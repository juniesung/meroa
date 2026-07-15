import { router } from 'expo-router';
import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { MeroaMark } from '@/components/MeroaMark';
import { PrimaryButton } from '@/components/PrimaryButton';
import { theme } from '@/constants/theme';
import { VibeOptionList } from '@/features/profile/VibeOptionList';
import type { VibePreset } from '@/features/profile/vibes';
import { useUpdatePrefs } from '@/features/profile/queries';

// First-run only: shown when prefs.communicationStyle is absent (see
// features/profile/useVibeOnboardingGate.ts). A starting point, not a fixed
// setting — changeable any time from You > Communication style.
export default function VibePickScreen() {
  const [selected, setSelected] = useState<VibePreset | null>(null);
  const updatePrefs = useUpdatePrefs();

  const finish = (style: VibePreset) => {
    updatePrefs.mutate({ communicationStyle: style }, { onSuccess: () => router.replace('/(tabs)') });
  };

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.hero}>
          <MeroaMark size={56} glow />
          <Text style={styles.title}>How should I talk to you?</Text>
          <Text style={styles.subtitle}>
            Pick a starting point — you can change this any time in the You tab.
          </Text>
        </View>

        <VibeOptionList selected={selected} onSelect={setSelected} />

        <PrimaryButton
          label={updatePrefs.isPending ? 'Setting up…' : 'Continue'}
          onPress={selected && !updatePrefs.isPending ? () => finish(selected) : undefined}
          style={{ marginTop: 24, opacity: selected && !updatePrefs.isPending ? 1 : 0.5 }}
        />

        <Text style={styles.skip} onPress={() => !updatePrefs.isPending && finish('balanced')}>
          Skip for now
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  content: { padding: 24, paddingBottom: 48 },
  hero: { alignItems: 'center', gap: 8, marginTop: 12, marginBottom: 32 },
  title: { color: theme.text, fontSize: 22, fontWeight: '700', marginTop: 12, textAlign: 'center' },
  subtitle: { color: theme.dim, fontSize: 14, textAlign: 'center', paddingHorizontal: 12 },
  skip: { color: theme.faint, fontSize: 13, textAlign: 'center', marginTop: 18 },
});
