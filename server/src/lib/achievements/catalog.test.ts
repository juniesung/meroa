import { describe, expect, it } from 'vitest';

import { earnedThresholds, nextTier, tierFor } from './catalog.ts';

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
