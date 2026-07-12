import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { PrimaryButton } from '@/components/PrimaryButton';
import { Sheet } from '@/components/Sheet';
import { radii, theme } from '@/constants/theme';
import type { ApiGoal } from '@/lib/api/types';
import { useLogGoalEntry } from './queries';

// Remounted each time the sheet opens (the parent renders this only while
// `visible`, matching TaskFormSheet's pattern) so state always starts fresh.
// v1 goals have a fixed { amount, note? } entry shape — no field builder
// (docs/goals-redesign-plan.md §2.2).
function GoalEntryForm({ goal, onDone }: { goal: ApiGoal; onDone: () => void }) {
  const logEntry = useLogGoalEntry();
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const n = Number(amount);
    if (!amount.trim() || Number.isNaN(n)) {
      setError('Enter an amount.');
      return;
    }
    setError(null);
    logEntry.mutate(
      { id: goal.id, patch: { amount: n, note: note.trim() || undefined } },
      {
        onSuccess: () => {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
          onDone();
        },
      },
    );
  };

  return (
    <ScrollView style={{ maxHeight: 420 }} keyboardShouldPersistTaps="handled">
      <View style={{ gap: 16, paddingBottom: 8 }}>
        <View style={{ gap: 8 }}>
          <Text style={styles.label}>Amount</Text>
          <TextInput
            value={amount}
            onChangeText={setAmount}
            placeholder={goal.definition.type === 'savings' ? goal.definition.currency : ''}
            placeholderTextColor={theme.faint}
            keyboardType="decimal-pad"
            style={styles.textInput}
            autoFocus
          />
        </View>
        <View style={{ gap: 8 }}>
          <Text style={styles.label}>Note (optional)</Text>
          <TextInput
            value={note}
            onChangeText={setNote}
            placeholder="e.g. birthday money"
            placeholderTextColor={theme.faint}
            style={styles.textInput}
          />
        </View>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <PrimaryButton label={logEntry.isPending ? 'Logging…' : 'Log entry'} onPress={submit} />
      </View>
    </ScrollView>
  );
}

export function GoalEntrySheet({
  visible,
  onClose,
  goal,
}: {
  visible: boolean;
  onClose: () => void;
  goal: ApiGoal;
}) {
  return (
    <Sheet visible={visible} onClose={onClose} title={`Log to "${goal.name}"`}>
      {visible ? <GoalEntryForm goal={goal} onDone={onClose} /> : null}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  label: { color: theme.text, fontSize: 14, fontWeight: '600' },
  textInput: {
    color: theme.text,
    fontSize: 15,
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: theme.surface,
    borderRadius: radii.controlTight,
    borderWidth: 1,
    borderColor: theme.border,
  },
  error: { color: theme.danger, fontSize: 13 },
});
