import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { radii, theme } from '@/constants/theme';
import { banner3dStyle } from '@/lib/banner';
import { GOAL_TYPE_ACCENT } from '@/features/goals/goal-accent';
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
    // Each goal extrudes in its own type accent (the same 3D banner as task
    // cards and achievement badges); dark surface kept so a goals list stays
    // calm, only the edge + shadow carry the color.
    <View style={[styles.card, banner3dStyle(accent ?? theme.blue, { tint: theme.card })]}>
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

/**
 * The server-computed pace line, e.g. "needs $5.20/day to hit Dec 15 — on
 * track". Being on pace is worth showing off, so it reads in the success
 * color; being behind deliberately does NOT turn red. The text already says
 * "behind pace" plainly — dressing that in an alarm color would be the app
 * scolding someone for a number it's supposed to state matter-of-factly
 * (CLAUDE.md §2: never reinforce harmful self-judgment).
 */
function PaceLine({ text, onTrack }: { text: string; onTrack?: boolean | null }) {
  return (
    <Text style={[styles.paceLine, onTrack === true && { color: theme.success }]} numberOfLines={1}>
      {text}
    </Text>
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
        {paceLine ? <PaceLine text={paceLine} onTrack={onTrack} /> : null}
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
      right={<Ring value={pct} size={38} stroke={3.5} label={`${pct}`} celebrate={celebrate} />}
    >
      <Progress value={pct} />
      {paceLine ? <PaceLine text={paceLine} onTrack={onTrack} /> : null}
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
