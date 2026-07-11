import { LinearGradient } from 'expo-linear-gradient';
import { StyleSheet, Text, View } from 'react-native';

import { radii, theme } from '@/constants/theme';

export function Bubble({ from, children }: { from: 'me' | 'ai'; children: React.ReactNode }) {
  const me = from === 'me';
  return (
    <View style={{ flexDirection: 'row', justifyContent: me ? 'flex-end' : 'flex-start', marginVertical: 3 }}>
      {me ? (
        <LinearGradient
          colors={theme.gradient}
          start={{ x: 0, y: 0 }}
          end={{ x: 0, y: 1 }}
          style={[styles.bubble, styles.bubbleMe]}
        >
          <Text style={styles.bubbleText}>{children}</Text>
        </LinearGradient>
      ) : (
        <View style={[styles.bubble, styles.bubbleAI]}>
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
  bubbleMe: {
    borderBottomRightRadius: radii.bubbleTail,
    shadowColor: theme.blue,
    shadowOpacity: 0.45,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
  },
  bubbleAI: {
    backgroundColor: theme.bubbleAI,
    borderBottomLeftRadius: radii.bubbleTail,
  },
  bubbleText: { color: '#fff', fontSize: 15, lineHeight: 20 },
});
