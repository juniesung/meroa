import { describe, expect, it } from 'vitest';

import { AI_CONSENT_VERSION } from './constants.ts';
import { hasValidAiConsent } from './consent.ts';

describe('hasValidAiConsent', () => {
  it('rejects when consent is entirely absent', () => {
    expect(hasValidAiConsent({})).toBe(false);
    expect(hasValidAiConsent(null)).toBe(false);
    expect(hasValidAiConsent(undefined)).toBe(false);
    expect(hasValidAiConsent({ communicationStyle: 'chill' })).toBe(false);
  });

  it('accepts a current, granted consent', () => {
    expect(
      hasValidAiConsent({ aiConsent: { granted: true, at: '2026-07-20T00:00:00Z', version: AI_CONSENT_VERSION } }),
    ).toBe(true);
  });

  it('rejects a revoked consent even at the current version', () => {
    expect(
      hasValidAiConsent({ aiConsent: { granted: false, at: '2026-07-20T00:00:00Z', version: AI_CONSENT_VERSION } }),
    ).toBe(false);
  });

  it('rejects consent granted to an older disclosure version (forces a re-prompt)', () => {
    expect(
      hasValidAiConsent({ aiConsent: { granted: true, at: '2026-07-20T00:00:00Z', version: AI_CONSENT_VERSION - 1 } }),
    ).toBe(false);
  });

  it('accepts a future version (a newer client than the server knows about)', () => {
    expect(
      hasValidAiConsent({ aiConsent: { granted: true, at: '2026-07-20T00:00:00Z', version: AI_CONSENT_VERSION + 1 } }),
    ).toBe(true);
  });

  it('rejects a malformed consent blob (missing version, wrong types)', () => {
    expect(hasValidAiConsent({ aiConsent: { granted: true } })).toBe(false);
    expect(hasValidAiConsent({ aiConsent: { granted: 'yes', version: AI_CONSENT_VERSION } })).toBe(false);
    expect(hasValidAiConsent({ aiConsent: true })).toBe(false);
  });
});
