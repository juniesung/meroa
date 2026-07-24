import { LinearGradient } from 'expo-linear-gradient';
import { useEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import { theme } from '@/constants/theme';
import { useReduceMotion } from '@/lib/motion';

export function Progress({ value, color }: { value: number; color?: string }) {
  const clamped = Math.min(100, Math.max(0, value));
  const progress = useSharedValue(clamped);
  const glow = useSharedValue(0);
  // Seeded from the mount value so a bar that's ALREADY full stays quiet — the
  // glow marks the moment of filling, not the state of being full.
  const wasComplete = useRef(clamped >= 100);
  const reduceMotion = useReduceMotion();

  useEffect(() => {
    progress.value = withTiming(clamped, { duration: 700, easing: Easing.out(Easing.cubic) });
    const justFilled = !wasComplete.current && clamped >= 100;
    wasComplete.current = clamped >= 100;
    if (justFilled && !reduceMotion) {
      // A brief blue bloom around the bar as it tops out — no haptic here (the
      // completing action fires its own from the mutation/ring layer).
      glow.value = withSequence(
        withTiming(1, { duration: 240, easing: Easing.out(Easing.cubic) }),
        withTiming(0, { duration: 620, easing: Easing.out(Easing.cubic) }),
      );
    }
  }, [clamped, progress, glow, reduceMotion]);

  const animatedStyle = useAnimatedStyle(() => ({ width: `${progress.value}%` }));
  const glowStyle = useAnimatedStyle(() => ({ opacity: glow.value }));

  // Default is the blue gradient (every existing caller). An explicit `color`
  // renders a solid bar in that hue and recolors the fill glow to match —
  // used by achievement badges so the bar matches the family outline.
  const gradient: readonly [string, string] = color ? [color, color] : [theme.blue, theme.blueLight];

  return (
    <View style={styles.wrap}>
      {/* Sits behind the track so only its shadow haloes past the filled bar
          (iOS); on Android the coloured shadow no-ops, same as Ring. */}
      <Animated.View
        pointerEvents="none"
        style={[styles.glow, color ? { backgroundColor: color, shadowColor: color } : null, glowStyle]}
      />
      <View style={styles.track}>
        <Animated.View style={[styles.fill, animatedStyle]}>
          <LinearGradient
            colors={gradient}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={StyleSheet.absoluteFill}
          />
        </Animated.View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'relative' },
  glow: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    height: 6,
    borderRadius: 999,
    backgroundColor: theme.blue,
    shadowColor: theme.blue,
    shadowOpacity: 0.9,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 0 },
  },
  track: {
    height: 6,
    borderRadius: 999,
    backgroundColor: theme.border,
    overflow: 'hidden',
  },
  fill: { height: '100%', borderRadius: 999 },
});
