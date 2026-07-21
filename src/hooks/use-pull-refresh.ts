import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { haptics } from '@/lib/haptics';

/**
 * Wires a `<RefreshControl>` to react-query: pulling down refetches the given
 * query keys and holds the spinner until they settle, with a Light haptic on
 * trigger. `refreshing`/`onRefresh` drop straight onto RefreshControl. setState
 * lives in the gesture handler (not an effect), so it's a plain event flow.
 */
export function usePullRefresh(queryKeys: readonly (readonly unknown[])[]) {
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = async () => {
    haptics.tap();
    setRefreshing(true);
    try {
      await Promise.all(queryKeys.map((key) => queryClient.refetchQueries({ queryKey: key })));
    } finally {
      setRefreshing(false);
    }
  };

  return { refreshing, onRefresh };
}
