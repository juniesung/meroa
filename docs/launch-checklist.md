# Launch checklist

Living list of everything between here and a submitted app. Last updated **2026-07-21**.

Ordered by what unblocks what — the critical path is **§1 → §2**. Sections 3–6 are
parallelizable, but none of them close a Definition of Done the way the device test does.

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

- [ ] **`userExists` UUID guard** — `server/src/routes/billing.ts:26` passes
      `app_user_id` straight into a `uuid` equality check, so a non-UUID id throws a
      500 instead of being skipped. Breaks RevenueCat's "Send test event" button and
      risks retry-backoff marking the webhook unhealthy. The anonymous-id case is
      already guarded at line 70 — this is the same class of defect, unhandled variant.

## 2. Dev build — unblocks the most

- [ ] `eas build --profile development --platform ios`, install on a physical device

Everything here depends on it:

- [ ] **Phase 7 DoD** — test purchase starts the 7-day trial and unlocks premium
- [ ] **Phase 7 DoD** — delete/reinstall → restore re-grants via server verification
- [ ] **Phase 7 DoD** — entitlement consistent across two devices, same account
- [ ] Confirm the `default` offering resolves and `introPrice` reads 7 days
- [ ] **Push-token registration** (Expo Go can't get push tokens) → unblocks Tier 2
- [ ] **Phase 8 manual checks, never run on device**: AI-consent nav flow, delete/export
      UI, report-a-response UI, notification tap routing, error/offline states
- [ ] Paywall visual review on device

Sandbox notes: sign the tester in under **Settings → Developer → Sandbox Apple Account**,
not the App Store. Trial eligibility is per-account and sticks — mint a fresh
`+sbx2` alias to re-test the "new user sees trial copy" path.

## 3. Notifications — to actually go live

- [ ] Set `CRON_SECRET` on Railway (unset ⇒ `/internal/tick` 404s ⇒ push is off in prod)
- [ ] Configure Railway cron → `POST /internal/tick`

## 4. Store portal

- [ ] **DSA trader declaration** — unresolved. Non-trader ⇒ must also remove the 27 EU
      territories in Pricing and Availability. Reversible later; trader status requires
      publishing a real address on the product page.
- [ ] Subscription **review screenshot** + review notes (needed to submit, not to test)
- [ ] App listing: name, subtitle, description, keywords, screenshots, support URL,
      privacy URL, age rating
- [ ] **App Privacy questionnaire** (Apple) + **Data Safety** (Google) — the mapping is
      already done in `docs/data-inventory.md`
- [ ] Export-compliance / encryption declaration

## 5. Legal review gate — blocks public launch

- [ ] Review `docs/legal/*-draft.md`; fill the `[PLACEHOLDER]` tokens (legal entity name)
- [ ] Scope CORS in `server/src/routes/legal.ts` — currently `*`, dev-only
- [ ] Deploy /privacy /terms /support publicly

## 6. Housekeeping

- [ ] Merge `phase-8-partial` → `main` (unmerged, 15+ commits)
- [ ] Revoke the old `sk_XFiU…` RevenueCat secret key if still active
- [ ] `scripts/battery.sh` reuses a fixed phone (`+15559000001`) with no reset —
      count-based assertions drift against leftover data across runs
