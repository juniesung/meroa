import { and, desc, eq, isNull } from 'drizzle-orm';

import { db } from '../../db/client.ts';
import { goals } from '../../db/schema.ts';
import { formatYmdShort, ymdInTz } from '../tasks/recurrence.ts';
import type { GoalDefinition } from '../goals/schema.ts';
import { buildGoalCardSummaries } from '../goals/summary.ts';
import type { TurnRefs } from './task-context.ts';

const MAX_ROWS = 10;
const MAX_CHARS = 1500;

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
    const deadlineLabel = definition.deadline ? `, due ${formatYmdShort(definition.deadline)}` : '';
    const lastLabel = summary.lastEntryAt ? `, last ${formatYmdShort(ymdInTz(summary.lastEntryAt, tz))}` : '';

    const line = `[${alias}] "${goal.name}" · ${summary.headline}${summary.paceLine ? ` · ${summary.paceLine}` : ''}${deadlineLabel} · ${summary.entryCount} entries${lastLabel}`;

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
