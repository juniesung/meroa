import OpenAI from 'openai';

import { env } from '../../../env.ts';
import { logger } from '../../../logger.ts';
import { executeAiToolCall } from '../actions.ts';
import { buildSystemPrompt, type ChatUserContext } from '../system-prompt.ts';
import { OPENAI_AI_TOOLS } from '../tools.ts';
import { streamChatReplyActNarrate } from './act-narrate.ts';
import {
  buildTailedMessages,
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

const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });

// delta.tool_calls arrives in fragments — first chunk carries {index, id,
// function:{name, arguments:''}}, later chunks for the same index append
// string pieces to `arguments`. Accumulated here by index, then parsed as
// JSON once the stream ends (arguments is a JSON string, not an object).
type AccumulatedToolCall = { id: string; name: string; argsJson: string };

export async function* streamChatReplyOpenai(
  history: ChatHistoryMessage[],
  user: ChatUserContext,
  tailText: string,
  actionCtx: ChatActionContext,
  // The reply pass's state block — same as tailText minus the recent-changes
  // feed and undo target (routes/messages.ts). Falls back to tailText for the
  // single-pass rollback path below, which has only one context to build.
  narrateTailText: string = tailText,
  conversationTailText: string = narrateTailText,
  stateFactsText: string = tailText,
): AsyncGenerator<ChatStreamEvent> {
  // The act/narrate split is the default — the single-pass loop below is
  // the AI_ACT_NARRATE=off rollback path (see providers/act-narrate.ts).
  if (env.AI_ACT_NARRATE === 'on') {
    yield* streamChatReplyActNarrate(
      client,
      env.OPENAI_MODEL,
      'max_completion_tokens',
      history,
      user,
      tailText,
      actionCtx,
      {},
      {},
      {},
      narrateTailText,
      conversationTailText,
      stateFactsText,
    );
    return;
  }

  const windowed = windowHistory(history).filter((m) => m.content.trim().length > 0);

  // Stable system prompt + history first, volatile tail block right before
  // the newest user turn — OpenAI's prompt caching is automatic and
  // prefix-based, so this ordering (nothing dynamic spliced into the
  // middle) is what makes everything except the last two messages eligible
  // for a cached read on every turn after the first (see buildTailedMessages).
  const turnMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = buildTailedMessages(
    buildSystemPrompt(user),
    tailText,
    windowed,
  );

  const { toolCallLog, emittedSegments, logTurn, maybeCorrectFakeAction } = createTurnState(actionCtx);

  try {
    let anySegmentEmitted = false;

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      const stream = await client.chat.completions.create({
        model: env.OPENAI_MODEL,
        stream: true,
        max_completion_tokens: MAX_OUTPUT_TOKENS,
        messages: turnMessages,
        tools: OPENAI_AI_TOOLS,
        // Force a text-only close once the iteration budget is spent, so a
        // model that still wants to act gets one last chance to narrate
        // instead of silently dropping the turn.
        tool_choice: iteration === MAX_TOOL_ITERATIONS - 1 ? 'none' : undefined,
      });

      // Segment-splitting state, reset each iteration — same scheme as the
      // Anthropic provider (see providers/anthropic.ts for the rationale).
      let buffer = '';
      let emittedLength = 0;
      const accumulated = new Map<number, AccumulatedToolCall>();
      let finishReason: string | null = null;
      let refusalText = '';

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

      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;

        const delta = choice.delta;
        if (delta?.refusal) refusalText += delta.refusal;

        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const existing = accumulated.get(tc.index);
            if (existing) {
              if (tc.function?.arguments) existing.argsJson += tc.function.arguments;
              if (tc.function?.name) existing.name = tc.function.name;
              if (tc.id) existing.id = tc.id;
            } else {
              accumulated.set(tc.index, {
                id: tc.id ?? '',
                name: tc.function?.name ?? '',
                argsJson: tc.function?.arguments ?? '',
              });
            }
          }
        }

        if (!delta?.content) continue;
        buffer += delta.content;

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

      const toolCalls = Array.from(accumulated.values());

      if (finishReason === 'tool_calls' && toolCalls.length > 0) {
        // Flush whatever text preceded the tool call as its own segment —
        // the tool call is a hard boundary.
        yield* flushSafe();
        const leftover = buffer.trim();
        if (leftover) {
          yield { type: 'segment_end', text: leftover };
          anySegmentEmitted = true;
          emittedSegments.push(leftover);
        }

        const assistantToolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] = [];
        const toolResultMessages: OpenAI.Chat.Completions.ChatCompletionToolMessageParam[] = [];

        for (const call of toolCalls) {
          assistantToolCalls.push({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: call.argsJson },
          });

          let parsedInput: unknown;
          try {
            parsedInput = call.argsJson.trim() ? JSON.parse(call.argsJson) : {};
          } catch {
            toolCallLog.push({ name: call.name, ok: false, error: 'invalid JSON arguments' });
            toolResultMessages.push({
              role: 'tool',
              tool_call_id: call.id,
              content:
                'Your arguments were not valid JSON — ask the user for the missing or corrected value rather than guessing, then retry.',
            });
            continue;
          }

          const result = await executeAiToolCall(
            actionCtx.userId,
            actionCtx.timezone,
            call.name,
            parsedInput,
            actionCtx.refs,
            {
              source: 'chat',
              sourceMessageId: actionCtx.sourceMessageId,
              toolCallId: call.id,
            },
            actionCtx.pendingConfirmCard,
            actionCtx.userMessageText,
          );

          if (result.ok && 'tasks' in result) {
            toolCallLog.push({
              name: call.name,
              ok: true,
              taskId: result.tasks.map((t) => t.id).join(','),
              // Always task_bulk_removal_pending — remove_tasks never
              // mutates by itself, only its own confirm card does.
              pending: true,
            });
            yield {
              type: 'action_bulk',
              toolName: result.toolName,
              tasks: result.tasks,
              summary: result.summary,
              recordKind: result.recordKind,
            };
            toolResultMessages.push({ role: 'tool', tool_call_id: call.id, content: result.summary });
          } else if (result.ok && 'preview' in result) {
            // Always goal_preview — create_goal never saves by itself.
            toolCallLog.push({ name: call.name, ok: true, pending: true });
            yield {
              type: 'action_preview',
              toolName: result.toolName,
              preview: result.preview,
              summary: result.summary,
              recordKind: result.recordKind,
            };
            toolResultMessages.push({ role: 'tool', tool_call_id: call.id, content: result.summary });
          } else if (result.ok && 'goal' in result) {
            toolCallLog.push({
              name: call.name,
              ok: true,
              taskId: result.goal.id,
              pending: result.recordKind === 'goal_advance_pending',
            });
            yield {
              type: 'action_goal',
              toolName: result.toolName,
              goal: result.goal,
              summary: result.summary,
              recordKind: result.recordKind,
              proposal: result.proposal,
            };
            toolResultMessages.push({ role: 'tool', tool_call_id: call.id, content: result.summary });
          } else if (result.ok) {
            toolCallLog.push({
              name: call.name,
              ok: true,
              taskId: result.task.id,
              pending: result.recordKind === 'task_removal_pending',
            });
            yield {
              type: 'action',
              toolName: result.toolName,
              task: result.task,
              summary: result.summary,
              recordKind: result.recordKind,
            };
            toolResultMessages.push({
              role: 'tool',
              tool_call_id: call.id,
              content: result.modelSummary ?? result.summary,
            });
          } else {
            toolCallLog.push({ name: call.name, ok: false, error: result.error });
            // OpenAI has no is_error flag on tool results — the instructive
            // error phrasing itself is what steers the model's retry.
            toolResultMessages.push({ role: 'tool', tool_call_id: call.id, content: result.error });
          }
        }

        turnMessages.push({
          role: 'assistant',
          content: leftover || null,
          tool_calls: assistantToolCalls,
        });
        turnMessages.push(...toolResultMessages);
        continue;
      }

      // Not a tool call (or the forced-final iteration) — finish the turn.
      let remaining: string;
      if (finishReason === 'content_filter' || refusalText) {
        remaining = "That's not something I can help with — let's talk about something else.";
      } else if (finishReason === 'length' && buffer.trim().length === 0) {
        remaining = 'Sorry, that got cut off on my end — mind asking again?';
      } else {
        yield* flushSafe();
        remaining = buffer.trim();
      }

      // Guarantee at least one segment per turn — a genuinely empty model
      // reply (rare, but possible on any finish reason) must never leave the
      // user's message met with silence and no error.
      if (!remaining && !anySegmentEmitted) {
        remaining = 'Hm, not sure what to say to that — try me again?';
      }

      if (remaining) {
        yield { type: 'segment_end', text: remaining };
        emittedSegments.push(remaining);
      }
      yield* maybeCorrectFakeAction(stateFactsText);
      logTurn();
      yield { type: 'stream_end' };
      return;
    }

    yield* maybeCorrectFakeAction(stateFactsText);
    logTurn();
    yield { type: 'stream_end' };
  } catch (err) {
    logger.error(
      { err, userId: actionCtx.userId, sourceMessageId: actionCtx.sourceMessageId },
      'openai chat stream threw',
    );
    if (err instanceof OpenAI.RateLimitError || err instanceof OpenAI.InternalServerError) {
      yield {
        type: 'error',
        retryable: true,
        message: "Meroa's a little overloaded right now — try again in a moment.",
      };
    } else if (err instanceof OpenAI.APIConnectionError) {
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
