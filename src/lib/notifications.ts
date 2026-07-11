import * as Notifications from 'expo-notifications';

import type { ApiTask, DurationConfig } from './api/types';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

// Anything due further out than this gets picked up by a later sync (the
// tasks query refreshes often enough) — scheduling isn't a set-and-forget
// calendar, so there's no need to look further ahead than a user will
// plausibly leave the app closed.
const REMINDER_WINDOW_DAYS = 7;

export async function requestNotificationPermission(): Promise<boolean> {
  const { status: existing } = await Notifications.getPermissionsAsync();
  if (existing === 'granted') return true;
  const { status } = await Notifications.requestPermissionsAsync();
  return status === 'granted';
}

function reminderBody(task: ApiTask): string {
  if (task.type === 'duration') {
    return `${task.title} — ${(task.config as DurationConfig).targetMinutes} min`;
  }
  return task.title;
}

// Two independent effects (the tasks query settling, and the app
// foregrounding) can both call syncTaskReminders close together, and the
// function's cancel-all-then-reschedule sequence isn't safe to run
// concurrently with itself — an overlap can leave a task double-scheduled.
// Chaining every call onto this queue forces them to run one at a time.
let syncQueue: Promise<void> = Promise.resolve();

export function syncTaskReminders(tasks: ApiTask[], enabled: boolean): Promise<void> {
  const run = () => syncTaskRemindersNow(tasks, enabled);
  const next = syncQueue.then(run, run);
  // Swallow so a failed sync doesn't permanently wedge the queue for every
  // call after it.
  syncQueue = next.catch(() => {});
  return next;
}

/**
 * Cancels every reminder this app previously scheduled and reschedules from
 * the current task list — cheap and simple given how few open, dueAt+reminder
 * tasks a person realistically has, and avoids drifting out of sync with
 * edits/completions/postpones. Called whenever the tasks query settles and
 * on app foreground. A no-op (after clearing) when permission hasn't been
 * granted; due-time reminders are additionally gated behind `enabled` so
 * disabling the check-in pref reliably silences those, while a running
 * timer's completion alert (below) is not proactive outreach — it's the
 * direct result of the user starting that timer — so it isn't gated by it.
 */
async function syncTaskRemindersNow(tasks: ApiTask[], enabled: boolean): Promise<void> {
  await Notifications.cancelAllScheduledNotificationsAsync();

  const { status } = await Notifications.getPermissionsAsync();
  if (status !== 'granted') return;

  const now = Date.now();

  for (const task of tasks) {
    if (task.type !== 'duration' || task.status !== 'open') continue;
    const config = task.config as DurationConfig;
    if (!config.runningSince) continue;

    const elapsedMs = now - new Date(config.runningSince).getTime();
    const remainingMs = (config.targetMinutes - config.loggedMinutes) * 60_000 - elapsedMs;
    if (remainingMs <= 0) continue;

    await Notifications.scheduleNotificationAsync({
      content: {
        title: 'Meroa',
        body: `${task.title} — timer's done.`,
        data: { taskId: task.id },
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: new Date(now + remainingMs),
      },
    });
  }

  if (!enabled) return;

  const windowEnd = now + REMINDER_WINDOW_DAYS * 24 * 60 * 60 * 1000;

  for (const task of tasks) {
    if (task.status !== 'open' || task.recurrence) continue;
    if (!(task.config as { reminder?: boolean }).reminder || !task.dueAt) continue;

    const dueAt = new Date(task.dueAt).getTime();
    if (dueAt <= now || dueAt > windowEnd) continue;

    await Notifications.scheduleNotificationAsync({
      content: { title: 'Meroa', body: reminderBody(task), data: { taskId: task.id } },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: new Date(dueAt) },
    });
  }
}
