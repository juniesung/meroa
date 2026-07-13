import { and, asc, eq, gt, inArray, isNull, or } from 'drizzle-orm';

import { db } from '../../db/client.ts';
import { goals, records, tasks } from '../../db/schema.ts';

const MAX_FEED_ENTRIES = 5;

function describeChange(kind: string, title: string): string {
  switch (kind) {
    case 'task_created':
      return `"${title}" was added`;
    case 'task_edited':
      return `"${title}" was edited`;
    case 'task_completion':
      return `"${title}" was marked done`;
    case 'task_progress':
      return `"${title}" progress was updated`;
    case 'task_postponed':
      return `"${title}" was postponed`;
    case 'task_removed':
      return `"${title}" was removed (you confirmed it)`;
    case 'goal_created':
      return `the "${title}" goal was created (you tapped Create)`;
    case 'goal_edited':
      return `the "${title}" goal was edited`;
    case 'goal_entry':
      return `an entry was logged to "${title}"`;
    case 'goal_archived':
      return `the "${title}" goal was removed`;
    case 'goal_stage_advanced':
      return `the "${title}" goal advanced to its next stage`;
    default:
      return `"${title}" changed`;
  }
}

// An undo reverses whichever kind of change it originally was — "restored"
// only reads right for a removal; the others need their own phrasing so the
// feed doesn't say something misleading like "X was restored" for an undone
// edit.
function describeUndo(undidKind: string, title: string): string {
  switch (undidKind) {
    case 'task_removed':
      return `"${title}" was restored (you undid removing it)`;
    case 'task_created':
      return `"${title}" was removed (you undid creating it)`;
    case 'task_completion':
    case 'task_progress':
      return `"${title}" progress was reverted (you undid the last change)`;
    case 'task_edited':
      return `"${title}" was reverted to its previous version (you undid the edit)`;
    case 'task_postponed':
      return `"${title}" was reverted to its previous due date (you undid the postpone)`;
    case 'goal_created':
      return `the "${title}" goal was removed (you undid creating it)`;
    case 'goal_archived':
      return `the "${title}" goal was brought back (you undid removing it)`;
    case 'goal_edited':
      return `the "${title}" goal was reverted to its previous version (you undid the edit)`;
    case 'goal_entry':
      return `that entry on "${title}" was removed (you undid logging it)`;
    case 'goal_stage_advanced':
      return `the "${title}" goal moved back a stage (you undid advancing it)`;
    default:
      return `"${title}" was reverted (you undid the last change)`;
  }
}

// One noun phrase per undoable record kind — what undo_last_action would
// take back, phrased as the action itself ("removing goal X"), not its
// effect, so the state line below reads as "the next undo reverts <this>".
function describeUndoable(kind: string, title: string): string {
  switch (kind) {
    case 'task_created':
      return `creating task "${title}"`;
    case 'task_completion':
      return `completing "${title}"`;
    case 'task_progress':
      return `the last progress update on "${title}"`;
    case 'task_edited':
      return `the last edit to "${title}"`;
    case 'task_postponed':
      return `postponing "${title}"`;
    case 'task_removed':
      return `removing "${title}"`;
    case 'goal_created':
      return `creating goal "${title}" (its starter tasks go too)`;
    case 'goal_edited':
      return `the last edit to goal "${title}"`;
    case 'goal_entry':
      return `the last entry logged to "${title}"`;
    case 'goal_archived':
      return `removing goal "${title}" (restores the goal AND its linked tasks)`;
    case 'goal_stage_advanced':
      return `advancing goal "${title}" to its next stage`;
    default:
      return `the last change to "${title}"`;
  }
}

/**
 * The state line for lib/tasks/executor.ts's peekUndoTarget: exactly what
 * undo_last_action would revert right now. The recent-changes feed below
 * narrates what happened; this states what undo DOES — without it, an
 * action that happened out-of-band (a Tasks-tab swipe) left the model's
 * conversational memory saying "nothing was ever saved", and it refused
 * "undo that" as nothing-to-undo (observed live). '' when there's nothing
 * undoable.
 */
export function renderUndoTarget(
  target: { kind: string; payload: unknown; source: string } | null,
): string {
  if (!target) return '';
  const payload = target.payload as {
    title?: string;
    name?: string;
    tasks?: { title: string }[];
  };
  const desc = payload.tasks?.length
    ? `removing ${payload.tasks.map((t) => `"${t.title}"`).join(', ')}`
    : describeUndoable(target.kind, payload.title ?? payload.name ?? 'the last change');
  return `If the user asks to undo: undo_last_action currently reverts ${desc}. This includes actions taken in the app outside this chat — never claim there's nothing to undo while this line is present.`;
}

/**
 * Out-of-band task/goal mutations — a Tasks-tab tap, a goal preview
 * Create-tap, a quick-entry log — are otherwise invisible to the model: its
 * own history only ever shows the "pending confirmation" side of the story,
 * never how it resolved. This surfaces everything recorded with source
 * 'tasks_ui' or 'goal_ui' since the previous user message as short prose, so
 * the model's next reply can reflect what actually happened instead of
 * completing an unresolved narrative wrongly (docs/ai-reliability-
 * hardening.md item 4, class 7). Returns '' when there's nothing to report
 * (including the first-ever message, when `since` is null).
 */
export async function buildRecentChangesFeed(userId: string, since: Date | null): Promise<string> {
  if (!since) return '';

  const rows = await db
    .select({ kind: records.kind, payload: records.payload })
    .from(records)
    .where(
      and(
        eq(records.userId, userId),
        or(eq(records.source, 'tasks_ui'), eq(records.source, 'goal_ui')),
        gt(records.occurredAt, since),
      ),
    )
    .orderBy(asc(records.occurredAt))
    .limit(MAX_FEED_ENTRIES);

  if (rows.length === 0) return '';

  const parsed = rows.map((row) => ({
    kind: row.kind,
    payload: row.payload as {
      taskId?: string;
      title?: string;
      // Goal payloads always carry `name` (the executor always has the
      // goal row in hand) — unlike task_edited's `title`, no batched lookup
      // is ever needed for these.
      name?: string;
      tasks?: { taskId: string; title: string }[];
      undidKind?: string;
    },
  }));

  // Only task_edited's payload lacks a title today, but this stays generic
  // rather than special-casing that kind by name — one batched lookup for
  // whichever rows need it, instead of one query per row.
  const missingTitleIds = [
    ...new Set(
      parsed
        .filter((r) => !r.payload.title && !r.payload.name && !r.payload.tasks?.length && r.payload.taskId)
        .map((r) => r.payload.taskId!),
    ),
  ];
  const titleById = new Map<string, string>();
  if (missingTitleIds.length > 0) {
    const found = await db
      .select({ id: tasks.id, title: tasks.title })
      .from(tasks)
      .where(inArray(tasks.id, missingTitleIds));
    for (const t of found) titleById.set(t.id, t.title);
  }

  // Connected loop: a task_completion/task_progress record whose task is
  // goal-linked auto-logged a contribution (lib/tasks/executor.ts's
  // applyProgress) — otherwise-invisible to the model the same way every
  // other out-of-band mutation here is, so it gets the same treatment
  // (docs/goals-redesign-plan.md §2.3). Only tasks currently `done` count —
  // a task reopened since (status back to 'open') no longer has a live
  // entry, so no contribution actually landed.
  const completionTaskIds = [
    ...new Set(
      parsed
        .filter((r) => (r.kind === 'task_completion' || r.kind === 'task_progress') && r.payload.taskId)
        .map((r) => r.payload.taskId!),
    ),
  ];
  const contributionByTaskId = new Map<string, { goalName: string; amount: number }>();
  if (completionTaskIds.length > 0) {
    const linked = await db
      .select({ id: tasks.id, goalId: tasks.goalId, config: tasks.config, status: tasks.status })
      .from(tasks)
      .where(inArray(tasks.id, completionTaskIds));
    const goalIds = [...new Set(linked.map((t) => t.goalId).filter((g): g is string => !!g))];
    const goalNameById = new Map<string, string>();
    if (goalIds.length > 0) {
      // Archived goals excluded — a completion after the goal was removed
      // logs nothing (lib/tasks/executor.ts's archived guard), so narrating
      // "adding $7 to X" for it would describe an entry that doesn't exist.
      const goalRows = await db
        .select({ id: goals.id, name: goals.name })
        .from(goals)
        .where(and(inArray(goals.id, goalIds), isNull(goals.archivedAt)));
      for (const g of goalRows) goalNameById.set(g.id, g.name);
    }
    for (const t of linked) {
      if (!t.goalId || t.status !== 'done') continue;
      const amount = (t.config as Record<string, unknown>).goalContribution;
      const goalName = goalNameById.get(t.goalId);
      if (typeof amount === 'number' && goalName) contributionByTaskId.set(t.id, { goalName, amount });
    }
  }

  const sentences: string[] = [];
  for (const { kind, payload } of parsed) {
    if (kind === 'task_undo' || kind === 'goal_undo') {
      const undidKind = payload.undidKind ?? 'unknown';
      if (payload.tasks?.length) {
        for (const t of payload.tasks) sentences.push(describeUndo(undidKind, t.title));
        continue;
      }
      const title = payload.title ?? payload.name ?? (payload.taskId && titleById.get(payload.taskId));
      sentences.push(describeUndo(undidKind, title || 'a task'));
      continue;
    }
    if (payload.tasks?.length) {
      for (const t of payload.tasks) sentences.push(describeChange(kind, t.title));
      continue;
    }
    const title = payload.title ?? payload.name ?? (payload.taskId && titleById.get(payload.taskId));
    const contribution = payload.taskId && contributionByTaskId.get(payload.taskId);
    const base = describeChange(kind, title || 'a task');
    sentences.push(contribution ? `${base}, adding ${contribution.amount} to "${contribution.goalName}"` : base);
  }

  return `Since your last message, in the app: ${sentences.join('; ')}.`;
}
