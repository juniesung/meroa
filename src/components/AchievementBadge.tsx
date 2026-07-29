import { StyleSheet, Text, View, type ViewStyle } from 'react-native';

import { Icon, type IconName } from '@/components/Icon';
import { Progress } from '@/components/Progress';
import { theme } from '@/constants/theme';
import { banner3dStyle } from '@/lib/banner';
import { toIconName } from '@/lib/icon';
import type { ApiAchievementView } from '@/lib/api/types';

// The icon now comes from the badge itself (server catalog is the source of
// truth — per-goal families aren't in any fixed client map). The accent still
// reads distinctly per family: the 5 globals keep their hand-picked colors,
// everything else colors by category (per-goal green, consistency purple,
// records gold). The 3D extrude is the shared banner3dStyle (lib/banner.ts).
const GLOBAL_ACCENT: Record<string, string> = {
  tasks_completed: '#0A84FF',
  streak: '#FF9F0A',
  goals_started: '#BF5AF2',
  goals_finished: '#FFD60A',
  active_days: '#34C6C6',
};
const CATEGORY_ACCENT: Record<string, string> = {
  global: '#0A84FF',
  goal: '#30D158',
  consistency: '#BF5AF2',
  record: '#FFD60A',
};
function accentFor(badge: ApiAchievementView): string {
  return GLOBAL_ACCENT[badge.key] ?? CATEGORY_ACCENT[badge.category] ?? theme.blue;
}

// Three visual states:
// - earned  → the full 3D colored banner (thick left/bottom edge + shadow).
// - started → some progress but no tier yet (e.g. a 3-day streak toward 7):
//             a colored OUTLINE in the family accent, no 3D fill — clearly
//             "in progress" without claiming the badge.
// - untouched (count 0) → flat grey.
// Framing is the user's own progress — never a bond with Meroa (CLAUDE.md §2).
export function AchievementBadge({ badge }: { badge: ApiAchievementView }) {
  const accent = accentFor(badge);
  const iconName: IconName = toIconName(badge.icon);
  const earned = badge.earnedTier !== null;
  const started = !earned && badge.count > 0;
  const active = earned || started; // has color; untouched does not
  // Globals show the punchy tier label ("Committed"); per-goal/consistency show
  // the family title (the goal name) so the badge is identifiable at a glance.
  const title =
    badge.category === 'global' ? (earned ? badge.earnedLabel! : badge.nextLabel ?? '—') : badge.title;
  const hasNext = badge.nextThreshold !== null;

  const sub = earned
    ? hasNext
      ? `${badge.count} / ${badge.nextThreshold} ${badge.unit}`
      : `Maxed out · ${badge.count} ${badge.unit}`
    : `${badge.count} / ${badge.nextThreshold} ${badge.unit}`;

  const banner: ViewStyle = earned
    ? banner3dStyle(accent, { tint: accent + '1A' })
    : started
      ? { ...styles.tileOutlined, borderColor: accent }
      : styles.tileUntouched;

  return (
    <View style={[styles.tile, banner]}>
      <View
        style={[
          styles.chip,
          { backgroundColor: earned ? accent : started ? accent + '22' : theme.card2 },
        ]}
      >
        <Icon name={iconName} size={20} color={earned ? '#fff' : started ? accent : theme.faint} stroke={2.2} />
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
          <Progress value={(badge.progressToNext ?? 0) * 100} color={accent} />
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
