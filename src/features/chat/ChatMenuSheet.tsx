import { StyleSheet, Text, View } from 'react-native';

import { Row } from '@/components/Row';
import { Sheet } from '@/components/Sheet';
import { theme } from '@/constants/theme';

export function ChatMenuSheet({
  visible,
  onClose,
  toneName,
  onSelectTone,
  onSelectMemory,
}: {
  visible: boolean;
  onClose: () => void;
  toneName: string;
  onSelectTone: () => void;
  onSelectMemory: () => void;
}) {
  return (
    <Sheet visible={visible} onClose={onClose}>
      <View style={styles.card}>
        <Row
          icon="sparkle"
          label="Tone"
          right={<Text style={styles.hint}>{toneName}</Text>}
          onPress={onSelectTone}
        />
        <Row icon="book" label="Memory" onPress={onSelectMemory} />
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: theme.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: theme.border,
    overflow: 'hidden',
  },
  hint: { color: theme.dim, fontSize: 14, marginRight: 6 },
});
