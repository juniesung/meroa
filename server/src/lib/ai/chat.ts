import Anthropic from '@anthropic-ai/sdk';

import { env } from '../../env.ts';
import { logger } from '../../logger.ts';
import type { TaskRow } from '../tasks/executor.ts';
import { executeAiToolCall } from './actions.ts';
import { buildDynamicContext, buildSystemPrompt, type ChatUserContext } from './system-prompt.ts';
import { TASK_TOOLS } from './tools.ts';

const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

// Streaming, non-thinking replies don't need much room — keep this modest so a
// runaway response can't stall the SSE connection.
const MAX_OUTPUT_TOKENS = 1024;

// Conversation context window: cap both message count and total characters so
// a long-running relationship doesn't balloon every request's token cost.
// Kept modest (not just for cost) — a long window of near-identical
// "I did X" turns is exactly the kind of repetition that makes a model more
// likely to pattern-complete that shape instead of actually deciding fresh
// each time whether to call a tool. The live task list (buildTaskContext),
// not history, is the source of truth for what currently exists.
const MAX_HISTORY_MESSAGES = 24;
const MAX_HISTORY_CHARS = 16_000;

// Between finishing one "text" and starting the next, pause briefly so a
// multi-bubble reply feels like separate messages arriving, not one message
// artificially chopped up.
const SEGMENT_PAUSE_MIN_MS = 500;
const SEGMENT_PAUSE_MAX_MS = 1100;

// A single user message shouldn't trigger a long chain of actions — task
// requests are 1-2 calls at most. This also bounds a pathological loop.
const MAX_TOOL_ITERATIONS = 3;

export type ChatHistoryMessage = { role: 'user' | 'assistant'; content: string };

export type ChatStreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'segment_end'; text: string }
  | { type: 'action'; toolName: string; task: TaskRow; summary: string; recordKind: string }
  | { type: 'stream_end' }
  | { type: 'error'; retryable: boolean; message: string };

export type ChatActionContext = {
  userId: string;
  timezone: string | null;
  sourceMessageId: string;
};

function windowHistory(history: ChatHistoryMessage[]): ChatHistoryMessage[] {
  const recent = history.slice(-MAX_HISTORY_MESSAGES);

  let totalChars = 0;
  let startIndex = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    totalChars += recent[i]!.content.length;
    startIndex = i;
    if (totalChars > MAX_HISTORY_CHARS) break;
  }
  return recent.slice(startIndex);
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Streams a reply from Claude given the conversation so far (must already
 * include the user's just-sent message). Meroa may send a reply as several
 * separate "texts" (CLAUDE.md's iMessage feel) — signaled by a blank line in
 * the model's output — and may call task tools (the AI action layer), each
 * producing an `action` event with the affected task. Consumers get `delta`
 * events for the segment currently arriving, `segment_end` once a segment is
 * complete, `action` when a tool call executes, and `stream_end` once the
 * whole turn is done. Never throws — always terminates in `stream_end` or
 * `error`.
 */
export async function* streamChatReply(
  history: ChatHistoryMessage[],
  user: ChatUserContext,
  taskContext: string,
  actionCtx: ChatActionContext,
): AsyncGenerator<ChatStreamEvent> {
  const windowed = windowHistory(history).filter((m) => m.content.trim().length > 0);

  // Base system block is cache-stable across a user's whole conversation;
  // the dynamic block (current time + task list) changes every turn and is
  // deliberately a *second*, uncached block so it never busts that cache.
  const system: Anthropic.TextBlockParam[] = [
    { type: 'text', text: buildSystemPrompt(user), cache_control: { type: 'ephemeral' } },
    { type: 'text', text: buildDynamicContext(new Date(), user.timezone, taskContext) },
  ];

  // Extends with each iteration's assistant turn + tool_result turn so the
  // model sees its own prior actions when the loop continues.
  const turnMessages: Anthropic.MessageParam[] = windowed.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  // Every tool call this turn attempted (across all iterations), success or
  // failure — logged as one line per turn so "the model said it did X but
  // nothing happened" is a log lookup instead of database archaeology (see
  // the toolCalls.length === 0 case in particular: the model produced text
  // without ever calling a tool at all).
  const toolCallLog: Array<{ name: string; ok: boolean; taskId?: string; error?: string }> = [];
  function logTurn() {
    logger.info(
      { userId: actionCtx.userId, sourceMessageId: actionCtx.sourceMessageId, toolCalls: toolCallLog },
      'chat turn finished',
    );
  }

  // Same-turn safety net for the "claimed an action without calling the
  // tool" failure: every segment_end text gets collected here, and if the
  // whole turn ends with zero tool calls yet the text still sounds like a
  // task-action confirmation (a quoted title next to a past-tense action
  // verb — the exact shape observed in practice, e.g. `Added "Feed cats"`),
  // one corrective segment gets appended instead of leaving a false
  // confirmation uncorrected. Deliberately narrow (not a general lie
  // detector) to avoid false-positives on ordinary conversation.
  const emittedSegments: string[] = [];
  const FAKE_ACTION_PATTERN =
    /\b(added|removed|deleted|marked|updated|moved|started|paused|logged|created)\b[^.!?]{0,30}["“]/i;
  // Second, independent signal: a literal mention of one of our tool names
  // in bracket notation. Legitimate replies never look like this — the only
  // known source was the model reproducing an internal history-compaction
  // marker verbatim on a turn where it hadn't actually called anything
  // (fixed at the source in messages.ts's historyContentFor, which no
  // longer feeds that marker back into the model at all) — kept here as a
  // backstop in case a similar leak happens through some other path.
  const TOOL_NAME_LEAK_PATTERN =
    /\[(create_task|edit_task|complete_task|progress_task|postpone_task|remove_task)\b/i;
  function* maybeCorrectFakeAction(): Generator<ChatStreamEvent> {
    if (toolCallLog.length > 0) return;
    const text = emittedSegments.join(' ');
    if (!FAKE_ACTION_PATTERN.test(text) && !TOOL_NAME_LEAK_PATTERN.test(text)) return;
    logger.warn(
      { userId: actionCtx.userId, sourceMessageId: actionCtx.sourceMessageId, segments: emittedSegments },
      'chat turn self-corrected a likely unconfirmed action',
    );
    yield {
      type: 'segment_end',
      text: "Hold on — I don't think that actually went through. Mind trying that again?",
    };
  }

  try {
    let anySegmentEmitted = false;

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      const stream = client.messages.stream({
        model: env.ANTHROPIC_MODEL,
        max_tokens: MAX_OUTPUT_TOKENS,
        system,
        tools: TASK_TOOLS,
        // Force a text-only close once the iteration budget is spent, so a
        // model that still wants to act gets one last chance to narrate
        // instead of silently dropping the turn.
        tool_choice: iteration === MAX_TOOL_ITERATIONS - 1 ? { type: 'none' } : undefined,
        messages: turnMessages,
      });

      // Segment-splitting state, reset each iteration — a tool call is a
      // hard segment boundary, so the next iteration's text always starts a
      // fresh bubble. `buffer` holds the current segment's raw text;
      // `emittedLength` is how much of it has already gone out as `delta`. A
      // trailing run of newlines is held back since it might turn into a
      // blank-line boundary once more text arrives.
      let buffer = '';
      let emittedLength = 0;

      function* flushSafe(): Generator<ChatStreamEvent> {
        const trailingNewlines = buffer.match(/\n+$/);
        const safeLength = trailingNewlines
          ? buffer.length - trailingNewlines[0].length
          : buffer.length;
        if (safeLength > emittedLength) {
          yield { type: 'delta', text: buffer.slice(emittedLength, safeLength) };
          emittedLength = safeLength;
        }
      }

      for await (const event of stream) {
        if (event.type !== 'content_block_delta' || event.delta.type !== 'text_delta') continue;
        buffer += event.delta.text;

        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          if (boundary > emittedLength) {
            yield { type: 'delta', text: buffer.slice(emittedLength, boundary) };
          }
          const segmentText = buffer.slice(0, boundary).trim();
          if (segmentText) {
            yield { type: 'segment_end', text: segmentText };
            anySegmentEmitted = true;
            emittedSegments.push(segmentText);
          }

          buffer = buffer.slice(boundary).replace(/^\n+/, '');
          emittedLength = 0;

          if (segmentText) {
            await sleep(
              SEGMENT_PAUSE_MIN_MS + Math.random() * (SEGMENT_PAUSE_MAX_MS - SEGMENT_PAUSE_MIN_MS),
            );
          }

          boundary = buffer.indexOf('\n\n');
        }

        yield* flushSafe();
      }

      const final = await stream.finalMessage();
      const toolUseBlocks = final.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
      );

      if (final.stop_reason === 'tool_use' && toolUseBlocks.length > 0) {
        // Flush whatever text preceded the tool call as its own segment —
        // the tool call is a hard boundary.
        yield* flushSafe();
        const leftover = buffer.trim();
        if (leftover) {
          yield { type: 'segment_end', text: leftover };
          anySegmentEmitted = true;
          emittedSegments.push(leftover);
        }

        const toolResults: Anthropic.ToolResultBlockParam[] = [];
        for (const block of toolUseBlocks) {
          const result = await executeAiToolCall(
            actionCtx.userId,
            actionCtx.timezone,
            block.name,
            block.input,
            {
              source: 'chat',
              sourceMessageId: actionCtx.sourceMessageId,
              toolCallId: block.id,
            },
          );
          if (result.ok) {
            toolCallLog.push({ name: block.name, ok: true, taskId: result.task.id });
            yield {
              type: 'action',
              toolName: result.toolName,
              task: result.task,
              summary: result.summary,
              recordKind: result.recordKind,
            };
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: result.summary,
            });
          } else {
            toolCallLog.push({ name: block.name, ok: false, error: result.error });
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: result.error,
              is_error: true,
            });
          }
        }

        turnMessages.push({ role: 'assistant', content: final.content });
        turnMessages.push({ role: 'user', content: toolResults });
        continue;
      }

      // Not a tool call (or the forced-final iteration) — finish the turn.
      const textBlock = final.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
      const modelText = textBlock?.text ?? '';

      let remaining: string;
      if (final.stop_reason === 'refusal') {
        remaining = "That's not something I can help with — let's talk about something else.";
      } else if (
        final.stop_reason === 'max_tokens' &&
        modelText.trim().length === 0 &&
        buffer.trim().length === 0
      ) {
        remaining = 'Sorry, that got cut off on my end — mind asking again?';
      } else {
        yield* flushSafe();
        remaining = buffer.trim();
      }

      // Guarantee at least one segment per turn — a genuinely empty model
      // reply (rare, but possible on any stop_reason) must never leave the
      // user's message met with silence and no error.
      if (!remaining && !anySegmentEmitted) {
        remaining = 'Hm, not sure what to say to that — try me again?';
      }

      if (remaining) {
        yield { type: 'segment_end', text: remaining };
        emittedSegments.push(remaining);
      }
      yield* maybeCorrectFakeAction();
      logTurn();
      yield { type: 'stream_end' };
      return;
    }

    yield* maybeCorrectFakeAction();
    logTurn();
    yield { type: 'stream_end' };
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError || err instanceof Anthropic.InternalServerError) {
      yield {
        type: 'error',
        retryable: true,
        message: "Meroa's a little overloaded right now — try again in a moment.",
      };
    } else if (err instanceof Anthropic.APIConnectionError) {
      yield {
        type: 'error',
        retryable: true,
        message: 'Lost connection — try sending that again.',
      };
    } else {
      yield { type: 'error', retryable: false, message: 'Something went wrong on my end.' };
    }
  }
}
