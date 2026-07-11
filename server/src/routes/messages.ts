import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';

import { db } from '../db/client.ts';
import { messages } from '../db/schema.ts';
import { getOrCreateAppConversation, getRecentMessages } from '../lib/conversations.ts';
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

messageRoutes.post('/', zValidator('json', sendSchema), async (c) => {
  const userId = c.get('userId');
  const { text } = c.req.valid('json');

  const conversation = await getOrCreateAppConversation(userId);

  const [userMessage] = await db
    .insert(messages)
    .values({ conversationId: conversation.id, role: 'user', content: text })
    .returning();
  if (!userMessage) throw new Error('message_insert_failed');

  // Phase 1 placeholder acknowledgment — real model-backed replies
  // (streaming, personality, safety handling) arrive in Phase 2.
  const [assistantMessage] = await db
    .insert(messages)
    .values({
      conversationId: conversation.id,
      role: 'assistant',
      content: 'Got it — noted. (Real replies start in Phase 2.)',
    })
    .returning();
  if (!assistantMessage) throw new Error('message_insert_failed');

  return c.json({ messages: [userMessage, assistantMessage] });
});
