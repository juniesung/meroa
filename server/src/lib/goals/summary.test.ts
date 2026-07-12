import { describe, expect, it } from 'vitest';

import { computeHabitCardSummary } from './summary.ts';

// Pure card copy for habit goals — the streak IS the headline, and there is
// never a progress fraction or pace to fake (docs/goals-redesign-plan.md §1).

describe('computeHabitCardSummary', () => {
  it('brand-new habit: no streak, invites the first check-in', () => {
    const card = computeHabitCardSummary({ current: 0, longest: 0, doneCount: 0 });
    expect(card.headline).toBe('No streak yet');
    expect(card.sub).toBe('First check-in starts it');
    expect(card.progress).toBeNull();
    expect(card.paceLine).toBeNull();
    expect(card.streak).toEqual({ current: 0, longest: 0, doneCount: 0 });
  });

  it('live streak: current run in the headline, longest + count in the sub', () => {
    const card = computeHabitCardSummary({ current: 4, longest: 9, doneCount: 21 });
    expect(card.headline).toBe('4-day streak');
    expect(card.sub).toBe('longest 9 · 21 check-ins');
  });

  it('broken streak: reset is real (headline drops) but longest is kept and shown', () => {
    const card = computeHabitCardSummary({ current: 0, longest: 6, doneCount: 12 });
    expect(card.headline).toBe('No streak yet');
    expect(card.sub).toBe('longest 6 · 12 check-ins');
  });

  it('singular check-in reads naturally', () => {
    const card = computeHabitCardSummary({ current: 1, longest: 1, doneCount: 1 });
    expect(card.headline).toBe('1-day streak');
    expect(card.sub).toBe('longest 1 · 1 check-in');
  });
});
