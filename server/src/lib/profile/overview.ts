import { and, eq, isNull, sql } from 'drizzle-orm';

import { achievements, goals, records, tasks } from '../../db/schema.ts';
import { db } from '../../db/client.ts';
import { ymdInTz } from '../tasks/recurrence.ts';
import {
  ACHIEVEMENT_CATALOG,
  type AchievementKey,
  earnedThresholds,
  nextTier,
} from '../achievements/catalog.ts';
import {
  type AchievementCounts,
  computeAchievementCounts,
  countTasksCompleted,
} from '../achievements/evaluate.ts';

// The You-tab profile read (GET /profile/overview). Every number here is a
// count over real, non-reverted records — the same figures the badges are
// earned from (evaluate.ts), so the stat row and the badges can never disagree.
// The streak/heatmap is deliberately NOT here: the client keeps using the
// existing GET /goals/consistency (buildGoalConsistency), already built and
// already cache-invalidated on task mutations.

export type ProfileStats = {
  tasksCompleted: number;
  goalsActive: number;
  goalsFinished: number;
  activeDays: number;
};

export type AchievementView = {
  key: AchievementKey;
  unit: string;
  count: number;
  // Highest earned tier's threshold+label, or null if none earned yet.
  earnedTier: number | null;
  earnedLabel: string | null;
  earnedAt: string | null;
  // The next locked tier (teaser) + progress toward it, or null once maxed.
  nextThreshold: number | null;
  nextLabel: string | null;
  progressToNext: number | null; // 0..1
};

export type MonthRecap = {
  tasksCompleted: number;
  goalsAdvanced: number;
  topHabit: string | null;
};

export type ProfileOverview = {
  memberSince: string;
  stats: ProfileStats;
  achievements: AchievementView[];
  month: MonthRecap;
};

// --- pure assembly (testable without a DB) ---------------------------------
// Given the user's real counts and their earned-badge rows, build the display
// list: for each family, the highest earned tier and the next locked teaser
// with a progress fraction. Kept pure so the tier/progress logic is unit-tested
// in isolation; the route just feeds it query results.
export function assembleAchievements(
  counts: AchievementCounts,
  earnedRows: { key: string; tier: number; earnedAt: Date }[],
): AchievementView[] {
  // earnedRows only supply the earned DATE — the earned/locked STATE is derived
  // live from the real count, so display always reflects the honest number and
  // self-corrects from any past miscount (a badge earned before a counting fix
  // never shows as earned once the count no longer supports it).
  const earnedAtByKeyTier = new Map<string, Date>();
  for (const r of earnedRows) earnedAtByKeyTier.set(`${r.key}:${r.tier}`, r.earnedAt);

  return ACHIEVEMENT_CATALOG.map((family) => {
    const count = counts[family.key];
    const earnedTiers = earnedThresholds(family.key, count);
    const highestTier = earnedTiers.length ? Math.max(...earnedTiers) : null;
    const highestLabel =
      highestTier !== null ? (family.tiers.find((t) => t.threshold === highestTier)?.label ?? null) : null;
    const earnedAt = highestTier !== null ? earnedAtByKeyTier.get(`${family.key}:${highestTier}`) ?? null : null;

    const next = nextTier(family.key, count);
    // Progress is absolute (count / next threshold) so the bar matches the
    // "count / next" label shown on the badge — e.g. "1 / 3" reads as a third
    // full, not empty (which a band-relative fill would show right after
    // earning the prior tier).
    const progressToNext = next ? Math.max(0, Math.min(1, count / next.threshold)) : null;

    return {
      key: family.key,
      unit: family.unit,
      count,
      earnedTier: highestTier,
      earnedLabel: highestLabel,
      earnedAt: earnedAt ? earnedAt.toISOString() : null,
      nextThreshold: next?.threshold ?? null,
      nextLabel: next?.label ?? null,
      progressToNext,
    };
  });
}

// --- I/O ------------------------------------------------------------------

async function countGoalsActive(userId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(goals)
    .where(and(eq(goals.userId, userId), isNull(goals.archivedAt)));
  return row?.n ?? 0;
}

async function buildMonthRecap(userId: string, tz: string, ym: string): Promise<MonthRecap> {
  const inMonth = sql`to_char(${records.occurredAt} at time zone ${tz}, 'YYYY-MM') = ${ym}`;

  // Tasks completed this month = tasks currently `done` whose completion
  // record landed this month. Keyed on the task's CURRENT completedRecordId
  // (one per done task) rather than raw task_completion records, so a
  // check→uncheck→re-check can't inflate it. AT TIME ZONE via inMonth applies
  // to records.occurredAt below through the join.
  const [tasksRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(tasks)
    .innerJoin(records, eq(tasks.completedRecordId, records.id))
    .where(
      and(
        eq(tasks.userId, userId),
        eq(tasks.status, 'done'),
        isNull(tasks.deletedAt),
        isNull(records.revertedAt),
        inMonth,
      ),
    );

  const [goalsRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(records)
    .where(
      and(
        eq(records.userId, userId),
        eq(records.kind, 'goal_stage_advanced'),
        isNull(records.revertedAt),
        inMonth,
      ),
    );

  // Top habit: the recurring task (templateId not null) with the most done
  // instances dated this month. A real count of what they actually completed —
  // no inference. Ties break arbitrarily; a single winner is enough for a line.
  const [habitRow] = await db
    .select({ title: tasks.title, n: sql<number>`count(*)::int` })
    .from(tasks)
    .where(
      and(
        eq(tasks.userId, userId),
        eq(tasks.status, 'done'),
        isNull(tasks.deletedAt),
        sql`${tasks.templateId} is not null`,
        sql`${tasks.occurrenceDate} is not null and to_char(${tasks.occurrenceDate}::date, 'YYYY-MM') = ${ym}`,
      ),
    )
    .groupBy(tasks.title)
    .orderBy(sql`count(*) desc`)
    .limit(1);

  return {
    tasksCompleted: tasksRow?.n ?? 0,
    goalsAdvanced: goalsRow?.n ?? 0,
    topHabit: habitRow?.title ?? null,
  };
}

export async function buildProfileOverview(
  userId: string,
  timezone: string | null,
  memberSince: Date,
): Promise<ProfileOverview> {
  const tz = timezone ?? 'UTC';
  const ym = ymdInTz(new Date(), tz).slice(0, 7);

  const [counts, goalsActive, earnedRows, month] = await Promise.all([
    computeAchievementCounts(db, userId, timezone),
    countGoalsActive(userId),
    db
      .select({ key: achievements.key, tier: achievements.tier, earnedAt: achievements.earnedAt })
      .from(achievements)
      .where(eq(achievements.userId, userId)),
    buildMonthRecap(userId, tz, ym),
  ]);

  return {
    memberSince: memberSince.toISOString(),
    stats: {
      tasksCompleted: counts.tasks_completed,
      goalsActive,
      goalsFinished: counts.goals_finished,
      activeDays: counts.active_days,
    },
    achievements: assembleAchievements(counts, earnedRows),
    month,
  };
}

// Re-export so the route can lazily backfill earned rows (a user who crossed
// thresholds before this feature shipped, or via streak rollover) on read.
export { countTasksCompleted };
