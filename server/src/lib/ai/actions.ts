import {
  formatYmdShort,
  localDatetimeToUtcIso,
  nextOccurrenceYmd,
  ymdEndOfDayToUtcDate,
  ymdInTz,
} from '../tasks/recurrence.ts';
import type { ProgressInput, Recurrence } from '../tasks/schema.ts';
import {
  completeTask,
  createTask,
  editTask,
  getTask,
  postponeTask,
  progressTask,
  TaskActionError,
  undoLastAction,
  type ActionSource,
  type TaskRow,
} from '../tasks/executor.ts';
import {
  archiveGoal,
  createGoal,
  editGoal,
  getGoal as getGoalRow,
  listGoalRetireCandidates,
  logGoalEntry,
  GoalActionError,
  type GoalRow,
} from '../goals/executor.ts';
import {
  goalDefinitionSchema,
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

function normalizeForMatch(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9\s]/g, '');
}

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
  | { ok: true; toolName: AiToolName; task: TaskRow; summary: string; modelSummary?: string; recordKind: string }
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
  // (docs/goals-redesign-plan.md §2.1/§2.2).
  | { ok: true; toolName: AiToolName; preview: GoalPreview; summary: string; recordKind: string }
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
      definition.activeStageIndex < definition.stages.length
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

function summarizeCreate(task: TaskRow, timezone: string | null): string {
  const label = shortDueLabel(task, timezone);
  return label ? `Added "${task.title}" for ${label}.` : `Added "${task.title}".`;
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

/**
 * A task created mid-turn gets a ref immediately, in the same TurnRefs map
 * the turn started with — without this, a create→act chain in one turn
 * always fails: the refs map is built at turn start, so the model's natural
 * follow-up ("created the counter, now log your current 165") has nothing
 * to target and guesses the next T-number, which is rejected. Observed
 * live doing exactly that (guessed "T8", failed, then spiraled into raw
 * markup leaks and a "glitched on my end" ending). The assigned ref is
 * appended to the tool-result summary so the model knows it — that summary
 * is model-facing, and the prompt already forbids repeating refs to the
 * user.
 */
function registerCreatedTaskRef(refs: TurnRefs, task: TaskRow): string {
  let maxIndex = 0;
  for (const key of refs.keys()) {
    const match = /^T(\d+)$/.exec(key);
    if (match) maxIndex = Math.max(maxIndex, Number(match[1]));
  }
  const alias = `T${maxIndex + 1}`;

  if (task.recurrence) {
    // createTask returned the template itself (recurring, no instance due
    // today) — same ref shape task-context.ts gives an off-day template.
    refs.set(alias, { kind: 'task', taskId: task.id, isRecurringSeries: true, templateId: task.id });
  } else if (task.templateId) {
    // createTask returned today's freshly-materialized instance.
    refs.set(alias, {
      kind: 'task',
      taskId: task.id,
      isRecurringSeries: true,
      instanceId: task.id,
      templateId: task.templateId,
    });
  } else {
    refs.set(alias, { kind: 'task', taskId: task.id, isRecurringSeries: false });
  }

  const items = (task.config as { items?: { id: string }[] }).items;
  if (task.type === 'checklist' && items) {
    items.forEach((item, idx) => {
      refs.set(`${alias}.${idx + 1}`, { kind: 'checklist_item', taskId: task.id, itemId: item.id });
    });
  }

  return alias;
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
): Promise<TaskActionResult> {
  return wrapFailure(await executeAiToolCallInner(userId, timezone, toolName, rawInput, refs, source));
}

async function executeAiToolCallInner(
  userId: string,
  timezone: string | null,
  toolName: string,
  rawInput: unknown,
  refs: TurnRefs,
  source: ActionSource,
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

        const { task } = await createTask(userId, input, timezone, source);
        const alias = registerCreatedTaskRef(refs, task);
        const linkSummary = await describeGoalLinkChange(userId, timezone, task, !!goalId, false, false);
        const summary = `${summarizeCreate(task, timezone)}${linkSummary}`;
        return {
          ok: true,
          toolName,
          task,
          summary,
          modelSummary: `${summary} Its ref is ${alias} — use that (never a guessed ref) if you need to act on it later this same turn, e.g. to log initial progress.`,
          recordKind: 'task_created',
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
        const definition = goalDefinitionSchema.parse(
          validated.data.type === 'habit'
            ? { type: 'habit' }
            : validated.data.type === 'indirect'
              ? {
                  type: 'indirect',
                  unit: validated.data.unit,
                  targetValue: validated.data.targetValue,
                  deadline: validated.data.deadline,
                }
              : validated.data.type === 'milestone'
                ? {
                    // activeStageIndex is never a model input — every fresh
                    // milestone starts at its first stage
                    // (docs/milestone-goal-plan.md §1).
                    type: 'milestone',
                    stages: validated.data.stages,
                    activeStageIndex: 0,
                  }
                : {
                    type: 'savings',
                    currency: validated.data.currency ?? '$',
                    targetValue: validated.data.targetValue,
                    deadline: validated.data.deadline,
                  },
        );
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

        return {
          ok: true,
          toolName,
          preview,
          summary: `Preview card shown — nothing is saved yet; the user taps Create on the card to save it. Do not ask them to confirm in chat text. This card is appearing for the FIRST time, right now, because you just called this tool — it was not up before and the user has not seen it; never tell them it was "already up" or "already there" (that reads as though you did nothing). ${describeGoalPreviewForSummary(preview)} Describe only what's listed here — never add, invent, or assume a starter task that isn't in that list, even if it seems like an obvious next step for this kind of goal.${paceNote}`,
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
        const nextStageTasks = toStage ? validated.data.nextStageTasks : undefined;

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
