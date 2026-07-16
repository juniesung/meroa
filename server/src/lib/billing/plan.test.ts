import { describe, expect, it } from 'vitest';

import { resolvePlan } from './plan.ts';

describe('resolvePlan', () => {
  it('no row at all is free', () => {
    expect(resolvePlan(undefined)).toBe('free');
  });

  it('plan free stays free regardless of expiresAt', () => {
    expect(resolvePlan({ plan: 'free', expiresAt: null })).toBe('free');
    expect(resolvePlan({ plan: 'free', expiresAt: new Date(Date.now() + 100000) })).toBe('free');
  });

  it('plus with no expiry is plus', () => {
    expect(resolvePlan({ plan: 'plus', expiresAt: null })).toBe('plus');
  });

  it('plus with a future expiry is plus', () => {
    expect(resolvePlan({ plan: 'plus', expiresAt: new Date(Date.now() + 100000) })).toBe('plus');
  });

  // The lazy-expiry guarantee: a missed/delayed webhook must not leave a
  // lapsed subscriber on Plus indefinitely — every read resolves this fresh.
  it('plus with a past expiry resolves to free', () => {
    expect(resolvePlan({ plan: 'plus', expiresAt: new Date(Date.now() - 1000) })).toBe('free');
  });
});
