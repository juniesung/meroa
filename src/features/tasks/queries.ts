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
// The whole ['goals'] prefix is invalidated too — by literal value, not
// imported from features/goals/queries.ts (which itself imports
// tasksQueryKey from here; importing the other direction would make the
// two modules circular). Completing a goal-linked task auto-logs a goal
// entry server-side, so the goal LIST (card headlines/progress), the goal
// detail, its entries, and the consistency map can all change on any task
// mutation; invalidating only the consistency key left the Goals tab card
// frozen at its old total while the detail screen (refetched on mount)
// showed the truth — hit live.
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
      queryClient.invalidateQueries({ queryKey: ['goals'] });
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
    // Deleting a recurring TEMPLATE cascades its OPEN instances server-side
    // (lib/tasks/executor.ts's removeTask) — a done instance deliberately
    // survives as history. The response only carries the template row
    // itself, so without also dropping any cached OPEN row whose
    // templateId points at what was just deleted, today's materialized
    // instance stayed visible until the onSettled refetch happened to land
    // (observed live as "the daily task doesn't disappear"). Scoped to
    // status === 'open' here too — an unconditional filter would instead
    // flash-hide a genuinely-preserved done instance until that same
    // refetch corrected it back.
    onSuccess: (data) => {
      queryClient.setQueryData<{ tasks: ApiTask[] }>(tasksQueryKey, (prev) => ({
        tasks: (prev?.tasks ?? []).filter(
          (t) => t.id !== data.task.id && !(t.templateId === data.task.id && t.status === 'open'),
        ),
      }));
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: tasksQueryKey });
      queryClient.invalidateQueries({ queryKey: ['goals'] });
    },
  });
}

export function useBulkDeleteTasks() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (taskIds: string[]) => api.bulkRemoveTasks(taskIds),
    // Same cascaded-instance gap as useDeleteTask above, batched — and the
    // same status === 'open' scoping so a done instance of a removed
    // template isn't optimistically (and wrongly) hidden.
    onSuccess: (data) => {
      const removedIds = new Set(data.tasks.map((t) => t.id));
      queryClient.setQueryData<{ tasks: ApiTask[] }>(tasksQueryKey, (prev) => ({
        tasks: (prev?.tasks ?? []).filter(
          (t) =>
            !removedIds.has(t.id) &&
            !(t.templateId && removedIds.has(t.templateId) && t.status === 'open'),
        ),
      }));
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: tasksQueryKey });
      queryClient.invalidateQueries({ queryKey: ['goals'] });
    },
  });
}

// Undo can revert a task completion — which removes its auto-logged goal
// entry — or revert a goal action entirely, so goals refresh here too.
export function useUndoLastTaskAction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.undoLastTaskAction(),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: tasksQueryKey });
      queryClient.invalidateQueries({ queryKey: ['goals'] });
    },
  });
}
