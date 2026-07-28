# Launch to-do — what's left (punch list)

> Just the OPEN items to ship, ordered. The engineering is done (auth + billing
> verified on device 2026-07-28). Everything below is portal/asset/build work.
> Full context in `docs/launch-checklist.md`; content for the store lives in the
> `docs/*.md` referenced below.

## A. Finish on-device checks (quick, you're already set up)
- [ ] **Restore Purchases** — delete/reinstall the app, tap Restore → premium re-grants.
- [ ] **Cancel** — sandbox subs expire in minutes; confirm the app re-locks after.
- [ ] Confirm the paywall shows the **7-day trial** copy (`introPrice`).

## B. Apple Developer (one toggle, if not done)
- [ ] Enable the **"Sign in with Apple" capability** for App ID `com.meroa.app`
      (Identifiers → com.meroa.app → check Sign in with Apple → Save). The `.p8`
      key is already wired (local `.env` + Railway).

## C. Screenshots
- [ ] Export the marketing screenshots at **1320×2868** (6.9"). The earlier set was
      the wrong size. Captions/shot list in `docs/app-store-listing.md` §6.

## D. App Store Connect data entry (all copy is written — just paste)
- [ ] **Listing** — name / subtitle / keywords / description / promo → `docs/app-store-listing.md`.
- [ ] **App Privacy** questionnaire → `docs/app-privacy-answers.md` (click-by-click).
- [ ] **Pricing & Availability** — deselect the **27 EU territories** (DSA: drop EU).
- [ ] **Age rating** questionnaire (min age 13).
- [ ] **Subscription review screenshot** + review notes. Note: reviewer signs in
      with their own Apple ID (no demo creds); mention the sandbox for the sub.
- [ ] **Export-compliance** declaration (HTTPS only — already `ITSAppUsesNonExemptEncryption:false`).
- [ ] Set **Privacy Policy URL** = `https://meroa-production.up.railway.app/privacy`
      (move to a custom domain later, editable, no resubmit).

## E. Build & submit
- [ ] `eas build --profile production --platform ios`
- [ ] `eas submit`
- [ ] Hit **Submit for Review**.

## F. Housekeeping (before/around launch)
- [ ] Enroll in the **App Store Small Business Program** (30% → 15% cut; you qualify).
- [ ] Put the 3 Apple Sign In secrets in Railway — **done**; just confirm the capability (B).
- [ ] Merge `phase-8-partial` → `main`.
- [ ] Revoke the old `sk_XFiU…` RevenueCat secret key if still active.

## G. Website (separate `meroa-web` repo, in progress elsewhere)
- [ ] Build the Next.js marketing site (scripted example-chat showcase → App Store).
      Self-contained spec: `docs/meroa-web-handoff.md`. Needs a domain + the real
      App Store `app-id` (exists once the app is submitted).

## Not blocking submission (do later)
- [ ] Notifications: set `CRON_SECRET` on Railway + configure the Railway cron.
- [ ] Attorney review of the legal copy (founder-reviewed; advisable pre-scale).
- [ ] Tier 3 DB scale work (`records`/FK indexes, pool ceiling) — only at volume.
