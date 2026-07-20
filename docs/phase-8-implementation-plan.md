# Phase 8 (partial) — everything buildable without an Apple Developer account

> Pickup: _"Read `CLAUDE.md`, `docs/phases/phase-8-release-readiness.md`, and this file.
> Implement the work items in order; each is independently commit-able. Live-drive the
> server bits with curl and the client bits in Expo Go per the repo's own convention —
> tsc has never caught the bugs that matter here."_
>
> Standing state: provider deepseek-v4-flash; server on Railway (Docker + CI + Sentry);
> `npm run dev` in `server/` (port 8787, log at `/private/tmp/meroa-server.log`);
> `npm run dev:token +1555...` for accounts. Typecheck both packages + `npm test` in
> `server/` after each item.

## 0. Context — why this, why now

Phase 8 is release-readiness. Its DoD splits cleanly along one line: **does it need the
Apple Developer account / App Store Connect / a real store build?** This plan is
everything on the *near* side of that line — real engineering that's fully unblocked
today. The store-portal and purchase-verification half stays blocked on Phase 7's
RevenueCat + Apple dashboard dependency and is listed under §Out of scope so nothing here
pretends to close it.

Two items are **not** optional polish — web research (July 2026) confirmed both are hard
store requirements that are *features*, not policy paragraphs:

1. **Apple Guideline 5.1.2(i)** (amended 2025-11-13): an app must obtain **explicit
   permission before** sending personal data to third-party AI. Every Meroa chat message
   goes server-side to a hosted LLM, so this needs a real consent gate + a revocable
   control — a privacy-policy paragraph does not satisfy it. Naming the specific provider
   is *not* required (generic "third-party AI service" is fine in the policy; the provider
   name goes in the private App Review Notes).
2. **Google Play AI-Generated Content policy**: a chatbot app must provide an **in-app way
   to report/flag an offensive AI response**. Hard for Google, prudent for Apple — ship on
   both.

Decisions locked with the user:
- **Legal pages** are served as HTML from the existing Hono server (zero new infra) —
  `/privacy`, `/terms`, `/support`, and the Google-required **web** deletion path.
- **Account deletion** is an **immediate hard delete**.
- **Dead composer controls** (mic + paperclip) are **removed**.
- **Policy text**: drafted here, grounded in the real code inventory, **flagged for the
  user's review before publishing** — not legal advice.

## Out of scope (needs the Apple account, a store build, or store-portal access)

Listed so the boundary is explicit — do **not** attempt these here:
- Purchase / restore / renewal / cross-device entitlement verification (Phase 7 blocked
  item; needs RevenueCat + App Store Connect sandbox).
- **Submitting** the Apple App Privacy questionnaire and Google Data Safety form — but
  this plan *produces the inventory that fills them in* (Item 8).
- App Store / Play screenshots, description, categories, age rating, reviewer credentials.
- iOS **universal links** (`associatedDomains`) — needs the Apple account + domain
  verification. Custom-scheme deep links (Item 9) work without it and are what we build.
- EAS production build + `eas submit`; final store-policy/API-level re-check at submit time.

---

## Work items, in order

### 1. AI data-sharing consent gate (Apple 5.1.2(i)) — the load-bearing item

The guarantee lives in code, per `docs/chat-architecture.md` §0: the **server** refuses to
send to the model without consent; the client just surfaces the prompt.

**Server**
- `users.prefs` (jsonb, merge-patched) gains `aiConsent?: { granted: boolean; at: string;
  version: number }`. Add to `prefsPatchSchema` (`server/src/routes/me.ts:78`). A
  `CONSENT_VERSION` const (`server/src/lib/constants.ts`) lets a future material change to
  the disclosure re-prompt everyone.
- **Enforce at the message endpoint**: in `server/src/routes/messages.ts`, before the ACT
  pass runs (before any provider call), reject when `prefs.aiConsent?.granted !== true` or
  `version < CONSENT_VERSION` with a distinct code, e.g. `{ error: 'ai_consent_required' }`
  (HTTP 403). This is the actual compliance boundary — a client that skipped the gate still
  cannot reach the model.
- `GET /me` already returns `prefs`; the client reads consent state from there.

**Client**
- New route `src/app/ai-consent.tsx` — a plain screen: what's shared (your messages, to an
  external AI service, over encrypted HTTPS), why, that it's required for chat, a link to
  the privacy policy, and an "I agree" button that PATCHes `prefs.aiConsent`.
- **Nav guard** in `src/app/_layout.tsx` (the `Stack.Protected` chain, currently
  auth → onboarding → paywall → tabs): add `needsAiConsent = signedIn && entitled &&
  !meConsentGranted` → route to `ai-consent` before `(tabs)`. One code path covers both new
  users (onboarding → paywall → consent → tabs) and existing accounts (consent → tabs on
  next launch, since none have it yet).
- **Revoke** control: a row/toggle in `src/app/(tabs)/you.tsx` PREFERENCES ("AI data
  sharing", anchored where the dead "Privacy" row at `you.tsx:93` is today). Revoking
  PATCHes `granted:false`; the guard then re-shows the consent screen next time chat is
  entered, and the server blocks sends meanwhile — chat genuinely can't function without
  it, which is the honest behavior.
- Handle the `403 ai_consent_required` in `src/features/chat/queries.ts` as a routed
  fallback to the consent screen (belt-and-braces; the guard should normally prevent it).

**Verify**: curl the message endpoint with consent absent → 403; grant via PATCH → send
succeeds. In Expo Go: fresh account never reaches chat before agreeing; revoking in You
blocks chat and re-prompts.

### 2. Report-an-AI-response (Google AI-content policy)

**Server**
- New table `message_reports` in `server/src/db/schema.ts`: `id`, `userId` (FK cascade),
  `messageId` (FK → messages, cascade), `reason` (text, nullable), `createdAt`. One
  migration (drizzle-kit generate).
- `POST /conversations/current/messages/:id/report` in `server/src/routes/messages.ts`
  (behind `requireAuth`): verify the message belongs to the user's conversation and is an
  `assistant` role, insert a report row (idempotent per (userId, messageId)). No model
  call. Returns 200.
- Include `message_reports` in the deletion cascade coverage (Item 3) and the export
  (Item 4).

**Client**
- On assistant chat bubbles (`src/app/(tabs)/index.tsx` message row) add a low-key
  affordance — long-press or a small ⋯ → action sheet "Report this response" → optional
  reason → POST. A quiet confirmation toast; nothing else changes on screen (consistent
  with the card-is-the-confirmation ethos).

**Verify**: report an assistant message via curl and via the UI; row lands; reporting the
same message twice is a no-op.

### 3. Account deletion — immediate hard delete (Apple + Google, in-app)

**Server**
- `DELETE /me` in `server/src/routes/me.ts` (behind `requireAuth`), in one transaction
  under `withUserLock(userId)` (`server/src/lib/usage.ts`) so it can't race a concurrent
  send/sync:
  - `DELETE FROM users WHERE id = $1` — the FK cascades already clear **10 of 12 tables**
    (sessions, conversations, messages, records, goals, tasks, goal_entries, memories,
    memory_extraction_state, entitlements) per the schema audit.
  - Explicitly `DELETE FROM otp_codes WHERE phone_e164 = $userPhone` — **no FK**, keyed by
    phone, and phone is the identity key, so a stale code must not survive a re-signup.
  - `message_reports` cascades via its userId FK (Item 2).
- **Stale access token**: TTL is 15 min and refresh tokens die with the `sessions` cascade,
  so a deleted user can't renew and the JWT self-expires fast. Accept that 15-min window
  (documented) rather than adding a per-request existence check — the row is gone, so any
  handler touching it fails closed anyway.
- **Billing reality** (must be surfaced in UX, per the audit): deleting our `entitlements`
  row cancels nothing — the real subscription lives with Apple/Google. Two honest steps:
  the deletion confirmation copy tells the user to cancel in the App Store / Play Store to
  stop billing; and (best-effort, non-blocking) call RevenueCat `DELETE
  /v1/subscribers/{userId}` so a later webhook can't resurrect a subscriber record. Wrap it
  so a RC failure never blocks the local delete.

**Client**
- "Delete account" row in `you.tsx` ACCOUNT section (`danger`, near Sign out). Two-step
  confirm (type-to-confirm or a second Alert), copy stating it's permanent, nothing
  recoverable, and "cancel your subscription in the App Store to stop billing".
- On success reuse the existing terminal path (`AuthProvider` `signOut` →
  `clearTokens()` → `logOutPurchases()` → `(auth)` stack).

**Verify**: on a throwaway dev-token account with goals/tasks/messages/memories, curl
`DELETE /me`; confirm every table has zero rows for that user (incl. otp_codes by phone);
confirm the old access token 401s within 15 min and refresh fails immediately.

### 4. Data export

Not a store *blocker* like 1–3, but on the Phase 8 list and cheap once deletion exists.
- **Server** `GET /me/export` (authed): assemble a faithful, **unfiltered/unpaginated**
  JSON of every user-owned row across all tables (the audit flags `records`, `goal_entries`,
  and messages-via-conversations as the joins an id-only query would miss; include
  soft-deleted rows with their flags so the export is complete). Reuse read helpers where
  they're faithful; do **not** call `/bootstrap` (it caps at 50 and has the
  `materializeRecurringInstances` side effect).
- **Client**: "Export my data" row in `you.tsx`. Fetch → write to a temp file
  (`expo-file-system`) → open the share sheet (`expo-sharing`); add both via `npx expo
  install`. Also offered on the web page (Item 5) after OTP.

**Verify**: export on a populated account returns every row; diff table counts against the DB.

### 5. Legal + web-deletion pages, served from Hono

**Server** — new `server/src/routes/legal.ts`, mounted in `src/index.ts`, serving static
HTML (self-contained, inline CSS, dark to match the app):
- `GET /privacy`, `GET /terms`, `GET /support` — content drafted in Item 8, **flagged for
  user review before this ships publicly**.
- **Google-required web deletion** — no browser-session concept exists, so a 3-step
  server-rendered OTP form reusing the existing OTP logic (`server/src/routes/auth.ts`):
  `GET /account/delete` (enter phone) → POST sends OTP → enter code → POST verifies and runs
  the **same** delete transaction as Item 3. Rate-limited like the app OTP path.
- CORS is currently `*` (dev). Before these are public, scope it (noted, not a blocker for
  local build-out).

**Client**
- Fix the **dead paywall links**: `PRIVACY_URL`/`TERMS_URL` in `src/app/paywall.tsx:27-28`
  point at `meroa.app`, which does not resolve. Repoint at the served pages — derive from
  the configured API base (`EXPO_PUBLIC_API_URL`) so they track whatever host the server is
  on, instead of a hardcoded dead domain.
- Wire the same privacy/terms/support links into `you.tsx` (the "Privacy" row) and the
  consent screen (Item 1).

**Verify**: hit each page in a browser against the dev server; run the full web-deletion
OTP flow end to end against a throwaway account and confirm the rows are gone.

### 6. Remove the dead composer controls

`src/app/(tabs)/index.tsx`: the mic (`~893`) and paperclip (`~867`) are `AnimatedPressable`s
with press feedback but **no `onPress`** — dead-end controls Apple rejects on, and neither
voice nor attachments exist server-side. Remove both; the composer keeps text + the
mic↔send swap collapses to just send. Update CLAUDE.md's Phase-0 note that called out the
mic placeholder.

**Verify**: composer still sends; no non-functional buttons remain (grep the composer for
`AnimatedPressable` without `onPress`).

### 7. Point-of-use permission gap + notification tap routing

- **Permission gap** (audit §2): enabling a per-task reminder in `TaskFormSheet` never
  requests notification permission (only the timer-start and the check-in toggle do), so
  the reminder silently no-ops. Call `requestNotificationPermission()` when the user turns
  on `config.reminder`. Keeps permissions at point-of-use, which Phase 8 requires.
- **Notification tap routing** (Phase 8 "deep links open the right task"): reminders
  schedule with `data: { taskId }` but nothing reads it. Add a
  `addNotificationResponseReceivedListener` (+ `getLastNotificationResponseAsync` for
  cold-start) in a root effect that routes to the task's tab/detail. Custom-scheme only —
  **no `associatedDomains`**, so no Apple account needed.

**Verify**: on device (Expo Go — notifications don't fire in the simulator), set a
near-future reminder, background the app, tap the banner → lands on the right task.

### 8. Data inventory + drafted policy text

- `docs/data-inventory.md`: code-verified — every collected data type (phone, messages,
  tasks, goals, memories, records, usage/diagnostics), where each goes (Postgres/Railway,
  the AI provider, RevenueCat, Sentry), whether it's Linked-to-User, and retention. This is
  the single source the **Apple App Privacy** and **Google Data Safety** forms are filled
  from later (mapped to their category names: User Content → Text; Identifiers → User ID;
  etc.), and what the privacy policy is written from.
- Draft `/privacy`, `/terms`, `/support` copy (Item 5) from that inventory — generic
  "third-party AI service" wording per the research. **Marked review-required; not legal
  advice.**
- `docs/app-review-notes.md`: the private App-Review-Notes text that *does* name the
  provider and describes the AI data flow ("user prompt → encrypted HTTPS → external LLM for
  completion; no extra identifiers shared"), for you to paste at submit time.

### 9. Resilience: error + offline states (Phase 8 "test offline states")

Lower-risk polish, last:
- **Network-error classification** in `src/lib/api/client.ts`: today a raw `fetch`
  rejection is unclassified and there's no timeout — add an `AbortController` timeout and a
  typed `NetworkError`, distinct from `ApiError`/`SessionExpiredError`.
- **Error states** on `tasks.tsx`, `goals.tsx`, `memories.tsx` — currently a failed load is
  indistinguishable from "you have nothing" (only loading + empty states exist). Add a
  retry row (generalize the chat `status:'failed'` pattern that already works well).
- **Root `ErrorBoundary` + `src/app/+not-found.tsx`** (Expo Router supports both; neither
  exists) so a render crash or a bad deep link degrades gracefully instead of white-screen.
- Optional: an offline banner via `@react-native-community/netinfo` + react-query
  `onlineManager` — include only if time allows; the three above are the real gaps.

---

## Suggested sequencing

1 → 3 → 5 are the store-blocking core (consent, deletion, the web deletion page + legal),
and 5 depends on 3's delete transaction and 8's copy, so realistically **8 (inventory
first) → 1 → 3 → 2 → 5 → 4 → 6 → 7 → 9**. Items 6, 7, 9 are independent and can slot
anywhere. Commit per item.

## Verification (whole-phase)

- `npx tsc --noEmit` in `server/` and repo root, `npm test` in `server/`, `npx expo export
  --platform ios`, `npx expo lint` after each item.
- Server items live-driven with curl against `npm run dev` (the repo convention — tsc has
  never caught the real bugs); deletion and the web flow driven on throwaway dev-token
  accounts with DB row-counts checked before/after.
- Client items driven in Expo Go on device where the behavior needs a device (notifications,
  share sheet).
- New server tests: deletion cascade completeness (seed a user across all tables → delete →
  assert zero rows incl. otp_codes), consent enforcement (send without consent → 403), and
  the report endpoint (ownership + assistant-only + idempotency).
