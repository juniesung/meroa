# Phase 6 — Personalization, Memory & Trust

**Status:** ☑ Done (2026-07-14/15)
**Goal:** Meroa adapts to how each person works, remembers what's useful (and only that),
gives the user full control over memory, and honors safety boundaries and quiet hours.
**Depends on:** Phase 5 (a working loop to personalize).

## In scope
- Adaptive vibe, memory storage + user controls + sensitivity, quiet hours / proactive limits, and the safety boundaries as enforced behavior.

## Out of scope
- Billing/premium gating of "deeper memory" (Phase 7) — build the capability here; gate it there.

## Tasks
- [x] Onboarding vibe pick: Chill / Supportive / Direct / Playful / Balanced — treated as a **starting point**, not a fixed setting. **Superseded (2026-07-19):** the standalone `vibe-pick` screen was folded into a combined pre-paywall onboarding questionnaire (focus areas + this same style pick) — see `docs/phases/phase-7-premium-billing.md`. The style options, behavior, and "changeable any time in You" contract are unchanged; only where/when it's shown moved.
- [x] Adaptive style: learn from conversation + explicit feedback — message length, directness, formality, humor, emoji, question frequency, and whether encouragement / challenge / a smaller next step actually drives action. Support **topic-specific** tone (e.g., blunt on work, gentle on personal).
- [x] Memory model: retain useful preferences and goals, **not** every casual detail forever.
- [x] Memory controls UI (in the You tab): view what's remembered, correct it, delete it, mark items **sensitive**, and "don't bring this up unless I do."
- [x] Sensitivity: health/financial/emotional info handled as sensitive even when entered manually.
- [x] Relevant-context retrieval so replies use the right memories at the right time (without dumping everything). **Known simplification, accepted:** this is a flat recency cap (`listMemories(userId).slice(0, 50)` in `routes/messages.ts`), not true relevance filtering — the model picks what "fits" at generation time from up to 50 memories, not a retrieval step. Fine while users are well under 50 memories; revisit if that stops being true.
- [x] Quiet hours, proactive-message caps, and opt-out controls that actually govern notifications/follow-ups. Proactive caps are N/A today — there's no server-side proactive-outreach system, only one user-scheduled local reminder per task, so no cap was invented for a message stream that doesn't exist.
- [x] Safety boundaries as behavior: no dependence/exclusivity/possessiveness, no "replace real relationships", not a therapist/doctor/adviser/emergency service, don't reinforce harmful self-judgment to match tone.

## Definition of Done
- [x] Style visibly adapts over a session and to explicit feedback; topic-specific tone works.
- [x] A user can view, edit, delete, and mark memories sensitive, and suppress a topic — and Meroa respects it.
- [x] Quiet hours and proactive limits are honored; nothing pings outside them.
- [x] Safety boundaries hold under tone-matching pressure. Verified via a 9-scenario adversarial red-team against the live provider (deepseek-v4-flash) — see `docs/safety-redteam-2026-07-15.md`. **Scope caveat:** single-shot per scenario, not repeated trials, and no multi-turn jailbreak/roleplay-bypass attempts — a solid first pass, not an exhaustive adversarial audit.

## Provider decision (was open since Phase 5)
**deepseek-v4-flash confirmed as the production provider.** Tied Sonnet 5 on the 10-op accuracy test (27/27 both), 3.4× cheaper, 1.8× faster, passed a clean 55/56 real battery run on a fresh account (the 1 failure is a stale test assertion — see below), and held all 9 safety red-team scenarios. The App Store 5.1.2(i) named-provider-consent / China-regulatory-optics question from earlier research remains genuinely open and should be resolved before store submission (Phase 8), but no longer blocks development.

## Known stale test assertion (not fixed, logged here per user decision)
`server/scripts/battery.sh`'s "today's occurrence done" assertion (§C, water counter) expects `did my water for today` to mark a 3/10 counter as fully done. The model now correctly asks for the actual count instead of guessing — the right behavior per CLAUDE.md's "never invent a number" rule and the water-task ambiguity guard (see git history). The assertion predates that guard. Left as-is by user decision (2026-07-15); fix if it's ever confusing to a future run.

## Guardrails
- Friend mode never disappears; personalization must not drift into dependence or possessiveness.
- Sensitive data stays sensitive by default; forget the trivial, keep the meaningful.
