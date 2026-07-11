import { zValidator } from '@hono/zod-validator';
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';

import { db } from '../db/client.ts';
import { records, tasks } from '../db/schema.ts';
import { requireAuth, type AuthVariables } from '../middleware/auth.ts';

export const taskRoutes = new Hono<{ Variables: AuthVariables }>();
taskRoutes.use('*', requireAuth);

taskRoutes.get('/', async (c) => {
  const userId = c.get('userId');
  const rows = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.userId, userId), isNull(tasks.deletedAt)))
    .orderBy(asc(tasks.status), desc(tasks.createdAt));
  return c.json({ tasks: rows });
});

// Minimal completion-type creation for Phase 1's "real, empty" Tasks tab.
// The full six-type model (checklist/counter/duration/etc.) is Phase 3.
const createSchema = z.object({
  title: z.string().trim().min(1).max(200),
  icon: z.string().optional(),
  dueAt: z.string().datetime().optional(),
});

taskRoutes.post('/', zValidator('json', createSchema), async (c) => {
  const userId = c.get('userId');
  const { title, icon, dueAt } = c.req.valid('json');

  const [task] = await db
    .insert(tasks)
    .values({
      userId,
      type: 'completion',
      title,
      icon: icon ?? null,
      dueAt: dueAt ? new Date(dueAt) : null,
    })
    .returning();
  if (!task) throw new Error('task_insert_failed');

  return c.json({ task }, 201);
});

taskRoutes.post('/:id/toggle', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');

  // Concurrent toggles on the same task must serialize: SELECT ... FOR UPDATE
  // locks the row for the transaction's duration, so a second concurrent
  // request blocks until the first commits, then sees the fresh status
  // instead of racing on a stale read (which previously created duplicate,
  // orphaned `records` rows never linked back to the task).
  const result = await db.transaction(async (tx) => {
    const [task] = await tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, id), eq(tasks.userId, userId), isNull(tasks.deletedAt)))
      .for('update')
      .limit(1);
    if (!task) return { status: 404 as const, body: { error: 'not_found' } };

    if (task.status === 'open') {
      const [record] = await tx
        .insert(records)
        .values({
          userId,
          kind: 'task_completion',
          payload: { taskId: task.id, title: task.title },
          source: 'tasks_ui',
        })
        .returning();
      if (!record) throw new Error('record_insert_failed');

      const [updated] = await tx
        .update(tasks)
        .set({ status: 'done', completedRecordId: record.id })
        .where(eq(tasks.id, task.id))
        .returning();
      return { status: 200 as const, body: { task: updated } };
    }

    if (task.status === 'done') {
      // Undo: revert (never delete) the completion record and reopen the task.
      if (task.completedRecordId) {
        await tx
          .update(records)
          .set({ revertedAt: new Date() })
          .where(eq(records.id, task.completedRecordId));
      }
      const [updated] = await tx
        .update(tasks)
        .set({ status: 'open', completedRecordId: null })
        .where(eq(tasks.id, task.id))
        .returning();
      return { status: 200 as const, body: { task: updated } };
    }

    return { status: 400 as const, body: { error: 'invalid_status' } };
  });

  return c.json(result.body, result.status);
});
