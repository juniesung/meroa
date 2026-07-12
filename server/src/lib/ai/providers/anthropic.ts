import Anthropic from '@anthropic-ai/sdk';

import { env } from '../../../env.ts';
import { logger } from '../../../logger.ts';
import { executeAiToolCall } from '../actions.ts';
import { buildSystemPrompt, type ChatUserContext } from '../system-prompt.ts';
import { AI_TOOLS } from '../tools.ts';
import {
  createTurnState,
  MAX_OUTPUT_TOKENS,
  MAX_TOOL_ITERATIONS,
  SEGMENT_PAUSE_MAX_MS,
  SEGMENT_PAUSE_MIN_MS,
  sleep,
  windowHistory,
  type ChatActionContext,
  type ChatHistoryMessage,
  type ChatStreamEvent,
} from './shared.ts';

const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

export async function* streamChatReplyAnthropic(
  history: ChatHistoryMessage[],
  user: ChatUserContext,
  tailText: string,
  actionCtx: ChatActionContext,
): AsyncGenerator<ChatStreamEvent> {
  const windowed = windowHistory(history).filter((m) => m.content.trim().length > 0);

  // Base system block is cache-stable across a user's whole conversation.
  const system: Anthropic.TextBlockParam[] = [
    { type: 'text', text: buildSystemPrompt(user), cache_control: { type: 'ephemeral' } },
  ];

  // Extends with each iteration's assistant turn + tool_result turn so the
  // model sees its own prior actions when the loop continues.
  const turnMessages: Anthropic.MessageParam[] = windowed.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  // The system array can't sit after messages on Anthropic, so the volatile
  // tail block (current time, counts, live task list, recent out-of-band
  // changes) is prepended as an extra text block inside the newest user
  // turn instead — the same <system-reminder> idiom used elsewhere. The
  // cache_control breakpoint moves to the message just before it: with
  // nothing dynamic spliced between the system prompt and history anymore,
  // the whole stable history prefix caches too, not just the base prompt.
  const newest = turnMessages[turnMessages.length - 1];
  if (newest) {
    const originalText = typeof newest.content === 'string' ? newest.content : '';
    newest.content = [
      { type: 'text', text: tailText },
      { type: 'text', text: originalText },
    ];
  }
  if (turnMessages.length > 1) {
    const priorLast = turnMessages[turnMessages.length - 2]!;
    const priorText = typeof priorLast.content === 'string' ? priorLast.content : '';
    priorLast.content = [{ type: 'text', text: priorText, cache_control: { type: 'ephemeral' } }];
  }

  const { toolCallLog, emittedSegments, logTurn, maybeCorrectFakeAction } = createTurnState(actionCtx);

  try {
    let anySegmentEmitted = false;

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      const stream = client.messages.stream({
        model: env.ANTHROPIC_MODEL,
        max_tokens: MAX_OUTPUT_TOKENS,
        system,
        tools: AI_TOOLS,
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
            actionCtx.refs,
            {
              source: 'chat',
              sourceMessageId: actionCtx.sourceMessageId,
              toolCallId: block.id,
            },
          );
          if (result.ok && 'tasks' in result) {
            toolCallLog.push({
              name: block.name,
              ok: true,
              taskId: result.tasks.map((t) => t.id).join(','),
            });
            yield {
              type: 'action_bulk',
              toolName: result.toolName,
              tasks: result.tasks,
              summary: result.summary,
              recordKind: result.recordKind,
            };
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: result.summary,
            });
          } else if (result.ok && 'preview' in result) {
            toolCallLog.push({ name: block.name, ok: true });
            yield {
              type: 'action_preview',
              toolName: result.toolName,
              preview: result.preview,
              summary: result.summary,
              recordKind: result.recordKind,
            };
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: result.summary,
            });
          } else if (result.ok && 'tool' in result) {
            toolCallLog.push({ name: block.name, ok: true, taskId: result.tool.id });
            yield {
              type: 'action_tool',
              toolName: result.toolName,
              tool: result.tool,
              summary: result.summary,
              recordKind: result.recordKind,
            };
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: result.summary,
            });
          } else if (result.ok) {
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
    logger.error(
      { err, userId: actionCtx.userId, sourceMessageId: actionCtx.sourceMessageId },
      'anthropic chat stream threw',
    );
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
