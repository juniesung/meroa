import { and, desc, eq, inArray, isNull, like } from 'drizzle-orm';

import { db } from '../../db/client.ts';
import { records, tasks } from '../../db/schema.ts';
import { materializeRecurringInstances, rollPastToNextDay, ymdInTz, type Tx } from './recurrence.ts';
import {
  reduceTaskProgress,
  resolveCompleteInput,
  ProgressError,
  type ProgressResult,
} from './progress.ts';
import {
  buildInitialConfig,
  validateEditPatchForType,
  type ChecklistItem,
  type CreateTaskInput,
  type EditTaskPatch,
  type PostponeInput,
  type ProgressInput,
  type Recurrence,
  type TaskStatus,
  type TaskType,
} from './schema.ts';

export type TaskRow = typeof tasks.$inferSelect;
export type ActionSource = {
  source: 'chat' | 'tasks_ui';
  sourceMessageId?: string;
  // The Anthropic tool_use block id for this specific call — see
  // db/schema.ts's records.toolCallId for why this exists.
  toolCallId?: string;
};

export class TaskActionError extends Error {
  code: 'not_found' | 'invalid_input' | 'nothing_to_undo';
  constructor(code: TaskActionError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

// A chat retry re-runs the whole model turn, which can re-issue the same
// tool call. Any action sourced from chat is guarded by this: if a
// non-reverted records row already exists for this exact tool call, return
// its outcome instead of re-executing.
//
// Keyed on (sourceMessageId, toolCallId) when a toolCallId is present — the
// Anthropic tool_use block's own id, unique per individual call even when
// several calls share one sourceMessageId (one turn creating two tasks, or
// starting then stopping the same timer). Keying on (sourceMessageId, kind[,
// taskId]) alone — the old behavior — can't tell "the same call replayed"
// apart from "a second, different call of the same kind in this turn", and
// would wrongly treat the second as a duplicate of the first.
//
// Falls back to the coarser (kind[, taskId]) match when there's no
// toolCallId (shouldn't happen for chat-sourced calls today, but keeps this
// safe for older records or any future non-tool_use caller).
// tasks_ui actions never pass a sourceMessageId, so this is a no-op for them.
async function findIdempotentRecord(
  tx: Tx,
  userId: string,
  opts: ActionSource,
  kind: string,
  taskId?: string,
) {
  if (!opts.sourceMessageId) return null;
  if (opts.toolCallId) {
    const [existing] = await tx
      .select()
      .from(records)
      .where(
        and(
          eq(records.userId, userId),
          eq(records.sourceMessageId, opts.sourceMessageId),
          eq(records.toolCallId, opts.toolCallId),
          isNull(records.revertedAt),
        ),
      )
      .orderBy(desc(records.createdAt))
      .limit(1);
    return existing ?? null;
  }
  const [existing] = await tx
    .select()
    .from(records)
    .where(
      and(
        eq(records.userId, userId),
        eq(records.sourceMessageId, opts.sourceMessageId),
        eq(records.kind, kind),
        isNull(records.revertedAt),
      ),
    )
    .orderBy(desc(records.createdAt))
    .limit(1);
  if (!existing) return null;
  const payload = existing.payload as { taskId?: string };
  if (taskId && payload.taskId !== taskId) return null;
  return existing;
}

async function loadTask(tx: Tx, userId: string, taskId: string): Promise<TaskRow> {
  const [task] = await tx
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.userId, userId), isNull(tasks.deletedAt)))
    .limit(1);
  if (!task) throw new TaskActionError('not_found', 'task not found');
  return task;
}

async function loadTaskForUpdate(tx: Tx, userId: string, taskId: string): Promise<TaskRow> {
  const [task] = await tx
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.userId, userId), isNull(tasks.deletedAt)))
    .for('update')
    .limit(1);
  if (!task) throw new TaskActionError('not_found', 'task not found');
  return task;
}

// Read-only, non-throwing task lookup for callers that need to check a
// task's current state without mutating it — the AI action layer's
// title-hint verification and the remove_task confirmation flow both use
// this instead of going through the mutation-oriented executor functions.
export async function getTask(userId: string, taskId: string): Promise<TaskRow | null> {
  const [task] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.userId, userId), isNull(tasks.deletedAt)))
    .limit(1);
  return task ?? null;
}

// --- create ----------------------------------------------------------

export async function createTask(
  userId: string,
  input: CreateTaskInput,
  timezone: string | null,
  opts: ActionSource,
): Promise<{ task: TaskRow }> {
  return db.transaction(async (tx) => {
    const idempotent = await findIdempotentRecord(tx, userId, opts, 'task_created');
    if (idempotent) {
      const payload = idempotent.payload as { taskId: string };
      const [existingTask] = await tx
        .select()
        .from(tasks)
        .where(eq(tasks.id, payload.taskId))
        .limit(1);
      if (existingTask) return { task: existingTask };
    }

    const config = {
      ...buildInitialConfig(input),
      reminder: input.reminder ?? false,
      dueTimeExplicit: input.dueTimeExplicit ?? true,
    };
    const dueAt = input.dueAt ? rollPastToNextDay(new Date(input.dueAt), timezone ?? 'UTC') : null;

    const [task] = await tx
      .insert(tasks)
      .values({
        userId,
        type: input.type,
        title: input.title,
        icon: input.icon ?? null,
        config,
        recurrence: input.recurrence ?? null,
        dueAt,
        createdFromMessageId: opts.source === 'chat' ? (opts.sourceMessageId ?? null) : null,
      })
      .returning();
    if (!task) throw new Error('task_insert_failed');

    await tx.insert(records).values({
      userId,
      kind: 'task_created',
      payload: { taskId: task.id, title: task.title },
      source: opts.source,
      sourceMessageId: opts.sourceMessageId ?? null,
      toolCallId: opts.toolCallId ?? null,
    });

    let responseTask = task;
    if (input.recurrence) {
      await materializeRecurringInstances(userId, timezone, tx);
      const todayYmd = ymdInTz(new Date(), timezone ?? 'UTC');
      const [todayInstance] = await tx
        .select()
        .from(tasks)
        .where(and(eq(tasks.templateId, task.id), eq(tasks.occurrenceDate, todayYmd)))
        .limit(1);
      if (todayInstance) responseTask = todayInstance;
    }

    return { task: responseTask };
  });
}

// --- edit --------------------------------------------------------------

export async function editTask(
  userId: string,
  taskId: string,
  patch: EditTaskPatch,
  timezone: string | null,
  opts: ActionSource,
): Promise<{ task: TaskRow }> {
  return db.transaction(async (tx) => {
    const idempotent = await findIdempotentRecord(
      tx,
      userId,
      opts,
      'task_edited',
      taskId,
    );
    if (idempotent) return { task: await loadTask(tx, userId, taskId) };

    const task = await loadTaskForUpdate(tx, userId, taskId);
    const type = task.type as TaskType;
    const invalidKey = validateEditPatchForType(type, patch);
    if (invalidKey) throw new TaskActionError('invalid_input', invalidKey);

    const prior: Record<string, unknown> = {};
    const updates: Partial<typeof tasks.$inferInsert> = {};

    if (patch.title !== undefined) {
      prior.title = task.title;
      updates.title = patch.title;
    }
    if (patch.icon !== undefined) {
      prior.icon = task.icon;
      updates.icon = patch.icon;
    }
    let config = task.config as Record<string, unknown>;
    let configChanged = false;

    // Whether the task is (or is becoming, via this same patch) a recurring
    // template — determines how patch.dueAt is handled just below.
    const willBeRecurring = patch.recurrence !== undefined ? !!patch.recurrence : !!task.recurrence;

    if (patch.dueAt !== undefined) {
      prior.dueAt = task.dueAt;
      // Recurring templates don't carry a caller-supplied anchor — same fix
      // as create_task (lib/ai/actions.ts): the UI's template-edit form
      // always sends dueAt and recurrence together, and rolling a stale
      // dueAt forward here could silently shift the every_n_days anchor day
      // on an otherwise-unrelated edit. Materialization derives the correct
      // first-occurrence day from recurrence.time + createdAt instead.
      updates.dueAt = willBeRecurring
        ? null
        : patch.dueAt
          ? rollPastToNextDay(new Date(patch.dueAt), timezone ?? 'UTC')
          : null;
      // Edit's dueAt always carries a real value the caller (UI form or AI)
      // gave explicitly — unlike create, nothing here auto-defaults to
      // end-of-day, so this is unconditionally a specified time.
      if (patch.dueAt && !willBeRecurring) {
        config = { ...config, dueTimeExplicit: true };
        configChanged = true;
      }
    }
    if (patch.recurrence !== undefined) {
      prior.recurrence = task.recurrence;
      updates.recurrence = patch.recurrence;
      config = { ...config, dueTimeExplicit: !!patch.recurrence?.time };
      configChanged = true;
    }
    if (patch.reminder !== undefined) {
      config = { ...config, reminder: patch.reminder };
      configChanged = true;
    }
    if (patch.note !== undefined && type === 'completion') {
      config = { ...config, note: patch.note };
      configChanged = true;
    }
    if (patch.items !== undefined && type === 'checklist') {
      const existingItems = (config.items as ChecklistItem[] | undefined) ?? [];
      const byText = new Map(existingItems.map((i) => [i.text, i]));
      config = {
        ...config,
        items: patch.items.map((text) => {
          const match = byText.get(text);
          return match ? { ...match, text } : { id: crypto.randomUUID(), text, done: false };
        }),
      };
      configChanged = true;
    }
    if (patch.target !== undefined && type === 'counter') {
      config = { ...config, target: patch.target };
      configChanged = true;
    }
    if (patch.unit !== undefined && type === 'counter') {
      config = { ...config, unit: patch.unit };
      configChanged = true;
    }
    if (patch.targetMinutes !== undefined && type === 'duration') {
      config = { ...config, targetMinutes: patch.targetMinutes };
      configChanged = true;
    }
    if (configChanged) {
      prior.config = task.config;
      updates.config = config;
    }

    if (Object.keys(updates).length === 0) return { task };

    const [updated] = await tx.update(tasks).set(updates).where(eq(tasks.id, task.id)).returning();
    if (!updated) throw new Error('task_update_failed');

    // A template's reminder setting only otherwise reaches instances
    // materialized *after* the edit (resetConfigForNewInstance reads it off
    // the template at generation time) — without this, turning reminders on
    // for a daily task wouldn't notify for today's already-materialized
    // instance until tomorrow. Matches removeTask's cascade in spirit; like
    // that one, this cascade isn't separately undoable — only the
    // template's own edit is (its reminder value is restored via prior.config).
    if (patch.reminder !== undefined && task.recurrence) {
      const instances = await tx
        .select({ id: tasks.id, config: tasks.config })
        .from(tasks)
        .where(
          and(eq(tasks.templateId, task.id), eq(tasks.status, 'open'), isNull(tasks.deletedAt)),
        );
      for (const inst of instances) {
        await tx
          .update(tasks)
          .set({ config: { ...(inst.config as Record<string, unknown>), reminder: patch.reminder } })
          .where(eq(tasks.id, inst.id));
      }
    }

    await tx.insert(records).values({
      userId,
      kind: 'task_edited',
      payload: { taskId: task.id, prior },
      source: opts.source,
      sourceMessageId: opts.sourceMessageId ?? null,
      toolCallId: opts.toolCallId ?? null,
    });

    return { task: updated };
  });
}

// --- progress / complete -------------------------------------------------

async function applyProgress(
  tx: Tx,
  userId: string,
  taskId: string,
  resolveInput: (task: TaskRow) => ProgressInput,
  recordKind: 'task_completion' | 'task_progress',
  opts: ActionSource,
): Promise<{ task: TaskRow }> {
  const task = await loadTaskForUpdate(tx, userId, taskId);
  const input = resolveInput(task);

  let result: ProgressResult;
  try {
    result = reduceTaskProgress(
      {
        type: task.type as TaskType,
        status: task.status as TaskStatus,
        config: task.config as Record<string, unknown>,
      },
      input,
    );
  } catch (err) {
    if (err instanceof ProgressError) throw new TaskActionError('invalid_input', err.message);
    throw err;
  }

  const prior = {
    status: task.status,
    config: task.config,
    completedRecordId: task.completedRecordId,
  };

  const [record] = await tx
    .insert(records)
    .values({
      userId,
      kind: recordKind,
      payload: { taskId: task.id, title: task.title, input, prior },
      source: opts.source,
      sourceMessageId: opts.sourceMessageId ?? null,
      toolCallId: opts.toolCallId ?? null,
    })
    .returning();
  if (!record) throw new Error('record_insert_failed');

  const becameDone = result.status === 'done' && task.status !== 'done';
  const becameOpen = result.status !== 'done' && task.status === 'done';

  const [updated] = await tx
    .update(tasks)
    .set({
      config: result.config,
      status: result.status,
      completedRecordId: becameDone ? record.id : becameOpen ? null : task.completedRecordId,
    })
    .where(eq(tasks.id, task.id))
    .returning();
  if (!updated) throw new Error('task_update_failed');

  return { task: updated };
}

export async function completeTask(
  userId: string,
  taskId: string,
  input: { value?: number; itemIds?: string[] },
  opts: ActionSource,
): Promise<{ task: TaskRow }> {
  return db.transaction(async (tx) => {
    const idempotent = await findIdempotentRecord(
      tx,
      userId,
      opts,
      'task_completion',
      taskId,
    );
    if (idempotent) return { task: await loadTask(tx, userId, taskId) };

    return applyProgress(
      tx,
      userId,
      taskId,
      (task) =>
        resolveCompleteInput(
          {
            type: task.type as TaskType,
            status: task.status as TaskStatus,
            config: task.config as Record<string, unknown>,
          },
          input,
        ),
      'task_completion',
      opts,
    );
  });
}

export async function progressTask(
  userId: string,
  taskId: string,
  input: ProgressInput,
  opts: ActionSource,
): Promise<{ task: TaskRow }> {
  return db.transaction(async (tx) => {
    const idempotent = await findIdempotentRecord(
      tx,
      userId,
      opts,
      'task_progress',
      taskId,
    );
    if (idempotent) return { task: await loadTask(tx, userId, taskId) };

    return applyProgress(tx, userId, taskId, () => input, 'task_progress', opts);
  });
}

// --- postpone ------------------------------------------------------------

export async function postponeTask(
  userId: string,
  taskId: string,
  input: PostponeInput,
  timezone: string | null,
  opts: ActionSource,
): Promise<{ task: TaskRow }> {
  return db.transaction(async (tx) => {
    const idempotent = await findIdempotentRecord(
      tx,
      userId,
      opts,
      'task_postponed',
      taskId,
    );
    if (idempotent) return { task: await loadTask(tx, userId, taskId) };

    const task = await loadTaskForUpdate(tx, userId, taskId);
    const prior = { dueAt: task.dueAt, status: task.status, config: task.config };
    const newDueAt = input.newDueAt ? rollPastToNextDay(new Date(input.newDueAt), timezone ?? 'UTC') : null;
    // Postpone always hands in a concrete new instant (UI chip or AI tool
    // call) — never the server's end-of-day default — so it's explicit.
    const config = newDueAt
      ? { ...(task.config as Record<string, unknown>), dueTimeExplicit: true }
      : task.config;

    const [updated] = await tx
      .update(tasks)
      .set({ dueAt: newDueAt, status: 'open', config })
      .where(eq(tasks.id, task.id))
      .returning();
    if (!updated) throw new Error('task_update_failed');

    await tx.insert(records).values({
      userId,
      kind: 'task_postponed',
      payload: { taskId: task.id, reason: input.reason ?? null, prior },
      source: opts.source,
      sourceMessageId: opts.sourceMessageId ?? null,
      toolCallId: opts.toolCallId ?? null,
    });

    return { task: updated };
  });
}

// --- remove ----------------------------------------------------------

export async function removeTask(
  userId: string,
  taskId: string,
  opts: ActionSource,
): Promise<{ task: TaskRow }> {
  return db.transaction(async (tx) => {
    const idempotent = await findIdempotentRecord(
      tx,
      userId,
      opts,
      'task_removed',
      taskId,
    );
    if (idempotent) return { task: await loadTask(tx, userId, taskId) };

    const task = await loadTaskForUpdate(tx, userId, taskId);

    const [updated] = await tx
      .update(tasks)
      .set({ deletedAt: new Date() })
      .where(eq(tasks.id, task.id))
      .returning();
    if (!updated) throw new Error('task_update_failed');

    // Removing a template also clears its not-yet-completed instances so
    // they don't linger on the Tasks tab. Their ids are recorded on the
    // template's own removal record so undoing it can restore exactly
    // these alongside the template — otherwise the materialization cursor
    // (recurrence.ts's lastInstance query) would treat those days as
    // already handled and never regenerate them, even after the template
    // comes back.
    let cascadedInstanceIds: string[] = [];
    if (task.recurrence) {
      const cascaded = await tx
        .update(tasks)
        .set({ deletedAt: new Date() })
        .where(
          and(eq(tasks.templateId, task.id), eq(tasks.status, 'open'), isNull(tasks.deletedAt)),
        )
        .returning({ id: tasks.id });
      cascadedInstanceIds = cascaded.map((r) => r.id);
    }

    await tx.insert(records).values({
      userId,
      kind: 'task_removed',
      payload: { taskId: task.id, title: task.title, cascadedInstanceIds },
      source: opts.source,
      sourceMessageId: opts.sourceMessageId ?? null,
      toolCallId: opts.toolCallId ?? null,
    });

    return { task: updated };
  });
}

// --- undo ------------------------------------------------------------

export async function undoLastAction(userId: string): Promise<{ task: TaskRow; action: string }> {
  return db.transaction(async (tx) => {
    const [record] = await tx
      .select()
      .from(records)
      .where(
        and(eq(records.userId, userId), isNull(records.revertedAt), like(records.kind, 'task_%')),
      )
      .orderBy(desc(records.createdAt))
      .limit(1);
    if (!record) throw new TaskActionError('nothing_to_undo', 'nothing to undo');

    const payload = record.payload as {
      taskId: string;
      prior?: unknown;
      reason?: string | null;
      cascadedInstanceIds?: string[];
    };
    const [task] = await tx
      .select()
      .from(tasks)
      .where(eq(tasks.id, payload.taskId))
      .for('update')
      .limit(1);
    if (!task) throw new TaskActionError('not_found', 'the task for that action no longer exists');

    let updated: TaskRow;
    switch (record.kind) {
      case 'task_created': {
        const [t] = await tx
          .update(tasks)
          .set({ deletedAt: new Date() })
          .where(eq(tasks.id, task.id))
          .returning();
        if (!t) throw new Error('task_update_failed');
        updated = t;
        if (task.recurrence) {
          await tx
            .update(tasks)
            .set({ deletedAt: new Date() })
            .where(
              and(eq(tasks.templateId, task.id), eq(tasks.status, 'open'), isNull(tasks.deletedAt)),
            );
        }
        break;
      }
      case 'task_completion':
      case 'task_progress': {
        const prior = payload.prior as {
          status: TaskStatus;
          config: Record<string, unknown>;
          completedRecordId: string | null;
        };
        const [t] = await tx
          .update(tasks)
          .set({
            status: prior.status,
            config: prior.config,
            completedRecordId: prior.completedRecordId,
          })
          .where(eq(tasks.id, task.id))
          .returning();
        if (!t) throw new Error('task_update_failed');
        updated = t;
        break;
      }
      case 'task_edited': {
        const prior = (payload.prior ?? {}) as Record<string, unknown>;
        const updates: Partial<typeof tasks.$inferInsert> = {};
        if ('title' in prior) updates.title = prior.title as string;
        if ('icon' in prior) updates.icon = prior.icon as string | null;
        if ('dueAt' in prior) updates.dueAt = prior.dueAt as Date | null;
        if ('recurrence' in prior) updates.recurrence = prior.recurrence as Recurrence | null;
        if ('config' in prior) updates.config = prior.config as Record<string, unknown>;
        const [t] = await tx.update(tasks).set(updates).where(eq(tasks.id, task.id)).returning();
        if (!t) throw new Error('task_update_failed');
        updated = t;
        break;
      }
      case 'task_postponed': {
        const prior = payload.prior as {
          dueAt: Date | null;
          status: TaskStatus;
          config?: Record<string, unknown>;
        };
        const [t] = await tx
          .update(tasks)
          .set({
            dueAt: prior.dueAt,
            status: prior.status,
            ...(prior.config ? { config: prior.config } : {}),
          })
          .where(eq(tasks.id, task.id))
          .returning();
        if (!t) throw new Error('task_update_failed');
        updated = t;
        break;
      }
      case 'task_removed': {
        const [t] = await tx
          .update(tasks)
          .set({ deletedAt: null })
          .where(eq(tasks.id, task.id))
          .returning();
        if (!t) throw new Error('task_update_failed');
        updated = t;
        if (payload.cascadedInstanceIds?.length) {
          await tx
            .update(tasks)
            .set({ deletedAt: null })
            .where(inArray(tasks.id, payload.cascadedInstanceIds));
        }
        break;
      }
      default:
        throw new TaskActionError('nothing_to_undo', `cannot undo record kind ${record.kind}`);
    }

    await tx.update(records).set({ revertedAt: new Date() }).where(eq(records.id, record.id));

    return { task: updated, action: record.kind };
  });
}
