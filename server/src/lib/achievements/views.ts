import { eq } from 'drizzle-orm';

import { achievements } from '../../db/schema.ts';
import { db } from '../../db/client.ts';
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

export type AchievementsScreen = {
  // Nearest not-yet-earned tiers across every family, ranked closest-first —
  // the goal-gradient "almost there" pull. Only families with real progress.
  inProgress: AchievementView[];
  // Every family with at least one earned tier, most-recent first.
  earned: AchievementView[];
};

const IN_PROGRESS_LIMIT = 8;

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
  const [catalog, rows] = await Promise.all([
    buildUserCatalog(userId, timezone),
    db.select().from(achievements).where(eq(achievements.userId, userId)),
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

  return { inProgress, earned };
}
