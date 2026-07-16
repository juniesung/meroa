import type OpenAI from 'openai';

import { logger } from '../../../logger.ts';
import { executeAiToolCall } from '../actions.ts';
import {
  ACTION_SYSTEM_PROMPT,
  buildMemoryBlock,
  buildStyleBlock,
  buildSystemPrompt,
  type ChatUserContext,
} from '../system-prompt.ts';
import { NO_ACTION_TOOL_NAME, OPENAI_ACTION_PASS_TOOLS } from '../tools.ts';
import {
  buildConversationHistory,
  buildTailedMessages,
  createTurnState,
  isToolCallMarkupLeak,
  looksPurelyConversational,
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
// user is saying "yeah" to.
//
// This was bumped 4 -> 6 to hold the milestone-goal chat build, which used
// to span a five-message question/answer/question/answer exchange the act
// pass needed all of to finally call create_goal. Deeper history bought
// that at a real cost — pattern-completion surface: 8 was tried too, and it
// visibly degraded the long e2e session, dropping a random call or two per
// run (the longer the session, the more it bites).
//
// docs/goal-manual-editing-plan.md deleted the multi-message build itself —
// milestone creation is now a single message, stages taken verbatim if
// given, a bare template otherwise, never a follow-up question — so the
// thing that forced the window open no longer exists. Back to 4: fewer
// older turns to imitate instead of act on.
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

// The two results blocks the narrate pass can be handed, lifted out so the
// SPECULATIVE narrate (dispatched before the action pass has finished) can be
// built from the same text the real one would get.
function actionResultsBlock(actionFacts: string[]): string {
  return `# Actions already taken this turn (by you, just now — the user can see their cards above your reply)\n${actionFacts.map((f) => `- ${f}`).join('\n')}\n\nThese facts are freshly computed from the real database state — they override anything you remember from earlier in this conversation, including a number, streak, or status you stated in a previous reply. If a fact here conflicts with your own memory of the conversation, the fact here is correct and your memory is stale; restate it exactly, never "correct" it back toward what you recalled. Describe what actually happened in your own words, short and casual. State only these facts — no other action, preview, or change happened this turn, and you cannot take further actions in this reply.`;
}

/**
 * A FAILED call is not an action taken, and filing it under a header that says
 * so is how "Undone — the card is gone" got written on a turn where the undo was
 * refused and nothing changed. The model was not hallucinating; it was reading
 * the heading we gave it. Failures get their own frame.
 */
function failureResultsBlock(failures: string[]): string {
  return `# NOTHING was done this turn — every action failed
${failures.map((f) => `- ${f}`).join('\n')}

The user's tasks and goals are EXACTLY as they were before they spoke. Nothing was created, completed, logged, removed, undone or previewed. Tell them plainly what could not be done and why, in one short sentence, and ask for whatever would let them proceed. Never describe any part of it as done.`;
}

// adjust_style has no card, so unlike every other successful action this
// one genuinely needs a spoken acknowledgment — see the silence-skip carve-
// out above. Composed alongside actionResultsBlock/failureResultsBlock/
// noActionResultsBlock rather than replacing them, so a style change stated
// in the same turn as a real action or a question still gets folded in.
function styleResultsBlock(styleFacts: string[]): string {
  return `# Your own settings changed this turn (by you, just now)
${styleFacts.map((f) => `- ${f}`).join('\n')}

This is real and it applies starting with THIS reply. Acknowledge it briefly and casually — one short line is enough. If nothing else happened this turn, that line is your whole reply: say it and stop, don't pad it out. If something else also belongs in this reply, fold the acknowledgment in naturally rather than tacking it on.`;
}

// `reason` is empty for the speculative call — the action pass hasn't spoken
// yet. That costs nothing, because a speculation is only ever SHOWN on an
// intent: 'conversation' turn, where the reason is "nothing to do" and there is
// no question for the reply to ask.
function noActionResultsBlock(reason: string, pendingConfirmCard?: string | null): string {
  // SERVER-AUTHORED, and that is the whole point. The model's own `reason` is
  // the only untrusted string in this prompt (it gets dropped outright when it
  // names a tool — see the capture site), and dropping it left the reply pass
  // with nothing to explain itself with: on "undo that" against a pending card
  // it fell straight back to pattern-matching the request and wrote "Undone —
  // Buy eggs is back", on a turn where nothing ran. This states the same fact,
  // computed from the database rather than written by a model, so it is always
  // there and always true.
  const pendingNote = pendingConfirmCard
    ? `\n\n# A confirmation card is on screen and they have NOT tapped it\nIt reads: "${pendingConfirmCard}"\nA card that has not been tapped has changed NOTHING. If they asked you to undo, cancel, or take that back: there is nothing to undo, because nothing has happened yet. Say exactly that — plainly, in one sentence — and tell them they can simply ignore the card or tap Cancel. Never say you undid, reversed, restored or brought anything back: you did not, and their list is untouched.`
    : '';
  return `# No action was taken this turn${reason ? `\nThe action layer declined, and this is why: ${reason}\nIf that reason says something is ambiguous or missing, ASK for exactly that — one short, specific question naming the real options or the missing value. Do not answer it yourself, and do not act as though it were already resolved.` : ''}${pendingNote}

Say the ONE thing this turn needs and stop. If a detail is missing, ask for it — just the question, nothing around it ("How much are you saving toward?"). Do not recap what they already have, do not list their existing tasks or goals, do not describe any card, do not offer a menu of next steps, and do not add a closing flourish. Extra sentences are not friendliness here; they are noise, and every one of them is a chance to say something untrue.

Do not claim or imply that anything was created, changed, logged, removed, or previewed — nothing was. The user is looking at an unchanged list: a reply that says you completed, created, or logged something is simply false, and they will see that it is.`;
}

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
  // Provider-specific request fields the OpenAI SDK's types don't know about
  // (DeepSeek's `thinking` toggle), set PER PASS — the two passes want
  // opposite things, and a single shared value was measurably wrong. See
  // providers/deepseek.ts for what it sends and the measurements behind it.
  // Empty for OpenAI proper, which rejects unknown body params outright.
  actExtra: Record<string, unknown> = {},
  narrateExtra: Record<string, unknown> = {},
  // Used INSTEAD of narrateExtra when the action pass reports that the user's
  // message held no task/goal intent at all (no_action intent: 'conversation').
  // See providers/deepseek.ts: that is the one narrate turn where reasoning
  // buys nothing, because there is no request in flight to falsely confirm.
  narrateConversationExtra: Record<string, unknown> = {},
  // The reply pass's state block. Same as `tailText` minus the recent-changes
  // feed and the undo target: those are GROUNDING for the action pass, and the
  // reply pass read them as news and announced them unprompted (a plain "What's
  // up dawg" came back as "Already got you — just tapped that confirm, so
  // they're all gone now"). A pass cannot announce what it cannot see.
  narrateTailText: string = tailText,
  // The state block for a PURE-CONVERSATION reply: just the clock. No task list,
  // no goals, no recent-changes feed. See the speculation below for why.
  conversationTailText: string = narrateTailText,
  // Tasks + goals only — what the guards judge the reply against. See
  // routes/messages.ts for why this is NOT tailText.
  stateFactsText: string = tailText,
): AsyncGenerator<ChatStreamEvent> {
  const windowed = windowHistory(history).filter((m) => m.content.trim().length > 0);
  const {
    toolCallLog,
    emittedSegments,
    logTurn,
    maybeCorrectFakeAction,
    maybeCorrectConcealedAction,
    maybeCorrectFabricatedFigure,
  } = createTurnState(actionCtx);

  const maxTokens = (n: number) =>
    maxTokensParam === 'max_tokens' ? { max_tokens: n } : { max_completion_tokens: n };

  try {
    // ---- pass 1: act -----------------------------------------------------
    const actionMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: 'system', content: ACTION_SYSTEM_PROMPT },
      { role: 'system', content: tailText },
      // The FULL record, pending cards included. Filtering them out here left two
      // user messages back-to-back with no assistant turn, and the act pass —
      // seeing a request it appeared never to have answered — stopped acting on
      // the next one. See routes/messages.ts.
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
    // Kept apart from actionFacts on purpose — see failureResultsBlock.
    const failureFacts: string[] = [];
    // adjust_style successes — kept apart from actionFacts on purpose too:
    // a style change is real (it belongs in the results block), but a turn
    // whose ONLY effect was adjusting style must NOT go silent under the
    // "cards speak for themselves" rule below — there is no card, so silence
    // would be the one case that really did say nothing back. See the
    // silence-skip condition and styleResultsBlock.
    const styleFacts: string[] = [];
    // Why the action pass declined, in its own words — the ONLY channel
    // between the two passes on a no-action turn. Without it the reply pass
    // knows only "nothing happened" and not *why*, so it can't ask the
    // question the act pass wanted asked: observed live on an ambiguous
    // "mark water done" (two matching tasks) — the act pass correctly
    // refused to guess, and the reply pass, told nothing, confidently
    // claimed the task was completed anyway (3 of 3 runs), leaving the
    // claim-check to retract it. The right reply was "which one?", and only
    // the act pass knew that.
    let noActionReason = '';
    // 'conversation' = the user asked for nothing at all (greeting, venting,
    // banter). 'unfulfilled' = they DID want something, and it couldn't be
    // done yet (missing number, ambiguous ref, a pending card). Only the
    // former unlocks the fast reply path — see the narrate call below.
    let noActionIntent: 'conversation' | 'unfulfilled' | '' = '';

    /**
     * SPECULATION — start the reply before we know whether we'll need it.
     *
     * A pure-conversation turn is strictly serial today: context -> act (~2.2s)
     * -> narrate (~1.1s). But the second key of the fast-path gate
     * (looksPurelyConversational) reads ONLY the user's own message — it does
     * not depend on the action pass at all. So when that key already turns, the
     * reply can be dispatched CONCURRENTLY with the action pass rather than
     * after it, and time-to-first-token becomes max(act, narrate) instead of
     * act + narrate.
     *
     * Safety is unchanged, and this is the crux: a speculation is only ever
     * SHOWN if BOTH keys turn — the action pass must still come back with
     * no_action AND intent 'conversation'. The action pass still runs, still
     * judges, and still owns every tool call; nothing is bypassed or routed
     * around it. If it acted, or declined for any reason other than "there was
     * nothing here to act on", this stream is aborted unread and the real
     * narrate runs exactly as before. A wrong guess costs tokens, never
     * correctness.
     */
    const newestUserMessage = windowed[windowed.length - 1]?.content ?? '';
    const mayBeConversational = looksPurelyConversational(newestUserMessage);
    // When the user is just talking, the reply pass has no business seeing their
    // task state — and the surest way to stop it narrating a task is not to show
    // it one. Both the CARD turns and the whole state block come out:
    //
    //   - Cards out of history. They are real history and must exist for the
    //     action pass (dropping them left a hole the model tried to fill), but on
    //     "What's up dawg" they are precisely what it should not be reporting on.
    //   - State block down to the clock. With the task list, the goals and the
    //     recent-changes feed in front of it, a greeting reliably came back as a
    //     status report: "Already got you — just tapped that confirm, so they're
    //     all gone now. Tasks are cleared out."
    //
    // A pass cannot announce what it cannot see. That is a guarantee; "please
    // don't mention their tasks" would only have been a request — and this
    // session's whole lesson is that the difference matters.
    const conversationHistory = buildConversationHistory(windowed);
    const speculation = mayBeConversational
      ? client.chat.completions
          .create({
            model,
            stream: true,
            ...maxTokens(NARRATE_MAX_OUTPUT_TOKENS),
            messages: [
              ...buildTailedMessages(buildSystemPrompt(user) + buildMemoryBlock(user.memories ?? []), conversationTailText + buildStyleBlock(user), conversationHistory),
              { role: 'system', content: noActionResultsBlock('') },
            ],
            ...narrateConversationExtra,
          } as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming)
          .then((stream) => ({ ok: true as const, stream }))
          // A failed speculation is a non-event: fall through to the real
          // narrate below, which will surface any genuine outage itself.
          .catch((err: unknown) => ({ ok: false as const, err }))
      : null;

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
          ...actExtra,
        } as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming);
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
          ...actExtra,
        } as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming);
      }

      const message = completion.choices[0]?.message;
      const calls = message?.tool_calls ?? [];
      if (!calls.length) break;

      const assistantToolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] = [];
      const toolResultMessages: OpenAI.Chat.Completions.ChatCompletionToolMessageParam[] = [];
      let sawRealCall = false;
      // Another round costs a full ~9k-token round trip (~1.5-2s, measured),
      // so it has to earn its place. Exactly two things earn it:
      //   1. A create_task succeeded — it minted a NEW ref the model couldn't
      //      have known at turn start, and the create->act chain ("created the
      //      counter, now log your current 165") needs a round to use it.
      //   2. A call FAILED — the tool result is a corrective message ("that
      //      titleHint doesn't match", "arguments were not valid JSON — retry")
      //      and the retry is the whole point of sending it.
      // Everything else (complete/log/edit/postpone/remove/undo/no_action) is
      // terminal: the model has nothing left to decide, and the extra round
      // just returns zero calls and breaks. That wasted round was firing on
      // nearly every action turn — the act pass averaged 2 rounds.
      let needsAnotherRound = false;

      for (const call of calls) {
        if (call.type !== 'function') continue;
        assistantToolCalls.push(call);

        if (call.function.name === NO_ACTION_TOOL_NAME) {
          try {
            const args = call.function.arguments.trim() ? JSON.parse(call.function.arguments) : {};
            const reason = (args as { reason?: unknown }).reason;
            // THE contamination channel, and the only one. Every other string
            // crossing into the reply pass's prompt is server-computed; this one
            // the model wrote itself, and we hand it straight back to a model.
            // When it names its own mechanics ("nothing to undo — the pending
            // remove_task card hasn't been tapped"), the reply pass reads a tool
            // name in its own instructions and echoes it to the user — observed
            // live on "undo that", leaking `[I called remove` into the chat.
            // A reason that talks about tools is worthless to the reply anyway:
            // it exists to say what to ASK the user. Drop it and fall back to the
            // generic block rather than launder tool-speak into the prompt.
            if (typeof reason === 'string' && reason.trim() && !isToolCallMarkupLeak(reason)) {
              noActionReason = reason.trim();
            } else if (typeof reason === 'string' && isToolCallMarkupLeak(reason)) {
              logger.warn(
                { userId: actionCtx.userId, sourceMessageId: actionCtx.sourceMessageId, reason },
                'no_action reason named a tool — dropped rather than injected into the reply prompt',
              );
            }
            const intent = (args as { intent?: unknown }).intent;
            if (intent === 'conversation' || intent === 'unfulfilled') noActionIntent = intent;
          } catch {
            // A malformed no_action argument is not worth failing a turn
            // over — the reply pass just falls back to the generic
            // no-action block, exactly as it behaved before reasons existed.
          }
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
          needsAnotherRound = true; // the retry is the whole point of that message
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
          actionCtx.pendingConfirmCard,
          actionCtx.userMessageText,
        );

        if (result.ok && 'taskPreview' in result) {
          // Always task_creation_pending — create_task never saves by
          // itself when this preference is on, only the confirm tap does.
          toolCallLog.push({ name: call.function.name, ok: true, pending: true });
          yield { type: 'action_task_preview', toolName: result.toolName, preview: result.taskPreview, summary: result.summary, recordKind: result.recordKind };
          actionFacts.push(result.summary);
          toolResultMessages.push({ role: 'tool', tool_call_id: call.id, content: result.summary });
        } else if (result.ok && 'tasks' in result) {
          // Always task_bulk_removal_pending — remove_tasks never mutates
          // by itself, only its own confirm card does.
          toolCallLog.push({ name: call.function.name, ok: true, taskId: result.tasks.map((t) => t.id).join(','), pending: true });
          yield { type: 'action_bulk', toolName: result.toolName, tasks: result.tasks, summary: result.summary, recordKind: result.recordKind };
          actionFacts.push(result.summary);
          toolResultMessages.push({ role: 'tool', tool_call_id: call.id, content: result.summary });
        } else if (result.ok && 'preview' in result) {
          // Always goal_preview — create_goal never saves by itself.
          toolCallLog.push({ name: call.function.name, ok: true, pending: true });
          yield { type: 'action_preview', toolName: result.toolName, preview: result.preview, detail: result.detail, summary: result.summary, recordKind: result.recordKind };
          actionFacts.push(result.summary);
          toolResultMessages.push({ role: 'tool', tool_call_id: call.id, content: result.summary });
        } else if (result.ok && 'goal' in result) {
          toolCallLog.push({ name: call.function.name, ok: true, taskId: result.goal.id, pending: result.recordKind === 'goal_advance_pending' });
          yield { type: 'action_goal', toolName: result.toolName, goal: result.goal, summary: result.summary, recordKind: result.recordKind, proposal: result.proposal };
          actionFacts.push(result.summary);
          toolResultMessages.push({ role: 'tool', tool_call_id: call.id, content: result.summary });
        } else if (result.ok && 'memory' in result) {
          // A real card, like any other action — participates in the
          // ordinary §3 silence rule (actionFacts, not styleFacts).
          toolCallLog.push({ name: call.function.name, ok: true, pending: false });
          yield { type: 'action_memory', toolName: result.toolName, memory: result.memory, summary: result.summary, recordKind: result.recordKind };
          actionFacts.push(result.summary);
          toolResultMessages.push({ role: 'tool', tool_call_id: call.id, content: result.summary });
        } else if (result.ok && 'styleSummary' in result) {
          // No card — a prefs write, not a task/goal record — so no `yield`
          // here. Goes to styleFacts, not actionFacts, precisely so the
          // silence-skip check below still runs the narrate pass.
          toolCallLog.push({ name: call.function.name, ok: true, pending: false });
          styleFacts.push(result.styleSummary);
          toolResultMessages.push({ role: 'tool', tool_call_id: call.id, content: result.styleSummary });
        } else if (result.ok) {
          toolCallLog.push({ name: call.function.name, ok: true, taskId: result.task.id, pending: result.recordKind === 'task_removal_pending' });
          yield { type: 'action', toolName: result.toolName, task: result.task, summary: result.summary, detail: result.detail, recordKind: result.recordKind };
          actionFacts.push(result.modelSummary ?? result.summary);
          toolResultMessages.push({ role: 'tool', tool_call_id: call.id, content: result.modelSummary ?? result.summary });
          // Only create_task hands back a ref that didn't exist at turn start
          // (registerCreatedTaskRef) — that's the one success worth another
          // round, so a "created it, now log my current 165" chain can land.
          if (result.toolName === 'create_task') needsAnotherRound = true;
        } else {
          toolCallLog.push({ name: call.function.name, ok: false, error: result.error });
          failureFacts.push(result.error);
          toolResultMessages.push({ role: 'tool', tool_call_id: call.id, content: result.error });
          // Ordinarily a corrective error is worth another round — give the
          // model a chance to fix and retry. A small set of failures
          // (result.retryable === false — a free-plan creation cap) are
          // deterministic within this turn: nothing the model does changes
          // the outcome, so looping just spends a guaranteed-empty round
          // trip. The "do not retry" sentence in the fact usually gets a
          // no_action next round anyway; this just stops paying for it.
          if (result.retryable !== false) needsAnotherRound = true;
        }
      }

      actionMessages.push({ role: 'assistant', content: message?.content ?? null, tool_calls: assistantToolCalls });
      actionMessages.push(...toolResultMessages);

      // A pure-no_action round means the pass decided nothing (more) needs
      // doing — don't loop it into deciding again. And a round of purely
      // terminal successes has nothing left to decide either: looping there
      // buys a guaranteed-empty round trip (see needsAnotherRound above).
      if (!sawRealCall || !needsAnotherRound) break;
    }

    /**
     * THE CARD IS THE CONFIRMATION — so when the turn did what it was asked,
     * say nothing.
     *
     * Every prose failure in this file's history lives in the sentence the reply
     * pass writes ABOUT an action that already succeeded: claiming an action it
     * didn't take, hiding one it did, inventing a total, and then the corrective
     * bubbles bolted on to catch those ("To be clear though — I just did that
     * now") which fired on roughly one action turn in four and read as a
     * malfunction. None of that prose carries information the user doesn't
     * already have: the action card is rendered directly above it, live from the
     * database, with the task's real title, schedule and state.
     *
     * So a turn whose tool calls all SUCCEEDED emits its cards and stops. No
     * narrate call at all. That deletes the entire lie surface for action turns
     * rather than policing it, and it removes a model round-trip (~1-2s) from
     * every create/complete/log.
     *
     * Prose is kept exactly where it carries information the card cannot:
     *  - a FAILED call — the card never renders, so silence would leave the user
     *    thinking it worked. They must be told, in words.
     *  - a no-action turn — the reply IS the product: the clarifying question,
     *    the missing amount, "which one did you mean". Asking BEFORE acting is
     *    the point; narrating after it is noise.
     *  - ordinary conversation.
     */
    const anyFailed = failureFacts.length > 0;
    // A style adjustment is real, but has no card — "the card is the
    // confirmation" doesn't hold for it, so it must never fall through this
    // silence rule on its own. styleFacts.length === 0 is the whole carve-out.
    if (actionFacts.length > 0 && !anyFailed && styleFacts.length === 0) {
      if (speculation) {
        const settled = await speculation;
        if (settled.ok) {
          try {
            settled.stream.controller.abort();
          } catch {
            // already settled
          }
        }
      }
      logger.info(
        { userId: actionCtx.userId, sourceMessageId: actionCtx.sourceMessageId, cards: toolCallLog.length },
        'action turn — cards speak for themselves, no narration',
      );
      logTurn();
      yield { type: 'stream_end' };
      return;
    }

    // ---- pass 2: narrate ---------------------------------------------------
    // The reply pass does not get the loose ends: a pending card's text is an
    // instruction to the USER ("Tap to confirm removing X"), and replayed as a past
    // assistant turn it reads as an open request still owed a follow-up. It learns
    // what it needs about a pending card from a server fact instead
    // (actionCtx.pendingConfirmCard).
    const narrateHistory = windowed.filter((m) => !m.isPendingCard && !m.isActionAck);
    const narrateMessages = buildTailedMessages(buildSystemPrompt(user) + buildMemoryBlock(user.memories ?? []), narrateTailText + buildStyleBlock(user), narrateHistory);
    // Action/failure priority is unchanged from before styleFacts existed
    // (see actionResultsBlock/failureResultsBlock) — style is composed
    // ALONGSIDE that choice, never in place of it, so a style change stated
    // in the same turn as a real action or a failure still surfaces.
    const baseResultsBlock =
      actionFacts.length > 0
        ? actionResultsBlock(actionFacts)
        : failureFacts.length > 0
          ? failureResultsBlock(failureFacts)
          : styleFacts.length > 0
            ? '' // nothing else happened — the style block below is the whole story
            : noActionResultsBlock(noActionReason, actionCtx.pendingConfirmCard);
    narrateMessages.push({
      role: 'system',
      content:
        styleFacts.length > 0
          ? [baseResultsBlock, styleResultsBlock(styleFacts)].filter(Boolean).join('\n\n')
          : baseResultsBlock,
    });

    /**
     * TWO keys, and both must turn before reasoning is dropped from the reply.
     *
     * Key 1 is the action pass declaring no_action with intent 'conversation'.
     * On its own that is NOT safe: asked "was there any task/goal intent here",
     * the model labelled "saved my $5 today" as 'conversation' 3 times out of 3
     * — because there was nothing left to DO about it (already recorded), so it
     * conflated "nothing to do" with "nothing asked". With reasoning then off,
     * the reply confirmed the save it had just read, on a turn where zero tools
     * ran. Tightening the wording only swung it the other way: the fast path
     * then never fired at all.
     *
     * Key 2 (looksPurelyConversational, shared.ts) is a dumb literal scan of
     * what the USER typed. The asymmetry is deliberate — a false positive there
     * costs a little latency and nothing else, while a false negative is still
     * caught by the model's own 'unfulfilled'. Neither key can, alone, put a
     * real request on the fast path.
     */
    // styleFacts.length === 0 is defensive: the fast path's own results
    // block (below) only knows noActionResultsBlock, so a turn that also
    // adjusted style must never take this branch even in the unlikely case
    // the act pass paired adjust_style with a no_action(intent:'conversation')
    // call in the same turn.
    const fastPath =
      actionFacts.length === 0 &&
      styleFacts.length === 0 &&
      noActionIntent === 'conversation' &&
      mayBeConversational;

    let stream: Awaited<ReturnType<typeof client.chat.completions.create>> | null = null;
    if (fastPath && speculation) {
      const settled = await speculation;
      if (settled.ok) {
        stream = settled.stream;
        logger.info(
          { userId: actionCtx.userId, sourceMessageId: actionCtx.sourceMessageId },
          'narrate fast path — speculation HIT (reply was already in flight during the action pass)',
        );
      }
    }

    if (!stream) {
      // Either we never speculated, or the action pass went somewhere the
      // speculation can't legally answer for (it acted, or it declined because
      // something was missing/ambiguous). Drop it unread — it was written
      // against "nothing happened", which is now either false or incomplete.
      if (speculation) {
        const settled = await speculation;
        if (settled.ok) {
          try {
            settled.stream.controller.abort();
          } catch {
            // Already finished or already aborted — nothing to clean up.
          }
        }
        logger.info(
          { userId: actionCtx.userId, sourceMessageId: actionCtx.sourceMessageId, acted: actionFacts.length > 0, intent: noActionIntent || 'none' },
          'narrate speculation DISCARDED — the action pass went another way',
        );
      }
      stream = await client.chat.completions.create({
        model,
        stream: true,
        ...maxTokens(NARRATE_MAX_OUTPUT_TOKENS),
        // A fast-path turn that lost its speculation still gets the clean
        // conversational context, not the state-laden one.
        messages: fastPath
          ? [
              ...buildTailedMessages(buildSystemPrompt(user) + buildMemoryBlock(user.memories ?? []), conversationTailText + buildStyleBlock(user), conversationHistory),
              { role: 'system', content: noActionResultsBlock(noActionReason, actionCtx.pendingConfirmCard) },
            ]
          : narrateMessages,
        // No tools at all — this pass talks; it cannot act.
        ...(fastPath ? narrateConversationExtra : narrateExtra),
      } as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming);
    }

    let buffer = '';
    let emittedLength = 0;
    let finishReason: string | null = null;
    let anySegmentEmitted = false;
    let leaked = false;

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

      // No tools in this pass, so a raw-markup leak can't be a lost call — just
      // junk the model shouldn't show. Drop EVERYTHING, not merely the rest:
      // truncating to what had already been emitted persisted the leak's own
      // PREFIX as a reply ("[I called remove", seen live). A partial leak is not
      // a partial reply, it is garbage with a cliff edge — and worse, it gets
      // persisted and fed back as history, which is how this class of leak
      // teaches itself (see the history filter in routes/messages.ts).
      if (isToolCallMarkupLeak(buffer)) {
        logger.warn(
          { userId: actionCtx.userId, sourceMessageId: actionCtx.sourceMessageId },
          'narrate pass leaked raw tool-call markup — discarding the whole reply',
        );
        buffer = '';
        leaked = true;
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
    if (leaked) {
      // Nothing salvageable. The claim-check below still runs and will speak if
      // the (now-discarded) reply had claimed anything; otherwise an honest
      // "say something" fallback covers the silence.
      remaining = anySegmentEmitted ? '' : "Hm, that glitched on my end — mind asking again?";
    } else if (finishReason === 'length' && buffer.trim().length === 0) {
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

    // Backstop for turns with no real mutation — the narrate pass has no
    // tools, so a claimed action there is always false. Always call this;
    // maybeCorrectFakeAction's own gate (toolCallLog has a non-pending
    // success) is what actually decides whether a real mutation happened —
    // gating on toolCallLog.length here too would wrongly skip a turn whose
    // only successful calls were pending-confirmation cards (see its
    // comment). no_action deliberately doesn't count as a real call either
    // way.
    yield* maybeCorrectFakeAction(stateFactsText);
    // The other half of the same guarantee. maybeCorrectFakeAction returns
    // the instant a real mutation exists, so it has never once looked at an
    // action turn's narration — and the reply passing a fresh action off as
    // pre-existing ("already done — you're good") measured 8.3% of action
    // turns. Exactly one of these two can fire on any given turn: that one
    // guards "said it happened when it didn't", this one guards "it happened
    // and the reply hid it".
    yield* maybeCorrectConcealedAction(actionFacts);
    // The third guard. Everything the reply was entitled to state a number from:
    // the live state block (task list, goal totals, streaks, the clock), whatever
    // the server actually did this turn, and the user's own words. A figure that
    // can't be justified from these was invented.
    yield* maybeCorrectFabricatedFigure(
      [stateFactsText, ...actionFacts, newestUserMessage].filter(Boolean).join('\n'),
    );
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
