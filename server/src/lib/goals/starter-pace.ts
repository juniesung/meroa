import { addDaysToYmd, daysBetweenYmd, isDueOn } from '../tasks/recurrence.ts';
import type { Recurrence } from '../tasks/schema.ts';
import type { StarterTask } from './schema.ts';

/**
 * How many times `recurrence` is due between `fromYmd` and `toYmd`
 * inclusive, anchored at `fromYmd` (a starter task's first occurrence is
 * always today — see createGoal/materializeRecurringInstances). Same
 * bounded-iteration shape as materializeRecurringInstances's own cursor
 * loop; deadlines are capped by ISO_DATE's regex to a real date, so this
 * always terminates.
 */
export function countOccurrences(recurrence: Recurrence, fromYmd: string, toYmd: string, tz: string): number {
  let count = 0;
  let cursor = fromYmd;
  while (daysBetweenYmd(cursor, toYmd) >= 0) {
    if (isDueOn(recurrence, cursor, fromYmd, tz)) count++;
    cursor = addDaysToYmd(cursor, 1);
  }
  return count;
}

export type StarterPaceShortfall = { projectedTotal: number; shortfall: number };

/**
 * Advisory-only check for the "$5/day starter against a $1000/7-day goal"
 * class of gap (small-nits ledger, docs/goals-redesign-plan.md) — projects
 * what the proposed starter tasks would actually total by the deadline and
 * flags a shortfall so the model can propose a better pace before the user
 * taps Create. Never blocks creation (create_goal's own validation already
 * covers what's required); returns null when there's nothing to flag —
 * no deadline, no contributing starters, or already on pace.
 */
export function checkStarterPace(
  targetValue: number,
  deadline: string,
  starterTasks: StarterTask[],
  todayYmd: string,
  tz: string,
): StarterPaceShortfall | null {
  const contributing = starterTasks.filter(
    (s): s is StarterTask & { recurrence: Recurrence; contribution: number } =>
      !!s.recurrence && typeof s.contribution === 'number',
  );
  if (contributing.length === 0) return null;

  const projectedTotal = contributing.reduce(
    (sum, s) => sum + countOccurrences(s.recurrence, todayYmd, deadline, tz) * s.contribution,
    0,
  );
  const shortfall = targetValue - projectedTotal;
  if (shortfall <= 0) return null;
  return { projectedTotal, shortfall };
}
