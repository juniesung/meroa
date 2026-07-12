import { router } from 'expo-router';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ToolCard } from '@/components/ToolCard';
import { theme } from '@/constants/theme';
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
              <Pressable key={tool.id} onPress={() => router.push({ pathname: '/tool/[id]', params: { id: tool.id } })}>
                <ToolCard
                  icon={toIconName(tool.icon)}
                  title={tool.name}
                  subtitle={tool.sub ?? `${tool.entryCount} ${tool.entryCount === 1 ? 'entry' : 'entries'} logged`}
                  progress={Math.round((tool.progress ?? 0) * 100)}
                />
              </Pressable>
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
});
