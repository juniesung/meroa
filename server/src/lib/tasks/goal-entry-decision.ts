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

// Pure decision core for post-creation task→goal linking's retro-credit rule
// (docs/goals-redesign-plan.md session 2, locked with the user): linking a
// task that's already completed *today* also credits that completion —
// linking one completed yesterday or earlier does not (no silent rewrite of
// older history). Habit goals need no entry at all (streaks are derived from
// the linked task's completions, automatically covering any already-done
// day); indirect goals never auto-log from a task by design. Split out of
// lib/tasks/executor.ts's editTask so the matrix (done-today / done-earlier /
// open / archived goal / habit / indirect / relink / already-credited) is
// unit-testable without a database — the caller does the DB reads and passes
// in only the facts this needs to decide.
export type RetroGoalEntryDecision =
  | { action: 'insert'; goalId: string; recordId: string; amount: number; entryAt: Date }
  | { action: 'none' };

export function decideRetroGoalEntry(params: {
  // The goal being linked to, resolved and validated by the caller — null
  // means this edit isn't a link (an unlink or unrelated edit).
  goalId: string | null;
  goalType: 'savings' | 'habit' | 'indirect' | undefined;
  goalArchived: boolean;
  // The contribution being set on this same link — retro-credit only ever
  // applies to a savings goal, which always carries one.
  contribution: number | undefined;
  taskStatus: string;
  completedRecordId: string | null;
  // ymd (account timezone) the completion record actually occurred, vs.
  // today's ymd in the same timezone — both precomputed by the caller so
  // this function stays pure.
  completedYmd: string | null;
  todayYmd: string;
  completedRecordOccurredAt: Date | null;
  // True if a live goal_entries row already exists for (goalId, recordId) —
  // guards a retried/idempotent edit from inserting a second entry for the
  // same completion.
  alreadyCredited: boolean;
}): RetroGoalEntryDecision {
  if (!params.goalId || params.goalArchived) return { action: 'none' };
  if (params.goalType !== 'savings') return { action: 'none' };
  if (typeof params.contribution !== 'number') return { action: 'none' };
  if (params.taskStatus !== 'done' || !params.completedRecordId || !params.completedRecordOccurredAt) {
    return { action: 'none' };
  }
  if (params.completedYmd !== params.todayYmd) return { action: 'none' };
  if (params.alreadyCredited) return { action: 'none' };
  return {
    action: 'insert',
    goalId: params.goalId,
    recordId: params.completedRecordId,
    amount: params.contribution,
    entryAt: params.completedRecordOccurredAt,
  };
}
