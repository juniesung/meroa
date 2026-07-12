# AI Reliability Hardening — implementation spec & session handoff

> **Pickup prompt for a fresh session:**
> _"Read `CLAUDE.md` and `docs/ai-reliability-hardening.md`. Implement the work items in order. Plan-per-item is already done — don't re-litigate the design; ask only if something in the codebase contradicts this doc."_
>
> Status (July 11, 2026): **items 1–7 implemented and typechecked**, including a
> workflow-backed adversarial review pass that caught and fixed 5 real bugs introduced
> during implementation (scope-blind bulk-removal wording, a bulk-delete race that silently
> no-op'd the whole batch, bulk-undo only narrating one restored task, a leak-regex gap for
> `remove_tasks`, and an N+1 query in the recent-changes feed). **Item 8's live 10-op
> protocol has now been run against all three models** (see §Results) — it caught and fixed
> two more real bugs (the claim-check classifier was completely non-functional due to a
> `max_tokens` too small for its reasoning model's chain-of-thought; a recurring-task
> duplicate-row regression under a real-world timing condition item 3's original fix didn't
> cover), and surfaced one new, unaddressed, 100%-reproducible false-claim pattern (checklist
> item completion by name) that needs a follow-up pass. All eight original failure classes
> were observed live this day across gpt-4o-mini, DeepSeek v4-flash, and Sonnet 5 (see
> `docs/openai-provider-swap.md` §6 for the raw provider-test results). Two external
> reviews converged on the same diagnosis; this plan is the merged, codebase-specific
> version.

---

## 0. The principle this plan implements

Every data-layer defense held during testing — Zod validation, titleHint verification,
idempotency, soft deletes, two-phase removal. **Every observed failure lived in the gap
between what the model said and what it did.** The fix direction, in one line:

> The model interprets. The server resolves. The executor mutates. Receipts establish
> facts. The model may only decorate those facts.

The failure classes (full evidence write-up lives in the session that produced this doc;
summary):

| # | Class | Seen on |
|---|---|---|
| 1 | Announced an action ("let me do that", "sent the request"), called no tool | 4o-mini ×2, DeepSeek ×2 |
| 2 | Claimed a write happened ("logged it"), called no tool | DeepSeek |
| 3 | Failed tool call narrated as success ("already been removed") | 4o-mini |
| 4 | UUID corrupted in tool args (dropped char in a digit run, 3× identical) | 4o-mini |
| 5 | Raw tool-call markup (`<｜｜DSML｜｜...>`) emitted as chat text | DeepSeek |
| 6 | Recurring template + today's instance treated as two tasks (dup cards, dup counts) | DeepSeek |
| 7 | Stale "pending confirmation" narrative overriding the live task list | Sonnet 5 |
| 8 | Bulk removal (6 tool calls in one turn) hit the output-token cap mid-turn | Sonnet 5 |

Root cause of #7, verified in code: the confirm-tap goes through `DELETE /tasks/:id`
(`routes/tasks.ts`), which writes **nothing** to the conversation, and
`historyContentFor` (`routes/messages.ts`) strips all task-card messages to empty
strings — so the model's history contains "removal pending" with no resolution, ever,
while the live list silently disagrees.

---

## Work items, in implementation order

Each item is independently commit-able. Typecheck (`npx tsc --noEmit` in `server/`)
after each. Items 1–4 are the core; 5–7 build on them.

### Item 1 — Unambiguous failure semantics in tool results

**Problem (class 3):** `"That task no longer exists — nothing to remove."` reads like a
success condition. The model told the user the task "has already been removed" while it
sat in the DB, open.

**Change:** in `server/src/lib/ai/actions.ts`, wrap **every** `ok: false` path (Zod
failures, titleHint mismatches, `TaskActionError`s, the remove_task not-found branch) at
the `executeAiToolCall` boundary so the text fed back to the model always leads with an
explicit outcome statement:

```
ACTION NOT COMPLETED — nothing was changed. <original message>
Tell the user you couldn't do this; do not describe it as done or already done.
```

One wrapper at the boundary, not per-string edits (the strings also flow into
`toolCallLog`, which is log-only — safe). The remove_task not-found message additionally
gets rewritten to remove the ambiguity at the source: *"no removal happened — that task
ref doesn't match any current task; it may already be gone or the ref may be wrong.
Check the task list."*

**Acceptance:** re-run the class-3 scenario (remove with a bad ref, then "go ahead") —
the model must not claim prior removal.

### Item 2 — Turn-scoped aliases replace raw UUIDs in the model interface

**Problem (class 4):** a UUID is ~20 tokens of high-entropy noise; 4o-mini dropped a
character inside a `5995` digit run identically three times. Models should never copy
database identifiers.

**Design:**

- `buildTaskContext` (`lib/ai/task-context.ts`) changes signature:
  `Promise<string>` → `Promise<{ text: string; refs: TurnRefs }>` where

  ```ts
  type TurnRef =
    | { kind: 'task'; taskId: string; isRecurringSeries: boolean; instanceId?: string; templateId?: string }
    | { kind: 'checklist_item'; taskId: string; itemId: string };
  type TurnRefs = Map<string, TurnRef>; // key: "T1", "T2", "T2.1", ...
  ```

  Aliases are assigned in render order (`T1`, `T2`, …; checklist items `T2.1`, `T2.2` —
  replacing the full item UUIDs currently rendered in `[items: ...]`).
- `routes/messages.ts` passes `refs` into the stream call; `ChatActionContext`
  (`providers/shared.ts`) gains `refs: TurnRefs`; providers pass it to
  `executeAiToolCall`, which gains a `refs` parameter.
- `lib/ai/tools.ts`: every tool schema swaps `taskId` → `taskRef` (description: "the
  task's ref exactly as shown in the task list, e.g. T2") and `itemIds` → `itemRefs`.
  Zod side: `taskRef: z.string().regex(/^T\d+$/)`, `itemRefs: z.array(z.string().regex(/^T\d+\.\d+$/))`.
  `titleHint` stays — it is now the *secondary* check.
- `actions.ts` resolves refs → UUIDs before anything else. Unknown ref →
  `ACTION NOT COMPLETED — T7 isn't in the current task list.` (item 1's wrapper applies).
- System prompt (`system-prompt.ts`): update the "task list" bullet to reference refs,
  not ids.

**Deliberate non-adoption — dynamic enums.** Both reviews suggested making `taskRef` a
per-turn enum in the tool schema. Rejected: tool definitions render at the very front of
the prompt on every provider, so per-turn schemas would invalidate the entire prefix
cache every turn (tools → system → messages). The regex + server-side resolution +
titleHint stack catches the same errors without the cache cost. Revisit only if wrong-ref
selection shows up in testing.

**Acceptance:** all 10-op protocol operations pass with refs; a hand-forced bad ref
returns the not-completed error; no UUID appears anywhere in `buildTaskContext` output.

### Item 3 — One logical row per recurring task + `scope` parameter

**Problem (class 6):** the model sees the recurring template and today's materialized
instance as two peer rows and acts on both. Today's prompt-annotation patch works but
teaches the model our storage internals — fragile across model swaps.

**Design (calendar-app pattern):**

- `buildTaskContext` renders **one row per logical task**:
  - If a template has a materialized instance for today → render the instance's live
    state (count, status), annotated `· repeats daily at 10:00`. The alias resolves to
    `{ taskId: instanceId, isRecurringSeries: true, templateId }`.
  - If no instance today (e.g. weekly task off-day) → render the template, annotated
    `· repeats weekly on mo · next: Jul 14`. Alias resolves to the template.
  - Template rows with a today-instance are **never** rendered separately.
- `remove_task` gains `scope: 'occurrence' | 'series'` (optional, **default `'series'`**
  — matches the product decision: "delete the task" on a recurring task means the whole
  series, and the cascade in `executor.ts` already removes today's occurrence with it).
  `scope: 'occurrence'` targets just the instance ("skip today").
- `edit_task` on a recurring ref routes to the **template** (schedule/title/target edits
  are series-level; `executor.ts` already propagates reminder changes to open instances).
- `complete_task` / `progress_task` on a recurring ref route to the **instance**; if the
  alias resolved to a template (off-day), return
  `ACTION NOT COMPLETED — "X" isn't due today (next: Jul 14).`
- Server routing lives in `actions.ts` at ref-resolution time — the model never chooses
  template vs instance.
- Removal-pending summary for `scope: 'series'` should say so:
  `Tap to confirm removing "Drink water" — repeats daily, removes the whole series.`
- **Revert the July 11 prompt patch** (the "two rows" bullet in `system-prompt.ts` and
  the `today's occurrence of [...]` annotation in `task-context.ts`) — this item
  replaces both.

**Acceptance:** recurring task shows once in context; "remove all tasks" over a recurring
task yields one card; "skip today's water plants" removes only the instance; counts
questions count it once.

### Item 4 — Context moves to the tail: counts, task list, and a recent-changes feed

**Problem (class 7):** out-of-band mutations (confirm-taps, Tasks-tab actions) are
invisible to the model, and the live list sits positionally far from the newest tokens.
Bonus problem discovered during review: on OpenAI/DeepSeek the volatile dynamic block
currently sits **before** history as the second system message, so it busts the prefix
cache for the whole conversation every turn.

**Design:**

- Split `buildDynamicContext` into a stable-position part (nothing left, delete the
  second system block) and a **tail block** injected adjacent to the newest user message,
  containing, in order:
  1. Current date/time (existing).
  2. **Precomputed counts** — `Right now: 2 open, 3 done today.` (computed server-side in
     `buildTaskContext`; the model should never derive counts by scanning rows).
  3. The task list (item 2/3 format).
  4. **Recent changes feed** — records rows since the previous user message with
     `source: 'tasks_ui'`, rendered as short prose:
     `Since your last message, in the app: "Water plants" was removed (you confirmed it); "Pushups" was marked done.`
     Cap at ~5 entries. This gives the "pending confirmation" narrative its ending.
  5. One fixed line: `Any task mentioned earlier in this conversation but absent from
     the list above no longer exists.`
- Provider mechanics:
  - **OpenAI/DeepSeek:** insert as a `role: 'system'` message *after* history, before the
    latest user message (both APIs accept mid-array system messages). History becomes an
    append-only stable prefix → prefix caching now covers it.
  - **Anthropic:** system array can't sit after messages; prepend the block as a separate
    text block inside the newest user message (the `<system-reminder>` idiom). Move the
    `cache_control` breakpoint to the last history message so history caches too.
- `routes/messages.ts` computes the feed: previous user message's `createdAt` is already
  in the fetched history; query `records` where `occurredAt > that && source = 'tasks_ui'`.

**Acceptance:** regression test for class 7 — create task via chat, request removal,
confirm via `DELETE /tasks/:id` (simulating the tap), then ask "how many tasks are
left?" — answer must reflect the removal and not mention a pending confirmation.

### Item 5 — Bulk removal primitive + single confirm card

**Problem (class 8 + UX):** "remove all tasks" = N `remove_task` calls, N cards, N taps,
and enough output tokens to hit the cap (`MAX_OUTPUT_TOKENS` is 1024).

**Design:**

- New tool `remove_tasks`: `{ items: [{ taskRef, titleHint }], scope?: 'occurrence' | 'series' }`
  (scope applies per the item-3 rules to any recurring refs; default series). Update
  `remove_task`'s description to say "for a single task; use remove_tasks for several."
- `actions.ts` validates every item (refs + hints) **before** returning; any invalid item
  fails the whole call with a not-completed error naming the bad ref — no partial
  pending state.
- Result is one pending confirmation: `recordKind: 'task_bulk_removal_pending'`, summary
  `Tap to confirm removing all 4 tasks: Meditate, Drink water (daily), Water plants,
  Pick up sister.` The `action` SSE event's `meta` carries `tasks: TaskRow[]`.
- Server execution path: new `POST /tasks/bulk-remove { taskIds: string[] }` route →
  new `removeTasks` in `executor.ts`: single transaction, per-task cascade logic reused,
  **one** records row `kind: 'task_removed'` with
  `payload: { bulk: true, tasks: [{ taskId, title, cascadedInstanceIds }] }` so one
  `undo_last_action` restores everything. Extend the `task_removed` undo case in
  `undoLastAction` to handle the bulk payload shape.
- **App:** locate the removal-pending card (grep `task_removal_pending` under `src/`),
  add a bulk variant listing titles with one Confirm/Cancel pair; Confirm calls the bulk
  route; invalidate the tasks query as the single-card path does.
- Raise `MAX_OUTPUT_TOKENS` 1024 → 1536 (aliases shrink tool-call payloads; this is
  headroom, not the fix).
- **Deferred:** auto-continue-on-length. With aliases + the bulk tool, class 8's cause is
  gone; a mid-JSON length cut can't be resumed cleanly on OpenAI-compat streams anyway.
  Revisit only if `finish_reason: 'length'` shows up in logs again.

**Acceptance:** "remove all tasks" over 4+ tasks incl. a recurring one → exactly one
tool call, one card, one tap removes all, one undo restores all.

### Item 6 — DSML leak: retry instead of swallow

**Problem (class 5):** today's filter suppresses the leaked markup bubble but silently
drops the action the model was attempting.

**Design (in `providers/deepseek.ts`):**

- On leak detection (`isToolCallMarkupLeak`):
  - **If nothing has been emitted yet this iteration** (no segments, no executed tool
    calls): abort the stream, decrement the iteration counter, retry once (guard flag —
    max one retry per turn). Do not attempt to parse/execute the leaked markup (observed
    leak used wrong param names).
  - **Else** (segments already streamed, as in the observed case): discard the leaked
    text as today, but instead of silence append an honest segment:
    `Hm, that last step glitched on my end — it may not have gone through. Mind asking again?`
- Keep the existing `toolCallLog` entry + warn log either way (it's how we count these).

**Acceptance:** unit-level — feed a synthetic leaked chunk sequence through the provider
(extract the segment loop into a testable function, or verify by log inspection during
protocol runs) and confirm retry/announce behavior; no DSML text ever reaches an SSE
event.

### Item 7 — Claim-check classifier on zero-tool-call turns

**Problem (classes 1–2):** the `maybeCorrectFakeAction` regex catches past-tense
confirmations but not promises ("let me do that", "sent the request"), and no regex will
keep up with phrasing variety.

**Design:**

- New helper in `lib/ai/` (e.g. `claim-check.ts`): `didClaimAction(segments: string[]):
  Promise<boolean>` — one cheap, non-streamed model call:
  system: *"Answer with exactly YES or NO. Does this assistant reply claim, promise, or
  imply that a task action (create/complete/log/edit/remove/postpone) was performed or
  is being performed right now?"* + the joined segments. Model: configurable
  `CLAIM_CHECK_MODEL` env (default `deepseek-v4-flash` for cost; the call is ~100 tokens).
  Timeout 2s; on timeout/error, fall back to the existing regex result.
- Wire into `createTurnState`: `maybeCorrectFakeAction` becomes async; it runs **only
  when `toolCallLog.length === 0`** (pure-chat turns are the common case for this branch,
  so the extra call happens on a minority of turns and adds latency only at stream end,
  after all bubbles are out). Regex still runs first (free); classifier confirms or
  catches what regex missed. On YES → emit the existing corrective segment.
- Keep the corrective segment as an **append**, not a retraction — text already streamed
  can't be unshown. True pre-display suppression requires the two-phase act/narrate
  split, which is **explicitly deferred** (see §Deferred) pending item-8 measurements.
- Log every classifier verdict (`claim_check: yes/no, matched_regex: bool`) so item 8
  produces a measured false-claim rate per model.

**Acceptance:** replay the four observed class-1/2 phrasings against the classifier —
all four must classify YES; a handful of normal chat replies must classify NO.

---

## Item 8 — Verification: the 10-op protocol, three models

After items 1–7 land, run the reliability protocol against **all three**:

| Model | Config | Baseline (old architecture) |
|---|---|---|
| `deepseek-v4-flash` | `AI_PROVIDER=deepseek` | 1 miss / 10 ops (July 11) |
| `claude-haiku-4-5` | `AI_PROVIDER=anthropic`, `ANTHROPIC_MODEL=claude-haiku-4-5` | 4/10 hallucinated (pre-swap session) |
| `gpt-4o-mini` | `AI_PROVIDER=openai` | failed hard (UUID corruption + false claims, July 11) |

Method (extends `docs/openai-provider-swap.md` §6 — same ground rules: ground truth is
the `chat turn finished` log + direct DB reads, natural task titles, isolated test
account, clean up afterwards):

1. **Core 10:** 3 creates (simple / checklist / counter-with-target), 1 edit (change a
   target), complete + un-complete, check off a checklist item by name, 1 postpone,
   2 deletes (one via the new confirm flow).
2. **New coverage, one pass each:**
   - recurring create → verify **one** context row; progress it; "skip today"
     (occurrence scope); "stop it entirely" (series scope, one card)
   - `remove_tasks` bulk over ≥4 tasks → one card; confirm via bulk route; undo restores
   - class-7 regression: request removal → confirm via `DELETE /tasks/:id` directly →
     ask "how many tasks left?"
   - count questions with ≥1 recurring task present
   - two identical tasks → disambiguation question expected
3. **Score:** hallucination rate (claims vs `toolCalls`), classifier catch rate
   (item 7 logs), alias resolution failures, wrong-scope actions. Record per-model
   results **in this file** under §Results.
4. Decision input, not a gate: per the review consensus — if a cheap model still fails
   loudly, it stays a stress-test harness, not the production model. Sonnet 5 remains
   the reliability reference (0/10 baseline).

### Results (July 11, 2026 run)

Run against isolated dev-token accounts, `AI_PROVIDER` swapped between runs (Haiku via
`ANTHROPIC_MODEL=claude-haiku-4-5` override), real chat turns over HTTP, ground truth from
the `chat turn finished` / `claim-check verdict` log lines and direct `records`/`tasks`
reads. **Two real bugs were found and fixed during this run** (see below) — the classifier
numbers reflect its state *before* the fix, since re-running all three models after was out
of scope for this pass.

| Model | Core 10 | New coverage | Classifier catches | Notes |
|---|---|---|---|---|
| deepseek-v4-flash | 7/10 clean, 1 hallucination (op 7), 2 blocked by an earlier no-op | recurring create never happened (blocked b/c/d); bulk-remove+undo passed cleanly; class-7 regression passed; count question correct; disambiguation correct (but leaked raw "T1"/"T2" refs into the reply text) | 0/1 (classifier was non-functional — see below) | Also: created "Call mom" with the correct UTC dueAt but then told the user it saved the wrong time (11am, not 6pm) — a false claim about its own successful action, not just a missed one |
| claude-haiku-4-5 | 7/10 clean, 2 hallucinations (op 7, op 10), 1 pass | recurring create hit the class-6 duplicate-row bug (found + fixed, see below); "skip today" hallucinated (op c); "stop series" passed with correct scope wording; bulk-remove asked a clarifying question instead of calling the tool (inconclusive); class-7 regression passed; count question correct; disambiguation prevented the duplicate proactively | 0/2 (non-functional) | Best of the three on core-10 accuracy when it did act; also the only model to hit the recurring-instance bug, because it was the only one that actually created a recurring task before item 3's real-world edge case (time-of-day already passed) got exercised |
| gpt-4o-mini | 7/10 clean, 1 hallucination (op 7), 2 deferred to a later turn | recurring create never happened (asked for liters, blocked b/c/d); bulk-remove asked a clarifying question instead of calling the tool; class-7 regression passed (once actually confirmed); count question correct; disambiguation prevented the duplicate proactively | 0/2 (non-functional) | Showed a "promise now, act next turn" pattern twice (create, remove) — said it would act, then only actually called the tool once prompted again |

**Two real bugs found and fixed this run:**

1. **Claim-check classifier was completely non-functional.** `CLASSIFIER_MAX_TOKENS` was
   set to 4. `deepseek-v4-flash` (the classifier's default model) always emits chain-of-
   thought in a separate `reasoning_content` field before the actual YES/NO in `content` —
   with a 4-token budget, every single call was truncated (`finish_reason: "length"`)
   before `content` was ever written, silently returning `''` → `false` on every call,
   every time, for the entire time item 7 has existed. Confirmed live: 5 separate
   classifier calls across the three model runs, all with clearly hallucinated source
   text, all returned `claim_check: "no"`. Fixed: `max_tokens` → 800, timeout → 8000ms,
   and the prompt now explicitly wraps the text as `Assistant's message: """..."""` (one
   of the three test payloads was otherwise misread as a user message, not the reply being
   judged). Re-verified in isolation post-fix against the exact failing strings from this
   run — all now classify correctly in ~1.6–1.9s. **Not yet re-verified against a live
   three-model re-run** — recommend re-running at least the core-10 protocol once to
   confirm the live catch rate actually improves, since the classifier's own chain-of-
   thought showed real inconsistency on pure future-tense promises ("I'll remove the
   pushups tracker... just a moment!") flip-flopping between YES and NO across identical
   repeated calls (temperature isn't 0) — completed-action claims ("passport is checked
   off") classified as YES reliably, but promise-only phrasing is a live open question the
   doc's own classifier prompt wording doesn't fully resolve.
2. **Recurring-task duplicate-row regression** in `task-context.ts`, caught live on
   claude-haiku-4-5's run: `materializeRecurringInstances` bumps a template's very first
   occurrence to *tomorrow* when today's clock time has already passed (existing, correct
   behavior — a task shouldn't be born overdue) — but the merge logic only matched an
   instance dated *exactly* today, so that tomorrow-dated instance rendered as a second,
   standalone row instead of folding into the template. The model itself narrated this:
   *"Looks like we ended up with a duplicate when I set up the repeating one."* — exactly
   the class-6 failure item 3 was built to prevent, just in a real-world timing condition
   the original fix didn't cover. Fixed: the merge now matches the nearest instance dated
   today-or-later, not only exactly-today; instances dated *before* today are still left
   standalone (missed-task recovery still needs them individually addressable). Verified
   directly against the affected account's live DB state post-fix — renders as one row.

**One new, unaddressed pattern found — 3/3 models, same op:** "I packed my passport" (a
checklist item completion by name, no ref/tool-name in the user's own wording) produced a
confident, specific false claim ("Got it, passport is checked off") with **zero tool
calls** on every single model tested. This is the single most actionable finding from this
run — a 100% reproduction rate across providers on one exact scenario, all currently
undetected (compounded by the classifier bug above, but the regex missed it too, since
none of the observed phrasings used a quoted title next to a listed verb). Recommend
prioritizing this: either a system-prompt callout specifically for checklist-item
completions, or re-running this one scenario post-classifier-fix before concluding item 7
covers it.

**Non-hallucination behavior variance observed** (not failures, but worth noting): all
three models were noticeably reluctant to call `create_task` for the recurring-water
scenario, asking a clarifying question instead even though "every day at 10am" reads as
unambiguous; two of three treated `remove_tasks` the same way, asking in prose rather than
emitting the tool call and letting the pending card be the confirmation. gpt-4o-mini
specifically showed a "promise now, act on the next turn" pattern twice. None of these are
data-integrity failures (no false claims were made in any of these cases — the models
correctly did *not* act), but they add conversational friction the doc's failure-class
taxonomy doesn't currently capture.

### Re-test (same day, later session): classifier fix verified live + 3 more bugs found

After the run above, the classifier's `max_tokens: 4` bug (§ above) was fixed, plus three
more real bugs surfaced through live app use in between: a recurring-instance duplicate-row
edge case (materializing a template's first occurrence for *tomorrow*, not merged into the
template row), a missing `edit_task`-over-remove+recreate system-prompt nudge, and —
important for this re-test — **`undoLastAction` never wrote a fresh `records` row**, so an
undo was invisible to the item-4 recent-changes feed; a live app session hit this directly
(bulk-removed several tasks, undid it, then asked about one by name — model insisted it was
"already gone," DB proved otherwise). Fixed: `undoLastAction` now inserts a `task_undo`
record tagged with the correct source, described by kind (`"X" was restored (you undid
removing it)`, etc.) — **verified live**: same repro (bulk-remove → undo → ask about one by
name) now gets *"yeah, it's still there... you removed them but then undid it."*

Re-ran the full 10-op protocol against all three models post-fix:

| Model | This run | Classifier verdict |
|---|---|---|
| deepseek-v4-flash | Cleanest run yet — 0 hallucinations. Op 7 (checklist item by name) succeeded this time (no tool-call needed to suppress, nothing to catch). Same over-cautious pattern as before on counter/recurring creation (asks instead of acting — safe, just friction), so recurring-dedup still untested on this model. Bulk-remove+undo, class-7 regression, count, disambiguation all clean. | n/a — no false claims occurred to test it against |
| claude-haiku-4-5 | Recurring create/progress/scope-aware removal all correct. New finding: on the complete→un-complete pair, the model *correctly* reopened the task via `complete_task`, then misread its own correct result as a mistake and called `undo_last_action` on top of it — landing back on "done," the opposite of what the user asked. Not a hallucination (both calls were real and logged), a self-second-guessing error. Also: narration accuracy was inconsistent between two structurally-identical `scope: occurrence` vs `scope: series` removals — one correctly said "tap to confirm," the sibling said "Skipped" (past tense) for an equally-pending card. | n/a for the above (both had real tool calls, so out of scope for the classifier by design — see finding below) |
| gpt-4o-mini | Noticeably *more* zero-tool-call turns this run than the pre-fix baseline (4 vs 1) — plausibly the system prompt is longer now (several nudges added live this session) and a weaker model has more rules competing for attention. **All 4 were real hallucinations, and the classifier caught all 4** (`claim_check: "yes"` each time, `matched_regex: false` — the regex alone would have missed every one). New failure mode found: asked to complete a plain, non-recurring "Check email" task, the model fabricated a rule ("I can only mark it done if due today") and refused — not a completion claim, so the classifier correctly stays silent, but it's a distinct failure: **inventing a false system constraint to justify not acting**, outside every current safety net. One more miss: a fabricated "I've got it ready to be removed... tap the button" with zero tool calls (no card ever created) went uncaught — borderline under the classifier's own YES/NO split and worth a follow-up prompt iteration. | 4/4 real hallucinations caught, 0 false positives observed this run — a first for gpt-4o-mini |

**Bottom line for the cheap-vs-reliable question:** the classifier fix is a clear, measured
win — it went from a total no-op (0/5 across the pre-fix runs, silently returning `false`
every time) to catching every genuine completion-claim hallucination thrown at it this
round, including on the model (gpt-4o-mini) that produced the most of them. What it
*doesn't* cover — and no current safety net does — is a model fabricating a false reason
for **not** acting, which only showed up on gpt-4o-mini. Combined with this run showing
gpt-4o-mini as the most failure-prone of the three (both in raw hallucination count and in
inventing the fabricated-refusal pattern), **deepseek-v4-flash looks like the strongest
cheap option right now** — cleanest run, already the cheapest of the three per-token, and
Haiku's action-quality remains the benchmark if cost allows for it. Small sample sizes
throughout (one run per model per round) — this is directional, not conclusive.

### DeepSeek deep-dive: extended protocol + case tests (same day, deepseek chosen as default)

After switching `AI_PROVIDER` to `deepseek` as the standing default, ran a longer, harder
pass beyond the core 10 ops: duration start/stop, counter add/subtract, weekly and
every-N-days recurrence, off-day action attempts (complete/progress on a not-due-today
recurring ref), a type-mismatch request (progress_task on a plain completion task), a
fully nonexistent task reference, a compound two-target request mixing an off-day skip
with a real deletion, double-undo, and three turns of pure casual chat interspersed to
check the classifier doesn't fire on ordinary conversation.

**2 hallucinations, both real, both caught:**
- `create_task` (pushups counter): "On it — pushups counter, target 50, no due date..."
  with zero tool calls — fabricated specific parameters for a task that didn't exist yet.
  `claim_check: "yes"`, corrected. The model then **self-recovered one turn later**
  unprompted: reading the live task list on the next request, it said *"I actually never
  got the first one saved... let me just set it up fresh"* and created it correctly — the
  live-task-list-as-ground-truth design (item 3/4) working exactly as intended, without
  needing the user to notice or intervene.
- `progress_task` (stop timer): "20 minutes in... Clock's stopped" with zero tool calls —
  the timer was still running (`runningSince` unchanged in the DB). `claim_check: "yes"`,
  corrected.

**Zero false positives across every other zero-tool-call turn this run** (~9 total,
including 3 turns of pure casual chat, an off-day refusal, a type-mismatch clarification,
and a nonexistent-task correction) — `claim_check: "no"` every time, verified against the
log.

**Every case test passed clean, no hallucinations:**
- Off-day recurring refusals (complete + progress) both correctly declined with an
  accurate reason, no false completion.
- Type-mismatch handling: asked to "log progress" on a plain completion-type task, the
  model correctly recognized there's no progress action for that type and offered
  `complete_task` instead, rather than inventing one.
- Nonexistent task reference ("Learn Spanish"): correctly refused, offered a real
  alternative, zero tool calls.
- Compound two-part request (skip an off-day recurring task *and* delete an unrelated
  real task, one message): correctly split the request — declined the impossible skip
  with an accurate reason, executed only the valid deletion.
- Double-undo: first call correctly reverted the most recent real action; second call hit
  the just-inserted `task_undo` record itself and failed gracefully
  (`nothing_to_undo: cannot undo record kind task_undo`) — no crash, no undefined
  behavior.
- Sensitive-topic baseline (low mood, unmotivated, not a stated crisis): warm,
  present, no pivot to problem-solving, no hotline over-escalation for a non-crisis
  statement — matches CLAUDE.md's safety golden rules.

**Verdict:** with the classifier fix in place, deepseek-v4-flash's raw hallucination rate
in this round (2 fabricated claims across ~30 turns) was fully caught by the safety net,
and its handling of every harder edge case tested (recurrence variety, type mismatches,
off-day logic, compound requests, undo edge cases, sensitive topics) was clean. This is
the strongest single-run result of any model tested so far. Recommend it as the standing
default; the honest caveat is still sample size — one extended run, not a statistical
guarantee — so keep an eye on real usage, especially around counter/duration creation
(the two hallucination sites found) since that's the one soft spot this round surfaced.

### Upgrade test: deepseek-v4-pro (July 12, 2026) — 2 real infra bugs found and fixed

Switched `DEEPSEEK_MODEL` to `deepseek-v4-pro` (the smarter/pricier DeepSeek tier — still
far cheaper than GPT-4o-mini or Haiku 4.5; see pricing comparison in the session that
prompted this) and ran a task-manipulation pass (create → edit → undo → postpone → undo,
plus a counter habit and a pending-removal). Found two genuine infrastructure bugs — not
model reliability issues — both now fixed:

1. **`undoLastAction` crashed reverting an edit or a postpone.** `records.payload` is
   jsonb; a `Date` written into it round-trips back as a plain ISO string on read, not a
   `Date` instance. The `task_edited` and `task_postponed` undo cases did a bare
   `as Date` **type cast** (compiles fine, does nothing at runtime) instead of actually
   reconstructing a `Date`, so Drizzle's timestamp column mapper threw
   `value.toISOString is not a function` deep inside the write — silently swallowed by
   the provider's catch-all (`"Something went wrong on my end"`), with the real error
   never logged. Fixed by reviving jsonb-sourced dates through `new Date(value)` before
   handing them back to Drizzle (`reviveDate()` in `executor.ts`), and by adding
   `logger.error` to all three providers' generic catch branches (they were swallowing
   *every* unexpected exception with no log line — a diagnostic gap independent of this
   specific bug). This bug was latent since item 11 (fresh-record-on-undo) shipped —
   never triggered before because prior testing hadn't undone an edit/postpone that
   carried a `dueAt` in its `prior` snapshot.
2. **Undo's tool-result summary didn't say what was restored.** `undo_last_action`'s
   summary was just `Undid the last change to "X".` — no concrete restored value. With
   nothing else to go on, the model narrated the restored state from its own memory of
   the conversation and got it wrong: after edit → undo → postpone → undo, it reported
   the task was "back to Monday the 20th at 10am" (the *pre-edit* state, two steps back)
   when the DB — and the correct answer — was "tomorrow at 3pm" (one step back, the true
   immediate-prior value). Fixed by having the summary state the actual restored due
   date (or status) via the existing `shortDueLabel` helper, so there's a fact to report
   instead of a memory to reconstruct. Re-verified clean after both fixes.

Neither bug is deepseek-v4-pro-specific — flash would hit the same crash and the same
narration gap under the same sequence; it simply hadn't been exercised by prior protocol
runs. Both fixes are provider-agnostic (executor.ts / actions.ts), so all three providers
benefit.

---

## Deferred (deliberately, with reasons)

- **Two-phase act/narrate split** (both reviews' endgame): structurally kills classes
  1–3 but doubles serialized calls on every turn and moves first-token latency behind a
  full non-streamed round trip. Build only if item 8 shows the classifier net leaves an
  unacceptable residual rate. If built: action turns only, narration phase fed
  exclusively by execution receipts.
- **Turn-mode classifier / deterministic query routing** (review 1, stages 1–2): the
  counts-in-context fix (item 4) covers the observed failure at ~zero cost; a
  misclassifying router is itself a new failure mode.
- **Dynamic per-turn enums in tool schemas:** prefix-cache cost (see item 2).
- **Auto-continue on `length`:** see item 5.
- **Removing the forced-`tool_choice: none` final pass** (review 1's #7): none of the
  eight observed failures traced to that path; it's the graceful close after the
  3-iteration budget. Keep.

## Lessons for future phases (Phase 4 Tools, Phase 5 Connected Loop)

These are the durable rules this incident set establishes — apply them from day one in
the Tools work rather than retrofitting:

1. **Models never see storage identifiers.** Tool entries, tool definitions, memories —
   all get turn-scoped refs. (Phase 4's `log_tool_entry` / `edit_tool` must launch with
   refs, not UUIDs.)
2. **Models never see storage *shape*.** One logical object per user-perceived thing;
   scope/routing parameters instead of exposing internal rows (template/instance was
   this lesson; Phase 4 tool-layout versions will rhyme with it).
3. **Every error string fed to a model states the outcome explicitly** ("nothing was
   changed") — models pattern-match failure text into success narratives.
4. **Every out-of-band mutation gets narrated into the next turn's context.** Silent
   state changes leave unresolved narratives the model will complete wrongly. (Phase 5's
   undo and cross-view updates: same requirement.)
5. **The live-state block goes at the context tail,** adjacent to the newest message —
   recency wins over instruction priority; it's also where prefix caching wants it.
6. **Precompute derived facts (counts, totals) server-side** — never make the model do
   arithmetic over context rows. (Phase 4 chart/summary answers: same rule.)
7. **Fixed templated shapes in model-visible history get copied verbatim eventually** —
   strip or paraphrase them (already learned in Phase 3, reaffirmed).
8. **Free-form claims of action are unreliable on cheap models; only server receipts
   establish facts.** Success language should trace to an executed record. The cheap
   enforcement is a claim-check on zero-call turns; the full enforcement is act/narrate
   separation.
9. **Keep the 10-op protocol as standing CI** — run it on any model/provider/prompt
   change that touches the action layer. A model that fails loudly against good guards
   is a useful stress harness and a bad production default.
10. **A "confirm before it happens" UI card is the only confirmation — never let the
    model also ask in chat text first.** Observed live, repeatedly: models asked "just
    confirm you want to delete X" in prose on top of the real tap-required card, forcing
    the user to confirm twice for one action. Phase 4's preview-before-save is the same
    shape (a card requiring a real tap) — the system prompt needs the same explicit rule
    from day one: call `create_tool`/`edit_tool` as soon as there's enough information;
    the preview card itself is the confirmation, not something to ask about first.
11. **Anything undoable must write a fresh record when it's undone, not just flip a
    flag.** `undoLastAction` originally only set the reverted record's `revertedAt` — no
    new row — so the recent-changes feed (lesson 4) had nothing to surface, and a model
    kept insisting a bulk-removed task was "already gone" after the user had undone it.
    Any Phase 4 undo path (a tool's prior version, a reverted entry) needs the same
    fresh-record treatment, not just a reverted-flag.
12. **Get chart/history date-bucketing timezone-consistent between client and server
    from day one.** A live bug this session: the app computed "overdue" using the
    device's local timezone while the server used the account's *stored* timezone —
    usually masked by an existing device/account sync, but a real gap right after travel
    or before that sync's first run. Phase 4's charts and "entries this week" views will
    bucket dates on both sides — thread the same account timezone through both rather
    than letting each side default to its own notion of "now."
13. **A narrow edit-UI must never silently overwrite a value it can't faithfully
    represent.** A live bug this session: an edit form offering only "today/tomorrow"
    due-date chips defaulted anything else (due in 3 days, overdue) to "today" when
    initializing from an existing task, then silently saved that guess back on any
    unrelated edit (changing just the title, say). Applies directly to Phase 4's
    tool-edit forms — if a field editor can't represent the tool's actual current value,
    it must not resave a guessed one; only send back what the user actually changed.
14. **Watch for models fabricating a false constraint to justify not acting** — a
    distinct failure class from claiming a false success. Live testing caught
    gpt-4o-mini inventing a nonexistent rule ("I can only mark it done if due today") to
    refuse a plain request instead of doing it or asking a real clarifying question. No
    current safety net catches this (it's not a completion claim). Worth watching for in
    Phase 4's `edit_tool`, where "can I change this field" has more surface for invented
    constraints than a task's fixed six fields do.
15. **Anything stored in a jsonb `payload` and later handed back to a typed Drizzle
    column needs to be actually reconstructed, not just type-asserted.** A `Date` (or
    any non-JSON-native type) written into jsonb comes back on read as its JSON form (an
    ISO string for `Date`) — a bare `as Date` cast satisfies the compiler but does
    nothing at runtime, and the first write using that value crashes deep in the driver
    with a confusing error. Applies directly to Phase 4: a tool version snapshot, an
    edit's "prior" restore payload, anything with a date/timestamp field stored for
    later undo. Revive with `new Date(value)` (or equivalent) at the read boundary, not a
    cast. Relatedly: **a provider's catch-all error handler must log the real exception**
    before yielding a generic user-facing message — all three providers here were
    swallowing every unexpected error silently, which is what made this bug invisible
    until deliberately instrumented.
16. **A tool-result summary that only announces "reverted"/"undone" without the concrete
    restored value forces the model to narrate from memory — and it will get the wrong
    step.** Observed live: undo after edit→undo→postpone→undo reported the state from
    two steps back instead of one, because the tool result never stated what the
    restored due date/status actually was. Any Phase 4 undo (tool field, layout version)
    needs its result summary to state the concrete restored value explicitly, the same
    way create/edit/postpone summaries already do — never leave "what changed" for the
    model to reconstruct unaided.
