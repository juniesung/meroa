import Purchases from 'react-native-purchases';

// Public by design (EXPO_PUBLIC_ vars ship in the bundle) — a RevenueCat SDK
// key only authorizes purchase requests, the same trust level as a Stripe
// publishable key. Empty until a RevenueCat project exists (see the phase-7
// plan's prerequisites); every function below no-ops rather than throwing
// so the app runs fine before billing is configured.
const REVENUECAT_IOS_KEY = process.env.EXPO_PUBLIC_REVENUECAT_IOS_KEY;

export function isBillingConfigured(): boolean {
  return !!REVENUECAT_IOS_KEY;
}

// Tracks which userId the SDK is currently configured/logged in as, so a
// re-render with the same user doesn't re-configure (Purchases.configure
// should only ever be called once per process) and a genuine user switch
// goes through logIn instead.
let configuredUserId: string | null = null;

// Always configured with OUR userId as appUserID, never left anonymous —
// that's what makes a RevenueCat app_user_id map 1:1 onto `users.id`
// server-side (routes/billing.ts's webhook, entitlement.ts's sync), with no
// alias-resolution step needed on either end.
export async function configurePurchases(userId: string): Promise<void> {
  if (!REVENUECAT_IOS_KEY || configuredUserId === userId) return;

  if (configuredUserId === null) {
    Purchases.configure({ apiKey: REVENUECAT_IOS_KEY, appUserID: userId });
  } else {
    await Purchases.logIn(userId);
  }
  configuredUserId = userId;
}

export async function logOutPurchases(): Promise<void> {
  if (!REVENUECAT_IOS_KEY || configuredUserId === null) return;
  await Purchases.logOut();
  configuredUserId = null;
}
