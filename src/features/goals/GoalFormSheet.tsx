import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useState, type Dispatch, type SetStateAction } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { Sheet } from '@/components/Sheet';
import { PrimaryButton } from '@/components/PrimaryButton';
import { Icon, type IconName } from '@/components/Icon';
import { radii, theme } from '@/constants/theme';
import type {
  ApiGoal,
  CreateGoalParams,
  EditGoalPatch,
  GoalTemplateKey,
  PlannedTask,
  Weekday,
} from '@/lib/api/types';
import { asLimitReached, limitReachedMessage } from '@/lib/api/limits';
import { RecurrenceField } from '@/features/tasks/RecurrenceField';
import { buildRecurrence, type RecurrenceChoice } from '@/features/tasks/task-form-helpers';
import { useCreateGoal, useEditGoal } from './queries';

const TYPE_OPTIONS: { type: GoalTemplateKey; label: string; icon: IconName }[] = [
  { type: 'savings', label: 'Savings', icon: 'wallet' },
  { type: 'habit', label: 'Habit', icon: 'flame' },
  { type: 'indirect', label: 'Tracked', icon: 'dumbbell' },
  { type: 'milestone', label: 'Milestone', icon: 'briefcase' },
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

const MAX_STAGES = 8;
const MAX_STAGE_TASKS = 5;

function haptic() {
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
}

function toIsoDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function formatIsoDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

// A stage row's local draft shape — `id` is a stable key for list rendering
// across add/remove/reorder (stage titles aren't unique or stable, so they
// can't key the list themselves). `tasks` holds title-only planned tasks
// (recurrence collapsed to a single "repeats daily" toggle) — the server's
// PlannedTask/StarterTask both support full recurrence and per-task icons,
// but a nested weekly/every-N picker inside an already-nested stage row
// inside a scrollable sheet is scope this form deliberately doesn't take on
// (docs/goal-manual-editing-plan.md §3.6: "no drag-reorder precedent —
// reorder via up/down affordance or defer" already sanctioned this kind of
// pragmatic cut for the stage editor).
type StageTaskDraft = { id: number; title: string; daily: boolean };
type StageDraft = { id: number; title: string; tasks: StageTaskDraft[] };

function toPlannedTask(t: StageTaskDraft): PlannedTask {
  return { title: t.title.trim(), ...(t.daily ? { recurrence: { freq: 'daily' } } : {}) };
}

// Module-level, not a ref — a stage/task draft only needs an id unique
// within its own mounted form (list-key stability across add/remove/
// reorder), and a ref read inside useState's lazy initializer trips the
// react-hooks/refs rule (reading a ref "during render"), even though a
// lazy initializer only ever runs once. A plain counter sidesteps that.
let stageDraftIdCounter = 0;
function nextStageId(): number {
  return stageDraftIdCounter++;
}

// Sheet stays mounted; the body remounts per open (see TaskFormSheet.tsx's
// identical comment) so its useState initializers just read `goal` once.
export function GoalFormSheet({
  visible,
  onClose,
  goal,
}: {
  visible: boolean;
  onClose: () => void;
  goal?: ApiGoal;
}) {
  return (
    <Sheet visible={visible} onClose={onClose} title={goal ? 'Edit goal' : 'New goal'}>
      <GoalFormBody key={`${visible}-${goal?.id ?? 'new'}`} goal={goal} onClose={onClose} />
    </Sheet>
  );
}

function GoalFormBody({ goal, onClose }: { goal?: ApiGoal; onClose: () => void }) {
  const isEdit = !!goal;
  const definition = goal?.definition;
  const createGoal = useCreateGoal();
  const editGoal = useEditGoal();
  const submitting = createGoal.isPending || editGoal.isPending;
  const [formError, setFormError] = useState<string | null>(null);

  const [type, setType] = useState<GoalTemplateKey>(definition?.type ?? 'savings');
  const [name, setName] = useState(goal?.name ?? '');
  const [icon, setIcon] = useState<IconName>((goal?.icon as IconName | null) ?? 'sparkle');

  // savings + indirect
  const [currency, setCurrency] = useState(definition?.type === 'savings' ? definition.currency : '$');
  const [targetValue, setTargetValue] = useState(() => {
    if (definition?.type === 'savings') return String(definition.targetValue);
    if (definition?.type === 'indirect' && definition.targetValue !== undefined) return String(definition.targetValue);
    return '';
  });
  const [deadline, setDeadline] = useState(
    (definition?.type === 'savings' || definition?.type === 'indirect') ? (definition.deadline ?? '') : '',
  );
  const [deadlinePickerOpen, setDeadlinePickerOpen] = useState(false);
  const [unit, setUnit] = useState(definition?.type === 'indirect' ? definition.unit : '');
  const unitLocked = isEdit && definition?.type === 'indirect' && (goal?.entryCount ?? 0) > 0;

  // savings/indirect optional starter task, habit's required check-in task —
  // create-only (an existing goal's tasks are edited as tasks, not reissued
  // through goal edit; the server's editGoalPatchSchema has no field for it).
  // `starterDaily` is the savings/indirect one-shot "repeats daily" toggle
  // only; a habit's cadence is the full picker below.
  const [starterTitle, setStarterTitle] = useState('');
  const [starterDaily, setStarterDaily] = useState(false);
  const [starterContribution, setStarterContribution] = useState('');

  // A habit's check-in cadence. Habits were locked to daily only because this
  // picker wasn't reachable from here — the server has always accepted any
  // recurrence for a check-in task, so "gym 3x/week" was representable
  // everywhere except the form. Defaults to daily, which is both the common
  // case and exactly what this form used to hardcode.
  const [checkinChoice, setCheckinChoice] = useState<RecurrenceChoice>('daily');
  const [checkinWeekdays, setCheckinWeekdays] = useState<Weekday[]>([]);
  const [checkinEveryN, setCheckinEveryN] = useState('2');

  // milestone — stages[0] is the active stage on create; its tasks submit as
  // starterTasks. On edit, stages[0..activeStageIndex] are the lived prefix
  // (rename-only, no task list — the active stage's tasks are real ApiTasks,
  // edited from the Tasks tab or the goal detail screen, never plans).
  const activeStageIndex = definition?.type === 'milestone' ? definition.activeStageIndex : 0;
  const [stages, setStages] = useState<StageDraft[]>(() => {
    if (definition?.type !== 'milestone') return [];
    return definition.stages.map((title, i) => ({
      id: nextStageId(),
      title,
      tasks: (definition.stagePlans?.[i] ?? []).map((t) => ({
        id: nextStageId(),
        title: t.title,
        daily: t.recurrence?.freq === 'daily',
      })),
    }));
  });
  const [newStageTitle, setNewStageTitle] = useState('');

  function addStage() {
    const title = newStageTitle.trim();
    if (!title || stages.length >= MAX_STAGES) return;
    setStages((prev) => [...prev, { id: nextStageId(), title, tasks: [] }]);
    setNewStageTitle('');
  }
  function renameStage(id: number, title: string) {
    setStages((prev) => prev.map((s) => (s.id === id ? { ...s, title } : s)));
  }
  function removeStage(id: number) {
    setStages((prev) => prev.filter((s) => s.id !== id));
  }
  function moveStage(index: number, dir: -1 | 1) {
    setStages((prev) => {
      const target = index + dir;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });
  }
  function addStageTask(stageId: number, title: string) {
    if (!title.trim()) return;
    setStages((prev) =>
      prev.map((s) =>
        s.id === stageId && s.tasks.length < MAX_STAGE_TASKS
          ? { ...s, tasks: [...s.tasks, { id: nextStageId(), title: title.trim(), daily: false }] }
          : s,
      ),
    );
  }
  function removeStageTask(stageId: number, taskId: number) {
    setStages((prev) => prev.map((s) => (s.id === stageId ? { ...s, tasks: s.tasks.filter((t) => t.id !== taskId) } : s)));
  }
  function toggleStageTaskDaily(stageId: number, taskId: number) {
    setStages((prev) =>
      prev.map((s) =>
        s.id === stageId
          ? { ...s, tasks: s.tasks.map((t) => (t.id === taskId ? { ...t, daily: !t.daily } : t)) }
          : s,
      ),
    );
  }

  function validTitle() {
    return name.trim().length > 0;
  }
  function targetValid() {
    if (isEdit) return !targetValue.trim() || (Number.isFinite(Number(targetValue)) && Number(targetValue) > 0);
    if (type === 'savings') return Number.isFinite(Number(targetValue)) && Number(targetValue) > 0;
    if (type === 'indirect') return !targetValue.trim() || (Number.isFinite(Number(targetValue)) && Number(targetValue) > 0);
    return true;
  }
  function unitValid() {
    return type !== 'indirect' || unit.trim().length > 0;
  }
  function checkinValid() {
    if (isEdit || type !== 'habit') return true;
    // "Weekdays" with nothing ticked can't build a recurrence, and a habit
    // without one can't carry a streak — block the submit rather than
    // quietly falling back to a cadence the user didn't choose.
    return (
      starterTitle.trim().length > 0 &&
      buildRecurrence(checkinChoice, checkinWeekdays, checkinEveryN, '') !== undefined
    );
  }
  function stagesValid() {
    return type !== 'milestone' || stages.length === 0 || stages.length >= 2;
  }
  function canSubmit() {
    return validTitle() && targetValid() && unitValid() && checkinValid() && stagesValid();
  }

  function handleSubmit() {
    if (!canSubmit()) return;

    if (isEdit && goal) {
      const patch: EditGoalPatch = { name: name.trim(), icon };
      if (type === 'savings' || type === 'indirect') {
        if (targetValue.trim()) patch.targetValue = Number(targetValue);
        patch.deadline = deadline || undefined;
      }
      if (type === 'indirect' && !unitLocked) patch.unit = unit.trim();
      if (type === 'milestone') {
        patch.stages = stages.map((s) => s.title.trim());
        patch.stagePlans = stages.map((s, i) => (i <= activeStageIndex ? [] : s.tasks.map(toPlannedTask)));
      }
      editGoal.mutate({ id: goal.id, patch }, { onSuccess: onClose });
      return;
    }

    const params: CreateGoalParams = { type, name: name.trim(), icon };
    if (type === 'savings') {
      params.currency = currency.trim() || '$';
      params.targetValue = Number(targetValue);
      if (deadline) params.deadline = deadline;
      if (starterTitle.trim()) {
        params.starterTasks = [
          {
            title: starterTitle.trim(),
            ...(starterDaily ? { recurrence: { freq: 'daily' as const } } : {}),
            ...(starterContribution.trim() ? { contribution: Number(starterContribution) } : {}),
          },
        ];
      }
    } else if (type === 'habit') {
      // A habit's check-in MUST repeat — the streak counts that task, and the
      // server rejects a one-off outright. buildRecurrence returns undefined
      // for an incomplete choice (e.g. "Weekdays" with nothing ticked), which
      // canSubmit() already blocks, so the daily fallback here is a
      // belt-and-braces guard against ever sending a bare task, never a
      // silent substitution of a cadence the user didn't pick.
      params.starterTasks = [
        {
          title: starterTitle.trim(),
          recurrence: buildRecurrence(checkinChoice, checkinWeekdays, checkinEveryN, '') ?? { freq: 'daily' },
        },
      ];
    } else if (type === 'indirect') {
      params.unit = unit.trim();
      if (targetValue.trim()) {
        params.targetValue = Number(targetValue);
        if (deadline) params.deadline = deadline;
      }
      if (starterTitle.trim()) {
        params.starterTasks = [
          { title: starterTitle.trim(), ...(starterDaily ? { recurrence: { freq: 'daily' as const } } : {}) },
        ];
      }
    } else {
      if (stages.length >= 2) params.stages = stages.map((s) => s.title.trim());
      const firstStageTasks = stages[0]?.tasks.map(toPlannedTask) ?? [];
      if (firstStageTasks.length) params.starterTasks = firstStageTasks;
      const laterPlans = stages.slice(1).map((s) => s.tasks.map(toPlannedTask));
      if (laterPlans.some((p) => p.length)) params.stagePlans = [[], ...laterPlans];
    }
    setFormError(null);
    createGoal.mutate(params, {
      onSuccess: onClose,
      onError: (err) => {
        const limit = asLimitReached(err);
        setFormError(limit ? limitReachedMessage(limit) : "Couldn't create that — try again.");
      },
    });
  }

  return (
    <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" style={{ maxHeight: '100%' }}>
      <FieldLabel>NAME</FieldLabel>
      <TextInput
        value={name}
        onChangeText={setName}
        placeholder={
          type === 'savings' ? 'Rave savings' : type === 'habit' ? 'Daily meditation' : type === 'indirect' ? 'Track my weight' : 'Land an internship'
        }
        placeholderTextColor={theme.faint}
        style={styles.input}
      />

      {/* Type is locked once editing an existing goal — savings/habit/
          indirect/milestone are different discriminated shapes server-side,
          so changing an existing goal's type isn't a supported edit; only
          create lets you pick. */}
      {!isEdit && (
        <>
          <FieldLabel>TYPE</FieldLabel>
          <View style={styles.chipRow}>
            {TYPE_OPTIONS.map((opt) => (
              <Chip key={opt.type} label={opt.label} icon={opt.icon} selected={type === opt.type} onPress={() => setType(opt.type)} />
            ))}
          </View>
        </>
      )}

      <FieldLabel>ICON</FieldLabel>
      <View style={styles.chipRow}>
        {ICON_OPTIONS.map((n) => (
          <Pressable
            key={n}
            onPress={() => {
              haptic();
              setIcon(n);
            }}
            style={[styles.iconChip, icon === n && styles.iconChipSelected]}
          >
            <Icon name={n} size={18} color={icon === n ? theme.blue : theme.dim} />
          </Pressable>
        ))}
      </View>

      {type === 'savings' && (
        <>
          <View style={styles.row}>
            <View style={{ flex: 1 }}>
              <FieldLabel>CURRENCY</FieldLabel>
              <TextInput value={currency} onChangeText={setCurrency} placeholder="$" placeholderTextColor={theme.faint} style={styles.input} />
            </View>
            <View style={{ flex: 2 }}>
              <FieldLabel>TARGET</FieldLabel>
              <TextInput
                value={targetValue}
                onChangeText={setTargetValue}
                keyboardType="decimal-pad"
                placeholder="500"
                placeholderTextColor={theme.faint}
                style={styles.input}
              />
            </View>
          </View>
          <DeadlineField deadline={deadline} open={deadlinePickerOpen} setOpen={setDeadlinePickerOpen} onChange={setDeadline} onClear={() => setDeadline('')} />
        </>
      )}

      {type === 'indirect' && (
        <>
          <FieldLabel>UNIT</FieldLabel>
          {unitLocked ? (
            <>
              <Text style={styles.lockedValue}>{unit}</Text>
              <Text style={styles.hint}>Already has logged entries — the unit can&apos;t change now without relabeling real history.</Text>
            </>
          ) : (
            <TextInput value={unit} onChangeText={setUnit} placeholder="lb, pages, reps…" placeholderTextColor={theme.faint} style={styles.input} />
          )}
          <FieldLabel>TARGET (OPTIONAL)</FieldLabel>
          <TextInput
            value={targetValue}
            onChangeText={setTargetValue}
            keyboardType="decimal-pad"
            placeholder="Just tracking it is fine too"
            placeholderTextColor={theme.faint}
            style={styles.input}
          />
          {targetValue.trim().length > 0 && (
            <DeadlineField deadline={deadline} open={deadlinePickerOpen} setOpen={setDeadlinePickerOpen} onChange={setDeadline} onClear={() => setDeadline('')} />
          )}
        </>
      )}

      {!isEdit && (type === 'savings' || type === 'indirect') && (
        <>
          <FieldLabel>{type === 'savings' ? 'STARTER TASK (OPTIONAL)' : 'SUPPORTING TASK (OPTIONAL)'}</FieldLabel>
          <TextInput
            value={starterTitle}
            onChangeText={setStarterTitle}
            placeholder={type === 'savings' ? 'Save $5' : 'Go for a run'}
            placeholderTextColor={theme.faint}
            style={styles.input}
          />
          {starterTitle.trim().length > 0 && (
            <View style={[styles.chipRow, { marginTop: 8 }]}>
              <Chip label="Repeats daily" selected={starterDaily} onPress={() => setStarterDaily((d) => !d)} />
              {type === 'savings' && (
                <View style={styles.inlineAmount}>
                  <Text style={styles.inlineAmountLabel}>{currency}</Text>
                  <TextInput
                    value={starterContribution}
                    onChangeText={setStarterContribution}
                    keyboardType="decimal-pad"
                    placeholder="5 / completion"
                    placeholderTextColor={theme.faint}
                    style={styles.inlineAmountInput}
                  />
                </View>
              )}
            </View>
          )}
        </>
      )}

      {!isEdit && type === 'habit' && (
        <>
          <FieldLabel>CHECK-IN TASK</FieldLabel>
          <Text style={styles.hint}>This repeating task IS the check-in — completing it counts toward the streak.</Text>
          <TextInput
            value={starterTitle}
            onChangeText={setStarterTitle}
            placeholder="Meditate 10 min"
            placeholderTextColor={theme.faint}
            style={styles.input}
          />
          <FieldLabel>HOW OFTEN</FieldLabel>
          <RecurrenceField
            choice={checkinChoice}
            weekdays={checkinWeekdays}
            everyN={checkinEveryN}
            onChoiceChange={setCheckinChoice}
            onWeekdaysChange={setCheckinWeekdays}
            onEveryNChange={setCheckinEveryN}
            allowNever={false}
          />
        </>
      )}

      {type === 'milestone' && (
        <>
          <FieldLabel>{`STAGES${isEdit ? '' : ' (OPTIONAL — LEAVE BLANK TO ADD LATER)'}`}</FieldLabel>
          {stages.length === 0 && <Text style={styles.hint}>No stages yet — add at least 2 to build the sequence.</Text>}
          <View style={{ gap: 10 }}>
            {stages.map((stage, i) => (
              <StageRow
                key={stage.id}
                stage={stage}
                index={i}
                isLast={i === stages.length - 1}
                locked={isEdit && i < activeStageIndex}
                active={isEdit ? i === activeStageIndex : i === 0}
                onRename={(t) => renameStage(stage.id, t)}
                onRemove={isEdit && i <= activeStageIndex ? undefined : () => removeStage(stage.id)}
                onMoveUp={isEdit && i <= activeStageIndex ? undefined : () => moveStage(i, -1)}
                onMoveDown={isEdit && i < activeStageIndex ? undefined : () => moveStage(i, 1)}
                onAddTask={(title) => addStageTask(stage.id, title)}
                onRemoveTask={(taskId) => removeStageTask(stage.id, taskId)}
                onToggleTaskDaily={(taskId) => toggleStageTaskDaily(stage.id, taskId)}
              />
            ))}
          </View>
          {stages.length < MAX_STAGES && (
            <View style={styles.addStageRow}>
              <TextInput
                value={newStageTitle}
                onChangeText={setNewStageTitle}
                placeholder="Add a stage"
                placeholderTextColor={theme.faint}
                style={[styles.input, { flex: 1 }]}
                onSubmitEditing={addStage}
              />
              <Pressable onPress={addStage} style={styles.addStageBtn} hitSlop={8}>
                <Icon name="plus" size={16} color={theme.blue} stroke={2.2} />
              </Pressable>
            </View>
          )}
        </>
      )}

      {formError && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{formError}</Text>
          {asLimitReached(createGoal.error) && (
            <Text style={styles.upgradeLink} onPress={() => router.push('/paywall')}>
              Upgrade to Meroa Plus →
            </Text>
          )}
        </View>
      )}

      <PrimaryButton
        label={submitting ? 'Saving…' : isEdit ? 'Save changes' : 'Create goal'}
        onPress={canSubmit() ? handleSubmit : undefined}
        style={{ marginTop: 20, marginBottom: 4, opacity: canSubmit() && !submitting ? 1 : 0.5 }}
      />
    </ScrollView>
  );
}

function StageRow({
  stage,
  index,
  isLast,
  locked,
  active,
  onRename,
  onRemove,
  onMoveUp,
  onMoveDown,
  onAddTask,
  onRemoveTask,
  onToggleTaskDaily,
}: {
  stage: StageDraft;
  index: number;
  isLast: boolean;
  locked: boolean;
  active: boolean;
  onRename: (title: string) => void;
  onRemove?: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onAddTask: (title: string) => void;
  onRemoveTask: (taskId: number) => void;
  onToggleTaskDaily: (taskId: number) => void;
}) {
  const [taskDraft, setTaskDraft] = useState('');
  // The active stage's tasks are real ApiTasks (edited from the Tasks tab or
  // the goal detail screen), never a plan — no nested task list here for it,
  // matching the server invariant that stagePlans has nothing at i <= active.
  const showTaskList = !active;

  return (
    <View style={styles.stageCard}>
      <View style={styles.stageHeaderRow}>
        <View style={[styles.stageBadge, active && styles.stageBadgeActive]}>
          <Text style={[styles.stageBadgeText, active && styles.stageBadgeTextActive]}>{index + 1}</Text>
        </View>
        <TextInput
          value={stage.title}
          onChangeText={onRename}
          editable={!locked}
          style={[styles.stageInput, locked && { color: theme.faint }]}
          placeholder={`Stage ${index + 1}`}
          placeholderTextColor={theme.faint}
        />
        {(onMoveUp || onMoveDown) && (
          <View style={{ flexDirection: 'row' }}>
            <Pressable onPress={onMoveUp} disabled={index === 0} hitSlop={6} style={styles.stageArrow}>
              <Icon name="chevron" size={14} color={index === 0 ? theme.faint : theme.dim} stroke={2} />
            </Pressable>
            <Pressable onPress={onMoveDown} disabled={isLast} hitSlop={6} style={[styles.stageArrow, { transform: [{ rotate: '180deg' }] }]}>
              <Icon name="chevron" size={14} color={isLast ? theme.faint : theme.dim} stroke={2} />
            </Pressable>
          </View>
        )}
        {onRemove && (
          <Pressable onPress={onRemove} hitSlop={6} style={styles.removeBtn}>
            <Icon name="ellipsis" size={16} color={theme.faint} />
          </Pressable>
        )}
      </View>

      {active && <Text style={styles.stageNote}>Active — its tasks are real tasks.</Text>}
      {locked && !active && <Text style={styles.stageNote}>Already complete — name only.</Text>}

      {showTaskList && (
        <View style={{ gap: 6, marginTop: 4 }}>
          {stage.tasks.map((t) => (
            <View key={t.id} style={styles.stageTaskRow}>
              <Text style={styles.stageTaskTitle} numberOfLines={1}>
                {t.title}
              </Text>
              <Pressable onPress={() => onToggleTaskDaily(t.id)} hitSlop={6}>
                <Text style={[styles.stageTaskDaily, t.daily && { color: theme.blue }]}>daily</Text>
              </Pressable>
              <Pressable onPress={() => onRemoveTask(t.id)} hitSlop={6}>
                <Icon name="ellipsis" size={14} color={theme.faint} />
              </Pressable>
            </View>
          ))}
          {stage.tasks.length < MAX_STAGE_TASKS && (
            <TextInput
              value={taskDraft}
              onChangeText={setTaskDraft}
              placeholder={active ? 'Add a task for this stage' : 'Plan a task for later'}
              placeholderTextColor={theme.faint}
              style={styles.stageTaskInput}
              onSubmitEditing={() => {
                onAddTask(taskDraft);
                setTaskDraft('');
              }}
              returnKeyType="done"
            />
          )}
        </View>
      )}
    </View>
  );
}

function DeadlineField({
  deadline,
  open,
  setOpen,
  onChange,
  onClear,
}: {
  deadline: string;
  open: boolean;
  setOpen: Dispatch<SetStateAction<boolean>>;
  onChange: (iso: string) => void;
  onClear: () => void;
}) {
  return (
    <>
      <FieldLabel>DEADLINE (OPTIONAL)</FieldLabel>
      <View style={styles.chipRow}>
        <Chip label={deadline ? formatIsoDate(deadline) : 'No deadline'} selected={!!deadline} onPress={() => setOpen((o) => !o)} icon="clock" />
        {deadline && <Chip label="Clear" selected={false} onPress={onClear} />}
      </View>
      {open && (
        <DateTimePicker
          value={deadline ? new Date(`${deadline}T00:00:00`) : new Date()}
          mode="date"
          display={Platform.OS === 'ios' ? 'spinner' : 'default'}
          minimumDate={new Date()}
          themeVariant="dark"
          onChange={(_event: DateTimePickerEvent, selected?: Date) => {
            if (Platform.OS === 'android') setOpen(false);
            if (selected) onChange(toIsoDate(selected));
          }}
        />
      )}
    </>
  );
}

function FieldLabel({ children }: { children: string }) {
  return <Text style={styles.fieldLabel}>{children}</Text>;
}

function Chip({
  label,
  icon,
  selected,
  onPress,
  disabled,
}: {
  label: string;
  icon?: IconName;
  selected: boolean;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={() => {
        if (disabled) return;
        haptic();
        onPress();
      }}
      style={[styles.chip, selected && styles.chipSelected, disabled && { opacity: 0.5 }]}
    >
      {icon && <Icon name={icon} size={13} color={selected ? theme.blue : theme.dim} stroke={2} />}
      <Text style={[styles.chipLabel, selected && styles.chipLabelSelected]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  errorBox: { marginTop: 16, gap: 6 },
  errorText: { color: theme.danger, fontSize: 13, textAlign: 'center' },
  upgradeLink: { color: theme.blue, fontSize: 13, fontWeight: '600', textAlign: 'center' },
  fieldLabel: { color: theme.dim, fontSize: 11, fontWeight: '700', letterSpacing: 1, marginTop: 18, marginBottom: 8 },
  hint: { color: theme.faint, fontSize: 12, marginTop: -2, marginBottom: 8, lineHeight: 16 },
  lockedValue: { color: theme.text, fontSize: 15, paddingVertical: 4 },
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
  removeBtn: { padding: 6 },
  inlineAmount: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  inlineAmountLabel: { color: theme.dim, fontSize: 14 },
  inlineAmountInput: {
    color: theme.text,
    fontSize: 14,
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: theme.surface,
    borderRadius: radii.controlTight,
    borderWidth: 1,
    borderColor: theme.border,
    minWidth: 90,
  },
  addStageRow: { flexDirection: 'row', gap: 8, alignItems: 'center', marginTop: 10 },
  addStageBtn: {
    width: 40,
    height: 40,
    borderRadius: radii.controlTight,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.border,
  },
  stageCard: {
    backgroundColor: theme.surface,
    borderRadius: radii.controlTight,
    borderWidth: 1,
    borderColor: theme.border,
    padding: 10,
    gap: 6,
  },
  stageHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  stageBadge: {
    width: 22,
    height: 22,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.card2,
  },
  stageBadgeActive: { backgroundColor: 'rgba(10,132,255,0.2)' },
  stageBadgeText: { color: theme.dim, fontSize: 11, fontWeight: '700' },
  stageBadgeTextActive: { color: theme.blue },
  stageInput: { flex: 1, color: theme.text, fontSize: 14, fontWeight: '600', paddingVertical: 4 },
  stageArrow: { padding: 4 },
  stageNote: { color: theme.faint, fontSize: 11, marginLeft: 30 },
  stageTaskRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginLeft: 30,
    paddingVertical: 4,
  },
  stageTaskTitle: { color: theme.text, fontSize: 13, flex: 1 },
  stageTaskDaily: { color: theme.faint, fontSize: 11, fontWeight: '600' },
  stageTaskInput: {
    marginLeft: 30,
    color: theme.text,
    fontSize: 13,
    paddingHorizontal: 10,
    paddingVertical: 7,
    backgroundColor: theme.card2,
    borderRadius: radii.chip,
    borderWidth: 1,
    borderColor: theme.border,
  },
});
