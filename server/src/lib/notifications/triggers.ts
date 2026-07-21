import { and, eq, isNull } from 'drizzle-orm';

import { db } from '../../db/client.ts';
import { goals } from '../../db/schema.ts';
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

export type NotificationTrigger = {
  kind: 'near_completion' | 'streak' | 'winback' | 'checkin';
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
  // A single non-sensitive memory the composer may weave in for a winback.
  // Never populated for progress nudges, never from a sensitive memory.
  memoryHint?: string;
};

function ymdInTz(now: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The single most worthwhile thing to say to this user right now, or null if
 * there's nothing worth a proactive push. Two modes:
 *
 * - Inactive (drifted away): a personalized winback that references a real goal
 *   or streak they were building, plus one non-sensitive memory — the "friend
 *   who remembers you" move. Falls back to a plain check-in if they have no
 *   progress to point at yet.
 * - Active-but-quiet: a progress nudge (near a savings target, or a live habit
 *   streak) — the near-completion hook, grounded in the real number. Returns
 *   null rather than inventing a reason to ping an engaged user.
 *
 * Progress numbers come straight from buildGoalCardSummaries (headline,
 * paceLine, streak) — never recomputed here, never invented.
 */
export async function buildTrigger(user: NotifyUser, now: Date): Promise<NotificationTrigger | null> {
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

  for (const goal of goalRows) {
    const s = summaries.get(goal.id);
    if (!s) continue;
    if (s.streak && s.streak.current >= 3) {
      if (!bestStreak || s.streak.current > bestStreak.current) {
        bestStreak = { goalName: goal.name, current: s.streak.current, longest: s.streak.longest };
      }
    }
    if (s.progress !== null && s.progress >= 0.7 && s.progress < 1) {
      const pct = Math.round(s.progress * 100);
      if (!bestNear || pct > bestNear.pct) {
        bestNear = { goalName: goal.name, headline: s.headline, paceLine: s.paceLine, pct };
      }
    }
  }

  if (inactive) {
    // Reference the most concrete real thing they were building, if any.
    const anchor = bestStreak
      ? { line: `${bestStreak.goalName} streak: ${bestStreak.current} days`, goalName: bestStreak.goalName }
      : bestNear
        ? { line: `${bestNear.goalName}: ${bestNear.headline}`, goalName: bestNear.goalName }
        : null;

    // One non-sensitive memory to make it personal (never sensitive, never
    // suppressed — listMemories already drops suppressed).
    const memories = await listMemories(user.id);
    const memoryHint = memories.find((m) => !m.sensitive)?.content;

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

    return {
      kind: 'winback',
      facts,
      templateBody,
      dedupeKey: `winback:${todayYmd}`,
      data: { route: 'chat' },
      memoryHint,
    };
  }

  // Active user: only nudge if there's a real, positive number to point at.
  if (bestNear) {
    const facts = [
      `${bestNear.goalName} is a goal in progress.`,
      `Progress: ${bestNear.headline} (${bestNear.pct}% of the way there).`,
      bestNear.paceLine ? `Pace: ${bestNear.paceLine}.` : null,
    ]
      .filter(Boolean)
      .join('\n');
    return {
      kind: 'near_completion',
      facts,
      templateBody: `${bestNear.goalName}: ${bestNear.headline} — so close 💪`,
      dedupeKey: `near:${bestNear.goalName}:${todayYmd}`,
      data: { route: 'goals' },
    };
  }

  if (bestStreak) {
    const facts = [
      `${bestStreak.goalName} is a habit goal.`,
      `Current streak: ${bestStreak.current} days in a row. Longest ever: ${bestStreak.longest} days.`,
    ].join('\n');
    return {
      kind: 'streak',
      facts,
      templateBody: `${bestStreak.current} days on ${bestStreak.goalName} 🔥 keep it going`,
      dedupeKey: `streak:${bestStreak.goalName}:${todayYmd}`,
      data: { route: 'goals' },
    };
  }

  return null;
}
