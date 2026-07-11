import { and, desc, eq, lt } from 'drizzle-orm';

import { db } from '../db/client.ts';
import { conversations, messages } from '../db/schema.ts';

/**
 * The client only ever writes to the user's 'app'-channel conversation.
 * An 'sms'-channel conversation (pre-install continuity) is read-only from
 * here — it's populated by the seed script / a future SMS webhook (Phase 9).
 */
export async function getOrCreateAppConversation(userId: string) {
  // INSERT ... ON CONFLICT DO NOTHING (backed by a unique index on
  // (userId, channel)) instead of SELECT-then-INSERT: concurrent first
  // messages from the same user must not race into creating two 'app'
  // conversations. If this insert loses the race, the conflict means a row
  // already exists, so we just select it.
  const [created] = await db
    .insert(conversations)
    .values({ userId, channel: 'app' })
    .onConflictDoNothing({ target: [conversations.userId, conversations.channel] })
    .returning();
  if (created) return created;

  const [existing] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.userId, userId), eq(conversations.channel, 'app')))
    .limit(1);
  if (!existing) throw new Error('conversation_insert_failed');
  return existing;
}

/** Merges messages across every channel (app + sms) into one chronological history. */
export async function getRecentMessages(userId: string, limit = 50, before?: Date) {
  const conditions = [eq(conversations.userId, userId)];
  if (before) conditions.push(lt(messages.createdAt, before));

  const rows = await db
    .select({
      id: messages.id,
      conversationId: messages.conversationId,
      role: messages.role,
      content: messages.content,
      meta: messages.meta,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .innerJoin(conversations, eq(messages.conversationId, conversations.id))
    .where(and(...conditions))
    .orderBy(desc(messages.createdAt))
    .limit(limit);

  return rows.reverse();
}
