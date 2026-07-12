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
const CLASSIFIER_SYSTEM_PROMPT = `You will be shown a message an AI assistant sent to its own user, inside an app for tracking tasks and long-term trackers/tools (savings goals, workout logs, habits). The assistant made zero tool calls this turn — nothing was created, completed, edited, removed, postponed, logged, or saved just now, no matter how the message reads. Answer with exactly YES or NO: does the message's wording falsely read as though something WAS just created, completed, edited, removed, postponed, logged, or saved THIS turn — a task action OR a tool/tracker action (creating a tool, logging an entry, editing a tool's fields or target)?

YES — the wording asserts or strongly implies a change just happened in this reply, even if softened or paired with a caveat. Examples: "Added your task", "Marked it done", "Removing it now", "I'll remove the pushups tracker for you, just a moment!" (reads as already in motion), "Set for tomorrow at 2pm with a reminder" (claims a specific new detail was configured).

NO — the wording only references a task's state from *before* this reply (created in an earlier turn, already existing), explains a limitation, or offers a conditional choice about the future — without asserting anything changed just now. Examples: "That's already on your list — T1, tomorrow at 2pm" (referring to something from earlier, not this turn), "No reminder attached" (stating an absence, not a change), "I can remove it if you want" (conditional offer), "I didn't set a reminder and can't add one retroactively" (explicitly says nothing changed), "Which day did you mean?".

The test that matters: does this specific sentence claim something happened THIS turn, or is it just talking about a task (existing, absent, or hypothetical) without claiming a fresh change? Only YES for the former.`;

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
