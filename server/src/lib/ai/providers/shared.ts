import type OpenAI from 'openai';

import { logger } from '../../../logger.ts';
import type { TaskRow } from '../../tasks/executor.ts';
import type { GoalRow } from '../../goals/executor.ts';
import type { AdvanceStageProposal, GoalPreview } from '../../goals/schema.ts';
import { didClaimAction, didConcealAction } from '../claim-check.ts';
import type { TurnRefs } from '../task-context.ts';

// Streaming, non-thinking replies don't need much room — keep this modest so a
// runaway response can't stall the SSE connection. Raised from 1024: turn-
// scoped aliases (task-context.ts) shrink every tool-call payload, and
// remove_tasks collapses what used to be N remove_task calls into one — this
// is headroom for the remaining cases, not a fix for either on its own.
export const MAX_OUTPUT_TOKENS = 1536;

// Conversation context window: cap both message count and total characters so
// a long-running relationship doesn't balloon every request's token cost.
// Kept modest (not just for cost) — a long window of near-identical
// "I did X" turns is exactly the kind of repetition that makes a model more
// likely to pattern-complete that shape instead of actually deciding fresh
// each time whether to call a tool. The live task list (buildTaskContext),
// not history, is the source of truth for what currently exists.
export const MAX_HISTORY_MESSAGES = 24;
export const MAX_HISTORY_CHARS = 16_000;

// Between finishing one "text" and starting the next, pause briefly so a
// multi-bubble reply feels like separate messages arriving, not one message
// artificially chopped up.
export const SEGMENT_PAUSE_MIN_MS = 500;
export const SEGMENT_PAUSE_MAX_MS = 1100;

// A single user message shouldn't trigger a long chain of actions — task
// requests are 1-2 calls at most. This also bounds a pathological loop.
export const MAX_TOOL_ITERATIONS = 3;

export type ChatHistoryMessage = { role: 'user' | 'assistant'; content: string };

export type ChatStreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'segment_end'; text: string }
  | { type: 'action'; toolName: string; task: TaskRow; summary: string; recordKind: string }
  | { type: 'action_bulk'; toolName: string; tasks: TaskRow[]; summary: string; recordKind: string }
  // A goal action — edit_goal/log_goal_entry, or an
  // undo_last_action that reverted a goal_% record. `proposal` is set only
  // for advance_goal_stage's pending-confirmation result (recordKind:
  // 'goal_advance_pending') — routes/messages.ts persists it on the confirm
  // card message's meta so POST /goals/:id/advance can re-validate it.
  | {
      type: 'action_goal';
      toolName: string;
      goal: GoalRow;
      summary: string;
      recordKind: string;
      proposal?: AdvanceStageProposal;
    }
  // create_goal — a preview only, nothing saved yet (docs/goals-redesign-
  // plan.md §2.1). routes/messages.ts persists this as a goal_preview
  // message; POST /goals {previewMessageId} is the actual save.
  | { type: 'action_preview'; toolName: string; preview: GoalPreview; summary: string; recordKind: string }
  | { type: 'stream_end' }
  | { type: 'error'; retryable: boolean; message: string };

export type ChatActionContext = {
  userId: string;
  timezone: string | null;
  sourceMessageId: string;
  // This turn's alias -> real-id map (task-context.ts) — every taskRef/
  // itemRef a tool call sends is resolved against this before it executes.
  refs: TurnRefs;
};

// Shared by the two OpenAI-compatible providers (openai.ts, deepseek.ts).
// The volatile tail block (current time, counts, live task list, recent
// out-of-band changes — system-prompt.ts's buildTailBlock) is inserted as
// its own system message *after* history and right before the newest user
// turn, instead of as a second system message up front — with nothing
// dynamic spliced between the stable system prompt and history anymore,
// every message except the newest two becomes a stable, cacheable prefix
// (docs/ai-reliability-hardening.md item 4).
export function buildTailedMessages(
  systemPrompt: string,
  tailText: string,
  windowed: ChatHistoryMessage[],
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const rest = windowed.slice(0, -1);
  const newest = windowed[windowed.length - 1];
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    ...rest.map((m): OpenAI.Chat.Completions.ChatCompletionMessageParam => ({
      role: m.role,
      content: m.content,
    })),
    { role: 'system', content: tailText },
  ];
  if (newest) messages.push({ role: newest.role, content: newest.content });
  return messages;
}

export function windowHistory(history: ChatHistoryMessage[]): ChatHistoryMessage[] {
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

export function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

// Same-turn safety net for the "claimed an action without calling the
// tool" failure: every segment_end text gets collected here, and if the
// whole turn ends with zero tool calls yet the text still sounds like a
// task-action confirmation (a quoted title next to a past-tense action
// verb — the exact shape observed in practice, e.g. `Added "Feed cats"`),
// one corrective segment gets appended instead of leaving a false
// confirmation uncorrected. Deliberately narrow (not a general lie
// detector) to avoid false-positives on ordinary conversation.
const FAKE_ACTION_PATTERN =
  /\b(added|removed|deleted|marked|updated|moved|started|paused|logged|created)\b[^.!?]{0,30}["“]/i;
// Its own pattern, not folded into FAKE_ACTION_PATTERN above — a preview
// claim needs its own corrective copy (see maybeCorrectFakeAction below),
// so it has to be distinguishable from the other matches, not just another
// alternative in the same regex. Observed live (server log, July 12):
// deepseek-v4-flash twice narrated a specific create_tool preview
// ("Preview's up — Chest Day tracker… tap Create") with zero tool calls
// (docs/goals-redesign-plan.md §2.6) — the classifier caught both, but the
// free regex tier should catch this shape without waiting on it.
//
// Widened after the §4 acceptance protocol's hallucination probe caught a
// live miss this original version didn't: "Sending a preview your way —
// **$500 laptop fund**... Check the card and tap **Create**" scored
// matched_regex: false AND claim_check: no (the classifier's prompt didn't
// name a preview claim as a qualifying case either — fixed in
// claim-check.ts's CLASSIFIER_SYSTEM_PROMPT alongside this). Two gaps: (1)
// present-tense "sending"/"here's" phrasing the original verb list didn't
// cover, (2) "tap **Create**" — markdown bold sits between "tap" and
// "Create", breaking the literal-adjacency assumption in the old `tap
// create\b` alternative. `\**` between words below tolerates that; testing
// against the markdown-stripped `text` in maybeCorrectFakeAction handles it
// more generally for every pattern, not just this one.
const PREVIEW_CLAIM_PATTERN =
  /\b(preview|card)('s| is)?\s*(up|sent|ready)|(sending|sent|here'?s)\s+(you\s+)?(a|the)\s+(preview|card)|tap\s*\**\s*create\b/i;
// Second, independent signal: a literal mention of one of our tool names
// in bracket notation. Legitimate replies never look like this — the only
// known source was the model reproducing an internal history-compaction
// marker verbatim on a turn where it hadn't actually called anything
// (fixed at the source in messages.ts's historyContentFor, which no
// longer feeds that marker back into the model at all) — kept here as a
// backstop in case a similar leak happens through some other path.
// remove_tasks (plural) is its own alternative, not just implied by
// remove_task — the trailing \b doesn't fire between "task" and a following
// "s" (both word chars), so without it a leaked "[remove_tasks" marker
// would silently fail to match at all. The old create_tool/edit_tool/
// log_tool_entry names are kept alongside the current create_goal/edit_goal/
// log_goal_entry ones — a backstop against a leak of an older, cached
// system-prompt or history string still using the pre-rename names
// (docs/goals-redesign-plan.md §2.1).
const TOOL_NAME_LEAK_PATTERN =
  /\[(create_task|edit_task|complete_task|progress_task|postpone_task|remove_task|remove_tasks|create_goal|edit_goal|log_goal_entry|remove_goal|create_tool|edit_tool|log_tool_entry)\b/i;

// Observed on DeepSeek v4-flash: instead of a structured tool_calls delta,
// the model occasionally emits its own function-call templating as literal
// content — fullwidth-pipe-wrapped sentinel tokens like
// `<｜｜DSML｜｜tool_calls><｜｜DSML｜｜invoke name="remove_task">...`. This is
// never legitimate reply text, so any provider can check for it and drop
// the offending segment rather than showing raw internal markup to the
// user (see providers/deepseek.ts for where this gets applied).
const RAW_TOOL_CALL_MARKUP_PATTERN = /｜{1,2}\s*DSML\s*｜{1,2}/;

// The same leak in PROSE rather than DeepSeek's sentinel markup: the reply
// pass narrating the mechanics of a call instead of its outcome. Seen live in
// the simulator as separate chat bubbles the user actually read:
//     calling create_task with title "Water the plants", due at 2026-07-13T10:00:00-07:00
//     `create_task(title="Pick up sister", recurrence={ "interval": "weekly", ... })`
// Note the second one's schema is INVENTED (we have no dueDateTime or
// daysOfWeek param) — the model isn't echoing a real call, it's performing one
// for the user, which is both confusing and a lie about how the app works.
//
// A user-facing reply has no legitimate reason to contain one of our snake_case
// tool names, ever — the system prompt already forbids naming them (the same
// rule that forbids writing a "T2" ref). Matching the bare name is therefore
// safe: ordinary English ("I'll create a task for you") has no underscore and
// cannot trip this.
//
// The second alternative exists because matching the tool NAME alone was not
// enough, and the way it failed matters. Once a leak like `calling create_task
// with title "..."` is persisted as an assistant message, it goes back into the
// model's own history — and the model imitates it. What came back was a
// DEGRADED copy: a bare `calling create`, with no underscore, which the
// name-only pattern sailed straight past. So the phrasing of the narration gets
// matched too, not just the identifier inside it. "calling"/"invoking" followed
// by one of our action verbs is never ordinary reply text; a real task titled
// "Call the dentist" trips none of it (no "calling create").
const TOOL_MECHANICS_LEAK_PATTERN =
  /\b(create_task|edit_task|complete_task|progress_task|postpone_task|remove_task|remove_tasks|create_goal|edit_goal|remove_goal|log_goal_entry|advance_goal_stage|undo_last_action|no_action)\b|\b(calling|invoking|executing|running)\s+(the\s+)?(create|edit|complete|progress|postpone|remove|delete|log|undo|advance)\b/i;

export function isToolCallMarkupLeak(text: string): boolean {
  return RAW_TOOL_CALL_MARKUP_PATTERN.test(text) || TOOL_MECHANICS_LEAK_PATTERN.test(text);
}

// `pending` marks a successful call whose recordKind is a tap-to-confirm
// card (task_removal_pending, task_bulk_removal_pending, goal_preview,
// goal_advance_pending) — nothing was actually mutated, only shown. Distinct
// from `ok` (which is about whether the call itself succeeded): a pending
// call is `ok: true` but still leaves the turn with zero real mutations.
export type ToolCallLogEntry = { name: string; ok: boolean; taskId?: string; error?: string; pending?: boolean };

// The free tier of the CONCEALMENT check — the mirror of FAKE_ACTION_PATTERN.
// Deliberately loose: it only decides whether the classifier is worth a call,
// and "already" is far too common a word to act on by itself ("logged it —
// you're already at $5 of $300" is perfectly honest, and refers to real prior
// state). So this over-matches on purpose and lets didConcealAction make the
// actual judgment; a false positive here costs one cheap classifier call, a
// false negative costs a user who never learns their data changed.
// Measured trigger rate: ~11% of action turns.
const CONCEALMENT_PATTERN =
  /\balready\b|\bfrom (earlier|before)\b|\bnothing (got|was|has been)\b|\bno (change|changes)\b|\bwas (already|set)\b|\byou'?re (all )?(good|set)\b/i;

/**
 * Per-turn state shared by every provider: the tool-call log (the ground
 * truth the "chat turn finished" line is measured against for hallucination
 * rate) and the fake-action self-correction check. One factory so every
 * provider gets identical behavior here instead of hand-copies drifting.
 */
export function createTurnState(actionCtx: ChatActionContext) {
  const toolCallLog: ToolCallLogEntry[] = [];
  const emittedSegments: string[] = [];

  function logTurn() {
    logger.info(
      { userId: actionCtx.userId, sourceMessageId: actionCtx.sourceMessageId, toolCalls: toolCallLog },
      'chat turn finished',
    );
  }

  // Regex is free and runs first; the classifier (lib/ai/claim-check.ts)
  // runs whenever there were zero tool calls this turn — that's the common
  // case for this branch, and it only adds latency at the very end of the
  // turn, after every real reply segment has already reached the user. Its
  // verdict is logged unconditionally (alongside whether the regex also
  // matched) so item 8's per-model false-claim rate has real numbers behind
  // it, not just the regex's narrower catch rate.
  async function* maybeCorrectFakeAction(): AsyncGenerator<ChatStreamEvent> {
    // A turn whose only successful calls were pending-confirmation cards
    // (recordKind task_removal_pending / task_bulk_removal_pending /
    // goal_preview / goal_advance_pending) mutated NOTHING — skipping self-
    // correction just because toolCallLog is non-empty let the narrate pass
    // claim a card's action was actually done (observed live: "yes do it"
    // on an advance_goal_stage card that had already fired once this
    // conversation re-triggered the pending card, and the reply said "moved
    // to Applying now — done" while the DB stayed on stage 1). Only a
    // genuinely mutating success should suppress this check entirely.
    if (toolCallLog.some((t) => t.ok && !t.pending)) return;
    const text = emittedSegments.join(' ');
    if (!text.trim()) return;
    // Markdown bold/italic markers can sit right inside a phrase a pattern
    // expects as literally adjacent (e.g. "tap **Create**") — stripped once
    // here so every regex below matches on the words, not the formatting
    // around them (docs/goals-redesign-plan.md §2.6, found live by the §4
    // acceptance protocol's hallucination probe).
    const stripped = text.replace(/[*_]{1,3}/g, '');

    // PREVIEW_CLAIM_PATTERN and the classifier are both built on the
    // premise "no card/preview exists at all this turn" (claim-check.ts's
    // system prompt says so explicitly) — true when there were zero
    // successful calls, but FALSE when a pending card genuinely was just
    // shown. Applying either in that case flags truthful narration ("tap it
    // to confirm moving to X") as a fake claim. Only FAKE_ACTION_PATTERN
    // (a completion VERB next to a quote, e.g. "you're moved to \"X\"") and
    // the markup/leak patterns stay meaningful either way — a pending
    // success can still falsely claim the underlying change is done, just
    // never falsely claim a card exists (one genuinely does).
    const hadPendingSuccess = toolCallLog.some((t) => t.ok && t.pending);
    const matchedPreviewClaim = !hadPendingSuccess && PREVIEW_CLAIM_PATTERN.test(stripped);
    const matchedRegex =
      matchedPreviewClaim ||
      FAKE_ACTION_PATTERN.test(stripped) ||
      TOOL_NAME_LEAK_PATTERN.test(stripped) ||
      RAW_TOOL_CALL_MARKUP_PATTERN.test(text);
    const claimed = hadPendingSuccess ? false : await didClaimAction(emittedSegments);

    logger.info(
      {
        userId: actionCtx.userId,
        sourceMessageId: actionCtx.sourceMessageId,
        claim_check: claimed ? 'yes' : 'no',
        matched_regex: matchedRegex,
        matched_preview_claim: matchedPreviewClaim,
        had_pending_success: hadPendingSuccess,
      },
      'claim-check verdict',
    );

    if (!matchedRegex && !claimed) return;

    logger.warn(
      { userId: actionCtx.userId, sourceMessageId: actionCtx.sourceMessageId, segments: emittedSegments },
      'chat turn self-corrected a likely unconfirmed action',
    );
    // A preview/card claim gets a truthful, specific correction instead of
    // the generic one — the failure here is always "no preview exists yet,"
    // not an ambiguous "something may not have gone through"
    // (docs/goals-redesign-plan.md §2.6 item 3).
    yield {
      type: 'segment_end',
      text: matchedPreviewClaim
        ? "Hm, that preview didn't actually go through — ask me again?"
        : "Hold on — I don't think that actually went through. Mind trying that again?",
    };
  }

  /**
   * The exact mirror of maybeCorrectFakeAction, for the failure it can never
   * see. That one returns immediately the moment a real mutation exists —
   * meaning on precisely the turns where something DID change, nothing has
   * ever checked what the reply said about it. This closes that side:
   * a turn that really acted, narrated as though it hadn't.
   *
   * Runs only when the turn actually did something (a mutation, or a card
   * genuinely shown), and only escalates to the classifier when the free
   * regex sees pre-existing/denial phrasing — so the extra call lands on a
   * small minority of turns, at the very end, after every real segment has
   * already reached the user.
   *
   * `actionFacts` are the same server-computed summaries the narrate pass was
   * handed, so the classifier compares the reply against what actually
   * happened rather than against a guess.
   */
  async function* maybeCorrectConcealedAction(actionFacts: string[]): AsyncGenerator<ChatStreamEvent> {
    // Nothing happened -> nothing to conceal; that turn is maybeCorrectFakeAction's.
    if (!toolCallLog.some((t) => t.ok)) return;
    if (!actionFacts.length) return;
    const text = emittedSegments.join(' ');
    if (!text.trim()) return;
    const stripped = text.replace(/[*_]{1,3}/g, '');

    // The regex gate is a COST optimization, and it may only be applied where
    // a miss is cheap. When this turn really mutated the user's data, a missed
    // concealment means they were told their data didn't change when it did —
    // so those always go to the classifier, no gate. That hole was real: the
    // first version gated everything on CONCEALMENT_PATTERN, and a live undo
    // that genuinely reverted a completion was narrated "I don't have a record
    // of any action to undo — I didn't actually mark it done." No "already",
    // no "nothing got" — the regex never matched, the classifier never ran,
    // and the user was told the opposite of what the database says.
    // Pending-card-only turns (a preview shown, nothing written) keep the gate:
    // the stakes are lower and the failure there is overwhelmingly the one
    // shape the regex does catch ("the card's already up").
    const mutated = toolCallLog.some((t) => t.ok && !t.pending);
    if (!mutated && !CONCEALMENT_PATTERN.test(stripped)) return;

    const concealed = await didConcealAction(emittedSegments, actionFacts);
    logger.info(
      {
        userId: actionCtx.userId,
        sourceMessageId: actionCtx.sourceMessageId,
        conceal_check: concealed ? 'yes' : 'no',
      },
      'concealment-check verdict',
    );
    if (!concealed) return;

    logger.warn(
      { userId: actionCtx.userId, sourceMessageId: actionCtx.sourceMessageId, segments: emittedSegments, actionFacts },
      'chat turn concealed a real action — correcting',
    );
    // Say the quiet part: it happened, and it happened NOW. The action card
    // above the reply already carries the specifics, so this only has to fix
    // the one thing the reply got wrong — the impression that nothing changed.
    //
    // Two different corrections, because the concealment is two different
    // lies. A turn whose only successes were tap-to-confirm cards mutated
    // NOTHING — nothing there was "done", so the generic "it wasn't already
    // done" copy would itself be false (and both concealments caught in
    // testing were exactly this case: "the card's already up"). The card was
    // SHOWN just now; that's the thing being hidden. A real mutation gets the
    // plain version.
    const onlyPendingSuccesses = toolCallLog.filter((t) => t.ok).every((t) => t.pending);
    yield {
      type: 'segment_end',
      text: onlyPendingSuccesses
        ? "To be clear — I put that card up just now, it wasn't there before. Nothing's saved until you tap it."
        : "To be clear though — I just did that now; it wasn't already done before you asked.",
    };
  }

  return { toolCallLog, emittedSegments, logTurn, maybeCorrectFakeAction, maybeCorrectConcealedAction };
}
