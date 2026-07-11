import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Icon } from '@/components/Icon';
import { radii, theme } from '@/constants/theme';
import { useTools } from '@/features/tools/queries';
import { useTabBarHeight } from '@/hooks/use-tab-bar-inset';
import { toIconName } from '@/lib/icon';

export default function ToolsScreen() {
  const { data: tools = [], isLoading } = useTools();
  const tabBarHeight = useTabBarHeight();

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 20, paddingBottom: tabBarHeight + 40 }}>
        <Text style={styles.eyebrow}>PERSONALIZED TOOLS</Text>
        <Text style={styles.h1}>Your progress</Text>
        <Text style={styles.p}>Meroa builds these from your conversations. They grow as you do.</Text>

        {isLoading ? (
          <View style={styles.loading}>
            <ActivityIndicator color={theme.dim} />
          </View>
        ) : tools.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyText}>
              {"No tools yet — describe a goal to Meroa and it'll build one with you."}
            </Text>
          </View>
        ) : (
          <View style={{ gap: 12, marginTop: 20 }}>
            {tools.map((tool) => (
              <View key={tool.id} style={styles.card}>
                <View style={styles.iconChip}>
                  <Icon name={toIconName(tool.icon)} size={18} color={theme.blue} stroke={1.9} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.cardTitle}>{tool.name}</Text>
                  <Text style={styles.cardMeta}>
                    {tool.entryCount} {tool.entryCount === 1 ? 'entry' : 'entries'} logged
                  </Text>
                </View>
              </View>
            ))}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  eyebrow: { color: theme.dim, fontSize: 11, fontWeight: '700', letterSpacing: 1.2 },
  h1: { color: theme.text, fontSize: 28, fontWeight: '700', letterSpacing: -0.5, marginTop: 4 },
  p: { color: theme.dim, fontSize: 14, marginTop: 6, lineHeight: 20 },
  loading: { alignItems: 'center', justifyContent: 'center', marginTop: 60 },
  empty: { alignItems: 'center', marginTop: 60, paddingHorizontal: 20 },
  emptyText: { color: theme.dim, fontSize: 14, textAlign: 'center', lineHeight: 20 },
  card: {
    backgroundColor: theme.card,
    borderColor: theme.borderStrong,
    borderWidth: 1,
    borderRadius: radii.card,
    padding: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  iconChip: {
    width: 34,
    height: 34,
    borderRadius: radii.chip,
    backgroundColor: 'rgba(10,132,255,0.14)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardTitle: { color: theme.text, fontSize: 15, fontWeight: '600' },
  cardMeta: { color: theme.dim, fontSize: 12, marginTop: 2 },
});
