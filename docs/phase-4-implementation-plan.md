# Phase 4 (Tools) — implementation plan

> **Pickup prompt for the implementing session:**
> _"Read `CLAUDE.md`, `docs/phases/phase-4-tools.md`, and `docs/phase-4-implementation-plan.md`. The design is settled — implement the work items in order; ask only if something in the codebase contradicts this doc."_
>
> Standing state: the AI provider is **deepseek-v4-flash** (`AI_PROVIDER`/`DEEPSEEK_MODEL`
> in `server/.env`) — don't change it. The dev server runs via `npm run dev` in `server/`;
> `.env` changes need a manual restart (tsx watch doesn't pick them up). Typecheck with
> `npx tsc --noEmit` in both `server/` and the repo root after each work item.

This plan applies all 16 "Lessons for future phases" from
`docs/ai-reliability-hardening.md` from day one (mapping table in §8). No DB migration is
needed — `tools`, `tool_entries`, and the `records.source` check (`'tool_ui'` already
allowed) shipped in Phase 1.

---

## 1. Design decisions (settled — don't re-litigate)

### 1.1 Tool definition model

A tool = typed **fields** + a **target** + **progress views**, stored in `tools.definition`
(jsonb), versioned via the existing `tools.version` int. New `server/src/lib/tools/schema.ts`:

```ts
type ToolField = {
  id: string;              // crypto.randomUUID() — stable across renames/layout changes
  label: string;
  type: 'number' | 'text' | 'boolean' | 'rating' | 'choice';  // rating = 1–5
  unit?: string;           // number fields: "$", "kg", "lb", "pages", …
  options?: string[];      // choice fields
  required?: boolean;
  archived?: boolean;      // removed fields are archived, never deleted — old entries keep their data
};
type ToolTarget =
  | { kind: 'total'; value: number; unit?: string }               // money/numeric: sum toward a total
  | { kind: 'count_per_period'; period: 'day' | 'week'; value: number };  // habit/workout: N entries per period
type ToolView =
  | { kind: 'progress_total' }                 // gradient bar + ring toward target
  | { kind: 'streak' }
  | { kind: 'bars'; bucket: 'day' | 'week'; measure: 'count' | 'sum'; fieldId?: string }
  | { kind: 'recent_list' };
type ToolDefinition = {
  fields: ToolField[];
  primaryFieldId?: string;   // the numeric field summed for totals (money "Amount", numeric "Value")
  target?: ToolTarget;
  views: ToolView[];         // 1–3, render order
  entryNoun?: string;        // "session", "contribution", "entry" — used in copy
};
```

**Versioning = one logical object** (lesson 2): a layout edit bumps `tools.version` and
snapshots the prior `{ name, icon, definition, version }` into the `tool_edited` records
row — there is no separate versions table and version history never renders as peer
tools anywhere (not in the Tools tab, not in the model's context). Entries store data
keyed by stable field ids, so they survive renames, archived fields, and re-ordering
untouched.

### 1.2 Templates, not an open-ended builder

`server/src/lib/tools/templates.ts` exports `buildTemplateDefinition(template, params)` —
the **server** assembles the full definition from a template key + small validated params;
the model never emits raw field arrays for the default shape. Templates for launch:

| template  | default fields                                                        | target                    | views                          |
| --------- | --------------------------------------------------------------------- | ------------------------- | ------------------------------ |
| `workout` | Exercise (text), Sets (number), Reps (number), Weight (number, unit param), Notes (text, optional) | count_per_period week (param) | bars(week, count) + recent_list |
| `habit`   | Notes (text, optional) — an entry's existence *is* the check-in       | count_per_period day/week | streak + bars(day, count)      |
| `numeric` | Value (number, unit param)                                            | total or count (params)   | progress_total or bars + recent_list |
| `money`   | Amount (number, currency param), Note (text, optional)                | total (param)             | progress_total + recent_list   |
| `journal` | Entry (text), Rating (rating, optional)                               | —                         | recent_list                    |

`project` is **deferred** within the phase (stages need a status-mutation model the
others don't; DoD only requires workout/habit/numeric/money — add project after those
land end-to-end, or model it as a journal/list with a `choice` status field if trivial).
`create_tool` params allow bounded customization at create time: `extraFields`
(max 5, `{label, type, unit?}`) and `omitFields` (default-field labels to drop).

### 1.3 Preview → confirm creation flow (the card is the only confirmation)

Mirrors the `task_removal_pending` pattern exactly:

1. `create_tool` **never writes a `tools` row.** It validates params, builds the full
   definition server-side, and returns `recordKind: 'tool_preview'` with the preview
   payload. `routes/messages.ts` persists an assistant message with
   `meta: { kind: 'tool_preview', preview: { template, name, icon, definition } }` and
   streams it; the client renders a **ToolPreviewCard** (name, icon, field list, views,
   target) with **Create** / **Not now** buttons.
2. The tool-result text fed back to the model says explicitly: *"Preview card shown —
   nothing is saved yet; the user taps Create on the card to save it. Do not ask them to
   confirm in chat text."* (lesson 10 / the phase's own guardrail, enforced in both the
   system prompt and the tool result).
3. **Create** calls `POST /tools { previewMessageId }`. The server loads that message,
   verifies it belongs to the user's conversation and has `meta.kind === 'tool_preview'`,
   re-validates the stored definition with zod, creates the tool, writes a
   `tool_created` records row (**source `'tool_ui'`** — it's a tap, not a chat turn),
   and stamps `meta.createdToolId` back onto the preview message. The stamp makes the
   flow **idempotent** (second tap returns the existing tool) and lets the card render
   "Created ✓" from server truth after reloads.
4. **Not now** is client-local dismissal (like the removal card's "Keep it") — no server
   write. The live tool list in context is the model's ground truth either way.
5. "Requests changes" pre-save = the model calls `create_tool` again with revised params
   → a new preview card. Old preview cards stay tappable (a user may genuinely want
   both); the idempotency stamp prevents double-creates per card.

### 1.4 Turn-scoped refs for tools and fields (never UUIDs)

Tools get aliases `L1`, `L2`, … (mnemonic: too**L**s; distinct from tasks' `T*` so a
regex can't confuse them), fields `L1.1`, `L1.2`, … `TurnRef` in
`lib/ai/task-context.ts` gains:

```ts
| { kind: 'tool'; toolId: string }
| { kind: 'tool_field'; toolId: string; fieldId: string }
```

New `lib/ai/tool-context.ts` builds the tool block and **appends into the same TurnRefs
map** the task context created. Zod: `toolRef: /^L\d+$/`, `fieldRef: /^L\d+\.\d+$/`.
`nameHint` (the titleHint analog) is the secondary check, verified against the tool's
real current name via the same lenient `titleMatches` logic.

Example context row (all derived values **precomputed** — lesson 6):

```
[L1] "Savings for Berlin" · money · 1,240/2,000 $ · 8 entries, last Jul 9 [fields: L1.1="Amount" (number, $), L1.2="Note" (text, optional)]
[L2] "Push day" · workout · 2/3 sessions this week · 12 entries, last yesterday [fields: L2.1="Exercise" (text), …]
```

Archived fields are **not** rendered (the model can't reference or write them). Cap the
block like the task list (~10 tools / ~1500 chars, "…and N more" overflow line). The tail
block (`buildTailBlock`) gains a `# Their tools` section between the task list and the
recent-changes feed, plus the absence rule line extended to cover tools.

### 1.5 The three new AI tools

- **`create_tool`** — `{ template, name, icon?, unit?, currency?, target?, targetPeriod?,
  extraFields?, omitFields? }`. Returns a preview (§1.3). Description mirrors
  `remove_task`'s hard-won wording: call it as soon as there's enough to render a
  preview; the card is the confirmation; only ask questions that change the result;
  never invent a target the user didn't give (target is optional — a money tool with no
  stated goal is fine, don't interrogate).
- **`edit_tool`** — applies **directly** (the phase spec reserves preview-first for
  creation; edits are undoable instead). Input is **constrained ops, never a
  full-definition resend** (lesson 13's shape): `{ toolRef, nameHint, name?, icon?,
  target?, unit?, addFields?, removeFieldRefs?, renameFields?: [{fieldRef, label}] }`.
  Server applies ops to the current definition, archives (never deletes) removed fields,
  bumps `version`, snapshots prior into the `tool_edited` record. Summary states
  concrete values: `Updated "Savings" — target is now $2,000 (was $1,500). All 14
  entries kept.`
- **`log_tool_entry`** — **explicit** chat entry only ("log 150 to savings"); free-text
  inference stays in Phase 5. Input: `{ toolRef, nameHint, values: [{ fieldRef, value }],
  entryAt? }`. Server resolves field refs, type-checks each value against the field's
  type, rejects a missing required field with an ask-the-user error (never invents —
  golden rule), normalizes `entryAt` through `localDatetimeToUtcIso`. Summary states the
  recomputed post-write fact: `Logged $150 to "Savings" — 1,390/2,000 now.`

`undo_last_action` stays one tool; its description widens to cover tool changes.
`validateToolInput` / `AI_TOOL_SCHEMAS` / `OPENAI_TASK_TOOLS` extend mechanically.
`executeAiToolCall` gains tool cases; `TaskActionResult` grows a tool-shaped ok-variant
(`{ ok: true; toolName; toolResult: { kind: 'preview' | 'tool'; tool?; preview?; }; summary; recordKind }`)
— the `wrapFailure` boundary applies unchanged, so every new failure path automatically
leads with `ACTION NOT COMPLETED — nothing was changed.` (lesson 3).

### 1.6 Executor, records, and undo

New `server/src/lib/tools/executor.ts`, same conventions as the tasks executor
(transactions, `findIdempotentRecord`-style chat-retry guard keyed on
`(sourceMessageId, toolCallId)`, `TaskActionError`-style typed errors):

- `createTool` → `tool_created` record `{ toolId, name }`.
- `editTool` → `tool_edited` record `{ toolId, name, prior: { name, icon, definition, version } }`.
- `logToolEntry` → one transaction: `records` row (`kind: 'tool_entry'`,
  `payload: { toolId, name, data, entryAt }`) + `tool_entries` row referencing it
  (store once, render everywhere — the entry row is a view of the record).
- `archiveTool` → sets `archivedAt`, `tool_archived` record (small addition beyond the
  phase task list — users will create junk tools while testing; swipe/long-press in the
  Tools tab can come later, the executor + route ship now).

**Undo generalizes** (golden rule: every write reversible; lessons 11 + 16):
`undoLastAction`'s record filter becomes `kind LIKE 'task_%' OR kind LIKE 'tool_%'`, with
new cases — `tool_created` → archive; `tool_edited` → restore prior snapshot (name,
icon, definition, version); `tool_entry` → the generic `revertedAt` flip *is* the undo
(entry queries exclude reverted records); `tool_archived` → clear. Every undo inserts a
fresh `tool_undo` records row (never just a flag flip) whose payload and tool-result
summary state the **concrete restored value** (`Undid the edit — "Savings" target back
to $1,500.`, `Removed that $150 entry — "Savings" back to 1,240/2,000.`). Return type
generalizes to a task-or-tool union; `POST /tasks/undo` keeps its path (response gains
an optional `tool` field), and `actions.ts`'s `undo_last_action` case narrates whichever
kind came back. `tool_undo` itself is un-undoable, same as `task_undo`.

jsonb discipline (lesson 15): `entryAt` and any date in a prior snapshot revives through
`new Date(value)` at the read boundary (`reviveDate` already exists in the tasks
executor — export/share it).

### 1.7 Server-side summary + chart math (the model and the client both just render)

New `server/src/lib/tools/summary.ts`. Entries = `tool_entries` joined to `records`
**where `records.revertedAt IS NULL`**. All bucketing in the **account timezone** via the
existing `ymdInTz` helpers (lesson 12 — the client never re-buckets; it renders labeled
buckets the server sends). Computed per tool:

- `total` — sum of `primaryFieldId` over live entries (money/numeric).
- `periodCount` — live entries in the current day/week. Weeks start **Monday** in the
  account tz (document in code; the chart labels make it visible).
- `streak` — consecutive days with ≥1 entry counting back from today; if today has none
  yet, the streak counts from yesterday (a streak isn't broken until the day ends).
- `buckets` — last 7 days (daily) or last 8 weeks (weekly): `[{ label, ymd, value }]`,
  value = count or primary-field sum per the view's `measure`.
- `headline`, `sub`, `progress` (0–1) — precomputed card strings ("1,240 / 2,000 $",
  "3-day streak") so the Tools tab and the AI context render identical facts.

### 1.8 REST surface (`server/src/routes/tools.ts`)

- `GET /tools` — list with `entryCount` + card summary (replaces the current N+1
  count loop with one grouped query while in there).
- `GET /tools/:id` — `{ tool, summary, charts, entries }` (recent entries, newest first).
- `GET /tools/:id/entries?cursor=` — paginated history.
- `POST /tools` — `{ previewMessageId }` confirm flow (§1.3), source `'tool_ui'`.
- `PATCH /tools/:id` — same constrained-ops patch shape as `edit_tool` (shared zod), for
  parity and Phase 5; the AI path goes through the executor directly.
- `POST /tools/:id/entries` — quick-entry sheet target, source `'tool_ui'`.
- `DELETE /tools/:id` — archive.

There is **no direct edit form in the app this phase** (the phase task list scopes
editing to edit-with-AI) — which also sidesteps lesson 13's guessed-default risk
entirely on the client. The quick-entry sheet only ever sends fields the user actually
filled in; untouched optional fields are omitted, not defaulted.

### 1.9 Context, narration, and safety-net plumbing

- `routes/messages.ts`: build tool context after task context (append to the same refs
  map), pass `toolListText` into `buildTailBlock`; persist the new action message kinds
  (`tool_preview`, `tool_action`); **strip both in `historyContentFor`** (lesson 7 —
  fixed templated shapes never re-enter model-visible history).
- Providers (`deepseek.ts`, `openai.ts`, `anthropic.ts`): handle the tool-shaped ok
  result → yield a new `action_tool` stream event `{ toolName, summary, recordKind,
  tool?, preview? }`; `routes/messages.ts` maps it to a persisted message + the existing
  `action` SSE event shape (`{ message, tool? }`).
- `recent-changes.ts`: widen the source filter to `['tasks_ui', 'tool_ui']`; add
  `describeChange`/`describeUndo` phrasings for the four tool kinds (`the "Savings" tool
  was created (you tapped Create)`, `an entry was logged to "Push day"`, …). This is how
  a preview-confirm tap or a quick-entry-sheet log gets narrated into the next turn
  (lesson 4).
- `shared.ts`: add `create_tool|edit_tool|log_tool_entry` to `TOOL_NAME_LEAK_PATTERN`.
- `claim-check.ts`: widen the classifier prompt from "a task action" to "a task or
  tracker action (… creating a tool/tracker, logging an entry to one)".
- `system-prompt.ts`: a `# Tools` section — tools are long-term trackers vs tasks'
  near-term to-dos, with a one-line disambiguation rule (clearly long-term progress →
  tool; near-term concrete action → task; genuinely unclear → one short question);
  call `create_tool` as soon as a preview is renderable, the card is the only
  confirmation; never invent an entry value or a target; edits preserve history; the
  refs-are-bookkeeping-only bullet extends to `L*` refs. Watch for invented constraints
  (lesson 14) — the edit_tool tool description explicitly lists what *is* editable so
  the model doesn't fabricate what isn't.

### 1.10 Client

- `src/lib/api/types.ts` + `client.ts` + `features/tools/queries.ts`: `ToolDefinition`
  types, `ApiToolSummary`, detail/entries/create/patch/entry/archive endpoints,
  `useTool(id)`, `useToolEntries`, `useCreateToolFromPreview`, `useLogToolEntry` —
  mutations invalidate `['tools']` (and the detail key). `features/chat/queries.ts`:
  the `action` SSE handler additionally invalidates tools when the message meta is
  tool-shaped.
- **ToolPreviewCard** (chat): icon + name, field chips, target/views line, Create /
  Not now; states: pending → Created ✓ (from `meta.createdToolId` + live tools query) /
  Kept. Follows `TaskRemovalConfirmCard`'s structure.
- **ToolActionCard** (chat, for `tool_action` messages): resolves the live tool by id
  (falls back to meta snapshot), one-line summary + headline stat — same
  live-view-of-the-record pattern as `TaskActionCard`.
- **Tools tab**: use the existing `ToolCard` (ring + gradient bar) with server
  `summary.headline/sub/progress`; tap → detail.
- **Tool detail screen** (`src/app/tool/[id].tsx`, stack route above the tabs): header
  stat, views rendered in order (progress bar/ring, streak chip, bar chart, recent
  list), full history section, floating "+ Log" button → **quick-entry bottom sheet**
  (existing `Sheet` component; per-field inputs by type; required-field validation;
  sends only what the user filled). Haptic on log, matching task completion.
- **BarChart** (`src/components/BarChart.tsx`): plain react-native-svg bars from server
  buckets — theme tokens (blue gradient fill, dim labels, radius 4), no chart library.

---

## 2. Work items, in order (each independently commit-able)

1. **Tool definition schema + templates** — `lib/tools/schema.ts`, `lib/tools/templates.ts`
   (zod for definition, ops-patch, entry values; the five template builders + param schemas).
2. **Executor + undo generalization** — `lib/tools/executor.ts`; generalize
   `undoLastAction` (filter, tool cases, fresh `tool_undo` record, union return); share
   `reviveDate`.
3. **Summary/chart math** — `lib/tools/summary.ts` (+ unit-testable pure core; tz
   bucketing via `ymdInTz`).
4. **REST routes** — expand `routes/tools.ts` (§1.8), fix the list N+1.
5. **AI layer** — `lib/ai/tool-context.ts`; extend `tools.ts` (defs + zod),
   `actions.ts` (three cases + undo narration), `system-prompt.ts` (tools section +
   tail block section), providers (`action_tool` event), `routes/messages.ts`
   (context build, meta persistence, history strip), `recent-changes.ts`,
   `shared.ts` regex, `claim-check.ts` prompt.
6. **Client API + chat cards** — types/client/queries; ToolPreviewCard, ToolActionCard,
   chat stream invalidation.
7. **Tools tab + detail screen** — ToolCard wiring, `tool/[id].tsx`, BarChart,
   quick-entry sheet.
8. **Verification + docs** — typecheck/lint both packages, live protocol (§3), tick
   Phase 4 in `CLAUDE.md` §9 + the phase file, record protocol results in this doc.

---

## 3. Acceptance protocol (run live against deepseek-v4-flash, isolated dev-token account)

Ground rules as in `docs/openai-provider-swap.md` §6: ground truth = `chat turn finished`
/ `claim-check verdict` logs + direct DB reads; clean up after.

1. "I want to save $2,000 for Berlin by December" → **one** preview card, no
   clarifying interrogation, no "should I save this?" prose.
2. "actually make it $2,500" (pre-save) → revised preview card.
3. Tap **Create** → tool exists; *next turn* "what am I saving for again?" → correct
   answer; feed narrated the tap.
4. "log $150 I saved" → `log_tool_entry`, reply states the real new total (from the
   tool result, not model arithmetic).
5. Quick-entry from the tool's own UI → next chat turn narrates the out-of-band entry.
6. "add a note field to my savings tracker" → `edit_tool`; version bumped; **all prior
   entries intact** (DB check).
7. "change the goal to $3,000" → concrete summary ("was $2,500"); then "undo that" →
   restored value stated concretely and correct in DB.
8. Workout: create → log 2 sessions → detail chart buckets correct in the account tz;
   "how many workouts this week?" answered from context (no arithmetic invention).
9. Habit: create → entries on consecutive days (backdate via `entryAt`) → streak
   correct in card, context, and reply.
10. Failure paths: hand-forced bad `toolRef` / wrong `nameHint` / missing required
    entry value → `ACTION NOT COMPLETED` and the model doesn't narrate success.
11. Ambiguity: "I should read more" → asks (task vs tool vs nothing), doesn't create.
12. Regression: re-run the task core-10 quickly (tail block changed) — no new
    hallucinations; claim-check stays quiet on clean turns.

## 4. Definition of Done mapping

| DoD line | Where satisfied |
| --- | --- |
| Describe goal → preview before save; confirm creates; change requests update the preview | §1.3 flow, protocol 1–3 |
| Workout, habit, numeric, money usable end-to-end (create → log → chart/history) | §1.2 templates, §1.7–1.8, §1.10 detail screen, protocol 4–9 |
| Editing fields (add RPE, change target) keeps prior entries | §1.1 stable field ids + archived-not-deleted, §1.5 edit_tool ops, protocol 6–7 |

## 6. Live protocol results (July 12, 2026 — deepseek-v4-flash)

Ran against an isolated dev-token account (`+15559990001`) over real HTTP against the
running dev server, ground truth from direct REST reads. All tools archived afterward.

- **money template**: "I want to save $2,000 for a trip to Berlin" → one preview card, no
  interrogation, no chat-text re-confirmation. Create-tap saved it; a second identical tap
  returned the same tool id (idempotent). `log_tool_entry` ("I just put $150 into it")
  stated the real recomputed total ($150/$2,000), not a guess. `edit_tool` ("change the
  goal to $2,500") stated the concrete before/after ("target is now $2,500 (was $2,000)");
  `undo_last_action` correctly restored $2,000 and stated it. Adding a field ("add a
  Method field") bumped the version and confirmed "Past entries are unaffected" — verified
  directly against the DB: the original $150 entry's `data` was untouched.
- **workout template**: "track my push day workouts, weight in lb" → correct default
  fields (Exercise required, Sets/Reps/Weight/Notes) with the stated unit. A well-formed
  log call recorded all four values and reported a real streak. A request with no exercise
  name ("log 5 sets of 5") made the model ask "What exercise is this for?" instead of
  guessing — matching CLAUDE.md's golden rule. Direct REST calls confirmed the server-side
  backstop independently: a missing required field returned `"Exercise" is required — ask
  the user for it rather than guessing`; a non-numeric value for a number field returned
  `"Sets" needs a number`.
- **habit template**: "help me build a meditation habit tracker, once a day" → correct
  streak + daily-bars views, `count_per_period` target. A quick-entry logged directly via
  REST (source `tool_ui`, simulating the app's own quick-entry sheet) was correctly
  narrated into the very next chat turn — asked "did I check in on meditation today?" and
  got "Yeah, you're 1/1 today — already checked in," with no re-ask and no stale belief.
- **numeric template**: "track how many pages I read each day" → correct single Value
  field with a `sum`-measured weekly bars view. Logging "read 30 pages today" produced the
  correct weekly chart bucket (the current Monday-anchored week showing 30, all prior weeks
  0) confirmed directly against the detail endpoint.
- **Absence rule**: asked to edit a tool that was never created ("change the target on my
  crypto portfolio tracker") — the model correctly declined, listing the real existing
  tools by name, zero tool calls, no hallucinated edit.
- **Failure paths**: a nonexistent tool id against `GET /tools/:id` returned a clean
  `not_found`; every invalid_input path led with an unambiguous outcome statement per the
  `wrapFailure` boundary (verified in the chat transcripts — the model never described any
  of these as done).

No hallucinations, no double-confirmation prompts, and no data loss observed across this
run. Small sample (one pass per template, single session) — directional, not exhaustive;
same caveat as every prior protocol run in `docs/ai-reliability-hardening.md`.

## 7. Deliberate scope notes for a future pass

- **`project` template deferred** (§1.2) — the four DoD-required templates (workout,
  habit, numeric, money) plus journal shipped; project's stage/status model doesn't fit
  the shared entry-log shape and needs its own design pass.
- **No direct edit-fields UI** — edit-with-AI is the only edit surface this phase, by
  design (sidesteps the guessed-default risk in lesson 13 entirely). A form-based editor,
  if ever wanted, is a deliberate future addition, not an oversight.
- **Entry history has no pagination UI yet** — the detail screen renders whatever `GET
  /tools/:id` returns (up to 20 recent entries); the cursor-paginated `GET
  /tools/:id/entries` route exists and works (used by `useToolEntries`) but nothing in the
  UI calls "load more" yet. Fine for the DoD's history requirement; revisit if a tool
  regularly exceeds 20 entries in real use.
- **Tool→task linking (`tasks.toolId`) is still Phase 5 scope**, untouched here.

## 8. Hardening-lessons coverage (16/16)

refs not UUIDs (1→§1.4) · no storage shape / one logical object (2→§1.1 versioning)
· explicit failure text (3→wrapFailure reuse §1.5) · out-of-band narration (4→§1.9 feed)
· live state at tail (5→existing tail block, tools section added) · precomputed math
(6→§1.7) · no templated shapes in history (7→historyContentFor strip §1.9) · claims need
receipts (8→claim-check widened §1.9) · standing protocol (9→§3) · card is the only
confirmation (10→§1.3 + prompt + tool description) · fresh record on undo (11→§1.6)
· tz-consistent bucketing (12→§1.7 server-only buckets) · edit surfaces never resave
guesses (13→ops-only patches §1.5, send-only-touched entry sheet §1.10, no direct edit
form) · invented-constraint watch (14→explicit editable-ops list in tool description)
· jsonb date revival (15→§1.6) · undo summaries state restored values (16→§1.6).
