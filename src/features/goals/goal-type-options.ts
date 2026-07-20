import type { IconName } from '@/components/Icon';
import type { GoalTemplateKey } from '@/lib/api/types';

// The one description of what each goal type IS, shared by onboarding's
// picker and the Goals-tab create sheet. These were duplicated by hand
// (onboarding's own comment said as much) and had already drifted: only
// onboarding carried the descriptions and examples, so the picker in the
// real create flow was four bare chips with nothing explaining the
// difference between "Savings" and "Tracked".
//
// "Tracked" rather than "Indirect" deliberately — `indirect` is the server's
// discriminator, not a word to show anyone.
export const GOAL_TYPE_OPTIONS: {
  key: GoalTemplateKey;
  icon: IconName;
  label: string;
  description: string;
  example: string;
}[] = [
  {
    key: 'savings',
    icon: 'wallet',
    label: 'Savings',
    description: 'Save toward a dollar amount',
    example: 'e.g. "Emergency fund" — save $1,000',
  },
  {
    key: 'habit',
    icon: 'flame',
    label: 'Habit',
    description: 'Build a habit, keep a streak',
    example: 'e.g. "Meditate every day"',
  },
  {
    key: 'indirect',
    icon: 'dumbbell',
    label: 'Tracked',
    description: 'Track a number over time',
    example: 'e.g. "Weight" — track lbs, no target needed',
  },
  {
    key: 'milestone',
    icon: 'briefcase',
    label: 'Milestone',
    description: 'A big goal, done in stages',
    example: 'e.g. "Land a new job"',
  },
];
