import { and, eq, isNull, or } from 'drizzle-orm';

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

// Build the currently-earned (key, tier) candidate set + a family lookup.
async function measureEarned(
  userId: string,
  timezone: string | null,
): Promise<{ byKey: Map<string, AchievementFamily>; candidates: { key: string; tier: number }[] }> {
  const catalog = await buildUserCatalog(userId, timezone);
  const byKey = new Map<string, AchievementFamily>();
  const candidates: { key: string; tier: number }[] = [];
  for (const { family, count } of catalog) {
    byKey.set(family.key, family);
    for (const tier of earnedTiersOf(family, count)) candidates.push({ key: family.key, tier });
  }
  return { byKey, candidates };
}

/**
 * Record any tiers the user has now earned as (un-announced) rows. Idempotent
 * via the unique (userId, key, tier) index. Does NOT claim the congrats — that
 * is deliberately the job of claimNewlyEarned alone, so a READ-path backfill
 * (profile) can record a freshly-crossed tier WITHOUT stealing the congrats a
 * concurrent mutation's announce path is about to deliver. This is the whole
 * fix for the silent-backfill-suppresses-congrats race: the insert is no longer
 * the arbiter of who congratulates.
 *
 * Evaluates the full PER-USER catalog (globals + per-goal + consistency), so a
 * streak on a specific habit, a savings goal crossing 50%, or a kept-3-months
 * tenure all earn here — every count computed in SQL, never fabricated.
 *
 * `opts.silent` is retained for call-site compatibility but is now a no-op:
 * rows are always inserted un-announced; only claimNewlyEarned stamps them.
 */
export async function evaluateAchievements(
  userId: string,
  timezone: string | null,
  executor: DbOrTx = db,
  _opts: { silent?: boolean } = {},
): Promise<NewlyEarned[]> {
  const { byKey, candidates } = await measureEarned(userId, timezone);
  if (candidates.length === 0) return [];

  const inserted = await executor
    .insert(achievements)
    .values(candidates.map((c) => ({ userId, key: c.key, tier: c.tier, announcedAt: null })))
    .onConflictDoNothing({ target: [achievements.userId, achievements.key, achievements.tier] })
    .returning({ key: achievements.key, tier: achievements.tier });

  return inserted
    .map((r) => {
      const family = byKey.get(r.key);
      return family ? { key: r.key, tier: r.tier, family } : null;
    })
    .filter((e): e is NewlyEarned => e !== null);
}

/**
 * The single announce arbiter. Records earned rows (idempotent), then ATOMICALLY
 * claims every still-un-announced earned tier via UPDATE ... WHERE announcedAt
 * IS NULL RETURNING. Row locks make the claim the one place a congrats can be
 * won: two concurrent announce paths each get a disjoint set, and the read-path
 * insert (which never claims) can no longer permanently suppress a congrats by
 * winning the INSERT first. Callers deliver mostSignificant() of the result and
 * may ignore the rest — the claim has already stamped them all.
 */
export async function claimNewlyEarned(
  userId: string,
  timezone: string | null,
  executor: DbOrTx = db,
): Promise<NewlyEarned[]> {
  const { byKey, candidates } = await measureEarned(userId, timezone);
  if (candidates.length === 0) return [];

  await executor
    .insert(achievements)
    .values(candidates.map((c) => ({ userId, key: c.key, tier: c.tier, announcedAt: null })))
    .onConflictDoNothing({ target: [achievements.userId, achievements.key, achievements.tier] });

  // Claim only rows for tiers currently earned (a since-undone tier keeps its
  // stale row un-announced rather than firing a congrats the user no longer
  // merits).
  const claimed = await executor
    .update(achievements)
    .set({ announcedAt: new Date() })
    .where(
      and(
        eq(achievements.userId, userId),
        isNull(achievements.announcedAt),
        or(...candidates.map((c) => and(eq(achievements.key, c.key), eq(achievements.tier, c.tier)))),
      ),
    )
    .returning({ key: achievements.key, tier: achievements.tier });

  return claimed
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
