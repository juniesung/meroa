import { useEffect } from 'react';
import { View } from 'react-native';
import Svg, { Circle, Defs, LinearGradient, Path, Stop } from 'react-native-svg';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import { Icon } from './Icon';
import { theme } from '@/constants/theme';

export type MeroaMood = 'idle' | 'warm' | 'deflated';

// mascot-lite (docs/goals-redesign-plan.md §1): idle soft pulse, a warmer
// glow + small flame once a streak takes hold (>=3 days), visibly deflated
// right after a fresh break — drama in the *visual* is fine (user OK'd it),
// the copy anywhere near it stays warm and matter-of-fact regardless.
export function MeroaMark({
  size = 28,
  glow = false,
  mood,
}: {
  size?: number;
  glow?: boolean;
  mood?: MeroaMood;
}) {
  const pulse = useSharedValue(1);

  useEffect(() => {
    if (mood === 'idle') {
      pulse.value = withRepeat(
        withSequence(
          withTiming(1.06, { duration: 1400, easing: Easing.inOut(Easing.sin) }),
          withTiming(1, { duration: 1400, easing: Easing.inOut(Easing.sin) }),
        ),
        -1,
      );
    } else {
      pulse.value = withTiming(1, { duration: 300 });
    }
  }, [mood, pulse]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: pulse.value }, { rotate: mood === 'deflated' ? '4deg' : '0deg' }],
  }));

  const isWarm = mood === 'warm';
  const isDeflated = mood === 'deflated';
  const showGlow = glow || isWarm;

  return (
    <Animated.View style={animatedStyle}>
      <View
        style={[
          showGlow
            ? {
                shadowColor: isWarm ? theme.blue : '#0A84FF',
                shadowOpacity: isWarm ? 0.75 : 0.55,
                shadowRadius: isWarm ? 14 : 10,
                shadowOffset: { width: 0, height: 0 },
              }
            : undefined,
          { opacity: isDeflated ? 0.55 : 1 },
        ]}
      >
        <Svg width={size} height={size} viewBox="0 0 64 64">
          <Defs>
            <LinearGradient id="meroaMarkGradient" x1="0" y1="0" x2="1" y2="1">
              <Stop offset="0%" stopColor={isDeflated ? '#6B7684' : '#5AB0FF'} />
              <Stop offset="100%" stopColor={isDeflated ? '#3A4250' : '#0A6DF0'} />
            </LinearGradient>
          </Defs>
          <Path
            d="M10 12 C10 10 12 8 14 8 C17 8 19 10 20 13 L26 34 C27 37 29 37 30 34 L36 13 C37 10 39 8 42 8 C44 8 46 10 46 12 L46 40 C46 46 42 50 36 50 L34 50 L30 56 L28 50 L20 50 C14 50 10 46 10 40 Z"
            fill="url(#meroaMarkGradient)"
          />
          <Circle cx="24" cy="42" r="1.6" fill="#0A2540" />
          <Circle cx="28" cy="42" r="1.6" fill="#0A2540" />
          <Circle cx="32" cy="42" r="1.6" fill="#0A2540" />
        </Svg>
      </View>
      {isWarm && (
        <View style={{ position: 'absolute', right: -4, top: -4 }}>
          <Icon name="flame" size={Math.max(12, size * 0.4)} color={theme.blue} stroke={2.2} />
        </View>
      )}
    </Animated.View>
  );
}
