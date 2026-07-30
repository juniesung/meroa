import { and, eq, gte, isNull, sql } from 'drizzle-orm';

import { db } from '../../db/client.ts';
import { goals, records, tasks, users } from '../../db/schema.ts';
import { logger } from '../../logger.ts';
import { readTourState } from '../ai/onboarding.ts';
import { resolveTone } from '../ai/system-prompt.ts';
import { buildGoalCardSummaries } from '../goals/summary.ts';
import { deliverThreadReachOut } from './dispatch.ts';
import { alreadySent, withinFrequencyCap } from './policy.ts';
import { composeProactiveMessage } from './proactive-message.ts';
import type { NotificationTrigger, NotifyUser } from './triggers.ts';

// Client-pinged rituals (WS4/WS5): a first-open-of-the-day "here's your day"
// and a roughly-weekly reflect-back recap. Both are thread-only reach-outs, so
// they need no push and work while the cron is still blocked — the client hits
// POST /me/catch-up on foreground, and runUserCatchUp decides if either is due
// (deduped per period) and drops it into the chat thread for next open.

const DAY_MS = 24 * 60 * 60 * 1000;

// The user's local calendar date, YYYY-MM-DD.
function ymdInTz(now: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

// A stable 7-day bucket key from a local calendar date — a recap fires at most
// once per bucket. Deliberately NOT calendar-week-aligned (that needs weekday
// math across timezones); a rolling 7-day cadence is what a recap wants anyway.
function weekBucketOf(ymd: string): number {
  return Math.floor(Date.parse(`${ymd}T00:00:00Z`) / DAY_MS / 7);
}

// Local part-of-day for the greeting. The daily ritual fires on the first
// *open* of the day, which is just as often afternoon or night — so a
// hardcoded "good morning" reads wrong (it did, at 8pm). Bucketed from the
// user's local hour so both the model instruction and the fallback body match.
function greetingForTz(now: Date, tz: string): { long: string; short: string } {
  const h =
    Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false }).format(now)) % 24;
  if (h < 12) return { long: 'good morning', short: 'morning' };
  if (h < 18) return { long: 'good afternoon', short: 'afternoon' };
  return { long: 'good evening', short: 'evening' };
}

// The best live habit streak worth mentioning (>= 3 days), across the user's
// goals — computed from summaries, never here.
async function bestStreak(
  user: NotifyUser,
): Promise<{ goalName: string; current: number } | null> {
  const goalRows = await db
    .select()
    .from(goals)
    .where(and(eq(goals.userId, user.id), isNull(goals.archivedAt)));
  const summaries = await buildGoalCardSummaries(goalRows, user.timezone);
  let best: { goalName: string; current: number } | null = null;
  for (const g of goalRows) {
    const s = summaries.get(g.id);
    if (s?.streak && s.streak.current >= 3 && (!best || s.streak.current > best.current)) {
      best = { goalName: g.name, current: s.streak.current };
    }
  }
  return best;
}

// --- daily ritual ---------------------------------------------------------

async function buildDailyRitual(user: NotifyUser, todayYmd: string, now: Date): Promise<NotificationTrigger> {
  const name = user.displayName?.trim() || null;
  const greeting = greetingForTz(now, user.timezone ?? 'UTC');
  // What's actually open right now — real titles, so Meroa points at the day
  // instead of inventing one. Instances + standalone tasks (skip templates).
  const openTasks = await db
    .select({ title: tasks.title })
    .from(tasks)
    .where(
      and(eq(tasks.userId, user.id), eq(tasks.status, 'open'), isNull(tasks.deletedAt), isNull(tasks.recurrence)),
    )
    .orderBy(tasks.dueAt)
    .limit(5);
  const titles = openTasks.map((t) => t.title);
  const streak = await bestStreak(user);

  const facts = [
    `A first-of-the-day check-in with ${name ?? 'the user'} — say ${greeting.long} like a friend does.`,
    titles.length
      ? `On their list right now: ${titles.join(', ')} (${titles.length} open${titles.length === 5 ? '+' : ''}).`
      : `Their task list is clear right now.`,
    streak ? `They're on a ${streak.current}-day streak with "${streak.goalName}".` : null,
    `Keep it short and warm, maybe point at one thing worth doing today. Quote any title or number EXACTLY; invent nothing. Never guilt or pressure.`,
  ]
    .filter(Boolean)
    .join('\n');

  const templateBody = titles.length
    ? `${greeting.short}! ${titles.length} thing${titles.length === 1 ? '' : 's'} on your list today, starting with "${titles[0]}".`
    : `${greeting.short}! clean slate today, what's the plan?`;

  return { kind: 'daily_ritual', facts, templateBody, dedupeKey: `daily:${todayYmd}`, data: { route: 'chat' } };
}

// --- weekly recap ---------------------------------------------------------

async function buildWeeklyRecap(
  user: NotifyUser,
  now: Date,
  weekBucket: number,
): Promise<NotificationTrigger | null> {
  const weekAgo = new Date(now.getTime() - 7 * DAY_MS);
  // Count currently-DONE tasks whose completion landed this week, keyed on the
  // task's completedRecordId (one per done task) — NOT raw task_completion
  // records. applyProgress writes a completion record on every toggle and never
  // reverts the prior one, so counting records inflates on any
  // check->uncheck->re-check ("42 tasks" that was really 14). This mirrors the
  // blessed convention in profile/overview.ts's buildMonthRecap and
  // achievements/evaluate.ts: a recurring task's daily instances are separate
  // rows so each done day still counts once; a reopened (now-open) task drops
  // out honestly.
  const [doneRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(tasks)
    .innerJoin(records, eq(tasks.completedRecordId, records.id))
    .where(
      and(
        eq(tasks.userId, user.id),
        eq(tasks.status, 'done'),
        isNull(tasks.deletedAt),
        isNull(records.revertedAt),
        gte(records.occurredAt, weekAgo),
      ),
    );
  const tasksDone = doneRow?.n ?? 0;
  const streak = await bestStreak(user);

  // Never send an empty recap — "you did nothing this week" is the opposite of
  // reflecting real progress. Only reach out when there's something honest to say.
  if (tasksDone === 0 && !streak) return null;

  const name = user.displayName?.trim() || null;
  const facts = [
    `A weekly reflect-back for ${name ?? 'the user'} on the past 7 days.`,
    `Tasks completed this week: ${tasksDone}.`,
    streak ? `Current streak: ${streak.current} days on "${streak.goalName}".` : null,
    `Reflect it back warmly as THEIR own progress and consistency. Quote the numbers EXACTLY; invent nothing. No guilt, no "days together", no pressure to keep a streak.`,
  ]
    .filter(Boolean)
    .join('\n');

  const templateBody = `this week: ${tasksDone} task${tasksDone === 1 ? '' : 's'} done${
    streak ? `, ${streak.current} days on "${streak.goalName}"` : ''
  }. proud of you.`;

  return { kind: 'weekly_recap', facts, templateBody, dedupeKey: `recap:${weekBucket}`, data: { route: 'chat' } };
}

// --- catch-up runner ------------------------------------------------------

/**
 * Called from POST /me/catch-up when the app comes to the foreground. Delivers
 * at most ONE reach-out per call: a weekly recap takes priority (it's the rarer,
 * bigger beat), else the daily ritual. Both are deduped per period, so pinging
 * this on every foreground is safe — a message lands at most once per day/week.
 * Thread-only (no push); the reach-out sits in the thread for next Chat open.
 */
export async function runUserCatchUp(userId: string, now: Date = new Date()): Promise<void> {
  try {
    const [row] = await db
      .select({ id: users.id, displayName: users.displayName, timezone: users.timezone, prefs: users.prefs, lastActiveAt: users.lastActiveAt, createdAt: users.createdAt })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!row) return;
    const prefs = (row.prefs as Record<string, unknown> | null) ?? null;
    // A user who explicitly turned proactive reach-outs off gets none — even
    // these gentle in-thread ones. Default is on (companion direction).
    if (prefs?.proactiveCheckins === false) return;
    // Don't let a daily ritual / weekly recap stomp the first-run guided tour
    // (lib/ai/onboarding.ts) — the tour owns the thread until it's done.
    if (readTourState(prefs)) return;

    const user: NotifyUser = {
      id: row.id,
      displayName: row.displayName,
      timezone: row.timezone,
      prefs,
      lastActiveAt: row.lastActiveAt,
    };
    const tz = user.timezone ?? 'UTC';
    const todayYmd = ymdInTz(now, tz);
    const weekBucket = weekBucketOf(todayYmd);
    const tone = resolveTone(prefs);

    async function deliver(trigger: NotificationTrigger): Promise<boolean> {
      if (await alreadySent(userId, trigger.dedupeKey)) return false;
      // Honor the user's proactive-message frequency cap, same as the cron tick
      // and the reaction beats — dedupe alone let a daily ritual + weekly recap
      // reach a user who capped themselves lower (or at zero).
      if (!(await withinFrequencyCap(userId, prefs, now))) return false;
      const chatBody = await composeProactiveMessage(trigger, tone);
      return deliverThreadReachOut(
        userId,
        { kind: trigger.kind, dedupeKey: trigger.dedupeKey, chatBody, data: trigger.data },
        { push: false },
      );
    }

    // Weekly recap first — if it lands, that's this catch-up's one reach-out.
    if (!(await alreadySent(userId, `recap:${weekBucket}`))) {
      const recap = await buildWeeklyRecap(user, now, weekBucket);
      if (recap && (await deliver(recap))) return;
    }
    // Skip the daily "here's your day" ritual on the user's signup day — the
    // first-run onboarding tour just welcomed them, so a "good afternoon,
    // here's your list" landing seconds later reads as Meroa talking to itself.
    // It resumes normally the next local day.
    const isSignupDay = ymdInTz(row.createdAt, tz) === todayYmd;
    if (!isSignupDay && !(await alreadySent(userId, `daily:${todayYmd}`))) {
      await deliver(await buildDailyRitual(user, todayYmd, now));
    }
  } catch (err) {
    logger.warn({ err, userId }, 'user catch-up failed');
  }
}
