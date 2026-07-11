# OpenAI Provider Swap — implementation spec & session handoff

> **Pickup prompt for a fresh session:**
> _"Read `CLAUDE.md` and `docs/openai-provider-swap.md`. Implement the provider swap per that doc. Plan first and show me the plan before writing code."_
>
> Status at time of writing (July 11, 2026): **decision made to switch the in-app chat
> from Anthropic to an OpenAI model. Exact model tier NOT yet chosen** — blocked on the
> user personally confirming current pricing at platform.openai.com/pricing (web lookups
> that day returned conflicting numbers across GPT-5.x mini/nano sub-versions; GPT-4o-mini
> is no longer on OpenAI's pricing page and should not be used). Everything else below is
> ready to execute. The server currently still runs `claude-sonnet-5` and works fine —
> nothing is broken; this is a cost-driven swap.

---

## 1. Why (context a fresh session won't have)

- The app charges $19.99/mo. On Sonnet 5 (~$0.01–0.02/message measured against this
  codebase's real prompt sizes), a sane AI budget only supports ~5–10 messages/day —
  the user judged that "not even worth paying for." OpenAI's small tiers are ~5–10x
  cheaper per token.
- **Reliability is the #1 risk of this swap, not the code.** This session measured
  tool-call hallucination rates by running 10 real operations through the live chatbot
  and cross-checking the server's `toolCalls` log: **Haiku 4.5 = 4/10 hallucinated
  (claimed an action happened with `toolCalls: []`); Sonnet 5 = 0/10.** Cheap models
  skipping tool calls and narrating fake success is a demonstrated, recurring failure
  mode in this exact harness. **The swap is not done until the chosen OpenAI model is
  put through the same 10-operation test (protocol in §6) and the rate is recorded here.**
- DeepSeek was evaluated and rejected for now (App Store Guideline 5.1.2(i) requires
  naming the AI provider in an explicit consent prompt; "DeepSeek (China)" carries
  regulatory momentum risk + likely opt-in conversion damage for a sensitive-data
  companion app).

## 2. Key facts about the OpenAI API (answers "is it one SDK?")

- **Yes — every OpenAI model uses the same SDK (`openai` npm package) and the same
  request shape.** The model is just a string in the request. So: implement once,
  set the tier via env var (`OPENAI_MODEL`), decide/change the tier later with zero
  code changes — exactly how `ANTHROPIC_MODEL` works today.
- Target the **Chat Completions API** (`client.chat.completions.create` with
  `stream: true`). It maps most directly onto the existing loop (messages array in,
  assistant message + tool calls out). The newer Responses API is fine too, but Chat
  Completions is the lower-risk translation and remains fully supported.
- **Prompt caching is automatic** on OpenAI (prefix-based, no `cache_control` markers,
  discounted cache reads). Consequence: delete the `cache_control` logic, but **keep
  the two-block system structure with the stable block first** (base prompt, then
  dynamic time+tasks block) — prefix-based caching rewards exactly that ordering.

## 3. What changes vs. what must not change

| Area | Verdict |
|---|---|
| `server/src/lib/ai/chat.ts` | **Rewritten** against OpenAI (details §5). Everything else consumes its `ChatStreamEvent` generator — keep that interface identical so `routes/messages.ts` needs no changes. |
| `server/src/lib/ai/tools.ts` | **Light conversion.** The JSON Schemas are already standard JSON Schema; OpenAI just wants them wrapped as `{type:'function', function:{name, description, parameters}}`. Zod validation layer (`AI_TOOL_SCHEMAS`, `validateToolInput`) unchanged. |
| `server/src/lib/ai/actions.ts` | **Untouched.** `executeAiToolCall`, titleHint verification, remove-confirmation flow — all provider-agnostic. |
| `server/src/lib/ai/system-prompt.ts` | **Content untouched.** Only how it's attached changes (two `role:'system'` messages instead of Anthropic's `system` array — order: stable block first). |
| `server/src/lib/ai/task-context.ts` | Untouched. |
| Executor / progress / recurrence / routes / records / idempotency | Untouched. `records.toolCallId` stores OpenAI's `call_…` id instead of Anthropic's `toolu_…` id — it's an opaque string, nothing cares. |
| App (client) | **Zero changes.** The SSE protocol the app consumes is defined by `routes/messages.ts`, which doesn't change. |
| `.env` | Add `OPENAI_API_KEY`, `OPENAI_MODEL`, `AI_PROVIDER`. Keep the `ANTHROPIC_*` vars for instant rollback. |

## 4. Recommended structure: dual provider behind one interface

Keep the Anthropic implementation alive during the transition — it's the control group
for the reliability test and the rollback path:

```
server/src/lib/ai/
  chat.ts                 # thin dispatcher: exports streamChatReply + shared types,
                          #   picks provider from env.AI_PROVIDER ('anthropic'|'openai')
  providers/anthropic.ts  # current chat.ts contents, moved (minimal edits)
  providers/openai.ts     # new implementation (§5)
```

Shared pieces both providers need (extract into chat.ts or a small shared module rather
than duplicating): `ChatStreamEvent` type, `windowHistory` + the history caps, the
segment-splitting buffer logic (blank-line → multi-bubble), `toolCallLog` + `logTurn`,
and the fake-action self-correction patterns (`FAKE_ACTION_PATTERN`,
`TOOL_NAME_LEAK_PATTERN`, `maybeCorrectFakeAction`). If extracting the segment splitter
gets messy, duplicating it consciously into each provider is acceptable — correctness
over elegance here.

If the implementer judges dual-provider too heavy, a straight rewrite of `chat.ts` with
git as the rollback is acceptable — but dual-provider is preferred because the
reliability A/B test (§6) is mandatory anyway.

## 5. `providers/openai.ts` — translation notes (the fiddly parts)

Current Anthropic loop → OpenAI equivalents:

- **Client/setup:** `npm i openai` (in `server/`), `new OpenAI({ apiKey: env.OPENAI_API_KEY })`.
- **Request:**
  ```ts
  client.chat.completions.create({
    model: env.OPENAI_MODEL,
    stream: true,
    max_completion_tokens: MAX_OUTPUT_TOKENS,   // NOT max_tokens (deprecated on new models)
    messages: [
      { role: 'system', content: buildSystemPrompt(user) },          // stable — first, for prefix caching
      { role: 'system', content: buildDynamicContext(...) },         // per-turn
      ...turnMessages,
    ],
    tools: OPENAI_TASK_TOOLS,                    // wrapped schemas, see §3
    tool_choice: iteration === MAX_TOOL_ITERATIONS - 1 ? 'none' : undefined,
  })
  ```
  Don't pass `temperature`/other sampling params — some GPT-5-family models reject them.
- **Text streaming:** chunks arrive as `chunk.choices[0].delta.content` (string
  fragments). Feed these into the existing segment-splitting buffer exactly as
  Anthropic's `text_delta`s are today — that logic is provider-agnostic.
- **Tool-call streaming (the trickiest difference):** `delta.tool_calls` arrives as
  *fragments*: first chunk carries `{index, id, function: {name, arguments: ''}}`,
  later chunks append string pieces to `function.arguments` at the same `index`.
  Accumulate by index into `{id, name, argsJson}` records. Arguments are a **JSON
  string, not an object** — `JSON.parse` each one after the stream ends. Wrap the
  parse in try/catch: on failure, push an error tool result ("your arguments were not
  valid JSON — retry") instead of throwing; `validateToolInput` expects an object.
- **Stop reason:** `finish_reason: 'tool_calls'` ≈ Anthropic's `stop_reason:
  'tool_use'`; `'stop'` ≈ `'end_turn'`; `'length'` ≈ `'max_tokens'`;
  `'content_filter'` ≈ `'refusal'` (also check `delta.refusal` / `message.refusal`
  for structured refusals). Map to the same friendly fallback strings used today.
- **Feeding results back** (the loop's continue step):
  ```ts
  turnMessages.push({
    role: 'assistant',
    content: assistantText || null,
    tool_calls: accumulated.map(c => ({
      id: c.id, type: 'function',
      function: { name: c.name, arguments: c.argsJson },   // raw string, as received
    })),
  });
  for (const c of accumulated) {
    turnMessages.push({ role: 'tool', tool_call_id: c.id, content: resultSummaryOrError });
  }
  ```
  Note: OpenAI has **no `is_error` flag** on tool results — error text just goes in
  `content`. Keep the instructive error phrasing ("…ask the user for the missing value
  rather than guessing") since that's what steers the model's retry.
- **`executeAiToolCall` call:** pass `toolCallId: c.id` (the `call_…` string) —
  idempotency works unchanged.
- **Error mapping** (same UX strings as today): `OpenAI.RateLimitError` /
  `OpenAI.InternalServerError` → retryable "overloaded"; `OpenAI.APIConnectionError` →
  retryable "lost connection"; anything else → generic non-retryable.
- **Keep bit-for-bit:** `MAX_TOOL_ITERATIONS = 3` with forced-`none` final pass, the
  per-turn `toolCallLog` + `logTurn()` logging (it's how hallucinations get measured),
  `maybeCorrectFakeAction()` at both turn-end exits, segment pause sleeps, the
  "guarantee at least one segment per turn" fallback, and `windowHistory` caps
  (24 msgs / 16k chars).

## 6. Verification protocol (mandatory before calling this done)

1. `npx tsc --noEmit` in `server/`; `npx tsc --noEmit` + `npm run lint` in the app root.
2. Live smoke test via curl (get a token with `npm run dev:token`; endpoint is
   `POST /conversations/current/messages` with body `{"text": "..."}`, SSE response).
3. **The 10-operation reliability test**, exactly as run twice this session:
   - Use the dev token account. Send, via real chat: 3 creates (simple / checklist
     with items / counter with target), 1 edit (change a target), complete + un-complete,
     check off a checklist item by name, 1 postpone, 2 deletes.
   - Use natural task titles (the model refuses suspicious names like
     "test-hallucination X" — correctly).
   - Ground truth is the server log, not the chat text: every turn logs
     `chat turn finished` with a `toolCalls` array (grep `/tmp/meroa-dev.log` or
     wherever the dev server logs). **A turn whose reply claims an action but logs
     `toolCalls: []` is a hallucination.** Deletes should produce
     `task_removal_pending` (confirm-card flow), not immediate deletion.
   - Record the rate in this file. Sonnet 5 baseline: 0/10. If the OpenAI model is
     materially worse (>1/10), stop and surface it — don't ship it on cost grounds alone.
4. Clean up all test tasks afterward (direct DB delete of the created ids — pattern
   used repeatedly this session: small `tsx` script in `server/src/`, run, then delete
   the script).

## 7. Related pre-ship items (recorded here so they aren't lost; not blockers for the swap)

- **User must confirm OpenAI pricing + pick the tier** (`OPENAI_MODEL`), then message
  allowances need real values: `PLUS_DAILY_MESSAGES` env default is **1000/day — a dev
  placeholder, ruinous at $19.99/mo; must be set from real per-message cost math**.
  `FREE_DAILY_MESSAGES=5000` in `server/.env` is likewise a dev-testing value (code
  default is 50).
- App Store Guideline 5.1.2(i): the AI-provider consent/disclosure flow (a later phase)
  must name **OpenAI** once this ships.
- Known tool gap, unrelated to the swap: the AI has no way to **un-check** a checklist
  item (`checklist_complete` only marks done; the model correctly says it can't).
  Small executor + tool addition if wanted.
- The user's per-phase workflow: plan on Fable, then switch to Sonnet to write code
  (`/model sonnet`) before implementing.
