# Data inventory — Meroa

> **Purpose.** The single, code-verified source of truth for every data type Meroa
> collects, where it goes, whether it's linked to the user, and how long it's kept.
> Everything downstream is filled from this file: the **Apple App Privacy**
> questionnaire, the **Google Data Safety** form, the public **privacy policy**
> (`docs/legal/privacy-draft.md`), and the private **App Review Notes**
> (`docs/app-review-notes.md`).
>
> **Verified against code** on 2026-07-20 (Phase 8 partial). Re-verify before any store
> submission — SDKs and data flows move. Line references are to the state of the repo on
> that date.
>
> **Not legal advice.** This is an engineering inventory. The user-facing legal copy
> derived from it is separately marked review-required.

---

## 1. How to read this

- **Linked to user?** — "Yes" means the row is keyed to a user identity (phone number is
  the identity key; `userId` UUID is the internal join key). Meroa has **no anonymous /
  not-linked data path** — there is no analytics SDK and no device identifier collection
  (see §4), so everything we store is linked.
- **Retention** — Meroa keeps data **until account deletion**, which is an **immediate
  hard delete** (`DELETE /me`, Item 3 of the Phase 8 plan). There is no separate
  time-based expiry except OTP codes (short-lived) and access tokens (15-min TTL). "Undo"
  and soft-delete flags (`deletedAt`, `revertedAt`, `archivedAt`, `suppressed`) keep rows
  present-but-hidden inside the account; they are still deleted on account deletion.

---

## 2. Data collected — Postgres (single source of truth)

All application data lives in one PostgreSQL database hosted on **Railway** (see §3).
Schema: `server/src/db/schema.ts` — 12 tables.

| # | Table | Data | Linked to user? | Purpose | Retention |
|---|---|---|---|---|---|
| 1 | `users` | **Phone number (E.164)**, display name, timezone, prefs (jsonb: chat vibe, quiet hours, and — added in Item 1 — AI-sharing consent) | Yes (phone is the identity key) | Account identity; personalization of chat + reminders | Until account deletion |
| 2 | `otp_codes` | Phone number, **hashed** one-time login code, attempt count | Yes (by phone; no FK) | Phone-number login / verification | Short-lived (expires per code); also hard-deleted by phone on account deletion |
| 3 | `sessions` | **Hashed** refresh token, timestamps. (`deviceLabel` column exists but is **never written** — no device name is collected.) | Yes | Keeping a user signed in across app launches | Until account deletion or token expiry/rotation |
| 4 | `conversations` | Channel (`app` / `sms`), timestamps | Yes | Groups a user's chat thread(s) | Until account deletion |
| 5 | `messages` | **Message content** — the user's typed messages and Meroa's AI replies; `meta` jsonb (card/action metadata) | Yes | The conversation itself; context for future replies | Until account deletion |
| 6 | `records` | The canonical log of every real-world action (kind + payload), source, revert flag | Yes | "Store once, render everywhere" — the one row every task/goal view reflects | Until account deletion |
| 7 | `goals` | Goal name, icon, template, definition (targets/units), archive flag | Yes | User-created trackers/dashboards | Until account deletion |
| 8 | `tasks` | Task title, type, config, due date, recurrence, status | Yes | User's tasks (all types) | Until account deletion |
| 9 | `goal_entries` | A view of a record attached to a goal (entry data, timestamp) | Yes | Progress entries on a goal | Until account deletion |
| 10 | `memories` | Free-text facts Meroa remembers (preference / trait / relationship / situation), a **`sensitive`** flag, a suppression flag, source (told / extracted / manual) | Yes | Personalization + continuity ("remembers the person") | Until account deletion or per-memory deletion by the user |
| 11 | `memory_extraction_state` | Watermark (last processed message id) per user | Yes | Bookkeeping for the background memory extractor | Until account deletion |
| 12 | `entitlements` | Plan (`free` / `plus`), source, expiry | Yes | Server-side subscription truth | Until account deletion |

**Added in Phase 8, Item 2:** `message_reports` (user id, reported message id, optional
reason, timestamp) — records a user flagging an AI response as offensive. Linked to user;
retained until account deletion; included in the deletion cascade and the data export.

**Sensitive data note (CLAUDE.md §2).** Message content and memories can contain health,
financial, or emotional information. Memories carry an explicit `sensitive` flag and a
user-controlled suppression control. This is treated as sensitive regardless of how it was
entered.

---

## 3. Third parties / subprocessors — where data leaves our database

| Recipient | What it receives | Identifiers included? | Why | Code |
|---|---|---|---|---|
| **DeepSeek** (`api.deepseek.com`) — third-party AI provider | The user's **message content** and server-computed state blocks (task/goal **titles**, counts, streaks) | **No.** No phone number and no user identifier is placed in the model request. (`userId` appears only in internal server logs / Sentry context, never in the provider payload.) | Generates Meroa's chat replies and extracts structured actions | `server/src/lib/ai/providers/deepseek.ts` (payload at `messages: turnMessages`, `baseURL: 'https://api.deepseek.com'`) |
| **RevenueCat** (`api.revenuecat.com`) | Our internal **`userId` (UUID)** as the app-user id | UUID only — **no phone, no message content** | Subscription receipt verification / entitlement state | `server/src/lib/billing/revenuecat.ts` |
| **Apple / Google** (platform billing) | Handled entirely by the OS billing sheet; the **real subscription lives with the store**, not us | Store account, not our identity | Purchase, renewal, cancellation | Client billing (Phase 7) |
| **Sentry** (server-side only) | **Error diagnostics** — exception objects + `environment` tag | Not message content by design; a stack trace/error context could *incidentally* contain a fragment | Crash / error monitoring | `server/src/index.ts`, `providers/*.ts` (`Sentry.captureException`) |
| **Railway** | Hosts the server and the Postgres database (i.e. *all* of §2) | All application data, as the infrastructure host | Hosting / database | Deployment (Docker on Railway) |
| **SMS provider** | *Nothing yet* — Phase 9, currently a stub | — | Pre-install / re-engagement texts (future) | `server/src/sms/sender.ts` (not implemented) |

**Server-side SDKs** (from `server/package.json`): `@anthropic-ai/sdk`, `openai` (the
DeepSeek provider uses the OpenAI-compatible client pointed at `api.deepseek.com`),
`@sentry/node`. RevenueCat is called via plain REST `fetch` (no SDK).

> **AI provider is swappable.** `AI_PROVIDER` can be `anthropic` | `openai` | `deepseek`;
> production is **deepseek-v4-flash**. The privacy policy therefore names a generic
> "third-party AI service" (per store research); the *specific* current provider
> (DeepSeek) is named only in the private App Review Notes.

---

## 4. What Meroa does **not** collect

Stated explicitly because store forms ask, and "we don't" is an answer that must be true:

- **No analytics / tracking SDK** on the client — no Amplitude, Segment, Firebase Analytics,
  PostHog, or similar (`package.json`).
- **No client-side Sentry** — error reporting is server-side only.
- **No push tokens.** `expo-notifications` is used for **local** notifications only
  (`Notifications.scheduleNotificationAsync`); no `getExpoPushToken` call exists, so no push
  token is generated or sent to the server (`src/lib/notifications.ts`).
- **No device identifiers.** `expo-device` is installed but **unused**; `sessions.deviceLabel`
  is never populated.
- **No location, contacts, photos, microphone, or camera access.** (The dead mic/paperclip
  composer controls are removed in Item 6; no speech or attachment feature exists.)
- **No advertising, no data sold or shared for ads, no cross-app tracking.**

---

## 5. Mapping to the store forms (fill these from §2–§4 later)

### Apple — App Privacy ("Data used to track you": **None**)

| Apple category | Meroa data | Linked to user | Used for tracking |
|---|---|---|---|
| **Contact Info → Phone Number** | `users.phoneE164` | Yes | No |
| **User Content → Other User Content** (chat messages) | `messages` | Yes | No |
| **User Content → Other User Content** (tasks, goals, memories) | tasks/goals/records/memories | Yes | No |
| **Identifiers → User ID** | internal `userId` UUID (sent to RevenueCat) | Yes | No |
| **Purchases → Purchase History** | `entitlements` / RevenueCat | Yes | No |
| **Diagnostics → Crash Data / Other Diagnostic Data** | Sentry errors | Linked (server) | No |

Product-interaction / usage-data analytics: **None collected** (no analytics SDK).

### Google — Data safety

| Google category | Meroa data | Collected | Shared w/ 3rd party | Purpose |
|---|---|---|---|---|
| **Personal info → Phone number** | `users.phoneE164` | Yes | No | Account management |
| **Messages → Other in-app messages** | `messages` | Yes | Yes → AI provider (content) | App functionality (chat) |
| **App activity → Other user-generated content** | tasks/goals/memories | Yes | No | App functionality |
| **App info & performance → Crash logs / Diagnostics** | Sentry | Yes | Yes → Sentry | App functionality / monitoring |
| **Financial info → Purchase history** | `entitlements` / RevenueCat | Yes | Yes → RevenueCat/store | Subscriptions |

- Data is **encrypted in transit** (HTTPS) and **encrypted at rest** (managed Postgres).
- Users **can request deletion** (in-app `DELETE /me` and the web deletion path, Item 5).
- Data is **not sold**; message content **is shared** with the AI provider strictly to
  generate replies.

---

## 6. Change log

- **2026-07-20** — Initial inventory, code-verified against the Phase 8-partial branch.
  Author: Phase 8 implementation. Re-verify before store submission.
