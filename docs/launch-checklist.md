# Launch checklist

Living list of everything between here and a submitted app. Last updated **2026-07-28**.

Ordered by what unblocks what — the critical path is **§1 → §2**. Sections 3–6 are
parallelizable, but none of them close a Definition of Done the way the device test does.

---

## Done 2026-07-28 (this session) — the hard engineering gates are cleared

- **Auth: Sign in with Apple, live on device.** SMS-OTP login was a console stub
  (no one could sign in); pivoted off Firebase (blocked on a $50 Blaze hold) to
  Sign in with Apple. Server `/auth/apple` (verify token → key on Apple id →
  session), client native button, `users.phone_e164` now nullable + `apple_user_id`,
  and Apple token **revocation on account deletion** (guideline 5.1.1(v)) with the
  `.p8` key wired (local `.env` + Railway). **Verified: sign-in works on device.**
- **Billing verified on device.** A sandbox purchase completes → entitlement →
  app unlocks. The previously "configured but unproven" Phase 7 items now proven.
  *(Restore + cross-device still to confirm — see §2.)*
- **All Tier 1 compliance (docs/prelaunch-audit.md):** age gate (hard-block <13),
  persistent + recurring-3h AI disclosure, deterministic crisis protocol
  (detect → fixed 988 response, published `/safety` page), reset-conversation,
  roleplay red-team (model held).
- **Tier 2 ops:** token logging, `/health` DB ping, SIGTERM graceful drain,
  OpenAI/RevenueCat timeouts, log/Sentry scrubbing. Figure-guard root fix
  (typed figures — no more false retractions on world numbers).
- **Deploy hygiene:** migrations now run on deploy (Dockerfile), so schema changes
  reach prod automatically. Dev + prod share one Supabase DB (already migrated).

---

## Already done (2026-07-21) — Apple + RevenueCat setup

Recorded so it isn't re-litigated:

- App Store Connect app record created (`com.meroa.app`).
- **Paid Applications agreement Active** — contacts, bank account, tax forms all cleared.
  This gated everything downstream; products don't load until it's Active.
- Subscription group `Meroa membership` → product **`meroa_monthly`**, $11.99/mo,
  localization filled, **7-day free trial introductory offer** configured.
- In-App Purchase key (`.p8` + Key ID + Issuer ID) generated and uploaded to RevenueCat.
- Sandbox tester account created (US region).
- RevenueCat: App Store app added to the existing `Meroa` project, product imported,
  entitlement **`plus`**, offering **`default`** marked default with the App Store *and*
  Test Store products in the `$rc_monthly` package.
- `.env` → `EXPO_PUBLIC_REVENUECAT_IOS_KEY=appl_…` (Test Store key kept commented one
  line below for the simulator path).
- `server/.env` + Railway → new `sk_…` secret key, `REVENUECAT_ENTITLEMENT_ID=plus`,
  `REVENUECAT_WEBHOOK_SECRET`.
- RevenueCat webhook → `https://meroa-production.up.railway.app/billing/webhook`,
  all events, both environments, no paywall events.

**Verified from the CLI:** secret key authenticates against the RevenueCat **v1** API
(our two call sites in `server/src/lib/billing/revenuecat.ts` are v1); webhook returns
401 on a bad auth header and 200 on a good one, which proves both Railway secrets are
live. `tsc --noEmit` clean on both trees.

**Configured but unproven** — none of this can be tested without a build: that the
`default` offering actually resolves as current, that the 7-day trial imported and
surfaces as `introPrice`, that `REVENUECAT_ENTITLEMENT_ID=plus` took on Railway.

---

## 1. Code — do first (small)

- [x] **`userExists` UUID guard** — **already fixed** in commit `49a5174` (same
      commit that scoped CORS). `billing.ts` now guards with `UUID_RE.test()` before
      the `users.id` query, and the webhook only syncs after `userExists` + the
      anonymous-id check pass, so a non-UUID `app_user_id` (RevenueCat's "Send test
      event") is skipped, never 500s. This item was stale. No code change needed.

## 2. Dev build — unblocks the most

- [x] Dev build on device (`npx expo run:ios`) — done; Sign in with Apple works.

Everything here depends on it:

- [x] **Phase 7 DoD** — sandbox purchase completes, entitlement granted, app unlocks
      (verified on device 2026-07-28).
- [x] `default` offering resolves + purchase sheet loads (proven by the purchase above).
- [ ] **Phase 7 DoD** — delete/reinstall → restore re-grants via server verification
- [ ] **Phase 7 DoD** — entitlement consistent across two devices, same account
- [ ] Confirm `introPrice` reads 7 days (the trial copy on the paywall)
- [ ] **Push-token registration** (Expo Go can't get push tokens) → unblocks Tier 2
- [ ] **Phase 8 manual checks, on device**: AI-consent nav flow, delete/export
      UI, report-a-response UI, notification tap routing, error/offline states
- [x] Paywall visual review on device (rendered; purchase flow works).

Sandbox notes: sign the tester in under **Settings → Developer → Sandbox Apple Account**,
not the App Store. Trial eligibility is per-account and sticks — mint a fresh
`+sbx2` alias to re-test the "new user sees trial copy" path.

## 3. Notifications — to actually go live

- [ ] Set `CRON_SECRET` on Railway (unset ⇒ `/internal/tick` 404s ⇒ push is off in prod)
- [ ] Configure Railway cron → `POST /internal/tick`

## 4. Store portal

- [x] **DSA trader declaration** — **RESOLVED (2026-07-26): drop EU.** Meroa is a paid
      sub ⇒ a trader, so the choice was declare-trader (publish a verified address on EU
      product pages) or drop the EU. Decided to drop the **27 EU member states** in
      Pricing and Availability (no address published anywhere; fully reversible later).
      *Remaining ASC action:* deselect those territories when setting Pricing & Availability.
- [ ] Subscription **review screenshot** + review notes (needed to submit, not to test)
- [ ] App listing: name, subtitle, description, keywords, screenshots, support URL,
      privacy URL, age rating
      - [x] Copy finalized — name/subtitle/keywords/description/promo, category, captions
        in `docs/app-store-listing.md` (ASO-optimized, 2026-07-26).
      - [x] Support/Privacy URLs fixed → live Railway pages (`/support`, `/privacy`,
        `/terms` all return 200); dead `meroa.app` links removed.
      - [ ] ⚠ Screenshots need re-export — the four produced are 941×1672 (too small +
        wrong aspect); re-render at **1320×2868 (6.9")**, taller ~0.46 composition.
      - [ ] Enter it all in App Store Connect + set age rating.
- [ ] **App Privacy questionnaire** (Apple) + **Data Safety** (Google) — mapping done in
      `docs/data-inventory.md`
      - [x] Apple answers finalized + click-by-click in `docs/app-privacy-answers.md`,
        re-verified against live code (2026-07-26). *Remaining:* enter in ASC (publishable
        independent of a build).
- [ ] Export-compliance / encryption declaration

## 5. Legal review gate — blocks public launch

- [x] Review `docs/legal/*-draft.md`; fill the `[PLACEHOLDER]` tokens — **done**: no real
      placeholders remain (grep hits are just header instructions), entity = Jun Kwon
      individual, DeepSeek→OpenAI story clean, founder-reviewed (`legal-copy-decisions`).
      *Still advisable:* attorney review before a large-scale launch (not a submit blocker).
- [x] Scope CORS — **already done**: `server/src/index.ts` denies all cross-origin in
      production (`CORS_ORIGINS` allowlist, empty by default); `*` only in non-prod. Stale item.
- [x] Deploy /privacy /terms /support publicly — **live** on Railway, all return 200.

## 6. Housekeeping

- [ ] **Enroll in the App Store Small Business Program** — drops Apple's cut 30% → 15%
      (you're under $1M/yr). A quick App Store Connect form; do before real revenue.
- [ ] Put the 3 **Apple Sign In** secrets in **Railway** — done (`APPLE_TEAM_ID`,
      `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY`). Enable the **"Sign in with Apple" capability**
      for `com.meroa.app` in the Apple Developer identifier if not already.
- [ ] Merge `phase-8-partial` → `main` (unmerged, many commits)
- [ ] Revoke the old `sk_XFiU…` RevenueCat secret key if still active
- [ ] `scripts/battery.sh` reuses a fixed phone (`+15559000001`) with no reset —
      count-based assertions drift against leftover data across runs

**App Review note (nice):** with Sign in with Apple, the reviewer signs in with their
own Apple ID — no demo credentials to provide. Just note the sandbox for the subscription.
