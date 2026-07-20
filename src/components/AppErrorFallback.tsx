import type { ErrorBoundaryProps } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { MeroaMark } from '@/components/MeroaMark';
import { theme } from '@/constants/theme';

// Rendered by Expo Router's root ErrorBoundary (exported from app/_layout.tsx)
// when a render throws — degrades to a recoverable screen instead of a white
// screen. `retry` re-mounts the failed segment.
export function AppErrorFallback({ error, retry }: ErrorBoundaryProps) {
  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.container}>
        <MeroaMark size={56} />
        <Text style={styles.title}>Something went wrong</Text>
        <Text style={styles.message}>{error.message || 'An unexpected error occurred.'}</Text>
        <Pressable onPress={retry} style={styles.button} hitSlop={10}>
          <Text style={styles.buttonText}>Try again</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14, padding: 32 },
  title: { color: theme.text, fontSize: 20, fontWeight: '700', marginTop: 8 },
  message: { color: theme.dim, fontSize: 14, textAlign: 'center', lineHeight: 20 },
  button: {
    marginTop: 10,
    paddingHorizontal: 22,
    paddingVertical: 11,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: theme.borderStrong,
    backgroundColor: theme.card,
  },
  buttonText: { color: theme.blue, fontSize: 15, fontWeight: '600' },
});
