import { eq } from 'drizzle-orm';
import { Hono } from 'hono';

import { db } from '../db/client.ts';
import { users } from '../db/schema.ts';
import { env } from '../env.ts';
import { syncEntitlementFromRevenueCat } from '../lib/billing/entitlement.ts';
import { secretsMatch } from '../lib/crypto.ts';
import { requireAuth, type AuthVariables } from '../middleware/auth.ts';
import { logger } from '../logger.ts';

export const billingRoutes = new Hono<{ Variables: AuthVariables }>();

// users.id is a Postgres uuid — comparing it against a non-UUID string is a
// type error at the DB level, not an empty result. RevenueCat's dashboard
// "send test event" button uses ids like `test_app_user_id`, so an unguarded
// query 500s and puts the webhook into retry backoff.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function userExists(userId: string): Promise<boolean> {
  if (!UUID_RE.test(userId)) return false;
  const [row] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1);
  return !!row;
}

// The interactive path — called by the app right after a purchase or a tap
// on "Restore purchases". Avoids waiting on webhook delivery/latency: by the
// time this returns, `entitlements` reflects RC's current subscriber state.
billingRoutes.post('/sync', requireAuth, async (c) => {
  if (!env.REVENUECAT_SECRET_API_KEY) {
    return c.json({ error: 'billing_unconfigured' }, 503);
  }
  const userId = c.get('userId');
  const entitlement = await syncEntitlementFromRevenueCat(userId);
  return c.json({ entitlement });
});

// The background path — RevenueCat calls this on every subscriber lifecycle
// event (renewal, cancellation, expiration, billing issue, transfer…). Never
// applies the event payload itself; every event type just triggers a refetch
// of RC's current truth (lib/billing/entitlement.ts) so a late, duplicated,
// or out-of-order delivery always converges instead of requiring ordering
// logic. Always 200s on a recognized-shape request — a 4xx makes RevenueCat
// retry indefinitely, which is the wrong response to "this user doesn't
// exist" or "this is an anonymous id we never configured the SDK with".
billingRoutes.post('/webhook', async (c) => {
  if (!env.REVENUECAT_WEBHOOK_SECRET || !env.REVENUECAT_SECRET_API_KEY) {
    return c.json({ error: 'billing_unconfigured' }, 503);
  }

  const authHeader = c.req.header('authorization') ?? '';
  if (!secretsMatch(authHeader, env.REVENUECAT_WEBHOOK_SECRET)) {
    return c.json({ error: 'unauthorized' }, 401);
  }

  const body = (await c.req.json().catch(() => null)) as {
    event?: { app_user_id?: string; transferred_from?: string[]; transferred_to?: string[]; type?: string };
  } | null;
  const event = body?.event;
  if (!event) return c.json({ ok: true });

  // A TRANSFER event carries NO app_user_id — only transferred_from/_to arrays.
  // Gating on app_user_id (as this once did) dropped every transfer on the
  // floor, so the account that LOST the subscription was never re-synced and
  // kept premium for free until its stale expiry passed. Sync every id the
  // event names: the losers (to downgrade) and the gainers (to grant).
  const idsToSync =
    event.type === 'TRANSFER'
      ? [...(event.transferred_from ?? []), ...(event.transferred_to ?? [])]
      : event.app_user_id
        ? [event.app_user_id]
        : [];
  if (idsToSync.length === 0) return c.json({ ok: true });

  for (const appUserId of idsToSync) {
    if (appUserId.startsWith('$RCAnonymousID:')) {
      logger.warn({ appUserId }, 'billing webhook: anonymous RC id, skipping — SDK should always be configured with our userId');
      continue;
    }
    if (!(await userExists(appUserId))) {
      logger.warn({ appUserId }, 'billing webhook: no matching user, skipping');
      continue;
    }
    await syncEntitlementFromRevenueCat(appUserId);
  }

  return c.json({ ok: true });
});
