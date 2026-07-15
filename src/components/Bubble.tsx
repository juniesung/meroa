import { LinearGradient } from 'expo-linear-gradient';
import { StyleSheet, Text, View } from 'react-native';

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
  children,
}: {
  from: 'me' | 'ai';
  isFirstInGroup?: boolean;
  isLastInGroup?: boolean;
  children: React.ReactNode;
}) {
  const me = from === 'me';
  const rowStyle = {
    flexDirection: 'row' as const,
    justifyContent: me ? ('flex-end' as const) : ('flex-start' as const),
    marginTop: isFirstInGroup ? 3 : 1,
    marginBottom: isLastInGroup ? 3 : 1,
  };
  return (
    <View style={rowStyle}>
      {me ? (
        <LinearGradient
          colors={theme.gradient}
          start={{ x: 0, y: 0 }}
          end={{ x: 0, y: 1 }}
          style={[styles.bubble, styles.bubbleMeShadow, isLastInGroup && styles.bubbleMeTail]}
        >
          <Text style={styles.bubbleText}>{children}</Text>
        </LinearGradient>
      ) : (
        <View style={[styles.bubble, styles.bubbleAI, isLastInGroup && styles.bubbleAITail]}>
          <Text style={styles.bubbleText}>{children}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  bubble: {
    maxWidth: '78%',
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: radii.bubble,
  },
  bubbleMeShadow: {
    shadowColor: theme.blue,
    shadowOpacity: 0.45,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
  },
  bubbleMeTail: { borderBottomRightRadius: radii.bubbleTail },
  bubbleAI: { backgroundColor: theme.bubbleAI },
  bubbleAITail: { borderBottomLeftRadius: radii.bubbleTail },
  bubbleText: { color: '#fff', fontSize: 15, lineHeight: 20 },
});
