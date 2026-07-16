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

  useEffect(() => {
    if (status !== 'loading') {
      SplashScreen.hideAsync();
    }
  }, [status]);

  if (status === 'loading') return null;

  return (
    <>
      {status === 'signedIn' && <BillingGate />}
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: theme.bg } }}>
        <Stack.Protected guard={status === 'signedIn'}>
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="goal/[id]" options={{ presentation: 'card' }} />
          <Stack.Screen name="vibe-pick" options={{ presentation: 'modal', gestureEnabled: false }} />
          <Stack.Screen name="memories" options={{ presentation: 'card' }} />
          <Stack.Screen name="paywall" options={{ presentation: 'modal' }} />
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
