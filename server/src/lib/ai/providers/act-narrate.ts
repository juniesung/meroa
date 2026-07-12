import type OpenAI from 'openai';

import { logger } from '../../../logger.ts';
import { executeAiToolCall } from '../actions.ts';
import { ACTION_SYSTEM_PROMPT, buildSystemPrompt, type ChatUserContext } from '../system-prompt.ts';
import { NO_ACTION_TOOL_NAME, OPENAI_ACTION_PASS_TOOLS } from '../tools.ts';
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

// The narrate pass gets extra output headroom over the shared
// MAX_OUTPUT_TOKENS: flash reasons before answering and that reasoning
// bills against the same budget — observed once live burning all 1536
// tokens on reasoning and emitting zero reply content (the same failure
// mode claim-check.ts documents for its classifier). The reply itself is
// short; the headroom is for the invisible reasoning pass.
const NARRATE_MAX_OUTPUT_TOKENS = MAX_OUTPUT_TOKENS + 1024;

// How many recent messages (user + assistant, newest user included) the
// action pass sees. Saved state lives in the live lists and the pending-
// preview line; the only thing history contributes is *pending
// conversational intent* — the question the model just asked, the plan the
// user is saying "yeah" to — which is inherently this recent. Anything
// deeper is exactly the material the model pattern-completes from instead
// of acting (the measured failure cluster: creations 2..N in a session,
// after "Preview's up — tap Create" replies piled up in history).
const ACTION_PASS_HISTORY_MESSAGES = 4;

type MaxTokensParam = 'max_tokens' | 'max_completion_tokens';

// DeepSeek's thinking-mode models reject tool_choice: 'required' outright
// (400 "Thinking mode does not support this tool_choice") — discovered
// live, not documented in the SDK types. Remembered per model after the
// first rejection so every later turn skips straight to 'auto'. The
// degradation is graceful: pass-1 prose is never shown to the user, so a
// model that talks instead of calling produces an honest "no action was
// taken" narrate pass — never a false success claim.
const requiredToolChoiceUnsupported = new Set<string>();

/**
 * The act/narrate split. Pass 1 (action) runs non-streamed on an isolated
 * context — action-only prompt, the volatile state block, and a tiny
 * recent-turn window — with tool choice FORCED: it must call a real tool or
 * the no_action escape, so "narrated the action instead of calling it" is
 * structurally impossible rather than probabilistically caught. Pass 2
 * (narrate) streams the actual reply from the full personality prompt +
 * full history, with the pass-1 results injected as authoritative facts and
 * tools disabled. The claim-check backstop still guards no-action turns.
 */
export async function* streamChatReplyActNarrate(
  client: OpenAI,
  model: string,
  maxTokensParam: MaxTokensParam,
  history: ChatHistoryMessage[],
  user: ChatUserContext,
  tailText: string,
  actionCtx: ChatActionContext,
): AsyncGenerator<ChatStreamEvent> {
  const windowed = windowHistory(history).filter((m) => m.content.trim().length > 0);
  const { toolCallLog, emittedSegments, logTurn, maybeCorrectFakeAction } = createTurnState(actionCtx);

  const maxTokens = (n: number) =>
    maxTokensParam === 'max_tokens' ? { max_tokens: n } : { max_completion_tokens: n };

  try {
    // ---- pass 1: act -----------------------------------------------------
    const actionMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: 'system', content: ACTION_SYSTEM_PROMPT },
      { role: 'system', content: tailText },
      ...windowed.slice(-ACTION_PASS_HISTORY_MESSAGES).map(
        (m): OpenAI.Chat.Completions.ChatCompletionMessageParam => ({
          role: m.role,
          content: m.content,
        }),
      ),
    ];

    // What the narrate pass gets told, verbatim — successes use the
    // model-facing summary (which carries refs/recomputed facts), failures
    // the wrapFailure text, so the reply can only describe what actually
    // happened.
    const actionFacts: string[] = [];
    let calledNoAction = false;

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      // Forced on the first round — the whole point of the pass. Later
      // rounds are 'auto' so a finished chain can stop without being
      // strong-armed into a spurious extra call.
      const wantRequired = iteration === 0 && !requiredToolChoiceUnsupported.has(model);
      let completion: OpenAI.Chat.Completions.ChatCompletion;
      try {
        completion = await client.chat.completions.create({
          model,
          ...maxTokens(MAX_OUTPUT_TOKENS),
          messages: actionMessages,
          tools: OPENAI_ACTION_PASS_TOOLS,
          tool_choice: wantRequired ? 'required' : 'auto',
        });
      } catch (err) {
        const message = (err as Error).message ?? '';
        if (!wantRequired || (err as { status?: number }).status !== 400 || !/tool_choice/i.test(message)) {
          throw err;
        }
        requiredToolChoiceUnsupported.add(model);
        logger.warn({ model }, "model rejected tool_choice 'required' — falling back to 'auto' for this and future turns");
        completion = await client.chat.completions.create({
          model,
          ...maxTokens(MAX_OUTPUT_TOKENS),
          messages: actionMessages,
          tools: OPENAI_ACTION_PASS_TOOLS,
          tool_choice: 'auto',
        });
      }

      const message = completion.choices[0]?.message;
      const calls = message?.tool_calls ?? [];
      if (!calls.length) break;

      const assistantToolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] = [];
      const toolResultMessages: OpenAI.Chat.Completions.ChatCompletionToolMessageParam[] = [];
      let sawRealCall = false;

      for (const call of calls) {
        if (call.type !== 'function') continue;
        assistantToolCalls.push(call);

        if (call.function.name === NO_ACTION_TOOL_NAME) {
          calledNoAction = true;
          toolResultMessages.push({ role: 'tool', tool_call_id: call.id, content: 'No action taken.' });
          continue;
        }

        let parsedInput: unknown;
        try {
          parsedInput = call.function.arguments.trim() ? JSON.parse(call.function.arguments) : {};
        } catch {
          toolCallLog.push({ name: call.function.name, ok: false, error: 'invalid JSON arguments' });
          toolResultMessages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: 'Your arguments were not valid JSON — retry with corrected arguments, or call no_action.',
          });
          continue;
        }

        sawRealCall = true;
        const result = await executeAiToolCall(
          actionCtx.userId,
          actionCtx.timezone,
          call.function.name,
          parsedInput,
          actionCtx.refs,
          { source: 'chat', sourceMessageId: actionCtx.sourceMessageId, toolCallId: call.id },
        );

        if (result.ok && 'tasks' in result) {
          toolCallLog.push({ name: call.function.name, ok: true, taskId: result.tasks.map((t) => t.id).join(',') });
          yield { type: 'action_bulk', toolName: result.toolName, tasks: result.tasks, summary: result.summary, recordKind: result.recordKind };
          actionFacts.push(result.summary);
          toolResultMessages.push({ role: 'tool', tool_call_id: call.id, content: result.summary });
        } else if (result.ok && 'preview' in result) {
          toolCallLog.push({ name: call.function.name, ok: true });
          yield { type: 'action_preview', toolName: result.toolName, preview: result.preview, summary: result.summary, recordKind: result.recordKind };
          actionFacts.push(result.summary);
          toolResultMessages.push({ role: 'tool', tool_call_id: call.id, content: result.summary });
        } else if (result.ok && 'goal' in result) {
          toolCallLog.push({ name: call.function.name, ok: true, taskId: result.goal.id });
          yield { type: 'action_goal', toolName: result.toolName, goal: result.goal, summary: result.summary, recordKind: result.recordKind };
          actionFacts.push(result.summary);
          toolResultMessages.push({ role: 'tool', tool_call_id: call.id, content: result.summary });
        } else if (result.ok) {
          toolCallLog.push({ name: call.function.name, ok: true, taskId: result.task.id });
          yield { type: 'action', toolName: result.toolName, task: result.task, summary: result.summary, recordKind: result.recordKind };
          actionFacts.push(result.modelSummary ?? result.summary);
          toolResultMessages.push({ role: 'tool', tool_call_id: call.id, content: result.modelSummary ?? result.summary });
        } else {
          toolCallLog.push({ name: call.function.name, ok: false, error: result.error });
          actionFacts.push(result.error);
          toolResultMessages.push({ role: 'tool', tool_call_id: call.id, content: result.error });
        }
      }

      actionMessages.push({ role: 'assistant', content: message?.content ?? null, tool_calls: assistantToolCalls });
      actionMessages.push(...toolResultMessages);

      // A pure-no_action round means the pass decided nothing (more) needs
      // doing — don't loop it into deciding again.
      if (!sawRealCall) break;
    }

    // ---- pass 2: narrate ---------------------------------------------------
    const narrateMessages = buildTailedMessages(buildSystemPrompt(user), tailText, windowed);
    const resultsBlock =
      actionFacts.length > 0
        ? `# Actions already taken this turn (by you, just now — the user can see their cards above your reply)\n${actionFacts.map((f) => `- ${f}`).join('\n')}\n\nDescribe what actually happened in your own words, short and casual. State only these facts — no other action, preview, or change happened this turn, and you cannot take further actions in this reply.`
        : `# No action was taken this turn\nReply conversationally. If the user asked for something that needs a missing required detail, ask for it. Do not claim or imply that anything was created, changed, logged, removed, or previewed — nothing was.`;
    narrateMessages.push({ role: 'system', content: resultsBlock });

    const stream = await client.chat.completions.create({
      model,
      stream: true,
      ...maxTokens(NARRATE_MAX_OUTPUT_TOKENS),
      messages: narrateMessages,
      // No tools at all — this pass talks; it cannot act.
    });

    let buffer = '';
    let emittedLength = 0;
    let finishReason: string | null = null;
    let anySegmentEmitted = false;

    function* flushSafe(): Generator<ChatStreamEvent> {
      const trailingNewlines = buffer.match(/\n+$/);
      const safeLength = trailingNewlines ? buffer.length - trailingNewlines[0].length : buffer.length;
      if (safeLength > emittedLength) {
        yield { type: 'delta', text: buffer.slice(emittedLength, safeLength) };
        emittedLength = safeLength;
      }
    }

    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      if (!choice.delta?.content) continue;
      buffer += choice.delta.content;

      // No tools in this pass, so a raw-markup leak can't be a lost call —
      // just junk the model shouldn't show; drop the segment.
      if (isToolCallMarkupLeak(buffer)) {
        logger.warn(
          { userId: actionCtx.userId, sourceMessageId: actionCtx.sourceMessageId },
          'narrate pass leaked raw tool-call markup — discarding rest of reply',
        );
        buffer = buffer.slice(0, emittedLength);
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
          emittedSegments.push(segmentText);
        }
        buffer = buffer.slice(boundary).replace(/^\n+/, '');
        emittedLength = 0;
        if (segmentText) {
          await sleep(SEGMENT_PAUSE_MIN_MS + Math.random() * (SEGMENT_PAUSE_MAX_MS - SEGMENT_PAUSE_MIN_MS));
        }
        boundary = buffer.indexOf('\n\n');
      }

      yield* flushSafe();
    }

    let remaining: string;
    if (finishReason === 'length' && buffer.trim().length === 0) {
      remaining = 'Sorry, that got cut off on my end — mind asking again?';
    } else {
      yield* flushSafe();
      remaining = buffer.trim();
    }

    // The action cards can speak for themselves, but a turn must never end
    // in total silence — if neither pass produced anything user-visible,
    // say something honest.
    if (!remaining && !anySegmentEmitted && actionFacts.length === 0) {
      remaining = 'Hm, not sure what to say to that — try me again?';
    }

    if (remaining) {
      yield { type: 'segment_end', text: remaining };
      emittedSegments.push(remaining);
    }

    // Backstop for no-action turns (toolCallLog is empty exactly then) —
    // the narrate pass has no tools, so a claimed action there is always
    // false. no_action deliberately doesn't count as a call here.
    if (calledNoAction || toolCallLog.length === 0) {
      yield* maybeCorrectFakeAction();
    }
    logTurn();
    yield { type: 'stream_end' };
  } catch (err) {
    logger.error(
      { err, userId: actionCtx.userId, sourceMessageId: actionCtx.sourceMessageId },
      'act/narrate chat stream threw',
    );
    const status = (err as { status?: number }).status;
    if (status === 429 || (status !== undefined && status >= 500)) {
      yield { type: 'error', retryable: true, message: "Meroa's a little overloaded right now — try again in a moment." };
    } else if ((err as { code?: string }).code === 'ECONNRESET' || (err as Error).name === 'APIConnectionError') {
      yield { type: 'error', retryable: true, message: 'Lost connection — try sending that again.' };
    } else {
      yield { type: 'error', retryable: false, message: 'Something went wrong on my end.' };
    }
  }
}
