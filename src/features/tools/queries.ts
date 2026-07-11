import { useQuery } from '@tanstack/react-query';

import { api } from '@/lib/api/client';

export const toolsQueryKey = ['tools'] as const;

export function useTools() {
  return useQuery({
    queryKey: toolsQueryKey,
    queryFn: () => api.getTools(),
    select: (data) => data.tools,
  });
}
