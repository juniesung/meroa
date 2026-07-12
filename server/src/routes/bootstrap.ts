import { and, desc, eq, isNull } from 'drizzle-orm';
import { Hono } from 'hono';

import { db } from '../db/client.ts';
import { entitlements, memories, tasks, goals, users } from '../db/schema.ts';
import { getOrCreateAppConversation, getRecentMessages } from '../lib/conversations.ts';
import { taskStatusOrder } from '../lib/task-order.ts';
import { materializeRecurringInstances } from '../lib/tasks/recurrence.ts';
import { requireAuth, type AuthVariables } from '../middleware/auth.ts';

export const bootstrapRoutes = new Hono<{ Variables: AuthVariables }>();
bootstrapRoutes.use('*', requireAuth);

// Continuity payload: everything a fresh app sign-in needs to hydrate the
// existing relationship in one round trip, so onboarding never repeats.
bootstrapRoutes.get('/', async (c) => {
  const userId = c.get('userId');

  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) return c.json({ error: 'not_found' }, 404);

  const [entitlement] = await db
    .select()
    .from(entitlements)
    .where(eq(entitlements.userId, userId))
    .limit(1);

  const conversation = await getOrCreateAppConversation(userId);
  const recentMessages = await getRecentMessages(userId, 50);

  await materializeRecurringInstances(userId, user.timezone, db);

  const memoryRows = await db
    .select()
    .from(memories)
    .where(
      and(eq(memories.userId, userId), eq(memories.suppressed, false), isNull(memories.deletedAt)),
    )
    .orderBy(desc(memories.createdAt))
    .limit(50);

  const taskRows = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.userId, userId), isNull(tasks.deletedAt)))
    .orderBy(taskStatusOrder, desc(tasks.createdAt));

  const goalRows = await db
    .select()
    .from(goals)
    .where(and(eq(goals.userId, userId), isNull(goals.archivedAt)))
    .orderBy(desc(goals.createdAt));

  return c.json({
    user: {
      id: user.id,
      phoneE164: user.phoneE164,
      displayName: user.displayName,
      timezone: user.timezone,
      prefs: user.prefs,
    },
    entitlement: entitlement
      ? { plan: entitlement.plan, expiresAt: entitlement.expiresAt }
      : { plan: 'free', expiresAt: null },
    conversationId: conversation.id,
    messages: recentMessages,
    memories: memoryRows,
    tasks: taskRows,
    goals: goalRows,
  });
});
