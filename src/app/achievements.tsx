import { router, Stack } from 'expo-router';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AchievementBadge, achievementBadgeKey } from '@/components/AchievementBadge';
import { Icon } from '@/components/Icon';
import { SkeletonBlock } from '@/components/Skeleton';
import { theme } from '@/constants/theme';
import { useAchievements } from '@/features/profile/queries';
import { toIconName } from '@/lib/icon';
import type { ApiPersonalRecord } from '@/lib/api/types';

// The full Achievements surface (off the You tab's "See all"). Everything is the
// user's OWN real progress — earned marks an earned transition, in-progress is
// the goal-gradient "almost there" pull, never a bond with Meroa (CLAUDE.md §2).
export default function AchievementsScreen() {
  const { data, isLoading, isRefetching, refetch } = useAchievements();

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />

      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.backButton} hitSlop={8}>
          <View style={{ transform: [{ rotate: '180deg' }] }}>
            <Icon name="chevron" size={18} color={theme.text} stroke={2.2} />
          </View>
        </Pressable>
        <Text style={styles.title}>Achievements</Text>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 20, paddingBottom: 60 }}
        refreshControl={
          <RefreshControl refreshing={isRefetching} onRefresh={() => void refetch()} tintColor={theme.dim} />
        }
      >
        {isLoading ? (
          <View style={{ gap: 12 }}>
            <SkeletonBlock height={120} radius={16} />
            <SkeletonBlock height={120} radius={16} />
          </View>
        ) : (
          <>
            {data && data.records.length > 0 ? (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>PERSONAL RECORDS</Text>
                <Text style={styles.sectionHint}>Your own bests — always there to beat.</Text>
                <View style={styles.recordRow}>
                  {data.records.map((r) => (
                    <RecordCard key={r.key} record={r} />
                  ))}
                </View>
              </View>
            ) : null}

            {data && data.inProgress.length > 0 ? (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>IN PROGRESS</Text>
                <Text style={styles.sectionHint}>What you&apos;re closest to earning.</Text>
                <View style={styles.grid}>
                  {data.inProgress.map((b) => (
                    <AchievementBadge key={achievementBadgeKey(b)} badge={b} />
                  ))}
                </View>
              </View>
            ) : null}

            <View style={styles.section}>
              <Text style={styles.sectionTitle}>EARNED</Text>
              {data && data.earned.length > 0 ? (
                <View style={styles.grid}>
                  {data.earned.map((b) => (
                    <AchievementBadge key={achievementBadgeKey(b)} badge={b} />
                  ))}
                </View>
              ) : (
                <Text style={styles.empty}>
                  None yet — finish a task or make progress on a goal and your first badge shows up here.
                </Text>
              )}
            </View>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function RecordCard({ record }: { record: ApiPersonalRecord }) {
  return (
    <View style={styles.recordCard}>
      <View style={styles.recordChip}>
        <Icon name={toIconName(record.icon)} size={16} color={theme.blue} stroke={2.2} />
      </View>
      <Text style={styles.recordValue}>{record.value}</Text>
      <Text style={styles.recordUnit}>{record.unit}</Text>
      <Text style={styles.recordLabel} numberOfLines={1}>
        {record.label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: theme.border,
  },
  backButton: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1, color: theme.text, fontSize: 16, fontWeight: '700', textAlign: 'center' },
  headerSpacer: { width: 40 },
  section: { marginBottom: 28 },
  sectionTitle: {
    color: theme.dim,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.2,
    paddingHorizontal: 4,
    // Consistent gap to the content below (the EARNED section has no hint line,
    // so without this its grid sat flush against the title).
    marginBottom: 12,
  },
  // Pulled up under the title so a section WITH a hint keeps the same title→content
  // rhythm as one without.
  sectionHint: { color: theme.faint, fontSize: 12.5, paddingHorizontal: 4, marginTop: -8, marginBottom: 12 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, justifyContent: 'space-between' },
  empty: { color: theme.dim, fontSize: 13.5, lineHeight: 19, marginTop: 10, paddingHorizontal: 4 },
  recordRow: { flexDirection: 'row', gap: 10 },
  recordCard: {
    flex: 1,
    backgroundColor: theme.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: theme.border,
    padding: 12,
    gap: 2,
  },
  recordChip: {
    width: 32,
    height: 32,
    borderRadius: 9,
    backgroundColor: 'rgba(10,132,255,0.14)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  recordValue: { color: theme.text, fontSize: 22, fontWeight: '800' },
  recordUnit: { color: theme.dim, fontSize: 12 },
  recordLabel: { color: theme.faint, fontSize: 11.5, marginTop: 2 },
});
