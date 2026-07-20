import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { theme } from '@/constants/theme';
import { Icon } from '@/components/Icon';
import type { DayBucket } from '@/lib/api/types';

const CELL = 34;
const GAP = 4;

// Intensity is the day's completion ratio on the app's own blue accent
// (CLAUDE.md §5 — not the dataviz skill's default palette): a day lights up
// in proportion to the share of due tasks finished, hitting the full accent
// exactly when everything due that day was done. Days with nothing done
// (or nothing due) stay unlit.
function cellColor(day: DayBucket): string {
  if (day.dueCount === 0 || day.doneCount === 0) return theme.card2;
  const ratio = Math.min(1, day.doneCount / day.dueCount);
  return `rgba(10,132,255,${(0.18 + 0.82 * ratio).toFixed(3)})`;
}

function formatDayLabel(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString(undefined, {
    timeZone: 'UTC',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

function monthTitle(monthKey: string): string {
  const [y, m] = monthKey.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1, 1, 12)).toLocaleDateString(undefined, {
    timeZone: 'UTC',
    month: 'long',
    year: 'numeric',
  });
}

function summaryFor(day: DayBucket): string {
  if (day.verdict === 'neutral') return `${formatDayLabel(day.ymd)} · nothing due`;
  if (day.verdict === 'perfect') return `${formatDayLabel(day.ymd)} · all ${day.dueCount} done`;
  return `${formatDayLabel(day.ymd)} · ${day.doneCount}/${day.dueCount} done`;
}

export function Heatmap({ calendar }: { calendar: DayBucket[] }) {
  const [selected, setSelected] = useState<DayBucket | null>(null);
  // 0 = the latest (current) month; +1 per page back into history.
  const [monthOffset, setMonthOffset] = useState(0);

  // The server sends whole months, oldest first, ending today
  // (lib/goals/consistency.ts) — grouped here for paging, never re-bucketed.
  const { monthKeys, byYmd, todayYmd } = useMemo(() => {
    const keys: string[] = [];
    const map = new Map<string, DayBucket>();
    for (const day of calendar) {
      const key = day.ymd.slice(0, 7);
      if (keys[keys.length - 1] !== key) keys.push(key);
      map.set(day.ymd, day);
    }
    return { monthKeys: keys, byYmd: map, todayYmd: calendar[calendar.length - 1]?.ymd ?? '' };
  }, [calendar]);

  if (monthKeys.length === 0) return null;

  const clampedOffset = Math.min(monthOffset, monthKeys.length - 1);
  const monthKey = monthKeys[monthKeys.length - 1 - clampedOffset]!;
  const [year, month] = monthKey.split('-').map(Number) as [number, number];
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

  // Reading order: left→right, top→down — cell 1 (the 1st of the month) is
  // top-left, the month's last day is bottom-right. Plain rows of 7, no
  // weekday alignment.
  const rows: (DayBucket | { ymd: string; future: true })[][] = [];
  for (let day = 1; day <= daysInMonth; day++) {
    const ymd = `${monthKey}-${String(day).padStart(2, '0')}`;
    const bucket = byYmd.get(ymd) ?? { ymd, future: true as const };
    if (day % 7 === 1) rows.push([]);
    rows[rows.length - 1]!.push(bucket);
  }

  const canGoBack = clampedOffset < monthKeys.length - 1;
  const canGoForward = clampedOffset > 0;

  return (
    <View style={styles.wrap}>
      <View style={styles.headerRow}>
        <Pressable
          onPress={() => canGoBack && setMonthOffset(clampedOffset + 1)}
          disabled={!canGoBack}
          hitSlop={8}
          style={{ opacity: canGoBack ? 1 : 0.25, transform: [{ rotate: '180deg' }] }}
        >
          <Icon name="chevron" size={16} color={theme.dim} stroke={2.2} />
        </Pressable>
        <Text style={styles.monthTitle}>{monthTitle(monthKey)}</Text>
        <Pressable
          onPress={() => canGoForward && setMonthOffset(clampedOffset - 1)}
          disabled={!canGoForward}
          hitSlop={8}
          style={{ opacity: canGoForward ? 1 : 0.25 }}
        >
          <Icon name="chevron" size={16} color={theme.dim} stroke={2.2} />
        </Pressable>
      </View>

      <View style={{ gap: GAP }}>
        {rows.map((row, ri) => (
          <View key={ri} style={styles.row}>
            {row.map((day) => {
              if ('future' in day) {
                return (
                  <View key={day.ymd} style={[styles.cell, styles.cellFuture]}>
                    <Text style={styles.dayNumFuture}>{Number(day.ymd.slice(8))}</Text>
                  </View>
                );
              }
              const isToday = day.ymd === todayYmd;
              const isSelected = selected?.ymd === day.ymd;
              // White number once the fill is saturated enough that the
              // faint gray would vanish against it.
              const brightFill = day.dueCount > 0 && day.doneCount / day.dueCount >= 0.5;
              return (
                <Pressable
                  key={day.ymd}
                  onPress={() => setSelected((prev) => (prev?.ymd === day.ymd ? null : day))}
                  style={[
                    styles.cell,
                    { backgroundColor: cellColor(day) },
                    isToday && styles.cellToday,
                    isSelected && styles.cellSelected,
                  ]}
                >
                  <Text style={[styles.dayNum, brightFill && styles.dayNumOnAccent]}>
                    {Number(day.ymd.slice(8))}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        ))}
      </View>

      <Text style={styles.summary} numberOfLines={1}>
        {selected ? summaryFor(selected) : 'Tap a day for details'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 10, alignItems: 'center' },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  monthTitle: { color: theme.text, fontSize: 13, fontWeight: '600', minWidth: 110, textAlign: 'center' },
  row: { flexDirection: 'row', gap: GAP },
  cell: {
    width: CELL,
    height: CELL,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cellFuture: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: theme.border,
  },
  cellToday: { borderWidth: 1, borderColor: theme.blueLight },
  cellSelected: { borderWidth: 1.5, borderColor: theme.text },
  dayNum: { color: theme.faint, fontSize: 10, fontWeight: '600' },
  dayNumOnAccent: { color: '#fff' },
  dayNumFuture: { color: theme.faint, fontSize: 10, opacity: 0.5 },
  summary: { color: theme.faint, fontSize: 11 },
});
