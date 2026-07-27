# Meroa Pre-Launch Audit — consolidated findings

> Produced 2026-07-26 by a five-track code audit against the pre-launch checklist.
> Every finding is grounded in `file:line` evidence. Status: **PASS** (verified
> done) · **FAIL** (verified missing/broken) · **PARTIAL** (partly done) ·
> **RUNTIME** (only verifiable by running on device/load/live-DB). **Not legal
> advice** — the §10 statutory items need counsel review.

## Stack corrections (the checklist's assumptions were wrong)

- LLM is **OpenAI gpt-5-mini/nano**, not Anthropic Sonnet.
- Client is **Expo/React Native**, not native iOS.
- Minimum age is **13**, not 18.
- **One** paid tier (Meroa Plus $11.99/mo) with a 7-day-trial hard paywall.
- Postgres via **direct node-postgres** connection — RLS is off *by design*, so
  all tenant isolation is app-code query predicates (audited — see DB §2).

## Verdict

The **application core is in good shape**: billing, IDOR/tenant-isolation, the AI
tool layer (loop bound, malformed-input handling, ref validation, idempotency,
context truncation, transactions), secrets, and the AI-consent gate all **PASS**.
The gaps cluster in three areas: **companion-chatbot law (statutory, highest
exposure)**, **cost/spend observability & controls**, and **production
reliability (ops)**. Nothing found is an architectural rewrite; most are additive.

---

# TIER 1 — Fix before you submit (App Store rejection + legal exposure)

### 1. No age collection / age gate at all — FAIL
Onboarding (`src/app/onboarding.tsx`) collects focus/goal/tone but **never asks
DOB or age**; `users` has no age column (`server/src/db/schema.ts:20-33`); "13+"
exists only as Terms prose (`legal.ts:192`), enforced nowhere. Apple flags
companion-AI apps without age assurance, and with min-age 13 the SB 243 minor
provisions (13–17) are in scope. **Fix:** collect DOB in onboarding, store it
server-side (account is phone-keyed, so it survives reinstall), block under-13,
and set the store age rating at submission (currently unset — `app.json` has no
age config).

### 2. Recurring 3-hour AI-disclosure reminder — FAIL (statutory)
No code re-surfaces "you're talking to an AI" on any timer (searched all
intervals). CA **SB 243** and NY **GBL §1700** both require it at conversation
start *and* at least every 3 hours of continuous interaction. SB 243 carries a
**private right of action** ($1,000/violation). **Fix:** track per-conversation
continuous-interaction time server-side and inject a disclosure message / client
banner at ≥3h boundaries.

### 3. AI disclosure not present in the chat itself — PARTIAL
Disclosure is only at one-time sign-in (`(auth)/sign-in.tsx:74`) and consent
(`ai-consent.tsx:33`) screens; the chat header shows only "Meroa" + a status dot
(`(tabs)/index.tsx:912-919`). SB 243 wants it conspicuous *at the start of
interaction*. **Fix:** persistent AI-identity line in the chat header or an
always-visible first-run disclosure in the thread.

### 4. Self-harm handling is prompt-only — FAIL (statutory)
Crisis handling exists **solely** as a system-prompt instruction
(`system-prompt.ts:50-51`) that even *discourages* routing ("don't reel off a
hotline like a script"). No deterministic detector, no guaranteed 988 surface,
no crisis-event logging, no published protocol. SB 243 requires an actual
detect→refer protocol, published, with event counting for the **2027 OSP report**.
**Fix (four parts):**
- Deterministic self-harm detector (server-side keyword/classifier gate on the
  user message) that fires regardless of model phrasing.
- Render **988** (and 741741) unmissably when it fires; also cite 988 on the
  legal/support pages (they currently say only "local emergency services",
  `legal.ts:189,223,265`).
- Anonymized crisis-referral **event log** (no user identifiers) for the 2027 report.
- A public **/safety** page documenting the protocol.

### 5. Roleplay-framed self-harm red-team — RUNTIME (must run before submit)
`docs/safety-redteam-2026-07-15.md` tested 9 single-shot scenarios (all held) but
was run on **DeepSeek** (now gpt-5-mini) and **explicitly excluded** roleplay /
jailbreak framing (lines 11-13) — the most dangerous bypass for a
relationship-first app. **Re-run on gpt-5-mini with roleplay/jailbreak framing.**

### 6. No reset / clear-conversation action — PARTIAL
Report mechanism is fully implemented (`messageReports`, `messages.ts:67-84`,
long-press UI), but there's **no block and no reset/clear-conversation** — the
only erase is full account deletion. SB 243 / store UGC expectations want a
conversation reset. **Fix:** add a "clear/reset conversation" action.

**TIER 1 also needs:** the App Review notes (demo/sandbox account, reverse-trial
walkthrough, and an explicit note on the 18-vs-13 gate, AI disclosure, and crisis
protocol so the reviewer sees compliance). PASS already: AI-consent gate is real
and server-enforced (`messages.ts:226`, `lib/consent.ts:14`); no
personhood/therapist claims anywhere.

---

# TIER 2 — Fix before real traffic (production reliability & cost)

### 7. No global spend circuit breaker — FAIL
All limits are per-user; there's no rolling aggregate token/$ counter across all
users (grep confirmed absent). A viral spike, prompt-injection storm, or one
abusive paid account runs OpenAI cost to arbitrary heights with nothing tripping.
**Fix:** a global rolling token/$ counter (Redis INCR w/ TTL or Postgres
aggregate) checked before the act pass; trip to a static "at capacity" reply.

### 8. Cost is unobservable — FAIL
No token usage is logged anywhere (`logTurn` logs only tool calls,
`shared.ts:411`); streaming calls don't set `stream_options:{include_usage:true}`
and the act pass never reads `completion.usage` (`act-narrate.ts:327`). You'd
learn about a cost blowout from the OpenAI bill, not your logs. Compounded by
quotas metering **message count, not tokens** (`usage.ts:43`), so per-message
cost is unbounded. **Fix:** log input/output/reasoning tokens per turn (you
already log `userId`+`sourceMessageId`); consider a token or monthly ceiling.

### 9. `/health` doesn't check the DB — FAIL
`index.ts:49` returns static `{ok:true}`; a load balancer can route to an
instance that can't reach Postgres. **Fix:** run `select 1` in the handler.

### 10. No SIGTERM graceful shutdown — FAIL
No `process.on('SIGTERM')`; the pg pool is never drained/closed. Railway sends
SIGTERM on **every deploy**, so in-flight requests/SSE streams are killed each
time. **Fix:** trap SIGTERM → stop accepting → drain in-flight → `queryClient.end()`.

### 11. SMS-pumping — `/otp/request` has no IP/global cap — PARTIAL
OTP is limited **per phone** only (`otp.ts:27-50`); each request sends a real SMS
(`auth.ts:37`), so phone-number rotation drives real cost with no global/IP
ceiling. `/auth/refresh` and `/logout` have no limit at all. **Fix:** IP-bucketed
limiter (shared store) on `/otp/request` especially.

### 12. No timeout on the main OpenAI call — PARTIAL
Utility calls have AbortController timeouts, but the main act+narrate completions
inherit the SDK's **10-minute** default (`act-narrate.ts:302,622`). RevenueCat
fetches have **no timeout** either (`revenuecat.ts:17,51`) — a hung RC call
blocks purchase-sync/webhook. **Fix:** explicit `timeout` (30–60s) on the main
OpenAI client and an `AbortSignal` on the RC fetches.

### 13. No cancellation on client disconnect (zombie stream) — PARTIAL
The request carries no `AbortSignal` into the AI generator, so a client disconnect
doesn't stop the act/narrate passes — they run to completion and keep spending
tokens (bounded by `MAX_TOOL_ITERATIONS`). **Fix:** wire `c.req.raw.signal`
through into the OpenAI calls.

### 14. Conversation content in logs + no Sentry scrubbing — PARTIAL
Guard-correction paths log assistant reply text (`shared.ts:497,566,624`) and
`memory-extractor.ts:238` logs memory content; `Sentry.init` has no `beforeSend`
scrubber (`index.ts:24`). For a companion app handling health/financial/emotional
content (CLAUDE.md §2), that's sensitive data reaching logs/error reports.
**Fix:** drop `segments`/`content` from those payloads; add a Sentry `beforeSend`.

### 15. In-memory burst limiter breaks at >1 replica — PARTIAL
The burst limiter is an in-memory `Map` (`middleware/rate-limit.ts:23`), documented
as per-process. The real per-user cap (Postgres quota) holds across replicas, but
the burst limiter becomes decorative the moment Railway runs a 2nd replica.
**Fix:** back it with Redis/Postgres before scaling out.

---

# TIER 3 — Hardening before scale / volume

### 16. `records` hot-path index gap — PARTIAL (FAIL at volume)
The append-only, unbounded-growth core table has only `records_user_idx
(user_id)`, but per-write idempotency lookup, undo, and the card-acted-on check
all filter+sort a user's whole record history in memory (`executor.ts:83-96,
1178-1212`; `messages.ts:339-349`). First thing to degrade as usage accumulates.
**Fix:** `CREATE INDEX ON records(user_id, source_message_id);` + partial
`CREATE INDEX ON records(user_id, created_at DESC) WHERE reverted_at IS NULL;`.

### 17. Missing FK indexes — PARTIAL
8 FKs lack a supporting index; the two hot ones are `tasks.goal_id` and
`goal_entries.record_id` (hit on every goal-cascade/uncomplete/retro-credit path).
**Fix:** btree index each, prioritizing those two.

### 18. Connection-pool ceiling on scale-out — PARTIAL / RUNTIME
pool `max:10` per process with no per-replica accounting (`db/client.ts:15`); safe
at 1 replica, but 10×N can exceed the Supabase session-pooler limit at N≥2–3.
**Before scaling:** verify replica count vs. plan ceiling; lower `max` or move to
the 6543 transaction pooler (`prepare:false`).

### 19. Smaller hardening — PARTIAL (low severity)
- Auth is per-router **opt-in**, not deny-by-default — all routes covered today,
  but a future route that forgets `requireAuth` ships public. Move to global auth +
  public allowlist (`index.ts`).
- Access token is a stateless JWT never re-checked, so a **logged-out/deleted
  user's access token stays valid until TTL** (`middleware/auth.ts`). Keep TTL
  short and/or add a session check.
- JWT algorithm not pinned (`lib/jwt.ts:18`) — add `{algorithms:['HS256']}`.
- No DB-level length caps on user-writable `text` (Zod-backstopped at the API,
  so a bypassing internal writer/seed could overflow). Defense-in-depth only.

---

# What PASSED (verified solid — don't re-litigate)

- **Billing/entitlements (all code items):** server is source of truth, client
  can't forge `plan`, webhook is authed (constant-time 401) + idempotent +
  out-of-order tolerant, no mock/debug entitlement flag, paywall meets Apple
  3.1.2 (price/period/auto-renew/Terms+Privacy), Restore works, trial is
  Apple-anchored (reinstall can't mint a second). `billing.ts`, `lib/billing/*`,
  `paywall.tsx`.
- **IDOR / tenant isolation:** every data-access query scoped by JWT `userId`
  (or owning-parent join); server never trusts a client-supplied user id.
  `*/executor.ts`, `me.ts`.
- **AI tool layer:** tool-loop bound (`MAX_TOOL_ITERATIONS=3`), malformed-input
  handled, hallucinated-ref validation (user-scoped ref maps), within-turn
  idempotency, context truncation (24 msgs / 16k chars), multi-write transactions.
- **Security basics:** no secrets in bundle or git history, parameterized SQL
  everywhere, ATS on, no stack-trace leaks, OpenAI SDK retry/backoff present.
- **Consent & copy:** AI-consent gate real + server-enforced; no
  personhood/therapist claims in Terms, Support, or the system prompt.
- **DB integrity:** all FKs have explicit ON DELETE, all timestamps `timestamptz`,
  CHECK constraints thorough, unique constraints all present, migrations run as a
  separate step (no boot race).

---

# RUNTIME-gated (cannot be closed in code — needs device/load/live infra)

- **§1 sandbox purchase matrix** — the entire Phase 7 DoD: purchase→trial→plus,
  restore, reinstall-no-2nd-trial, refund→downgrade, grace period, cross-account
  transfer. Needs `eas build` on a physical device + sandbox tester.
- **§8 iOS client** — cold-launch, cellular, network-transition mid-stream,
  backgrounding mid-response, offline compose, memory growth, Dynamic Type /
  VoiceOver, iPad, deep links, TestFlight crash-free rate (≥20 testers/1 week).
- **§11 load & failure** — k6/autocannon at 10× peak vs staging; kill DB / kill
  replica / blackhole OpenAI mid-load; watch DB connections + p99.
- **§12 launch-day runbook** — write down: one-command rollback (tested),
  maintenance toggle, Supabase/Railway support tiers, spend limits per provider,
  monitored support inbox, soft-launch storefront (NZ/CA), day-one dashboard.
- **DB live checks** — `pg_class` RLS confirmation, `EXPLAIN ANALYZE` on the
  idempotency/undo queries at seeded volume, `pg_stat_activity` under load.

---

# Suggested remediation order

1. **TIER 1 compliance block (items 1–6)** — this gates submission *and* is live
   legal exposure; get counsel to review the crisis + disclosure + age posture.
2. **The on-device sandbox test** (Phase 7 DoD) — unblocks the largest bucket of
   RUNTIME items and is already the critical path.
3. **TIER 2 ops/cost (items 7–14)** — before any real traffic / soft launch.
4. **TIER 3 indexes + scale (16–19)** — before volume / a 2nd replica.
