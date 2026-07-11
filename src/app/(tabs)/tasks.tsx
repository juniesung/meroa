import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Ring } from '@/components/Ring';
import { TaskCard } from '@/components/TaskCard';
import { theme } from '@/constants/theme';
import { useTabBarHeight } from '@/hooks/use-tab-bar-inset';

const initial = [
  { id: '1', icon: 'dumbbell' as const, title: 'Chest workout (30 min)', meta: 'From your chat · 6:42 PM', done: false },
  { id: '2', icon: 'droplet' as const, title: 'Drink 2L of water', meta: 'Daily', done: true },
  { id: '3', icon: 'briefcase' as const, title: 'Review Q3 roadmap', meta: 'Work · 3:00 PM', done: false },
  { id: '4', icon: 'book' as const, title: 'Read 10 pages', meta: 'Habit · 21 day streak', done: false },
  { id: '5', icon: 'clock' as const, title: 'Lights out by 11:30', meta: 'Sleep goal', done: false },
];

export default function TasksScreen() {
  const [tasks, setTasks] = useState(initial);
  const doneCount = tasks.filter((t) => t.done).length;
  const pct = Math.round((doneCount / tasks.length) * 100);
  const tabBarHeight = useTabBarHeight();
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
              {doneCount} of {tasks.length} done
            </Text>
          </View>
          <Ring value={pct} size={64} stroke={6} />
        </View>

        <View style={{ gap: 10, marginTop: 20 }}>
          {tasks.map((t) => (
            <TaskCard
              key={t.id}
              icon={t.icon}
              title={t.title}
              meta={t.meta}
              done={t.done}
              onToggle={() =>
                setTasks((prev) => prev.map((p) => (p.id === t.id ? { ...p, done: !p.done } : p)))
              }
            />
          ))}
        </View>
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
});
