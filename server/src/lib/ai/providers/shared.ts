import type OpenAI from 'openai';

import { logger } from '../../../logger.ts';
import type { TaskRow } from '../../tasks/executor.ts';
import type { GoalRow } from '../../goals/executor.ts';
import type { GoalPreview } from '../../goals/schema.ts';
import { didClaimAction } from '../claim-check.ts';
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
  // undo_last_action that reverted a goal_% record.
  | { type: 'action_goal'; toolName: string; goal: GoalRow; summary: string; recordKind: string }
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
const PREVIEW_CLAIM_PATTERN = /\b(preview|card)('s| is)? (up|sent|ready)|sent you a preview|tap create\b/i;
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
  /\[(create_task|edit_task|complete_task|progress_task|postpone_task|remove_task|remove_tasks|create_goal|edit_goal|log_goal_entry|create_tool|edit_tool|log_tool_entry)\b/i;

// Observed on DeepSeek v4-flash: instead of a structured tool_calls delta,
// the model occasionally emits its own function-call templating as literal
// content — fullwidth-pipe-wrapped sentinel tokens like
// `<｜｜DSML｜｜tool_calls><｜｜DSML｜｜invoke name="remove_task">...`. This is
// never legitimate reply text, so any provider can check for it and drop
// the offending segment rather than showing raw internal markup to the
// user (see providers/deepseek.ts for where this gets applied).
const RAW_TOOL_CALL_MARKUP_PATTERN = /｜{1,2}\s*DSML\s*｜{1,2}/;

export function isToolCallMarkupLeak(text: string): boolean {
  return RAW_TOOL_CALL_MARKUP_PATTERN.test(text);
}

export type ToolCallLogEntry = { name: string; ok: boolean; taskId?: string; error?: string };

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
    if (toolCallLog.length > 0) return;
    const text = emittedSegments.join(' ');
    if (!text.trim()) return;

    const matchedPreviewClaim = PREVIEW_CLAIM_PATTERN.test(text);
    const matchedRegex =
      matchedPreviewClaim ||
      FAKE_ACTION_PATTERN.test(text) ||
      TOOL_NAME_LEAK_PATTERN.test(text) ||
      RAW_TOOL_CALL_MARKUP_PATTERN.test(text);
    const claimed = await didClaimAction(emittedSegments);

    logger.info(
      {
        userId: actionCtx.userId,
        sourceMessageId: actionCtx.sourceMessageId,
        claim_check: claimed ? 'yes' : 'no',
        matched_regex: matchedRegex,
        matched_preview_claim: matchedPreviewClaim,
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

  return { toolCallLog, emittedSegments, logTurn, maybeCorrectFakeAction };
}
