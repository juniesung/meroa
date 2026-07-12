import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '@/lib/api/client';
import type { ApiTool, EditToolPatch, LogToolEntryPatch } from '@/lib/api/types';

export const toolsQueryKey = ['tools'] as const;
export const toolDetailQueryKey = (id: string) => ['tools', id] as const;
export const toolEntriesQueryKey = (id: string) => ['tools', id, 'entries'] as const;

export function useTools() {
  return useQuery({
    queryKey: toolsQueryKey,
    queryFn: () => api.getTools(),
    select: (data) => data.tools,
  });
}

export function useTool(id: string | undefined) {
  return useQuery({
    queryKey: toolDetailQueryKey(id ?? ''),
    queryFn: () => api.getTool(id!),
    enabled: !!id,
  });
}

export function useToolEntries(id: string | undefined, cursor?: string) {
  return useQuery({
    queryKey: [...toolEntriesQueryKey(id ?? ''), cursor ?? null],
    queryFn: () => api.getToolEntries(id!, cursor),
    select: (data) => data.entries,
    enabled: !!id,
  });
}

function upsertTool(tools: ApiTool[], tool: ApiTool): ApiTool[] {
  return tools.some((t) => t.id === tool.id) ? tools.map((t) => (t.id === tool.id ? tool : t)) : [...tools, tool];
}

function invalidateTool(queryClient: ReturnType<typeof useQueryClient>, toolId: string) {
  queryClient.invalidateQueries({ queryKey: toolsQueryKey });
  queryClient.invalidateQueries({ queryKey: toolDetailQueryKey(toolId) });
  queryClient.invalidateQueries({ queryKey: toolEntriesQueryKey(toolId) });
}

export function useCreateToolFromPreview() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (previewMessageId: string) => api.createToolFromPreview(previewMessageId),
    onSuccess: (data) => {
      queryClient.setQueryData<{ tools: ApiTool[] }>(toolsQueryKey, (prev) => ({
        tools: upsertTool(prev?.tools ?? [], data.tool),
      }));
    },
    onSettled: (data) => {
      queryClient.invalidateQueries({ queryKey: toolsQueryKey });
      if (data) queryClient.invalidateQueries({ queryKey: toolDetailQueryKey(data.tool.id) });
    },
  });
}

export function useEditTool() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: EditToolPatch }) => api.editTool(id, patch),
    onSettled: (_data, _err, vars) => invalidateTool(queryClient, vars.id),
  });
}

export function useLogToolEntry() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: LogToolEntryPatch }) => api.logToolEntry(id, patch),
    onSettled: (_data, _err, vars) => invalidateTool(queryClient, vars.id),
  });
}

export function useArchiveTool() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.archiveTool(id),
    onSuccess: (data) => {
      queryClient.setQueryData<{ tools: ApiTool[] }>(toolsQueryKey, (prev) => ({
        tools: (prev?.tools ?? []).filter((t) => t.id !== data.tool.id),
      }));
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: toolsQueryKey });
    },
  });
}
