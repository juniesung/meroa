import { router, Stack } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Purchases, { INTRO_ELIGIBILITY_STATUS } from 'react-native-purchases';

import { Icon } from '@/components/Icon';
import { MeroaMark } from '@/components/MeroaMark';
import { PrimaryButton } from '@/components/PrimaryButton';
import { theme } from '@/constants/theme';
import {
  monthlyPackage,
  trialLengthLabel,
  useOfferings,
  usePurchase,
  useRestorePurchases,
  useTrialEligibility,
} from '@/features/billing/queries';
import { isBillingConfigured } from '@/features/billing/purchases';
import type { OnboardingDraft } from '@/features/profile/OnboardingDraftFlush';
import { useMe } from '@/features/profile/queries';
import { haptics } from '@/lib/haptics';
import { privacyUrl, termsUrl } from '@/lib/legal-urls';


function formatExpiry(iso: string | null): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
}

export default function PaywallScreen() {
  const { data: me } = useMe();
  const { data: offering, isLoading: offeringsLoading } = useOfferings();
  const purchase = usePurchase();
  const restore = useRestorePurchases();
  const [restoreMessage, setRestoreMessage] = useState<string | null>(null);

  const isPlus = me?.entitlement.plan === 'plus';
  const pkg = monthlyPackage(offering ?? null);
  const onboardingDraft = me?.user.prefs.onboardingDraft as OnboardingDraft | null | undefined;
  const waitingGoalName = onboardingDraft?.goal?.name;
  // Only reachable via router.push from within the app (Settings, cap-hit
  // banners) when there's already a screen underneath to return to. The
  // mandatory hard-paywall landing screen (_layout.tsx, !hasAccess) is the
  // base of the stack — nothing to dismiss back to, so no close button there.
  const canDismiss = router.canGoBack();

  const { data: eligibilityStatus } = useTrialEligibility(pkg?.product.identifier);
  const trialLength = pkg ? trialLengthLabel(pkg.product) : null;
  const showTrialCopy = trialLength !== null && eligibilityStatus !== INTRO_ELIGIBILITY_STATUS.INTRO_ELIGIBILITY_STATUS_INELIGIBLE;

  // The mandatory hard-paywall landing screen (!canDismiss) has nowhere to
  // router.back() to — Stack.Protected making (tabs) newly reachable doesn't
  // by itself move the user off whatever screen they're already sitting on,
  // so without this they're left stranded here showing "You're a Meroa
  // member" after a real purchase/restore instead of landing in the app. The
  // voluntary, dismissible entry points (Settings, cap-hit banners) are
  // unaffected — canDismiss is already true there, so this never fires.
  useEffect(() => {
    if (isPlus && !canDismiss) {
      router.replace('/(tabs)');
    }
  }, [isPlus, canDismiss]);

  const handleSubscribe = () => {
    if (!pkg) return;
    purchase.mutate(pkg, {
      onSuccess: (result) => {
        if (result.cancelled) return;
        // The payoff for converting — a success chime as it lands, before the
        // screen hands off into the app.
        haptics.success();
        if (canDismiss) router.back();
      },
    });
  };

  const handleRestore = () => {
    haptics.tap();
    setRestoreMessage(null);
    restore.mutate(undefined, {
      onSuccess: () => {
        haptics.success();
        setRestoreMessage("You're all set.");
      },
      onError: () => {
        haptics.warning();
        setRestoreMessage("Couldn't restore — try again in a moment.");
      },
    });
  };

  const handleManage = async () => {
    try {
      await Purchases.showManageSubscriptions();
    } catch {
      await Linking.openURL('https://apps.apple.com/account/subscriptions');
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <Stack.Screen options={{ headerShown: false }} />

      <View style={styles.header}>
        <View style={{ flex: 1 }} />
        {canDismiss && (
          <Pressable onPress={() => router.back()} style={styles.closeButton} hitSlop={8}>
            <View style={{ transform: [{ rotate: '45deg' }] }}>
              <Icon name="plus" size={18} color={theme.text} stroke={2.2} />
            </View>
          </Pressable>
        )}
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.hero}>
          {/* The mascot warms up once you're a member — a small welcome on the
              "you're a Meroa member" state. */}
          <MeroaMark size={56} glow mood={isPlus ? 'warm' : 'idle'} />
          <Text style={styles.title}>Meroa membership</Text>
        </View>

        {isPlus ? (
          <PlusState expiresAt={me?.entitlement.expiresAt ?? null} onManage={handleManage} />
        ) : (
          <>
            {waitingGoalName && (
              <Text style={styles.waiting}>
                Your goal &quot;{waitingGoalName}&quot; is set up and waiting.
              </Text>
            )}
            <View style={styles.benefits}>
              <Benefit label="Unlimited chat" />
              <Benefit label="Unlimited new tasks" />
              <Benefit label="Multiple active goals" />
              <Benefit label="Deeper long-term memory" />
              <Benefit label="Longer progress history" />
            </View>

            {offeringsLoading ? (
              <ActivityIndicator color={theme.dim} style={{ marginTop: 24 }} />
            ) : !isBillingConfigured() || !pkg ? (
              <Text style={styles.unavailable}>
                Membership isn&apos;t available to purchase yet — check back soon.
              </Text>
            ) : (
              <>
                <Text style={styles.disclosure}>
                  {showTrialCopy
                    ? `${trialLength} free, then ${pkg.product.priceString} per month. Renews automatically until cancelled — cancel anytime during your trial and you won't be charged.`
                    : `${pkg.product.priceString} per month. Renews automatically until cancelled — cancel anytime in your App Store account settings.`}
                </Text>
                <View style={styles.links}>
                  <Text style={styles.link} onPress={() => WebBrowser.openBrowserAsync(privacyUrl())}>
                    Privacy Policy
                  </Text>
                  <Text style={styles.linkSep}>·</Text>
                  <Text style={styles.link} onPress={() => WebBrowser.openBrowserAsync(termsUrl())}>
                    Terms of Use
                  </Text>
                </View>

                <PrimaryButton
                  label={
                    purchase.isPending
                      ? 'Starting…'
                      : showTrialCopy
                        ? `Start your ${trialLength} free trial`
                        : `Subscribe — ${pkg.product.priceString}/month`
                  }
                  onPress={!purchase.isPending ? handleSubscribe : undefined}
                  style={{ marginTop: 20 }}
                />
                <Text
                  style={styles.restore}
                  onPress={!restore.isPending ? handleRestore : undefined}
                >
                  {restore.isPending ? 'Restoring…' : 'Restore purchases'}
                </Text>
                {restoreMessage && <Text style={styles.restoreMessage}>{restoreMessage}</Text>}
                {purchase.isError && (
                  <Text style={styles.restoreMessage}>Something went wrong — try again.</Text>
                )}
              </>
            )}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function Benefit({ label }: { label: string }) {
  return (
    <View style={styles.benefitRow}>
      <Icon name="sparkle" size={16} color={theme.blue} stroke={2} />
      <Text style={styles.benefitLabel}>{label}</Text>
    </View>
  );
}

function PlusState({ expiresAt, onManage }: { expiresAt: string | null; onManage: () => void }) {
  const expiryLabel = formatExpiry(expiresAt);
  return (
    <View style={styles.plusState}>
      <Text style={styles.plusHeadline}>You&apos;re a Meroa member</Text>
      {expiryLabel && <Text style={styles.plusSub}>Renews {expiryLabel}</Text>}
      <PrimaryButton label="Manage subscription" onPress={onManage} style={{ marginTop: 24 }} />
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: 8 },
  closeButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.surface,
  },
  content: { padding: 24, paddingBottom: 48 },
  hero: { alignItems: 'center', gap: 10, marginBottom: 28 },
  title: { color: theme.text, fontSize: 26, fontWeight: '700', letterSpacing: -0.5 },
  waiting: {
    color: theme.blue,
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
    marginBottom: 20,
  },
  benefits: { gap: 14, marginBottom: 8 },
  benefitRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  benefitLabel: { color: theme.text, fontSize: 15, flex: 1 },
  disclosure: { color: theme.dim, fontSize: 12, lineHeight: 17, marginTop: 24, textAlign: 'center' },
  links: { flexDirection: 'row', justifyContent: 'center', gap: 8, marginTop: 10 },
  link: { color: theme.blue, fontSize: 12, fontWeight: '600' },
  linkSep: { color: theme.faint, fontSize: 12 },
  unavailable: { color: theme.dim, fontSize: 14, textAlign: 'center', marginTop: 32 },
  restore: { color: theme.blue, fontSize: 14, fontWeight: '600', textAlign: 'center', marginTop: 16 },
  restoreMessage: { color: theme.dim, fontSize: 13, textAlign: 'center', marginTop: 8 },
  plusState: { alignItems: 'center', marginTop: 8 },
  plusHeadline: { color: theme.text, fontSize: 18, fontWeight: '700' },
  plusSub: { color: theme.dim, fontSize: 14, marginTop: 6 },
});
