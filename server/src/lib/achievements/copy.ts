import { type AchievementKey, tierFor } from './catalog.ts';

// Server-templated congrats copy — deterministic, NEVER a model call. Grounded
// in the real threshold that was just crossed, so it structurally cannot
// fabricate a number (docs/chat-architecture.md: "a guarantee lives in code").
// Tone follows the retention research + CLAUDE.md §2: celebrate the USER's own
// consistency, never a bond with Meroa, no guilt/FOMO. Short by design.

export function congratsLine(key: AchievementKey, tier: number): string {
  const t = tierFor(key, tier);
  const label = t?.label ?? 'a milestone';

  switch (key) {
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
  }
}
