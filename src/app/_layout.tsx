import { QueryClientProvider } from '@tanstack/react-query';
import { DarkTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { configurePurchases } from '@/features/billing/purchases';
import { useMe } from '@/features/profile/queries';
import { theme } from '@/constants/theme';
import { AuthProvider, useAuth } from '@/lib/auth/AuthProvider';
import { queryClient } from '@/lib/query-client';

// Configures the RevenueCat SDK with OUR userId as soon as it's known, so
// app_user_id maps 1:1 onto users.id for every later webhook/sync — see
// features/billing/purchases.ts. Rendered only while signed in; a signed-
// out session never needs the SDK configured (and AuthProvider's signOut
// already calls logOutPurchases on the way out).
function BillingGate() {
  const { data } = useMe();
  const userId = data?.user.id;
  useEffect(() => {
    if (userId) configurePurchases(userId);
  }, [userId]);
  return null;
}

SplashScreen.preventAutoHideAsync();

const navTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: theme.bg,
    card: theme.bg,
    text: theme.text,
    border: theme.border,
    primary: theme.blue,
  },
};

function RootNavigator() {
  const { status } = useAuth();
  const { data: me } = useMe({ enabled: status === 'signedIn' });
  // Hard paywall (docs/phases/phase-7-premium-billing.md): 'plus' covers both
  // a trialing and a paid subscriber identically (RevenueCat treats a trial
  // as an active entitlement) — there's no persistent free tier to fall back
  // to, so anyone without it is routed straight to the paywall below.
  const hasAccess = me?.entitlement.plan === 'plus';
  // Absence of prefs.communicationStyle is the first-run signal — it's
  // server-persisted, so it survives a reinstall (unlike the transient
  // isNewUser flag from OTP verify, which the client never keeps). Gated
  // ahead of the paywall: signup → onboarding → paywall → tabs.
  const needsOnboarding = typeof me?.user.prefs.communicationStyle !== 'string';

  useEffect(() => {
    if (status !== 'loading') {
      SplashScreen.hideAsync();
    }
  }, [status]);

  if (status === 'loading') return null;
  // Signed in but the entitlement hasn't loaded yet — wait rather than
  // flashing the paywall for an instant before hasAccess is known.
  if (status === 'signedIn' && me === undefined) return null;

  return (
    <>
      {status === 'signedIn' && <BillingGate />}
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: theme.bg } }}>
        <Stack.Protected guard={status === 'signedIn' && needsOnboarding}>
          <Stack.Screen name="onboarding" options={{ gestureEnabled: false }} />
        </Stack.Protected>
        <Stack.Protected guard={status === 'signedIn' && !needsOnboarding && hasAccess}>
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="goal/[id]" options={{ presentation: 'card' }} />
          <Stack.Screen name="memories" options={{ presentation: 'card' }} />
        </Stack.Protected>
        <Stack.Protected guard={status === 'signedIn' && !needsOnboarding}>
          {/* Declared once, always reachable while signed in — 'card' with no
              tab bar underneath when it's the mandatory hard-paywall landing
              screen (!hasAccess), 'modal' over the tabs for the existing
              voluntary upgrade entry points (Settings, cap-hit banners). */}
          <Stack.Screen name="paywall" options={{ presentation: hasAccess ? 'modal' : 'card' }} />
        </Stack.Protected>
        <Stack.Protected guard={status === 'signedOut'}>
          <Stack.Screen name="(auth)" />
        </Stack.Protected>
      </Stack>
    </>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: theme.bg }}>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <ThemeProvider value={navTheme}>
            <RootNavigator />
            <StatusBar style="light" />
          </ThemeProvider>
        </AuthProvider>
      </QueryClientProvider>
    </GestureHandlerRootView>
  );
}
