import { localDatetimeToUtcIso, ymdEndOfDayToUtcDate, ymdInTz } from '../tasks/recurrence.ts';
import type { ProgressInput } from '../tasks/schema.ts';
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

// Deterministic backstop for a hallucinated or mismatched taskId: the model
// must state what it believes the task's title is, and this checks that
// against the task's real, current title before edit/complete/progress/
// postpone/remove ever executes. Observed in practice: a model once deleted
// an unrelated task because it silently picked the wrong id for "the daily
// one at 10am" — this makes that class of error mechanically impossible to
// execute rather than just less likely. Returns null (no error) if the task
// doesn't exist at all, letting the executor's own not_found error fire
// instead of a confusing double message.
async function verifyTitleHint(
  userId: string,
  taskId: string,
  titleHint: string,
): Promise<{ error: string } | null> {
  const task = await getTask(userId, taskId);
  if (!task) return null;
  if (titleMatches(titleHint, task.title)) return null;
  return {
    error: `taskId doesn't match titleHint — the task at that id is actually titled "${task.title}", not "${titleHint}". Re-check the task list in context for the right id, or ask the user to clarify which task they mean.`,
  };
}

export type TaskActionResult =
  | { ok: true; toolName: AiToolName; task: TaskRow; summary: string; recordKind: string }
  | { ok: false; error: string };

// "7:00 PM" / "tomorrow at 7:00 PM" / "Jul 15 at 7:00 PM" — short and
// readable instead of a full localized date-time string. Never fabricates a
// time: an implicit end-of-day dueAt (dueTimeExplicit: false) returns ''.
function shortDueLabel(task: TaskRow): string {
  if (!task.dueAt) return '';
  const explicit = (task.config as { dueTimeExplicit?: boolean }).dueTimeExplicit !== false;
  if (!explicit) return '';
  const due = new Date(task.dueAt);
  const time = due.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const today = new Date();
  if (due.toDateString() === today.toDateString()) return time;
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (due.toDateString() === tomorrow.toDateString()) return `tomorrow at ${time}`;
  return `${due.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} at ${time}`;
}

function summarizeCreate(task: TaskRow): string {
  const label = shortDueLabel(task);
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

/**
 * Validates + executes one AI-issued tool call against the shared task
 * executor (the same functions the REST routes call), scoped to `source`
 * so records/idempotency work identically to a UI-driven action.
 */
export async function executeAiToolCall(
  userId: string,
  timezone: string | null,
  toolName: string,
  rawInput: unknown,
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
          summary: summarizeCreate(task),
          recordKind: 'task_created',
        };
      }
      case 'edit_task': {
        const validated = validateToolInput('edit_task', rawInput);
        if (!validated.ok) return { ok: false, error: validated.error };
        const hintCheck = await verifyTitleHint(userId, validated.data.taskId, validated.data.titleHint);
        if (hintCheck) return { ok: false, error: hintCheck.error };
        const dueAt = normalizeDueAt(validated.data.dueAt, timezone);
        if ('error' in dueAt) return { ok: false, error: dueAt.error };
        const { taskId, titleHint: _titleHint, ...patch } = validated.data;
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
        const hintCheck = await verifyTitleHint(userId, validated.data.taskId, validated.data.titleHint);
        if (hintCheck) return { ok: false, error: hintCheck.error };
        const { taskId, titleHint: _titleHint, ...input } = validated.data;
        const { task } = await completeTask(userId, taskId, input, source);
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
        const hintCheck = await verifyTitleHint(userId, validated.data.taskId, validated.data.titleHint);
        if (hintCheck) return { ok: false, error: hintCheck.error };
        const { taskId, action } = validated.data;
        const input: ProgressInput =
          action === 'start_timer'
            ? { kind: 'duration_start' }
            : action === 'stop_timer'
              ? { kind: 'duration_stop' }
              : { kind: 'counter_increment', amount: validated.data.amount };
        const { task } = await progressTask(userId, taskId, input, source);
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
        const hintCheck = await verifyTitleHint(userId, validated.data.taskId, validated.data.titleHint);
        if (hintCheck) return { ok: false, error: hintCheck.error };
        const newDueAt = normalizeDueAt(validated.data.newDueAt, timezone);
        if ('error' in newDueAt) return { ok: false, error: newDueAt.error };
        const { taskId, titleHint: _titleHint, ...input } = validated.data;
        const { task } = await postponeTask(
          userId,
          taskId,
          { ...input, newDueAt: newDueAt.value ?? null },
          timezone,
          source,
        );
        const when = shortDueLabel(task) || 'later';
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
        const hintCheck = await verifyTitleHint(userId, validated.data.taskId, validated.data.titleHint);
        if (hintCheck) return { ok: false, error: hintCheck.error };
        // Doesn't actually delete — removal is destructive-feeling enough
        // that it needs a real human tap, not just conversational assent.
        // This returns a pending-confirmation card; the client's Confirm
        // button calls the existing DELETE /tasks/:id REST endpoint, which
        // is what actually removes it.
        const task = await getTask(userId, validated.data.taskId);
        if (!task) return { ok: false, error: 'That task no longer exists — nothing to remove.' };
        return {
          ok: true,
          toolName,
          task,
          summary: `Tap to confirm removing "${task.title}".`,
          recordKind: 'task_removal_pending',
        };
      }
      case 'undo_last_action': {
        const { task, action } = await undoLastAction(userId);
        return {
          ok: true,
          toolName,
          task,
          summary: `Undid the last change to "${task.title}".`,
          recordKind: action,
        };
      }
      default: {
        const exhaustive: never = toolName;
        return { ok: false, error: `unhandled tool "${exhaustive}"` };
      }
    }
  } catch (err) {
    if (err instanceof TaskActionError) {
      return { ok: false, error: err.message };
    }
    throw err;
  }
}
