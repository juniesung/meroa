# Phase 7 — Free & Premium (Billing)

**Status:** ☐ In progress — code complete (RevenueCat, iOS-first), blocked on human-side
RevenueCat/Apple dashboard setup before the purchase/restore/cross-device DoD items can
be exercised end-to-end. See §Verification below for exactly what ran and what didn't.
**Goal:** A paywall backed by platform billing with server-verified entitlements, correct
restore across devices, and free-plan limits that meter the right things.
**Depends on:** Phase 6 (features to gate now exist).

**Implementation notes:** RevenueCat chosen over direct Apple/Google integration (free
under $2.5k/mo revenue, handles the full purchase/renew/cancel/restore lifecycle, and the
`entitlements` table stays the server's own source of truth regardless — RC only
interprets store receipts). The webhook and the client-called `POST /billing/sync` both
refetch RevenueCat's *current* subscriber state rather than applying event payloads, so a
late/duplicate/out-of-order webhook always converges to truth — no event-ordering logic,
no DB migration needed. Core-three free limits only this phase (chat cap, 2 new
tasks/day, 1 active goal) — memory/history-window gating deferred, per the phase-6
"build the capability, gate it here" note not yet acted on for those two.

Premium unlocks deeper capability and persistence — **not** a more caring personality.

## In scope
- Apple IAP + Google Play Billing, purchase/restore/renewal/expiry/cancel, server-side entitlement checks, and enforcement of free vs premium limits.

## Free vs Premium (target $19.99/mo)
| Capability | Free | Premium |
|---|---|---|
| Chat | Limited fair-use | Higher fair-use |
| Tasks | ≤ 2 **new** per day | Unlimited (reasonable) |
| Goals | 1 active | Multiple |
| Custom tools | Preview only / unavailable | Create, edit, use many |
| Memory | Basic profile + short context | Deeper long-term memory/patterns |
| Proactive support | Occasional/limited | Configurable follow-ups + summaries |
| Progress history | Short window | Long-term, richer views |

## Tasks
- [x] Integrate Apple In-App Purchase (iOS) for Meroa Premium, via `react-native-purchases` (RevenueCat). Android deferred — no Play Console account yet; the server side is store-agnostic already.
- [x] Handle the full lifecycle: purchase, **restore**, renewal, expiration, cancellation — via RevenueCat webhook (`POST /billing/webhook`) + client-called `POST /billing/sync`, both converging on RC's current subscriber state.
- [x] **Server-side entitlement verification** — `entitlements` table stays the source of truth (`lib/billing/entitlement.ts`); `resolvePlan()` lazily treats an expired `plus` row as free everywhere, closing the missed-webhook gap. Sync-on-purchase/restore + AppState-driven query refetch handles cross-device consistency.
- [x] Enforce free-plan limits server-side (core three): 2 new tasks/day and 1 active goal (`lib/limits.ts`, enforced atomically in `routes/tasks.ts`/`routes/goals.ts`), on top of the existing chat cap. Completion/progress/updates are never metered. Tool creation gating, memory/history windows, and proactive frequency are **not yet built** (Tools tab was superseded by Goals per §9; memory/history windows deferred).
- [x] Paywall screen (`src/app/paywall.tsx`) showing live price (from RC offerings, never hardcoded), billing period, auto-renewal, cancellation, and Privacy/Terms links (placeholder URLs pending Phase 8) **before** purchase.

## Definition of Done
- [ ] A test purchase unlocks premium; deleting/reinstalling and restoring re-grants it via server verification. **Blocked** — needs the RevenueCat Test Store product/offering configured in the dashboard (see prerequisites below) and a dev build run on a real device/simulator.
- [x] Free limits are enforced server-side and can't be bypassed from the client; **completing** tasks/updating progress is never blocked. Verified live via curl: 2 tasks succeed, 3rd 429s; complete/edit still 200 at the cap; 1 goal succeeds, 2nd 429s; archiving frees the slot; undo refunds quota; plus plan lifts both; an expired-but-still-`plan=plus'` row lazily resolves to free.
- [ ] Entitlement is consistent across two devices signed into the same account. **Blocked** — same RC dashboard dependency; the mechanism (sync + AppState-driven refetch) is in place but unexercised against real cross-device state.
- [x] The paywall discloses price/terms/renewal/cancellation clearly before any charge — implemented; visual/on-device review still pending (needs a dev build, see below).

### Human prerequisites before the blocked items can close
1. RevenueCat account + project; iOS app added (bundle `com.meroa.app`).
2. Entitlement id `plus`; product `meroa_plus_monthly` ($19.99/mo); offering `default` with a `$rc_monthly` package.
3. **Test Store** key (`test_…`) → app `.env`'s `EXPO_PUBLIC_REVENUECAT_IOS_KEY`; secret key (`sk_…`) → server `.env`'s `REVENUECAT_SECRET_API_KEY`.
4. `npx expo install` already ran; still needed: `npx expo run:ios` (or a dev-client build) to actually exercise the paywall and a real purchase — Expo Go can't load native IAP modules.
5. Optional for now: webhook URL + `REVENUECAT_WEBHOOK_SECRET` (a local tunnel is only needed to test the webhook path itself; `/billing/sync` + `npm run dev:plan` already cover the entitlement loop without one).

### Server-side verification already run (no RC account needed)
- Task/goal creation caps, undo-refunds-quota, plus-lifts-caps, and lazy plan expiry — all confirmed live via curl against a fresh dev-token account (see commit history / session notes).
- Chat-at-limit: confirmed `create_task` mints **no preview card** when the free task cap is hit (server-authored failure fact quotes the real numbers, NARRATE states it honestly, no card that would 429 on tap) — restores once flipped to `plus` via `npm run dev:plan`.
- `billing_unconfigured` 503 confirmed on both `/billing/sync` and `/billing/webhook` before RC keys exist.
- Full regression: `npm run battery` (56 DB assertions passed, 0 failed, 0 abnormal chat flagged) and `npx vitest run` (215/215) both green post-change; `tsc --noEmit` clean on both the app and server trees.

## Guardrails
- Platform billing only; never trust a client-supplied entitlement.
- Meter **new task creation** on free — nothing about completion or progress.
- Premium changes capability, not warmth.
