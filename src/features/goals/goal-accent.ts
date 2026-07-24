import type { GoalTemplateKey } from '@/lib/api/types';

// Per-type goal colors — distinct from tasks (blue) and from each other:
// savings green (money), habit orange (the flame/streak), indirect teal (a
// tracked metric), milestone purple (staged progress). Shared so GoalCard and
// the goal detail screen tint with the same color.
export const GOAL_TYPE_ACCENT: Record<GoalTemplateKey, string> = {
  savings: '#30D158',
  habit: '#FF9F0A',
  indirect: '#34C6C6',
  milestone: '#BF5AF2',
};

export function goalAccent(type: GoalTemplateKey): string {
  return GOAL_TYPE_ACCENT[type] ?? '#0A84FF';
}
