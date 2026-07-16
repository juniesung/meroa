// Server-side plan truth (CLAUDE.md §2: never trust a client-asserted plan).
// A `plan='plus'` row with a past `expiresAt` must read as free everywhere —
// otherwise a missed/delayed RevenueCat webhook leaves a lapsed subscriber on
// Plus indefinitely. Centralizing this as one lazy check (rather than relying
// on the webhook to always downgrade in time) means correctness doesn't
// depend on network delivery.
export type EntitlementRow = { plan: string; expiresAt: Date | null } | undefined;

export function resolvePlan(row: EntitlementRow): 'free' | 'plus' {
  if (!row || row.plan !== 'plus') return 'free';
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return 'free';
  return 'plus';
}
