import { File, Paths } from 'expo-file-system';
import { router, Stack } from 'expo-router';
import * as Sharing from 'expo-sharing';
import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Icon } from '@/components/Icon';
import { Row } from '@/components/Row';
import { theme } from '@/constants/theme';
import { haptics } from '@/lib/haptics';
import { consentGranted } from '@/features/profile/ai-consent';
import { useMe, useUpdatePrefs } from '@/features/profile/queries';
import { api } from '@/lib/api/client';
import { privacyUrl, supportUrl, termsUrl } from '@/lib/legal-urls';
import { QuietHoursSheet } from '@/features/profile/QuietHoursSheet';
import { formatHhmmDisplay } from '@/features/tasks/task-form-helpers';
import { readQuietHours } from '@/features/profile/quiet-hours';
import { VibePickerSheet } from '@/features/profile/VibePickerSheet';
import { vibeLabel } from '@/features/profile/vibes';
import { useAuth } from '@/lib/auth/AuthProvider';
import { requestNotificationPermission } from '@/lib/notifications';
import { registerForPushNotifications } from '@/lib/push';

// The app's settings, moved off the You tab (now a profile/progress surface)
// behind its gear icon. Everything here is a verbatim relocation — the same
// handlers as before. Delete account, Export my data, and the legal links stay
// one tap in (Apple App Review requires account-deletion + privacy be present
// and easily reachable — a stack screen off the profile qualifies).
export default function SettingsScreen() {
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
    haptics.select();
    // Ask the OS only when turning check-ins on (CLAUDE.md §2) — the sync
    // logic separately checks actual permission before scheduling, so a
    // denial here doesn't need to be reflected back into the toggle.
    if (next) {
      const granted = await requestNotificationPermission();
      // Register this device for server-side re-engagement pushes right away on
      // opt-in (no-op off a dev build); the tabs layout also re-registers on
      // every foreground.
      if (granted) void registerForPushNotifications();
    }
    updatePrefs.mutate({ proactiveCheckins: next });
  };

  const aiSharingOn = consentGranted(data?.user.prefs);
  const handleToggleAiSharing = (next: boolean) => {
    haptics.select();
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
      const exportPayload = await api.exportData();
      // Cache dir — this is a transient handoff file for the share sheet, not
      // something to keep. Overwrite any prior export.
      const file = new File(Paths.cache, 'meroa-export.json');
      if (file.exists) file.delete();
      file.create();
      file.write(JSON.stringify(exportPayload, null, 2));
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
      <Stack.Screen options={{ headerShown: false }} />

      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.iconButton} hitSlop={8}>
          <View style={{ transform: [{ rotate: '180deg' }] }}>
            <Icon name="chevron" size={18} color={theme.text} stroke={2.2} />
          </View>
        </Pressable>
        <Text style={styles.title}>Settings</Text>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 20, paddingBottom: 60 }}>
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
          <Row icon="moon" label="Dark appearance" right={<Text style={styles.hint}>Always</Text>} />
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
            label={data?.entitlement.plan === 'plus' ? 'Manage subscription' : 'Subscribe to Meroa'}
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
          <Row icon="lock" label="Privacy Policy" onPress={() => WebBrowser.openBrowserAsync(privacyUrl())} />
          <Row icon="book" label="Terms of Use" onPress={() => WebBrowser.openBrowserAsync(termsUrl())} />
          <Row icon="chat" label="Support" onPress={() => WebBrowser.openBrowserAsync(supportUrl())} />
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
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  iconButton: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1, color: theme.text, fontSize: 16, fontWeight: '700', textAlign: 'center' },
  headerSpacer: { width: 40 },
  hint: { color: theme.dim, fontSize: 14, marginRight: 6 },
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
  footer: { color: theme.faint, fontSize: 11, textAlign: 'center', marginTop: 32 },
});
