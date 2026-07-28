import OpenAI from 'openai';

import { env } from '../../env.ts';

// Shared client + params for the non-conversational AI calls — the claim-check
// guards (claim-check.ts), the memory extractor (memory-extractor.ts), and the
// notification composers (compose.ts, proactive-message.ts).
//
// These used to hit DeepSeek directly (cheapest ~classifier calls), independent
// of AI_PROVIDER. That was a privacy hole: the extractor sends RAW user
// messages, and DeepSeek's API may train on + retain content in the PRC
// (verified 2026-07-26). Routing them through OpenAI here closes it — user data
// for every AI call now goes to the same no-train-by-default provider.
//
// Returns null (→ callers degrade to regex-only / template output, exactly as
// they did when DEEPSEEK_API_KEY was unset) if there's no OpenAI key.
let client: OpenAI | null = null;
export function getUtilityClient(): OpenAI | null {
  if (!env.OPENAI_API_KEY) return null;
  // Explicit client timeout in addition to the per-call AbortControllers the
  // callers already set — belt and suspenders against the SDK's 10-min default.
  if (!client) client = new OpenAI({ apiKey: env.OPENAI_API_KEY, timeout: 20_000 });
  return client;
}

export const UTILITY_MODEL = env.UTILITY_MODEL;

// Completion params for a utility call. GPT-5 reasoning models reject
// `temperature`, require `max_completion_tokens` (not `max_tokens`), and accept
// `reasoning_effort` — these are near-classifier tasks, so keep it 'minimal'
// (fast, cheap, and it doesn't eat the token budget on hidden reasoning). Spread
// into `chat.completions.create({ model: UTILITY_MODEL, ...utilityParams(n) })`.
export function utilityParams(maxOut: number): {
  max_completion_tokens: number;
  reasoning_effort: 'minimal';
} {
  return { max_completion_tokens: maxOut, reasoning_effort: 'minimal' };
}
