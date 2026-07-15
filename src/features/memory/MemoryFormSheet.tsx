import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import { ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import { PrimaryButton } from '@/components/PrimaryButton';
import { Sheet } from '@/components/Sheet';
import { radii, theme } from '@/constants/theme';
import type { ApiMemory } from '@/lib/api/types';
import { useCreateMemory, useUpdateMemory } from './queries';

const KIND_OPTIONS: { key: string; label: string }[] = [
  { key: 'preference', label: 'Preference' },
  { key: 'trait', label: 'Trait' },
  { key: 'relationship', label: 'Relationship' },
  { key: 'situation', label: 'Situation' },
];

export function MemoryFormSheet({
  visible,
  onClose,
  memory,
}: {
  visible: boolean;
  onClose: () => void;
  memory?: ApiMemory | null;
}) {
  return (
    <Sheet visible={visible} onClose={onClose} title={memory ? 'Edit memory' : 'Add a memory'}>
      <MemoryFormBody key={`${visible}-${memory?.id ?? 'new'}`} memory={memory} onClose={onClose} />
    </Sheet>
  );
}

function MemoryFormBody({ memory, onClose }: { memory?: ApiMemory | null; onClose: () => void }) {
  const isEdit = !!memory;
  const [content, setContent] = useState(memory?.content ?? '');
  const [kind, setKind] = useState(memory?.kind ?? 'preference');
  const [sensitive, setSensitive] = useState(memory?.sensitive ?? false);
  const [suppressed, setSuppressed] = useState(memory?.suppressed ?? false);
  const createMemory = useCreateMemory();
  const updateMemory = useUpdateMemory();
  const submitting = createMemory.isPending || updateMemory.isPending;
  const canSubmit = content.trim().length > 0;

  const handleSubmit = () => {
    if (!canSubmit) return;
    if (isEdit) {
      updateMemory.mutate(
        { id: memory.id, patch: { content: content.trim(), sensitive, suppressed } },
        { onSuccess: onClose },
      );
    } else {
      createMemory.mutate({ content: content.trim(), kind, sensitive }, { onSuccess: onClose });
    }
  };

  return (
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 20, gap: 16 }}>
      <View>
        <Text style={styles.label}>WHAT SHOULD I REMEMBER</Text>
        <TextInput
          value={content}
          onChangeText={setContent}
          placeholder="e.g. Prefers texts over calls"
          placeholderTextColor={theme.faint}
          style={[styles.input, styles.textArea]}
          multiline
        />
      </View>

      {!isEdit && (
        <View>
          <Text style={styles.label}>KIND</Text>
          <View style={styles.chipRow}>
            {KIND_OPTIONS.map((opt) => (
              <Chip key={opt.key} label={opt.label} selected={kind === opt.key} onPress={() => setKind(opt.key)} />
            ))}
          </View>
        </View>
      )}

      <View style={styles.switchRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.switchLabel}>Sensitive</Text>
          <Text style={styles.switchHint}>Health, money, or emotional — never brought up unprompted.</Text>
        </View>
        <Switch
          value={sensitive}
          onValueChange={setSensitive}
          trackColor={{ true: theme.blue, false: theme.border }}
          thumbColor="#fff"
        />
      </View>

      {isEdit && (
        <View style={styles.switchRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.switchLabel}>Don&apos;t bring this up</Text>
            <Text style={styles.switchHint}>Kept, but Meroa won&apos;t reference it unless you do first.</Text>
          </View>
          <Switch
            value={suppressed}
            onValueChange={setSuppressed}
            trackColor={{ true: theme.blue, false: theme.border }}
            thumbColor="#fff"
          />
        </View>
      )}

      <PrimaryButton
        label={submitting ? 'Saving…' : isEdit ? 'Save' : 'Add memory'}
        onPress={
          canSubmit && !submitting
            ? () => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
                handleSubmit();
              }
            : undefined
        }
        style={{ opacity: canSubmit && !submitting ? 1 : 0.5 }}
      />
    </ScrollView>
  );
}

function Chip({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  return (
    <Text
      onPress={() => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
        onPress();
      }}
      style={[styles.chip, selected && styles.chipSelected]}
    >
      {label}
    </Text>
  );
}

const styles = StyleSheet.create({
  label: { color: theme.dim, fontSize: 11, fontWeight: '700', letterSpacing: 1, marginBottom: 8 },
  input: {
    color: theme.text,
    fontSize: 15,
    paddingHorizontal: 14,
    paddingVertical: 11,
    backgroundColor: theme.surface,
    borderRadius: radii.controlTight,
    borderWidth: 1,
    borderColor: theme.border,
  },
  textArea: { minHeight: 80, textAlignVertical: 'top' },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.surface,
    color: theme.dim,
    fontSize: 13,
    fontWeight: '600',
    overflow: 'hidden',
  },
  chipSelected: { borderColor: theme.blue, backgroundColor: 'rgba(10,132,255,0.14)', color: theme.blue },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  switchLabel: { color: theme.text, fontSize: 14, fontWeight: '600' },
  switchHint: { color: theme.dim, fontSize: 12, marginTop: 2 },
});
