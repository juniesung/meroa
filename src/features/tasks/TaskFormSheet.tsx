import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { Picker } from '@react-native-picker/picker';
import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { Sheet } from '@/components/Sheet';
import { PrimaryButton } from '@/components/PrimaryButton';
import { Icon, type IconName } from '@/components/Icon';
import { isOverdue } from '@/components/TaskCard';
import { useMe } from '@/features/profile/queries';
import { useGoals } from '@/features/goals/queries';
import { radii, theme } from '@/constants/theme';
import type {
  ApiTask,
  ChecklistConfig,
  CounterConfig,
  CreateTaskInput,
  DurationConfig,
  EditTaskPatch,
  TaskType,
  Weekday,
} from '@/lib/api/types';
import { useCreateTask, useEditTask, usePostponeTask } from './queries';
import {
  buildDueAtIso,
  buildDueAtPreservingDay,
  buildRecurrence,
  dateToHhmm,
  dueChoiceFromIso,
  formatHhmmDisplay,
  hhmmToDate,
  recurrenceChoiceFrom,
  type DueChoice,
  type RecurrenceChoice,
} from './task-form-helpers';

const TYPE_OPTIONS: { type: TaskType; label: string; icon: IconName }[] = [
  { type: 'completion', label: 'Simple', icon: 'check' },
  { type: 'checklist', label: 'Checklist', icon: 'tasks' },
  { type: 'counter', label: 'Counter', icon: 'plus' },
  { type: 'duration', label: 'Timer', icon: 'clock' },
];

const ICON_OPTIONS: IconName[] = [
  'sparkle',
  'dumbbell',
  'droplet',
  'book',
  'briefcase',
  'wallet',
  'flame',
  'clock',
  'bell',
  'tasks',
];

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

const REASON_OPTIONS: { key: 'bad_timing' | 'low_energy' | 'avoided'; label: string }[] = [
  { key: 'bad_timing', label: 'Bad timing' },
  { key: 'low_energy', label: 'Low energy' },
  { key: 'avoided', label: 'Avoided it' },
];

function haptic() {
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
}

// Sheet stays permanently mounted (it owns the open/close animation); the
// form body is what needs to reset per task. Rather than an effect that
// syncs local state to `task` on every open, `TaskFormBody` is remounted
// (via the `key` below) each time the sheet opens — so its `useState`
// initializers just read `task` once, no synchronization needed.
export function TaskFormSheet({
  visible,
  onClose,
  task,
}: {
  visible: boolean;
  onClose: () => void;
  task?: ApiTask;
}) {
  return (
    <Sheet visible={visible} onClose={onClose} title={task ? 'Edit task' : 'New task'}>
      <TaskFormBody key={`${visible}-${task?.id ?? 'new'}`} task={task} onClose={onClose} />
    </Sheet>
  );
}

function TaskFormBody({ task, onClose }: { task?: ApiTask; onClose: () => void }) {
  const isEdit = !!task;
  const isTemplate = !!task?.recurrence;
  const { data: me } = useMe();
  const createTask = useCreateTask();
  const editTask = useEditTask();
  const postponeTask = usePostponeTask();

  const [type, setType] = useState<TaskType>(task?.type ?? 'completion');
  const [title, setTitle] = useState(task?.title ?? '');
  const [icon, setIcon] = useState<IconName>((task?.icon as IconName | null) ?? 'sparkle');
  const [note, setNote] = useState(task ? ((task.config as { note?: string }).note ?? '') : '');
  const [items, setItems] = useState<string[]>(
    task?.type === 'checklist' ? (task.config as ChecklistConfig).items.map((i) => i.text) : [''],
  );
  const [target, setTarget] = useState(() =>
    task?.type === 'counter' ? String((task.config as CounterConfig).target) : '',
  );
  const [unit, setUnit] = useState(() =>
    task?.type === 'counter' ? ((task.config as CounterConfig).unit ?? '') : '',
  );
  const [targetMinutes, setTargetMinutes] = useState(
    task?.type === 'duration' ? String((task.config as DurationConfig).targetMinutes ?? '') : '',
  );
  const initialDue = dueChoiceFromIso(task?.dueAt ?? null);
  const initialRecurrence = recurrenceChoiceFrom(task?.recurrence ?? null);
  const [dueChoice, setDueChoice] = useState<DueChoice>(initialDue.choice);
  const [dueTime, setDueTime] = useState(initialRecurrence.time || initialDue.time);
  // dueChoiceFromIso can only represent "none/today/tomorrow" — an existing
  // task due on any other day (or overdue) has no faithful chip to show, and
  // falls back to 'today'. Saving that guess back would silently overwrite a
  // real due date the user never touched. Tracked separately from the time
  // field: touching only the time (e.g. nudging 5pm -> 6pm on a task due in
  // 3 days) should keep that real day and just swap the time, not also
  // silently move the date to today.
  const [dueTouched, setDueTouched] = useState(false);
  const [dueTimeTouched, setDueTimeTouched] = useState(false);
  const [recurrenceChoice, setRecurrenceChoice] = useState<RecurrenceChoice>(
    initialRecurrence.choice,
  );
  const [weekdays, setWeekdays] = useState<Weekday[]>(initialRecurrence.weekdays);
  const [everyN, setEveryN] = useState(initialRecurrence.everyN);
  const [reminder, setReminder] = useState(
    () => !!(task?.config as { reminder?: boolean } | undefined)?.reminder,
  );

  // Goal link — "None" plus every live goal, filtered to what this task
  // could actually count toward: a habit goal needs a recurring check-in
  // task, so it's only offered once the task already repeats (edit) or the
  // user has picked a repeat schedule below (create). goalTouched mirrors
  // dueTouched: only send goalId on an edit if the user actually opened
  // this picker, so an unrelated field edit never silently re-sends
  // (and re-records) the task's existing link.
  const { data: goals = [] } = useGoals();
  const [goalId, setGoalId] = useState<string | null>(task?.goalId ?? null);
  const [goalTouched, setGoalTouched] = useState(false);
  const [contribution, setContribution] = useState(() => {
    const c = (task?.config as { goalContribution?: number } | undefined)?.goalContribution;
    return c !== undefined ? String(c) : '';
  });
  const willRepeat = isTemplate || (!isEdit && recurrenceChoice !== 'none');
  const linkableGoals = goals.filter((g) => g.definition.type !== 'habit' || willRepeat);
  const selectedGoal = goalId ? goals.find((g) => g.id === goalId) : undefined;
  const selectedGoalNeedsContribution = selectedGoal?.definition.type === 'savings';

  function goalContributionValid() {
    if (!goalId || !selectedGoalNeedsContribution) return true;
    return Number.isFinite(Number(contribution)) && Number(contribution) > 0;
  }

  const submitting = createTask.isPending || editTask.isPending;

  function validTitle() {
    return title.trim().length > 0;
  }

  // Weekly recurrence with zero weekday chips selected would otherwise
  // silently produce a non-recurring task (buildRecurrence returns
  // undefined) — block submission instead, same as an empty title.
  function recurrenceValid() {
    return recurrenceChoice !== 'weekly' || weekdays.length > 0;
  }

  // Mirrors the per-type early-returns in handleSubmit — without this the
  // button looked enabled but tapping it silently did nothing (create) or
  // saved every other field while dropping the target change (edit).
  function targetValid() {
    const relevantType = isEdit && task ? task.type : type;
    if (relevantType === 'counter') return Number.isFinite(Number(target)) && Number(target) > 0;
    if (relevantType === 'duration') {
      return Number.isFinite(Number(targetMinutes)) && Number(targetMinutes) > 0;
    }
    return true;
  }

  function canSubmit() {
    return validTitle() && recurrenceValid() && targetValid() && goalContributionValid();
  }

  function toggleWeekday(day: Weekday) {
    setWeekdays((prev) => (prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day]));
  }

  function handleSubmit() {
    if (!canSubmit()) return;
    const recurrence =
      isTemplate || !isEdit
        ? buildRecurrence(recurrenceChoice, weekdays, everyN, dueTime)
        : undefined;

    if (isEdit && task) {
      const patch: EditTaskPatch = { title: title.trim(), icon, reminder };
      // Only touch dueAt if the user actually changed something about it —
      // see dueTouched's declaration for why the chips can't be trusted to
      // reconstruct an untouched due date.
      if (dueTouched) {
        patch.dueAt = buildDueAtIso(dueChoice, dueTime) ?? null;
      } else if (dueTimeTouched && task.dueAt) {
        patch.dueAt = buildDueAtPreservingDay(task.dueAt, dueTime);
      }
      if (isTemplate) patch.recurrence = recurrence ?? null;
      if (task.type === 'completion') patch.note = note.trim();
      if (task.type === 'checklist') {
        const nonEmpty = items.map((i) => i.trim()).filter(Boolean);
        if (nonEmpty.length) patch.items = nonEmpty;
      }
      if (task.type === 'counter') {
        const n = Number(target);
        if (!Number.isFinite(n) || n <= 0) return;
        patch.target = n;
        patch.unit = unit.trim();
      }
      if (task.type === 'duration') {
        const n = Number(targetMinutes);
        if (!Number.isFinite(n) || n <= 0) return;
        patch.targetMinutes = n;
      }
      if (goalTouched) {
        patch.goalId = goalId;
        if (goalId && selectedGoalNeedsContribution) patch.goalContribution = Number(contribution);
      }
      editTask.mutate({ id: task.id, patch }, { onSuccess: onClose });
      return;
    }

    const dueAt = buildDueAtIso(dueChoice, dueTime);
    const shared = {
      title: title.trim(),
      icon,
      dueAt,
      recurrence,
      reminder,
      goalId: goalId ?? undefined,
      goalContribution: goalId && selectedGoalNeedsContribution ? Number(contribution) : undefined,
    };
    let input: CreateTaskInput;
    switch (type) {
      case 'completion':
        input = { type: 'completion', note: note.trim() || undefined, ...shared };
        break;
      case 'checklist': {
        const nonEmpty = items.map((i) => i.trim()).filter(Boolean);
        if (!nonEmpty.length) return;
        input = { type: 'checklist', items: nonEmpty, ...shared };
        break;
      }
      case 'counter': {
        const n = Number(target);
        if (!Number.isFinite(n) || n <= 0) return;
        input = { type: 'counter', target: n, unit: unit.trim() || undefined, ...shared };
        break;
      }
      case 'duration': {
        const n = Number(targetMinutes);
        if (!Number.isFinite(n) || n <= 0) return;
        input = { type: 'duration', targetMinutes: n, ...shared };
        break;
      }
    }
    createTask.mutate(input, { onSuccess: onClose });
  }

  function handleReason(reason: 'bad_timing' | 'low_energy' | 'avoided') {
    if (!task) return;
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    postponeTask.mutate(
      { id: task.id, input: { newDueAt: tomorrow.toISOString(), reason } },
      { onSuccess: onClose },
    );
  }

  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      style={{ maxHeight: '100%' }}
    >
      {isEdit && task && isOverdue(task, me?.user.timezone) && (
        <View style={styles.recoveryBand}>
          <Text style={styles.recoveryTitle}>What happened with this one?</Text>
          <View style={styles.chipRow}>
            {REASON_OPTIONS.map((r) => (
              <Chip
                key={r.key}
                label={r.label}
                selected={false}
                onPress={() => handleReason(r.key)}
              />
            ))}
          </View>
          {postponeTask.isPending && (
            <Text style={styles.recoveryHint}>Moving it to tomorrow…</Text>
          )}
        </View>
      )}

      <FieldLabel>TITLE</FieldLabel>
      <TextInput
        value={title}
        onChangeText={setTitle}
        placeholder="What are you tracking?"
        placeholderTextColor={theme.faint}
        style={styles.input}
      />

      {!isEdit && (
        <>
          <FieldLabel>TYPE</FieldLabel>
          <View style={styles.chipRow}>
            {TYPE_OPTIONS.map((opt) => (
              <Chip
                key={opt.type}
                label={opt.label}
                icon={opt.icon}
                selected={type === opt.type}
                onPress={() => setType(opt.type)}
              />
            ))}
          </View>
        </>
      )}

      <FieldLabel>ICON</FieldLabel>
      <View style={styles.chipRow}>
        {ICON_OPTIONS.map((name) => (
          <Pressable
            key={name}
            onPress={() => {
              haptic();
              setIcon(name);
            }}
            style={[styles.iconChip, icon === name && styles.iconChipSelected]}
          >
            <Icon name={name} size={18} color={icon === name ? theme.blue : theme.dim} />
          </Pressable>
        ))}
      </View>

      {type === 'completion' && (
        <>
          <FieldLabel>NOTE (OPTIONAL)</FieldLabel>
          <TextInput
            value={note}
            onChangeText={setNote}
            placeholder="Any details"
            placeholderTextColor={theme.faint}
            style={styles.input}
          />
        </>
      )}

      {type === 'checklist' && (
        <>
          <FieldLabel>ITEMS</FieldLabel>
          {items.map((value, i) => (
            <View key={i} style={styles.itemRow}>
              <TextInput
                value={value}
                onChangeText={(text) =>
                  setItems((prev) => prev.map((v, idx) => (idx === i ? text : v)))
                }
                placeholder={`Item ${i + 1}`}
                placeholderTextColor={theme.faint}
                style={[styles.input, { flex: 1 }]}
              />
              {items.length > 1 && (
                <Pressable
                  onPress={() => setItems((prev) => prev.filter((_, idx) => idx !== i))}
                  hitSlop={8}
                  style={styles.removeBtn}
                >
                  <Icon name="ellipsis" size={16} color={theme.faint} />
                </Pressable>
              )}
            </View>
          ))}
          <Pressable onPress={() => setItems((prev) => [...prev, ''])} style={styles.addItemBtn}>
            <Icon name="plus" size={14} color={theme.blue} stroke={2.2} />
            <Text style={styles.addItemText}>Add item</Text>
          </Pressable>
        </>
      )}

      {type === 'counter' && (
        <View style={styles.row}>
          <View style={{ flex: 1 }}>
            <FieldLabel>TARGET</FieldLabel>
            <TextInput
              value={target}
              onChangeText={setTarget}
              keyboardType="decimal-pad"
              placeholder="10"
              placeholderTextColor={theme.faint}
              style={styles.input}
            />
          </View>
          <View style={{ flex: 1 }}>
            <FieldLabel>UNIT (OPTIONAL)</FieldLabel>
            <TextInput
              value={unit}
              onChangeText={setUnit}
              placeholder="reps, L, $…"
              placeholderTextColor={theme.faint}
              style={styles.input}
            />
          </View>
        </View>
      )}

      {type === 'duration' && (
        <>
          <FieldLabel>TARGET MINUTES</FieldLabel>
          <TextInput
            value={targetMinutes}
            onChangeText={setTargetMinutes}
            keyboardType="number-pad"
            placeholder="30"
            placeholderTextColor={theme.faint}
            style={styles.input}
          />
        </>
      )}

      {linkableGoals.length > 0 && (
        <>
          <FieldLabel>GOAL (OPTIONAL)</FieldLabel>
          <View style={styles.chipRow}>
            <Chip
              label="None"
              selected={!goalId}
              onPress={() => {
                setGoalId(null);
                setGoalTouched(true);
              }}
            />
            {linkableGoals.map((g) => (
              <Chip
                key={g.id}
                label={g.name}
                selected={goalId === g.id}
                onPress={() => {
                  setGoalId(g.id);
                  setGoalTouched(true);
                }}
              />
            ))}
          </View>
          {selectedGoalNeedsContribution && (
            <>
              <FieldLabel>AMOUNT PER COMPLETION</FieldLabel>
              <TextInput
                value={contribution}
                onChangeText={setContribution}
                keyboardType="decimal-pad"
                placeholder="5"
                placeholderTextColor={theme.faint}
                style={styles.input}
              />
            </>
          )}
        </>
      )}

      <FieldLabel>DUE</FieldLabel>
      <View style={styles.chipRow}>
        <Chip
          label="No due date"
          selected={dueChoice === 'none'}
          onPress={() => {
            setDueChoice('none');
            setDueTouched(true);
          }}
        />
        <Chip
          label="Today"
          selected={dueChoice === 'today'}
          onPress={() => {
            setDueChoice('today');
            setDueTouched(true);
          }}
        />
        <Chip
          label="Tomorrow"
          selected={dueChoice === 'tomorrow'}
          onPress={() => {
            setDueChoice('tomorrow');
            setDueTouched(true);
          }}
        />
      </View>
      {(dueChoice !== 'none' || recurrenceChoice !== 'none') && (
        <TimeField
          time={dueTime}
          onChange={(t) => {
            setDueTime(t);
            setDueTimeTouched(true);
          }}
        />
      )}

      {(!isEdit || isTemplate) && (
        <>
          <FieldLabel>REPEATS</FieldLabel>
          <View style={styles.chipRow}>
            <Chip
              label="Never"
              selected={recurrenceChoice === 'none'}
              onPress={() => setRecurrenceChoice('none')}
            />
            <Chip
              label="Daily"
              selected={recurrenceChoice === 'daily'}
              onPress={() => setRecurrenceChoice('daily')}
            />
            <Chip
              label="Weekdays"
              selected={recurrenceChoice === 'weekly'}
              onPress={() => setRecurrenceChoice('weekly')}
            />
            <Chip
              label="Every N days"
              selected={recurrenceChoice === 'every_n'}
              onPress={() => setRecurrenceChoice('every_n')}
            />
          </View>
          {recurrenceChoice === 'weekly' && (
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
          {recurrenceChoice === 'every_n' && <EveryNField value={everyN} onChange={setEveryN} />}
        </>
      )}

      <Pressable
        onPress={() => {
          haptic();
          setReminder((r) => !r);
        }}
        style={styles.reminderRow}
      >
        <View style={[styles.toggle, reminder && styles.toggleOn]}>
          <View style={[styles.toggleKnob, reminder && styles.toggleKnobOn]} />
        </View>
        <Text style={styles.reminderLabel}>
          {isTemplate ? 'Remind me every time this repeats' : 'Remind me around this time'}
        </Text>
      </Pressable>

      <PrimaryButton
        label={submitting ? 'Saving…' : isEdit ? 'Save changes' : 'Create task'}
        onPress={canSubmit() ? handleSubmit : undefined}
        style={{ marginTop: 20, marginBottom: 4, opacity: canSubmit() && !submitting ? 1 : 0.5 }}
      />
    </ScrollView>
  );
}

function FieldLabel({ children }: { children: string }) {
  return <Text style={styles.fieldLabel}>{children}</Text>;
}

// A native wheel picker (iOS) / clock dialog (Android) instead of free-text
// "HH:mm" entry — the old text field silently fell back to a default time on
// any input it couldn't parse (e.g. "9pm"), with no feedback that it had.
function TimeField({ time, onChange }: { time: string; onChange: (hhmm: string) => void }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <View style={{ marginTop: 14 }}>
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
        <Picker
          selectedValue={n}
          onValueChange={(val) => onChange(String(val))}
          itemStyle={styles.pickerItem}
        >
          {EVERY_N_OPTIONS.map((opt) => (
            <Picker.Item key={opt} label={`${opt} days`} value={opt} />
          ))}
        </Picker>
      )}
    </View>
  );
}

function Chip({
  label,
  icon,
  selected,
  onPress,
}: {
  label: string;
  icon?: IconName;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={() => {
        haptic();
        onPress();
      }}
      style={[styles.chip, selected && styles.chipSelected]}
    >
      {icon && <Icon name={icon} size={13} color={selected ? theme.blue : theme.dim} stroke={2} />}
      <Text style={[styles.chipLabel, selected && styles.chipLabelSelected]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fieldLabel: {
    color: theme.dim,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
    marginTop: 18,
    marginBottom: 8,
  },
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
  row: { flexDirection: 'row', gap: 10 },
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
  iconChip: {
    width: 36,
    height: 36,
    borderRadius: radii.chip,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.surface,
  },
  iconChipSelected: { borderColor: theme.blue, backgroundColor: 'rgba(10,132,255,0.14)' },
  itemRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  removeBtn: { padding: 6 },
  addItemBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 },
  addItemText: { color: theme.blue, fontSize: 13, fontWeight: '600' },
  reminderRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 18 },
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
  reminderLabel: { color: theme.text, fontSize: 14 },
  recoveryBand: {
    backgroundColor: 'rgba(255,69,58,0.08)',
    borderRadius: radii.controlTight,
    borderWidth: 1,
    borderColor: 'rgba(255,69,58,0.25)',
    padding: 12,
    marginBottom: 8,
  },
  recoveryTitle: { color: theme.text, fontSize: 13.5, fontWeight: '600', marginBottom: 10 },
  recoveryHint: { color: theme.dim, fontSize: 12, marginTop: 8 },
});
