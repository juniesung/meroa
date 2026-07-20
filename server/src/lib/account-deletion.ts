import { eq } from 'drizzle-orm';

import { db } from '../db/client.ts';
import { otpCodes, users } from '../db/schema.ts';
import { deleteSubscriber } from './billing/revenuecat.ts';
import { withUserLock } from './usage.ts';
import { logger } from '../logger.ts';

// Immediate hard delete of a user and everything they own. Shared by the in-app
// DELETE /me and the web-deletion flow (routes/legal.ts) so both run the
// IDENTICAL transaction — one deletion path, no drift.
//
// One transaction under the same per-user advisory lock the chat/task/goal
// writes take, so a delete can't interleave with an in-flight send/create.
// Deleting the users row cascades to the other tables via their FKs (sessions,
// conversations, messages, records, goals, tasks, goal_entries, memories,
// memory_extraction_state, entitlements, message_reports). otp_codes is the
// exception: NO FK (keyed by phone, the identity key, which must survive across
// signups), so a stale code would otherwise outlive the account and be valid on
// a re-signup — delete it explicitly by phone.
//
// Returns false if there was no such user (already gone / never existed).
export async function hardDeleteUser(userId: string): Promise<boolean> {
  const deleted = await withUserLock(userId, async (tx) => {
    const [user] = await tx
      .select({ phoneE164: users.phoneE164 })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!user) return false;

    await tx.delete(otpCodes).where(eq(otpCodes.phoneE164, user.phoneE164));
    await tx.delete(users).where(eq(users.id, userId));
    return true;
  });

  if (!deleted) return false;

  // Best-effort, and deliberately AFTER the local delete has committed: removing
  // RC's subscriber record stops a later webhook from resurrecting an
  // entitlements row, but a RC outage must never block or fail the user's
  // deletion. Deleting our entitlements row does NOT cancel the store
  // subscription — only Apple/Google can; the user is told to do that.
  try {
    await deleteSubscriber(userId);
  } catch (err) {
    logger.error({ err, userId }, 'revenuecat subscriber delete failed after account deletion');
  }

  return true;
}
