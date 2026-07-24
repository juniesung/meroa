import { StyleSheet, Text, View } from 'react-native';

import { Icon, type IconName } from '@/components/Icon';
import { Progress } from '@/components/Progress';
import { theme } from '@/constants/theme';
import type { ApiAchievementKey, ApiAchievementView } from '@/lib/api/types';

// Per-family identity: icon (mirrors server catalog.ts) + an accent and a
// darker "deep" shade. The deep shade forms the thicker left+bottom border
// that gives each earned banner a subtle 3D/extruded look. Colors are chosen
// so tasks vs goals (and each family) read as distinct at a glance — tasks
// blue, streak the warm flame, goals started purple, goals finished gold,
// active days teal.
const FAMILY: Record<ApiAchievementKey, { icon: IconName; accent: string; deep: string }> = {
  tasks_completed: { icon: 'check', accent: '#0A84FF', deep: '#0A5FCF' },
  streak: { icon: 'flame', accent: '#FF9F0A', deep: '#C2760A' },
  goals_started: { icon: 'sparkle', accent: '#BF5AF2', deep: '#8B3FBF' },
  goals_finished: { icon: 'crown', accent: '#FFD60A', deep: '#C79E00' },
  active_days: { icon: 'clock', accent: '#34C6C6', deep: '#1E8F8F' },
};

// A single achievement tile. Earned → the family's accent chip + a 3D banner
// (thicker left/bottom border in the deep shade). Not yet earned → a dimmed,
// flat locked teaser showing what the next tier is and how close they are.
// Framing is the user's own progress — never a bond with Meroa (CLAUDE.md §2).
export function AchievementBadge({ badge }: { badge: ApiAchievementView }) {
  const fam = FAMILY[badge.key];
  const earned = badge.earnedTier !== null;
  const title = earned ? badge.earnedLabel! : (badge.nextLabel ?? '—');
  const hasNext = badge.nextThreshold !== null;

  const sub = earned
    ? hasNext
      ? `${badge.count} / ${badge.nextThreshold} ${badge.unit}`
      : `Maxed out · ${badge.count} ${badge.unit}`
    : `${badge.count} / ${badge.nextThreshold} ${badge.unit}`;

  // The 3D extrude: left + bottom edges are thick and use the deep family
  // shade (earned) or a plain dark edge (locked); top + right stay hairline.
  const banner3d = earned
    ? {
        backgroundColor: theme.card,
        borderTopColor: fam.accent + '55',
        borderRightColor: fam.accent + '55',
        borderLeftColor: fam.deep,
        borderBottomColor: fam.deep,
      }
    : {
        backgroundColor: theme.surface,
        borderTopColor: theme.border,
        borderRightColor: theme.border,
        borderLeftColor: theme.card2,
        borderBottomColor: theme.card2,
      };

  return (
    <View style={[styles.tile, banner3d]}>
      <View style={[styles.chip, { backgroundColor: earned ? fam.accent : theme.card2 }]}>
        <Icon name={fam.icon} size={20} color={earned ? '#fff' : theme.faint} stroke={2.2} />
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
    // Asymmetric border = the 3D extrude. Left/bottom are the "lit" thick
    // edges; top/right are hairline.
    borderTopWidth: 1,
    borderRightWidth: 1,
    borderLeftWidth: 3,
    borderBottomWidth: 4,
    padding: 14,
    paddingBottom: 12,
    gap: 6,
  },
  chip: {
    width: 40,
    height: 40,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 2,
  },
  title: { color: theme.text, fontSize: 14, fontWeight: '700' },
  titleLocked: { color: theme.dim },
  sub: { color: theme.faint, fontSize: 12 },
  bar: { marginTop: 4 },
  barSpacer: { height: 6, marginTop: 4 },
});
