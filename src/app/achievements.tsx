import { router, Stack } from 'expo-router';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AchievementBadge } from '@/components/AchievementBadge';
import { Icon } from '@/components/Icon';
import { SkeletonBlock } from '@/components/Skeleton';
import { theme } from '@/constants/theme';
import { useAchievements } from '@/features/profile/queries';

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
            {data && data.inProgress.length > 0 ? (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>IN PROGRESS</Text>
                <Text style={styles.sectionHint}>What you&apos;re closest to earning.</Text>
                <View style={styles.grid}>
                  {data.inProgress.map((b) => (
                    <AchievementBadge key={b.key} badge={b} />
                  ))}
                </View>
              </View>
            ) : null}

            <View style={styles.section}>
              <Text style={styles.sectionTitle}>EARNED</Text>
              {data && data.earned.length > 0 ? (
                <View style={styles.grid}>
                  {data.earned.map((b) => (
                    <AchievementBadge key={b.key} badge={b} />
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
  },
  sectionHint: { color: theme.faint, fontSize: 12.5, paddingHorizontal: 4, marginTop: 4, marginBottom: 12 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, justifyContent: 'space-between' },
  empty: { color: theme.dim, fontSize: 13.5, lineHeight: 19, marginTop: 10, paddingHorizontal: 4 },
});
