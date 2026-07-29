import { and, eq, gte, isNull, like, sql } from 'drizzle-orm';

import { db } from '../../db/client.ts';
import { goals, notificationsLog, tasks, users } from '../../db/schema.ts';
import { logger } from '../../logger.ts';
import { congratsLine } from '../achievements/copy.ts';
import { evaluateAchievements, markAnnounced, mostSignificant } from '../achievements/evaluate.ts';
import { resolveTone } from '../ai/system-prompt.ts';
import { buildGoalCardSummaries } from '../goals/summary.ts';
import type { GoalDefinition } from '../goals/schema.ts';
import { composeProactiveMessage } from './proactive-message.ts';
import { deliverThreadReachOut } from './dispatch.ts';
import { alreadySent, withinFrequencyCap } from './policy.ts';
import type { NotificationTrigger } from './triggers.ts';

// "Meroa noticed" — event-driven, milestone-weighted reactions to something the
// user did OUTSIDE chat (a Tasks/Goals-tab completion, log, or stage advance).
// A chat-originated action already shows a card in the thread, so those are NOT
// routed here (the mutation routes only emit for source 'tasks_ui'/'goal_ui').
//
// Milestone-weighted by design: we react on beats worth noticing, not every
// tap. The "highest reached bucket, fire once" shape falls straight out of the
// dedupeKey — buildReactionTrigger always returns the trigger for the single
// highest milestone currently reached, and the caller's alreadySent() check on
// that key means each milestone fires at most once, in order, ever. No
// before/after diffing needed, and a big jump (10% -> 60%) correctly fires only
// the 50% beat, never a stale 25% one afterward.

// The affected entity, handed in by the mutation route right after it commits.
export type ReactionEvent =
  | { type: 'task_completed'; taskId: string }
  | { type: 'goal_entry'; goalId: string }
  | { type: 'stage_advanced'; goalId: string };

const PCT_BUCKETS = [25, 50, 75, 100] as const;
const STREAK_MILESTONES = [3, 7, 14, 30] as const;

// A loose ceiling so a burst of milestone-crossings in one session can't turn
// into a wall of reactions. Milestones are already deduped per bucket, so this
// only bites in an unusual flurry (e.g. logging a big backlog at once).
const REACTION_MAX_PER_DAY = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

async function withinReactionCap(userId: string, now: Date): Promise<boolean> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(notificationsLog)
    .where(
      and(
        eq(notificationsLog.userId, userId),
        gte(notificationsLog.sentAt, new Date(now.getTime() - DAY_MS)),
        like(notificationsLog.kind, 'reaction_%'),
      ),
    );
  return (row?.n ?? 0) < REACTION_MAX_PER_DAY;
}

// Highest reached bucket, or null if none reached yet. Returning only the single
// highest reached milestone (never a lower one) is what gives the "fire once, in
// order" behavior when paired with the caller's per-key dedupe — a jump from 10%
// to 60% yields 50, and once 50 is sent a later 60% yields 50 again (skipped),
// never a stale 25%. Exported for the pure unit test.
export function progressBucket(progress: number): number | null {
  const pct = progress * 100;
  let hit: number | null = null;
  for (const b of PCT_BUCKETS) if (pct >= b - 1e-9) hit = b;
  return hit;
}
export function streakMilestone(current: number): number | null {
  let hit: number | null = null;
  for (const m of STREAK_MILESTONES) if (current >= m) hit = m;
  return hit;
}

async function loadGoal(userId: string, goalId: string) {
  const [g] = await db
    .select()
    .from(goals)
    .where(and(eq(goals.id, goalId), eq(goals.userId, userId), isNull(goals.archivedAt)))
    .limit(1);
  return g ?? null;
}

/**
 * The single most worthwhile reaction to this event right now, or null if the
 * event didn't cross a milestone worth a word. Every number in `facts` comes
 * straight from buildGoalCardSummaries (SQL-computed) — the composer only ever
 * QUOTES it, never derives one (CLAUDE.md §2), and proactive-message.ts
 * figure-guards the result before it can be shown.
 */
export async function buildReactionTrigger(
  userId: string,
  event: ReactionEvent,
  timezone: string | null,
  _now: Date,
): Promise<NotificationTrigger | null> {
  // Stage advance: react to the new active stage (dedupe per stage index).
  if (event.type === 'stage_advanced') {
    const goal = await loadGoal(userId, event.goalId);
    if (!goal) return null;
    const def = goal.definition as GoalDefinition;
    if (def.type !== 'milestone') return null;
    const stageName = def.stages[def.activeStageIndex];
    if (!stageName) return null; // goal completed past its last stage, or no stages
    return {
      kind: 'reaction_stage',
      facts: [
        `The user just moved their goal "${goal.name}" forward to a new stage: "${stageName}". This happened just now, from the Goals tab (not in chat).`,
        `React briefly, like a friend who noticed the momentum. Do not invent any number or detail beyond the stage name above.`,
      ].join('\n'),
      templateBody: `onto "${stageName}" for "${goal.name}" now. that's real movement.`,
      dedupeKey: `react:stage:${goal.id}:${def.activeStageIndex}`,
      data: { route: 'chat' },
    };
  }

  // Resolve the goal affected by a completion / log entry.
  let goalId: string;
  if (event.type === 'goal_entry') {
    goalId = event.goalId;
  } else {
    const [task] = await db
      .select({ status: tasks.status, goalId: tasks.goalId })
      .from(tasks)
      .where(and(eq(tasks.id, event.taskId), eq(tasks.userId, userId)))
      .limit(1);
    // Only a task that is actually done and linked to a goal can move one.
    if (!task || task.status !== 'done' || !task.goalId) return null;
    goalId = task.goalId;
  }

  const goal = await loadGoal(userId, goalId);
  if (!goal) return null;
  const definition = goal.definition as GoalDefinition;
  const summaries = await buildGoalCardSummaries([goal], timezone);
  const s = summaries.get(goal.id);
  if (!s) return null;

  // Habit goal → celebrate a streak milestone (completing its check-in is what
  // extended the streak).
  if (definition.type === 'habit') {
    if (!s.streak) return null;
    const milestone = streakMilestone(s.streak.current);
    if (!milestone) return null;
    return {
      kind: 'reaction_streak',
      facts: [
        `The user just checked in on their habit "${goal.name}" and it's now a ${s.streak.current}-day streak (they just reached the ${milestone}-day mark). This happened just now, from the Tasks/Goals tab.`,
        `Hype the consistency briefly, like a friend who noticed. Quote the day count exactly (${s.streak.current}); invent nothing.`,
      ].join('\n'),
      templateBody: `${s.streak.current} days straight on "${goal.name}". that streak's the real deal.`,
      dedupeKey: `react:streak:${goal.id}:${milestone}`,
      data: { route: 'chat' },
    };
  }

  // Savings / indirect goal → celebrate a progress bucket (this also covers the
  // 100% completion beat). Milestone goals never take this path (their progress
  // is stage-based; the stage_advanced event above owns that).
  if (definition.type === 'milestone') return null;
  if (s.progress === null) return null; // e.g. an indirect goal with no target set
  const bucket = progressBucket(s.progress);
  if (!bucket) return null;

  const done = bucket === 100;
  return {
    kind: 'reaction_progress',
    facts: [
      done
        ? `The user just hit the target on their goal "${goal.name}" — it's complete: ${s.headline} (100%). This happened just now, from the Tasks/Goals tab.`
        : `The user just crossed ${bucket}% on their goal "${goal.name}": ${s.headline}${s.paceLine ? ` (${s.paceLine})` : ''}. This happened just now, from the Tasks/Goals tab.`,
      `React briefly, like a friend who noticed real progress. Quote the figures exactly as written above; never change or invent a number.`,
    ].join('\n'),
    templateBody: done
      ? `you just hit your "${goal.name}" goal, ${s.headline}. that's huge.`
      : `"${goal.name}" just passed ${bucket}%, ${s.headline}. nice work.`,
    dedupeKey: `react:pct:${goal.id}:${bucket}`,
    data: { route: 'chat' },
  };
}

/**
 * Fire-and-forget "Meroa noticed" beat for an app-originated (Tasks/Goals-tab)
 * mutation. Call it right AFTER the mutation commits, WITHOUT awaiting — it must
 * never block or fail the request. Delivers at most ONE beat:
 *
 *  1. If the mutation earned an achievement, celebrate the most significant one
 *     in Meroa's voice (deterministic congratsLine — no model call). This is the
 *     "Meroa voice for tab-earned achievements" — chat-earned ones are already
 *     announced by routes/messages.ts.
 *  2. Otherwise fall back to a plain "you hit 50%" reaction (LLM-composed).
 *
 * Achievement first because it's the richer beat AND often celebrates the SAME
 * crossing (a goal_progress tier vs a progress reaction) — firing both would
 * double-message. Cross-path double-earn is already impossible: the achievements
 * unique (user,key,tier) insert means whichever path evaluates first is the only
 * one that gets a row back to announce.
 */
export function emitProgressBeat(userId: string, event: ReactionEvent): void {
  void (async () => {
    try {
      const now = new Date();
      const [user] = await db
        .select({ timezone: users.timezone, prefs: users.prefs })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      if (!user) return;

      // Every in-thread proactive message honors the user's frequency cap — the
      // same one the cron tick enforces (CLAUDE.md §2 + the user's notificationCap
      // override; a user who set perDay:0 wants zero proactive messages). Checked
      // BEFORE evaluateAchievements so nothing gets markAnnounced-suppressed when
      // over cap — the badge stays un-announced and surfaces on a later beat.
      if (!(await withinFrequencyCap(userId, user.prefs as Record<string, unknown> | null, now))) return;

      const earned = await evaluateAchievements(userId, user.timezone);
      const top = mostSignificant(earned);
      if (top) {
        const delivered = await deliverThreadReachOut(
          userId,
          {
            kind: `achievement_${top.family.category}`,
            dedupeKey: `achievement:${top.key}:${top.tier}`,
            chatBody: congratsLine(top),
            data: { route: 'you' },
          },
          { push: false },
        );
        // Stamp all newly-earned so no other path re-announces them (we chose to
        // celebrate one and suppress the rest, same as the chat-turn path).
        if (delivered) await markAnnounced(userId, earned);
        return;
      }

      if (!(await withinReactionCap(userId, now))) return;
      const trigger = await buildReactionTrigger(userId, event, user.timezone, now);
      if (!trigger) return;
      // Cheap up-front skip so a duplicate never reaches the (paid) compose step;
      // the claim inside deliverThreadReachOut is the real race-safe guard.
      if (await alreadySent(userId, trigger.dedupeKey)) return;
      const tone = resolveTone(user.prefs as Record<string, unknown> | null);
      const chatBody = await composeProactiveMessage(trigger, tone);
      await deliverThreadReachOut(
        userId,
        { kind: trigger.kind, dedupeKey: trigger.dedupeKey, chatBody, data: trigger.data },
        { push: false },
      );
    } catch (err) {
      logger.warn({ err, userId }, 'progress beat failed');
    }
  })();
}
