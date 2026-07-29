import { describe, expect, it } from 'vitest';

import { progressBucket, streakMilestone } from './reactions.ts';

describe('progressBucket', () => {
  it('returns null below the first milestone', () => {
    expect(progressBucket(0)).toBeNull();
    expect(progressBucket(0.24)).toBeNull();
  });

  it('returns the single highest bucket reached, never a lower one', () => {
    expect(progressBucket(0.25)).toBe(25);
    expect(progressBucket(0.49)).toBe(25);
    expect(progressBucket(0.5)).toBe(50);
    // a big jump lands on the highest crossed bucket, not an intermediate one —
    // paired with per-bucket dedupe this is what prevents a stale lower reaction
    expect(progressBucket(0.6)).toBe(50);
    expect(progressBucket(0.75)).toBe(75);
    expect(progressBucket(1)).toBe(100);
  });

  it('clamps a slightly-over value to the 100 bucket', () => {
    expect(progressBucket(1.01)).toBe(100);
  });
});

describe('streakMilestone', () => {
  it('returns null below the first milestone', () => {
    expect(streakMilestone(0)).toBeNull();
    expect(streakMilestone(2)).toBeNull();
  });

  it('returns the highest streak milestone reached', () => {
    expect(streakMilestone(3)).toBe(3);
    expect(streakMilestone(6)).toBe(3);
    expect(streakMilestone(7)).toBe(7);
    expect(streakMilestone(14)).toBe(14);
    expect(streakMilestone(29)).toBe(14);
    expect(streakMilestone(30)).toBe(30);
    expect(streakMilestone(100)).toBe(30);
  });
});
