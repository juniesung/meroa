import { describe, expect, it } from 'vitest';

import { checkStarterPace, countOccurrences } from './starter-pace.ts';

describe('countOccurrences', () => {
  it('daily recurrence counts every day inclusive', () => {
    expect(countOccurrences({ freq: 'daily' }, '2026-07-12', '2026-07-19', 'UTC')).toBe(8);
  });

  it('every_n_days counts from the anchor (today)', () => {
    // today, +2, +4, +6 => 4 occurrences in a 7-day window
    expect(countOccurrences({ freq: 'every_n_days', n: 2 }, '2026-07-12', '2026-07-18', 'UTC')).toBe(4);
  });

  it('weekly counts only matching weekdays', () => {
    // 2026-07-12 is a Sunday; one week window, weekdays mo+we
    expect(
      countOccurrences({ freq: 'weekly', byWeekday: ['mo', 'we'] }, '2026-07-12', '2026-07-18', 'UTC'),
    ).toBe(2);
  });

  it('zero when the range is inverted', () => {
    expect(countOccurrences({ freq: 'daily' }, '2026-07-19', '2026-07-12', 'UTC')).toBe(0);
  });
});

// The small-nits ledger's named example: a $5/day starter against a
// $1000/7-day goal can't possibly reach the target.
describe('checkStarterPace', () => {
  it('flags a real shortfall — $5/day for 7 days only reaches $35 of $1000', () => {
    const result = checkStarterPace(
      1000,
      '2026-07-19',
      [{ title: 'Save $5', recurrence: { freq: 'daily' }, contribution: 5 }],
      '2026-07-12',
      'UTC',
    );
    expect(result).not.toBeNull();
    expect(result!.projectedTotal).toBe(40); // 8 days inclusive * $5
    expect(result!.shortfall).toBe(960);
  });

  it('returns null when the pace comfortably covers the target', () => {
    const result = checkStarterPace(
      50,
      '2026-07-19',
      [{ title: 'Save $10', recurrence: { freq: 'daily' }, contribution: 10 }],
      '2026-07-12',
      'UTC',
    );
    expect(result).toBeNull();
  });

  it('returns null with no contributing starters (supporting task with no contribution)', () => {
    const result = checkStarterPace(1000, '2026-07-19', [{ title: 'Track spending' }], '2026-07-12', 'UTC');
    expect(result).toBeNull();
  });

  it('sums multiple starter tasks toward the same target', () => {
    const result = checkStarterPace(
      1000,
      '2026-07-19',
      [
        { title: 'Save $5', recurrence: { freq: 'daily' }, contribution: 5 },
        { title: 'Save $50 weekly', recurrence: { freq: 'weekly', byWeekday: ['su'] }, contribution: 50 },
      ],
      '2026-07-12',
      'UTC',
    );
    // 8 daily occurrences ($40) + 2 Sundays in range ($100) = $140, still short of $1000
    expect(result).not.toBeNull();
    expect(result!.projectedTotal).toBe(140);
  });

  it('returns null exactly on pace (shortfall of zero is not a shortfall)', () => {
    const result = checkStarterPace(
      40,
      '2026-07-19',
      [{ title: 'Save $5', recurrence: { freq: 'daily' }, contribution: 5 }],
      '2026-07-12',
      'UTC',
    );
    expect(result).toBeNull();
  });
});
