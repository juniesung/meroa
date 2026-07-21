import { Expo, type ExpoPushMessage } from 'expo-server-sdk';
import { and, eq, inArray, isNull } from 'drizzle-orm';

import { db } from '../../db/client.ts';
import { notificationsLog, pushTokens } from '../../db/schema.ts';
import { logger } from '../../logger.ts';

// No credentials needed for Expo's push service; a single client is fine.
let expo: Expo | null = null;
function getExpo(): Expo {
  if (!expo) expo = new Expo();
  return expo;
}

export type PushPayload = {
  kind: string;
  title: string;
  body: string;
  // Merged into the notification's `data`, which the client reads on tap
  // (src/app/_layout.tsx's routeFromNotification). `kind` is always included.
  data?: Record<string, unknown>;
  // When set, a row is written to notifications_log and the partial unique
  // index makes a repeat send of the same trigger a no-op — see policy.ts.
  dedupeKey?: string;
};

/**
 * Delivers one proactive push to every live device the user has, records it in
 * notifications_log (for the frequency cap and idempotency), and disables any
 * token Expo reports as unregistered. Returns whether at least one message was
 * accepted for delivery. Quiet-hours and cap gating happen in the tick BEFORE
 * this is called — this is the raw delivery layer.
 */
export async function sendPush(userId: string, payload: PushPayload): Promise<boolean> {
  const tokens = await db
    .select()
    .from(pushTokens)
    .where(and(eq(pushTokens.userId, userId), isNull(pushTokens.disabledAt)));

  const valid = tokens.filter((t) => Expo.isExpoPushToken(t.token));
  if (!valid.length) return false;

  // Record the send first, keyed by dedupeKey. If the row already exists
  // (onConflictDoNothing hit the partial unique index), another tick already
  // sent this trigger — bail without re-notifying. A missed send is cheaper
  // than a duplicate one.
  if (payload.dedupeKey) {
    const inserted = await db
      .insert(notificationsLog)
      .values({
        userId,
        kind: payload.kind,
        title: payload.title,
        body: payload.body,
        dedupeKey: payload.dedupeKey,
      })
      .onConflictDoNothing({
        target: [notificationsLog.userId, notificationsLog.dedupeKey],
      })
      .returning({ id: notificationsLog.id });
    if (!inserted.length) return false;
  } else {
    await db.insert(notificationsLog).values({
      userId,
      kind: payload.kind,
      title: payload.title,
      body: payload.body,
    });
  }

  const messages: ExpoPushMessage[] = valid.map((t) => ({
    to: t.token,
    title: payload.title,
    body: payload.body,
    sound: 'default',
    data: { ...payload.data, kind: payload.kind },
  }));

  const deadTokens: string[] = [];
  try {
    for (const chunk of getExpo().chunkPushNotifications(messages)) {
      const tickets = await getExpo().sendPushNotificationsAsync(chunk);
      tickets.forEach((ticket, i) => {
        if (ticket.status === 'error' && ticket.details?.error === 'DeviceNotRegistered') {
          const to = chunk[i]?.to;
          if (typeof to === 'string') deadTokens.push(to);
        }
      });
    }
  } catch (err) {
    // Delivery is best-effort — a transient Expo outage shouldn't throw out of
    // the tick and stop every other user's notification.
    logger.warn({ err, userId }, 'push send failed');
    return false;
  }

  if (deadTokens.length) {
    await db
      .update(pushTokens)
      .set({ disabledAt: new Date() })
      .where(and(eq(pushTokens.userId, userId), inArray(pushTokens.token, deadTokens)));
  }

  return true;
}
