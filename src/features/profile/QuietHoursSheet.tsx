import * as Haptics from 'expo-haptics';
import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Icon } from '@/components/Icon';
import { PrimaryButton } from '@/components/PrimaryButton';
import { Sheet } from '@/components/Sheet';
import { radii, theme } from '@/constants/theme';
import { dateToHhmm, formatHhmmDisplay, hhmmToDate } from '@/features/tasks/task-form-helpers';
import { useMe, useUpdatePrefs } from './queries';
import { readQuietHours } from './quiet-hours';

export function QuietHoursSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  return (
    <Sheet visible={visible} onClose={onClose} title="Quiet hours">
      <QuietHoursBody onClose={onClose} />
    </Sheet>
  );
}

// Remounted per open (key on the sheet below) so the fields read fresh
// prefs each time — same idiom as VibePickerSheet's body.
function QuietHoursBody({ onClose }: { onClose: () => void }) {
  const { data } = useMe();
  const updatePrefs = useUpdatePrefs();
  const current = readQuietHours(data?.user.prefs);

  const [enabled, setEnabled] = useState(current.enabled);
  const [start, setStart] = useState(current.start);
  const [end, setEnd] = useState(current.end);

  const handleSave = () => {
    updatePrefs.mutate({ quietHours: { enabled, start, end } }, { onSuccess: onClose });
  };

  return (
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 12 }}>
      <Text style={styles.intro}>
        Task reminders won&apos;t ping during this window — they&apos;ll fire once it ends instead
        of getting lost.
      </Text>

      <Pressable
        onPress={() => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
          setEnabled((e) => !e);
        }}
        style={styles.enableRow}
      >
        <View style={[styles.toggle, enabled && styles.toggleOn]}>
          <View style={[styles.toggleKnob, enabled && styles.toggleKnobOn]} />
        </View>
        <Text style={styles.enableLabel}>Quiet hours on</Text>
      </Pressable>

      {enabled && (
        <View style={styles.timeFields}>
          <TimeField label="Start" time={start} onChange={setStart} />
          <TimeField label="End" time={end} onChange={setEnd} />
        </View>
      )}

      <PrimaryButton
        label={updatePrefs.isPending ? 'Saving…' : 'Save'}
        onPress={handleSave}
        style={{ marginTop: 24, marginBottom: 4 }}
      />
    </ScrollView>
  );
}

function TimeField({
  label,
  time,
  onChange,
}: {
  label: string;
  time: string;
  onChange: (hhmm: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <View style={styles.timeField}>
      <Text style={styles.timeFieldLabel}>{label}</Text>
      <Pressable onPress={() => setExpanded((e) => !e)} style={styles.timeRow}>
        <Icon name="clock" size={15} color={theme.dim} stroke={2} />
        <Text style={styles.timeRowText}>{formatHhmmDisplay(time)}</Text>
        <Icon name="chevron" size={13} color={theme.faint} stroke={2} />
      </Pressable>
      {expanded && (
        <DateTimePicker
          value={hhmmToDate(time)}
          mode="time"
          display={Platform.OS === 'ios' ? 'spinner' : 'default'}
          is24Hour={false}
          themeVariant="dark"
          onChange={(_event: DateTimePickerEvent, selected?: Date) => {
            if (Platform.OS === 'android') setExpanded(false);
            if (selected) onChange(dateToHhmm(selected));
          }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  intro: { color: theme.dim, fontSize: 13, lineHeight: 18, marginBottom: 18 },
  enableRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  toggle: {
    width: 40,
    height: 24,
    borderRadius: 999,
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.border,
    justifyContent: 'center',
  },
  toggleOn: { backgroundColor: 'rgba(10,132,255,0.35)', borderColor: theme.blue },
  toggleKnob: {
    width: 18,
    height: 18,
    borderRadius: 999,
    backgroundColor: theme.dim,
    marginLeft: 2,
  },
  toggleKnobOn: { backgroundColor: theme.blue, marginLeft: 18 },
  enableLabel: { color: theme.text, fontSize: 15, fontWeight: '500' },
  timeFields: { flexDirection: 'row', gap: 16, marginTop: 20 },
  timeField: { flex: 1 },
  timeFieldLabel: {
    color: theme.dim,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
    marginBottom: 8,
  },
  timeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    alignSelf: 'flex-start',
    paddingHorizontal: 14,
    paddingVertical: 11,
    backgroundColor: theme.surface,
    borderRadius: radii.controlTight,
  },
  timeRowText: { color: theme.text, fontSize: 15, fontWeight: '600' },
});
