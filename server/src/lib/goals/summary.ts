import { and, desc, eq, inArray, isNull } from 'drizzle-orm';

import { db } from '../../db/client.ts';
import { records, goalEntries } from '../../db/schema.ts';
import { daysBetweenYmd, formatYmdShort, ymdInTz } from '../tasks/recurrence.ts';
import { buildGoalScopedStreaks, type GoalStreak } from './consistency.ts';
import type { GoalRow } from './executor.ts';
import type { GoalDefinition, GoalEntryData, IndirectGoalDefinition, SavingsGoalDefinition } from './schema.ts';

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

/**
 * Progress fraction for an indirect goal, generalized to both directions
 * (rising toward a target, like a bench PR, or falling toward one, like a
 * weight-loss goal) — `start` is the first-ever logged value, never a
 * stored field (docs/goals-redesign-plan.md §1.3: no direction/start field,
 * derived from entries). Distinct from computePace above, which assumes a
 * savings goal's total only ever rises toward its target.
 */
export function computeIndirectProgress(
  start: number,
  current: number,
  target: number,
): { fraction: number; reached: boolean } {
  if (target === start) return { fraction: current === target ? 1 : 0, reached: current === target };
  const raw = (current - start) / (target - start);
  const fraction = Math.min(1, Math.max(0, raw));
  const reached = target >= start ? current >= target : current <= target;
  return { fraction, reached };
}

/** Same shape as computePace, direction-aware via `start` — see computeIndirectProgress. */
export function computeIndirectPace(
  start: number,
  current: number,
  target: number,
  deadline: string | undefined,
  tz: string,
  now: Date,
): Pace | null {
  if (!deadline) return null;
  const reached = target >= start ? current >= target : current <= target;
  const remaining = Math.abs(target - current);
  const todayYmd = ymdInTz(now, tz);
  const rawDaysLeft = daysBetweenYmd(todayYmd, deadline);
  const overdue = rawDaysLeft < 0;
  const daysLeft = Math.max(0, rawDaysLeft);
  const perDay = reached ? 0 : remaining / Math.max(1, daysLeft);
  return { perDay, daysLeft, remaining, reached, overdue };
}

/**
 * The indirect card: current value + unit as the headline, a delta-vs-
 * previous-entry sub-line (a down payment on Phase 5's history-aware
 * replies), and a progress fraction/pace line only once a target exists —
 * never a number derived from a linked task (locked decision, §1.3).
 */
export function computeIndirectCardSummary(
  definition: IndirectGoalDefinition,
  entries: LiveEntry[],
  tz: string,
  now: Date,
): GoalCardSummary {
  if (entries.length === 0) {
    return {
      headline: `No ${definition.unit} logged yet`,
      sub: 'Log a measurement to start tracking',
      progress: null,
      paceLine: null,
      streak: null,
    };
  }

  const sortedAsc = [...entries].sort((a, b) => a.entryAt.getTime() - b.entryAt.getTime());
  const start = sortedAsc[0]!.data.amount;
  const current = sortedAsc[sortedAsc.length - 1]!.data.amount;
  const previous = sortedAsc.length > 1 ? sortedAsc[sortedAsc.length - 2]!.data.amount : null;

  const headline = `${formatNumber(current)}${definition.unit}`;
  const sub =
    previous === null
      ? 'First log'
      : current === previous
        ? 'unchanged since last log'
        : `${current > previous ? 'up' : 'down'} ${formatNumber(Math.abs(current - previous))}${definition.unit} since last log`;

  let progress: number | null = null;
  let paceLine: string | null = null;
  if (definition.targetValue !== undefined) {
    const { fraction, reached } = computeIndirectProgress(start, current, definition.targetValue);
    progress = fraction;
    const pace = computeIndirectPace(start, current, definition.targetValue, definition.deadline, tz, now);
    if (pace) {
      if (pace.reached) {
        paceLine = 'Target reached';
      } else if (pace.overdue) {
        paceLine = `${formatNumber(pace.remaining)}${definition.unit} to go — past the ${formatYmdShort(definition.deadline!)} deadline`;
      } else {
        paceLine = `needs ${formatNumber(pace.perDay)}${definition.unit}/day to hit ${formatYmdShort(definition.deadline!)}`;
      }
    } else if (reached) {
      paceLine = 'Target reached';
    }
  }

  return { headline, sub, progress, paceLine, streak: null };
}

// --- I/O-backed entry points ---------------------------------------------

// Discriminated by `type` — the savings/indirect fields are null on a habit
// detail and vice versa, so the client branches on one field instead of
// guessing from which numbers happen to be present.
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
  // Indirect only — null on every other type.
  unit: string | null;
  currentValue: number | null;
  startValue: number | null;
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
      unit: null,
      currentValue: null,
      startValue: null,
    };
  }

  if (definition.type === 'indirect') {
    const entries = await fetchLiveEntries(goal.id);
    const sortedAsc = [...entries].sort((a, b) => a.entryAt.getTime() - b.entryAt.getTime());
    const startValue = sortedAsc.length ? sortedAsc[0]!.data.amount : null;
    const currentValue = sortedAsc.length ? sortedAsc[sortedAsc.length - 1]!.data.amount : null;
    return {
      type: 'indirect',
      card: computeIndirectCardSummary(definition, entries, tz, now),
      total: null,
      targetValue: definition.targetValue ?? null,
      currency: null,
      deadline: definition.deadline ?? null,
      streak: null,
      entryCount: entries.length,
      lastEntryAt: entries[0]?.entryAt.toISOString() ?? null,
      unit: definition.unit,
      currentValue,
      startValue,
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
    unit: null,
    currentValue: null,
    startValue: null,
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
  const indirectGoals = goalRows.filter((g) => (g.definition as GoalDefinition).type === 'indirect');

  const [entriesByGoal, streaksByGoal] = await Promise.all([
    fetchLiveEntriesForGoals([...savingsGoals, ...indirectGoals].map((g) => g.id)),
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
  for (const goal of indirectGoals) {
    const entries = entriesByGoal.get(goal.id) ?? [];
    const card = computeIndirectCardSummary(goal.definition as IndirectGoalDefinition, entries, tz, now);
    result.set(goal.id, { ...card, entryCount: entries.length, lastEntryAt: entries[0]?.entryAt ?? null });
  }
  return result;
}
