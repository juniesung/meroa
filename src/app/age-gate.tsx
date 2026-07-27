import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { MeroaMark } from '@/components/MeroaMark';
import { PrimaryButton } from '@/components/PrimaryButton';
import { theme } from '@/constants/theme';
import { useAuth } from '@/lib/auth/AuthProvider';
import { useMe, useUpdatePrefs } from '@/features/profile/queries';
import { ageFromDob, isUnderMinAge, MIN_AGE, toDobString } from '@/lib/age';

// The age gate (min 13). Passing it writes prefs.dob, which flips the nav guard
// in _layout.tsx and moves the user on — this screen never navigates itself. The
// server independently 403s an under-13 dob on every send (lib/age.ts), so this
// is the humane surface, not the enforcement. An under-13 answer is stored too,
// so the block persists across reinstall (the account is phone-keyed).
function eighteenYearsAgo(): Date {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 18);
  return d;
}

export default function AgeGateScreen() {
  const { data: me } = useMe();
  const { signOut } = useAuth();
  const updatePrefs = useUpdatePrefs();
  const [dob, setDob] = useState<Date>(eighteenYearsAgo());

  // If a stored dob already puts them under the floor, this is the permanent
  // block — no path forward. (The nav guard keeps routing here.)
  const blocked = isUnderMinAge(me?.user.prefs);

  const submit = () => {
    if (updatePrefs.isPending) return;
    updatePrefs.mutate({ dob: toDobString(dob) });
  };

  if (blocked) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.content}>
          <MeroaMark size={56} mood="deflated" />
          <Text style={styles.title}>Meroa is for ages {MIN_AGE}+</Text>
          <Text style={styles.subtitle}>
            Thanks for your honesty. You need to be at least {MIN_AGE} years old to use Meroa. We
            hope to see you when you&apos;re a little older.
          </Text>
          <Pressable onPress={() => signOut()} hitSlop={8}>
            <Text style={styles.link}>Sign out</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  const age = ageFromDob(toDobString(dob));

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.content}>
        <View style={styles.header}>
          <MeroaMark size={56} glow />
          <Text style={styles.title}>How old are you?</Text>
          <Text style={styles.subtitle}>
            Meroa is for ages {MIN_AGE} and up. We ask once, and we don&apos;t share it.
          </Text>
        </View>

        <View style={styles.pickerWrap}>
          <DateTimePicker
            value={dob}
            mode="date"
            display="spinner"
            maximumDate={new Date()}
            onChange={(_e: DateTimePickerEvent, selected?: Date) => {
              if (selected) setDob(selected);
            }}
            themeVariant="dark"
            textColor={theme.text}
          />
        </View>

        {updatePrefs.isError ? (
          <Text style={styles.error}>{"Couldn't save that. Check your connection and try again."}</Text>
        ) : null}
      </View>

      <View style={styles.footer}>
        <PrimaryButton
          label={updatePrefs.isPending ? 'Saving…' : 'Continue'}
          onPress={updatePrefs.isPending || age === null ? undefined : submit}
          style={updatePrefs.isPending || age === null ? styles.ctaDisabled : undefined}
        />
        {updatePrefs.isPending ? <ActivityIndicator style={styles.spinner} color={theme.dim} /> : null}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  content: { flex: 1, padding: 24, paddingTop: 48, gap: 24, alignItems: 'center' },
  header: { alignItems: 'center', gap: 12 },
  title: { color: theme.text, fontSize: 26, fontWeight: '700', letterSpacing: -0.5, textAlign: 'center', marginTop: 8 },
  subtitle: { color: theme.dim, fontSize: 15, lineHeight: 22, textAlign: 'center', paddingHorizontal: 8 },
  pickerWrap: { width: '100%', alignItems: 'center', marginTop: 8 },
  link: { color: theme.blue, fontSize: 15, fontWeight: '600', textAlign: 'center', marginTop: 12 },
  error: { color: theme.danger, fontSize: 14, textAlign: 'center' },
  footer: { padding: 24, paddingTop: 8 },
  ctaDisabled: { opacity: 0.6 },
  spinner: { position: 'absolute', right: 44, top: 24 },
});
