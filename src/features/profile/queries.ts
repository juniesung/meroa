import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '@/lib/api/client';
import type { ApiEntitlement, ApiUser } from '@/lib/api/types';

export const meQueryKey = ['me'] as const;
// Parent key ['profile'] is what the task/goal/chat mutations invalidate (they
// already invalidate the sibling ['goals'] parent for the streak) so the
// stat row + badges refresh whenever a real record changes.
export const profileOverviewQueryKey = ['profile', 'overview'] as const;

export function useMe(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: meQueryKey,
    queryFn: () => api.me(),
    enabled: options?.enabled,
  });
}

export function useProfileOverview() {
  return useQuery({
    queryKey: profileOverviewQueryKey,
    queryFn: () => api.getProfileOverview(),
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
