import { and, isNull, sql } from 'drizzle-orm';

import { db } from '../../db/client.ts';
import { messages, pushTokens, users } from '../../db/schema.ts';
import { logger } from '../../logger.ts';
import { getOrCreateAppConversation } from '../conversations.ts';
import { resolveTone } from '../ai/system-prompt.ts';
import { composeNotificationBody } from './compose.ts';
import { composeProactiveMessage } from './proactive-message.ts';
import { alreadySent, isWithinQuietHours, withinFrequencyCap } from './policy.ts';
import { claimNotification, deliverPush } from './send.ts';
import { buildTrigger, type NotifyUser } from './triggers.ts';

// How many opted-in users to scan per tick, and how many to process at once.
// Almost all scanned users are gated out cheaply (already at their daily cap,
// in quiet hours, or nothing worth saying), so the expensive compose runs for
// only a handful — the pool bounds the worst case (e.g. a first-ever run).
const SCAN_BATCH = 200;
const CONCURRENCY = 5;

async function runPool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      if (item !== undefined) await fn(item);
    }
  });
  await Promise.all(workers);
}

export type TickResult = { scanned: number; sent: number };

/**
 * One pass of the proactive re-engagement engine, driven by an external cron
 * hitting POST /internal/tick. For each opted-in user with a live push token it
 * applies the guarantees in order — quiet hours, frequency cap, per-trigger
 * idempotency — then composes a grounded, figure-guarded message and sends it.
 * Every gate is server-side; nothing here is trusted to the client.
 */
export async function runNotificationTick(now: Date = new Date()): Promise<TickResult> {
  // Opted-in users who have at least one live device. The inner join can
  // repeat a user across their tokens, so dedupe by id in JS.
  const joined = await db
    .select({
      id: users.id,
      displayName: users.displayName,
      timezone: users.timezone,
      prefs: users.prefs,
      lastActiveAt: users.lastActiveAt,
    })
    .from(users)
    .innerJoin(pushTokens, and(sql`${pushTokens.userId} = ${users.id}`, isNull(pushTokens.disabledAt)))
    .where(sql`${users.prefs}->>'proactiveCheckins' = 'true'`)
    .limit(SCAN_BATCH * 4);

  const seen = new Set<string>();
  const candidates: NotifyUser[] = [];
  for (const r of joined) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    candidates.push({
      id: r.id,
      displayName: r.displayName,
      timezone: r.timezone,
      prefs: (r.prefs as Record<string, unknown> | null) ?? null,
      lastActiveAt: r.lastActiveAt,
    });
    if (candidates.length >= SCAN_BATCH) break;
  }

  let sent = 0;
  await runPool(candidates, CONCURRENCY, async (user) => {
    try {
      if (isWithinQuietHours(user.prefs, user.timezone, now)) return;
      if (!(await withinFrequencyCap(user.id, user.prefs, now))) return;
      const trigger = await buildTrigger(user, now);
      if (!trigger) return;
      if (await alreadySent(user.id, trigger.dedupeKey)) return;

      const tone = resolveTone(user.prefs);
      // The short push preview and the full in-chat message, composed together.
      const [pushBody, chatBody] = await Promise.all([
        composeNotificationBody(trigger, tone),
        composeProactiveMessage(trigger, tone),
      ]);

      // Atomically claim the trigger BEFORE anything user-visible. If a
      // concurrent tick already claimed it, we produce neither a chat message
      // nor a push — a missed reach-out is cheaper than a duplicate one.
      const claimed = await claimNotification(user.id, {
        kind: trigger.kind,
        title: 'Meroa',
        body: pushBody,
        dedupeKey: trigger.dedupeKey,
      });
      if (!claimed) return;

      // Meroa reaches out FIRST: the real message lands in the chat thread, so
      // opening the app shows it already there. The push is just the alert that
      // pulls them in to read and reply — the reply is an ordinary turn from
      // there. The reach-out has succeeded once the message is in the thread,
      // whether or not push delivery (a blocked dev-build dependency) lands.
      const conversation = await getOrCreateAppConversation(user.id);
      // Use `proactiveKind`, NOT `kind`: `meta.kind` is a reserved history
      // classification field (routes/messages.ts isCardMessage / historyContentFor).
      // A proactive message is plain prose, so it must not carry a `kind` that
      // could ever be mistaken for a card/pending marker.
      await db.insert(messages).values({
        conversationId: conversation.id,
        role: 'assistant',
        content: chatBody,
        meta: { proactive: true, proactiveKind: trigger.kind },
      });
      sent++;

      await deliverPush(user.id, {
        kind: trigger.kind,
        title: 'Meroa',
        body: pushBody,
        data: trigger.data,
      });
    } catch (err) {
      // One user's failure never stops the tick for everyone else.
      logger.warn({ err, userId: user.id }, 'notification tick: per-user failure');
    }
  });

  logger.info({ scanned: candidates.length, sent }, 'notification tick complete');
  return { scanned: candidates.length, sent };
}
