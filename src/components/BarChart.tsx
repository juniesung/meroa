import { LinearGradient } from 'expo-linear-gradient';
import { StyleSheet, Text, View } from 'react-native';

import { theme } from '@/constants/theme';

type Bucket = { label: string; ymd: string; value: number };

/** Server-precomputed chart buckets (lib/goals/summary.ts) rendered as plain
 * gradient bars — the client never re-derives or re-buckets the numbers. */
export function BarChart({ buckets }: { buckets: Bucket[] }) {
  const max = Math.max(1, ...buckets.map((b) => b.value));

  return (
    <View style={styles.row}>
      {buckets.map((b) => {
        const heightPct = b.value > 0 ? Math.max(6, (b.value / max) * 100) : 0;
        return (
          <View key={b.ymd} style={styles.col}>
            <Text style={styles.value}>{b.value > 0 ? b.value : ''}</Text>
            <View style={styles.track}>
              <View style={[styles.bar, { height: `${heightPct}%` }]}>
                <LinearGradient
                  colors={[theme.blueLight, theme.blue]}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 0, y: 1 }}
                  style={StyleSheet.absoluteFill}
                />
              </View>
            </View>
            <Text style={styles.label}>{b.label}</Text>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-end', height: 130, gap: 6 },
  col: { flex: 1, alignItems: 'center', height: '100%', justifyContent: 'flex-end' },
  value: { color: theme.dim, fontSize: 10, height: 14 },
  track: { width: '100%', height: 80, justifyContent: 'flex-end' },
  bar: { width: '100%', borderRadius: 4, overflow: 'hidden' },
  label: { color: theme.faint, fontSize: 10, marginTop: 6 },
});
