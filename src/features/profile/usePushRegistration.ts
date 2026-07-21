import { useEffect } from 'react';
import { AppState } from 'react-native';

import { useMe } from '@/features/profile/queries';
import { registerForPushNotifications } from '@/lib/push';

/**
 * Keeps this device's Expo push token registered with the server whenever the
 * user has proactive check-ins on — on mount and on every foreground, since a
 * token can change (reinstall, OS refresh). The register call is a safe no-op
 * off a dev build / on a simulator, so this is cheap to run unconditionally
 * within the enabled branch. Mounted once, in the tabs layout.
 */
export function usePushRegistration() {
  const { data: me } = useMe();
  const enabled = me?.user.prefs.proactiveCheckins === true;

  useEffect(() => {
    if (!enabled) return;
    void registerForPushNotifications();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void registerForPushNotifications();
    });
    return () => sub.remove();
  }, [enabled]);
}
