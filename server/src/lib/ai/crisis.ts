import { logger } from '../../logger.ts';
import { getUtilityClient, UTILITY_MODEL, utilityParams } from './utility-client.ts';

// The crisis protocol (CA SB 243 / NY GBL §1700). Two stages so it's both
// reliable and precise:
//   1. A cheap keyword PRE-FILTER (high recall) — runs on every user message,
//      no model call. Most turns don't match and cost nothing.
//   2. A gpt-5-nano CONFIRM (high precision) — only when the pre-filter matches,
//      it decides genuine self-directed risk vs. figurative/idiomatic use ("this
//      deadline is killing me", "kill me now" as exasperation, venting, or
//      talking about someone else). This is what lets us REPLACE the reply
//      (routes/messages.ts) without clobbering ordinary messages.
// If the confirm errors/times out, we FAIL SAFE (treat as crisis): a matched
// crisis phrase we can't classify should surface resources, not be dropped. And
// anything the detector misses still lands on the model's own handling, which
// red-teamed strong (warm, 988, refuses roleplay/story bypasses) — defense in
// depth. Detection is deterministic-enough to be a real protocol; the RESPONSE
// is fully deterministic (a fixed server string, never model-generated, so no
// output guard can touch it).

// High-recall, deliberately broad. Precision is the classifier's job (below).
const CRISIS_PREFILTER =
  /\b(kill(ing)?\s+(myself|me)|end(ing)?\s+(my\s+life|it\s+all|myself)|take\s+my\s+(own\s+)?life|want(ing)?\s+to\s+die|wanna\s+die|don'?t\s+want\s+to\s+(live|be\s+here|wake\s+up|exist|be\s+alive)|better\s+off\s+(dead|without\s+me)|no\s+(reason|point)\s+(to|in)\s+(living|life|go(ing)?\s+on|being\s+here)|suicid|self[-\s]?harm|harm(ing)?\s+myself|hurt(ing)?\s+myself|cut(ting)?\s+myself|\bkms\b|off\s+myself|end\s+the\s+pain|can'?t\s+go\s+on\s+(anymore|any\s+longer)|not\s+worth\s+living)\b/i;

export function looksLikeCrisis(text: string): boolean {
  return CRISIS_PREFILTER.test(text);
}

const CRISIS_CLASSIFIER_TIMEOUT_MS = 6000;

const CRISIS_CLASSIFIER_PROMPT = `You screen a chat message for a self-harm/suicide crisis. Answer with exactly YES or NO.

YES — the person is expressing genuine suicidal thoughts, intent to end their own life, or intent to seriously harm themselves (now or ongoing). Includes clear oblique forms: "everyone would be better off without me", "I don't want to be here anymore", "I want it all to stop" said about their own life, asking how to end their life.

NO — figurative or idiomatic use with no real self-directed risk: "this deadline is killing me", "I'd kill for a coffee", "kill me now"/"ugh just end me" as exasperation, "that movie killed me", venting frustration or being dramatic, discussing suicide about someone ELSE or in the abstract/news, or song lyrics.

When it is genuinely ambiguous whether the person means real self-harm, answer YES.`;

// Only call this when looksLikeCrisis() already matched.
export async function confirmCrisis(text: string): Promise<boolean> {
  const openai = getUtilityClient();
  // No classifier available → fail safe on a pre-filter match.
  if (!openai) return true;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CRISIS_CLASSIFIER_TIMEOUT_MS);
  try {
    const completion = await openai.chat.completions.create(
      {
        model: UTILITY_MODEL,
        ...utilityParams(400),
        messages: [
          { role: 'system', content: CRISIS_CLASSIFIER_PROMPT },
          { role: 'user', content: `MESSAGE:\n"""\n${text}\n"""` },
        ],
      },
      { signal: controller.signal },
    );
    const answer = completion.choices[0]?.message?.content?.trim().toUpperCase() ?? '';
    // Fail safe: only a clear NO suppresses the crisis response.
    return !answer.startsWith('NO');
  } catch (err) {
    logger.warn({ err }, 'crisis classifier call failed — failing safe (treating as crisis)');
    return true;
  } finally {
    clearTimeout(timeout);
  }
}

// Full detector: cheap pre-filter first, model confirm only on a match.
export async function detectCrisis(text: string): Promise<boolean> {
  if (!looksLikeCrisis(text)) return false;
  return confirmCrisis(text);
}

// The FIXED response — deterministic, never model-generated. Sent as separate
// bursts (each its own message bubble). Numbers here are server-authored, so no
// output guard runs on them (and the figure guard is whitelisted on these anyway,
// see providers/shared.ts CRISIS_SAFE_NUMBERS).
export const CRISIS_RESPONSE: string[] = [
  "hey, i'm really glad you told me, and i want to take this seriously with you. you don't have to go through it alone.",
  "i'm an AI, so i can't be the one to keep you safe, but people who can are available right now:\n\n• Call or text 988 — the Suicide & Crisis Lifeline (US), 24/7\n• Text HOME to 741741 — the Crisis Text Line\n• If you're in immediate danger, please call 911",
  "if you can, reach out to one of those, or tell someone near you what you're feeling. they're there for exactly this. i'm still here with you too.",
];
