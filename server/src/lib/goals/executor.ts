import { and, desc, eq, inArray, isNull, lt } from 'drizzle-orm';

import { db } from '../../db/client.ts';
import { records, goalEntries, goals, tasks } from '../../db/schema.ts';
import { archiveGoalCascadeInTx, createTaskInTx, type ActionSource, type TaskRow } from '../tasks/executor.ts';
import {
  applyStageOps,
  goalDefinitionSchema,
  type AdvanceStageProposal,
  type EditGoalPatch,
  type IndirectGoalDefinition,
  type LogGoalEntryPatch,
  type GoalDefinition,
  type GoalEntryData,
  type GoalTemplateKey,
  type MilestoneGoalDefinition,
  type PlannedTask,
  type SavingsGoalDefinition,
  type StarterTask,
} from './schema.ts';

export type GoalRow = typeof goals.$inferSelect;
export type GoalEntryRow = typeof goalEntries.$inferSelect;
export type Tx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

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

// Pure — extracted so the "which linked tasks retire" decision is directly
// unit-testable without a DB. A recurring template retires regardless of
// status (it's never 'done' itself); an instance or standalone task only
// while still open — a done one is history and keeps its record. Same rule
// as tasks/executor.ts's archiveGoalCascadeInTx cascade filter.
export function filterRetireCandidates<T extends { recurrence: unknown; status: string }>(rows: T[]): T[] {
  return rows.filter((t) => t.recurrence !== null || t.status === 'open');
}

// Pure — the single read point for a milestone's planned tasks
// (docs/goal-manual-editing-plan.md §2). `[]` for a stage with no plan yet,
// or one that's already active/complete — a plan never lives there (see
// milestoneGoalDefinitionSchema's comment in schema.ts): the active
// stage's tasks are real task rows, not a plan.
export function plannedTasksForStage(definition: MilestoneGoalDefinition, index: number): PlannedTask[] {
  return definition.stagePlans?.[index] ?? [];
}

// Pure — whether an advance_goal_stage proposal is stale against the goal's
// LIVE activeStageIndex. The confirm card freezes fromStageIndex at the
// moment it was shown; if the goal has moved on since (another advance, an
// undo), re-tapping it must fail rather than silently advancing from the
// wrong stage.
export function isAdvanceProposalStale(liveActiveStageIndex: number, proposalFromStageIndex: number): boolean {
  return liveActiveStageIndex !== proposalFromStageIndex;
}

// Live, still-linked tasks eligible for the "retire" side of an
// advance_goal_stage proposal. Read-only; lib/ai/actions.ts uses this to
// build the proposal from LIVE state rather than trusting the model's
// belief about which tasks are currently open.
export async function listGoalRetireCandidates(
  userId: string,
  goalId: string,
): Promise<{ id: string; title: string }[]> {
  const rows = await db
    .select({ id: tasks.id, title: tasks.title, recurrence: tasks.recurrence, status: tasks.status })
    .from(tasks)
    .where(and(eq(tasks.goalId, goalId), eq(tasks.userId, userId), isNull(tasks.deletedAt)));
  return filterRetireCandidates(rows).map((t) => ({ id: t.id, title: t.title }));
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
// Transaction-parameterized core (mirrors tasks/executor.ts's
// createTaskInTx) — routes/goals.ts wraps this in withUserLock so the
// free-plan active-goal cap check and the insert are atomic.
export async function createGoalInTx(
  tx: Tx,
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

  const createdTasks: TaskRow[] = [];
  for (const [index, starter] of (input.starterTasks ?? []).entries()) {
    const { task: created } = await createTaskInTx(
      tx,
      userId,
      { type: 'completion', title: starter.title, recurrence: starter.recurrence, reminder: false },
      timezone,
      // Each starter gets its own toolCallId — createTaskInTx's idempotency
      // otherwise keys on (sourceMessageId, 'task_created') alone, and with
      // every starter sharing this create's sourceMessageId, starter #2
      // would find starter #1's record and silently return it instead of
      // creating anything (caught by the as-a-user test pass, not live).
      { ...opts, toolCallId: `starter:${index}` },
      // The Create tap is one user action — the goal_created record below
      // (payload.starterTaskIds) is its single record; per-starter
      // task_created records would tie with it on createdAt (same
      // transaction, same frozen now()) and make undo's "most recent
      // record" pick nondeterministic.
      { skipRecord: true },
    );
    // Recurring: createTaskInTx materialized instances from the template
    // BEFORE the goal link exists on it (the stamp below) — so every
    // instance row that materialization just created must be stamped too,
    // not only the template. Crucially that is NOT always just today's:
    // the first-ever-run bump in recurrence.ts can materialize the first
    // instance for *tomorrow* (a daily time that already passed — hit
    // live: the model set time "11:53" at 11:53:38, the instance landed
    // on tomorrow, was never returned as "today's instance", stayed
    // unlinked, and completing it moved nothing). Stamping every instance
    // of the template closes that hole for any occurrence date.
    const templateId = created.templateId ?? created.id;
    // Habit starters never stamp a contribution — even if one slipped past
    // the schema, a stamped amount would make the completion hook insert
    // goal_entries against a goal that must have none (the completions ARE
    // the record). Only savings starters stamp an auto-log amount.
    const contributionExtra =
      input.definition.type === 'savings' && starter.contribution !== undefined
        ? { goalContribution: starter.contribution }
        : {};
    const [templateRow] = await tx.select().from(tasks).where(eq(tasks.id, templateId)).limit(1);
    if (!templateRow) throw new Error('task_insert_failed');
    const [updatedTemplate] = await tx
      .update(tasks)
      .set({
        goalId: goal.id,
        config: { ...(templateRow.config as Record<string, unknown>), ...contributionExtra },
      })
      .where(eq(tasks.id, templateId))
      .returning();
    if (!updatedTemplate) throw new Error('task_update_failed');

    const instances = await tx.select().from(tasks).where(eq(tasks.templateId, templateId));
    let returnedInstance: TaskRow | null = null;
    for (const instance of instances) {
      const [updatedInstance] = await tx
        .update(tasks)
        .set({
          goalId: goal.id,
          config: { ...(instance.config as Record<string, unknown>), ...contributionExtra },
        })
        .where(eq(tasks.id, instance.id))
        .returning();
      if (!updatedInstance) throw new Error('task_update_failed');
      if (created.id === instance.id) returnedInstance = updatedInstance;
    }

    createdTasks.push(returnedInstance ?? updatedTemplate);
  }

  // The goal_created record is inserted *after* the starter tasks' own
  // task_created records, deliberately — undo_last_action reverts the most
  // recent record, and a user saying "undo that" right after tapping
  // Create means the whole thing, not just the last starter task. Its
  // payload carries the starter template ids so undoGoalRecord
  // (lib/tasks/executor.ts) can cascade them away with the goal.
  await tx.insert(records).values({
    userId,
    kind: 'goal_created',
    payload: {
      goalId: goal.id,
      name: goal.name,
      starterTaskIds: createdTasks.map((t) => t.templateId ?? t.id),
    },
    source: opts.source,
    sourceMessageId: opts.sourceMessageId ?? null,
    toolCallId: opts.toolCallId ?? null,
  });

  return { goal, tasks: createdTasks };
}

// Non-transactional wrapper for callers with no existing tx (kept for any
// direct caller other than routes/goals.ts, which uses createGoalInTx inside
// withUserLock so the active-goal cap check and the insert are atomic).
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
  return db.transaction((tx) => createGoalInTx(tx, userId, input, timezone, opts));
}

// --- edit (constrained ops) ---------------------------------------------

/**
 * Applies a constrained edit patch to a goal's current definition —
 * targetValue and deadline exist on savings and indirect; unit exists only
 * on indirect; a habit goal's definition has nothing numeric to edit
 * (name/icon live on the row, not in here). Returns an error string instead
 * of throwing so the executor can wrap it consistently as an invalid_input.
 */
function applyEditOps(
  definition: GoalDefinition,
  patch: EditGoalPatch,
): { definition: GoalDefinition } | { error: string } {
  if (definition.type === 'habit') {
    if (patch.targetValue !== undefined || patch.deadline !== undefined || patch.unit !== undefined) {
      return { error: 'a habit goal has no target amount, deadline, or unit to change — only its name or icon can be edited' };
    }
    return { definition };
  }

  if (definition.type === 'milestone') {
    if (patch.targetValue !== undefined || patch.deadline !== undefined || patch.unit !== undefined) {
      return {
        error: 'a milestone goal has no target amount, deadline, or unit — only its name, icon, or stages can be edited',
      };
    }
    // stages/stagePlans edits are routed through applyStageOps (schema.ts)
    // against the LIVE definition — it enforces the completed-prefix-
    // immutable / 0-or-2-8 / stagePlans-alignment invariants that this flat
    // patch shape can't (docs/goal-manual-editing-plan.md §2/§3.1).
    if (patch.stages === undefined && patch.stagePlans === undefined) return { definition };
    return applyStageOps(definition, patch.stages, patch.stagePlans);
  }

  if (definition.type === 'savings') {
    if (patch.unit !== undefined) {
      return { error: 'a savings goal has no unit field — it always uses currency' };
    }
    let next: SavingsGoalDefinition = definition;
    if (patch.targetValue !== undefined) next = { ...next, targetValue: patch.targetValue };
    if (patch.deadline !== undefined) next = { ...next, deadline: patch.deadline };
    const parsed = goalDefinitionSchema.safeParse(next);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'invalid goal definition' };
    return { definition: parsed.data };
  }

  // indirect
  let next: IndirectGoalDefinition = definition;
  if (patch.targetValue !== undefined) next = { ...next, targetValue: patch.targetValue };
  if (patch.deadline !== undefined) next = { ...next, deadline: patch.deadline };
  if (patch.unit !== undefined) next = { ...next, unit: patch.unit };

  // indirectGoalDefinitionSchema can't enforce this itself (see its comment
  // — a discriminated union member can't carry a superRefine) — checked here
  // instead, same rule as create's.
  if (next.deadline !== undefined && next.targetValue === undefined) {
    return { error: 'a deadline only makes sense with a target value — include one or drop the deadline' };
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

    // A unit is only a display label, not stored per entry — changing it
    // after entries exist would silently relabel real history rather than
    // convert it (a "steps" log reading as "12,000mi" after a rename,
    // caught live). Locked once the goal has any live entry; the user's
    // explicit call after seeing that happen — start a new goal instead if
    // the unit genuinely needs to change.
    if (patch.unit !== undefined && currentDefinition.type === 'indirect') {
      const [existingEntry] = await tx
        .select({ id: goalEntries.id })
        .from(goalEntries)
        .innerJoin(records, eq(goalEntries.recordId, records.id))
        .where(and(eq(goalEntries.goalId, goalId), isNull(records.revertedAt)))
        .limit(1);
      if (existingEntry) {
        throw new GoalActionError(
          'invalid_input',
          `"${goal.name}" already has logged entries in "${currentDefinition.unit}" — changing the unit now would relabel that history instead of converting it, so it can't be changed. Start a new goal instead if the unit needs to change.`,
        );
      }
    }

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
    // Habit goals have no entries by design — the check-in task's
    // completions ARE the record, and inventing an "amount" for a habit
    // would be exactly the fabricated-number class CLAUDE.md §2 bans.
    if ((goal.definition as GoalDefinition).type === 'habit') {
      throw new GoalActionError(
        'invalid_input',
        `"${goal.name}" is a habit goal — it tracks check-ins through its daily task, not logged amounts. Completing the task is the check-in.`,
      );
    }
    // Milestone goals have no numbers at all (docs/milestone-goal-plan.md
    // §0) — a stage advance is declared in chat via advance_goal_stage's
    // confirm card, never logged as an amount.
    if ((goal.definition as GoalDefinition).type === 'milestone') {
      throw new GoalActionError(
        'invalid_input',
        `"${goal.name}" is a milestone goal — it advances through stages, not logged amounts. Say when a stage is done and I'll propose moving to the next one.`,
      );
    }

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

export async function archiveGoal(
  userId: string,
  goalId: string,
  opts: ActionSource,
): Promise<{ goal: GoalRow; cascadedTaskTitles: string[] }> {
  return db.transaction(async (tx) => {
    const idempotent = await findIdempotentGoalRecord(tx, userId, opts, 'goal_archived', goalId);
    if (idempotent) return { goal: await loadGoal(tx, userId, goalId), cascadedTaskTitles: [] };

    const goal = await loadGoalForUpdate(tx, userId, goalId);

    // Linked tasks go with the goal — without this, removing a goal leaves
    // its "Save $5 daily" nagging forever: still due every day, dragging
    // every day's consistency verdict to "missed", while completing it logs
    // nothing (the archived-entry guard). The cascade itself (which tasks
    // go, the goal_archived record whose payload undo restores) is shared
    // with the goal-linked-template removal rule and lives in
    // tasks/executor's archiveGoalCascadeInTx.
    const { goal: updated, cascadedTaskTitles } = await archiveGoalCascadeInTx(tx, userId, goal, opts);
    return { goal: updated, cascadedTaskTitles };
  });
}

// --- milestone advance -------------------------------------------------

/**
 * Consumes an advance_goal_stage confirm-card proposal (docs/milestone-
 * goal-plan.md §2.2) — the ONLY way a milestone goal's activeStageIndex
 * moves. Called by POST /goals/:id/advance once the user taps the card;
 * that route re-validates ownership/message-kind before this runs, and this
 * function itself re-validates the goal's LIVE state (type, not archived,
 * not already complete, current stage matches what the card showed) rather
 * than trusting the stored proposal blindly — the same "never trust what
 * the model/card said, recheck the DB" discipline as createGoal.
 * Idempotent the same way createGoal is: keyed on (sourceMessageId, kind)
 * via findIdempotentGoalRecord, so a retried or double-tapped confirm
 * returns the original outcome instead of double-advancing.
 */
export async function advanceGoalStage(
  userId: string,
  goalId: string,
  proposal: Pick<AdvanceStageProposal, 'fromStageIndex' | 'retire' | 'nextStageTasks'>,
  timezone: string | null,
  opts: ActionSource,
): Promise<{ goal: GoalRow; tasks: TaskRow[] }> {
  return db.transaction(async (tx) => {
    const idempotent = await findIdempotentGoalRecord(tx, userId, opts, 'goal_stage_advanced', goalId);
    if (idempotent) {
      const payload = idempotent.payload as { createdTaskIds?: string[] };
      const goal = await loadGoal(tx, userId, goalId);
      const createdTasks = payload.createdTaskIds?.length
        ? await tx.select().from(tasks).where(inArray(tasks.id, payload.createdTaskIds))
        : [];
      return { goal, tasks: createdTasks };
    }

    const goal = await loadGoalForUpdate(tx, userId, goalId);
    const definition = goal.definition as GoalDefinition;
    if (definition.type !== 'milestone') {
      throw new GoalActionError('invalid_input', `"${goal.name}" isn't a milestone goal — there's nothing to advance.`);
    }
    if (definition.stages.length === 0) {
      throw new GoalActionError(
        'invalid_input',
        `"${goal.name}" has no stages set yet — add them in the Goals tab before advancing.`,
      );
    }
    if (definition.activeStageIndex >= definition.stages.length) {
      throw new GoalActionError('invalid_input', `"${goal.name}" is already complete — every stage is done.`);
    }
    if (isAdvanceProposalStale(definition.activeStageIndex, proposal.fromStageIndex)) {
      throw new GoalActionError(
        'invalid_input',
        `"${goal.name}" has already moved on since that card was shown — ask again for a fresh one.`,
      );
    }

    const prior = { definition: goal.definition, version: goal.version };
    const nextActiveIndex = definition.activeStageIndex + 1;
    // The stage about to activate had its own stagePlans entry (its planned
    // tasks) — those are materialized into real task rows below, so the
    // plan is consumed and cleared. A stage's tasks are either a plan or
    // real tasks, never briefly both (docs/goal-manual-editing-plan.md §2
    // invariant).
    const carriedStagePlans = definition.stagePlans?.map((entry, i) => (i === nextActiveIndex ? [] : entry));
    const hasAnyPlan = carriedStagePlans?.some((entry) => entry.length > 0) ?? false;
    const nextDefinition = {
      ...definition,
      activeStageIndex: nextActiveIndex,
      stagePlans: hasAnyPlan ? carriedStagePlans : undefined,
    };
    const parsedDefinition = goalDefinitionSchema.parse(nextDefinition);

    const [updated] = await tx
      .update(goals)
      .set({ definition: parsedDefinition, version: goal.version + 1 })
      .where(eq(goals.id, goal.id))
      .returning();
    if (!updated) throw new Error('goal_update_failed');

    // Retire the proposal's tasks — re-checked against LIVE state (still
    // linked to this goal, not already deleted), not just what the card
    // showed when it was rendered. Same filter as archiveGoalCascadeInTx:
    // a recurring template goes regardless of status; an instance or
    // standalone task only while still open — a done one is history and
    // keeps its record.
    const proposalIds = proposal.retire.map((r) => r.taskId);
    let retiredTaskIds: string[] = [];
    if (proposalIds.length) {
      const liveLinked = await tx
        .select({ id: tasks.id, recurrence: tasks.recurrence, status: tasks.status })
        .from(tasks)
        .where(and(inArray(tasks.id, proposalIds), eq(tasks.goalId, goal.id), isNull(tasks.deletedAt)));
      const toRetire = filterRetireCandidates(liveLinked);
      retiredTaskIds = toRetire.map((t) => t.id);
      if (retiredTaskIds.length) {
        await tx.update(tasks).set({ deletedAt: new Date() }).where(inArray(tasks.id, retiredTaskIds));
      }
    }

    // Create the next stage's tasks — same shape as createGoal's starter-
    // task loop (skipRecord: true, one record for the whole advance, a
    // distinct toolCallId per starter so createTaskInTx's own idempotency
    // can't collapse starter #2 into starter #1's result). Never a
    // contribution — a milestone goal never logs a number from a task
    // (schema-enforced upstream, but nothing here would stamp one anyway).
    //
    // The tasks come from whoever supplied them: the model, if the user
    // stated the next stage's plan in the same breath as the advance
    // declaration ("got the offer! now I need to research salary bands");
    // otherwise the stage's own `stagePlans` entry, planned earlier in the
    // Goals tab (docs/goal-manual-editing-plan.md §3.3) — the same default-
    // source swap plannedTasksForStage exists for.
    const nextStageTasksRaw: (StarterTask | PlannedTask)[] =
      proposal.nextStageTasks ?? plannedTasksForStage(definition, nextActiveIndex);
    const nextStageTasks = nextStageTasksRaw.map((t) => ({
      title: t.title,
      recurrence: t.recurrence,
      icon: 'icon' in t ? t.icon : undefined,
    }));

    const createdTaskIds: string[] = [];
    const createdTasks: TaskRow[] = [];
    for (const [index, starter] of nextStageTasks.entries()) {
      const { task: created } = await createTaskInTx(
        tx,
        userId,
        { type: 'completion', title: starter.title, recurrence: starter.recurrence, icon: starter.icon, reminder: false },
        timezone,
        { ...opts, toolCallId: `advance-starter:${index}` },
        { skipRecord: true },
      );
      const templateId = created.templateId ?? created.id;
      const [templateRow] = await tx.select().from(tasks).where(eq(tasks.id, templateId)).limit(1);
      if (!templateRow) throw new Error('task_insert_failed');
      const [updatedTemplate] = await tx
        .update(tasks)
        .set({ goalId: goal.id })
        .where(eq(tasks.id, templateId))
        .returning();
      if (!updatedTemplate) throw new Error('task_update_failed');
      createdTaskIds.push(templateId);

      const instances = await tx.select().from(tasks).where(eq(tasks.templateId, templateId));
      let returnedInstance: TaskRow | null = null;
      for (const instance of instances) {
        const [updatedInstance] = await tx
          .update(tasks)
          .set({ goalId: goal.id })
          .where(eq(tasks.id, instance.id))
          .returning();
        if (!updatedInstance) throw new Error('task_update_failed');
        if (created.id === instance.id) returnedInstance = updatedInstance;
      }
      createdTasks.push(returnedInstance ?? updatedTemplate);
    }

    // ONE record for the whole advance — undo (undoGoalRecord's
    // 'goal_stage_advanced' case) restores prior.definition/version,
    // un-deletes retiredTaskIds, and soft-deletes createdTaskIds as a unit,
    // the same goal_created-undo cascade shape.
    await tx.insert(records).values({
      userId,
      kind: 'goal_stage_advanced',
      payload: { goalId: goal.id, name: updated.name, prior, retiredTaskIds, createdTaskIds },
      source: opts.source,
      sourceMessageId: opts.sourceMessageId ?? null,
      toolCallId: opts.toolCallId ?? null,
    });

    return { goal: updated, tasks: createdTasks };
  });
}
