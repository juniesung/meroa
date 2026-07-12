import { and, desc, eq, isNull, lt } from 'drizzle-orm';

import { db } from '../../db/client.ts';
import { records, goalEntries, goals, tasks } from '../../db/schema.ts';
import { createTaskInTx, type ActionSource, type TaskRow } from '../tasks/executor.ts';
import {
  goalDefinitionSchema,
  type EditGoalPatch,
  type LogGoalEntryPatch,
  type GoalDefinition,
  type GoalEntryData,
  type GoalTemplateKey,
  type StarterTask,
} from './schema.ts';

export type GoalRow = typeof goals.$inferSelect;
export type GoalEntryRow = typeof goalEntries.$inferSelect;
type Tx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export class GoalActionError extends Error {
  code: 'not_found' | 'invalid_input';
  constructor(code: GoalActionError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

// Same chat-retry idempotency pattern as lib/tasks/executor.ts's
// findIdempotentRecord — a retried turn re-issuing the same tool call
// returns the original outcome instead of double-writing.
async function findIdempotentGoalRecord(
  tx: Tx,
  userId: string,
  opts: ActionSource,
  kind: string,
  goalId?: string,
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
  const payload = existing.payload as { goalId?: string };
  if (goalId && payload.goalId !== goalId) return null;
  return existing;
}

async function loadGoal(tx: Tx, userId: string, goalId: string): Promise<GoalRow> {
  const [goal] = await tx
    .select()
    .from(goals)
    .where(and(eq(goals.id, goalId), eq(goals.userId, userId), isNull(goals.archivedAt)))
    .limit(1);
  if (!goal) throw new GoalActionError('not_found', 'goal not found');
  return goal;
}

async function loadGoalForUpdate(tx: Tx, userId: string, goalId: string): Promise<GoalRow> {
  const [goal] = await tx
    .select()
    .from(goals)
    .where(and(eq(goals.id, goalId), eq(goals.userId, userId), isNull(goals.archivedAt)))
    .for('update')
    .limit(1);
  if (!goal) throw new GoalActionError('not_found', 'goal not found');
  return goal;
}

// Read-only, non-throwing lookup — the AI action layer's nameHint
// verification and the create-from-preview flow both use this instead of
// the mutation-oriented functions below (mirrors lib/tasks/executor.ts's
// getTask).
export async function getGoal(userId: string, goalId: string): Promise<GoalRow | null> {
  const [goal] = await db
    .select()
    .from(goals)
    .where(and(eq(goals.id, goalId), eq(goals.userId, userId), isNull(goals.archivedAt)))
    .limit(1);
  return goal ?? null;
}

// --- create ----------------------------------------------------------
// `create_goal` (the AI tool, lib/ai/actions.ts) never calls this — it only
// builds and returns a preview definition. This is the actual save, called
// by POST /goals once the user taps Create on the preview card, with the
// exact definition that was shown (re-validated here, not rebuilt from
// params) so what gets saved always matches what was previewed. Every
// starter task is created in the same transaction, linked via `goalId` with
// `config.goalContribution` — the connected loop's setup half
// (docs/goals-redesign-plan.md §2.3); the other half lives in
// lib/tasks/executor.ts's applyProgress.
export async function createGoal(
  userId: string,
  input: {
    template: GoalTemplateKey;
    name: string;
    icon?: string | null;
    definition: GoalDefinition;
    starterTasks?: StarterTask[];
  },
  timezone: string | null,
  opts: ActionSource,
): Promise<{ goal: GoalRow; tasks: TaskRow[] }> {
  return db.transaction(async (tx) => {
    const idempotent = await findIdempotentGoalRecord(tx, userId, opts, 'goal_created');
    if (idempotent) {
      const payload = idempotent.payload as { goalId: string };
      const [existingGoal] = await tx.select().from(goals).where(eq(goals.id, payload.goalId)).limit(1);
      if (existingGoal) {
        const linkedTasks = await tx.select().from(tasks).where(eq(tasks.goalId, existingGoal.id));
        return { goal: existingGoal, tasks: linkedTasks };
      }
    }

    const definition = goalDefinitionSchema.parse(input.definition);

    const [goal] = await tx
      .insert(goals)
      .values({
        userId,
        template: input.template,
        name: input.name,
        icon: input.icon ?? null,
        version: 1,
        definition,
      })
      .returning();
    if (!goal) throw new Error('goal_insert_failed');

    await tx.insert(records).values({
      userId,
      kind: 'goal_created',
      payload: { goalId: goal.id, name: goal.name },
      source: opts.source,
      sourceMessageId: opts.sourceMessageId ?? null,
      toolCallId: opts.toolCallId ?? null,
    });

    const createdTasks: TaskRow[] = [];
    for (const starter of input.starterTasks ?? []) {
      const { task: created } = await createTaskInTx(
        tx,
        userId,
        { type: 'completion', title: starter.title, recurrence: starter.recurrence, reminder: false },
        timezone,
        opts,
      );
      // Recurring: createTaskInTx already materialized and returned *today's*
      // instance, not the template — the template needs the stamp too (every
      // future instance reads goalContribution off the template's config at
      // materialization time — recurrence.ts's resetConfigForNewInstance),
      // and if today's instance already exists it needs its own copy right
      // now rather than waiting for tomorrow's materialization.
      const templateId = created.templateId ?? created.id;
      const [templateRow] = await tx.select().from(tasks).where(eq(tasks.id, templateId)).limit(1);
      if (!templateRow) throw new Error('task_insert_failed');
      const [updatedTemplate] = await tx
        .update(tasks)
        .set({
          goalId: goal.id,
          config: { ...(templateRow.config as Record<string, unknown>), goalContribution: starter.contribution },
        })
        .where(eq(tasks.id, templateId))
        .returning();
      if (!updatedTemplate) throw new Error('task_update_failed');

      if (created.id === templateId) {
        createdTasks.push(updatedTemplate);
      } else {
        const [updatedInstance] = await tx
          .update(tasks)
          .set({
            goalId: goal.id,
            config: { ...(created.config as Record<string, unknown>), goalContribution: starter.contribution },
          })
          .where(eq(tasks.id, created.id))
          .returning();
        if (!updatedInstance) throw new Error('task_update_failed');
        createdTasks.push(updatedInstance);
      }
    }

    return { goal, tasks: createdTasks };
  });
}

// --- edit (constrained ops) ---------------------------------------------

/**
 * Applies a constrained edit patch to a goal's current definition. v1 ops:
 * targetValue, deadline — nothing else exists to edit yet
 * (docs/goals-redesign-plan.md §2.2). Returns an error string instead of
 * throwing so the executor can wrap it consistently as an invalid_input.
 */
function applyEditOps(
  definition: GoalDefinition,
  patch: EditGoalPatch,
): { definition: GoalDefinition } | { error: string } {
  let next = definition;

  if (patch.targetValue !== undefined) {
    next = { ...next, targetValue: patch.targetValue };
  }

  if (patch.deadline !== undefined) {
    next = { ...next, deadline: patch.deadline };
  }

  const parsed = goalDefinitionSchema.safeParse(next);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'invalid goal definition' };
  return { definition: parsed.data };
}

export async function editGoal(
  userId: string,
  goalId: string,
  patch: EditGoalPatch,
  opts: ActionSource,
): Promise<{ goal: GoalRow }> {
  return db.transaction(async (tx) => {
    const idempotent = await findIdempotentGoalRecord(tx, userId, opts, 'goal_edited', goalId);
    if (idempotent) return { goal: await loadGoal(tx, userId, goalId) };

    const goal = await loadGoalForUpdate(tx, userId, goalId);
    const currentDefinition = goal.definition as GoalDefinition;

    const prior = { name: goal.name, icon: goal.icon, definition: goal.definition, version: goal.version };

    const name = patch.name ?? goal.name;
    const icon = patch.icon !== undefined ? patch.icon : goal.icon;
    const result = applyEditOps(currentDefinition, patch);
    if ('error' in result) throw new GoalActionError('invalid_input', result.error);

    const noChange =
      name === goal.name && icon === goal.icon && JSON.stringify(result.definition) === JSON.stringify(goal.definition);
    if (noChange) return { goal };

    const [updated] = await tx
      .update(goals)
      .set({ name, icon, definition: result.definition, version: goal.version + 1 })
      .where(eq(goals.id, goal.id))
      .returning();
    if (!updated) throw new Error('goal_update_failed');

    await tx.insert(records).values({
      userId,
      kind: 'goal_edited',
      payload: { goalId: goal.id, name: updated.name, prior },
      source: opts.source,
      sourceMessageId: opts.sourceMessageId ?? null,
      toolCallId: opts.toolCallId ?? null,
    });

    return { goal: updated };
  });
}

// --- log entry -----------------------------------------------------------

export async function logGoalEntry(
  userId: string,
  goalId: string,
  patch: LogGoalEntryPatch,
  opts: ActionSource,
): Promise<{ goal: GoalRow; entry: GoalEntryRow }> {
  return db.transaction(async (tx) => {
    const idempotent = await findIdempotentGoalRecord(tx, userId, opts, 'goal_entry', goalId);
    if (idempotent) {
      const payload = idempotent.payload as { entryId?: string };
      if (payload.entryId) {
        const [entry] = await tx.select().from(goalEntries).where(eq(goalEntries.id, payload.entryId)).limit(1);
        if (entry) return { goal: await loadGoal(tx, userId, goalId), entry };
      }
    }

    const goal = await loadGoal(tx, userId, goalId);

    // patch.entryAt, when set, has already been normalized to a real UTC
    // instant by the caller (lib/ai/actions.ts, via localDatetimeToUtcIso) —
    // same convention as every dueAt reaching lib/tasks/executor.ts.
    const entryAt = patch.entryAt ? new Date(patch.entryAt) : new Date();
    const data: GoalEntryData = patch.note ? { amount: patch.amount, note: patch.note } : { amount: patch.amount };

    const [record] = await tx
      .insert(records)
      .values({
        userId,
        kind: 'goal_entry',
        payload: { goalId: goal.id, name: goal.name, data, entryAt: entryAt.toISOString() },
        source: opts.source,
        sourceMessageId: opts.sourceMessageId ?? null,
        toolCallId: opts.toolCallId ?? null,
      })
      .returning();
    if (!record) throw new Error('record_insert_failed');

    // The entry row is a view of the record above, not a second copy of the
    // same action (CLAUDE.md §2's "store once, render everywhere") — its
    // own `records.toolCallId`-backed idempotency lives on the record, not
    // here, so this insert never needs its own conflict handling.
    const [entry] = await tx
      .insert(goalEntries)
      .values({ goalId: goal.id, recordId: record.id, data, entryAt })
      .returning();
    if (!entry) throw new Error('entry_insert_failed');

    // Stamp the entry id onto the just-inserted record's payload so a
    // retried call (idempotency path above) and undo (which reads the
    // record, not the entry, as its source of truth) both know exactly
    // which goal_entries row this created.
    await tx.update(records).set({ payload: { ...record.payload as object, entryId: entry.id } }).where(eq(records.id, record.id));

    return { goal, entry };
  });
}

// --- read (history) ------------------------------------------------------

// Newest-first, cursor-paginated live entries (backed by a non-reverted
// record) for a goal's history view. Ownership is the caller's
// responsibility (routes/goals.ts checks getGoal first) — this only reads.
export async function listGoalEntries(
  goalId: string,
  opts: { limit: number; before?: Date },
): Promise<GoalEntryRow[]> {
  const conditions = [eq(goalEntries.goalId, goalId), isNull(records.revertedAt)];
  if (opts.before) conditions.push(lt(goalEntries.entryAt, opts.before));
  return db
    .select({
      id: goalEntries.id,
      goalId: goalEntries.goalId,
      recordId: goalEntries.recordId,
      data: goalEntries.data,
      entryAt: goalEntries.entryAt,
      createdAt: goalEntries.createdAt,
    })
    .from(goalEntries)
    .innerJoin(records, eq(goalEntries.recordId, records.id))
    .where(and(...conditions))
    .orderBy(desc(goalEntries.entryAt))
    .limit(opts.limit);
}

// --- archive ---------------------------------------------------------

export async function archiveGoal(userId: string, goalId: string, opts: ActionSource): Promise<{ goal: GoalRow }> {
  return db.transaction(async (tx) => {
    const idempotent = await findIdempotentGoalRecord(tx, userId, opts, 'goal_archived', goalId);
    if (idempotent) return { goal: await loadGoal(tx, userId, goalId) };

    const goal = await loadGoalForUpdate(tx, userId, goalId);
    const [updated] = await tx.update(goals).set({ archivedAt: new Date() }).where(eq(goals.id, goal.id)).returning();
    if (!updated) throw new Error('goal_update_failed');

    await tx.insert(records).values({
      userId,
      kind: 'goal_archived',
      payload: { goalId: goal.id, name: goal.name },
      source: opts.source,
      sourceMessageId: opts.sourceMessageId ?? null,
      toolCallId: opts.toolCallId ?? null,
    });

    return { goal: updated };
  });
}
