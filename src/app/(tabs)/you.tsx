import { router } from 'expo-router';
import { useState } from 'react';
import { Alert, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { MeroaMark } from '@/components/MeroaMark';
import { Row } from '@/components/Row';
import { theme } from '@/constants/theme';
import { consentGranted } from '@/features/profile/ai-consent';
import { useMe, useUpdatePrefs } from '@/features/profile/queries';
import { QuietHoursSheet } from '@/features/profile/QuietHoursSheet';
import { formatHhmmDisplay } from '@/features/tasks/task-form-helpers';
import { readQuietHours } from '@/features/profile/quiet-hours';
import { VibePickerSheet } from '@/features/profile/VibePickerSheet';
import { vibeLabel } from '@/features/profile/vibes';
import { useTabBarHeight } from '@/hooks/use-tab-bar-inset';
import { useAuth } from '@/lib/auth/AuthProvider';
import { requestNotificationPermission } from '@/lib/notifications';

export default function YouScreen() {
  const tabBarHeight = useTabBarHeight();
  const { data } = useMe();
  const { signOut } = useAuth();
  const updatePrefs = useUpdatePrefs();
  const [vibeSheetOpen, setVibeSheetOpen] = useState(false);
  const [quietHoursSheetOpen, setQuietHoursSheetOpen] = useState(false);

  const communicationStyle = vibeLabel(data?.user.prefs.communicationStyle);
  const proactiveCheckins = data?.user.prefs.proactiveCheckins === true;
  const quietHours = readQuietHours(data?.user.prefs);
  const quietHoursHint = quietHours.enabled
    ? `${formatHhmmDisplay(quietHours.start)}–${formatHhmmDisplay(quietHours.end)}`
    : 'Off';

  const handleToggleCheckins = async (next: boolean) => {
    // Ask the OS only when turning check-ins on (CLAUDE.md §2) — the sync
    // logic separately checks actual permission before scheduling, so a
    // denial here doesn't need to be reflected back into the toggle.
    if (next) await requestNotificationPermission();
    updatePrefs.mutate({ proactiveCheckins: next });
  };

  const aiSharingOn = consentGranted(data?.user.prefs);
  const handleToggleAiSharing = (next: boolean) => {
    if (next) {
      updatePrefs.mutate({ aiConsent: { granted: true } });
      return;
    }
    // Revoking blocks chat entirely (the server refuses every send without
    // consent, and the nav guard re-shows the consent screen) — so confirm the
    // consequence rather than silently breaking chat on a stray tap.
    Alert.alert(
      'Turn off AI data sharing?',
      "Meroa's chat sends your messages to a third-party AI service to reply. Turn this off and chat stops working until you turn it back on. Nothing you've saved is deleted.",
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Turn off',
          style: 'destructive',
          onPress: () => updatePrefs.mutate({ aiConsent: { granted: false } }),
        },
      ],
    );
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
            onPress={() => setVibeSheetOpen(true)}
          />
          <Row icon="book" label="Memory" onPress={() => router.push('/memories')} />
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
            icon="clock"
            label="Quiet hours"
            right={<Text style={styles.hint}>{quietHoursHint}</Text>}
            onPress={() => setQuietHoursSheetOpen(true)}
          />
          <Row
            icon="moon"
            label="Dark appearance"
            right={<Text style={styles.hint}>Always</Text>}
          />
          <Row
            icon="lock"
            label="AI data sharing"
            right={
              <Switch
                value={aiSharingOn}
                onValueChange={handleToggleAiSharing}
                trackColor={{ true: theme.blue, false: theme.border }}
                thumbColor="#fff"
              />
            }
          />
        </Section>

        <Section title="ACCOUNT">
          <Row
            icon="crown"
            label={data?.entitlement.plan === 'plus' ? 'Manage subscription' : 'Upgrade to Meroa Plus'}
            onPress={() => router.push('/paywall')}
          />
          <Row icon="logout" label="Sign out" danger onPress={() => signOut()} />
        </Section>

        <Text style={styles.footer}>Meroa · v1.0.0</Text>
      </ScrollView>
      <VibePickerSheet visible={vibeSheetOpen} onClose={() => setVibeSheetOpen(false)} />
      <QuietHoursSheet visible={quietHoursSheetOpen} onClose={() => setQuietHoursSheetOpen(false)} />
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
