import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { theme } from '@/constants/theme';
import type { DayBucket } from '@/lib/api/types';

const CELL = 11;
const GAP = 3;

// Sequential 4-step ramp on the app's own blue tokens (CLAUDE.md §5) — not
// the dataviz skill's default palette, per docs/goals-redesign-plan.md
// §2.5's implementer note. Level 0 reads as an empty cell (nothing due, or
// due but nothing done — see consistency.ts), level 3 is the full accent at
// a perfect day.
const LEVEL_COLOR: Record<DayBucket['level'], string> = {
  0: theme.card2,
  1: 'rgba(10,132,255,0.35)',
  2: 'rgba(10,132,255,0.65)',
  3: theme.blue,
};

function formatDayLabel(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString(undefined, {
    timeZone: 'UTC',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

function summaryFor(day: DayBucket): string {
  if (day.verdict === 'neutral') return `${formatDayLabel(day.ymd)} · nothing due`;
  if (day.verdict === 'perfect') return `${formatDayLabel(day.ymd)} · all ${day.dueCount} done`;
  return `${formatDayLabel(day.ymd)} · ${day.doneCount}/${day.dueCount} done`;
}

export function Heatmap({ calendar }: { calendar: DayBucket[] }) {
  const [selected, setSelected] = useState<DayBucket | null>(null);

  // calendar is oldest-first, a flat run of days ending today
  // (lib/goals/consistency.ts's buildCalendar) — chunked here into 7-day
  // columns, most recent column last, for the classic GitHub-style grid.
  // Columns don't align to real Sun–Sat weeks (that needs padding the first
  // partial week); a plain 7-day chunk reads the same as a heatmap and
  // keeps this a pure client-side render with no re-bucketing.
  const columns: DayBucket[][] = [];
  for (let i = 0; i < calendar.length; i += 7) {
    columns.push(calendar.slice(i, i + 7));
  }

  return (
    <View style={styles.wrap}>
      <View style={styles.grid}>
        {columns.map((col, ci) => (
          <View key={ci} style={{ gap: GAP }}>
            {col.map((day) => (
              <Pressable
                key={day.ymd}
                onPress={() => setSelected((prev) => (prev?.ymd === day.ymd ? null : day))}
                style={[
                  styles.cell,
                  { backgroundColor: LEVEL_COLOR[day.level] },
                  selected?.ymd === day.ymd && styles.cellSelected,
                ]}
              />
            ))}
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
  wrap: { gap: 8 },
  grid: { flexDirection: 'row', gap: GAP },
  cell: { width: CELL, height: CELL, borderRadius: 3 },
  cellSelected: { borderWidth: 1.5, borderColor: theme.text },
  summary: { color: theme.faint, fontSize: 11 },
});
