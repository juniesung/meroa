import { Hono } from 'hono';

import { env } from '../env.ts';
import { logger } from '../logger.ts';
import { runNotificationTick } from '../lib/notifications/tick.ts';

// Internal, cron-driven endpoints. Not behind requireAuth (no user JWT) — guarded
// instead by a shared CRON_SECRET the Railway cron passes as a bearer token. When
// CRON_SECRET is unset the whole surface 404s, so proactive notifications stay
// off until it's deliberately configured (no accidental sends in dev).
export const internalRoutes = new Hono();

internalRoutes.post('/tick', async (c) => {
  if (!env.CRON_SECRET) return c.json({ error: 'not_found' }, 404);

  const header = c.req.header('authorization');
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
  if (token !== env.CRON_SECRET) return c.json({ error: 'unauthorized' }, 401);

  try {
    const result = await runNotificationTick();
    return c.json({ ok: true, ...result });
  } catch (err) {
    logger.error(err, 'notification tick failed');
    return c.json({ error: 'tick_failed' }, 500);
  }
});
