import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';

import { db } from '../db/client.ts';
import { conversations, messages, goals, users } from '../db/schema.ts';
import {
  advanceGoalStage,
  archiveGoal,
  createGoalInTx,
  editGoal,
  getGoal,
  isAdvanceProposalStale,
  listGoalEntries,
  logGoalEntry,
  GoalActionError,
} from '../lib/goals/executor.ts';
import { computeActiveGoalAllowance, limitReachedBody, LimitReachedError } from '../lib/limits.ts';
import { withUserLock } from '../lib/usage.ts';
import {
  buildGoalDefinition,
  editGoalPatchSchema,
  logGoalEntryPatchSchema,
  goalDefinitionSchema,
  manualCreateGoalSchema,
  starterTaskSchema,
  GOAL_TEMPLATES,
  type AdvanceStageProposal,
  type GoalDefinition,
  type GoalTemplateKey,
} from '../lib/goals/schema.ts';
import { buildGoalCardSummaries, buildGoalDetail } from '../lib/goals/summary.ts';
import { buildGoalConsistency } from '../lib/goals/consistency.ts';
import { localDatetimeToUtcIso } from '../lib/tasks/recurrence.ts';
import { requireAuth, type AuthVariables } from '../middleware/auth.ts';
import { rateLimit } from '../middleware/rate-limit.ts';

export const goalRoutes = new Hono<{ Variables: AuthVariables }>();
goalRoutes.use('*', requireAuth);

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
  if (err instanceof GoalActionError) {
    const status = err.code === 'invalid_input' ? 400 : 404;
    return { status, body: { error: err.code, message: err.message } };
  }
  throw err;
}

goalRoutes.get('/', async (c) => {
  const userId = c.get('userId');
  const timezone = await getUserTimezone(userId);
  const rows = await db
    .select()
    .from(goals)
    .where(and(eq(goals.userId, userId), isNull(goals.archivedAt)))
    .orderBy(desc(goals.createdAt));

  const summaries = await buildGoalCardSummaries(rows, timezone);
  const withSummary = rows.map((goal) => ({ ...goal, ...summaries.get(goal.id)! }));
  return c.json({ goals: withSummary });
});

// Registered before /:id so "consistency" is never captured as a goal id.
goalRoutes.get('/consistency', async (c) => {
  const userId = c.get('userId');
  const timezone = await getUserTimezone(userId);
  const consistency = await buildGoalConsistency(userId, timezone);
  return c.json(consistency);
});

goalRoutes.get('/:id', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const timezone = await getUserTimezone(userId);

  const goal = await getGoal(userId, id);
  if (!goal) return c.json({ error: 'not_found', message: 'goal not found' }, 404);

  const [detail, entries] = await Promise.all([
    buildGoalDetail(goal, timezone),
    listGoalEntries(id, { limit: 20 }),
  ]);
  return c.json({ goal, detail, entries });
});

const entriesQuerySchema = z.object({
  cursor: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

goalRoutes.get('/:id/entries', zValidator('query', entriesQuerySchema), async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const { cursor, limit } = c.req.valid('query');

  const goal = await getGoal(userId, id);
  if (!goal) return c.json({ error: 'not_found', message: 'goal not found' }, 404);

  const entries = await listGoalEntries(id, {
    limit: limit ?? 30,
    before: cursor ? new Date(cursor) : undefined,
  });
  return c.json({ entries });
});

const createFromPreviewSchema = z.object({ previewMessageId: z.string().uuid() });

// Two ways to create a goal (docs/goal-manual-editing-plan.md §1): tap
// Create on a chat preview card (`previewMessageId`, unchanged — see
// below), or fill out the Goals-tab form directly (manualCreateGoalSchema
// — same cross-field rules as the chat create_goal tool, plus stagePlans).
// A body with `previewMessageId` fails manualCreateGoalSchema (`.strict()`
// rejects the unknown key) and a manual body fails createFromPreviewSchema
// (missing the required field), so the two branches are unambiguous.
const createGoalBodySchema = z.union([createFromPreviewSchema, manualCreateGoalSchema]);

// Confirm-tap target for the AI's create_goal preview card — create_goal
// itself never writes a goals row (docs/goals-redesign-plan.md §2.1); this
// is the actual save, using the exact definition that was shown on the
// card. Idempotent two ways: the stamped meta.createdGoalId (checked here)
// and the executor's own (sourceMessageId, kind) idempotency check, so a
// retried or double tap never creates a second goal.
//
// The manual branch (docs/goal-manual-editing-plan.md §1.4) routes through
// the SAME createGoal executor with the SAME `source: 'goal_ui'` — it
// yields an identical `goal_created` record, so undo and the recent-
// changes feed treat a manually-created goal exactly like a chat-created
// one. It has no sourceMessageId (there's no chat message behind it), so
// it gets no server-side double-tap idempotency — same as every other
// manual goal route below (editGoal, archiveGoal, logGoalEntry), none of
// which set one either; the client is responsible for not double-submitting
// a form, the same as it already is for every other create sheet.
goalRoutes.post('/', rateLimit({ windowMs: 60_000, max: 20 }), zValidator('json', createGoalBodySchema), async (c) => {
  const userId = c.get('userId');
  const body = c.req.valid('json');
  const timezone = await getUserTimezone(userId);

  if (!('previewMessageId' in body)) {
    const definition = buildGoalDefinition(body);
    try {
      const { goal, tasks } = await withUserLock(userId, async (tx) => {
        const allowance = await computeActiveGoalAllowance(tx, userId);
        if (!allowance.allowed) throw new LimitReachedError('goals', allowance);
        return createGoalInTx(
          tx,
          userId,
          {
            template: body.type,
            name: body.name,
            icon: body.icon ?? null,
            definition,
            starterTasks: body.starterTasks,
          },
          timezone,
          { source: 'goal_ui' },
        );
      });
      return c.json({ goal, tasks }, 201);
    } catch (err) {
      if (err instanceof LimitReachedError) {
        const { status, body } = limitReachedBody(err);
        return c.json(body, status);
      }
      const { status, body: errBody } = actionErrorResponse(err);
      return c.json(errBody, status);
    }
  }
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
    preview?: { template?: string; name?: string; icon?: string | null; definition?: unknown; starterTasks?: unknown };
    createdGoalId?: string;
  };
  if (meta.createdGoalId) {
    // Deliberately NOT filtered to non-archived (unlike getGoal): one
    // preview creates at most one goal, ever. Without the archived rows
    // here, a tap on a stale card whose goal was since undone/removed fell
    // through and created a duplicate (its goal_created record is reverted,
    // so the executor's idempotency check misses too — caught by the
    // as-a-user pass). If they want it back, that's a fresh preview or an
    // undo, not a re-tap.
    const [existing] = await db
      .select()
      .from(goals)
      .where(and(eq(goals.id, meta.createdGoalId), eq(goals.userId, userId)))
      .limit(1);
    if (existing) return c.json({ goal: existing, tasks: [] }, 200);
  }
  if (meta.kind !== 'goal_preview' || !meta.preview) {
    return c.json({ error: 'invalid_input', message: 'that message is not a goal preview' }, 400);
  }
  const { template, name, icon, definition, starterTasks } = meta.preview;
  if (!template || !GOAL_TEMPLATES.includes(template as GoalTemplateKey) || !name) {
    return c.json({ error: 'invalid_input', message: 'stored preview is malformed' }, 400);
  }
  const parsedDefinition = goalDefinitionSchema.safeParse(definition);
  if (!parsedDefinition.success) {
    return c.json({ error: 'invalid_input', message: 'stored preview definition is invalid' }, 400);
  }
  const parsedStarterTasks = starterTasks ? starterTaskSchema.array().safeParse(starterTasks) : null;
  if (starterTasks && !parsedStarterTasks?.success) {
    return c.json({ error: 'invalid_input', message: 'stored preview starter tasks are invalid' }, 400);
  }
  // A habit goal without its check-in task could never progress — the AI
  // schema already enforces this, but the tap re-validates the stored
  // preview rather than trusting it (same reason the definition re-parses).
  if (parsedDefinition.data.type === 'habit' && !parsedStarterTasks?.data?.length) {
    return c.json({ error: 'invalid_input', message: 'a habit preview must include its check-in task' }, 400);
  }

  try {
    const { goal, tasks } = await withUserLock(userId, async (tx) => {
      const allowance = await computeActiveGoalAllowance(tx, userId);
      if (!allowance.allowed) throw new LimitReachedError('goals', allowance);
      const result = await createGoalInTx(
        tx,
        userId,
        {
          template: template as GoalTemplateKey,
          name,
          icon: icon ?? null,
          definition: parsedDefinition.data,
          starterTasks: parsedStarterTasks?.data,
        },
        timezone,
        { source: 'goal_ui', sourceMessageId: previewMessageId },
      );
      await tx
        .update(messages)
        .set({ meta: { ...meta, createdGoalId: result.goal.id } })
        .where(eq(messages.id, previewMessageId));
      return result;
    });
    return c.json({ goal, tasks }, 201);
  } catch (err) {
    if (err instanceof LimitReachedError) {
      const { status, body } = limitReachedBody(err);
      return c.json(body, status);
    }
    const { status, body } = actionErrorResponse(err);
    return c.json(body, status);
  }
});

const advanceSchema = z.object({ proposalMessageId: z.string().uuid() });

// Confirm-tap target for the AI's advance_goal_stage proposal card —
// advance_goal_stage itself never mutates the goal (docs/milestone-goal-
// plan.md §2.1); this is the actual advance, re-validating the exact
// proposal that was shown against LIVE state before executing it. Mirrors
// POST / (create-from-preview) line by line, including the two-layer
// idempotency (the stamped meta.advancedRecordId here, and advanceGoalStage's
// own (sourceMessageId, kind) check) so a retried or double-tapped confirm
// never double-advances.
goalRoutes.post('/:id/advance', zValidator('json', advanceSchema), async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const { proposalMessageId } = c.req.valid('json');
  const timezone = await getUserTimezone(userId);

  const [row] = await db
    .select({ message: messages, conversationUserId: conversations.userId })
    .from(messages)
    .innerJoin(conversations, eq(messages.conversationId, conversations.id))
    .where(eq(messages.id, proposalMessageId))
    .limit(1);
  if (!row || row.conversationUserId !== userId) {
    return c.json({ error: 'not_found', message: 'that advance card no longer exists' }, 404);
  }

  const meta = row.message.meta as {
    kind?: string;
    proposal?: AdvanceStageProposal;
    advancedRecordId?: string;
  };
  if (meta.advancedRecordId) {
    // Deliberately NOT filtered to non-archived (unlike getGoal) — one
    // proposal advances at most once, ever, same reasoning as create-from-
    // preview's createdGoalId check.
    const [existing] = await db
      .select()
      .from(goals)
      .where(and(eq(goals.id, id), eq(goals.userId, userId)))
      .limit(1);
    if (existing) return c.json({ goal: existing, tasks: [] }, 200);
  }
  if (meta.kind !== 'goal_advance_pending' || !meta.proposal) {
    return c.json({ error: 'invalid_input', message: 'that message is not an advance proposal' }, 400);
  }
  if (meta.proposal.goalId !== id) {
    return c.json({ error: 'invalid_input', message: 'that proposal is for a different goal' }, 400);
  }

  const goal = await getGoal(userId, id);
  if (!goal) return c.json({ error: 'not_found', message: 'goal not found' }, 404);
  const definition = goal.definition as GoalDefinition;
  if (definition.type !== 'milestone') {
    return c.json({ error: 'invalid_input', message: "that goal isn't a milestone goal" }, 400);
  }
  if (isAdvanceProposalStale(definition.activeStageIndex, meta.proposal.fromStageIndex)) {
    return c.json(
      {
        error: 'invalid_input',
        message: 'that advance card is stale — the goal has moved on since; ask Meroa again.',
      },
      400,
    );
  }

  try {
    const { goal: updated, tasks } = await advanceGoalStage(
      userId,
      id,
      {
        fromStageIndex: meta.proposal.fromStageIndex,
        retire: meta.proposal.retire,
        nextStageTasks: meta.proposal.nextStageTasks,
      },
      timezone,
      { source: 'goal_ui', sourceMessageId: proposalMessageId },
    );
    await db
      .update(messages)
      .set({ meta: { ...meta, advancedRecordId: updated.id } })
      .where(eq(messages.id, proposalMessageId));
    return c.json({ goal: updated, tasks }, 201);
  } catch (err) {
    const { status, body } = actionErrorResponse(err);
    return c.json(body, status);
  }
});

goalRoutes.patch('/:id', zValidator('json', editGoalPatchSchema), async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const patch = c.req.valid('json');
  try {
    const { goal } = await editGoal(userId, id, patch, { source: 'goal_ui' });
    return c.json({ goal });
  } catch (err) {
    const { status, body } = actionErrorResponse(err);
    return c.json(body, status);
  }
});

// Quick-entry bottom sheet target — only ever sends fields the user actually
// filled in (docs/ai-reliability-hardening.md lesson 13); untouched optional
// fields are simply omitted, never defaulted.
goalRoutes.post('/:id/entries', zValidator('json', logGoalEntryPatchSchema), async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const timezone = await getUserTimezone(userId);
  const patch = c.req.valid('json');

  let entryAt: string | undefined;
  if (patch.entryAt) {
    const normalized = localDatetimeToUtcIso(patch.entryAt, timezone ?? 'UTC');
    if (!normalized) return c.json({ error: 'invalid_input', message: 'entryAt is not a valid datetime' }, 400);
    entryAt = normalized;
  }

  try {
    const { goal, entry } = await logGoalEntry(userId, id, { ...patch, entryAt }, { source: 'goal_ui' });
    return c.json({ goal, entry }, 201);
  } catch (err) {
    const { status, body } = actionErrorResponse(err);
    return c.json(body, status);
  }
});

goalRoutes.delete('/:id', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  try {
    const { goal } = await archiveGoal(userId, id, { source: 'goal_ui' });
    return c.json({ goal });
  } catch (err) {
    const { status, body } = actionErrorResponse(err);
    return c.json(body, status);
  }
});
