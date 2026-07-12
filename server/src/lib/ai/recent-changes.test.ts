import { describe, expect, it } from 'vitest';

import { renderUndoTarget } from './recent-changes.ts';

// The undo state line exists so "undo that" works even when the undoable
// action happened in the app, outside chat (observed live: the model
// refused with "nothing to undo" right after a Tasks-tab deletion).

describe('renderUndoTarget', () => {
  it('renders nothing when nothing is undoable', () => {
    expect(renderUndoTarget(null)).toBe('');
  });

  it('names a goal-archive with its task cascade', () => {
    const line = renderUndoTarget({
      kind: 'goal_archived',
      payload: { goalId: 'g1', name: 'Daily journaling', cascadedTaskIds: ['a', 'b'] },
      source: 'tasks_ui',
    });
    expect(line).toContain('removing goal "Daily journaling"');
    expect(line).toContain('restores the goal AND its linked tasks');
    expect(line).toContain('never claim there\'s nothing to undo');
  });

  it('names a single task removal by title', () => {
    const line = renderUndoTarget({
      kind: 'task_removed',
      payload: { taskId: 't1', title: 'Journal', cascadedInstanceIds: [] },
      source: 'tasks_ui',
    });
    expect(line).toContain('removing "Journal"');
  });

  it('lists every title of a bulk removal', () => {
    const line = renderUndoTarget({
      kind: 'task_removed',
      payload: { bulk: true, tasks: [{ title: 'Water' }, { title: 'Pushups' }] },
      source: 'tasks_ui',
    });
    expect(line).toContain('removing "Water", "Pushups"');
  });

  it('phrases a completion as the action, not the effect', () => {
    const line = renderUndoTarget({
      kind: 'task_completion',
      payload: { taskId: 't1', title: 'Meditate' },
      source: 'app_chat',
    });
    expect(line).toContain('completing "Meditate"');
  });
});
