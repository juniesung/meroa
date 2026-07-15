import { useEffect, type ReactNode } from 'react';
import {
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { radii, theme } from '@/constants/theme';

// Exported so callers chaining one sheet's close into another sheet's open
// (e.g. a menu sheet handing off to the sheet it opened) wait exactly as
// long as the close animation actually takes, instead of duplicating 220
// as an unexplained magic number elsewhere.
export const ANIM_DURATION = 220;
const OFFSCREEN_Y = 700;
const DRAG_DISMISS_THRESHOLD = 100;
const DRAG_DISMISS_VELOCITY = 800;

/**
 * A bottom sheet used for quick create/edit/log flows. Always dismiss via
 * the `onClose` this component is given (backdrop tap, swipe-down, or a
 * button calling it) rather than flipping `visible` to false directly from
 * elsewhere — that skips the close animation, since Modal unmounts the
 * instant `visible` goes false.
 */
export function Sheet({
  visible,
  onClose,
  title,
  children,
}: {
  visible: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const translateY = useSharedValue(OFFSCREEN_Y);
  const backdropOpacity = useSharedValue(0);

  // Shared values are ref-stable and mutated again later (close(), the pan
  // gesture) — deliberately left out of the deps array, same as the
  // TypingDots loop in the chat screen.
  useEffect(() => {
    if (visible) {
      translateY.value = withTiming(0, {
        duration: ANIM_DURATION,
        easing: Easing.out(Easing.cubic),
      });
      backdropOpacity.value = withTiming(1, { duration: ANIM_DURATION });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const close = () => {
    Keyboard.dismiss();
    // eslint-disable-next-line react-hooks/immutability -- reanimated shared value, not React state
    backdropOpacity.value = withTiming(0, { duration: ANIM_DURATION });
    // eslint-disable-next-line react-hooks/immutability -- reanimated shared value, not React state
    translateY.value = withTiming(
      OFFSCREEN_Y,
      { duration: ANIM_DURATION, easing: Easing.in(Easing.cubic) },
      (finished) => {
        if (finished) runOnJS(onClose)();
      },
    );
  };

  const pan = Gesture.Pan()
    .onUpdate((e) => {
      // eslint-disable-next-line react-hooks/immutability -- reanimated shared value, not React state
      if (e.translationY > 0) translateY.value = e.translationY;
    })
    .onEnd((e) => {
      if (e.translationY > DRAG_DISMISS_THRESHOLD || e.velocityY > DRAG_DISMISS_VELOCITY) {
        runOnJS(close)();
      } else {
        // eslint-disable-next-line react-hooks/immutability -- reanimated shared value, not React state
        translateY.value = withTiming(0, { duration: 180 });
      }
    });

  const sheetStyle = useAnimatedStyle(() => ({ transform: [{ translateY: translateY.value }] }));
  const backdropStyle = useAnimatedStyle(() => ({ opacity: backdropOpacity.value }));

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      onRequestClose={close}
      statusBarTranslucent
    >
      <View style={styles.root}>
        <Pressable style={StyleSheet.absoluteFill} onPress={close}>
          <Animated.View style={[styles.backdrop, backdropStyle]} />
        </Pressable>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.avoidingView}
          pointerEvents="box-none"
        >
          <Animated.View style={[styles.sheet, { paddingBottom: insets.bottom + 20 }, sheetStyle]}>
            <GestureDetector gesture={pan}>
              <View>
                <View style={styles.handle} />
                {title && <Text style={styles.title}>{title}</Text>}
              </View>
            </GestureDetector>
            {children}
          </Animated.View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)' },
  avoidingView: { justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: theme.card,
    borderTopLeftRadius: radii.section,
    borderTopRightRadius: radii.section,
    borderWidth: 1,
    borderColor: theme.borderStrong,
    borderBottomWidth: 0,
    paddingHorizontal: 20,
    paddingTop: 10,
    maxHeight: '86%',
  },
  handle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 999,
    backgroundColor: theme.faint,
    marginBottom: 14,
  },
  title: { color: theme.text, fontSize: 18, fontWeight: '700', marginBottom: 16 },
});
