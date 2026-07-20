import { and, eq, inArray, isNull } from 'drizzle-orm';

import { db } from '../../db/client.ts';
import { tasks } from '../../db/schema.ts';
import { addDaysToYmd, weekStartYmd, ymdInTz } from '../tasks/recurrence.ts';

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
  // This day was genuinely missed, but the week's one grace covered it, so
  // it doesn't break the streak (see applyWeeklyGrace). Deliberately a
  // decoration on top of `verdict` rather than a fourth verdict value:
  // the day really WAS missed, and bucketTasksByDay stays honest about that.
  // The calendar shows it distinctly from both a perfect day and a rest day.
  forgiven: boolean;
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
    buckets.set(ymd, {
      ymd,
      dueCount: due,
      doneCount: done,
      verdict: verdictFor(due, done),
      level: levelFor(due, done),
      // Grace is a separate pass (applyWeeklyGrace) — this function reports
      // what actually happened, nothing more.
      forgiven: false,
    });
  }
  return buckets;
}

function bucketOrNeutral(buckets: Map<string, DayBucket>, ymd: string): DayBucket {
  return buckets.get(ymd) ?? { ymd, dueCount: 0, doneCount: 0, verdict: 'neutral', level: 0, forgiven: false };
}

/**
 * One missed day per calendar week doesn't break the streak.
 *
 * Everyone misses a day. Before this, a single slip reset a 40-day run to
 * zero, which is mechanically true and motivationally brutal — and the app's
 * own rule is that the copy stays warm while the mechanics stay real. So the
 * mechanic itself softens by exactly one day a week: a forgiven miss behaves
 * like a rest day (neither breaks nor extends the run), and the calendar
 * still shows it as a miss, because it was one.
 *
 * Derived fresh on every call from the buckets alone — there is no stored
 * "graces remaining" anywhere, matching how every other figure here is
 * recomputed rather than persisted. Two properties make that safe:
 *
 * - The scan runs oldest-first, so within a week the FIRST miss is the one
 *   forgiven and any later one is a real break. Chronological order is what
 *   makes that deterministic instead of map-iteration-order-dependent.
 * - Today can never consume the week's grace. Today reads as `missed` only
 *   because the day isn't over yet (computeCurrentStreak already exempts it
 *   for that reason). Letting it spend the grace would burn the allowance on
 *   a day that may still end perfect, and leave a genuine miss later that
 *   week unprotected. Once today is genuinely in the past, a later
 *   recomputation judges it like any other day.
 *
 * Monday-start weeks, matching the heatmap's rows and weekStartYmd's other
 * callers.
 */
export function applyWeeklyGrace(
  buckets: Map<string, DayBucket>,
  todayYmd: string,
): Map<string, DayBucket> {
  const graceUsedInWeek = new Set<string>();
  const out = new Map<string, DayBucket>();

  for (const ymd of [...buckets.keys()].sort()) {
    const bucket = buckets.get(ymd)!;
    if (bucket.verdict !== 'missed' || ymd === todayYmd) {
      out.set(ymd, { ...bucket, forgiven: false });
      continue;
    }
    const week = weekStartYmd(ymd);
    const forgiven = !graceUsedInWeek.has(week);
    if (forgiven) graceUsedInWeek.add(week);
    out.set(ymd, { ...bucket, forgiven });
  }
  return out;
}

/** A day only breaks a run if it was missed AND the week's grace didn't cover it. */
function breaksStreak(bucket: DayBucket): boolean {
  return bucket.verdict === 'missed' && !bucket.forgiven;
}

/**
 * Consecutive perfect days counting back from today, skipping neutral days
 * (they neither break nor extend), stopping at the first missed day. Today
 * itself is never evaluated as a potential break — if it isn't perfect yet
 * (tasks still open, day not over), counting starts from yesterday instead,
 * the same grace lib/goals/summary.ts's goal-entry streak already uses.
 *
 * A forgiven miss (applyWeeklyGrace) passes through like a neutral day. Pass
 * un-graced buckets and every miss breaks, which is what the callers that
 * want the strict reading do.
 */
export function computeCurrentStreak(buckets: Map<string, DayBucket>, todayYmd: string): number {
  const todayVerdict = bucketOrNeutral(buckets, todayYmd).verdict;
  let cursor = todayVerdict === 'perfect' ? todayYmd : addDaysToYmd(todayYmd, -1);
  let streak = 0;
  // 10 years is far more than any real calendar payload spans — a hard
  // backstop against an infinite loop, not a meaningful business limit.
  for (let i = 0; i < 3650; i++) {
    const bucket = bucketOrNeutral(buckets, cursor);
    if (breaksStreak(bucket)) break;
    if (bucket.verdict === 'perfect') streak += 1;
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
    const bucket = buckets.get(ymd)!;
    if (bucket.verdict === 'perfect') {
      current += 1;
      longest = Math.max(longest, current);
    } else if (breaksStreak(bucket)) {
      current = 0;
    }
    // neutral, or a miss the week's grace covered: current carries through
    // unchanged — neither extends the run nor ends it.
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

  const todayYmd = ymdInTz(new Date(), tz);
  const buckets = applyWeeklyGrace(bucketTasksByDay(dueRows), todayYmd);

  return {
    current: computeCurrentStreak(buckets, todayYmd),
    longest: computeLongestStreak(buckets),
    calendar: buildCalendar(buckets, todayYmd),
  };
}

export type GoalStreak = { current: number; longest: number; doneCount: number };

/**
 * Per-goal streaks for habit goals, batched — one query over every linked
 * task instance for the given goals, then the same pure day-verdict/streak
 * machinery scoped per goal (docs/goals-redesign-plan.md §2.4's "per-habit
 * goal streak counts that goal's own daily task"). `doneCount` is the total
 * completed check-ins, for the card's sub-line. Goals with no linked task
 * activity yet come back as all-zeroes rather than being omitted.
 */
export async function buildGoalScopedStreaks(
  userId: string,
  timezone: string | null,
  goalIds: string[],
): Promise<Map<string, GoalStreak>> {
  const result = new Map<string, GoalStreak>();
  if (goalIds.length === 0) return result;
  const tz = timezone ?? 'UTC';
  const todayYmd = ymdInTz(new Date(), tz);

  const rows = await db
    .select({ goalId: tasks.goalId, dueAt: tasks.dueAt, status: tasks.status })
    .from(tasks)
    .where(
      and(eq(tasks.userId, userId), isNull(tasks.deletedAt), isNull(tasks.recurrence), inArray(tasks.goalId, goalIds)),
    );

  const byGoal = new Map<string, TaskDueRow[]>();
  for (const row of rows) {
    if (!row.goalId || !row.dueAt) continue;
    const list = byGoal.get(row.goalId) ?? [];
    list.push({ dueYmd: ymdInTz(row.dueAt, tz), status: row.status });
    byGoal.set(row.goalId, list);
  }

  for (const goalId of goalIds) {
    const dueRows = byGoal.get(goalId) ?? [];
    const buckets = applyWeeklyGrace(bucketTasksByDay(dueRows), todayYmd);
    result.set(goalId, {
      current: computeCurrentStreak(buckets, todayYmd),
      longest: computeLongestStreak(buckets),
      doneCount: dueRows.filter((r) => r.status === 'done').length,
    });
  }
  return result;
}
