import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { PrimaryButton } from '@/components/PrimaryButton';
import { Sheet } from '@/components/Sheet';
import { radii, theme } from '@/constants/theme';
import type { ApiTool, ToolField } from '@/lib/api/types';
import { useLogToolEntry } from './queries';

function FieldInput({
  field,
  value,
  onChange,
}: {
  field: ToolField;
  value: string | boolean | undefined;
  onChange: (v: string | boolean | undefined) => void;
}) {
  if (field.type === 'boolean') {
    const on = value === true;
    return (
      <Pressable onPress={() => onChange(!on)} style={[styles.boolChip, on && styles.chipSelected]}>
        <Text style={[styles.chipText, on && styles.chipTextSelected]}>{on ? 'Yes' : 'No'}</Text>
      </Pressable>
    );
  }
  if (field.type === 'choice') {
    return (
      <View style={styles.chipRow}>
        {(field.options ?? []).map((opt) => {
          const selected = value === opt;
          return (
            <Pressable
              key={opt}
              onPress={() => onChange(selected ? undefined : opt)}
              style={[styles.chip, selected && styles.chipSelected]}
            >
              <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{opt}</Text>
            </Pressable>
          );
        })}
      </View>
    );
  }
  if (field.type === 'rating') {
    const current = typeof value === 'string' ? Number(value) : undefined;
    return (
      <View style={styles.chipRow}>
        {[1, 2, 3, 4, 5].map((n) => {
          const selected = current === n;
          return (
            <Pressable
              key={n}
              onPress={() => onChange(selected ? undefined : String(n))}
              style={[styles.ratingChip, selected && styles.chipSelected]}
            >
              <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{n}</Text>
            </Pressable>
          );
        })}
      </View>
    );
  }
  return (
    <TextInput
      value={typeof value === 'string' ? value : ''}
      onChangeText={onChange}
      placeholder={field.unit ? `in ${field.unit}` : 'value'}
      placeholderTextColor={theme.faint}
      keyboardType={field.type === 'number' ? 'decimal-pad' : 'default'}
      style={styles.textInput}
    />
  );
}

// Remounted each time the sheet opens (the parent renders this only while
// `visible`, matching TaskFormSheet's pattern) so state always starts fresh.
function ToolEntryForm({ tool, onDone }: { tool: ApiTool; onDone: () => void }) {
  const logEntry = useLogToolEntry();
  const [values, setValues] = useState<Record<string, string | boolean | undefined>>({});
  const [error, setError] = useState<string | null>(null);

  const fields = tool.definition.fields.filter((f) => !f.archived);

  const submit = () => {
    // Only fields the user actually filled in are sent — untouched optional
    // fields are omitted, never defaulted (docs/ai-reliability-hardening.md
    // lesson 13).
    const payload: { fieldId: string; value: number | string | boolean }[] = [];
    for (const field of fields) {
      const raw = values[field.id];
      const filled = field.type === 'boolean' ? raw !== undefined : raw !== undefined && raw !== '';
      if (!filled) {
        if (field.required) {
          setError(`"${field.label}" is required.`);
          return;
        }
        continue;
      }
      if (field.type === 'number' || field.type === 'rating') {
        const n = Number(raw);
        if (Number.isNaN(n)) {
          setError(`"${field.label}" needs a number.`);
          return;
        }
        payload.push({ fieldId: field.id, value: n });
      } else if (field.type === 'boolean') {
        payload.push({ fieldId: field.id, value: raw === true });
      } else {
        payload.push({ fieldId: field.id, value: String(raw) });
      }
    }
    if (payload.length === 0) {
      setError('Enter at least one value.');
      return;
    }
    setError(null);
    logEntry.mutate(
      { id: tool.id, patch: { values: payload } },
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
        {fields.map((field) => (
          <View key={field.id} style={{ gap: 8 }}>
            <Text style={styles.label}>
              {field.label}
              {field.required ? ' *' : ''}
            </Text>
            <FieldInput
              field={field}
              value={values[field.id]}
              onChange={(v) => setValues((prev) => ({ ...prev, [field.id]: v }))}
            />
          </View>
        ))}
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <PrimaryButton label={logEntry.isPending ? 'Logging…' : 'Log entry'} onPress={submit} />
      </View>
    </ScrollView>
  );
}

export function ToolEntrySheet({
  visible,
  onClose,
  tool,
}: {
  visible: boolean;
  onClose: () => void;
  tool: ApiTool;
}) {
  return (
    <Sheet visible={visible} onClose={onClose} title={`Log to "${tool.name}"`}>
      {visible ? <ToolEntryForm tool={tool} onDone={onClose} /> : null}
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
  chipRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: theme.borderStrong,
    backgroundColor: theme.surface,
  },
  chipSelected: { backgroundColor: theme.blue, borderColor: theme.blue },
  chipText: { color: theme.text, fontSize: 13, fontWeight: '600' },
  chipTextSelected: { color: '#fff' },
  ratingChip: {
    width: 40,
    height: 40,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: theme.borderStrong,
    backgroundColor: theme.surface,
  },
  boolChip: {
    alignSelf: 'flex-start',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: theme.borderStrong,
    backgroundColor: theme.surface,
  },
  error: { color: theme.danger, fontSize: 13 },
});
