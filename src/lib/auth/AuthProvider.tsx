import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { logOutPurchases } from '@/features/billing/purchases';
import { api, setSessionExpiredHandler } from '@/lib/api/client';
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
