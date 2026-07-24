import * as Haptics from 'expo-haptics';
import { useEffect } from 'react';
import { type LayoutChangeEvent, Pressable, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { radii, theme } from '@/constants/theme';
import { TONE_EXAMPLE_PROMPT, TONE_MAX, TONE_MIN, TONE_STOPS, toneExample, toneLabel } from './tone';

const THUMB = 28;
const TRACK_H = 6;

// The warmth↔edge tone control. A draggable thumb snaps to one of five notches
// on release; each notch is also directly tappable. Built on gesture-handler +
// reanimated (both already deps) so it needs no new native module — the app's
// current dev build runs it as-is.
export function ToneSlider({
  value,
  onChange,
  trackWidth,
  onTrackLayout,
}: {
  value: number;
  onChange: (level: number) => void;
  // Measured width is lifted to the parent so it survives this component's own
  // re-renders during a drag; parent stores it in state and passes it back.
  trackWidth: number;
  onTrackLayout: (w: number) => void;
}) {
  const usable = Math.max(0, trackWidth - THUMB);
  const stepW = usable / (TONE_MAX - TONE_MIN);

  // `pos` (thumb x, in px) is the SINGLE source of truth for the thumb — it's
  // snapped to the target notch on the UI thread the instant the drag ends, so
  // it never depends on React re-rendering with the new value. The old approach
  // (deriving the resting spot from the `value` prop) briefly read the STALE
  // value on release and flashed the thumb back to the previous notch for a
  // frame before it moved to the new one — the "ghost circle" bug.
  const pos = useSharedValue(0);
  const startPos = useSharedValue(0);
  const dragging = useSharedValue(false);

  // Pin the thumb to the current value whenever we're NOT dragging — covers
  // first layout (trackWidth arrives) and external/tap changes. During a drag
  // the gesture owns `pos`, so this leaves it alone.
  useEffect(() => {
    if (!dragging.value) {
      pos.value = withTiming(value * stepW, { duration: 150 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, stepW]);

  const commit = (level: number) => {
    const clamped = Math.min(TONE_MAX, Math.max(TONE_MIN, level));
    Haptics.selectionAsync();
    if (clamped !== value) onChange(clamped);
  };

  const pan = Gesture.Pan()
    .onBegin(() => {
      // eslint-disable-next-line react-hooks/immutability -- reanimated shared value, not React state
      dragging.value = true;
      startPos.value = pos.value;
    })
    .onUpdate((e) => {
      // eslint-disable-next-line react-hooks/immutability -- reanimated shared value, not React state
      pos.value = Math.min(usable, Math.max(0, startPos.value + e.translationX));
    })
    .onEnd(() => {
      const level = stepW > 0 ? Math.round(pos.value / stepW) : value;
      // Settle to the snapped notch right here on the UI thread — no stale-value
      // frame, so no ghost flash at the previous position.
      // eslint-disable-next-line react-hooks/immutability -- reanimated shared value, not React state
      pos.value = withTiming(level * stepW, { duration: 120 });
      // eslint-disable-next-line react-hooks/immutability -- reanimated shared value, not React state
      dragging.value = false;
      runOnJS(commit)(level);
    });

  const thumbStyle = useAnimatedStyle(() => ({ transform: [{ translateX: pos.value }] }));
  const fillStyle = useAnimatedStyle(() => ({ width: pos.value + THUMB / 2 }));

  return (
    <View>
      <Text style={styles.currentLabel}>{toneLabel(value)}</Text>

      {/* Live example: the same message answered in the current tone, so moving
          the slider shows the voice instead of describing it. */}
      <View style={styles.preview}>
        <View style={styles.userBubble}>
          <Text style={styles.userText}>{TONE_EXAMPLE_PROMPT}</Text>
        </View>
        <View style={styles.aiBubble}>
          <Text style={styles.aiText}>{toneExample(value)}</Text>
        </View>
      </View>

      <View
        style={styles.track}
        onLayout={(e: LayoutChangeEvent) => onTrackLayout(e.nativeEvent.layout.width)}
      >
        <View style={styles.trackBase} />
        <Animated.View style={[styles.trackFill, fillStyle]} />
        {TONE_STOPS.map((s) => (
          <Pressable
            key={s.level}
            hitSlop={10}
            style={[styles.notchHit, { left: s.level * stepW }]}
            onPress={() => commit(s.level)}
          >
            <View style={[styles.notch, value === s.level && styles.notchActive]} />
          </Pressable>
        ))}
        <GestureDetector gesture={pan}>
          <Animated.View style={[styles.thumb, thumbStyle]} />
        </GestureDetector>
      </View>

      <View style={styles.endsRow}>
        <Text style={styles.endLabel}>Warmest</Text>
        <Text style={styles.endLabel}>Edgiest</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  currentLabel: { color: theme.blue, fontSize: 16, fontWeight: '700', textAlign: 'center' },
  preview: { marginTop: 14, marginBottom: 24, minHeight: 96, justifyContent: 'center' },
  userBubble: {
    alignSelf: 'flex-end',
    maxWidth: '82%',
    backgroundColor: theme.blueDeep,
    borderRadius: radii.bubble,
    borderBottomRightRadius: radii.bubbleTail,
    paddingHorizontal: 13,
    paddingVertical: 8,
    marginBottom: 6,
  },
  userText: { color: '#fff', fontSize: 14, lineHeight: 19 },
  aiBubble: {
    alignSelf: 'flex-start',
    maxWidth: '86%',
    backgroundColor: theme.bubbleAI,
    borderRadius: radii.bubble,
    borderBottomLeftRadius: radii.bubbleTail,
    paddingHorizontal: 13,
    paddingVertical: 8,
  },
  aiText: { color: theme.text, fontSize: 14, lineHeight: 19 },
  track: { height: THUMB, justifyContent: 'center' },
  trackBase: {
    position: 'absolute',
    left: THUMB / 2,
    right: THUMB / 2,
    height: TRACK_H,
    borderRadius: radii.pill,
    backgroundColor: theme.card2,
  },
  trackFill: {
    position: 'absolute',
    left: 0,
    height: TRACK_H,
    borderRadius: radii.pill,
    backgroundColor: theme.blue,
  },
  notchHit: {
    position: 'absolute',
    width: THUMB,
    height: THUMB,
    alignItems: 'center',
    justifyContent: 'center',
  },
  notch: { width: 8, height: 8, borderRadius: radii.pill, backgroundColor: theme.borderStrong },
  notchActive: { backgroundColor: theme.text },
  thumb: {
    width: THUMB,
    height: THUMB,
    borderRadius: radii.pill,
    backgroundColor: theme.blue,
    // No outline — a solid blue knob. A soft drop shadow gives it depth so it
    // still reads as a raised control where it sits over the blue track fill.
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  endsRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 12 },
  endLabel: { color: theme.faint, fontSize: 12, fontWeight: '600' },
});
