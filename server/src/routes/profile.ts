import { eq } from 'drizzle-orm';
import { Hono } from 'hono';

import { db } from '../db/client.ts';
import { users } from '../db/schema.ts';
import { evaluateAchievements } from '../lib/achievements/evaluate.ts';
import { buildAchievementsScreen } from '../lib/achievements/views.ts';
import { buildProfileOverview } from '../lib/profile/overview.ts';
import { requireAuth, type AuthVariables } from '../middleware/auth.ts';

export const profileRoutes = new Hono<{ Variables: AuthVariables }>();
profileRoutes.use('*', requireAuth);

// The You-tab profile surface. One read for hero (memberSince) + stat row +
// achievement badges + this-month recap. The streak/heatmap is fetched
// separately via GET /goals/consistency (already built) and not duplicated here.
profileRoutes.get('/overview', async (c) => {
  const userId = c.get('userId');

  const [user] = await db
    .select({ timezone: users.timezone, createdAt: users.createdAt })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) return c.json({ error: 'not_found' }, 404);

  // Backfill any already-earned tiers SILENTLY on read — a badge crossed before
  // this feature existed, or a streak tier that ticked over passively, becomes
  // a row so the profile shows it, but never queues a historical congrats
  // (silent pre-stamps announcedAt). Genuine in-action unlocks are announced by
  // their own call sites, not here.
  await evaluateAchievements(userId, user.timezone, db, { silent: true });

  const overview = await buildProfileOverview(userId, user.timezone, user.createdAt);
  return c.json(overview);
});

// The dedicated Achievements screen — the full per-user catalog (globals +
// per-goal + consistency) split into in-progress (nearest first) and earned
// (newest first). Backfills earned tiers silently, same as /overview, so
// opening the screen never queues a pile of historical congrats.
profileRoutes.get('/achievements', async (c) => {
  const userId = c.get('userId');
  const [user] = await db
    .select({ timezone: users.timezone })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) return c.json({ error: 'not_found' }, 404);

  await evaluateAchievements(userId, user.timezone, db, { silent: true });
  const screen = await buildAchievementsScreen(userId, user.timezone);
  return c.json(screen);
});
