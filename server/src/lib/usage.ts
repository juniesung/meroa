import { and, eq, gte, sql } from 'drizzle-orm';

import { db } from '../db/client.ts';
import { conversations, entitlements, messages } from '../db/schema.ts';
import { env } from '../env.ts';

// Free vs premium chat allowances (CLAUDE.md §2: enforced server-side, never
// client-trusted). Phase 7 wires the real Apple/Google billing gate; this
// reads the `entitlements` row seeded in Phase 1, so upgrading a user's plan
// later doesn't require touching this logic. Limits are env-overridable
// (see env.ts) so testing the 429 path doesn't require editing this file.
const DAY_MS = 24 * 60 * 60 * 1000;

export type ChatAllowance = {
  plan: 'free' | 'plus';
  limit: number;
  used: number;
  remaining: number;
  allowed: boolean;
};

// The type Drizzle gives the callback in `db.transaction(async (tx) => ...)`.
// `computeAllowance` accepts either `db` or a `tx` so the same count logic
// can run inside `withUserChatLock`'s locked transaction.
type DbOrTx = typeof db | Parameters<Parameters<(typeof db)['transaction']>[0]>[0];

async function computeAllowance(executor: DbOrTx, userId: string): Promise<ChatAllowance> {
  const [entitlement] = await executor
    .select({ plan: entitlements.plan })
    .from(entitlements)
    .where(eq(entitlements.userId, userId))
    .limit(1);

  const plan = (entitlement?.plan ?? 'free') as 'free' | 'plus';
  const limit = plan === 'plus' ? env.PLUS_DAILY_MESSAGES : env.FREE_DAILY_MESSAGES;

  const since = new Date(Date.now() - DAY_MS);
  const [row] = await executor
    .select({ used: sql<number>`count(*)::int` })
    .from(messages)
    .innerJoin(conversations, eq(messages.conversationId, conversations.id))
    .where(
      and(
        eq(conversations.userId, userId),
        eq(conversations.channel, 'app'),
        eq(messages.role, 'user'),
        gte(messages.createdAt, since),
      ),
    );

  const used = row?.used ?? 0;
  return { plan, limit, used, remaining: Math.max(0, limit - used), allowed: used < limit };
}

/**
 * Rolling 24-hour message allowance (not a calendar-day boundary — avoids
 * per-user timezone math while still resetting fairly). Read-only — use
 * `withUserChatLock` when the result gates a write, or two concurrent sends
 * can both read "under limit" before either's insert commits.
 */
export async function getChatAllowance(userId: string): Promise<ChatAllowance> {
  return computeAllowance(db, userId);
}

/**
 * Runs `fn` inside a transaction holding a Postgres advisory lock keyed on
 * `userId` — the same pattern `auth.ts` uses for OTP rate limiting. This
 * serializes concurrent chat sends from the *same* user (so a burst of
 * simultaneous requests can't all see "under limit" before any of them
 * commits) without blocking requests from other users. `fn` should check
 * `computeAllowance(tx, userId)` and, if allowed, insert the user's message
 * in the same transaction — that's what makes the check-then-insert atomic.
 */
export async function withUserChatLock<T>(
  userId: string,
  fn: (tx: Parameters<Parameters<(typeof db)['transaction']>[0]>[0]) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${userId})::bigint)`);
    return fn(tx);
  });
}

export { computeAllowance };
