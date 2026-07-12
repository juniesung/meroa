# Phase 4 — Tools

**Status:** ☑ Done (July 12, 2026) — implementation plan + live protocol results in
`docs/phase-4-implementation-plan.md`
**Goal:** Persistent, personalized trackers the user describes in conversation: Meroa asks
only what matters, shows a preview before saving, then supports entry, charts, history, and edit-with-AI.
**Depends on:** Phase 3.

**Before starting:** read `docs/ai-reliability-hardening.md`'s "Lessons for future
phases" section — it's written for exactly this phase. In short: turn-scoped refs, never
database ids, for every tool/field/entry the model can reference; one logical object per
user-perceived thing (a tool's version history must never look like several peer tools);
precompute chart/summary math server-side (never make the model add up entries itself);
every out-of-band mutation (a direct tool-UI entry, an edit made outside chat) narrated
into the next chat turn; and the two guardrails below, both hard-won from live Phase 3
bugs.

## In scope
- Tool definitions from supported components, the preview→confirm creation flow, record entry, history, charts, and editing tools via chat.

## Out of scope
- Auto-updating a tool from a task completion or free-text progress report (Phase 5). Here, entry is direct/explicit.

## Strong first tool types
Workout (exercises/sets/reps/weight/target/history/chart) · Habit (frequency/checklist/streak/notes) · Numeric (unit/target/period/graph/entries) · Project (stages/deadlines/checklist/notes) · Money (currency/target/categories/contributions/remaining) · Journal/List (entries/tags/ratings/links/status).

## What "build any tool" means
Trackers, logs, checklists, planners, dashboards, journals, collections — assembled from
**supported components only**. Meroa does **not** generate arbitrary executable apps.

## Tasks
- [x] Tool definition model: a tool = typed fields + progress view(s) + actions, versioned so layout can change without losing past entries.
- [x] Start with the strong templates above (don't build a fully open-ended builder first). (project deferred — see implementation plan §1.2)
- [x] Creation flow via chat: user describes the outcome → Meroa asks **only** questions that change the result → renders a **visual preview** (fields, progress views, actions) → user confirms or requests changes → tool saves under the Tools tab.
- [x] Extend the AI action layer: `create_tool` (returns a preview, not an immediate save), `edit_tool` ("add RPE", "change goal to $2,000", "show weekly averages").
- [x] Direct record entry from the tool's own UI (quick-entry bottom sheet); charts and history views.
- [x] Edit-with-AI from within a tool; edits preserve historical entries.

## Definition of Done
- [x] A user describes a goal in chat and gets a preview before anything is saved; confirming creates a working tool; requesting a change updates the preview.
- [x] At least the workout, habit, numeric, and money templates are usable end-to-end (create → log → see chart/history).
- [x] Editing a tool's fields (e.g., adding RPE, changing a target) keeps all prior entries intact.

All three verified live against `deepseek-v4-flash` on an isolated dev-token account —
see `docs/phase-4-implementation-plan.md` §"Live protocol results" for the full run.

## Guardrails
- Preview **before** save — never silently create a tool.
- Only ask questions that change the result; don't interrogate.
- Never fabricate entries; past records are immutable across layout changes.
- The preview card's tap is the **only** confirmation — `create_tool`/`edit_tool` should
  fire as soon as there's enough information to render a preview; never also ask "should
  I save this?" in chat text on top of the card. Phase 3 hit this repeatedly (models
  asking for a second, chat-text confirmation before or after the real tap-required
  card), doubling the user's effort for one action.
- An edit surface that can't faithfully represent a tool's actual current value (a
  field, a target, a version) must never silently resave a guessed default over it —
  only send back what the user actually changed. A Phase 3 edit form did exactly this
  and silently corrupted real due dates; a tool's edit form is the same shape of risk.
