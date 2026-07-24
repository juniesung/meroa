import { router, useIsFocused } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, {
  Easing,
  FadeIn,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import { AddFab } from '@/components/AddFab';
import { AnimatedPressable, useTapFeedback } from '@/components/AnimatedPressable';
import { GoalCard } from '@/components/GoalCard';
import { Icon } from '@/components/Icon';
import { LoadError } from '@/components/LoadError';
import { MeroaMark, type MeroaMood } from '@/components/MeroaMark';
import { Ring } from '@/components/Ring';
import { GoalListSkeleton } from '@/components/Skeleton';
import { taskProgressFraction } from '@/components/TaskCard';
import { radii, theme } from '@/constants/theme';
import { GoalFormSheet } from '@/features/goals/GoalFormSheet';
import { useArchivedGoals, useGoalConsistency, useGoals } from '@/features/goals/queries';
import { useMe } from '@/features/profile/queries';
import { useTasks } from '@/features/tasks/queries';
import { useTabBarHeight } from '@/hooks/use-tab-bar-inset';
import { usePullRefresh } from '@/hooks/use-pull-refresh';
import { banner3dStyle } from '@/lib/banner';
import { haptics } from '@/lib/haptics';
import type { ApiGoal, ApiGoalConsistency, ApiTask } from '@/lib/api/types';
import { toIconName } from '@/lib/icon';

// The "Today" summary card at the top of the Goals tab wears the app blue.
const HEADER_BANNER = banner3dStyle(theme.blue, { tint: theme.card });

// One goal in the list — its own tap-scale so the card presses in, instead of
// a bare Pressable with no feedback. A component (not an inline map body) so it
// can own the useTapFeedback hook.
function GoalRow({ goal, celebrate }: { goal: ApiGoal; celebrate: boolean }) {
  const feedback = useTapFeedback(0.98);
  return (
    <AnimatedPressable
      onPressIn={feedback.onPressIn}
      onPressOut={feedback.onPressOut}
      onPress={() => {
        haptics.tap();
        router.push({ pathname: '/goal/[id]', params: { id: goal.id } });
      }}
      style={[styles.goalCell, feedback.animatedStyle]}
    >
      <GoalCard
        type={goal.definition.type}
        icon={toIconName(goal.icon)}
        title={goal.name}
        subtitle={goal.headline ?? goal.sub ?? `${goal.entryCount} entries logged`}
        progress={goal.progress != null ? Math.round(goal.progress * 100) : null}
        paceLine={goal.paceLine}
        onTrack={goal.onTrack}
        streak={goal.streak}
        celebrate={celebrate}
      />
    </AnimatedPressable>
  );
}

function tzOrLocal(timezone?: string | null): string | undefined {
  return timezone ?? undefined;
}

function ymdInTz(date: Date, timezone?: string | null): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tzOrLocal(timezone),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function isDueToday(task: ApiTask, timezone?: string | null): boolean {
  if (!task.dueAt) return false;
  return ymdInTz(new Date(task.dueAt), timezone) === ymdInTz(new Date(), timezone);
}

// A brief pop the instant the streak count increments — satisfying, not
// distracting (docs/goals-redesign-plan.md §2.5).
function FlamePop({ current }: { current: number }) {
  const scale = useSharedValue(1);
  const prevRef = useRef(current);

  useEffect(() => {
    if (current > prevRef.current) {
      scale.value = withSequence(
        withTiming(1.45, { duration: 150, easing: Easing.out(Easing.cubic) }),
        withTiming(1, { duration: 260, easing: Easing.out(Easing.back(2)) }),
      );
    }
    prevRef.current = current;
  }, [current, scale]);

  const style = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  return (
    <Animated.View style={style}>
      <Icon name="flame" size={20} color={current > 0 ? theme.blue : theme.faint} stroke={2.2} />
    </Animated.View>
  );
}

function StatTile({ label, value }: { label: string; value: string | number }) {
  return (
    <View style={styles.statTile}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

// Dumb-simple and derived, never stored (docs/goals-redesign-plan.md §2.5) —
// just a few nice moments read off data already fetched for this screen.
function buildWins(goals: ApiGoal[], consistency: ApiGoalConsistency): string[] {
  const wins: string[] = [];
  if (consistency.current >= 3) wins.push(`${consistency.current}-day perfect streak`);
  for (const g of goals) {
    if ((g.progress ?? 0) >= 1) wins.push(`"${g.name}" target reached`);
  }
  const recentlyLogged = [...goals]
    .filter((g) => g.lastEntryAt)
    .sort((a, b) => new Date(b.lastEntryAt!).getTime() - new Date(a.lastEntryAt!).getTime())
    .slice(0, 2);
  for (const g of recentlyLogged) {
    if (g.headline) wins.push(`${g.headline} on "${g.name}"`);
  }
  return wins.slice(0, 4);
}

function EmptyState() {
  return (
    <Animated.View entering={FadeIn.duration(320)} style={styles.empty}>
      <View style={styles.ghostCard}>
        <View style={styles.ghostIconChip} />
        <View style={{ flex: 1, gap: 6 }}>
          <View style={styles.ghostLine} />
          <View style={[styles.ghostLine, { width: '55%' }]} />
        </View>
      </View>
      <Text style={styles.emptyText}>
        No goals yet — tell Meroa what you&apos;re working toward and it&apos;ll build one with you.
      </Text>
    </Animated.View>
  );
}

export default function GoalsScreen() {
  const isFocused = useIsFocused();
  const { data: goals = [], isLoading, isError, refetch } = useGoals();
  const { data: archivedGoals = [] } = useArchivedGoals();
  const { data: consistency } = useGoalConsistency();
  const { data: tasks = [] } = useTasks();
  const { data: me } = useMe();
  const timezone = me?.user.timezone;
  const tabBarHeight = useTabBarHeight();
  const [createVisible, setCreateVisible] = useState(false);
  // Goals, consistency, and archived all live under the ['goals'] prefix;
  // tasks feed the "today" ring, so refresh both.
  const { refreshing, onRefresh } = usePullRefresh([['goals'], ['tasks']]);

  const dueTodayTasks = tasks.filter(
    (t) => t.status !== 'archived' && !t.recurrence && isDueToday(t, timezone),
  );
  const doneToday = dueTodayTasks.filter((t) => t.status === 'done').length;
  const todayPct = dueTodayTasks.length
    ? Math.round(
        (dueTodayTasks.reduce((sum, t) => sum + taskProgressFraction(t), 0) / dueTodayTasks.length) * 100,
      )
    : 0;

  const current = consistency?.current ?? 0;
  const longest = consistency?.longest ?? 0;
  // idle: no streak history at all. warm: a streak of 3+ is currently live.
  // deflated: there *was* a streak (longest > 0) but it just broke (current
  // is 0) — the "fresh break" state (docs/goals-redesign-plan.md §1). Any
  // other combination (a short 1-2 day current streak) stays idle rather
  // than swinging between moods on every small change.
  const mood: MeroaMood = current >= 3 ? 'warm' : current === 0 && longest > 0 ? 'deflated' : 'idle';

  const doneThisWeek = consistency
    ? consistency.calendar.slice(-7).reduce((sum, d) => sum + d.doneCount, 0)
    : 0;
  const now = new Date();
  const thisMonthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const perfectDaysThisMonth = consistency
    ? consistency.calendar.filter((d) => d.ymd.startsWith(thisMonthPrefix) && d.verdict === 'perfect').length
    : 0;
  // Only advertised once there's something in it — an "Archived (0)" link is
  // just clutter for anyone who's never removed a goal.
  const hasArchived = archivedGoals.length > 0;
  const wins = consistency ? buildWins(goals, consistency) : [];

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 20, paddingBottom: tabBarHeight + 88, gap: 20 }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.dim} colors={[theme.blue]} />
        }
      >
        <View style={styles.headerRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.eyebrow}>YOUR GOALS</Text>
            <Text style={styles.h1}>Your progress</Text>
          </View>
        </View>

        <View style={[styles.headerCard, HEADER_BANNER]}>
          <Ring value={todayPct} size={50} stroke={5} />
          <View style={{ flex: 1 }}>
            <Text style={styles.headerLabel}>Today</Text>
            <Text style={styles.headerValue}>
              {dueTodayTasks.length ? `${doneToday}/${dueTodayTasks.length} done` : 'Nothing due'}
            </Text>
          </View>
          <View style={{ alignItems: 'center', gap: 2 }}>
            <FlamePop current={current} />
            <Text style={styles.streakValue}>{current}</Text>
            <Text style={styles.streakSub}>longest {longest}</Text>
          </View>
          <MeroaMark size={38} mood={mood} />
        </View>

        {isError ? (
          <LoadError onRetry={() => refetch()} />
        ) : isLoading ? (
          <GoalListSkeleton />
        ) : goals.length === 0 ? (
          <EmptyState />
        ) : (
          <View style={styles.goalGrid}>
            {goals.map((goal) => (
              <GoalRow key={goal.id} goal={goal} celebrate={isFocused && !isLoading} />
            ))}
          </View>
        )}

        {goals.length > 0 && (
          <View style={styles.statRow}>
            <StatTile label="Done this week" value={doneThisWeek} />
            <StatTile label="Perfect days" value={perfectDaysThisMonth} />
            <StatTile label="Active goals" value={goals.length} />
          </View>
        )}

        {hasArchived && (
          <Pressable
            onPress={() => {
              haptics.tap();
              router.push('/archived-goals');
            }}
            style={styles.archivedLink}
            hitSlop={6}
          >
            <Icon name="chevron" size={13} color={theme.dim} stroke={2} />
            <Text style={styles.archivedLinkText}>
              Archived ({archivedGoals.length})
            </Text>
          </Pressable>
        )}

        {wins.length > 0 && (
          <View style={{ gap: 8 }}>
            <Text style={styles.sectionTitle}>Recent wins</Text>
            <View style={{ gap: 8 }}>
              {wins.map((w, i) => (
                <View key={i} style={styles.winRow}>
                  <Icon name="sparkle" size={14} color={theme.blue} stroke={2} />
                  <Text style={styles.winText} numberOfLines={1}>
                    {w}
                  </Text>
                </View>
              ))}
            </View>
          </View>
        )}
      </ScrollView>

      <AddFab onPress={() => setCreateVisible(true)} bottom={tabBarHeight + 16} />

      <GoalFormSheet visible={createVisible} onClose={() => setCreateVisible(false)} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  eyebrow: { color: theme.dim, fontSize: 11, fontWeight: '700', letterSpacing: 1.2 },
  h1: { color: theme.text, fontSize: 28, fontWeight: '700', letterSpacing: -0.5, marginTop: 4 },
  sectionTitle: { color: theme.text, fontSize: 15, fontWeight: '700' },
  headerCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    backgroundColor: theme.card,
    borderColor: theme.borderStrong,
    borderWidth: 1,
    borderRadius: radii.card,
    padding: 14,
  },
  headerLabel: { color: theme.dim, fontSize: 11, fontWeight: '700', letterSpacing: 0.6, textTransform: 'uppercase' },
  headerValue: { color: theme.text, fontSize: 15, fontWeight: '600', marginTop: 2 },
  streakValue: { color: theme.text, fontSize: 16, fontWeight: '700' },
  streakSub: { color: theme.faint, fontSize: 10.5 },
  // Two square goal cards per row, wrapping to the next line.
  goalGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: 12 },
  goalCell: { width: '48%' },
  statRow: { flexDirection: 'row', gap: 10 },
  statTile: {
    flex: 1,
    backgroundColor: theme.card,
    borderColor: theme.border,
    borderWidth: 1,
    borderRadius: radii.controlTight,
    paddingVertical: 12,
    alignItems: 'center',
    gap: 2,
  },
  statValue: { color: theme.text, fontSize: 18, fontWeight: '700' },
  statLabel: { color: theme.dim, fontSize: 10.5, textAlign: 'center' },
  archivedLink: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'center', paddingVertical: 4 },
  archivedLinkText: { color: theme.dim, fontSize: 13, fontWeight: '600' },
  winRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  winText: { color: theme.dim, fontSize: 13, flex: 1 },
  empty: { alignItems: 'center', paddingVertical: 30, paddingHorizontal: 10, gap: 16 },
  ghostCard: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: theme.card,
    borderColor: theme.border,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderRadius: radii.card,
    padding: 14,
  },
  ghostIconChip: { width: 34, height: 34, borderRadius: radii.chip, backgroundColor: theme.card2 },
  ghostLine: { height: 10, borderRadius: 4, backgroundColor: theme.card2, width: '80%' },
  emptyText: { color: theme.dim, fontSize: 14, textAlign: 'center', lineHeight: 20 },
});
