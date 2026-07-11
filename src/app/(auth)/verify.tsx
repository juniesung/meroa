import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { MeroaMark } from '@/components/MeroaMark';
import { PrimaryButton } from '@/components/PrimaryButton';
import { radii, theme } from '@/constants/theme';
import { ApiError, api } from '@/lib/api/client';
import { useAuth } from '@/lib/auth/AuthProvider';

export default function VerifyScreen() {
  const params = useLocalSearchParams<{ phone: string }>();
  const phone = Array.isArray(params.phone) ? params.phone[0] : params.phone;
  const { signIn } = useAuth();

  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [resending, setResending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (loading || code.trim().length < 4) return;
    setLoading(true);
    setError(null);
    try {
      const result = await api.verifyOtp(phone, code.trim());
      await signIn(result);
      // Root layout's Stack.Protected reacts to auth status and redirects to (tabs).
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        setError('Too many attempts — request a new code.');
      } else if (err instanceof ApiError && err.status === 400) {
        setError("That code doesn't match — try again.");
      } else {
        setError('Something went wrong. Check your connection and try again.');
      }
    } finally {
      setLoading(false);
    }
  };

  const resend = async () => {
    if (resending) return;
    setResending(true);
    setError(null);
    try {
      await api.requestOtp(phone);
    } catch {
      setError('Could not resend right now — try again shortly.');
    } finally {
      setResending(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.content}>
        <MeroaMark size={48} glow />
        <Text style={styles.title}>Enter your code</Text>
        <Text style={styles.subtitle}>We sent a 6-digit code to {phone}.</Text>

        <TextInput
          value={code}
          onChangeText={(t) => {
            setCode(t.replace(/\D/g, ''));
            setError(null);
          }}
          placeholder="000000"
          placeholderTextColor={theme.faint}
          keyboardType="number-pad"
          maxLength={6}
          style={styles.codeInput}
          onSubmitEditing={submit}
          autoFocus
        />

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <PrimaryButton label={loading ? 'Verifying…' : 'Verify'} onPress={submit} style={styles.button} />

        <Text style={styles.resend} onPress={resend}>
          {resending ? 'Resending…' : "Didn't get it? Resend code"}
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  content: { flex: 1, justifyContent: 'center', paddingHorizontal: 28, gap: 8 },
  title: { color: theme.text, fontSize: 28, fontWeight: '700', letterSpacing: -0.5, marginTop: 16 },
  subtitle: { color: theme.dim, fontSize: 15, lineHeight: 21, marginBottom: 24, maxWidth: 320 },
  codeInput: {
    color: theme.text,
    fontSize: 24,
    fontWeight: '600',
    letterSpacing: 6,
    textAlign: 'center',
    paddingVertical: 16,
    backgroundColor: theme.surface,
    borderRadius: radii.control,
    borderWidth: 1,
    borderColor: theme.border,
  },
  error: { color: theme.danger, fontSize: 13, marginTop: 4 },
  button: { marginTop: 20 },
  resend: { color: theme.blue, fontSize: 14, textAlign: 'center', marginTop: 20 },
});
