import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AnimatedPressable, useRimHighlight, useTapFeedback } from '@/components/AnimatedPressable';
import { Icon } from '@/components/Icon';
import { Ring } from '@/components/Ring';
import { SwipeToDelete } from '@/components/SwipeToDelete';
import { isOverdue, TaskCard, taskProgressFraction } from '@/components/TaskCard';
import { theme } from '@/constants/theme';
import { useMe } from '@/features/profile/queries';
import { TaskFormSheet } from '@/features/tasks/TaskFormSheet';
import { useCompleteTask, useDeleteTask, useProgressTask, useTasks } from '@/features/tasks/queries';
import { useLiveNow } from '@/hooks/use-live-now';
import { useTabBarHeight } from '@/hooks/use-tab-bar-inset';
import type { ApiTask } from '@/lib/api/types';
import { requestNotificationPermission } from '@/lib/notifications';

function haptic() {
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
}

export default function TasksScreen() {
  const { data: tasks = [], isLoading } = useTasks();
  const { data: me } = useMe();
  const timezone = me?.user.timezone;
  const completeTask = useCompleteTask();
  const progressTask = useProgressTask();
  const deleteTask = useDeleteTask();
  const tabBarHeight = useTabBarHeight();
  const addFeedback = useTapFeedback(0.9);

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
  const visibleTasks = nonTemplates.filter((t) => !isOverdue(t, timezone));

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

  const isEmpty = visibleTasks.length === 0 && templates.length === 0 && overdueTasks.length === 0;

  function renderTaskCard(t: ApiTask) {
    return (
      <SwipeToDelete key={t.id} onDelete={() => deleteTask.mutate(t.id)}>
        <TaskCard
          task={t}
          onToggleComplete={() => completeTask.mutate({ id: t.id })}
          onCounterIncrement={() =>
            progressTask.mutate({ id: t.id, input: { kind: 'counter_increment' } })
          }
          onCounterDecrement={() =>
            progressTask.mutate({ id: t.id, input: { kind: 'counter_increment', amount: -1 } })
          }
          onTimerStart={() => {
            void requestNotificationPermission();
            progressTask.mutate({ id: t.id, input: { kind: 'duration_start' } });
          }}
          onTimerStop={() => progressTask.mutate({ id: t.id, input: { kind: 'duration_stop' } })}
          onDurationReopen={() => progressTask.mutate({ id: t.id, input: { kind: 'reopen' } })}
          onToggleItem={(itemId) =>
            progressTask.mutate({ id: t.id, input: { kind: 'checklist_toggle', itemId } })
          }
        />
      </SwipeToDelete>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 20, paddingBottom: tabBarHeight + 40 }}
      >
        <View style={styles.headerRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.eyebrow}>TASKS</Text>
            <Text style={styles.h1}>{today}</Text>
            <Text style={styles.h2}>
              {visibleTasks.length ? `${doneCount} of ${visibleTasks.length} done` : 'Nothing yet'}
            </Text>
          </View>
          <Ring value={pct} size={64} stroke={6} />
          <AnimatedPressable
            onPressIn={addFeedback.onPressIn}
            onPressOut={addFeedback.onPressOut}
            onPress={() => {
              haptic();
              setCreateVisible(true);
            }}
            style={[styles.addBtn, addFeedback.animatedStyle]}
            hitSlop={8}
          >
            <Icon name="plus" size={20} color="#fff" stroke={2.2} />
          </AnimatedPressable>
        </View>

        {isLoading ? (
          <View style={styles.loading}>
            <ActivityIndicator color={theme.dim} />
          </View>
        ) : isEmpty ? (
          <View style={styles.empty}>
            <Text style={styles.emptyText}>{"Nothing yet — tell Meroa what you're up to."}</Text>
          </View>
        ) : (
          visibleTasks.length > 0 && <View style={{ gap: 10, marginTop: 20 }}>{visibleTasks.map(renderTaskCard)}</View>
        )}

        {templates.length > 0 && (
          <View style={{ marginTop: 28 }}>
            <Text style={styles.sectionTitle}>REPEATING</Text>
            <View style={{ gap: 10, marginTop: 10 }}>
              {templates.map((t) => (
                <SwipeToDelete key={t.id} onDelete={() => deleteTask.mutate(t.id)}>
                  <TemplateRow task={t} onPress={() => setEditingTemplate(t)} />
                </SwipeToDelete>
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
        haptic();
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
  addBtn: {
    width: 40,
    height: 40,
    borderRadius: 999,
    backgroundColor: theme.blue,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: theme.blue,
    shadowOpacity: 0.5,
    shadowRadius: 10,
  },
  loading: { alignItems: 'center', justifyContent: 'center', marginTop: 60 },
  empty: { alignItems: 'center', marginTop: 60, paddingHorizontal: 20 },
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
