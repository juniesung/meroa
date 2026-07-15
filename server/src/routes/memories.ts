import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';

import { createMemory, deleteMemory, listMemories, updateMemoryFromUser } from '../lib/memories/executor.ts';
import { requireAuth, type AuthVariables } from '../middleware/auth.ts';

export const memoryRoutes = new Hono<{ Variables: AuthVariables }>();
memoryRoutes.use('*', requireAuth);

const MEMORY_KINDS = ['preference', 'trait', 'relationship', 'situation'] as const;

// The memory-controls UI shows what chat never sees — includeSuppressed:
// true is deliberate here (a user has to be able to find and un-suppress a
// row), and the injection path (routes/messages.ts) never uses this route.
memoryRoutes.get('/', async (c) => {
  const userId = c.get('userId');
  const rows = await listMemories(userId, { includeSuppressed: true });
  return c.json({ memories: rows });
});

const createMemorySchema = z.object({
  content: z.string().trim().min(1).max(200),
  kind: z.enum(MEMORY_KINDS),
  sensitive: z.boolean().optional(),
});

// User-authored, via the You tab's "add memory" — source: 'manual', same as
// the seed data, distinct from a chat-originated remember/extracted row.
memoryRoutes.post('/', zValidator('json', createMemorySchema), async (c) => {
  const userId = c.get('userId');
  const input = c.req.valid('json');
  const memory = await createMemory(userId, { ...input, source: 'manual' });
  return c.json({ memory }, 201);
});

const patchMemorySchema = z.object({
  content: z.string().trim().min(1).max(200).optional(),
  sensitive: z.boolean().optional(),
  suppressed: z.boolean().optional(),
});

// The one path allowed to LOWER sensitivity or flip suppressed — a real
// person correcting their own data (lib/memories/executor.ts's
// updateMemoryFromUser, as opposed to the AI-facing ratchet-only paths).
memoryRoutes.patch('/:id', zValidator('json', patchMemorySchema), async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const patch = c.req.valid('json');
  const memory = await updateMemoryFromUser(userId, id, patch);
  if (!memory) return c.json({ error: 'not_found' }, 404);
  return c.json({ memory });
});

memoryRoutes.delete('/:id', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const removed = await deleteMemory(userId, id);
  if (!removed) return c.json({ error: 'not_found' }, 404);
  return c.json({ ok: true });
});
