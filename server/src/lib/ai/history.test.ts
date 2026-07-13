import { describe, expect, it } from 'vitest';

import {
  describeCompletionHistory,
  isSameMonth,
  isSameWeek,
  seriesIdForHistory,
  weekStartYmd,
} from './history.ts';

describe('weekStartYmd', () => {
  it('returns the day itself for a Monday', () => {
    expect(weekStartYmd('2026-07-13')).toBe('2026-07-13'); // Monday
  });

  it('rolls a Sunday back to the Monday six days earlier, not forward', () => {
    // The Sunday→Monday boundary is the classic off-by-one: a Sunday belongs
    // to the week that STARTED six days ago, not the one starting tomorrow.
    expect(weekStartYmd('2026-07-12')).toBe('2026-07-06'); // Sunday
  });

  it('crosses a month boundary backwards', () => {
    expect(weekStartYmd('2026-07-02')).toBe('2026-06-29'); // Thu -> prev Mon
  });

  it('crosses a year boundary backwards', () => {
    expect(weekStartYmd('2027-01-01')).toBe('2026-12-28'); // Fri -> prev Mon
  });
});

describe('isSameWeek', () => {
  it('a Sunday and the Monday before it are the same week', () => {
    expect(isSameWeek('2026-07-12', '2026-07-06')).toBe(true);
  });

  it('a Sunday and the Monday after it are different weeks', () => {
    expect(isSameWeek('2026-07-12', '2026-07-13')).toBe(false);
  });

  it('spans a month boundary within one week', () => {
    expect(isSameWeek('2026-06-30', '2026-07-02')).toBe(true);
  });
});

describe('isSameMonth', () => {
  it('same month, different days', () => {
    expect(isSameMonth('2026-07-01', '2026-07-31')).toBe(true);
  });

  it('adjacent days across a month boundary are different months', () => {
    expect(isSameMonth('2026-06-30', '2026-07-01')).toBe(false);
  });
});

describe('describeCompletionHistory', () => {
  it('says nothing at all for a first completion (1 is noise, not a fact)', () => {
    expect(describeCompletionHistory({ countThisWeek: 1, countThisMonth: 1 })).toBeNull();
  });

  it('stays silent on the first of the week even when the month count is high', () => {
    expect(describeCompletionHistory({ countThisWeek: 1, countThisMonth: 9 })).toBeNull();
  });

  it('states the count from the 2nd onward', () => {
    expect(describeCompletionHistory({ countThisWeek: 2, countThisMonth: 2 })).toBe(
      "That's your 2nd time this week.",
    );
  });

  it('adds the month count only when it says something the week count did not', () => {
    expect(describeCompletionHistory({ countThisWeek: 3, countThisMonth: 7 })).toBe(
      "That's your 3rd time this week (7th this month).",
    );
    // Equal counts (the week IS the month so far) — no redundant parenthetical.
    expect(describeCompletionHistory({ countThisWeek: 4, countThisMonth: 4 })).toBe(
      "That's your 4th time this week.",
    );
  });

  it('gets the ordinal suffix right at the teens and the 21st', () => {
    expect(describeCompletionHistory({ countThisWeek: 2, countThisMonth: 11 })).toContain('11th this month');
    expect(describeCompletionHistory({ countThisWeek: 2, countThisMonth: 12 })).toContain('12th this month');
    expect(describeCompletionHistory({ countThisWeek: 2, countThisMonth: 13 })).toContain('13th this month');
    expect(describeCompletionHistory({ countThisWeek: 2, countThisMonth: 21 })).toContain('21st this month');
    expect(describeCompletionHistory({ countThisWeek: 2, countThisMonth: 22 })).toContain('22nd this month');
    expect(describeCompletionHistory({ countThisWeek: 2, countThisMonth: 23 })).toContain('23rd this month');
  });
});

describe('seriesIdForHistory', () => {
  it('a one-off task has no history to count', () => {
    // The guarantee behind "no count is ever stated for a non-recurring task":
    // buildTaskCompletionHistory returns null the moment this does.
    expect(seriesIdForHistory({ id: 'task-1', templateId: null, recurrence: null })).toBeNull();
  });

  it('an instance resolves to its template', () => {
    expect(seriesIdForHistory({ id: 'inst-1', templateId: 'tmpl-1', recurrence: null })).toBe('tmpl-1');
  });

  it('a template row resolves to itself', () => {
    expect(seriesIdForHistory({ id: 'tmpl-1', templateId: null, recurrence: { freq: 'daily' } })).toBe('tmpl-1');
  });
});
