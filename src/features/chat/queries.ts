import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '@/lib/api/client';
import type { ApiMessage } from '@/lib/api/types';

export const messagesQueryKey = ['messages'] as const;

export function useMessages() {
  return useQuery({
    queryKey: messagesQueryKey,
    queryFn: () => api.getMessages(),
    select: (data) => data.messages,
  });
}

export function useSendMessage() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (text: string) => api.sendMessage(text),
    onSuccess: (data) => {
      queryClient.setQueryData<{ messages: ApiMessage[] }>(messagesQueryKey, (prev) => ({
        messages: [...(prev?.messages ?? []), ...data.messages],
      }));
    },
  });
}
