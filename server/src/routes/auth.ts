import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';

import { db } from '../db/client.ts';
import { conversations, entitlements, messages, otpCodes, sessions, users } from '../db/schema.ts';
import {
  DEMO_OTP_CODE,
  DEMO_PHONE_E164,
  OTP_MAX_ATTEMPTS,
  OTP_RATE_LIMIT_PER_HOUR,
  OTP_RESEND_COOLDOWN_SECONDS,
  OTP_TTL_MINUTES,
  REFRESH_TOKEN_TTL_DAYS,
  WELCOME_MESSAGE,
} from '../lib/constants.ts';
import { generateOtpCode, generateRefreshToken, hashWithPepper } from '../lib/crypto.ts';
import { signAccessToken } from '../lib/jwt.ts';
import { normalizePhone } from '../lib/phone.ts';
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

  // The rate-limit check below is count-then-insert, not backed by a unique
  // constraint (any number of otp_codes rows per phone is structurally
  // valid) — so concurrent requests for the same number could all read the
  // same under-the-cap count and all insert, blowing past the 5/hour limit.
  // pg_advisory_xact_lock serializes concurrent requests for the same
  // phone number (via a lock key derived from it) without blocking
  // requests for any other number.
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${phone})::bigint)`);

    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const recent = await tx
      .select()
      .from(otpCodes)
      .where(and(eq(otpCodes.phoneE164, phone), gt(otpCodes.createdAt, oneHourAgo)))
      .orderBy(desc(otpCodes.createdAt));

    if (recent.length >= OTP_RATE_LIMIT_PER_HOUR) {
      return { status: 429 as const, body: { error: 'rate_limited' } };
    }
    const [last] = recent;
    if (last && Date.now() - last.createdAt.getTime() < OTP_RESEND_COOLDOWN_SECONDS * 1000) {
      return { status: 429 as const, body: { error: 'rate_limited' } };
    }

    const code = phone === DEMO_PHONE_E164 ? DEMO_OTP_CODE : generateOtpCode();
    const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);

    await tx.insert(otpCodes).values({ phoneE164: phone, codeHash: hashWithPepper(code), expiresAt });

    return { status: 200 as const, body: { ok: true as const }, code };
  });

  if (result.status === 200) {
    await smsSender.send(phone, `Your Meroa code is ${result.code}`);
  }

  return c.json(result.body, result.status);
});

const verifySchema = z.object({
  phone: z.string().min(3),
  code: z.string().min(4).max(8),
  // IANA name (e.g. "America/Chicago"), read from the device at verify time.
  // Every task's "due today at 6am" reasoning — both the AI's and the
  // recurrence materializer's — depends on this being right, so it's
  // refreshed on every login below, not just captured once at signup.
  timezone: z.string().min(1).max(100).optional(),
});

authRoutes.post('/otp/verify', zValidator('json', verifySchema), async (c) => {
  const { code, timezone } = c.req.valid('json');
  let phone: string;
  try {
    phone = normalizePhone(c.req.valid('json').phone);
  } catch {
    return c.json({ error: 'invalid_phone' }, 400);
  }

  const [candidate] = await db
    .select()
    .from(otpCodes)
    .where(
      and(eq(otpCodes.phoneE164, phone), isNull(otpCodes.consumedAt), gt(otpCodes.expiresAt, new Date())),
    )
    .orderBy(desc(otpCodes.createdAt))
    .limit(1);

  if (!candidate) return c.json({ error: 'no_pending_code' }, 400);
  if (candidate.attempts >= OTP_MAX_ATTEMPTS) return c.json({ error: 'too_many_attempts' }, 429);

  if (candidate.codeHash !== hashWithPepper(code)) {
    await db.update(otpCodes).set({ attempts: candidate.attempts + 1 }).where(eq(otpCodes.id, candidate.id));
    return c.json({ error: 'invalid_code' }, 400);
  }

  await db.update(otpCodes).set({ consumedAt: new Date() }).where(eq(otpCodes.id, candidate.id));

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
