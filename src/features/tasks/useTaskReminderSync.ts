import { useEffect } from 'react';
import { AppState } from 'react-native';

import { useMe } from '@/features/profile/queries';
import { syncTaskReminders } from '@/lib/notifications';
import { useTasks } from './queries';

/**
 * Keeps scheduled local notifications in sync with the current task list —
 * resyncs whenever the tasks query settles (create/edit/complete/postpone/
 * delete all funnel through it) and whenever the app returns to the
 * foreground, so a reminder scheduled while backgrounded still gets cleared
 * if the task was completed elsewhere in the meantime.
 */
export function useTaskReminderSync() {
  const { data: tasks } = useTasks();
  const { data: me } = useMe();
  const enabled = me?.user.prefs.proactiveCheckins === true;

  useEffect(() => {
    if (!tasks) return;
    void syncTaskReminders(tasks, enabled);
  }, [tasks, enabled]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active' && tasks) void syncTaskReminders(tasks, enabled);
    });
    return () => subscription.remove();
  }, [tasks, enabled]);
}
