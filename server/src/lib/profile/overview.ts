import { and, eq, isNull, sql } from 'drizzle-orm';

import { achievements, goals, records, tasks } from '../../db/schema.ts';
import { db } from '../../db/client.ts';
import { ymdInTz } from '../tasks/recurrence.ts';
import {
  ACHIEVEMENT_CATALOG,
  type AchievementKey,
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
  const earnedByKey = new Map<string, { tier: number; earnedAt: Date }[]>();
  for (const r of earnedRows) {
    const list = earnedByKey.get(r.key) ?? [];
    list.push({ tier: r.tier, earnedAt: r.earnedAt });
    earnedByKey.set(r.key, list);
  }

  return ACHIEVEMENT_CATALOG.map((family) => {
    const count = counts[family.key];
    const earned = (earnedByKey.get(family.key) ?? []).sort((a, b) => b.tier - a.tier);
    const highest = earned[0] ?? null;
    const highestLabel = highest
      ? (family.tiers.find((t) => t.threshold === highest.tier)?.label ?? null)
      : null;

    const next = nextTier(family.key, count);
    // Progress is measured from the previously-earned threshold to the next one
    // so the bar fills across the current tier band, not from zero every time.
    const floor = highest?.tier ?? 0;
    const progressToNext = next
      ? Math.max(0, Math.min(1, (count - floor) / (next.threshold - floor)))
      : null;

    return {
      key: family.key,
      unit: family.unit,
      count,
      earnedTier: highest?.tier ?? null,
      earnedLabel: highestLabel,
      earnedAt: highest ? highest.earnedAt.toISOString() : null,
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

async function countActiveDays(userId: string, tz: string): Promise<number> {
  // Distinct calendar days (in the user's own tz) with at least one real,
  // non-reverted record. AT TIME ZONE takes the zone as bound text.
  const [row] = await db
    .select({
      n: sql<number>`count(distinct (${records.occurredAt} at time zone ${tz})::date)::int`,
    })
    .from(records)
    .where(and(eq(records.userId, userId), isNull(records.revertedAt)));
  return row?.n ?? 0;
}

async function buildMonthRecap(userId: string, tz: string, ym: string): Promise<MonthRecap> {
  const inMonth = sql`to_char(${records.occurredAt} at time zone ${tz}, 'YYYY-MM') = ${ym}`;

  const [tasksRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(records)
    .where(
      and(
        eq(records.userId, userId),
        eq(records.kind, 'task_completion'),
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

  const [counts, goalsActive, activeDays, earnedRows, month] = await Promise.all([
    computeAchievementCounts(db, userId, timezone),
    countGoalsActive(userId),
    countActiveDays(userId, tz),
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
      activeDays,
    },
    achievements: assembleAchievements(counts, earnedRows),
    month,
  };
}

// Re-export so the route can lazily backfill earned rows (a user who crossed
// thresholds before this feature shipped, or via streak rollover) on read.
export { countTasksCompleted };
