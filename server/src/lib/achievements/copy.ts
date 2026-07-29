import type { NewlyEarned } from './evaluate.ts';

// Server-templated congrats copy — deterministic, NEVER a model call. Grounded
// in the real threshold just crossed and the family's own (SQL-derived) title,
// so it structurally cannot fabricate a number (docs/chat-architecture.md: "a
// guarantee lives in code"). Tone follows the retention research + CLAUDE.md §2:
// celebrate the USER's own consistency, never a bond with Meroa, no guilt/FOMO.
export function congratsLine(earned: NewlyEarned): string {
  const { family, tier } = earned;
  const label = family.tiers.find((t) => t.threshold === tier)?.label ?? 'a milestone';
  const k = family.key;

  // Dynamic per-goal families — family.title carries the real goal name.
  if (k.startsWith('goal_streak:'))
    return `${tier}-day ${family.title} — "${label}". That consistency is all you. 🔥`;
  if (k.startsWith('goal_progress:'))
    return tier >= 100
      ? `${family.title} — you reached it. 💯 That's the whole goal.`
      : `${family.title} is ${tier}% of the way — "${label}". Real momentum. 💪`;
  if (k.startsWith('goal_tenure:'))
    return `${family.title} ${tier} month${tier === 1 ? '' : 's'} now — "${label}". That's staying power. 🌱`;
  if (family.category === 'consistency')
    return `${tier} perfect days — "${label}". Finishing everything due is the hard part, and you did. ✨`;

  // Static global families.
  switch (k) {
    case 'tasks_completed':
      return `That's ${tier} task${tier === 1 ? '' : 's'} done — the "${label}" badge. You've been showing up. 🏅`;
    case 'streak':
      return `${tier}-day streak — that's "${label}". That consistency is all you. 🔥`;
    case 'goals_started':
      return tier === 1
        ? `First goal on the board — "${label}". Nice. ✨`
        : `${tier} goals going at once — "${label}". ✨`;
    case 'goals_finished':
      return tier === 1
        ? `You finished a goal — "${label}". That's the whole point. 👑`
        : `${tier} goals finished — "${label}". You keep closing them out. 👑`;
    case 'active_days':
      return `${tier} active days — that's "${label}". Showing up is the hard part, and you did. 📅`;
    default:
      return `"${label}" — nice work. 🏅`;
  }
}
