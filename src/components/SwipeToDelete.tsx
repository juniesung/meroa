import * as Haptics from 'expo-haptics';
import { useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { radii, theme } from '@/constants/theme';
import { Icon } from './Icon';

const DELETE_WIDTH = 88;
const OPEN_THRESHOLD = DELETE_WIDTH / 2;
const FLING_VELOCITY = 600;

/** Swipe a row left to reveal a Delete button — the app-wide way to remove a task. */
export function SwipeToDelete({ children, onDelete }: { children: ReactNode; onDelete: () => void }) {
  const translateX = useSharedValue(0);
  const [open, setOpen] = useState(false);

  const close = () => {
    translateX.value = withTiming(0, { duration: 180 });
    setOpen(false);
  };

  const pan = Gesture.Pan()
    .activeOffsetX([-10, 10])
    .onUpdate((e) => {
      const base = open ? -DELETE_WIDTH : 0;
      translateX.value = Math.min(0, Math.max(-DELETE_WIDTH, base + e.translationX));
    })
    .onEnd((e) => {
      const shouldOpen = translateX.value < -OPEN_THRESHOLD || e.velocityX < -FLING_VELOCITY;
      translateX.value = withTiming(shouldOpen ? -DELETE_WIDTH : 0, { duration: 180 });
      runOnJS(setOpen)(shouldOpen);
    });

  const cardStyle = useAnimatedStyle(() => ({ transform: [{ translateX: translateX.value }] }));

  const handleDelete = () => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
    close();
    onDelete();
  };

  return (
    <View style={styles.root}>
      <View style={styles.deleteBackdrop}>
        <Pressable onPress={handleDelete} style={styles.deleteButton} hitSlop={4}>
          <Icon name="trash" size={18} color="#fff" stroke={2} />
          <Text style={styles.deleteText}>Delete</Text>
        </Pressable>
      </View>
      <GestureDetector gesture={pan}>
        <Animated.View style={cardStyle}>{children}</Animated.View>
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { position: 'relative' },
  deleteBackdrop: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    right: 0,
    width: DELETE_WIDTH,
    backgroundColor: theme.danger,
    borderRadius: radii.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  deleteButton: { alignItems: 'center', gap: 3 },
  deleteText: { color: '#fff', fontSize: 11, fontWeight: '700' },
});
