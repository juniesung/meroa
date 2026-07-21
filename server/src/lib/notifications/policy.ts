import { and, eq, gte, isNull, sql } from 'drizzle-orm';

import { db } from '../../db/client.ts';
import { notificationsLog, pushTokens } from '../../db/schema.ts';
import { env } from '../../env.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

// --- quiet hours (server-side, timezone-aware) -----------------------------
// The client evaluates quiet hours against the device's wall clock (src/
// features/profile/quiet-hours.ts). The server has no device clock, so it must
// resolve the user's *local* time from their stored IANA timezone first — same
// window logic, different clock source. A push that would land inside the
// window is simply not sent; the next tick (~15 min later) re-checks and sends
// it once the window has passed. That's the server equivalent of the client's
// "shift to window end, don't drop".

type QuietHours = { enabled: boolean; start: string; end: string };

export function readQuietHours(prefs: Record<string, unknown> | null | undefined): QuietHours {
  const raw = (prefs?.quietHours ?? null) as Record<string, unknown> | null;
  return {
    enabled: raw?.enabled === true,
    start: typeof raw?.start === 'string' ? raw.start : '22:00',
    end: typeof raw?.end === 'string' ? raw.end : '08:00',
  };
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

// The user's local wall-clock minute-of-day in `tz`. hourCycle h23 so midnight
// reads as 00:xx, never 24:xx.
function localMinuteOfDay(now: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return get('hour') * 60 + get('minute');
}

export function isWithinQuietHours(
  prefs: Record<string, unknown> | null | undefined,
  timezone: string | null,
  now: Date,
): boolean {
  const quiet = readQuietHours(prefs);
  if (!quiet.enabled) return false;
  const startMin = toMinutes(quiet.start);
  const endMin = toMinutes(quiet.end);
  if (startMin === endMin) return false; // zero-length window == disabled (matches client)
  const nowMin = localMinuteOfDay(now, timezone ?? 'UTC');
  if (startMin < endMin) return nowMin >= startMin && nowMin < endMin;
  return nowMin >= startMin || nowMin < endMin; // crosses midnight
}

// --- frequency cap (the proactive-message limit, CLAUDE.md §2) -------------

type CapConfig = { perDay: number; perWeek: number };

// The effective cap is the tighter of the server ceiling and any user override
// in prefs.notificationCap — a user can ask for fewer, never more.
export function effectiveCap(prefs: Record<string, unknown> | null | undefined): CapConfig {
  const raw = (prefs?.notificationCap ?? null) as Record<string, unknown> | null;
  const perDay =
    typeof raw?.perDay === 'number' ? Math.min(env.NOTIFY_MAX_PER_DAY, raw.perDay) : env.NOTIFY_MAX_PER_DAY;
  const perWeek =
    typeof raw?.perWeek === 'number' ? Math.min(env.NOTIFY_MAX_PER_WEEK, raw.perWeek) : env.NOTIFY_MAX_PER_WEEK;
  return { perDay, perWeek };
}

async function countSince(userId: string, since: Date): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(notificationsLog)
    .where(and(eq(notificationsLog.userId, userId), gte(notificationsLog.sentAt, since)));
  return row?.n ?? 0;
}

// Whether a proactive push to this user right now stays within their cap.
// Counts only rows in notifications_log — task reminders the user set are
// client-local and never logged, so they don't count against the cap.
export async function withinFrequencyCap(
  userId: string,
  prefs: Record<string, unknown> | null | undefined,
  now: Date,
): Promise<boolean> {
  const cap = effectiveCap(prefs);
  const [today, week] = await Promise.all([
    countSince(userId, new Date(now.getTime() - DAY_MS)),
    countSince(userId, new Date(now.getTime() - WEEK_MS)),
  ]);
  return today < cap.perDay && week < cap.perWeek;
}

// Has this exact trigger already been sent (idempotency across ticks)? Backed
// by the partial unique index on (userId, dedupeKey), but checked up front so
// a duplicate never even reaches the (paid) compose step.
export async function alreadySent(userId: string, dedupeKey: string): Promise<boolean> {
  const [row] = await db
    .select({ id: notificationsLog.id })
    .from(notificationsLog)
    .where(and(eq(notificationsLog.userId, userId), eq(notificationsLog.dedupeKey, dedupeKey)))
    .limit(1);
  return !!row;
}

// Does the user have at least one live (non-disabled) push token?
export async function hasLiveToken(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: pushTokens.id })
    .from(pushTokens)
    .where(and(eq(pushTokens.userId, userId), isNull(pushTokens.disabledAt)))
    .limit(1);
  return !!row;
}
