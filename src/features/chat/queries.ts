import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { tasksQueryKey } from '@/features/tasks/queries';
import { api } from '@/lib/api/client';
import { streamMessage } from '@/lib/api/stream';
import type { ApiMessage } from '@/lib/api/types';

export const messagesQueryKey = ['messages'] as const;

export type ChatMessageStatus = 'sending' | 'streaming' | 'failed' | 'limit_reached';

export type ChatMessage = ApiMessage & { status?: ChatMessageStatus };

export function useMessages() {
  return useQuery({
    queryKey: messagesQueryKey,
    queryFn: () => api.getMessages(),
    select: (data) => data.messages as ChatMessage[],
  });
}

let tempIdCounter = 0;
function nextTempId(prefix: string) {
  tempIdCounter += 1;
  return `${prefix}-${tempIdCounter}`;
}

function placeholderAssistantMessage(id: string): ChatMessage {
  return {
    id,
    conversationId: '',
    role: 'assistant',
    content: '',
    meta: {},
    createdAt: new Date().toISOString(),
    status: 'streaming',
  };
}

export function useSendMessage() {
  const queryClient = useQueryClient();

  const updateMessages = useCallback(
    (updater: (prev: ChatMessage[]) => ChatMessage[]) => {
      queryClient.setQueryData<{ messages: ChatMessage[] }>(messagesQueryKey, (prev) => ({
        messages: updater(prev?.messages ?? []),
      }));
    },
    [queryClient],
  );

  const send = useCallback(
    async (text: string) => {
      const now = new Date().toISOString();
      // These track whichever row is currently "live" — the user message
      // (until its persisted id arrives) and whichever assistant bubble is
      // presently streaming. A multi-bubble reply moves currentAssistantId
      // to a fresh placeholder each time a segment finishes.
      let currentUserId = nextTempId('temp-user');
      let currentAssistantId = nextTempId('temp-assistant');

      const tempUserMessage: ChatMessage = {
        id: currentUserId,
        conversationId: '',
        role: 'user',
        content: text,
        meta: {},
        createdAt: now,
        status: 'sending',
      };

      updateMessages((prev) => [
        ...prev,
        tempUserMessage,
        placeholderAssistantMessage(currentAssistantId),
      ]);

      const markFailed = (status: ChatMessageStatus) => {
        const failedAssistantId = currentAssistantId;
        const failedUserId = currentUserId;
        updateMessages((prev) =>
          prev
            .filter((m) => m.id !== failedAssistantId)
            .map((m) => (m.id === failedUserId ? { ...m, status } : m)),
        );
      };

      try {
        for await (const event of streamMessage(text)) {
          if (event.type === 'user_message') {
            const persisted = event.message;
            const tempId = currentUserId;
            updateMessages((prev) => prev.map((m) => (m.id === tempId ? persisted : m)));
            currentUserId = persisted.id;
          } else if (event.type === 'delta') {
            const assistantId = currentAssistantId;
            updateMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId ? { ...m, content: m.content + event.text } : m,
              ),
            );
          } else if (event.type === 'segment') {
            const persisted = event.message;
            const finishedId = currentAssistantId;
            const nextId = nextTempId('temp-assistant');
            updateMessages((prev) => [
              ...prev.map((m) => (m.id === finishedId ? persisted : m)),
              placeholderAssistantMessage(nextId),
            ]);
            currentAssistantId = nextId;
          } else if (event.type === 'action') {
            const persisted = event.message;
            const finishedId = currentAssistantId;
            const nextId = nextTempId('temp-assistant');
            updateMessages((prev) => [
              ...prev.map((m) => (m.id === finishedId ? persisted : m)),
              placeholderAssistantMessage(nextId),
            ]);
            currentAssistantId = nextId;
            // Same record, two views (CLAUDE.md §2) — the Tasks tab must
            // reflect this the instant the card appears in chat.
            queryClient.invalidateQueries({ queryKey: tasksQueryKey });
          } else if (event.type === 'stream_end') {
            // The last segment always leaves one trailing, never-filled
            // placeholder behind (created in anticipation of a segment that
            // never came) — drop it.
            const danglingId = currentAssistantId;
            updateMessages((prev) => prev.filter((m) => m.id !== danglingId));
          } else if (event.type === 'error') {
            markFailed('failed');
          } else if (event.type === 'limit_reached') {
            markFailed('limit_reached');
          }
        }
      } catch {
        markFailed('failed');
      }
    },
    [updateMessages, queryClient],
  );

  const retry = useCallback(
    (message: ChatMessage) => {
      updateMessages((prev) => prev.filter((m) => m.id !== message.id));
      return send(message.content);
    },
    [send, updateMessages],
  );

  return { send, retry };
}
