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
