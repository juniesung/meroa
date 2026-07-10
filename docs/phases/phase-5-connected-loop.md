# Phase 5 — The Connected Loop  ⭐ (the MVP's reason to exist)

**Status:** ☐ Not started
**Goal:** One natural progress report becomes a single stored record that updates every
place it matters — Chat, the linked Task, and the linked Tool — reversibly and without invented data.
**Depends on:** Phases 3 and 4.

This is the phase the whole MVP exists to prove. Phases 3–4 were prerequisites.

## In scope
- Linking tasks ↔ tools, structured extraction from free text, single-write-many-views propagation, confidence gating, and undo.

## The target behavior
> User: "finished chest today, bench was 165 for 8."
> 1. Meroa finds today's chest **task** and the linked workout **tool**.
> 2. Extracts `Bench Press, 165 lb, 8 reps, today`.
> 3. If clear, records the set; if not, asks a short clarification.
> 4. The chest **task** completes.
> 5. The weekly workout count + bench chart (**tool**) update.
> 6. Reply uses history: "logged it — that's 10 lb over your last recorded top set."

## Tasks
- [ ] Link model: a task may reference a tool (e.g., "chest workout today" → strength tool) so completion can flow into the tool.
- [ ] Extraction: the AI action layer parses free-text progress into structured updates (exercise/weight/reps, amount spent, minutes studied…) with a confidence score.
- [ ] **Single write, many views:** persist one record; Chat, Tasks, and Tools all derive from it. No duplicate rows.
- [ ] Confidence gating: high-confidence → write and confirm; low-confidence → ask before writing. **Never invent** a missing number.
- [ ] Undo: "undo that" cleanly reverses the write across every affected view; prior state restored.
- [ ] History-aware replies: responses reference prior data ("10 lb over your last top set", "that's your 4th workout this week").
- [ ] Reconcile edge cases: a completion with no linked tool, a tool log with no matching task, ambiguous which tool, multiple candidate tasks.

## Definition of Done
- One free-text report ("benched 165 for 8", "spent $18 on lunch", "studied 50 minutes") updates the correct task **and** tool from a single stored record.
- Ambiguous reports prompt a short clarification instead of guessing; no fabricated values ever appear.
- "Undo that" reverses the update everywhere and restores prior state.
- At least one reply demonstrably uses stored history to add context.
- **The full MVP loop now runs end-to-end** (see CLAUDE.md §1 "done when").

## Guardrails
- Store once, show everywhere — the single most important rule in the app.
- Confirm on low confidence; never invent numbers; every write reversible; history survives edits.
