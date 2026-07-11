import { fetch as expoFetch } from 'expo/fetch';

import { ApiError, notifySessionExpired, refreshAccessToken, SessionExpiredError } from '@/lib/api/client';
import { getCachedAccessToken, loadTokens } from '@/lib/auth/tokenStore';

import type { ApiMessage } from './types';

const BASE_URL = process.env.EXPO_PUBLIC_API_URL;
if (!BASE_URL) {
  throw new Error('EXPO_PUBLIC_API_URL is not set — check your .env file.');
}

export type ChatStreamEvent =
  | { type: 'user_message'; message: ApiMessage }
  | { type: 'delta'; text: string }
  | { type: 'segment'; message: ApiMessage }
  | { type: 'stream_end' }
  | { type: 'error'; retryable: boolean; message: string }
  | { type: 'limit_reached'; plan: 'free' | 'plus'; limit: number };

/** Parses a `text/event-stream` body into `{event, data}` pairs, one per blank-line-delimited block. */
async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let sepIndex = buffer.indexOf('\n\n');
    while (sepIndex !== -1) {
      const block = buffer.slice(0, sepIndex);
      buffer = buffer.slice(sepIndex + 2);

      let event = 'message';
      const dataLines: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7);
        else if (line.startsWith('data: ')) dataLines.push(line.slice(6));
      }
      if (dataLines.length > 0) yield { event, data: dataLines.join('\n') };

      sepIndex = buffer.indexOf('\n\n');
    }
  }
}

/** Streams a chat reply for `text`. Yields events as they arrive; never throws for a limit/model error — those surface as `error`/`limit_reached` events. */
export async function* streamMessage(text: string, isRetry = false): AsyncGenerator<ChatStreamEvent> {
  await loadTokens();
  const accessToken = getCachedAccessToken();

  const res = await expoFetch(`${BASE_URL}/conversations/current/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify({ text }),
  });

  if (res.status === 401 && !isRetry) {
    const newAccessToken = await refreshAccessToken();
    if (newAccessToken) {
      yield* streamMessage(text, true);
      return;
    }
    notifySessionExpired();
    throw new SessionExpiredError();
  }

  if (res.status === 429) {
    const body = await res.json().catch(() => undefined);
    yield { type: 'limit_reached', plan: body?.plan ?? 'free', limit: body?.limit ?? 0 };
    return;
  }

  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => undefined);
    throw new ApiError(res.status, body);
  }

  for await (const { event, data } of parseSSE(res.body)) {
    const parsed = JSON.parse(data);
    switch (event) {
      case 'user_message':
        yield { type: 'user_message', message: parsed };
        break;
      case 'delta':
        yield { type: 'delta', text: parsed.text };
        break;
      case 'segment':
        yield { type: 'segment', message: parsed.message };
        break;
      case 'stream_end':
        yield { type: 'stream_end' };
        break;
      case 'error':
        yield { type: 'error', retryable: parsed.retryable, message: parsed.message };
        break;
    }
  }
}
