import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { radii, theme } from '@/constants/theme';
import { banner3dStyle } from '@/lib/banner';
import { GOAL_TYPE_ACCENT } from '@/features/goals/goal-accent';
import type { GoalStreak, GoalTemplateKey } from '@/lib/api/types';
import { Icon, type IconName } from './Icon';
import { Progress } from './Progress';
import { Ring } from './Ring';

// A square goal card, laid out 2-up on the Goals tab: the icon + a metric
// (ring / streak) sit at the top, the title + subtitle + progress bar anchor
// the bottom, with the middle free so cards stay square regardless of content.
function CardShell({
  icon,
  title,
  subtitle,
  accent,
  right,
  children,
}: {
  icon: IconName;
  title: string;
  subtitle: string;
  accent?: string;
  right?: ReactNode;
  children?: ReactNode;
}) {
  return (
    // Each goal extrudes in its own type accent (the same 3D banner as task
    // cards and achievement badges); dark surface kept so the grid stays calm,
    // only the edge + shadow carry the color.
    <View style={[styles.card, banner3dStyle(accent ?? theme.blue, { tint: theme.card })]}>
      <View style={styles.topRow}>
        <View style={[styles.iconChip, { backgroundColor: `${accent ?? theme.blue}22` }]}>
          <Icon name={icon} size={18} color={accent ?? theme.blue} stroke={1.9} />
        </View>
        {right}
      </View>
      <View style={{ flex: 1 }} />
      <Text style={styles.title} numberOfLines={2}>
        {title}
      </Text>
      <Text style={styles.meta} numberOfLines={2}>
        {subtitle}
      </Text>
      {children}
    </View>
  );
}

export function GoalCard({
  type,
  icon,
  title,
  subtitle,
  progress,
  paceLine,
  onTrack,
  streak,
  accent,
  celebrate = false,
}: {
  // Discriminates the render shape explicitly — a habit's `streak` presence
  // used to be inferred from a truthy prop, but that collapsed indirect
  // (which also has no streak) into the savings ring/bar shape, wrongly
  // showing a 0% ring for a goal with no target at all.
  type: GoalTemplateKey;
  icon: IconName;
  title: string;
  subtitle: string;
  // 0-100, or null when there's no fraction to show (indirect with no
  // target — never fake one; docs/goals-redesign-plan.md §1.3).
  progress: number | null;
  // Server-computed (lib/goals/summary.ts) — only present when the goal has
  // a deadline, e.g. "needs $5.2/day to hit Dec 15"
  // (docs/goals-redesign-plan.md §2.5).
  paceLine?: string | null;
  // The same on-track/behind verdict already stated inside `paceLine`, as a
  // boolean so this component can style it without parsing the sentence.
  onTrack?: boolean | null;
  // Habit goals only.
  streak?: GoalStreak | null;
  accent?: string;
  // Let the savings ring bloom + buzz when it crosses 100%. Same contract as
  // Ring's own `celebrate`: the caller must keep it false until the list has
  // loaded and the screen is on-view, so a placeholder 0→100 on first paint
  // (or a tab kept mounted behind another) never fakes a finish.
  celebrate?: boolean;
}) {
  // Each goal type gets its own color so goals read distinctly from tasks
  // (blue) and from each other. An explicit `accent` prop still wins.
  const resolvedAccent = accent ?? GOAL_TYPE_ACCENT[type] ?? theme.blue;
  accent = resolvedAccent;

  // The detailed pace line doesn't fit a small square — it lives on the goal
  // detail screen. The bar carries progress here; the subtitle carries the
  // headline. (`paceLine`/`onTrack` still typed for callers, just not rendered.)
  void paceLine;
  void onTrack;

  if (type === 'habit') {
    const s = streak ?? { current: 0, longest: 0, doneCount: 0 };
    const lit = s.current > 0;
    return (
      <CardShell
        icon={icon}
        title={title}
        subtitle={subtitle}
        accent={accent}
        right={
          <View style={styles.streakChip}>
            <Icon name="flame" size={18} color={lit ? accent : theme.faint} stroke={2.2} />
            <Text style={[styles.streakCount, !lit && { color: theme.faint }]}>{s.current}</Text>
          </View>
        }
      />
    );
  }

  if (type === 'indirect') {
    return (
      <CardShell icon={icon} title={title} subtitle={subtitle} accent={accent}>
        {progress != null && <Progress value={progress} color={accent} />}
      </CardShell>
    );
  }

  if (type === 'milestone') {
    // subtitle is the active stage's title (or "Complete — all N stages" once
    // done). The bar is a real, user-declared fraction (activeStageIndex /
    // stages.length) — no ring.
    return (
      <CardShell icon={icon} title={title} subtitle={subtitle} accent={accent}>
        {progress != null && <Progress value={progress} color={accent} />}
      </CardShell>
    );
  }

  // savings
  const pct = progress ?? 0;
  return (
    <CardShell
      icon={icon}
      title={title}
      subtitle={subtitle}
      accent={accent}
      right={<Ring value={pct} size={40} stroke={4} label={`${pct}`} celebrate={celebrate} />}
    >
      <Progress value={pct} color={accent} />
    </CardShell>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: theme.card,
    borderColor: theme.borderStrong,
    borderWidth: 1,
    borderRadius: radii.card,
    padding: 14,
    // Square — the Goals tab lays these out two per row.
    aspectRatio: 1,
    flexDirection: 'column',
    alignItems: 'stretch',
    gap: 6,
  },
  topRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  iconChip: {
    width: 40,
    height: 40,
    borderRadius: radii.chip,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { color: theme.text, fontSize: 16, fontWeight: '700' },
  meta: { color: theme.dim, fontSize: 12.5, marginTop: 2 },
  streakChip: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  streakCount: { color: theme.text, fontSize: 18, fontWeight: '700' },
});
