import { StyleSheet, Text, View, type ViewStyle } from 'react-native';

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

// Three visual states:
// - earned  → the full 3D colored banner (thick left/bottom edge + shadow).
// - started → some progress but no tier yet (e.g. a 3-day streak toward 7):
//             a colored OUTLINE in the family accent, no 3D fill — clearly
//             "in progress" without claiming the badge.
// - untouched (count 0) → flat grey.
// Framing is the user's own progress — never a bond with Meroa (CLAUDE.md §2).
export function AchievementBadge({ badge }: { badge: ApiAchievementView }) {
  const fam = FAMILY[badge.key];
  const earned = badge.earnedTier !== null;
  const started = !earned && badge.count > 0;
  const active = earned || started; // has color; untouched does not
  const title = earned ? badge.earnedLabel! : (badge.nextLabel ?? '—');
  const hasNext = badge.nextThreshold !== null;

  const sub = earned
    ? hasNext
      ? `${badge.count} / ${badge.nextThreshold} ${badge.unit}`
      : `Maxed out · ${badge.count} ${badge.unit}`
    : `${badge.count} / ${badge.nextThreshold} ${badge.unit}`;

  const banner: ViewStyle = earned
    ? banner3dStyle(fam.accent, { tint: fam.accent + '1A' })
    : started
      ? { ...styles.tileOutlined, borderColor: fam.accent }
      : styles.tileUntouched;

  return (
    <View style={[styles.tile, banner]}>
      <View
        style={[
          styles.chip,
          { backgroundColor: earned ? fam.accent : started ? fam.accent + '22' : theme.card2 },
        ]}
      >
        <Icon name={fam.icon} size={20} color={earned ? '#fff' : started ? fam.accent : theme.faint} stroke={2.2} />
      </View>
      <Text style={[styles.title, !active && styles.titleUntouched]} numberOfLines={1}>
        {title}
      </Text>
      <Text style={styles.sub} numberOfLines={1}>
        {sub}
      </Text>
      {hasNext ? (
        <View style={styles.bar}>
          {/* Bar matches the family outline color (accent). */}
          <Progress value={(badge.progressToNext ?? 0) * 100} color={fam.accent} />
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
    padding: 14,
    paddingBottom: 12,
    gap: 6,
  },
  // Started: a uniform colored outline (border color set inline per family).
  tileOutlined: {
    backgroundColor: theme.surface,
    borderWidth: 1.5,
  },
  // Untouched: flat, faint grey.
  tileUntouched: {
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.border,
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
  titleUntouched: { color: theme.dim },
  sub: { color: theme.faint, fontSize: 12 },
  bar: { marginTop: 4 },
  barSpacer: { height: 6, marginTop: 4 },
});
