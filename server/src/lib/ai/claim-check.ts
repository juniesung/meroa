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
const CLASSIFIER_SYSTEM_PROMPT = `You will be shown a message an AI assistant sent to its own user, inside an app for tracking tasks and goals (savings goals, and their linked tasks). The assistant made zero tool calls this turn — nothing was created, completed, edited, removed, postponed, logged, saved, or shown as a preview just now, no matter how the message reads. Answer with exactly YES or NO: does the message's wording falsely read as though something WAS just created, completed, edited, removed, postponed, logged, saved, or shown as a preview/card THIS turn?

YES — the wording asserts or strongly implies a change (or a preview being shown) just happened in this reply, even if softened or paired with a caveat. Examples: "Added your task", "Marked it done", "Removing it now", "I'll remove the goal for you, just a moment!" (reads as already in motion), "Set for tomorrow at 2pm with a reminder" (claims a specific new detail was configured), "Sending a preview your way — tap Create" (claims a preview card was shown when create_goal was never called — describing a card that doesn't exist is the same lie as claiming a task was created), "Here's the card, take a look".

NO — the wording only references a task's or goal's state from *before* this reply (created in an earlier turn, already existing), explains a limitation, or offers a conditional choice about the future — without asserting anything changed or was shown just now. Examples: "That's already on your list — T1, tomorrow at 2pm" (referring to something from earlier, not this turn), "No reminder attached" (stating an absence, not a change), "I can remove it if you want" (conditional offer), "I didn't set a reminder and can't add one retroactively" (explicitly says nothing changed), "Which day did you mean?", "Want me to set up a preview for that?" (asking, not claiming one already exists).

Also NO — a status recap of what the USER already did in the app: summarizing which tasks are done or open, running totals, streaks, or progress ("You crushed it today — packing list all checked off, bench target hit, savings at $14/$120") describes existing state the user created through their own taps, not an action the ASSISTANT performed this turn. Past-tense completion language inside a recap of the user's day is NO, even when enthusiastic.

The test that matters: does this specific sentence claim the ASSISTANT changed or showed something THIS turn, or is it just describing tasks/goals (existing, absent, hypothetical, or the user's own activity) without claiming a fresh change of its own? Only YES for the former.`;

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
export async function didClaimAction(segments: string[]): Promise<boolean> {
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
          { role: 'user', content: `Assistant's message:\n"""\n${text}\n"""` },
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
const CONCEALMENT_SYSTEM_PROMPT = `An AI assistant JUST performed an action on the user's data — in this very reply, seconds ago. You will be shown (1) the server's authoritative record of what it did, and (2) what the assistant told the user.

Answer with exactly YES or NO: does the reply HIDE the fact that the assistant just did this — by presenting the fresh action as something that was already true, already handled, or done earlier; or by denying/omitting that anything changed at all?

YES — the reply passes off this turn's action as pre-existing or denies it. Examples (each said on a turn where the action genuinely just happened): "Already done — you're good", "That's already marked off", "The card's already up", "That's already on the card from earlier", "Nothing got deleted", "No change needed — you were already set". The test: would a user reading this believe the assistant did NOT just change anything?

NO — the reply conveys that the assistant did it, in any phrasing, however casual: "marked it done", "logged it", "done ✅", "there you go", "card's up — tap Create", "undid that". Enthusiasm, brevity, and emoji are all fine.

Also NO — the reply correctly describes the action AND separately mentions genuinely pre-existing state ("logged it — you're already at $5 of $300", "done; your streak was already 4 days"). Referring to prior state is not concealment, as long as this turn's action is itself owned.

Also NO — a tap-to-confirm card that hasn't been tapped: saying nothing has changed YET is truthful, because it hasn't. Only the card being SHOWN is the action, so "here's a card to confirm" is NO, while "that card was already up from before" is YES.

Only YES when the reply would leave the user thinking this turn's action didn't happen or wasn't the assistant's doing.`;

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
