import { and, desc, eq, isNull } from 'drizzle-orm';

import { db } from '../../db/client.ts';
import { tasks } from '../../db/schema.ts';
import { taskStatusOrder } from '../task-order.ts';
import { ymdEndOfDayToUtcDate, ymdInTz } from '../tasks/recurrence.ts';
import type { ChecklistConfig, CounterConfig, DurationConfig, Recurrence } from '../tasks/schema.ts';

const MAX_ROWS = 30;
const MAX_CHARS = 3000;
const RECENT_DONE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function progressLabel(type: string, config: Record<string, unknown>): string {
  switch (type) {
    case 'checklist': {
      const items = (config as ChecklistConfig).items ?? [];
      const doneCount = items.filter((i) => i.done).length;
      // Full item ids (not truncated) so complete_task's itemIds can target
      // one exactly — a partial id would silently match nothing.
      const itemsList = items.map((i) => `${i.id}="${i.text}"${i.done ? ' (done)' : ''}`).join('; ');
      return `checklist ${doneCount}/${items.length} [items: ${itemsList}]`;
    }
    case 'counter': {
      const c = config as CounterConfig;
      return `counter ${c.count}/${c.target}${c.unit ? ` ${c.unit}` : ''}`;
    }
    case 'duration': {
      const d = config as DurationConfig;
      // Surfaced so the model doesn't call start_timer on a timer that's
      // already running (progress_task's duration_start is a no-op in that
      // case, but the model should know rather than falsely narrate
      // "started" when it did nothing).
      const running = d.runningSince ? ' (running)' : '';
      return `duration ${Math.round(d.loggedMinutes ?? 0)}/${d.targetMinutes}m${running}`;
    }
    default:
      return 'completion';
  }
}

// Overdue only once the *entire calendar day* containing `dueAt` has elapsed
// in the user's timezone — not the instant the due time itself passes (a 9am
// task stays "due 9am" through the rest of that day, matching the app's
// isOverdue in components/TaskCard.tsx).
function isOverdue(dueAt: Date, tz: string): boolean {
  const endOfDueDay = ymdEndOfDayToUtcDate(ymdInTz(dueAt, tz), tz);
  return Date.now() > endOfDueDay.getTime();
}

// "Jul 12, 9:00 AM" — short and in the account's own timezone, instead of a
// verbose locale string (e.g. "7/12/2026, 9:00:00 AM"). Injected directly
// into the model's context, so a terser format here also means the model
// has less of that verbose style to pattern-match against when narrating
// its own replies.
function shortDateTime(d: Date, tz: string): string {
  const date = d.toLocaleDateString(undefined, { timeZone: tz, month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString(undefined, { timeZone: tz, hour: 'numeric', minute: '2-digit' });
  return `${date}, ${time}`;
}

function describeRecurrence(recurrence: Recurrence): string {
  const time = recurrence.time ? ` at ${recurrence.time}` : '';
  if (recurrence.freq === 'daily') return `daily${time}`;
  if (recurrence.freq === 'weekly') return `weekly on ${recurrence.byWeekday.join(',')}${time}`;
  return `every ${recurrence.n} days${time}`;
}

/**
 * Compact task-list summary injected into the AI's context so it can
 * reference real task ids instead of guessing. Callers must materialize
 * recurring instances first (the route already does this via GET /tasks'
 * shared path) — this only reads.
 */
export async function buildTaskContext(userId: string, timezone: string | null): Promise<string> {
  const rows = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.userId, userId), isNull(tasks.deletedAt)))
    .orderBy(taskStatusOrder, desc(tasks.createdAt))
    .limit(200);

  const recentCutoff = Date.now() - RECENT_DONE_WINDOW_MS;
  const relevant = rows.filter((t) => {
    if (t.recurrence) return true;
    if (t.status === 'open') return true;
    if (t.status === 'done' && t.createdAt.getTime() >= recentCutoff) return true;
    return false;
  });

  if (relevant.length === 0) return 'They have no tasks yet.';

  const lines: string[] = [];
  let charCount = 0;
  let shown = 0;
  const tz = timezone ?? 'UTC';
  for (const t of relevant) {
    if (shown >= MAX_ROWS) break;
    const overdue = t.status === 'open' && !!t.dueAt && isOverdue(t.dueAt, tz);
    const due = t.recurrence
      ? `repeats: ${describeRecurrence(t.recurrence as Recurrence)}`
      : t.dueAt
        ? overdue
          ? `overdue since ${shortDateTime(t.dueAt, tz)}`
          : `due ${shortDateTime(t.dueAt, tz)}`
        : 'no due date';
    const line = `[${t.id}] "${t.title}" · ${progressLabel(t.type, (t.config ?? {}) as Record<string, unknown>)} · ${due} · ${t.status}`;
    if (charCount + line.length > MAX_CHARS) break;
    lines.push(line);
    charCount += line.length;
    shown += 1;
  }
  if (shown < relevant.length) lines.push(`…and ${relevant.length - shown} more.`);

  return lines.join('\n');
}
