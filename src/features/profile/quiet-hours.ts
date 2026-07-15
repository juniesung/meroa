export type QuietHours = { enabled: boolean; start: string; end: string };

export const DEFAULT_QUIET_HOURS: QuietHours = { enabled: false, start: '22:00', end: '08:00' };

export function readQuietHours(prefs: Record<string, unknown> | undefined): QuietHours {
  const raw = prefs?.quietHours;
  if (!raw || typeof raw !== 'object') return DEFAULT_QUIET_HOURS;
  const r = raw as Record<string, unknown>;
  return {
    enabled: r.enabled === true,
    start: typeof r.start === 'string' ? r.start : DEFAULT_QUIET_HOURS.start,
    end: typeof r.end === 'string' ? r.end : DEFAULT_QUIET_HOURS.end,
  };
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h! * 60 + m!;
}

/**
 * Whether `date` (read in local time) falls inside the quiet window.
 * Handles windows that cross midnight (e.g. 22:00 -> 08:00) — the common
 * case, since a quiet window is usually "tonight into tomorrow morning".
 * A zero-length window (start === end) is treated as disabled rather than
 * as "block the whole day" — an equal pair is far more likely to be an
 * unfinished edit than an intentional 24-hour quiet period.
 */
export function isWithinQuietHours(quiet: QuietHours, date: Date): boolean {
  if (!quiet.enabled) return false;
  const startMin = toMinutes(quiet.start);
  const endMin = toMinutes(quiet.end);
  if (startMin === endMin) return false;
  const nowMin = date.getHours() * 60 + date.getMinutes();
  if (startMin < endMin) return nowMin >= startMin && nowMin < endMin;
  return nowMin >= startMin || nowMin < endMin;
}

/**
 * The next moment `date` exits the quiet window it falls in — used to shift
 * a reminder rather than drop it (CLAUDE.md: quiet hours mean nothing pings
 * *during* them, not that the reminder is lost). Assumes
 * `isWithinQuietHours(quiet, date)` is true; behavior otherwise is
 * unspecified.
 */
export function nextQuietHoursEnd(quiet: QuietHours, date: Date): Date {
  const endMin = toMinutes(quiet.end);
  const result = new Date(date);
  result.setHours(Math.floor(endMin / 60), endMin % 60, 0, 0);
  // Covers both wrap cases at once: a same-day window's end is always later
  // today (so this never fires); a midnight-crossing window's end lands
  // before `date` only when `date` is still in the pre-midnight half, which
  // means the real end is tomorrow.
  if (result <= date) result.setDate(result.getDate() + 1);
  return result;
}
