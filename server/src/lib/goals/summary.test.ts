import { describe, expect, it } from 'vitest';

import {
  computeHabitCardSummary,
  computeIndirectCardSummary,
  computeIndirectPace,
  computeIndirectProgress,
} from './summary.ts';
import type { IndirectGoalDefinition } from './schema.ts';

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

// Indirect progress/pace must work whether the target is above the start
// (a rising metric, e.g. a bench PR) or below it (a falling one, e.g.
// weight loss) — computePace above assumes savings' always-rising total,
// so this is a distinct, direction-aware implementation.
describe('computeIndirectProgress', () => {
  it('rising toward a target (e.g. bench press)', () => {
    expect(computeIndirectProgress(165, 165, 225)).toEqual({ fraction: 0, reached: false });
    expect(computeIndirectProgress(165, 195, 225)).toEqual({ fraction: 0.5, reached: false });
    expect(computeIndirectProgress(165, 225, 225)).toEqual({ fraction: 1, reached: true });
    expect(computeIndirectProgress(165, 250, 225)).toEqual({ fraction: 1, reached: true }); // overshoot clamps at 1
  });

  it('falling toward a target (e.g. weight loss)', () => {
    expect(computeIndirectProgress(180, 180, 165)).toEqual({ fraction: 0, reached: false });
    expect(computeIndirectProgress(180, 172.5, 165)).toEqual({ fraction: 0.5, reached: false });
    expect(computeIndirectProgress(180, 165, 165)).toEqual({ fraction: 1, reached: true });
    expect(computeIndirectProgress(180, 160, 165)).toEqual({ fraction: 1, reached: true }); // past it clamps at 1
  });

  it('target equals start — already there', () => {
    expect(computeIndirectProgress(165, 165, 165)).toEqual({ fraction: 1, reached: true });
    expect(computeIndirectProgress(165, 170, 165)).toEqual({ fraction: 0, reached: false });
  });
});

describe('computeIndirectPace', () => {
  it('rising: needs N/day to hit the deadline', () => {
    const pace = computeIndirectPace(165, 195, 225, '2026-07-22', 'UTC', new Date('2026-07-12T00:00:00Z'));
    expect(pace).not.toBeNull();
    expect(pace!.reached).toBe(false);
    expect(pace!.remaining).toBe(30);
    expect(pace!.daysLeft).toBe(10);
    expect(pace!.perDay).toBe(3);
  });

  it('falling: needs N/day to hit the deadline', () => {
    const pace = computeIndirectPace(180, 172, 165, '2026-07-22', 'UTC', new Date('2026-07-12T00:00:00Z'));
    expect(pace).not.toBeNull();
    expect(pace!.remaining).toBe(7);
    expect(pace!.perDay).toBe(0.7);
  });

  it('null without a deadline', () => {
    expect(computeIndirectPace(165, 195, 225, undefined, 'UTC', new Date())).toBeNull();
  });

  it('overdue once the deadline has passed and the target is unmet', () => {
    const pace = computeIndirectPace(165, 195, 225, '2026-07-01', 'UTC', new Date('2026-07-12T00:00:00Z'));
    expect(pace!.overdue).toBe(true);
    expect(pace!.reached).toBe(false);
  });
});

describe('computeIndirectCardSummary', () => {
  const def: IndirectGoalDefinition = { type: 'indirect', unit: 'lb' };
  const now = new Date('2026-07-12T00:00:00Z');

  it('no entries yet', () => {
    const card = computeIndirectCardSummary(def, [], 'UTC', now);
    expect(card.headline).toBe('No lb logged yet');
    expect(card.progress).toBeNull();
    expect(card.paceLine).toBeNull();
  });

  it('first entry — headline is the value, sub says "First log"', () => {
    const entries = [{ entryAt: new Date('2026-07-10T00:00:00Z'), data: { amount: 175 } }];
    const card = computeIndirectCardSummary(def, entries, 'UTC', now);
    expect(card.headline).toBe('175lb');
    expect(card.sub).toBe('First log');
    expect(card.progress).toBeNull(); // no target set
  });

  it('delta vs the previous entry, direction-aware wording', () => {
    const entries = [
      { entryAt: new Date('2026-07-10T00:00:00Z'), data: { amount: 175 } },
      { entryAt: new Date('2026-07-12T00:00:00Z'), data: { amount: 174 } },
    ];
    const card = computeIndirectCardSummary(def, entries, 'UTC', now);
    expect(card.headline).toBe('174lb');
    expect(card.sub).toBe('down 1lb since last log');
  });

  it('unchanged since last log', () => {
    const entries = [
      { entryAt: new Date('2026-07-10T00:00:00Z'), data: { amount: 175 } },
      { entryAt: new Date('2026-07-12T00:00:00Z'), data: { amount: 175 } },
    ];
    const card = computeIndirectCardSummary(def, entries, 'UTC', now);
    expect(card.sub).toBe('unchanged since last log');
  });

  it('progress + pace line once a target and deadline exist', () => {
    const withTarget: IndirectGoalDefinition = { type: 'indirect', unit: 'lb', targetValue: 165, deadline: '2026-07-22' };
    const entries = [
      { entryAt: new Date('2026-07-01T00:00:00Z'), data: { amount: 180 } },
      { entryAt: new Date('2026-07-12T00:00:00Z'), data: { amount: 172 } },
    ];
    const card = computeIndirectCardSummary(withTarget, entries, 'UTC', now);
    expect(card.progress).toBeCloseTo(8 / 15);
    expect(card.paceLine).toContain('lb/day to hit');
  });

  it('never derives from tasks — only ever reads the entries it was given', () => {
    // A pure function by construction: no task/db access is even possible
    // here, but pin the contract explicitly (locked decision, §1.3).
    const def2: IndirectGoalDefinition = { type: 'indirect', unit: 'lb', targetValue: 165 };
    const entries = [{ entryAt: new Date('2026-07-12T00:00:00Z'), data: { amount: 165 } }];
    const card = computeIndirectCardSummary(def2, entries, 'UTC', now);
    expect(card.paceLine).toBe('Target reached');
    expect(card.progress).toBe(1);
  });
});
