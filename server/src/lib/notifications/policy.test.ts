import { describe, expect, it } from 'vitest';

import { env } from '../../env.ts';
import { effectiveCap, isWithinQuietHours, readQuietHours } from './policy.ts';

// The server evaluates quiet hours against the user's LOCAL time (resolved from
// their IANA timezone), not the server clock — these lock that math down,
// including the midnight-crossing window and the disabled/zero-length cases the
// client shares.
describe('isWithinQuietHours', () => {
  const quiet = { quietHours: { enabled: true, start: '22:00', end: '08:00' } };
  // 2026-07-21T06:00Z — a fixed instant we reinterpret in different zones.
  const at06Utc = new Date('2026-07-21T06:00:00Z');

  it('is within the overnight window in a zone where it is 02:00 local', () => {
    // America/New_York is UTC-4 in July → 02:00, inside 22:00–08:00.
    expect(isWithinQuietHours(quiet, 'America/New_York', at06Utc)).toBe(true);
  });

  it('is outside the window in a zone where it is mid-afternoon', () => {
    // Asia/Tokyo is UTC+9 → 15:00, outside 22:00–08:00.
    expect(isWithinQuietHours(quiet, 'Asia/Tokyo', at06Utc)).toBe(false);
  });

  it('handles a same-day (non-crossing) window', () => {
    const daytime = { quietHours: { enabled: true, start: '09:00', end: '17:00' } };
    // 13:00 UTC in UTC → inside 09:00–17:00.
    expect(isWithinQuietHours(daytime, 'UTC', new Date('2026-07-21T13:00:00Z'))).toBe(true);
    expect(isWithinQuietHours(daytime, 'UTC', new Date('2026-07-21T18:00:00Z'))).toBe(false);
  });

  it('treats disabled and zero-length windows as never quiet', () => {
    expect(isWithinQuietHours({ quietHours: { enabled: false, start: '22:00', end: '08:00' } }, 'UTC', at06Utc)).toBe(
      false,
    );
    expect(isWithinQuietHours({ quietHours: { enabled: true, start: '08:00', end: '08:00' } }, 'UTC', at06Utc)).toBe(
      false,
    );
  });

  it('falls back to UTC when timezone is null', () => {
    // 06:00 UTC is inside 22:00–08:00.
    expect(isWithinQuietHours(quiet, null, at06Utc)).toBe(true);
  });
});

describe('readQuietHours', () => {
  it('defaults a missing block to disabled 22:00–08:00', () => {
    expect(readQuietHours(null)).toEqual({ enabled: false, start: '22:00', end: '08:00' });
    expect(readQuietHours({})).toEqual({ enabled: false, start: '22:00', end: '08:00' });
  });
});

// The frequency cap only ever tightens the server ceiling — a user can ask for
// fewer proactive pushes, never more (CLAUDE.md §2's proactive-message limit).
describe('effectiveCap', () => {
  it('uses the server ceiling when no override is set', () => {
    expect(effectiveCap(null)).toEqual({ perDay: env.NOTIFY_MAX_PER_DAY, perWeek: env.NOTIFY_MAX_PER_WEEK });
  });

  it('lets a user request fewer', () => {
    expect(effectiveCap({ notificationCap: { perDay: 0, perWeek: 1 } })).toEqual({ perDay: 0, perWeek: 1 });
  });

  it('never lets a user exceed the ceiling', () => {
    const cap = effectiveCap({ notificationCap: { perDay: 999, perWeek: 999 } });
    expect(cap.perDay).toBe(env.NOTIFY_MAX_PER_DAY);
    expect(cap.perWeek).toBe(env.NOTIFY_MAX_PER_WEEK);
  });
});
