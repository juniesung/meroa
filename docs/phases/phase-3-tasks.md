# Phase 3 — Tasks

**Status:** ☑ Done
**Goal:** Short-term action that works from both the Tasks UI and plain-language chat:
all task types, recurring instances, completion, reminders, and shame-free missed-task recovery.
**Depends on:** Phase 2 (needs the AI action layer's first real actions).

## In scope

- The full task model + the first slice of the AI action layer (task actions), reminders, and recovery flows.

## Out of scope

- Tools (Phase 4) and cross-linking a task to a tool (Phase 5). Tasks stand alone this phase.

## Task types to support

Completion (single checkbox + optional note) · Checklist (sub-items + %) · Counter (increment toward a target) · Duration (timer or manual minutes) · Numeric meter (progress bar / ring) · Recurring (spawns a dated instance per occurrence).

## Tasks

- [x] Task data model covering all six types; recurring generates separate **dated** instances (not one mutable row).
- [x] Create/edit/complete/postpone/remove from the **Tasks UI** (bottom sheets for quick create/edit).
- [x] Create/edit/complete/postpone/remove from **chat**: extend the AI action layer with `create_task`, `edit_task`, `complete_task`, `postpone_task`, `remove_task`. Actions are allow-listed, validated, and **confidence-gated** — vague requests get a short confirming question ("add it for today and check in around 6?").
- [x] A task created via chat shows a **task card in Chat** and appears in the **Tasks tab** (same record).
- [x] Reminders via Expo Notifications — scheduled **only** if the user allows proactive check-ins.
- [x] Missed-task recovery: light but honest ("what happened — bad timing, low energy, or did you just avoid it?"), then resize / reschedule / reduce friction / reconsider the goal — no shame.

## Definition of Done

- [x] Each of the six task types can be created, completed, and edited from both UI and chat.
- [x] A recurring task produces correct dated instances; completing one doesn't wrongly affect others.
- [x] Vague chat requests trigger a confirmation before a task is written; clear ones create directly.
- [x] Reminders fire only with permission; missed-task recovery offers real adjustments.
- [x] Any task action is reversible ("undo that").

## Known follow-ups (not blockers)

- A `task_action` chat card resolves live state from the tasks query by id, falling back to the creation-time `meta` snapshot only if the task isn't found there (e.g. it was later deleted). That snapshot doesn't reflect a later removal, so an old chat card for a task that was since deleted can still render as if open — cosmetic, and the Tasks tab itself is always accurate.
- Interactive tap-driven UI flows (bottom sheets, checkbox/increment/timer taps) are implemented and were verified via direct REST calls against the running server plus visual rendering checks (including reload-from-history); end-to-end simulator tap automation hit an unrelated tooling issue mid-session and wasn't completed for this pass.

## Guardrails

- Ask before turning an uncertain thought into a tracked task.
- Never invent details (time, count) to complete a task — ask.
- Metering note: free plan limits **new task creation** only; completion/updates are never metered (enforced fully in Phase 7).
