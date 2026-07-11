import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { MeroaMark } from '@/components/MeroaMark';
import { Row } from '@/components/Row';
import { theme } from '@/constants/theme';
import { useTabBarHeight } from '@/hooks/use-tab-bar-inset';

export default function YouScreen() {
  const tabBarHeight = useTabBarHeight();

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 20, paddingBottom: tabBarHeight + 40 }}>
        <View style={styles.hero}>
          <MeroaMark size={64} glow />
          <Text style={styles.name}>Alex Rivera</Text>
          <Text style={styles.email}>alex@meroa.app</Text>
          <View style={styles.pill}>
            <Text style={styles.pillText}>Meroa Plus</Text>
          </View>
        </View>

        <Section title="PERSONALITY">
          <Row icon="sparkle" label="Communication style" right={<Text style={styles.hint}>Casual</Text>} />
          <Row icon="book" label="Memory" right={<Text style={styles.hint}>128 notes</Text>} />
        </Section>

        <Section title="PREFERENCES">
          <Row icon="bell" label="Notifications" />
          <Row icon="moon" label="Dark appearance" right={<Text style={styles.hint}>Always</Text>} />
          <Row icon="lock" label="Privacy" />
        </Section>

        <Section title="ACCOUNT">
          <Row icon="crown" label="Manage subscription" />
          <Row icon="logout" label="Sign out" danger />
        </Section>

        <Text style={styles.footer}>Meroa · v1.0.0</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={{ marginTop: 28 }}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.sectionBody}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  hero: { alignItems: 'center', gap: 8, marginTop: 12 },
  name: { color: theme.text, fontSize: 22, fontWeight: '700', marginTop: 8 },
  email: { color: theme.dim, fontSize: 13 },
  pill: {
    marginTop: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: 'rgba(10,132,255,0.14)',
  },
  pillText: { color: theme.blue, fontSize: 12, fontWeight: '600' },
  sectionTitle: {
    color: theme.dim,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.2,
    marginBottom: 8,
    paddingHorizontal: 4,
  },
  sectionBody: {
    backgroundColor: theme.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: theme.border,
    overflow: 'hidden',
  },
  hint: { color: theme.dim, fontSize: 14, marginRight: 6 },
  footer: { color: theme.faint, fontSize: 11, textAlign: 'center', marginTop: 32 },
});
