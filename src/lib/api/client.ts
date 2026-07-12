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
  ApiToolDetail,
  ApiToolEntry,
  ApiUser,
  AuthTokens,
  BootstrapResponse,
  ApiMessage,
  CompleteTaskInput,
  CreateTaskInput,
  EditTaskPatch,
  EditToolPatch,
  LogToolEntryPatch,
  PostponeTaskInput,
  ProgressInput,
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

// Rough device-vs-server clock offset, refreshed from every response's Date
// header (every HTTP response has one — no dedicated endpoint needed). Not
// meant to be precise (no RTT correction), just enough to keep a running
// timer's live display from freezing at 0% for its whole duration if the
// device clock is genuinely misconfigured, not just momentarily stale.
let clockOffsetMs = 0;
export function getClockOffsetMs(): number {
  return clockOffsetMs;
}
function updateClockOffset(res: Response) {
  const dateHeader = res.headers.get('date');
  if (!dateHeader) return;
  const serverTime = Date.parse(dateHeader);
  if (Number.isNaN(serverTime)) return;
  clockOffsetMs = serverTime - Date.now();
}
export function notifySessionExpired() {
  onSessionExpired?.();
}

let refreshPromise: Promise<string | null> | null = null;

/** Shared by the streaming client (stream.ts) so both request paths refresh through the same promise. */
export async function refreshAccessToken(): Promise<string | null> {
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
  updateClockOffset(res);

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
      // The device's IANA timezone — every AI-scheduled time and recurring
      // occurrence is computed against whatever the server has on file, so
      // this needs to reach it before any task gets created.
      body: JSON.stringify({ phone, code, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
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

  updatePrefs: (patch: Record<string, unknown>) =>
    request<{ prefs: Record<string, unknown> }>('/me/prefs', {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  updateTimezone: (timezone: string) =>
    request<{ timezone: string }>('/me/timezone', {
      method: 'PATCH',
      body: JSON.stringify({ timezone }),
    }),

  bootstrap: () => request<BootstrapResponse>('/bootstrap'),

  getMessages: (cursor?: string) =>
    request<{ messages: ApiMessage[] }>(
      `/conversations/current/messages${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
    ),

  // Sending a message streams via SSE — see lib/api/stream.ts's `streamMessage`.

  getTasks: () => request<{ tasks: ApiTask[] }>('/tasks'),

  createTask: (input: CreateTaskInput) =>
    request<{ task: ApiTask }>('/tasks', { method: 'POST', body: JSON.stringify(input) }),

  editTask: (id: string, patch: EditTaskPatch) =>
    request<{ task: ApiTask }>(`/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),

  completeTask: (id: string, input: CompleteTaskInput = {}) =>
    request<{ task: ApiTask }>(`/tasks/${id}/complete`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  progressTask: (id: string, input: ProgressInput) =>
    request<{ task: ApiTask }>(`/tasks/${id}/progress`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  postponeTask: (id: string, input: PostponeTaskInput) =>
    request<{ task: ApiTask }>(`/tasks/${id}/postpone`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  deleteTask: (id: string) => request<{ task: ApiTask }>(`/tasks/${id}`, { method: 'DELETE' }),

  bulkRemoveTasks: (taskIds: string[]) =>
    request<{ tasks: ApiTask[] }>('/tasks/bulk-remove', {
      method: 'POST',
      body: JSON.stringify({ taskIds }),
    }),

  undoLastTaskAction: () =>
    request<{ task: ApiTask; action: string }>('/tasks/undo', { method: 'POST' }),

  getTools: () => request<{ tools: ApiTool[] }>('/tools'),

  getTool: (id: string) =>
    request<{ tool: ApiTool; detail: ApiToolDetail; entries: ApiToolEntry[] }>(`/tools/${id}`),

  getToolEntries: (id: string, cursor?: string) =>
    request<{ entries: ApiToolEntry[] }>(
      `/tools/${id}/entries${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
    ),

  // Confirm-tap for a chat create_tool preview card — create_tool itself
  // never saves anything (docs/phase-4-implementation-plan.md §1.3); this
  // is the actual save, using the exact definition the card showed.
  createToolFromPreview: (previewMessageId: string) =>
    request<{ tool: ApiTool }>('/tools', {
      method: 'POST',
      body: JSON.stringify({ previewMessageId }),
    }),

  editTool: (id: string, patch: EditToolPatch) =>
    request<{ tool: ApiTool }>(`/tools/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),

  logToolEntry: (id: string, patch: LogToolEntryPatch) =>
    request<{ tool: ApiTool; entry: ApiToolEntry }>(`/tools/${id}/entries`, {
      method: 'POST',
      body: JSON.stringify(patch),
    }),

  archiveTool: (id: string) => request<{ tool: ApiTool }>(`/tools/${id}`, { method: 'DELETE' }),
};
