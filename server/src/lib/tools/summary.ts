import { and, desc, eq, inArray, isNull } from 'drizzle-orm';

import { db } from '../../db/client.ts';
import { records, toolEntries } from '../../db/schema.ts';
import { addDaysToYmd, formatYmdShort, ymdInTz, weekdayOfYmd } from '../tasks/recurrence.ts';
import type { Weekday } from '../tasks/schema.ts';
import type { ToolRow } from './executor.ts';
import type { ToolDefinition, ToolView } from './schema.ts';

// All chart/streak/total math lives here, computed once server-side in the
// account's own timezone — the model and the client both only ever render
// what this returns (docs/ai-reliability-hardening.md lesson 6: never make
// either side do the arithmetic itself; lesson 12: keep date-bucketing
// timezone-consistent between client and server).
export type LiveEntry = { entryAt: Date; data: Record<string, unknown> };

const WEEKDAY_INDEX: Record<Weekday, number> = { mo: 0, tu: 1, we: 2, th: 3, fr: 4, sa: 5, su: 6 };

function weekStartYmd(ymd: string, tz: string): string {
  return addDaysToYmd(ymd, -WEEKDAY_INDEX[weekdayOfYmd(ymd, tz)]);
}

function dayLabel(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString(undefined, {
    timeZone: 'UTC',
    weekday: 'short',
  });
}

function readNumericValue(data: Record<string, unknown>, fieldId: string | undefined): number {
  if (!fieldId) return 0;
  const v = data[fieldId];
  return typeof v === 'number' ? v : 0;
}

function sumField(entries: LiveEntry[], fieldId: string): number {
  return entries.reduce((sum, e) => sum + readNumericValue(e.data, fieldId), 0);
}

function formatNumber(n: number): string {
  return Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

// --- fetch (live entries = tool_entries whose backing record was never
// undone; summary.ts is the only place that reads entries for display, so
// this filter is the single source of truth for "still counts") ----------

async function fetchLiveEntries(toolId: string): Promise<LiveEntry[]> {
  const rows = await db
    .select({ entryAt: toolEntries.entryAt, data: toolEntries.data })
    .from(toolEntries)
    .innerJoin(records, eq(toolEntries.recordId, records.id))
    .where(and(eq(toolEntries.toolId, toolId), isNull(records.revertedAt)))
    .orderBy(desc(toolEntries.entryAt));
  return rows.map((r) => ({ entryAt: r.entryAt, data: r.data as Record<string, unknown> }));
}

// Batched form for the tools list — one query for every tool's entries
// instead of one query per tool (the N+1 the old GET /tools list had).
async function fetchLiveEntriesForTools(toolIds: string[]): Promise<Map<string, LiveEntry[]>> {
  const byTool = new Map<string, LiveEntry[]>();
  if (toolIds.length === 0) return byTool;
  const rows = await db
    .select({ toolId: toolEntries.toolId, entryAt: toolEntries.entryAt, data: toolEntries.data })
    .from(toolEntries)
    .innerJoin(records, eq(toolEntries.recordId, records.id))
    .where(and(inArray(toolEntries.toolId, toolIds), isNull(records.revertedAt)))
    .orderBy(desc(toolEntries.entryAt));
  for (const r of rows) {
    const list = byTool.get(r.toolId) ?? [];
    list.push({ entryAt: r.entryAt, data: r.data as Record<string, unknown> });
    byTool.set(r.toolId, list);
  }
  return byTool;
}

// --- pure computation (no I/O — testable in isolation) ------------------

/**
 * Consecutive days with >=1 live entry, counting back from today. If today
 * has no entry yet, counting starts from yesterday instead — a streak isn't
 * broken until the day has fully elapsed, matching how the tasks executor
 * treats "overdue" (lib/ai/actions.ts's isOverdue reasoning).
 */
export function computeStreak(entries: LiveEntry[], tz: string, now: Date): number {
  const daysWithEntry = new Set(entries.map((e) => ymdInTz(e.entryAt, tz)));
  const todayYmd = ymdInTz(now, tz);
  let cursor = daysWithEntry.has(todayYmd) ? todayYmd : addDaysToYmd(todayYmd, -1);
  if (!daysWithEntry.has(cursor)) return 0;
  let streak = 0;
  while (daysWithEntry.has(cursor)) {
    streak += 1;
    cursor = addDaysToYmd(cursor, -1);
  }
  return streak;
}

export function computeChartBuckets(
  view: Extract<ToolView, { kind: 'bars' }>,
  entries: LiveEntry[],
  tz: string,
  now: Date,
): { label: string; ymd: string; value: number }[] {
  const todayYmd = ymdInTz(now, tz);

  if (view.bucket === 'day') {
    const buckets = Array.from({ length: 7 }, (_, i) => {
      const ymd = addDaysToYmd(todayYmd, -(6 - i));
      return { ymd, label: dayLabel(ymd), value: 0 };
    });
    const byYmd = new Map(buckets.map((b) => [b.ymd, b]));
    for (const e of entries) {
      const bucket = byYmd.get(ymdInTz(e.entryAt, tz));
      if (bucket) bucket.value += view.measure === 'count' ? 1 : readNumericValue(e.data, view.fieldId);
    }
    return buckets;
  }

  const currentWeekStart = weekStartYmd(todayYmd, tz);
  const buckets = Array.from({ length: 8 }, (_, i) => {
    const ymd = addDaysToYmd(currentWeekStart, -7 * (7 - i));
    return { ymd, label: formatYmdShort(ymd), value: 0 };
  });
  const byWeekStart = new Map(buckets.map((b) => [b.ymd, b]));
  for (const e of entries) {
    const bucket = byWeekStart.get(weekStartYmd(ymdInTz(e.entryAt, tz), tz));
    if (bucket) bucket.value += view.measure === 'count' ? 1 : readNumericValue(e.data, view.fieldId);
  }
  return buckets;
}

export type ToolCardSummary = {
  headline: string;
  sub: string;
  progress: number | null;
};

function computeProgress(
  definition: ToolDefinition,
  total: number | null,
  entriesToday: number,
  entriesThisWeek: number,
): number | null {
  const target = definition.target;
  if (!target) return null;
  if (target.kind === 'total') {
    if (total == null) return null;
    return Math.min(1, Math.max(0, total / target.value));
  }
  const count = target.period === 'day' ? entriesToday : entriesThisWeek;
  return Math.min(1, Math.max(0, count / target.value));
}

function pluralNoun(noun: string): string {
  return noun.endsWith('s') ? noun : `${noun}s`;
}

function countLabel(count: number, noun: string): string {
  return `${count} ${count === 1 ? noun : pluralNoun(noun)}`;
}

export function computeCardSummary(
  definition: ToolDefinition,
  entries: LiveEntry[],
  tz: string,
  now: Date,
): ToolCardSummary {
  const noun = definition.entryNoun ?? 'entry';
  const entryCount = entries.length;
  const lastEntryAt = entries[0]?.entryAt ?? null;

  const primaryField = definition.fields.find((f) => f.id === definition.primaryFieldId);
  const total = primaryField ? sumField(entries, primaryField.id) : null;

  const todayYmd = ymdInTz(now, tz);
  const weekStart = weekStartYmd(todayYmd, tz);
  const entriesToday = entries.filter((e) => ymdInTz(e.entryAt, tz) === todayYmd).length;
  const entriesThisWeek = entries.filter((e) => {
    const ymd = ymdInTz(e.entryAt, tz);
    return ymd >= weekStart && ymd <= todayYmd;
  }).length;
  const streak = computeStreak(entries, tz, now);
  const progress = computeProgress(definition, total, entriesToday, entriesThisWeek);

  const target = definition.target;
  if (target?.kind === 'total' && total != null) {
    const unit = target.unit ? ` ${target.unit}` : '';
    return {
      headline: `${formatNumber(total)}${unit} / ${formatNumber(target.value)}${unit}`,
      sub: countLabel(entryCount, noun) + ' logged',
      progress,
    };
  }
  if (target?.kind === 'count_per_period') {
    const count = target.period === 'day' ? entriesToday : entriesThisWeek;
    const periodLabel = target.period === 'day' ? 'today' : 'this week';
    return {
      headline: `${count}/${target.value} ${periodLabel}`,
      sub: streak > 0 ? `${streak}-day streak` : `${countLabel(entryCount, noun)} logged`,
      progress,
    };
  }
  if (total != null) {
    const unit = primaryField?.unit ? ` ${primaryField.unit}` : '';
    return { headline: `${formatNumber(total)}${unit}`, sub: `${countLabel(entryCount, noun)} logged`, progress };
  }
  if (streak > 0) {
    return { headline: `${streak}-day streak`, sub: `${countLabel(entryCount, noun)} logged`, progress };
  }
  if (entryCount === 0) return { headline: 'No entries yet', sub: 'Log your first one', progress: null };
  return {
    headline: countLabel(entryCount, noun),
    sub: lastEntryAt ? `Last ${formatYmdShort(ymdInTz(lastEntryAt, tz))}` : '',
    progress,
  };
}

// --- I/O-backed entry points ---------------------------------------------

export type ToolViewData =
  | { kind: 'progress_total'; total: number | null; targetValue: number | null; unit: string | null; progress: number | null }
  | { kind: 'streak'; streak: number }
  | { kind: 'bars'; bucket: 'day' | 'week'; buckets: { label: string; ymd: string; value: number }[] }
  | { kind: 'recent_list' };

export type ToolDetail = {
  card: ToolCardSummary;
  views: ToolViewData[];
  entryCount: number;
  lastEntryAt: string | null;
};

function buildViews(definition: ToolDefinition, entries: LiveEntry[], tz: string, now: Date): ToolViewData[] {
  const primaryField = definition.fields.find((f) => f.id === definition.primaryFieldId);
  const total = primaryField ? sumField(entries, primaryField.id) : null;
  const todayYmd = ymdInTz(now, tz);
  const weekStart = weekStartYmd(todayYmd, tz);
  const entriesToday = entries.filter((e) => ymdInTz(e.entryAt, tz) === todayYmd).length;
  const entriesThisWeek = entries.filter((e) => {
    const ymd = ymdInTz(e.entryAt, tz);
    return ymd >= weekStart && ymd <= todayYmd;
  }).length;
  const progress = computeProgress(definition, total, entriesToday, entriesThisWeek);

  return definition.views.map((view): ToolViewData => {
    switch (view.kind) {
      case 'progress_total': {
        const target = definition.target?.kind === 'total' ? definition.target : null;
        return {
          kind: 'progress_total',
          total,
          targetValue: target?.value ?? null,
          unit: target?.unit ?? primaryField?.unit ?? null,
          progress,
        };
      }
      case 'streak':
        return { kind: 'streak', streak: computeStreak(entries, tz, now) };
      case 'bars':
        return { kind: 'bars', bucket: view.bucket, buckets: computeChartBuckets(view, entries, tz, now) };
      case 'recent_list':
        return { kind: 'recent_list' };
    }
  });
}

export async function buildToolDetail(tool: ToolRow, timezone: string | null): Promise<ToolDetail> {
  const tz = timezone ?? 'UTC';
  const now = new Date();
  const definition = tool.definition as ToolDefinition;
  const entries = await fetchLiveEntries(tool.id);

  return {
    card: computeCardSummary(definition, entries, tz, now),
    views: buildViews(definition, entries, tz, now),
    entryCount: entries.length,
    lastEntryAt: entries[0]?.entryAt.toISOString() ?? null,
  };
}

/** Batched card summaries for the tools list — one query total, not one per tool. */
export async function buildToolCardSummaries(
  tools: ToolRow[],
  timezone: string | null,
): Promise<Map<string, ToolCardSummary & { entryCount: number; lastEntryAt: Date | null }>> {
  const tz = timezone ?? 'UTC';
  const now = new Date();
  const entriesByTool = await fetchLiveEntriesForTools(tools.map((t) => t.id));
  const result = new Map<string, ToolCardSummary & { entryCount: number; lastEntryAt: Date | null }>();
  for (const tool of tools) {
    const entries = entriesByTool.get(tool.id) ?? [];
    const card = computeCardSummary(tool.definition as ToolDefinition, entries, tz, now);
    result.set(tool.id, { ...card, entryCount: entries.length, lastEntryAt: entries[0]?.entryAt ?? null });
  }
  return result;
}
