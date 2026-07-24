import { QueryClientProvider } from '@tanstack/react-query';
import * as Notifications from 'expo-notifications';
import { DarkTheme, router, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import type { ErrorBoundaryProps } from 'expo-router';

import { AppErrorFallback } from '@/components/AppErrorFallback';
import { configurePurchases } from '@/features/billing/purchases';
import { consentGranted } from '@/features/profile/ai-consent';
import { OnboardingDraftFlush } from '@/features/profile/OnboardingDraftFlush';
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

// A tapped notification lands on the surface it's about. Two sources:
//  - Local reminders (lib/reminder-schedule.ts): a task reminder → Tasks (the
//    task's surface — there's no task-detail route); the "haven't seen you"
//    nudge → Chat, since it's a friend check-in, not a task.
//  - Server re-engagement pushes (server/lib/notifications): carry an explicit
//    `route` ('chat' | 'goals' | 'tasks') for where the message points.
// Custom-scheme only; no associatedDomains, so no Apple-account dependency.
// Rendered only when the tabs are reachable, so a cold-start tap can't fight the
// onboarding/paywall/consent guards.
const ROUTE_BY_KEY: Record<string, string> = {
  chat: '/(tabs)',
  goals: '/(tabs)/goals',
  tasks: '/(tabs)/tasks',
};

function routeFromNotification(response: Notifications.NotificationResponse | null) {
  const data = response?.notification.request.content.data;
  const route = typeof data?.route === 'string' ? ROUTE_BY_KEY[data.route] : undefined;
  if (route) {
    router.navigate(route as Parameters<typeof router.navigate>[0]);
    return;
  }
  if (data?.kind === 'reengage') {
    router.navigate('/(tabs)');
    return;
  }
  if (typeof data?.taskId === 'string') router.navigate('/(tabs)/tasks');
}

function NotificationRouter() {
  useEffect(() => {
    let active = true;
    // Cold start: the app was launched by tapping the notification.
    Notifications.getLastNotificationResponseAsync().then((response) => {
      if (active) routeFromNotification(response);
    });
    // Warm: tapped while the app was running or backgrounded.
    const sub = Notifications.addNotificationResponseReceivedListener(routeFromNotification);
    return () => {
      active = false;
      sub.remove();
    };
  }, []);
  return null;
}

// Expo Router picks up a root ErrorBoundary export from this layout file — a
// render crash anywhere below degrades to a recoverable screen, not a white one.
export function ErrorBoundary(props: ErrorBoundaryProps) {
  return <AppErrorFallback {...props} />;
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
  // A written tone-slider level (prefs.tone) is the first-run signal — it's
  // server-persisted, so it survives a reinstall (unlike the transient
  // isNewUser flag from OTP verify, which the client never keeps). A legacy
  // communicationStyle string still counts, so users onboarded before the
  // slider aren't sent back through it. Gated ahead of the paywall: signup →
  // onboarding → paywall → tabs.
  const prefs = me?.user.prefs;
  const needsOnboarding =
    typeof prefs?.tone !== 'number' && typeof prefs?.communicationStyle !== 'string';
  // Apple 5.1.2(i): after onboarding and the paywall, an entitled user must have
  // agreed to AI data-sharing before reaching chat. One code path covers both a
  // brand-new user (onboarding → paywall → consent → tabs) and every existing
  // account (none has consent yet, so → consent → tabs on next launch). Revoking
  // in the You tab flips this back and re-shows the screen. The server enforces
  // the same predicate on every send (lib/consent.ts) — this is just the surface.
  const needsAiConsent = !needsOnboarding && hasAccess && !consentGranted(me?.user.prefs);
  const canUseTabs = status === 'signedIn' && !needsOnboarding && hasAccess && !needsAiConsent;

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
      {status === 'signedIn' && <OnboardingDraftFlush />}
      {canUseTabs && <NotificationRouter />}
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: theme.bg } }}>
        <Stack.Protected guard={status === 'signedIn' && needsOnboarding}>
          <Stack.Screen name="onboarding" options={{ gestureEnabled: false }} />
        </Stack.Protected>
        <Stack.Protected guard={status === 'signedIn' && needsAiConsent}>
          <Stack.Screen name="ai-consent" options={{ gestureEnabled: false }} />
        </Stack.Protected>
        <Stack.Protected guard={canUseTabs}>
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="goal/[id]" options={{ presentation: 'card' }} />
          <Stack.Screen name="archived-goals" options={{ presentation: 'card' }} />
          <Stack.Screen name="memories" options={{ presentation: 'card' }} />
          <Stack.Screen name="settings" options={{ presentation: 'card' }} />
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
