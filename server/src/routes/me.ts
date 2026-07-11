import { eq } from 'drizzle-orm';
import { Hono } from 'hono';

import { db } from '../db/client.ts';
import { entitlements, users } from '../db/schema.ts';
import { requireAuth, type AuthVariables } from '../middleware/auth.ts';

export const meRoutes = new Hono<{ Variables: AuthVariables }>();
meRoutes.use('*', requireAuth);

meRoutes.get('/', async (c) => {
  const userId = c.get('userId');

  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) return c.json({ error: 'not_found' }, 404);

  const [entitlement] = await db
    .select()
    .from(entitlements)
    .where(eq(entitlements.userId, userId))
    .limit(1);

  return c.json({
    user: {
      id: user.id,
      phoneE164: user.phoneE164,
      displayName: user.displayName,
      timezone: user.timezone,
      prefs: user.prefs,
    },
    entitlement: entitlement
      ? { plan: entitlement.plan, expiresAt: entitlement.expiresAt }
      : { plan: 'free', expiresAt: null },
  });
});
