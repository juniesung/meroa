import { router } from 'expo-router';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AchievementBadge } from '@/components/AchievementBadge';
import { Heatmap } from '@/components/Heatmap';
import { Icon } from '@/components/Icon';
import { MeroaMark } from '@/components/MeroaMark';
import { SkeletonBlock } from '@/components/Skeleton';
import { theme } from '@/constants/theme';
import { banner3dStyle } from '@/lib/banner';
import { AnimatedPressable, useTapFeedback } from '@/components/AnimatedPressable';
import { useGoalConsistency } from '@/features/goals/queries';
import { useMe, useProfileOverview } from '@/features/profile/queries';
import { useTabBarHeight } from '@/hooks/use-tab-bar-inset';

function memberSinceLabel(iso: string): string {
  const d = new Date(iso);
  return `Member since ${d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}`;
}

// The streak card wears the flame accent (matching the streak badge). Stat
// tiles wear their badge family's color so the whole tab reads as one system:
// tasks blue, goals-active purple, finished gold, active-days teal.
const STREAK_BANNER = banner3dStyle('#FF9F0A', { tint: theme.card });

// The You tab: a profile/progress/identity surface (CLAUDE.md §5 + the
// retention research in memory). Everything shown is the user's OWN real
// recorded progress — never fabricated, never framed as a bond with Meroa.
// App settings live behind the gear, top-right.
export default function YouScreen() {
  const tabBarHeight = useTabBarHeight();
  const { data: me } = useMe();
  const overview = useProfileOverview();
  const consistency = useGoalConsistency();
  const gearFeedback = useTapFeedback();

  const loading = overview.isLoading || consistency.isLoading;
  const streak = consistency.data;
  const o = overview.data;

  const displayName = me?.user.displayName ?? me?.user.phoneE164 ?? '—';

  const refreshing = overview.isRefetching || consistency.isRefetching;
  const onRefresh = () => {
    void overview.refetch();
    void consistency.refetch();
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.topBar}>
        <View style={styles.gearSpacer} />
        <AnimatedPressable
          onPress={() => router.push('/settings')}
          onPressIn={gearFeedback.onPressIn}
          onPressOut={gearFeedback.onPressOut}
          style={[styles.gearButton, gearFeedback.animatedStyle]}
          hitSlop={8}
        >
          <Icon name="gear" size={22} color={theme.dim} stroke={1.8} />
        </AnimatedPressable>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: tabBarHeight + 40 }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.dim} />
        }
      >
        {/* Hero — identity, about the user */}
        <View style={styles.hero}>
          <MeroaMark size={64} glow />
          <Text style={styles.name}>{displayName}</Text>
          {me?.user.displayName ? <Text style={styles.sub}>{me.user.phoneE164}</Text> : null}
          <View style={styles.pill}>
            <Text style={styles.pillText}>{me?.entitlement.plan === 'plus' ? 'Member' : 'Meroa'}</Text>
          </View>
          {o ? <Text style={styles.memberSince}>{memberSinceLabel(o.memberSince)}</Text> : null}
        </View>

        {loading ? (
          <View style={{ gap: 12, marginTop: 24 }}>
            <SkeletonBlock height={120} radius={18} />
            <SkeletonBlock height={90} radius={18} />
            <SkeletonBlock height={160} radius={18} />
          </View>
        ) : (
          <>
            {/* Streak — the user's own consistency, never "days with Meroa" */}
            {streak ? (
              <View style={[styles.card, STREAK_BANNER]}>
                <View style={styles.streakHead}>
                  <Text style={styles.streakNum}>{streak.current}</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.streakLabel}>
                      {streak.current === 1 ? 'day streak' : 'day streak'}
                    </Text>
                    {/* label is the same singular/plural by design — "1 day streak" / "5 day streak" */}
                    <Text style={styles.streakSub}>
                      {streak.current > 0
                        ? 'You showed up. Keep it going at your own pace.'
                        : streak.longest > 0
                          ? `Longest streak: ${streak.longest} days. It restarts the next day you finish what's due.`
                          : 'Finish what’s due in a day and a streak starts — no pressure.'}
                    </Text>
                  </View>
                </View>
                {streak.calendar.length > 0 ? (
                  <View style={styles.heatmapWrap}>
                    <Heatmap calendar={streak.calendar} />
                  </View>
                ) : null}
              </View>
            ) : null}

            {/* Stat row — real counts, the same numbers badges are earned from */}
            {o ? (
              <View style={styles.statRow}>
                <Stat value={o.stats.tasksCompleted} label="tasks done" />
                <Stat value={o.stats.goalsActive} label="goals active" />
                <Stat value={o.stats.goalsFinished} label="finished" />
                <Stat value={o.stats.activeDays} label="active days" />
              </View>
            ) : null}

            {/* Achievements — earned + locked teasers */}
            {o ? (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>ACHIEVEMENTS</Text>
                <View style={styles.badgeGrid}>
                  {o.achievements.map((b) => (
                    <AchievementBadge key={b.key} badge={b} />
                  ))}
                </View>
              </View>
            ) : null}

            {/* This month — honest recap, only when there's something to show */}
            {o && (o.month.tasksCompleted > 0 || o.month.goalsAdvanced > 0 || o.month.topHabit) ? (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>THIS MONTH</Text>
                <View style={styles.card}>
                  <Text style={styles.monthLine}>
                    <Text style={styles.monthNum}>{o.month.tasksCompleted}</Text>{' '}
                    {o.month.tasksCompleted === 1 ? 'task' : 'tasks'} completed
                    {o.month.goalsAdvanced > 0 ? (
                      <>
                        {' · '}
                        <Text style={styles.monthNum}>{o.month.goalsAdvanced}</Text> goal
                        {o.month.goalsAdvanced === 1 ? '' : 's'} advanced
                      </>
                    ) : null}
                  </Text>
                  {o.month.topHabit ? (
                    <Text style={styles.monthSub}>
                      Your most-kept habit this month: {o.month.topHabit}
                    </Text>
                  ) : null}
                </View>
              </View>
            ) : null}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <View style={styles.statTile}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  topBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 6 },
  gearSpacer: { flex: 1 },
  gearButton: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },

  hero: { alignItems: 'center', gap: 6, marginTop: 4 },
  name: { color: theme.text, fontSize: 22, fontWeight: '700', marginTop: 8 },
  sub: { color: theme.dim, fontSize: 13 },
  pill: {
    marginTop: 4,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: 'rgba(10,132,255,0.14)',
  },
  pillText: { color: theme.blue, fontSize: 12, fontWeight: '600' },
  memberSince: { color: theme.faint, fontSize: 12, marginTop: 2 },

  card: {
    backgroundColor: theme.card,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: theme.border,
    padding: 16,
    marginTop: 16,
    gap: 12,
  },
  streakHead: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  streakNum: { color: theme.blue, fontSize: 44, fontWeight: '800', minWidth: 56, textAlign: 'center' },
  streakLabel: { color: theme.text, fontSize: 15, fontWeight: '700' },
  streakSub: { color: theme.dim, fontSize: 12.5, marginTop: 2, lineHeight: 17 },
  heatmapWrap: { alignItems: 'center', borderTopWidth: 1, borderTopColor: theme.border, paddingTop: 14 },

  statRow: { flexDirection: 'row', gap: 8, marginTop: 16 },
  statTile: {
    flex: 1,
    backgroundColor: theme.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: theme.border,
    paddingVertical: 14,
    alignItems: 'center',
    gap: 3,
  },
  statValue: { color: theme.text, fontSize: 20, fontWeight: '800' },
  statLabel: { color: theme.faint, fontSize: 11 },

  section: { marginTop: 28 },
  sectionTitle: {
    color: theme.dim,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.2,
    marginBottom: 10,
    paddingHorizontal: 4,
  },
  badgeGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, justifyContent: 'space-between' },

  monthLine: { color: theme.text, fontSize: 15 },
  monthNum: { color: theme.text, fontWeight: '800' },
  monthSub: { color: theme.dim, fontSize: 13 },
});
