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
  isToolCallMarkupLeak,
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

// DeepSeek's API is OpenAI-compatible (same Chat Completions request/response
// shape, including function calling and streaming tool-call fragments), so
// this reuses the `openai` SDK pointed at DeepSeek's base URL rather than a
// separate client library. Tool schemas are the same OPENAI_AI_TOOLS used
// by the OpenAI provider — no separate wrapping needed.
const client = new OpenAI({ apiKey: env.DEEPSEEK_API_KEY, baseURL: 'https://api.deepseek.com' });

/**
 * DeepSeek's v4 models think by default. The two passes want OPPOSITE things
 * here, and the 27-scenario accuracy battery is what settled it — turning
 * thinking off on BOTH looked like a pure win on paper (it's faster, it's
 * cheaper, and it's the only way to get `tool_choice: 'required'` accepted)
 * and it regressed accuracy from 27/27 to 23/27.
 *
 * ACT PASS — thinking stays ON. It looked like a mere classifier, but it is
 * the pass that has to *judge*: is "mark water done" ambiguous between two
 * open tasks? Does "undo that" refer to a pending card that changed nothing,
 * or to a real earlier change? With thinking disabled it stopped reasoning
 * and started pattern-matching, and both of those judgments collapsed —
 * undo-pending failed 3/3 (silently reverting an unrelated completion, the
 * exact data-integrity bug the rule exists to prevent) and ambiguous-task
 * failed 1/3. The cost of keeping thinking on is real and accepted: thinking
 * mode REJECTS `tool_choice: 'required'` (400), so act-narrate.ts falls back
 * to 'auto' and the "must call a tool" guarantee is not structurally
 * enforced. It is backstopped instead — by no_action carrying a reason, by
 * the claim-check, and by this battery. Correct beats fast.
 *
 * NARRATE PASS — thinking also stays ON, for the same reason, and this one
 * was the bigger surprise. It looked like the safe half: this pass judges
 * nothing, it just restates facts handed to it in the results block, and
 * disabling thinking cut time-to-first-token from 1.97s to 0.80s (reasoning
 * is emitted BEFORE the first content token, so it lands straight on TTFT).
 * The replies read fine in isolation. But on a NO-ACTION turn the reply pass
 * has one hard job — resist the pull of what the user just asked for and obey
 * "nothing happened this turn" — and that is a judgment, not a restatement.
 * Without reasoning it pattern-matched the request and confirmed it: "No
 * problem, undid that", "Nice — $5 logged", on turns where zero tools ran.
 * Four such false claims in 27 (all on no-action turns), each one caught and
 * retracted by the claim-check, versus zero at baseline.
 *
 * So: the thinking toggle is a trap on both passes. It is faster, cheaper,
 * and it is the ONLY way to get `tool_choice: 'required'` accepted (thinking
 * mode 400s on it) — and it costs accuracy on exactly the turns that matter
 * most. The forced-tool-call guarantee is therefore NOT available on a
 * thinking model, and act-narrate.ts's fallback to 'auto' is load-bearing,
 * not a wart. The guarantee is backstopped instead: no_action carries a
 * reason, the claim-check catches false claims, and the battery gates it.
 *
 * Left as an empty object rather than deleted so the next person who has this
 * idea finds the measurement instead of re-running it. OpenAI proper rejects
 * unknown body params, so this stays DeepSeek-local either way.
 */
const DEEPSEEK_ACT_EXTRA = {}; // thinking ON (default) — see above
const DEEPSEEK_NARRATE_EXTRA = {}; // thinking ON (default) — see above

/**
 * The one exception, and the reason the "thinking off" measurement above is
 * kept rather than deleted: it is only *unsafe on turns with a request in
 * flight*. When the action pass reports no_action with intent 'conversation'
 * — the user asked for nothing at all; a greeting, venting, banter — there is
 * no claim to falsely confirm, and the 1.97s -> 0.80s TTFT win is free.
 *
 * Applied only after the action pass has run and judged, so nothing is
 * bypassed or routed around the tools; the claim-check still guards the turn.
 */
const DEEPSEEK_NARRATE_CONVERSATION_EXTRA = { thinking: { type: 'disabled' } };

type AccumulatedToolCall = { id: string; name: string; argsJson: string };

export async function* streamChatReplyDeepseek(
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
  // The act/narrate split is the default — this file's single-pass loop
  // below is the AI_ACT_NARRATE=off rollback path (kept for A/B comparison
  // of the false-claim rate; see providers/act-narrate.ts).
  if (env.AI_ACT_NARRATE === 'on') {
    yield* streamChatReplyActNarrate(
      client,
      env.DEEPSEEK_MODEL,
      'max_tokens',
      history,
      user,
      tailText,
      actionCtx,
      DEEPSEEK_ACT_EXTRA,
      DEEPSEEK_NARRATE_EXTRA,
      DEEPSEEK_NARRATE_CONVERSATION_EXTRA,
      narrateTailText,
      conversationTailText,
      stateFactsText,
    );
    return;
  }

  const windowed = windowHistory(history).filter((m) => m.content.trim().length > 0);

  // See providers/shared.ts's buildTailedMessages: stable prefix first, the
  // volatile tail block right before the newest user turn.
  const turnMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = buildTailedMessages(
    buildSystemPrompt(user),
    tailText,
    windowed,
  );

  const { toolCallLog, emittedSegments, logTurn, maybeCorrectFakeAction } = createTurnState(actionCtx);

  try {
    let anySegmentEmitted = false;
    // At most one silent retry per turn for a leak with nothing else
    // emitted yet — guards against retry-looping forever if the model
    // leaks on every attempt.
    let dsmlRetried = false;

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      const stream = await client.chat.completions.create({
        model: env.DEEPSEEK_MODEL,
        stream: true,
        // DeepSeek's Chat Completions API predates OpenAI's max_tokens ->
        // max_completion_tokens rename and still takes the older name.
        max_tokens: MAX_OUTPUT_TOKENS,
        messages: turnMessages,
        tools: OPENAI_AI_TOOLS,
        tool_choice: iteration === MAX_TOOL_ITERATIONS - 1 ? 'none' : undefined,
      });

      let buffer = '';
      let emittedLength = 0;
      const accumulated = new Map<number, AccumulatedToolCall>();
      let finishReason: string | null = null;
      let refusalText = '';
      let leakLogged = false;
      let segmentEmittedThisIteration = false;
      let retryThisIteration = false;
      let glitchThisIteration = false;

      // DeepSeek v4-flash occasionally emits its own function-call
      // templating as literal content instead of a structured tool_calls
      // delta (fullwidth-pipe sentinel tokens like `<｜｜DSML｜｜...>`) — see
      // isToolCallMarkupLeak in shared.ts. Never real reply text, and never
      // safe to parse/execute (the observed leak used wrong param names).
      function bufferIsLeaked(): boolean {
        if (!isToolCallMarkupLeak(buffer)) return false;
        if (!leakLogged) {
          leakLogged = true;
          toolCallLog.push({
            name: 'unknown',
            ok: false,
            error: 'model emitted raw tool-call markup as content instead of a structured tool call — segment discarded',
          });
          logger.warn(
            { userId: actionCtx.userId, sourceMessageId: actionCtx.sourceMessageId },
            'deepseek leaked raw tool-call markup into content — discarding segment',
          );
        }
        return true;
      }

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

        if (bufferIsLeaked()) {
          // Nothing after a leak is trustworthy — stop consuming this
          // stream rather than trying to keep scanning past it. If nothing
          // real has gone out yet this iteration, the whole attempt is
          // silently retried once; otherwise the turn ends with an honest
          // admission instead of just going quiet.
          if (!segmentEmittedThisIteration && !dsmlRetried) {
            dsmlRetried = true;
            retryThisIteration = true;
          } else {
            glitchThisIteration = true;
          }
          break;
        }

        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          if (boundary > emittedLength) {
            yield { type: 'delta', text: buffer.slice(emittedLength, boundary) };
          }
          const segmentText = buffer.slice(0, boundary).trim();
          if (segmentText) {
            yield { type: 'segment_end', text: segmentText };
            anySegmentEmitted = true;
            segmentEmittedThisIteration = true;
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

      if (retryThisIteration) {
        iteration -= 1;
        continue;
      }
      if (glitchThisIteration) {
        const glitchText =
          "Hm, that last step glitched on my end — it may not have gone through. Mind asking again?";
        yield { type: 'segment_end', text: glitchText };
        emittedSegments.push(glitchText);
        yield* maybeCorrectFakeAction(stateFactsText);
        logTurn();
        yield { type: 'stream_end' };
        return;
      }

      const toolCalls = Array.from(accumulated.values());

      if (finishReason === 'tool_calls' && toolCalls.length > 0) {
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

      let remaining: string;
      if (finishReason === 'content_filter' || refusalText) {
        remaining = "That's not something I can help with — let's talk about something else.";
      } else if (finishReason === 'length' && buffer.trim().length === 0) {
        remaining = 'Sorry, that got cut off on my end — mind asking again?';
      } else {
        yield* flushSafe();
        remaining = buffer.trim();
      }

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
      'deepseek chat stream threw',
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
