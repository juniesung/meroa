import { useIsFocused } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useRimHighlight } from '@/components/AnimatedPressable';
import { AddFab } from '@/components/AddFab';
import { Icon } from '@/components/Icon';
import { LoadError } from '@/components/LoadError';
import { MeroaMark } from '@/components/MeroaMark';
import { Ring } from '@/components/Ring';
import { TaskListSkeleton } from '@/components/Skeleton';
import { SwipeToDelete } from '@/components/SwipeToDelete';
import { isOverdue, isPastDue, isUpcoming, TaskCard, taskProgressFraction } from '@/components/TaskCard';
import { theme } from '@/constants/theme';
import { useGoals } from '@/features/goals/queries';
import { useMe } from '@/features/profile/queries';
import { TaskFormSheet } from '@/features/tasks/TaskFormSheet';
import { useCompleteTask, useDeleteTask, useProgressTask, useTasks } from '@/features/tasks/queries';
import { haptics } from '@/lib/haptics';
import { useLiveNow } from '@/hooks/use-live-now';
import { usePullRefresh } from '@/hooks/use-pull-refresh';
import { useTabBarHeight } from '@/hooks/use-tab-bar-inset';
import type { ApiTask } from '@/lib/api/types';
import { requestNotificationPermission } from '@/lib/notifications';

// A row slides to close a gap when its neighbor is deleted or it changes
// section, and fades out as it's removed — so the list settles instead of
// snapping. `entering` is deliberately omitted: the tab remounts on every
// visit, and re-fading the whole list each time reads as jitter, not polish.
const ROW_LAYOUT = LinearTransition.springify().damping(20).stiffness(180);

export default function TasksScreen() {
  const { data: tasks = [], isLoading, isError, refetch } = useTasks();
  const { data: goals = [] } = useGoals();
  const { data: me } = useMe();
  const timezone = me?.user.timezone;
  const completeTask = useCompleteTask();
  const progressTask = useProgressTask();
  const deleteTask = useDeleteTask();
  const tabBarHeight = useTabBarHeight();
  const isFocused = useIsFocused();
  // A goal-linked task auto-logs a goal entry, so a manual refresh pulls both.
  const { refreshing, onRefresh } = usePullRefresh([['tasks'], ['goals']]);

  // Deleting a goal-linked recurring task is never a silent swipe
  // (user rule): a template takes its goal with it (the server cascade in
  // lib/tasks/executor.ts), so it gets an explicit "removes the goal too"
  // confirm; a day instance only skips today and comes back tomorrow, so
  // its confirm just says that. Everything else deletes on swipe as before.
  function confirmDelete(t: ApiTask) {
    const linkedGoal = t.goalId ? goals.find((g) => g.id === t.goalId) : undefined;
    if (!linkedGoal) {
      deleteTask.mutate(t.id);
      return;
    }
    if (t.recurrence) {
      Alert.alert(
        'This task powers a goal',
        `"${t.title}" is the repeating task behind "${linkedGoal.name}". Deleting it removes the goal too.`,
        [
          { text: 'Keep it', style: 'cancel' },
          { text: 'Delete both', style: 'destructive', onPress: () => deleteTask.mutate(t.id) },
        ],
      );
      return;
    }
    if (t.templateId) {
      Alert.alert(
        'Skip today?',
        `"${t.title}" is linked to "${linkedGoal.name}". Deleting removes it just for today — it'll be back tomorrow.`,
        [
          { text: 'Keep it', style: 'cancel' },
          { text: 'Skip today', style: 'destructive', onPress: () => deleteTask.mutate(t.id) },
        ],
      );
      return;
    }
    deleteTask.mutate(t.id);
  }

  const [createVisible, setCreateVisible] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<ApiTask | null>(null);

  // Templates (recurrence != null) are abstract — their dated instances are
  // what's actionable day to day, so the day list only shows instances and
  // standalone (non-recurring) tasks. Templates get their own section,
  // edited only from there — a day's specific instance is act-on-only
  // (complete/delete), never edited.
  const nonTemplates = tasks.filter((t) => t.status !== 'archived' && !t.recurrence);
  const templates = tasks.filter((t) => !!t.recurrence);
  const overdueTasks = nonTemplates.filter((t) => isOverdue(t, timezone));
  // Anything due after today drops out of the day list into its own section at
  // the bottom — the top of this screen is "what do I have to do today", and a
  // task due Friday sitting in it is just noise you have to read past every time.
  // Soonest first, so the next thing you'll actually face is at the top of it.
  const upcomingTasks = nonTemplates
    .filter((t) => isUpcoming(t, timezone))
    .sort((a, b) => (a.dueAt ?? '').localeCompare(b.dueAt ?? ''));
  // "Today" = not due on a past day (isPastDue, any status) and not upcoming.
  // Using isPastDue rather than isOverdue (open-only) is what drops a completed
  // prior-day recurring instance out of today's list — an open past task is
  // still surfaced separately in the OVERDUE section below.
  const visibleTasks = nonTemplates.filter(
    (t) => !isPastDue(t, timezone) && !isUpcoming(t, timezone),
  );

  const hasRunningTimer = visibleTasks.some(
    (t) => t.type === 'duration' && !!(t.config as { runningSince?: string | null }).runningSince,
  );
  const now = useLiveNow(hasRunningTimer);

  const doneCount = visibleTasks.filter((t) => t.status === 'done').length;
  const pct = visibleTasks.length
    ? Math.round(
        (visibleTasks.reduce((sum, t) => sum + taskProgressFraction(t, now), 0) / visibleTasks.length) *
          100,
      )
    : 0;

  const today = new Date().toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  });

  const isEmpty =
    visibleTasks.length === 0 &&
    templates.length === 0 &&
    overdueTasks.length === 0 &&
    upcomingTasks.length === 0;

  function renderTaskCard(t: ApiTask) {
    return (
      <Animated.View key={t.id} layout={ROW_LAYOUT} exiting={FadeOut.duration(180)}>
        <SwipeToDelete onDelete={() => confirmDelete(t)}>
        {(guardPress) => (
          <TaskCard
            task={t}
            onToggleComplete={guardPress(() => completeTask.mutate({ id: t.id }))}
            onCounterIncrement={guardPress(() =>
              progressTask.mutate({ id: t.id, input: { kind: 'counter_increment' } }),
            )}
            onCounterDecrement={guardPress(() =>
              progressTask.mutate({ id: t.id, input: { kind: 'counter_increment', amount: -1 } }),
            )}
            onTimerStart={guardPress(() => {
              void requestNotificationPermission();
              progressTask.mutate({ id: t.id, input: { kind: 'duration_start' } });
            })}
            onTimerStop={guardPress(() =>
              progressTask.mutate({ id: t.id, input: { kind: 'duration_stop' } }),
            )}
            onDurationReopen={guardPress(() =>
              progressTask.mutate({ id: t.id, input: { kind: 'reopen' } }),
            )}
            onToggleItem={guardPress((itemId: string) =>
              progressTask.mutate({ id: t.id, input: { kind: 'checklist_toggle', itemId } }),
            )}
          />
        )}
        </SwipeToDelete>
      </Animated.View>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 20, paddingBottom: tabBarHeight + 40 }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.dim} colors={[theme.blue]} />
        }
      >
        <View style={styles.headerRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.eyebrow}>TASKS</Text>
            <Text style={styles.h1}>{today}</Text>
            <Text style={styles.h2}>
              {visibleTasks.length ? `${doneCount} of ${visibleTasks.length} done` : 'Nothing yet'}
            </Text>
          </View>
          <Ring value={pct} size={64} stroke={6} celebrate={isFocused && !isLoading} />
        </View>

        {isError ? (
          <LoadError onRetry={() => refetch()} />
        ) : isLoading ? (
          <TaskListSkeleton />
        ) : isEmpty ? (
          <Animated.View entering={FadeIn.duration(320)} style={styles.empty}>
            <MeroaMark size={44} glow />
            <Text style={styles.emptyText}>{"Nothing yet — tell Meroa what you're up to and it'll line up your day."}</Text>
          </Animated.View>
        ) : (
          visibleTasks.length > 0 && <View style={{ gap: 10, marginTop: 20 }}>{visibleTasks.map(renderTaskCard)}</View>
        )}

        {upcomingTasks.length > 0 && (
          <View style={{ marginTop: 28 }}>
            <Text style={styles.sectionTitle}>TOMORROW</Text>
            <View style={{ gap: 10, marginTop: 10 }}>{upcomingTasks.map(renderTaskCard)}</View>
          </View>
        )}

        {templates.length > 0 && (
          <View style={{ marginTop: 28 }}>
            <Text style={styles.sectionTitle}>REPEATING</Text>
            <View style={{ gap: 10, marginTop: 10 }}>
              {templates.map((t) => (
                <Animated.View key={t.id} layout={ROW_LAYOUT} exiting={FadeOut.duration(180)}>
                  <SwipeToDelete onDelete={() => confirmDelete(t)}>
                    {(guardPress) => (
                      <TemplateRow task={t} onPress={guardPress(() => setEditingTemplate(t))} />
                    )}
                  </SwipeToDelete>
                </Animated.View>
              ))}
            </View>
          </View>
        )}

        {overdueTasks.length > 0 && (
          <View style={{ marginTop: 28 }}>
            <Text style={styles.sectionTitle}>OVERDUE</Text>
            <View style={{ gap: 10, marginTop: 10 }}>{overdueTasks.map(renderTaskCard)}</View>
          </View>
        )}
      </ScrollView>

      <AddFab onPress={() => setCreateVisible(true)} bottom={tabBarHeight + 16} />

      <TaskFormSheet visible={createVisible} onClose={() => setCreateVisible(false)} />
      <TaskFormSheet
        visible={!!editingTemplate}
        onClose={() => setEditingTemplate(null)}
        task={editingTemplate ?? undefined}
      />
    </SafeAreaView>
  );
}

function TemplateRow({ task, onPress }: { task: ApiTask; onPress: () => void }) {
  const rim = useRimHighlight();
  return (
    <Pressable
      onPress={() => {
        haptics.tap();
        onPress();
      }}
      onPressIn={rim.onPressIn}
      onPressOut={rim.onPressOut}
      style={styles.templateRow}
    >
      <Animated.View pointerEvents="none" style={[styles.templateRimHighlight, rim.highlightStyle]} />
      <View style={styles.templateIconChip}>
        <Icon name="repeat" size={16} color={theme.blue} stroke={2} />
      </View>
      <Text style={styles.templateTitle}>{task.title}</Text>
      <Icon name="chevron" size={16} color={theme.faint} stroke={2} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  eyebrow: { color: theme.dim, fontSize: 11, fontWeight: '700', letterSpacing: 1.2 },
  h1: { color: theme.text, fontSize: 26, fontWeight: '700', letterSpacing: -0.5, marginTop: 4 },
  h2: { color: theme.dim, fontSize: 14, marginTop: 4 },
  empty: { alignItems: 'center', marginTop: 60, paddingHorizontal: 20, gap: 16 },
  emptyText: { color: theme.dim, fontSize: 14, textAlign: 'center', lineHeight: 20 },
  sectionTitle: { color: theme.dim, fontSize: 11, fontWeight: '700', letterSpacing: 1.2 },
  templateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: theme.card,
    borderColor: theme.borderStrong,
    borderWidth: 1,
    borderRadius: 18,
    padding: 14,
    position: 'relative',
  },
  templateRimHighlight: {
    position: 'absolute',
    top: -1,
    left: -1,
    right: -1,
    bottom: -1,
    borderRadius: 18,
    borderWidth: 1.5,
    borderColor: theme.blue,
    backgroundColor: 'rgba(10,132,255,0.10)',
  },
  templateIconChip: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: 'rgba(10,132,255,0.14)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  templateTitle: { color: theme.text, fontSize: 15, fontWeight: '600', flex: 1 },
});
