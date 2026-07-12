import { and, desc, eq, inArray, isNull, like, notInArray, or } from 'drizzle-orm';

import { db } from '../../db/client.ts';
import { records, tasks, goals, goalEntries } from '../../db/schema.ts';
import type { GoalRow } from '../goals/executor.ts';
import { materializeRecurringInstances, rollPastToNextDay, ymdInTz, type Tx } from './recurrence.ts';
import { decideGoalEntryAction } from './goal-entry-decision.ts';
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
// Shared by the tasks and goals executors (lib/goals/executor.ts) — a goal
// action sourced from the goal's own UI (a quick-entry sheet, an archive
// tap) uses 'goal_ui', the same way a Tasks-tab tap uses 'tasks_ui'.
export type ActionSource = {
  source: 'chat' | 'tasks_ui' | 'goal_ui';
  sourceMessageId?: string;
  // The Anthropic tool_use block id for this specific call — see
  // db/schema.ts's records.toolCallId for why this exists.
  toolCallId?: string;
};

// `records.payload` round-trips through jsonb — any `Date` stashed in a
// snapshot comes back as an ISO string, not a Date instance. A bare `as
// Date` cast doesn't convert it, and Drizzle's timestamp column mapper
// throws calling `.toISOString()` on a string at write time.
export function reviveDate(value: unknown): Date | null {
  if (value == null) return null;
  return value instanceof Date ? value : new Date(value as string);
}

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

// Transaction-parameterized core, so a caller that needs to create a task
// alongside something else in the same transaction (goals/executor.ts's
// starter-task creation — docs/goals-redesign-plan.md §2.3) can share it
// instead of nesting a second top-level transaction.
//
// `skipRecord` is for a caller whose own action record subsumes this create
// — a goal's Create tap is ONE user action, so its goal_created record (with
// starterTaskIds in the payload) is the single record for the whole thing,
// and per-starter task_created records would (a) double-count the action and
// (b) tie with goal_created on createdAt (Postgres freezes now() at
// transaction start), making "which record does undo pick" nondeterministic.
export async function createTaskInTx(
  tx: Tx,
  userId: string,
  input: CreateTaskInput,
  timezone: string | null,
  opts: ActionSource,
  { skipRecord = false }: { skipRecord?: boolean } = {},
): Promise<{ task: TaskRow }> {
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

  if (!skipRecord) {
    await tx.insert(records).values({
      userId,
      kind: 'task_created',
      payload: { taskId: task.id, title: task.title },
      source: opts.source,
      sourceMessageId: opts.sourceMessageId ?? null,
      toolCallId: opts.toolCallId ?? null,
    });
  }

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
}

export async function createTask(
  userId: string,
  input: CreateTaskInput,
  timezone: string | null,
  opts: ActionSource,
): Promise<{ task: TaskRow }> {
  return db.transaction((tx) => createTaskInTx(tx, userId, input, timezone, opts));
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

  // Connected loop: a goal-linked task's completion auto-logs its
  // contribution as a goal entry, store-once — the entry's recordId IS this
  // same task_completion/task_progress record, not a duplicate row
  // (CLAUDE.md §2). becameDone can fire under either recordKind (a counter
  // task_progress reaching its target counts too), so this hooks the status
  // transition itself rather than a specific AI tool name. The un-complete
  // trap (docs/goals-redesign-plan.md §2.3 — re-completing after an
  // un-complete must never double-log) is decided by the pure
  // decideGoalEntryAction (unit-tested in goal-entry-decision.test.ts), not
  // inline here — `task.completedRecordId` is the *prior* value since
  // `task` was loaded before this update. undo_last_action needs no
  // equivalent cleanup: reverting the record sets its own revertedAt, which
  // already hides the entry via the live-entries join (lib/goals/summary.ts).
  let goalArchived = false;
  if (task.goalId && becameDone) {
    const [linkedGoal] = await tx
      .select({ archivedAt: goals.archivedAt })
      .from(goals)
      .where(eq(goals.id, task.goalId))
      .limit(1);
    goalArchived = !linkedGoal || linkedGoal.archivedAt !== null;
  }
  const goalEntryAction = decideGoalEntryAction({
    goalId: task.goalId,
    goalArchived,
    goalContribution: (task.config as Record<string, unknown>).goalContribution,
    becameDone,
    becameOpen,
    newRecordId: record.id,
    priorCompletedRecordId: task.completedRecordId,
    entryAt: record.occurredAt,
  });
  if (goalEntryAction.action === 'insert') {
    await tx.insert(goalEntries).values({
      goalId: goalEntryAction.goalId,
      recordId: goalEntryAction.recordId,
      data: { amount: goalEntryAction.amount },
      entryAt: goalEntryAction.entryAt,
    });
  } else if (goalEntryAction.action === 'delete') {
    await tx.delete(goalEntries).where(eq(goalEntries.recordId, goalEntryAction.recordId));
  }

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

/**
 * Archive a goal and cascade its linked tasks inside an existing
 * transaction — the single implementation behind goals/executor's
 * archiveGoal (remove_goal / DELETE /goals/:id) AND the goal-linked
 * template removal rule in removeTask/removeTasks below. Lives here rather
 * than in goals/executor because tasks/executor may not value-import it
 * (goals/executor already value-imports createTaskInTx from here — the
 * reverse edge would be a runtime cycle), same reason undoGoalRecord lives
 * here. Recurring templates cascade regardless of status (they're never
 * 'done'); instances and standalone linked tasks only while open — a done
 * instance is history and keeps its record. Writes the one goal_archived
 * record whose payload.cascadedTaskIds lets undo restore the whole unit.
 */
export async function archiveGoalCascadeInTx(
  tx: Tx,
  userId: string,
  goal: GoalRow,
  opts: ActionSource,
): Promise<{ goal: GoalRow; cascadedTaskIds: string[]; cascadedTaskTitles: string[] }> {
  const [updated] = await tx
    .update(goals)
    .set({ archivedAt: new Date() })
    .where(eq(goals.id, goal.id))
    .returning();
  if (!updated) throw new Error('goal_update_failed');

  const linked = await tx
    .select({ id: tasks.id, title: tasks.title, recurrence: tasks.recurrence, status: tasks.status })
    .from(tasks)
    .where(and(eq(tasks.goalId, goal.id), isNull(tasks.deletedAt)));
  const toCascade = linked.filter((t) => t.recurrence !== null || t.status === 'open');
  const cascadedTaskIds = toCascade.map((t) => t.id);
  if (cascadedTaskIds.length) {
    await tx.update(tasks).set({ deletedAt: new Date() }).where(inArray(tasks.id, cascadedTaskIds));
  }
  // One title per template/task, not per materialized instance — for the
  // "removed along with …" summary.
  const cascadedTaskTitles = [...new Set(toCascade.map((t) => t.title))];

  await tx.insert(records).values({
    userId,
    kind: 'goal_archived',
    payload: { goalId: goal.id, name: goal.name, cascadedTaskIds },
    source: opts.source,
    sourceMessageId: opts.sourceMessageId ?? null,
    toolCallId: opts.toolCallId ?? null,
  });

  return { goal: updated, cascadedTaskIds, cascadedTaskTitles };
}

// A repeating task that powers a goal doesn't outlive it: removing the
// TEMPLATE removes the goal too, with exactly remove_goal's semantics (the
// cascade above deletes the template alongside everything else linked and
// leaves one goal_archived record, so "undo" restores goal + tasks as a
// unit). Instances never trigger this (their recurrence is null) — deleting
// today's check-in just skips today, and tomorrow materializes normally.
// The client warns + double-confirms before calling DELETE on such a
// template; the AI's pending-removal card says it in the tap-to-confirm
// text — by the time either reaches here, the user has said yes to the
// goal going too.
async function loadLiveLinkedGoal(tx: Tx, task: TaskRow): Promise<GoalRow | null> {
  if (!task.recurrence || !task.goalId) return null;
  const [goal] = await tx
    .select()
    .from(goals)
    .where(and(eq(goals.id, task.goalId), isNull(goals.archivedAt)))
    .limit(1);
  return goal ?? null;
}

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

    const linkedGoal = await loadLiveLinkedGoal(tx, task);
    if (linkedGoal) {
      await archiveGoalCascadeInTx(tx, userId, linkedGoal, opts);
      // The cascade deleted this template (it's linked) — return the
      // deleted row directly; loadTask would 404 on it now.
      const [removedRow] = await tx.select().from(tasks).where(eq(tasks.id, task.id)).limit(1);
      if (!removedRow) throw new Error('task_update_failed');
      return { task: removedRow };
    }

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

// --- bulk remove -------------------------------------------------------

// Batched form of removeTask, used by the AI's remove_tasks confirm flow
// (item 5, docs/ai-reliability-hardening.md) — a single transaction, one
// records row for the whole batch (kind stays 'task_removed', distinguished
// by `payload.bulk`) so one undo_last_action restores everything at once
// instead of one card/tap/record per task. Scope (occurrence vs. series) is
// already resolved to concrete ids by the caller (lib/ai/actions.ts) — this
// just removes each id and cascades exactly like removeTask does per item.
export async function removeTasks(
  userId: string,
  taskIds: string[],
  opts: ActionSource,
): Promise<{ tasks: TaskRow[] }> {
  return db.transaction(async (tx) => {
    const idempotent = await findIdempotentRecord(tx, userId, opts, 'task_removed');
    if (idempotent) {
      const payload = idempotent.payload as { bulk?: boolean; tasks?: { taskId: string }[] };
      if (payload.bulk && payload.tasks) {
        const rows = await tx
          .select()
          .from(tasks)
          .where(inArray(tasks.id, payload.tasks.map((t) => t.taskId)));
        return { tasks: rows };
      }
    }

    const removed: TaskRow[] = [];
    const recordTasks: { taskId: string; title: string; cascadedInstanceIds: string[] }[] = [];
    // Tasks a goal cascade in this same batch already deleted — a batch can
    // contain both a goal-linked template and its instance (or two tasks of
    // the same goal); the second must not 404 or double-delete.
    const cascadeDeleted = new Set<string>();

    for (const taskId of taskIds) {
      if (cascadeDeleted.has(taskId)) {
        const [row] = await tx.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
        if (row) removed.push(row);
        continue;
      }
      const task = await loadTaskForUpdate(tx, userId, taskId);

      const linkedGoal = await loadLiveLinkedGoal(tx, task);
      if (linkedGoal) {
        // Goal-linked template: same rule as removeTask — the goal goes
        // with it, one goal_archived record of its own (inserted before
        // the batch's task_removed record below, so chained undos peel
        // the batch first, then the goal). This item is deliberately NOT
        // in recordTasks: restoring it belongs to the goal record.
        const cascade = await archiveGoalCascadeInTx(tx, userId, linkedGoal, opts);
        for (const id of cascade.cascadedTaskIds) cascadeDeleted.add(id);
        const [row] = await tx.select().from(tasks).where(eq(tasks.id, task.id)).limit(1);
        if (!row) throw new Error('task_update_failed');
        removed.push(row);
        continue;
      }

      const [updated] = await tx
        .update(tasks)
        .set({ deletedAt: new Date() })
        .where(eq(tasks.id, task.id))
        .returning();
      if (!updated) throw new Error('task_update_failed');
      removed.push(updated);

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
      recordTasks.push({ taskId: task.id, title: task.title, cascadedInstanceIds });
    }

    // A batch fully absorbed by goal cascades writes no task_removed record
    // of its own — the goal_archived records already cover every deletion,
    // and an empty bulk record would be a no-op undo target.
    if (recordTasks.length) {
      await tx.insert(records).values({
        userId,
        kind: 'task_removed',
        payload: { bulk: true, tasks: recordTasks },
        source: opts.source,
        sourceMessageId: opts.sourceMessageId ?? null,
        toolCallId: opts.toolCallId ?? null,
      });
    }

    return { tasks: removed };
  });
}

// --- undo ------------------------------------------------------------
//
// Undo covers both tasks and goals under one entry point (undo_last_action
// is a single AI tool and a single "undo that" REST route) — the most
// recent non-reverted records row across either kind gets reverted,
// whichever domain it belongs to. Goal records are handled by
// undoGoalRecord below; task records keep their existing, unchanged logic.

export type UndoResult = {
  action: string;
  task?: TaskRow;
  tasks?: TaskRow[];
  goal?: GoalRow;
  // Only set for a 'goal_entry' undo — the values that were logged, so the
  // caller can narrate what got removed (docs/ai-reliability-hardening.md
  // lesson 16: a bare "reverted" summary forces the model to guess).
  goalEntryData?: Record<string, unknown>;
};

/**
 * What undo_last_action would revert right now, without reverting anything —
 * rendered as a state line in the AI tail (lib/ai/recent-changes.ts's
 * renderUndoTarget). Out-of-band actions (a Tasks-tab swipe, a Goals-tab
 * removal) are invisible to the model's conversation history, and observed
 * live that made it refuse "undo that" as "nothing to undo" right after a
 * UI deletion; a deterministic state fact beats hoping it infers one from
 * the recent-changes narrative. Same candidate query as undoLastAction
 * below so the line can never disagree with what undo would actually do.
 */
export async function peekUndoTarget(
  userId: string,
): Promise<{ kind: string; payload: unknown; source: string } | null> {
  const [record] = await db
    .select({ kind: records.kind, payload: records.payload, source: records.source })
    .from(records)
    .where(
      and(
        eq(records.userId, userId),
        isNull(records.revertedAt),
        or(like(records.kind, 'task_%'), like(records.kind, 'goal_%')),
        notInArray(records.kind, ['task_undo', 'goal_undo']),
      ),
    )
    .orderBy(desc(records.createdAt))
    .limit(1);
  return record ?? null;
}

export async function undoLastAction(userId: string, opts: ActionSource): Promise<UndoResult> {
  return db.transaction(async (tx) => {
    const [record] = await tx
      .select()
      .from(records)
      .where(
        and(
          eq(records.userId, userId),
          isNull(records.revertedAt),
          or(like(records.kind, 'task_%'), like(records.kind, 'goal_%')),
          // The undo bookkeeping records themselves match the task_%/goal_%
          // prefixes but aren't undoable actions — without excluding them,
          // a second consecutive "undo that" finds the first undo's own
          // record and dies on "cannot undo record kind task_undo" instead
          // of reverting the next-most-recent real action (pre-existing bug,
          // caught by the as-a-user test pass). Undo-of-undo (redo) stays
          // deliberately unsupported; consecutive undos walk further back.
          notInArray(records.kind, ['task_undo', 'goal_undo']),
        ),
      )
      .orderBy(desc(records.createdAt))
      .limit(1);
    if (!record) throw new TaskActionError('nothing_to_undo', 'nothing to undo');

    if (record.kind.startsWith('goal_')) return undoGoalRecord(tx, userId, record, opts);
    return undoTaskRecord(tx, userId, record, opts);
  });
}

async function undoGoalRecord(
  tx: Tx,
  userId: string,
  record: typeof records.$inferSelect,
  opts: ActionSource,
): Promise<UndoResult> {
  const payload = record.payload as {
    goalId?: string;
    name?: string;
    prior?: { name: string; icon: string | null; definition: unknown; version: number };
    data?: Record<string, unknown>;
    starterTaskIds?: string[];
    cascadedTaskIds?: string[];
  };
  const goalId = payload.goalId;
  if (!goalId) throw new TaskActionError('not_found', 'the goal for that action no longer exists');

  // Not filtered to isNull(archivedAt) — undoing a goal_archived action must
  // find the goal while it's still archived.
  const [goal] = await tx
    .select()
    .from(goals)
    .where(and(eq(goals.id, goalId), eq(goals.userId, userId)))
    .for('update')
    .limit(1);
  if (!goal) throw new TaskActionError('not_found', 'the goal for that action no longer exists');

  let updated: GoalRow;
  switch (record.kind) {
    case 'goal_created': {
      const [g] = await tx.update(goals).set({ archivedAt: new Date() }).where(eq(goals.id, goal.id)).returning();
      if (!g) throw new Error('goal_update_failed');
      updated = g;
      // Starter tasks were created in the same Create-tap transaction as
      // the goal — undoing the goal's creation takes them (and any open
      // materialized instances of a recurring starter) with it, the same
      // cascade shape undoTaskRecord's 'task_created' uses. Without this,
      // "undo that" right after Create leaves orphaned tasks silently
      // logging entries to an archived goal.
      if (payload.starterTaskIds?.length) {
        await tx
          .update(tasks)
          .set({ deletedAt: new Date() })
          .where(and(inArray(tasks.id, payload.starterTaskIds), isNull(tasks.deletedAt)));
        await tx
          .update(tasks)
          .set({ deletedAt: new Date() })
          .where(
            and(
              inArray(tasks.templateId, payload.starterTaskIds),
              eq(tasks.status, 'open'),
              isNull(tasks.deletedAt),
            ),
          );
      }
      break;
    }
    case 'goal_edited': {
      const prior = payload.prior;
      if (!prior) throw new Error('goal_edited record missing prior snapshot');
      const [g] = await tx
        .update(goals)
        .set({ name: prior.name, icon: prior.icon, definition: prior.definition, version: prior.version })
        .where(eq(goals.id, goal.id))
        .returning();
      if (!g) throw new Error('goal_update_failed');
      updated = g;
      break;
    }
    case 'goal_archived': {
      const [g] = await tx.update(goals).set({ archivedAt: null }).where(eq(goals.id, goal.id)).returning();
      if (!g) throw new Error('goal_update_failed');
      updated = g;
      // Removing the goal cascaded its linked tasks away (archiveGoal) —
      // bringing the goal back brings exactly that set back with it.
      if (payload.cascadedTaskIds?.length) {
        await tx
          .update(tasks)
          .set({ deletedAt: null })
          .where(inArray(tasks.id, payload.cascadedTaskIds));
      }
      break;
    }
    case 'goal_entry': {
      // The generic revertedAt flip below on `record` IS the undo for an
      // entry — lib/goals/summary.ts's entry queries already exclude
      // reverted records. Nothing else to mutate on the goal row itself.
      updated = goal;
      break;
    }
    default:
      throw new TaskActionError('nothing_to_undo', `cannot undo record kind ${record.kind}`);
  }

  await tx.update(records).set({ revertedAt: new Date() }).where(eq(records.id, record.id));

  // Same reasoning as undoTaskRecord below — undoing is itself an
  // out-of-band mutation the next chat turn needs to know about.
  await tx.insert(records).values({
    userId,
    kind: 'goal_undo',
    payload: { undidKind: record.kind, goalId: updated.id, name: updated.name },
    source: opts.source,
    sourceMessageId: opts.sourceMessageId ?? null,
    toolCallId: opts.toolCallId ?? null,
  });

  return {
    action: record.kind,
    goal: updated,
    goalEntryData: record.kind === 'goal_entry' ? payload.data : undefined,
  };
}

async function undoTaskRecord(
  tx: Tx,
  userId: string,
  record: typeof records.$inferSelect,
  opts: ActionSource,
): Promise<UndoResult> {
  const payload = record.payload as {
    taskId?: string;
    prior?: unknown;
    reason?: string | null;
    cascadedInstanceIds?: string[];
    bulk?: boolean;
    tasks?: { taskId: string; title: string; cascadedInstanceIds: string[] }[];
  };
  // A bulk removal's record has no top-level taskId — its "primary" task
  // (the one this function's single-task return value reflects) is just
  // the first of the batch; every id in the batch still gets restored
  // below, regardless of which one is returned.
  const primaryTaskId =
    payload.bulk && payload.tasks?.length ? payload.tasks[0]!.taskId : payload.taskId;
  if (!primaryTaskId) throw new TaskActionError('not_found', 'the task for that action no longer exists');

  const [task] = await tx
    .select()
    .from(tasks)
    .where(eq(tasks.id, primaryTaskId))
    .for('update')
    .limit(1);
  if (!task) throw new TaskActionError('not_found', 'the task for that action no longer exists');

    let updated: TaskRow;
    // Only set for a bulk removal's undo — every task actually restored,
    // not just the "primary" one `updated` reflects, so the caller can
    // narrate the whole batch instead of implying only one came back.
    let restoredBulk: TaskRow[] | undefined;
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
        if ('dueAt' in prior) updates.dueAt = reviveDate(prior.dueAt);
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
            dueAt: reviveDate(prior.dueAt),
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
        if (payload.bulk && payload.tasks?.length) {
          const ids = payload.tasks.flatMap((t) => [t.taskId, ...t.cascadedInstanceIds]);
          await tx.update(tasks).set({ deletedAt: null }).where(inArray(tasks.id, ids));
          const primaryIds = payload.tasks.map((t) => t.taskId);
          const restored = await tx.select().from(tasks).where(inArray(tasks.id, primaryIds));
          const primary = restored.find((t) => t.id === primaryTaskId) ?? restored[0];
          if (!primary) throw new Error('task_update_failed');
          updated = primary;
          restoredBulk = restored;
          break;
        }
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

    // Undoing an action is itself a real, out-of-band mutation the next
    // chat turn needs to know about — same reasoning as every other action
    // here, and the gap this closes was observed live: undoing a bulk
    // removal via the Tasks-tab (or REST) button restored every task in the
    // DB, but with no fresh record for it, buildRecentChangesFeed (item 4)
    // had nothing to surface, and the model kept insisting a task was
    // "already gone" — its stale belief from before the undo, never
    // corrected. Marking the reverted record's revertedAt alone isn't
    // enough; the feed only looks at fresh occurredAt timestamps.
    await tx.insert(records).values({
      userId,
      kind: 'task_undo',
      payload: {
        undidKind: record.kind,
        taskId: updated.id,
        title: updated.title,
        tasks: restoredBulk?.map((t) => ({ taskId: t.id, title: t.title })),
      },
      source: opts.source,
      sourceMessageId: opts.sourceMessageId ?? null,
      toolCallId: opts.toolCallId ?? null,
    });

  return { task: updated, action: record.kind, tasks: restoredBulk };
}
