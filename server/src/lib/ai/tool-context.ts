import { and, desc, eq, isNull } from 'drizzle-orm';

import { db } from '../../db/client.ts';
import { tools } from '../../db/schema.ts';
import { formatYmdShort, ymdInTz } from '../tasks/recurrence.ts';
import type { ToolDefinition, ToolField } from '../tools/schema.ts';
import { buildToolCardSummaries } from '../tools/summary.ts';
import type { TurnRefs } from './task-context.ts';

const MAX_ROWS = 10;
const MAX_CHARS = 1500;

function renderField(field: ToolField, alias: string): string {
  const details = [field.type, field.unit, field.required ? undefined : 'optional'].filter(Boolean);
  if (field.type === 'choice' && field.options?.length) details.push(field.options.join('/'));
  return `${alias}="${field.label}" (${details.join(', ')})`;
}

/**
 * Compact tool-list summary injected into the AI's context, mirroring
 * buildTaskContext (task-context.ts) — turn-scoped aliases ("L1", "L1.1")
 * instead of database ids, precomputed card facts instead of raw entries the
 * model would otherwise have to sum itself. Appends into the same TurnRefs
 * map the task context already built, so one ref namespace covers both
 * tasks and tools for the turn.
 */
export async function buildToolContext(
  userId: string,
  timezone: string | null,
  refs: TurnRefs,
): Promise<{ text: string }> {
  const tz = timezone ?? 'UTC';

  const rows = await db
    .select()
    .from(tools)
    .where(and(eq(tools.userId, userId), isNull(tools.archivedAt)))
    .orderBy(desc(tools.createdAt))
    .limit(200);

  if (rows.length === 0) return { text: 'They have no tools yet.' };

  const summaries = await buildToolCardSummaries(rows, timezone);

  const lines: string[] = [];
  let charCount = 0;
  let shown = 0;
  let truncated = false;

  for (const tool of rows) {
    if (truncated) continue;
    if (shown >= MAX_ROWS) {
      truncated = true;
      continue;
    }

    const alias = `L${shown + 1}`;
    const summary = summaries.get(tool.id)!;
    const definition = tool.definition as ToolDefinition;
    const activeFields = definition.fields.filter((f) => !f.archived);
    const fieldRefs = activeFields.map((f, idx) => renderField(f, `${alias}.${idx + 1}`)).join('; ');
    const lastLabel = summary.lastEntryAt ? `, last ${formatYmdShort(ymdInTz(summary.lastEntryAt, tz))}` : '';

    const line = `[${alias}] "${tool.name}" · ${tool.template} · ${summary.headline} · ${summary.entryCount} entries${lastLabel}${fieldRefs ? ` [fields: ${fieldRefs}]` : ''}`;

    if (charCount + line.length > MAX_CHARS) {
      truncated = true;
      continue;
    }

    refs.set(alias, { kind: 'tool', toolId: tool.id });
    activeFields.forEach((f, idx) => {
      refs.set(`${alias}.${idx + 1}`, { kind: 'tool_field', toolId: tool.id, fieldId: f.id });
    });

    lines.push(line);
    charCount += line.length;
    shown += 1;
  }

  if (rows.length > shown) lines.push(`…and ${rows.length - shown} more.`);

  return { text: lines.join('\n') };
}
