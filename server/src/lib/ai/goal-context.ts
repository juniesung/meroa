import { and, desc, eq, inArray, isNull } from 'drizzle-orm';

import { db } from '../../db/client.ts';
import { goals, tasks } from '../../db/schema.ts';
import { formatYmdShort, ymdInTz } from '../tasks/recurrence.ts';
import type { GoalDefinition } from '../goals/schema.ts';
import { buildGoalCardSummaries, formatMoney } from '../goals/summary.ts';
import type { TurnRefs } from './task-context.ts';

const MAX_ROWS = 10;
const MAX_CHARS = 1500;

// The first linked task per goal, so the goal line can state "$5/day via
// 'Save $5'" for savings or "check-in via 'Meditate'" for habit
// (docs/goals-redesign-plan.md §2.3) — the model already sees the task
// itself (with its own ref) in the task list, so this names it by title
// rather than duplicating a ref cross-reference. `contribution` is null for
// habit check-in tasks, which carry no amount by design.
async function fetchPrimaryContribution(
  goalIds: string[],
): Promise<Map<string, { title: string; contribution: number | null }>> {
  const byGoal = new Map<string, { title: string; contribution: number | null }>();
  if (goalIds.length === 0) return byGoal;
  const rows = await db
    .select({ goalId: tasks.goalId, title: tasks.title, config: tasks.config, createdAt: tasks.createdAt })
    .from(tasks)
    .where(and(inArray(tasks.goalId, goalIds), isNull(tasks.deletedAt)))
    .orderBy(tasks.createdAt);
  for (const row of rows) {
    if (!row.goalId || byGoal.has(row.goalId)) continue;
    const contribution = (row.config as Record<string, unknown>).goalContribution;
    byGoal.set(row.goalId, {
      title: row.title,
      contribution: typeof contribution === 'number' ? contribution : null,
    });
  }
  return byGoal;
}

/**
 * Compact goal-list summary injected into the AI's context, mirroring
 * buildTaskContext (task-context.ts) — turn-scoped aliases ("G1") instead
 * of database ids, precomputed card facts (lib/goals/summary.ts) instead of
 * raw entries the model would otherwise have to sum itself. Appends into
 * the same TurnRefs map the task context already built, so one ref
 * namespace covers both tasks and goals for the turn.
 */
export async function buildGoalContext(
  userId: string,
  timezone: string | null,
  refs: TurnRefs,
): Promise<{ text: string }> {
  const tz = timezone ?? 'UTC';

  const rows = await db
    .select()
    .from(goals)
    .where(and(eq(goals.userId, userId), isNull(goals.archivedAt)))
    .orderBy(desc(goals.createdAt))
    .limit(200);

  if (rows.length === 0) return { text: 'They have no goals yet.' };

  const summaries = await buildGoalCardSummaries(rows, timezone);
  const contributions = await fetchPrimaryContribution(rows.map((g) => g.id));

  const lines: string[] = [];
  let charCount = 0;
  let shown = 0;
  let truncated = false;

  for (const goal of rows) {
    if (truncated) continue;
    if (shown >= MAX_ROWS) {
      truncated = true;
      continue;
    }

    const alias = `G${shown + 1}`;
    const summary = summaries.get(goal.id)!;
    const definition = goal.definition as GoalDefinition;

    // Habit line leads with the streak (its whole mechanic) and the
    // check-in task; indirect states it never derives from a task; savings
    // with the money facts. All precomputed — the model quotes, never
    // derives (lesson 6).
    let line: string;
    if (definition.type === 'habit') {
      const contribution = contributions.get(goal.id);
      const viaLabel = contribution ? ` · check-in via "${contribution.title}" (complete_task IS the check-in)` : '';
      line = `[${alias}] "${goal.name}" · habit · ${summary.headline} (${summary.sub})${viaLabel}`;
    } else if (definition.type === 'milestone') {
      const done = definition.activeStageIndex >= definition.stages.length;
      const stageLabel = done
        ? `complete — all ${definition.stages.length} stages`
        : `stage ${definition.activeStageIndex + 1}/${definition.stages.length} "${definition.stages[definition.activeStageIndex]}"`;
      line = `[${alias}] "${goal.name}" · milestone · ${stageLabel} · advance ONLY on the user's say-so (advance_goal_stage) — a completed linked task is never a reason to advance`;
    } else if (definition.type === 'indirect') {
      const deadlineLabel = definition.deadline ? `, due ${formatYmdShort(definition.deadline)}` : '';
      const lastLabel = summary.lastEntryAt ? `, last ${formatYmdShort(ymdInTz(summary.lastEntryAt, tz))}` : '';
      const contribution = contributions.get(goal.id);
      const supportingLabel = contribution
        ? ` · supporting task "${contribution.title}" (never auto-logs a number)`
        : '';
      line = `[${alias}] "${goal.name}" · indirect · ${summary.headline} (${summary.sub})${summary.paceLine ? ` · ${summary.paceLine}` : ''}${deadlineLabel}${supportingLabel} · ${summary.entryCount} ${summary.entryCount === 1 ? 'entry' : 'entries'}${lastLabel}`;
    } else {
      const deadlineLabel = definition.deadline ? `, due ${formatYmdShort(definition.deadline)}` : '';
      const lastLabel = summary.lastEntryAt ? `, last ${formatYmdShort(ymdInTz(summary.lastEntryAt, tz))}` : '';
      const contribution = contributions.get(goal.id);
      const contributionLabel =
        contribution && contribution.contribution !== null
          ? ` · ${definition.currency}${formatMoney(contribution.contribution)}/completion via "${contribution.title}"`
          : '';
      line = `[${alias}] "${goal.name}" · ${summary.headline}${contributionLabel}${summary.paceLine ? ` · ${summary.paceLine}` : ''}${deadlineLabel} · ${summary.entryCount} ${summary.entryCount === 1 ? 'entry' : 'entries'}${lastLabel}`;
    }

    if (charCount + line.length > MAX_CHARS) {
      truncated = true;
      continue;
    }

    refs.set(alias, { kind: 'goal', goalId: goal.id });

    lines.push(line);
    charCount += line.length;
    shown += 1;
  }

  if (rows.length > shown) lines.push(`…and ${rows.length - shown} more.`);

  return { text: lines.join('\n') };
}
