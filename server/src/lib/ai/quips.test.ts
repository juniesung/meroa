import { afterEach, describe, expect, it, vi } from 'vitest';

import { pickTaskCreatedQuip } from './quips.ts';

describe('pickTaskCreatedQuip', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('the edgiest tone (4) never gets a quip, regardless of the roll', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(pickTaskCreatedQuip(4)).toBeNull();
  });

  it('a losing roll (above the tone chance) returns null', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    expect(pickTaskCreatedQuip(3)).toBeNull();
  });

  it('a winning roll returns a real string from the tone pool', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const quip = pickTaskCreatedQuip(3);
    expect(typeof quip).toBe('string');
    expect(quip).not.toBe('');
  });

  it('defaults to the baseline tone when none is set', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(typeof pickTaskCreatedQuip(undefined)).toBe('string');
  });
});
