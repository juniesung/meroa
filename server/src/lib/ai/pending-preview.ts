import type { GoalPreview, StarterTask } from '../goals/schema.ts';

// The one kind of state that exists nowhere but the conversation: a
// create_goal preview that hasn't been saved yet (create_goal deliberately
// persists nothing — the Create tap does). The act/narrate split's action
// pass runs on a deliberately tiny history window, so "make it $120
// instead" must resolve against *state*, not deep history — this derives
// that state from the already-fetched recent messages
// (docs/goals-redesign-plan.md, second as-a-user pass).
export type MessageLike = {
  role: string;
  meta: unknown;
  createdAt: Date;
};

type PreviewMeta = {
  kind?: string;
  preview?: GoalPreview;
  createdGoalId?: string;
};

/**
 * The newest goal preview that was shown but never consumed by a Create
 * tap, or null. A newer preview supersedes older ones (each create_goal
 * call renders a fresh card — the model treats the latest as "the"
 * preview), and a consumed one (meta.createdGoalId stamped by POST /goals)
 * is no longer pending. Client-local "Not now" dismissals never reach the
 * server, so a dismissed card still counts as pending here — harmless: it
 * just means "make it $120" after a dismissal still knows what "it" was.
 */
export function findPendingPreview(messages: MessageLike[]): GoalPreview | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role !== 'assistant') continue;
    const meta = message.meta as PreviewMeta | null;
    if (meta?.kind !== 'goal_preview' || !meta.preview) continue;
    return meta.createdGoalId ? null : meta.preview;
  }
  return null;
}

function describeStarter(starter: StarterTask, currency: string): string {
  const cadence =
    starter.recurrence?.freq === 'daily'
      ? ' daily'
      : starter.recurrence?.freq === 'weekly'
        ? ` weekly on ${starter.recurrence.byWeekday.join(',')}`
        : starter.recurrence?.freq === 'every_n_days'
          ? ` every ${starter.recurrence.n} days`
          : '';
  return `"${starter.title}"${cadence} (${currency}${starter.contribution}/completion)`;
}

/** One compact state line for the model's context, '' when nothing is pending. */
export function renderPendingPreview(preview: GoalPreview | null): string {
  if (!preview) return '';
  const d = preview.definition;
  const deadline = d.deadline ? ` · by ${d.deadline}` : '';
  const starters = preview.starterTasks?.length
    ? ` · starter tasks: ${preview.starterTasks.map((s) => describeStarter(s, d.currency)).join('; ')}`
    : '';
  return `A create_goal preview is showing but NOT saved yet (the user hasn't tapped Create): "${preview.name}" · ${d.currency}${d.targetValue}${deadline}${starters}. If the user asks to change it, call create_goal again with the full revised version; if they ask about it, it's this one.`;
}
