import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { tasksQueryKey } from '@/features/tasks/queries';
import { goalsQueryKey } from '@/features/goals/queries';
import { meQueryKey } from '@/features/profile/queries';
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

// Report an assistant reply as offensive (Google AI-content policy). No cache
// to touch — the report is write-only and nothing on screen changes (the
// confirmation is a toast/alert, consistent with the card-is-the-confirmation
// ethos).
export function useReportMessage() {
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) => api.reportMessage(id, reason),
  });
}

// "Clear conversation" — wipes the chat thread (server deletes messages only;
// tasks/goals/memories survive). Empties the local cache immediately on success
// so the thread reads clean without a refetch.
export function useClearConversation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.clearConversation(),
    onSuccess: () => {
      queryClient.setQueryData<{ messages: ChatMessage[] }>(messagesQueryKey, { messages: [] });
    },
  });
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

      // Once the server has persisted the user turn (user_message) and/or run a
      // real, side-effecting action, a naive resend is UNSAFE: the server keys
      // idempotency on the user-message id, so a retry (new id) duplicates the
      // user row (#18) and re-executes every already-succeeded action — a second
      // task, a second $20 logged (#9). In that case we do NOT offer "tap to
      // retry"; we drop the dangling placeholder, clear the sending state, and
      // refetch so the thread shows the true server state (whatever landed).
      let userPersisted = false;
      let turnHadAction = false;
      const reconcileFromServer = () => {
        const droppedAssistantId = currentAssistantId;
        const settledUserId = currentUserId;
        updateMessages((prev) =>
          prev
            .filter((m) => m.id !== droppedAssistantId)
            .map((m) => (m.id === settledUserId ? { ...m, status: undefined } : m)),
        );
        queryClient.invalidateQueries({ queryKey: messagesQueryKey });
      };
      // A post-persist failure can't be a naive resend — reconcile instead.
      const failTurn = (status: ChatMessageStatus) => {
        if (userPersisted || turnHadAction) reconcileFromServer();
        else markFailed(status);
      };

      try {
        for await (const event of streamMessage(text)) {
          if (event.type === 'user_message') {
            const persisted = event.message;
            const tempId = currentUserId;
            updateMessages((prev) => prev.map((m) => (m.id === tempId ? persisted : m)));
            currentUserId = persisted.id;
            userPersisted = true;
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
            turnHadAction = true;
            // Same record, two views (CLAUDE.md §2) — the Tasks/Goals tab
            // must reflect this the instant the card appears in chat. Both
            // prefixes always: a task_action on a goal-linked task auto-logs
            // a goal entry server-side (and undo reverses one), so splitting
            // the invalidation by kind left whichever tab the kind didn't
            // name showing stale totals. The ['goals'] prefix covers the
            // list, every detail/entries query, and the consistency map.
            queryClient.invalidateQueries({ queryKey: tasksQueryKey });
            queryClient.invalidateQueries({ queryKey: goalsQueryKey });
            // Profile stat row + badges are derived from the same records this
            // action just wrote (the ['profile'] prefix covers the overview).
            queryClient.invalidateQueries({ queryKey: ['profile'] });
          } else if (event.type === 'stream_end') {
            // The last segment always leaves one trailing, never-filled
            // placeholder behind (created in anticipation of a segment that
            // never came) — drop it.
            const danglingId = currentAssistantId;
            updateMessages((prev) => prev.filter((m) => m.id !== danglingId));
          } else if (event.type === 'error') {
            failTurn('failed');
          } else if (event.type === 'limit_reached') {
            markFailed('limit_reached');
          } else if (event.type === 'consent_required') {
            // Refetch /me so _layout's nav guard sees consent is missing and
            // routes to the consent screen (it owns the routing — see the
            // needsAiConsent guard). Just drop the in-flight bubble here.
            markFailed('failed');
            queryClient.invalidateQueries({ queryKey: meQueryKey });
          }
        }
      } catch {
        failTurn('failed');
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
