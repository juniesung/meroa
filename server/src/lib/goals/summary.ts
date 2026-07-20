import { and, desc, eq, inArray, isNull } from 'drizzle-orm';

import { db } from '../../db/client.ts';
import { records, goalEntries } from '../../db/schema.ts';
import { daysBetweenYmd, formatYmdShort, ymdInTz } from '../tasks/recurrence.ts';
import { buildGoalScopedStreaks, type GoalStreak } from './consistency.ts';
import type { GoalRow } from './executor.ts';
import type {
  GoalDefinition,
  GoalEntryData,
  IndirectGoalDefinition,
  MilestoneGoalDefinition,
  SavingsGoalDefinition,
} from './schema.ts';

// All total/pace math lives here, computed once server-side in the
// account's own timezone — the model and the client both only ever render
// what this returns (docs/ai-reliability-hardening.md lesson 6: never make
// either side do the arithmetic itself).
export type LiveEntry = { entryAt: Date; data: GoalEntryData };

function formatNumber(n: number): string {
  return Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

// Money always shows two decimals once it has any fraction at all — an
// integer dollar amount still reads as "$5" (no forced ".00"), but a
// fractional one always pads to cents ("$0.50", never the observed "$0.5")
// so a currency value never looks like it's missing a digit. Reused
// everywhere else a currency amount renders (lib/ai/actions.ts,
// lib/ai/goal-context.ts, lib/ai/pending-preview.ts) so the app never shows
// two different renderings of the same amount.
export function formatMoney(n: number): string {
  return Number.isInteger(n)
    ? n.toLocaleString()
    : n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
 * Has the user's own historical rate kept up with the rate the deadline now
 * demands? `null` when there isn't enough elapsed history to judge (a goal
 * started today), which reads as "no verdict yet" rather than a misleading
 * "behind" on day zero.
 *
 * The comparison is deliberately self-correcting: `requiredPerDay` is
 * recomputed from what's *still* remaining over the days *still* left, so
 * falling behind raises the bar and the verdict flips honestly on its own.
 */
export function computeOnTrack(actualPerDay: number, requiredPerDay: number): boolean {
  return actualPerDay >= requiredPerDay;
}

/**
 * Elapsed whole days between a start date and now, in the account's tz —
 * the denominator of every "actual rate so far" figure below. Returns null
 * under a full day, which is what makes the on-track verdict abstain instead
 * of dividing by ~0 and reporting a wild rate.
 */
function elapsedDaysSince(start: Date, tz: string, now: Date): number | null {
  const days = daysBetweenYmd(ymdInTz(start, tz), ymdInTz(now, tz));
  return days >= 1 ? days : null;
}

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
  // Is the actual rate so far keeping up with what the deadline demands?
  // Null when there's no deadline to pace against, or too little history to
  // judge. Carried as its own field *as well as* being baked into paceLine's
  // text so the client can style the line without parsing prose — the model
  // only ever quotes paceLine (docs/chat-architecture.md §9: it never
  // computes a figure, and must not derive this verdict either).
  onTrack: boolean | null;
};

export function computeCardSummary(
  definition: SavingsGoalDefinition,
  entries: LiveEntry[],
  tz: string,
  now: Date,
  createdAt: Date,
): GoalCardSummary {
  const total = computeTotal(entries);
  const unit = definition.currency;
  const progress = Math.min(1, Math.max(0, total / definition.targetValue));
  const pace = computePace(definition.targetValue, total, definition.deadline, tz, now);

  const headline = `${unit}${formatMoney(total)} / ${unit}${formatMoney(definition.targetValue)}`;
  const entryCount = entries.length;
  const sub = entryCount === 0 ? 'No entries yet' : `${entryCount} ${entryCount === 1 ? 'entry' : 'entries'} logged`;

  // Savings paces from the goal's own creation, not its first entry: `total`
  // sums every entry ever logged, so the window it accumulated over is the
  // goal's whole lifetime. Starting the clock at the first entry instead
  // would divide a total that *includes* that entry by a window that
  // excludes the time before it, inflating the rate — and an untouched goal
  // would look paceless rather than behind. (Indirect measures a delta from
  // its first reading, so it starts there instead — see
  // computeIndirectCardSummary.)
  const elapsedDays = elapsedDaysSince(createdAt, tz, now);
  const onTrack =
    pace && !pace.reached && !pace.overdue && elapsedDays !== null
      ? computeOnTrack(total / elapsedDays, pace.perDay)
      : null;

  let paceLine: string | null = null;
  if (pace) {
    if (pace.reached) {
      paceLine = 'Target reached';
    } else if (pace.overdue) {
      // Already past the deadline — "behind" is self-evident and stacking a
      // second verdict on top just piles on.
      paceLine = `${unit}${formatMoney(pace.remaining)} to go — past the ${formatYmdShort(definition.deadline!)} deadline`;
    } else {
      paceLine = `needs ${unit}${formatMoney(pace.perDay)}/day to hit ${formatYmdShort(definition.deadline!)}${paceVerdictSuffix(onTrack)}`;
    }
  }

  return { headline, sub, progress, paceLine, streak: null, onTrack };
}

/**
 * Appended to an active pace line, never a standalone sentence — the verdict
 * has to travel *with* the numbers it's about, because the model quotes
 * paceLine verbatim and would otherwise have to pair the two itself.
 * Deliberately plain: "behind pace" is a fact, not a scolding
 * (docs/goals-redesign-plan.md §2.5 — the mechanics are real, the copy stays
 * matter-of-fact).
 */
function paceVerdictSuffix(onTrack: boolean | null): string {
  if (onTrack === null) return '';
  return onTrack ? ' — on track' : ' — behind pace';
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
  return { headline, sub, progress: null, paceLine: null, streak, onTrack: null };
}

/**
 * The milestone card: no numbers anywhere (docs/milestone-goal-plan.md §0)
 * — the headline IS the active stage's title, progress is
 * activeStageIndex / stages.length, legitimate because every advance was a
 * user-declared tap on the advance_goal_stage confirm card, never inferred
 * from a task completion. Pure — no I/O, unlike computeCardSummary/
 * computeIndirectCardSummary, since a milestone goal has no entries to fetch.
 */
export function computeMilestoneCardSummary(definition: MilestoneGoalDefinition): GoalCardSummary {
  const total = definition.stages.length;
  // A bare template (0 stages, docs/goal-manual-editing-plan.md §1 decision
  // 1) is its own case — `activeStageIndex(0) >= total(0)` is trivially true
  // the same way a genuinely finished goal is, and without this branch it
  // read as "Complete — all 0 stages" for a goal that hasn't even started.
  if (total === 0) {
    return { headline: 'No stages yet', sub: 'add them in Goals', progress: 0, paceLine: null, streak: null, onTrack: null };
  }
  const done = definition.activeStageIndex >= total;
  const headline = done ? `Complete — all ${total} stages` : (definition.stages[definition.activeStageIndex] ?? '');
  const sub = done ? `${total} stage${total === 1 ? '' : 's'} done` : `stage ${definition.activeStageIndex + 1} of ${total}`;
  const progress = Math.min(1, definition.activeStageIndex / total);
  return { headline, sub, progress, paceLine: null, streak: null, onTrack: null };
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
      onTrack: null,
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
  let onTrack: boolean | null = null;
  if (definition.targetValue !== undefined) {
    const { fraction, reached } = computeIndirectProgress(start, current, definition.targetValue);
    progress = fraction;
    const pace = computeIndirectPace(start, current, definition.targetValue, definition.deadline, tz, now);
    if (pace) {
      // Unlike savings, the clock starts at the FIRST READING, not the goal's
      // creation: `start` is that reading, and the movement being paced is
      // `current - start`. Numerator and denominator have to span the same
      // window or the rate is meaningless. Direction-agnostic via abs() —
      // this works the same whether the number is climbing toward a bench PR
      // or falling toward a weight target (docs/goals-redesign-plan.md §1.3).
      const elapsedDays = elapsedDaysSince(sortedAsc[0]!.entryAt, tz, now);
      onTrack =
        !pace.reached && !pace.overdue && elapsedDays !== null
          ? computeOnTrack(Math.abs(current - start) / elapsedDays, pace.perDay)
          : null;

      if (pace.reached) {
        paceLine = 'Target reached';
      } else if (pace.overdue) {
        paceLine = `${formatNumber(pace.remaining)}${definition.unit} to go — past the ${formatYmdShort(definition.deadline!)} deadline`;
      } else {
        paceLine = `needs ${formatNumber(pace.perDay)}${definition.unit}/day to hit ${formatYmdShort(definition.deadline!)}${paceVerdictSuffix(onTrack)}`;
      }
    } else if (reached) {
      paceLine = 'Target reached';
    }
  }

  return { headline, sub, progress, paceLine, streak: null, onTrack };
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
  // Milestone only — null on every other type.
  stages: string[] | null;
  activeStageIndex: number | null;
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
      stages: null,
      activeStageIndex: null,
    };
  }

  if (definition.type === 'milestone') {
    return {
      type: 'milestone',
      card: computeMilestoneCardSummary(definition),
      total: null,
      targetValue: null,
      currency: null,
      deadline: null,
      streak: null,
      entryCount: 0,
      lastEntryAt: null,
      unit: null,
      currentValue: null,
      startValue: null,
      stages: definition.stages,
      activeStageIndex: definition.activeStageIndex,
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
      stages: null,
      activeStageIndex: null,
    };
  }

  const entries = await fetchLiveEntries(goal.id);
  const total = computeTotal(entries);

  return {
    type: 'savings',
    card: computeCardSummary(definition, entries, tz, now, goal.createdAt),
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
    stages: null,
    activeStageIndex: null,
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
  const milestoneGoals = goalRows.filter((g) => (g.definition as GoalDefinition).type === 'milestone');

  const [entriesByGoal, streaksByGoal] = await Promise.all([
    fetchLiveEntriesForGoals([...savingsGoals, ...indirectGoals].map((g) => g.id)),
    buildGoalScopedStreaks(goalRows[0]?.userId ?? '', timezone, habitGoals.map((g) => g.id)),
  ]);

  const result = new Map<string, GoalCardSummary & { entryCount: number; lastEntryAt: Date | null }>();
  for (const goal of savingsGoals) {
    const entries = entriesByGoal.get(goal.id) ?? [];
    const card = computeCardSummary(goal.definition as SavingsGoalDefinition, entries, tz, now, goal.createdAt);
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
  for (const goal of milestoneGoals) {
    const card = computeMilestoneCardSummary(goal.definition as MilestoneGoalDefinition);
    result.set(goal.id, { ...card, entryCount: 0, lastEntryAt: null });
  }
  return result;
}
