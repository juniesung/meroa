import { ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { MeroaMark } from '@/components/MeroaMark';
import { Row } from '@/components/Row';
import { theme } from '@/constants/theme';
import { useMe, useUpdatePrefs } from '@/features/profile/queries';
import { useTabBarHeight } from '@/hooks/use-tab-bar-inset';
import { useAuth } from '@/lib/auth/AuthProvider';
import { requestNotificationPermission } from '@/lib/notifications';

function capitalize(value: string): string {
  return value.length ? value[0]!.toUpperCase() + value.slice(1) : value;
}

export default function YouScreen() {
  const tabBarHeight = useTabBarHeight();
  const { data } = useMe();
  const { signOut } = useAuth();
  const updatePrefs = useUpdatePrefs();

  const communicationStyle =
    typeof data?.user.prefs.communicationStyle === 'string'
      ? capitalize(data.user.prefs.communicationStyle)
      : 'Casual';
  const proactiveCheckins = data?.user.prefs.proactiveCheckins === true;

  const handleToggleCheckins = async (next: boolean) => {
    // Ask the OS only when turning check-ins on (CLAUDE.md §2) — the sync
    // logic separately checks actual permission before scheduling, so a
    // denial here doesn't need to be reflected back into the toggle.
    if (next) await requestNotificationPermission();
    updatePrefs.mutate({ proactiveCheckins: next });
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 20, paddingBottom: tabBarHeight + 40 }}
      >
        <View style={styles.hero}>
          <MeroaMark size={64} glow />
          <Text style={styles.name}>{data?.user.displayName ?? data?.user.phoneE164 ?? '—'}</Text>
          {data?.user.displayName ? <Text style={styles.email}>{data.user.phoneE164}</Text> : null}
          <View style={styles.pill}>
            <Text style={styles.pillText}>
              {data?.entitlement.plan === 'plus' ? 'Meroa Plus' : 'Meroa Free'}
            </Text>
          </View>
        </View>

        <Section title="PERSONALITY">
          <Row
            icon="sparkle"
            label="Communication style"
            right={<Text style={styles.hint}>{communicationStyle}</Text>}
          />
          <Row icon="book" label="Memory" />
        </Section>

        <Section title="PREFERENCES">
          <Row
            icon="bell"
            label="Proactive check-ins"
            right={
              <Switch
                value={proactiveCheckins}
                onValueChange={handleToggleCheckins}
                trackColor={{ true: theme.blue, false: theme.border }}
                thumbColor="#fff"
              />
            }
          />
          <Row
            icon="moon"
            label="Dark appearance"
            right={<Text style={styles.hint}>Always</Text>}
          />
          <Row icon="lock" label="Privacy" />
        </Section>

        <Section title="ACCOUNT">
          <Row icon="crown" label="Manage subscription" />
          <Row icon="logout" label="Sign out" danger onPress={() => signOut()} />
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
