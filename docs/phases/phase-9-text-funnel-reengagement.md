# Phase 9 — Pre-install Text Funnel & Re-engagement  *(optional / after the loop works)*

**Status:** ☐ Not started
**Goal:** The discovery funnel from the product journey — a limited SMS experience that
delivers value before install and converts to the app, plus re-engagement messages — wired to the continuity model from Phase 1.
**Depends on:** Phase 1 (identity continuity) and Phase 2 (chat behavior). Can run in parallel once those exist.

**Why it's separate:** the in-app loop (Phases 0–8) is what validates the product, and the
blueprint says longer conversations belong in the app — external texting is "mainly for
onboarding and re-engagement." Outbound SMS is also **regulated** (US A2P/10DLC
registration, consent, opt-out), which adds real lead time. Sequence it after the core loop.

## In scope
- Messaging-provider integration, the limited pre-install bot, the text→app conversion prompt, and re-engagement — all within compliance.

## Out of scope
- Making SMS a full conversational surface. Keep it a funnel that hands off to the app.

## Tasks
- [ ] Integrate a messaging provider; complete required registration/compliance (A2P/10DLC or regional equivalent), consent capture, and honored opt-out/STOP.
- [ ] Pre-install bot: introduces itself as **AI**, has a real (short) conversation instead of a long form, and **delivers value before asking to install** (advice, a recommendation, a small decision, a possible task).
- [ ] Conversion prompt when there's something worth saving/tracking ("…the app lets me make you an actual workout tracker and keep your progress in one place. Want me to set that up?").
- [ ] Handoff: the same verified phone number links the text relationship into the app (uses Phase 1 continuity) — nothing re-entered.
- [ ] Re-engagement messages within quiet-hours/opt-out limits from Phase 6.

## Definition of Done
- A new person can text Meroa, get value, and be invited to the app at a natural moment.
- Verifying that number in the app restores the text-side history/preferences with no re-onboarding.
- Compliance is in place: consent recorded, opt-out honored, registration complete.
- Re-engagement respects quiet hours, frequency caps, and opt-out.

## Guardrails
- Always identified as AI over text.
- Value before install; don't lead with a download ask.
- Keep long conversations in the app; SMS is a funnel, not the product.
