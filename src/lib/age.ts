// Client mirror of server/src/lib/age.ts — minimum age 13. Kept in sync by hand
// (same as tone.ts mirrors the server's resolveTone). The server is the real
// enforcement boundary (the message endpoint 403s an under-13 dob); this is the
// nav-guard surface + the age-gate screen's local check.
export const MIN_AGE = 13;

export function ageFromDob(dob: unknown, now: Date = new Date()): number | null {
  if (typeof dob !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dob)) return null;
  const [y, m, d] = dob.split('-').map(Number);
  if (!y || !m || !d) return null;
  let age = now.getFullYear() - y;
  const monthNow = now.getMonth() + 1;
  const dayNow = now.getDate();
  if (monthNow < m || (monthNow === m && dayNow < d)) age -= 1;
  return age;
}

// "under 13" — only when a dob is present AND resolves below the floor. A missing
// dob is "not answered yet", not "under age".
export function isUnderMinAge(prefs: unknown): boolean {
  const dob = (prefs as { dob?: unknown } | null | undefined)?.dob;
  const age = ageFromDob(dob);
  return age !== null && age < MIN_AGE;
}

// dob present or not.
export function hasDob(prefs: unknown): boolean {
  return typeof (prefs as { dob?: unknown } | null | undefined)?.dob === 'string';
}

// Format a Date as the YYYY-MM-DD the server stores.
export function toDobString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
