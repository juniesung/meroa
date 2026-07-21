import { router, Stack } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { AnimatedPressable, useTapFeedback } from '@/components/AnimatedPressable';
import { Icon } from '@/components/Icon';
import { ListSkeleton } from '@/components/Skeleton';
import { LoadError } from '@/components/LoadError';
import { SwipeToDelete } from '@/components/SwipeToDelete';
import { radii, theme } from '@/constants/theme';
import { useDeleteMemory, useMemories } from '@/features/memory/queries';
import { MemoryFormSheet } from '@/features/memory/MemoryFormSheet';
import type { ApiMemory } from '@/lib/api/types';

const KIND_LABEL: Record<string, string> = {
  preference: 'Preferences',
  trait: 'Traits',
  relationship: 'Relationships',
  situation: 'Situations',
};
const KIND_ORDER = ['preference', 'trait', 'relationship', 'situation'];

function sourceHint(memory: ApiMemory): string {
  if (memory.source === 'chat_explicit') return 'you told me';
  if (memory.source === 'extracted') return 'from conversation';
  return 'added manually';
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export default function MemoriesScreen() {
  const { data: memories = [], isLoading, isError, refetch } = useMemories();
  const deleteMemory = useDeleteMemory();
  const [formVisible, setFormVisible] = useState(false);
  const [editing, setEditing] = useState<ApiMemory | null>(null);
  const insets = useSafeAreaInsets();
  const fabFeedback = useTapFeedback();

  const grouped = useMemo(() => {
    const groups = new Map<string, ApiMemory[]>();
    for (const m of memories) {
      const list = groups.get(m.kind) ?? [];
      list.push(m);
      groups.set(m.kind, list);
    }
    return KIND_ORDER.map((kind) => ({ kind, items: groups.get(kind) ?? [] })).filter((g) => g.items.length > 0);
  }, [memories]);

  const openEdit = (memory: ApiMemory) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    setEditing(memory);
    setFormVisible(true);
  };

  const openCreate = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    setEditing(null);
    setFormVisible(true);
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />

      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.iconButton} hitSlop={8}>
          <View style={{ transform: [{ rotate: '180deg' }] }}>
            <Icon name="chevron" size={18} color={theme.text} stroke={2.2} />
          </View>
        </Pressable>
        <Text style={styles.title}>Memory</Text>
        <View style={styles.headerSpacer} />
      </View>

      {isError ? (
        <LoadError onRetry={() => refetch()} />
      ) : isLoading ? (
        <ListSkeleton />
      ) : memories.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>
            Nothing remembered yet. Meroa picks up on things naturally as you talk, or you can add one yourself.
          </Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
          {grouped.map((group) => (
            <View key={group.kind} style={{ marginBottom: 22 }}>
              <Text style={styles.sectionTitle}>{KIND_LABEL[group.kind] ?? group.kind}</Text>
              <View style={{ gap: 8 }}>
                {group.items.map((memory) => (
                  <SwipeToDelete key={memory.id} onDelete={() => deleteMemory.mutate(memory.id)}>
                    {(guardPress) => (
                      <Pressable onPress={guardPress(() => openEdit(memory))} style={styles.card}>
                        <Text style={styles.cardContent}>{memory.content}</Text>
                        <View style={styles.cardMetaRow}>
                          <Text style={styles.cardMeta}>
                            {sourceHint(memory)} · {formatDate(memory.createdAt)}
                          </Text>
                          {memory.sensitive && (
                            <View style={styles.badge}>
                              <Icon name="lock" size={11} color={theme.dim} stroke={2} />
                              <Text style={styles.badgeText}>Sensitive</Text>
                            </View>
                          )}
                          {memory.suppressed && (
                            <View style={styles.badge}>
                              <Text style={styles.badgeText}>Muted</Text>
                            </View>
                          )}
                        </View>
                      </Pressable>
                    )}
                  </SwipeToDelete>
                ))}
              </View>
            </View>
          ))}
        </ScrollView>
      )}

      <AnimatedPressable
        onPress={openCreate}
        onPressIn={fabFeedback.onPressIn}
        onPressOut={fabFeedback.onPressOut}
        style={[styles.fab, { bottom: insets.bottom + 20 }, fabFeedback.animatedStyle]}
        hitSlop={8}
      >
        <Icon name="plus" size={22} color="#fff" stroke={2.4} />
      </AnimatedPressable>

      <MemoryFormSheet visible={formVisible} onClose={() => setFormVisible(false)} memory={editing} />
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
  // Balances the back button on the other side so the title stays centered
  // — same size as iconButton, but invisible (no FAB-adjacent "+" here anymore).
  headerSpacer: { width: 32, height: 32 },
  title: { color: theme.text, fontSize: 16, fontWeight: '700' },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 40 },
  emptyText: { color: theme.dim, fontSize: 14, textAlign: 'center', lineHeight: 20 },
  sectionTitle: {
    color: theme.dim,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.2,
    marginBottom: 8,
    paddingHorizontal: 4,
    textTransform: 'uppercase',
  },
  card: {
    backgroundColor: theme.card,
    borderRadius: radii.card,
    borderWidth: 1,
    borderColor: theme.border,
    padding: 14,
  },
  cardContent: { color: theme.text, fontSize: 14, lineHeight: 20 },
  cardMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' },
  cardMeta: { color: theme.faint, fontSize: 12 },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: radii.pill,
    backgroundColor: theme.surface,
  },
  badgeText: { color: theme.dim, fontSize: 10.5, fontWeight: '600' },
  fab: {
    position: 'absolute',
    right: 20,
    width: 56,
    height: 56,
    borderRadius: 999,
    backgroundColor: theme.blue,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: theme.blue,
    shadowOpacity: 0.5,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
});
