# Chat architecture — how a turn works, and why

> **Read this before changing anything in `server/src/lib/ai/`.**
>
> This describes the reply pipeline as it stands after the July 13 2026 rebuild.
> Most of it looks over-engineered until you know what it's for. Every layer here
> exists because something specific went wrong in production, and the comment in
> the code names the incident. This file is the map; the code has the detail.

---

## 0. The one rule

**A prompt is a suggestion with a good success rate. A guarantee has to live in code.**

This is not a stylistic preference. It's the measured result of a full day of work:

| change | kind | outcome |
| --- | --- | --- |
| "own it plainly, say what YOU just did" | prompt | caused a tool-call leak into the chat |
| "never say *already*" (anti-concealment) | prompt | 61 pedantic correction bubbles |
| "undo means the last *real* change" | prompt | still silently reverted data ~5% of the time |
| "don't recap their tasks" | prompt | *(never shipped — see §5)* |
| filter leaks out of history | structural | held |
| `no_action` carries a reason | structural | held |
| deterministic key on the fast-path gate | structural | held |
| **stop narrating after an action** | structural | **deleted an entire bug class** |
| refuse undo in the executor | structural | silent writes → 0 |

**Every prompt rule added created a new failure somewhere else. Every structural
change held.** When you catch the model saying something wrong, the reflex should
not be "write a better instruction." It should be:

1. **Can I delete the thing that let it speak?** (see §3 — this is the best fix)
2. **Is the context I gave it lying?** (see §5 — it usually is)
3. **Can the server just refuse?** (see §7)
4. Only then: a prompt rule, backstopped by a guard.

---

## 1. The shape of a turn

```
POST /conversations/current/messages
  │
  ├─ 1. persist the user message (inside an advisory lock, with the allowance check)
  ├─ 2. build context      ──────────────────────► §4  (four different blocks!)
  │
  ├─ 3. ACT PASS   (non-streamed, has tools, thinking ON)      ──► §2
  │       └─ decides: call tools, or call no_action(reason, intent)
  │
  ├─ 4. did every call succeed?
  │       ├─ YES → emit the cards. SAY NOTHING. done.          ──► §3
  │       └─ NO / nothing ran → NARRATE PASS (streamed, no tools) ──► §2
  │
  ├─ 5. guards (at most one correction fires)                  ──► §6
  └─ 6. stream_end
```

Two model passes, never more. The act pass **decides and acts**; the narrate pass
**talks**. They never swap jobs — the narrate pass has no tools attached, so
"narrated the action instead of doing it" is not a thing it can do.

---

## 2. The two passes

### Act pass — `providers/act-narrate.ts`, pass 1

| | |
| --- | --- |
| Streamed? | No |
| Tools | All of them, plus `no_action` |
| Thinking | **ON** (load-bearing — see below) |
| History | Last **4** messages only (`ACTION_PASS_HISTORY_MESSAGES`) |
| Context | `tailText` — the full state block (§4) |
| Loops? | Only if a `create_task` succeeded, or a call **failed** |

**Why thinking stays on.** It looks like a classifier picking a tool. It is not:
it has to *judge*. Is "mark water done" ambiguous between two open tasks? Does
"undo that" mean a pending card or a real change? Turning thinking off made it
stop reasoning and start pattern-matching, and accuracy fell 27/27 → 23/27,
including reintroducing a silent data write. The cost is real and accepted:
**thinking mode rejects `tool_choice: 'required'` (HTTP 400)**, so the code falls
back to `'auto'` and the "must call a tool" guarantee has *never actually been in
force*. That fallback is load-bearing, not a wart. The guarantee is backstopped by
§6 instead.

**Why the loop is stingy.** Another round costs a full ~9k-token round trip
(~1.5–2s, measured). It has to earn it. Only two things do: a `create_task`
success (it mints a ref the model couldn't know at turn start, so a
create→act chain needs a round), and a **failure** (the tool result is a
corrective message, and the retry is the entire point of sending it). Everything
else is terminal.

### Narrate pass — `providers/act-narrate.ts`, pass 2

| | |
| --- | --- |
| Streamed? | Yes |
| Tools | **None.** It cannot act, ever. |
| Thinking | ON — except on the conversation fast path (§8) |
| Context | *Depends on the turn.* See §4. |

It is handed the act pass's results as **authoritative facts** and told to describe
them. It can't call anything, so anything it claims is either true or caught (§6).

---

## 3. THE CARD IS THE CONFIRMATION — silence after acting

**A turn whose tool calls all succeeded emits its cards and stops. No narrate call
at all.**

This is the single most important thing in this document.

Every prose bug this app has ever had lived in the sentence the reply pass wrote
*about* an action it had already performed:

- claiming an action it never took (**false claim**)
- hiding one it did take (**concealment** — *"already done, you're good"* about a
  task it had just completed)
- inventing a total (*"you're at $10"* when it was $5)
- and then the **correction bubbles** bolted on to catch those, which fired on
  roughly **one action turn in four** and read to users as a malfunction
  (*"To be clear though — I just did that now"*)

None of that prose carried information the user didn't already have. **The action
card is rendered directly above it**, live from the database, with the task's real
title, schedule and state.

So the prose is gone. That doesn't police the lie surface — it **deletes** it. It
also removes a model round-trip (~1–2s) from every create/complete/log.

**Prose is kept exactly where it carries what the card cannot:**

| turn | reply |
| --- | --- |
| a **missing detail** | *"How much are you saving toward?"* |
| an **ambiguity** | *"Which one — water the plants or water filter change?"* |
| a **FAILED call** | the card never renders, so silence would be a lie |
| ordinary **conversation** | unchanged |

**Ask before acting. Say nothing after.**

### The one thing the card can't show

Goal impact and history (*"Auto-logged $5 to 'New bike' — now $5 / $300. That's
your 4th time this week."*) is not on the `TaskCard`. It used to live only in the
prose — i.e. only in the lie surface. It's now `meta.detail`, rendered as a
caption **on** the card, **computed in SQL**, so it cannot be wrong.

---

## 4. The four context blocks — the most important table here

The two passes need *different* things, and giving them the same context was
actively harmful. There are **four** state blocks built per turn
(`routes/messages.ts`):

| block | contains | given to |
| --- | --- | --- |
| **`tailText`** | now · counts · task list · goals · streak · pending preview · **recent-changes feed** · **undo target** | the **ACT pass** |
| **`narrateTailText`** | same, minus the undo target | the **normal narrate** pass |
| **`conversationTailText`** | **just the clock** | the **conversation fast path** (§8) |
| **`stateFactsText`** | tasks + goals + streak + counts. **No** recent-changes, **no** undo target | the **guards** (§6) |

### Why the reply pass doesn't get the recent-changes feed on a chat turn

The feed (*"Since your last message, in the app: removed 'Pick up brother'…"*)
exists so the model can't *contradict* something you did out of band — a Tasks-tab
tap, a Confirm on a card. That's **grounding** for the act pass, which genuinely
needs it to handle "undo that".

The reply pass read it as **news and announced it**. You tapped Confirm on a bulk
delete, typed *"What's up dawg"*, and got:

> *"Already got you — just tapped that confirm, so they're all gone now. Tasks are
> cleared out."*

A status report nobody asked for, on a greeting.

### Why the conversation path gets nothing but the clock

Hiding the feed alone wasn't enough (it then said *"card's still waiting"* about
tasks that were already deleted — stale instead of unprompted). The real fix: **on
a pure-conversation turn the reply pass sees no task state at all.** Card turns are
stripped from its history and its state block is cut to the clock.

**It cannot narrate a task it cannot see.** That's a guarantee. *"Please don't
mention their tasks"* would have been a request — and §0 is about the difference.

State questions still work, because the two-key gate (§8) routes them to the *full*
context: *"what's on my list?"* → *"Nothing — you cleared it all out."*

### Why the guards get their own block

They were being handed `tailText`, which talks about **changes** — while the
claim-check's whole premise is *"nothing changed this turn"*. Handing a classifier
a contradiction and then blaming its judgment is not reasonable. It duly retracted
two perfectly honest replies. **A guard can only be as good as the facts you give
it.**

### A block that omits a row makes the model lie — and the guard takes the blame

The blocks above are only as true as the queries behind them. `task-context.ts`
**folds** a recurring instance into its parent template, so a daily task renders as
one row and not a pile of dated copies. That fold assumes the template is *there to
be folded into*.

It wasn't. The removal cascade used to spare **completed** instances (`status ===
'open'`), which orphaned them: the template was deleted, the done instance survived.
The fold then hid each orphan behind a stand-in that no longer existed, and the block
came back:

> *They have no tasks yet.*

…while the Tasks tab showed **three**. The user said *"delete all tasks"*, tapped
Confirm, and three remained. Chat, reading its context faithfully, said everything
was gone. `didClaimAction` — which reads real server state and could see the rows —
caught the contradiction and retracted:

> *"Hold on — I don't think that actually went through."*

**Every component behaved correctly and the user got a lie followed by a retraction.**
The model didn't hallucinate; it was told there were no tasks. The guard didn't
misfire; it was right. The bug was one `WHERE` clause in a cascade and one fold with
an unchecked premise.

Two things were fixed, deliberately at both layers:

- **Policy:** every cascade (`removeTask`, `removeTasks`, the goal-archive cascade)
  now takes the whole series, done instances included. The app stops **making**
  orphans.
- **Guarantee:** the fold is now conditional on the template actually being present.
  A row with nothing to fold into **represents itself**. An orphan can no longer go
  **unseen**, whatever creates one next.

The policy is the fix; the guarantee is the one that will still be true in a year.
This is §0 again from a new angle: *fix the context that's lying*. **When a guard
fires, suspect the context before you suspect the model** — a guard firing is
evidence the reply disagreed with reality, not evidence about *which one* was wrong.

---

## 5. History — what the model sees, and what it must never see

`historyContentFor()` in `routes/messages.ts`.

| message kind | in model history? | why |
| --- | --- | --- |
| user / assistant prose | ✅ as-is | it's the conversation |
| `task_action`, `goal_action` | ✅ the server-computed summary | **the card IS the assistant's reply** |
| `task_removal_pending`, `task_bulk_removal_pending`, `goal_advance_pending`, `goal_preview` | ❌ **dropped** | a pending card is not an action; see below |
| anything matching `isToolCallMarkupLeak` | ❌ **filtered** | leaks are self-reinforcing; see below |
| card turns, on the **conversation** path only | ❌ dropped | §4 — nothing to narrate if it can't see them |

### Completed actions must be in history

They used to be dropped. That was safe under an assumption that **§3 destroyed**:
the old comment said *"the model's own immediately-following natural-language reply
still carries the conversational continuity."* That reply is gone. Dropping the
card too left a **hole**:

```
user: "make a task to pick up brother daily at 7pm"
user: "what's up"                    ← no assistant turn between them
```

The model saw an unanswered request and caught up on it — answering a plain
*"what's up"* with *"Already in there — daily at 7pm."* **Not a prompt problem: the
record we handed it was false.** Fill the hole and there's nothing to catch up on.

### Never put a constant string in history

The fix above was first attempted with a placeholder for pending cards —
`[showed a confirmation card — nothing changes unless the user taps it]`. The model
**copied it verbatim into a real reply**: a delete request got
*"[showing a confirmation card — tap it to confirm]"* as prose, with no card behind
it.

An earlier attempt failed identically with a different placeholder
(`[create_task → "Feed cats"]`). **The lesson is not that brackets are bad. It is
that a fixed, repeated shape in the model's own history is a template it will
eventually reproduce, whatever it looks like.**

Pending cards are therefore dropped, and nothing is lost: the reply pass learns
about them from a **server-authored fact** instead (`actionCtx.pendingConfirmCard`).

### Leaks are self-reinforcing

A leaked reply gets persisted as an assistant message → the model reads its own
`calling create_task with title "…"` in history next turn → does it again. The copy
it produced was *degraded* (`calling create`) — enough like the original to imitate,
different enough to dodge a guard that only knew the full tool name.

**Suppressing the output is not enough on its own.** One leak that escaped before
the guard existed keeps teaching the model forever. So leaked assistant messages are
filtered out of model-visible history, permanently.

---

## 6. The guards — three lies, three checks

All in `providers/shared.ts` + `lib/ai/claim-check.ts`. **At most one correction
fires per turn** (two stacked walk-backs read as a malfunction, not as honesty).

Each follows the same shape: **a free deterministic gate → a grounded classifier →
an honest correction.** The gate decides whether a call is worth making; the
classifier is the arbiter. A regex can see that a sentence *sounds like* a claim;
only the state can say whether it's *false*.

| guard | fires on | asks |
| --- | --- | --- |
| **`maybeCorrectFakeAction`** | turns with **no** real mutation | did it claim an action that never happened? |
| **`maybeCorrectConcealedAction`** | turns that **did** act | did it hide or deny what it did? |
| **`maybeCorrectFabricatedFigure`** | any turn with an ungrounded number | is a figure actually *wrong*? |

### `didClaimAction` — grounded, not vibes

It used to see only the reply text and was asked *"does this sound like a claim?"*
That's the wrong question — **sounding like a claim isn't the issue; being false
is.** It retracted honest replies (*"Call the dentist is set for tomorrow at 3 PM"*
— a task that really does exist) about **18% of live turns**.

On a zero-tool turn this is *decidable*: nothing changed, so the current state **is**
the pre-reply state. Anything consistent with it is honest by construction, however
confidently phrased. It's now handed `stateFactsText` and stops guessing — and it
catches a **fabricated total** as a bonus, which the text-only version was blind to.

### `didConcealAction` — denial, not casualness

First version treated the *word* "already" as concealment. But flash uses it as a
discourse marker meaning "handled": *"Already got you — 'Feed the dogs' is set for
tomorrow"*, said on the turn it created the task. **61 corrections fired live,
~1 in 4 action turns.** The card is on screen — a breezy "already got you" can't
mislead anyone. Only words that **fight the card** can. Scoped to denial and
contradiction. (Mostly moot now that §3 means action turns write no prose at all —
kept for the mixed success/failure case.)

### `didMisstateFigure` — the one both others were blind to

`didClaimAction` guards *action claims*. `didConcealAction` guards *denials*.
Neither ever looked at whether the **numbers** were right — so a reply could be
scrupulously honest about its actions and still tell you your savings were double
what they are (*"You're at $10 total now"* against a real $5). "Never invent a
number" is the app's own rule (CLAUDE.md §2); this enforces it at the output
boundary.

The free gate is `hasUngroundedFigure` — does the reply contain a number that
appears **nowhere** in the facts? If every figure is already grounded, no
fabrication is possible and **no API call is made** (~2% of turns escalate). It is
deliberately over-eager: a correctly *derived* figure (*"$295 to go"* from *"$5 /
$300"*) trips it too, and the classifier — which is told sound arithmetic is fine —
sorts that out.

### The leak guard

`isToolCallMarkupLeak` runs on the narrate stream. On a hit it **discards the whole
reply**, not just the remainder: truncating to "what was already emitted" persisted
the leak's own *prefix* (`[I called remove`). A partial leak is not a partial reply.

---

## 7. Server-side guarantees — where model judgment cannot reach

`lib/ai/actions.ts`. These are not prompts. The model **cannot** talk its way past
them.

| guard | stops |
| --- | --- |
| `resolveTaskRef` / `resolveGoalRef` | a ref that isn't in *this turn's* map — hallucinated, stale, or copied |
| `verifyTitleHint` / `verifyNameHint` | a ref that resolves to a *different* task than the model thinks |
| zod schemas (+ `superRefine`) | malformed or cross-field-invalid tool args |
| `complete_task` already-done check | re-reporting a done task silently reversing it (it's a *toggle*) |
| **the undo guard** | **see below** |

### The undo guard — the last silent write

A tap-to-confirm card **mutates nothing**. It's a question, not a change. So when
it's the newest thing on your screen and you say *"undo that"*, there is by
definition nothing to undo: *"that"* is the card, and the card did nothing.

Without this, `undo_last_action` reached **past** the card and reverted the last
real record — an unrelated task you had actually completed — while the reply said
*"nothing got deleted."* **~1 undo in 20.**

The rule existed in the prompt and held ~95% of the time. **That is precisely the
problem.** A data-integrity invariant needs a guarantee, not a good success rate. So
the executor refuses, and the reply pass is told the truth by a **server-authored
fact**, not by the model's own explanation.

**There is no remaining path by which Meroa can change your data without telling
you.**

---

## 8. The conversation fast path — and the two-key gate

Reasoning is emitted **before** the first content token, so it lands directly on
time-to-first-token (1.97s → 0.80s with it off, measured). But turning it off
globally caused false claims: on a no-action turn the reply pass has one hard job —
**resist the pull of what the user just asked for** — and without reasoning it
confirmed the request it had just read.

Look at *which* turns those were: every one had a **real request in flight** that
couldn't be fulfilled. A greeting has nothing to falsely confirm.

**So reasoning is dropped for exactly one case, behind TWO keys, and both must
turn:**

1. **The act pass declares** `no_action` with `intent: 'conversation'`
2. **`looksPurelyConversational(userMessage)`** — a dumb literal scan of what the
   *user typed* (digits, `$`, "task", "saved", "done", "today", "list", "how am i"…)

**Key 1 alone is not safe.** Asked *"was there any task intent here?"*, the model
labelled **"saved my $5 today" as `conversation` 3 times out of 3** — because there
was nothing left to *do* about it (already recorded). It conflated *"nothing to do"*
with *"nothing asked."* Tightening the wording only swung it the other way: the fast
path then never fired at all, on anything.

**The asymmetry is deliberate.** A false positive on the regex costs a little
latency and nothing else. A false negative is still caught by the model's own
`unfulfilled`. **Neither key can, alone, put a real request on the fast path.**

### Speculation

`looksPurelyConversational` reads only the user's message — it does **not** depend on
the act pass. So when that key already turns, the narrate request is dispatched
**concurrently with the act pass** and buffered. TTFT becomes `max(act, narrate)`
instead of `act + narrate`.

It is only ever **shown** if both keys turn. If the act pass acted, or declined for
any reason other than "there was nothing to act on," the stream is aborted unread.
**A wrong guess costs tokens, never correctness.**

---

## 9. The trust boundary

| **server-computed — trusted, quoted verbatim** | **model-authored — never trusted** |
| --- | --- |
| action summaries (`summarizeComplete`, `goalImpactSuffix`) | tool-call arguments → zod + refs + hints (§7) |
| goal headlines, pace, streaks (`buildGoalCardSummaries`) | `no_action`'s `reason` → **sanitized**, see below |
| completion history (`lib/ai/history.ts`) | every sentence of every reply → guards (§6) |
| the state block, `meta.detail` captions | |
| the pending-card fact | |

**The model never computes a number.** Every figure in the app is computed in SQL
and *quoted*. It has been caught doing its own arithmetic and getting it wrong
(narrating `$2.65/day` when the real recomputed pace was `$2.41/day`).

### `no_action.reason` — the one channel we opened, and had to sanitize

The act pass writes `reason` in free text, and we inject it **verbatim into the
reply pass's prompt**. It is the *only* model-authored string that crosses into a
model prompt.

On "undo that", the act pass wrote reasons naming its own mechanics — **8 times out
of 10, measured** — and the reply pass read a tool name *in its own instructions*
and echoed it to the user: **`[I called remove`** reached the chat.

Reasons naming a tool are now **dropped**. But dropping alone made it worse (with no
reason, the reply fell back to pattern-matching "undo that" → *"Undone — Buy eggs is
back"*), so the same fact is now stated **server-side** from the pending-card state.
Leaks 1 → 0, retractions 6 → 0.

---

## 10. Numbers (measured, July 13 2026)

| | |
| --- | --- |
| Conversation TTFT | ~3.4s (was ~6.7s) |
| Terminal action, total | ~6.1s (was ~8.1s) |
| Act pass | ~2.2s (noisy: 1.6–3.8s) |
| Narrate, with thinking / without | 1.87s / 1.10s |
| Cost per user message | **$0.00131** (deepseek-v4-flash) |
| Provider | flash — tied pro on accuracy (27/27 both), **3.4× cheaper, 1.8× faster** |

Free plan 50 msgs/day, Plus 1000/day (`env.ts`) — **there is no monthly cap in code.**
See `docs/phase-5-completion-plan.md` and Phase 7.

---

## 11. Rules for changing this

1. **Don't add a prompt rule to fix a correctness bug.** Read §0. Ask what you can
   delete, what context is lying, or what the server can refuse.
2. **Never put a constant string into model-visible history.** §5. It will be copied.
3. **Never hand a guard a context that contradicts its own premise.** §4.
4. **When a guard fires, suspect the context before the model.** §4. A firing guard
   proves the reply disagreed with server state — it says nothing about *which* of
   them was wrong. The "delete all tasks" bug looked exactly like a hallucination and
   was a `WHERE` clause. If a context block can omit a row the UI still renders, the
   model will state it as fact and the guard will retract it, and you will spend the
   day debugging the wrong layer.
5. **Anything with a number in it is server-computed.** §9. No exceptions.
6. **Two keys for anything that relaxes safety.** §8. Model judgment is one key,
   never both.
7. **The battery is a floor, not a ceiling.** It runs on *fresh accounts*. Three of
   today's bugs — the leak, the correction spam, the "what's up" recap — were
   invisible to it and surfaced within minutes of a human using a **long-lived
   account**. Before you trust a change, drive it on an account with real history.
8. **Every change goes through the battery** (`docs/phase-5-completion-plan.md` §3)
   *and* an as-a-user pass. `tsc` and unit tests have never once caught one of these
   bugs.
9. **A guard's "is this legitimately pending" exemption is only as wide as what it
   checks for.** §12 below — `hasPendingPreview` was named generically but only ever
   checked for a pending *goal* preview, so an honest reference to a pending *task*
   preview had no exemption and got force-corrected as a false claim. If a flag's
   name is broader than its implementation, assume it will eventually be asked the
   broader question.

---

## 12. Addendum — 2026-07-15: tone tuning and a task-preview guard gap

A pass to make Meroa a little more "hardass" about follow-through and to encourage
turning real intentions into tracked structure surfaced two real issues, both fixed:

**A pre-existing guard gap, exposed by the new behavior.** `hasPendingPreview`
(`pending-preview.ts`'s `findPendingPreview`, fed into `ChatActionContext` in
`routes/messages.ts`) only ever recognized a pending **goal** preview
(`meta.kind === 'goal_preview'`) — never a pending **task** preview
(`task_creation_pending`). The claim-check guard's exemption for "describing a card
that's legitimately still pending" (`shared.ts`'s `matchedPreviewClaim`) relies on
that flag, so an honest reply referencing a genuinely-pending task card ("could you
tap Create on that card") had no way to be recognized as honest and got force-
corrected: *"Hm, that preview didn't actually go through"* — which was itself false.
Fixed by adding `hasPendingTaskPreview()` (same newest-wins scan, checking
`task_creation_pending` / `createdTaskId` instead of `goal_preview` /
`createdGoalId`) and OR-ing it into the same flag. This is a straight case of §0: the
fix is structural (the guard now has the fact it needs), not a prompt tweak.

**Encouragement language colliding with the no-false-claims rule.** Separately, a
turn where `create_goal` failed (malformed tool-call JSON — a known model-reliability
flake, not something new) was followed by the reply claiming *"you want the gym one
as a daily task — putting it up now"* — a flat claim of action against a call that
had just failed, directly contradicting `failureResultsBlock`'s explicit instruction.
The claim-check guard caught it correctly, but pushing the model toward more
confident, decisive language (in service of a "hardass"/accountability tone) made it
measurably more likely to reach for "doing it now" phrasing exactly where a failed
call needed the opposite: an honest "that didn't go through." Fixed with an explicit
tie-in in the system prompt: being firm/direct is never a license to describe a task
or goal as created/started before a real tool result confirms it, and any
encouragement toward tracking must be phrased as a question or offer, never as
something already in progress.

**Also landed this session, not guard-related:** a deterministic lowercase transform
for the `chill` vibe preset (applied at the output boundary in `routes/messages.ts`,
covering both the SSE stream and the persisted DB row — a guarantee instead of a
prompt suggestion, per §0), and moving `buildStyleBlock` from the front system
prompt into the tail block (adjacent to the newest message) so a vibe instruction
gets the same "recency wins over instruction priority" treatment already given to
the volatile task/goal state.

**A pattern worth naming:** an early attempt to widen `create_task`'s auto-trigger
threshold *and* have the reply pass proactively reference existing state for
encouragement was rolled back after live testing showed it referencing a
still-*pending* preview in a suggestion-shaped way that tripped the claim-check
guard. The version that shipped instead scopes proactive state-citing to **real,
confirmed** records only — never a pending preview — which is the same "quote only
what's real" rule every other number and fact in this app already follows.
