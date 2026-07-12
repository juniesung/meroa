import { router, Stack, useLocalSearchParams } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Icon } from '@/components/Icon';
import { Progress } from '@/components/Progress';
import { Ring } from '@/components/Ring';
import { radii, theme } from '@/constants/theme';
import { useArchiveGoal, useGoal } from '@/features/goals/queries';
import { GoalEntrySheet } from '@/features/goals/GoalEntrySheet';
import type { ApiGoalDetail, ApiGoalEntry } from '@/lib/api/types';
import { toIconName } from '@/lib/icon';

function formatNumber(n: number): string {
  return Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function formatEntryLine(currency: string, data: { amount: number; note?: string }): string {
  return data.note ? `${currency}${formatNumber(data.amount)} — ${data.note}` : `${currency}${formatNumber(data.amount)}`;
}

function formatEntryDate(iso: string): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${date} · ${time}`;
}

function TotalView({ detail }: { detail: ApiGoalDetail }) {
  const pct = Math.round((detail.card.progress ?? 0) * 100);
  return (
    <View style={styles.viewCard}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
        <Ring value={pct} size={56} stroke={5} label={`${pct}%`} />
        <View style={{ flex: 1 }}>
          <Text style={styles.viewHeadline}>
            {detail.currency}{formatNumber(detail.total)} / {detail.currency}{formatNumber(detail.targetValue)}
          </Text>
          {detail.card.paceLine ? <Text style={styles.viewSub}>{detail.card.paceLine}</Text> : null}
        </View>
      </View>
      <Progress value={pct} />
    </View>
  );
}

export default function GoalDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data, isLoading } = useGoal(id);
  const archiveGoal = useArchiveGoal();
  const [entrySheetOpen, setEntrySheetOpen] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  if (isLoading || !data) {
    return (
      <SafeAreaView style={styles.safe}>
        <Stack.Screen options={{ headerShown: false }} />
        <View style={styles.loading}>
          <ActivityIndicator color={theme.dim} />
        </View>
      </SafeAreaView>
    );
  }

  const { goal, detail, entries } = data;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />

      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.backButton} hitSlop={8}>
          <View style={{ transform: [{ rotate: '180deg' }] }}>
            <Icon name="chevron" size={18} color={theme.text} stroke={2.2} />
          </View>
        </Pressable>
        <View style={styles.iconChip}>
          <Icon name={toIconName(goal.icon)} size={20} color={theme.blue} stroke={1.9} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.title} numberOfLines={1}>
            {goal.name}
          </Text>
          <Text style={styles.subtitle}>{detail.card.sub}</Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 120, gap: 12 }}>
        <Text style={styles.headline}>{detail.card.headline}</Text>

        <TotalView detail={detail} />

        <Text style={styles.sectionTitle}>History</Text>
        {entries.length === 0 ? (
          <Text style={styles.emptyText}>No entries yet — log your first one.</Text>
        ) : (
          <View style={{ gap: 8 }}>
            {entries.map((entry: ApiGoalEntry) => (
              <View key={entry.id} style={styles.entryRow}>
                <Text style={styles.entryLine} numberOfLines={1}>
                  {formatEntryLine(detail.currency, entry.data)}
                </Text>
                <Text style={styles.entryDate}>{formatEntryDate(entry.entryAt)}</Text>
              </View>
            ))}
          </View>
        )}

        <View style={{ marginTop: 24, alignItems: 'center' }}>
          {confirmingRemove ? (
            <View style={styles.removeConfirmRow}>
              <Pressable onPress={() => setConfirmingRemove(false)} style={styles.removeCancelButton} hitSlop={8}>
                <Text style={styles.removeCancelText}>Keep it</Text>
              </Pressable>
              <Pressable
                onPress={() => {
                  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
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

      <Pressable
        onPress={() => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
          setEntrySheetOpen(true);
        }}
        style={styles.logButton}
      >
        <Icon name="plus" size={18} color="#fff" stroke={2.2} />
        <Text style={styles.logButtonText}>Log</Text>
      </Pressable>

      <GoalEntrySheet visible={entrySheetOpen} onClose={() => setEntrySheetOpen(false)} goal={goal} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
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
