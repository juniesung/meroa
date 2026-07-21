import { and, isNull, sql } from 'drizzle-orm';

import { db } from '../../db/client.ts';
import { pushTokens, users } from '../../db/schema.ts';
import { logger } from '../../logger.ts';
import type { VibePreset } from '../ai/system-prompt.ts';
import { composeNotificationBody } from './compose.ts';
import { alreadySent, isWithinQuietHours, withinFrequencyCap } from './policy.ts';
import { sendPush } from './send.ts';
import { buildTrigger, type NotifyUser } from './triggers.ts';

// How many opted-in users to scan per tick, and how many to process at once.
// Almost all scanned users are gated out cheaply (already at their daily cap,
// in quiet hours, or nothing worth saying), so the expensive compose runs for
// only a handful — the pool bounds the worst case (e.g. a first-ever run).
const SCAN_BATCH = 200;
const CONCURRENCY = 5;

const VIBES = new Set(['chill', 'supportive', 'direct', 'playful', 'balanced']);
function styleOf(prefs: Record<string, unknown> | null): VibePreset | undefined {
  const s = prefs?.communicationStyle;
  return typeof s === 'string' && VIBES.has(s) ? (s as VibePreset) : undefined;
}

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

      const body = await composeNotificationBody(trigger, styleOf(user.prefs));
      const ok = await sendPush(user.id, {
        kind: trigger.kind,
        title: 'Meroa',
        body,
        data: trigger.data,
        dedupeKey: trigger.dedupeKey,
      });
      if (ok) sent++;
    } catch (err) {
      // One user's failure never stops the tick for everyone else.
      logger.warn({ err, userId: user.id }, 'notification tick: per-user failure');
    }
  });

  logger.info({ scanned: candidates.length, sent }, 'notification tick complete');
  return { scanned: candidates.length, sent };
}
