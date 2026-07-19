import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Purchases, {
  INTRO_ELIGIBILITY_STATUS,
  type PurchasesPackage,
  type PurchasesStoreProduct,
} from 'react-native-purchases';

import { api } from '@/lib/api/client';
import { meQueryKey } from '@/features/profile/queries';

import { isBillingConfigured } from './purchases';

export function useOfferings() {
  return useQuery({
    queryKey: ['billing', 'offerings'],
    queryFn: async () => {
      const offerings = await Purchases.getOfferings();
      return offerings.current;
    },
    enabled: isBillingConfigured(),
    // Offering config rarely changes mid-session — no point refetching it
    // on every paywall mount the way a live query normally would.
    staleTime: 5 * 60 * 1000,
  });
}

// The one plan Meroa Premium sells (docs/phases/phase-7-premium-billing.md
// target: $11.99/mo) — the `monthly` accessor is RevenueCat's predefined
// package type, so this needs no per-product identifier hardcoded here.
export function monthlyPackage(offering: Awaited<ReturnType<typeof Purchases.getOfferings>>['current']): PurchasesPackage | null {
  return offering?.monthly ?? null;
}

async function syncAndInvalidate(queryClient: ReturnType<typeof useQueryClient>) {
  await api.billingSync();
  await queryClient.invalidateQueries({ queryKey: meQueryKey });
}

export function usePurchase() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (pkg: PurchasesPackage) => {
      try {
        await Purchases.purchasePackage(pkg);
      } catch (err) {
        // A user-cancelled purchase isn't an error the paywall should
        // surface — RevenueCat's own error shape marks it explicitly rather
        // than leaving callers to guess from a message string.
        if (err && typeof err === 'object' && 'userCancelled' in err && err.userCancelled) {
          return { cancelled: true as const };
        }
        throw err;
      }
      await syncAndInvalidate(queryClient);
      return { cancelled: false as const };
    },
  });
}

export function useRestorePurchases() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      await Purchases.restorePurchases();
      await syncAndInvalidate(queryClient);
    },
  });
}

// iOS-only (Android always reports UNKNOWN — checkTrialOrIntroductoryPriceEligibility's
// own doc comment). Apple requires the paywall not to promise a free trial to
// someone who already used one (e.g. a reinstall) — this is what tells the
// difference. Treated optimistically: only a confirmed INELIGIBLE suppresses
// trial copy, since UNKNOWN is the common/Android case and isn't evidence of
// ineligibility.
export function useTrialEligibility(productId: string | undefined) {
  return useQuery({
    queryKey: ['billing', 'trial-eligibility', productId],
    queryFn: async () => {
      const result = await Purchases.checkTrialOrIntroductoryPriceEligibility([productId!]);
      return result[productId!]?.status ?? INTRO_ELIGIBILITY_STATUS.INTRO_ELIGIBILITY_STATUS_UNKNOWN;
    },
    enabled: isBillingConfigured() && !!productId,
    staleTime: 5 * 60 * 1000,
  });
}

// The trial length as configured on the product itself (App Store Connect),
// never hardcoded — same discipline as monthlyPackage() not hardcoding a
// product id. `introPrice` is only non-null for a real intro offer, and only
// a price of exactly 0 is a FREE trial (a nonzero introPrice is a discounted
// intro price, a different offer type this paywall doesn't claim to be).
export function trialLengthLabel(product: PurchasesStoreProduct): string | null {
  const intro = product.introPrice;
  if (!intro || intro.price !== 0) return null;
  const n = intro.periodNumberOfUnits;
  const unit = { DAY: 'day', WEEK: 'week', MONTH: 'month', YEAR: 'year' }[intro.periodUnit] ?? intro.periodUnit.toLowerCase();
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

// A cheap re-check the paywall can fire on mount — picks up a purchase made
// on another device (server/src/routes/billing.ts's webhook already keeps
// `entitlements` current; this just pulls the freshest copy into the client
// without waiting for the query-client's own foreground refetch).
export function useSyncEntitlement() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => syncAndInvalidate(queryClient),
  });
}
