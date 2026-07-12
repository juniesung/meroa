import { describe, expect, it } from 'vitest';

import { AI_TOOL_SCHEMAS, validateToolInput } from './tools.ts';

// Regression: intersecting createTaskInputSchema with a .strict() wrapper
// object rejected every ordinary field (title/type/icon/...) because
// z.intersection validates the raw input against BOTH operands
// independently — a strict() second operand bans any key it doesn't itself
// declare, even one the first operand already accepts. Caught live: every
// create_task call failed 100% of the time with "Unrecognized key(s):
// 'title', 'type', 'icon'" until this was fixed. Pinned here so a future
// "let me just add .strict() for safety" doesn't reintroduce it.
describe('AI_TOOL_SCHEMAS.create_task', () => {
  it('accepts a plain task with no goalLink', () => {
    const result = validateToolInput('create_task', { title: 'Skip lunch out', type: 'completion' });
    expect(result.ok).toBe(true);
  });

  it('accepts every ordinary create_task field alongside a goalLink', () => {
    const result = validateToolInput('create_task', {
      title: 'Save $5',
      type: 'completion',
      icon: 'wallet',
      recurrence: { freq: 'daily' },
      goalLink: { goalRef: 'G1', goalNameHint: 'Trip savings', contribution: 5 },
    });
    expect(result.ok).toBe(true);
  });

  it('still rejects a genuinely malformed input (missing required title)', () => {
    const result = validateToolInput('create_task', { type: 'completion' });
    expect(result.ok).toBe(false);
  });
});

describe('AI_TOOL_SCHEMAS.edit_task', () => {
  it('accepts an ordinary patch with no goal fields', () => {
    const result = validateToolInput('edit_task', { taskRef: 'T1', titleHint: 'Skip lunch out', title: 'Bring lunch' });
    expect(result.ok).toBe(true);
  });

  it('accepts a goalLink alongside ordinary patch fields', () => {
    const result = validateToolInput('edit_task', {
      taskRef: 'T1',
      titleHint: 'Skip lunch out',
      goalLink: { goalRef: 'G1', goalNameHint: 'Trip savings', contribution: 5 },
    });
    expect(result.ok).toBe(true);
  });

  it('accepts unlinkGoal', () => {
    const result = validateToolInput('edit_task', { taskRef: 'T1', titleHint: 'Skip lunch out', unlinkGoal: true });
    expect(result.ok).toBe(true);
  });
});

// The AI_TOOL_SCHEMAS map itself must stay in sync with AiToolName — a
// smoke test that every entry actually parses *something* valid, catching
// the exact class of "every input rejected" bug above for any future tool.
describe('AI_TOOL_SCHEMAS — every tool has a working schema', () => {
  it('create_goal/edit_goal/log_goal_entry/remove_goal/undo_last_action are unaffected', () => {
    expect(AI_TOOL_SCHEMAS.create_goal.safeParse({ type: 'savings', name: 'x', targetValue: 10 }).success).toBe(true);
    expect(AI_TOOL_SCHEMAS.edit_goal.safeParse({ goalRef: 'G1', nameHint: 'x', name: 'y' }).success).toBe(true);
    expect(
      AI_TOOL_SCHEMAS.log_goal_entry.safeParse({ goalRef: 'G1', nameHint: 'x', amount: 5 }).success,
    ).toBe(true);
    expect(AI_TOOL_SCHEMAS.remove_goal.safeParse({ goalRef: 'G1', nameHint: 'x' }).success).toBe(true);
    expect(AI_TOOL_SCHEMAS.undo_last_action.safeParse({}).success).toBe(true);
  });
});
