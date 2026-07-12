import { describe, expect, it } from 'vitest';

import {
  bucketTasksByDay,
  buildCalendar,
  computeCurrentStreak,
  computeLongestStreak,
  type TaskDueRow,
} from './consistency.ts';

function row(dueYmd: string, status: 'open' | 'done'): TaskDueRow {
  return { dueYmd, status };
}

describe('bucketTasksByDay', () => {
  it('marks a day perfect when every due task is done', () => {
    const buckets = bucketTasksByDay([row('2026-07-10', 'done'), row('2026-07-10', 'done')]);
    expect(buckets.get('2026-07-10')).toMatchObject({ dueCount: 2, doneCount: 2, verdict: 'perfect', level: 3 });
  });

  it('marks a day missed when any due task is open', () => {
    const buckets = bucketTasksByDay([row('2026-07-10', 'done'), row('2026-07-10', 'open')]);
    expect(buckets.get('2026-07-10')).toMatchObject({ dueCount: 2, doneCount: 1, verdict: 'missed', level: 2 });
  });

  it('a day with nothing due at all never appears in the bucket map (neutral by omission)', () => {
    const buckets = bucketTasksByDay([row('2026-07-10', 'done')]);
    expect(buckets.has('2026-07-11')).toBe(false);
  });

  it('level scales with completion ratio: 0 when nothing done, 1 partial, 2 mostly, 3 perfect', () => {
    expect(bucketTasksByDay([row('d', 'open'), row('d', 'open')]).get('d')?.level).toBe(0);
    expect(bucketTasksByDay([row('d', 'done'), row('d', 'open'), row('d', 'open')]).get('d')?.level).toBe(1);
    expect(bucketTasksByDay([row('d', 'done'), row('d', 'done'), row('d', 'open')]).get('d')?.level).toBe(2);
    expect(bucketTasksByDay([row('d', 'done'), row('d', 'done')]).get('d')?.level).toBe(3);
  });
});

describe('computeCurrentStreak', () => {
  it('counts consecutive perfect days ending today when today is already perfect', () => {
    const buckets = bucketTasksByDay([
      row('2026-07-08', 'done'),
      row('2026-07-09', 'done'),
      row('2026-07-10', 'done'),
    ]);
    expect(computeCurrentStreak(buckets, '2026-07-10')).toBe(3);
  });

  it("today doesn't break the streak until it ends — an in-progress (missed-so-far) today falls back to counting from yesterday", () => {
    const buckets = bucketTasksByDay([
      row('2026-07-08', 'done'),
      row('2026-07-09', 'done'),
      row('2026-07-10', 'open'), // today, not done yet — day isn't over
    ]);
    expect(computeCurrentStreak(buckets, '2026-07-10')).toBe(2);
  });

  it('neutral days (nothing due) are skipped — they neither break nor extend the streak', () => {
    const buckets = bucketTasksByDay([
      row('2026-07-08', 'done'),
      // 2026-07-09 has nothing due at all — neutral, skipped
      row('2026-07-10', 'done'),
    ]);
    expect(computeCurrentStreak(buckets, '2026-07-10')).toBe(2);
  });

  it('a genuinely missed past day (fully elapsed, not all done) breaks the streak', () => {
    const buckets = bucketTasksByDay([
      row('2026-07-08', 'done'),
      row('2026-07-09', 'open'), // missed
      row('2026-07-10', 'done'),
    ]);
    expect(computeCurrentStreak(buckets, '2026-07-10')).toBe(1);
  });

  it('is 0 with no history at all', () => {
    expect(computeCurrentStreak(new Map(), '2026-07-10')).toBe(0);
  });
});

describe('computeLongestStreak', () => {
  it('finds the longest run even after a break resets the current streak', () => {
    const buckets = bucketTasksByDay([
      row('2026-07-01', 'done'),
      row('2026-07-02', 'done'),
      row('2026-07-03', 'done'),
      row('2026-07-04', 'done'), // 4-day run
      row('2026-07-05', 'open'), // break
      row('2026-07-06', 'done'),
      row('2026-07-07', 'done'), // only a 2-day run after the reset
    ]);
    expect(computeLongestStreak(buckets)).toBe(4);
    // current streak (as of 07-07) is only 2 — longest and current diverge
    // exactly the way a real "reset then rebuild" history should.
    expect(computeCurrentStreak(buckets, '2026-07-07')).toBe(2);
  });

  it('skips neutral gaps without breaking an otherwise-perfect run', () => {
    const buckets = bucketTasksByDay([
      row('2026-07-01', 'done'),
      row('2026-07-02', 'done'),
      // 07-03 neutral (nothing due)
      row('2026-07-04', 'done'),
    ]);
    expect(computeLongestStreak(buckets)).toBe(3);
  });
});

describe('buildCalendar', () => {
  it('spans from the 1st of the month monthsBack months ago through today, oldest first', () => {
    const buckets = bucketTasksByDay([row('2026-07-10', 'done')]);
    const calendar = buildCalendar(buckets, '2026-07-10', 2);
    // May 1 .. Jul 10 = 31 + 30 + 10
    expect(calendar).toHaveLength(71);
    expect(calendar[0]!.ymd).toBe('2026-05-01');
    expect(calendar[calendar.length - 1]!.ymd).toBe('2026-07-10');
    expect(calendar[calendar.length - 1]!.verdict).toBe('perfect');
  });

  it('wraps the year boundary when monthsBack crosses January', () => {
    const calendar = buildCalendar(new Map(), '2026-01-15', 2);
    expect(calendar[0]!.ymd).toBe('2025-11-01');
    expect(calendar[calendar.length - 1]!.ymd).toBe('2026-01-15');
  });

  it('fills days with no data as neutral (level 0) rather than omitting them', () => {
    const calendar = buildCalendar(new Map(), '2026-07-10', 0);
    // Jul 1 .. Jul 10
    expect(calendar).toHaveLength(10);
    expect(calendar.every((d) => d.verdict === 'neutral' && d.level === 0)).toBe(true);
  });
});
