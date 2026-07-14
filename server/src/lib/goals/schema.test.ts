import { describe, expect, it } from 'vitest';

import {
  applyStageOps,
  buildGoalDefinition,
  createGoalParamsSchema,
  manualCreateGoalSchema,
  milestoneGoalDefinitionSchema,
  type MilestoneGoalDefinition,
} from './schema.ts';

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

  it('accepts 0 stages — a bare template (docs/goal-manual-editing-plan.md §1 decision 1)', () => {
    expect(milestoneGoalDefinitionSchema.safeParse({ ...base, stages: [] }).success).toBe(true);
  });

  it('accepts 1 stage at the schema level — the "0, or 2-8, never exactly 1" invariant is enforced by writers (buildGoalDefinition, applyStageOps), not this schema, the same reason indirect keeps its cross-field rules outside its own schema', () => {
    expect(milestoneGoalDefinitionSchema.safeParse({ ...base, stages: ['Only one'] }).success).toBe(true);
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

  it('accepts a milestone missing stages entirely — a bare, name-only template (docs/goal-manual-editing-plan.md §1 decision 1)', () => {
    const result = createGoalParamsSchema.safeParse({ type: 'milestone', name: 'Land internship' });
    expect(result.success).toBe(true);
  });

  it('rejects a bare-template milestone carrying starterTasks — no stage 0 for them to belong to yet', () => {
    const result = createGoalParamsSchema.safeParse({
      type: 'milestone',
      name: 'Land internship',
      starterTasks: [{ title: 'Update resume' }],
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.path).toEqual(['starterTasks']);
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

describe('manualCreateGoalSchema — stagePlans', () => {
  const validMilestone = {
    type: 'milestone' as const,
    name: 'Land internship',
    stages: ['Applying', 'Interviewing', 'Offer negotiation'],
  };

  it('accepts a milestone with plans for stages after the active one', () => {
    const result = manualCreateGoalSchema.safeParse({
      ...validMilestone,
      stagePlans: [[], [{ title: 'Mock interviews' }], [{ title: 'Research salary bands' }]],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a plan for stage 0 — that\'s the active stage; its tasks go in starterTasks', () => {
    const result = manualCreateGoalSchema.safeParse({
      ...validMilestone,
      stagePlans: [[{ title: 'Update resume' }]],
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.path).toEqual(['stagePlans']);
  });

  it('rejects stagePlans with more entries than stages', () => {
    const result = manualCreateGoalSchema.safeParse({
      ...validMilestone,
      stagePlans: [[], [], [], [{ title: 'Too far out' }]],
    });
    expect(result.success).toBe(false);
  });

  it('rejects stagePlans on a bare template — nothing to attach to yet', () => {
    const result = manualCreateGoalSchema.safeParse({
      type: 'milestone',
      name: 'Land internship',
      stagePlans: [[{ title: 'Update resume' }]],
    });
    expect(result.success).toBe(false);
  });

  it('rejects stagePlans on a non-milestone goal', () => {
    const result = manualCreateGoalSchema.safeParse({
      type: 'savings',
      name: 'Trip',
      currency: '$',
      targetValue: 500,
      stagePlans: [[{ title: 'Should not be allowed' }]],
    });
    expect(result.success).toBe(false);
  });

  it('enforces the same cross-field rules as createGoalParamsSchema (e.g. savings needs a target)', () => {
    const result = manualCreateGoalSchema.safeParse({ type: 'savings', name: 'Trip', currency: '$' });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.path).toEqual(['targetValue']);
  });
});

describe('buildGoalDefinition', () => {
  it('savings: defaults currency to "$" when omitted', () => {
    const def = buildGoalDefinition({ type: 'savings', targetValue: 500 });
    expect(def).toEqual({ type: 'savings', currency: '$', targetValue: 500, deadline: undefined });
  });

  it('habit: carries nothing but the tag', () => {
    expect(buildGoalDefinition({ type: 'habit' })).toEqual({ type: 'habit' });
  });

  it('indirect: passes through unit/targetValue/deadline', () => {
    const def = buildGoalDefinition({ type: 'indirect', unit: 'lb', targetValue: 165 });
    expect(def).toEqual({ type: 'indirect', unit: 'lb', targetValue: 165, deadline: undefined });
  });

  it('milestone: stages defaults to [] (a bare template) when omitted', () => {
    const def = buildGoalDefinition({ type: 'milestone' });
    expect(def).toEqual({ type: 'milestone', stages: [], activeStageIndex: 0 });
  });

  it('milestone: activeStageIndex is always 0, never a caller input', () => {
    const def = buildGoalDefinition({ type: 'milestone', stages: ['A', 'B'] });
    expect(def).toMatchObject({ activeStageIndex: 0, stages: ['A', 'B'] });
  });

  it('milestone: stagePlans passes through only when non-empty', () => {
    const withPlans = buildGoalDefinition({ type: 'milestone', stages: ['A', 'B'], stagePlans: [[], [{ title: 'X' }]] });
    expect(withPlans).toMatchObject({ stagePlans: [[], [{ title: 'X' }]] });

    const withoutPlans = buildGoalDefinition({ type: 'milestone', stages: ['A', 'B'], stagePlans: [] });
    expect('stagePlans' in withoutPlans).toBe(false);
  });
});

describe('applyStageOps', () => {
  const fresh: MilestoneGoalDefinition = { type: 'milestone', stages: ['A', 'B', 'C'], activeStageIndex: 0 };

  it('replaces the stage list wholesale (rename/insert/reorder from the active stage on)', () => {
    const result = applyStageOps(fresh, ['A', 'B2', 'C', 'D']);
    expect('definition' in result).toBe(true);
    if ('definition' in result) expect(result.definition.stages).toEqual(['A', 'B2', 'C', 'D']);
  });

  it('rejects dropping below the active stage count — the completed/active prefix can\'t shrink', () => {
    const advanced: MilestoneGoalDefinition = { ...fresh, activeStageIndex: 2 };
    const result = applyStageOps(advanced, ['A', 'B']);
    expect('error' in result).toBe(true);
  });

  it('accepts a rename within the completed/active prefix (same length, same order)', () => {
    const advanced: MilestoneGoalDefinition = { ...fresh, activeStageIndex: 2 };
    const result = applyStageOps(advanced, ['A renamed', 'B', 'C']);
    expect('definition' in result).toBe(true);
  });

  it('rejects exactly 1 stage', () => {
    const result = applyStageOps(fresh, ['Only one']);
    expect('error' in result).toBe(true);
  });

  it('rejects collapsing to 0 stages while a real active stage exists — that stage\'s tasks are real, not a plan to silently discard', () => {
    const result = applyStageOps(fresh, []);
    expect('error' in result).toBe(true);
  });

  it('an already-bare template stays valid at 0 stages (a no-op-shaped edit)', () => {
    const bare: MilestoneGoalDefinition = { type: 'milestone', stages: [], activeStageIndex: 0 };
    const result = applyStageOps(bare, []);
    expect('definition' in result).toBe(true);
    if ('definition' in result) expect(result.definition.stages).toEqual([]);
  });

  it('a bare template can be filled in with 2-8 stages', () => {
    const bare: MilestoneGoalDefinition = { type: 'milestone', stages: [], activeStageIndex: 0 };
    const result = applyStageOps(bare, ['Applying', 'Interviewing']);
    expect('definition' in result).toBe(true);
    if ('definition' in result) expect(result.definition.stages).toEqual(['Applying', 'Interviewing']);
  });

  it('rejects 9 stages', () => {
    const result = applyStageOps(fresh, Array.from({ length: 9 }, (_, i) => `Stage ${i + 1}`));
    expect('error' in result).toBe(true);
  });

  it('realigns stagePlans to the new stage count, padding new trailing stages with []', () => {
    const result = applyStageOps(fresh, ['A', 'B', 'C', 'D'], [[], [{ title: 'For B' }], [{ title: 'For C' }]]);
    expect('definition' in result).toBe(true);
    if ('definition' in result) {
      expect(result.definition.stagePlans).toEqual([[], [{ title: 'For B' }], [{ title: 'For C' }], []]);
    }
  });

  it('rejects a plan for the active stage — its tasks are real tasks, not a plan', () => {
    const result = applyStageOps(fresh, ['A', 'B', 'C'], [[{ title: 'Should not be allowed' }]]);
    expect('error' in result).toBe(true);
  });

  it('rejects a plan for an already-complete stage', () => {
    const advanced: MilestoneGoalDefinition = { ...fresh, activeStageIndex: 1 };
    const result = applyStageOps(advanced, ['A', 'B', 'C'], [[{ title: 'For completed stage A' }]]);
    expect('error' in result).toBe(true);
  });

  it('rejects stagePlans with more entries than stages', () => {
    const result = applyStageOps(fresh, ['A', 'B'], [[], [], [{ title: 'Orphaned' }]]);
    expect('error' in result).toBe(true);
  });

  it('omits stagePlans entirely from the result when every entry is empty', () => {
    const result = applyStageOps(fresh, ['A', 'B', 'C'], [[], [], []]);
    expect('definition' in result).toBe(true);
    if ('definition' in result) expect('stagePlans' in result.definition).toBe(false);
  });

  it('advancing the active stage clears its consumed plan (mirrors executor.ts\'s advanceGoalStage)', () => {
    const withPlan: MilestoneGoalDefinition = {
      type: 'milestone',
      stages: ['A', 'B', 'C'],
      activeStageIndex: 1,
      stagePlans: [[], [{ title: 'For B' }], [{ title: 'For C' }]],
    };
    // Simulating the advance: activeStageIndex bumps to 2, and the caller
    // (executor.ts) clears stagePlans[2] before calling applyStageOps-
    // adjacent logic — here we just confirm applyStageOps itself refuses a
    // stale plan sitting on the new active stage if handed one.
    const staleAdvance: MilestoneGoalDefinition = { ...withPlan, activeStageIndex: 2 };
    const result = applyStageOps(staleAdvance, undefined, [[], [], [{ title: 'For C' }]]);
    expect('error' in result).toBe(true);
  });
});
