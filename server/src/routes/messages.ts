import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';

import { db } from '../db/client.ts';
import { messages, users } from '../db/schema.ts';
import { streamChatReply, type ChatHistoryMessage } from '../lib/ai/chat.ts';
import { getOrCreateAppConversation, getRecentMessages } from '../lib/conversations.ts';
import { computeAllowance, withUserChatLock } from '../lib/usage.ts';
import { logger } from '../logger.ts';
import { requireAuth, type AuthVariables } from '../middleware/auth.ts';

export const messageRoutes = new Hono<{ Variables: AuthVariables }>();
messageRoutes.use('*', requireAuth);

const listQuerySchema = z.object({
  cursor: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

messageRoutes.get('/', zValidator('query', listQuerySchema), async (c) => {
  const userId = c.get('userId');
  const { cursor, limit } = c.req.valid('query');
  const rows = await getRecentMessages(userId, limit ?? 50, cursor ? new Date(cursor) : undefined);
  return c.json({ messages: rows });
});

const sendSchema = z.object({ text: z.string().trim().min(1).max(4000) });

function isChatRole(role: string): role is 'user' | 'assistant' {
  return role === 'user' || role === 'assistant';
}

// Server-sent events on this stream:
//   user_message  — the persisted user message row (client reconciles its optimistic id)
//   delta         — { text } incremental text for the segment currently arriving
//   segment       — { message } a persisted assistant message row (one "text" of a
//                   possibly multi-bubble reply); more may follow
//   stream_end    — the whole reply is done; no further segments
//   error         — { retryable, message } — the in-flight segment was not persisted;
//                   any earlier segments in this turn already were
messageRoutes.post('/', zValidator('json', sendSchema), async (c) => {
  const userId = c.get('userId');
  const { text } = c.req.valid('json');

  const conversation = await getOrCreateAppConversation(userId);

  // The allowance check and the user-message insert must be atomic, or two
  // concurrent sends can both read "under limit" before either commits and
  // both get through — bypassing the cap. withUserChatLock holds a Postgres
  // advisory lock (keyed on userId) for the duration of this transaction,
  // serializing concurrent sends from the *same* user (other users' requests
  // aren't blocked) — same pattern as the OTP rate limit in auth.ts.
  const result = await withUserChatLock(userId, async (tx) => {
    const allowance = await computeAllowance(tx, userId);
    if (!allowance.allowed) return { limited: true as const, allowance };

    const [userMessage] = await tx
      .insert(messages)
      .values({ conversationId: conversation.id, role: 'user', content: text })
      .returning();
    if (!userMessage) throw new Error('message_insert_failed');
    return { limited: false as const, userMessage };
  });

  if (result.limited) {
    return c.json({ error: 'limit_reached', plan: result.allowance.plan, limit: result.allowance.limit }, 429);
  }
  const { userMessage } = result;

  const [user] = await db
    .select({ displayName: users.displayName, timezone: users.timezone })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  // Includes the message just inserted above, and merges the sms-channel
  // continuity history (Phase 1) chronologically with the app channel.
  const history = await getRecentMessages(userId, 50);
  const chatHistory: ChatHistoryMessage[] = history
    .filter((m): m is typeof m & { role: 'user' | 'assistant' } => isChatRole(m.role))
    .map((m) => ({ role: m.role, content: m.content }));

  return streamSSE(c, async (stream) => {
    await stream.writeSSE({ event: 'user_message', data: JSON.stringify(userMessage) });

    // Hono's streamSSE only console.errors an uncaught throw — it never
    // notifies the client. Without this try/catch, a DB error mid-segment
    // (rare, but possible) would leave the client's typing indicator hanging
    // forever with no error and no retry path.
    try {
      for await (const event of streamChatReply(chatHistory, user ?? { displayName: null, timezone: null })) {
        if (event.type === 'delta') {
          await stream.writeSSE({ event: 'delta', data: JSON.stringify({ text: event.text }) });
        } else if (event.type === 'segment_end') {
          const [assistantMessage] = await db
            .insert(messages)
            .values({ conversationId: conversation.id, role: 'assistant', content: event.text })
            .returning();
          await stream.writeSSE({ event: 'segment', data: JSON.stringify({ message: assistantMessage }) });
        } else if (event.type === 'stream_end') {
          await stream.writeSSE({ event: 'stream_end', data: JSON.stringify({}) });
        } else {
          await stream.writeSSE({
            event: 'error',
            data: JSON.stringify({ retryable: event.retryable, message: event.message }),
          });
        }
      }
    } catch (err) {
      logger.error(err, 'chat stream failed');
      await stream.writeSSE({
        event: 'error',
        data: JSON.stringify({ retryable: false, message: 'Something went wrong on my end.' }),
      });
    }
  });
});
