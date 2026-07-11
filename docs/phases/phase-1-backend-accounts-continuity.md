# Phase 1 — Backend, Accounts & Continuity

**Status:** ☑ Done
**Goal:** A TypeScript API + PostgreSQL behind the app, with phone-based sign-in and the
identity continuity that lets a text-bot relationship carry into the app with nothing re-entered.
**Depends on:** Phase 0.

## In scope
- Backend service, database schema, phone verification/linking, secure sessions, and the data plumbing for continuity.

## Out of scope
- AI replies (Phase 2), task/tool feature logic (Phases 3–4), billing (Phase 7). The actual outbound SMS *provider* is Phase 9 — here we only build the account/continuity model it will plug into.

## Tasks
- [x] Stand up the TypeScript API (framework of choice) and a PostgreSQL database (Supabase or equivalent). Keep all secrets server-side.
- [x] Design the core schema (single source of truth): `users`, `sessions`, `conversations`, `messages`, `tasks`, `tools` (definition + fields), `tool_entries`/`progress`, `memories`, `entitlements`. Model tasks/tools/progress so one record can back multiple views (CLAUDE.md §2 data integrity).
- [x] Phone-number verification (OTP) and account creation. Verifying the **same** number in the app must resolve to the **same** user as the pre-install text identity.
- [x] Secure session handling (short-lived access + refresh, secure storage on device). Auth middleware on every endpoint.
- [x] Continuity: on first app sign-in, hydrate the existing relationship — conversation history, learned preferences, pending task/tool previews — so onboarding is never repeated.
- [x] Typed API client + server-state query layer in the app; wire the four tabs to real (empty-but-real) data instead of mock arrays.
- [x] Migrations tooling; seed script for local/dev accounts.

## Definition of Done
- [x] A user can verify a phone number and get a persistent, authenticated session that survives app restart.
- [x] Signing in with a number that already has text-side context surfaces that history/preferences immediately — no re-onboarding.
- [x] The four tabs read/write real records through the API; data persists across restarts.
- [x] Every endpoint requires auth; no secret ships in the app bundle.

## Guardrails
- One record, many views — do not duplicate the same real-world item across tables.
- Never a destructive migration that could drop historical progress.
- Treat health/financial/emotional fields as sensitive at the schema/access level from day one.
