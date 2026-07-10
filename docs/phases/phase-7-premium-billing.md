# Phase 7 — Free & Premium (Billing)

**Status:** ☐ Not started
**Goal:** A paywall backed by platform billing with server-verified entitlements, correct
restore across devices, and free-plan limits that meter the right things.
**Depends on:** Phase 6 (features to gate now exist).

Premium unlocks deeper capability and persistence — **not** a more caring personality.

## In scope
- Apple IAP + Google Play Billing, purchase/restore/renewal/expiry/cancel, server-side entitlement checks, and enforcement of free vs premium limits.

## Free vs Premium (target $19.99/mo)
| Capability | Free | Premium |
|---|---|---|
| Chat | Limited fair-use | Higher fair-use |
| Tasks | ≤ 2 **new** per day | Unlimited (reasonable) |
| Goals | 1 active | Multiple |
| Custom tools | Preview only / unavailable | Create, edit, use many |
| Memory | Basic profile + short context | Deeper long-term memory/patterns |
| Proactive support | Occasional/limited | Configurable follow-ups + summaries |
| Progress history | Short window | Long-term, richer views |

## Tasks
- [ ] Integrate Apple In-App Purchase (iOS) and Google Play Billing (Android) for Meroa Premium.
- [ ] Handle the full lifecycle: purchase, **restore**, renewal, expiration, cancellation.
- [ ] **Server-side entitlement verification** — the source of truth is the server, never a client flag. Sync entitlement across devices.
- [ ] Enforce free-plan limits server-side: cap **new task creation** (not completion/updates), 1 active goal, tool creation gated, memory/history windows, proactive frequency.
- [ ] Paywall screen showing price, billing period, renewal, cancellation, privacy, and terms **before** purchase.

## Definition of Done
- A test purchase unlocks premium; deleting/reinstalling and restoring re-grants it via server verification.
- Free limits are enforced server-side and can't be bypassed from the client; **completing** tasks/updating progress is never blocked.
- Entitlement is consistent across two devices signed into the same account.
- The paywall discloses price/terms/renewal/cancellation clearly before any charge.

## Guardrails
- Platform billing only; never trust a client-supplied entitlement.
- Meter **new task creation** on free — nothing about completion or progress.
- Premium changes capability, not warmth.
