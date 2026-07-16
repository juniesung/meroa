import { and, eq, gte, isNull, sql } from 'drizzle-orm';

import { db } from '../db/client.ts';
import { entitlements, goals, records } from '../db/schema.ts';
import { env } from '../env.ts';
import { resolvePlan } from './billing/plan.ts';
import type { DbOrTx } from './usage.ts';

// Free-plan creation caps (CLAUDE.md §2 / phase-7: meter NEW creation only —
// never completion, progress, or other updates). Mirrors usage.ts's
// computeAllowance shape and rolling-24h window for consistency; both
// counters key off structures that already exclude what shouldn't be
// metered, rather than filtering it out here:
//
// - Task creation counts `records` rows of kind 'task_created'. Recurring
//   instance materialization (tasks/recurrence.ts) never writes a record,
//   and a goal's starter tasks are created with `skipRecord: true`
//   (goals/executor.ts) — so neither counts against, or is blocked by, the
//   cap. `revertedAt IS NULL` means an undone create refunds the quota.
// - Active goals counts live `goals` rows (`archivedAt IS NULL`) —
//   archiving one frees a slot.
export type CreateAllowance = {
  plan: 'free' | 'plus';
  limit: number;
  used: number;
  remaining: number;
  allowed: boolean;
};

// Thrown inside a withUserLock transaction when a create would exceed the
// free-plan cap — callers catch this specifically (it isn't a
// TaskActionError/GoalActionError) and translate it into a 429 with a
// consistent, client-detectable shape: {error:'limit_reached', feature, ...}.
export class LimitReachedError extends Error {
  feature: 'tasks' | 'goals';
  allowance: CreateAllowance;
  constructor(feature: 'tasks' | 'goals', allowance: CreateAllowance) {
    super(`${feature} creation limit reached`);
    this.feature = feature;
    this.allowance = allowance;
  }
}

// 429 shape shared with usage.ts's chat cap ({error, plan, limit}), plus a
// `feature` discriminator so the client can tell which cap was hit.
export function limitReachedBody(err: LimitReachedError) {
  const { allowance } = err;
  return {
    status: 429 as const,
    body: {
      error: 'limit_reached' as const,
      feature: err.feature,
      plan: allowance.plan,
      limit: allowance.limit,
      used: allowance.used,
    },
  };
}

async function loadPlan(executor: DbOrTx, userId: string): Promise<'free' | 'plus'> {
  const [entitlement] = await executor
    .select({ plan: entitlements.plan, expiresAt: entitlements.expiresAt })
    .from(entitlements)
    .where(eq(entitlements.userId, userId))
    .limit(1);
  return resolvePlan(entitlement);
}

const DAY_MS = 24 * 60 * 60 * 1000;

export async function computeTaskCreateAllowance(
  executor: DbOrTx,
  userId: string,
): Promise<CreateAllowance> {
  const plan = await loadPlan(executor, userId);
  const limit = env.FREE_DAILY_TASKS;
  if (plan === 'plus') {
    return { plan, limit, used: 0, remaining: limit, allowed: true };
  }

  const since = new Date(Date.now() - DAY_MS);
  const [row] = await executor
    .select({ used: sql<number>`count(*)::int` })
    .from(records)
    .where(
      and(
        eq(records.userId, userId),
        eq(records.kind, 'task_created'),
        isNull(records.revertedAt),
        gte(records.createdAt, since),
      ),
    );

  const used = row?.used ?? 0;
  return { plan, limit, used, remaining: Math.max(0, limit - used), allowed: used < limit };
}

export async function computeActiveGoalAllowance(
  executor: DbOrTx,
  userId: string,
): Promise<CreateAllowance> {
  const plan = await loadPlan(executor, userId);
  const limit = env.FREE_MAX_ACTIVE_GOALS;
  if (plan === 'plus') {
    return { plan, limit, used: 0, remaining: limit, allowed: true };
  }

  const [row] = await executor
    .select({ used: sql<number>`count(*)::int` })
    .from(goals)
    .where(and(eq(goals.userId, userId), isNull(goals.archivedAt)));

  const used = row?.used ?? 0;
  return { plan, limit, used, remaining: Math.max(0, limit - used), allowed: used < limit };
}
