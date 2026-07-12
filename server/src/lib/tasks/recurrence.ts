import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm';

import { db } from '../../db/client.ts';
import { tasks } from '../../db/schema.ts';
import type { ChecklistItem, Recurrence, TaskType, Weekday } from './schema.ts';
import { recurrenceSchema } from './schema.ts';

export type Tx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// Backfilling further than this on first read (e.g. a template nobody has
// opened in months) would produce an unbounded burst of instance rows —
// cap it and jump the cursor forward instead of generating the whole gap.
const MAX_BACKFILL_DAYS = 60;

const WEEKDAY_BY_SHORT: Record<string, Weekday> = {
  mon: 'mo',
  tue: 'tu',
  wed: 'we',
  thu: 'th',
  fri: 'fr',
  sat: 'sa',
  sun: 'su',
};

export function ymdInTz(date: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

// Exported for reuse by lib/tools/summary.ts's chart/streak bucketing — the
// same "no date library, just Intl + UTC-noon-anchored ymd strings"
// approach applies to weekly/daily tool chart buckets as it does to task
// recurrence, and duplicating this math risks the two drifting apart.
export function addDaysToYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function daysBetweenYmd(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number) as [number, number, number];
  const [by, bm, bd] = b.split('-').map(Number) as [number, number, number];
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

export function weekdayOfYmd(ymd: string, tz: string): Weekday {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  const noonUtc = new Date(Date.UTC(y, m - 1, d, 12));
  const short = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' })
    .format(noonUtc)
    .toLowerCase();
  const weekday = WEEKDAY_BY_SHORT[short.slice(0, 3)];
  if (!weekday) throw new Error(`unrecognized weekday format: ${short}`);
  return weekday;
}

// The UTC offset (in minutes) of `tz` at approximately `date`. Formats the
// instant in the target zone, then re-interprets those wall-clock fields as
// UTC and diffs against the original instant — the standard trick for
// getting a timezone's offset without a date library.
function tzOffsetMinutes(date: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return (asUtc - date.getTime()) / 60_000;
}

function ymdAndTimeToUtcDate(ymd: string, time: string, tz: string): Date {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  const [hh, mm] = time.split(':').map(Number) as [number, number];
  const guess = new Date(Date.UTC(y, m - 1, d, hh, mm));
  return new Date(guess.getTime() - tzOffsetMinutes(guess, tz) * 60_000);
}

/**
 * A day's closing instant (23:59:59.999 local) in `tz`, converted to UTC.
 * Used whenever something is due "sometime today/that day" with no specific
 * clock time — never inventing an arbitrary time like 9am, while still
 * giving `dueAt < now` a natural boundary: it only goes overdue once the
 * day has fully elapsed (see rollPastToNextDay's docs and createTask).
 */
export function ymdEndOfDayToUtcDate(ymd: string, tz: string): Date {
  // Computed as "1ms before next midnight" rather than directly resolving
  // 23:59:59.999 through the offset trick — tzOffsetMinutes reads whole
  // seconds back from formatToParts, so applying it straight to an instant
  // that already carries .999ms compounds a sub-second error that can round
  // the wrong way at display time (showed as "12:00 AM" instead of "11:59
  // PM"). Midnight is a clean whole-minute instant, so this sidesteps that.
  const nextMidnight = ymdAndTimeToUtcDate(addDaysToYmd(ymd, 1), '00:00', tz);
  return new Date(nextMidnight.getTime() - 1);
}

const HAS_TZ_DESIGNATOR = /(?:Z|[+-]\d{2}:\d{2})$/;
const LOCAL_DATETIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/;

/**
 * The AI naturally reasons about times as local wall-clock ("7am") and
 * often emits a datetime with no timezone designator — which `new Date()`
 * would silently parse in the *server's* local time, not the user's. This
 * normalizes any datetime string to a proper UTC ISO instant: if it already
 * carries an offset/Z, that's trusted as-is; otherwise its wall-clock
 * fields are interpreted in `tz` using the same offset trick as
 * `ymdAndTimeToUtcDate`. Returns null if the string isn't parseable either way.
 */
export function localDatetimeToUtcIso(raw: string, tz: string): string | null {
  if (HAS_TZ_DESIGNATOR.test(raw)) {
    const withOffset = new Date(raw);
    return Number.isNaN(withOffset.getTime()) ? null : withOffset.toISOString();
  }
  const match = raw.match(LOCAL_DATETIME);
  if (!match) return null;
  const [, y, mo, d, hh, mm, ss] = match;
  const guess = new Date(
    Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mm), ss ? Number(ss) : 0),
  );
  const utc = new Date(guess.getTime() - tzOffsetMinutes(guess, tz) * 60_000);
  return Number.isNaN(utc.getTime()) ? null : utc.toISOString();
}

/**
 * A task shouldn't be born already overdue — if `date` (a due-time being
 * written right now, from create/edit/postpone, UI or AI) has already
 * passed, this bumps it to the same wall-clock time the next calendar day
 * in `tz`, rather than leaving it in the past. Otherwise returns it as-is.
 */
export function rollPastToNextDay(date: Date, tz: string): Date {
  if (date.getTime() > Date.now()) return date;
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
  const nextYmd = addDaysToYmd(ymdInTz(date, tz), 1);
  return ymdAndTimeToUtcDate(nextYmd, time, tz);
}

function isDueOn(recurrence: Recurrence, ymd: string, anchorYmd: string, tz: string): boolean {
  if (recurrence.freq === 'daily') return true;
  if (recurrence.freq === 'weekly') return recurrence.byWeekday.includes(weekdayOfYmd(ymd, tz));
  const diff = daysBetweenYmd(anchorYmd, ymd);
  return diff >= 0 && diff % recurrence.n === 0;
}

function resetConfigForNewInstance(
  type: TaskType,
  templateConfig: Record<string, unknown>,
  dueTimeExplicit: boolean,
): Record<string, unknown> {
  // A template's `reminder` flag ("notify me around this time") carries
  // over to every instance it spawns — otherwise a recurring task with
  // reminders on would only ever notify for the template row itself, which
  // never has a concrete same-day dueAt and is never shown as a due task.
  const reminder = !!templateConfig.reminder;
  switch (type) {
    case 'completion':
      return { dueTimeExplicit, reminder };
    case 'checklist': {
      const items = (templateConfig.items as ChecklistItem[] | undefined) ?? [];
      return { items: items.map((i) => ({ ...i, done: false })), dueTimeExplicit, reminder };
    }
    case 'counter':
      return {
        count: 0,
        target: templateConfig.target,
        unit: templateConfig.unit,
        dueTimeExplicit,
        reminder,
      };
    case 'duration':
      return {
        loggedMinutes: 0,
        targetMinutes: templateConfig.targetMinutes,
        runningSince: null,
        dueTimeExplicit,
        reminder,
      };
  }
}

/**
 * Lazily generates dated instance rows for every recurring template owned by
 * `userId`, from the day after its last-materialized occurrence (or its
 * anchor date, if none yet) through today in the user's timezone. Idempotent
 * under concurrent calls via the partial unique index on
 * (template_id, occurrence_date). Called at the top of every read path that
 * shows tasks (GET /tasks, bootstrap, chat context) — never pre-generates
 * future occurrences.
 */
export async function materializeRecurringInstances(
  userId: string,
  timezone: string | null,
  tx: Tx,
): Promise<void> {
  const tz = timezone ?? 'UTC';
  const todayYmd = ymdInTz(new Date(), tz);

  const templates = await tx
    .select()
    .from(tasks)
    .where(and(eq(tasks.userId, userId), isNotNull(tasks.recurrence), isNull(tasks.deletedAt)));

  for (const template of templates) {
    const recurrence = recurrenceSchema.parse(template.recurrence);
    const anchorYmd = template.dueAt
      ? ymdInTz(template.dueAt, tz)
      : ymdInTz(template.createdAt, tz);

    const [lastInstance] = await tx
      .select({ occurrenceDate: tasks.occurrenceDate })
      .from(tasks)
      .where(eq(tasks.templateId, template.id))
      .orderBy(desc(tasks.occurrenceDate))
      .limit(1);

    let cursor = lastInstance?.occurrenceDate
      ? addDaysToYmd(lastInstance.occurrenceDate, 1)
      : anchorYmd;
    if (daysBetweenYmd(cursor, todayYmd) > MAX_BACKFILL_DAYS) {
      cursor = addDaysToYmd(todayYmd, -MAX_BACKFILL_DAYS);
    }

    // A template's very first occurrence shouldn't be born already overdue —
    // if this is the first time it's ever materializing (no prior instance)
    // and today's slot has already passed, bump just that slot to tomorrow.
    // Backfilled *past* days (an ongoing template that's been dormant/unread
    // for a while) are left alone — those are genuinely missed occurrences,
    // which is the shame-free-recovery flow's whole reason to exist.
    const isFirstEverRun = !lastInstance;

    const toInsert: (typeof tasks.$inferInsert)[] = [];
    while (cursor <= todayYmd) {
      let occurrenceDate = cursor;
      // Only a *specific clock time* can have "already passed today" — a
      // date-only occurrence (no recurrence.time) is due sometime before
      // midnight, so there's no earlier deadline it could have missed yet.
      if (isFirstEverRun && cursor === todayYmd && recurrence.time) {
        const todayInstant = ymdAndTimeToUtcDate(cursor, recurrence.time, tz);
        if (todayInstant.getTime() <= Date.now()) {
          occurrenceDate = addDaysToYmd(cursor, 1);
        }
      }

      if (isDueOn(recurrence, occurrenceDate, anchorYmd, tz)) {
        toInsert.push({
          userId,
          type: template.type,
          title: template.title,
          icon: template.icon,
          config: resetConfigForNewInstance(
            template.type as TaskType,
            (template.config ?? {}) as Record<string, unknown>,
            !!recurrence.time,
          ),
          recurrence: null,
          toolId: template.toolId,
          dueAt: recurrence.time
            ? ymdAndTimeToUtcDate(occurrenceDate, recurrence.time, tz)
            : ymdEndOfDayToUtcDate(occurrenceDate, tz),
          status: 'open',
          templateId: template.id,
          occurrenceDate,
        });
      }
      cursor = addDaysToYmd(cursor, 1);
    }

    if (toInsert.length > 0) {
      await tx.insert(tasks).values(toInsert).onConflictDoNothing();
    }
  }
}

/**
 * The next calendar date (in `tz`) on/after `fromYmd` on which `recurrence`
 * is due, given the template's own anchor day. Used to annotate an off-day
 * recurring template in the AI's context ("next: Jul 14") and to explain why
 * complete/progress/postpone can't act on a template whose alias resolved
 * with no due instance today. `n` is capped at 365 (recurrenceSchema), so
 * this always terminates well inside the iteration bound.
 */
export function nextOccurrenceYmd(
  recurrence: Recurrence,
  template: { dueAt: Date | null; createdAt: Date },
  fromYmd: string,
  tz: string,
): string {
  const anchorYmd = template.dueAt ? ymdInTz(template.dueAt, tz) : ymdInTz(template.createdAt, tz);
  let cursor = addDaysToYmd(fromYmd, 1);
  for (let i = 0; i < 400; i++) {
    if (isDueOn(recurrence, cursor, anchorYmd, tz)) return cursor;
    cursor = addDaysToYmd(cursor, 1);
  }
  return cursor;
}

/** "daily at 10:00" / "weekly on mo,we" / "every 3 days" — short prose for a
 * recurrence, shared by the AI's task-list rendering and its removal-pending
 * summaries. */
export function describeRecurrence(recurrence: Recurrence): string {
  const time = recurrence.time ? ` at ${recurrence.time}` : '';
  if (recurrence.freq === 'daily') return `daily${time}`;
  if (recurrence.freq === 'weekly') return `weekly on ${recurrence.byWeekday.join(',')}${time}`;
  return `every ${recurrence.n} days${time}`;
}

/**
 * "Jul 14" from a plain "YYYY-MM-DD" — anchored at UTC noon so no local
 * timezone offset can shift it onto the adjacent calendar day.
 */
export function formatYmdShort(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString(undefined, {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
  });
}
