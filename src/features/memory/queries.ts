import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '@/lib/api/client';

export const memoriesQueryKey = ['memories'] as const;

export function useMemories() {
  return useQuery({
    queryKey: memoriesQueryKey,
    queryFn: () => api.listMemories(),
    select: (data) => data.memories,
  });
}

export function useCreateMemory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { content: string; kind: string; sensitive?: boolean }) => api.createMemory(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: memoriesQueryKey }),
  });
}

export function useUpdateMemory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      patch,
    }: {
      id: string;
      patch: { content?: string; sensitive?: boolean; suppressed?: boolean };
    }) => api.updateMemory(id, patch),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: memoriesQueryKey }),
  });
}

export function useDeleteMemory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteMemory(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: memoriesQueryKey }),
  });
}
