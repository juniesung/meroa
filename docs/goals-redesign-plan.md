# Goals redesign — implementation plan

> **Pickup prompt for the implementing session:**
> _"Read `CLAUDE.md` and `docs/goals-redesign-plan.md`. The design is settled with the
> user — implement the work items in order; ask only if something in the codebase
> contradicts this doc."_
>
> Standing state: AI provider is **deepseek-v4-flash** (`server/.env`); dev server via
> `npm run dev` in `server/` (manual restart on `.env` changes); its stdout is captured at
> `/private/tmp/meroa-server.log` — read it when debugging, providers log real errors
> there. Typecheck `npx tsc --noEmit` in both `server/` and repo root after each item.

## 0. What this is and why

Phase 4 shipped "Tools" (five tracker templates). Live use surfaced two verdicts, both
the user's call after real testing:

1. **The concept is wrong, not just buggy.** A grab-bag of trackers doesn't answer "why
   am I tracking this." The tab becomes **Goals**: long-term outcomes (save $2,000, reach
   a target weight, land an internship, keep a daily habit) that *explain* tasks —
   Meroa proposes tasks in service of a goal, and completing those tasks visibly moves
   the goal. This pulls the core of Phase 5's connected loop forward with a clearer
   product story. The old generic template/field builder is **scrapped**; goal types are
   rebuilt one at a time with fixed, typed shapes (the open-ended field system was the
   main bug surface and served no user need).
2. **The tab should feel rich and alive.** A GitHub-style completion calendar, streaks,
   and a set of stat widgets (see §2.5), plus light "emotional design" touches — micro
   feedback on completions and a slightly dramatic mascot-lite treatment of the existing
   `MeroaMark` (user explicitly OK'd drama; CLAUDE.md's no-shame rule still governs
   *copy* — the streak reset is mechanically real but Meroa never lectures).

Everything renames end-to-end: **no production users, so we rename the internals too**
(DB tables, record kinds, AI tool names, refs, routes, client types) rather than living
with `tool_*` names under a Goals product forever. Bonus: "tools" stops colliding with
AI function-calling tools in the codebase.

## 1. Product decisions locked with the user (don't re-litigate)

- **Goal types, built one at a time, in this order:**
  1. **Quantified, task-driven** (savings): real number + target (+ optional deadline);
     completing a linked task literally logs the amount. ← **this plan builds it**
  2. **Habit** (meditate daily): no target number; a linked daily task + a **streak** is
     the whole mechanic. Missing a day genuinely resets the streak (longest-streak kept).
  3. **Quantified, indirect** (weight): real measurements logged explicitly get their own
     chart; linked tasks are supporting activity only — **no progress bar derived from
     tasks, ever** (never fabricate a number). Deferred to its own pass.
  4. **Milestone-staged** (internship): ordered stages Meroa proposes upfront (editable
     in the preview); one active at a time; stage advances only when the *user says so*;
     on advance, Meroa proposes retiring old tasks + creating the next stage's tasks in
     one confirm card. Deferred to its own pass.
- **Creation flow:** describing a goal produces ONE preview card containing the goal
  *and* Meroa's proposed starter tasks (typically recurring, e.g. "save $5 daily"); one
  Create tap saves both. Preview-is-the-only-confirmation rule carries over verbatim.
- **Suggestions:** starter set at creation + on request. **Proactive periodic check-ins
  are wanted but deferred** until quiet-hours/frequency guardrails exist (Phase 6) —
  design the goal row to carry a `checkInCadence` field now, act on it later.
- **Streaks/calendar:** tab-level GitHub-style calendar marks days where **all tasks due
  that day were completed**; tab-level streak counts consecutive such days. Per-habit
  goal streak counts that goal's own daily task. Breaks are real (reset to 0), tone
  stays warm, `longest` is always shown alongside.
- **Mascot:** full illustrated character is later; **mascot-lite now** — `MeroaMark`
  gains mood states (idle pulse / streak-warm glow + flame / visibly deflated on a
  fresh break — drama allowed) shown in the Goals tab header and chat header.
- **UI polish:** feature-tied micro-interactions ship with this work (completion
  bounce/glow, streak flame animation, satisfying entry-log feedback). The app-wide
  motion/onboarding polish pass waits until the goal model has proven out.
- **Bugs:** the `create_tool` preview hallucination is real and gets mitigations here
  (§2.6). The user has more small bugs to report — collect the list and fold fixes into
  the protocol run (§4).

## 2. Design

### 2.1 The rename, end to end

One hand-written migration (drizzle-kit fumbles renames — write the SQL):

| Old | New |
| --- | --- |
| table `tools` | `goals` |
| table `tool_entries` | `goal_entries` |
| column `tasks.tool_id` | `tasks.goal_id` |
| records kinds `tool_created/edited/entry/archived/undo` | `goal_created/edited/entry/archived/undo` (UPDATE existing rows) |
| records source `'tool_ui'` | `'goal_ui'` (UPDATE rows + recreate the check constraint) |
| messages meta kinds `tool_preview`/`tool_action` | `goal_preview`/`goal_action` (UPDATE rows: `meta->>'kind'`) |

Code/API renames: `server/src/lib/tools/` → `lib/goals/`; AI tools `create_tool` /
`edit_tool` / `log_tool_entry` → **`create_goal` / `edit_goal` / `log_goal_entry`**;
turn refs `L*` → **`G*`** (`/^G\d+$/`; field refs go away entirely in v1 — see §2.2);
routes `/tools*` → `/goals*`; client `ApiTool*` → `ApiGoal*`, tab `tools.tsx` →
`goals.tsx` (label **Goals**), detail route `/tool/[id]` → `/goal/[id]`; stream event
`action_tool`/`action_preview` naming and prompt text updated to goal vocabulary.
Existing archived dev tools rows survive the table rename but never render (archived
filter) — no destructive data loss (CLAUDE.md §2). Rewrite `seed.ts`'s demo tool as a
savings goal via the new builder.

### 2.2 Goal model v1 — fixed shapes, no field builder

```ts
// goals.definition (jsonb), discriminated by goal type; v1 ships 'savings' only
type SavingsGoalDefinition = {
  type: 'savings';
  currency: string;                    // "$"
  targetValue: number;                 // 200
  deadline?: string;                   // ISO date — "in 30 days" → concrete date; enables pace math
  checkInCadence?: 'weekly' | 'off';   // stored now, acted on in Phase 6
};
// entries: goal_entries.data = { amount: number; note?: string } — fixed shape, no field ids
```

The generic `fields`/`views`/field-ref machinery is deleted, not ported. Each future
type adds its own literal definition + entry shape. `edit_goal` v1 ops: `name`, `icon`,
`targetValue`, `deadline` — nothing else exists to edit. `log_goal_entry` v1 input:
`{ goalRef, nameHint, amount, note?, entryAt? }`. All the Phase-4 guardrails carry over
unchanged: preview-only `create_goal`, nameHint verification, `wrapFailure`, undo with
concrete restored values, `historyContentFor` stripping, recent-changes narration.

### 2.3 The connected loop: linked tasks auto-log entries

- `create_goal` proposes starter tasks inside the preview:
  `starterTasks: [{ title, recurrence?, contribution: number }]` (contribution = the
  amount completing it logs, e.g. 5). The preview card lists them under the goal.
  Create-tap (`POST /goals { previewMessageId }`) creates the goal **and** the tasks in
  one transaction — tasks get `goalId` + `config.goalContribution`.
  `materializeRecurringInstances` already copies `toolId`→ now `goalId` onto instances;
  verify `goalContribution` rides along in `resetConfigForNewInstance`.
- **Completion → entry, store-once:** in the tasks executor, when a linked task
  transitions to done (`becameDone`), insert a `goal_entries` row whose `recordId` is
  **that same `task_completion` record** — one record, two views (CLAUDE.md §2's heart).
- **The un-complete trap (get this right):** when a linked task transitions done→open
  (`becameOpen` — un-complete/reopen, which writes a *new* progress record rather than
  reverting the old one), **delete the auto-entry row referencing
  `prior.completedRecordId`** — otherwise re-completing creates a second entry against a
  new record while the stale one still counts, double-logging the contribution. (Entries
  are projections and may be removed; the records row itself is never touched.)
  `undo_last_action` on the completion needs nothing special: `revertedAt` on the record
  already hides the entry via the existing live-entries join.
- Chat entry (`log_goal_entry`) and the goal detail's quick-entry sheet still exist for
  ad-hoc amounts ("also put in my $40 birthday money").
- Model context row precomputes everything (lesson 6):
  `[G1] "Rave savings" · $45/$200 · $5/day via "Save $5" (T3) · 9 days left · on pace`.

### 2.4 Streak + calendar semantics (server-computed, account timezone)

New `lib/goals/consistency.ts`, all math server-side, one query over non-deleted tasks
bucketed by due date in the account tz:

- **Day verdict:** a day with ≥1 task due and **all of them done** = *perfect*. A day
  with ≥1 due and any open = *missed*. **Zero tasks due = neutral**: doesn't break the
  streak, doesn't extend it (a rest day, not a failure).
- **Streak:** consecutive perfect days counting back, skipping neutral days; **today
  doesn't break the streak until it ends** (same grace the goal-entry streak already
  uses). Track and return `current` + `longest`.
- **Postponing a task off today removes it from today's denominator** — intended;
  that's the shame-free-adjustment path, not cheating.
- **Habit-goal streak:** same rules scoped to that goal's linked daily task.
- **Calendar payload:** last ~15 weeks as `[{ ymd, dueCount, doneCount, level }]` where
  `level` ∈ 0 (none due) / 1 (some done) / 2 (most) / 3 (perfect) — client renders,
  never re-buckets (lesson 12). Served via `GET /goals/consistency` and summarized into
  the chat tail block (`4-day perfect streak`) so Meroa can talk about it accurately.

### 2.5 The Goals tab — layout + widgets (top to bottom)

1. **Header stat row** — *Today ring* (tasks done/due today, reuses `Ring`) + *streak
   flame* (current, with `longest N` sub-label) + **mascot-lite `MeroaMark`** reacting:
   idle soft pulse · streak ≥3 warmer glow + small flame · fresh break = dimmed/droopy
   for that day (dramatic is fine; the *copy* anywhere near it stays warm and
   matter-of-fact — "streak reset — day one starts now" not "you let me down").
2. **GitHub-style completion heatmap** — ~15 weeks × 7 rows of rounded 2–3px-radius
   cells, blue intensity ramp on theme tokens, perfect days at full `accent`, tap a cell
   for a one-line day summary. New `components/Heatmap.tsx`.
3. **Goal cards** — icon, name, gradient progress bar toward target, and a **pace
   line** when a deadline exists (`$45 of $200 · needs $5.2/day to hit Dec 15` — server-
   computed). Tap → detail.
4. **Stat tiles row** (2–3 small cards) — *done this week*, *perfect days this month*,
   *active goals*. Reuse card tokens; numbers from the consistency endpoint.
5. **Recent wins strip** — last few nice moments ("hit a 7-day streak", "$50 milestone
   on Rave savings") from existing records; keep dumb-simple (derived, not stored).
6. **Empty state** — one warm line + a ghost goal card sketching what could live here.

Micro-interactions shipped with this slice: completion bounce/glow on task check
(chat + Tasks tab + goal detail), a brief flame pop when the streak increments, haptic +
scale-settle on logging an entry. Skip glassmorphism entirely (user's own source flags
the accessibility cost; conflicts with the locked dark theme).

> Implementer: read the `dataviz` skill before writing `Heatmap.tsx`/pace charts, but
> the app's own theme tokens override its palette.

### 2.6 Preview-hallucination mitigations (the "keep going" fix)

Observed live (server log, July 12): on `create_tool` turns, deepseek-v4-flash twice
narrated a specific preview ("Preview's up — Chest Day tracker… tap Create") with
**zero tool calls**; the claim-check classifier caught both (`claim_check: yes,
matched_regex: false`) and appended the corrective segment. Mitigations, cheapest first:

1. **Regex tier:** extend `FAKE_ACTION_PATTERN`/add a preview-specific pattern in
   `providers/shared.ts` — `/\b(preview|card)('s| is)? (up|sent|ready)|sent you a preview|tap create\b/i`
   — so the free check catches this shape without waiting on the classifier.
2. **Prompt tier:** in the `# Taking action` block, add the preview case explicitly:
   *"Never say a preview or card was sent unless you called create_goal in this exact
   turn — describing a card that doesn't exist is the same lie as claiming a task was
   created."*
3. **Corrective copy:** when the catch fires on a zero-call turn whose text mentions a
   preview/card, use a truthful specific correction ("hm, that preview didn't actually
   go through — ask me again?") instead of the generic one.
4. **Measure:** the §4 protocol re-runs creation 5×; log lines (`claim_check`) give the
   before/after rate. If it stays high, the act/narrate split (deferred in the hardening
   doc) gets reconsidered — note it, don't build it yet.

### 2.7 Explicitly deferred (with reasons)

- Goal types 2–4 (habit is next after savings ships; indirect + milestone each get a
  design pass of their own — milestone needs stage-mutation UX that doesn't exist).
  **Note:** the *streak/calendar infrastructure* in §2.4 ships now and is exactly what
  the habit type will sit on — habit becomes a thin slice afterward.
- Proactive check-ins → needs Phase 6 quiet-hours/rate limits. Field stored, unused.
- Full illustrated mascot with expression library → own design project.
- App-wide motion/onboarding polish pass → after the goal model survives real use.
- Task *suggestion* beyond creation time stays reactive (user asks) — no unprompted
  goal nudges until check-ins exist.

## 3. Work items, in order (each independently commit-able)

1. **Migration + mechanical rename** — SQL migration (§2.1 table), `lib/tools/`→
   `lib/goals/`, routes, AI tool names + `G*` refs, client types/routes/tab, prompts.
   App keeps working against renamed shapes; typecheck both packages. (No automated
   tests exist anywhere in the repo yet — the gate here is typecheck; vitest arrives
   in item 3.)
2. **Model v1 simplification** — delete the field/template builder; `savings` definition
   + fixed entry shape; rewrite `create_goal`/`edit_goal`/`log_goal_entry` schemas +
   executor + summary math (total, pace vs deadline); update seed.
3. **Connected loop** — starter tasks in the preview + one-transaction create;
   `becameDone` auto-entry / `becameOpen` entry removal (§2.3 trap); undo verified both
   directions; recent-changes narration for auto-logged contributions. **Adds `vitest`
   to `server/`** (devDependency + `npm test` script — the repo's first automated
   tests) with unit tests pinning the done→open→re-done sequence: exactly one live
   entry after re-completion, never two, and none while reopened.
4. **Consistency engine** — `lib/goals/consistency.ts` (day verdicts, streaks, heatmap
   buckets), `GET /goals/consistency`, tail-block line. Written as pure
   data-in/data-out functions (task rows in, verdicts/streaks/buckets out) so the
   vitest suite covers the edge cases the manual protocol can't cheaply reach: tz
   bucketing, neutral days skipped not broken, today's grace, postpone-off-today
   leaving the denominator, longest-vs-current after a reset.
5. **Goals tab UI** — header stats + mascot-lite `MeroaMark` states, `Heatmap.tsx`,
   goal cards w/ pace, stat tiles, wins strip, empty state, micro-interactions.
6. **Hallucination mitigations** — §2.6 items 1–3.
7. **Verify + docs** — protocol (§4) plus `npm test` in `server/`, update CLAUDE.md §9
   (Phase 4 row → "superseded by Goals redesign", Phase 5 row notes the loop shipped
   early), record results here. (The user's small-bug list turned out to be mooted —
   see the ledger below.)

## 4. Acceptance protocol (deepseek-v4-flash, isolated dev-token account)

1. "I want to save $200 for the next rave in 30 days" → ONE preview: goal (deadline
   ~30 days out) + proposed "save $5 daily"-style recurring task; no chat-text
   double-confirm. Create → both exist, linked.
2. Complete today's instance in the **Tasks tab** → goal total +$5 (DB: one records row,
   goal entry references it); next chat turn narrates it; Goals tab card updates.
3. Un-complete it → total back to $45−$5; re-complete → +$5 once (no double-count).
4. "log my $40 birthday money into rave savings" → ad-hoc entry, reply states the real
   recomputed total + pace.
5. "change the target to $250" → concrete before/after; "undo that" → restored value.
6. Complete *all* tasks due today → calendar cell hits level 3; streak increments;
   flame/mascot state changes. Leave one open past midnight (or simulate) → streak
   resets, `longest` retained, copy stays warm.
7. Preview-hallucination probe: ask for goal creation 5× in varied phrasing; count
   zero-call preview claims in the log (target: caught by regex tier or gone).
8. Regression: task core-10 quick pass (context/tail changed again).

---

*Deferred-bug ledger (fill as the user reports):*
- [x] create_tool preview narrated with zero calls (mitigations §2.6)
- [x] User's small-bug list collected: all of them live in the old Tools tab UI
  (template/field-builder surfaces), which this redesign deletes outright — mooted, no
  individual fixes carried forward. If any equivalent behavior resurfaces in the new
  Goals UI during the §4 protocol, log it here as a fresh entry.
- [x] create_goal preview-narrated-with-zero-calls found live *again* during the §4 run
  below, past the §2.6 mitigations as first shipped — root-caused and fixed (see §4
  results, items 1 and 6 follow-up commit). Not a new bug class, a gap in the first fix.

## As-a-user bug hunt (2026-07-12, after the user's live bench-goal report)

The user hit "asked to log a bench goal to 225, it says it logged it but it didn't" on
the demo account. Root-caused from the server log + DB, then a full as-a-user pass over
everything this redesign touched (fresh dev-token account, live deepseek-v4-flash, real
DB state checked between steps). Found and fixed, each verified live after the fix:

1. **Mid-turn refs (the user's bug).** The model handled "add a goal to hit 225 on
   bench" *correctly* (explained savings-only, offered a counter task, created it) —
   then tried to log the user's current 165 with ref "T8", which failed: the TurnRefs
   map is built at turn start, so a task created mid-turn had no ref, every
   create→act chain failed, and the model spiraled into raw-markup leaks ending in
   "glitched on my end." Fix: register a ref for created tasks (and checklist items)
   immediately, told to the model via a model-only `modelSummary` on the tool result
   (never persisted user-facing). Re-ran the exact scenario: counter created AND 165
   logged in one turn; "make a packing list and check off passport" also works now.
2. **Multi-starter idempotency collision.** N starter tasks on one Create tap created
   only the first — createTaskInTx's idempotency keyed on (sourceMessageId,
   'task_created'), identical for every starter. Fix: per-starter toolCallId.
3. **Chained undo was broken (pre-existing, beyond this redesign).** "undo" twice in a
   row always failed: the task_undo/goal_undo bookkeeping records themselves matched
   the undo-candidate query's task_%/goal_% prefixes. Fix: exclude them; consecutive
   undos now walk back through real actions (redo stays unsupported).
4. **Nondeterministic undo after a Create tap.** Postgres freezes now() at transaction
   start, so the goal_created record and its starters' task_created records tied on
   createdAt and "most recent record" was luck. Fix: one user action = one record —
   the Create tap writes only goal_created (payload.starterTaskIds); undoing it
   cascades the starter tasks (and their materialized instances) away with the goal.
5. **Completions logged entries into archived goals.** Complete a still-linked task
   after removing its goal → entry written into the archived container, and the
   recent-changes feed narrated a contribution that renders nowhere. Fix: archived
   guard in the (unit-tested) entry decision + archived filter in the feed's goal
   lookup.
6. **Double-log risk.** The model had no way to know completing a linked task IS the
   logging — task-context now labels linked tasks ("auto-logs $4 to goal … when
   completed"), plus an explicit system-prompt rule. Verified live: "just did my $4
   save" → complete_task only, one entry.
7. **Classifier false-positive on day recaps.** "how did today go?" recaps ("all
   checked off", "hit your target") got the "that didn't go through" correction
   appended — the claim-check classifier read user-activity summaries as assistant
   action claims. Fix: recap NO-example in the classifier prompt; verified clean.
8. **Model recomputed pace itself after edits — wrongly.** After a deadline edit it
   narrated "$2.65/day" from its own division (real: $2.41). Fix: target/deadline
   edit summaries now append the server-recomputed headline + pace (lesson 6/16);
   verified quoting it verbatim.

Also verified clean in the same pass (no bugs found): preview revise-then-Create,
Create double-tap idempotency, multi-goal disambiguation by rough name ("the coat
fund"), withdrawals (negative amounts), un-complete via chat reversing the auto-entry,
recurring materialization carrying goalId+contribution (incl. multi-day backfill),
perfect-day flip + streak on /goals/consistency, and ad-hoc + auto entries coexisting.

Known model-quality observations, not code bugs (ledger for the act/narrate-split
decision): zero-call preview claims still occur at a high raw rate on flash (now
reliably caught + truthfully corrected); one transient recap misstatement ("skipped
today" for a done task) contradicting clear context; one max-tokens empty reply
("that got cut off"). An aspirational counter ("Bench press 225") is born due-today
and goes overdue tomorrow — that's the deferred goal type 3 (quantified, indirect)
use case, pre-existing Phase 3 behavior, not addressed here.

## Second as-a-user pass (2026-07-12, catch-only, then a fix round on user approval)

A pure user-simulation session (~30 live turns, no code changed during it) cataloged
1 severe + 5 moderate code findings plus a model-quality cluster; on approval all six
were fixed and each re-verified live through chat AND the REST entry points:

1. **[severe] Re-reporting a done task silently reversed it and the model lied about
   the total.** completeTask is a toggle (right for a UI tap); via chat, "I did my $60
   save" said twice reopened the task, deleted the $60 auto-entry, showed "Logged
   progress", and the model announced $220.50 while the DB said $100.50. Fix: the AI
   complete_task path rejects re-completing an already-done completion task ("already
   marked done — nothing changed"); un-marking is opt-in via a new `reopen: true`
   param routed through the generic reopen transition. Verified: re-report is a safe
   no-op; "unmark it" reopens and removes the auto-entry.
2. **Goal removal orphaned its linked tasks** — the daily "Save $X" kept nagging
   forever, logging nothing, dragging every day's consistency verdict to "missed".
   Fix: archiveGoal cascades linked tasks (templates always; instances/standalones
   while open — done rows stay as history), records cascadedTaskIds on the
   goal_archived record, and undoing the removal restores exactly that set. Verified
   through chat, the app's DELETE route, and both undo entry points.
3. **A stale preview card could create a duplicate goal** (re-tap after the created
   goal was undone: createdGoalId lookup filtered archived, and the reverted
   goal_created record dodged the executor's idempotency too). Fix: the Create-tap
   idempotency lookup includes archived rows — one preview creates at most one goal,
   ever. Client: "Created ✓" downgrades to "Created — since removed" when the goal no
   longer exists in the live list.
4. **Zero-streak turns had no streak line at all in the tail**, so "do I have a
   streak?" got an invented answer ("none of your tasks are set up for it"). Fix: the
   line is always present, including a "starts automatically the first day every due
   task gets done" zero-state. Verified grounded live.
5. **complete/progress results said nothing about the goal side effect**, so the
   model did its own money math (twice wrong live). Fix: completion/reopen/progress
   summaries state the auto-log/removal fact with the recomputed server headline +
   pace. Verified the model quoting them verbatim.
6. **No chat path to remove a goal.** New `remove_goal` AI tool: immediate (no
   confirm card exists for goals) but description-gated on clear user intent, fully
   reversible incl. cascaded tasks; system-prompt rule added. Verified end to end
   with undo.

Still open from that session, deliberately untouched (minor/model-quality): "$0.5"
money formatting (no trailing cents digit); no validation that starter-task pace can
actually reach the target; flash's high zero-call claim rate (6 corrections in ~29
turns — strongest signal yet for the deferred act/narrate split); one *missed* catch
("undo again" → zero calls, claimed "Back to 12/40" — short state-claims pass the
recap-tolerant classifier); history-over-context narration in long sessions (stale
totals, a never-created goal recalled as existing); currency contamination across
goals in one conversation (€ leaked from an Oktoberfest goal onto a parking ticket).

## §4 results (2026-07-12, deepseek-v4-flash, isolated dev-token account +15555559911)

Ran end-to-end against the live server (not a simulation) — real chat turns through the
actual model, real DB state checked via REST between steps.

1. **Pass.** "I want to save $200 for the next rave in 30 days" → one preview, deadline
   correctly resolved to 2026-08-11 (30 days from the session's "today"), a proposed
   daily "Save $7" starter task (the model's own choice of pace, not $5 — reasonable,
   ~$210 total covers the target with margin), no chat-text double-confirm. Create →
   goal + starter task both exist, `task.goalId` set, `config.goalContribution: 7`.
2. **Pass.** Completed today's instance via REST (Tasks-tab equivalent) → goal total
   $0→$7, exactly one `goal_entries` row referencing the same record as the task's
   `completedRecordId`. Next chat turn ("hey how's my savings goal looking?") correctly
   narrated the $7/$200 state and attributed it to the just-completed task.
3. **Pass.** Un-complete → total back to $0, zero live entries. Re-complete → back to
   $7 via a *new* record, exactly one live entry (no double-count) — matches the
   goal-entry-decision unit tests, now also confirmed against the real DB end to end.
4. **Pass.** "log my $40 birthday money into rave savings" → ad-hoc entry logged with
   note "birthday money", reply stated the real recomputed total ($47/$200). Didn't
   explicitly restate the pace line this turn — not a bug (pace math is correct and in
   context; the model chose to lead with the fraction instead), just model style
   variance worth knowing about.
5. **Pass.** "change the target to $250" → concrete before/after ("$200 → $250") in
   both the tool result and the chat reply. "undo that" → restored to $200, version
   reverted 2→1, concrete restored value stated.
6. **Pass (live-verifiable slice).** The one real due day (today, the starter task)
   correctly hit calendar level 3 (`dueCount: 1, doneCount: 1, verdict: perfect`) with
   `current: 1, longest: 1` via the live `/goals/consistency` endpoint. The multi-day
   "leave one open past midnight → streak resets, longest retained" transition wasn't
   separately re-verified live (the test account only had one real day of history to
   work with) — it's covered by consistency.test.ts's unit tests instead, which pin
   that exact scenario (missed-day-breaks-streak, longest-survives-a-reset) against
   contrived multi-day data; the live endpoint composes the same tested pure functions
   over real query results, verified above.
7. **Found and fixed a real gap.** 5 varied creation phrasings ("save $500 for a
   laptop", "$1000 for a new car", "$300 emergency cash", "$150 concert tickets", "$80
   headphones") produced 4 zero-tool-call preview claims and 1 honest real tool call.
   The *first* zero-call turn ("Sending a preview your way — **$500 laptop fund**...
   tap **Create**") slipped past both the regex tier and the classifier — root cause:
   markdown bold breaking `tap create`'s literal-adjacency assumption, plus
   present-tense phrasing the verb list didn't cover; the classifier's own prompt never
   named a preview claim as a qualifying case either. Fixed both (commit after this
   run) and re-probed live: the remaining 3 zero-call turns were all caught by the
   regex tier (100% post-fix), each producing the truthful "that preview didn't
   actually go through" correction instead of the generic one. The underlying
   *zero-call rate* itself stayed high (4/5) — the doc's target was "caught by the
   regex tier or gone," and it's now reliably caught; the act/narrate split
   (docs/ai-reliability-hardening.md, deferred) would be the next lever if the raw rate
   itself needs to come down, noted per §2.6 item 4's instruction, not built.
8. **Pass.** Plain (non-goal) task create → complete → undo all worked normally via
   chat; a non-goal-linked task correctly gets no `goal_entries` side effects (the
   `task.goalId` guard). Incidentally also caught a genuine, pre-existing (unrelated to
   this redesign) undo hallucination — the model claimed "Done — undone." without
   calling `undo_last_action`; the existing FAKE_ACTION_PATTERN/classifier system
   caught it correctly and told the user honestly, then the retry succeeded for real.
   Confirms the general claim-check system is unaffected by the goals-redesign changes.

**Overall:** all 8 protocol items pass; one real bug found and fixed along the way
(item 7), which is exactly what the probe step is for. `npm test` in `server/`: 20/20
passing (goal-entry-decision + consistency pure-function suites). Both packages
typecheck clean throughout. Client verified via a clean `expo export` bundle (1830
modules) at each UI-touching step — no simulator/screenshot access in this
environment, noted explicitly rather than claiming a rendered-screenshot verification.
