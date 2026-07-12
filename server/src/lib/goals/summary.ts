import { and, desc, eq, inArray, isNull } from 'drizzle-orm';

import { db } from '../../db/client.ts';
import { records, goalEntries } from '../../db/schema.ts';
import { daysBetweenYmd, formatYmdShort, ymdInTz } from '../tasks/recurrence.ts';
import { buildGoalScopedStreaks, type GoalStreak } from './consistency.ts';
import type { GoalRow } from './executor.ts';
import type { GoalDefinition, GoalEntryData, SavingsGoalDefinition } from './schema.ts';

// All total/pace math lives here, computed once server-side in the
// account's own timezone — the model and the client both only ever render
// what this returns (docs/ai-reliability-hardening.md lesson 6: never make
// either side do the arithmetic itself).
export type LiveEntry = { entryAt: Date; data: GoalEntryData };

function formatNumber(n: number): string {
  return Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

// --- fetch (live entries = goal_entries whose backing record was never
// undone; summary.ts is the only place that reads entries for display, so
// this filter is the single source of truth for "still counts") ----------

async function fetchLiveEntries(goalId: string): Promise<LiveEntry[]> {
  const rows = await db
    .select({ entryAt: goalEntries.entryAt, data: goalEntries.data })
    .from(goalEntries)
    .innerJoin(records, eq(goalEntries.recordId, records.id))
    .where(and(eq(goalEntries.goalId, goalId), isNull(records.revertedAt)))
    .orderBy(desc(goalEntries.entryAt));
  return rows.map((r) => ({ entryAt: r.entryAt, data: r.data as GoalEntryData }));
}

// Batched form for the goals list — one query for every goal's entries
// instead of one query per goal (the N+1 the old GET /tools list had).
async function fetchLiveEntriesForGoals(goalIds: string[]): Promise<Map<string, LiveEntry[]>> {
  const byGoal = new Map<string, LiveEntry[]>();
  if (goalIds.length === 0) return byGoal;
  const rows = await db
    .select({ goalId: goalEntries.goalId, entryAt: goalEntries.entryAt, data: goalEntries.data })
    .from(goalEntries)
    .innerJoin(records, eq(goalEntries.recordId, records.id))
    .where(and(inArray(goalEntries.goalId, goalIds), isNull(records.revertedAt)))
    .orderBy(desc(goalEntries.entryAt));
  for (const r of rows) {
    const list = byGoal.get(r.goalId) ?? [];
    list.push({ entryAt: r.entryAt, data: r.data as GoalEntryData });
    byGoal.set(r.goalId, list);
  }
  return byGoal;
}

// --- pure computation (no I/O — testable in isolation) ------------------

export function computeTotal(entries: LiveEntry[]): number {
  return entries.reduce((sum, e) => sum + e.data.amount, 0);
}

export type Pace = {
  perDay: number;
  daysLeft: number;
  remaining: number;
  reached: boolean;
  overdue: boolean;
};

/**
 * Money needed per day to hit `targetValue` by `deadline` — the "$5.2/day to
 * hit Dec 15" line on a goal card (docs/goals-redesign-plan.md §2.5). Null
 * when there's no deadline to pace against. `daysLeft` floors at 0 rather
 * than going negative once the deadline has passed — `overdue` carries that
 * fact separately so the caller can phrase it honestly instead of showing a
 * nonsensical negative pace.
 */
export function computePace(
  targetValue: number,
  total: number,
  deadline: string | undefined,
  tz: string,
  now: Date,
): Pace | null {
  if (!deadline) return null;
  const remaining = Math.max(0, targetValue - total);
  const reached = remaining <= 0;
  const todayYmd = ymdInTz(now, tz);
  const rawDaysLeft = daysBetweenYmd(todayYmd, deadline);
  const overdue = rawDaysLeft < 0;
  const daysLeft = Math.max(0, rawDaysLeft);
  const perDay = reached ? 0 : remaining / Math.max(1, daysLeft);
  return { perDay, daysLeft, remaining, reached, overdue };
}

export type GoalCardSummary = {
  headline: string;
  sub: string;
  progress: number | null;
  paceLine: string | null;
  // Habit goals only — the card's whole mechanic (docs/goals-redesign-
  // plan.md §1). Null for savings.
  streak: GoalStreak | null;
};

export function computeCardSummary(
  definition: SavingsGoalDefinition,
  entries: LiveEntry[],
  tz: string,
  now: Date,
): GoalCardSummary {
  const total = computeTotal(entries);
  const unit = definition.currency;
  const progress = Math.min(1, Math.max(0, total / definition.targetValue));
  const pace = computePace(definition.targetValue, total, definition.deadline, tz, now);

  const headline = `${unit}${formatNumber(total)} / ${unit}${formatNumber(definition.targetValue)}`;
  const entryCount = entries.length;
  const sub = entryCount === 0 ? 'No entries yet' : `${entryCount} ${entryCount === 1 ? 'entry' : 'entries'} logged`;

  let paceLine: string | null = null;
  if (pace) {
    if (pace.reached) {
      paceLine = 'Target reached';
    } else if (pace.overdue) {
      paceLine = `${unit}${formatNumber(pace.remaining)} to go — past the ${formatYmdShort(definition.deadline!)} deadline`;
    } else {
      paceLine = `needs ${unit}${formatNumber(pace.perDay)}/day to hit ${formatYmdShort(definition.deadline!)}`;
    }
  }

  return { headline, sub, progress, paceLine, streak: null };
}

/**
 * The habit card: the streak IS the headline — no progress fraction, no
 * pace, never a number derived from anything but real completed check-ins.
 * `longest` is always shown next to the current run (docs/goals-redesign-
 * plan.md §1: breaks are real, the reset is mechanical, the copy stays
 * matter-of-fact).
 */
export function computeHabitCardSummary(streak: GoalStreak): GoalCardSummary {
  const headline = streak.current > 0 ? `${streak.current}-day streak` : 'No streak yet';
  const sub =
    streak.doneCount === 0
      ? 'First check-in starts it'
      : `longest ${streak.longest} · ${streak.doneCount} check-in${streak.doneCount === 1 ? '' : 's'}`;
  return { headline, sub, progress: null, paceLine: null, streak };
}

// --- I/O-backed entry points ---------------------------------------------

// Discriminated by `type` — the savings fields are null on a habit detail
// and vice versa, so the client branches on one field instead of guessing
// from which numbers happen to be present.
export type GoalDetail = {
  type: GoalDefinition['type'];
  card: GoalCardSummary;
  total: number | null;
  targetValue: number | null;
  currency: string | null;
  deadline: string | null;
  streak: GoalStreak | null;
  entryCount: number;
  lastEntryAt: string | null;
};

export async function buildGoalDetail(goal: GoalRow, timezone: string | null): Promise<GoalDetail> {
  const tz = timezone ?? 'UTC';
  const now = new Date();
  const definition = goal.definition as GoalDefinition;

  if (definition.type === 'habit') {
    const streaks = await buildGoalScopedStreaks(goal.userId, timezone, [goal.id]);
    const streak = streaks.get(goal.id) ?? { current: 0, longest: 0, doneCount: 0 };
    return {
      type: 'habit',
      card: computeHabitCardSummary(streak),
      total: null,
      targetValue: null,
      currency: null,
      deadline: null,
      streak,
      entryCount: 0,
      lastEntryAt: null,
    };
  }

  const entries = await fetchLiveEntries(goal.id);
  const total = computeTotal(entries);

  return {
    type: 'savings',
    card: computeCardSummary(definition, entries, tz, now),
    total,
    targetValue: definition.targetValue,
    currency: definition.currency,
    deadline: definition.deadline ?? null,
    streak: null,
    entryCount: entries.length,
    lastEntryAt: entries[0]?.entryAt.toISOString() ?? null,
  };
}

/** Batched card summaries for the goals list — one query per data source, not one per goal. */
export async function buildGoalCardSummaries(
  goalRows: GoalRow[],
  timezone: string | null,
): Promise<Map<string, GoalCardSummary & { entryCount: number; lastEntryAt: Date | null }>> {
  const tz = timezone ?? 'UTC';
  const now = new Date();
  const savingsGoals = goalRows.filter((g) => (g.definition as GoalDefinition).type === 'savings');
  const habitGoals = goalRows.filter((g) => (g.definition as GoalDefinition).type === 'habit');

  const [entriesByGoal, streaksByGoal] = await Promise.all([
    fetchLiveEntriesForGoals(savingsGoals.map((g) => g.id)),
    buildGoalScopedStreaks(goalRows[0]?.userId ?? '', timezone, habitGoals.map((g) => g.id)),
  ]);

  const result = new Map<string, GoalCardSummary & { entryCount: number; lastEntryAt: Date | null }>();
  for (const goal of savingsGoals) {
    const entries = entriesByGoal.get(goal.id) ?? [];
    const card = computeCardSummary(goal.definition as SavingsGoalDefinition, entries, tz, now);
    result.set(goal.id, { ...card, entryCount: entries.length, lastEntryAt: entries[0]?.entryAt ?? null });
  }
  for (const goal of habitGoals) {
    const streak = streaksByGoal.get(goal.id) ?? { current: 0, longest: 0, doneCount: 0 };
    const card = computeHabitCardSummary(streak);
    result.set(goal.id, { ...card, entryCount: 0, lastEntryAt: null });
  }
  return result;
}
