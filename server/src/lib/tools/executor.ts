import { and, desc, eq, isNull, lt } from 'drizzle-orm';

import { db } from '../../db/client.ts';
import { records, toolEntries, tools } from '../../db/schema.ts';
import type { ActionSource } from '../tasks/executor.ts';
import {
  toolDefinitionSchema,
  validateEntryValues,
  type EditToolPatch,
  type LogToolEntryPatch,
  type ToolDefinition,
  type ToolField,
  type ToolFieldInput,
  type ToolTemplateKey,
} from './schema.ts';

export type ToolRow = typeof tools.$inferSelect;
export type ToolEntryRow = typeof toolEntries.$inferSelect;
type Tx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export class ToolActionError extends Error {
  code: 'not_found' | 'invalid_input';
  constructor(code: ToolActionError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

// Same chat-retry idempotency pattern as lib/tasks/executor.ts's
// findIdempotentRecord — a retried turn re-issuing the same tool call
// returns the original outcome instead of double-writing.
async function findIdempotentToolRecord(
  tx: Tx,
  userId: string,
  opts: ActionSource,
  kind: string,
  toolId?: string,
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
  const payload = existing.payload as { toolId?: string };
  if (toolId && payload.toolId !== toolId) return null;
  return existing;
}

async function loadTool(tx: Tx, userId: string, toolId: string): Promise<ToolRow> {
  const [tool] = await tx
    .select()
    .from(tools)
    .where(and(eq(tools.id, toolId), eq(tools.userId, userId), isNull(tools.archivedAt)))
    .limit(1);
  if (!tool) throw new ToolActionError('not_found', 'tool not found');
  return tool;
}

async function loadToolForUpdate(tx: Tx, userId: string, toolId: string): Promise<ToolRow> {
  const [tool] = await tx
    .select()
    .from(tools)
    .where(and(eq(tools.id, toolId), eq(tools.userId, userId), isNull(tools.archivedAt)))
    .for('update')
    .limit(1);
  if (!tool) throw new ToolActionError('not_found', 'tool not found');
  return tool;
}

// Read-only, non-throwing lookup — the AI action layer's nameHint
// verification and the create-from-preview flow both use this instead of
// the mutation-oriented functions below (mirrors lib/tasks/executor.ts's
// getTask).
export async function getTool(userId: string, toolId: string): Promise<ToolRow | null> {
  const [tool] = await db
    .select()
    .from(tools)
    .where(and(eq(tools.id, toolId), eq(tools.userId, userId), isNull(tools.archivedAt)))
    .limit(1);
  return tool ?? null;
}

// --- create ----------------------------------------------------------
// `create_tool` (the AI tool, lib/ai/actions.ts) never calls this — it only
// builds and returns a preview definition. This is the actual save, called
// by POST /tools once the user taps Create on the preview card, with the
// exact definition that was shown (re-validated here, not rebuilt from
// params) so what gets saved always matches what was previewed.
export async function createTool(
  userId: string,
  input: { template: ToolTemplateKey; name: string; icon?: string | null; definition: ToolDefinition },
  opts: ActionSource,
): Promise<{ tool: ToolRow }> {
  return db.transaction(async (tx) => {
    const idempotent = await findIdempotentToolRecord(tx, userId, opts, 'tool_created');
    if (idempotent) {
      const payload = idempotent.payload as { toolId: string };
      const [existingTool] = await tx.select().from(tools).where(eq(tools.id, payload.toolId)).limit(1);
      if (existingTool) return { tool: existingTool };
    }

    const definition = toolDefinitionSchema.parse(input.definition);

    const [tool] = await tx
      .insert(tools)
      .values({
        userId,
        template: input.template,
        name: input.name,
        icon: input.icon ?? null,
        version: 1,
        definition,
      })
      .returning();
    if (!tool) throw new Error('tool_insert_failed');

    await tx.insert(records).values({
      userId,
      kind: 'tool_created',
      payload: { toolId: tool.id, name: tool.name },
      source: opts.source,
      sourceMessageId: opts.sourceMessageId ?? null,
      toolCallId: opts.toolCallId ?? null,
    });

    return { tool };
  });
}

// --- edit (constrained ops) ---------------------------------------------

function addField(fields: ToolField[], input: ToolFieldInput): ToolField[] {
  return [...fields, { id: crypto.randomUUID(), ...input }];
}

/**
 * Applies a constrained edit patch to a tool's current definition. Never
 * resends or reconstructs the whole definition from scratch — only the
 * fields the caller actually touched change (docs/ai-reliability-hardening.md
 * lesson 13: an edit surface that can't faithfully represent a value must
 * never resave a guessed one). Returns an error string instead of throwing
 * so the executor can wrap it consistently as an invalid_input.
 */
function applyEditOps(
  definition: ToolDefinition,
  patch: EditToolPatch,
): { definition: ToolDefinition } | { error: string } {
  let next = definition;

  if (patch.targetValue !== undefined) {
    if (!next.target) {
      return { error: 'this tool has no target to change — ask the user if they want to add one' };
    }
    next = { ...next, target: { ...next.target, value: patch.targetValue } };
  }

  if (patch.unit !== undefined) {
    if (!next.primaryFieldId) {
      return { error: 'this tool has no primary numeric field to set a unit on' };
    }
    const primaryId = next.primaryFieldId;
    next = {
      ...next,
      fields: next.fields.map((f) => (f.id === primaryId ? { ...f, unit: patch.unit } : f)),
      target: next.target && next.target.kind === 'total' ? { ...next.target, unit: patch.unit } : next.target,
    };
  }

  if (patch.addFields?.length) {
    if (next.fields.filter((f) => !f.archived).length + patch.addFields.length > 20) {
      return { error: 'that would be too many fields — remove one first, or ask what to drop' };
    }
    next = { ...next, fields: patch.addFields.reduce(addField, next.fields) };
  }

  if (patch.removeFieldIds?.length) {
    const removeSet = new Set(patch.removeFieldIds);
    const missing = patch.removeFieldIds.filter((id) => !next.fields.some((f) => f.id === id));
    if (missing.length) return { error: `unknown field id(s): ${missing.join(', ')}` };
    // A field still backing the primary summed total or a chart's summed
    // measure can't just vanish out from under those — reject rather than
    // silently breaking the definition; the model can ask the user which to
    // drop first (the target/view, or pick a different field).
    if (next.primaryFieldId && removeSet.has(next.primaryFieldId)) {
      return { error: 'that field backs this tool\'s total — remove the target first, or choose a different field' };
    }
    const usedByBars = next.views.some((v) => v.kind === 'bars' && v.fieldId && removeSet.has(v.fieldId));
    if (usedByBars) {
      return { error: 'that field backs one of this tool\'s charts — ask the user which to drop first' };
    }
    next = { ...next, fields: next.fields.map((f) => (removeSet.has(f.id) ? { ...f, archived: true } : f)) };
  }

  if (patch.renameFields?.length) {
    const missing = patch.renameFields.filter((r) => !next.fields.some((f) => f.id === r.fieldId));
    if (missing.length) return { error: `unknown field id(s): ${missing.map((r) => r.fieldId).join(', ')}` };
    const labelById = new Map(patch.renameFields.map((r) => [r.fieldId, r.label]));
    next = { ...next, fields: next.fields.map((f) => (labelById.has(f.id) ? { ...f, label: labelById.get(f.id)! } : f)) };
  }

  const parsed = toolDefinitionSchema.safeParse(next);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'invalid tool definition' };
  return { definition: parsed.data };
}

export async function editTool(
  userId: string,
  toolId: string,
  patch: EditToolPatch,
  opts: ActionSource,
): Promise<{ tool: ToolRow }> {
  return db.transaction(async (tx) => {
    const idempotent = await findIdempotentToolRecord(tx, userId, opts, 'tool_edited', toolId);
    if (idempotent) return { tool: await loadTool(tx, userId, toolId) };

    const tool = await loadToolForUpdate(tx, userId, toolId);
    const currentDefinition = tool.definition as ToolDefinition;

    const prior = { name: tool.name, icon: tool.icon, definition: tool.definition, version: tool.version };

    const name = patch.name ?? tool.name;
    const icon = patch.icon !== undefined ? patch.icon : tool.icon;
    const result = applyEditOps(currentDefinition, patch);
    if ('error' in result) throw new ToolActionError('invalid_input', result.error);

    const noChange =
      name === tool.name && icon === tool.icon && JSON.stringify(result.definition) === JSON.stringify(tool.definition);
    if (noChange) return { tool };

    const [updated] = await tx
      .update(tools)
      .set({ name, icon, definition: result.definition, version: tool.version + 1 })
      .where(eq(tools.id, tool.id))
      .returning();
    if (!updated) throw new Error('tool_update_failed');

    await tx.insert(records).values({
      userId,
      kind: 'tool_edited',
      payload: { toolId: tool.id, name: updated.name, prior },
      source: opts.source,
      sourceMessageId: opts.sourceMessageId ?? null,
      toolCallId: opts.toolCallId ?? null,
    });

    return { tool: updated };
  });
}

// --- log entry -----------------------------------------------------------

export async function logToolEntry(
  userId: string,
  toolId: string,
  patch: LogToolEntryPatch,
  opts: ActionSource,
): Promise<{ tool: ToolRow; entry: ToolEntryRow }> {
  return db.transaction(async (tx) => {
    const idempotent = await findIdempotentToolRecord(tx, userId, opts, 'tool_entry', toolId);
    if (idempotent) {
      const payload = idempotent.payload as { entryId?: string };
      if (payload.entryId) {
        const [entry] = await tx.select().from(toolEntries).where(eq(toolEntries.id, payload.entryId)).limit(1);
        if (entry) return { tool: await loadTool(tx, userId, toolId), entry };
      }
    }

    const tool = await loadTool(tx, userId, toolId);
    const definition = tool.definition as ToolDefinition;
    const error = validateEntryValues(definition.fields, patch.values);
    if (error) throw new ToolActionError('invalid_input', error);

    // patch.entryAt, when set, has already been normalized to a real UTC
    // instant by the caller (lib/ai/actions.ts, via localDatetimeToUtcIso) —
    // same convention as every dueAt reaching lib/tasks/executor.ts.
    const entryAt = patch.entryAt ? new Date(patch.entryAt) : new Date();
    const data: Record<string, unknown> = Object.fromEntries(patch.values.map((v) => [v.fieldId, v.value]));

    const [record] = await tx
      .insert(records)
      .values({
        userId,
        kind: 'tool_entry',
        payload: { toolId: tool.id, name: tool.name, data, entryAt: entryAt.toISOString() },
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
      .insert(toolEntries)
      .values({ toolId: tool.id, recordId: record.id, data, entryAt })
      .returning();
    if (!entry) throw new Error('entry_insert_failed');

    // Stamp the entry id onto the just-inserted record's payload so a
    // retried call (idempotency path above) and undo (which reads the
    // record, not the entry, as its source of truth) both know exactly
    // which tool_entries row this created.
    await tx.update(records).set({ payload: { ...record.payload as object, entryId: entry.id } }).where(eq(records.id, record.id));

    return { tool, entry };
  });
}

// --- read (history) ------------------------------------------------------

// Newest-first, cursor-paginated live entries (backed by a non-reverted
// record) for a tool's history view. Ownership is the caller's
// responsibility (routes/tools.ts checks getTool first) — this only reads.
export async function listToolEntries(
  toolId: string,
  opts: { limit: number; before?: Date },
): Promise<ToolEntryRow[]> {
  const conditions = [eq(toolEntries.toolId, toolId), isNull(records.revertedAt)];
  if (opts.before) conditions.push(lt(toolEntries.entryAt, opts.before));
  return db
    .select({
      id: toolEntries.id,
      toolId: toolEntries.toolId,
      recordId: toolEntries.recordId,
      data: toolEntries.data,
      entryAt: toolEntries.entryAt,
      createdAt: toolEntries.createdAt,
    })
    .from(toolEntries)
    .innerJoin(records, eq(toolEntries.recordId, records.id))
    .where(and(...conditions))
    .orderBy(desc(toolEntries.entryAt))
    .limit(opts.limit);
}

// --- archive ---------------------------------------------------------

export async function archiveTool(userId: string, toolId: string, opts: ActionSource): Promise<{ tool: ToolRow }> {
  return db.transaction(async (tx) => {
    const idempotent = await findIdempotentToolRecord(tx, userId, opts, 'tool_archived', toolId);
    if (idempotent) return { tool: await loadTool(tx, userId, toolId) };

    const tool = await loadToolForUpdate(tx, userId, toolId);
    const [updated] = await tx.update(tools).set({ archivedAt: new Date() }).where(eq(tools.id, tool.id)).returning();
    if (!updated) throw new Error('tool_update_failed');

    await tx.insert(records).values({
      userId,
      kind: 'tool_archived',
      payload: { toolId: tool.id, name: tool.name },
      source: opts.source,
      sourceMessageId: opts.sourceMessageId ?? null,
      toolCallId: opts.toolCallId ?? null,
    });

    return { tool: updated };
  });
}
