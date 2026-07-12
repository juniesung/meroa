import { describe, expect, it } from 'vitest';

import { findPendingPreview, renderPendingPreview, type MessageLike } from './pending-preview.ts';
import type { GoalPreview } from '../goals/schema.ts';

function previewMessage(preview: GoalPreview, createdGoalId?: string, at = 0): MessageLike {
  return {
    role: 'assistant',
    meta: { kind: 'goal_preview', preview, ...(createdGoalId ? { createdGoalId } : {}) },
    createdAt: new Date(at),
  };
}

function textMessage(role: 'user' | 'assistant', at = 0): MessageLike {
  return { role, meta: {}, createdAt: new Date(at) };
}

const PORTUGAL: GoalPreview = {
  template: 'savings',
  name: 'Portugal trip',
  icon: 'wallet',
  definition: { type: 'savings', currency: '$', targetValue: 1500, deadline: '2026-12-25' },
  starterTasks: [{ title: 'Save $60', recurrence: { freq: 'weekly', byWeekday: ['su'] }, contribution: 60 }],
};

const COAT: GoalPreview = {
  template: 'savings',
  name: 'Big warm coat',
  icon: 'wallet',
  definition: { type: 'savings', currency: '$', targetValue: 110 },
};

describe('findPendingPreview', () => {
  it('returns null with no previews at all', () => {
    expect(findPendingPreview([textMessage('user'), textMessage('assistant')])).toBeNull();
  });

  it('finds an un-tapped preview even with later conversation on top', () => {
    const messages = [
      previewMessage(PORTUGAL),
      textMessage('user', 1),
      textMessage('assistant', 2),
      textMessage('user', 3),
    ];
    expect(findPendingPreview(messages)?.name).toBe('Portugal trip');
  });

  it('a consumed preview (Create tapped) is not pending', () => {
    expect(findPendingPreview([previewMessage(PORTUGAL, 'goal-1')])).toBeNull();
  });

  it('the newest preview supersedes older ones — pending or not', () => {
    // older un-tapped + newer un-tapped -> newer wins
    expect(
      findPendingPreview([previewMessage(PORTUGAL, undefined, 0), previewMessage(COAT, undefined, 1)])?.name,
    ).toBe('Big warm coat');
    // older un-tapped + newer CONSUMED -> nothing pending (that flow ended)
    expect(
      findPendingPreview([previewMessage(PORTUGAL, undefined, 0), previewMessage(COAT, 'goal-2', 1)]),
    ).toBeNull();
  });
});

describe('renderPendingPreview', () => {
  it('renders nothing for null', () => {
    expect(renderPendingPreview(null)).toBe('');
  });

  it('renders the full proposal — name, target, deadline, starter cadence', () => {
    const line = renderPendingPreview(PORTUGAL);
    expect(line).toContain('"Portugal trip"');
    expect(line).toContain('$1500');
    expect(line).toContain('by 2026-12-25');
    expect(line).toContain('"Save $60" weekly on su ($60/completion)');
    expect(line).toContain('NOT saved yet');
  });
});
