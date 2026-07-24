import { StyleSheet, Text, View } from 'react-native';

import { Icon, type IconName } from '@/components/Icon';
import { Progress } from '@/components/Progress';
import { theme } from '@/constants/theme';
import { banner3dStyle } from '@/lib/banner';
import type { ApiAchievementKey, ApiAchievementView } from '@/lib/api/types';

// Per-family identity: icon (mirrors server catalog.ts) + an accent. Colors are
// chosen so tasks vs goals (and each family) read as distinct at a glance —
// tasks blue, streak the warm flame, goals started purple, goals finished gold,
// active days teal. The 3D extrude is the shared banner3dStyle (lib/banner.ts),
// the same look task and goal cards use.
const FAMILY: Record<ApiAchievementKey, { icon: IconName; accent: string }> = {
  tasks_completed: { icon: 'check', accent: '#0A84FF' },
  streak: { icon: 'flame', accent: '#FF9F0A' },
  goals_started: { icon: 'sparkle', accent: '#BF5AF2' },
  goals_finished: { icon: 'crown', accent: '#FFD60A' },
  active_days: { icon: 'clock', accent: '#34C6C6' },
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

  // Earned → the shared 3D colored banner; locked → a flat grey teaser so the
  // earned ones pop.
  const banner = earned
    ? banner3dStyle(fam.accent, { tint: fam.accent + '1A' })
    : styles.tileLockedBanner;

  return (
    <View style={[styles.tile, banner]}>
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
    // Asymmetric border widths = the 3D extrude (colors come from the banner
    // style, earned or locked). Left/bottom are the thick edges; top/right
    // are hairline.
    borderTopWidth: 1,
    borderRightWidth: 1,
    borderLeftWidth: 3,
    borderBottomWidth: 4,
    padding: 14,
    paddingBottom: 12,
    gap: 6,
  },
  tileLockedBanner: {
    backgroundColor: theme.surface,
    borderTopColor: theme.border,
    borderRightColor: theme.border,
    borderLeftColor: theme.card2,
    borderBottomColor: theme.card2,
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
