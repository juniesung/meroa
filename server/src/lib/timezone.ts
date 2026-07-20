import { z } from 'zod';

// Intl throws RangeError for any string that isn't a real IANA zone — the
// standard way to validate one without shipping a name list of our own.
// Every "due today"/recurrence-anchor calculation downstream (task
// materializer, the AI's own date reasoning) trusts users.timezone is a
// real zone Intl.DateTimeFormat/toLocaleString can key off; an unvalidated
// value like "Not/A_Real_Zone" would reach those call sites and throw at
// runtime instead of failing here, at the boundary, with a clean 400.
export function isValidIanaTimeZone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const ianaTimezoneSchema = z
  .string()
  .min(1)
  .max(100)
  .refine(isValidIanaTimeZone, { message: 'timezone must be a valid IANA time zone name' });
