# Phase 8 — Release Readiness

**Status:** ☐ Not started
**Goal:** Everything required to ship to the App Store and Play Store — treated as product
features (privacy, deletion, permissions, review access), not a last-afternoon scramble.
**Depends on:** Phases 0–7 (a complete, working app).

## In scope
- Notifications polish, deep links, legal/support pages, account deletion (in-app + web), data export, privacy disclosures, device testing, store metadata, and production build/submit.

## Tasks
**Product & account**
- [ ] Complete app: no placeholder screens, broken buttons, or inaccessible features.
- [ ] Public **privacy policy**, **terms of use**, **support page**, and a contact method.
- [ ] **In-app account deletion** + a **web** deletion path (Google Play requires the web path when accounts exist).
- [ ] **Data export** and per-memory deletion as distinct controls.
- [ ] Clear AI disclosure throughout; no unsupported medical/financial claims.

**Notifications & links**
- [ ] Finalize Expo Notifications (reminders, follow-ups, conversation alerts) on both platforms; respect quiet hours/limits from Phase 6.
- [ ] Deep links open the right task/tool with context attached.

**Subscriptions & store**
- [ ] Verify purchase/restore/renewal/expiry/cancel + server entitlement checks end-to-end (from Phase 7). **Still blocked as of this writing** on the same Phase 7 dependency: RevenueCat + Apple App Store Connect sandbox/dashboard setup (product config, sandbox tester, entitlement linking) needs to happen before this can be verified — do this first if it hasn't already.
- [ ] App icon, screenshots, description, categories, age/content rating, support URL, privacy disclosures.
- [ ] Complete Apple **App Privacy** and Google **Data safety** forms from an accurate inventory of every SDK and data type collected.
- [ ] **Reviewer access:** working credentials + instructions to reach Chat, Tasks, Tools, and Premium **without** depending on a live SMS flow.

**Permissions & quality**
- [ ] Request notifications/mic/photos/location **only when the related feature is used**. (The composer's mic icon today is a decorative Phase-0 placeholder — no `onPress`, no speech-to-text integration exists. Either build a real voice-input feature first, or drop the icon before store submission so there's no dead-end control in the shipped app.)
- [ ] Test on physical iOS + Android: keyboard, notifications, billing, account deletion, offline states, accessibility.
- [ ] Production binaries via **EAS Build**; submit via **EAS Submit** or store portals.
- [ ] Re-check current store policies and the required Android target API immediately before submitting.

## Definition of Done
- App passes internal review on real devices with all of the above working.
- Account deletion works both in-app and via the web path; data export produces the user's data.
- Privacy/Data-safety forms match the real SDK/data inventory; reviewer credentials reach every surface without SMS.
- Production builds are uploaded and accepted into review.

## Guardrails
- Privacy, deletion, billing, permissions, and review access are **features** — built and tested, not bolted on.
- Permissions are requested at point-of-use, never up front.
