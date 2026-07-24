// The achievement catalog — pure data, no I/O. The single place that defines
// which badges exist, their tiers, and their copy. Kept out of the DB (the
// `achievements` row stores only key+tier) so labels/icons can change without
// a migration, and so evaluate.ts and the /profile/overview read share one
// definition of "what's earnable."
//
// Design is deliberately narrow (CLAUDE.md §2 + the retention research): every
// tier marks an EARNED TRANSITION from real recorded activity — there is no
// badge for merely opening the app or showing up, because participation badges
// test as hollow. Tiers escalate in difficulty (research: retention rises with
// achievement difficulty), and every family maps to a count computed in SQL
// from real records, never a fabricated number.

export type AchievementKey =
  | 'tasks_completed'
  | 'streak'
  | 'goals_started'
  | 'goals_finished'
  | 'active_days';

export type AchievementTier = {
  // The threshold that earns this tier — the same integer stored in
  // achievements.tier. Also the value a count is compared against.
  threshold: number;
  // Shown on the badge itself.
  label: string;
  // Icon name from the client's stroke-SVG set (components/Icon.tsx). Chosen
  // per family; the tier doesn't change the icon, only brightness/earned state.
  icon: string;
};

export type AchievementFamily = {
  key: AchievementKey;
  // What the family measures, shown as the badge's sub-line / the locked
  // teaser's goal ("Complete 50 tasks").
  unit: string;
  tiers: AchievementTier[];
};

// Icons reuse the existing set (components/Icon.tsx): check, flame, sparkle,
// crown are all already drawn there.
export const ACHIEVEMENT_CATALOG: AchievementFamily[] = [
  {
    key: 'tasks_completed',
    unit: 'tasks completed',
    tiers: [
      { threshold: 1, label: 'First step', icon: 'check' },
      { threshold: 10, label: 'Getting going', icon: 'check' },
      { threshold: 50, label: 'Committed', icon: 'check' },
      { threshold: 250, label: 'Unstoppable', icon: 'check' },
    ],
  },
  {
    key: 'streak',
    unit: 'day streak',
    tiers: [
      { threshold: 7, label: 'Week one', icon: 'flame' },
      { threshold: 30, label: 'Month strong', icon: 'flame' },
      { threshold: 100, label: 'Century', icon: 'flame' },
    ],
  },
  {
    key: 'goals_started',
    unit: 'goals started',
    tiers: [
      { threshold: 1, label: 'First goal', icon: 'sparkle' },
      { threshold: 3, label: 'Three going', icon: 'sparkle' },
    ],
  },
  {
    key: 'goals_finished',
    unit: 'goals finished',
    tiers: [
      { threshold: 1, label: 'Finisher', icon: 'crown' },
      { threshold: 3, label: 'Serial finisher', icon: 'crown' },
    ],
  },
  {
    key: 'active_days',
    unit: 'active days',
    tiers: [
      { threshold: 7, label: 'Showing up', icon: 'clock' },
      { threshold: 30, label: 'Regular', icon: 'clock' },
      { threshold: 100, label: 'Ever-present', icon: 'clock' },
    ],
  },
];

const BY_KEY = new Map<AchievementKey, AchievementFamily>(
  ACHIEVEMENT_CATALOG.map((f) => [f.key, f]),
);

export function familyFor(key: AchievementKey): AchievementFamily {
  const f = BY_KEY.get(key);
  if (!f) throw new Error(`unknown achievement key: ${key}`);
  return f;
}

export function tierFor(key: AchievementKey, threshold: number): AchievementTier | undefined {
  return familyFor(key).tiers.find((t) => t.threshold === threshold);
}

/**
 * Pure: given a family and the user's current real count, return every tier
 * threshold that count has reached. The one place "earned?" is decided — both
 * the evaluator (what to insert) and any display code share it, so they can
 * never disagree about where the line is.
 */
export function earnedThresholds(key: AchievementKey, count: number): number[] {
  return familyFor(key)
    .tiers.filter((t) => count >= t.threshold)
    .map((t) => t.threshold);
}

/**
 * Pure: the next unearned tier for a family given the current count, or null if
 * every tier is earned. Drives the locked/teaser badge + its progress bar.
 */
export function nextTier(key: AchievementKey, count: number): AchievementTier | null {
  return familyFor(key).tiers.find((t) => count < t.threshold) ?? null;
}
