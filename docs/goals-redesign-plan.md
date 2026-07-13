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

## The act/narrate split (2026-07-12) — built, measured, kept on

The deferred split from docs/ai-reliability-hardening.md, built once the measured
zero-call claim rate justified it (16% of all turns; 4/5 first-try failures on the
creation probe). Design (providers/act-narrate.ts, AI_ACT_NARRATE=on default for the
OpenAI-compatible providers; 'off' = instant rollback to the single-pass loop):

- **Action pass, isolated context**: action-only prompt + the volatile state block +
  the last 4 messages only, non-streamed, tool choice forced (real tool or a
  `no_action` escape). Saved state lives in the live lists; pending state — the one
  thing that exists nowhere but conversation, an un-tapped preview — is promoted into
  the state block (lib/ai/pending-preview.ts, derived from already-fetched history,
  unit tested). Deep history, the measured contamination source (failures clustered on
  creations 2..N after "Preview's up" replies piled up), never enters this pass.
- **Narrate pass, full context**: personality prompt + full history + the pass-1
  results injected as authoritative facts, tools disabled, extra output headroom
  (flash's invisible reasoning once ate the whole shared budget and produced an empty
  reply). Claim-check stays as the backstop on no-action turns.
- Found live: flash's thinking mode 400s on tool_choice 'required' — handled with a
  remembered per-model fallback to 'auto'; degradation is graceful because pass-1
  prose is discarded, so a miss becomes an honest no-action, never a false claim.

**Before/after, same model, same test shapes (fresh account, live server):**

| Metric | single-pass baseline | act/narrate split |
| --- | --- | --- |
| Zero-call false claims | 15 / 92 turns (16%) | **0 / 21 turns** |
| Corrections appended | 15 (+1 missed catch) | **0** |
| Creation probe (5 varied asks) | 1/5 called the tool first try | **5/5** |
| Raw markup leaks | 2 | 0 |
| Empty replies | 2 | 1 (headroom fix landed after) |

Also verified through the split: pending-preview revision across a 3-turn chitchat
gap ("make it $120" resolved from state, not window), the bench create+log chain,
two-turn intent flows ("1500 by christmas" after being asked the amount), starter
tasks in previews, re-report guard, explicit unmark, remove_goal + chained undo,
ad-hoc entries, accurate recap and streak answers. Remaining observed wobble class:
occasional imprecise *prose* around correct actions ("then I'll set up the weekly
task" for a starter already in the preview) — factual drift in narration with the
facts also on screen, never a false success claim. Cost: two model calls per turn.

**Heatmap revision (user-requested, 2026-07-12):** §2.5's GitHub-style 15-week strip
replaced with a month-paged calendar — one month at a time (chevrons page back
through the served history, currently 2 months + current), reading left→right /
top→down with the 1st at top-left, cell intensity = that day's completion ratio
(full accent exactly when everything due was done), future days as outlined
placeholders, tap-a-day summary kept. Server side: buildCalendar now serves whole
months (1st of monthsBack ago → today) instead of a fixed 105-day strip; day-verdict
and streak math untouched. Stat tiles deliberately left as-is (rolling 7-day "done
this week", calendar-month "perfect days") per the user's call.

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

## Habit goal type (2026-07-12) — built, tested, shipped

Second goal type from §1, built to the locked decisions: **no target number at
all** — a linked recurring check-in task + the streak IS the whole mechanic.
Missing a day genuinely resets the streak (mechanically real); `longest` is
always kept and shown next to the current run. Session lessons were designed in
up front rather than re-discovered:

**Shape & invariants**
- `definition = { type: 'habit' }` (plus the stored-only `checkInCadence`),
  discriminated union with savings; `goals.template` mirrors the tag.
- **Habit goals have NO `goal_entries`** — the task completions ARE the record.
  Guarded four deep: `createGoalParamsSchema` superRefine rejects a habit
  starter carrying a `contribution` (fails loud with a corrective message the
  model can act on); the executor only stamps `goalContribution` when
  `definition.type === 'savings'` (backstop for the preview-tap path);
  `logGoalEntry` throws `invalid_input` for habit goals; and the tool schema
  says savings-only. Live-verified: zero `goal_entries` rows after check-ins.
- `create_goal` gained a required `type` param; superRefine enforces the
  cross-field rules (savings → targetValue required; habit → no
  targetValue/currency/deadline, starterTasks required with recurrence on the
  check-in). Habit edit is name/icon only — target/deadline ops error with a
  type-aware message.
- Streaks come from the existing consistency engine scoped per goal
  (`buildGoalScopedStreaks`, batched for the list) — same tested
  `computeCurrentStreak`/`computeLongestStreak`, filtered to the goal's linked
  task instances. Never derived by the model or the client.

**Surfaces**
- Card: `computeHabitCardSummary` — headline "N-day streak"/"No streak yet",
  sub "longest N · M check-ins"/"First check-in starts it", progress/pace null
  (a habit never fakes a fraction). `GoalDetail` is discriminated by `type`
  with nullable savings/habit fields; client `GoalCard` renders a flame+count
  variant, detail screen shows a `StreakView` (no Log button, no entry sheet,
  no history section), the chat preview card says "Habit — daily check-ins
  build the streak" instead of a Target line.
- Model context: goal line renders `habit · N-day streak (…) · check-in via
  "task" (complete_task IS the check-in)`; task line says "completing =
  checking in"; pending-preview state line renders the habit shape without
  amounts; `goalImpactSuffix` states the post-completion streak fact from
  server data ("streak is now 1 day (longest: 1)") so the model narrates
  facts, not derivations.

**Verification** — 40/40 vitest (new: schema superRefine suite,
computeHabitCardSummary suite, habit pending-preview render), both packages
typecheck clean, `expo export` clean (1830 modules). Live as-a-user pass on
fresh dev-token accounts (+15555559301–03): creation via 3 phrasings (3/3
correct habit previews, no invented times/amounts) → Create tap (goal + linked
daily instance, no contribution stamped) → chat check-in (streak fact stated,
streak 1, zero entries in DB) → re-report ("i meditated today") correctly
acknowledged without double-count → "log 20 minutes" correctly explained as
streak-based instead of logging → unmark (streak back to 0/0/0) → re-complete
after unmark (clean, new record, streak 1) → remove_goal (cascaded the
check-in task) → undo (goal + tasks restored) → rename ok, "set target to 30
days" correctly refused with a clarifying counter-offer → savings regression
(create → Create tap → $45 chat log) intact.

*Known wobble (existing class, 2 sightings):* the narrate pass occasionally
contradicts the action result's streak fact using stale conversation history
("longest 1" after an unmark that made it 0). The action card always carries
the server-computed fact; the fix lever, if the rate warrants it, is
sharpening the narrate prompt's "trust the results block over history" rule —
not new to habit.

*Deferred, same as savings:* post-creation task→goal linking; `checkInCadence`
acted on in Phase 6; indirect + milestone types in their own passes.

## Recurring-task delete semantics (2026-07-12) — built, tested, shipped

User-specified rules, all verified live end to end:

1. **Deleting a day instance** (daily list) only skips that day — the template
   and any linked goal survive, and the next day's instance materializes
   normally. Already true mechanically (the materialization cursor counts
   deleted instances as handled days); verified live including a simulated
   next-day rematerialization.
2. **Deleting a repeating task** (REPEATING section) removes it from the daily
   list too (open instances cascade — pre-existing) and nothing materializes
   after; done instances stay as history.
3. **Goal-linked recurring deletes are never a silent swipe.** The Tasks tab
   now confirms first (`confirmDelete` in tasks.tsx): a goal-linked *template*
   gets "…is the repeating task behind ‹goal›. Deleting it removes the goal
   too." with Keep it / Delete both; a goal-linked *instance* gets "skips
   today — it'll be back tomorrow." The AI's pending-removal card discloses
   the same ("this also removes goal ‹X› (powered by those tasks)") — by the
   time DELETE reaches the server, the user has consented to the full effect.
4. **Deleting a goal-linked template deletes its goal**, with exactly
   remove_goal's semantics: `archiveGoalCascadeInTx` (new, in
   lib/tasks/executor.ts — shared with goals/executor's archiveGoal, placed
   there to avoid a runtime import cycle) archives the goal, cascades every
   linked task, and writes ONE goal_archived record so "undo" restores goal +
   tasks as a unit. Wired into removeTask and removeTasks; bulk batches
   dedupe tasks a same-batch cascade already deleted (verified live with a
   duplicate-template-id batch from the model), and a batch fully absorbed by
   cascades writes no empty task_removed record.
5. **Deleting a goal deletes all its linked tasks** — pre-existing cascade,
   re-verified.

**Found & fixed along the way:** "undo that" in chat right after an *app*
(non-chat) deletion was refused as "nothing to undo" — the model's
conversational memory ("nothing was ever saved") outweighed the
recent-changes narrative. Fix: a deterministic undo-target state line in the
tail (`peekUndoTarget` in tasks/executor — same candidate query as
undoLastAction so it can't disagree — rendered by `renderUndoTarget`):
"undo_last_action currently reverts removing goal X… never claim there's
nothing to undo while this line is present." Re-tested live: the same undo
that failed now restores goal + template + instances. New unit suite covers
the renderer (45/45 total).

*Known wobble:* given "undo that delete" after two separate deletions, the
model chained two undo calls in one turn (restored both) — over-eager but
state-correct; same narrate-wobble ledger as before.

## Session: post-creation task→goal linking + indirect goal type + nits (2026-07-12) — built, tested, shipped

Picked up Phase 5's two biggest remaining gaps per the pickup plan, plus the
small-nits ledger. Implemented server-first then client per item, each typechecked
+ tested along the way; closed with a live as-a-user pass (fresh dev-token
account, deepseek-v4-flash, act/narrate on, real DB checked between REST/chat
steps) rather than trusting unit tests alone.

**A. Post-creation task→goal linking** — `create_task`/`edit_task` gain
`goalLink` (savings requires `contribution`, habit forbids it and requires the
task already repeat, indirect forbids it); `edit_task` gains `unlinkGoal`.
Validation (`validateGoalLinkTarget`) lives once in `lib/tasks/executor.ts`,
shared by the REST path and the AI path — not just at the AI layer, so a
REST-originated link (the client's new `TaskFormSheet` goal picker) gets the
same guarantees. **Retro-credit** (locked decision: linking a task already
completed *today* also credits that completion, an earlier day is left alone):
`decideRetroGoalEntry` in `lib/tasks/goal-entry-decision.ts`, unit-tested
against the done-today/done-earlier/open/archived/habit/indirect/already-credited
matrix. Link/unlink cascades to a recurring template's open instances (not
separately undoable, same precedent as the existing reminder cascade); the
template's own `task_edited` record's prior/retroEntry payload is what undo
restores. Client: `TaskFormSheet` gained a goal picker (filtered — habit only
once the task repeats) with a contribution field; `TaskCard` shows a linked-goal
chip.

**B. Indirect goal type** (third of four locked types) — `definition = {
type: 'indirect', unit, targetValue?, deadline? }`; target is optional ("track
my weight" with just a unit is a complete goal). No stored start/direction
field — `computeIndirectProgress`/`computeIndirectPace`
(`lib/goals/summary.ts`) derive both from `start` (the first logged entry) vs
`current` vs `target`, generalized to work whether the metric rises (a bench
PR) or falls (weight loss) toward its target. Entries reuse the savings
`goal_entries` shape (`amount` = the measurement itself); a linked task is
guarded at every layer (schema superRefine, executor validation, task-context's
label, `goalImpactSuffix`) to **never** auto-log a number — completing one
narrates "supporting activity," nothing numeric. `log_goal_entry`'s reply
states the delta vs. the previous entry (`goalHeadlineWithDelta`) — a down
payment on Phase 5's history-aware-replies task. Client: new
`components/TrendChart.tsx` (single-series SVG line + dashed target line, no
legend needed per the dataviz skill for one series); `GoalCard` refactored
from an implicit streak-presence branch to an explicit `type` switch so an
indirect goal with no target renders without a misleading 0% ring; goal detail
screen gained a `TrendView`.

**C. Small nits closed:** `formatMoney` (mirrored server `lib/goals/summary.ts`
+ client `lib/format.ts`) fixes "$0.5" → "$0.50" everywhere money renders;
`checkStarterPace` (`lib/goals/starter-pace.ts`) flags a savings goal whose
proposed starter pace can't reach its deadline (advisory only, never blocks) —
live-verified against the ledger's own named example ($5/day proposed for
$1000/week correctly surfaced "$40 by [date], $960 short"); the act/narrate
results-block preamble now explicitly says fresh action facts override the
model's own conversational memory on conflict (the narrate-wobble class).
Chained-undo restraint was left as-is per the user's call (state-correct, just
eager).

**Found and fixed one real bug via the live pass, not unit tests:**
`AI_TOOL_SCHEMAS.create_task` intersected `createTaskInputSchema` with a
`.strict()` wrapper object for the new `goalLink` field — `z.intersection`
validates the raw input against both operands independently, so the strict
operand rejected every key it didn't itself declare (`title`, `type`, `icon`)
even though the first operand already accepted them. Every `create_task` call
failed 100% of the time; both packages typechecked clean throughout because
the bug is a runtime validation-composition mistake, invisible to `tsc`.
Caught within minutes of driving real chat turns against a fresh account.
Fixed (dropped `.strict()`, matching every other AI tool schema's
default-strip backstop pattern) and pinned with a new regression suite
(`lib/ai/tools.test.ts`) asserting every ordinary field plus `goalLink`
parses together. Lesson for future AI-tool-schema changes: **a schema
addition needs a live smoke call, not just a typecheck** — this class of bug
is structurally invisible to static analysis.

**Live-verified end to end** (fresh dev-token account, real DB state): link
with a stated contribution → complete → one entry referencing the completion
record; un-complete → entry gone, re-complete → fresh entry, no double-count;
unlink preserves history (doesn't delete a past entry); relink to the *same*
goal a task already has a live entry for is correctly idempotent (no double
retro-credit); relink to a *different* already-done-today task correctly
retro-credits; `undo_last_action` after a retro-credited link restores the
prior (unlinked) state and deletes the retro entry; asking to link without a
stated contribution correctly asks rather than invents one; linking a
non-recurring task to a habit goal is correctly rejected with a clear message
(both via chat and via a direct REST PATCH probe). Indirect: creation invents
neither a target nor a unit; logging narrates the real delta vs. the previous
entry; adding a target/deadline later produces direction-aware pace math
(falling toward 165 from 175 → "0.1lb/day", not the savings-shaped "reached"
miscalculation a naive port would have produced); a linked supporting task's
completion changes zero numeric state on the goal; savings and habit
regression (money formatting, streaks) intact throughout.

**Server test suite: 93/93 passing** (up from 45 at the start of this
session — retro-credit decision matrix, indirect schema/summary/pace, starter-
pace shortfall, formatMoney, and the create_task regression suite are new).
Both packages typecheck clean; client `expo lint` clean; `expo export`
clean (1831 modules).

*Still open from Phase 5:* milestone goal type (fourth and last locked type);
the rest of history-aware replies beyond indirect's delta narration (a
same-week "4th workout this week" style count); the formal §4-style DoD
protocol run and CLAUDE.md §9 tick for Phase 5 (reconcile edge cases:
completion-with-no-linked-goal already covered by the pre-existing archived-
goal guard, ambiguous-goal-name disambiguation already covered by
`verifyNameHint`/`verifyGoalNameHint`, multiple-candidate-tasks already
covered by `titleMatches`'s lenient matching — none newly regressed this
session, but no dedicated end-to-end protocol pass has been run against them
specifically). Provider decision (deepseek-v4-flash is still the test
provider) remains the gate before Phase 6.

## Milestone goal type (2026-07-13) — built, tested, shipped

Fourth and last locked goal type (`docs/milestone-goal-plan.md`), implemented
work-item-by-work-item per that plan: schema → executor → summary → AI tools
→ AI actions → prompt/context → the `action_goal` proposal event → the advance
REST endpoint → undo/recent-changes → server tests → client. Server typecheck
+ `npm test` (93 → 123 passing) + client typecheck + `expo lint` + `expo
export` (1832 modules) all clean after every item, then a full live-as-a-user
pass on a fresh dev-token account (deepseek-v4-flash, act/narrate on, real DB
checked between steps) end to end: one preview with sensible AI-proposed
stages and no invented numbers; Create tap idempotent; a completed linked
task states the "supports … never advances on its own" impact suffix without
touching the goal; a stage declaration produces an `advance_goal_stage`
confirm card whose retire list is server-recomputed from live state (only
open/recurring tasks, done ones survive as history) — a chat-text "yes do it"
correctly does NOT advance, only the tap does; the tap moves
`activeStageIndex`, retires/creates tasks, and a second tap on the same
proposal message is idempotent; `undo_last_action` fully restores the prior
definition + retired/created tasks as a unit, and re-tapping the
now-stale/consumed card doesn't double-advance; advancing through all stages
reaches the "Complete — all N stages" state on the card/detail/context line;
`log_goal_entry`, target/deadline/unit edits, and a stage-rename request are
all honestly rejected; `remove_goal` cascades the goal's open linked tasks
and `undo_last_action` restores it. Savings/habit/indirect create→act→undo
and a plain task-core create all regression-passed clean.

**Found and fixed one real bug via the live pass, not unit tests:** the
narrate pass's self-correction backstop (`maybeCorrectFakeAction`,
`providers/shared.ts`) skipped entirely whenever *any* tool call succeeded
this turn — including a **pending-confirmation-only** success
(`task_removal_pending`, `task_bulk_removal_pending`, `goal_preview`, and now
`goal_advance_pending`), which mutates nothing. Live-caught: a second "yes
advance it" re-triggered `advance_goal_stage`'s pending card (a real,
successful call), and with self-correction suppressed, the narrate pass
freely fabricated "You're moved to 'Applying' now — done" while the DB
stayed on the prior stage the whole time. Fixed by tagging each
`toolCallLog` entry with `pending` (true for the four card-only recordKinds)
and gating the backstop on "a genuinely mutating success happened," not
merely "a call happened" — restores exactly the same protection the
zero-tool-call path already had, extended to every provider (`anthropic.ts`,
`openai.ts`, `deepseek.ts`, `act-narrate.ts`) and every pending recordKind,
not just this session's new one. A second-order false positive followed
immediately: once the backstop ran on pending-success turns too, it still
applied `PREVIEW_CLAIM_PATTERN` and the `claim-check.ts` classifier — both
built on the premise "no card exists at all this turn" (the classifier's
system prompt says so outright) — so a *truthful* "sending the card now, tap
to confirm" got flagged as fake. Fixed by only applying those two checks when
there was no pending success this turn; `FAKE_ACTION_PATTERN` (a completion
verb next to a quote) still applies either way, since a pending success can
still falsely claim the underlying *mutation* happened even when the card
itself is real. Both fixes are structural, not milestone-specific — they
correct a latent gap that already existed for `remove_task`/`remove_tasks`/
`create_goal`'s pending flows, just harder to trigger by chance before this
session's live pass happened to hit it via re-issued `advance_goal_stage`
calls.

**Server test suite: 123/123 passing** (up from 93 — milestone
`createGoalParamsSchema`/`milestoneGoalDefinitionSchema` matrix,
`computeMilestoneCardSummary`, pure `filterRetireCandidates`/
`isAdvanceProposalStale` decision coverage, and `create_goal`/
`advance_goal_stage` tool-schema regression cases are new). Both packages
typecheck clean; client `expo lint` clean; `expo export` clean (1832
modules).

The goal type system is now complete — savings, habit, indirect, milestone,
all shipped. *Still open from Phase 5:* the rest of history-aware replies
beyond indirect's delta narration (a same-week "4th workout this week" style
count); the formal §4-style DoD protocol run and CLAUDE.md §9 tick for Phase
5. Provider decision (deepseek-v4-flash is still the test provider) remains
the gate before Phase 6.

---

## Session ledger — Phase 5 completion (2026-07-13)

Worked `docs/phase-5-completion-plan.md` end to end: history-aware replies (the one
genuinely unbuilt feature), the reconcile-edge-case audit, and the formal DoD protocol
run. **Phase 5 is now ☑** (`docs/phases/phase-5-connected-loop.md`, CLAUDE.md §9).

**Shipped: history-aware replies.** New pure module `lib/ai/history.ts` — `weekStartYmd`
(Monday-start, computed in the account's timezone like every other date boundary),
`describeCompletionHistory`, and the I/O half `buildTaskCompletionHistory`, which counts
**done instances of a recurring series by `occurrenceDate`** (the due *day*, not
`records.occurredAt` — "4th workout this week" means four workout days, not four taps; the
partial unique index on `(template_id, occurrence_date)` guarantees one row per day). Wired
into `lib/ai/actions.ts` as `taskHistorySuffix`, sitting beside `goalImpactSuffix` and
gated identically on `becameDone` (a count after *un*-completing something is nonsense),
appended to `complete_task` and `progress_task`: goal fact first (the connected-loop
payload), history clause last (color). A one-off task returns null — it has no history to
count — and a count of **1 says nothing at all**: silence is the default, not a filler
sentence. The count is server-computed and quoted, never derived by the model (lesson
6/16), enforced by one line in `SYSTEM_PROMPT`.

**The DoD protocol run found three real bugs.** All were invisible to `tsc` and the unit
suite, and only surfaced by driving real turns — the same lesson as the `.strict()`
intersection bug and the pending-success gap before them. Each is fixed:

1. **The action pass stalled into `no_action` when a question was left dangling.** Given a
   complete goal spec ("target is $900 for the laptop"), the act pass made *zero* tool
   calls when an earlier clarifying question of its own ("how much toward the bike?") was
   still unanswered — it deferred the whole turn instead of acting on the intent the user
   had actually completed, and the narrate pass then claimed a preview card that did not
   exist (the claim-check caught it and retracted). Reproduced 2/3 on fresh accounts; a
   clean slot-fill, and the same interleave *without* a real dangling question, both
   passed 3/3 — so the dangling question was the variable, not multi-turn slot-filling.
   Root cause: `ACTION_SYSTEM_PROMPT` said "if something required is missing, call
   no_action" and "when in doubt, choose no_action", with **no rule to act on the parts
   it *can* act on**. Fixed with an explicit multi-intent rule: judge each intent
   separately, make every call you have complete information for, leave only the
   genuinely-missing parts to the reply pass (which can ask but cannot act). Now 5/5.

2. **An ambiguous task reference was silently written.** "mark water done", with both
   "Water the plants" and "Water filter change" open, made the act pass **pick one and
   complete it** while the narrate pass — correctly seeing the ambiguity — asked *which
   one they meant*. The user got a card saying it was done **and** a question, with a
   possibly-wrong task marked done: a direct violation of CLAUDE.md's "low-confidence
   extractions must ask for confirmation before writing." The believed coverage
   (`titleMatches`' lenient matching) cannot catch this by construction — it is a backstop
   against an *invented* ref, and "water" legitimately matches both; the server never sees
   that the *user* said only "water", so the only lever is the act pass declining to
   guess. Fixed with an ambiguity rule in `ACTION_SYSTEM_PROMPT` (act only when exactly
   one listed item fits; a reference that clearly names one — "mark the plants done" — is
   not ambiguous). Now 0/3 write, 3/3 ask, and unambiguous references still act 3/3.

   That fix exposed a **structural gap underneath it**: `no_action` took *no parameters*,
   so the act pass could not tell the narrate pass **why** it declined. Told only "nothing
   happened", the reply pass confidently claimed the task was completed anyway (3/3),
   leaving the claim-check to retract it — when the obviously right reply was "which one?".
   `no_action` now takes a **required `reason`**, which `act-narrate.ts` threads into the
   narrate pass's no-action block ("if that reason says something is ambiguous or missing,
   ASK for exactly that"). This is the only channel between the two passes on a no-action
   turn, and it makes every decline — ambiguity, a missing amount, a "maybe" — into a
   question the reply can actually ask. Locked by a contract test in `tools.test.ts`.

3. **"Undo that" reached past a pending card and silently reverted an older change.** With
   two *pending* tap-to-confirm removal cards showing (which mutate nothing), "undo that"
   called `undo_last_action`, which reverted the last real record — an unrelated
   **completed task** — while the reply told the user "just canceled the removal cards —
   nothing got deleted." DB-verified: the completion really was reverted, and the
   narration concealed it. An untapped card is not a change; it is undone by ignoring it.
   Fixed by teaching the act pass that pending cards and previews are not changes, so
   "undo"/"cancel"/"never mind" against one is `no_action` (with a reason), never
   `undo_last_action`. Now 3/3 leave the older completion alone, and a genuine undo still
   works 3/3.

**Protocol run — all 9 steps pass.** Fresh dev-token account, deepseek-v4-flash,
act/narrate on, DB inspected between steps. Single-write-many-views verified at the row
level (**one** `records` row; the `goal_entries` row references *that same record id*, not
a copy; undo marks `records.reverted_at` and every summary filters on it). Free text →
`complete_task` (never a second `log_goal_entry` for the same money). Re-reporting an
already-done task writes nothing. Missing numbers always ask. Two similarly-named savings
goals → "which savings goal — laptop or bike?", then the answer logs to the right one.
History: a 4th real completion across 4 real days replied "that's your 4th time this week"
(server-computed, and correctly excluding a still-open day). Hallucination probe: **7/7
claim-check verdicts "no", zero self-corrections**. Regression: all four goal types
create→act→undo (including the milestone confirm-tap and its undo restoring the stage *and*
its tasks), plus the task core (create/edit/postpone/complete/remove/bulk-remove/undo,
with the goal-cascade disclosure on the bulk card).

**Server test suite: 142/142 passing** (up from 123 — `history.test.ts` covers the
Sunday→Monday boundary, month/year rollover, the 11th/12th/13th/21st ordinal trap, silence
at a count of 1, and the one-off-task null; plus the `no_action` reason contract). Both
packages typecheck clean; client `expo lint` clean; `expo export --platform ios` clean.

**What's left.** Nothing in Phase 5. All three fixes are prompt/contract-level, which is
the right layer — the server could not have caught any of them deterministically, because
in each case the *tool result was already correct* and the failure was in what the model
chose to call, or chose to say. The recurring residue across all three is
**deepseek-v4-flash's narration fidelity**: on no-action turns it still sometimes claims an
action it never took (backstopped by the claim-check, which retracted it every time), and
in bug 3 it flatly contradicted a correct tool result. Data integrity is sound; narration
quality is the open question — and that is precisely the input to the **provider decision**,
now the sole gate before Phase 6. Run this same protocol against an Anthropic model and
pick on measured false-claim rate, not vibes.
