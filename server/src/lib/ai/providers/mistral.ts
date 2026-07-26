import OpenAI from 'openai';

import { env } from '../../../env.ts';
import { streamChatReplyActNarrate } from './act-narrate.ts';
import type { ChatActionContext, ChatHistoryMessage, ChatStreamEvent } from './shared.ts';
import type { ChatUserContext } from '../system-prompt.ts';

// Mistral's API is OpenAI-compatible (same Chat Completions shape, function
// calling, streaming tool-call fragments), so this reuses the `openai` SDK
// pointed at Mistral's base URL — the same trick the DeepSeek provider uses.
// Mistral Small 4 (`mistral-small-2603`) is the cost + privacy candidate: no
// training on API data, EU/GDPR-hosted, 30-day (or Zero-Data-Retention) — and
// it's a standard-param model (uses `max_tokens`, NOT the gpt-5 reasoning
// params), with its own reasoning on by default (which is what the act pass
// wants — see the DeepSeek provider's thinking-is-load-bearing note).
//
// apiKey may be undefined when another provider is active; the module still
// imports, and the client is only ever *used* when AI_PROVIDER=mistral, which
// env.ts's refine guarantees has a key.
const client = new OpenAI({ apiKey: env.MISTRAL_API_KEY, baseURL: 'https://api.mistral.ai/v1' });

/**
 * Mistral runs only the act/narrate split (the default, AI_ACT_NARRATE=on).
 * Empty per-pass extras: no provider-specific reasoning toggle to send, unlike
 * DeepSeek's `thinking` — Mistral Small 4 reasons by default. If the reply
 * quality or cost needs tuning, that's where a Mistral reasoning param would go.
 */
export async function* streamChatReplyMistral(
  history: ChatHistoryMessage[],
  user: ChatUserContext,
  tailText: string,
  actionCtx: ChatActionContext,
  narrateTailText: string = tailText,
  conversationTailText: string = narrateTailText,
  stateFactsText: string = tailText,
): AsyncGenerator<ChatStreamEvent> {
  yield* streamChatReplyActNarrate(
    client,
    env.MISTRAL_MODEL,
    'max_tokens',
    history,
    user,
    tailText,
    actionCtx,
    {},
    {},
    {},
    narrateTailText,
    conversationTailText,
    stateFactsText,
  );
}
