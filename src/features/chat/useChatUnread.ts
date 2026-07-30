import { useSyncExternalStore } from 'react';
import * as SecureStore from 'expo-secure-store';

import { type ChatMessage, useMessages } from './queries';

// Chat-tab unread indicator (client-only, Option A). Meroa drops proactive
// messages into the thread (daily ritual, "noticed" reactions, weekly recap)
// while the user may be on another tab — a dot on the Chat icon nudges them.
//
// The read cursor is the ISO timestamp of the newest message the user has
// actually seen (Chat tab focused). Persisted so a message received while away
// still badges after an app restart; per-device is fine (it's just a nudge).
// A module-level mirror + listeners lets the tab badge (reader, in the tabs
// layout) and the chat screen (writer, on focus) react to the same cursor.

const KEY = 'chat_last_read_at';

let lastReadAt: string | null = null;
const listeners = new Set<() => void>();
function emit(): void {
  for (const l of listeners) l();
}

// Hydrate the persisted cursor once, then wake any mounted subscribers.
SecureStore.getItemAsync(KEY)
  .then((v) => {
    if (v && (!lastReadAt || v > lastReadAt)) lastReadAt = v;
  })
  .catch(() => {})
  .finally(emit);

// Advance the cursor to `upTo` (ISO). Monotonic — never moves backward, so a
// stale render can't un-read newer messages. No-op for a null/older value.
export function markChatRead(upTo: string | null | undefined): void {
  if (!upTo) return;
  if (lastReadAt && upTo <= lastReadAt) return;
  lastReadAt = upTo;
  SecureStore.setItemAsync(KEY, upTo).catch(() => {});
  emit();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function useChatLastRead(): string | null {
  return useSyncExternalStore(subscribe, () => lastReadAt);
}

// The newest PERSISTED assistant message (skip in-flight placeholders, which
// carry a `status`) — the thing a badge would be about.
function newestAssistantAt(messages: ChatMessage[] | undefined): string | null {
  if (!messages) return null;
  let latest: string | null = null;
  for (const m of messages) {
    if (m.role === 'assistant' && !m.status && (!latest || m.createdAt > latest)) {
      latest = m.createdAt;
    }
  }
  return latest;
}

// True when an assistant message is newer than the read cursor. Used in the
// tabs layout; the useMessages() observer here also keeps the ['messages']
// query active so useDailyCatchUp's foreground invalidation refetches even
// while the Chat screen is unmounted. Null cursor (pre-hydration / never
// focused) => no badge, so a first cold open doesn't flash a spurious dot.
export function useChatUnread(): boolean {
  const { data: messages } = useMessages();
  const lastRead = useChatLastRead();
  const newest = newestAssistantAt(messages);
  return lastRead != null && newest != null && newest > lastRead;
}
