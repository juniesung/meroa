import { Picker } from '@react-native-picker/picker';
import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Icon } from '@/components/Icon';
import { radii, theme } from '@/constants/theme';
import type { Weekday } from '@/lib/api/types';
import type { RecurrenceChoice } from './task-form-helpers';

// The "how often does this repeat" control, shared by the task form and the
// goal form. It lives here rather than inline in TaskFormSheet because a
// habit goal's check-in task needs exactly the same choice — a habit was
// locked to daily purely because this UI wasn't reachable from the goal
// sheet, which made "gym 3x/week" impossible to express even though the
// server has always accepted it.
//
// Presentational and fully controlled: the caller owns the state and turns it
// into a Recurrence via buildRecurrence() from task-form-helpers, which stays
// the single place that mapping happens.

const WEEKDAY_OPTIONS: { key: Weekday; letter: string }[] = [
  { key: 'mo', letter: 'M' },
  { key: 'tu', letter: 'T' },
  { key: 'we', letter: 'W' },
  { key: 'th', letter: 'T' },
  { key: 'fr', letter: 'F' },
  { key: 'sa', letter: 'S' },
  { key: 'su', letter: 'S' },
];

const EVERY_N_OPTIONS = Array.from({ length: 29 }, (_, i) => i + 2); // 2-30 days

function haptic() {
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
}

export function RecurrenceField({
  choice,
  weekdays,
  everyN,
  onChoiceChange,
  onWeekdaysChange,
  onEveryNChange,
  // A habit's check-in task has to repeat — the streak counts that task, and
  // a one-off can't carry one (the server rejects it outright). Hiding
  // "Never" is how the form makes that unrepresentable rather than
  // rejectable.
  allowNever = true,
}: {
  choice: RecurrenceChoice;
  weekdays: Weekday[];
  everyN: string;
  onChoiceChange: (choice: RecurrenceChoice) => void;
  onWeekdaysChange: (weekdays: Weekday[]) => void;
  onEveryNChange: (everyN: string) => void;
  allowNever?: boolean;
}) {
  const toggleWeekday = (day: Weekday) => {
    onWeekdaysChange(weekdays.includes(day) ? weekdays.filter((d) => d !== day) : [...weekdays, day]);
  };

  return (
    <>
      <View style={styles.chipRow}>
        {allowNever && (
          <Chip label="Never" selected={choice === 'none'} onPress={() => onChoiceChange('none')} />
        )}
        <Chip label="Daily" selected={choice === 'daily'} onPress={() => onChoiceChange('daily')} />
        <Chip label="Weekdays" selected={choice === 'weekly'} onPress={() => onChoiceChange('weekly')} />
        <Chip
          label="Every N days"
          selected={choice === 'every_n'}
          onPress={() => onChoiceChange('every_n')}
        />
      </View>
      {choice === 'weekly' && (
        <View style={styles.weekdayRow}>
          {WEEKDAY_OPTIONS.map((d) => (
            <WeekdayChip
              key={d.key}
              letter={d.letter}
              selected={weekdays.includes(d.key)}
              onPress={() => toggleWeekday(d.key)}
            />
          ))}
        </View>
      )}
      {choice === 'every_n' && <EveryNField value={everyN} onChange={onEveryNChange} />}
    </>
  );
}

function WeekdayChip({ letter, selected, onPress }: { letter: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={() => {
        haptic();
        onPress();
      }}
      style={[styles.weekdayChip, selected && styles.weekdayChipSelected]}
      hitSlop={4}
    >
      <Text style={[styles.weekdayChipText, selected && styles.weekdayChipTextSelected]}>{letter}</Text>
    </Pressable>
  );
}

// A native wheel picker for the "every N days" interval — matches the time
// field's tap-to-reveal pattern instead of a raw number TextInput.
function EveryNField({ value, onChange }: { value: string; onChange: (n: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const n = Number.parseInt(value, 10) || 2;

  return (
    <View style={{ marginTop: 14 }}>
      <Pressable onPress={() => setExpanded((e) => !e)} style={styles.timeRow}>
        <Icon name="repeat" size={15} color={theme.dim} stroke={2} />
        <Text style={styles.timeRowText}>Every {n} days</Text>
        <Icon name="chevron" size={13} color={theme.faint} stroke={2} />
      </Pressable>
      {expanded && (
        <Picker selectedValue={n} onValueChange={(val) => onChange(String(val))} itemStyle={styles.pickerItem}>
          {EVERY_N_OPTIONS.map((opt) => (
            <Picker.Item key={opt} label={`${opt} days`} value={opt} />
          ))}
        </Picker>
      )}
    </View>
  );
}

function Chip({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={() => {
        haptic();
        onPress();
      }}
      style={[styles.chip, selected && styles.chipSelected]}
    >
      <Text style={[styles.chipLabel, selected && styles.chipLabelSelected]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  timeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    alignSelf: 'flex-start',
    paddingHorizontal: 14,
    paddingVertical: 11,
    backgroundColor: theme.surface,
    borderRadius: radii.controlTight,
    borderWidth: 1,
    borderColor: theme.border,
  },
  timeRowText: { color: theme.text, fontSize: 15, fontWeight: '600' },
  pickerItem: { color: theme.text, fontSize: 20 },
  weekdayRow: { flexDirection: 'row', gap: 8, marginTop: 14 },
  weekdayChip: {
    width: 36,
    height: 36,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.border,
  },
  weekdayChipSelected: { backgroundColor: theme.blue, borderColor: theme.blue },
  weekdayChipText: { color: theme.dim, fontSize: 14, fontWeight: '700' },
  weekdayChipTextSelected: { color: '#fff' },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.surface,
  },
  chipSelected: { borderColor: theme.blue, backgroundColor: 'rgba(10,132,255,0.14)' },
  chipLabel: { color: theme.dim, fontSize: 13, fontWeight: '600' },
  chipLabelSelected: { color: theme.blue },
});
