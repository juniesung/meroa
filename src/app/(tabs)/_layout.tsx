import { BlurView } from 'expo-blur';
import { Tabs } from 'expo-router';
import { Platform, StyleSheet, type ColorValue } from 'react-native';
import Animated, { useAnimatedStyle, withSpring } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon, type IconName } from '@/components/Icon';
import { TAB_BAR_CONTENT_HEIGHT, theme } from '@/constants/theme';
import { useChatUnread } from '@/features/chat/useChatUnread';
import { useDailyCatchUp } from '@/features/chat/useDailyCatchUp';
import { usePushRegistration } from '@/features/profile/usePushRegistration';
import { useTimezoneSync } from '@/features/profile/useTimezoneSync';
import { useTaskReminderSync } from '@/features/tasks/useTaskReminderSync';
import { haptics } from '@/lib/haptics';

function makeIcon(name: IconName) {
  function TabIcon({ color, focused }: { color: ColorValue; focused: boolean }) {
    const animatedStyle = useAnimatedStyle(() => ({
      transform: [{ scale: withSpring(focused ? 1.1 : 1, { damping: 14, stiffness: 180 }) }],
    }));
    return (
      <Animated.View style={animatedStyle}>
        <Icon name={name} size={24} color={color as string} stroke={focused ? 2 : 1.7} />
      </Animated.View>
    );
  }
  return TabIcon;
}

export default function TabsLayout() {
  const insets = useSafeAreaInsets();
  useTaskReminderSync();
  useTimezoneSync();
  usePushRegistration();
  useDailyCatchUp();
  const chatUnread = useChatUnread();

  return (
    <Tabs
      screenListeners={{
        // A light Selection tick when you switch tabs — the icon already
        // spring-scales on focus; this gives the switch a matching bit of feel.
        tabPress: () => haptics.select(),
      }}
      screenOptions={{
        headerShown: false,
        // No 'shift' tab transition: on the New Architecture it intermittently
        // left the incoming screen's CONTENT black (tab bar fine, no recovery
        // on re-tap, only fixed by navigating away and back) — the animation
        // layer stranding the screen, not a render crash. Instant switch is safe.
        tabBarActiveTintColor: theme.blue,
        tabBarInactiveTintColor: theme.dim,
        tabBarLabelStyle: { fontSize: 10.5, fontWeight: '600' },
        tabBarStyle: {
          position: 'absolute',
          height: TAB_BAR_CONTENT_HEIGHT + insets.bottom,
          paddingTop: 8,
          paddingBottom: insets.bottom,
          borderTopColor: theme.border,
          backgroundColor: Platform.OS === 'ios' ? 'transparent' : 'rgba(3,5,7,0.95)',
          elevation: 0,
        },
        tabBarBackground:
          Platform.OS === 'ios'
            ? () => <BlurView intensity={40} tint="dark" style={StyleSheet.absoluteFill} />
            : undefined,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Chat',
          tabBarIcon: makeIcon('chat'),
          // A dot (empty-string badge) when Meroa has messaged since the user
          // last had Chat focused; cleared on focus by markChatRead. Sized down
          // to a dot (tiny font so the empty label adds no height).
          tabBarBadge: chatUnread ? '' : undefined,
          tabBarBadgeStyle: {
            backgroundColor: theme.blue,
            minWidth: 10,
            maxHeight: 10,
            borderRadius: 5,
            fontSize: 1,
            lineHeight: 10,
          },
        }}
      />
      <Tabs.Screen name="tasks" options={{ title: 'Tasks', tabBarIcon: makeIcon('tasks') }} />
      <Tabs.Screen name="goals" options={{ title: 'Goals', tabBarIcon: makeIcon('goals') }} />
      <Tabs.Screen name="you" options={{ title: 'You', tabBarIcon: makeIcon('you') }} />
    </Tabs>
  );
}
