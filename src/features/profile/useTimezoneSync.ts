import { useEffect } from 'react';
import { AppState } from 'react-native';

import { useMe, useUpdateTimezone } from './queries';

/**
 * Keeps the account's stored timezone in sync with the device's — captured
 * once at OTP verify, but nothing else ever refreshed it, so travel (or the
 * OS auto-switching timezones) could silently leave the server computing
 * overdue/recurrence/end-of-day times against a stale zone. Checked on
 * mount and whenever the app returns to the foreground; only PATCHes when
 * the two actually differ.
 */
export function useTimezoneSync() {
  const { data: me } = useMe();
  const updateTimezone = useUpdateTimezone();
  const accountTimezone = me?.user.timezone;

  useEffect(() => {
    const syncIfChanged = () => {
      const deviceTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (deviceTimezone && deviceTimezone !== accountTimezone) {
        updateTimezone.mutate(deviceTimezone);
      }
    };

    if (accountTimezone !== undefined) syncIfChanged();

    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') syncIfChanged();
    });
    return () => subscription.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountTimezone]);
}
