import { router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useEffect, useRef } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import { GoalCard } from '@/components/GoalCard';
import { Heatmap } from '@/components/Heatmap';
import { Icon } from '@/components/Icon';
import { MeroaMark, type MeroaMood } from '@/components/MeroaMark';
import { Ring } from '@/components/Ring';
import { taskProgressFraction } from '@/components/TaskCard';
import { radii, theme } from '@/constants/theme';
import { useGoalConsistency, useGoals } from '@/features/goals/queries';
import { useMe } from '@/features/profile/queries';
import { useTasks } from '@/features/tasks/queries';
import { useTabBarHeight } from '@/hooks/use-tab-bar-inset';
import type { ApiGoal, ApiGoalConsistency, ApiTask } from '@/lib/api/types';
import { toIconName } from '@/lib/icon';

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
    <View style={styles.empty}>
      <View style={styles.ghostCard}>
        <View style={styles.ghostIconChip} />
        <View style={{ flex: 1, gap: 6 }}>
          <View style={styles.ghostLine} />
          <View style={[styles.ghostLine, { width: '55%' }]} />
        </View>
      </View>
      <Text style={styles.emptyText}>
        No goals yet — tell Meroa what you&apos;re saving toward and it&apos;ll build one with you.
      </Text>
    </View>
  );
}

export default function GoalsScreen() {
  const { data: goals = [], isLoading } = useGoals();
  const { data: consistency } = useGoalConsistency();
  const { data: tasks = [] } = useTasks();
  const { data: me } = useMe();
  const timezone = me?.user.timezone;
  const tabBarHeight = useTabBarHeight();

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
  const hasAnyDueDay = consistency?.calendar.some((d) => d.dueCount > 0) ?? false;
  const wins = consistency ? buildWins(goals, consistency) : [];

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 20, paddingBottom: tabBarHeight + 40, gap: 20 }}
      >
        <View>
          <Text style={styles.eyebrow}>YOUR GOALS</Text>
          <Text style={styles.h1}>Your progress</Text>
        </View>

        <View style={styles.headerCard}>
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

        {hasAnyDueDay && consistency && (
          <View style={{ gap: 8 }}>
            <Text style={styles.sectionTitle}>Consistency</Text>
            <Heatmap calendar={consistency.calendar} />
          </View>
        )}

        {isLoading ? (
          <View style={styles.loading}>
            <ActivityIndicator color={theme.dim} />
          </View>
        ) : goals.length === 0 ? (
          <EmptyState />
        ) : (
          <View style={{ gap: 12 }}>
            {goals.map((goal) => (
              <Pressable
                key={goal.id}
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
                  router.push({ pathname: '/goal/[id]', params: { id: goal.id } });
                }}
              >
                <GoalCard
                  icon={toIconName(goal.icon)}
                  title={goal.name}
                  subtitle={goal.headline ?? goal.sub ?? `${goal.entryCount} entries logged`}
                  progress={Math.round((goal.progress ?? 0) * 100)}
                  paceLine={goal.paceLine}
                />
              </Pressable>
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
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  eyebrow: { color: theme.dim, fontSize: 11, fontWeight: '700', letterSpacing: 1.2 },
  h1: { color: theme.text, fontSize: 28, fontWeight: '700', letterSpacing: -0.5, marginTop: 4 },
  sectionTitle: { color: theme.text, fontSize: 15, fontWeight: '700' },
  loading: { alignItems: 'center', justifyContent: 'center', paddingVertical: 40 },
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
