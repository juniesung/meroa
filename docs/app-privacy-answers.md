# Apple App Privacy — answer sheet

> **What this is.** The exact answers to enter in App Store Connect →
> *App Privacy*, transcribed from the code-verified `docs/data-inventory.md`
> (re-verified 2026-07-26). Enter these as-is unless the code has changed since.
>
> **Not legal advice** — engineering transcription. Judgment calls are flagged
> `⚠️`; review them before you submit.

---

## 0. Top-level answers

- **Do you or your third-party partners collect data from this app?** → **Yes.**
- **Data used to track you** → **None.** No advertising identifiers, no data
  brokers, no cross-app/cross-site tracking, no ad networks. Every "Used for
  tracking?" toggle below is **No**.
- Sharing message content with the AI provider is **not** "tracking" (it's
  functional processing) — Apple's App Privacy has no separate "shared with
  third parties" field; that lives in the privacy policy + Google's form.

---

## 1. Data types to declare

For **every** type below: **Linked to the user? Yes** · **Used for tracking? No.**
Only the Apple category, sub-type, and purpose(s) change.

| # | Apple category → data type | Purpose(s) to check | Source |
|---|---|---|---|
| 1 | **Contact Info → Phone Number** | App Functionality | `users.phoneE164` (login identity) |
| 2 | **User Content → Other User Content** | App Functionality, Product Personalization | `messages` (chat), `tasks`, `goals`, `records`, `goal_entries`, `memories` |
| 3 | **Identifiers → User ID** | App Functionality | internal `userId` UUID → RevenueCat |
| 4 | **Identifiers → Device ID** ⚠️ | App Functionality | Expo **push token** (`push_tokens`) — notifications only |
| 5 | **Purchases → Purchase History** | App Functionality | `entitlements` / RevenueCat |
| 6 | **Diagnostics → Crash Data** | App Functionality | Sentry (server) |
| 7 | **Diagnostics → Other Diagnostic Data** | App Functionality | Sentry (server) |

That's the complete list. Everything else Apple offers (Health, Financial account
info, Location, Contacts, Browsing/Search history, Sensitive Info as a *declared
category*, Usage Data, Advertising Data, Audio, Photos, etc.) → **not collected.**

---

## 2. Notes & judgment calls

- **⚠️ #4 Device ID (push token).** An Expo/APNs push token is a functional
  delivery identifier, not an advertising ID. Some devs don't declare it at all;
  we declare it **conservatively** because we store it linked to the user
  (`push_tokens`). Keep it declared unless you decide the functional-token
  exemption applies. Either way, "Used for tracking" stays **No**. *(This exists
  because push is in v1.0 — founder decision 2026-07-26. If push is ever pulled
  from v1.0, drop this row.)*
- **#2 covers the sensitive stuff.** Chat + memories can contain health /
  financial / emotional content. Apple has **no required "sensitive data"
  toggle** in App Privacy (that's Google) — it's covered as *User Content →
  Other User Content*. The privacy policy is where the sensitive-data handling is
  spelled out.
- **#6/#7 Diagnostics are Linked = Yes.** Sentry error context carries the
  server-side `userId` (`data-inventory.md §3`). Purpose is **App Functionality**
  (crash monitoring), **not** Analytics — there is no analytics SDK.
- **Do not add "Analytics" or "Advertising" purposes anywhere.** No analytics
  SDK, no ads (`data-inventory.md §4`). If App Store Connect pre-checks them,
  uncheck them.
- **Phone number purpose = App Functionality only.** It's the login identity, not
  used for marketing.

---

## 3. Cross-check before submitting

1. Re-run the `data-inventory.md` verification (SDKs move).
2. Confirm push is still in the build (`src/lib/push.ts` `getExpoPushTokenAsync`);
   if it was pulled, remove row #4.
3. Make sure the same story matches the **privacy policy** (`docs/legal/
   privacy-draft.md`) and **Google Data Safety** (`data-inventory.md §5`) — all
   three must agree.
