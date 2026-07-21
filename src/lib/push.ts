import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { api } from './api/client';

// The EAS project id getExpoPushTokenAsync needs to mint a token. Absent until
// the app is set up on EAS (a dev-build prerequisite) — so this whole path
// gracefully no-ops in Expo Go / the simulator / a bare scaffold, and only does
// real work once a dev build with a configured project runs on a device.
function easProjectId(): string | undefined {
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined;
  return extra?.eas?.projectId ?? (Constants as { easConfig?: { projectId?: string } }).easConfig?.projectId;
}

/**
 * Captures this device's Expo push token and registers it with the server so
 * the re-engagement tick can reach it. Safe to call repeatedly (the server
 * upserts) and safe to call anywhere — it silently returns false rather than
 * throwing when push isn't available: on a simulator, without permission,
 * before the EAS project is configured, or in Expo Go. Real delivery needs a
 * dev build on a physical device.
 */
export async function registerForPushNotifications(): Promise<boolean> {
  try {
    if (!Device.isDevice) return false; // a simulator can't receive remote push
    const { status } = await Notifications.getPermissionsAsync();
    if (status !== 'granted') return false;
    const projectId = easProjectId();
    if (!projectId) return false;

    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
    if (!token) return false;

    await api.registerPushToken({
      token,
      platform: Platform.OS === 'android' ? 'android' : 'ios',
    });
    return true;
  } catch {
    // No dev build / offline / token service hiccup — a missed registration is
    // recoverable on the next app open, so never surface this.
    return false;
  }
}
