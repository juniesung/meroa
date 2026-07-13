import { describe, expect, it } from 'vitest';

import { filterRetireCandidates, isAdvanceProposalStale } from './executor.ts';

// Pure decision coverage for advance_goal_stage's proposal-building and
// re-validation logic — no DB required (docs/milestone-goal-plan.md §4).

describe('filterRetireCandidates', () => {
  it('retires a recurring template regardless of status', () => {
    const rows = [{ id: 't1', recurrence: { freq: 'daily' as const }, status: 'open' }];
    expect(filterRetireCandidates(rows)).toEqual(rows);
  });

  it('retires a recurring template even when status is somehow done', () => {
    // Templates are never actually 'done' themselves in practice, but the
    // filter shouldn't depend on that — recurrence presence alone decides.
    const rows = [{ id: 't1', recurrence: { freq: 'daily' as const }, status: 'done' }];
    expect(filterRetireCandidates(rows)).toEqual(rows);
  });

  it('retires an open, non-recurring instance/standalone', () => {
    const rows = [{ id: 't1', recurrence: null, status: 'open' }];
    expect(filterRetireCandidates(rows)).toEqual(rows);
  });

  it('a done, non-recurring instance survives — it is history, not retired', () => {
    const rows = [{ id: 't1', recurrence: null, status: 'done' }];
    expect(filterRetireCandidates(rows)).toEqual([]);
  });

  it('mixed batch: keeps templates and open tasks, drops done standalones', () => {
    const rows = [
      { id: 'template', recurrence: { freq: 'daily' as const }, status: 'open' },
      { id: 'open-standalone', recurrence: null, status: 'open' },
      { id: 'done-standalone', recurrence: null, status: 'done' },
    ];
    expect(filterRetireCandidates(rows).map((r) => r.id)).toEqual(['template', 'open-standalone']);
  });
});

describe('isAdvanceProposalStale', () => {
  it('is not stale when the live stage matches what the card showed', () => {
    expect(isAdvanceProposalStale(1, 1)).toBe(false);
  });

  it('is stale when the goal has already advanced past the card', () => {
    expect(isAdvanceProposalStale(2, 1)).toBe(true);
  });

  it('is stale when the goal has moved backward (an undo) since the card', () => {
    expect(isAdvanceProposalStale(0, 1)).toBe(true);
  });
});
