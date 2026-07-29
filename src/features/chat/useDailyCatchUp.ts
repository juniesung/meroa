import { useEffect } from 'react';
import { AppState } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';

import { isChatStreaming, messagesQueryKey } from '@/features/chat/queries';
import { api } from '@/lib/api/client';

/**
 * Pings the catch-up endpoint on mount and whenever the app returns to the
 * foreground (WS4/WS5) — the server drops a first-open-of-day ritual or weekly
 * recap into the chat thread if one's due, deduped per period, so pinging often
 * is safe. Then refreshes the messages cache so anything new shows: the ritual
 * itself, and also any "Meroa noticed" reactions (WS1) that landed while the
 * user was on another tab or the app was backgrounded.
 */
export function useDailyCatchUp() {
  const queryClient = useQueryClient();
  useEffect(() => {
    let cancelled = false;
    // Never refetch mid-stream — a getMessages snapshot would clobber the
    // optimistic in-flight reply and truncate it. If a stream is running, wait
    // for it to finish, then refresh so the ritual/reactions still show.
    const refreshWhenIdle = () => {
      if (cancelled) return;
      if (isChatStreaming()) {
        setTimeout(refreshWhenIdle, 800);
        return;
      }
      queryClient.invalidateQueries({ queryKey: messagesQueryKey });
    };
    const run = () => {
      api
        .catchUp()
        .catch(() => {})
        .finally(refreshWhenIdle);
    };
    run();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') run();
    });
    return () => {
      cancelled = true;
      sub.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
