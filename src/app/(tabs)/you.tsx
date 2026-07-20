import { File, Paths } from 'expo-file-system';
import { router } from 'expo-router';
import * as Sharing from 'expo-sharing';
import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { Alert, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { MeroaMark } from '@/components/MeroaMark';
import { Row } from '@/components/Row';
import { theme } from '@/constants/theme';
import { consentGranted } from '@/features/profile/ai-consent';
import { useMe, useUpdatePrefs } from '@/features/profile/queries';
import { api } from '@/lib/api/client';
import { privacyUrl, supportUrl, termsUrl } from '@/lib/legal-urls';
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
  const [deletingAccount, setDeletingAccount] = useState(false);
  const [exporting, setExporting] = useState(false);

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

  const handleExport = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const data = await api.exportData();
      // Cache dir — this is a transient handoff file for the share sheet, not
      // something to keep. Overwrite any prior export.
      const file = new File(Paths.cache, 'meroa-export.json');
      if (file.exists) file.delete();
      file.create();
      file.write(JSON.stringify(data, null, 2));
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(file.uri, { mimeType: 'application/json', UTI: 'public.json' });
      } else {
        Alert.alert('Export ready', "Your data was saved, but sharing isn't available on this device.");
      }
    } catch {
      Alert.alert('Export failed', "Couldn't export your data. Please try again.");
    } finally {
      setExporting(false);
    }
  };

  const doDeleteAccount = async () => {
    setDeletingAccount(true);
    try {
      await api.deleteAccount();
    } catch {
      setDeletingAccount(false);
      Alert.alert('Something went wrong', "We couldn't delete your account. Please try again.");
      return;
    }
    // The account is gone server-side; run the normal terminal path (logout
    // fails silently — its session is already cascaded away — then clears
    // tokens, logs out of RevenueCat, and routes to the auth stack).
    await signOut();
  };

  const handleDeleteAccount = () => {
    if (deletingAccount) return;
    // Two-step confirm: destructive and irreversible, so a single stray tap
    // must not do it. The copy is explicit that billing is separate (deleting
    // the account does NOT cancel the store subscription — only the store can).
    Alert.alert(
      'Delete account?',
      "This permanently deletes your account and everything in it — your messages, tasks, goals, and memories. It can't be undone.\n\nDeleting your account does not cancel your subscription. To stop billing, cancel it in the App Store.",
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () =>
            Alert.alert(
              'Are you absolutely sure?',
              'Your data will be erased immediately and cannot be recovered.',
              [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Delete forever', style: 'destructive', onPress: doDeleteAccount },
              ],
            ),
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
          <Row
            icon="book"
            label={exporting ? 'Preparing export…' : 'Export my data'}
            onPress={handleExport}
          />
          <Row icon="logout" label="Sign out" danger onPress={() => signOut()} />
          <Row
            icon="lock"
            label={deletingAccount ? 'Deleting…' : 'Delete account'}
            danger
            onPress={handleDeleteAccount}
          />
        </Section>

        <Section title="ABOUT">
          <Row
            icon="lock"
            label="Privacy Policy"
            onPress={() => WebBrowser.openBrowserAsync(privacyUrl())}
          />
          <Row
            icon="book"
            label="Terms of Use"
            onPress={() => WebBrowser.openBrowserAsync(termsUrl())}
          />
          <Row
            icon="chat"
            label="Support"
            onPress={() => WebBrowser.openBrowserAsync(supportUrl())}
          />
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
