import { describe, expect, it } from 'vitest';

import { createGoalParamsSchema, milestoneGoalDefinitionSchema } from './schema.ts';

// The cross-field rules the model is most likely to get wrong — enforced in
// the schema so a bad call fails loud with a corrective message instead of
// writing a malformed goal (docs/ai-reliability-hardening.md: fail loud).

const DAILY = { freq: 'daily' as const };

describe('createGoalParamsSchema — savings', () => {
  it('accepts a full savings goal and defaults type to savings when omitted', () => {
    const result = createGoalParamsSchema.safeParse({
      name: 'Portugal trip',
      currency: '$',
      targetValue: 1500,
      deadline: '2026-12-25',
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.type).toBe('savings');
  });

  it('rejects savings without a target amount', () => {
    const result = createGoalParamsSchema.safeParse({ type: 'savings', name: 'Trip', currency: '$' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['targetValue']);
    }
  });
});

describe('createGoalParamsSchema — habit', () => {
  const validHabit = {
    type: 'habit' as const,
    name: 'Meditate daily',
    starterTasks: [{ title: 'Meditate 10 min', recurrence: DAILY }],
  };

  it('accepts a habit with a recurring, contribution-less check-in task', () => {
    expect(createGoalParamsSchema.safeParse(validHabit).success).toBe(true);
  });

  it('rejects a habit carrying savings numbers (targetValue / currency / deadline)', () => {
    for (const extra of [{ targetValue: 30 }, { currency: '$' }, { deadline: '2026-12-25' }]) {
      const result = createGoalParamsSchema.safeParse({ ...validHabit, ...extra });
      expect(result.success).toBe(false);
    }
  });

  it('rejects a habit without its check-in task', () => {
    const result = createGoalParamsSchema.safeParse({ type: 'habit', name: 'Meditate daily' });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.path).toEqual(['starterTasks']);
  });

  it('rejects a habit whose check-in task does not repeat', () => {
    const result = createGoalParamsSchema.safeParse({
      ...validHabit,
      starterTasks: [{ title: 'Meditate 10 min' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a habit check-in task with a contribution amount', () => {
    // A stamped contribution would make completions write goal_entries — a
    // habit goal must have none (the completions ARE the record).
    const result = createGoalParamsSchema.safeParse({
      ...validHabit,
      starterTasks: [{ title: 'Meditate 10 min', recurrence: DAILY, contribution: 5 }],
    });
    expect(result.success).toBe(false);
  });
});

describe('createGoalParamsSchema — indirect', () => {
  it('accepts a unit-only indirect goal (no target) — "just track it" is complete', () => {
    const result = createGoalParamsSchema.safeParse({ type: 'indirect', name: 'Weight', unit: 'lb' });
    expect(result.success).toBe(true);
  });

  it('accepts an indirect goal with a target and deadline', () => {
    const result = createGoalParamsSchema.safeParse({
      type: 'indirect',
      name: 'Bench PR',
      unit: 'lb',
      targetValue: 225,
      deadline: '2026-12-25',
    });
    expect(result.success).toBe(true);
  });

  it('rejects indirect without a unit', () => {
    const result = createGoalParamsSchema.safeParse({ type: 'indirect', name: 'Weight' });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.path).toEqual(['unit']);
  });

  it('rejects indirect with a currency', () => {
    const result = createGoalParamsSchema.safeParse({ type: 'indirect', name: 'Weight', unit: 'lb', currency: '$' });
    expect(result.success).toBe(false);
  });

  it('rejects a deadline with no target value', () => {
    const result = createGoalParamsSchema.safeParse({
      type: 'indirect',
      name: 'Weight',
      unit: 'lb',
      deadline: '2026-12-25',
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.path).toEqual(['deadline']);
  });

  it('rejects a starter task carrying a contribution — a linked task never logs a number', () => {
    const result = createGoalParamsSchema.safeParse({
      type: 'indirect',
      name: 'Weight',
      unit: 'lb',
      starterTasks: [{ title: 'Gym session', contribution: 5 }],
    });
    expect(result.success).toBe(false);
  });

  it('accepts a supporting starter task with no contribution', () => {
    const result = createGoalParamsSchema.safeParse({
      type: 'indirect',
      name: 'Weight',
      unit: 'lb',
      starterTasks: [{ title: 'Gym session' }],
    });
    expect(result.success).toBe(true);
  });
});

describe('milestoneGoalDefinitionSchema — stage-count matrix', () => {
  const base = { type: 'milestone' as const, activeStageIndex: 0 };

  it('accepts 2..8 stages', () => {
    for (let n = 2; n <= 8; n++) {
      const stages = Array.from({ length: n }, (_, i) => `Stage ${i + 1}`);
      expect(milestoneGoalDefinitionSchema.safeParse({ ...base, stages }).success).toBe(true);
    }
  });

  it('rejects 1 stage', () => {
    expect(milestoneGoalDefinitionSchema.safeParse({ ...base, stages: ['Only one'] }).success).toBe(false);
  });

  it('rejects 9 stages', () => {
    const stages = Array.from({ length: 9 }, (_, i) => `Stage ${i + 1}`);
    expect(milestoneGoalDefinitionSchema.safeParse({ ...base, stages }).success).toBe(false);
  });

  it('rejects an empty-string stage title', () => {
    expect(
      milestoneGoalDefinitionSchema.safeParse({ ...base, stages: ['Applying', ''] }).success,
    ).toBe(false);
  });
});

describe('createGoalParamsSchema — milestone', () => {
  const validMilestone = {
    type: 'milestone' as const,
    name: 'Land internship',
    stages: ['Applying', 'Interviewing', 'Offer negotiation'],
  };

  it('accepts a valid milestone with 2-8 stages', () => {
    expect(createGoalParamsSchema.safeParse(validMilestone).success).toBe(true);
  });

  it('rejects a milestone with fewer than 2 stages', () => {
    const result = createGoalParamsSchema.safeParse({ ...validMilestone, stages: ['Applying'] });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.path).toEqual(['stages']);
  });

  it('rejects a milestone missing stages entirely', () => {
    const result = createGoalParamsSchema.safeParse({ type: 'milestone', name: 'Land internship' });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.path).toEqual(['stages']);
  });

  it('rejects a milestone carrying targetValue / currency / deadline / unit', () => {
    for (const extra of [
      { targetValue: 30 },
      { currency: '$' },
      { deadline: '2026-12-25' },
      { unit: 'lb' },
    ]) {
      const result = createGoalParamsSchema.safeParse({ ...validMilestone, ...extra });
      expect(result.success).toBe(false);
    }
  });

  it('rejects a milestone starter task carrying a contribution', () => {
    const result = createGoalParamsSchema.safeParse({
      ...validMilestone,
      starterTasks: [{ title: 'Update resume', contribution: 5 }],
    });
    expect(result.success).toBe(false);
  });

  it('accepts milestone starter tasks with no contribution — the first stage\'s to-dos', () => {
    const result = createGoalParamsSchema.safeParse({
      ...validMilestone,
      starterTasks: [{ title: 'Update resume' }, { title: 'Apply to 5 companies' }],
    });
    expect(result.success).toBe(true);
  });
});
