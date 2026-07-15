import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';

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

// Merge-only patch — never replaces the whole prefs blob, so unrelated keys
// (e.g. communicationStyle) survive a reminders-toggle update untouched.
const prefsPatchSchema = z.object({
  proactiveCheckins: z.boolean().optional(),
  communicationStyle: z.enum(['chill', 'supportive', 'direct', 'playful', 'balanced']).optional(),
  styleAdjustments: z
    .object({
      length: z.enum(['shorter', 'longer']).optional(),
      questions: z.literal('fewer').optional(),
      directness: z.enum(['more', 'softer']).optional(),
      emoji: z.enum(['none', 'ok']).optional(),
    })
    .optional(),
});

// Captured once at OTP verify, but a device's timezone can drift from that
// (travel, or the OS auto-switching it) with nothing to ever refresh it —
// letting the app resend its current one keeps server-side time math
// (overdue, recurrence anchors, end-of-day defaults) in sync with where the
// user actually is, rather than where they signed up.
const timezonePatchSchema = z.object({ timezone: z.string().min(1).max(100) });

meRoutes.patch('/timezone', zValidator('json', timezonePatchSchema), async (c) => {
  const userId = c.get('userId');
  const { timezone } = c.req.valid('json');

  const [updated] = await db.update(users).set({ timezone }).where(eq(users.id, userId)).returning();
  if (!updated) return c.json({ error: 'not_found' }, 404);

  return c.json({ timezone: updated.timezone });
});

meRoutes.patch('/prefs', zValidator('json', prefsPatchSchema), async (c) => {
  const userId = c.get('userId');
  const patch = c.req.valid('json');

  const [user] = await db
    .select({ prefs: users.prefs })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) return c.json({ error: 'not_found' }, 404);

  const nextPrefs = { ...(user.prefs as Record<string, unknown>), ...patch };
  const [updated] = await db
    .update(users)
    .set({ prefs: nextPrefs })
    .where(eq(users.id, userId))
    .returning();
  if (!updated) throw new Error('user_update_failed');

  return c.json({ prefs: updated.prefs });
});
