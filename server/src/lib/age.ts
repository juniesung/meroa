// The age gate. Minimum age is 13 (US COPPA floor, and what the Terms state —
// see legal-copy-decisions). Enforced HERE, in code, on the message endpoint —
// not just in the client nav guard — so a client that skipped the gate (or an
// old build) still can't reach the app's core. Same posture as the AI-consent
// boundary (lib/consent.ts): a guarantee lives in code, not a screen.
export const MIN_AGE = 13;

// Whole years between a YYYY-MM-DD date of birth and now. Returns null if dob is
// absent or unparseable (so callers can distinguish "not provided" from "young").
export function ageFromDob(dob: unknown, now: Date = new Date()): number | null {
  if (typeof dob !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dob)) return null;
  const [y, m, d] = dob.split('-').map(Number);
  if (!y || !m || !d) return null;
  let age = now.getUTCFullYear() - y;
  // Subtract a year if this year's birthday hasn't happened yet.
  const monthNow = now.getUTCMonth() + 1;
  const dayNow = now.getUTCDate();
  if (monthNow < m || (monthNow === m && dayNow < d)) age -= 1;
  return age;
}

// True only when a dob is present AND resolves to under MIN_AGE. A missing dob is
// NOT "under age" — it means the gate hasn't been answered yet (the client routes
// those to the age-gate screen); the server simply hasn't been told, so it
// doesn't block on absence here (the message endpoint independently requires the
// gate to have been passed via the client flow + consent).
export function isUnderMinAge(prefs: unknown): boolean {
  const dob = (prefs as { dob?: unknown } | null | undefined)?.dob;
  const age = ageFromDob(dob);
  return age !== null && age < MIN_AGE;
}
