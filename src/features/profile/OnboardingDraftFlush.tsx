import { useEffect, useRef } from 'react';

import { useCreateGoal } from '@/features/goals/queries';
import { useCreateTask } from '@/features/tasks/queries';
import { useMe, useUpdatePrefs } from './queries';

export type OnboardingDraft = {
  goal?: {
    type: 'savings' | 'habit' | 'indirect' | 'milestone';
    name: string;
    targetValue?: number; // savings (effectively required by the UI), indirect (optional)
    unit?: string; // indirect only
    checkinTitle?: string; // habit only — its recurring check-in task
  };
  task?: { title: string }; // savings/indirect/milestone only — habit has no separate task
};

/**
 * Consumes prefs.onboardingDraft — the goal/task a user set up during
 * onboarding, held there rather than created directly because onboarding
 * runs on the free plan, and the hard paywall's free-tier limits are zero
 * (a create attempt then would 429 — see docs/phases/phase-7-premium-
 * billing.md). The instant `entitlement.plan` flips to 'plus' (purchase,
 * restore, or `npm run dev:plan`), this creates the real goal (+ any linked
 * task) then clears the draft. Mounted alongside BillingGate in _layout.tsx,
 * only while signed in.
 *
 * Only clears the draft on success. A thrown create is NOT retried within
 * the same mount (flushing.current is deliberately never reset) — goal
 * creation has no idempotency check, so retrying in a loop (an unstable
 * effect dependency re-firing the effect several times a second is
 * plausible right after app launch) would create a duplicate goal on every
 * attempt, exactly as happened before this comment was written: a savings
 * goal linked without a contribution amount 400s on the task-create step
 * every time, and the old reset-on-catch let the whole sequence retry from
 * scratch, producing ~20 duplicate goals and zero tasks. A future mount
 * (the next real app launch) starts with a fresh ref and retries once.
 */
export function OnboardingDraftFlush() {
  const { data: me } = useMe();
  const createGoal = useCreateGoal();
  const createTask = useCreateTask();
  const updatePrefs = useUpdatePrefs();
  const flushing = useRef(false);

  useEffect(() => {
    if (!me || me.entitlement.plan !== 'plus' || flushing.current) return;
    const draft = me.user.prefs.onboardingDraft as OnboardingDraft | null | undefined;
    if (!draft || (!draft.goal && !draft.task)) return;

    flushing.current = true;
    (async () => {
      try {
        if (draft.goal?.type === 'habit') {
          // The check-in task IS the goal's mechanic — created together in
          // one call, exactly like GoalFormSheet.tsx's manual habit flow
          // (hardcoded daily recurrence, no frequency picker exposed).
          await createGoal.mutateAsync({
            type: 'habit',
            name: draft.goal.name,
            ...(draft.goal.checkinTitle
              ? { starterTasks: [{ title: draft.goal.checkinTitle, recurrence: { freq: 'daily' } }] }
              : {}),
          });
        } else if (draft.goal) {
          const { goal } = await createGoal.mutateAsync({
            type: draft.goal.type,
            name: draft.goal.name,
            ...(draft.goal.targetValue !== undefined ? { targetValue: draft.goal.targetValue } : {}),
            ...(draft.goal.unit ? { unit: draft.goal.unit } : {}),
          });
          if (draft.task) {
            await createTask.mutateAsync({
              type: 'completion',
              title: draft.task.title,
              // A savings goal requires a goalContribution on any linked task
              // (server/src/lib/tasks/executor.ts's validateGoalLinkTarget) —
              // onboarding never collects a contribution amount, so only link
              // for indirect/milestone, which accept a link with none.
              ...(draft.goal.type !== 'savings' ? { goalId: goal.id } : {}),
            });
          }
        } else if (draft.task) {
          await createTask.mutateAsync({ type: 'completion', title: draft.task.title });
        }
        updatePrefs.mutate({ onboardingDraft: null });
      } catch {
        // Deliberately not resetting flushing.current — see doc comment above.
      }
    })();
  }, [me, createGoal, createTask, updatePrefs]);

  return null;
}
