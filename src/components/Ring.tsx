import * as Haptics from 'expo-haptics';
import { useEffect, useRef } from 'react';
import { Text, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import Animated, {
  Easing,
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { theme } from '@/constants/theme';

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

// The celebration only fires on the CROSSING into 100 — not on being at 100.
// Otherwise the ring would throb every time you opened the tab on a day you'd
// already finished, which is nagging, not rewarding. `pulse` rests at 1 (fully
// faded out) and is reset to 0 to replay.
const REST = 1;

export function Ring({
  value,
  size = 44,
  stroke = 4,
  label,
  celebrate = false,
}: {
  value: number;
  size?: number;
  stroke?: number;
  label?: string;
  // Opt-in, and the caller must hold it FALSE while `value` is still a
  // placeholder — an unloaded list reads as 0%, and 0 → 100 on first paint is
  // indistinguishable from actually finishing the day. Also false while the
  // screen is off-view, or a task completed from Chat would buzz an invisible
  // ring on a tab kept mounted behind it.
  celebrate?: boolean;
}) {
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const progress = useSharedValue(value);

  const pulse = useSharedValue(REST);
  // Seeded with the first value, so a ring that mounts ALREADY complete counts
  // as "was at 100" and stays quiet.
  const previous = useRef(value);
  // A crossing needs BOTH ends of it to be trustworthy. `celebrate` flipping
  // true is itself the moment the value becomes real, so the render it flips on
  // can't be the render we fire on — only the one after.
  const wasEligible = useRef(false);

  useEffect(() => {
    progress.value = withTiming(value, { duration: 700, easing: Easing.out(Easing.cubic) });

    const justCompleted = wasEligible.current && previous.current < 100 && value >= 100;
    previous.current = value;
    wasEligible.current = celebrate;
    if (!justCompleted) return;

    // Let the ring finish closing before the glow lands — the reward should
    // read as a consequence of the bar filling, not a thing that happens next
    // to it.
    pulse.value = 0;
    pulse.value = withTiming(REST, { duration: 900, easing: Easing.out(Easing.cubic) });

    // Success, not Light — the tap that completed the task already fired its own
    // Light impact, so a second identical buzz would just read as a double-tap.
    // This is the day landing, and it should feel different from the tap.
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
  }, [value, celebrate, progress, pulse]);

  const animatedProps = useAnimatedProps(() => ({
    strokeDasharray: `${circumference} ${circumference}`,
    strokeDashoffset: circumference - (progress.value / 100) * circumference,
  }));

  // A halo blooming outward and fading — expands past the ring and dissolves.
  const halo = useAnimatedStyle(() => ({
    opacity: (1 - pulse.value) * 0.55,
    transform: [{ scale: 1 + pulse.value * 0.55 }],
  }));

  // A soft inner bloom, so the middle of the ring lifts too rather than the
  // glow reading as a detached expanding circle.
  const core = useAnimatedStyle(() => ({
    opacity: (1 - pulse.value) * 0.28,
    transform: [{ scale: 0.9 + pulse.value * 0.25 }],
  }));

  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Animated.View
        pointerEvents="none"
        style={[
          {
            position: 'absolute',
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: theme.blue,
          },
          core,
        ]}
      />
      <Animated.View
        pointerEvents="none"
        style={[
          {
            position: 'absolute',
            width: size,
            height: size,
            borderRadius: size / 2,
            borderWidth: stroke,
            borderColor: theme.blue,
            // iOS renders a genuine coloured glow; Android has no coloured
            // shadow, so the expanding ring above is what carries it there.
            shadowColor: theme.blue,
            shadowOpacity: 1,
            shadowRadius: size / 4,
            shadowOffset: { width: 0, height: 0 },
          },
          halo,
        ]}
      />
      <Svg width={size} height={size} style={{ position: 'absolute' }}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={theme.border} strokeWidth={stroke} fill="none" />
        <AnimatedCircle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={theme.blue}
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          animatedProps={animatedProps}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </Svg>
      <Text style={{ color: theme.text, fontWeight: '700', fontSize: size / 3.8 }}>
        {label ?? `${value}%`}
      </Text>
    </View>
  );
}
