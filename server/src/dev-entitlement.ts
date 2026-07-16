import { eq } from 'drizzle-orm';

import { db } from './db/client.ts';
import { entitlements, users } from './db/schema.ts';
import { env } from './env.ts';
import { normalizePhone } from './lib/phone.ts';
import { logger } from './logger.ts';

// Dev-only: flips a user's entitlement plan directly, so the full
// free-plan-limit → paywall → "plus" loop is testable end-to-end before any
// RevenueCat/store configuration exists (mirrors dev-token.ts's rationale).
//
// Usage: npm run dev:plan -- <phone> <plan>   (plan: 'free' | 'plus')
//
// Never expose this as an HTTP route or run it against a production DB.
if (env.NODE_ENV === 'production') {
  throw new Error('dev-entitlement must not run against a production environment');
}

async function main() {
  const phoneArg = process.argv[2];
  const planArg = process.argv[3];

  if (!phoneArg || (planArg !== 'free' && planArg !== 'plus')) {
    throw new Error('usage: npm run dev:plan -- <phone> <free|plus>');
  }

  const phone = normalizePhone(phoneArg);
  const plan = planArg;

  const [user] = await db.select().from(users).where(eq(users.phoneE164, phone)).limit(1);
  if (!user) throw new Error(`no user found for ${phone} — run dev:token first`);

  const [updated] = await db
    .insert(entitlements)
    .values({ userId: user.id, plan, source: 'dev', expiresAt: null })
    .onConflictDoUpdate({
      target: entitlements.userId,
      set: { plan, source: 'dev', expiresAt: null, updatedAt: new Date() },
    })
    .returning();

  console.log(JSON.stringify({ userId: user.id, phone, entitlement: updated }, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error(err, 'dev-entitlement failed');
    process.exit(1);
  });
