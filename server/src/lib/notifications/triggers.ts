import { and, eq, inArray, isNull, lt, sql } from 'drizzle-orm';

import { db } from '../../db/client.ts';
import { goalEntries, goals, records, tasks } from '../../db/schema.ts';
import { env } from '../../env.ts';
import { listMemories } from '../memories/executor.ts';
import { buildGoalCardSummaries } from '../goals/summary.ts';

// A user row as the tick selects it.
export type NotifyUser = {
  id: string;
  displayName: string | null;
  timezone: string | null;
  prefs: Record<string, unknown> | null;
  lastActiveAt: Date | null;
};

// The kinds of proactive reach-out. Positive nudges celebrate a real number;
// accountability nudges name a real slip (the user's own commitment, never
// guilt — CLAUDE.md §2); whole-life nudges are the "friend who texts first
// about nothing in particular" — grounded in a stored memory, never invented.
export type NotificationKind =
  | 'near_completion'
  | 'streak'
  | 'winback'
  | 'checkin'
  | 'stalled_task'
  | 'stale_goal'
  | 'broken_streak'
  | 'loose_thread';

export type NotificationTrigger = {
  kind: NotificationKind;
  // The COMPLETE authoritative facts the composer may quote and the figure
  // guard checks against. Every number that could appear in the copy is here,
  // computed in SQL — the model only ever quotes, never derives (CLAUDE.md §2).
  facts: string;
  // Deterministic fallback copy, sent verbatim if the composer is unavailable
  // or its output fails the grounding guard.
  templateBody: string;
  // Idempotency key — one row per (user, dedupeKey) in notifications_log.
  dedupeKey: string;
  data: Record<string, unknown>;
  // A single non-sensitive memory the composer may weave in. Never populated
  // from a sensitive memory.
  memoryHint?: string;
};

// A trigger plus the odds it's the one we send this tick. Higher = more likely.
type Candidate = NotificationTrigger & { weight: number };

function ymdInTz(now: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

const DAY_MS = 24 * 60 * 60 * 1000;

// A task pushed this many times (or once with reason "avoided") is a real
// pattern worth naming, not a one-off.
const POSTPONE_CALLOUT = 2;
// An open task overdue by at least this long is being quietly dropped.
const STALE_TASK_DAYS = 3;
// An in-progress savings/indirect goal untouched this long has stalled.
const STALE_GOAL_DAYS = 7;
// A quiet, on-track active user gets a "just checking in" only this often, so
// the random texting stays a pleasant surprise, not a daily obligation.
const RANDOM_CHECKIN_CHANCE = 0.2;

// Weighted pick: draws one candidate with probability proportional to weight.
// rng is injectable so tests are deterministic; defaults to Math.random.
function pickWeighted(items: Candidate[], rng: () => number): Candidate | null {
  if (items.length === 0) return null;
  const total = items.reduce((s, i) => s + i.weight, 0);
  if (total <= 0) return null;
  let r = rng() * total;
  for (const it of items) {
    r -= it.weight;
    if (r < 0) return it;
  }
  return items[items.length - 1] ?? null;
}

// --- accountability detectors ---------------------------------------------

// How many times each still-open task has been postponed, and whether any of
// those postpones were an explicit "avoided" — the strongest slip signal.
async function postponeCounts(userId: string): Promise<Map<string, { count: number; avoided: boolean }>> {
  const rows = await db
    .select({
      taskId: sql<string>`${records.payload}->>'taskId'`,
      count: sql<number>`count(*)::int`,
      avoided: sql<boolean>`bool_or(${records.payload}->>'reason' = 'avoided')`,
    })
    .from(records)
    .where(and(eq(records.userId, userId), eq(records.kind, 'task_postponed'), isNull(records.revertedAt)))
    .groupBy(sql`${records.payload}->>'taskId'`);
  const map = new Map<string, { count: number; avoided: boolean }>();
  for (const r of rows) if (r.taskId) map.set(r.taskId, { count: r.count, avoided: r.avoided });
  return map;
}

// The single most-neglected open task: overdue longest, enriched with how many
// times it's been pushed. Returns null if nothing is genuinely being dropped.
async function stalledTaskCandidate(user: NotifyUser, now: Date, todayYmd: string): Promise<Candidate | null> {
  const cutoff = new Date(now.getTime() - STALE_TASK_DAYS * DAY_MS);
  const overdue = await db
    .select({ id: tasks.id, title: tasks.title, dueAt: tasks.dueAt })
    .from(tasks)
    .where(
      and(
        eq(tasks.userId, user.id),
        eq(tasks.status, 'open'),
        isNull(tasks.deletedAt),
        isNull(tasks.recurrence), // skip template rows; overdue instances still qualify
        lt(tasks.dueAt, cutoff),
      ),
    )
    .orderBy(tasks.dueAt)
    .limit(1);
  const task = overdue[0];
  if (!task || !task.dueAt) return null;

  const daysOverdue = Math.floor((now.getTime() - task.dueAt.getTime()) / DAY_MS);
  const pushes = (await postponeCounts(user.id)).get(task.id);
  const pattern =
    pushes && (pushes.count >= POSTPONE_CALLOUT || pushes.avoided)
      ? ` They've pushed it ${pushes.count} time${pushes.count === 1 ? '' : 's'}${pushes.avoided ? ', at least once because they were avoiding it' : ''}.`
      : '';

  const facts = [
    `"${task.title}" is an open task that's now ${daysOverdue} day${daysOverdue === 1 ? '' : 's'} overdue.${pattern}`,
    `Call it out plainly as a friend who wants them to follow through — name the pattern, not their character, and offer a real next step (do it, reschedule it, shrink it, or drop it). Never guilt, shame, or "you're falling behind".`,
  ].join('\n');

  return {
    kind: 'stalled_task',
    weight: pushes && (pushes.count >= POSTPONE_CALLOUT || pushes.avoided) ? 6 : 4,
    facts,
    templateBody: `"${task.title}" keeps sliding — what's the actual blocker?`,
    dedupeKey: `stalled:${task.id}:${todayYmd}`,
    data: { route: 'chat' },
  };
}

// --- build ----------------------------------------------------------------

/**
 * The single most worthwhile thing to say to this user right now, or null if
 * there's nothing worth a proactive reach-out. Two phases:
 *
 * - Inactive (drifted away): a personalized winback that references a real goal
 *   or streak they were building, plus one non-sensitive memory — the "friend
 *   who remembers you" move. Falls back to a plain check-in if there's nothing
 *   concrete to point at yet.
 * - Active: gather every honest thing worth saying — a slip they're dropping, a
 *   goal that's stalled, a streak that broke, a milestone they're close to, a
 *   live streak, a loose thread from a past chat, or just a hello — then pick
 *   ONE by weight so it feels like a person with range, not a daily report.
 *
 * Every number comes straight from buildGoalCardSummaries or a SQL count — never
 * recomputed here, never invented (CLAUDE.md §2). rng is injectable for tests.
 */
export async function buildTrigger(
  user: NotifyUser,
  now: Date,
  rng: () => number = Math.random,
): Promise<NotificationTrigger | null> {
  const tz = user.timezone ?? 'UTC';
  const todayYmd = ymdInTz(now, tz);
  const inactive =
    !user.lastActiveAt || now.getTime() - user.lastActiveAt.getTime() >= env.NOTIFY_WINBACK_AFTER_DAYS * DAY_MS;

  const goalRows = await db
    .select()
    .from(goals)
    .where(and(eq(goals.userId, user.id), isNull(goals.archivedAt)));
  const summaries = await buildGoalCardSummaries(goalRows, user.timezone);
  const name = user.displayName?.trim() || null;

  // Best live habit streak (>= 3 days is worth acknowledging).
  let bestStreak: { goalName: string; current: number; longest: number } | null = null;
  // Savings/indirect goal closest to done in the 70–99% band.
  let bestNear: { goalName: string; headline: string; paceLine: string | null; pct: number } | null = null;
  // A habit whose streak has reset from a run of >= 3 — a chance to restart, no guilt.
  let broken: { goalId: string; goalName: string; longest: number } | null = null;

  for (const goal of goalRows) {
    const s = summaries.get(goal.id);
    if (!s) continue;
    if (s.streak && s.streak.current >= 3) {
      if (!bestStreak || s.streak.current > bestStreak.current) {
        bestStreak = { goalName: goal.name, current: s.streak.current, longest: s.streak.longest };
      }
    }
    if (s.streak && s.streak.current === 0 && s.streak.longest >= 3) {
      if (!broken || s.streak.longest > broken.longest) {
        broken = { goalId: goal.id, goalName: goal.name, longest: s.streak.longest };
      }
    }
    if (s.progress !== null && s.progress >= 0.7 && s.progress < 1) {
      const pct = Math.round(s.progress * 100);
      if (!bestNear || pct > bestNear.pct) {
        bestNear = { goalName: goal.name, headline: s.headline, paceLine: s.paceLine, pct };
      }
    }
  }

  // Non-sensitive memories, fetched once — used for the personal touch on a
  // winback and as the whole hook for a loose-thread / check-in.
  const memories = await listMemories(user.id);
  const nonSensitive = memories.filter((m) => !m.sensitive);
  const memoryHint = nonSensitive[0]?.content;

  // --- inactive: one personalized winback ---------------------------------
  if (inactive) {
    const anchor = bestStreak
      ? { line: `${bestStreak.goalName} streak: ${bestStreak.current} days`, goalName: bestStreak.goalName }
      : bestNear
        ? { line: `${bestNear.goalName}: ${bestNear.headline}`, goalName: bestNear.goalName }
        : null;

    const facts = [
      `This is a re-engagement message to ${name ?? 'the user'}, who hasn't opened the app in a while.`,
      anchor ? `They were working on — ${anchor.line}.` : `They have no active goal progress to reference yet.`,
      memoryHint ? `Something you know about them: ${memoryHint}` : null,
    ]
      .filter(Boolean)
      .join('\n');

    const templateBody = anchor
      ? `been a bit — how's ${anchor.goalName} going?`
      : `been a little while — how are you doing?`;

    return { kind: 'winback', facts, templateBody, dedupeKey: `winback:${todayYmd}`, data: { route: 'chat' }, memoryHint };
  }

  // --- active: gather every honest candidate, then pick one by weight ------
  const candidates: Candidate[] = [];

  const stalled = await stalledTaskCandidate(user, now, todayYmd);
  if (stalled) candidates.push(stalled);

  const staleGoal = await staleGoalCandidate(user.id, goalRows, summaries, now, todayYmd);
  if (staleGoal) candidates.push(staleGoal);

  if (broken) {
    candidates.push({
      kind: 'broken_streak',
      weight: 3,
      facts: [
        `${broken.goalName} is a habit goal whose streak has reset to zero. Their longest run was ${broken.longest} days.`,
        `Nudge them to start a fresh streak today — warm and matter-of-fact, "day one starts now". Never guilt, never "you lost it".`,
      ].join('\n'),
      templateBody: `${broken.goalName} streak reset — want to start a new one today?`,
      dedupeKey: `broken:${broken.goalId}:${todayYmd}`,
      data: { route: 'chat' },
    });
  }

  if (bestNear) {
    candidates.push({
      kind: 'near_completion',
      weight: 5,
      facts: [
        `${bestNear.goalName} is a goal in progress.`,
        `Progress: ${bestNear.headline} (${bestNear.pct}% of the way there).`,
        bestNear.paceLine ? `Pace: ${bestNear.paceLine}.` : null,
      ]
        .filter(Boolean)
        .join('\n'),
      templateBody: `${bestNear.goalName}: ${bestNear.headline} — so close 💪`,
      dedupeKey: `near:${bestNear.goalName}:${todayYmd}`,
      data: { route: 'goals' },
    });
  }

  if (bestStreak) {
    candidates.push({
      kind: 'streak',
      weight: 4,
      facts: [
        `${bestStreak.goalName} is a habit goal.`,
        `Current streak: ${bestStreak.current} days in a row. Longest ever: ${bestStreak.longest} days.`,
      ].join('\n'),
      templateBody: `${bestStreak.current} days on ${bestStreak.goalName} 🔥 keep it going`,
      dedupeKey: `streak:${bestStreak.goalName}:${todayYmd}`,
      data: { route: 'goals' },
    });
  }

  // Whole-life: follow up on a real thing they mentioned (a "situation" they
  // told you about — an interview, a trip, a rough week). Grounded in the
  // stored memory, never invented.
  const situation = nonSensitive.find((m) => m.kind === 'situation');
  if (situation) {
    candidates.push({
      kind: 'loose_thread',
      weight: 3,
      facts: [
        `Something ${name ?? 'they'} mentioned in a past conversation: ${situation.content}`,
        `Text first to follow up on it naturally, the way a friend who remembered would — ask how it went / how it's going. Don't invent any detail beyond what's above.`,
      ].join('\n'),
      templateBody: `been thinking — how are things going?`,
      dedupeKey: `loose:${situation.id}:${todayYmd}`,
      data: { route: 'chat' },
      memoryHint: situation.content,
    });
  }

  // A quiet, on-track active user gets an occasional plain hello — the random
  // "texts you for no reason" texture. rng-gated so it isn't every day.
  if (rng() < RANDOM_CHECKIN_CHANCE) {
    candidates.push({
      kind: 'checkin',
      weight: 2,
      facts: [
        `A light, no-agenda check-in with ${name ?? 'the user'} — just texting first because a friend does that.`,
        memoryHint ? `Something you know about them you could open with: ${memoryHint}` : null,
        `Keep it easy and warm. Don't manufacture a task or a number.`,
      ]
        .filter(Boolean)
        .join('\n'),
      templateBody: `hey — how's your day going?`,
      dedupeKey: `checkin:${todayYmd}`,
      data: { route: 'chat' },
      memoryHint,
    });
  }

  const picked = pickWeighted(candidates, rng);
  if (!picked) return null;
  const { weight, ...trigger } = picked;
  return trigger;
}

// The most-stalled in-progress savings/indirect goal: created a while ago and
// with no live entry (or none recently). Habit/milestone goals are excluded —
// they have no logged amount to go stale (their slip is the broken streak).
async function staleGoalCandidate(
  userId: string,
  goalRows: (typeof goals.$inferSelect)[],
  summaries: Awaited<ReturnType<typeof buildGoalCardSummaries>>,
  now: Date,
  todayYmd: string,
): Promise<Candidate | null> {
  const trackable = goalRows.filter((g) => g.template === 'savings' || g.template === 'indirect');
  if (trackable.length === 0) return null;

  const ids = trackable.map((g) => g.id);
  const lastRows = await db
    .select({ goalId: goalEntries.goalId, last: sql<Date>`max(${goalEntries.entryAt})` })
    .from(goalEntries)
    .innerJoin(records, eq(goalEntries.recordId, records.id))
    .where(and(inArray(goalEntries.goalId, ids), isNull(records.revertedAt)))
    .groupBy(goalEntries.goalId);
  const lastByGoal = new Map<string, Date>();
  for (const r of lastRows) if (r.last) lastByGoal.set(r.goalId, r.last);

  const cutoff = now.getTime() - STALE_GOAL_DAYS * DAY_MS;
  let worst: { goal: (typeof goals.$inferSelect); idleDays: number; headline: string } | null = null;
  for (const goal of trackable) {
    const s = summaries.get(goal.id);
    if (!s || s.progress === null || s.progress >= 1) continue; // skip finished / unmeasured
    const last = lastByGoal.get(goal.id);
    const since = last ? last.getTime() : goal.createdAt.getTime();
    if (since >= cutoff) continue; // touched recently enough
    const idleDays = Math.floor((now.getTime() - since) / DAY_MS);
    if (!worst || idleDays > worst.idleDays) worst = { goal, idleDays, headline: s.headline };
  }
  if (!worst) return null;

  return {
    kind: 'stale_goal',
    weight: 4,
    facts: [
      `${worst.goal.name} is a goal in progress (${worst.headline}) that hasn't had a new entry in ${worst.idleDays} days.`,
      `Check in on it like a friend who noticed — is it still something they want, and what's one small move? Never guilt or "you're behind".`,
    ].join('\n'),
    templateBody: `${worst.goal.name} has been quiet ${worst.idleDays} days — still going for it?`,
    dedupeKey: `stalegoal:${worst.goal.id}:${todayYmd}`,
    data: { route: 'chat' },
  };
}
