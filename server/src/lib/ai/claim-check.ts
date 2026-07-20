import OpenAI from 'openai';

import { env } from '../../env.ts';
import { logger } from '../../logger.ts';

// env.CLAIM_CHECK_MODEL's default (deepseek-v4-flash) reasons before
// answering — it always emits chain-of-thought as a separate
// `reasoning_content` field ahead of the actual YES/NO in `content`, even
// for a question this simple, and that reasoning alone commonly runs into
// the hundreds of tokens. A tight token budget doesn't make the call
// cheaper here, it just truncates before `content` is ever written —
// observed live: max_tokens: 4 (this constant's first value) meant every
// single classifier call silently returned '' -> false, regardless of the
// actual text, for as long as this ran. Both constants below have real
// headroom for that reasoning pass; this is slower and pricier than a
// plain instruction-following model would need for the same question, but
// a classifier call that reliably reaches an answer beats a fast one that
// never does.
const CLASSIFIER_TIMEOUT_MS = 8000;
const CLASSIFIER_MAX_TOKENS = 800;

// Tightened after a live false-positive: the first version of this prompt
// asked a single broad question ("...claim, promise, or imply... was
// performed, or is being performed right now?"), and the model's own
// chain-of-thought treated *any mention* of a task action as qualifying —
// including an honest "I didn't set a reminder, and I can't add one
// retroactively — I can remove and re-create it if you want" (a truthful
// non-claim, correctly explaining a limitation and offering a *conditional*
// future option) as YES. That's worse than a missed catch: it's a
// nonsensical "Hold on, that didn't go through" appended to a reply that
// was honest about nothing having gone through. The YES/NO split now names
// the distinction explicitly (declarative "doing it now" vs. conditional
// "can do it if you want" / explaining what didn't happen) with concrete
// examples of each, since without them the model reliably blurred it.
// GROUNDED, after it fired on two honest replies in eleven live turns (~18%) and
// made the app look broken: "You good? \"Call the dentist\" is set for tomorrow at
// 3 PM" (a task that really does exist) and "Kept. Dentist at 4 PM tomorrow" (said
// when correctly declining to delete anything) both got "Hold on — I don't think
// that actually went through" bolted onto them.
//
// The old prompt could not have got those right, because it was shown ONLY the
// reply. Asked "does this sound like a claim", it had to guess — and it even
// listed "Set for tomorrow at 2pm" as a YES example. But sounding like a claim is
// not the question. The question is whether the claim is FALSE.
//
// And on a zero-tool turn that is decidable, because nothing changed this turn:
// the user's current state IS their state from before the reply. So a reply that
// merely describes something in that state is honest by construction, however
// confidently it is phrased. Only a reply that asserts something the state
// contradicts is a lie. Hand the classifier the state and it stops guessing.
// PATCHED for a blind spot an edge-case pass found live: the "no card was shown
// this turn" line below used to be an unconditional assumption, true only because
// this function is never called on a turn with a pending SUCCESS this same turn
// (see hadPendingSuccess in providers/shared.ts). It said nothing about a preview
// shown in an EARLIER turn that is still sitting on screen, un-tapped — the exact
// state providers/shared.ts's regex gate already carries as actionCtx.hasPendingPreview
// (fixed in the "silent non-creation" commit) but never threaded through to this
// classifier. Result: an honest "it won't save until you tap Create — not saved
// yet" about a genuinely pending card got YES'd anyway, because the prompt told the
// model such a card categorically can't exist. The facts block now states plainly
// when one does; the two bullets below that mention "preview" or "card" tell the
// model to check that stated fact instead of assuming it's always false.
const CLASSIFIER_SYSTEM_PROMPT = `You will be shown (1) the user's CURRENT tasks and goals — including whether a preview/confirmation card is still pending from an earlier turn, un-tapped — and (2) a message an AI assistant just sent them.

The assistant made ZERO tool calls this turn — nothing was created, completed, edited, removed, postponed, logged, saved, or newly shown as a card. Because nothing changed, the state below is ALSO exactly what the state was before the assistant replied (except for a preview card already pending from before — that part of the state can be older than this turn).

Answer with exactly YES or NO: does the reply tell the user something FALSE about their tasks or goals?

YES — the reply asserts something the state contradicts. That is the only thing you are looking for. Examples:
- claims a change it did not make ("Added your task", "Marked it done", "Removed it", "Logged that", "Moved it to Friday") when the state shows otherwise: the task isn't there, is still open, is still on its old date.
- presents a task or goal as EXISTING — already set up, already on their list, already tracked — when it does not appear in the state at all. (Merely TALKING about one that isn't there yet is not this: see below.)
- claims a preview or card was just shown or saved THIS turn ("Preview's up — tap Create", "Here's the card", "that's saved now") when the state does NOT list a pending preview at all. No card was created this turn, so a brand-new one is always false.
- claims a pending preview already went through or was saved ("that's all set now", "saved it") while the state still lists it as pending, un-tapped.
- gets a fact wrong: says a task is due at 5pm when the state says 7pm; says a goal is at $50 when it is at $10.

NO — everything else. Crucially:
- DESCRIBING something that really is in the state is honest, no matter how it is phrased. "Call the dentist is set for tomorrow at 3 PM" is NO if that task exists that way. It reads like a confirmation; that does not matter, because it is TRUE.
- Declining to act is honest: "Kept it", "Nothing to undo", "I didn't delete anything", "Which one did you mean?".
- Recapping what the USER did themselves — totals, streaks, what is done today — is honest.
- Offers and questions about the future ("I can remove it if you want") are honest.
- NAMING something is not CLAIMING it exists. The assistant BUILDS things with the user across several turns, asking questions before anything is saved — so a reply routinely discusses a goal, a stage, or a task that is not in the state yet, precisely BECAUSE it hasn't been created. That is the design, not a lie. All of these are NO even when the state is empty: "what are the milestones for that?", "what'll get you through the Applying stage?", "how much do you want to save?". It is only YES if the reply tells them it EXISTS or is DONE ("your internship goal is all set", "that's on your list now").
- A preview/card the state lists as pending is honest to describe as PENDING, however it's phrased: "that preview's still up, tap Create to confirm", "it won't save until you hit Create", "still waiting on you for that one" are all NO whenever the state shows one pending. This is the mirror of the YES rule above — describing a real pending card as pending is not the same lie as claiming a new one appeared or that it already saved.
- Asking about a milestone stage they have NOT reached yet is honest. The stages are all listed in the state, and the assistant deliberately asks what they want to do for the NEXT stage BEFORE advancing. "What's the plan for the Interviewing stage?", "congrats — what'll get you through Offer negotiation?" are questions: NO. Agreeing that they finished something in real life ("sounds like Applying is done") is also NO — that is about their life, not about what the app did. Only an assertion that the app ITSELF moved them ("moved you to Interviewing", "advanced your goal", "you're now on stage 2") is YES, and only while the state still shows the old stage.
- Ordinary conversation making no factual claim about their tasks is honest.

Do not judge tone, confidence, or phrasing. Judge only truth against the state. If the reply says nothing the state contradicts, answer NO.`;

// Lazy singleton — most requests never hit this (see the toolCallLog.length
// guard in providers/shared.ts), so there's no reason to construct a client
// that's never used. Always talks to DeepSeek directly regardless of the
// conversation's own AI_PROVIDER (env.CLAIM_CHECK_MODEL's default is a
// DeepSeek model, chosen for cost — a yes/no call, not a reply, even though
// the default model's own reasoning overhead means it isn't as cheap or
// fast in practice as that framing suggests; see the comment above
// CLASSIFIER_TIMEOUT_MS).
let client: OpenAI | null = null;
function getClient(): OpenAI | null {
  if (!env.DEEPSEEK_API_KEY) return null;
  if (!client) client = new OpenAI({ apiKey: env.DEEPSEEK_API_KEY, baseURL: 'https://api.deepseek.com' });
  return client;
}

/**
 * Cheap, non-streamed backstop for the "announced or claimed a task action
 * without ever calling the tool" failure (docs/ai-reliability-hardening.md
 * item 7) — the regex in providers/shared.ts only catches past-tense
 * confirmations ("Added \"X\""), not promises ("let me do that", "sent the
 * request"), and phrasing varies too much for a fixed pattern to keep up.
 * Only meant to be called on turns with zero tool calls (see
 * createTurnState's maybeCorrectFakeAction) — the common case for that
 * branch, so this adds latency only at the very end of the turn, after
 * every real reply segment has already reached the user.
 *
 * Falls back to `false` (defers entirely to the regex result) on a missing
 * API key, a slower-than-CLASSIFIER_TIMEOUT_MS response, or any other
 * error — a missed catch here is far cheaper than blocking every reply on
 * an extra round trip that isn't guaranteed to succeed.
 */
export async function didClaimAction(segments: string[], stateFacts: string): Promise<boolean> {
  const text = segments.join(' ').trim();
  if (!text) return false;

  const openai = getClient();
  if (!openai) return false;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CLASSIFIER_TIMEOUT_MS);
  try {
    const completion = await openai.chat.completions.create(
      {
        model: env.CLAIM_CHECK_MODEL,
        max_tokens: CLASSIFIER_MAX_TOKENS,
        temperature: 0,
        messages: [
          { role: 'system', content: CLASSIFIER_SYSTEM_PROMPT },
          {
            role: 'user',
            content: `THE USER'S CURRENT TASKS AND GOALS (unchanged this turn):\n"""\n${stateFacts || '(no tasks or goals)'}\n"""\n\nTHE ASSISTANT'S MESSAGE:\n"""\n${text}\n"""`,
          },
        ],
      },
      { signal: controller.signal },
    );
    const answer = completion.choices[0]?.message?.content?.trim().toUpperCase() ?? '';
    return answer.startsWith('YES');
  } catch (err) {
    logger.warn({ err }, 'claim-check classifier call failed — falling back to regex result');
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

// The background memory extractor (memory-extractor.ts) only structurally
// verifies that a create op's sourceMessageId is a real message in its own
// batch — it never checked whether the CLAIMED CONTENT is actually
// supported by what that message says. Observed live: given a batch
// containing only "my girlfriend broke up with me" plus unrelated banter,
// the extractor wrote "User has a new girlfriend, met at school." — a fact
// invented outright, timestamped hours before the user ever said anything
// about a new girlfriend at all. The resolve-then-verify discipline caught
// a hallucinated ID; it had nothing that could catch a hallucinated FACT
// wearing a real ID. This is that check — the extractor's own equivalent of
// didClaimAction, but for "did they actually say this" instead of "does the
// state show this."
const MEMORY_GROUNDING_SYSTEM_PROMPT = `You will be shown (1) something a user actually typed to their AI companion, and (2) a fact an extraction process wants to save about that user, citing THAT message as its source.

Answer with exactly YES or NO: is the claimed fact actually supported by what the user said — not embellished, not inferred beyond it, not invented?

YES — the fact is a fair restatement of something the message actually says or directly, unambiguously implies. Example: message "I've been really into rock climbing lately" -> fact "Into rock climbing" is YES.

NO — the fact adds any specific detail, name, place, or event the message never mentioned, even if it sounds plausible or is the kind of thing that could plausibly follow. Example: message "my girlfriend broke up with me" -> fact "User has a new girlfriend, met at school" is NO — nothing in the message says anything about a new girlfriend or where they met. A breakup is not evidence a new relationship started, and "met at school" was invented outright.

Also NO if the fact contradicts the message, or states something as an ongoing trait when the message only describes a single past instant with no sign it's lasting.

When genuinely unsure whether a detail was really said or was quietly added, answer NO — a memory that never gets saved costs nothing; a fabricated one about a real person is exactly what this check exists to catch.`;

/**
 * Runs once per proposed `create` op (never update/supersede — those cite
 * an existing memory by id, not a new source message, and resolve-then-
 * verify already confirms that id is real). Deliberately no free regex gate
 * first, unlike didClaimAction: extraction itself is already batched,
 * capped at 5 ops per run, and deliberately conservative (most batches
 * produce zero), so the volume never justifies a cheaper pre-filter.
 *
 * Fails CLOSED on any error (missing key, timeout, malformed answer) —
 * the opposite default from didClaimAction, which falls back to the regex
 * result. There is no regex to fall back to here, and "never invent a
 * fact" is the one rule this whole check exists to enforce, so an
 * unverifiable claim is treated the same as a false one: dropped.
 */
export async function isMemoryGrounded(content: string, sourceText: string): Promise<boolean> {
  const openai = getClient();
  if (!openai) return false;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CLASSIFIER_TIMEOUT_MS);
  try {
    const completion = await openai.chat.completions.create(
      {
        model: env.CLAIM_CHECK_MODEL,
        max_tokens: CLASSIFIER_MAX_TOKENS,
        temperature: 0,
        messages: [
          { role: 'system', content: MEMORY_GROUNDING_SYSTEM_PROMPT },
          {
            role: 'user',
            content: `THE USER'S ACTUAL MESSAGE:\n"""\n${sourceText}\n"""\n\nTHE CLAIMED FACT ABOUT THEM:\n"""\n${content}\n"""`,
          },
        ],
      },
      { signal: controller.signal },
    );
    const answer = completion.choices[0]?.message?.content?.trim().toUpperCase() ?? '';
    return answer.startsWith('YES');
  } catch (err) {
    logger.warn({ err }, 'memory grounding check failed — dropping the memory rather than risk an ungrounded write');
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

// The MIRROR of CLASSIFIER_SYSTEM_PROMPT, for the opposite failure. The
// claim-check above only ever runs on turns where NOTHING happened, so for
// the whole life of this app the reverse case has gone unchecked: a turn
// where something really DID happen and the reply hides it. Measured at 3 of
// 36 action turns (8.3%) across two models, and a prompt rule alone did not
// move it (still 1 in 15 after the results block was reworded) — same lesson
// as the false-claim path, which is why that one has a classifier too.
//
// Why it matters, in the app's own terms: "already done — you're good" about
// a task Meroa just completed reads to the user as "nothing changed, it was
// like that before." They don't learn that their data was touched. The
// severe version was live on July 13: an undo really reverted a completed
// task while the reply said "nothing got deleted."
// SCOPED DOWN after it fired on 61 live turns — roughly every fourth action —
// and made the app look broken. The first version treated the WORD "already" as
// concealment, but flash uses it as a discourse marker meaning "consider it
// handled": "Already got you — 'Feed the dogs' is set for tomorrow at 10 AM 🐶",
// said on the very turn it created the task. That is not a lie, it is idiom, and
// appending "To be clear though — I just did that now" to it is pedantic noise.
//
// The line that actually matters: THE ACTION CARD IS ALWAYS RENDERED ABOVE THE
// REPLY. The user can see "Feed the dogs · 10:00 AM tomorrow" sitting there. So
// a casual "already got you" cannot mislead anyone into thinking nothing
// happened — the screen contradicts it. What DOES harm is a reply that denies or
// contradicts the card, because then the user has to decide which to believe:
// "Just canceled the removal cards — nothing got deleted" while an undo really
// reverted a completed task (the live bug this guard exists for).
//
// So: concealment is DENIAL, not casualness. Only fire when the words fight the
// card.
const CONCEALMENT_SYSTEM_PROMPT = `An AI assistant JUST performed an action on the user's data — in this very reply, seconds ago. You will be shown (1) the server's authoritative record of what it did (this is also displayed to the user as a CARD, directly above the reply, so they can see it), and (2) what the assistant told the user.

Answer with exactly YES or NO: does the reply CONTRADICT or DENY what the card says happened?

YES — only when the words fight the card, so a user reading both would be confused about whether anything changed:
- denying the change: "nothing got deleted" / "nothing was changed" (when something was), "no record of any action to undo" (when an undo just ran), "I didn't actually mark it done" (when it did).
- describing a DIFFERENT action than the one that happened: the card says it undid a task completion, the reply says it restored a deleted task.
- substituting a harmless-sounding non-event for the real change, so the user never learns what actually happened — even if every word is technically true. Example: the card says 'Undid the last change to "Buy milk" — now marked open' (a task the user had COMPLETED was un-completed), and the reply says "Just canceled the removal cards — nothing got deleted." Nothing was deleted, true. But the reply never tells them their completed task was reverted, and talks about something else instead. Answer YES: technically-true wording that still leaves the user with a false picture of what changed to their data is exactly the failure this catches.
- explicitly claiming the thing predates the request, in a way that erases this turn's action: "that was already on your list from before you asked", "that card was already up from earlier".

NO — everything else. In particular, CASUAL CONFIRMATION IS NOT CONCEALMENT. "Already got you", "already done", "already on it", "already taken care of", "you're all set", "done ✅", "there you go" are ordinary ways of saying "handled" — the user sees the card, so these are honest, and they must be answered NO. Phrasing, tone, brevity and emoji are irrelevant.

Also NO — the reply correctly describes the action and separately mentions genuinely pre-existing state ("logged it — you're already at $5 of $300").

Also NO — a tap-to-confirm card that has not been tapped: saying nothing has changed YET is simply true.

The single test: would a user who reads the reply AND sees the card come away believing the assistant did NOT just do what the card says? Only then is it YES. If the reply is merely casual, breezy, or uses the word "already" while still conveying that it is handled, answer NO.`;

// The THIRD failure class, and the one both existing guards are blind to.
// didClaimAction catches "said it happened when it didn't". didConcealAction
// catches "it happened and the reply hid it". Neither looks at whether the
// NUMBERS are right — so a reply can be perfectly honest about what it did and
// still lie about the user's money. Observed live on a no-action turn: "so that
// $5 is logged and counted toward the bike. You're at $10 total now" — the real
// total was $5. The claim-check passed it (correctly: no action was claimed),
// and the user was told their savings were double what they are.
//
// This is the app's central rule ("never invent a number" — CLAUDE.md §2, and
// the lesson-6/16 discipline of computing every figure server-side and having
// the model QUOTE it), and until now nothing enforced it at the output boundary.
//
// The judgment is genuinely subtle, which is why it needs a model and not a
// comparison: a figure absent from the facts can still be correct if it was
// derived from them ("$295 to go" from "$5 / $300"), and the app is full of
// legitimate numbers that never appear verbatim in the state block — times,
// dates, ordinals, counts. Only a figure that is actually WRONG counts.
const FIGURE_SYSTEM_PROMPT = `You are given (1) the COMPLETE set of authoritative facts an AI assistant had when it wrote a reply — the live state of the user's tasks and goals, plus anything the server did this turn — and (2) the reply itself.

Every number the assistant states about the user's tasks, goals, money, counts, streaks or progress must be true given those facts. Answer with exactly YES or NO: does the reply state any FIGURE that is WRONG or unsupported by the facts?

YES — a number in the reply contradicts the facts, or is invented outright. Examples, given facts showing a savings goal at $5 of $300: "you're at $10 total" (wrong — it is $5), "that's your 6th day in a row" when the streak is 2, "you've got 4 tasks left" when 2 are open. The test is whether a user reading this would come away believing something false about their own numbers.

NO — every figure is consistent with the facts. This includes:
- figures quoted straight from the facts ("$5 / $300", "3rd time this week"),
- figures correctly DERIVED from them ("$295 to go" when the goal is $5 of $300; "just 2 left" when 4 of 6 are done) — arithmetic that checks out is fine,
- times, dates and days ("due at 11:59 PM", "Friday"),
- numbers the USER themselves just stated, echoed back,
- ordinary prose numbers with no factual claim ("one sec", "a couple of things", "day one").

If a figure is merely absent from the facts but is not actually wrong, answer NO. Only answer YES when a number is genuinely false.`;

/**
 * Did the reply state a figure that is wrong? The third guard, alongside
 * didClaimAction (false claims) and didConcealAction (denials). Fail-open like
 * the others — a missed catch is cheaper than blocking a reply on a round trip.
 * Gated in providers/shared.ts on a cheap deterministic check (does the reply
 * contain any number that does NOT appear in the facts at all), so this only
 * runs on turns where a fabrication is even possible.
 */
export async function didMisstateFigure(segments: string[], groundingFacts: string): Promise<boolean> {
  const text = segments.join(' ').trim();
  if (!text || !groundingFacts.trim()) return false;

  const openai = getClient();
  if (!openai) return false;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CLASSIFIER_TIMEOUT_MS);
  try {
    const completion = await openai.chat.completions.create(
      {
        model: env.CLAIM_CHECK_MODEL,
        max_tokens: CLASSIFIER_MAX_TOKENS,
        temperature: 0,
        messages: [
          { role: 'system', content: FIGURE_SYSTEM_PROMPT },
          {
            role: 'user',
            content: `THE AUTHORITATIVE FACTS:\n"""\n${groundingFacts}\n"""\n\nTHE ASSISTANT'S REPLY:\n"""\n${text}\n"""`,
          },
        ],
      },
      { signal: controller.signal },
    );
    const answer = completion.choices[0]?.message?.content?.trim().toUpperCase() ?? '';
    return answer.startsWith('YES');
  } catch (err) {
    logger.warn({ err }, 'figure-check classifier call failed — treating as no misstatement');
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Did the reply conceal an action that really happened? Counterpart to
 * didClaimAction — same lazy client, same timeout, same fail-open behavior (a
 * missed catch is far cheaper than blocking a reply on an extra round trip).
 * Only called when the free regex in providers/shared.ts has already flagged
 * pre-existing/denial phrasing on a turn that DID act, so this runs on a small
 * minority of turns rather than on every action.
 */
export async function didConcealAction(segments: string[], actionFacts: string[]): Promise<boolean> {
  const text = segments.join(' ').trim();
  if (!text || !actionFacts.length) return false;

  const openai = getClient();
  if (!openai) return false;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CLASSIFIER_TIMEOUT_MS);
  try {
    const completion = await openai.chat.completions.create(
      {
        model: env.CLAIM_CHECK_MODEL,
        max_tokens: CLASSIFIER_MAX_TOKENS,
        temperature: 0,
        messages: [
          { role: 'system', content: CONCEALMENT_SYSTEM_PROMPT },
          {
            role: 'user',
            content: `What the server actually did this turn:\n"""\n${actionFacts.join('\n')}\n"""\n\nWhat the assistant told the user:\n"""\n${text}\n"""`,
          },
        ],
      },
      { signal: controller.signal },
    );
    const answer = completion.choices[0]?.message?.content?.trim().toUpperCase() ?? '';
    return answer.startsWith('YES');
  } catch (err) {
    logger.warn({ err }, 'concealment classifier call failed — treating as no concealment');
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
