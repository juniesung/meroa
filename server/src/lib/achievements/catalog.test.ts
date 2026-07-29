import { describe, expect, it } from 'vitest';

import {
  earnedThresholds,
  earnedTiersOf,
  goalProgressFamily,
  goalStreakFamily,
  goalTenureFamily,
  nextTier,
  nextTierOf,
  tierFor,
} from './catalog.ts';

describe('earnedThresholds', () => {
  it('earns every tier at or below the count', () => {
    expect(earnedThresholds('tasks_completed', 0)).toEqual([]);
    expect(earnedThresholds('tasks_completed', 1)).toEqual([1]);
    expect(earnedThresholds('tasks_completed', 49)).toEqual([1, 5, 10, 25]);
    expect(earnedThresholds('tasks_completed', 50)).toEqual([1, 5, 10, 25, 50]);
    expect(earnedThresholds('tasks_completed', 999)).toEqual([1, 5, 10, 25, 50, 100, 250, 500]);
  });

  it('crossing a threshold earns exactly the newly-reached tier', () => {
    const before = earnedThresholds('tasks_completed', 49);
    const after = earnedThresholds('tasks_completed', 50);
    const newlyEarned = after.filter((t) => !before.includes(t));
    expect(newlyEarned).toEqual([50]);
  });

  it('streak earns off day thresholds', () => {
    expect(earnedThresholds('streak', 2)).toEqual([]);
    expect(earnedThresholds('streak', 3)).toEqual([3]);
    expect(earnedThresholds('streak', 7)).toEqual([3, 7]);
    expect(earnedThresholds('streak', 100)).toEqual([3, 7, 14, 30, 60, 100]);
  });
});

describe('nextTier', () => {
  it('points at the first unearned tier', () => {
    expect(nextTier('tasks_completed', 0)?.threshold).toBe(1);
    expect(nextTier('tasks_completed', 1)?.threshold).toBe(5);
    expect(nextTier('tasks_completed', 50)?.threshold).toBe(100);
  });

  it('returns null once every tier is earned', () => {
    expect(nextTier('tasks_completed', 500)).toBeNull();
    expect(nextTier('goals_finished', 10)).toBeNull();
  });
});

describe('tierFor', () => {
  it('resolves label + icon for a real (key, threshold)', () => {
    expect(tierFor('tasks_completed', 50)).toMatchObject({ label: 'Committed', icon: 'check' });
    expect(tierFor('streak', 100)?.label).toBe('Century');
  });

  it('is undefined for a threshold that is not a real tier', () => {
    expect(tierFor('tasks_completed', 42)).toBeUndefined();
  });
});

describe('dynamic per-goal families', () => {
  it('instantiate namespaced keys with the goal name woven into the title', () => {
    const g = 'a1b2';
    expect(goalStreakFamily(g, 'Meditation', 'flame')).toMatchObject({
      key: 'goal_streak:a1b2',
      title: 'Meditation streak',
      category: 'goal',
      icon: 'flame',
    });
    expect(goalProgressFamily(g, 'Trip to Japan', 'wallet').key).toBe('goal_progress:a1b2');
    expect(goalProgressFamily(g, 'Trip to Japan', 'wallet').title).toBe('Trip to Japan');
    expect(goalTenureFamily(g, 'Reading', 'book').title).toBe('Kept Reading going');
  });

  it('tier math works family-based, same as the global helpers', () => {
    const fam = goalProgressFamily('x', 'Bike', 'wallet'); // tiers 25/50/75/100
    expect(earnedTiersOf(fam, 24)).toEqual([]);
    expect(earnedTiersOf(fam, 40)).toEqual([25]);
    expect(earnedTiersOf(fam, 100)).toEqual([25, 50, 75, 100]);
    expect(nextTierOf(fam, 40)?.threshold).toBe(50);
    expect(nextTierOf(fam, 100)).toBeNull();
  });
});
