import type { GoalPreview, StarterTask } from '../goals/schema.ts';
import { formatMoney } from '../goals/summary.ts';

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

/**
 * Same "was a preview shown but never consumed by a Create tap" question as
 * findPendingPreview, for create_task instead of create_goal — but callers
 * here only need a yes/no, not the preview's contents (a task preview's
 * contents already reach the model via the create_task tool result, and the
 * task list only ever reflects REAL rows). This exists specifically to feed
 * ChatActionContext.hasPendingPreview: without it, that flag only ever
 * recognized a pending GOAL preview, so the claim-check guard's exemption
 * for "describing a card that's legitimately still pending" (shared.ts's
 * matchedPreviewClaim) had no way to know a pending TASK card was real —
 * and force-corrected an honest reference to one as a false claim (observed
 * live: "could you tap Create on that card" about a genuinely-pending
 * "Take creatine" preview got retracted as "that preview didn't actually go
 * through," which was itself wrong).
 */
export function hasPendingTaskPreview(messages: MessageLike[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role !== 'assistant') continue;
    const meta = message.meta as { kind?: string; createdTaskId?: string } | null;
    if (meta?.kind !== 'task_creation_pending') continue;
    return !meta.createdTaskId;
  }
  return false;
}

function describeStarter(starter: StarterTask, currency: string | null): string {
  const cadence =
    starter.recurrence?.freq === 'daily'
      ? ' daily'
      : starter.recurrence?.freq === 'weekly'
        ? ` weekly on ${starter.recurrence.byWeekday.join(',')}`
        : starter.recurrence?.freq === 'every_n_days'
          ? ` every ${starter.recurrence.n} days`
          : '';
  const amount =
    starter.contribution !== undefined && currency !== null
      ? ` (${currency}${formatMoney(starter.contribution)}/completion)`
      : '';
  return `"${starter.title}"${cadence}${amount}`;
}

// Used by BOTH renderPendingPreview below (the tail-block context line) AND
// lib/ai/actions.ts's create_goal tool-result summary — the same concrete
// facts feed both, so a card's real contents (or the real absence of
// starter tasks) is what the model quotes, never what it assumes. Without
// this grounding in the tool result specifically, the narrate pass has
// nothing but its own guess to describe a just-shown preview with — observed
// live: a milestone preview with genuinely ZERO starterTasks got narrated as
// "first stage has starter tasks like updating your resume, researching
// companies, and submitting apps," inventing three tasks that were never in
// the preview at all (docs/ai-reliability-hardening.md's lesson 6/16 class,
// surfaced here because create_goal's summary previously said nothing about
// contents at all).
function describeGoalFacts(preview: GoalPreview): string {
  const d = preview.definition;
  const currency = d.type === 'savings' ? d.currency : null;
  const facts =
    d.type === 'savings'
      ? ` · ${d.currency}${formatMoney(d.targetValue)}${d.deadline ? ` · by ${d.deadline}` : ''}`
      : d.type === 'indirect'
        ? ` · indirect (${d.unit}${d.targetValue !== undefined ? `, target ${d.targetValue}${d.unit}` : ', no target'}${d.deadline ? ` · by ${d.deadline}` : ''})`
        : d.type === 'milestone'
          ? d.stages.length === 0
            ? ' · milestone (no stages yet — a bare template; the user adds stages in the Goals tab)'
            : ` · milestone (${d.stages.length} stages, starting at "${d.stages[0]}")`
          : ' · habit (daily check-in streak, no target amount)';
  const starters = preview.starterTasks?.length
    ? ` · starter tasks: ${preview.starterTasks.map((s) => describeStarter(s, currency)).join('; ')}`
    : ' · no starter tasks proposed (the card has nothing to check off yet — only say it does if the user actually sees some)';
  return `${facts}${starters}`;
}

/** One compact state line for the model's context, '' when nothing is pending. */
export function renderPendingPreview(preview: GoalPreview | null): string {
  if (!preview) return '';
  return `A create_goal preview is showing but NOT saved yet (the user hasn't tapped Create): "${preview.name}"${describeGoalFacts(preview)}. If the user asks to change it, call create_goal again with the full revised version; if they ask about it, it's this one.`;
}

/**
 * What actually got shown on the just-rendered preview card, for the
 * create_goal tool-result summary (lib/ai/actions.ts) — the narrate pass
 * only ever sees this summary string, never the raw preview object, so
 * without a concrete fact here it has nothing to describe the card with but
 * its own guess. Same underlying facts as renderPendingPreview's context
 * line, phrased for a sentence rather than a compact state line.
 */
export function describeGoalPreviewForSummary(preview: GoalPreview): string {
  return `What's actually on the card: "${preview.name}"${describeGoalFacts(preview)}.`;
}
