import {
  clearTokens,
  getCachedAccessToken,
  getCachedRefreshToken,
  loadTokens,
  setTokens,
} from '@/lib/auth/tokenStore';

import type {
  ApiEntitlement,
  ApiTask,
  ApiTool,
  ApiUser,
  AuthTokens,
  BootstrapResponse,
  ApiMessage,
  VerifyOtpResponse,
} from './types';

const BASE_URL = process.env.EXPO_PUBLIC_API_URL;
if (!BASE_URL) {
  throw new Error('EXPO_PUBLIC_API_URL is not set — check your .env file.');
}

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown) {
    super(`API error ${status}`);
    this.status = status;
    this.body = body;
  }
}

export class SessionExpiredError extends Error {}

let onSessionExpired: (() => void) | null = null;
export function setSessionExpiredHandler(handler: () => void) {
  onSessionExpired = handler;
}

let refreshPromise: Promise<string | null> | null = null;

async function refreshAccessToken(): Promise<string | null> {
  if (!refreshPromise) {
    refreshPromise = (async () => {
      const refreshToken = getCachedRefreshToken();
      if (!refreshToken) return null;

      const res = await fetch(`${BASE_URL}/auth/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });

      if (!res.ok) {
        await clearTokens();
        return null;
      }

      const data = (await res.json()) as AuthTokens;
      await setTokens(data);
      return data.accessToken;
    })().finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

async function request<T>(path: string, options: RequestInit = {}, isRetry = false): Promise<T> {
  await loadTokens();
  const accessToken = getCachedAccessToken();

  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      ...options.headers,
    },
  });

  if (res.status === 401 && !isRetry && !path.startsWith('/auth/')) {
    const newAccessToken = await refreshAccessToken();
    if (newAccessToken) {
      return request<T>(path, options, true);
    }
    onSessionExpired?.();
    throw new SessionExpiredError();
  }

  const body = await res.json().catch(() => undefined);
  if (!res.ok) {
    throw new ApiError(res.status, body);
  }
  return body as T;
}

export const api = {
  requestOtp: (phone: string) =>
    request<{ ok: true }>('/auth/otp/request', { method: 'POST', body: JSON.stringify({ phone }) }),

  verifyOtp: (phone: string, code: string) =>
    request<VerifyOtpResponse>('/auth/otp/verify', {
      method: 'POST',
      body: JSON.stringify({ phone, code }),
    }),

  logout: async () => {
    const refreshToken = getCachedRefreshToken();
    if (refreshToken) {
      await request('/auth/logout', {
        method: 'POST',
        body: JSON.stringify({ refreshToken }),
      }).catch(() => {});
    }
    await clearTokens();
  },

  me: () => request<{ user: ApiUser; entitlement: ApiEntitlement }>('/me'),

  bootstrap: () => request<BootstrapResponse>('/bootstrap'),

  getMessages: (cursor?: string) =>
    request<{ messages: ApiMessage[] }>(
      `/conversations/current/messages${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
    ),

  sendMessage: (text: string) =>
    request<{ messages: ApiMessage[] }>('/conversations/current/messages', {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),

  getTasks: () => request<{ tasks: ApiTask[] }>('/tasks'),

  createTask: (input: { title: string; icon?: string; dueAt?: string }) =>
    request<{ task: ApiTask }>('/tasks', { method: 'POST', body: JSON.stringify(input) }),

  toggleTask: (id: string) => request<{ task: ApiTask }>(`/tasks/${id}/toggle`, { method: 'POST' }),

  getTools: () => request<{ tools: ApiTool[] }>('/tools'),
};
