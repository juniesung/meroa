import type { ChecklistItem, ProgressInput, TaskStatus, TaskType } from './schema.ts';

export type TaskProgressState = {
  type: TaskType;
  status: TaskStatus;
  config: Record<string, unknown>;
};
export type ProgressResult = { config: Record<string, unknown>; status: TaskStatus };

export class ProgressError extends Error {}

/**
 * Pure state transition: given a task's current type/status/config and one
 * progress action, returns the next config + status. No I/O — the executor
 * wraps this with the transaction, row lock, and records-row bookkeeping.
 */
export function reduceTaskProgress(task: TaskProgressState, input: ProgressInput): ProgressResult {
  switch (input.kind) {
    case 'mark_done': {
      requireType(task, 'completion', 'mark_done');
      return { config: task.config, status: 'done' };
    }
    case 'mark_open': {
      requireType(task, 'completion', 'mark_open');
      return { config: task.config, status: 'open' };
    }
    case 'checklist_toggle': {
      requireType(task, 'checklist', 'checklist_toggle');
      const items = readItems(task);
      if (!items.some((i) => i.id === input.itemId))
        throw new ProgressError('unknown checklist item');
      const nextItems = items.map((i) => (i.id === input.itemId ? { ...i, done: !i.done } : i));
      return checklistResult(task, nextItems);
    }
    case 'checklist_complete': {
      requireType(task, 'checklist', 'checklist_complete');
      const items = readItems(task);
      const validIds = new Set(items.map((i) => i.id));
      const requestedIds = input.itemIds ?? items.map((i) => i.id);
      const unknown = requestedIds.filter((id) => !validIds.has(id));
      // Unlike checklist_toggle, this used to silently no-op on an unknown
      // id — reporting success back to the caller (and the AI narrating
      // "done") while nothing was actually marked. Matches checklist_toggle's
      // behavior instead: fail loudly so a bad/hallucinated id gets caught.
      if (unknown.length) throw new ProgressError(`unknown checklist item id(s): ${unknown.join(', ')}`);
      const ids = new Set(requestedIds);
      const nextItems = items.map((i) => (ids.has(i.id) ? { ...i, done: true } : i));
      return checklistResult(task, nextItems);
    }
    case 'counter_increment': {
      requireType(task, 'counter', 'counter_increment');
      const target = readNumber(task, 'target');
      const count = Math.max(0, readNumber(task, 'count') + (input.amount ?? 1));
      return { config: { ...task.config, count }, status: count >= target ? 'done' : 'open' };
    }
    case 'counter_set': {
      requireType(task, 'counter', 'counter_set');
      const target = readNumber(task, 'target');
      return {
        config: { ...task.config, count: input.count },
        status: input.count >= target ? 'done' : 'open',
      };
    }
    case 'duration_start': {
      requireType(task, 'duration', 'duration_start');
      // A no-op if already running — resetting runningSince here would
      // silently discard whatever's elapsed since the real start (it's
      // only folded into loggedMinutes by stop/add/set), which is a real
      // risk since the AI has no separate signal telling it a timer is
      // already running before it decides to call this again.
      if (task.config.runningSince) return { config: task.config, status: task.status };
      return {
        config: { ...task.config, runningSince: new Date().toISOString() },
        status: task.status,
      };
    }
    case 'duration_stop': {
      requireType(task, 'duration', 'duration_stop');
      const runningSince = task.config.runningSince as string | null | undefined;
      const elapsedMinutes = runningSince
        ? Math.max(0, (Date.now() - new Date(runningSince).getTime()) / 60_000)
        : 0;
      const loggedMinutes = readNumber(task, 'loggedMinutes') + elapsedMinutes;
      return durationResult(task, loggedMinutes, null);
    }
    case 'duration_add_minutes': {
      requireType(task, 'duration', 'duration_add_minutes');
      const loggedMinutes = readNumber(task, 'loggedMinutes') + input.minutes;
      return durationResult(
        task,
        loggedMinutes,
        (task.config.runningSince as string | null) ?? null,
      );
    }
    case 'duration_set_minutes': {
      requireType(task, 'duration', 'duration_set_minutes');
      return durationResult(task, input.minutes, null);
    }
    // Generic "undo the completion, don't touch config" — used for types
    // where there's no clean fixed-size undo (duration's "tap again to bring
    // it back"). Completion/counter have their own more specific inverses
    // (mark_open, counter_increment by -1).
    case 'reopen': {
      return { config: task.config, status: 'open' };
    }
  }
}

/**
 * Resolves the flat `{ value?, itemIds? }` shape shared by the REST
 * `/complete` endpoint and the AI `complete_task` tool into a concrete
 * progress action for the task's actual type. `value` is always an absolute
 * measurement ("benched... for 20 minutes" -> 20, not +20); omitted value on
 * counter/duration completes fully (sets count/minutes to target).
 */
export function resolveCompleteInput(
  task: TaskProgressState,
  input: { value?: number; itemIds?: string[] },
): ProgressInput {
  switch (task.type) {
    case 'completion':
      return task.status === 'open' ? { kind: 'mark_done' } : { kind: 'mark_open' };
    case 'checklist':
      return { kind: 'checklist_complete', itemIds: input.itemIds };
    case 'counter':
      return { kind: 'counter_set', count: input.value ?? readNumber(task, 'target') };
    case 'duration':
      return {
        kind: 'duration_set_minutes',
        minutes: input.value ?? readNumber(task, 'targetMinutes'),
      };
  }
}

function requireType(task: TaskProgressState, type: TaskType, action: string) {
  if (task.type !== type)
    throw new ProgressError(
      `${action} only applies to ${type} tasks (this is a ${task.type} task)`,
    );
}

function readNumber(task: TaskProgressState, key: string): number {
  const value = task.config[key];
  if (typeof value !== 'number') throw new ProgressError(`task config is missing numeric "${key}"`);
  return value;
}

function readItems(task: TaskProgressState): ChecklistItem[] {
  const items = task.config.items;
  if (!Array.isArray(items)) throw new ProgressError('task config is missing checklist items');
  return items as ChecklistItem[];
}

function checklistResult(task: TaskProgressState, items: ChecklistItem[]): ProgressResult {
  const allDone = items.length > 0 && items.every((i) => i.done);
  return { config: { ...task.config, items }, status: allDone ? 'done' : 'open' };
}

function durationResult(
  task: TaskProgressState,
  loggedMinutes: number,
  runningSince: string | null,
): ProgressResult {
  const targetMinutes = readNumber(task, 'targetMinutes');
  const status = loggedMinutes >= targetMinutes ? 'done' : 'open';
  return { config: { ...task.config, loggedMinutes, runningSince }, status };
}
