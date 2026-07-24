import { describe, expect, it } from 'vitest';

import { assembleAchievements } from './overview.ts';
import type { AchievementCounts } from '../achievements/evaluate.ts';

const D = new Date('2026-07-20T00:00:00Z');

function counts(partial: Partial<AchievementCounts>): AchievementCounts {
  return { tasks_completed: 0, streak: 0, goals_started: 0, goals_finished: 0, active_days: 0, ...partial };
}

describe('assembleAchievements', () => {
  it('reports no earned tier and a first teaser when nothing is earned', () => {
    const tasks = assembleAchievements(counts({}), []).find((a) => a.key === 'tasks_completed')!;
    expect(tasks).toMatchObject({
      key: 'tasks_completed',
      count: 0,
      earnedTier: null,
      earnedLabel: null,
      earnedAt: null,
      nextThreshold: 1,
      nextLabel: 'First step',
      progressToNext: 0,
    });
  });

  it('surfaces the highest earned tier and its earnedAt', () => {
    const rows = [
      { key: 'tasks_completed', tier: 1, earnedAt: D },
      { key: 'tasks_completed', tier: 10, earnedAt: D },
    ];
    const tasks = assembleAchievements(counts({ tasks_completed: 12 }), rows).find((a) => a.key === 'tasks_completed')!;
    expect(tasks.earnedTier).toBe(10);
    expect(tasks.earnedLabel).toBe('Getting going');
    expect(tasks.earnedAt).toBe(D.toISOString());
    expect(tasks.nextThreshold).toBe(50);
  });

  it('fills the progress bar across the current tier band, not from zero', () => {
    // 30 tasks: earned tier 10, next tier 50 → (30-10)/(50-10) = 0.5
    const rows = [{ key: 'tasks_completed', tier: 10, earnedAt: D }];
    const tasks = assembleAchievements(counts({ tasks_completed: 30 }), rows).find((a) => a.key === 'tasks_completed')!;
    expect(tasks.progressToNext).toBeCloseTo(0.5, 5);
  });

  it('nulls the teaser + progress once every tier is earned', () => {
    const rows = [{ key: 'goals_finished', tier: 1, earnedAt: D }, { key: 'goals_finished', tier: 3, earnedAt: D }];
    const finished = assembleAchievements(counts({ goals_finished: 4 }), rows).find(
      (a) => a.key === 'goals_finished',
    )!;
    expect(finished.earnedTier).toBe(3);
    expect(finished.nextThreshold).toBeNull();
    expect(finished.progressToNext).toBeNull();
  });

  it('returns one view per catalog family', () => {
    const views = assembleAchievements(counts({}), []);
    expect(views.map((v) => v.key).sort()).toEqual(
      ['active_days', 'goals_finished', 'goals_started', 'streak', 'tasks_completed'],
    );
  });
});
