# Phase 2 — Live Chat

**Status:** ☑ Done
**Goal:** Real conversations with Meroa: model-backed replies, persisted history,
streaming/staged output, graceful failure, safe usage limits — with Meroa clearly identified as AI.
**Depends on:** Phase 1.

## In scope
- Server-side AI orchestration for chat, message persistence, streaming, retry/error UX, and fair-use limits.

## Out of scope
- Turning messages into tasks/tools (Phases 3–5). This phase is conversation only; the action layer arrives next.

## Tasks
- [x] Server-side chat orchestration calling the hosted model API. **Keys and prompts live on the server**; the app only sends/receives messages.
- [x] System prompt / behavior encoding the personality rules (CLAUDE.md §2): friend-first, matches the user's register, restraint when natural, no lecture-per-message, **always identified as AI**.
- [x] Persist every message; load history on open; keep conversation context within a sensible window.
- [x] Streaming or staged responses in the UI with a typing indicator; smooth append into the iMessage-style list. (Shipped as staged, multi-bubble replies — Meroa can split a reply into several "texts," each persisted and paced like separate messages arriving, not just token-level streaming.)
- [x] Retry and error states (network loss, model error, rate limit) that never lose the user's draft.
- [x] Fair-use limits: free vs premium chat allowances enforced **server-side** (wire the real premium gate in Phase 7; stub the tiers here). Enforced inside a Postgres advisory-lock transaction so concurrent sends from the same user can't race past the daily cap.
- [x] Basic safety handling in responses: don't pose as a therapist/doctor/adviser; sensible redirect on crisis-type content; no unsupported medical/financial claims.

## Definition of Done
- [x] A user holds a multi-turn conversation; history reloads correctly after restart.
- [x] Responses stream/appear progressively; a forced error shows a retry path without dropping the draft.
- [x] Meroa introduces/identifies as AI and stays in character without lecturing.
- [x] Usage limits are enforced on the server and can't be bypassed from the client.

## Known follow-ups (not blockers)
- If a multi-bubble reply errors mid-turn (some segments already sent, a later one fails), the user's own message is marked "failed"/retryable even though a partial reply is visible. Rare; cosmetic, not data loss.
- The blank-line "these are separate texts" convention can occasionally collide with content that legitimately uses blank lines for its own formatting (e.g. a poem's stanzas). Considered a prompt-level exception for this and deliberately decided against it.

## Guardrails
- The model **proposes**; nothing is written to tasks/tools yet — resist adding action-execution here.
- No client-side model keys, ever.
- Keep replies matched to the user's length/tone; don't turn chat into a form.
