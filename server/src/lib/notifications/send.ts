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
 * Atomically claims this proactive reach-out by writing its notifications_log
 * row — the single source of truth for the frequency cap AND idempotency. If a
 * dedupeKey collides (another tick already claimed this exact trigger), the
 * onConflictDoNothing insert returns nothing and this returns false. Callers
 * MUST claim before doing anything user-visible (delivering a push, writing a
 * proactive chat message), so a lost race produces neither — "a missed send is
 * cheaper than a duplicate one" now covers the in-chat message too.
 */
export async function claimNotification(userId: string, payload: PushPayload): Promise<boolean> {
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
    return inserted.length > 0;
  }
  await db.insert(notificationsLog).values({
    userId,
    kind: payload.kind,
    title: payload.title,
    body: payload.body,
  });
  return true;
}

/**
 * Delivers one proactive push to every live device the user has and disables any
 * token Expo reports as unregistered. Returns whether at least one message was
 * accepted for delivery. This is delivery ONLY — the notifications_log row is
 * written separately by claimNotification (call it first). Quiet-hours and cap
 * gating happen in the tick before either.
 */
export async function deliverPush(userId: string, payload: PushPayload): Promise<boolean> {
  const tokens = await db
    .select()
    .from(pushTokens)
    .where(and(eq(pushTokens.userId, userId), isNull(pushTokens.disabledAt)));

  const valid = tokens.filter((t) => Expo.isExpoPushToken(t.token));
  if (!valid.length) return false;

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
