import { Link, Stack } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { theme } from '@/constants/theme';

// Rendered for any unmatched route — e.g. a stale or malformed deep link — so a
// bad path degrades gracefully instead of white-screening.
export default function NotFound() {
  return (
    <>
      <Stack.Screen options={{ title: 'Not found' }} />
      <SafeAreaView style={styles.safe}>
        <View style={styles.container}>
          <Text style={styles.title}>This screen doesn’t exist.</Text>
          <Link href="/" style={styles.link}>
            <Text style={styles.linkText}>Go to Meroa</Text>
          </Link>
        </View>
      </SafeAreaView>
    </>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 32 },
  title: { color: theme.text, fontSize: 18, fontWeight: '600' },
  link: { paddingVertical: 8 },
  linkText: { color: theme.blue, fontSize: 15, fontWeight: '600' },
});
