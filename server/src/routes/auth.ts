import { zValidator } from '@hono/zod-validator';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';

import { db } from '../db/client.ts';
import { conversations, entitlements, messages, sessions, users } from '../db/schema.ts';
import { REFRESH_TOKEN_TTL_DAYS, WELCOME_MESSAGE } from '../lib/constants.ts';
import { generateRefreshToken, hashWithPepper } from '../lib/crypto.ts';
import { signAccessToken } from '../lib/jwt.ts';
import { issueOtpForPhone, verifyAndConsumeOtp } from '../lib/otp.ts';
import { normalizePhone } from '../lib/phone.ts';
import { ianaTimezoneSchema } from '../lib/timezone.ts';
import { smsSender } from '../sms/sender.ts';

export const authRoutes = new Hono();

function refreshExpiry(): Date {
  return new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
}

const requestSchema = z.object({ phone: z.string().min(3) });

authRoutes.post('/otp/request', zValidator('json', requestSchema), async (c) => {
  let phone: string;
  try {
    phone = normalizePhone(c.req.valid('json').phone);
  } catch {
    return c.json({ error: 'invalid_phone' }, 400);
  }

  // Rate-limited issuance lives in issueOtpForPhone (lib/otp.ts) — one
  // implementation shared with the web-deletion flow.
  const result = await issueOtpForPhone(phone);
  if (result.status === 429) return c.json({ error: 'rate_limited' }, 429);

  await smsSender.send(phone, `Your Meroa code is ${result.code}`);
  return c.json({ ok: true });
});

const verifySchema = z.object({
  phone: z.string().min(3),
  code: z.string().min(4).max(8),
  // IANA name (e.g. "America/Chicago"), read from the device at verify time.
  // Every task's "due today at 6am" reasoning — both the AI's and the
  // recurrence materializer's — depends on this being right, so it's
  // refreshed on every login below, not just captured once at signup.
  timezone: ianaTimezoneSchema.optional(),
});

authRoutes.post('/otp/verify', zValidator('json', verifySchema), async (c) => {
  const { code, timezone } = c.req.valid('json');
  let phone: string;
  try {
    phone = normalizePhone(c.req.valid('json').phone);
  } catch {
    return c.json({ error: 'invalid_phone' }, 400);
  }

  const verification = await verifyAndConsumeOtp(phone, code);
  if (!verification.ok) return c.json({ error: verification.error }, verification.status);

  let [user] = await db.select().from(users).where(eq(users.phoneE164, phone)).limit(1);
  let isNewUser = false;

  if (!user) {
    // INSERT ... ON CONFLICT DO NOTHING instead of a bare insert: a
    // double-tap or a client retry can send two concurrent verifies for the
    // same brand-new number. Without this, the loser's insert would violate
    // users_phone_e164_unique and bubble up as a raw 500 instead of
    // gracefully resolving to the session the winner already created.
    const [created] = await db
      .insert(users)
      .values({ phoneE164: phone, prefs: {}, timezone: timezone ?? null })
      .onConflictDoNothing({ target: users.phoneE164 })
      .returning();

    if (created) {
      isNewUser = true;
      user = created;

      await db.insert(entitlements).values({ userId: user.id, plan: 'free' });

      const [conversation] = await db
        .insert(conversations)
        .values({ userId: user.id, channel: 'app' })
        .returning();
      if (!conversation) throw new Error('conversation_insert_failed');

      await db.insert(messages).values({
        conversationId: conversation.id,
        role: 'assistant',
        content: WELCOME_MESSAGE,
      });
    } else {
      // Lost the race: another concurrent verify already created this user
      // (and their entitlement/welcome conversation) — just sign them in.
      const [existing] = await db.select().from(users).where(eq(users.phoneE164, phone)).limit(1);
      if (!existing) throw new Error('user_insert_failed');
      user = existing;
    }
  }

  // Keep an existing user's timezone current — a stale one silently skews
  // every AI-scheduled time and recurrence occurrence (the device moved,
  // or this is a returning user from before timezone capture existed).
  if (!isNewUser && timezone && timezone !== user.timezone) {
    const [updated] = await db.update(users).set({ timezone }).where(eq(users.id, user.id)).returning();
    if (updated) user = updated;
  }

  const accessToken = await signAccessToken(user.id);
  const refreshToken = generateRefreshToken();

  await db.insert(sessions).values({
    userId: user.id,
    refreshTokenHash: hashWithPepper(refreshToken),
    expiresAt: refreshExpiry(),
  });

  return c.json({
    accessToken,
    refreshToken,
    isNewUser,
    user: { id: user.id, phoneE164: user.phoneE164, displayName: user.displayName },
  });
});

const refreshSchema = z.object({ refreshToken: z.string().min(10) });

authRoutes.post('/refresh', zValidator('json', refreshSchema), async (c) => {
  const { refreshToken } = c.req.valid('json');
  const tokenHash = hashWithPepper(refreshToken);

  const [session] = await db
    .select()
    .from(sessions)
    .where(
      and(eq(sessions.refreshTokenHash, tokenHash), isNull(sessions.revokedAt), gt(sessions.expiresAt, new Date())),
    )
    .limit(1);

  if (!session) return c.json({ error: 'invalid_session' }, 401);

  const newRefreshToken = generateRefreshToken();
  await db
    .update(sessions)
    .set({ refreshTokenHash: hashWithPepper(newRefreshToken), lastUsedAt: new Date(), expiresAt: refreshExpiry() })
    .where(eq(sessions.id, session.id));

  const accessToken = await signAccessToken(session.userId);

  return c.json({ accessToken, refreshToken: newRefreshToken });
});

const logoutSchema = z.object({ refreshToken: z.string().min(10) });

authRoutes.post('/logout', zValidator('json', logoutSchema), async (c) => {
  const { refreshToken } = c.req.valid('json');
  const tokenHash = hashWithPepper(refreshToken);

  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.refreshTokenHash, tokenHash), isNull(sessions.revokedAt)));

  return c.json({ ok: true });
});
