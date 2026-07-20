import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';

import { db } from '../db/client.ts';
import { entitlements, users } from '../db/schema.ts';
import { hardDeleteUser } from '../lib/account-deletion.ts';
import { resolvePlan } from '../lib/billing/plan.ts';
import { AI_CONSENT_VERSION } from '../lib/constants.ts';
import { ianaTimezoneSchema } from '../lib/timezone.ts';
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
    entitlement: { plan: resolvePlan(entitlement), expiresAt: entitlement?.expiresAt ?? null },
  });
});

// Same HH:mm (24h, local) shape as server/src/lib/tasks/schema.ts's
// timeSchema — quiet hours are evaluated against the device's own local
// clock (src/lib/notifications.ts), never converted through a stored
// timezone, so this is deliberately just two wall-clock strings.
const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'time must be HH:mm (24h, local)');

// Captured at the end of onboarding (still on the free plan, before the
// paywall) and consumed by OnboardingDraftFlush the instant the user
// subscribes — creating a goal/task directly during onboarding would 429
// against the hard-paywall's zero free-tier limits (lib/limits.ts), so the
// draft holds the user's intent in prefs (ungated) until there's an active
// entitlement to create against. Cleared (set to null) once flushed.
// `type` drives which fields OnboardingDraftFlush actually uses — this schema
// stays lenient (no cross-field refine, unlike lib/goals/schema.ts's real
// createGoalParamsBaseSchema) since it only holds intent; the real validation
// happens when the flush calls the actual create endpoints.
const onboardingDraftSchema = z
  .object({
    // Independently optional — a user can fill in one and skip the other.
    goal: z
      .object({
        type: z.enum(['savings', 'habit', 'indirect', 'milestone']),
        name: z.string().trim().min(1).max(60),
        targetValue: z.number().min(0.01).optional(),
        unit: z.string().trim().min(1).max(20).optional(),
        checkinTitle: z.string().trim().min(1).max(200).optional(),
      })
      .optional(),
    task: z
      .object({
        title: z.string().trim().min(1).max(200),
      })
      .optional(),
  })
  .nullable()
  .optional();

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
  quietHours: z
    .object({
      enabled: z.boolean(),
      start: timeSchema,
      end: timeSchema,
    })
    .optional(),
  onboardingDraft: onboardingDraftSchema,
  // Apple 5.1.2(i) AI-sharing consent. The client only asserts `granted`; the
  // server stamps `at` and `version` below, so a client can neither backdate a
  // grant nor claim agreement to a disclosure version it never saw. Revoking
  // (`granted: false`) is a first-class action — the message endpoint blocks
  // sends whenever consent isn't valid for the current version (lib/consent.ts).
  aiConsent: z.object({ granted: z.boolean() }).optional(),
});

// Captured once at OTP verify, but a device's timezone can drift from that
// (travel, or the OS auto-switching it) with nothing to ever refresh it —
// letting the app resend its current one keeps server-side time math
// (overdue, recurrence anchors, end-of-day defaults) in sync with where the
// user actually is, rather than where they signed up.
const timezonePatchSchema = z.object({ timezone: ianaTimezoneSchema });

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

  const nextPrefs: Record<string, unknown> = { ...(user.prefs as Record<string, unknown>), ...patch };
  // Server-stamp consent metadata — never trust a client-supplied timestamp or
  // version (see the schema note above). Both grant and revoke are stamped, so
  // the recorded `at` is always the moment of the real state change.
  if (patch.aiConsent) {
    nextPrefs.aiConsent = {
      granted: patch.aiConsent.granted,
      at: new Date().toISOString(),
      version: AI_CONSENT_VERSION,
    };
  }
  const [updated] = await db
    .update(users)
    .set({ prefs: nextPrefs })
    .where(eq(users.id, userId))
    .returning();
  if (!updated) throw new Error('user_update_failed');

  return c.json({ prefs: updated.prefs });
});

// Immediate hard delete (Apple + Google in-app deletion requirement). The whole
// transaction — and the stale-token reasoning — lives in hardDeleteUser
// (lib/account-deletion.ts), shared verbatim with the web-deletion flow.
meRoutes.delete('/', async (c) => {
  const userId = c.get('userId');
  const deleted = await hardDeleteUser(userId);
  if (!deleted) return c.json({ error: 'not_found' }, 404);
  return c.json({ ok: true });
});
