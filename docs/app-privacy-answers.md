# Apple App Privacy — answer sheet

> **What this is.** The exact answers to enter in App Store Connect →
> *App Privacy*, transcribed from the code-verified `docs/data-inventory.md`.
> Enter these as-is unless the code has changed since.
>
> **Re-verified 2026-07-30** — reconciled with the **Sign in with Apple** pivot
> (auth changed from phone/SMS-OTP to Apple; the old sheet still listed Phone
> Number as the login identity). Live code scan: client SDK dependency scan (only
> `react-native-purchases` touches data — no analytics/ads/location/contacts/
> health/camera SDKs), `app.json` plugins + `infoPlist` (no tracking usage-string,
> no location/photo/mic permissions), push token still minted (`src/lib/push.ts`),
> RevenueCat keyed to our `userId` (`features/billing/purchases.ts`), Sentry
> server-only (`@sentry/node`).
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
| 1 | **Contact Info → Name** | App Functionality | `users.displayName` — Apple's first-sign-in `fullName` (Sign in with Apple), stored as the display name |
| 2 | **User Content → Other User Content** | App Functionality, Product Personalization | `messages` (chat), `tasks`, `goals`, `records`, `goal_entries`, `memories` |
| 3 | **Identifiers → User ID** | App Functionality | Apple user id (`users.appleUserId`) + internal `userId` UUID → RevenueCat app_user_id |
| 4 | **Identifiers → Device ID** ⚠️ | App Functionality | Expo **push token** (`push_tokens`) — notifications only |
| 5 | **Purchases → Purchase History** | App Functionality | `entitlements` / RevenueCat |
| 6 | **Diagnostics → Crash Data** | App Functionality | Sentry (server) |
| 7 | **Diagnostics → Other Diagnostic Data** | App Functionality | Sentry (server) |

That's the complete list. Everything else Apple offers (Health, Financial account
info, Location, Contacts, Browsing/Search history, Sensitive Info as a *declared
category*, Usage Data, Advertising Data, Audio, Photos, etc.) → **not collected.**

---

## 2. Notes & judgment calls

- **Phone Number is NO LONGER declared.** Auth is **Sign in with Apple only** —
  the client (`src/app/(auth)/sign-in.tsx`) presents only the Apple button. A
  phone/OTP route still exists server-side but is **unreachable from the shipping
  app**, so the app does not collect a phone number. (`users.phoneE164` is
  nullable and stays null for every Apple account.) Do not declare Contact Info →
  Phone Number.
- **⚠️ Name (#1).** Sign in with Apple returns the user's name **once, on first
  sign-in, only if they don't hide it**; the client forwards it and the server
  stores it as `users.displayName`. Because it's stored, declare **Contact Info →
  Name**. Purpose is App Functionality (personal greeting/display), never
  marketing.
- **⚠️ Email — requested but NOT stored → not declared (transient-processing
  exemption).** The client requests the `EMAIL` scope, so Apple puts the email in
  the identity token sent to our server, and `apple-auth.ts` decodes it — but
  there is **no email column** and it is **never persisted or used** (discarded
  after token verification). Under Apple's "collect" definition (accessed no
  longer than needed to service the request in real time) this qualifies for the
  transient-processing exemption, so **Email Address is not declared**.
  **Cleaner long-term fix:** drop the `EMAIL` scope from `sign-in.tsx` (we don't
  use it) — removes the ambiguity entirely. *Founder decision — if you'd rather
  play it safe, declare Contact Info → Email Address (App Functionality, Linked
  Yes, Tracking No) instead.*
- **⚠️ #4 Device ID (push token).** An Expo/APNs push token is a functional
  delivery identifier, not an advertising ID. We declare it **conservatively**
  because we store it linked to the user (`push_tokens`). "Used for tracking"
  stays **No**. *(This exists because push is in v1.0. If push is ever pulled,
  drop this row.)*
- **#2 covers the sensitive stuff.** Chat + memories can contain health /
  financial / emotional content. Apple has **no required "sensitive data"
  toggle** in App Privacy (that's Google) — it's covered as *User Content →
  Other User Content*. The privacy policy spells out sensitive-data handling.
- **#6/#7 Diagnostics are Linked = Yes.** Sentry error context carries the
  server-side `userId` (`data-inventory.md §3`). Purpose is **App Functionality**
  (crash monitoring), **not** Analytics — there is no analytics SDK.
- **Do not add "Analytics" or "Advertising" purposes anywhere.** No analytics
  SDK, no ads. If App Store Connect pre-checks them, uncheck them.

---

## 3. Click-by-click in App Store Connect

App Store Connect → your app → **App Privacy** → **Get Started** (or **Edit**).

**Step 1 — Data Collection question.**
"Do you or your third-party partners collect data from this app?" → **Yes, we collect data from this app.**

**Step 2 — Select the 7 data types** (Apple category → checkbox):
- Contact Info → **Name**
- User Content → **Other User Content**
- Identifiers → **User ID**
- Identifiers → **Device ID**  ⚠️ (functional push token — see §2)
- Purchases → **Purchase History**
- Diagnostics → **Crash Data**
- Diagnostics → **Other Diagnostic Data**

Leave every other type unchecked (**no** Phone Number, **no** Email Address — see §2).

**Step 3 — For each selected type, the wizard asks three things. Answers:**

| Data type | Purposes to check | Linked to identity? | Used to track? |
|---|---|---|---|
| Name | App Functionality | **Yes** | **No** |
| Other User Content | App Functionality, **Product Personalization** | **Yes** | **No** |
| User ID | App Functionality | **Yes** | **No** |
| Device ID | App Functionality | **Yes** | **No** |
| Purchase History | App Functionality | **Yes** | **No** |
| Crash Data | App Functionality | **Yes** | **No** |
| Other Diagnostic Data | App Functionality | **Yes** | **No** |

Rules that hold for **all seven**: Linked = **Yes**, Tracking = **No**, and the
only purpose is **App Functionality** — *except* Other User Content, which also
gets **Product Personalization** (memories + tone personalize replies). Never
check **Analytics**, **Developer's Advertising or Marketing**, or **Third-Party
Advertising** on anything — there is no analytics SDK and no ads. If ASC
pre-checks any of them, uncheck them.

**Step 4 — Publish.** Review the summary, then **Publish**. (This can be saved and
published independently of a build/version submission.)

---

## 4. Cross-check before submitting

1. Re-run the `data-inventory.md` verification (SDKs move).
2. Confirm push is still in the build (`src/lib/push.ts` `getExpoPushTokenAsync`);
   if it was pulled, remove row #4.
3. **Email scope decision (§2):** either keep the transient-exemption stance
   (don't declare Email) or drop the `EMAIL` scope in `sign-in.tsx` — pick one and
   make sure the choice matches what's declared here.
4. Make sure the same story matches the **privacy policy** (`docs/legal/
   privacy-draft.md`) and **Google Data Safety** (`data-inventory.md §5`) — all
   three must agree, especially the phone→Apple auth change (Name in, Phone out).
