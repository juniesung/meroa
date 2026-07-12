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
// How far a touch has to travel horizontally before it counts as a swipe
// attempt — deliberately smaller than the pan gesture's own activeOffsetX
// (10) so a short/slow swipe that never crosses that activation threshold
// still gets caught by the guard below, instead of silently falling
// through as a tap.
const DRAG_INTENT_THRESHOLD = 4;

/**
 * Swipe a row left to reveal a Delete button — the app-wide way to remove a
 * task. `children` is a render function that receives `guardPress`: every
 * interactive callback the row's own content invokes (complete, edit,
 * counter +/-, timer, ...) must be wrapped in it. A plain RN `Pressable`
 * nested inside this component's `GestureDetector` doesn't participate in
 * the pan gesture's own arena, so a swipe that falls short of activeOffsetX
 * — or a plain tap anywhere on a row that's already swiped open — can
 * otherwise still land as a real tap on the content underneath and silently
 * fire the wrong action (observed live: swiping to delete a task instead
 * marked it complete; swiping a repeating task instead opened its edit
 * sheet). guardPress swallows both cases: it drops the call if this touch
 * had any drag intent, and closes the row instead of firing through it if
 * the row was already open.
 */
export function SwipeToDelete({
  children,
  onDelete,
}: {
  children: (guardPress: <T extends (...args: any[]) => void>(fn: T) => T) => ReactNode;
  onDelete: () => void;
}) {
  const translateX = useSharedValue(0);
  const startX = useSharedValue(0);
  const [open, setOpen] = useState(false);
  // A Reanimated shared value, not a React ref — it's written from inside
  // the pan gesture's worklets (UI thread) and read from guardPress (JS
  // thread, in a plain event-handler call, never during render), which is
  // exactly what shared values are for; a ref written via runOnJS from a
  // worklet trips the React Compiler's "may read a ref during render"
  // check, since it can't see through runOnJS to know the write only ever
  // happens in response to a real touch event.
  const hadDragIntent = useSharedValue(false);

  const close = () => {
    translateX.value = withTiming(0, { duration: 180 });
    setOpen(false);
  };

  const pan = Gesture.Pan()
    .activeOffsetX([-10, 10])
    .failOffsetY([-15, 15])
    .onTouchesDown((e) => {
      startX.value = e.allTouches[0]?.absoluteX ?? 0;
      hadDragIntent.value = false;
    })
    .onTouchesMove((e) => {
      const x = e.allTouches[0]?.absoluteX;
      if (x === undefined) return;
      if (Math.abs(x - startX.value) > DRAG_INTENT_THRESHOLD) {
        hadDragIntent.value = true;
      }
    })
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

  function guardPress<T extends (...args: any[]) => void>(fn: T): T {
    return ((...args: any[]) => {
      const dragged = hadDragIntent.value;
      hadDragIntent.value = false;
      if (dragged) return;
      if (open) {
        close();
        return;
      }
      fn(...args);
    }) as T;
  }

  return (
    <View style={styles.root}>
      <View style={styles.deleteBackdrop}>
        <Pressable onPress={handleDelete} style={styles.deleteButton} hitSlop={4}>
          <Icon name="trash" size={18} color="#fff" stroke={2} />
          <Text style={styles.deleteText}>Delete</Text>
        </Pressable>
      </View>
      <GestureDetector gesture={pan}>
        <Animated.View style={cardStyle}>{children(guardPress)}</Animated.View>
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
