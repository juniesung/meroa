import * as Notifications from 'expo-notifications';

import type { QuietHours } from '@/features/profile/quiet-hours';
import { planReminders } from './reminder-schedule';
import type { ApiTask } from './api/types';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

export async function requestNotificationPermission(): Promise<boolean> {
  const { status: existing } = await Notifications.getPermissionsAsync();
  if (existing === 'granted') return true;
  const { status } = await Notifications.requestPermissionsAsync();
  return status === 'granted';
}

// Two independent effects (the tasks query settling, and the app foregrounding)
// can both call syncTaskReminders close together, and the function's cancel-all-
// then-reschedule sequence isn't safe to run concurrently with itself — an
// overlap can leave a notification double-scheduled. Chaining every call onto
// this queue forces them to run one at a time.
let syncQueue: Promise<void> = Promise.resolve();

export function syncTaskReminders(
  tasks: ApiTask[],
  enabled: boolean,
  quietHours: QuietHours,
): Promise<void> {
  const run = () => syncTaskRemindersNow(tasks, enabled, quietHours);
  const next = syncQueue.then(run, run);
  // Swallow so a failed sync doesn't permanently wedge the queue for every
  // call after it.
  syncQueue = next.catch(() => {});
  return next;
}

/**
 * Cancels every notification this app previously scheduled and reschedules from
 * the current task list. Cheap and simple given how few open tasks a person
 * realistically has, and it avoids drifting out of sync with edits/completions/
 * postpones. Called whenever the tasks query settles and on app foreground —
 * the latter is also what pushes the re-engagement nudge back out of reach for
 * an active user (see reminder-schedule.ts's planReminders). A no-op (after
 * clearing) when permission hasn't been granted. All the actual decisions —
 * which reminders, quiet-hours shifting, the recurring expansion, the nudge —
 * live in the pure planReminders(); this is only the expo I/O.
 */
async function syncTaskRemindersNow(
  tasks: ApiTask[],
  enabled: boolean,
  quietHours: QuietHours,
): Promise<void> {
  await Notifications.cancelAllScheduledNotificationsAsync();

  const { status } = await Notifications.getPermissionsAsync();
  if (status !== 'granted') return;

  const plan = planReminders({ tasks, enabled, quietHours, now: Date.now() });

  for (const item of plan) {
    await Notifications.scheduleNotificationAsync({
      content: { title: item.title, body: item.body, data: item.data },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: item.date },
    });
  }
}
