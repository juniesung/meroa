import { router, Stack } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Icon } from '@/components/Icon';
import { radii, theme } from '@/constants/theme';
import { useArchivedGoals, useRestoreGoal } from '@/features/goals/queries';
import { toIconName } from '@/lib/icon';
import type { ApiGoal } from '@/lib/api/types';

// Removing a goal has always been reversible in principle — undo_last_action
// could bring one back — but only while it was still the most recent action,
// so anything removed a few steps ago was effectively gone. This screen is
// the way back, and it's the only surface that lists archived goals (the
// Goals tab deliberately shows only live ones).
//
// Deliberately its own flat list rather than routing into goal/[id]: that
// screen's data comes from getGoal, which filters archived rows out
// server-side, so reusing it would mean threading an "include archived" flag
// through the whole type-discriminated detail view for a row whose only
// available action is "put it back".

function formatArchivedAt(iso: string | null): string {
  if (!iso) return 'Removed';
  return `Removed ${new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}

function ArchivedRow({ goal }: { goal: ApiGoal }) {
  const restoreGoal = useRestoreGoal();

  return (
    <View style={styles.card}>
      <View style={styles.iconChip}>
        <Icon name={toIconName(goal.icon)} size={16} color={theme.dim} stroke={2} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.cardTitle} numberOfLines={1}>
          {goal.name}
        </Text>
        <Text style={styles.cardMeta}>{formatArchivedAt(goal.archivedAt)}</Text>
      </View>
      <Pressable
        onPress={() => {
          if (restoreGoal.isPending) return;
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
          restoreGoal.mutate(goal.id);
        }}
        style={styles.restoreBtn}
        hitSlop={6}
      >
        <Text style={styles.restoreText}>{restoreGoal.isPending ? '…' : 'Restore'}</Text>
      </Pressable>
    </View>
  );
}

export default function ArchivedGoalsScreen() {
  const { data: goals = [], isLoading } = useArchivedGoals();

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />

      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.iconButton} hitSlop={8}>
          <View style={{ transform: [{ rotate: '180deg' }] }}>
            <Icon name="chevron" size={18} color={theme.text} stroke={2.2} />
          </View>
        </Pressable>
        <Text style={styles.title}>Archived</Text>
        <View style={styles.headerSpacer} />
      </View>

      {isLoading ? (
        <View style={styles.loading}>
          <ActivityIndicator color={theme.dim} />
        </View>
      ) : goals.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>
            Nothing archived. Goals you remove land here — nothing is ever deleted, so you can
            always bring one back.
          </Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40, gap: 10 }}>
          <Text style={styles.hint}>
            Restoring a goal brings its linked tasks back with it.
          </Text>
          {goals.map((goal) => (
            <ArchivedRow key={goal.id} goal={goal} />
          ))}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: theme.border,
  },
  iconButton: {
    width: 32,
    height: 32,
    borderRadius: 999,
    backgroundColor: theme.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerSpacer: { width: 32, height: 32 },
  title: { color: theme.text, fontSize: 16, fontWeight: '700' },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 40 },
  emptyText: { color: theme.dim, fontSize: 14, textAlign: 'center', lineHeight: 20 },
  hint: { color: theme.faint, fontSize: 12, paddingHorizontal: 2, marginBottom: 2 },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: theme.card,
    borderRadius: radii.card,
    borderWidth: 1,
    borderColor: theme.border,
    padding: 14,
  },
  iconChip: {
    width: 34,
    height: 34,
    borderRadius: radii.chip,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.card2,
  },
  cardTitle: { color: theme.text, fontSize: 15, fontWeight: '600' },
  cardMeta: { color: theme.faint, fontSize: 12, marginTop: 2 },
  restoreBtn: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.surface,
  },
  restoreText: { color: theme.blue, fontSize: 13, fontWeight: '600' },
});
