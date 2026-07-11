import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Ring } from '@/components/Ring';
import { TaskCard } from '@/components/TaskCard';
import { theme } from '@/constants/theme';
import { useTasks, useToggleTask } from '@/features/tasks/queries';
import { useTabBarHeight } from '@/hooks/use-tab-bar-inset';
import { toIconName } from '@/lib/icon';

export default function TasksScreen() {
  const { data: tasks = [], isLoading } = useTasks();
  const toggleTask = useToggleTask();
  const tabBarHeight = useTabBarHeight();

  const visibleTasks = tasks.filter((t) => t.status !== 'archived');
  const doneCount = visibleTasks.filter((t) => t.status === 'done').length;
  const pct = visibleTasks.length ? Math.round((doneCount / visibleTasks.length) * 100) : 0;

  const today = new Date().toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  });

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 20, paddingBottom: tabBarHeight + 40 }}>
        <View style={styles.headerRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.eyebrow}>TODAY</Text>
            <Text style={styles.h1}>{today}</Text>
            <Text style={styles.h2}>
              {visibleTasks.length ? `${doneCount} of ${visibleTasks.length} done` : 'Nothing yet'}
            </Text>
          </View>
          <Ring value={pct} size={64} stroke={6} />
        </View>

        {isLoading ? (
          <View style={styles.loading}>
            <ActivityIndicator color={theme.dim} />
          </View>
        ) : visibleTasks.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyText}>
              {"Nothing yet — tell Meroa what you're up to."}
            </Text>
          </View>
        ) : (
          <View style={{ gap: 10, marginTop: 20 }}>
            {visibleTasks.map((t) => (
              <TaskCard
                key={t.id}
                icon={toIconName(t.icon)}
                title={t.title}
                meta={
                  t.dueAt
                    ? new Date(t.dueAt).toLocaleString(undefined, { hour: 'numeric', minute: '2-digit' })
                    : undefined
                }
                done={t.status === 'done'}
                onToggle={() => toggleTask.mutate(t.id)}
              />
            ))}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  eyebrow: { color: theme.dim, fontSize: 11, fontWeight: '700', letterSpacing: 1.2 },
  h1: { color: theme.text, fontSize: 26, fontWeight: '700', letterSpacing: -0.5, marginTop: 4 },
  h2: { color: theme.dim, fontSize: 14, marginTop: 4 },
  loading: { alignItems: 'center', justifyContent: 'center', marginTop: 60 },
  empty: { alignItems: 'center', marginTop: 60, paddingHorizontal: 20 },
  emptyText: { color: theme.dim, fontSize: 14, textAlign: 'center', lineHeight: 20 },
});
