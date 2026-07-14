import type OpenAI from 'openai';

import { logger } from '../../../logger.ts';
import type { TaskRow } from '../../tasks/executor.ts';
import type { GoalRow } from '../../goals/executor.ts';
import type { AdvanceStageProposal, GoalPreview } from '../../goals/schema.ts';
import { didClaimAction, didConcealAction, didMisstateFigure } from '../claim-check.ts';
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

// `isCard` = this assistant turn was a CARD, not spoken words. Card turns are
// real history (the assistant did reply, and dropping them left a hole the model
// tried to fill — routes/messages.ts), but on a pure-conversation turn they are
// exactly the thing it should not be commenting on.
export type ChatHistoryMessage = {
  role: 'user' | 'assistant';
  content: string;
  // A CARD turn rather than spoken words. The conversation fast path drops these.
  isCard?: boolean;
  // A card that changed NOTHING and awaits a tap. The ACT pass needs these (their
  // absence tore a hole in the record and it stopped acting); the REPLY pass must
  // not have them (their text reads as an open request it owes a follow-up on).
  isPendingCard?: boolean;
};

export type ChatStreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'segment_end'; text: string }
  | { type: 'action'; toolName: string; task: TaskRow; summary: string; detail?: string; recordKind: string }
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
  // message; POST /goals {previewMessageId} is the actual save. `detail`
  // is the server-computed handoff caption (docs/goal-manual-editing-
  // plan.md §3.4).
  | { type: 'action_preview'; toolName: string; preview: GoalPreview; detail?: string; summary: string; recordKind: string }
  | { type: 'stream_end' }
  | { type: 'error'; retryable: boolean; message: string };

export type ChatActionContext = {
  userId: string;
  timezone: string | null;
  sourceMessageId: string;
  // Set when the NEWEST assistant message is a tap-to-confirm card the user
  // hasn't acted on — i.e. the thing they are looking at right now changed
  // nothing. "undo that" in that state must not reach past it (lib/ai/actions.ts).
  pendingConfirmCard?: string | null;
  // True when a create_goal preview really IS on screen, un-tapped. Without this,
  // PREVIEW_CLAIM_PATTERN retracted an honest reply for saying the true thing:
  // "the PS5 one is still in preview, waiting for you to tap Create" tripped the
  // pattern and got "Hm, that preview didn't actually go through" stapled on. The
  // pattern's whole premise is "no preview exists"; when one does, it is off.
  hasPendingPreview?: boolean;
  // This turn's alias -> real-id map (task-context.ts) — every taskRef/
  // itemRef a tool call sends is resolved against this before it executes.
  refs: TurnRefs;
  // The user's newest message, verbatim — lib/ai/ambiguity.ts's server-
  // side backstop judges ambiguity against what the USER actually said,
  // never the model's titleHint (its post-hoc justification for whichever
  // task it already picked). Optional so a caller that can't supply it
  // (none today) simply disables that one guard rather than failing.
  userMessageText?: string;
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
  /\b(create_task|edit_task|complete_task|progress_task|postpone_task|remove_task|remove_tasks|create_goal|edit_goal|remove_goal|log_goal_entry|advance_goal_stage|undo_last_action|no_action)\b|\b(call(s|ed|ing)?|invok(e|ed|ing)|execut(e|ed|ing)|run(s|ning)?|us(e|ed|ing))\s+(the\s+)?(create|edit|complete|progress|postpone|remove|delete|log|undo|advance)\b|\[\s*I\s+(call|invok|execut|us|run)/i;

export function isToolCallMarkupLeak(text: string): boolean {
  return RAW_TOOL_CALL_MARKUP_PATTERN.test(text) || TOOL_MECHANICS_LEAK_PATTERN.test(text);
}

// The SECOND key on the narrate fast path (providers/act-narrate.ts). The first
// key is the action pass declaring no_action intent: 'conversation', and on its
// own that was not safe enough — asked to judge "was there any task/goal intent
// here", the model reliably said 'conversation' for "saved my $5 today" (3 of 3)
// because there was nothing left to DO about it, conflating "nothing to do" with
// "nothing asked". With reasoning then off, the reply confirmed the save it had
// just read: "You're on it — $5 logged for today." Tightening the wording only
// swung it the other way — the fast path then never fired at all, on anything.
//
// So the model's judgment is not the gate; it is one of two. This is the other:
// a dumb, literal scan of what the USER actually typed. Both keys must agree
// before reasoning is turned off. The asymmetry is the point — a false positive
// here (calling a greeting task-ish) costs a little latency and nothing else,
// while a false negative is caught by the model's own 'unfulfilled'. Neither
// key can, alone, route a real request into the fast lane.
// The trailing alternatives are progress QUESTIONS, and they earn their place:
// "how am i doing so far?" trips none of the nouns or verbs above, so the regex
// waved it through and the action pass — reasonably enough, since there is
// nothing to DO about a status question — called it 'conversation'. Both keys
// turned, and a numbers recap got written with reasoning off. It came back
// correct in testing, but a recap is precisely where a fabricated figure would
// land (the reply has to quote real totals from the state block), and the
// claim-check only guards ACTION claims, not invented numbers. So a question
// about their own progress never takes the fast path, whatever the model calls
// it. Costs a reasoning pass on a handful of turns; buys back the one place the
// backstops don't reach.
const TASK_INTENT_SIGNAL_PATTERN =
  /\d|\$|£|€|\btask|\bgoal|\bhabit|\bstreak|\bsav(e|ed|ing)|\bspent|\blog(ged)?\b|\btrack|\bremind|\bdone\b|\bfinish|\bcomplet|\bundo\b|\bdelete|\bremove|\bcancel|\badd\b|\bcreate\b|\bmark\b|\bdid\b|\bworkout|\bgym\b|\brun\b|\bprogress|\bdue\b|\btoday\b|\btomorrow\b|\bweek\b|\bmonth\b|how am i|how'?s my|how are my|how much|how many|how far|where (am|are) (i|we|my)|\bstatus\b|catch me up|\bso far\b|\bleft\b|\blist\b|\bplan(s|ned)?\b|\bschedule\b/i;

/** True when the user's own message shows no sign of touching their tasks/goals. */
export function looksPurelyConversational(userMessage: string): boolean {
  return !TASK_INTENT_SIGNAL_PATTERN.test(userMessage);
}

const NUMBER_TOKEN = /\d+(?:[.,]\d+)*/g;

function numbersIn(text: string): string[] {
  // "1,200" and "1200" are the same figure, and so are "$5.00" and "$5" — but
  // normalize by VALUE, not by stripping characters. The first cut of this
  // stripped trailing zeros to fold "5.00" into "5", which also silently turned
  // "10" into "1" and "300" into "3" — so a reply claiming "$10" matched the "1"
  // in a ref like "G1" and the guard went blind to the exact fabrication it
  // exists to catch. The unit test caught it; the arithmetic here is the point.
  return (text.match(NUMBER_TOKEN) ?? []).map((raw) => {
    const value = Number(raw.replace(/,/g, ''));
    return Number.isFinite(value) ? String(value) : raw;
  });
}

/**
 * The free tier of the figure check: does the reply contain a number that does
 * NOT appear anywhere in the facts the model was given? Cheap, and deliberately
 * over-eager — a legitimately DERIVED figure ("$295 to go" from "$5 / $300")
 * trips this too, and that is fine: this only decides whether a classifier call
 * is worth making, and didMisstateFigure is what actually judges. What it buys
 * is the opposite guarantee — if every number in the reply already appears in
 * the facts, no fabrication is possible and no call is made.
 */
export function hasUngroundedFigure(reply: string, groundingFacts: string): boolean {
  const grounded = new Set(numbersIn(groundingFacts));
  return numbersIn(reply).some((n) => !grounded.has(n));
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
  // At most ONE correction per turn. The three guards are independent and can in
  // principle all fire on the same reply; two walk-backs stacked on one message
  // reads as a malfunction, not as honesty.
  let corrected = false;

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
  async function* maybeCorrectFakeAction(stateFacts: string = ''): AsyncGenerator<ChatStreamEvent> {
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
    // ...and equally off when a preview from an EARLIER turn is still on screen.
    // Describing a card that genuinely exists is not a false claim about one that
    // doesn't (see hasPendingPreview).
    const matchedPreviewClaim =
      !hadPendingSuccess && !actionCtx.hasPendingPreview && PREVIEW_CLAIM_PATTERN.test(stripped);
    const matchedRegex =
      matchedPreviewClaim ||
      FAKE_ACTION_PATTERN.test(stripped) ||
      TOOL_NAME_LEAK_PATTERN.test(stripped) ||
      RAW_TOOL_CALL_MARKUP_PATTERN.test(text);
    const claimed = hadPendingSuccess ? false : await didClaimAction(emittedSegments, stateFacts);

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

    // The GROUNDED classifier arbitrates; the regexes only tell us what to look
    // at. This used to be an OR — a FAKE_ACTION_PATTERN hit forced a correction
    // even when the classifier said the reply was fine — and that is how two
    // perfectly honest replies got "Hold on, I don't think that actually went
    // through" stapled to them in eleven live turns. A pattern can see that a
    // sentence *sounds like* a claim; only the state can say whether the claim is
    // false. The one exception stays forced: a preview/card claim on a turn where
    // no card exists is false by construction, no state needed.
    if (!matchedPreviewClaim && !claimed) return;
    corrected = true;

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
    if (corrected) return;
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
    corrected = true;

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

  /**
   * The third guard, and the one the other two are blind to by construction.
   * maybeCorrectFakeAction asks "did it claim an action that never happened".
   * maybeCorrectConcealedAction asks "did it hide one that did". Neither ever
   * looks at whether the NUMBERS are true — so a reply can be scrupulously
   * honest about its actions and still tell the user their savings are double
   * what they are ("You're at $10 total now" against a real $5, seen live, on a
   * turn where the claim-check correctly passed it because no action was
   * claimed).
   *
   * "Never invent a number" is the app's own rule (CLAUDE.md §2), and every
   * figure in the system is computed server-side precisely so the model only has
   * to QUOTE it. This enforces that at the last possible moment, on the way out.
   *
   * `groundingFacts` is everything the reply was entitled to state a number from:
   * the live state block, whatever the server actually did this turn, and the
   * user's own message. The free check (hasUngroundedFigure) skips the classifier
   * whenever every number in the reply already appears in those facts — which is
   * the common case, so this costs nothing on most turns.
   */
  async function* maybeCorrectFabricatedFigure(groundingFacts: string): AsyncGenerator<ChatStreamEvent> {
    if (corrected) return;
    const text = emittedSegments.join(' ');
    if (!text.trim()) return;
    if (!hasUngroundedFigure(text, groundingFacts)) return;

    const misstated = await didMisstateFigure(emittedSegments, groundingFacts);
    logger.info(
      { userId: actionCtx.userId, sourceMessageId: actionCtx.sourceMessageId, figure_check: misstated ? 'yes' : 'no' },
      'figure-check verdict',
    );
    if (!misstated) return;
    corrected = true;

    logger.warn(
      { userId: actionCtx.userId, sourceMessageId: actionCtx.sourceMessageId, segments: emittedSegments },
      'chat turn stated a figure the facts do not support — correcting',
    );
    // Deliberately does NOT try to restate the right number. The model that just
    // got it wrong is the same one that would be supplying the fix, and a
    // confidently-wrong correction is worse than an honest retraction. The true
    // figures are already on the cards and in the Tasks/Goals tabs, one tap away
    // — point there, and own the mistake.
    yield {
      type: 'segment_end',
      text: "Actually — scratch that number, I don't trust it. Check the card (or your Goals tab) for the real figure; I shouldn't have guessed at it.",
    };
  }

  return {
    toolCallLog,
    emittedSegments,
    logTurn,
    maybeCorrectFakeAction,
    maybeCorrectConcealedAction,
    maybeCorrectFabricatedFigure,
  };
}
