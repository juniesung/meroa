import OpenAI from 'openai';

import { env } from '../../env.ts';
import { logger } from '../../logger.ts';
import { didMisstateFigure } from '../ai/claim-check.ts';
import { applyStyleCasing, type VibePreset } from '../ai/system-prompt.ts';
import type { NotificationTrigger } from './triggers.ts';

const COMPOSE_TIMEOUT_MS = 6000;
// deepseek-v4-flash reasons before answering (emits reasoning_content first),
// so a tight budget would truncate before the actual line is written — same
// lesson as claim-check.ts's CLASSIFIER_MAX_TOKENS. Leave real headroom.
const COMPOSE_MAX_TOKENS = 400;

let client: OpenAI | null = null;
function getClient(): OpenAI | null {
  if (!env.DEEPSEEK_API_KEY) return null;
  if (!client) client = new OpenAI({ apiKey: env.DEEPSEEK_API_KEY, baseURL: 'https://api.deepseek.com' });
  return client;
}

// A notification is pure prose with no card beneath it to ground it (docs/chat-
// architecture.md §3) — so the discipline is stricter than chat, not looser:
// every number is handed to the model pre-computed, the model may only QUOTE,
// and the output is figure-guarded before it can ever be sent. No guilt, no
// urgency, no loss-aversion — that's both the product guardrail (CLAUDE.md §2:
// never encourage dependence) and what separates a friend from a nag.
const SYSTEM_PROMPT = `You are Meroa, a warm, familiar AI friend. Write ONE push notification to gently pull the user back or cheer them on.

Hard rules:
- Sound like a friend texting, not an app alerting. Short — 12 words or fewer, one idea.
- Quote every number EXACTLY as it appears in the facts. Never change, round, combine, or invent a number. If the facts have no number, use none.
- Never guilt, pressure, or use loss-aversion. Do NOT say things like "don't lose your streak", "you'll fall behind", "last chance". Encourage, don't scare.
- No hashtags, no quotation marks around the message, no emoji spam (one at most, only if it fits).
- If a personal detail is provided, you may reference it naturally — but never add specifics that aren't there.

Output ONLY the message text, nothing else.`;

/**
 * Composes the notification body from the trigger's grounded facts, then gates
 * it: any figure the model got wrong (or an empty/failed/absent completion)
 * drops the AI copy and returns the deterministic template instead. The result
 * is self-healing — a bad generation degrades to a safe, correct line rather
 * than sending something false. Chill-preset users get the line lowercased at
 * the boundary (applyStyleCasing), the same guarantee-in-code the chat pass uses.
 */
export async function composeNotificationBody(
  trigger: NotificationTrigger,
  style: VibePreset | undefined,
): Promise<string> {
  const openai = getClient();
  if (!openai) return trigger.templateBody;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), COMPOSE_TIMEOUT_MS);
  try {
    const completion = await openai.chat.completions.create(
      {
        model: env.DEEPSEEK_MODEL,
        max_tokens: COMPOSE_MAX_TOKENS,
        temperature: 0.7,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: `Tone preset: ${style ?? 'balanced'}\n\nFACTS (quote any number EXACTLY; never invent one):\n"""\n${trigger.facts}\n"""\n\nWrite the notification now.`,
          },
        ],
      },
      { signal: controller.signal },
    );
    let text = completion.choices[0]?.message?.content?.trim() ?? '';
    // Strip any wrapping quotes the model added despite the instruction.
    text = text.replace(/^["'“”]+|["'“”]+$/g, '').trim();
    if (!text) return trigger.templateBody;

    // The hard gate: quote a figure wrong and the whole line is discarded.
    const misstated = await didMisstateFigure([text], trigger.facts);
    if (misstated) {
      logger.warn({ kind: trigger.kind }, 'composed notification failed figure guard — using template');
      return trigger.templateBody;
    }
    return applyStyleCasing(text, style);
  } catch (err) {
    logger.warn({ err, kind: trigger.kind }, 'notification compose failed — using template');
    return trigger.templateBody;
  } finally {
    clearTimeout(timeout);
  }
}
