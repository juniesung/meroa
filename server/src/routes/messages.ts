import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';

import { db } from '../db/client.ts';
import { messages, users } from '../db/schema.ts';
import { streamChatReply, type ChatHistoryMessage } from '../lib/ai/chat.ts';
import { buildTaskContext } from '../lib/ai/task-context.ts';
import { getOrCreateAppConversation, getRecentMessages } from '../lib/conversations.ts';
import { materializeRecurringInstances } from '../lib/tasks/recurrence.ts';
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

// task_action / task_removal_pending messages store a templated confirmation
// sentence as their `content`, for display and as an SMS-channel fallback.
// A first attempt at this replaced that sentence with a compact bracket
// marker (e.g. `[create_task → "Feed cats"]`) instead of the full sentence,
// on the theory that something structurally un-prose-like couldn't be
// mistaken for freely-generated reply text. Observed in practice: it still
// got copied verbatim into a real reply on a turn where no tool was called
// — the model doesn't reliably treat "looks different from prose" as "never
// repeat this," so *any* fixed, repeated shape in its own history is a
// template risk, not just a natural-sounding one.
//
// So these are dropped from model-visible history entirely instead — an
// empty string here gets filtered out downstream (chat.ts's `windowed`
// filter drops empty-content entries). The model doesn't lose the
// information: buildTaskContext re-derives current task state fresh on
// every turn regardless of history, and the model's own immediately-
// following natural-language reply (a genuine, separately-stored message)
// still carries the conversational continuity.
function historyContentFor(m: { content: string; meta: unknown }): string {
  const meta = m.meta as { kind?: string } | null;
  if (meta?.kind === 'task_action' || meta?.kind === 'task_removal_pending') return '';
  return m.content;
}

// Server-sent events on this stream:
//   user_message  — the persisted user message row (client reconciles its optimistic id)
//   delta         — { text } incremental text for the segment currently arriving
//   segment       — { message } a persisted assistant message row (one "text" of a
//                   possibly multi-bubble reply); more may follow
//   action        — { message, task } a task action executed (create/edit/complete/
//                   postpone/remove/undo); the client renders `message` as a task card
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
    return c.json(
      { error: 'limit_reached', plan: result.allowance.plan, limit: result.allowance.limit },
      429,
    );
  }
  const { userMessage } = result;

  const [user] = await db
    .select({ displayName: users.displayName, timezone: users.timezone })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const userContext = user ?? { displayName: null, timezone: null };

  // Includes the message just inserted above, and merges the sms-channel
  // continuity history (Phase 1) chronologically with the app channel.
  const history = await getRecentMessages(userId, 50);
  const chatHistory: ChatHistoryMessage[] = history
    .filter((m): m is typeof m & { role: 'user' | 'assistant' } => isChatRole(m.role))
    .map((m) => ({ role: m.role, content: historyContentFor(m) }));

  // The AI action layer needs a settled, up-to-date task list to reference
  // real ids and see today's recurring instances.
  await materializeRecurringInstances(userId, userContext.timezone, db);
  const taskContext = await buildTaskContext(userId, userContext.timezone);

  return streamSSE(c, async (stream) => {
    await stream.writeSSE({ event: 'user_message', data: JSON.stringify(userMessage) });

    // Hono's streamSSE only console.errors an uncaught throw — it never
    // notifies the client. Without this try/catch, a DB error mid-segment
    // (rare, but possible) would leave the client's typing indicator hanging
    // forever with no error and no retry path.
    try {
      for await (const event of streamChatReply(chatHistory, userContext, taskContext, {
        userId,
        timezone: userContext.timezone,
        sourceMessageId: userMessage.id,
      })) {
        if (event.type === 'delta') {
          await stream.writeSSE({ event: 'delta', data: JSON.stringify({ text: event.text }) });
        } else if (event.type === 'segment_end') {
          const [assistantMessage] = await db
            .insert(messages)
            .values({ conversationId: conversation.id, role: 'assistant', content: event.text })
            .returning();
          await stream.writeSSE({
            event: 'segment',
            data: JSON.stringify({ message: assistantMessage }),
          });
        } else if (event.type === 'action') {
          // remove_task doesn't delete outright — it comes back with
          // recordKind: 'task_removal_pending' so the client renders a
          // Confirm/Cancel card instead of a read-only one.
          const kind = event.recordKind === 'task_removal_pending' ? 'task_removal_pending' : 'task_action';
          const [assistantMessage] = await db
            .insert(messages)
            .values({
              conversationId: conversation.id,
              role: 'assistant',
              content: event.summary,
              meta: {
                kind,
                action: event.toolName,
                taskId: event.task.id,
                task: event.task,
              },
            })
            .returning();
          await stream.writeSSE({
            event: 'action',
            data: JSON.stringify({ message: assistantMessage, task: event.task }),
          });
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
