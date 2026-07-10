# Phase 4 — Tools

**Status:** ☐ Not started
**Goal:** Persistent, personalized trackers the user describes in conversation: Meroa asks
only what matters, shows a preview before saving, then supports entry, charts, history, and edit-with-AI.
**Depends on:** Phase 3.

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
- [ ] Tool definition model: a tool = typed fields + progress view(s) + actions, versioned so layout can change without losing past entries.
- [ ] Start with the strong templates above (don't build a fully open-ended builder first).
- [ ] Creation flow via chat: user describes the outcome → Meroa asks **only** questions that change the result → renders a **visual preview** (fields, progress views, actions) → user confirms or requests changes → tool saves under the Tools tab.
- [ ] Extend the AI action layer: `create_tool` (returns a preview, not an immediate save), `edit_tool` ("add RPE", "change goal to $2,000", "show weekly averages").
- [ ] Direct record entry from the tool's own UI (quick-entry bottom sheet); charts and history views.
- [ ] Edit-with-AI from within a tool; edits preserve historical entries.

## Definition of Done
- A user describes a goal in chat and gets a preview before anything is saved; confirming creates a working tool; requesting a change updates the preview.
- At least the workout, habit, numeric, and money templates are usable end-to-end (create → log → see chart/history).
- Editing a tool's fields (e.g., adding RPE, changing a target) keeps all prior entries intact.

## Guardrails
- Preview **before** save — never silently create a tool.
- Only ask questions that change the result; don't interrogate.
- Never fabricate entries; past records are immutable across layout changes.
