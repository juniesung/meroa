import { useEffect } from 'react';
import { StyleSheet, View, type DimensionValue } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import { radii, theme } from '@/constants/theme';
import { useReduceMotion } from '@/lib/motion';

/**
 * One pulsing placeholder block. Compose these into layout-matched skeletons so
 * a loading screen reads as "the content, arriving" rather than a lone spinner.
 * Reduce-motion holds it at a flat dim instead of pulsing.
 */
export function SkeletonBlock({
  width = '100%',
  height,
  radius = radii.card,
  align,
}: {
  width?: DimensionValue;
  height: number;
  radius?: number;
  align?: 'flex-start' | 'flex-end';
}) {
  const opacity = useSharedValue(0.45);
  const reduceMotion = useReduceMotion();

  useEffect(() => {
    if (reduceMotion) {
      opacity.value = 0.4;
      return;
    }
    opacity.value = withRepeat(
      withSequence(
        withTiming(0.85, { duration: 750, easing: Easing.inOut(Easing.ease) }),
        withTiming(0.4, { duration: 750, easing: Easing.inOut(Easing.ease) }),
      ),
      -1,
    );
  }, [opacity, reduceMotion]);

  const animatedStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));

  return (
    <Animated.View
      style={[{ width, height, borderRadius: radius, alignSelf: align }, styles.block, animatedStyle]}
    />
  );
}

/** Chat placeholder — a few alternating bubbles. */
export function ChatSkeleton() {
  const rows: { width: DimensionValue; align: 'flex-start' | 'flex-end' }[] = [
    { width: '58%', align: 'flex-start' },
    { width: '44%', align: 'flex-end' },
    { width: '72%', align: 'flex-start' },
    { width: '36%', align: 'flex-end' },
  ];
  return (
    <View style={styles.chat}>
      {rows.map((r, i) => (
        <SkeletonBlock key={i} width={r.width} height={40} radius={radii.bubble} align={r.align} />
      ))}
    </View>
  );
}

/** Tasks placeholder — three card-height rows. */
export function TaskListSkeleton() {
  return (
    <View style={styles.list}>
      {[0, 1, 2].map((i) => (
        <SkeletonBlock key={i} height={72} />
      ))}
    </View>
  );
}

/** Goals placeholder — two goal-card-height rows (the header card renders for real above). */
export function GoalListSkeleton() {
  return (
    <View style={styles.goalList}>
      {[0, 1].map((i) => (
        <SkeletonBlock key={i} height={84} />
      ))}
    </View>
  );
}

/** Generic list placeholder — a few card rows. For Memories and Archived, whose
 *  header renders for real above this. */
export function ListSkeleton() {
  return (
    <View style={styles.padList}>
      {[0, 1, 2, 3].map((i) => (
        <SkeletonBlock key={i} height={64} />
      ))}
    </View>
  );
}

/** Detail placeholder — a hero block, a section label, then a few rows. Used by
 *  the goal detail screen while its data loads (was a lone spinner on near-black). */
export function DetailSkeleton() {
  return (
    <View style={styles.detail}>
      <SkeletonBlock height={116} />
      <SkeletonBlock width="45%" height={16} radius={6} />
      {[0, 1, 2].map((i) => (
        <SkeletonBlock key={i} height={52} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  block: { backgroundColor: theme.card2 },
  chat: { padding: 14, gap: 12 },
  list: { gap: 10, marginTop: 20 },
  goalList: { gap: 12 },
  padList: { padding: 16, gap: 10 },
  detail: { padding: 20, gap: 14 },
});
