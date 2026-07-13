import { env } from '../../env.ts';
import type { ChatUserContext } from './system-prompt.ts';
import { streamChatReplyAnthropic } from './providers/anthropic.ts';
import { streamChatReplyDeepseek } from './providers/deepseek.ts';
import { streamChatReplyOpenai } from './providers/openai.ts';
import type { ChatActionContext, ChatHistoryMessage, ChatStreamEvent } from './providers/shared.ts';

export type { ChatActionContext, ChatHistoryMessage, ChatStreamEvent };

/**
 * Streams a reply from the configured AI provider (env.AI_PROVIDER) given
 * the conversation so far (must already include the user's just-sent
 * message). Meroa may send a reply as several separate "texts" (CLAUDE.md's
 * iMessage feel) — signaled by a blank line in the model's output — and may
 * call task tools (the AI action layer), each producing an `action` event
 * with the affected task. Consumers get `delta` events for the segment
 * currently arriving, `segment_end` once a segment is complete, `action`
 * when a tool call executes, and `stream_end` once the whole turn is done.
 * Never throws — always terminates in `stream_end` or `error`.
 */
export function streamChatReply(
  history: ChatHistoryMessage[],
  user: ChatUserContext,
  tailText: string,
  // What the REPLY pass sees — the same state block minus the recent-changes
  // feed and undo target, which are grounding for the action pass and unprompted
  // announcements in the reply. See routes/messages.ts.
  narrateTailText: string,
  // Just the clock — the state block a pure-conversation reply gets.
  conversationTailText: string,
  actionCtx: ChatActionContext,
): AsyncGenerator<ChatStreamEvent> {
  if (env.AI_PROVIDER === 'openai') return streamChatReplyOpenai(history, user, tailText, actionCtx, narrateTailText, conversationTailText);
  if (env.AI_PROVIDER === 'deepseek') return streamChatReplyDeepseek(history, user, tailText, actionCtx, narrateTailText, conversationTailText);
  return streamChatReplyAnthropic(history, user, tailText, actionCtx);
}
