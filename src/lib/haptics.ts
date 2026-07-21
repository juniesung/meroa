import * as Haptics from 'expo-haptics';

/**
 * Semantic haptics wrapper. Match the weight to the action:
 *  - `tap`     — a routine press (send, open, primary button). Light impact.
 *  - `select`  — a value changed by the tap (counter ±, tab switch, timer start/stop). Selection.
 *  - `success` — a real-world thing completed (task done, goal logged, day 100%). Notification success.
 *  - `warning` — a destructive/undoable action confirmed (delete, remove). Notification warning.
 *
 * Haptics no-op in the simulator (and when the device has them disabled), so every
 * call swallows its rejection — never wrap a call site in its own try/catch.
 */
export const haptics = {
  tap: () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {}),
  select: () => Haptics.selectionAsync().catch(() => {}),
  success: () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {}),
  warning: () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {}),
};
