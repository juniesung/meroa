import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';

import { db } from '../db/client.ts';
import { conversations, messages, tools, users } from '../db/schema.ts';
import {
  archiveTool,
  createTool,
  editTool,
  getTool,
  listToolEntries,
  logToolEntry,
  ToolActionError,
} from '../lib/tools/executor.ts';
import {
  editToolPatchSchema,
  logToolEntryPatchSchema,
  toolDefinitionSchema,
  TOOL_TEMPLATES,
  type ToolTemplateKey,
} from '../lib/tools/schema.ts';
import { buildToolCardSummaries, buildToolDetail } from '../lib/tools/summary.ts';
import { localDatetimeToUtcIso } from '../lib/tasks/recurrence.ts';
import { requireAuth, type AuthVariables } from '../middleware/auth.ts';

export const toolRoutes = new Hono<{ Variables: AuthVariables }>();
toolRoutes.use('*', requireAuth);

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
  if (err instanceof ToolActionError) {
    const status = err.code === 'invalid_input' ? 400 : 404;
    return { status, body: { error: err.code, message: err.message } };
  }
  throw err;
}

toolRoutes.get('/', async (c) => {
  const userId = c.get('userId');
  const timezone = await getUserTimezone(userId);
  const rows = await db
    .select()
    .from(tools)
    .where(and(eq(tools.userId, userId), isNull(tools.archivedAt)))
    .orderBy(desc(tools.createdAt));

  const summaries = await buildToolCardSummaries(rows, timezone);
  const withSummary = rows.map((tool) => ({ ...tool, ...summaries.get(tool.id)! }));
  return c.json({ tools: withSummary });
});

toolRoutes.get('/:id', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const timezone = await getUserTimezone(userId);

  const tool = await getTool(userId, id);
  if (!tool) return c.json({ error: 'not_found', message: 'tool not found' }, 404);

  const [detail, entries] = await Promise.all([
    buildToolDetail(tool, timezone),
    listToolEntries(id, { limit: 20 }),
  ]);
  return c.json({ tool, detail, entries });
});

const entriesQuerySchema = z.object({
  cursor: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

toolRoutes.get('/:id/entries', zValidator('query', entriesQuerySchema), async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const { cursor, limit } = c.req.valid('query');

  const tool = await getTool(userId, id);
  if (!tool) return c.json({ error: 'not_found', message: 'tool not found' }, 404);

  const entries = await listToolEntries(id, {
    limit: limit ?? 30,
    before: cursor ? new Date(cursor) : undefined,
  });
  return c.json({ entries });
});

const createFromPreviewSchema = z.object({ previewMessageId: z.string().uuid() });

// Confirm-tap target for the AI's create_tool preview card — create_tool
// itself never writes a tools row (docs/phase-4-implementation-plan.md
// §1.3); this is the actual save, using the exact definition that was shown
// on the card. Idempotent two ways: the stamped meta.createdToolId (checked
// here) and the executor's own (sourceMessageId, kind) idempotency check, so
// a retried or double tap never creates a second tool.
toolRoutes.post('/', zValidator('json', createFromPreviewSchema), async (c) => {
  const userId = c.get('userId');
  const { previewMessageId } = c.req.valid('json');

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
    preview?: { template?: string; name?: string; icon?: string | null; definition?: unknown };
    createdToolId?: string;
  };
  if (meta.createdToolId) {
    const existing = await getTool(userId, meta.createdToolId);
    if (existing) return c.json({ tool: existing }, 200);
  }
  if (meta.kind !== 'tool_preview' || !meta.preview) {
    return c.json({ error: 'invalid_input', message: 'that message is not a tool preview' }, 400);
  }
  const { template, name, icon, definition } = meta.preview;
  if (!template || !TOOL_TEMPLATES.includes(template as ToolTemplateKey) || !name) {
    return c.json({ error: 'invalid_input', message: 'stored preview is malformed' }, 400);
  }
  const parsedDefinition = toolDefinitionSchema.safeParse(definition);
  if (!parsedDefinition.success) {
    return c.json({ error: 'invalid_input', message: 'stored preview definition is invalid' }, 400);
  }

  try {
    const { tool } = await createTool(
      userId,
      { template: template as ToolTemplateKey, name, icon: icon ?? null, definition: parsedDefinition.data },
      { source: 'tool_ui', sourceMessageId: previewMessageId },
    );
    await db
      .update(messages)
      .set({ meta: { ...meta, createdToolId: tool.id } })
      .where(eq(messages.id, previewMessageId));
    return c.json({ tool }, 201);
  } catch (err) {
    const { status, body } = actionErrorResponse(err);
    return c.json(body, status);
  }
});

toolRoutes.patch('/:id', zValidator('json', editToolPatchSchema), async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const patch = c.req.valid('json');
  try {
    const { tool } = await editTool(userId, id, patch, { source: 'tool_ui' });
    return c.json({ tool });
  } catch (err) {
    const { status, body } = actionErrorResponse(err);
    return c.json(body, status);
  }
});

// Quick-entry bottom sheet target — only ever sends fields the user actually
// filled in (docs/ai-reliability-hardening.md lesson 13); untouched optional
// fields are simply omitted, never defaulted.
toolRoutes.post('/:id/entries', zValidator('json', logToolEntryPatchSchema), async (c) => {
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
    const { tool, entry } = await logToolEntry(userId, id, { ...patch, entryAt }, { source: 'tool_ui' });
    return c.json({ tool, entry }, 201);
  } catch (err) {
    const { status, body } = actionErrorResponse(err);
    return c.json(body, status);
  }
});

toolRoutes.delete('/:id', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  try {
    const { tool } = await archiveTool(userId, id, { source: 'tool_ui' });
    return c.json({ tool });
  } catch (err) {
    const { status, body } = actionErrorResponse(err);
    return c.json(body, status);
  }
});
