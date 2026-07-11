import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '@/lib/api/client';
import type { ApiTask } from '@/lib/api/types';

export const tasksQueryKey = ['tasks'] as const;

export function useTasks() {
  return useQuery({
    queryKey: tasksQueryKey,
    queryFn: () => api.getTasks(),
    select: (data) => data.tasks,
  });
}

export function useToggleTask() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => api.toggleTask(id),
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: tasksQueryKey });
      const previous = queryClient.getQueryData<{ tasks: ApiTask[] }>(tasksQueryKey);

      queryClient.setQueryData<{ tasks: ApiTask[] }>(tasksQueryKey, (prev) => ({
        tasks: (prev?.tasks ?? []).map((t) =>
          t.id === id ? { ...t, status: t.status === 'open' ? 'done' : 'open' } : t,
        ),
      }));

      return { previous };
    },
    onError: (_err, _id, context) => {
      if (context?.previous) queryClient.setQueryData(tasksQueryKey, context.previous);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: tasksQueryKey });
    },
  });
}
