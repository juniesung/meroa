import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '@/lib/api/client';
import type {
  ApiTask,
  CompleteTaskInput,
  CreateTaskInput,
  EditTaskPatch,
  PostponeTaskInput,
  ProgressInput,
} from '@/lib/api/types';

export const tasksQueryKey = ['tasks'] as const;

export function useTasks() {
  return useQuery({
    queryKey: tasksQueryKey,
    queryFn: () => api.getTasks(),
    select: (data) => data.tasks,
  });
}

function upsertTask(tasks: ApiTask[], task: ApiTask): ApiTask[] {
  return tasks.some((t) => t.id === task.id)
    ? tasks.map((t) => (t.id === task.id ? task : t))
    : [...tasks, task];
}

// Every task mutation returns the fresh row from the executor, so the cache
// is corrected the moment the response lands (no client-side reimplementing
// of the six-type progress rules) — `onSettled` still invalidates so a
// recurring create's freshly-materialized siblings and anything else the
// response didn't carry stay in sync.
//
// Also invalidates the goals-consistency key by its literal value (not
// imported from features/goals/queries.ts, which itself imports
// tasksQueryKey from here — importing the other direction too would make
// the two modules circular) — completing/postponing/editing a task can
// change a day's verdict, so the streak/heatmap need a fresh fetch too.
function useTaskMutation<TVars>(mutationFn: (vars: TVars) => Promise<{ task: ApiTask }>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: (data) => {
      queryClient.setQueryData<{ tasks: ApiTask[] }>(tasksQueryKey, (prev) => ({
        tasks: upsertTask(prev?.tasks ?? [], data.task),
      }));
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: tasksQueryKey });
      queryClient.invalidateQueries({ queryKey: ['goals', 'consistency'] });
    },
  });
}

export function useCreateTask() {
  return useTaskMutation((input: CreateTaskInput) => api.createTask(input));
}

export function useEditTask() {
  return useTaskMutation(({ id, patch }: { id: string; patch: EditTaskPatch }) =>
    api.editTask(id, patch),
  );
}

export function useCompleteTask() {
  return useTaskMutation(({ id, input }: { id: string; input?: CompleteTaskInput }) =>
    api.completeTask(id, input),
  );
}

export function useProgressTask() {
  return useTaskMutation(({ id, input }: { id: string; input: ProgressInput }) =>
    api.progressTask(id, input),
  );
}

export function usePostponeTask() {
  return useTaskMutation(({ id, input }: { id: string; input: PostponeTaskInput }) =>
    api.postponeTask(id, input),
  );
}

export function useDeleteTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteTask(id),
    onSuccess: (data) => {
      queryClient.setQueryData<{ tasks: ApiTask[] }>(tasksQueryKey, (prev) => ({
        tasks: (prev?.tasks ?? []).filter((t) => t.id !== data.task.id),
      }));
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: tasksQueryKey });
    },
  });
}

export function useBulkDeleteTasks() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (taskIds: string[]) => api.bulkRemoveTasks(taskIds),
    onSuccess: (data) => {
      const removedIds = new Set(data.tasks.map((t) => t.id));
      queryClient.setQueryData<{ tasks: ApiTask[] }>(tasksQueryKey, (prev) => ({
        tasks: (prev?.tasks ?? []).filter((t) => !removedIds.has(t.id)),
      }));
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: tasksQueryKey });
    },
  });
}

export function useUndoLastTaskAction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.undoLastTaskAction(),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: tasksQueryKey });
    },
  });
}
