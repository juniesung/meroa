import * as SecureStore from 'expo-secure-store';

import type { AuthTokens } from '@/lib/api/types';

const ACCESS_KEY = 'meroa_access_token';
const REFRESH_KEY = 'meroa_refresh_token';

let accessToken: string | null = null;
let refreshToken: string | null = null;
let loaded = false;

export async function loadTokens(): Promise<AuthTokens | null> {
  if (!loaded) {
    const [a, r] = await Promise.all([
      SecureStore.getItemAsync(ACCESS_KEY),
      SecureStore.getItemAsync(REFRESH_KEY),
    ]);
    accessToken = a;
    refreshToken = r;
    loaded = true;
  }
  return accessToken && refreshToken ? { accessToken, refreshToken } : null;
}

export async function setTokens(tokens: AuthTokens): Promise<void> {
  accessToken = tokens.accessToken;
  refreshToken = tokens.refreshToken;
  loaded = true;
  await Promise.all([
    SecureStore.setItemAsync(ACCESS_KEY, tokens.accessToken),
    SecureStore.setItemAsync(REFRESH_KEY, tokens.refreshToken),
  ]);
}

export async function clearTokens(): Promise<void> {
  accessToken = null;
  refreshToken = null;
  loaded = true;
  await Promise.all([SecureStore.deleteItemAsync(ACCESS_KEY), SecureStore.deleteItemAsync(REFRESH_KEY)]);
}

export function getCachedAccessToken(): string | null {
  return accessToken;
}

export function getCachedRefreshToken(): string | null {
  return refreshToken;
}
