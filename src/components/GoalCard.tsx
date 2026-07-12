import { StyleSheet, Text, View } from 'react-native';

import { radii, theme } from '@/constants/theme';
import type { GoalStreak } from '@/lib/api/types';
import { Icon, type IconName } from './Icon';
import { Progress } from './Progress';
import { Ring } from './Ring';

export function GoalCard({
  icon,
  title,
  subtitle,
  progress,
  paceLine,
  streak,
  accent,
}: {
  icon: IconName;
  title: string;
  subtitle: string;
  progress: number;
  // Server-computed (lib/goals/summary.ts) — only present when the goal has
  // a deadline, e.g. "needs $5.2/day to hit Dec 15"
  // (docs/goals-redesign-plan.md §2.5).
  paceLine?: string | null;
  // Habit goals only — when present the card renders streak-first (flame +
  // current run) instead of a progress ring/bar; a habit has no fraction to
  // fill and never fakes one (docs/goals-redesign-plan.md §1).
  streak?: GoalStreak | null;
  accent?: string;
}) {
  if (streak) {
    const lit = streak.current > 0;
    return (
      <View style={styles.card}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <View style={[styles.iconChip, { backgroundColor: `${accent ?? theme.blue}22` }]}>
            <Icon name={icon} size={18} color={accent ?? theme.blue} stroke={1.9} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.title} numberOfLines={1}>
              {title}
            </Text>
            <Text style={styles.meta} numberOfLines={1}>
              {subtitle}
            </Text>
          </View>
          <View style={styles.streakChip}>
            <Icon name="flame" size={16} color={lit ? theme.blue : theme.faint} stroke={2.2} />
            <Text style={[styles.streakCount, !lit && { color: theme.faint }]}>{streak.current}</Text>
          </View>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.card}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <View style={[styles.iconChip, { backgroundColor: `${accent ?? theme.blue}22` }]}>
          <Icon name={icon} size={18} color={accent ?? theme.blue} stroke={1.9} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.title} numberOfLines={1}>
            {title}
          </Text>
          <Text style={styles.meta} numberOfLines={1}>
            {subtitle}
          </Text>
        </View>
        <Ring value={progress} size={38} stroke={3.5} label={`${progress}`} />
      </View>
      <Progress value={progress} />
      {paceLine ? (
        <Text style={styles.paceLine} numberOfLines={1}>
          {paceLine}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: theme.card,
    borderColor: theme.borderStrong,
    borderWidth: 1,
    borderRadius: radii.card,
    padding: 14,
    flexDirection: 'column',
    alignItems: 'stretch',
    gap: 10,
  },
  iconChip: {
    width: 34,
    height: 34,
    borderRadius: radii.chip,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { color: theme.text, fontSize: 15, fontWeight: '600' },
  meta: { color: theme.dim, fontSize: 12, marginTop: 2 },
  paceLine: { color: theme.faint, fontSize: 11.5 },
  streakChip: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  streakCount: { color: theme.text, fontSize: 16, fontWeight: '700' },
});
