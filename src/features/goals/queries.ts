import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '@/lib/api/client';
import { tasksQueryKey } from '@/features/tasks/queries';
import type { ApiGoal, EditGoalPatch, LogGoalEntryPatch } from '@/lib/api/types';

export const goalsQueryKey = ['goals'] as const;
export const goalDetailQueryKey = (id: string) => ['goals', id] as const;
export const goalEntriesQueryKey = (id: string) => ['goals', id, 'entries'] as const;

export function useGoals() {
  return useQuery({
    queryKey: goalsQueryKey,
    queryFn: () => api.getGoals(),
    select: (data) => data.goals,
  });
}

export function useGoal(id: string | undefined) {
  return useQuery({
    queryKey: goalDetailQueryKey(id ?? ''),
    queryFn: () => api.getGoal(id!),
    enabled: !!id,
  });
}

export function useGoalEntries(id: string | undefined, cursor?: string) {
  return useQuery({
    queryKey: [...goalEntriesQueryKey(id ?? ''), cursor ?? null],
    queryFn: () => api.getGoalEntries(id!, cursor),
    select: (data) => data.entries,
    enabled: !!id,
  });
}

function upsertGoal(goals: ApiGoal[], goal: ApiGoal): ApiGoal[] {
  return goals.some((g) => g.id === goal.id) ? goals.map((g) => (g.id === goal.id ? goal : g)) : [...goals, goal];
}

function invalidateGoal(queryClient: ReturnType<typeof useQueryClient>, goalId: string) {
  queryClient.invalidateQueries({ queryKey: goalsQueryKey });
  queryClient.invalidateQueries({ queryKey: goalDetailQueryKey(goalId) });
  queryClient.invalidateQueries({ queryKey: goalEntriesQueryKey(goalId) });
}

export function useCreateGoalFromPreview() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (previewMessageId: string) => api.createGoalFromPreview(previewMessageId),
    onSuccess: (data) => {
      queryClient.setQueryData<{ goals: ApiGoal[] }>(goalsQueryKey, (prev) => ({
        goals: upsertGoal(prev?.goals ?? [], data.goal),
      }));
    },
    onSettled: (data) => {
      queryClient.invalidateQueries({ queryKey: goalsQueryKey });
      if (data) queryClient.invalidateQueries({ queryKey: goalDetailQueryKey(data.goal.id) });
      // Starter tasks are created alongside the goal in the same transaction
      // (docs/goals-redesign-plan.md §2.3) — the Tasks tab needs to reflect
      // them the instant Create is tapped, same as any other task action.
      if (data?.tasks.length) queryClient.invalidateQueries({ queryKey: tasksQueryKey });
    },
  });
}

export function useEditGoal() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: EditGoalPatch }) => api.editGoal(id, patch),
    onSettled: (_data, _err, vars) => invalidateGoal(queryClient, vars.id),
  });
}

export function useLogGoalEntry() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: LogGoalEntryPatch }) => api.logGoalEntry(id, patch),
    onSettled: (_data, _err, vars) => invalidateGoal(queryClient, vars.id),
  });
}

export function useArchiveGoal() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.archiveGoal(id),
    onSuccess: (data) => {
      queryClient.setQueryData<{ goals: ApiGoal[] }>(goalsQueryKey, (prev) => ({
        goals: (prev?.goals ?? []).filter((g) => g.id !== data.goal.id),
      }));
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: goalsQueryKey });
    },
  });
}
