import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, gt, isNull } from 'drizzle-orm';
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

  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const recent = await db
    .select()
    .from(otpCodes)
    .where(and(eq(otpCodes.phoneE164, phone), gt(otpCodes.createdAt, oneHourAgo)))
    .orderBy(desc(otpCodes.createdAt));

  if (recent.length >= OTP_RATE_LIMIT_PER_HOUR) {
    return c.json({ error: 'rate_limited' }, 429);
  }
  const [last] = recent;
  if (last && Date.now() - last.createdAt.getTime() < OTP_RESEND_COOLDOWN_SECONDS * 1000) {
    return c.json({ error: 'rate_limited' }, 429);
  }

  const code = phone === DEMO_PHONE_E164 ? DEMO_OTP_CODE : generateOtpCode();
  const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);

  await db.insert(otpCodes).values({ phoneE164: phone, codeHash: hashWithPepper(code), expiresAt });
  await smsSender.send(phone, `Your Meroa code is ${code}`);

  return c.json({ ok: true });
});

const verifySchema = z.object({ phone: z.string().min(3), code: z.string().min(4).max(8) });

authRoutes.post('/otp/verify', zValidator('json', verifySchema), async (c) => {
  const { code } = c.req.valid('json');
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
    isNewUser = true;
    const [created] = await db.insert(users).values({ phoneE164: phone, prefs: {} }).returning();
    if (!created) throw new Error('user_insert_failed');
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
      content:
        "Hey — I'm Meroa. Just so it's clear up front: I'm an AI, not a person. I'm here to actually help — keep track of things, think through stuff with you, check in without being annoying about it. What's going on with you today?",
    });
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
