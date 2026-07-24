import OpenAI from 'openai';

import { env } from '../../env.ts';
import { logger } from '../../logger.ts';
import { didMisstateFigure } from '../ai/claim-check.ts';
import { DEFAULT_TONE, type ToneLevel } from '../ai/system-prompt.ts';
import type { NotificationTrigger } from './triggers.ts';

const COMPOSE_TIMEOUT_MS = 8000;
// deepseek-v4-flash emits reasoning_content before the answer, so leave real
// headroom or the actual line gets truncated — same lesson as compose.ts.
const COMPOSE_MAX_TOKENS = 600;

let client: OpenAI | null = null;
function getClient(): OpenAI | null {
  if (!env.DEEPSEEK_API_KEY) return null;
  if (!client) client = new OpenAI({ apiKey: env.DEEPSEEK_API_KEY, baseURL: 'https://api.deepseek.com' });
  return client;
}

// This composes the actual message Meroa drops into the chat thread when it
// reaches out first — NOT the 12-word push (that's compose.ts). It's real
// conversation, so it carries Meroa's voice, but it's still server-authored
// prose with no card under it (docs/chat-architecture.md §13), so the same
// discipline as a notification body applies, only stricter: every number is
// handed over pre-computed and may only be QUOTED, and the whole thing is
// figure-guarded before it can ever be persisted or shown.
const SYSTEM_PROMPT = `You are Meroa, a close AI friend texting someone you know — and this time YOU'RE texting THEM first, out of the blue. They didn't message you; you're reaching out because a real friend does that.

Your voice:
- You have a personality: opinions, dry humor, a little bite. You're warm but you're not a suck-up, and you don't do hollow cheerleading.
- When it's about something they said they'd do and haven't, call it out plainly — name the pattern, not their character ("that's the third time this has slid, what's the actual blocker?"), and point at a real next step. This comes from being in their corner, never from nagging or guilt.
- When it's just a check-in or a follow-up on their life, be easy and genuinely curious — like remembering to ask how the thing went.

Hard rules:
- Text like a person, not an app. A couple of short texts, not a paragraph. If you have two beats (a reaction, then the point), split them with ONE blank line so each is its own text. Keep it brief.
- Quote every number EXACTLY as it appears in the facts. Never change, round, combine, or invent a number, a name, or a detail. If the facts give you no number, use none.
- NEVER guilt, pressure, or use loss-aversion. No "don't lose your streak", "you're falling behind", "last chance". You're a friend, not a nag.
- This is a follow-through/banter nudge, so the edge is fine — but if the facts touch anything heavy or sensitive, drop the edge entirely and just be warm.
- No em dashes (a real person rarely types them). No hashtags, no quotation marks wrapping the message, at most one emoji and only if it truly fits.

Output ONLY the message text (one or two short texts, blank-line separated if two), nothing else.`;

// A one-line tone nudge per slider level — the chat opener bends to the user's
// warmth↔edge setting the same way a normal reply does (buildStyleBlock),
// without re-teaching the whole personality. Level 2 is the baseline (no nudge).
const TONE_HINT: Record<ToneLevel, string> = {
  0: 'Warmest setting: gentle and encouraging, no bite at all.',
  1: 'Warm and supportive, light on the edge.',
  2: '',
  3: 'Edgier: blunter and a little teasing.',
  4: 'Edgiest: sharp, dry, roast-y — but drop it all instantly if anything is heavy.',
};

/**
 * Composes the in-chat reach-out from the trigger's grounded facts, then gates
 * it: any figure the model got wrong (or an empty/failed generation) drops the
 * AI copy and returns the deterministic template instead — the same self-healing
 * fallback compose.ts uses, so a bad generation degrades to something correct
 * rather than persisting something false into the conversation.
 */
export async function composeProactiveMessage(
  trigger: NotificationTrigger,
  tone: ToneLevel | undefined,
): Promise<string> {
  const openai = getClient();
  if (!openai) return trigger.templateBody;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), COMPOSE_TIMEOUT_MS);
  try {
    const hint = TONE_HINT[tone ?? DEFAULT_TONE];
    const completion = await openai.chat.completions.create(
      {
        model: env.DEEPSEEK_MODEL,
        max_tokens: COMPOSE_MAX_TOKENS,
        temperature: 0.8,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: `${hint ? `Tone: ${hint}\n\n` : ''}FACTS (quote any number EXACTLY; never invent one):\n"""\n${trigger.facts}\n"""\n\nText them now.`,
          },
        ],
      },
      { signal: controller.signal },
    );
    let text = completion.choices[0]?.message?.content?.trim() ?? '';
    // Strip any wrapping quotes the model added despite the instruction.
    text = text.replace(/^["'“”]+|["'“”]+$/g, '').trim();
    if (!text) return trigger.templateBody;

    // The hard gate: quote a figure wrong and the whole message is discarded in
    // favor of the safe template. Split on blank lines so each burst is checked.
    const bursts = text.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
    const misstated = await didMisstateFigure(bursts, trigger.facts);
    if (misstated) {
      logger.warn({ kind: trigger.kind }, 'composed proactive message failed figure guard — using template');
      return trigger.templateBody;
    }
    return text;
  } catch (err) {
    logger.warn({ err, kind: trigger.kind }, 'proactive message compose failed — using template');
    return trigger.templateBody;
  } finally {
    clearTimeout(timeout);
  }
}
