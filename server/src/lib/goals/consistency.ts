import { and, eq, isNull } from 'drizzle-orm';

import { db } from '../../db/client.ts';
import { tasks } from '../../db/schema.ts';
import { addDaysToYmd, ymdInTz } from '../tasks/recurrence.ts';

// All day-verdict/streak/calendar math lives here, computed once
// server-side in the account's own timezone — the client only ever renders
// what this returns, never re-buckets (docs/goals-redesign-plan.md §2.4,
// lesson 12: keep date-bucketing timezone-consistent between client and
// server by doing it in exactly one place).

export type DayVerdict = 'perfect' | 'missed' | 'neutral';

export type DayBucket = {
  ymd: string;
  dueCount: number;
  doneCount: number;
  verdict: DayVerdict;
  // Heatmap cell intensity — a finer-grained *display* signal than verdict
  // (which only has 3 states for streak purposes). 0: nothing due, or due
  // but nothing done (reads as an empty cell either way — a day with zero
  // completions has nothing to show, whether or not something was due).
  // 1: partially done. 2: mostly done. 3: perfect.
  level: 0 | 1 | 2 | 3;
};

export type TaskDueRow = { dueYmd: string; status: string };

// --- pure computation (no I/O — testable in isolation) --------------------

function levelFor(dueCount: number, doneCount: number): DayBucket['level'] {
  if (dueCount === 0 || doneCount === 0) return 0;
  const ratio = doneCount / dueCount;
  if (ratio >= 1) return 3;
  if (ratio >= 0.5) return 2;
  return 1;
}

function verdictFor(dueCount: number, doneCount: number): DayVerdict {
  if (dueCount === 0) return 'neutral';
  return doneCount === dueCount ? 'perfect' : 'missed';
}

/**
 * Groups already-tz-resolved due rows into one bucket per calendar day —
 * a day with ≥1 task due and all of them done is `perfect`; ≥1 due with any
 * open is `missed`; zero due is `neutral` (a rest day, not a failure —
 * doesn't break or extend a streak). Postponing a task off today already
 * removes it from today's denominator by construction: this only ever sees
 * each task's *current* dueAt, never a historical one
 * (docs/goals-redesign-plan.md §2.4).
 */
export function bucketTasksByDay(rows: TaskDueRow[]): Map<string, DayBucket> {
  const counts = new Map<string, { due: number; done: number }>();
  for (const row of rows) {
    const entry = counts.get(row.dueYmd) ?? { due: 0, done: 0 };
    entry.due += 1;
    if (row.status === 'done') entry.done += 1;
    counts.set(row.dueYmd, entry);
  }
  const buckets = new Map<string, DayBucket>();
  for (const [ymd, { due, done }] of counts) {
    buckets.set(ymd, { ymd, dueCount: due, doneCount: done, verdict: verdictFor(due, done), level: levelFor(due, done) });
  }
  return buckets;
}

function bucketOrNeutral(buckets: Map<string, DayBucket>, ymd: string): DayBucket {
  return buckets.get(ymd) ?? { ymd, dueCount: 0, doneCount: 0, verdict: 'neutral', level: 0 };
}

/**
 * Consecutive perfect days counting back from today, skipping neutral days
 * (they neither break nor extend), stopping at the first missed day. Today
 * itself is never evaluated as a potential break — if it isn't perfect yet
 * (tasks still open, day not over), counting starts from yesterday instead,
 * the same grace lib/goals/summary.ts's goal-entry streak already uses.
 */
export function computeCurrentStreak(buckets: Map<string, DayBucket>, todayYmd: string): number {
  const todayVerdict = bucketOrNeutral(buckets, todayYmd).verdict;
  let cursor = todayVerdict === 'perfect' ? todayYmd : addDaysToYmd(todayYmd, -1);
  let streak = 0;
  // 10 years is far more than any real calendar payload spans — a hard
  // backstop against an infinite loop, not a meaningful business limit.
  for (let i = 0; i < 3650; i++) {
    const verdict = bucketOrNeutral(buckets, cursor).verdict;
    if (verdict === 'missed') break;
    if (verdict === 'perfect') streak += 1;
    cursor = addDaysToYmd(cursor, -1);
  }
  return streak;
}

/**
 * Longest run of consecutive perfect days anywhere in `buckets` (skipping
 * neutral days the same way), scanned oldest-to-newest so a currently
 * in-progress streak counts too if it's already the longest.
 */
export function computeLongestStreak(buckets: Map<string, DayBucket>): number {
  const ymds = [...buckets.keys()].sort();
  let longest = 0;
  let current = 0;
  for (const ymd of ymds) {
    const verdict = buckets.get(ymd)!.verdict;
    if (verdict === 'perfect') {
      current += 1;
      longest = Math.max(longest, current);
    } else if (verdict === 'missed') {
      current = 0;
    }
    // neutral: current carries through unchanged.
  }
  return longest;
}

/**
 * From the 1st of the month `monthsBack` months before today's month,
 * through today, oldest first — whole months so the client's month-paged
 * calendar view (components/Heatmap.tsx) always has complete months to
 * page through; the current month simply ends at today (future days are
 * client-side placeholders, no data to bucket). Client renders, never
 * re-buckets.
 */
export function buildCalendar(buckets: Map<string, DayBucket>, todayYmd: string, monthsBack = 2): DayBucket[] {
  const [year, month] = todayYmd.split('-').map(Number) as [number, number];
  let startYear = year;
  let startMonth = month - monthsBack;
  while (startMonth < 1) {
    startMonth += 12;
    startYear -= 1;
  }
  const calendar: DayBucket[] = [];
  let cursor = `${startYear}-${String(startMonth).padStart(2, '0')}-01`;
  while (cursor <= todayYmd) {
    calendar.push(bucketOrNeutral(buckets, cursor));
    cursor = addDaysToYmd(cursor, 1);
  }
  return calendar;
}

// --- I/O-backed entry point -----------------------------------------------

export type GoalConsistency = {
  current: number;
  longest: number;
  calendar: DayBucket[];
};

/**
 * `taskIdFilter`, when given, scopes every bit of this to just those task
 * ids — the same day-verdict/streak machinery a future habit-goal type
 * reuses scoped to its own linked daily task (docs/goals-redesign-plan.md
 * §2.7); omitted, it's the tab-level consistency across every task.
 */
export async function buildGoalConsistency(
  userId: string,
  timezone: string | null,
  taskIdFilter?: string[],
): Promise<GoalConsistency> {
  const tz = timezone ?? 'UTC';

  const rows = await db
    .select({ dueAt: tasks.dueAt, status: tasks.status, id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.userId, userId), isNull(tasks.deletedAt), isNull(tasks.recurrence)));

  const filtered = taskIdFilter ? rows.filter((r) => taskIdFilter.includes(r.id)) : rows;
  const dueRows: TaskDueRow[] = filtered
    .filter((r) => r.dueAt !== null)
    .map((r) => ({ dueYmd: ymdInTz(r.dueAt!, tz), status: r.status }));

  const buckets = bucketTasksByDay(dueRows);
  const todayYmd = ymdInTz(new Date(), tz);

  return {
    current: computeCurrentStreak(buckets, todayYmd),
    longest: computeLongestStreak(buckets),
    calendar: buildCalendar(buckets, todayYmd),
  };
}
