import { afterEach, describe, expect, it, vi } from 'vitest';

import { pickTaskCreatedQuip } from './quips.ts';

describe('pickTaskCreatedQuip', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('direct never gets a quip, regardless of the roll', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(pickTaskCreatedQuip('direct')).toBeNull();
  });

  it('a losing roll (above the preset chance) returns null', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    expect(pickTaskCreatedQuip('playful')).toBeNull();
  });

  it('a winning roll returns a real string from the preset pool', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const quip = pickTaskCreatedQuip('playful');
    expect(typeof quip).toBe('string');
    expect(quip).not.toBe('');
  });

  it('defaults to balanced when no preset is set', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(typeof pickTaskCreatedQuip(undefined)).toBe('string');
  });
});
