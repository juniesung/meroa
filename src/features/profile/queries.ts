import { useQuery } from '@tanstack/react-query';

import { api } from '@/lib/api/client';

export const meQueryKey = ['me'] as const;

export function useMe() {
  return useQuery({
    queryKey: meQueryKey,
    queryFn: () => api.me(),
  });
}
