import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Purchases, { type PurchasesPackage } from 'react-native-purchases';

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
