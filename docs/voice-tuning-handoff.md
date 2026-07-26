# Voice / tonality tuning — handoff

> **Purpose.** Everything a fresh session needs to rewrite Meroa's chat *voice*
> against reference example texts, without breaking the correctness/safety
> guarantees. Read this + `docs/chat-architecture.md` first. Task: a purpose-built
> persona rewrite for the current model, anchored to reference texts + few-shot
> examples.

---

## 0. Why this rewrite exists

The persona prompt was iteratively tuned against **DeepSeek-flash's** failure
modes. Production switched to **OpenAI gpt-5-mini** (privacy — DeepSeek trains on
API data, PRC-hosted). gpt-5-mini fails *differently* — dry, over-careful, only
asks questions, hollow/mirroring — so many DeepSeek-era rules fight ghosts that
aren't there while the real gpt-5-mini failure modes go unaddressed. Patching
further deepens the patchwork; a fresh, opinionated voice is the fix.

## 1. Current model + config (verified)

- `server/.env`: `AI_PROVIDER=openai`, `OPENAI_MODEL=gpt-5-mini`,
  `OPENAI_REASONING_EFFORT=low`, `UTILITY_MODEL=gpt-5-nano`. Prod (Railway) = same.
- gpt-5-mini runs the chat (act + narrate); gpt-5-nano runs the utility calls
  (guards / memory extractor / notification composers via `lib/ai/utility-client.ts`).
- Battery baseline on this config: **~56/56** (`cd server && npm run battery`).

## 2. How the voice system works (the map)

Two passes (see `docs/chat-architecture.md`):

- **ACT pass** — decides/makes tool calls. Prompt: `ACTION_SYSTEM_PROMPT` in
  `server/src/lib/ai/system-prompt.ts`. **This is correctness, NOT voice.
  Battery-verified. DO NOT rewrite it.**
- **NARRATE pass** — does the talking. Prompt: `SYSTEM_PROMPT` (the `# Who you
  are` + `# Style` sections). **This is the voice — this is what you rewrite.**

All voice code is in **`server/src/lib/ai/system-prompt.ts`**:

- `SYSTEM_PROMPT` — the persona (`# Who you are`, `# Style`). ← rewrite target
- `TONE_BLOCKS: Record<ToneLevel, string>` — the **tone slider**. `prefs.tone` is
  an int **0–4** (0 = warmest, 2 = baseline/no-op, 4 = edgiest). `resolveTone(prefs)`
  reads it (maps a legacy `communicationStyle` too). `buildStyleBlock()` appends
  the level's block + any `StyleAdjustments` to the **tail** (recency wins). So:
  the persona is the baseline; the slider only *modulates* warmth↔edge. **Keep the
  0–4 axis; you may rewrite each level's wording to match the new voice.**
  Client control: `src/features/profile/ToneSlider.tsx` + `tone.ts` (also holds
  the live-example preview strings).
- `StyleAdjustments` (length / questions / directness / emoji) — per-user knobs set
  by the `adjust_style` tool, rendered in `buildStyleBlock`.
- `buildMemoryBlock()` — injects known facts into the narrate context
  ("quote, don't recall"). Narrate-only.
- `stripEmDashes()` — deterministic output transform (GPT overuses em dashes);
  applied at the output boundary in `routes/messages.ts`. Keep it.
- `quips.ts` — occasional pre-written ack after a real `create_task`.

The **guards** (`claim-check.ts` + `providers/shared.ts`) are correction backstops
(e.g. "Hold on, that didn't go through") — not voice, but tune-adjacent. They were
just gated so they don't fire on banter (only on replies with real action-claim
vocabulary). Leave them unless a false correction resurfaces.

## 3. What MUST be preserved (guarantees, not voice)

Do not lose these in the rewrite — they're model-agnostic and hard-won
(`docs/chat-architecture.md`):

- `ACTION_SYSTEM_PROMPT` (the act pass) — untouched.
- **Never invent a number** (every figure is server-computed and quoted).
- **The card IS the confirmation** — a successful action turn writes no prose.
- **Never claim an unconfirmed action** (no "added/created/logged" unless a tool
  call returned success THIS turn) — being firm is never license to fake it.
- **Crisis / safety**: not a therapist/doctor/adviser; the edge drops to zero on
  anything sensitive/emotional/crisis.
- **No manufactured dependence** (no guilt / FOMO / "days together" / loss-aversion).
- **Ground call-outs in real state** — never assert a pattern the state doesn't show.
- **Don't turn casual chat into tasks** — a story/vent is not a productivity op.
- Always clearly an AI *when it comes up* (asked, or first hello) — but never
  announce it unprompted, never imply it's human.

## 4. What to change (the rewrite)

1. Rewrite `# Who you are` + `# Style` fresh, targeting the **reference example
   texts**. Directly counter gpt-5-mini's failure modes: hollow/mirroring,
   only-asks-questions, dry, over-careful. Fold the preserved guarantees (§3) back
   in — but as tight, positive rules, not the DeepSeek-era "don't do X" pile.
2. **Add few-shot examples** — 4–6 concrete `user → Meroa` exchanges drawn from the
   reference. This is the strongest lever for gpt-5-mini (examples >> instructions).
   Two options for where they live:
   - Simplest: an `# How you sound` block of examples inside `SYSTEM_PROMPT`.
   - Stronger: real example messages prepended to the narrate history in
     `providers/act-narrate.ts` (where `buildTailedMessages(...)` builds the
     message array). More faithful, slightly more plumbing.
3. Optionally re-tune the `TONE_BLOCKS` wording per level to match the new voice
   (keep the 0–4 warmth↔edge structure).

### The desired voice (fill from the reference texts)
Founder's stated wants so far (2026-07-26), to confirm/refine against the video:
substance & opinions (not a mirror), a **hard-love initiative toward the user's
goals** as the main drive, able to talk about anything with a real take, *makes
conversation* (not just asks questions), playful/teasing, and **backs off the
moment the user says to**. Capture length / rhythm / humor / how it opens & reacts
from the actual example texts.

## 5. How to test + iterate (fast loop)

- Local server = the gpt-5-mini config: `cd server && npm run dev`. Editing
  `system-prompt.ts` **hot-reloads** (tsx watch) — no restart needed.
- **On device:** `npx expo start --dev-client` (repo root) → open the Meroa
  dev-client app (same Wi-Fi → hits the local server).
- **Via curl** (no phone): mint a token `npm run dev:token`, grant consent
  `PATCH /me/prefs {"aiConsent":{"granted":true}}`, then
  `POST /conversations/current/messages {"text":"..."}` (SSE stream). Body field is
  `text`, not `content`.
- **Correctness gate after any change:** `npm run battery` (server must be up) — must
  stay ~56/56. Voice changes shouldn't move it (act pass is separate), but verify.
- Real test account: phone `9168463503` (entitled; currently in reset-onboarding
  state). Reading its live messages: a throwaway `tsx` script querying `messages`
  by phone (see prior sessions) — or ask the user.

## 6. Repo state (2026-07-26)

- Branch `phase-8-partial`. Provider switch + compliance docs are **pushed**.
- Local **unpushed** voice commits (the accumulated patches this rewrite will
  largely replace): `e884eda` (AI-mention), `4696378` (em-dash + dryness),
  `a1577b2` (banter-guard + playful), `2c3a51b` (substance + initiative). Push,
  keep, or squash as you like once the rewrite lands.
- Provider decision + full battery matrix: `[[openai-provider-swap-in-progress]]`
  memory. Voice/companion direction: `[[companion-edge-proactive-direction]]`.
