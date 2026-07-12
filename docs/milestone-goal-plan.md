# Milestone goal type — implementation plan

> **Pickup prompt for the implementing session:**
> _"Read `CLAUDE.md` and `docs/milestone-goal-plan.md`. The design is settled with the
> user — implement the work items in order; ask only if something in the codebase
> contradicts this doc. Live-test as a user (§5) before calling it done."_
>
> Standing state: AI provider is **deepseek-v4-flash** (`server/.env`), act/narrate on
> (`AI_ACT_NARRATE` defaults on); dev server via `npm run dev` in `server/` (tsx watch,
> manual restart on `.env` changes), stdout captured at `/private/tmp/meroa-server.log`.
> Dev accounts: `npm run dev:token +1555555XXXX`. Typecheck `npx tsc --noEmit` in both
> `server/` and repo root after each item; `npm test` in `server/` (93 passing at time
> of writing); client gate is `npm run lint` + `npx expo export --platform ios`.

## 0. What this is

The **fourth and last** of the locked goal types (docs/goals-redesign-plan.md §1.4).
Savings, habit, and indirect are shipped; after this the type system is complete and
Phase 5's remaining scope is history-aware replies + the formal DoD protocol run.

Locked decisions (§1.4, don't re-litigate):
- Ordered **stages** Meroa proposes upfront, editable in the preview before Create.
- **One stage active at a time.**
- A stage advances **only when the user says so** — never automatically, never
  because a task completed.
- On advance, Meroa proposes **retiring the old stage's tasks + creating the next
  stage's tasks in ONE confirm card** — the tap is the consent for the whole bundle.

Decisions defaulted in this plan (consistent with the locked design; flag to the user
only if one looks wrong in practice):
- **No numbers anywhere.** No target, currency, unit, deadline, or entries — a
  milestone goal's `log_goal_entry` is rejected exactly like habit's. Progress is
  `stagesDone / stagesTotal`, legitimate because every advance was user-declared.
- **Stages are plain strings** (`stages: string[]` + `activeStageIndex`), no per-stage
  ids in v1 — nothing references a stage by identity yet, and a fixed literal shape is
  the redesign's whole point. 2–8 stages, each 1–60 chars.
- **Post-creation stage-list editing is deferred** (locked scope says editable *in the
  preview*). After Create, `edit_goal` on a milestone allows name/icon only; a stage
  rename/insert wants its own pass. If the user asks in chat, Meroa says so honestly.
- **Task↔stage association is implicit**: the goal's currently-linked open tasks ARE
  the active stage's tasks. No `stageId` on tasks. Advance retires *all* open linked
  tasks (the card lists them) and creates the proposed next-stage set.
- **Completing the final stage completes the goal** — it stays in the list with a
  "Complete — all N stages" card state until the user removes it. No auto-archive.
- **Advance is chat-only in v1** (the confirm card). A detail-screen Advance button is
  deferred — proposing next-stage tasks is inherently conversational.

## 1. Shape

```ts
// goals.definition, joining the discriminated union in server/src/lib/goals/schema.ts
type MilestoneGoalDefinition = {
  type: 'milestone';
  stages: string[];          // ordered titles, 2–8, each 1–60 chars trimmed
  activeStageIndex: number;  // 0-based; === stages.length means complete
  checkInCadence?: 'weekly' | 'off';   // stored only, Phase 6 (same as other types)
};
```

- Derived, never stored: `stagesDone = activeStageIndex`, `complete =
  activeStageIndex >= stages.length`, `progress = activeStageIndex / stages.length`.
- `create_goal` always builds it with `activeStageIndex: 0` (the model never sets it —
  not exposed in the tool schema at all; `createGoalParamsSchema` gains `stages` only,
  and actions.ts stamps `activeStageIndex: 0` when building the preview definition,
  same place it defaults savings currency to `'$'`).
- **No goal_entries, ever** — guard in `logGoalEntry` (goals/executor.ts, beside the
  habit guard, with a milestone-specific message: advances are declared in chat, not
  logged as amounts). `starterTasks`/`nextStageTasks` contribution is forbidden in
  every schema (superRefine) AND `validateGoalLinkTarget` already lands milestone in
  the non-savings "never logs a number from a task" branch (tasks/executor.ts) —
  verify, don't rebuild.

## 2. The advance flow (the one genuinely new mechanism)

Mirror two existing, battle-tested patterns — do not invent a third:
`remove_task`'s **pending-confirmation card** (nothing mutates until a real tap) and
`POST /goals`' **consume-a-stored-proposal endpoint** (re-validate what the card
showed; idempotent via a stamped meta id + record idempotency).

### 2.1 AI tool `advance_goal_stage` (pending only, mutates nothing)

```
{ goalRef, nameHint, nextStageTasks?: StarterTask[] }   // contribution forbidden
```

- Executor case (lib/ai/actions.ts): resolve/verify ref+hint as usual; reject if the
  goal isn't milestone, or is already complete. Build the proposal **server-side from
  live state** — never trust the model's idea of which stage is current:
  ```ts
  proposal = {
    goalId, fromStageIndex, fromStage: stages[i], toStage: stages[i+1] ?? null, // null = this advance completes the goal
    retire: [{ taskId, title }],   // live open linked tasks + templates (dedup template vs. its instances by templateId)
    nextStageTasks,                // the model's proposed set, validated (no contribution; recurrence allowed)
  }
  ```
- Result: a goal-flavored pending variant, `recordKind: 'goal_advance_pending'`,
  summary = "Tap to confirm: finish "Applying" and move to "Interviewing" — retires
  ‹titles›, adds ‹titles›." Tool description copies remove_task's rules verbatim in
  spirit: call it as soon as intent is clear ("I got the interview!"), the tap IS the
  confirmation, never ask again in chat text; only ever on clear user declaration —
  completing a task is NOT a stage declaration.
- routes/messages.ts: in the `action_goal` branch, key the meta kind off recordKind
  (exactly the `task_removal_pending` trick at line ~213): `kind =
  recordKind === 'goal_advance_pending' ? 'goal_advance_pending' : 'goal_action'`, and
  persist `proposal` in meta when present (add an optional `proposal` field to the
  `action_goal` stream event in providers/shared.ts's event type + both providers'
  yield sites — grep `action_goal`).

### 2.2 `POST /goals/:id/advance { proposalMessageId }` (routes/goals.ts)

Follow `POST /` (create-from-preview) line by line:
- Load message + conversation, check ownership; `meta.kind === 'goal_advance_pending'`
  and `meta.proposal.goalId === :id`.
- **Idempotency/staleness**: if `meta.advancedRecordId` exists → return current goal
  (200, consumed — the create-from-preview `createdGoalId` pattern, including checking
  archived rows). Then re-validate against LIVE state: goal exists, not archived, type
  milestone, `definition.activeStageIndex === proposal.fromStageIndex` — else 400
  "that advance card is stale — the goal has moved on since; ask Meroa again."
- Execute `advanceGoalStage` (new, goals/executor.ts), one transaction:
  1. definition → `activeStageIndex + 1`, version bump.
  2. Retire: soft-delete (`deletedAt`) every proposal-listed task that's still live
     and still linked; templates regardless of status, instances/standalones only
     while open (same filter as `archiveGoalCascadeInTx` — reuse its shape, but do
     NOT archive the goal). Record what was actually deleted, not what was proposed.
  3. Create `nextStageTasks` via `createTaskInTx` with `skipRecord: true` and
     per-starter `toolCallId: 'advance-starter:${i}'` (both createGoal precedents —
     the idempotency-collision and record-tie lessons are already documented there),
     stamping `goalId`, never a contribution.
  4. ONE record: `kind: 'goal_stage_advanced'`, payload `{ goalId, name, prior:
     { definition, version }, retiredTaskIds, createdTaskIds }` (created = template
     ids, matching goal_created's starterTaskIds convention).
  5. Stamp `meta.advancedRecordId` on the proposal message (outside tx is fine — the
     create-from-preview endpoint does its meta stamp the same way).
- Response `{ goal, tasks }` like POST /.

### 2.3 Undo + narration

- `undoTaskRecord`/`undoGoalRecord` (tasks/executor.ts): new `goal_stage_advanced`
  case in **undoGoalRecord** — restore `prior.definition`/`prior.version`, un-delete
  `retiredTaskIds`, soft-delete `createdTaskIds` + their open materialized instances
  (the goal_created-undo cascade shape, verbatim).
- `recent-changes.ts`: add the kind to `describeChange` ("advanced ‹name› to its next
  stage"), `describeUndone` ("moved ‹name› back a stage"), `describeUndoable`.
- `goalImpactSuffix` (lib/ai/actions.ts): milestone branch on becameDone — one
  sentence: "That supports ‹name› (stage N of M, "‹stage›") — say the word when the
  stage itself is done; it never advances on its own." Nothing on becameOpen.

## 3. Everything else — follow the indirect-type template mechanically

The indirect pass (commits `84b10d9` + `1f93e9f`) touched the exact file list below;
milestone is the same sweep with a different shape. Per file:

**Server**
- `lib/goals/schema.ts`: `GOAL_TEMPLATES` += 'milestone'; `milestoneGoalDefinitionSchema`
  (strict; stages `z.array(z.string().trim().min(1).max(60)).min(2).max(8)`;
  activeStageIndex `z.number().int().min(0)`); union member; `createGoalParamsSchema`
  gains `stages` (input side, no activeStageIndex) + superRefine arm: milestone
  requires stages, forbids targetValue/currency/deadline/unit and any starter
  contribution (fail-loud corrective messages, cfe7300 pattern). Keep the union-member-
  can't-carry-superRefine constraint in mind (see indirect's comment) — cross-field
  rules live in createGoalParamsSchema and applyEditOps, and add
  `activeStageIndex <= stages.length` wherever the definition is rebuilt.
- `lib/goals/executor.ts`: `applyEditOps` milestone arm → name/icon only, everything
  else rejected with a type-aware message (habit arm is the template);
  `logGoalEntry` milestone guard; `advanceGoalStage` (§2.2); `createGoal` — verify the
  savings-only contribution stamping condition still holds (it's `type === 'savings'`,
  so milestone is safe by construction).
- `lib/goals/summary.ts`: `computeMilestoneCardSummary(definition)` — pure, no I/O:
  headline = active stage title, or `Complete — all N stages` when done; sub =
  `stage N of M` (done: `M stages done`); progress = activeStageIndex/stages.length;
  paceLine/streak null. Wire into `buildGoalCardSummaries` + `buildGoalDetail`;
  `GoalDetail` gains `stages: string[] | null` + `activeStageIndex: number | null`
  (null on every other type, matching the unit/currentValue convention).
- `lib/ai/tools.ts`: `create_goal` type enum + `stages` param (description: propose
  sensible ordered stages from what the user said, 2–8, user can edit in the preview;
  starterTasks = FIRST stage's tasks only); `edit_goal` description notes milestone is
  name/icon only; new `advance_goal_stage` tool + zod backstop in `AI_TOOL_SCHEMAS`.
  **Schema-composition lesson (regression suite exists): never `.strict()` an
  intersected wrapper — extend `lib/ai/tools.test.ts` with milestone create/advance
  parse cases FIRST, they're cheap.**
- `lib/ai/system-prompt.ts`: SYSTEM_PROMPT goals section — fourth kind described;
  advance rules (user-declared only; the card tap is the only confirmation; a
  completed linked task is never a reason to advance; if asked to edit stages, be
  honest that stages are set at creation for now). ACTION_SYSTEM_PROMPT — one line for
  advance_goal_stage mirroring the remove_task/no_action guidance.
- `lib/ai/goal-context.ts`: milestone line — `[G2] "Land internship" · milestone ·
  stage 2/5 "Interviewing" · advance ONLY on the user's say-so (advance_goal_stage)`.
- `lib/ai/task-context.ts`: linked-task label branch — `· supports milestone goal
  "‹name›" (never advances a stage by itself)`.
- `lib/ai/pending-preview.ts`: milestone facts branch — `· milestone (5 stages,
  starting at "Applying")`.
- `routes/messages.ts` + `providers/shared.ts` (+ anthropic/act-narrate yield sites):
  the proposal-carrying action_goal event (§2.1).
- `routes/goals.ts`: the advance endpoint (§2.2); POST / re-validation — the existing
  habit check-in re-validation block gains nothing (milestone starters are optional),
  but `GOAL_TEMPLATES.includes(...)` already admits milestone once the const grows.

**Client**
- `src/lib/api/types.ts`: `GoalTemplateKey`/`GoalDefinition` + milestone;
  `ApiGoalDetail` + `stages`/`activeStageIndex`; `CreateGoalParams.stages?`;
  advance-proposal meta type if you type message metas anywhere (they're
  `Record<string, unknown>` today — cast locally like the other cards do).
- `src/lib/api/client.ts`: `advanceGoalStage(id, proposalMessageId)` → POST
  /goals/:id/advance.
- `src/features/goals/queries.ts`: `useAdvanceGoalStage` — invalidates `goalsQueryKey`,
  the goal detail, AND `tasksQueryKey` (it retires + creates tasks; the
  create-from-preview hook is the template).
- `src/components/GoalCard.tsx`: fourth arm in the type switch — icon/name, headline =
  active stage, sub `stage N of M`, `Progress` bar (real, user-declared fraction), no
  ring needed; complete state reads "Complete — all N stages".
- `src/app/goal/[id].tsx`: `StagesView` — vertical stage list, done = check + strike,
  active = accent highlight, pending = dim; no Log FAB, no entry sheet, no history
  section (habit's branch shows how to suppress them).
- `src/app/(tabs)/index.tsx`: `GoalPreviewCard` — milestone branch renders the stage
  list (numbered) instead of a Target line; new `GoalAdvanceConfirmCard` for
  `meta.kind === 'goal_advance_pending'` — copy `TaskRemovalConfirmCard`'s skeleton
  (~line 126): shows from→to stage, retire list, new-task list; buttons "Not yet" /
  "Advance"; consumed state via `meta.advancedRecordId` or live-goal
  `activeStageIndex !== proposal.fromStageIndex` → "Advanced ✓" / "Stale — ask again";
  wire into `MessageRow`'s kind switch.

## 4. Tests (server vitest — extend, currently 93 passing)

- `schema.test.ts`: milestone superRefine matrix — accepts 2..8 stages; rejects 1
  stage / 9 stages / empty titles / targetValue / currency / unit / deadline / starter
  contribution.
- `summary.test.ts`: `computeMilestoneCardSummary` — fresh (0/N), mid (2/5 headline =
  stages[2]), complete (N/N), progress fractions.
- New `advance` decision coverage: pure retire-filter (templates always, open
  instances/standalones only, done instances survive) — extract as a pure helper if
  it isn't naturally one; staleness predicate (fromStageIndex mismatch).
- `tools.test.ts`: create_goal-with-stages and advance_goal_stage inputs parse; every
  ordinary field still accepted (the .strict() regression class).

## 5. Live as-a-user pass (fresh dev-token account, real DB between steps — the §4-protocol culture; a schema/tool change needs live chat turns, not just tsc — see the create_task `.strict()` lesson in goals-redesign-plan.md)

1. "help me land a summer internship" → ONE preview: milestone, sensible ordered
   stages, stage-1 starter tasks only, no invented numbers. Revise before Create
   ("add a 'negotiate offer' stage") → fresh preview.
2. Create tap → goal + stage-1 tasks exist, linked, `activeStageIndex: 0`; double-tap
   idempotent.
3. Complete a linked task → impact suffix states "supports … never advances on its
   own"; goal unchanged in DB.
4. "I finished all my applications!" → advance card (retire list = stage-1 open tasks,
   proposed stage-2 tasks); confirm in chat text ("yes do it") does NOT advance —
   model points at the card. Tap Advance → index 1, retired tasks gone (done ones
   survive as history), new tasks created; card flips to consumed.
5. "undo that" → definition, retired tasks, and created tasks all restored; the card
   shows stale/consumed, and re-tapping it does not double-advance.
6. Advance through the final stage → complete state on card/detail/context line;
   further advance attempts get a clean refusal.
7. Guards: "log 3 to my internship goal" → rejected with the milestone message; edit
   target/deadline/unit → rejected; stage-list edit request → honest "set at creation
   for now"; remove_goal → cascades linked tasks, undo restores.
8. Regression: savings, habit, indirect quick pass (create → act → undo each);
   task-core quick pass; `npm test`, both typechecks, `npm run lint`,
   `npx expo export --platform ios` (~1976 modules dev / 1831 export at last count).

## 6. After this ships (not this session's scope)

Phase 5 remainder: history-aware replies beyond indirect's delta line ("4th workout
this week"); the formal Phase-5 DoD protocol run + CLAUDE.md §9 tick; then the
provider decision (flash is still the test provider) gates Phase 6. Record results in
`docs/goals-redesign-plan.md`'s ledger as always.
