import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ToolCard } from '@/components/ToolCard';
import { theme } from '@/constants/theme';
import { useTabBarHeight } from '@/hooks/use-tab-bar-inset';

const tools = [
  { icon: 'dumbbell' as const, title: 'Strength tracker', subtitle: '4 workouts this week', progress: 72 },
  { icon: 'droplet' as const, title: 'Hydration', subtitle: '1.4L of 2L today', progress: 70 },
  { icon: 'book' as const, title: 'Reading habit', subtitle: '21 day streak', progress: 88 },
  { icon: 'wallet' as const, title: 'Weekly spend', subtitle: '$142 of $250', progress: 57 },
  { icon: 'clock' as const, title: 'Sleep window', subtitle: 'Avg 7h 12m', progress: 60 },
];

export default function ToolsScreen() {
  const tabBarHeight = useTabBarHeight();

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 20, paddingBottom: tabBarHeight + 40 }}>
        <Text style={styles.eyebrow}>PERSONALIZED TOOLS</Text>
        <Text style={styles.h1}>Your progress</Text>
        <Text style={styles.p}>
          Meroa builds these from your conversations. They grow as you do.
        </Text>

        <View style={{ gap: 12, marginTop: 20 }}>
          {tools.map((t) => (
            <ToolCard key={t.title} {...t} />
          ))}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  eyebrow: { color: theme.dim, fontSize: 11, fontWeight: '700', letterSpacing: 1.2 },
  h1: { color: theme.text, fontSize: 28, fontWeight: '700', letterSpacing: -0.5, marginTop: 4 },
  p: { color: theme.dim, fontSize: 14, marginTop: 6, lineHeight: 20 },
});
