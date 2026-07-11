import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';

import { db } from '../db/client.ts';
import { tasks, users } from '../db/schema.ts';
import { requireAuth, type AuthVariables } from '../middleware/auth.ts';
import { taskStatusOrder } from '../lib/task-order.ts';
import { materializeRecurringInstances } from '../lib/tasks/recurrence.ts';
import {
  createTaskInputSchema,
  editTaskPatchSchema,
  postponeInputSchema,
  progressInputSchema,
} from '../lib/tasks/schema.ts';
import {
  completeTask,
  createTask,
  editTask,
  postponeTask,
  progressTask,
  removeTask,
  TaskActionError,
  undoLastAction,
} from '../lib/tasks/executor.ts';

export const taskRoutes = new Hono<{ Variables: AuthVariables }>();
taskRoutes.use('*', requireAuth);

async function getUserTimezone(userId: string): Promise<string | null> {
  const [user] = await db
    .select({ timezone: users.timezone })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return user?.timezone ?? null;
}

function actionErrorResponse(err: unknown): {
  status: 400 | 404;
  body: { error: string; message: string };
} {
  if (err instanceof TaskActionError) {
    const status = err.code === 'invalid_input' ? 400 : 404;
    return { status, body: { error: err.code, message: err.message } };
  }
  throw err;
}

taskRoutes.get('/', async (c) => {
  const userId = c.get('userId');
  const timezone = await getUserTimezone(userId);
  await materializeRecurringInstances(userId, timezone, db);

  const rows = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.userId, userId), isNull(tasks.deletedAt)))
    .orderBy(taskStatusOrder, desc(tasks.createdAt));
  return c.json({ tasks: rows });
});

taskRoutes.post('/', zValidator('json', createTaskInputSchema), async (c) => {
  const userId = c.get('userId');
  const input = c.req.valid('json');
  const timezone = await getUserTimezone(userId);
  try {
    const { task } = await createTask(userId, input, timezone, { source: 'tasks_ui' });
    return c.json({ task }, 201);
  } catch (err) {
    const { status, body } = actionErrorResponse(err);
    return c.json(body, status);
  }
});

taskRoutes.patch('/:id', zValidator('json', editTaskPatchSchema), async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const patch = c.req.valid('json');
  const timezone = await getUserTimezone(userId);
  try {
    const { task } = await editTask(userId, id, patch, timezone, { source: 'tasks_ui' });
    return c.json({ task });
  } catch (err) {
    const { status, body } = actionErrorResponse(err);
    return c.json(body, status);
  }
});

const completeSchema = z.object({
  value: z.number().optional(),
  itemIds: z.array(z.string()).optional(),
});

taskRoutes.post('/:id/complete', zValidator('json', completeSchema), async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const input = c.req.valid('json');
  try {
    const { task } = await completeTask(userId, id, input, { source: 'tasks_ui' });
    return c.json({ task });
  } catch (err) {
    const { status, body } = actionErrorResponse(err);
    return c.json(body, status);
  }
});

taskRoutes.post('/:id/progress', zValidator('json', progressInputSchema), async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const input = c.req.valid('json');
  try {
    const { task } = await progressTask(userId, id, input, { source: 'tasks_ui' });
    return c.json({ task });
  } catch (err) {
    const { status, body } = actionErrorResponse(err);
    return c.json(body, status);
  }
});

taskRoutes.post('/:id/postpone', zValidator('json', postponeInputSchema), async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const input = c.req.valid('json');
  const timezone = await getUserTimezone(userId);
  try {
    const { task } = await postponeTask(userId, id, input, timezone, { source: 'tasks_ui' });
    return c.json({ task });
  } catch (err) {
    const { status, body } = actionErrorResponse(err);
    return c.json(body, status);
  }
});

taskRoutes.delete('/:id', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  try {
    const { task } = await removeTask(userId, id, { source: 'tasks_ui' });
    return c.json({ task });
  } catch (err) {
    const { status, body } = actionErrorResponse(err);
    return c.json(body, status);
  }
});

taskRoutes.post('/undo', async (c) => {
  const userId = c.get('userId');
  try {
    const { task, action } = await undoLastAction(userId);
    return c.json({ task, action });
  } catch (err) {
    const { status, body } = actionErrorResponse(err);
    return c.json(body, status);
  }
});
