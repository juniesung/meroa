import { BlurView } from 'expo-blur';
import { Tabs } from 'expo-router';
import { Platform, StyleSheet, type ColorValue } from 'react-native';
import Animated, { useAnimatedStyle, withSpring } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon, type IconName } from '@/components/Icon';
import { TAB_BAR_CONTENT_HEIGHT, theme } from '@/constants/theme';
import { useTimezoneSync } from '@/features/profile/useTimezoneSync';
import { useTaskReminderSync } from '@/features/tasks/useTaskReminderSync';

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

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
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
      <Tabs.Screen name="index" options={{ title: 'Chat', tabBarIcon: makeIcon('chat') }} />
      <Tabs.Screen name="tasks" options={{ title: 'Tasks', tabBarIcon: makeIcon('tasks') }} />
      <Tabs.Screen name="tools" options={{ title: 'Tools', tabBarIcon: makeIcon('tools') }} />
      <Tabs.Screen name="you" options={{ title: 'You', tabBarIcon: makeIcon('you') }} />
    </Tabs>
  );
}
