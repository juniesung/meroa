import { env } from '../../env.ts';

export type RevenueCatEntitlementState = { active: boolean; expiresAt: Date | null };

// RevenueCat's subscriber-state REST API — the server never trusts a client-
// supplied plan or a webhook event payload; both the webhook and
// /billing/sync (entitlement.ts) call this to read RC's CURRENT truth and
// upsert `entitlements` from it. GET auto-creates the subscriber record on
// RC's side if it doesn't exist yet — harmless (Configuring the SDK with our
// own userId as appUserID means one always exists by the time this is
// called from an authenticated route).
export async function fetchSubscriberEntitlement(appUserId: string): Promise<RevenueCatEntitlementState> {
  if (!env.REVENUECAT_SECRET_API_KEY) {
    throw new Error('REVENUECAT_SECRET_API_KEY is not configured');
  }

  const res = await fetch(
    `https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(appUserId)}`,
    { headers: { Authorization: `Bearer ${env.REVENUECAT_SECRET_API_KEY}` } },
  );

  if (!res.ok) {
    // A 5xx (or any non-2xx) means RC's truth is temporarily unreachable —
    // throw rather than silently returning "inactive", so callers keep the
    // existing entitlements row instead of downgrading a real subscriber on
    // a transient RC outage.
    throw new Error(`revenuecat subscriber fetch failed: ${res.status}`);
  }

  const body = (await res.json()) as {
    subscriber?: { entitlements?: Record<string, { expires_date?: string | null }> };
  };
  const entitlement = body.subscriber?.entitlements?.[env.REVENUECAT_ENTITLEMENT_ID];
  if (!entitlement) return { active: false, expiresAt: null };

  const expiresAt = entitlement.expires_date ? new Date(entitlement.expires_date) : null;
  const active = !expiresAt || expiresAt.getTime() > Date.now();
  return { active, expiresAt };
}

// Best-effort teardown of the RevenueCat subscriber on account deletion. This
// does NOT cancel the store subscription (only Apple/Google can — the user is
// told to do that in the delete confirmation copy); it removes RC's record so a
// later webhook can't resurrect an `entitlements` row for a user we've deleted.
// Deliberately throws on failure so the caller can log it, but the caller MUST
// wrap this so a RC outage never blocks the local hard delete. Returns false
// (no-op) when billing isn't configured.
export async function deleteSubscriber(appUserId: string): Promise<boolean> {
  if (!env.REVENUECAT_SECRET_API_KEY) return false;

  const res = await fetch(
    `https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(appUserId)}`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${env.REVENUECAT_SECRET_API_KEY}` } },
  );
  // 404 means there was no subscriber record to begin with — that's success for
  // our purposes (nothing left to resurrect us).
  if (!res.ok && res.status !== 404) {
    throw new Error(`revenuecat subscriber delete failed: ${res.status}`);
  }
  return true;
}
