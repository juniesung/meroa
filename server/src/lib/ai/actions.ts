import {
  formatYmdShort,
  localDatetimeToUtcIso,
  nextOccurrenceYmd,
  ymdEndOfDayToUtcDate,
  ymdInTz,
} from '../tasks/recurrence.ts';
import type { CreateTaskInput, ProgressInput, Recurrence } from '../tasks/schema.ts';
import {
  completeTask,
  editTask,
  getTask,
  listOpenTaskTitles,
  postponeTask,
  progressTask,
  TaskActionError,
  undoLastAction,
  type ActionSource,
  type TaskRow,
} from '../tasks/executor.ts';
import { eq } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import { users } from '../../db/schema.ts';
import { findAmbiguousTaskMatch, normalizeForMatch } from './ambiguity.ts';
import { isStyleAdjustments, type StyleAdjustments } from './system-prompt.ts';
import { createMemory, raiseSensitivityIfNeeded, type MemoryRow } from '../memories/executor.ts';
import {
  archiveGoal,
  createGoal,
  editGoal,
  getGoal as getGoalRow,
  listGoalRetireCandidates,
  logGoalEntry,
  plannedTasksForStage,
  GoalActionError,
  type GoalRow,
} from '../goals/executor.ts';
import {
  buildGoalDefinition,
  type AdvanceStageProposal,
  type EditGoalPatch,
  type GoalDefinition,
  type GoalEntryData,
  type GoalPreview,
  type LogGoalEntryPatch,
} from '../goals/schema.ts';
import { buildGoalScopedStreaks } from '../goals/consistency.ts';
import { buildGoalCardSummaries, formatMoney } from '../goals/summary.ts';
import { checkStarterPace } from '../goals/starter-pace.ts';
import { buildTaskCompletionHistory, describeCompletionHistory } from './history.ts';
import { describeGoalPreviewForSummary } from './pending-preview.ts';
import type { TurnRef, TurnRefs } from './task-context.ts';
import { isAiToolName, validateToolInput, type AiToolName } from './tools.ts';

// Lenient on purpose — only needs to catch "completely different task",
// not penalize reasonable paraphrasing ("the plants task" vs "Water the
// plants"). Exact match, substring either direction, or any shared
// significant word (length > 2, so "the"/"a" don't count) all pass.
function titleMatches(hint: string, realTitle: string): boolean {
  const h = normalizeForMatch(hint);
  const t = normalizeForMatch(realTitle);
  if (!h || !t) return false;
  if (h === t || t.includes(h) || h.includes(t)) return true;
  const hWords = new Set(h.split(/\s+/).filter((w) => w.length > 2));
  const tWords = new Set(t.split(/\s+/).filter((w) => w.length > 2));
  for (const w of hWords) if (tWords.has(w)) return true;
  return false;
}

// Deterministic backstop for a hallucinated or mismatched taskRef: the model
// must state what it believes the task's title is, and this checks that
// against the task's real, current title before edit/complete/progress/
// postpone/remove ever executes — a secondary check behind ref resolution
// itself (resolveTaskRef below), which already rejects a ref the model
// invented outright. Returns null (no error) if the task doesn't exist at
// all, letting the executor's own not_found error fire instead of a
// confusing double message.
async function verifyTitleHint(
  userId: string,
  taskId: string,
  titleHint: string,
): Promise<{ error: string } | null> {
  const task = await getTask(userId, taskId);
  if (!task) return null;
  if (titleMatches(titleHint, task.title)) return null;
  return {
    error: `titleHint doesn't match that ref — the task there is actually titled "${task.title}", not "${titleHint}". Re-check the task list in context for the right ref, or ask the user to clarify which task they mean.`,
  };
}

export type TaskActionResult =
  // `modelSummary`, when set, is what goes back to the model as the tool
  // result instead of `summary` — for facts the model needs but the user
  // must never see persisted (a created task's turn-scoped ref). `summary`
  // remains the persisted message content / SSE payload.
  // `detail` is the slice of the summary the task CARD cannot show for itself —
  // the goal impact ("Auto-logged $5 to \"New bike\" — now $5 / $300") and the
  // history clause ("That's your 4th time this week"). The card already renders
  // the task's real title, schedule and state live from the DB, so repeating
  // that in text is noise; this is the part that would otherwise be lost now
  // that a successful action turn emits no prose at all. Server-computed, so it
  // cannot lie.
  | {
      ok: true;
      toolName: AiToolName;
      task: TaskRow;
      summary: string;
      modelSummary?: string;
      detail?: string;
      recordKind: string;
    }
  | { ok: true; toolName: AiToolName; tasks: TaskRow[]; summary: string; recordKind: string }
  // A goal action that actually mutated a saved row — edit_goal,
  // log_goal_entry, or an undo_last_action that reverted a goal_% record.
  // `proposal` is set only for advance_goal_stage's pending-confirmation
  // result (recordKind: 'goal_advance_pending') — nothing mutated yet, the
  // card carries this so POST /goals/:id/advance can re-validate it.
  | {
      ok: true;
      toolName: AiToolName;
      goal: GoalRow;
      summary: string;
      recordKind: string;
      proposal?: AdvanceStageProposal;
    }
  // create_goal — a preview only, nothing saved yet
  // (docs/goals-redesign-plan.md §2.1/§2.2). `detail` is the server-computed
  // handoff caption the card can't compute itself (docs/goal-manual-
  // editing-plan.md §3.4) — "open in Goals to add your stages" for a bare
  // milestone template, or how many stages are already set.
  | { ok: true; toolName: AiToolName; preview: GoalPreview; detail?: string; summary: string; recordKind: string }
  // create_task via chat — always a preview, never an immediate save, same
  // shape as create_goal's preview (docs/goals-redesign-plan.md §2.1),
  // unconditional, matching remove_task's own always-confirm pattern. Only
  // reachable via chat — the manual Tasks-tab create route never calls
  // executeAiToolCall at all, so it stays immediate, unaffected — see the
  // create_task case below. `taskPreview` is the already-fully-resolved
  // CreateTaskInput (dueAt defaulted, goalId/goalContribution resolved from
  // refs) — exactly what createTask() would be called with; the confirm
  // tap (routes/tasks.ts) re-validates and replays it verbatim.
  | { ok: true; toolName: AiToolName; taskPreview: CreateTaskInput; summary: string; recordKind: 'task_creation_pending' }
  // adjust_style — a prefs write, not a task/goal record. No `task`/`tasks`/
  // `goal`/`preview` key, so providers/act-narrate.ts routes it away from
  // every card-rendering branch and into its own results block instead
  // (docs/chat-architecture.md's silence rule would otherwise swallow the
  // acknowledgment — a style change met with silence is exactly the wrong
  // note). `styleSummary` is SERVER-authored, never the model's own words —
  // same reasoning as every other summary in this file.
  | { ok: true; toolName: AiToolName; styleSummary: string; recordKind: 'style_adjusted' }
  // remember — a real write with a real card, unlike adjust_style. Routes
  // through the ordinary §3 silence flow: the card IS the confirmation.
  | { ok: true; toolName: AiToolName; memory: MemoryRow; summary: string; recordKind: 'memory_action' }
  | { ok: false; error: string };

// "$150" (savings), "175lb" (indirect — the unit trails, never a currency
// prefix), or "$150 (birthday money)" with a note — used both to confirm
// what log_goal_entry actually recorded and to narrate what an undone entry
// removed. Habit goals never reach here (they have no entries).
function describeEntryData(definition: GoalDefinition, data: GoalEntryData): string {
  const value =
    definition.type === 'savings'
      ? `${definition.currency}${formatMoney(data.amount)}`
      : definition.type === 'indirect'
        ? `${data.amount}${definition.unit}`
        : `${data.amount}`;
  return data.note ? `${value} (${data.note})` : value;
}

// The goal's concrete, recomputed post-action fact (never leaves the model
// to narrate from memory — docs/ai-reliability-hardening.md lesson 16).
// Reuses the batched summaries helper with a single-element array; the cost
// is the same as a dedicated single-goal query would be.
async function goalHeadline(goal: GoalRow, timezone: string | null): Promise<string> {
  const summaries = await buildGoalCardSummaries([goal], timezone);
  return summaries.get(goal.id)?.headline ?? '';
}

// Indirect-only: headline plus the delta-vs-previous-entry fact
// (computeIndirectCardSummary's `sub`) and the pace line when a target
// exists — a down payment on Phase 5's history-aware replies ("that's 0.6
// down from your last log"), server-computed so the model quotes it rather
// than comparing entries itself.
async function goalHeadlineWithDelta(goal: GoalRow, timezone: string | null): Promise<string> {
  const summaries = await buildGoalCardSummaries([goal], timezone);
  const summary = summaries.get(goal.id);
  if (!summary) return '';
  const parts = [summary.headline];
  if (summary.sub && summary.sub !== 'First log') parts.push(summary.sub);
  if (summary.paceLine) parts.push(summary.paceLine);
  return parts.join(' — ');
}

// Headline plus the recomputed pace ("$14 / $120 — needs $2.41/day to hit
// Aug 25") — the post-edit fact stated outright so the model never
// recomputes pace itself (observed live narrating "$2.65/day" from its own
// arithmetic when the real recomputed pace was $2.41/day; lesson 6).
async function goalHeadlineWithPace(goal: GoalRow, timezone: string | null): Promise<string> {
  const summaries = await buildGoalCardSummaries([goal], timezone);
  const summary = summaries.get(goal.id);
  if (!summary) return '';
  return summary.paceLine ? `${summary.headline} — ${summary.paceLine}` : summary.headline;
}

// The connected loop's side effect, stated as a fact on the completion/
// reopen summary itself — without it, complete_task's result says nothing
// about the goal, and the model does its own math (observed live announcing
// "$220.50" while the real total was $100.50; lesson 6/16). Savings-linked
// tasks state the auto-logged amount + recomputed total/pace; habit-linked
// tasks state the recomputed streak (the model must never derive a streak
// itself — same lesson). Empty when the task isn't goal-linked, when the
// status didn't cross the done boundary, or when the goal is archived.
async function goalImpactSuffix(
  userId: string,
  timezone: string | null,
  priorStatus: string | undefined,
  after: TaskRow,
): Promise<string> {
  if (!after.goalId) return '';
  const becameDone = after.status === 'done' && priorStatus !== 'done';
  const becameOpen = after.status !== 'done' && priorStatus === 'done';
  if (!becameDone && !becameOpen) return '';
  const goal = await getGoalRow(userId, after.goalId);
  if (!goal) return '';
  const definition = goal.definition as GoalDefinition;

  if (definition.type === 'habit') {
    const streaks = await buildGoalScopedStreaks(userId, timezone, [goal.id]);
    const streak = streaks.get(goal.id) ?? { current: 0, longest: 0, doneCount: 0 };
    return becameDone
      ? ` That's the check-in for habit "${goal.name}" — streak is now ${streak.current} day${streak.current === 1 ? '' : 's'} (longest: ${streak.longest}).`
      : ` Check-in removed for habit "${goal.name}" — streak is now ${streak.current} (longest: ${streak.longest}).`;
  }

  if (definition.type === 'indirect') {
    // Never a source of the number itself (locked decision: "no progress
    // bar derived from tasks, ever") — a linked task is supporting activity
    // only, so its completion states that plainly and nothing numeric.
    return becameDone
      ? ` That's supporting activity for "${goal.name}" — log a real measurement there when you have one.`
      : '';
  }

  if (definition.type === 'milestone') {
    // A completed task is supporting activity only — never itself a stage
    // declaration (locked decision, docs/milestone-goal-plan.md §2.3). Only
    // stated on becameDone; there's nothing to say on becameOpen since a
    // reopen doesn't retract a stage that was never advanced by this.
    if (!becameDone) return '';
    const stageLabel =
      definition.stages.length === 0
        ? 'no stages set yet'
        : definition.activeStageIndex < definition.stages.length
          ? `stage ${definition.activeStageIndex + 1} of ${definition.stages.length}, "${definition.stages[definition.activeStageIndex]}"`
          : `all ${definition.stages.length} stages done`;
    return ` That supports "${goal.name}" (${stageLabel}) — say the word when the stage itself is done; it never advances on its own.`;
  }

  const contribution = (after.config as { goalContribution?: unknown }).goalContribution;
  if (typeof contribution !== 'number') return '';
  const currency = definition.currency;
  const amount = formatMoney(contribution);
  const fact = await goalHeadlineWithPace(goal, timezone);
  return becameDone
    ? ` Auto-logged ${currency}${amount} to "${goal.name}" — now ${fact}.`
    : ` Removed today's ${currency}${amount} auto-entry from "${goal.name}" — back to ${fact}.`;
}

// Phase 5's history-aware reply ("that's your 4th time this week"), stated as
// a server-computed fact on the completion summary — the model quotes it and
// never counts anything itself (lesson 6/16, the same rule goalImpactSuffix
// follows). Gated on becameDone exactly like goalImpactSuffix: "that's your
// 3rd this week" after *un*-completing something is nonsense. Empty for a
// one-off task (no series to count) and for a first completion of the week
// (a count of 1 is noise, not a fact worth saying).
async function taskHistorySuffix(
  userId: string,
  timezone: string | null,
  priorStatus: string | undefined,
  after: TaskRow,
): Promise<string> {
  if (after.status !== 'done' || priorStatus === 'done') return '';
  const history = await buildTaskCompletionHistory(userId, timezone, after);
  if (!history) return '';
  const clause = describeCompletionHistory(history);
  return clause ? ` ${clause}` : '';
}

async function summarizeGoalUndo(
  goal: GoalRow,
  undidKind: string,
  timezone: string | null,
  entryData?: GoalEntryData,
): Promise<string> {
  const headline = await goalHeadline(goal, timezone);
  switch (undidKind) {
    case 'goal_created':
      return `Removed the "${goal.name}" goal.`;
    case 'goal_archived':
      return `Brought back "${goal.name}"${headline ? ` — ${headline}` : ''}.`;
    case 'goal_edited':
      return `Undid the last edit to "${goal.name}"${headline ? ` — ${headline}` : ''}.`;
    case 'goal_entry': {
      const definition = goal.definition as GoalDefinition;
      const logged = entryData ? describeEntryData(definition, entryData as GoalEntryData) : '';
      return `Removed that${logged ? ` ${logged}` : ''} entry from "${goal.name}"${headline ? ` — ${headline} now` : ''}.`;
    }
    case 'goal_stage_advanced':
      return `Moved "${goal.name}" back a stage${headline ? ` — ${headline}` : ''}.`;
    default:
      return `Undid the last change to "${goal.name}"${headline ? ` — ${headline}` : ''}.`;
  }
}

// Confirms a constrained edit_goal op with the concrete before/after value,
// not just "updated" (docs/ai-reliability-hardening.md lesson 13's edit
// surface applies just as much to what the model says about an edit as to
// what a form silently resaves).
function describeGoalEdit(
  before: GoalRow,
  after: GoalRow,
  input: { name?: string; targetValue?: number; deadline?: string; unit?: string },
): string {
  const parts: string[] = [];
  if (input.name !== undefined) parts.push(`renamed to "${after.name}"`);

  const beforeDef = before.definition as GoalDefinition;
  const afterDef = after.definition as GoalDefinition;
  // target/deadline exist on savings and indirect; unit only on indirect —
  // the executor already rejected those patch fields for a habit, so this
  // narrowing never drops real info.
  if (beforeDef.type === 'savings' && afterDef.type === 'savings') {
    if (input.targetValue !== undefined) {
      parts.push(`target is now ${afterDef.currency}${formatMoney(afterDef.targetValue)} (was ${beforeDef.currency}${formatMoney(beforeDef.targetValue)})`);
    }
    if (input.deadline !== undefined) {
      parts.push(
        beforeDef.deadline
          ? `deadline is now ${afterDef.deadline} (was ${beforeDef.deadline})`
          : `deadline is now ${afterDef.deadline}`,
      );
    }
  } else if (beforeDef.type === 'indirect' && afterDef.type === 'indirect') {
    if (input.targetValue !== undefined) {
      parts.push(
        beforeDef.targetValue !== undefined
          ? `target is now ${afterDef.targetValue}${afterDef.unit} (was ${beforeDef.targetValue}${beforeDef.unit})`
          : `target is now ${afterDef.targetValue}${afterDef.unit}`,
      );
    }
    if (input.deadline !== undefined) {
      parts.push(
        beforeDef.deadline
          ? `deadline is now ${afterDef.deadline} (was ${beforeDef.deadline})`
          : `deadline is now ${afterDef.deadline}`,
      );
    }
    if (input.unit !== undefined) {
      parts.push(`unit is now ${afterDef.unit} (was ${beforeDef.unit})`);
    }
  }

  return parts.length ? `Updated "${after.name}" — ${parts.join('; ')}.` : `Updated "${after.name}".`;
}

// "7:00 PM" / "tomorrow at 7:00 PM" / "Jul 15 at 7:00 PM" — short and
// readable instead of a full localized date-time string. Never fabricates a
// time: an implicit end-of-day dueAt (dueTimeExplicit: false) returns ''.
// Always formats in the account's own timezone — bare `toLocaleTimeString`/
// `toDateString` (no `timeZone` option) silently fall back to the *server
// process's* local timezone, which produced a real, observed bug: a user
// with no timezone set (falls back to UTC everywhere else) asked for "6pm"
// and the task card said "11:00 AM" — the correct 18:00 UTC instant,
// mis-rendered in whatever zone the server happened to be running in.
function shortDueLabel(task: TaskRow, timezone: string | null): string {
  if (!task.dueAt) return '';
  const explicit = (task.config as { dueTimeExplicit?: boolean }).dueTimeExplicit !== false;
  if (!explicit) return '';
  const tz = timezone ?? 'UTC';
  const due = new Date(task.dueAt);
  const time = due.toLocaleTimeString(undefined, { timeZone: tz, hour: 'numeric', minute: '2-digit' });
  const dueYmd = ymdInTz(due, tz);
  const todayYmd = ymdInTz(new Date(), tz);
  if (dueYmd === todayYmd) return time;
  const tomorrowYmd = ymdInTz(new Date(Date.now() + 24 * 60 * 60 * 1000), tz);
  if (dueYmd === tomorrowYmd) return `tomorrow at ${time}`;
  return `${due.toLocaleDateString(undefined, { timeZone: tz, month: 'short', day: 'numeric' })} at ${time}`;
}

// The preview-only mirror of shortDueLabel/summarizeCreate — same wording,
// worked off the not-yet-saved CreateTaskInput instead of a real TaskRow
// (there's no task.config yet to read dueTimeExplicit from).
function shortDueLabelForPreview(
  dueAt: string | undefined,
  dueTimeExplicit: boolean | undefined,
  timezone: string | null,
): string {
  if (!dueAt || dueTimeExplicit === false) return '';
  const tz = timezone ?? 'UTC';
  const due = new Date(dueAt);
  const time = due.toLocaleTimeString(undefined, { timeZone: tz, hour: 'numeric', minute: '2-digit' });
  const dueYmd = ymdInTz(due, tz);
  const todayYmd = ymdInTz(new Date(), tz);
  if (dueYmd === todayYmd) return time;
  const tomorrowYmd = ymdInTz(new Date(Date.now() + 24 * 60 * 60 * 1000), tz);
  if (dueYmd === tomorrowYmd) return `tomorrow at ${time}`;
  return `${due.toLocaleDateString(undefined, { timeZone: tz, month: 'short', day: 'numeric' })} at ${time}`;
}

function summarizeTaskPreview(preview: CreateTaskInput, timezone: string | null): string {
  const label = shortDueLabelForPreview(preview.dueAt, preview.dueTimeExplicit, timezone);
  return `Preview card shown — nothing is saved yet; the user taps Create on the card. Would create "${preview.title}"${label ? ` for ${label}` : ''}.`;
}

function summarizeComplete(task: TaskRow): string {
  return task.status === 'done'
    ? `Marked "${task.title}" done.`
    : `Logged progress on "${task.title}".`;
}

// Confirms a task→goal link/unlink/relink the same way describeGoalEdit
// confirms an edit_goal op — the concrete goal name and, for savings, the
// server-recomputed headline + pace, never left for the model to derive
// (lesson 6). retroCredited states the same-day-completion fact plainly so
// the model doesn't have to infer it happened.
async function describeGoalLinkChange(
  userId: string,
  timezone: string | null,
  task: TaskRow,
  linked: boolean,
  unlinked: boolean,
  retroCredited: boolean,
): Promise<string> {
  if (unlinked) return ' Unlinked from its goal.';
  if (!linked || !task.goalId) return '';
  const goal = await getGoalRow(userId, task.goalId);
  if (!goal) return '';
  const definition = goal.definition as GoalDefinition;
  if (definition.type === 'habit') {
    return ` Linked to habit "${goal.name}" — completing it is now the check-in.`;
  }
  if (definition.type !== 'savings') {
    return ` Linked to "${goal.name}" as supporting activity — it won't log a number itself.`;
  }
  const contribution = (task.config as { goalContribution?: unknown }).goalContribution;
  if (typeof contribution !== 'number') return ` Linked to "${goal.name}".`;
  const fact = await goalHeadlineWithPace(goal, timezone);
  const retroNote = retroCredited ? " Today's completion was credited too." : '';
  return ` Linked to "${goal.name}" — completing it logs ${definition.currency}${formatMoney(contribution)}.${retroNote} Now ${fact}.`;
}

// The AI reasons about times as local wall-clock ("7am") and often emits a
// datetime with no timezone designator — see localDatetimeToUtcIso for why
// that can't just be handed to `new Date()`. Every dueAt/newDueAt from a
// tool call is normalized through here before it reaches the executor.
function normalizeDueAt(
  raw: string | null | undefined,
  timezone: string | null,
): { value: string | null | undefined } | { error: string } {
  if (raw == null) return { value: raw };
  const iso = localDatetimeToUtcIso(raw, timezone ?? 'UTC');
  if (!iso)
    return { error: `"${raw}" is not a valid datetime — ask the user to clarify the date/time.` };
  return { value: iso };
}

type ResolvedTaskRef = Extract<TurnRef, { kind: 'task' }>;

// Every taskRef the model sends is resolved against this turn's TurnRefs map
// before anything executes — an unrecognized ref (hallucinated, stale, or
// copied from earlier in the conversation) is rejected deterministically
// here rather than trusted as a real id. Models copy a short alias like "T2"
// far more reliably than a ~20-token UUID (see task-context.ts).
function resolveTaskRef(
  refs: TurnRefs,
  taskRef: string,
): { ok: true; ref: ResolvedTaskRef } | { ok: false; error: string } {
  const entry = refs.get(taskRef);
  if (!entry || entry.kind !== 'task') {
    return {
      ok: false,
      error: `${taskRef} isn't in the current task list — re-check the task list in context for the right ref.`,
    };
  }
  return { ok: true, ref: entry };
}

// edit_task is always series-level for a recurring ref — the schedule,
// title, and target live on the template, not a day's instance.
function editTarget(ref: ResolvedTaskRef): string {
  return ref.templateId ?? ref.taskId;
}

// complete_task / progress_task / postpone_task are always about a concrete
// due instant, so a recurring ref always routes to *today's* instance — the
// model never chooses template vs. instance itself (that routing decision
// lives here, not in the prompt). A ref that resolved to an off-day
// template (no instance due today) can't be acted on this way at all.
async function occurrenceTarget(
  userId: string,
  timezone: string | null,
  ref: ResolvedTaskRef,
): Promise<{ ok: true; taskId: string } | { ok: false; error: string }> {
  if (!ref.isRecurringSeries) return { ok: true, taskId: ref.taskId };
  if (ref.instanceId) return { ok: true, taskId: ref.instanceId };

  const templateId = ref.templateId ?? ref.taskId;
  const template = await getTask(userId, templateId);
  if (!template || !template.recurrence) {
    return { ok: false, error: "that task isn't due today." };
  }
  const tz = timezone ?? 'UTC';
  const nextYmd = nextOccurrenceYmd(template.recurrence as Recurrence, template, ymdInTz(new Date(), tz), tz);
  return {
    ok: false,
    error: `"${template.title}" isn't due today (next: ${formatYmdShort(nextYmd)}).`,
  };
}

// remove_task's scope decides series-vs-occurrence the same way
// occurrenceTarget decides it for progress-shaped actions — 'series' (the
// default) targets the template, whose cascade in executor.ts already
// removes today's open instance with it; 'occurrence' targets just today's
// instance ("skip today"), which is a no-op for the schedule itself.
function removeTarget(
  ref: ResolvedTaskRef,
  scope: 'occurrence' | 'series' | undefined,
): { ok: true; taskId: string } | { ok: false; error: string } {
  if (!ref.isRecurringSeries) return { ok: true, taskId: ref.taskId };
  if ((scope ?? 'series') === 'series') return { ok: true, taskId: ref.templateId ?? ref.taskId };
  if (!ref.instanceId) return { ok: false, error: "there's no occurrence due today to skip." };
  return { ok: true, taskId: ref.instanceId };
}

type ResolvedGoalRef = Extract<TurnRef, { kind: 'goal' }>;

// Same resolve-then-verify pattern as resolveTaskRef, for goals.
function resolveGoalRef(
  refs: TurnRefs,
  goalRef: string,
): { ok: true; ref: ResolvedGoalRef } | { ok: false; error: string } {
  const entry = refs.get(goalRef);
  if (!entry || entry.kind !== 'goal') {
    return {
      ok: false,
      error: `${goalRef} isn't in the current goals list — re-check the goals list in context for the right ref.`,
    };
  }
  return { ok: true, ref: entry };
}

// Same pattern as verifyTitleHint, for goals.
async function verifyNameHint(
  userId: string,
  goalId: string,
  nameHint: string,
): Promise<{ error: string } | null> {
  const goal = await getGoalRow(userId, goalId);
  if (!goal) return null;
  if (titleMatches(nameHint, goal.name)) return null;
  return {
    error: `nameHint doesn't match that ref — the goal there is actually named "${goal.name}", not "${nameHint}". Re-check the goals list in context for the right ref, or ask the user to clarify which goal they mean.`,
  };
}

// A failure string like "That task no longer exists" reads, to a model
// pattern-matching on tone, like a success condition — observed in practice
// narrated back to the user as "it's already been removed" while the task
// sat in the DB, open. Every ok:false path gets funneled through here at the
// executeAiToolCall boundary so the text the model sees always leads with an
// explicit, unambiguous outcome statement instead of relying on each
// individual error string to carry that weight. This wraps the boundary
// itself (not each string) so new failure paths get the same guarantee for
// free; the unwrapped error still flows into toolCallLog, which is log-only.
const MEMORY_KIND_LABEL: Record<string, string> = {
  preference: 'Preference',
  trait: 'Trait',
  relationship: 'Relationship',
  situation: 'Situation',
};

function summarizeRemember(memory: MemoryRow): string {
  const label = MEMORY_KIND_LABEL[memory.kind] ?? 'Memory';
  return `Remembered (${label}): ${memory.content}`;
}

// Server-authored, deliberately — the narrate pass quotes this verbatim
// rather than describing the change in its own words, same reasoning as
// every other summary in this file (CLAUDE.md §2: never invent a number,
// and by extension never invent what a settings write actually did).
function describeStyleAdjustment(patch: {
  length?: 'shorter' | 'longer';
  questions?: 'fewer';
  directness?: 'more' | 'softer';
  emoji?: 'none' | 'ok';
  reset?: boolean;
}): string {
  if (patch.reset) return 'Style adjustments reset to just their preset.';
  const parts: string[] = [];
  if (patch.length === 'shorter') parts.push('shorter replies');
  if (patch.length === 'longer') parts.push('longer replies');
  if (patch.questions === 'fewer') parts.push('fewer questions');
  if (patch.directness === 'more') parts.push('more directness');
  if (patch.directness === 'softer') parts.push('a softer touch');
  if (patch.emoji === 'none') parts.push('no emoji');
  if (patch.emoji === 'ok') parts.push('emoji is fine again');
  return parts.length > 0 ? `Style updated: ${parts.join(', ')}.` : 'Style adjustment saved.';
}

// Read-merge-write against the same users.prefs blob routes/me.ts patches —
// deliberately NOT that endpoint (this runs from inside the AI action
// layer, not an HTTP request), but the same merge-only discipline: only
// `styleAdjustments` is touched, every other prefs key survives untouched.
async function applyStyleAdjustment(
  userId: string,
  patch: {
    length?: 'shorter' | 'longer';
    questions?: 'fewer';
    directness?: 'more' | 'softer';
    emoji?: 'none' | 'ok';
    reset?: boolean;
  },
): Promise<void> {
  const [row] = await db.select({ prefs: users.prefs }).from(users).where(eq(users.id, userId)).limit(1);
  const prefs = (row?.prefs ?? {}) as Record<string, unknown>;
  const current = isStyleAdjustments(prefs.styleAdjustments) ? prefs.styleAdjustments : {};
  const { reset: _reset, ...fields } = patch;
  const next: StyleAdjustments = patch.reset ? {} : { ...current, ...fields };
  await db
    .update(users)
    .set({ prefs: { ...prefs, styleAdjustments: next } })
    .where(eq(users.id, userId));
}

function wrapFailure(result: TaskActionResult): TaskActionResult {
  if (result.ok) return result;
  return {
    ok: false,
    error: `ACTION NOT COMPLETED — nothing was changed. ${result.error}\nTell the user you couldn't do this; do not describe it as done or already done.`,
  };
}

/**
 * Validates + executes one AI-issued tool call against the shared task
 * executor (the same functions the REST routes call), scoped to `source`
 * so records/idempotency work identically to a UI-driven action. `refs` is
 * this turn's TurnRefs map (task-context.ts) — every taskRef/itemRef the
 * model sends is resolved against it before anything executes.
 */
export async function executeAiToolCall(
  userId: string,
  timezone: string | null,
  toolName: string,
  rawInput: unknown,
  refs: TurnRefs,
  source: ActionSource,
  // The newest thing on the user's screen is a tap-to-confirm card they haven't
  // acted on — see the undo guard below.
  pendingConfirmCard?: string | null,
  // The user's newest message, verbatim — feeds the ambiguity guard below.
  // Optional; omitting it simply disables that one guard.
  userMessageText?: string | null,
): Promise<TaskActionResult> {
  return wrapFailure(
    await executeAiToolCallInner(userId, timezone, toolName, rawInput, refs, source, pendingConfirmCard, userMessageText),
  );
}

async function executeAiToolCallInner(
  userId: string,
  timezone: string | null,
  toolName: string,
  rawInput: unknown,
  refs: TurnRefs,
  source: ActionSource,
  pendingConfirmCard?: string | null,
  userMessageText?: string | null,
): Promise<TaskActionResult> {
  if (!isAiToolName(toolName)) {
    return { ok: false, error: `unknown tool "${toolName}"` };
  }

  try {
    switch (toolName) {
      case 'create_task': {
        const validated = validateToolInput('create_task', rawInput);
        if (!validated.ok) return { ok: false, error: validated.error };

        let goalId: string | undefined;
        let goalContribution: number | undefined;
        if (validated.data.goalLink) {
          const goalResolved = resolveGoalRef(refs, validated.data.goalLink.goalRef);
          if (!goalResolved.ok) return { ok: false, error: goalResolved.error };
          const goalHintCheck = await verifyNameHint(
            userId,
            goalResolved.ref.goalId,
            validated.data.goalLink.goalNameHint,
          );
          if (goalHintCheck) return { ok: false, error: goalHintCheck.error };
          goalId = goalResolved.ref.goalId;
          goalContribution = validated.data.goalLink.contribution;
        }

        const { goalLink: _goalLink, ...taskFields } = validated.data;
        let input: typeof taskFields & { dueTimeExplicit: boolean; goalId?: string; goalContribution?: number };
        if (taskFields.recurrence) {
          // The model is unreliable about which calendar date a repeating
          // task's first occurrence should land on — it sometimes picks
          // "tomorrow" even when the given time-of-day hasn't passed yet
          // today (observed: "water the plants at 10am everyday" at 2am
          // got created for the next day). recurrence.time is the real
          // source of truth for time-of-day, and materialization already
          // derives the correct first occurrence deterministically (today,
          // unless that time has already passed) — so any model-supplied
          // dueAt is dropped entirely for a repeating task rather than
          // trusted as the anchor. The UI's own today/tomorrow due-date
          // chip is a separate, deliberate user choice and isn't affected.
          input = {
            ...taskFields,
            dueAt: undefined,
            dueTimeExplicit: !!taskFields.recurrence.time,
            goalId,
            goalContribution,
          };
        } else {
          const dueAt = normalizeDueAt(taskFields.dueAt, timezone);
          if ('error' in dueAt) return { ok: false, error: dueAt.error };
          // The model was told to leave dueAt unset rather than invent a
          // clock time (tools.ts) — that doesn't mean "no deadline at all",
          // it means "sometime today": default to today's end-of-day so the
          // task still shows up as due, and goes overdue at midnight if
          // untouched, without a fabricated hour.
          const tz = timezone ?? 'UTC';
          const defaultedDueAt =
            dueAt.value ?? ymdEndOfDayToUtcDate(ymdInTz(new Date(), tz), tz).toISOString();
          input = {
            ...taskFields,
            dueAt: defaultedDueAt,
            dueTimeExplicit: dueAt.value != null,
            goalId,
            goalContribution,
          };
        }

        // Always a preview via chat, never an immediate save — same "nothing
        // saved yet" shape as create_goal (docs/goals-redesign-plan.md
        // §2.1), unconditional now, matching remove_task's own always-
        // confirm pattern (a model apology in prose doesn't persist to the
        // next turn; only a guarantee does — see docs/chat-architecture.md
        // §0). `input` here is already fully resolved (dueAt defaulted,
        // goalId/goalContribution resolved from refs) — routes/tasks.ts's
        // confirm tap replays it verbatim, no re-derivation needed. Because
        // this never hands back a real ref anymore, a same-turn chain
        // ("create X and mark it done") can't complete — tools.ts's
        // description tells the model not to attempt one.
        return {
          ok: true,
          toolName,
          taskPreview: input,
          summary: summarizeTaskPreview(input, timezone),
          recordKind: 'task_creation_pending',
        };
      }
      case 'edit_task': {
        const validated = validateToolInput('edit_task', rawInput);
        if (!validated.ok) return { ok: false, error: validated.error };
        const resolved = resolveTaskRef(refs, validated.data.taskRef);
        if (!resolved.ok) return { ok: false, error: resolved.error };
        const taskId = editTarget(resolved.ref);
        const hintCheck = await verifyTitleHint(userId, taskId, validated.data.titleHint);
        if (hintCheck) return { ok: false, error: hintCheck.error };
        const dueAt = normalizeDueAt(validated.data.dueAt, timezone);
        if ('error' in dueAt) return { ok: false, error: dueAt.error };

        // Never trust a raw goalId/goalContribution the zod backstop happens
        // to allow through (editTaskPatchSchema carries those for the REST/
        // client goal-picker path) — the AI path only ever links via a
        // resolved goalRef, verified against its nameHint the same as every
        // other goal reference. goalLink and unlinkGoal are mutually
        // exclusive by construction here (an unlink wins if the model
        // somehow sent both, which the tool description forbids).
        const {
          taskRef: _taskRef,
          titleHint: _titleHint,
          goalLink,
          unlinkGoal,
          goalId: _rawGoalId,
          goalContribution: _rawContribution,
          ...patch
        } = validated.data;
        let goalPatch: { goalId?: string | null; goalContribution?: number } = {};
        if (goalLink) {
          const goalResolved = resolveGoalRef(refs, goalLink.goalRef);
          if (!goalResolved.ok) return { ok: false, error: goalResolved.error };
          const goalHintCheck = await verifyNameHint(userId, goalResolved.ref.goalId, goalLink.goalNameHint);
          if (goalHintCheck) return { ok: false, error: goalHintCheck.error };
          goalPatch = { goalId: goalResolved.ref.goalId, goalContribution: goalLink.contribution };
        } else if (unlinkGoal) {
          goalPatch = { goalId: null };
        }

        const { task, retroCredited } = await editTask(
          userId,
          taskId,
          { ...patch, ...goalPatch, dueAt: dueAt.value },
          timezone,
          source,
        );
        const linkSummary = await describeGoalLinkChange(
          userId,
          timezone,
          task,
          !!goalLink,
          !!unlinkGoal,
          retroCredited,
        );
        return {
          ok: true,
          toolName,
          task,
          summary: `Updated "${task.title}".${linkSummary}`,
          detail: linkSummary.trim(),
          recordKind: 'task_edited',
        };
      }
      case 'complete_task': {
        const validated = validateToolInput('complete_task', rawInput);
        if (!validated.ok) return { ok: false, error: validated.error };
        const resolved = resolveTaskRef(refs, validated.data.taskRef);
        if (!resolved.ok) return { ok: false, error: resolved.error };
        const target = await occurrenceTarget(userId, timezone, resolved.ref);
        if (!target.ok) return { ok: false, error: target.error };
        const hintCheck = await verifyTitleHint(userId, target.taskId, validated.data.titleHint);
        if (hintCheck) return { ok: false, error: hintCheck.error };

        // Structural backstop for chat-architecture.md §0's "make the
        // server refuse" (docs/goal-manual-editing-plan.md §4): the prompt
        // rule alone ("if the user's words could plausibly refer to more
        // than one item, call no_action") held only ~2/3 of the time live —
        // "mark water done" with both "Water the plants" and a "drink 8
        // glasses of water" counter open wrote to one instead of asking.
        // Judged against the user's OWN words, never the model's titleHint
        // (its post-hoc justification for whichever task it already
        // picked — exactly the belief that's wrong when this fails).
        if (userMessageText) {
          const candidates = await listOpenTaskTitles(userId);
          const ambiguity = findAmbiguousTaskMatch(userMessageText, candidates);
          if (ambiguity) {
            const titles = ambiguity.candidates.map((c) => `"${c.title}"`).join(' or ');
            return {
              ok: false,
              error: `That could mean more than one task — ${titles} both match what the user said. Don't guess: call no_action and ask which one they mean.`,
            };
          }
        }

        let itemIds: string[] | undefined;
        if (validated.data.itemRefs) {
          itemIds = [];
          for (const itemRef of validated.data.itemRefs) {
            const entry = refs.get(itemRef);
            if (!entry || entry.kind !== 'checklist_item' || entry.taskId !== target.taskId) {
              return {
                ok: false,
                error: `${itemRef} isn't a valid checklist item ref for that task — re-check the [items: ...] list in context.`,
              };
            }
            itemIds.push(entry.itemId);
          }
        }

        // The executor's completeTask is a *toggle* for completion-type
        // tasks (a UI tap on a done task un-checks it) — fine for a
        // deliberate tap, a trap for chat: a user re-reporting a task
        // they've already done ("I did my $60 save" said twice, or said
        // once after tapping done in the app) must not silently reverse
        // their progress and its auto-logged goal entry (observed live
        // doing exactly that and then narrating a fabricated total).
        // Un-marking is opt-in via the explicit `reopen` flag instead.
        const priorTask = await getTask(userId, target.taskId);
        if (!priorTask) {
          return { ok: false, error: "that task ref doesn't match any current task — check the task list." };
        }

        if (validated.data.reopen) {
          if (priorTask.status !== 'done') {
            return {
              ok: false,
              error: `"${priorTask.title}" isn't marked done, so there's nothing to un-mark.`,
            };
          }
          const { task } = await progressTask(userId, target.taskId, { kind: 'reopen' }, source);
          const impact = await goalImpactSuffix(userId, timezone, priorTask.status, task);
          return {
            ok: true,
            toolName,
            task,
            summary: `Un-marked "${task.title}" — it's open again.${impact}`,
            detail: impact.trim(),
            recordKind: 'task_progress',
          };
        }

        if (priorTask.status === 'done' && priorTask.type === 'completion') {
          return {
            ok: false,
            error: `"${priorTask.title}" is already marked done — completing it again would just repeat what's recorded, so nothing was changed. If the user is un-doing it ("actually I didn't do it"), call complete_task again with reopen: true.`,
          };
        }

        const { task } = await completeTask(
          userId,
          target.taskId,
          { value: validated.data.value, itemIds },
          source,
        );
        const impact = await goalImpactSuffix(userId, timezone, priorTask.status, task);
        // Goal fact first (it's the connected-loop payload), history clause
        // last (it's color).
        const history = await taskHistorySuffix(userId, timezone, priorTask.status, task);
        return {
          ok: true,
          toolName,
          task,
          summary: `${summarizeComplete(task)}${impact}${history}`,
          detail: `${impact}${history}`.trim(),
          recordKind: 'task_completion',
        };
      }
      case 'progress_task': {
        const validated = validateToolInput('progress_task', rawInput);
        if (!validated.ok) return { ok: false, error: validated.error };
        const resolved = resolveTaskRef(refs, validated.data.taskRef);
        if (!resolved.ok) return { ok: false, error: resolved.error };
        const target = await occurrenceTarget(userId, timezone, resolved.ref);
        if (!target.ok) return { ok: false, error: target.error };
        const hintCheck = await verifyTitleHint(userId, target.taskId, validated.data.titleHint);
        if (hintCheck) return { ok: false, error: hintCheck.error };
        const { action } = validated.data;
        const input: ProgressInput =
          action === 'start_timer'
            ? { kind: 'duration_start' }
            : action === 'stop_timer'
              ? { kind: 'duration_stop' }
              : { kind: 'counter_increment', amount: validated.data.amount };
        const priorTask = await getTask(userId, target.taskId);
        const { task } = await progressTask(userId, target.taskId, input, source);
        // Incremental progress can cross the done boundary either way (a
        // counter reaching its target auto-completes; a negative increment
        // can reopen) — the goal side effect gets stated as a fact here the
        // same way complete_task's does.
        const impact = await goalImpactSuffix(userId, timezone, priorTask?.status, task);
        const history = await taskHistorySuffix(userId, timezone, priorTask?.status, task);
        const summary =
          action === 'start_timer'
            ? `Started the timer for "${task.title}".`
            : action === 'stop_timer'
              ? `Paused "${task.title}".`
              : `Updated "${task.title}".`;
        return {
          ok: true,
          toolName,
          task,
          summary: `${summary}${impact}${history}`,
          detail: `${impact}${history}`.trim(),
          recordKind: 'task_progress',
        };
      }
      case 'postpone_task': {
        const validated = validateToolInput('postpone_task', rawInput);
        if (!validated.ok) return { ok: false, error: validated.error };
        const resolved = resolveTaskRef(refs, validated.data.taskRef);
        if (!resolved.ok) return { ok: false, error: resolved.error };
        const target = await occurrenceTarget(userId, timezone, resolved.ref);
        if (!target.ok) return { ok: false, error: target.error };
        const hintCheck = await verifyTitleHint(userId, target.taskId, validated.data.titleHint);
        if (hintCheck) return { ok: false, error: hintCheck.error };
        const newDueAt = normalizeDueAt(validated.data.newDueAt, timezone);
        if ('error' in newDueAt) return { ok: false, error: newDueAt.error };
        const { task } = await postponeTask(
          userId,
          target.taskId,
          { reason: validated.data.reason, newDueAt: newDueAt.value ?? null },
          timezone,
          source,
        );
        const when = shortDueLabel(task, timezone) || 'later';
        return {
          ok: true,
          toolName,
          task,
          summary: `Moved "${task.title}" to ${when}.`,
          recordKind: 'task_postponed',
        };
      }
      case 'remove_task': {
        const validated = validateToolInput('remove_task', rawInput);
        if (!validated.ok) return { ok: false, error: validated.error };
        const resolved = resolveTaskRef(refs, validated.data.taskRef);
        if (!resolved.ok) return { ok: false, error: resolved.error };
        const target = removeTarget(resolved.ref, validated.data.scope);
        if (!target.ok) return { ok: false, error: target.error };
        const hintCheck = await verifyTitleHint(userId, target.taskId, validated.data.titleHint);
        if (hintCheck) return { ok: false, error: hintCheck.error };
        // Doesn't actually delete — removal is destructive-feeling enough
        // that it needs a real human tap, not just conversational assent.
        // This returns a pending-confirmation card; the client's Confirm
        // button calls the existing DELETE /tasks/:id REST endpoint, which
        // is what actually removes it.
        const task = await getTask(userId, target.taskId);
        if (!task)
          return {
            ok: false,
            error:
              "no removal happened — that task ref doesn't match any current task; it may already be gone or the ref may be wrong. Check the task list.",
          };
        const scope = validated.data.scope ?? 'series';
        // Removing a goal-linked series removes the goal with it (the
        // executor's cascade rule) — the confirmation tap has to say so, or
        // the user is consenting to less than what happens.
        let goalNote = '';
        if (resolved.ref.isRecurringSeries && scope === 'series' && task.recurrence && task.goalId) {
          const linkedGoal = await getGoalRow(userId, task.goalId);
          if (linkedGoal) goalNote = ` This task powers goal "${linkedGoal.name}" — removing it removes the goal too.`;
        }
        const summary =
          resolved.ref.isRecurringSeries && scope === 'series' && task.recurrence
            ? `Tap to confirm removing "${task.title}" — repeats, removes the whole series.${goalNote}`
            : resolved.ref.isRecurringSeries && scope === 'occurrence'
              ? `Tap to confirm skipping today's "${task.title}" — the schedule keeps going.`
              : `Tap to confirm removing "${task.title}".`;
        return { ok: true, toolName, task, summary, recordKind: 'task_removal_pending' };
      }
      case 'remove_tasks': {
        const validated = validateToolInput('remove_tasks', rawInput);
        if (!validated.ok) return { ok: false, error: validated.error };

        // Every item is validated before anything is returned — one bad
        // ref fails the whole call rather than leaving a partial pending
        // confirmation the user could tap into.
        const scope = validated.data.scope ?? 'series';
        const resolvedTasks: TaskRow[] = [];
        // scope only actually skips-just-today for the items that are
        // recurring refs — a non-recurring ref in the same batch always
        // means a real removal regardless of scope (removeTarget's own
        // rule) — tracked per item so the summary never claims a schedule
        // "keeps going" for a task that's actually gone for good, or vice
        // versa, in a batch that mixes both.
        const skippedTitles: string[] = [];
        const removedTitles: string[] = [];
        const cascadedGoalNames = new Set<string>();
        for (const item of validated.data.items) {
          const resolved = resolveTaskRef(refs, item.taskRef);
          if (!resolved.ok) return { ok: false, error: `${item.taskRef}: ${resolved.error}` };
          const target = removeTarget(resolved.ref, scope);
          if (!target.ok) return { ok: false, error: `${item.taskRef}: ${target.error}` };
          const hintCheck = await verifyTitleHint(userId, target.taskId, item.titleHint);
          if (hintCheck) return { ok: false, error: `${item.taskRef}: ${hintCheck.error}` };
          const task = await getTask(userId, target.taskId);
          if (!task) {
            return {
              ok: false,
              error: `${item.taskRef}: no removal happened — that task ref doesn't match any current task. Check the task list.`,
            };
          }
          resolvedTasks.push(task);
          const isOccurrenceSkip = resolved.ref.isRecurringSeries && scope === 'occurrence';
          (isOccurrenceSkip ? skippedTitles : removedTitles).push(`"${task.title}"`);
          // Same disclosure as remove_task: a goal-linked series in the
          // batch takes its goal with it, and the confirm text must say so.
          if (!isOccurrenceSkip && task.recurrence && task.goalId) {
            const linkedGoal = await getGoalRow(userId, task.goalId);
            if (linkedGoal) cascadedGoalNames.add(linkedGoal.name);
          }
        }

        const parts: string[] = [];
        if (removedTitles.length) parts.push(`remove ${removedTitles.join(', ')} for good`);
        if (cascadedGoalNames.size)
          parts.push(
            `this also removes ${[...cascadedGoalNames].map((n) => `goal "${n}"`).join(' and ')} (powered by those tasks)`,
          );
        if (skippedTitles.length)
          parts.push(`skip today's occurrence of ${skippedTitles.join(', ')} — the schedule keeps going`);
        return {
          ok: true,
          toolName,
          tasks: resolvedTasks,
          summary: `Tap to confirm: ${parts.join('; ')}.`,
          recordKind: 'task_bulk_removal_pending',
        };
      }
      case 'create_goal': {
        const validated = validateToolInput('create_goal', rawInput);
        if (!validated.ok) return { ok: false, error: validated.error };

        // Never saves — this returns a preview only (docs/goals-redesign-
        // plan.md §2.1). POST /goals {previewMessageId} does the actual
        // create once the user taps. The cross-field rules (savings needs a
        // target, habit needs its check-in task and no numbers, indirect
        // needs a unit) are already enforced by createGoalParamsSchema's
        // superRefine in validateToolInput above — a violation came back as
        // an error the model can act on, not a half-built preview.
        // activeStageIndex is never a model input — every fresh milestone
        // starts at its first stage (docs/milestone-goal-plan.md §1); stages
        // itself is optional now — omitted means a bare template
        // (docs/goal-manual-editing-plan.md §1 decision 1).
        const definition = buildGoalDefinition(validated.data);
        const preview: GoalPreview = {
          template: validated.data.type,
          name: validated.data.name,
          icon: validated.data.icon ?? null,
          definition,
          starterTasks: validated.data.starterTasks,
        };

        // Advisory-only: a savings goal with a deadline whose proposed
        // starter pace can't actually reach the target by then (small-nits
        // ledger — "$5/day starter against $1000/7-day goal"). Never blocks
        // the preview; just tells the model so it can propose a better pace
        // before the user taps Create.
        let paceNote = '';
        if (definition.type === 'savings' && definition.deadline && validated.data.starterTasks?.length) {
          const tz = timezone ?? 'UTC';
          const shortfall = checkStarterPace(
            definition.targetValue,
            definition.deadline,
            validated.data.starterTasks,
            ymdInTz(new Date(), tz),
            tz,
          );
          if (shortfall) {
            paceNote = ` Heads up: at this pace the starter tasks only reach ${definition.currency}${formatMoney(shortfall.projectedTotal)} by ${definition.deadline}, short of the ${definition.currency}${formatMoney(definition.targetValue)} target by ${definition.currency}${formatMoney(shortfall.shortfall)} — consider proposing a bigger contribution or a later deadline before the user taps Create (they can still create it as-is if they want).`;
          }
        }

        // Server-computed handoff caption (docs/goal-manual-editing-plan.md
        // §3.4) — the one thing the card can't show for itself: a bare
        // milestone template has nowhere to send the user next, and a
        // staged one is worth confirming before they tap Create. Never
        // model-authored (chat-architecture.md §9's trust boundary).
        const detail =
          definition.type === 'milestone'
            ? definition.stages.length === 0
              ? 'Open in Goals to add your stages'
              : `${definition.stages.length} stage${definition.stages.length === 1 ? '' : 's'} set — add tasks in Goals`
            : undefined;

        return {
          ok: true,
          toolName,
          preview,
          detail,
          // FACTS ONLY. This string is three things at once: the narrate pass's
          // input, the tool result in act-pass history, and the persisted content
          // of the card message — so every instruction smuggled in here is a
          // prompt rule replayed into model-visible history on every future turn,
          // which chat-architecture.md §5 says will eventually be copied verbatim.
          // It was ~700 chars of "never say X" and the model duly opened a reply
          // with "You already have a preview card up" — the exact phrasing the
          // blob forbade. Negative instructions prime what they forbid. The rules
          // live in SYSTEM_PROMPT's Goals section now, where rules belong.
          summary: `Preview card shown — nothing is saved yet; the user taps Create on the card. ${describeGoalPreviewForSummary(preview)}${paceNote}`,
          recordKind: 'goal_preview',
        };
      }
      case 'edit_goal': {
        const validated = validateToolInput('edit_goal', rawInput);
        if (!validated.ok) return { ok: false, error: validated.error };
        const resolved = resolveGoalRef(refs, validated.data.goalRef);
        if (!resolved.ok) return { ok: false, error: resolved.error };
        const goalId = resolved.ref.goalId;
        const hintCheck = await verifyNameHint(userId, goalId, validated.data.nameHint);
        if (hintCheck) return { ok: false, error: hintCheck.error };

        const before = await getGoalRow(userId, goalId);
        if (!before) {
          return { ok: false, error: "that goal ref doesn't match any current goal — check the goals list." };
        }

        const patch: EditGoalPatch = {
          name: validated.data.name,
          icon: validated.data.icon,
          targetValue: validated.data.targetValue,
          deadline: validated.data.deadline,
          unit: validated.data.unit,
        };
        const { goal } = await editGoal(userId, goalId, patch, source);

        // Target/deadline edits change the pace — state the recomputed one
        // so the model quotes it instead of doing its own division.
        const paceSuffix =
          validated.data.targetValue !== undefined || validated.data.deadline !== undefined
            ? await goalHeadlineWithPace(goal, timezone)
            : '';
        return {
          ok: true,
          toolName,
          goal,
          summary: `${describeGoalEdit(before, goal, validated.data)}${paceSuffix ? ` Now: ${paceSuffix}.` : ''}`,
          recordKind: 'goal_edited',
        };
      }
      case 'remove_goal': {
        const validated = validateToolInput('remove_goal', rawInput);
        if (!validated.ok) return { ok: false, error: validated.error };
        const resolved = resolveGoalRef(refs, validated.data.goalRef);
        if (!resolved.ok) return { ok: false, error: resolved.error };
        const goalId = resolved.ref.goalId;
        const hintCheck = await verifyNameHint(userId, goalId, validated.data.nameHint);
        if (hintCheck) return { ok: false, error: hintCheck.error };

        // Unlike remove_task there's no tap-to-confirm card for goals —
        // removal applies immediately, but it's archival (fully restored by
        // undo_last_action, linked tasks included), and the tool description
        // requires clear user intent first. Linked tasks cascade away with
        // it (archiveGoal), so no orphaned "Save $5" keeps nagging for a
        // goal that no longer exists.
        const { goal, cascadedTaskTitles } = await archiveGoal(userId, goalId, source);
        const taskNote = cascadedTaskTitles.length
          ? ` along with ${cascadedTaskTitles.map((t) => `"${t}"`).join(', ')}`
          : '';
        return {
          ok: true,
          toolName,
          goal,
          summary: `Removed the "${goal.name}" goal${taskNote}. "Undo" brings it all back.`,
          recordKind: 'goal_archived',
        };
      }
      case 'advance_goal_stage': {
        const validated = validateToolInput('advance_goal_stage', rawInput);
        if (!validated.ok) return { ok: false, error: validated.error };
        const resolved = resolveGoalRef(refs, validated.data.goalRef);
        if (!resolved.ok) return { ok: false, error: resolved.error };
        const goalId = resolved.ref.goalId;
        const hintCheck = await verifyNameHint(userId, goalId, validated.data.nameHint);
        if (hintCheck) return { ok: false, error: hintCheck.error };

        const goal = await getGoalRow(userId, goalId);
        if (!goal) {
          return { ok: false, error: "that goal ref doesn't match any current goal — check the goals list." };
        }
        const definition = goal.definition as GoalDefinition;
        if (definition.type !== 'milestone') {
          return {
            ok: false,
            error: `"${goal.name}" isn't a milestone goal — advance_goal_stage only applies to milestone goals.`,
          };
        }
        if (definition.stages.length === 0) {
          return {
            ok: false,
            error: `"${goal.name}" has no stages set yet — tell the user to add them in the Goals tab before advancing.`,
          };
        }
        if (definition.activeStageIndex >= definition.stages.length) {
          return {
            ok: false,
            error: `"${goal.name}" is already complete — every stage is done, nothing left to advance.`,
          };
        }

        // Never trust the model's idea of which stage is current or which
        // tasks are open — built server-side from LIVE state
        // (docs/milestone-goal-plan.md §2.1). Doesn't mutate anything: this
        // is a pending-confirmation card, mirroring remove_task; the actual
        // advance happens in POST /goals/:id/advance once the user taps it.
        const fromStageIndex = definition.activeStageIndex;
        const fromStage = definition.stages[fromStageIndex]!;
        const toStage = definition.stages[fromStageIndex + 1] ?? null;
        const retireCandidates = await listGoalRetireCandidates(userId, goalId);
        const retire = retireCandidates.map((t) => ({ taskId: t.id, title: t.title }));
        // A next-stage task proposal only makes sense when there IS a next
        // stage — this advance completing the goal means nothing to create.
        // The model's own tasks win if it has them (the user stated the
        // next stage's plan in the same breath as the advance declaration);
        // otherwise fall back to what was already planned for that stage in
        // the Goals tab (docs/goal-manual-editing-plan.md §3.4) — so the
        // confirm card shows exactly what will materialize on tap.
        const nextStageTasks = toStage
          ? validated.data.nextStageTasks?.length
            ? validated.data.nextStageTasks
            : plannedTasksForStage(definition, fromStageIndex + 1)
          : undefined;

        const proposal: AdvanceStageProposal = { goalId, fromStageIndex, fromStage, toStage, retire, nextStageTasks };

        const retireNote = retire.length ? ` — retires ${retire.map((t) => `"${t.title}"`).join(', ')}` : '';
        const addNote = nextStageTasks?.length
          ? `, adds ${nextStageTasks.map((t) => `"${t.title}"`).join(', ')}`
          : '';
        const summary = toStage
          ? `Tap to confirm: finish "${fromStage}" and move "${goal.name}" to "${toStage}"${retireNote}${addNote}.`
          : `Tap to confirm: finish "${fromStage}" and complete "${goal.name}" — that's the last stage${retireNote}.`;

        return {
          ok: true,
          toolName,
          goal,
          proposal,
          summary,
          recordKind: 'goal_advance_pending',
        };
      }
      case 'log_goal_entry': {
        const validated = validateToolInput('log_goal_entry', rawInput);
        if (!validated.ok) return { ok: false, error: validated.error };
        const resolved = resolveGoalRef(refs, validated.data.goalRef);
        if (!resolved.ok) return { ok: false, error: resolved.error };
        const goalId = resolved.ref.goalId;
        const hintCheck = await verifyNameHint(userId, goalId, validated.data.nameHint);
        if (hintCheck) return { ok: false, error: hintCheck.error };

        const entryAt = normalizeDueAt(validated.data.entryAt, timezone);
        if ('error' in entryAt) return { ok: false, error: entryAt.error };

        const patch: LogGoalEntryPatch = {
          amount: validated.data.amount,
          note: validated.data.note,
          entryAt: entryAt.value ?? undefined,
        };
        const { goal } = await logGoalEntry(userId, goalId, patch, source);

        // logGoalEntry rejects habit goals, so a success here is always
        // savings or indirect. Indirect gets the delta-vs-previous fact too
        // (goalHeadlineWithDelta) so the model can narrate history, not just
        // the raw new value.
        const definition = goal.definition as GoalDefinition;
        const headline =
          definition.type === 'indirect'
            ? await goalHeadlineWithDelta(goal, timezone)
            : await goalHeadline(goal, timezone);
        const logged = describeEntryData(definition, { amount: validated.data.amount, note: validated.data.note });
        return {
          ok: true,
          toolName,
          goal,
          summary: `Logged ${logged} to "${goal.name}"${headline ? ` — ${headline} now` : ''}.`,
          recordKind: 'goal_entry',
        };
      }
      case 'undo_last_action': {
        /**
         * THE GUARD. A tap-to-confirm card mutates nothing — it is a question,
         * not a change. So when the newest thing on the user's screen is one of
         * those and they say "undo that", there is by definition nothing to undo:
         * "that" is the card, and the card did nothing.
         *
         * Without this, undo_last_action happily reached PAST the card and
         * reverted the last real record — an unrelated task the user had actually
         * completed — while the reply told them "nothing got deleted". It is the
         * only way left for Meroa to change someone's data without saying so, and
         * it fired in roughly 1 undo in 20.
         *
         * The rule already existed, in the prompt. It held ~95% of the time,
         * which is exactly the problem: a prompt is a suggestion with a good
         * success rate, and a data-integrity invariant needs a guarantee. So it
         * moves here, where model judgment cannot defeat it — the same reasoning
         * as resolveTaskRef and verifyTitleHint.
         *
         * Deliberately says nothing about tools: this string is fed back into the
         * reply pass, and naming a tool there is how mechanics leak into chat.
         */
        if (pendingConfirmCard) {
          return {
            ok: false,
            error:
              "there's a confirmation card still showing, and it hasn't changed anything yet — so there is nothing to undo. Nothing was reverted. Ask them whether they want to cancel that card, or undo an earlier change instead.",
          };
        }
        const result = await undoLastAction(userId, source);
        if (result.goal) {
          return {
            ok: true,
            toolName,
            goal: result.goal,
            summary: await summarizeGoalUndo(
              result.goal,
              result.action,
              timezone,
              result.goalEntryData as GoalEntryData | undefined,
            ),
            recordKind: result.action,
          };
        }
        const { task, action, tasks } = result;
        if (!task) throw new Error('undo_last_action returned neither a task nor a goal');
        // Without the concrete restored value here, the model has nothing
        // but its own (unreliable) memory of prior turns to describe what
        // changed — observed live producing a wrong due date two edits
        // back instead of the actual just-restored one. State the fact so
        // there's nothing left to guess.
        const restoredWhen = shortDueLabel(task, timezone);
        const restoredDetail = restoredWhen
          ? ` — now due ${restoredWhen}`
          : task.status !== 'open'
            ? ` — now marked ${task.status}`
            : '';
        const summary =
          tasks && tasks.length > 1
            ? `Undid the last change — restored ${tasks.length} tasks: ${tasks.map((t) => `"${t.title}"`).join(', ')}.`
            : `Undid the last change to "${task.title}"${restoredDetail}.`;
        return { ok: true, toolName, task, summary, recordKind: action };
      }
      case 'remember': {
        const validated = validateToolInput('remember', rawInput);
        if (!validated.ok) return { ok: false, error: validated.error };
        const memory = await createMemory(userId, {
          kind: validated.data.kind,
          content: validated.data.content,
          sensitive: validated.data.sensitive,
          source: 'chat_explicit',
          sourceMessageId: source.sourceMessageId,
        });
        return { ok: true, toolName, memory, summary: summarizeRemember(memory), recordKind: 'memory_action' };
      }
      case 'adjust_style': {
        const validated = validateToolInput('adjust_style', rawInput);
        if (!validated.ok) return { ok: false, error: validated.error };
        await applyStyleAdjustment(userId, validated.data);
        return {
          ok: true,
          toolName,
          styleSummary: describeStyleAdjustment(validated.data),
          recordKind: 'style_adjusted',
        };
      }
      default: {
        const exhaustive: never = toolName;
        return { ok: false, error: `unhandled tool "${exhaustive}"` };
      }
    }
  } catch (err) {
    if (err instanceof TaskActionError || err instanceof GoalActionError) {
      return { ok: false, error: err.message };
    }
    throw err;
  }
}
