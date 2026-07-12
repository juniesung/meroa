import { describe, expect, it } from 'vitest';

import { decideGoalEntryAction } from './goal-entry-decision.ts';

describe('decideGoalEntryAction', () => {
  it('does nothing for a task with no linked goal', () => {
    const decision = decideGoalEntryAction({
      goalId: null,
      goalContribution: 5,
      becameDone: true,
      becameOpen: false,
      newRecordId: 'record-1',
      priorCompletedRecordId: null,
      entryAt: new Date('2026-07-01T00:00:00Z'),
    });
    expect(decision).toEqual({ action: 'none' });
  });

  it('does nothing on completion if the task carries no numeric contribution', () => {
    const decision = decideGoalEntryAction({
      goalId: 'goal-1',
      goalContribution: undefined,
      becameDone: true,
      becameOpen: false,
      newRecordId: 'record-1',
      priorCompletedRecordId: null,
      entryAt: new Date('2026-07-01T00:00:00Z'),
    });
    expect(decision).toEqual({ action: 'none' });
  });

  it('inserts an entry referencing the new record when a goal-linked task becomes done', () => {
    const entryAt = new Date('2026-07-01T00:00:00Z');
    const decision = decideGoalEntryAction({
      goalId: 'goal-1',
      goalContribution: 5,
      becameDone: true,
      becameOpen: false,
      newRecordId: 'record-1',
      priorCompletedRecordId: null,
      entryAt,
    });
    expect(decision).toEqual({ action: 'insert', goalId: 'goal-1', recordId: 'record-1', amount: 5, entryAt });
  });

  it('deletes the entry referencing the prior record when a done task reopens', () => {
    const decision = decideGoalEntryAction({
      goalId: 'goal-1',
      goalContribution: 5,
      becameDone: false,
      becameOpen: true,
      newRecordId: 'record-2',
      priorCompletedRecordId: 'record-1',
      entryAt: new Date('2026-07-02T00:00:00Z'),
    });
    expect(decision).toEqual({ action: 'delete', recordId: 'record-1' });
  });

  it('does nothing on reopen if there was no prior completed record', () => {
    const decision = decideGoalEntryAction({
      goalId: 'goal-1',
      goalContribution: 5,
      becameDone: false,
      becameOpen: true,
      newRecordId: 'record-2',
      priorCompletedRecordId: null,
      entryAt: new Date('2026-07-02T00:00:00Z'),
    });
    expect(decision).toEqual({ action: 'none' });
  });

  it('does nothing for an incremental progress update that neither completes nor reopens', () => {
    const decision = decideGoalEntryAction({
      goalId: 'goal-1',
      goalContribution: 5,
      becameDone: false,
      becameOpen: false,
      newRecordId: 'record-1',
      priorCompletedRecordId: null,
      entryAt: new Date('2026-07-01T00:00:00Z'),
    });
    expect(decision).toEqual({ action: 'none' });
  });

  // The double-count trap (docs/goals-redesign-plan.md §2.3): complete,
  // un-complete, re-complete — simulating a minimal in-memory goal_entries
  // table against the emitted decisions confirms exactly one live entry
  // survives, never two, and none while reopened.
  it('done -> open -> re-done leaves exactly one live entry, never two', () => {
    const liveEntries = new Map<string, number>(); // recordId -> amount

    function applyDecision(decision: ReturnType<typeof decideGoalEntryAction>) {
      if (decision.action === 'insert') liveEntries.set(decision.recordId, decision.amount);
      else if (decision.action === 'delete') liveEntries.delete(decision.recordId);
    }

    // 1. complete_task -> record-1
    const d1 = decideGoalEntryAction({
      goalId: 'goal-1',
      goalContribution: 5,
      becameDone: true,
      becameOpen: false,
      newRecordId: 'record-1',
      priorCompletedRecordId: null,
      entryAt: new Date('2026-07-01T00:00:00Z'),
    });
    applyDecision(d1);
    expect(liveEntries.size).toBe(1);
    expect(liveEntries.get('record-1')).toBe(5);

    // 2. un-complete -> record-2, prior completedRecordId was record-1
    const d2 = decideGoalEntryAction({
      goalId: 'goal-1',
      goalContribution: 5,
      becameDone: false,
      becameOpen: true,
      newRecordId: 'record-2',
      priorCompletedRecordId: 'record-1',
      entryAt: new Date('2026-07-01T00:05:00Z'),
    });
    applyDecision(d2);
    expect(liveEntries.size).toBe(0); // none while reopened

    // 3. re-complete -> record-3
    const d3 = decideGoalEntryAction({
      goalId: 'goal-1',
      goalContribution: 5,
      becameDone: true,
      becameOpen: false,
      newRecordId: 'record-3',
      priorCompletedRecordId: null,
      entryAt: new Date('2026-07-01T00:10:00Z'),
    });
    applyDecision(d3);
    expect(liveEntries.size).toBe(1); // exactly one, never two
    expect(liveEntries.get('record-3')).toBe(5);
    expect(liveEntries.has('record-1')).toBe(false);
  });
});
