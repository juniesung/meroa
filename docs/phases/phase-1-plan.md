# Phase 1 Implementation Plan — Backend, Accounts & Continuity

> Working plan for the Phase 1 build session. Derived from `CLAUDE.md` + `docs/phases/phase-1-backend-accounts-continuity.md`, with the schema designed forward against Phases 2–5. Delete or commit this file as you prefer.

## Key decisions (with reasoning)

| Decision | Choice | Why |
|---|---|---|
| API framework | **Hono** on Node 22 (`@hono/node-server`) | Tiny, excellent TS inference, zod-validator middleware, SSE-ready for Phase 2 streaming, deployable anywhere later. |
| ORM / migrations | **Drizzle + drizzle-kit**, `postgres` (postgres-js) driver | TS-first schema = single source of truth; satisfies the migrations-tooling task; plain SQL migrations, portable to Supabase later. |
| Database | **Hosted Supabase project** (used as plain Postgres) | User decision. We use only the Postgres database — not Supabase Auth (our OTP flow is custom) or its client SDK. Drizzle connects by connection string, copied from the Supabase dashboard's Connect dialog. Use a **session-mode connection for migrations** (session pooler, or direct connection — DDL/drizzle-kit needs session semantics). The **persistent API server also uses the session pooler**; if any part of the API ever runs serverless, switch that part to the transaction pooler with `prepare: false` in Drizzle. Note the direct connection is IPv6-only on the free tier — the poolers are the IPv4-safe choice. Confirm exact hostnames/ports from the dashboard at setup time (Supabase's pooler setup has changed across versions). `DATABASE_URL` lives in `server/.env`, never in the app. |
| Phone OTP | **Custom OTP flow with a pluggable `SmsSender`**; dev implementation logs the code to the server console | The real SMS provider is Phase 9 by design. Interface now, provider later. Seeded dev numbers also accept a fixed code (`000000`) for painless simulator testing. |
| Sessions | Short-lived **access JWT (15 min, `jose`)** + **rotating refresh token (30 d)** stored hashed in a `sessions` table; device stores both in `expo-secure-store` | Matches the spec's "short-lived access + refresh, secure storage on device". Rotation + hashing means a leaked DB row can't be replayed. |
| Repo layout | `server/` inside this repo with its **own package.json** (no npm workspaces) | Workspaces + Metro hoisting is a known footgun; the server is independent. App `tsconfig.json` gets `"exclude": ["server"]`. |
| Shared API types | Hand-written mirror in `src/lib/api/types.ts` | Phase 1's API surface is small; cross-package type imports without workspaces aren't worth the plumbing yet. Revisit if it grows. |
| Server-state layer (app) | **TanStack Query** (`@tanstack/react-query`) | The "query layer" CLAUDE.md §4 calls for; cache + refetch semantics the tabs need. |
| Client auth state | Minimal React context + hooks (no new state library) | Phase 1 only needs "am I signed in + who am I". |
| Chat replies in Phase 1 | Sending persists the user message; server persists + returns **one canned assistant acknowledgment** | Keeps history-reload demonstrable without touching AI (Phase 2's job). Clearly marked placeholder in code. |

## Database schema (migration 0001)

Designed so Phases 2–5 add columns/tables, never restructure. The `records` table is the "single source of truth" heart: every real-world action is one row there; task completions and tool entries *reference* it (CLAUDE.md §2, Phase 5).

- **users** — `id uuid pk`, `phone_e164 text unique not null`, `display_name`, `timezone`, `prefs jsonb` (communication style etc. — continuity payload), `created_at`. Phone is the identity key: same number = same user, app or SMS.
- **otp_codes** — `id`, `phone_e164`, `code_hash`, `expires_at`, `attempts int`, `consumed_at`. Rate-limit by phone + IP.
- **sessions** — `id uuid pk`, `user_id fk`, `refresh_token_hash`, `device_label`, `created_at`, `last_used_at`, `expires_at`, `revoked_at`.
- **conversations** — `id`, `user_id fk`, `channel text check in ('app','sms')`, `created_at`. One logical relationship; channel recorded per conversation so the pre-install SMS thread and the app thread can merge into one history view.
- **messages** — `id`, `conversation_id fk`, `role check in ('user','assistant','system')`, `content text`, `meta jsonb`, `created_at`. Index `(conversation_id, created_at)` for cursor pagination.
- **records** — `id`, `user_id fk`, `kind text` (e.g. `task_completion`, `tool_entry`), `payload jsonb`, `source text check in ('chat','tasks_ui','tool_ui','system')`, `source_message_id fk null`, `occurred_at`, `created_at`, `reverted_at timestamptz null` (undo = set reverted_at, never delete).
- **tasks** — `id`, `user_id fk`, `type text` (all six Phase-3 types in the check constraint now), `title`, `icon`, `config jsonb` (target counts, checklist items…), `recurrence jsonb null`, `tool_id fk null` (Phase-5 link, nullable now), `due_at`, `status check in ('open','done','archived')`, `completed_record_id fk records null`, `created_from_message_id fk null`, `created_at`, `deleted_at`.
- **tools** — `id`, `user_id fk`, `template text` (workout/habit/numeric/money/…), `name`, `icon`, `version int`, `definition jsonb` (typed fields + views + actions, per Phase 4), `created_at`, `archived_at`. Layout edits bump `version`; entries are never touched.
- **tool_entries** — `id`, `tool_id fk`, `record_id fk records not null`, `data jsonb`, `entry_at`, `created_at`. An entry is a *view* of a record.
- **memories** — `id`, `user_id fk`, `kind text`, `content text`, `sensitive boolean default false`, `suppressed boolean default false` ("don't bring this up"), `source_message_id fk null`, `created_at`, `deleted_at`. Sensitivity is schema-level from day one (guardrail).
- **entitlements** — `user_id pk/fk`, `plan check in ('free','plus') default 'free'`, `source text`, `expires_at null`, `updated_at`. Server-side truth for Phase 7.

## API surface (all JSON, all auth'd except `/auth/*` and `/health`)

```
POST /auth/otp/request     { phone }            → { ok }           (rate-limited)
POST /auth/otp/verify      { phone, code }      → { accessToken, refreshToken, user, isNewUser }
POST /auth/refresh         { refreshToken }     → rotated pair
POST /auth/logout          { refreshToken }     → revokes session
GET  /me                                        → user + prefs + entitlement
GET  /bootstrap                                 → continuity payload: user, prefs, memories (non-suppressed),
                                                  conversation id, recent messages, open tasks, tools
GET  /conversations/current/messages?cursor=    → paginated history (merged app+sms channels)
POST /conversations/current/messages { text }   → persists user msg + canned assistant msg, returns both
GET  /tasks                                     → open + recently-done tasks
POST /tasks { title, icon?, due_at? }           → minimal completion-type create (full model is Phase 3)
POST /tasks/:id/toggle                          → complete/uncomplete; writes/reverts a `records` row
GET  /tools                                     → tool list w/ definition (read-only until Phase 4)
```

Auth middleware verifies the JWT on every non-auth route; zod validates every body. No secret ever reaches the app bundle — the app only holds its own session tokens.

## App-side work

```
src/lib/api/client.ts        fetch wrapper: base URL from EXPO_PUBLIC_API_URL, bearer header,
                             single-flight 401 → refresh → retry, typed endpoints
src/lib/api/types.ts         wire types mirroring the server contract
src/lib/auth/                secure-store token persistence + AuthProvider (session context)
src/features/{chat,tasks,tools,profile}/queries.ts   TanStack Query hooks per feature
src/app/(auth)/sign-in.tsx   phone entry (design system: dark, blue gradient CTA)
src/app/(auth)/verify.tsx    6-digit OTP entry, resend, error states
src/app/_layout.tsx          QueryClientProvider + AuthProvider + redirect guard
                             (no session → (auth); session → (tabs))
```

Tab rewiring (mock arrays → queries, each with a real empty state):
- **Chat**: history from `/bootstrap` + messages query; send = optimistic append → POST; remove the local fake-reply `setTimeout`.
- **Tasks**: task list query; toggle = mutation with optimistic update; empty state ("Nothing yet — tell Meroa what you're up to").
- **Tools**: tools query; empty state explaining tools come from conversation.
- **You**: real user (name/phone, plan pill from entitlement), working **Sign out** (revoke + clear secure store → auth screen). Drop "Alex Rivera".

New app deps (via `npx expo install`): `expo-secure-store`; (via npm, non-native): `@tanstack/react-query`.

## Continuity proof (no SMS provider yet)

`server/src/seed.ts` creates the "pre-install relationship": user **+1 555 555 0100** with the Phase-0 seed conversation as an `sms`-channel history, casual-style prefs, a few memories, 2 open tasks, 1 workout tool with entries. **Demo:** sign in as 555-555-0100 / code 000000 → chat opens with the existing relationship, tasks and tools populated, zero re-onboarding. Sign in with any other number → fresh account, single welcome message. That is the Phase-1 continuity DoD, demonstrable on the simulator.

## Build order (each step = one reviewable commit)

1. **Server scaffold** — `server/` package, tsconfig (strict), Hono app, `/health`, env loading (`.env` git-ignored, `.env.example` committed), pino logging. Add `"exclude": ["server"]` to app tsconfig.
2. **DB + schema** — Supabase project connection (`DATABASE_URL` in `server/.env`, `.env.example` documents both pooler URLs), Drizzle schema for all tables above, generate + run migration 0001 against Supabase, `db:*` scripts.
3. **Auth** — OTP request/verify (hashing, expiry, attempt caps, rate limit), JWT issue, refresh rotation, logout, auth middleware, dev SMS sender.
4. **Core endpoints** — `/me`, `/bootstrap`, messages (get/post + canned reply), tasks (list/create/toggle writing `records`), tools (list).
5. **Seed script** — continuity demo data as above.
6. **App: auth plumbing** — secure store, API client with refresh, providers, `(auth)` screens, route guard.
7. **App: wire the four tabs** — queries/mutations + empty states, You-tab sign-out.
8. **Verify DoD + gates** — full simulator pass (fresh sign-in, restart-survives-session, continuity number, task toggle persistence), `npx tsc --noEmit` both packages, lint, expo-doctor. Tick Phase 1 in CLAUDE.md §9.

## DoD checklist (from the phase spec)

- [x] Verify a phone number → persistent authenticated session that survives app restart (secure-store + refresh).
- [x] Sign-in with the seeded number surfaces history/preferences immediately — no re-onboarding.
- [x] All four tabs read/write real records through the API; data persists across restarts.
- [x] Every endpoint requires auth; zero secrets in the app bundle.

## Guardrail notes for implementation

- `records` is written once per real-world action; tasks/tool_entries reference it. Never duplicate an action into two tables.
- Migrations are additive; no destructive changes to progress data, ever.
- `memories.sensitive` / `suppressed` enforced at query level in `/bootstrap` from day one.
- OTP codes hashed at rest; refresh tokens hashed; access token lifetime 15 min.
- Supabase is our Postgres only: the app never talks to Supabase directly, and the DB password / service-role key are server secrets. The anon key and PostgREST/Realtime APIs go unused — don't wire them in.
