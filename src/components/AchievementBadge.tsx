import { StyleSheet, Text, View } from 'react-native';

import { Icon, type IconName } from '@/components/Icon';
import { Progress } from '@/components/Progress';
import { theme } from '@/constants/theme';
import type { ApiAchievementKey, ApiAchievementView } from '@/lib/api/types';

// Which icon each family shows (mirrors server catalog.ts). Kept here rather
// than sent over the wire — a badge's look is a client concern.
const ICON: Record<ApiAchievementKey, IconName> = {
  tasks_completed: 'check',
  streak: 'flame',
  goals_started: 'sparkle',
  goals_finished: 'crown',
};

// A single achievement tile. Earned → bright accent chip + the earned label,
// with a thin progress bar toward the next tier (or "Maxed out" when every
// tier is done). Not yet earned → a dimmed locked teaser showing what the
// first tier is and how close they are. Framing is the user's own progress —
// never a bond with Meroa (CLAUDE.md §2 + retention research).
export function AchievementBadge({ badge }: { badge: ApiAchievementView }) {
  const earned = badge.earnedTier !== null;
  const title = earned ? badge.earnedLabel! : (badge.nextLabel ?? '—');
  const hasNext = badge.nextThreshold !== null;

  const sub = earned
    ? hasNext
      ? `${badge.count} / ${badge.nextThreshold} ${badge.unit}`
      : `Maxed out · ${badge.count} ${badge.unit}`
    : `${badge.count} / ${badge.nextThreshold} ${badge.unit}`;

  return (
    <View style={[styles.tile, earned ? styles.tileEarned : styles.tileLocked]}>
      <View style={[styles.chip, earned ? styles.chipEarned : styles.chipLocked]}>
        <Icon
          name={ICON[badge.key]}
          size={20}
          color={earned ? '#fff' : theme.faint}
          stroke={2.2}
        />
      </View>
      <Text style={[styles.title, !earned && styles.titleLocked]} numberOfLines={1}>
        {title}
      </Text>
      <Text style={styles.sub} numberOfLines={1}>
        {sub}
      </Text>
      {hasNext ? (
        <View style={styles.bar}>
          <Progress value={(badge.progressToNext ?? 0) * 100} />
        </View>
      ) : (
        <View style={styles.barSpacer} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  tile: {
    width: '48%',
    borderRadius: 16,
    borderWidth: 1,
    padding: 14,
    gap: 6,
  },
  tileEarned: { backgroundColor: theme.card, borderColor: theme.borderStrong },
  tileLocked: { backgroundColor: theme.surface, borderColor: theme.border },
  chip: {
    width: 40,
    height: 40,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 2,
  },
  chipEarned: { backgroundColor: theme.blue },
  chipLocked: { backgroundColor: theme.card2 },
  title: { color: theme.text, fontSize: 14, fontWeight: '700' },
  titleLocked: { color: theme.dim },
  sub: { color: theme.faint, fontSize: 12 },
  bar: { marginTop: 4 },
  barSpacer: { height: 6, marginTop: 4 },
});
