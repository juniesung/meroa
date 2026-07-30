import * as AppleAuthentication from 'expo-apple-authentication';
import { useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { MeroaMark } from '@/components/MeroaMark';
import { radii, theme } from '@/constants/theme';
import { api } from '@/lib/api/client';
import { useAuth } from '@/lib/auth/AuthProvider';

// Sign in with Apple is the login. The server still supports a phone/OTP path
// (routes/auth.ts) for later/dev, but there's no live SMS sender, so Apple is
// the only user-facing sign-in. Signing in flips the nav guard (_layout.tsx) —
// this screen never navigates itself.
export default function SignInScreen() {
  const { signIn } = useAuth();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signInWithApple = async () => {
    if (loading) return;
    setError(null);
    setLoading(true);
    try {
      const credential = await AppleAuthentication.signInAsync({
        // FULL_NAME only — we store the name (as displayName) but never store or
        // use the email, so we don't request the EMAIL scope. Keeps the privacy
        // story unambiguous: email is genuinely not collected (see
        // docs/app-privacy-answers.md §2).
        requestedScopes: [AppleAuthentication.AppleAuthenticationScope.FULL_NAME],
      });
      if (!credential.identityToken) throw new Error('no_identity_token');
      // Apple returns the name only on the FIRST sign-in — forward it so the
      // server can store it; undefined afterward.
      const fullName =
        [credential.fullName?.givenName, credential.fullName?.familyName].filter(Boolean).join(' ') ||
        undefined;
      const result = await api.appleSignIn(
        credential.identityToken,
        credential.authorizationCode ?? undefined,
        fullName,
      );
      await signIn(result);
    } catch (err) {
      // Tapping Cancel on the Apple sheet is not an error.
      if ((err as { code?: string }).code === 'ERR_REQUEST_CANCELED') return;
      setError('Could not sign in. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.content}>
        <MeroaMark size={56} glow />
        <Text style={styles.title}>Meroa</Text>
        <Text style={styles.subtitle}>
          The AI friend that actually keeps you honest. Sign in to get started.
        </Text>

        <View style={styles.buttonWrap}>
          <AppleAuthentication.AppleAuthenticationButton
            buttonType={AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN}
            buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.WHITE}
            cornerRadius={radii.control}
            style={styles.appleButton}
            onPress={signInWithApple}
          />
          {loading ? <ActivityIndicator style={styles.spinner} color={theme.dim} /> : null}
        </View>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <Text style={styles.disclaimer}>Meroa is an AI companion, always clearly identified as AI.</Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  content: { flex: 1, justifyContent: 'center', paddingHorizontal: 28, gap: 8 },
  title: { color: theme.text, fontSize: 28, fontWeight: '700', letterSpacing: -0.5, marginTop: 16 },
  subtitle: { color: theme.dim, fontSize: 15, lineHeight: 21, marginBottom: 24, maxWidth: 320 },
  buttonWrap: { marginTop: 8 },
  appleButton: { width: '100%', height: 50 },
  spinner: { position: 'absolute', right: 16, top: 15 },
  error: { color: theme.danger, fontSize: 13, marginTop: 12 },
  disclaimer: { color: theme.faint, fontSize: 12, marginTop: 20, lineHeight: 17, maxWidth: 320 },
});
