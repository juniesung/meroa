import { and, eq, isNull, sql } from 'drizzle-orm';

import { achievements, goals, records, tasks } from '../../db/schema.ts';
import { buildGoalConsistency } from '../goals/consistency.ts';
import type { DbOrTx } from '../usage.ts';
import { db } from '../../db/client.ts';
import { type AchievementKey, earnedThresholds } from './catalog.ts';

// --- real counts (the only numbers a badge is ever allowed to reflect) -----
// Each maps one achievement family to a real count. Kept as small named
// queries so /profile/overview's stat row reuses the exact same numbers the
// badges are earned from — one definition, never two.

export async function countTasksCompleted(executor: DbOrTx, userId: string): Promise<number> {
  // Count task instances currently in `done` status — NOT task_completion
  // records. applyProgress writes a task_completion record on every toggle
  // (including un-checking) and never reverts the prior one, so counting those
  // records inflates on any check→uncheck→re-check. A recurring task's daily
  // instances are separate rows, so each done day still counts once; the
  // template itself is never `done`. Un-checking flips status back to open, so
  // the count drops honestly (the earned badge row stays — it's append-only).
  const [row] = await executor
    .select({ n: sql<number>`count(*)::int` })
    .from(tasks)
    .where(and(eq(tasks.userId, userId), eq(tasks.status, 'done'), isNull(tasks.deletedAt)));
  return row?.n ?? 0;
}

export async function countGoalsStarted(executor: DbOrTx, userId: string): Promise<number> {
  // Every goal the user ever created, archived or not — "started", not "active".
  const [row] = await executor
    .select({ n: sql<number>`count(*)::int` })
    .from(goals)
    .where(eq(goals.userId, userId));
  return row?.n ?? 0;
}

export async function countGoalsFinished(executor: DbOrTx, userId: string): Promise<number> {
  // A milestone goal is finished when its activeStageIndex has advanced past
  // the last stage (executor.ts's advance guard: activeStageIndex >=
  // stages.length). Non-milestone goals are never counted — the only
  // unambiguous completion signal in the schema (decided with the product owner).
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

// The streak family earns off the LONGEST streak ever reached, not the current
// one, so a broken streak never un-earns a badge (the row is append-only
// anyway, but this keeps evaluate honest about what to insert). Reuses the
// existing account-wide consistency machinery — no separate streak math.
export async function longestStreak(userId: string, timezone: string | null): Promise<number> {
  const { longest } = await buildGoalConsistency(userId, timezone);
  return longest;
}

// Distinct calendar days (in the user's own tz) with at least one real,
// non-reverted record — the same figure the stat row shows, so the badge and
// the stat can't disagree. AT TIME ZONE takes the zone as bound text.
export async function countActiveDays(
  executor: DbOrTx,
  userId: string,
  timezone: string | null,
): Promise<number> {
  const tz = timezone ?? 'UTC';
  const [row] = await executor
    .select({
      n: sql<number>`count(distinct (${records.occurredAt} at time zone ${tz})::date)::int`,
    })
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

export type NewlyEarned = { key: AchievementKey; tier: number };

/**
 * Insert any tiers the user has now earned but that aren't yet rows, and return
 * only the ones inserted THIS call — the trigger for a one-time congrats. The
 * unique index (userId, key, tier) makes this idempotent: two concurrent
 * evaluations of the same crossing both try to insert, one wins, the loser's
 * onConflictDoNothing returns no row, so a badge is announced exactly once.
 *
 * Read-only when nothing is newly earned (the common case) — the counts run
 * regardless, but no write happens. Pass the surrounding `tx` when called from
 * inside a mutation so the insert commits atomically with the action that
 * earned it; omit it and it uses the base connection.
 */
export async function evaluateAchievements(
  userId: string,
  timezone: string | null,
  executor: DbOrTx = db,
  opts: { silent?: boolean } = {},
): Promise<NewlyEarned[]> {
  const counts = await computeAchievementCounts(executor, userId, timezone);

  const candidates: NewlyEarned[] = [];
  for (const key of Object.keys(counts) as AchievementKey[]) {
    for (const tier of earnedThresholds(key, counts[key])) {
      candidates.push({ key, tier });
    }
  }
  if (candidates.length === 0) return [];

  // `silent` pre-stamps announcedAt so a row can never later trigger a
  // congrats. Used by the profile READ, which must backfill already-earned
  // tiers (a badge crossed before this feature shipped, or via a passive
  // streak rollover the user is looking at right now) without queueing a pile
  // of historical congrats messages. The mutating call sites leave it null so
  // the in-chat segment / proactive tick announces the crossing exactly once.
  const announcedAt = opts.silent ? new Date() : null;

  // One insert for all candidates; ON CONFLICT DO NOTHING means only the
  // genuinely-new (userId, key, tier) rows come back in `returning()`.
  const inserted = await executor
    .insert(achievements)
    .values(candidates.map((c) => ({ userId, key: c.key, tier: c.tier, announcedAt })))
    .onConflictDoNothing({
      target: [achievements.userId, achievements.key, achievements.tier],
    })
    .returning({ key: achievements.key, tier: achievements.tier });

  return inserted.map((r) => ({ key: r.key as AchievementKey, tier: r.tier }));
}

// Stamp announcedAt on specific (key, tier) rows once their congrats has been
// delivered — the guard that stops the other delivery path (the proactive
// tick) from re-announcing the same unlock. Called right after the in-chat
// congrats segment is emitted.
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

// When several tiers cross in one turn (rare), congratulate only the most
// significant — one congrats per turn, mirroring the "at most one correction
// per turn" rule. Order: finishing a goal > a streak milestone > tasks > a new
// goal; ties break on the higher tier.
const KEY_WEIGHT: Record<AchievementKey, number> = {
  goals_finished: 5,
  streak: 4,
  tasks_completed: 3,
  active_days: 2,
  goals_started: 1,
};

export function mostSignificant(earned: NewlyEarned[]): NewlyEarned | null {
  if (earned.length === 0) return null;
  return [...earned].sort(
    (a, b) => KEY_WEIGHT[b.key] - KEY_WEIGHT[a.key] || b.tier - a.tier,
  )[0]!;
}
