import { StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Line, Path, Text as SvgText } from 'react-native-svg';

import { theme } from '@/constants/theme';

const HEIGHT = 120;
const PAD_X = 10;
const PAD_TOP = 16;
const PAD_BOTTOM = 8;

export type TrendPoint = { entryAt: string; amount: number };

function trimNum(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * A single-series line for an indirect goal's logged measurements over time
 * — the only place a number here comes from is `entries` (never a task; see
 * docs/goals-redesign-plan.md's indirect goal type). One series needs no
 * legend (dataviz skill); the target, when present, is a dashed reference
 * line rather than a second series so the chart never grows a second axis.
 * `width` is the container's measured width (onLayout), so the SVG can use
 * a real viewBox instead of a hardcoded size.
 */
export function TrendChart({
  entries,
  unit,
  targetValue,
  width,
}: {
  entries: TrendPoint[];
  unit: string;
  targetValue?: number | null;
  width: number;
}) {
  if (entries.length === 0 || width <= 0) return null;

  const sorted = [...entries].sort((a, b) => new Date(a.entryAt).getTime() - new Date(b.entryAt).getTime());
  const values = sorted.map((e) => e.amount);
  const allValues = targetValue != null ? [...values, targetValue] : values;
  const rawMin = Math.min(...allValues);
  const rawMax = Math.max(...allValues);
  // A flat series (or a single point) would otherwise divide by zero — pad
  // the range so the line still draws roughly mid-height.
  const span = rawMax - rawMin || Math.abs(rawMax) * 0.1 || 1;
  const min = rawMin - span * 0.12;
  const max = rawMax + span * 0.12;

  const plotW = width - PAD_X * 2;
  const plotH = HEIGHT - PAD_TOP - PAD_BOTTOM;
  const xFor = (i: number) => PAD_X + (sorted.length === 1 ? plotW / 2 : (i / (sorted.length - 1)) * plotW);
  const yFor = (v: number) => PAD_TOP + plotH - ((v - min) / (max - min)) * plotH;

  const linePath = sorted.map((p, i) => `${i === 0 ? 'M' : 'L'} ${xFor(i)} ${yFor(p.amount)}`).join(' ');
  const targetY = targetValue != null ? yFor(targetValue) : null;
  const last = sorted[sorted.length - 1]!;

  return (
    <View>
      <Svg width={width} height={HEIGHT}>
        {targetY != null && (
          <>
            <Line
              x1={PAD_X}
              y1={targetY}
              x2={width - PAD_X}
              y2={targetY}
              stroke={theme.dim}
              strokeWidth={1}
              strokeDasharray="4,4"
            />
            <SvgText x={width - PAD_X} y={targetY - 5} fontSize={10} fill={theme.dim} textAnchor="end">
              target {trimNum(targetValue!)}
              {unit}
            </SvgText>
          </>
        )}
        {sorted.length > 1 && <Path d={linePath} stroke={theme.blue} strokeWidth={2} fill="none" strokeLinecap="round" strokeLinejoin="round" />}
        {sorted.map((p, i) => (
          <Circle
            key={p.entryAt + i}
            cx={xFor(i)}
            cy={yFor(p.amount)}
            r={i === sorted.length - 1 ? 5 : 3}
            fill={i === sorted.length - 1 ? theme.blue : theme.card2}
            stroke={theme.blue}
            strokeWidth={i === sorted.length - 1 ? 0 : 1.5}
          />
        ))}
      </Svg>
      <View style={styles.axisRow}>
        <Text style={styles.axisLabel}>{shortDate(sorted[0]!.entryAt)}</Text>
        {sorted.length > 1 && <Text style={styles.axisLabel}>{shortDate(last.entryAt)}</Text>}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  axisRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 2 },
  axisLabel: { color: theme.faint, fontSize: 10 },
});
