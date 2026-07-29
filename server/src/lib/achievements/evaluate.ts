import { and, eq, isNull } from 'drizzle-orm';

import { achievements } from '../../db/schema.ts';
import type { DbOrTx } from '../usage.ts';
import { db } from '../../db/client.ts';
import { earnedTiersOf, type AchievementFamily } from './catalog.ts';
import { buildUserCatalog } from './user-catalog.ts';

// The count helpers + AchievementCounts moved to user-catalog.ts (so evaluate
// can import buildUserCatalog without a cycle). Re-exported here so existing
// importers (profile/overview.ts, evaluate.test.ts) keep their path.
export {
  countTasksCompleted,
  countGoalsStarted,
  countGoalsFinished,
  countActiveDays,
  longestStreak,
  computeAchievementCounts,
  type AchievementCounts,
} from './user-catalog.ts';

// Carries the family so the congrats copy can name a dynamic (per-goal) badge
// without re-resolving it — a per-goal key isn't in any static map.
export type NewlyEarned = { key: string; tier: number; family: AchievementFamily };

/**
 * Insert any tiers the user has now earned but that aren't yet rows, and return
 * only the ones inserted THIS call — the trigger for a one-time congrats. The
 * unique index (userId, key, tier) makes this idempotent across concurrent
 * evaluations. Read-only when nothing is newly earned (the common case).
 *
 * Evaluates the full PER-USER catalog (globals + per-goal + consistency), so a
 * streak on a specific habit, a savings goal crossing 50%, or a kept-3-months
 * tenure all earn here — every count computed in SQL, never fabricated.
 */
export async function evaluateAchievements(
  userId: string,
  timezone: string | null,
  executor: DbOrTx = db,
  opts: { silent?: boolean } = {},
): Promise<NewlyEarned[]> {
  const catalog = await buildUserCatalog(userId, timezone);

  const byKey = new Map<string, AchievementFamily>();
  const candidates: { key: string; tier: number }[] = [];
  for (const { family, count } of catalog) {
    byKey.set(family.key, family);
    for (const tier of earnedTiersOf(family, count)) candidates.push({ key: family.key, tier });
  }
  if (candidates.length === 0) return [];

  // `silent` pre-stamps announcedAt so a row can never later trigger a congrats
  // — used by the profile READ to backfill already-earned tiers without queueing
  // a pile of historical congrats. Mutating call sites leave it null.
  const announcedAt = opts.silent ? new Date() : null;

  const inserted = await executor
    .insert(achievements)
    .values(candidates.map((c) => ({ userId, key: c.key, tier: c.tier, announcedAt })))
    .onConflictDoNothing({ target: [achievements.userId, achievements.key, achievements.tier] })
    .returning({ key: achievements.key, tier: achievements.tier });

  return inserted
    .map((r) => {
      const family = byKey.get(r.key);
      return family ? { key: r.key, tier: r.tier, family } : null;
    })
    .filter((e): e is NewlyEarned => e !== null);
}

// Stamp announcedAt on specific (key, tier) rows once their congrats is
// delivered — the guard that stops the other delivery path from re-announcing.
export async function markAnnounced(
  userId: string,
  earned: NewlyEarned[],
  executor: DbOrTx = db,
): Promise<void> {
  const now = new Date();
  for (const e of earned) {
    await executor
      .update(achievements)
      .set({ announcedAt: now })
      .where(
        and(
          eq(achievements.userId, userId),
          eq(achievements.key, e.key),
          eq(achievements.tier, e.tier),
          isNull(achievements.announcedAt),
        ),
      );
  }
}

// When several tiers cross at once (rare), congratulate only the most
// significant — one congrats per turn. Reaching a goal outranks finishing one,
// then streaks, then progress/tenure/tasks, then consistency, then the rest;
// ties break on the higher tier.
function weightOf(e: NewlyEarned): number {
  const k = e.key;
  if (k.startsWith('goal_progress:') && e.tier === 100) return 6;
  if (k === 'goals_finished') return 5;
  if (k === 'streak' || k.startsWith('goal_streak:')) return 4;
  if (k.startsWith('goal_progress:')) return 3.5;
  if (k === 'tasks_completed') return 3;
  if (k.startsWith('goal_tenure:')) return 3;
  if (e.family.category === 'consistency') return 2.5;
  if (k === 'active_days') return 2;
  return 1; // goals_started, anything else
}

export function mostSignificant(earned: NewlyEarned[]): NewlyEarned | null {
  if (earned.length === 0) return null;
  return [...earned].sort((a, b) => weightOf(b) - weightOf(a) || b.tier - a.tier)[0]!;
}
