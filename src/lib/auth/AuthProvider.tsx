import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { logOutPurchases } from '@/features/billing/purchases';
import { api, setSessionExpiredHandler } from '@/lib/api/client';
import { queryClient } from '@/lib/query-client';
import type { AuthTokens } from '@/lib/api/types';

import { getCachedRefreshToken, loadTokens, setTokens } from './tokenStore';

type AuthStatus = 'loading' | 'signedOut' | 'signedIn';

type AuthContextValue = {
  status: AuthStatus;
  signIn: (tokens: AuthTokens) => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');

  useEffect(() => {
    setSessionExpiredHandler(() => setStatus('signedOut'));

    loadTokens().then(() => {
      setStatus(getCachedRefreshToken() ? 'signedIn' : 'signedOut');
    });
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      signIn: async (tokens) => {
        await setTokens(tokens);
        setStatus('signedIn');
      },
      signOut: async () => {
        await api.logout();
        await logOutPurchases();
        // Wipe the React Query cache — it's an app-level singleton, so without
        // this the next account signing in on this device would briefly see the
        // previous user's cached chat/tasks/goals/memories/entitlement before
        // refetches replace them (cross-account data leak).
        queryClient.clear();
        setStatus('signedOut');
      },
    }),
    [status],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
