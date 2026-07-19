// Server-side plan truth (CLAUDE.md §2: never trust a client-asserted plan).
// A `plan='plus'` row with a past `expiresAt` must read as free everywhere —
// otherwise a missed/delayed RevenueCat webhook leaves a lapsed subscriber on
// Plus indefinitely. Centralizing this as one lazy check (rather than relying
// on the webhook to always downgrade in time) means correctness doesn't
// depend on network delivery.
//
// Hard paywall: RevenueCat treats a trialing subscriber as an active
// entitlement identically to a paid one — syncEntitlementFromRevenueCat never
// distinguishes trial from paid, both land here as `plan: 'plus'`. So 'plus'
// really means "has active access (trial or paid)" and 'free' means "no
// access at all" (see lib/limits.ts, lib/usage.ts) — there's no persistent
// graduated free tier anymore, just active vs. locked-until-they-subscribe.
export type EntitlementRow = { plan: string; expiresAt: Date | null } | undefined;

export function resolvePlan(row: EntitlementRow): 'free' | 'plus' {
  if (!row || row.plan !== 'plus') return 'free';
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return 'free';
  return 'plus';
}
