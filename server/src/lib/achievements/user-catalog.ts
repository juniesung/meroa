import { and, eq, isNull, sql } from 'drizzle-orm';

import { goals, records, tasks } from '../../db/schema.ts';
import { db } from '../../db/client.ts';
import { buildGoalConsistency, buildGoalScopedStreaks, countPerfectDays } from '../goals/consistency.ts';
import { buildGoalCardSummaries } from '../goals/summary.ts';
import type { GoalDefinition } from '../goals/schema.ts';
import type { DbOrTx } from '../usage.ts';
import {
  ACHIEVEMENT_CATALOG,
  consistencyFamily,
  goalProgressFamily,
  goalStreakFamily,
  goalTenureFamily,
  type AchievementFamily,
  type AchievementKey,
} from './catalog.ts';

// --- real counts for the global families (the only numbers a badge reflects) --
// Each maps one global family to a real count, kept as small named queries so
// /profile/overview's stat row reuses the exact numbers the badges are earned
// from — one definition, never two. Moved here (from evaluate.ts) so evaluate
// can import buildUserCatalog without a cycle; re-exported from evaluate.ts for
// back-compat.

export async function countTasksCompleted(executor: DbOrTx, userId: string): Promise<number> {
  // Count task instances currently in `done` status — NOT task_completion
  // records (applyProgress writes one on every toggle and never reverts the
  // prior, so counting records inflates on any check→uncheck→re-check). A
  // recurring task's daily instances are separate rows, so each done day counts
  // once; un-checking flips status back to open, so the count drops honestly.
  const [row] = await executor
    .select({ n: sql<number>`count(*)::int` })
    .from(tasks)
    .where(and(eq(tasks.userId, userId), eq(tasks.status, 'done'), isNull(tasks.deletedAt)));
  return row?.n ?? 0;
}

export async function countGoalsStarted(executor: DbOrTx, userId: string): Promise<number> {
  const [row] = await executor
    .select({ n: sql<number>`count(*)::int` })
    .from(goals)
    .where(eq(goals.userId, userId));
  return row?.n ?? 0;
}

export async function countGoalsFinished(executor: DbOrTx, userId: string): Promise<number> {
  // A milestone goal is finished once its activeStageIndex has advanced past the
  // last stage. Non-milestone goals are never counted (the only unambiguous
  // completion signal in the schema).
  const [row] = await executor
    .select({ n: sql<number>`count(*)::int` })
    .from(goals)
    .where(
      and(
        eq(goals.userId, userId),
        sql`${goals.definition}->>'type' = 'milestone'`,
        sql`coalesce((${goals.definition}->>'activeStageIndex')::int, 0) >= coalesce(jsonb_array_length(${goals.definition}->'stages'), 0)`,
        sql`coalesce(jsonb_array_length(${goals.definition}->'stages'), 0) > 0`,
      ),
    );
  return row?.n ?? 0;
}

// Earns off the LONGEST streak ever, so a broken streak never un-earns a badge.
export async function longestStreak(userId: string, timezone: string | null): Promise<number> {
  const { longest } = await buildGoalConsistency(userId, timezone);
  return longest;
}

// Distinct calendar days (user's tz) with at least one real, non-reverted record.
export async function countActiveDays(
  executor: DbOrTx,
  userId: string,
  timezone: string | null,
): Promise<number> {
  const tz = timezone ?? 'UTC';
  const [row] = await executor
    .select({ n: sql<number>`count(distinct (${records.occurredAt} at time zone ${tz})::date)::int` })
    .from(records)
    .where(and(eq(records.userId, userId), isNull(records.revertedAt)));
  return row?.n ?? 0;
}

export type AchievementCounts = Record<AchievementKey, number>;

export async function computeAchievementCounts(
  executor: DbOrTx,
  userId: string,
  timezone: string | null,
): Promise<AchievementCounts> {
  const [tasks_completed, goals_started, goals_finished, streak, active_days] = await Promise.all([
    countTasksCompleted(executor, userId),
    countGoalsStarted(executor, userId),
    countGoalsFinished(executor, userId),
    longestStreak(userId, timezone),
    countActiveDays(executor, userId, timezone),
  ]);
  return { tasks_completed, goals_started, goals_finished, streak, active_days };
}

// --- the per-user instantiated catalog ------------------------------------

export type MeasuredFamily = { family: AchievementFamily; count: number };

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Every family that applies to THIS user right now, each paired with its real
 * measured count: the static globals + one-per-goal families (streak / progress
 * / tenure, instantiated with the goal's own name + numbers) + the consistency
 * family. This is what makes achievements feel custom — the definitions are
 * code, the numbers are SQL, only the instantiation is per-user. `now` is
 * injectable for deterministic tenure tests.
 */
export async function buildUserCatalog(
  userId: string,
  timezone: string | null,
  now: number = Date.now(),
): Promise<MeasuredFamily[]> {
  const [counts, perfectDays, goalRows] = await Promise.all([
    computeAchievementCounts(db, userId, timezone),
    countPerfectDays(userId, timezone),
    db.select().from(goals).where(and(eq(goals.userId, userId), isNull(goals.archivedAt))),
  ]);

  const out: MeasuredFamily[] = ACHIEVEMENT_CATALOG.map((f) => ({
    family: f,
    count: counts[f.key as AchievementKey] ?? 0,
  }));
  out.push({ family: consistencyFamily, count: perfectDays });

  if (goalRows.length > 0) {
    const habitIds = goalRows
      .filter((g) => (g.definition as GoalDefinition).type === 'habit')
      .map((g) => g.id);
    const [summaries, streaks] = await Promise.all([
      buildGoalCardSummaries(goalRows, timezone),
      buildGoalScopedStreaks(userId, timezone, habitIds),
    ]);

    for (const g of goalRows) {
      const def = g.definition as GoalDefinition;
      const s = summaries.get(g.id);
      const icon = g.icon ?? 'sparkle';

      if (def.type === 'habit') {
        const st = streaks.get(g.id);
        // Earn off the longest run (append-only; a break never un-earns).
        if (st) out.push({ family: goalStreakFamily(g.id, g.name, icon), count: st.longest });
      }

      if (s && s.progress !== null && (def.type === 'savings' || def.type === 'indirect')) {
        out.push({
          family: goalProgressFamily(g.id, g.name, icon),
          count: Math.round(s.progress * 100),
        });
      }

      // Tenure only counts once the goal has real activity — "kept it going"
      // shouldn't reward an untouched goal that's just been sitting there.
      const hasActivity = (s?.progress ?? 0) > 0 || (s?.streak?.longest ?? 0) > 0;
      if (hasActivity) {
        const months = Math.floor((now - g.createdAt.getTime()) / MONTH_MS);
        out.push({ family: goalTenureFamily(g.id, g.name, icon), count: months });
      }
    }
  }

  return out;
}
