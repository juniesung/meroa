import { Pressable } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

export const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export function useTapFeedback(scaleTo = 0.96) {
  const pressed = useSharedValue(0);
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: withTiming(pressed.value ? scaleTo : 1, { duration: pressed.value ? 90 : 150 }) }],
    opacity: withTiming(pressed.value ? 0.85 : 1, { duration: 120 }),
  }));
  return {
    animatedStyle,
    onPressIn: () => {
      pressed.value = 1;
    },
    onPressOut: () => {
      pressed.value = 0;
    },
  };
}

/**
 * A soft blue glow around the edge of a tappable row (list-style rows read
 * better with a highlight than a scale/shrink) — pair with an absolutely
 * positioned `<Animated.View pointerEvents="none" style={[rimStyle, highlightStyle]} />`
 * sized to the row, layered under its content.
 */
export function useRimHighlight() {
  const pressed = useSharedValue(0);
  const highlightStyle = useAnimatedStyle(() => ({
    opacity: withTiming(pressed.value, { duration: pressed.value ? 80 : 220 }),
  }));
  return {
    highlightStyle,
    onPressIn: () => {
      pressed.value = 1;
    },
    onPressOut: () => {
      pressed.value = 0;
    },
  };
}
