import { isWithinQuietHours, nextQuietHoursEnd, type QuietHours } from '@/features/profile/quiet-hours';
import type { ApiTask, DurationConfig, Recurrence, Weekday } from './api/types';

// Anything due further out than this gets picked up by a later sync (the tasks
// query refreshes often enough, and every foreground reschedules) — scheduling
// isn't a set-and-forget calendar, so there's no need to look further ahead
// than a user will plausibly leave the app closed.
export const REMINDER_WINDOW_DAYS = 7;

// iOS silently drops pending local notifications past ~64. Cap the due-reminder
// pass well under that so a user with many tasks (and a recurring template
// fanning out across the window) can't starve the timer alert or the re-
// engagement nudge, which are always kept.
const MAX_DUE_REMINDERS = 32;

// How long after the app was last active the "haven't seen you" nudge lands.
// Every sync (foreground or a settling query) cancels and reschedules it, so
// it only ever fires for someone who has genuinely drifted away — opening the
// app pushes it back out of reach.
const REENGAGE_AFTER_DAYS = 2;

export type PlannedReminder = {
  // Stable-ish identity for debugging/dedup; not used by the OS.
  key: string;
  title: string;
  body: string;
  date: Date;
  data: { taskId?: string; kind?: 'timer' | 'reminder' | 'reengage' };
};

// --- friend-tone copy ------------------------------------------------------
// Static pools (personalization/vibe is a server concern; the client can't see
// the preset, so this stays gently neutral — warm, brief, never guilt-y).
// A stable per-task index keeps a given task on the same line across reschedules
// instead of flip-flopping every sync, while different tasks read differently.

const DUE_LINES = [
  (t: string) => `still on for ${t}?`,
  (t: string) => `time for ${t}`,
  (t: string) => `${t} — you've got this`,
  (t: string) => `ready for ${t}?`,
  (t: string) => `quick one: ${t}`,
];

const REENGAGE_LINES = [
  "been a little while — how's it going?",
  'thinking of you. how are things?',
  "here whenever you're ready to pick things back up.",
];

// Deterministic, dependency-free string hash → stable index into a pool.
function stableIndex(seed: string, len: number): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return Math.abs(h) % len;
}

export function reminderBody(task: ApiTask): string {
  const line = DUE_LINES[stableIndex(task.id, DUE_LINES.length)]!;
  if (task.type === 'duration') {
    const mins = (task.config as DurationConfig).targetMinutes;
    return `${line(task.title)} (~${mins} min)`;
  }
  return line(task.title);
}

export function timerDoneBody(task: ApiTask): string {
  return `${task.title} — time's up 🙌`;
}

export function reengageBody(now: number): string {
  // Vary by day so a user who drifts for a while doesn't see the identical
  // line every couple days, without any randomness (keeps it deterministic).
  const dayIndex = Math.floor(now / 86_400_000);
  return REENGAGE_LINES[dayIndex % REENGAGE_LINES.length]!;
}

// --- local recurrence math (device-local wall clock) -----------------------
// Mirrors the server's timezone-free ymd-string helpers (lib/tasks/
// recurrence.ts), but anchored to the *device's* local calendar — the same
// basis quiet hours already use on the client, and normally the account's
// timezone anyway. The server only ever materializes a recurring instance for
// *today*, so without expanding future occurrences here a recurring reminder
// would only cover the current day and only while the app is being opened.

function localYmd(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function daysBetweenYmd(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number) as [number, number, number];
  const [by, bm, bd] = b.split('-').map(Number) as [number, number, number];
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

const WEEKDAY_BY_INDEX: Weekday[] = ['su', 'mo', 'tu', 'we', 'th', 'fr', 'sa'];

function weekdayOfYmd(ymd: string): Weekday {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  // Noon-anchored so no DST/offset quirk can shift the weekday to an adjacent
  // day. getUTCDay because the components are already a resolved local date.
  return WEEKDAY_BY_INDEX[new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay()]!;
}

function isDueOn(rec: Recurrence, ymd: string, anchorYmd: string): boolean {
  if (rec.freq === 'daily') return true;
  if (rec.freq === 'weekly') return rec.byWeekday.includes(weekdayOfYmd(ymd));
  const diff = daysBetweenYmd(anchorYmd, ymd);
  return diff >= 0 && diff % rec.n === 0;
}

// The concrete future fire instants for a recurring template within the window.
// Only time-specific recurrences get a pre-scheduled ping — a date-only
// recurrence has no meaningful clock time to notify at (pinging at 23:59 is
// noise, not a reminder), which matches "never invent a number/time".
function recurringFireDates(
  template: ApiTask,
  now: number,
  windowEnd: number,
  doneToday: boolean,
): Date[] {
  const rec = template.recurrence;
  if (!rec || !rec.time) return [];
  const [hh, mm] = rec.time.split(':').map(Number) as [number, number];
  const anchorYmd = localYmd(new Date(template.dueAt ?? template.createdAt));
  const todayYmd = localYmd(new Date(now));

  const out: Date[] = [];
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  for (let i = 0; i <= REMINDER_WINDOW_DAYS; i++) {
    const cur = new Date(day);
    cur.setDate(cur.getDate() + i);
    const ymd = localYmd(cur);
    // Don't nag for a day whose occurrence the user already completed (only
    // today's instance realistically exists, but this keeps it honest).
    if (doneToday && ymd === todayYmd) continue;
    if (!isDueOn(rec, ymd, anchorYmd)) continue;
    const fire = new Date(cur);
    fire.setHours(hh, mm, 0, 0);
    const t = fire.getTime();
    if (t <= now || t > windowEnd) continue;
    out.push(fire);
  }
  return out;
}

// --- the plan --------------------------------------------------------------

function shiftOutOfQuietHours(date: Date, quietHours: QuietHours): Date {
  // A reminder that would land in the quiet window is moved to the window's
  // end rather than dropped — a silenced reminder is still a lost reminder.
  return isWithinQuietHours(quietHours, date) ? nextQuietHoursEnd(quietHours, date) : date;
}

// If several reminders collapse onto the same instant (common when quiet hours
// shift a batch to one window-end moment), fan them out a minute apart so they
// arrive as a readable sequence instead of one indistinguishable pile.
function stagger(reminders: PlannedReminder[]): PlannedReminder[] {
  const sorted = [...reminders].sort((a, b) => a.date.getTime() - b.date.getTime());
  let prev = -Infinity;
  for (const r of sorted) {
    let t = r.date.getTime();
    if (t <= prev) {
      t = prev + 60_000;
      r.date = new Date(t);
    }
    prev = t;
  }
  return sorted;
}

/**
 * The full set of local notifications to schedule, computed purely from the
 * current task list — no side effects, no expo import, so it's trivially
 * inspectable and testable. `syncTaskReminders` in lib/notifications.ts is the
 * thin expo shell that cancels everything and schedules exactly this.
 *
 * - Running-timer completion alerts are always included (a timer's alert is the
 *   direct result of the user starting it, not proactive outreach — so it's not
 *   gated by `enabled` or quiet hours).
 * - Everything else (due reminders, the re-engagement nudge) only appears when
 *   `enabled` (the proactiveCheckins pref) is true, and is shifted around quiet
 *   hours.
 */
export function planReminders(input: {
  tasks: ApiTask[];
  enabled: boolean;
  quietHours: QuietHours;
  now: number;
}): PlannedReminder[] {
  const { tasks, enabled, quietHours, now } = input;
  const plan: PlannedReminder[] = [];

  // 1. Running-timer completion alerts (ungated).
  for (const task of tasks) {
    if (task.type !== 'duration' || task.status !== 'open') continue;
    const config = task.config as DurationConfig;
    if (!config.runningSince) continue;
    const elapsedMs = now - new Date(config.runningSince).getTime();
    const remainingMs = (config.targetMinutes - config.loggedMinutes) * 60_000 - elapsedMs;
    if (remainingMs <= 0) continue;
    plan.push({
      key: `timer:${task.id}`,
      title: 'Meroa',
      body: timerDoneBody(task),
      date: new Date(now + remainingMs),
      data: { taskId: task.id, kind: 'timer' },
    });
  }

  if (!enabled) return plan;

  const windowEnd = now + REMINDER_WINDOW_DAYS * 24 * 60 * 60 * 1000;

  // Which recurring templates already have a completed instance for today, so
  // the expansion below doesn't ping after the user's already done it.
  const todayYmd = localYmd(new Date(now));
  const doneTemplatesToday = new Set<string>();
  for (const task of tasks) {
    if (task.templateId && task.status === 'done' && task.occurrenceDate === todayYmd) {
      doneTemplatesToday.add(task.templateId);
    }
  }

  // 2. Due-time reminders — one-off tasks directly, recurring templates by
  //    expanding their future occurrences across the window.
  const due: PlannedReminder[] = [];
  for (const task of tasks) {
    if (!(task.config as { reminder?: boolean }).reminder) continue;

    if (task.recurrence) {
      if (task.status === 'archived') continue;
      const fires = recurringFireDates(task, now, windowEnd, doneTemplatesToday.has(task.id));
      for (const fire of fires) {
        due.push({
          key: `reminder:${task.id}:${fire.getTime()}`,
          title: 'Meroa',
          body: reminderBody(task),
          date: shiftOutOfQuietHours(fire, quietHours),
          data: { taskId: task.id, kind: 'reminder' },
        });
      }
      continue;
    }

    // A materialized recurring instance is covered by its template's expansion
    // above — skip it here so the two don't double-schedule the same day.
    if (task.templateId) continue;
    if (task.status !== 'open' || !task.dueAt) continue;
    const dueAt = new Date(task.dueAt).getTime();
    if (dueAt <= now || dueAt > windowEnd) continue;
    due.push({
      key: `reminder:${task.id}`,
      title: 'Meroa',
      body: reminderBody(task),
      date: shiftOutOfQuietHours(new Date(dueAt), quietHours),
      data: { taskId: task.id, kind: 'reminder' },
    });
  }

  // Keep the earliest reminders if we're over the safety cap, then fan out any
  // that collapsed onto the same instant.
  const capped = stagger(due).slice(0, MAX_DUE_REMINDERS);
  plan.push(...capped);

  // 3. The decaying "haven't seen you" re-engagement nudge — the one local-only
  //    win-back move. Rescheduled every sync, so it only lands for someone who
  //    truly drifted away. (A proper personalized win-back is server push.)
  const nudgeAt = shiftOutOfQuietHours(
    new Date(now + REENGAGE_AFTER_DAYS * 24 * 60 * 60 * 1000),
    quietHours,
  );
  plan.push({
    key: 'reengage',
    title: 'Meroa',
    body: reengageBody(now),
    date: nudgeAt,
    data: { kind: 'reengage' },
  });

  return plan;
}
