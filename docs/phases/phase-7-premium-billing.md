# Phase 7 — Free & Premium (Billing)

**Status:** ☐ In progress — code complete (RevenueCat, iOS-first, hard paywall + 7-day
trial), blocked on human-side RevenueCat/Apple dashboard setup before the purchase/
restore/cross-device/trial DoD items can be exercised end-to-end. See §Verification
below for exactly what ran and what didn't.
**Goal:** A hard paywall backed by platform billing: a 7-day free trial with full
access, server-verified entitlements, correct restore across devices, and zero access
for anyone without an active trial or subscription.
**Depends on:** Phase 6 (features to gate now exist).

**Implementation notes:** RevenueCat chosen over direct Apple/Google integration (free
under $2.5k/mo revenue, handles the full purchase/renew/cancel/restore lifecycle, and the
`entitlements` table stays the server's own source of truth regardless — RC only
interprets store receipts). The webhook and the client-called `POST /billing/sync` both
refetch RevenueCat's *current* subscriber state rather than applying event payloads, so a
late/duplicate/out-of-order webhook always converges to truth — no event-ordering logic,
no DB migration needed.

**Freemium → hard paywall (this revision):** Phase 7 originally shipped a permanent
limited free tier (20 chat msgs/day, 2 new tasks/day, 1 active goal). That was replaced
after a real per-message API cost model showed freemium's cost is unbounded and
recurring per non-converting user — it accrues for as long as they keep opening the app,
forever, with zero revenue — whereas a bounded trial costs a fixed, one-time amount and
then stops. The new model: **new users get a 7-day free trial with full access; without
converting to paid, every feature is blocked, but nothing is ever deleted** — subscribing
later picks back up exactly where they left off.

The key simplification that made this a small change rather than a rewrite: **RevenueCat
already treats a trialing subscriber as an active entitlement, identical to a paid one**
— `syncEntitlementFromRevenueCat` never reads `period_type`/`is_trial_period`, so both
land as `plan: 'plus'` with no server-side distinction needed. The trial itself needs no
new tracking — it's purely a product configuration (a 7-day introductory free trial
offer on `meroa_plus_monthly` in App Store Connect), and the existing plan-resolution/
sync machinery already handles "active during trial, correctly downgrades to free the
moment it lapses" for free.

Premium unlocks deeper capability and persistence — **not** a more caring personality.

## In scope
- Apple IAP + Google Play Billing, purchase/restore/renewal/expiry/cancel, server-side entitlement checks, and a hard gate on every feature for anyone without an active trial or subscription.

## Trial vs Locked (target $11.99/mo, 7-day free trial)
There is no persistent limited free tier. Two states only:

| State | Access |
|---|---|
| **Trialing or subscribed** (`entitlement.plan === 'plus'`) | Full access to everything — chat (fair-use capped at `PLUS_DAILY_MESSAGES`, currently 100/day, to control abuse/cost regardless of tier), unlimited new tasks, multiple active goals, deep long-term memory, full progress history. |
| **Locked** (never started a trial, or trial/subscription lapsed) | Zero access — chat, task creation, and goal creation are all blocked from the very first attempt (`FREE_DAILY_MESSAGES`/`FREE_DAILY_TASKS`/`FREE_MAX_ACTIVE_GOALS` all default to 0). Nothing is deleted; the app routes straight to the paywall (`src/app/_layout.tsx`'s root nav guard) until they subscribe. |

## Tasks
- [x] Integrate Apple In-App Purchase (iOS) for Meroa Premium, via `react-native-purchases` (RevenueCat). Android deferred — no Play Console account yet; the server side is store-agnostic already.
- [x] Handle the full lifecycle: purchase, **restore**, renewal, expiration, cancellation — via RevenueCat webhook (`POST /billing/webhook`) + client-called `POST /billing/sync`, both converging on RC's current subscriber state.
- [x] **Server-side entitlement verification** — `entitlements` table stays the source of truth (`lib/billing/entitlement.ts`); `resolvePlan()` lazily treats an expired `plus` row as free everywhere, closing the missed-webhook gap. Sync-on-purchase/restore + AppState-driven query refetch handles cross-device consistency.
- [x] **Hard-gate everything on plan status** — `FREE_DAILY_MESSAGES`/`FREE_DAILY_TASKS`/`FREE_MAX_ACTIVE_GOALS` all default to 0 (`env.ts`), so `lib/limits.ts`/`lib/usage.ts`'s existing `allowed: used < limit` check blocks a locked-out user from their very first attempt at any of the three, with no new gating logic needed. `PLUS_DAILY_MESSAGES` (100/day) remains as the sole fair-use cap for anyone with active access.
- [x] **Root navigation gate** (`src/app/_layout.tsx`) — a signed-in user is routed through, in order: onboarding (if `prefs.communicationStyle` is unset) → paywall (if not `plan === 'plus'`) → tabs. Nothing past onboarding is reachable without an active trial or subscription.
- [x] **Pre-paywall onboarding questionnaire** (`src/app/onboarding.tsx`, added 2026-07-19) — a motivational multi-step flow shown before the paywall: focus areas (multi-select — habit, savings, tracking, milestone, or "just company") and communication style (reusing `VibeOptionList`, replacing the old standalone `vibe-pick` screen — see `docs/phases/phase-6-personalization-memory-trust.md`). Framed around two real, cited studies (Matthews on written goals + accountability check-ins; Lally et al. on habit-formation timelines) — copy doesn't invent or round these further. Focus picks are written as `preference` memories (`POST /memories`, `source: 'manual'`); the style pick goes through the existing `PATCH /me/prefs`, whose cache update flips the root guard's `needsOnboarding` reactively — no imperative navigation, same hand-off pattern the purchase flow uses.
- [x] Paywall screen (`src/app/paywall.tsx`) showing live price (from RC offerings, never hardcoded), trial length (from the product's `introPrice`, never hardcoded), billing period, auto-renewal, cancellation, and Privacy/Terms links (placeholder URLs pending Phase 8) **before** purchase. Checks trial eligibility (`Purchases.checkTrialOrIntroductoryPriceEligibility`) so a user who already used their trial (e.g. reinstalled) sees a plain subscribe flow instead of a false trial promise. Reused for both the mandatory hard-paywall landing screen and the existing voluntary upgrade entry points (Settings, cap-hit banners) — the close button only shows when there's actually somewhere to dismiss back to.
- [ ] Tool creation gating, memory/history windows, and proactive frequency are **not yet built** (Tools tab was superseded by Goals per §9; memory/history windows deferred) — moot in the locked state (everything is blocked there already), but not yet distinguished as separate capability tiers within the active state either.

## Definition of Done
- [ ] A test purchase starts the 7-day trial and unlocks premium; deleting/reinstalling and restoring re-grants it via server verification. **Blocked** — needs the RevenueCat Test Store product/offering **and the 7-day trial introductory offer** configured in the dashboard (see prerequisites below) and a dev build run on a real device/simulator.
- [x] Locked-out users (no active trial or subscription) are blocked server-side on chat, task creation, and goal creation from the very first attempt, and can't be bypassed from the client — the root nav guard reinforces this by never showing the tab bar at all. Verified live via curl against the zero defaults — see §Verification.
- [ ] Entitlement is consistent across two devices signed into the same account. **Blocked** — same RC dashboard dependency; the mechanism (sync + AppState-driven refetch) is in place but unexercised against real cross-device state.
- [x] The paywall discloses price/trial terms/renewal/cancellation clearly before any charge — implemented, including dynamic trial-eligibility-aware copy; visual/on-device review still pending (needs a dev build, see below).

### Human prerequisites before the blocked items can close
1. RevenueCat account + project; iOS app added (bundle `com.meroa.app`).
2. Entitlement id `plus`; product `meroa_plus_monthly` ($11.99/mo); offering `default` with a `$rc_monthly` package.
3. **A 7-day free trial introductory offer configured on `meroa_plus_monthly` in App Store Connect** — this is what actually makes `Purchases.purchasePackage()` start a trial instead of charging immediately; no app or server code causes this, it's store configuration. New requirement on top of the two items above.
4. **Test Store** key (`test_…`) → app `.env`'s `EXPO_PUBLIC_REVENUECAT_IOS_KEY`; secret key (`sk_…`) → server `.env`'s `REVENUECAT_SECRET_API_KEY`.
5. `npx expo install` already ran; still needed: `npx expo run:ios` (or a dev-client build) to actually exercise the paywall and a real purchase — Expo Go can't load native IAP modules.
6. Optional for now: webhook URL + `REVENUECAT_WEBHOOK_SECRET` (a local tunnel is only needed to test the webhook path itself; `/billing/sync` + `npm run dev:plan` already cover the entitlement loop without one).

### Server-side verification already run (no RC account needed)
- **Historical, under the old 20/2/1 freemium caps** (still an accurate record of the mechanism, now superseded by the zero-based limits above): task/goal creation caps, undo-refunds-quota, plus-lifts-caps, and lazy plan expiry — all confirmed live via curl against a fresh dev-token account. Chat-at-limit: confirmed `create_task` minted no preview card when the free task cap was hit. `billing_unconfigured` 503 confirmed on both `/billing/sync` and `/billing/webhook` before RC keys exist. Full regression at the time: `npm run battery` (56 DB assertions) and `npx vitest run` (215/215) both green; `tsc --noEmit` clean on both trees.
- **Zero-default verification, done (2026-07-19)**: curl-confirmed a fresh free-plan account 429s on its very first chat message/task/goal (not after N: `{error:'limit_reached', limit:0, used:0}`), and flipping to `plus` via `npm run dev:plan` unlocks all three unchanged. `tsc --noEmit`/`vitest` (215/215) clean on both trees.
- **`battery` test-hygiene gap found, not yet fixed**: `scripts/battery.sh` reuses a fixed default phone (`+15559000001`) with no reset between runs. After many runs across sessions, count-based assertions (e.g. "exactly one manually-created savings goal") started failing against real leftover data, not a code regression — confirmed by wiping the account and re-running clean (55/56 passed, the one remaining failure a live-model wording variance, not a defect). Fix later: either randomize the default phone or wipe it at the start of the script.
- **Full signup→onboarding→paywall flow verified live** in the iOS simulator (2026-07-19): fresh account through real OTP verify → onboarding (all 5 focus areas + "direct" style picked) → landed on paywall with no manual navigation. DB-confirmed: `prefs.communicationStyle` set correctly, one `preference` memory created per selected focus area. Paywall correctly showed plain subscribe copy (not trial copy) since the RevenueCat trial introductory offer isn't configured yet — expected, not a bug.

## Guardrails
- Platform billing only; never trust a client-supplied entitlement.
- No persistent free tier — trial and paid both get full access; locked means zero access to creation and chat, but never data loss.
- Premium changes capability, not warmth.
