import { zValidator } from '@hono/zod-validator';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';

import { db } from '../db/client.ts';
import { conversations, entitlements, messages, sessions, users } from '../db/schema.ts';
import { exchangeAppleAuthCode, verifyAppleIdentityToken } from '../lib/apple-auth.ts';
import { REFRESH_TOKEN_TTL_DAYS, WELCOME_MESSAGE } from '../lib/constants.ts';
import { generateRefreshToken, hashWithPepper } from '../lib/crypto.ts';
import { signAccessToken } from '../lib/jwt.ts';
import { issueOtpForPhone, verifyAndConsumeOtp } from '../lib/otp.ts';
import { normalizePhone } from '../lib/phone.ts';
import { ianaTimezoneSchema } from '../lib/timezone.ts';
import { smsSender } from '../sms/sender.ts';

export const authRoutes = new Hono();

type UserRow = typeof users.$inferSelect;

function refreshExpiry(): Date {
  return new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
}

// A brand-new user's starting state — free entitlement + a welcome conversation
// with Meroa's first message. Shared by every sign-in path (phone OTP + Apple)
// so a new account is provisioned identically however they got here.
async function provisionNewUser(userId: string): Promise<void> {
  await db.insert(entitlements).values({ userId, plan: 'free' });
  const [conversation] = await db
    .insert(conversations)
    .values({ userId, channel: 'app' })
    .returning();
  if (!conversation) throw new Error('conversation_insert_failed');
  await db.insert(messages).values({
    conversationId: conversation.id,
    role: 'assistant',
    content: WELCOME_MESSAGE,
  });
  // Arm the first-run guided tour (lib/ai/onboarding.ts). The seeded welcome
  // above offers it; the user's first reply drives it. Merged into prefs so any
  // key set at account creation survives.
  await db
    .update(users)
    .set({
      prefs: sql`coalesce(${users.prefs}, '{}'::jsonb) || ${JSON.stringify({ onboardingTour: { active: true, step: 0 } })}::jsonb`,
    })
    .where(eq(users.id, userId));
}

// Mint an access token + a rotating refresh token and record the session.
async function createSession(userId: string): Promise<{ accessToken: string; refreshToken: string }> {
  const accessToken = await signAccessToken(userId);
  const refreshToken = generateRefreshToken();
  await db.insert(sessions).values({
    userId,
    refreshTokenHash: hashWithPepper(refreshToken),
    expiresAt: refreshExpiry(),
  });
  return { accessToken, refreshToken };
}

function authResponse(user: UserRow, isNewUser: boolean, tokens: { accessToken: string; refreshToken: string }) {
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    isNewUser,
    user: { id: user.id, phoneE164: user.phoneE164, displayName: user.displayName },
  };
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
      await provisionNewUser(user.id);
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

  const tokens = await createSession(user.id);
  return c.json(authResponse(user, isNewUser, tokens));
});

// Sign in with Apple. The client (expo-apple-authentication) does the actual
// sign-in and sends us Apple's signed identity token; we verify it
// (lib/apple-auth.ts — no Apple server secret needed for login) and key the
// account on Apple's stable `sub`. Same session + new-user provisioning as the
// phone path. `fullName` is Apple's one-time first-sign-in name (client forwards
// it); after that Apple never sends it again, so we only set it on creation.
const appleSchema = z.object({
  identityToken: z.string().min(1),
  // Apple's one-time authorization code — exchanged server-side for a refresh
  // token we keep ONLY to revoke on account deletion (guideline 5.1.1(v)).
  authorizationCode: z.string().min(1).optional(),
  fullName: z.string().trim().min(1).max(100).optional(),
  timezone: ianaTimezoneSchema.optional(),
});

authRoutes.post('/apple', zValidator('json', appleSchema), async (c) => {
  const { identityToken, authorizationCode, fullName, timezone } = c.req.valid('json');

  let identity: Awaited<ReturnType<typeof verifyAppleIdentityToken>>;
  try {
    identity = await verifyAppleIdentityToken(identityToken);
  } catch {
    return c.json({ error: 'invalid_apple_token' }, 401);
  }

  // Exchange the auth code for a refresh token (no-op until the Apple server key
  // is configured). Never blocks sign-in — a null just means no revoke-on-delete.
  const appleRefreshToken = authorizationCode ? await exchangeAppleAuthCode(authorizationCode) : null;

  let [user] = await db.select().from(users).where(eq(users.appleUserId, identity.appleUserId)).limit(1);
  let isNewUser = false;

  if (!user) {
    // Same race-safe upsert as the phone path: two concurrent first sign-ins for
    // the same Apple id must resolve to one account, not a unique-constraint 500.
    const [created] = await db
      .insert(users)
      .values({
        appleUserId: identity.appleUserId,
        appleRefreshToken,
        displayName: fullName ?? null,
        prefs: {},
        timezone: timezone ?? null,
      })
      .onConflictDoNothing({ target: users.appleUserId })
      .returning();

    if (created) {
      isNewUser = true;
      user = created;
      await provisionNewUser(user.id);
    } else {
      const [existing] = await db
        .select()
        .from(users)
        .where(eq(users.appleUserId, identity.appleUserId))
        .limit(1);
      if (!existing) throw new Error('apple_user_insert_failed');
      user = existing;
    }
  }

  if (!isNewUser && timezone && timezone !== user.timezone) {
    const [updated] = await db.update(users).set({ timezone }).where(eq(users.id, user.id)).returning();
    if (updated) user = updated;
  }

  // Keep the stored Apple refresh token current so deletion can always revoke.
  if (!isNewUser && appleRefreshToken && appleRefreshToken !== user.appleRefreshToken) {
    await db.update(users).set({ appleRefreshToken }).where(eq(users.id, user.id));
  }

  const tokens = await createSession(user.id);
  return c.json(authResponse(user, isNewUser, tokens));
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

  if (!session) {
    // Reuse detection: the presented token doesn't match any live session, but
    // does it match the token a session ALREADY rotated away from? If so it
    // leaked (rotation invalidates a token exactly once) — revoke that lineage
    // so the attacker's rotated-to token dies with it, and force re-auth. A
    // legit client whose rotation response was lost also lands here; with Apple
    // sign-in re-auth is seamless, and silently honoring a replayed token would
    // defeat the whole mechanism.
    const [replayed] = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.previousTokenHash, tokenHash), isNull(sessions.revokedAt)))
      .limit(1);
    if (replayed) {
      await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, replayed.id));
      return c.json({ error: 'token_reuse_detected' }, 401);
    }
    return c.json({ error: 'invalid_session' }, 401);
  }

  const now = new Date();
  const newRefreshToken = generateRefreshToken();
  await db
    .update(sessions)
    .set({
      refreshTokenHash: hashWithPepper(newRefreshToken),
      previousTokenHash: tokenHash,
      lastUsedAt: now,
      expiresAt: refreshExpiry(),
    })
    .where(eq(sessions.id, session.id));

  // A live refresh means the app is in active use — the broad signal the
  // re-engagement tick reads to decide who has drifted away (lib/notifications/
  // triggers.ts). Fires ~every 15 min while the app is open.
  await db.update(users).set({ lastActiveAt: now }).where(eq(users.id, session.userId));

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
