import { focusManager, QueryClient } from '@tanstack/react-query';
import { AppState } from 'react-native';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30_000,
    },
  },
});

// React Query's focus-refetch is a web concept by default (window focus) —
// wiring it to AppState is what makes returning to the foreground refetch
// stale queries on a phone. This is what picks up a purchase made on
// another device (or via the Test Store dashboard) into `useMe()`'s
// entitlement without the user having to do anything — Phase 7's
// two-device consistency, achieved generically rather than by special-
// casing billing.
AppState.addEventListener('change', (state) => {
  focusManager.setFocused(state === 'active');
});
