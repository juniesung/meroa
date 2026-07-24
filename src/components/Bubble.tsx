import { LinearGradient } from 'expo-linear-gradient';
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { radii, theme } from '@/constants/theme';

/**
 * `isFirstInGroup`/`isLastInGroup` describe this bubble's place in a run of
 * consecutive same-sender texts (the iMessage "stack" — CLAUDE.md §5). Only
 * the last bubble in a stack gets the tightened tail corner; only the first
 * gets the full gap above it. Both default true, so a lone bubble (the
 * common case) renders exactly as before.
 */
export function Bubble({
  from,
  isFirstInGroup = true,
  isLastInGroup = true,
  onLongPress,
  children,
}: {
  from: 'me' | 'ai';
  isFirstInGroup?: boolean;
  isLastInGroup?: boolean;
  // When set, long-pressing the bubble surface fires this (used to report an
  // assistant reply). Scoped to the surface, not the full row, so a press in
  // the empty space beside a bubble does nothing.
  onLongPress?: () => void;
  children: React.ReactNode;
}) {
  const me = from === 'me';
  // A FIXED-PIXEL max width, not "78%". A percentage max width can't resolve
  // against a parent with no definite width — and AI-reportable bubbles are
  // wrapped in a Pressable (below) that has exactly that, which collapsed the
  // bubble to ~1 character and broke short words ("Bet." → "B" / "et" / ".")
  // across lines. A px cap resolves regardless of parent. 14px is the chat's
  // horizontal padding on each side.
  const { width } = useWindowDimensions();
  const maxBubbleWidth = (width - 28) * 0.78;
  const rowStyle = {
    flexDirection: 'row' as const,
    justifyContent: me ? ('flex-end' as const) : ('flex-start' as const),
    marginTop: isFirstInGroup ? 3 : 1,
    marginBottom: isLastInGroup ? 3 : 1,
  };
  // Both senders use a plain View to size the bubble — a View reliably
  // constrains its child Text to wrap at maxWidth. The blue "me" gradient is an
  // absolute-fill layer *behind* the text, NOT the sizing container: when the
  // gradient itself was the surface, it didn't propagate the maxWidth wrap
  // constraint to the Text, so long messages laid out full-width and got
  // clipped on the right instead of wrapping.
  const surface = (
    <View
      style={[
        styles.bubble,
        { maxWidth: maxBubbleWidth },
        me ? styles.bubbleMe : styles.bubbleAI,
        isLastInGroup && (me ? styles.bubbleMeTail : styles.bubbleAITail),
      ]}
    >
      {me && (
        <LinearGradient
          colors={theme.gradient}
          start={{ x: 0, y: 0 }}
          end={{ x: 0, y: 1 }}
          style={[styles.gradientFill, isLastInGroup && styles.bubbleMeTail]}
        />
      )}
      <Text style={styles.bubbleText}>{children}</Text>
    </View>
  );
  return (
    <View style={rowStyle}>
      {onLongPress ? (
        <Pressable onLongPress={onLongPress} delayLongPress={350}>
          {surface}
        </Pressable>
      ) : (
        surface
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  bubble: {
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: radii.bubble,
  },
  // Solid fallback under the gradient so the rounded shadow casts and any
  // sub-pixel edge reads as blue, never the page background.
  bubbleMe: {
    backgroundColor: theme.blueDeep,
    shadowColor: theme.blue,
    shadowOpacity: 0.45,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
  },
  bubbleAI: { backgroundColor: theme.bubbleAI },
  bubbleMeTail: { borderBottomRightRadius: radii.bubbleTail },
  bubbleAITail: { borderBottomLeftRadius: radii.bubbleTail },
  // Fills the bubble behind the text; borderRadius matches so the corners round.
  gradientFill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderRadius: radii.bubble },
  bubbleText: { color: '#fff', fontSize: 15, lineHeight: 20 },
});
