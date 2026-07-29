// The achievement catalog. The single place that defines what's earnable, its
// tiers, and its copy. The `achievements` row stores only key+tier, so labels/
// icons/tiers can change without a migration.
//
// Two shapes of family now coexist:
//   - STATIC globals (below), keyed by AchievementKey — account-wide counts.
//   - DYNAMIC per-goal / consistency families, INSTANTIATED per user by
//     lib/achievements/user-catalog.ts (goal name woven into the title, goal id
//     in the key). This is how achievements feel "custom" without an LLM ever
//     inventing one: the definitions are code, the numbers are SQL, only the
//     instantiation is per-user.
//
// Design is deliberate (CLAUDE.md §2 + retention research): every tier marks an
// EARNED TRANSITION from real recorded activity — no badge for merely opening
// the app. Tiers escalate in difficulty (retention rises with difficulty), and
// every family maps to a count computed in SQL, never a fabricated number.

// The static, account-wide families. Per-goal/consistency keys are dynamic
// strings (see user-catalog.ts) and deliberately NOT in this union.
export type AchievementKey =
  | 'tasks_completed'
  | 'streak'
  | 'goals_started'
  | 'goals_finished'
  | 'active_days';

export type AchievementCategory = 'global' | 'goal' | 'consistency' | 'record';

export type AchievementTier = {
  // The threshold that earns this tier — the same integer stored in
  // achievements.tier, and the value a count is compared against.
  threshold: number;
  label: string;
  // Icon name from the client's stroke-SVG set. Kept per-tier for back-compat;
  // display uses the family-level `icon` (all tiers in a family share it).
  icon: string;
};

export type AchievementFamily = {
  // AchievementKey for globals; a namespaced string for dynamic families
  // (`goal_streak:<id>`, `goal_progress:<id>`, `goal_tenure:<id>`,
  // `consistency:perfect_days`).
  key: string;
  // Display title — for a dynamic family the goal name is woven in
  // ("Meditation streak"). Shown on the badge / teaser.
  title: string;
  // What the family measures ("day streak", "% funded") — the badge sub-line.
  unit: string;
  // Family-level icon (server sends this to the client so per-goal families
  // render without a client-side key→icon map).
  icon: string;
  category: AchievementCategory;
  tiers: AchievementTier[]; // ascending threshold
};

// Tiers are layered on purpose (research: retention rises with achievement
// difficulty, so pair an accessible early tier with progressively harder ones).
// More tiers per family also means there's almost always a *close* next target
// — the goal-gradient pull that drives the "In progress" section.
export const ACHIEVEMENT_CATALOG: AchievementFamily[] = [
  {
    key: 'tasks_completed',
    title: 'Tasks completed',
    unit: 'tasks completed',
    icon: 'check',
    category: 'global',
    tiers: [
      { threshold: 1, label: 'First step', icon: 'check' },
      { threshold: 5, label: 'Warming up', icon: 'check' },
      { threshold: 10, label: 'Getting going', icon: 'check' },
      { threshold: 25, label: 'Rolling', icon: 'check' },
      { threshold: 50, label: 'Committed', icon: 'check' },
      { threshold: 100, label: 'Centurion', icon: 'check' },
      { threshold: 250, label: 'Unstoppable', icon: 'check' },
      { threshold: 500, label: 'Machine', icon: 'check' },
    ],
  },
  {
    key: 'streak',
    title: 'Daily streak',
    unit: 'day streak',
    icon: 'flame',
    category: 'global',
    tiers: [
      { threshold: 3, label: 'Three in a row', icon: 'flame' },
      { threshold: 7, label: 'Week one', icon: 'flame' },
      { threshold: 14, label: 'Two weeks', icon: 'flame' },
      { threshold: 30, label: 'Month strong', icon: 'flame' },
      { threshold: 60, label: 'Two months', icon: 'flame' },
      { threshold: 100, label: 'Century', icon: 'flame' },
      { threshold: 180, label: 'Half a year', icon: 'flame' },
      { threshold: 365, label: 'A full year', icon: 'flame' },
    ],
  },
  {
    key: 'goals_started',
    title: 'Goals started',
    unit: 'goals started',
    icon: 'sparkle',
    category: 'global',
    tiers: [
      { threshold: 1, label: 'First goal', icon: 'sparkle' },
      { threshold: 3, label: 'Three going', icon: 'sparkle' },
      { threshold: 5, label: 'Ambitious', icon: 'sparkle' },
      { threshold: 10, label: 'Big plans', icon: 'sparkle' },
    ],
  },
  {
    key: 'goals_finished',
    title: 'Goals finished',
    unit: 'goals finished',
    icon: 'crown',
    category: 'global',
    tiers: [
      { threshold: 1, label: 'Finisher', icon: 'crown' },
      { threshold: 3, label: 'Serial finisher', icon: 'crown' },
      { threshold: 5, label: 'Closer', icon: 'crown' },
      { threshold: 10, label: 'Relentless', icon: 'crown' },
    ],
  },
  {
    key: 'active_days',
    title: 'Active days',
    unit: 'active days',
    icon: 'clock',
    category: 'global',
    tiers: [
      { threshold: 3, label: 'Getting the habit', icon: 'clock' },
      { threshold: 7, label: 'Showing up', icon: 'clock' },
      { threshold: 30, label: 'Regular', icon: 'clock' },
      { threshold: 60, label: 'Fixture', icon: 'clock' },
      { threshold: 100, label: 'Ever-present', icon: 'clock' },
      { threshold: 365, label: 'Year-rounder', icon: 'clock' },
    ],
  },
];

const BY_KEY = new Map<AchievementKey, AchievementFamily>(
  ACHIEVEMENT_CATALOG.map((f) => [f.key as AchievementKey, f]),
);

export function familyFor(key: AchievementKey): AchievementFamily {
  const f = BY_KEY.get(key);
  if (!f) throw new Error(`unknown achievement key: ${key}`);
  return f;
}

export function tierFor(key: AchievementKey, threshold: number): AchievementTier | undefined {
  return familyFor(key).tiers.find((t) => t.threshold === threshold);
}

// --- pure tier logic, family-based (works for globals AND dynamic families) --

/** Every tier threshold this count has reached, ascending. */
export function earnedTiersOf(family: AchievementFamily, count: number): number[] {
  return family.tiers.filter((t) => count >= t.threshold).map((t) => t.threshold);
}

/** The next unearned tier for this count, or null once every tier is earned. */
export function nextTierOf(family: AchievementFamily, count: number): AchievementTier | null {
  return family.tiers.find((t) => count < t.threshold) ?? null;
}

// Key-based wrappers over the global families — kept so catalog.test.ts and the
// profile read keep their existing call shape. Both delegate to the family-based
// core above, so the "earned?" line is defined in exactly one place.
export function earnedThresholds(key: AchievementKey, count: number): number[] {
  return earnedTiersOf(familyFor(key), count);
}
export function nextTier(key: AchievementKey, count: number): AchievementTier | null {
  return nextTierOf(familyFor(key), count);
}

// --- dynamic (per-user) family builders -----------------------------------
// Instantiated by user-catalog.ts. Keys are namespaced and stable so an earned
// row survives even after the goal is deleted (append-only: you earned it).

const tier = (threshold: number, label: string, icon: string): AchievementTier => ({ threshold, label, icon });

/** A habit goal's own streak (earned off its longest run, like the global one). */
export function goalStreakFamily(goalId: string, goalName: string, icon: string): AchievementFamily {
  return {
    key: `goal_streak:${goalId}`,
    title: `${goalName} streak`,
    unit: 'day streak',
    icon,
    category: 'goal',
    tiers: [
      tier(7, 'A week of it', icon),
      tier(30, 'A month of it', icon),
      tier(100, '100 days', icon),
      tier(365, 'A full year', icon),
    ],
  };
}

/** A savings / measured goal's progress toward its target, in percent. */
export function goalProgressFamily(goalId: string, goalName: string, icon: string): AchievementFamily {
  return {
    key: `goal_progress:${goalId}`,
    title: goalName,
    unit: '% there',
    icon,
    category: 'goal',
    tiers: [
      tier(25, 'A quarter of the way', icon),
      tier(50, 'Halfway', icon),
      tier(75, 'Three quarters', icon),
      tier(100, 'Reached it', icon),
    ],
  };
}

/** How long the user has kept a goal going (months since it was created). */
export function goalTenureFamily(goalId: string, goalName: string, icon: string): AchievementFamily {
  return {
    key: `goal_tenure:${goalId}`,
    title: `Kept ${goalName} going`,
    unit: 'months',
    icon,
    category: 'goal',
    tiers: [
      tier(1, 'One month in', icon),
      tier(3, 'Three months', icon),
      tier(6, 'Half a year', icon),
      tier(12, 'A whole year', icon),
    ],
  };
}

/** Account-wide "perfect days" — days every due task got done. */
export const consistencyFamily: AchievementFamily = {
  key: 'consistency:perfect_days',
  title: 'Perfect days',
  unit: 'days you finished everything due',
  icon: 'sparkle',
  category: 'consistency',
  tiers: [
    tier(3, 'Three perfect days', 'sparkle'),
    tier(10, 'Ten perfect days', 'sparkle'),
    tier(30, 'Thirty perfect days', 'sparkle'),
    tier(100, 'A hundred perfect days', 'sparkle'),
  ],
};
