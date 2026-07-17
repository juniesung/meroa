import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';

import { db } from '../db/client.ts';
import { conversations, messages, tasks, users } from '../db/schema.ts';
import { requireAuth, type AuthVariables } from '../middleware/auth.ts';
import { rateLimit } from '../middleware/rate-limit.ts';
import { computeTaskCreateAllowance, limitReachedBody, LimitReachedError } from '../lib/limits.ts';
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
  createTaskInTx,
  editTask,
  postponeTask,
  progressTask,
  removeTask,
  removeTasks,
  TaskActionError,
  undoLastAction,
} from '../lib/tasks/executor.ts';
import { withUserLock } from '../lib/usage.ts';

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

const createFromPreviewSchema = z.object({ previewMessageId: z.string().uuid() });

// Two ways to create a task, same split as goals (routes/goals.ts): a full
// definition (the Tasks-tab "+" sheet, always immediate — confirmBeforeCreate
// never applies here), or `{previewMessageId}` confirming a chat preview
// card (lib/ai/actions.ts's create_task case, when that preference is on).
// `.strict()` isn't needed to disambiguate — a previewMessageId body fails
// createTaskInputSchema's discriminated union (no `type`) and vice versa.
const createTaskBodySchema = z.union([createFromPreviewSchema, createTaskInputSchema]);

taskRoutes.post('/', rateLimit({ windowMs: 60_000, max: 20 }), zValidator('json', createTaskBodySchema), async (c) => {
  const userId = c.get('userId');
  const body = c.req.valid('json');
  const timezone = await getUserTimezone(userId);

  if (!('previewMessageId' in body)) {
    try {
      const { task } = await withUserLock(userId, async (tx) => {
        const allowance = await computeTaskCreateAllowance(tx, userId);
        if (!allowance.allowed) throw new LimitReachedError('tasks', allowance);
        return createTaskInTx(tx, userId, body, timezone, { source: 'tasks_ui' });
      });
      return c.json({ task }, 201);
    } catch (err) {
      if (err instanceof LimitReachedError) {
        const { status, body } = limitReachedBody(err);
        return c.json(body, status);
      }
      const { status, body: errBody } = actionErrorResponse(err);
      return c.json(errBody, status);
    }
  }

  // Confirm-tap target for the AI's create_task preview card — create_task
  // never writes a row itself when confirmBeforeCreate is on; this is the
  // actual save, using the exact input that was shown on the card. Same
  // idempotency shape as POST /goals's previewMessageId branch: a stamped
  // meta.createdTaskId, checked first, so a retried or double tap never
  // creates a second task.
  const { previewMessageId } = body;
  const [row] = await db
    .select({ message: messages, conversationUserId: conversations.userId })
    .from(messages)
    .innerJoin(conversations, eq(messages.conversationId, conversations.id))
    .where(eq(messages.id, previewMessageId))
    .limit(1);
  if (!row || row.conversationUserId !== userId) {
    return c.json({ error: 'not_found', message: 'that preview no longer exists' }, 404);
  }

  const meta = row.message.meta as {
    kind?: string;
    preview?: unknown;
    createdTaskId?: string;
  };
  if (meta.createdTaskId) {
    const [existing] = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, meta.createdTaskId), eq(tasks.userId, userId)))
      .limit(1);
    if (existing) return c.json({ task: existing }, 200);
  }
  if (meta.kind !== 'task_creation_pending' || !meta.preview) {
    return c.json({ error: 'invalid_input', message: 'that message is not a task preview' }, 400);
  }
  const parsedPreview = createTaskInputSchema.safeParse(meta.preview);
  if (!parsedPreview.success) {
    return c.json({ error: 'invalid_input', message: 'stored preview is malformed' }, 400);
  }

  try {
    const { task } = await withUserLock(userId, async (tx) => {
      const allowance = await computeTaskCreateAllowance(tx, userId);
      if (!allowance.allowed) throw new LimitReachedError('tasks', allowance);
      const result = await createTaskInTx(tx, userId, parsedPreview.data, timezone, {
        source: 'chat',
        sourceMessageId: previewMessageId,
      });
      await tx
        .update(messages)
        .set({ meta: { ...meta, createdTaskId: result.task.id } })
        .where(eq(messages.id, previewMessageId));
      return result;
    });
    return c.json({ task }, 201);
  } catch (err) {
    if (err instanceof LimitReachedError) {
      const { status, body } = limitReachedBody(err);
      return c.json(body, status);
    }
    const { status, body: errBody } = actionErrorResponse(err);
    return c.json(errBody, status);
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

const bulkRemoveSchema = z.object({ taskIds: z.array(z.string().uuid()).min(1).max(50) });

// Confirm-tap target for the AI's remove_tasks pending card — one Confirm
// removes every task in the batch (and cascades any recurring template's
// open instances with it), as a single undoable records row.
taskRoutes.post('/bulk-remove', zValidator('json', bulkRemoveSchema), async (c) => {
  const userId = c.get('userId');
  const { taskIds } = c.req.valid('json');
  try {
    const { tasks } = await removeTasks(userId, taskIds, { source: 'tasks_ui' });
    return c.json({ tasks });
  } catch (err) {
    const { status, body } = actionErrorResponse(err);
    return c.json(body, status);
  }
});

taskRoutes.post('/undo', async (c) => {
  const userId = c.get('userId');
  try {
    const { task, action } = await undoLastAction(userId, { source: 'tasks_ui' });
    return c.json({ task, action });
  } catch (err) {
    const { status, body } = actionErrorResponse(err);
    return c.json(body, status);
  }
});
