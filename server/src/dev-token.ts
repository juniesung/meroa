import { eq } from 'drizzle-orm';

import { db } from './db/client.ts';
import { conversations, entitlements, messages, sessions, users } from './db/schema.ts';
import { env } from './env.ts';
import { REFRESH_TOKEN_TTL_DAYS, WELCOME_MESSAGE } from './lib/constants.ts';
import { generateRefreshToken, hashWithPepper } from './lib/crypto.ts';
import { signAccessToken } from './lib/jwt.ts';
import { normalizePhone } from './lib/phone.ts';
import { logger } from './logger.ts';

// Dev-only: mints a token pair for a user without going through the OTP
// flow, so local testing (curl, scripts, agents) isn't gated by the 5/hour
// OTP rate limit or a real SMS round trip. Creates the user — plus
// entitlement, app conversation, and welcome message, mirroring auth.ts's
// new-user path — if the phone doesn't exist yet, so this also doubles as
// a "give me a fresh test user" command (handy for testing anything
// scoped per-user, like the fair-use message limit).
//
// Usage: npm run dev:token [phone]   (defaults to the seeded demo number)
//
// Never expose this as an HTTP route or run it against a production DB.
if (env.NODE_ENV === 'production') {
  throw new Error('dev-token must not run against a production environment');
}

function refreshExpiry(): Date {
  return new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
}

async function main() {
  const phone = normalizePhone(process.argv[2] ?? '+15555550100');

  let [user] = await db.select().from(users).where(eq(users.phoneE164, phone)).limit(1);
  let isNewUser = false;

  if (!user) {
    const [created] = await db
      .insert(users)
      .values({ phoneE164: phone, prefs: {} })
      .onConflictDoNothing({ target: users.phoneE164 })
      .returning();

    if (created) {
      user = created;
      isNewUser = true;

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
      // Lost the race: another concurrent invocation (or the real signup
      // flow) already created this user — just mint a token for them.
      const [existing] = await db.select().from(users).where(eq(users.phoneE164, phone)).limit(1);
      if (!existing) throw new Error('user_insert_failed');
      user = existing;
    }
  }

  const accessToken = await signAccessToken(user.id);
  const refreshToken = generateRefreshToken();

  await db.insert(sessions).values({
    userId: user.id,
    refreshTokenHash: hashWithPepper(refreshToken),
    expiresAt: refreshExpiry(),
  });

  console.log(JSON.stringify({ isNewUser, userId: user.id, phone, accessToken, refreshToken }, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error(err, 'dev-token failed');
    process.exit(1);
  });
