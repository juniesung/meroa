import { router, Stack, useIsFocused, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, { FadeInDown, LinearTransition } from 'react-native-reanimated';

import { Icon } from '@/components/Icon';
import { Progress } from '@/components/Progress';
import { Ring } from '@/components/Ring';
import { DetailSkeleton } from '@/components/Skeleton';
import { TrendChart, type TrendPoint } from '@/components/TrendChart';
import { radii, theme } from '@/constants/theme';
import { banner3dStyle } from '@/lib/banner';
import { goalAccent } from '@/features/goals/goal-accent';
import { useArchiveGoal, useGoal } from '@/features/goals/queries';
import { GoalEntrySheet } from '@/features/goals/GoalEntrySheet';
import { GoalFormSheet } from '@/features/goals/GoalFormSheet';
import { useCompleteTask, useTasks } from '@/features/tasks/queries';
import { useCountUp } from '@/hooks/use-count-up';
import { haptics } from '@/lib/haptics';
import type { ApiGoal, ApiGoalDetail, ApiGoalEntry, ApiTask } from '@/lib/api/types';
import { formatMoney, formatNumber } from '@/lib/format';
import { toIconName } from '@/lib/icon';

function formatEntryLine(detail: ApiGoalDetail, data: { amount: number; note?: string }): string {
  const value =
    detail.type === 'indirect'
      ? `${formatNumber(data.amount)}${detail.unit ?? ''}`
      : `${detail.currency ?? ''}${formatMoney(data.amount)}`;
  return data.note ? `${value} — ${data.note}` : value;
}

function formatEntryDate(iso: string): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${date} · ${time}`;
}

function TotalView({ detail, celebrate, accent }: { detail: ApiGoalDetail; celebrate: boolean; accent: string }) {
  const pct = Math.round((detail.card.progress ?? 0) * 100);
  // The total ticks up to its new value the moment an entry lands — the payoff
  // for logging, instead of the number just swapping. The ring beside it blooms
  // + buzzes if this entry is the one that hits 100%.
  const total = useCountUp(detail.total ?? 0);
  return (
    <View style={[styles.viewCard, banner3dStyle(accent, { tint: theme.card })]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
        <Ring value={pct} size={56} stroke={5} label={`${pct}%`} celebrate={celebrate} />
        <View style={{ flex: 1 }}>
          <Text style={styles.viewHeadline}>
            {detail.currency}{formatMoney(total)} / {detail.currency}{formatMoney(detail.targetValue ?? 0)}
          </Text>
          {detail.card.paceLine ? (
            <Text style={[styles.viewSub, detail.card.onTrack === true && { color: theme.success }]}>
              {detail.card.paceLine}
            </Text>
          ) : null}
        </View>
      </View>
      <Progress value={pct} color={accent} />
    </View>
  );
}

// Habit goals have no total/target — the streak IS the progress
// (docs/goals-redesign-plan.md §1), so the detail hero is the current run,
// not a ring toward a fraction that doesn't exist.
function StreakView({ detail, accent }: { detail: ApiGoalDetail; accent: string }) {
  const streak = detail.streak ?? { current: 0, longest: 0, doneCount: 0 };
  const lit = streak.current > 0;
  return (
    <View style={[styles.viewCard, banner3dStyle(accent, { tint: theme.card })]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
        <View style={[styles.flameChip, lit && { backgroundColor: accent + '24' }]}>
          <Icon name="flame" size={26} color={lit ? accent : theme.faint} stroke={2} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.viewHeadline}>
            {lit ? `${streak.current}-day streak` : 'No streak yet'}
          </Text>
          <Text style={styles.viewSub}>
            longest {streak.longest} · {streak.doneCount} check-in{streak.doneCount === 1 ? '' : 's'}
          </Text>
        </View>
      </View>
      <Text style={styles.habitNote}>Completing the daily task is the check-in — nothing to log here.</Text>
    </View>
  );
}

// Indirect goals never derive a number from a task (docs/goals-redesign-
// plan.md's indirect goal type, locked decision) — the hero here is the
// logged-entries trend line itself, not a ring toward a fabricated fraction.
function TrendView({ detail, entries, accent }: { detail: ApiGoalDetail; entries: ApiGoalEntry[]; accent: string }) {
  const [width, setWidth] = useState(0);
  const points: TrendPoint[] = entries.map((e) => ({ entryAt: e.entryAt, amount: e.data.amount }));

  return (
    <View style={[styles.viewCard, banner3dStyle(accent, { tint: theme.card })]}>
      {detail.card.paceLine ? (
        <Text style={[styles.viewSub, detail.card.onTrack === true && { color: theme.success }]}>
          {detail.card.paceLine}
        </Text>
      ) : null}
      {points.length > 0 ? (
        <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
          <TrendChart entries={points} unit={detail.unit ?? ''} targetValue={detail.targetValue} width={width} />
        </View>
      ) : (
        <Text style={styles.emptyText}>Log your first {detail.unit} to start the chart.</Text>
      )}
    </View>
  );
}

// Milestone goals never have numbers or entries (docs/milestone-goal-plan.md
// §0) — the hero is the ordered stage list. Advancing only happens through
// the chat confirm card (nothing here moves a stage), but each stage now
// shows what's actually attached to it:
//   - the ACTIVE stage's real, linked ApiTasks — tappable, completable here,
//     the same TaskCard-style checkbox as everywhere else in the app.
//   - an upcoming stage's PLANNED tasks (goal.definition.stagePlans) — a
//     visibly different, non-tappable row (dashed marker, dim text, a clock
//     icon) since a plan is an intention, not a record. That distinction is
//     load-bearing (docs/goal-manual-editing-plan.md §3.8): the app must
//     never blur "planned" with "real."
function StagesView({ goal, tasks, accent }: { goal: ApiGoal; tasks: ApiTask[]; accent: string }) {
  const completeTask = useCompleteTask();
  if (goal.definition.type !== 'milestone') return null;
  const { stages, activeStageIndex, stagePlans } = goal.definition;
  const linkedTasks = tasks.filter((t) => t.goalId === goal.id && t.status !== 'archived');

  if (stages.length === 0) {
    return (
      <View style={styles.viewCard}>
        <Text style={styles.emptyText}>No stages yet — tap Edit above to add them.</Text>
      </View>
    );
  }

  return (
    <View style={{ gap: 10 }}>
      {stages.map((stage, i) => {
        const done = i < activeStageIndex;
        const active = i === activeStageIndex;
        const plans = stagePlans?.[i] ?? [];
        return (
          // Only the ACTIVE stage extrudes in the goal color — the current
          // focus pops without turning the whole stage list into a wall of it.
          <View key={i} style={[styles.viewCard, active && banner3dStyle(accent, { tint: theme.card })]}>
            <View style={styles.stageRow}>
              <View style={[styles.stageMarker, done && styles.stageMarkerDone, active && styles.stageMarkerActive]}>
                {done ? (
                  <Icon name="check" size={12} color="#fff" stroke={2.4} />
                ) : (
                  <Text style={[styles.stageMarkerText, active && styles.stageMarkerTextActive]}>{i + 1}</Text>
                )}
              </View>
              <Text style={[styles.stageLabel, done && styles.stageLabelDone, active && styles.stageLabelActive]}>
                {stage}
              </Text>
            </View>

            {active && linkedTasks.length > 0 && (
              <View style={{ gap: 6, marginTop: 8 }}>
                {linkedTasks.map((t) => (
                  <Pressable
                    key={t.id}
                    onPress={() => completeTask.mutate({ id: t.id })}
                    style={styles.realTaskRow}
                  >
                    <View style={[styles.realTaskCheck, t.status === 'done' && styles.realTaskCheckDone]}>
                      {t.status === 'done' && <Icon name="check" size={10} color="#fff" stroke={2.6} />}
                    </View>
                    <Text
                      style={[styles.realTaskText, t.status === 'done' && styles.realTaskTextDone]}
                      numberOfLines={1}
                    >
                      {t.title}
                    </Text>
                  </Pressable>
                ))}
              </View>
            )}

            {!active && !done && plans.length > 0 && (
              <View style={{ gap: 6, marginTop: 8 }}>
                {plans.map((p, idx) => (
                  <View key={idx} style={styles.plannedTaskRow}>
                    <Icon name="clock" size={12} color={theme.faint} stroke={2} />
                    <Text style={styles.plannedTaskText} numberOfLines={1}>
                      {p.title}
                    </Text>
                  </View>
                ))}
              </View>
            )}
          </View>
        );
      })}
      <Text style={styles.habitNote}>
        A stage only advances when you tell Meroa it&apos;s done. Dashed tasks are planned — they
        become real tasks automatically once their stage activates.
      </Text>
    </View>
  );
}

export default function GoalDetailScreen() {
  const isFocused = useIsFocused();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data, isLoading } = useGoal(id);
  const { data: tasks = [] } = useTasks();
  const archiveGoal = useArchiveGoal();
  const [entrySheetOpen, setEntrySheetOpen] = useState(false);
  const [editVisible, setEditVisible] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  if (isLoading || !data) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <Stack.Screen options={{ headerShown: false }} />
        <DetailSkeleton />
      </SafeAreaView>
    );
  }

  const { goal, detail, entries } = data;
  const accent = goalAccent(detail.type);
  const isHabit = detail.type === 'habit';
  const isIndirect = detail.type === 'indirect';
  const isMilestone = detail.type === 'milestone';
  const hidesEntries = isHabit || isMilestone;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />

      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.backButton} hitSlop={8}>
          <View style={{ transform: [{ rotate: '180deg' }] }}>
            <Icon name="chevron" size={18} color={theme.text} stroke={2.2} />
          </View>
        </Pressable>
        <View style={[styles.iconChip, { backgroundColor: accent + '22' }]}>
          <Icon name={toIconName(goal.icon)} size={20} color={accent} stroke={1.9} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.title} numberOfLines={1}>
            {goal.name}
          </Text>
          <Text style={styles.subtitle}>{detail.card.sub}</Text>
        </View>
        <Pressable
          onPress={() => {
            haptics.tap();
            setEditVisible(true);
          }}
          style={styles.editButton}
          hitSlop={8}
        >
          <Icon name="edit" size={17} color={theme.dim} stroke={1.8} />
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 120, gap: 12 }}>
        <Text style={styles.headline}>{detail.card.headline}</Text>

        {isHabit ? (
          <StreakView detail={detail} accent={accent} />
        ) : isMilestone ? (
          <StagesView goal={goal} tasks={tasks} accent={accent} />
        ) : isIndirect ? (
          <TrendView detail={detail} entries={entries} accent={accent} />
        ) : (
          <TotalView detail={detail} celebrate={isFocused && !isLoading} accent={accent} />
        )}

        {!hidesEntries && (
          <>
            <Text style={styles.sectionTitle}>History</Text>
            {entries.length === 0 ? (
              <Text style={styles.emptyText}>No entries yet — log your first one.</Text>
            ) : (
              <View style={{ gap: 8 }}>
                {entries.map((entry: ApiGoalEntry) => (
                  // A freshly logged entry drops in and the rest slide down to
                  // make room; on first open every row fades in gently.
                  <Animated.View
                    key={entry.id}
                    entering={FadeInDown.duration(260)}
                    layout={LinearTransition.springify().damping(20).stiffness(180)}
                    style={styles.entryRow}
                  >
                    <Text style={styles.entryLine} numberOfLines={1}>
                      {formatEntryLine(detail, entry.data)}
                    </Text>
                    <Text style={styles.entryDate}>{formatEntryDate(entry.entryAt)}</Text>
                  </Animated.View>
                ))}
              </View>
            )}
          </>
        )}

        <View style={{ marginTop: 24, alignItems: 'center' }}>
          {confirmingRemove ? (
            <View style={styles.removeConfirmRow}>
              <Pressable onPress={() => setConfirmingRemove(false)} style={styles.removeCancelButton} hitSlop={8}>
                <Text style={styles.removeCancelText}>Keep it</Text>
              </Pressable>
              <Pressable
                onPress={() => {
                  haptics.warning();
                  archiveGoal.mutate(goal.id, { onSuccess: () => router.back() });
                }}
                style={styles.removeConfirmButton}
                hitSlop={8}
              >
                <Text style={styles.removeConfirmText}>Remove goal</Text>
              </Pressable>
            </View>
          ) : (
            <Pressable onPress={() => setConfirmingRemove(true)} hitSlop={8}>
              <Text style={styles.removeLink}>Remove this goal</Text>
            </Pressable>
          )}
        </View>
      </ScrollView>

      {!hidesEntries && (
        <>
          <Pressable
            onPress={() => {
              haptics.tap();
              setEntrySheetOpen(true);
            }}
            style={styles.logButton}
          >
            <Icon name="plus" size={18} color="#fff" stroke={2.2} />
            <Text style={styles.logButtonText}>Log</Text>
          </Pressable>

          <GoalEntrySheet visible={entrySheetOpen} onClose={() => setEntrySheetOpen(false)} goal={goal} />
        </>
      )}

      <GoalFormSheet visible={editVisible} onClose={() => setEditVisible(false)} goal={goal} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: theme.border,
  },
  backButton: {
    width: 32,
    height: 32,
    borderRadius: 999,
    backgroundColor: theme.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconChip: {
    width: 34,
    height: 34,
    borderRadius: radii.chip,
    backgroundColor: 'rgba(10,132,255,0.14)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  editButton: {
    width: 32,
    height: 32,
    borderRadius: 999,
    backgroundColor: theme.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { color: theme.text, fontSize: 16, fontWeight: '700' },
  subtitle: { color: theme.dim, fontSize: 12, marginTop: 1 },
  headline: { color: theme.text, fontSize: 26, fontWeight: '700', letterSpacing: -0.5, marginBottom: 4 },
  viewCard: {
    backgroundColor: theme.card,
    borderColor: theme.borderStrong,
    borderWidth: 1,
    borderRadius: radii.card,
    padding: 14,
    gap: 10,
  },
  viewHeadline: { color: theme.text, fontSize: 17, fontWeight: '700' },
  viewSub: { color: theme.dim, fontSize: 12 },
  flameChip: {
    width: 56,
    height: 56,
    borderRadius: 999,
    backgroundColor: theme.card2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  habitNote: { color: theme.faint, fontSize: 12 },
  stageRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  stageMarker: {
    width: 24,
    height: 24,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: theme.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stageMarkerDone: { backgroundColor: theme.blue, borderColor: theme.blue },
  stageMarkerActive: { borderColor: theme.blue, backgroundColor: 'rgba(10,132,255,0.14)' },
  stageMarkerText: { color: theme.dim, fontSize: 11, fontWeight: '700' },
  stageMarkerTextActive: { color: theme.blue },
  stageLabel: { color: theme.dim, fontSize: 14, flex: 1 },
  stageLabelDone: { color: theme.faint, textDecorationLine: 'line-through' },
  stageLabelActive: { color: theme.text, fontWeight: '700' },
  // Active stage: a real, tappable task — same checkbox language as TaskCard
  // elsewhere in the app, just compact for this nested context.
  realTaskRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginLeft: 30 },
  realTaskCheck: {
    width: 18,
    height: 18,
    borderRadius: 999,
    borderWidth: 1.5,
    borderColor: theme.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  realTaskCheckDone: { backgroundColor: theme.blue, borderColor: theme.blue },
  realTaskText: { color: theme.text, fontSize: 13, flex: 1 },
  realTaskTextDone: { color: theme.faint, textDecorationLine: 'line-through' },
  // Upcoming stage: a PLAN, not a task — dashed marker, dim text, a clock
  // instead of a checkbox, and never a Pressable. The visual gap from
  // realTaskRow above is the point (docs/goal-manual-editing-plan.md §3.8).
  plannedTaskRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginLeft: 30,
    paddingVertical: 3,
    paddingHorizontal: 8,
    borderRadius: radii.chip,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: theme.border,
  },
  plannedTaskText: { color: theme.faint, fontSize: 12.5, flex: 1 },
  sectionTitle: { color: theme.text, fontSize: 15, fontWeight: '700', marginTop: 10 },
  emptyText: { color: theme.dim, fontSize: 13 },
  entryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: theme.card,
    borderColor: theme.border,
    borderWidth: 1,
    borderRadius: radii.controlTight,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  entryLine: { color: theme.text, fontSize: 14, flex: 1, marginRight: 10 },
  entryDate: { color: theme.faint, fontSize: 11 },
  removeLink: { color: theme.faint, fontSize: 13 },
  removeConfirmRow: { flexDirection: 'row', gap: 10, width: '100%' },
  removeCancelButton: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    borderRadius: radii.controlTight,
    borderWidth: 1,
    borderColor: theme.borderStrong,
  },
  removeCancelText: { color: theme.text, fontSize: 14, fontWeight: '600' },
  removeConfirmButton: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    borderRadius: radii.controlTight,
    backgroundColor: theme.danger,
  },
  removeConfirmText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  logButton: {
    position: 'absolute',
    right: 20,
    bottom: 30,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderRadius: radii.pill,
    backgroundColor: theme.blue,
    shadowColor: theme.blue,
    shadowOpacity: 0.5,
    shadowRadius: 10,
  },
  logButtonText: { color: '#fff', fontSize: 15, fontWeight: '700' },
});
