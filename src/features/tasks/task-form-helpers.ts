import type { Recurrence, Weekday } from '@/lib/api/types';

export type DueChoice = 'none' | 'today' | 'tomorrow';
export type RecurrenceChoice = 'none' | 'daily' | 'weekly' | 'every_n';

export function normalizeTime(raw: string): string | undefined {
  const match = raw.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return undefined;
  const hh = Number(match[1]);
  const mm = Number(match[2]);
  if (hh > 23 || mm > 59) return undefined;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/** Renders a "HH:mm" (or empty) string as a Date for the native time picker — defaults to 9:00 AM. */
export function hhmmToDate(hhmm: string): Date {
  const normalized = normalizeTime(hhmm);
  const [hh, mm] = normalized ? normalized.split(':').map(Number) : [9, 0];
  const date = new Date();
  date.setHours(hh!, mm!, 0, 0);
  return date;
}

export function dateToHhmm(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function formatHhmmDisplay(hhmm: string): string {
  return hhmmToDate(hhmm).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function buildDueAtIso(choice: DueChoice, time: string): string | undefined {
  if (choice === 'none') return undefined;
  const date = new Date();
  if (choice === 'tomorrow') date.setDate(date.getDate() + 1);
  const normalized = normalizeTime(time);
  const [hh, mm] = normalized ? normalized.split(':').map(Number) : [9, 0];
  date.setHours(hh!, mm!, 0, 0);
  return date.toISOString();
}

export function dueChoiceFromIso(iso: string | null): { choice: DueChoice; time: string } {
  if (!iso) return { choice: 'none', time: '' };
  const date = new Date(iso);
  const today = new Date();
  const isToday = date.toDateString() === today.toDateString();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const isTomorrow = date.toDateString() === tomorrow.toDateString();
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  return { choice: isToday ? 'today' : isTomorrow ? 'tomorrow' : 'today', time };
}

export function buildRecurrence(
  choice: RecurrenceChoice,
  weekdays: Weekday[],
  everyN: string,
  time: string,
): Recurrence | undefined {
  const normalizedTime = normalizeTime(time);
  if (choice === 'daily') return { freq: 'daily', time: normalizedTime };
  if (choice === 'weekly')
    return weekdays.length
      ? { freq: 'weekly', byWeekday: weekdays, time: normalizedTime }
      : undefined;
  if (choice === 'every_n') {
    const n = Number.parseInt(everyN, 10);
    return Number.isFinite(n) && n >= 2
      ? { freq: 'every_n_days', n, time: normalizedTime }
      : undefined;
  }
  return undefined;
}

export function recurrenceChoiceFrom(recurrence: Recurrence | null): {
  choice: RecurrenceChoice;
  weekdays: Weekday[];
  everyN: string;
  time: string;
} {
  if (!recurrence) return { choice: 'none', weekdays: [], everyN: '2', time: '' };
  const time = recurrence.time ?? '';
  if (recurrence.freq === 'daily') return { choice: 'daily', weekdays: [], everyN: '2', time };
  if (recurrence.freq === 'weekly')
    return { choice: 'weekly', weekdays: recurrence.byWeekday, everyN: '2', time };
  return { choice: 'every_n', weekdays: [], everyN: String(recurrence.n), time };
}
