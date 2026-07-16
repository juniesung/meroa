import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '@/lib/api/client';
import type { ApiEntitlement, ApiUser } from '@/lib/api/types';

export const meQueryKey = ['me'] as const;

export function useMe() {
  return useQuery({
    queryKey: meQueryKey,
    queryFn: () => api.me(),
  });
}

export function useUpdatePrefs() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: Record<string, unknown>) => api.updatePrefs(patch),
    onSuccess: (data) => {
      queryClient.setQueryData<{ user: ApiUser; entitlement: ApiEntitlement }>(meQueryKey, (prev) =>
        prev ? { ...prev, user: { ...prev.user, prefs: data.prefs } } : prev,
      );
    },
  });
}

export function useUpdateTimezone() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (timezone: string) => api.updateTimezone(timezone),
    onSuccess: (data) => {
      queryClient.setQueryData<{ user: ApiUser; entitlement: ApiEntitlement }>(meQueryKey, (prev) =>
        prev ? { ...prev, user: { ...prev.user, timezone: data.timezone } } : prev,
      );
    },
  });
}
