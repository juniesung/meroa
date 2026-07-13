import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { radii, theme } from '@/constants/theme';
import type { GoalStreak, GoalTemplateKey } from '@/lib/api/types';
import { Icon, type IconName } from './Icon';
import { Progress } from './Progress';
import { Ring } from './Ring';

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
        {right}
      </View>
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
  streak,
  accent,
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
  // Habit goals only.
  streak?: GoalStreak | null;
  accent?: string;
}) {
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
            <Icon name="flame" size={16} color={lit ? theme.blue : theme.faint} stroke={2.2} />
            <Text style={[styles.streakCount, !lit && { color: theme.faint }]}>{s.current}</Text>
          </View>
        }
      />
    );
  }

  if (type === 'indirect') {
    return (
      <CardShell icon={icon} title={title} subtitle={subtitle} accent={accent}>
        {progress != null && <Progress value={progress} />}
        {paceLine ? (
          <Text style={styles.paceLine} numberOfLines={1}>
            {paceLine}
          </Text>
        ) : null}
      </CardShell>
    );
  }

  if (type === 'milestone') {
    // subtitle is the active stage's title (or "Complete — all N stages"
    // once done) — the headline server-computed by computeMilestoneCardSummary.
    // The bar is a real, user-declared fraction (activeStageIndex /
    // stages.length) — no ring, and never a paceLine (milestone goals have
    // no numbers or deadlines to pace against).
    return (
      <CardShell icon={icon} title={title} subtitle={subtitle} accent={accent}>
        {progress != null && <Progress value={progress} />}
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
      right={<Ring value={pct} size={38} stroke={3.5} label={`${pct}`} />}
    >
      <Progress value={pct} />
      {paceLine ? (
        <Text style={styles.paceLine} numberOfLines={1}>
          {paceLine}
        </Text>
      ) : null}
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
