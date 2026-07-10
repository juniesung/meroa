# Phase 6 — Personalization, Memory & Trust

**Status:** ☐ Not started
**Goal:** Meroa adapts to how each person works, remembers what's useful (and only that),
gives the user full control over memory, and honors safety boundaries and quiet hours.
**Depends on:** Phase 5 (a working loop to personalize).

## In scope
- Adaptive vibe, memory storage + user controls + sensitivity, quiet hours / proactive limits, and the safety boundaries as enforced behavior.

## Out of scope
- Billing/premium gating of "deeper memory" (Phase 7) — build the capability here; gate it there.

## Tasks
- [ ] Onboarding vibe pick: Chill / Supportive / Direct / Playful / Balanced — treated as a **starting point**, not a fixed setting.
- [ ] Adaptive style: learn from conversation + explicit feedback — message length, directness, formality, humor, emoji, question frequency, and whether encouragement / challenge / a smaller next step actually drives action. Support **topic-specific** tone (e.g., blunt on work, gentle on personal).
- [ ] Memory model: retain useful preferences and goals, **not** every casual detail forever.
- [ ] Memory controls UI (in the You tab): view what's remembered, correct it, delete it, mark items **sensitive**, and "don't bring this up unless I do."
- [ ] Sensitivity: health/financial/emotional info handled as sensitive even when entered manually.
- [ ] Relevant-context retrieval so replies use the right memories at the right time (without dumping everything).
- [ ] Quiet hours, proactive-message caps, and opt-out controls that actually govern notifications/follow-ups.
- [ ] Safety boundaries as behavior: no dependence/exclusivity/possessiveness, no "replace real relationships", not a therapist/doctor/adviser/emergency service, don't reinforce harmful self-judgment to match tone.

## Definition of Done
- Style visibly adapts over a session and to explicit feedback; topic-specific tone works.
- A user can view, edit, delete, and mark memories sensitive, and suppress a topic — and Meroa respects it.
- Quiet hours and proactive limits are honored; nothing pings outside them.
- Safety boundaries hold under tone-matching pressure.

## Guardrails
- Friend mode never disappears; personalization must not drift into dependence or possessiveness.
- Sensitive data stays sensitive by default; forget the trivial, keep the meaningful.
