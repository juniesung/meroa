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
  createGoal,
  editGoal,
  getGoal as getGoalRow,
  logGoalEntry,
  GoalActionError,
  type GoalRow,
} from '../goals/executor.ts';
import { buildTemplateDefinition } from '../goals/templates.ts';
import {
  goalDefinitionSchema,
  validateEntryValues,
  type EditGoalPatch,
  type LogGoalEntryPatch,
  type GoalDefinition,
  type GoalEntryValue,
  type GoalPreview,
} from '../goals/schema.ts';
import { buildGoalCardSummaries } from '../goals/summary.ts';
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
  | { ok: true; toolName: AiToolName; task: TaskRow; summary: string; recordKind: string }
  | { ok: true; toolName: AiToolName; tasks: TaskRow[]; summary: string; recordKind: string }
  // A goal action that actually mutated a saved row — edit_goal,
  // log_goal_entry, or an undo_last_action that reverted a goal_% record.
  | { ok: true; toolName: AiToolName; goal: GoalRow; summary: string; recordKind: string }
  // create_goal — a preview only, nothing saved yet
  // (docs/goals-redesign-plan.md §2.1/§2.2).
  | { ok: true; toolName: AiToolName; preview: GoalPreview; summary: string; recordKind: string }
  | { ok: false; error: string };

// "$150" for the primary field, "Note: groceries" for anything else — used
// both to confirm what log_goal_entry actually recorded and to narrate what
// an undone entry removed.
function describeEntryValues(definition: GoalDefinition, data: Record<string, unknown>): string {
  const fieldsById = new Map(definition.fields.map((f) => [f.id, f]));
  const parts: string[] = [];
  for (const [fieldId, value] of Object.entries(data)) {
    const field = fieldsById.get(fieldId);
    if (!field) continue;
    const unit = field.unit ? ` ${field.unit}` : '';
    parts.push(field.id === definition.primaryFieldId ? `${value}${unit}` : `${field.label}: ${value}${unit}`);
  }
  return parts.join(', ');
}

// The goal's concrete, recomputed post-action fact (never leaves the model
// to narrate from memory — docs/ai-reliability-hardening.md lesson 16).
// Reuses the batched summaries helper with a single-element array; the cost
// is the same as a dedicated single-goal query would be.
async function goalHeadline(goal: GoalRow, timezone: string | null): Promise<string> {
  const summaries = await buildGoalCardSummaries([goal], timezone);
  return summaries.get(goal.id)?.headline ?? '';
}

async function summarizeGoalUndo(
  goal: GoalRow,
  undidKind: string,
  timezone: string | null,
  entryData?: Record<string, unknown>,
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
      const logged = entryData ? describeEntryValues(goal.definition as GoalDefinition, entryData) : '';
      return `Removed that${logged ? ` ${logged}` : ''} entry from "${goal.name}"${headline ? ` — ${headline} now` : ''}.`;
    }
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
  input: {
    name?: string;
    targetValue?: number;
    unit?: string;
    addFields?: unknown[];
    removeFieldRefs?: string[];
    renameFields?: unknown[];
  },
): string {
  const parts: string[] = [];
  if (input.name !== undefined) parts.push(`renamed to "${after.name}"`);

  const beforeTarget = (before.definition as GoalDefinition).target;
  const afterTarget = (after.definition as GoalDefinition).target;
  if (input.targetValue !== undefined && afterTarget && beforeTarget) {
    const afterUnit = 'unit' in afterTarget && afterTarget.unit ? ` ${afterTarget.unit}` : '';
    const beforeUnit = 'unit' in beforeTarget && beforeTarget.unit ? ` ${beforeTarget.unit}` : '';
    parts.push(`target is now ${afterTarget.value}${afterUnit} (was ${beforeTarget.value}${beforeUnit})`);
  }
  if (input.unit !== undefined) parts.push(`unit is now ${input.unit}`);
  if (input.addFields?.length) {
    parts.push(input.addFields.length === 1 ? 'added a field' : `added ${input.addFields.length} fields`);
  }
  if (input.removeFieldRefs?.length) {
    parts.push(
      input.removeFieldRefs.length === 1 ? 'removed a field' : `removed ${input.removeFieldRefs.length} fields`,
    );
  }
  if (input.renameFields?.length) {
    parts.push(input.renameFields.length === 1 ? 'renamed a field' : `renamed ${input.renameFields.length} fields`);
  }

  const changedFields = !!(input.addFields?.length || input.removeFieldRefs?.length || input.renameFields?.length);
  const suffix = changedFields ? ' Past entries are unaffected.' : '';
  return parts.length ? `Updated "${after.name}" — ${parts.join('; ')}.${suffix}` : `Updated "${after.name}".`;
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

function resolveGoalFieldRef(
  refs: TurnRefs,
  goalId: string,
  fieldRef: string,
): { ok: true; fieldId: string } | { ok: false; error: string } {
  const entry = refs.get(fieldRef);
  if (!entry || entry.kind !== 'goal_field' || entry.goalId !== goalId) {
    return {
      ok: false,
      error: `${fieldRef} isn't a valid field ref for that goal — re-check the [fields: ...] list in context.`,
    };
  }
  return { ok: true, fieldId: entry.fieldId };
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

        let input: typeof validated.data & { dueTimeExplicit: boolean };
        if (validated.data.recurrence) {
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
          input = { ...validated.data, dueAt: undefined, dueTimeExplicit: !!validated.data.recurrence.time };
        } else {
          const dueAt = normalizeDueAt(validated.data.dueAt, timezone);
          if ('error' in dueAt) return { ok: false, error: dueAt.error };
          // The model was told to leave dueAt unset rather than invent a
          // clock time (tools.ts) — that doesn't mean "no deadline at all",
          // it means "sometime today": default to today's end-of-day so the
          // task still shows up as due, and goes overdue at midnight if
          // untouched, without a fabricated hour.
          const tz = timezone ?? 'UTC';
          const defaultedDueAt =
            dueAt.value ?? ymdEndOfDayToUtcDate(ymdInTz(new Date(), tz), tz).toISOString();
          input = { ...validated.data, dueAt: defaultedDueAt, dueTimeExplicit: dueAt.value != null };
        }

        const { task } = await createTask(userId, input, timezone, source);
        return {
          ok: true,
          toolName,
          task,
          summary: summarizeCreate(task, timezone),
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
        const { taskRef: _taskRef, titleHint: _titleHint, ...patch } = validated.data;
        const { task } = await editTask(
          userId,
          taskId,
          { ...patch, dueAt: dueAt.value },
          timezone,
          source,
        );
        return {
          ok: true,
          toolName,
          task,
          summary: `Updated "${task.title}".`,
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

        const { task } = await completeTask(
          userId,
          target.taskId,
          { value: validated.data.value, itemIds },
          source,
        );
        return {
          ok: true,
          toolName,
          task,
          summary: summarizeComplete(task),
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
        const { task } = await progressTask(userId, target.taskId, input, source);
        const summary =
          action === 'start_timer'
            ? `Started the timer for "${task.title}".`
            : action === 'stop_timer'
              ? `Paused "${task.title}".`
              : `Updated "${task.title}".`;
        return { ok: true, toolName, task, summary, recordKind: 'task_progress' };
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
        const summary =
          resolved.ref.isRecurringSeries && scope === 'series' && task.recurrence
            ? `Tap to confirm removing "${task.title}" — repeats, removes the whole series.`
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
        }

        const parts: string[] = [];
        if (removedTitles.length) parts.push(`remove ${removedTitles.join(', ')} for good`);
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
        // create once the user taps.
        const definition = goalDefinitionSchema.parse(buildTemplateDefinition(validated.data));
        const preview: GoalPreview = {
          template: validated.data.template,
          name: validated.data.name,
          icon: validated.data.icon ?? null,
          definition,
        };
        return {
          ok: true,
          toolName,
          preview,
          summary:
            'Preview card shown — nothing is saved yet; the user taps Create on the card to save it. Do not ask them to confirm in chat text.',
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

        let removeFieldIds: string[] | undefined;
        if (validated.data.removeFieldRefs?.length) {
          removeFieldIds = [];
          for (const fieldRef of validated.data.removeFieldRefs) {
            const resolvedField = resolveGoalFieldRef(refs, goalId, fieldRef);
            if (!resolvedField.ok) return { ok: false, error: resolvedField.error };
            removeFieldIds.push(resolvedField.fieldId);
          }
        }

        let renameFields: { fieldId: string; label: string }[] | undefined;
        if (validated.data.renameFields?.length) {
          renameFields = [];
          for (const r of validated.data.renameFields) {
            const resolvedField = resolveGoalFieldRef(refs, goalId, r.fieldRef);
            if (!resolvedField.ok) return { ok: false, error: resolvedField.error };
            renameFields.push({ fieldId: resolvedField.fieldId, label: r.label });
          }
        }

        const patch: EditGoalPatch = {
          name: validated.data.name,
          icon: validated.data.icon,
          targetValue: validated.data.targetValue,
          unit: validated.data.unit,
          addFields: validated.data.addFields,
          removeFieldIds,
          renameFields,
        };
        const { goal } = await editGoal(userId, goalId, patch, source);

        return {
          ok: true,
          toolName,
          goal,
          summary: describeGoalEdit(before, goal, validated.data),
          recordKind: 'goal_edited',
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

        const values: GoalEntryValue[] = [];
        for (const v of validated.data.values) {
          const resolvedField = resolveGoalFieldRef(refs, goalId, v.fieldRef);
          if (!resolvedField.ok) return { ok: false, error: resolvedField.error };
          values.push({ fieldId: resolvedField.fieldId, value: v.value });
        }

        const entryAt = normalizeDueAt(validated.data.entryAt, timezone);
        if ('error' in entryAt) return { ok: false, error: entryAt.error };

        const patch: LogGoalEntryPatch = { values, entryAt: entryAt.value ?? undefined };
        const { goal } = await logGoalEntry(userId, goalId, patch, source);

        const headline = await goalHeadline(goal, timezone);
        const logged = describeEntryValues(
          goal.definition as GoalDefinition,
          Object.fromEntries(values.map((v) => [v.fieldId, v.value])),
        );
        return {
          ok: true,
          toolName,
          goal,
          summary: `Logged ${logged || 'that'} to "${goal.name}"${headline ? ` — ${headline} now` : ''}.`,
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
            summary: await summarizeGoalUndo(result.goal, result.action, timezone, result.goalEntryData),
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
