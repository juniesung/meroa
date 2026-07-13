import { describe, expect, it } from 'vitest';

import { hasUngroundedFigure, looksPurelyConversational } from './providers/shared.ts';
import {
  AI_TOOL_SCHEMAS,
  NO_ACTION_TOOL_NAME,
  OPENAI_ACTION_PASS_TOOLS,
  validateToolInput,
} from './tools.ts';

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

// The .strict()-intersection regression class applies to any tool whose
// schema is built by extending/merging — new cases added up front per the
// milestone plan's lesson, not discovered live after a launch.
describe('AI_TOOL_SCHEMAS.create_goal — milestone', () => {
  it('accepts a milestone with 2-8 stages', () => {
    const result = validateToolInput('create_goal', {
      type: 'milestone',
      name: 'Land internship',
      stages: ['Applying', 'Interviewing', 'Offer negotiation'],
    });
    expect(result.ok).toBe(true);
  });

  it('accepts a milestone with starter tasks for the first stage', () => {
    const result = validateToolInput('create_goal', {
      type: 'milestone',
      name: 'Land internship',
      stages: ['Applying', 'Interviewing'],
      starterTasks: [{ title: 'Update resume' }, { title: 'Apply to 5 companies' }],
    });
    expect(result.ok).toBe(true);
  });

  it('rejects a milestone with fewer than 2 stages', () => {
    const result = validateToolInput('create_goal', {
      type: 'milestone',
      name: 'Land internship',
      stages: ['Applying'],
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a milestone starter task with a contribution', () => {
    const result = validateToolInput('create_goal', {
      type: 'milestone',
      name: 'Land internship',
      stages: ['Applying', 'Interviewing'],
      starterTasks: [{ title: 'Update resume', contribution: 5 }],
    });
    expect(result.ok).toBe(false);
  });
});

describe('AI_TOOL_SCHEMAS.advance_goal_stage', () => {
  it('accepts a goal ref with no nextStageTasks (advance to the last stage)', () => {
    const result = validateToolInput('advance_goal_stage', { goalRef: 'G1', nameHint: 'Land internship' });
    expect(result.ok).toBe(true);
  });

  it('accepts nextStageTasks with a recurrence, no contribution field exists to set', () => {
    const result = validateToolInput('advance_goal_stage', {
      goalRef: 'G1',
      nameHint: 'Land internship',
      nextStageTasks: [{ title: 'Prep for interviews', recurrence: { freq: 'daily' } }],
    });
    expect(result.ok).toBe(true);
  });

  it('rejects a nextStageTasks item carrying an (unsupported) contribution key', () => {
    const result = validateToolInput('advance_goal_stage', {
      goalRef: 'G1',
      nameHint: 'Land internship',
      nextStageTasks: [{ title: 'Prep for interviews', contribution: 5 }],
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a missing goalRef', () => {
    const result = validateToolInput('advance_goal_stage', { nameHint: 'Land internship' });
    expect(result.ok).toBe(false);
  });
});

describe('no_action carries a reason', () => {
  // The only channel between the act pass and the narrate pass on a turn
  // where nothing was called. Without a REQUIRED reason, the reply pass
  // knows only "nothing happened" and not why — and an ambiguous "mark
  // water done" (two matching tasks) came back as a confident, false
  // "marked it done" in 3 of 3 live runs instead of "which one?".
  // providers/act-narrate.ts reads exactly this field.
  const noAction = OPENAI_ACTION_PASS_TOOLS.find(
    (t) => t.type === 'function' && t.function.name === NO_ACTION_TOOL_NAME,
  );

  it('is present in the action pass tools', () => {
    expect(noAction).toBeDefined();
  });

  it('requires a reason the narrate pass can ask from', () => {
    const params = (noAction as { function: { parameters: unknown } }).function.parameters as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(params.properties).toHaveProperty('reason');
    expect(params.required).toContain('reason');
  });

  // The narrate fast path (providers/act-narrate.ts) turns reasoning off for
  // the reply ONLY when this says 'conversation'. Disabling it on a turn where
  // the user actually asked for something is what produced false claims ("No
  // problem, undid that" on a turn where nothing ran), so the two values are
  // load-bearing, not decorative.
  it('requires an intent the fast reply path can gate on', () => {
    const params = (noAction as { function: { parameters: unknown } }).function.parameters as {
      properties?: Record<string, { enum?: string[] }>;
      required?: string[];
    };
    expect(params.required).toContain('intent');
    expect(params.properties?.intent?.enum).toEqual(['conversation', 'unfulfilled']);
  });
});

describe('looksPurelyConversational — the fast path\'s second key', () => {
  // Pure function, no API. This is the key that does NOT depend on the model,
  // and it is the only thing standing between a task request and a reply
  // written with reasoning switched off.
  it('lets genuine small talk through', () => {
    for (const m of ['hey', 'haha fair enough', "what's your deal", 'kind of a rough day honestly', 'lol']) {
      expect(looksPurelyConversational(m), m).toBe(true);
    }
  });

  it('blocks anything that touches their tasks or goals', () => {
    for (const m of [
      'saved my $5 today', // labelled 'conversation' by the model 3/3 — this key is what stops it
      'mark water done',
      'add a task to call mom',
      'undo that',
      'i want to save for a laptop',
      'did my workout',
      'log 165',
    ]) {
      expect(looksPurelyConversational(m), m).toBe(false);
    }
  });

  it('blocks progress questions — a numbers recap must never lose its reasoning', () => {
    // Found live: "how am i doing so far?" tripped none of the nouns or verbs,
    // so it was fast-pathed 3/3. A recap has to quote real totals, and the
    // claim-check guards action claims, not invented numbers.
    for (const m of ['how am i doing so far?', 'how much have i saved', 'where am i at', 'catch me up', "what's left"]) {
      expect(looksPurelyConversational(m), m).toBe(false);
    }
  });
});

describe('hasUngroundedFigure — the figure check\'s free tier', () => {
  const FACTS = '# Their goals\nG1 "New bike" — savings, $5 / $300\n\n# Their tasks\nT1 "Save $5" — daily';

  it('passes a reply whose every number is already in the facts (no classifier call needed)', () => {
    expect(hasUngroundedFigure("nice — you're at $5 of $300 on the bike", FACTS)).toBe(false);
  });

  it('flags a number that appears nowhere in the facts', () => {
    // The live fabrication: real total $5, reply claimed $10.
    expect(hasUngroundedFigure("that $5 is logged — you're at $10 total now", FACTS)).toBe(true);
  });

  it('is deliberately over-eager: a correctly DERIVED figure also trips it', () => {
    // "$295 to go" is right ($300 - $5) but appears nowhere in the facts. The
    // regex only decides whether to ASK; didMisstateFigure is what judges, and
    // it is told that sound arithmetic is fine.
    expect(hasUngroundedFigure('$295 to go', FACTS)).toBe(true);
  });

  it('treats 1,200 and 1200 as the same figure', () => {
    expect(hasUngroundedFigure('you saved 1,200', 'total is 1200')).toBe(false);
  });

  it('says nothing to flag when the reply has no numbers at all', () => {
    expect(hasUngroundedFigure('nice, keep it going', FACTS)).toBe(false);
  });
});

describe('looksPurelyConversational — state questions must never fast-path', () => {
  // The fast path hands the reply pass a context with NO task list at all
  // (providers/act-narrate.ts), so a state question that slipped through would
  // be answered from nothing. "what's on my list?" tripped none of the original
  // signal words; only the model's own 'unfulfilled' caught it, and this key is
  // supposed to hold on its own.
  it('blocks questions about their list, plans or schedule', () => {
    for (const m of ["what's on my list?", 'what are my plans', "what's my schedule", 'anything left']) {
      expect(looksPurelyConversational(m), m).toBe(false);
    }
  });

  it('still lets real small talk through', () => {
    for (const m of ['hey', 'what’s up dawg', 'how are you', 'lol nice', 'haha fair enough']) {
      expect(looksPurelyConversational(m), m).toBe(true);
    }
  });
});
