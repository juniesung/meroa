import { and, eq, gte, isNull } from 'drizzle-orm';

import { db } from '../../db/client.ts';
import { tasks } from '../../db/schema.ts';
import { ymdInTz, weekStartYmd } from '../tasks/recurrence.ts';

// weekStartYmd moved to lib/tasks/recurrence.ts (beside the other ymd-string
// helpers) once lib/goals/consistency.ts needed it too. Re-exported here so
// this module's existing importers — and its test — keep their path.
export { weekStartYmd };

// Phase 5's history-aware replies ("that's your 4th workout this week"). The
// count is *always* computed here, server-side, from real instance rows — the
// model never counts its own completions (docs/ai-reliability-hardening.md
// lesson 6/16: every number in a reply is quoted from a tool result, never
// derived by the model). Same pure-decide / query-in-the-caller split as
// lib/goals/consistency.ts.

// --- pure computation (no I/O — testable in isolation) --------------------

export function isSameWeek(aYmd: string, bYmd: string): boolean {
  return weekStartYmd(aYmd) === weekStartYmd(bYmd);
}

export function isSameMonth(aYmd: string, bYmd: string): boolean {
  return aYmd.slice(0, 7) === bYmd.slice(0, 7);
}

export type CompletionHistory = { countThisWeek: number; countThisMonth: number };

function ordinal(n: number): string {
  // 11/12/13 are the trap — they take "th" despite ending in 1/2/3.
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/**
 * The one clause appended to a completion's summary, or null when there's
 * nothing interesting to say. Never states a count of 1 — "that's your 1st
 * workout this week" is noise, and silence is the default, not a filler
 * sentence. Never states a streak: habit goals already do that via
 * goalImpactSuffix, and two competing counts in one sentence reads like a
 * dashboard, not a friend. The month count only rides along when it actually
 * adds something the week count didn't.
 */
export function describeCompletionHistory(h: CompletionHistory): string | null {
  if (h.countThisWeek < 2) return null;
  const week = `That's your ${ordinal(h.countThisWeek)} time this week`;
  return h.countThisMonth > h.countThisWeek
    ? `${week} (${ordinal(h.countThisMonth)} this month).`
    : `${week}.`;
}

/**
 * The template id whose instances make up this task's history, or null when
 * there's no history to count. A one-off task is a single event — "that's your
 * 3rd time this week" is meaningless for something that happens once — so only
 * a recurring series qualifies: either a dated instance (`templateId` set) or
 * the template row itself. Pure, so the recurring-vs-not decision is testable
 * without a database.
 */
export function seriesIdForHistory(task: {
  id: string;
  templateId: string | null;
  recurrence: unknown;
}): string | null {
  if (task.templateId) return task.templateId;
  return task.recurrence ? task.id : null;
}

// --- I/O-backed entry point -----------------------------------------------

/**
 * How many days of this recurring series the user has completed this week and
 * this month, in the account's timezone. Counts by `occurrenceDate` (the day
 * the instance was due), not by `records.occurredAt` — "4th workout this week"
 * means four workout *days*, not four taps, and the partial unique index on
 * (template_id, occurrence_date) guarantees one instance row per day. Returns
 * null for a one-off task.
 */
export async function buildTaskCompletionHistory(
  userId: string,
  timezone: string | null,
  task: { id: string; templateId: string | null; recurrence: unknown },
): Promise<CompletionHistory | null> {
  const seriesId = seriesIdForHistory(task);
  if (!seriesId) return null;

  const tz = timezone ?? 'UTC';
  const todayYmd = ymdInTz(new Date(), tz);
  const weekStart = weekStartYmd(todayYmd);
  const monthStart = `${todayYmd.slice(0, 7)}-01`;
  // A week straddling a month boundary (today is the 2nd, the week began in
  // the previous month) starts earlier than the month does — fetch from
  // whichever comes first so neither count loses rows to the other's window.
  const from = weekStart < monthStart ? weekStart : monthStart;

  const rows = await db
    .select({ occurrenceDate: tasks.occurrenceDate })
    .from(tasks)
    .where(
      and(
        eq(tasks.userId, userId),
        eq(tasks.templateId, seriesId),
        eq(tasks.status, 'done'),
        isNull(tasks.deletedAt),
        gte(tasks.occurrenceDate, from),
      ),
    );

  let countThisWeek = 0;
  let countThisMonth = 0;
  for (const row of rows) {
    if (!row.occurrenceDate) continue;
    if (isSameWeek(row.occurrenceDate, todayYmd)) countThisWeek += 1;
    if (isSameMonth(row.occurrenceDate, todayYmd)) countThisMonth += 1;
  }
  return { countThisWeek, countThisMonth };
}
