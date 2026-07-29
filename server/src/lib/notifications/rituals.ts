import { and, eq, gte, isNull, sql } from 'drizzle-orm';

import { db } from '../../db/client.ts';
import { goals, records, tasks, users } from '../../db/schema.ts';
import { logger } from '../../logger.ts';
import { resolveTone } from '../ai/system-prompt.ts';
import { buildGoalCardSummaries } from '../goals/summary.ts';
import { deliverThreadReachOut } from './dispatch.ts';
import { alreadySent } from './policy.ts';
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

async function buildDailyRitual(user: NotifyUser, todayYmd: string): Promise<NotificationTrigger> {
  const name = user.displayName?.trim() || null;
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
    `A first-of-the-day check-in with ${name ?? 'the user'} — say good morning like a friend does.`,
    titles.length
      ? `On their list right now: ${titles.join(', ')} (${titles.length} open${titles.length === 5 ? '+' : ''}).`
      : `Their task list is clear right now.`,
    streak ? `They're on a ${streak.current}-day streak with "${streak.goalName}".` : null,
    `Keep it short and warm, maybe point at one thing worth doing today. Quote any title or number EXACTLY; invent nothing. Never guilt or pressure.`,
  ]
    .filter(Boolean)
    .join('\n');

  const templateBody = titles.length
    ? `morning! ${titles.length} thing${titles.length === 1 ? '' : 's'} on your list today, starting with "${titles[0]}".`
    : `morning! clean slate today, what's the plan?`;

  return { kind: 'daily_ritual', facts, templateBody, dedupeKey: `daily:${todayYmd}`, data: { route: 'chat' } };
}

// --- weekly recap ---------------------------------------------------------

async function buildWeeklyRecap(
  user: NotifyUser,
  now: Date,
  weekBucket: number,
): Promise<NotificationTrigger | null> {
  const weekAgo = new Date(now.getTime() - 7 * DAY_MS);
  const [doneRow] = await db
    .select({
      // DISTINCT taskId, not count(*): a task toggled done->reopen->done writes
      // a mark_done record each time, so count(*) counted check-off EVENTS and
      // "42 tasks" really meant "42 completions across 14 tasks" — a misleading
      // number. Distinct tasks is the honest "tasks you completed this week"
      // (a recurring task's daily instances are distinct ids, so they still each
      // count once per day, which is correct).
      n: sql<number>`count(distinct ${records.payload}->>'taskId')::int`,
    })
    .from(records)
    .where(
      and(
        eq(records.userId, user.id),
        eq(records.kind, 'task_completion'),
        isNull(records.revertedAt),
        gte(records.createdAt, weekAgo),
        // exclude reopens (mark_open) — only real completions count
        sql`${records.payload}->'input'->>'kind' = 'mark_done'`,
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
      .select({ id: users.id, displayName: users.displayName, timezone: users.timezone, prefs: users.prefs, lastActiveAt: users.lastActiveAt })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!row) return;
    const prefs = (row.prefs as Record<string, unknown> | null) ?? null;
    // A user who explicitly turned proactive reach-outs off gets none — even
    // these gentle in-thread ones. Default is on (companion direction).
    if (prefs?.proactiveCheckins === false) return;

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
    if (!(await alreadySent(userId, `daily:${todayYmd}`))) {
      await deliver(await buildDailyRitual(user, todayYmd));
    }
  } catch (err) {
    logger.warn({ err, userId }, 'user catch-up failed');
  }
}
