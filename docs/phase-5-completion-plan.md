# Phase 5 completion — implementation plan

> **Pickup prompt for the implementing session:**
> _"Read `CLAUDE.md` and `docs/phase-5-completion-plan.md`. The design is settled with the
> user — implement the work items in order; ask only if something in the codebase
> contradicts this doc. Live-test as a user (§5) before calling it done."_
>
> Standing state: AI provider is **deepseek-v4-flash** (`server/.env`), act/narrate on
> (`AI_ACT_NARRATE` defaults on); dev server via `npm run dev` in `server/` (tsx watch,
> manual restart on `.env` changes), stdout captured at `/private/tmp/meroa-server.log`.
> Dev accounts: `npm run dev:token +1555555XXXX` (any number works; its OTP is printed to
> the server log as `[dev-sms]`). Typecheck `npx tsc --noEmit` in both `server/` and repo
> root after each item; `npm test` in `server/` (**123 passing** at time of writing);
> client gate is `npm run lint` + `npx expo export --platform ios` (~1832 modules).

## 0. What this is

The last work in Phase 5 (`docs/phases/phase-5-connected-loop.md`). All four goal types
(savings, habit, indirect, milestone) are shipped and the connected loop works. What
remains is **one genuinely unbuilt feature** (history-aware replies), **one audit**
(reconcile edge cases), and **one formal protocol run** that lets Phase 5 be ticked ☑.

After this, Phase 5 is done and the **provider decision** (flash is still only the test
provider) is the gate before Phase 6.

### Decisions defaulted in this plan (flag to the user only if one looks wrong)

- **"Confidence gating" (spec line 26) is already satisfied structurally — do NOT build a
  numeric confidence score.** The spec was written before the goals redesign. The DoD it
  actually asks for ("ambiguous reports prompt a short clarification instead of guessing;
  no fabricated values ever appear") is already enforced by three shipped mechanisms:
  fail-loud zod schemas with corrective messages (`createGoalParamsSchema`'s superRefine),
  the never-invent-a-number rules in every tool description + `SYSTEM_PROMPT`, and the
  tap-to-confirm cards (`remove_task`, `create_goal`, `advance_goal_stage`) where the tap
  IS the consent. A model-emitted confidence float would add a new lie surface (the model
  scoring its own certainty) with no user-visible benefit over what ships today. **§5's
  protocol run verifies the behavior; nothing new gets built for it.**
- **Spec language predates the redesign.** Where `phase-5-connected-loop.md` says "tool",
  read "goal" (Tools was scrapped — CLAUDE.md §9). Its DoD examples map to: "benched 165
  for 8" → indirect goal `log_goal_entry`; "spent $18 on lunch" → savings goal entry;
  "studied 50 minutes" → a duration task. Fix the stale wording in that file as part of
  item 6 rather than leaving it to confuse the next reader.
- **History facts are server-computed and quoted, never derived by the model** — the same
  lesson-6/16 rule every other number in this app follows (`goalImpactSuffix`,
  `goalHeadlineWithPace`). The model never counts anything itself.
- **A history fact is stated only when it's actually interesting.** The 1st completion of
  the week gets nothing ("that's your 1st workout this week" is noise); ≥2 gets the count.
  Silence is the default, not a filler sentence.

---

## 1. Item 1 — history-aware replies (the one real feature)

The DoD's named example is *"that's your 4th workout this week."* Indirect's
delta-vs-previous line (`goalHeadlineWithDelta`, `lib/ai/actions.ts`) was a down payment
on this; this item finishes it for **task completions**, which is where the spec's example
actually lives.

### 1.1 New pure module: `server/src/lib/ai/history.ts`

```ts
// Pure — no I/O, unit-tested directly (the established split: decide in a pure
// function, query in the caller). Week convention: Monday-start, computed in the
// account's timezone, same as every other date boundary in the app (ymdInTz).
export function weekStartYmd(todayYmd: string): string
export function isSameWeek(aYmd: string, bYmd: string): boolean

export type CompletionHistory = { countThisWeek: number; countThisMonth: number };

/**
 * The one sentence appended to a completion's summary, or null when there's
 * nothing interesting to say. Never states a count of 1 (noise). Never states a
 * streak — habit goals already do that via goalImpactSuffix, and two competing
 * counts in one sentence reads like a dashboard, not a friend.
 */
export function describeCompletionHistory(h: CompletionHistory): string | null
```

Copy shape: `That's your 4th time this week.` / `That's your 3rd this week (7th this
month).` Keep it to ONE short clause — this gets concatenated onto an already-long
summary and the narrate pass has to work it into a text message.

### 1.2 The query: `buildTaskCompletionHistory` (same file, I/O half)

```ts
export async function buildTaskCompletionHistory(
  userId: string, timezone: string | null, task: TaskRow,
): Promise<CompletionHistory | null>
```

- **Only for a recurring series** — a one-off task has no history to count (return null).
  Resolve the series from `task.templateId ?? task.id`, exactly like `editTarget` does.
- Count **done instances of that template** whose `occurrenceDate` falls in the current
  week / month in the account's tz. `occurrenceDate` (the due day) is the right key, not
  `records.occurredAt` — "4th workout this week" means four workout *days*, not four taps.
- Exclude soft-deleted rows (`isNull(tasks.deletedAt)`), same as everywhere else.

### 1.3 Wire it in — `lib/ai/actions.ts`

- New `taskHistorySuffix(userId, timezone, priorStatus, after)`, sitting directly beside
  `goalImpactSuffix` and gated the same way: **only on `becameDone`** (never on a reopen —
  "that's your 3rd this week" after un-completing something is nonsense).
- Append it in the **`complete_task`** and **`progress_task`** cases, after `impact`:
  `summary: \`${summarizeComplete(task)}${impact}${history}\``.
- Order matters: the goal fact first (it's the connected-loop payload), the history clause
  last (it's color).

### 1.4 Prompt — `lib/ai/system-prompt.ts`

One line in `SYSTEM_PROMPT`'s "Taking action" section, no more:

> When a tool result hands you a history fact ("that's your 4th time this week"), work it
> into your reply naturally in your own words — it's already computed from real records,
> so quote it, never recount or recompute it yourself, and never invent one when the
> result didn't give you one.

`ACTION_SYSTEM_PROMPT` needs **no change** (the action pass doesn't narrate).

### 1.5 Tests — `server/src/lib/ai/history.test.ts` (new)

- `weekStartYmd` across a Sunday→Monday boundary and a month boundary.
- `describeCompletionHistory`: returns null at count 1; states the count at ≥2; ordinal
  wording is right at 2nd/3rd/4th/11th/21st (the classic ordinal-suffix trap).
- No count is ever stated for a non-recurring task (assert `buildTaskCompletionHistory`
  returns null for `recurrence: null` — extract the recurring-vs-not decision as a pure
  predicate if that's the only way to test it without a DB).

---

## 2. Item 2 — reconcile edge cases (audit, not new code)

Spec line 29 lists four. Each is believed covered; this item is to **prove it with a test
or a live turn, and only write code where a gap is real.** Do not refactor working code.

| Edge case | Believed covered by | What to do |
| --- | --- | --- |
| A completion with no linked goal | `goalImpactSuffix` returns `''` when `!after.goalId` | Assert with a live turn; no test needed if the path is a one-line guard |
| A goal entry with no matching task | `log_goal_entry` never requires a task | Live turn ("log $40 birthday money") — already exercised, confirm |
| Ambiguous which goal | `resolveGoalRef` + `verifyNameHint` reject a wrong/invented ref | Live turn with two similarly-named goals — **most likely to surface a real gap; do this one carefully** |
| Multiple candidate tasks | `titleMatches`' lenient matching + the "only offer options actually in the list" prompt rule | Live turn with two tasks sharing a word |

Anything that fails becomes a fix + a regression test, logged in the ledger.

---

## 3. Item 3 — the formal DoD protocol run

The §4-style acceptance run, but scoped to Phase 5's DoD rather than the savings goal.
**Fresh dev-token account, real DB inspected between steps, deepseek-v4-flash, act/narrate
on.** Every step is a real chat turn or a real tap — never a unit test standing in for one.

1. **Single write, many views.** Create a savings goal + its recurring "Save $5" task via
   chat → Create tap. Complete today's instance **in the Tasks tab** → verify in the DB:
   exactly ONE `records` row, the `goal_entries` row references *that same* record id (not
   a copy). Chat, Tasks tab, and Goals tab all show the change.
2. **Free-text report → correct task AND goal.** "saved my $5 today" → `complete_task` (not
   a second `log_goal_entry`), goal total +$5 exactly once.
3. **No double-count.** Un-complete → total drops; re-complete → +$5 once.
4. **Never invent.** "I want to save for a laptop" (no amount) → asks, does not guess.
   "log some money to savings" (no amount) → asks. Zero fabricated numbers anywhere.
5. **Ambiguity → clarification.** Two goals with similar names; "log $20 to my savings" →
   asks which, does not pick one.
6. **Undo everywhere.** "undo that" after a completion → task reopens, goal entry gone,
   total restored, and the next turn's narration reflects it.
7. **History-aware reply (item 1).** Complete a recurring task 4 times across 4 days
   (backdate via `occurrenceDate` or run over the real week) → the 4th completion's reply
   states "4th this week". Verify the count is server-computed (the log's tool-result
   summary carries it) and not model arithmetic.
8. **Hallucination probe.** 5 varied goal-creation phrasings → zero false "I created/showed
   a card" claims with zero tool calls (check `claim-check verdict` lines in the log).
9. **Regression.** All four goal types create→act→undo; task core (create/complete/edit/
   postpone/remove/bulk-remove/undo); `npm test`, both typechecks, `npm run lint`,
   `npx expo export --platform ios`.

Every failure gets root-caused and fixed before Phase 5 is ticked — this run is the gate,
not a formality. Both live bugs found this month (the `.strict()` intersection bug, the
pending-success self-correction gap) were invisible to `tsc` and the unit suite and only
surfaced by driving real turns; expect this run to find at least one more.

---

## 4. Item 4 — docs + the tick

- `docs/goals-redesign-plan.md`: new ledger section for this session (what shipped, what
  the protocol run found, final test count) — same shape as the existing ones.
- `docs/phases/phase-5-connected-loop.md`: tick every task checkbox, set **Status: ☑**, and
  fix the stale "tool" wording (§0's second defaulted decision) so the file describes what
  actually shipped.
- `CLAUDE.md` §9: Phase 5 row → **☑**, and drop the "◐ (partial)" note.
- If the provider decision is still open (it is), leave the Phase 6 row untouched — that
  decision is §6's business, not this plan's.

---

## 5. Live as-a-user pass

§3 **is** the live pass — it's the DoD protocol run, on a fresh dev-token account with the
real DB checked between steps. Don't call this plan done on a green `npm test`; a schema or
prompt change needs live chat turns (the `create_task` `.strict()` lesson in
`docs/goals-redesign-plan.md`).

## 6. After this ships (not this session's scope)

**Phase 5 is done.** The next gate is the **provider decision**: deepseek-v4-flash is only
the test provider, chosen for cost during development. Its narration wobble is documented
and real (it hedges, occasionally claims a card didn't send when it did). Before Phase 6,
run the same protocol against at least one Anthropic model and pick the production
provider on measured false-claim rate + narration quality, not vibes. Then Phase 6
(personalization, memory, trust).
