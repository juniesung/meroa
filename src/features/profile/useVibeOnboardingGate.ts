import { router } from 'expo-router';
import { useEffect } from 'react';

import { useMe } from './queries';

/**
 * Absence of prefs.communicationStyle is the first-run signal — it's
 * server-persisted, so it survives a reinstall (unlike the transient
 * isNewUser flag from OTP verify, which the client never keeps).
 */
export function useVibeOnboardingGate() {
  const { data } = useMe();

  useEffect(() => {
    if (data && typeof data.user.prefs.communicationStyle !== 'string') {
      router.push('/vibe-pick');
    }
  }, [data]);
}
