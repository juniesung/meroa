import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { Hono } from 'hono';

import { db } from '../db/client.ts';
import { toolEntries, tools } from '../db/schema.ts';
import { requireAuth, type AuthVariables } from '../middleware/auth.ts';

export const toolRoutes = new Hono<{ Variables: AuthVariables }>();
toolRoutes.use('*', requireAuth);

// Read-only for Phase 1 — creation/editing via chat preview arrives in Phase 4.
toolRoutes.get('/', async (c) => {
  const userId = c.get('userId');
  const rows = await db
    .select()
    .from(tools)
    .where(and(eq(tools.userId, userId), isNull(tools.archivedAt)))
    .orderBy(desc(tools.createdAt));

  const withCounts = await Promise.all(
    rows.map(async (tool) => {
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(toolEntries)
        .where(eq(toolEntries.toolId, tool.id));
      return { ...tool, entryCount: row?.count ?? 0 };
    }),
  );

  return c.json({ tools: withCounts });
});
