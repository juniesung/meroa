# Phase 5 — The Connected Loop  ⭐ (the MVP's reason to exist)

**Status:** ☑ Done (2026-07-13)
**Goal:** One natural progress report becomes a single stored record that updates every
place it matters — Chat, the linked Task, and the linked Goal — reversibly and without invented data.
**Depends on:** Phases 3 and 4.

This is the phase the whole MVP exists to prove. Phases 3–4 were prerequisites.

> **Wording note.** This spec was written before the Goals redesign, when the third
> surface was called **Tools** (a generic field/template builder). Tools was scrapped and
> replaced by **Goals** — four concrete types: savings, habit, indirect, milestone
> (`docs/goals-redesign-plan.md`, CLAUDE.md §9). Everything below now says "goal". The
> original DoD examples map cleanly: "benched 165 for 8" → an **indirect** goal's
> `log_goal_entry`; "spent $18 on lunch" → a **savings** goal entry; "studied 50 minutes"
> → a duration task.

## In scope
- Linking tasks ↔ goals, structured extraction from free text, single-write-many-views propagation, confirmation gating, and undo.

## The target behavior
> User: "finished chest today, bench was 165 for 8."
> 1. Meroa finds today's chest **task** and the linked bench **goal**.
> 2. Extracts `165 lb, today`.
> 3. If clear, records it; if not, asks a short clarification.
> 4. The chest **task** completes.
> 5. The bench **goal** total/chart updates.
> 6. Reply uses history: "logged it — that's 10 lb over your last recorded top set."

## Tasks
- [x] Link model: a task may reference a goal (`tasks.goalId` + `config.goalContribution`), so completing it flows into the goal — savings auto-logs its amount, habit counts it as the check-in, indirect/milestone treat it as supporting activity only (never a number). Linkable at creation *or* after the fact (`create_task`/`edit_task` `goalLink`, `unlinkGoal`).
- [x] Extraction: the AI action layer parses free-text progress into structured tool calls. **No numeric confidence score** — see the note below.
- [x] **Single write, many views:** one `records` row is the source of truth; a `goal_entries` row references *that same record id*, never a copy. Chat, Tasks, and Goals all derive from it. Verified against the DB in the acceptance run.
- [x] Confirmation gating: ambiguous → ask; **never invent** a missing number.
- [x] Undo: "undo that" reverses the write across every view — task reopens, goal entry drops out (its record is marked `reverted_at`, and every summary filters on that), total restored.
- [x] History-aware replies: server-computed completion history ("that's your 4th time this week") — `lib/ai/history.ts`, stated as a fact on the tool result so the model quotes it and never counts anything itself. Indirect goals also state delta-vs-previous (`goalHeadlineWithDelta`).
- [x] Reconcile edge cases: a completion with no linked goal, a goal entry with no matching task, ambiguous which goal, multiple candidate tasks. All four exercised live; the last one surfaced a real bug (see below).

### On "confidence gating" — why there is no confidence score
The DoD asks that "ambiguous reports prompt a short clarification instead of guessing; no
fabricated values ever appear." That is enforced **structurally**, by three shipped
mechanisms, rather than by a model-emitted confidence float (which would just add a new
lie surface — the model scoring its own certainty):
1. Fail-loud zod schemas with corrective messages (`createGoalParamsSchema`'s superRefine).
2. Never-invent-a-number rules in every tool description and in `SYSTEM_PROMPT`.
3. Tap-to-confirm cards (`remove_task`, `remove_tasks`, `create_goal`, `advance_goal_stage`) where **the tap is the consent** — nothing is written until it happens.
4. The action pass refuses to guess: when the user's words could match more than one task or goal, it calls `no_action` with a reason, and the reply pass asks which they meant.

## Definition of Done
- [x] One free-text report updates the correct task **and** goal from a single stored record.
- [x] Ambiguous reports prompt a short clarification instead of guessing; no fabricated values ever appear.
- [x] "Undo that" reverses the update everywhere and restores prior state.
- [x] At least one reply demonstrably uses stored history to add context.
- [x] **The full MVP loop now runs end-to-end** (see CLAUDE.md §1 "done when").

## Guardrails
- Store once, show everywhere — the single most important rule in the app.
- Confirm on low confidence; never invent numbers; every write reversible; history survives edits.

## Acceptance run (2026-07-13)
The formal DoD protocol was run live on a fresh dev-token account against
deepseek-v4-flash with act/narrate on, inspecting the DB between steps — never a unit test
standing in for a real turn. All 9 steps pass. It found **three real bugs**, all invisible
to `tsc` and the unit suite; each was root-caused and fixed, and all are recorded in
`docs/goals-redesign-plan.md`'s ledger:
1. The action pass **stalled into `no_action`** when a clarifying question was left dangling and the user answered an older one (2/3 reproduction) — a complete goal spec produced no card at all.
2. An ambiguous "mark water done" (matching two tasks) made the action pass **guess and complete one** while the reply asked which was meant — a silent write to a possibly-wrong task.
3. "Undo that" while a *pending* tap-to-confirm card was showing **reached past it and silently reverted an older, unrelated completion**, while the reply claimed "nothing got deleted."

The remaining known wobble is narration quality, not data integrity: on no-action turns
deepseek-v4-flash sometimes claims an action it never took, and the claim-check backstop
retracts it. That is the input to the **provider decision**, which is the next gate before
Phase 6 (`docs/phase-5-completion-plan.md` §6).
