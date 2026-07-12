// Pure decision core for the connected loop's completion→entry side
// (docs/goals-redesign-plan.md §2.3) — split out of applyProgress
// (executor.ts) so the double-count trap (un-complete → re-complete) is
// unit-testable without a database. applyProgress executes whatever this
// returns against the transaction; this function itself only decides.
export type GoalEntryDecision =
  | { action: 'insert'; goalId: string; recordId: string; amount: number; entryAt: Date }
  | { action: 'delete'; recordId: string }
  | { action: 'none' };

export function decideGoalEntryAction(params: {
  goalId: string | null;
  // An archived (removed) goal accepts no new entries anywhere —
  // logGoalEntry already 404s on archived — so a still-linked task
  // completing after its goal was removed logs nothing rather than writing
  // into an archived container. The delete side still runs regardless of
  // archive state: a stale auto-entry must always be cleaned up on reopen.
  goalArchived: boolean;
  goalContribution: unknown;
  becameDone: boolean;
  becameOpen: boolean;
  newRecordId: string;
  // The task's completedRecordId as it was *before* this transition — the
  // record a becameOpen needs to find and remove the auto-entry for.
  priorCompletedRecordId: string | null;
  entryAt: Date;
}): GoalEntryDecision {
  if (!params.goalId) return { action: 'none' };

  if (params.becameDone && !params.goalArchived && typeof params.goalContribution === 'number') {
    return {
      action: 'insert',
      goalId: params.goalId,
      recordId: params.newRecordId,
      amount: params.goalContribution,
      entryAt: params.entryAt,
    };
  }

  if (params.becameOpen && params.priorCompletedRecordId) {
    return { action: 'delete', recordId: params.priorCompletedRecordId };
  }

  return { action: 'none' };
}
