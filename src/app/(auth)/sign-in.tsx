import { router } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { MeroaMark } from '@/components/MeroaMark';
import { PrimaryButton } from '@/components/PrimaryButton';
import { radii, theme } from '@/constants/theme';
import { ApiError, api } from '@/lib/api/client';

export default function SignInScreen() {
  const [phone, setPhone] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (loading) return;
    const trimmed = phone.trim();
    if (trimmed.length < 7) {
      setError('Enter your phone number.');
      return;
    }

    setLoading(true);
    setError(null);
    try {
      await api.requestOtp(trimmed);
      router.push({ pathname: '/(auth)/verify', params: { phone: trimmed } });
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        setError('Too many attempts — give it a minute and try again.');
      } else if (err instanceof ApiError && err.status === 400) {
        setError("That phone number doesn't look right.");
      } else {
        setError('Something went wrong. Check your connection and try again.');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.content}>
          <MeroaMark size={56} glow />
          <Text style={styles.title}>Meroa</Text>
          <Text style={styles.subtitle}>
            Your number keeps one relationship with Meroa — in the app or by text.
          </Text>

          <View style={styles.field}>
            <Text style={styles.label}>PHONE NUMBER</Text>
            <TextInput
              value={phone}
              onChangeText={(t) => {
                setPhone(t);
                setError(null);
              }}
              placeholder="(555) 555-0100"
              placeholderTextColor={theme.faint}
              keyboardType="phone-pad"
              autoComplete="tel"
              textContentType="telephoneNumber"
              style={styles.input}
              onSubmitEditing={submit}
            />
          </View>

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <PrimaryButton label={loading ? 'Sending…' : 'Continue'} onPress={submit} style={styles.button} />

          <Text style={styles.disclaimer}>
            Meroa is an AI. We&rsquo;ll text you a code to verify it&rsquo;s you.
          </Text>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  content: { flex: 1, justifyContent: 'center', paddingHorizontal: 28, gap: 8 },
  title: { color: theme.text, fontSize: 28, fontWeight: '700', letterSpacing: -0.5, marginTop: 16 },
  subtitle: { color: theme.dim, fontSize: 15, lineHeight: 21, marginBottom: 24, maxWidth: 320 },
  field: { marginBottom: 4 },
  label: { color: theme.dim, fontSize: 11, fontWeight: '700', letterSpacing: 1.2, marginBottom: 8 },
  input: {
    color: theme.text,
    fontSize: 17,
    paddingHorizontal: 16,
    paddingVertical: 14,
    backgroundColor: theme.surface,
    borderRadius: radii.control,
    borderWidth: 1,
    borderColor: theme.border,
  },
  error: { color: theme.danger, fontSize: 13, marginTop: 4 },
  button: { marginTop: 20 },
  disclaimer: { color: theme.faint, fontSize: 12, marginTop: 16, lineHeight: 17, maxWidth: 320 },
});
