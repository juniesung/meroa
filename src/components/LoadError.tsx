import { Pressable, StyleSheet, Text, View } from 'react-native';

import { theme } from '@/constants/theme';

// A failed load must read differently from an empty list — otherwise "we
// couldn't reach the server" looks identical to "you have nothing yet", and the
// user has no way to retry. Generalizes the chat `status:'failed'` retry row
// that already works well.
export function LoadError({ onRetry, message }: { onRetry: () => void; message?: string }) {
  return (
    <View style={styles.container}>
      <Text style={styles.text}>{message ?? "Couldn't load this. Check your connection."}</Text>
      <Pressable onPress={onRetry} style={styles.retry} hitSlop={10}>
        <Text style={styles.retryText}>Try again</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { alignItems: 'center', marginTop: 60, paddingHorizontal: 24, gap: 14 },
  text: { color: theme.dim, fontSize: 14, textAlign: 'center', lineHeight: 20 },
  retry: {
    paddingHorizontal: 18,
    paddingVertical: 9,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: theme.borderStrong,
    backgroundColor: theme.card,
  },
  retryText: { color: theme.blue, fontSize: 14, fontWeight: '600' },
});
