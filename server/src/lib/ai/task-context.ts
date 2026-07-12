import { and, desc, eq, isNull } from 'drizzle-orm';

import { db } from '../../db/client.ts';
import { records, tasks } from '../../db/schema.ts';
import { taskStatusOrder } from '../task-order.ts';
import {
  describeRecurrence,
  formatYmdShort,
  nextOccurrenceYmd,
  ymdEndOfDayToUtcDate,
  ymdInTz,
} from '../tasks/recurrence.ts';
import type { ChecklistConfig, ChecklistItem, CounterConfig, DurationConfig, Recurrence } from '../tasks/schema.ts';

const MAX_ROWS = 30;
const MAX_CHARS = 3000;
const RECENT_DONE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// Turn-scoped aliases stand in for real database ids everywhere the model
// can see or emit an identifier — a UUID is ~20 tokens of high-entropy noise
// a model can (and, observed in practice, does) silently corrupt. Assigned
// in render order ("T1", "T2", ...; checklist items "T2.1", "T2.2", ...) and
// resolved back to real ids server-side (lib/ai/actions.ts) before anything
// executes; an alias the model invents that isn't in this map is rejected
// deterministically rather than trusted.
export type TurnRef =
  | { kind: 'task'; taskId: string; isRecurringSeries: boolean; instanceId?: string; templateId?: string }
  | { kind: 'checklist_item'; taskId: string; itemId: string }
  // Goal refs — assigned by lib/ai/goal-context.ts into this same map,
  // aliased "G1"/"G1.1" rather than "T*" so a regex can't confuse the two
  // ref families.
  | { kind: 'goal'; goalId: string }
  | { kind: 'goal_field'; goalId: string; fieldId: string };
export type TurnRefs = Map<string, TurnRef>;

export type TaskContextResult = {
  text: string;
  refs: TurnRefs;
  counts: { open: number; doneToday: number };
};

type Row = {
  id: string;
  type: string;
  title: string;
  config: unknown;
  recurrence: unknown;
  dueAt: Date | null;
  status: string;
  templateId: string | null;
  occurrenceDate: string | null;
  createdAt: Date;
  completedAt: Date | null;
};

function renderChecklistItems(items: ChecklistItem[], alias: string, refs: TurnRefs, taskId: string): string {
  return items
    .map((item, idx) => {
      const itemAlias = `${alias}.${idx + 1}`;
      refs.set(itemAlias, { kind: 'checklist_item', taskId, itemId: item.id });
      return `${itemAlias}="${item.text}"${item.done ? ' (done)' : ''}`;
    })
    .join('; ');
}

function progressLabel(
  type: string,
  config: Record<string, unknown>,
  alias: string,
  refs: TurnRefs,
  taskId: string,
): string {
  switch (type) {
    case 'checklist': {
      const items = (config as ChecklistConfig).items ?? [];
      const doneCount = items.filter((i) => i.done).length;
      const itemsList = renderChecklistItems(items, alias, refs, taskId);
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

/**
 * Compact task-list summary injected into the AI's context so it can
 * reference tasks by turn-scoped alias instead of guessing an id. Callers
 * must materialize recurring instances first (the route already does this
 * via GET /tasks' shared path) — this only reads.
 *
 * A recurring template and its materialized instance for today are the same
 * conceptual task, not two — this renders exactly one logical row per task,
 * using the instance's live state when today has one and the template's
 * schedule otherwise (see docs/ai-reliability-hardening.md item 3). Counts
 * are computed here, over every logical row (not just what fits under the
 * row/char caps below), so the model never has to derive them by scanning.
 */
export async function buildTaskContext(userId: string, timezone: string | null): Promise<TaskContextResult> {
  const tz = timezone ?? 'UTC';
  const todayYmd = ymdInTz(new Date(), tz);

  const rows: Row[] = await db
    .select({
      id: tasks.id,
      type: tasks.type,
      title: tasks.title,
      config: tasks.config,
      recurrence: tasks.recurrence,
      dueAt: tasks.dueAt,
      status: tasks.status,
      templateId: tasks.templateId,
      occurrenceDate: tasks.occurrenceDate,
      createdAt: tasks.createdAt,
      completedAt: records.occurredAt,
    })
    .from(tasks)
    .leftJoin(records, eq(tasks.completedRecordId, records.id))
    .where(and(eq(tasks.userId, userId), isNull(tasks.deletedAt)))
    .orderBy(taskStatusOrder, desc(tasks.createdAt))
    .limit(200);

  const refs: TurnRefs = new Map();

  if (rows.length === 0) {
    return { text: 'They have no tasks yet.', refs, counts: { open: 0, doneToday: 0 } };
  }

  // Which instance row represents the template's "current" occurrence —
  // usually today's, but materializeRecurringInstances also bumps a
  // template's very first-ever occurrence to tomorrow when today's clock
  // time has already passed (see recurrence.ts's isFirstEverRun handling),
  // so this can legitimately be a future date. Whichever it is, it folds
  // into the template's row rather than rendering as a second, standalone
  // one — otherwise a freshly-created "every day at 10am" task made at
  // 11pm renders as two rows for the same conceptual task (observed live
  // running this file's own protocol against claude-haiku-4-5: the model
  // apologized for a "duplicate" it didn't create). Instances dated
  // *before* today are excluded here on purpose — those are genuinely
  // missed occurrences the missed-task-recovery flow still needs to
  // surface individually, not folded away.
  const currentInstanceByTemplate = new Map<string, Row>();
  for (const r of rows) {
    if (!r.templateId || !r.occurrenceDate || r.occurrenceDate < todayYmd) continue;
    const existing = currentInstanceByTemplate.get(r.templateId);
    if (!existing || r.occurrenceDate < existing.occurrenceDate!) {
      currentInstanceByTemplate.set(r.templateId, r);
    }
  }
  const hiddenInstanceIds = new Set(Array.from(currentInstanceByTemplate.values(), (r) => r.id));

  const recentCutoff = Date.now() - RECENT_DONE_WINDOW_MS;
  const relevant = rows.filter((t) => {
    if (hiddenInstanceIds.has(t.id)) return false;
    if (t.recurrence) return true;
    if (t.status === 'open') return true;
    if (t.status === 'done' && t.createdAt.getTime() >= recentCutoff) return true;
    return false;
  });

  if (relevant.length === 0) {
    return { text: 'They have no tasks yet.', refs, counts: { open: 0, doneToday: 0 } };
  }

  let openCount = 0;
  let doneTodayCount = 0;
  let totalLogical = 0;
  const lines: string[] = [];
  let charCount = 0;
  let shown = 0;
  let truncated = false;

  for (const t of relevant) {
    let displayRow: Row = t;
    let isRecurringSeries = false;
    let instanceId: string | undefined;
    let templateId: string | undefined;
    let scheduleNote = '';
    let offDayDue: string | null = null;

    if (t.recurrence) {
      isRecurringSeries = true;
      templateId = t.id;
      const recurrence = t.recurrence as Recurrence;
      const recurrenceDesc = describeRecurrence(recurrence);
      const currentInstance = currentInstanceByTemplate.get(t.id);
      if (currentInstance) {
        displayRow = currentInstance;
        instanceId = currentInstance.id;
        scheduleNote = ` · repeats ${recurrenceDesc}`;
      } else {
        const nextYmd = nextOccurrenceYmd(recurrence, t, todayYmd, tz);
        offDayDue = `repeats: ${recurrenceDesc} · next: ${formatYmdShort(nextYmd)}`;
      }
    } else if (t.templateId) {
      isRecurringSeries = true;
      templateId = t.templateId;
      instanceId = t.id;
    }

    totalLogical += 1;
    if (displayRow.status === 'open') openCount += 1;
    if (
      displayRow.status === 'done' &&
      displayRow.completedAt &&
      ymdInTz(displayRow.completedAt, tz) === todayYmd
    ) {
      doneTodayCount += 1;
    }

    if (truncated) continue;
    if (shown >= MAX_ROWS) {
      truncated = true;
      continue;
    }

    const alias = `T${shown + 1}`;
    const overdue =
      !offDayDue && displayRow.status === 'open' && !!displayRow.dueAt && isOverdue(displayRow.dueAt, tz);
    const due =
      offDayDue ??
      (displayRow.dueAt
        ? overdue
          ? `overdue since ${shortDateTime(displayRow.dueAt, tz)}`
          : `due ${shortDateTime(displayRow.dueAt, tz)}`
        : 'no due date');

    const line = `[${alias}] "${displayRow.title}" · ${progressLabel(displayRow.type, (displayRow.config ?? {}) as Record<string, unknown>, alias, refs, displayRow.id)} · ${due}${scheduleNote} · ${displayRow.status}`;

    if (charCount + line.length > MAX_CHARS) {
      truncated = true;
      continue;
    }

    refs.set(alias, { kind: 'task', taskId: displayRow.id, isRecurringSeries, instanceId, templateId });
    lines.push(line);
    charCount += line.length;
    shown += 1;
  }

  if (totalLogical > shown) lines.push(`…and ${totalLogical - shown} more.`);

  return {
    text: lines.join('\n'),
    refs,
    counts: { open: openCount, doneToday: doneTodayCount },
  };
}
