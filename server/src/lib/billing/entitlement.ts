import { entitlements } from '../../db/schema.ts';
import { withUserLock } from '../usage.ts';
import { fetchSubscriberEntitlement } from './revenuecat.ts';
import { resolvePlan } from './plan.ts';

// The single write path from RevenueCat into `entitlements`. Deliberately
// refetches RC's CURRENT subscriber state rather than applying an event
// payload — both the webhook (any event type) and the client-called
// /billing/sync call this same function, so a late, duplicated, or
// out-of-order webhook always converges to the same truth instead of
// requiring event-ordering logic. That's also why this needs no new DB
// column (an event timestamp or original-transaction-id) — there's nothing
// to compare against, only the latest fetch to trust.
export async function syncEntitlementFromRevenueCat(
  userId: string,
): Promise<{ plan: 'free' | 'plus'; expiresAt: Date | null }> {
  const state = await fetchSubscriberEntitlement(userId);
  const plan = state.active ? 'plus' : 'free';

  return withUserLock(userId, async (tx) => {
    const [row] = await tx
      .insert(entitlements)
      .values({ userId, plan, source: 'revenuecat', expiresAt: state.expiresAt })
      .onConflictDoUpdate({
        target: entitlements.userId,
        set: { plan, source: 'revenuecat', expiresAt: state.expiresAt, updatedAt: new Date() },
      })
      .returning();
    return { plan: resolvePlan(row), expiresAt: row?.expiresAt ?? null };
  });
}
