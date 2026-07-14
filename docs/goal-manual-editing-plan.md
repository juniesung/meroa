# Manual goal creation & editing — implementation plan

> Status: **planned, not built.** Written 2026-07-13.
> Supersedes the chat-interrogation milestone flow shipped in `541054f`.

---

## 0. The problem, stated honestly

The goals system is **chat-first to a fault**. Today:

- A goal can **only** be born from a chat preview card — `POST /goals` accepts nothing but
  a `previewMessageId`. There is no way to create a goal by hand.
- `PATCH /goals/:id` can edit a name, icon, target, deadline, unit — and **not** a
  milestone's stages. They are frozen at creation, forever. The prompt literally instructs
  the model to tell the user this isn't supported.
- The only goal UI is `GoalEntrySheet` (log a number). There is no create sheet, no edit
  sheet, no `+` button on the Goals tab.

So when the user asked for milestone goals to stop inventing their plan, the only lever
available was **chat**, and I used it: ask for the milestones, then ask for the first
stage's tasks, then ask again at every advance. It works (63/63 on the flow test) but it
is *clunky*, and it is clunky for a structural reason:

**Chat is the worst possible input surface for a structured list.** Typing "applying,
interviewing, negotiating" into a text box, to be parsed by a model, to render a card you
then confirm, is a bad trade against tapping "+ Add stage" three times. It also forced the
act pass's history window from 4 → 6 just to hold the conversation together.

The fix is to put each job where it belongs:

| job | belongs in |
| --- | --- |
| capturing **intent** ("I want to land an internship") | **chat** |
| **structured editing** (stages, per-stage tasks, reordering) | **the UI** |

---

## 1. Decisions (confirmed with the user)

1. **Chat takes stages if given, else makes a bare template.** If the message lists the
   milestones, use them. If it doesn't, create the goal with just a name and let the card
   say *"open in Goals to add your stages."* **Never a second question, never an invented
   stage.** One message, one tap, then the user is in the UI with full control.
2. **Tasks can be planned for any stage, not just the current one.** The user lays out
   "for Interviewing I'll do mock interviews" *before* reaching Interviewing. Those tasks
   lie dormant and activate on advance.
3. Manual create/edit covers **all four goal types** (savings, habit, indirect, milestone).

---

## 2. The key design call: where do planned tasks live?

Requirement 2 sounds like it needs `tasks.stage_index` — a new column, and a dormant task
row for every future stage. **Don't do that.** A dormant row in `tasks` would have to be
excluded from, and would eventually leak into:

- the Tasks tab day list and its counts
- the ring, "6 of 6 done", and the TOMORROW section
- recurring-instance materialization (a dormant daily task must not spawn instances)
- `task-context.ts` (the model's world) and `stateFacts` (the guards' world)
- `consistency.ts` — streaks and Perfect Days, which count live task rows
- `history.ts` — the completion counts the model quotes

That is six filters that must each be got right, in a codebase where **a row the UI renders
but the model can't see** has already caused one production bug (the delete-all divergence).
Adding a class of row that *nothing* should see is asking for the same bug with a new face.

**Instead, planned tasks live inside the goal's own definition** and only become real
`tasks` rows when their stage activates:

```ts
// milestoneGoalDefinitionSchema — `stages` UNCHANGED, one optional field added
{
  type: 'milestone',
  stages: string[],                 // 2-8, as today
  activeStageIndex: number,
  stagePlans?: PlannedTask[][],     // NEW — parallel to `stages`, by index
}
// PlannedTask = the same shape create_goal's starterTasks already uses
//               { title, recurrence?, icon? } — no contribution, ever
```

Why this is the right shape:

- **No migration.** `definition` is JSONB and `stagePlans` is optional — every existing
  goal reads back as "no plans", which is exactly true. Nothing to backfill.
- **No new task-table state.** A planned task is not a task. It cannot leak into the day
  list, a streak, a ring, or the model's context, because *it does not exist* until its
  stage activates. The six filters above stay untouched.
- **The activation machinery already exists.** `advance_goal_stage` already takes
  `nextStageTasks` and creates real task rows on the tap. Advance simply reads the plan
  instead of asking the user for it. This is a *smaller* change than what it replaces.

The one cost: `stagePlans` is index-aligned with `stages`, so inserting/removing/reordering
a stage must reorder the plans in lockstep. That lives in exactly one function
(`applyStageOps`) and gets a unit test.

---

## 3. Work items

### Server

**3.1 `lib/goals/schema.ts`**
- Add `plannedTaskSchema` (reuse the existing starter-task shape) and `stagePlans` to
  `milestoneGoalDefinitionSchema` — optional, max 8 stages × max 5 tasks.
- Extend `editGoalPatchSchema` with `stages?: string[]` and `stagePlans?: PlannedTask[][]`.
- New pure `applyStageOps(definition, nextStages, nextPlans)` enforcing the invariants:
  - 2–8 stages, `activeStageIndex` stays valid.
  - **Stages already completed are immutable in count and order.** The first
    `activeStageIndex` entries may be *renamed* (a label) but not removed or reordered —
    removing one would rewrite history the user actually lived. Everything from
    `activeStageIndex` onward is free to add/remove/reorder.
  - `stagePlans` is reordered to match, never silently dropped.

**3.2 `routes/goals.ts`**
- `POST /goals` becomes a union: `{ previewMessageId }` (unchanged, chat path) **or** a
  full definition (new, manual path). The manual path reuses the *same* executor and
  writes the *same* `goal_created` record, so undo and the recent-changes feed work
  identically — a manually created goal must be indistinguishable downstream.
- `PATCH /goals/:id` routes stage edits through `applyStageOps`.

**3.3 `lib/goals/executor.ts` — advance**
- On advance, if the caller supplied no `nextStageTasks`, **materialize the next stage's
  `stagePlans` entry** into real tasks. If it did supply them (the user said it in chat),
  use those. Same code path as today, new default source.

**3.4 Chat (`tools.ts`, `system-prompt.ts`)** — *this is mostly deletion*
- `create_goal`: milestone `stages` becomes **optional** (use them if stated, omit
  otherwise); `starterTasks` no longer required for milestone.
- `advance_goal_stage`: **delete the ask-for-next-stage-tasks rule** — the plan is already
  on the goal. Advance goes straight to its card again.
- Delete the two-question milestone build from both prompts.
- The card's server-computed `detail` line carries the handoff:
  *"Open in Goals to add your stages"* / *"3 stages set — add tasks in Goals"*. No prose:
  the card stays the confirmation (§3 of `chat-architecture.md`).

**3.5 `ACTION_PASS_HISTORY_MESSAGES`: 6 → 4**
- The build collapses to a single message, so the five-message span that forced 6 is gone.
- 6 was already measured as safe; 4 is safer (less pattern-completion surface). **Re-run
  the long e2e to confirm**, since this is a global change.

### Client

**3.6 `features/goals/GoalFormSheet.tsx` (new)** — mirrors `TaskFormSheet` (~800 lines
there; expect ~600 here).
- **Create:** type picker (savings · habit · indirect · milestone), then per-type fields.
  Type is **immutable on edit** — the definition shape is a discriminated union and
  changing type mid-life would orphan entries.
- savings: target, deadline, currency, optional starter task
- habit: the required recurring check-in task (the streak counts it — enforce it here, the
  way the schema already does)
- indirect: unit (locked once entries exist — the server already refuses this; surface it)
- milestone: the stage editor — add / rename / reorder / delete, with planned tasks nested
  under each stage.

**3.7 Goals tab (`app/(tabs)/goals.tsx`)** — `+` button in the header, opening the sheet.

**3.8 Goal detail (`app/goal/[id].tsx`)** — an edit affordance, and for milestones the
stage list from the mock:

```
1. Applying          ← active
   ☐ Update resume
   ☐ Apply to 5 jobs        daily
2. Interviewing      (upcoming)
   ◦ Mock interviews
3. Negotiating       (upcoming)
+ Add stage
```
Active-stage tasks are **real tasks** (tappable, they complete). Upcoming-stage tasks are
**plans** (a different affordance — they are not on the Tasks tab and cannot be completed).
That visual distinction is load-bearing: it is the difference between a record and an
intention, and the app must never blur it.

**3.9 `lib/api/client.ts` + `types.ts`** — `createGoal(definition)`, extend `updateGoal`.

---

## 4. Tests

**The battery is now in the repo: `server/scripts/battery.sh` (`npm run battery`).**
It mints a fresh account, drives the real server over HTTP in plain English, asserts
against Postgres after every step, and separately flags abnormal chat behaviour (prose on
a turn that should be silent, a retraction, a tool-name leak). Read the header comment
before editing it — several of its oddities are load-bearing (bash not zsh, because `GID`
is zsh's process group id; a recurring task is *two* rows).

Two things about it are known and expected right now:
- **Section E (milestone) encodes the flow this plan deletes.** It will fail until you
  rewrite it. Rewriting it is a work item, not an afterthought: it should assert that
  "goal to X — a, b, c" produces a 3-stage card with **no second question**, that a bare
  "goal to X" produces a name-only template, and that advancing **materialises the next
  stage's `stagePlans` into real tasks**.
- The `mark water done` ambiguity case is **flaky** — the last run wrote to "Water the
  plants" instead of asking. That is a golden-rule violation (low-confidence extractions
  must ask before writing) and pre-exists this plan. Worth a look while you're in here.

**Unit (`vitest`)**
- `applyStageOps`: insert/delete/reorder keeps `stagePlans` aligned; a completed stage
  cannot be removed or reordered; 2–8 bound; `activeStageIndex` stays valid.
- Manual-create schema: each of the four types, including the cross-field rules
  (habit needs its check-in task; savings needs a target; indirect needs a unit).

**Live (the battery)**
- Create each of the four types **manually over REST** — assert the DB, and assert the
  `goal_created` record so "undo that" in chat still reverts a manually-made goal.
- Milestone: plan tasks for stage 2, advance, assert **stage 2's planned tasks became real
  tasks** and stage 1's were retired.
- Chat: "goal to land an internship — applying, interviewing, negotiating" → card with 3
  stages, no second question. And with no stages → bare template card.
- Re-run the long e2e at window **4** to confirm no pattern-completion regression.

---

## 5. What this deletes

Worth saying plainly, because it is the point: this plan **removes** the two-question chat
build, the ask-at-every-advance rule, and the window bump — i.e. most of what shipped in
`541054f`. That commit was a correct fix (stop inventing the user's plan) applied at the
wrong layer (chat). The rule it established survives — **Meroa never invents your
milestones** — but the UI enforces it structurally, for free, instead of a prompt asking a
model to be disciplined about it every single turn.

That is the same lesson as everything else in `chat-architecture.md` §0: *a prompt is a
suggestion; a guarantee lives in code.* A stage list the user typed into a form cannot be
hallucinated.
