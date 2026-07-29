import { and, eq, isNull, sql } from 'drizzle-orm';

import { achievements, records, tasks } from '../../db/schema.ts';
import { db } from '../../db/client.ts';
import { buildGoalConsistency } from '../goals/consistency.ts';
import { weekStartYmd } from '../tasks/recurrence.ts';
import { earnedTiersOf, nextTierOf, type AchievementCategory, type AchievementFamily } from './catalog.ts';
import { buildUserCatalog } from './user-catalog.ts';

// A single achievement family shaped for display — the highest tier earned (if
// any) plus the next locked tier and a goal-gradient progress fraction toward
// it. The earned/locked STATE is derived live from the real count, so it always
// reflects the honest number and self-corrects from any past miscount; the
// earned ROW only supplies the date.
export type AchievementView = {
  key: string;
  title: string;
  unit: string;
  icon: string;
  category: AchievementCategory;
  count: number;
  earnedTier: number | null;
  earnedLabel: string | null;
  earnedAt: string | null;
  nextThreshold: number | null;
  nextLabel: string | null;
  progressToNext: number | null; // 0..1
};

// A self-referential personal best (Duolingo-style) — always beatable, no tier.
// Computed on the fly; celebrate-on-beat is a later follow.
export type PersonalRecord = { key: string; label: string; value: number; unit: string; icon: string };

export type AchievementsScreen = {
  // Nearest not-yet-earned tiers across every family, ranked closest-first —
  // the goal-gradient "almost there" pull. Only families with real progress.
  inProgress: AchievementView[];
  // Every family with at least one earned tier, most-recent first.
  earned: AchievementView[];
  // Personal bests — only ones the user actually has (value > 0).
  records: PersonalRecord[];
};

const IN_PROGRESS_LIMIT = 8;

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/**
 * The user's personal bests, computed live from real records: the most tasks
 * finished in a single day, the best 7-day (Mon-start) total, and their longest
 * streak ever. Counts currently-done tasks by their completion day (the same
 * completedRecordId convention as the stats/recap — a re-toggle can't inflate
 * it). Only records with a real value are returned.
 */
export async function buildPersonalRecords(userId: string, timezone: string | null): Promise<PersonalRecord[]> {
  const tz = timezone ?? 'UTC';
  const dayExpr = sql<string>`(${records.occurredAt} AT TIME ZONE ${tz})::date`;
  const perDay = await db
    .select({ day: dayExpr, n: sql<number>`count(*)::int` })
    .from(tasks)
    .innerJoin(records, eq(tasks.completedRecordId, records.id))
    .where(and(eq(tasks.userId, userId), eq(tasks.status, 'done'), isNull(tasks.deletedAt), isNull(records.revertedAt)))
    // GROUP BY ordinal, not the expression: the tz-bound day expression would
    // otherwise get a second parameter placeholder and Postgres wouldn't match
    // it to the SELECT ("must appear in the GROUP BY clause").
    .groupBy(sql`1`);

  let mostInDay = 0;
  const weekTotals = new Map<string, number>();
  for (const row of perDay) {
    // `day` comes back as 'YYYY-MM-DD' (a date column); weekStartYmd wants that.
    const day = String(row.day).slice(0, 10);
    mostInDay = Math.max(mostInDay, row.n);
    const wk = weekStartYmd(day);
    weekTotals.set(wk, (weekTotals.get(wk) ?? 0) + row.n);
  }
  const bestWeek = weekTotals.size ? Math.max(...weekTotals.values()) : 0;
  const { longest } = await buildGoalConsistency(userId, timezone);

  const out: PersonalRecord[] = [];
  if (longest > 0)
    out.push({ key: 'longest_streak', label: 'Longest streak', value: longest, unit: plural(longest, 'day', 'days'), icon: 'flame' });
  if (mostInDay > 0)
    out.push({ key: 'most_tasks_day', label: 'Most in a day', value: mostInDay, unit: plural(mostInDay, 'task', 'tasks'), icon: 'check' });
  if (bestWeek > 0)
    out.push({ key: 'best_week', label: 'Best week', value: bestWeek, unit: plural(bestWeek, 'task', 'tasks'), icon: 'sparkle' });
  return out;
}

function toView(
  family: AchievementFamily,
  count: number,
  earnedAtByKeyTier: Map<string, Date>,
): AchievementView {
  const earnedTiers = earnedTiersOf(family, count);
  const highest = earnedTiers.length ? Math.max(...earnedTiers) : null;
  const highestLabel = highest !== null ? family.tiers.find((t) => t.threshold === highest)?.label ?? null : null;
  const earnedAt = highest !== null ? earnedAtByKeyTier.get(`${family.key}:${highest}`) ?? null : null;
  const next = nextTierOf(family, count);
  const progressToNext = next ? Math.max(0, Math.min(1, count / next.threshold)) : null;
  return {
    key: family.key,
    title: family.title,
    unit: family.unit,
    icon: family.icon,
    category: family.category,
    count,
    earnedTier: highest,
    earnedLabel: highestLabel,
    earnedAt: earnedAt ? earnedAt.toISOString() : null,
    nextThreshold: next?.threshold ?? null,
    nextLabel: next?.label ?? null,
    progressToNext,
  };
}

/**
 * The dedicated Achievements screen: the full per-user catalog split into
 * in-progress (nearest first) and earned (newest first). Every number is
 * SQL-computed via buildUserCatalog; this only arranges them for display.
 */
export async function buildAchievementsScreen(
  userId: string,
  timezone: string | null,
): Promise<AchievementsScreen> {
  const [catalog, rows, personalRecords] = await Promise.all([
    buildUserCatalog(userId, timezone),
    db.select().from(achievements).where(eq(achievements.userId, userId)),
    buildPersonalRecords(userId, timezone),
  ]);
  const earnedAtByKeyTier = new Map<string, Date>();
  for (const r of rows) earnedAtByKeyTier.set(`${r.key}:${r.tier}`, r.earnedAt);

  const views = catalog.map(({ family, count }) => toView(family, count, earnedAtByKeyTier));

  const earned = views
    .filter((v) => v.earnedTier !== null)
    .sort((a, b) => (b.earnedAt ?? '').localeCompare(a.earnedAt ?? ''));
  const inProgress = views
    .filter((v) => v.nextThreshold !== null && v.count > 0)
    .sort((a, b) => (b.progressToNext ?? 0) - (a.progressToNext ?? 0))
    .slice(0, IN_PROGRESS_LIMIT);

  return { inProgress, earned, records: personalRecords };
}
