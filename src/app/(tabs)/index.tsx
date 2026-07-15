import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import { AnimatedPressable, useTapFeedback } from '@/components/AnimatedPressable';
import { Bubble } from '@/components/Bubble';
import { Icon } from '@/components/Icon';
import { MeroaMark, type MeroaMood } from '@/components/MeroaMark';
import { ANIM_DURATION } from '@/components/Sheet';
import { TaskCard } from '@/components/TaskCard';
import { radii, theme } from '@/constants/theme';
import { ChatMenuSheet } from '@/features/chat/ChatMenuSheet';
import { type ChatMessage, useMessages, useSendMessage } from '@/features/chat/queries';
import {
  useBulkDeleteTasks,
  useCompleteTask,
  useCreateTaskFromPreview,
  useDeleteTask,
  useProgressTask,
  useTasks,
} from '@/features/tasks/queries';
import { useAdvanceGoalStage, useCreateGoalFromPreview, useGoalConsistency, useGoals } from '@/features/goals/queries';
import { useMe } from '@/features/profile/queries';
import { VibePickerSheet } from '@/features/profile/VibePickerSheet';
import { vibeLabel } from '@/features/profile/vibes';
import { useTabBarHeight } from '@/hooks/use-tab-bar-inset';
import type { AdvanceStageProposal, ApiTask, CreateTaskInput, GoalPreview, StarterTask } from '@/lib/api/types';
import { formatMoney } from '@/lib/format';
import { toIconName } from '@/lib/icon';
import { requestNotificationPermission } from '@/lib/notifications';

// Must match the server's `sendSchema` max (server/src/routes/messages.ts) —
// otherwise an over-limit send round-trips to a 400, gets marked "failed",
// and retry just resends the identical text into the same 400 forever.
const MAX_MESSAGE_LENGTH = 4000;

// Bubbles more than a minute apart read as separate turns even if the
// sender didn't change — a stack shouldn't span a real gap in the
// conversation.
const GROUP_GAP_MS = 60_000;

function isCardMessage(m: ChatMessage): boolean {
  return m.role === 'assistant' && typeof m.meta?.kind === 'string' && m.meta.kind.length > 0;
}

/**
 * iMessage-style stacking (CLAUDE.md §5): consecutive plain-text bubbles
 * from the same sender, close together in time, form one visual group —
 * only the group's last bubble gets the tail corner, only its first gets
 * the full gap above it. Cards, a role change, or a real time gap always
 * break a group. A streaming placeholder deliberately counts as "same
 * sender, no gap" so the tail on the bubble above it doesn't pop in only to
 * disappear the instant the next segment starts arriving.
 */
function computeGroupFlags(messages: ChatMessage[]): Map<string, { isFirst: boolean; isLast: boolean }> {
  const flags = new Map<string, { isFirst: boolean; isLast: boolean }>();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (isCardMessage(m)) continue;
    const prev = messages[i - 1];
    const next = messages[i + 1];
    const gapFrom = (a: ChatMessage, b: ChatMessage) =>
      Math.abs(new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()) > GROUP_GAP_MS;
    const isFirst = !prev || prev.role !== m.role || isCardMessage(prev) || gapFrom(prev, m);
    const isLast = !next || next.role !== m.role || isCardMessage(next) || gapFrom(m, next);
    flags.set(m.id, { isFirst, isLast });
  }
  return flags;
}

function TypingDots() {
  const d1 = useSharedValue(0.3);
  const d2 = useSharedValue(0.3);
  const d3 = useSharedValue(0.3);

  useEffect(() => {
    const loop = () =>
      withRepeat(
        withSequence(withTiming(1, { duration: 350 }), withTiming(0.3, { duration: 350 })),
        -1,
      );
    d1.value = loop();
    d2.value = withSequence(withTiming(0.3, { duration: 120 }), loop());
    d3.value = withSequence(withTiming(0.3, { duration: 240 }), loop());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const s1 = useAnimatedStyle(() => ({ opacity: d1.value }));
  const s2 = useAnimatedStyle(() => ({ opacity: d2.value }));
  const s3 = useAnimatedStyle(() => ({ opacity: d3.value }));

  return (
    <View style={{ flexDirection: 'row', justifyContent: 'flex-start', marginVertical: 3 }}>
      <View style={styles.typingBubble}>
        <Animated.View style={[styles.typingDot, s1]} />
        <Animated.View style={[styles.typingDot, s2]} />
        <Animated.View style={[styles.typingDot, s3]} />
      </View>
    </View>
  );
}

// The task card in a chat reply is a view of the same record as the Tasks
// tab (CLAUDE.md §2) — it resolves live state from the tasks query by id so
// completing it elsewhere updates the card here too, falling back to the
// meta snapshot taken at creation time only if that task can't be found
// (e.g. history loaded before the tasks query has settled).
function TaskActionCard({ message }: { message: ChatMessage }) {
  const { data: tasks } = useTasks();
  const completeTask = useCompleteTask();
  const progressTask = useProgressTask();

  const taskId = message.meta.taskId as string | undefined;
  const snapshot = message.meta.task as ApiTask | undefined;
  const task = tasks?.find((t) => t.id === taskId) ?? snapshot;
  // The one thing the card can't show about itself: the goal impact and the
  // history fact ("Auto-logged $5 to \"New bike\" — now $5 / $300. That's your
  // 4th time this week."). Server-computed, so it can't be wrong — and a
  // successful action turn no longer writes any prose at all, so without this
  // the fact would simply be lost.
  const detail = message.meta.detail as string | undefined;
  if (!task) return null;

  return (
    <View style={styles.actionCard}>
      <TaskCard
        task={task}
        onToggleComplete={() => completeTask.mutate({ id: task.id })}
        onCounterIncrement={() =>
          progressTask.mutate({ id: task.id, input: { kind: 'counter_increment' } })
        }
        onCounterDecrement={() =>
          progressTask.mutate({ id: task.id, input: { kind: 'counter_increment', amount: -1 } })
        }
        onTimerStart={() => {
          void requestNotificationPermission();
          progressTask.mutate({ id: task.id, input: { kind: 'duration_start' } });
        }}
        onTimerStop={() => progressTask.mutate({ id: task.id, input: { kind: 'duration_stop' } })}
        onDurationReopen={() => progressTask.mutate({ id: task.id, input: { kind: 'reopen' } })}
        onToggleItem={(itemId) =>
          progressTask.mutate({ id: task.id, input: { kind: 'checklist_toggle', itemId } })
        }
      />
      {detail ? <Text style={styles.actionDetail}>{detail}</Text> : null}
    </View>
  );
}

// remove_task never deletes on its own — the AI asks, this card shows the
// real task, and only a tap on Delete actually removes it (via the same
// REST endpoint the Tasks tab's swipe-to-delete uses). If the task is no
// longer in the live list (deleted from here, or from elsewhere), the card
// just reflects that instead of asking again.
function TaskRemovalConfirmCard({ message }: { message: ChatMessage }) {
  const { data: tasks } = useTasks();
  const deleteTask = useDeleteTask();
  const [dismissed, setDismissed] = useState(false);

  const taskId = message.meta.taskId as string | undefined;
  const snapshot = message.meta.task as ApiTask | undefined;
  const liveTask = tasks?.find((t) => t.id === taskId);
  const task = liveTask ?? snapshot;
  if (!task) return null;

  const alreadyRemoved = !liveTask;
  const statusText = alreadyRemoved ? 'Removed' : dismissed ? "Kept — didn't delete it" : 'Delete this task?';

  return (
    <View style={styles.actionCard}>
      <View style={styles.removalRow}>
        <View style={styles.removalIconChip}>
          <Icon name={toIconName(task.icon)} size={18} color={theme.dim} stroke={1.9} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.removalTitle} numberOfLines={1}>
            {task.title}
          </Text>
          <Text style={styles.removalStatus}>{statusText}</Text>
        </View>
      </View>
      {!alreadyRemoved && !dismissed && (
        <View style={styles.removalButtons}>
          <Pressable onPress={() => setDismissed(true)} style={styles.removalCancelButton} hitSlop={4}>
            <Text style={styles.removalCancelText}>Keep it</Text>
          </Pressable>
          <Pressable
            onPress={() => {
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
              deleteTask.mutate(task.id);
            }}
            style={styles.removalConfirmButton}
            hitSlop={4}
          >
            <Icon name="trash" size={14} color="#fff" stroke={2.2} />
            <Text style={styles.removalConfirmText}>Delete</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

// remove_tasks' bulk sibling — one card, one Confirm, for the whole batch
// (POST /tasks/bulk-remove), instead of one remove_task card per task. Any
// task already removed elsewhere by the time this renders is just dropped
// from the "still here" set rather than blocking the rest.
function TaskBulkRemovalConfirmCard({ message }: { message: ChatMessage }) {
  const { data: tasks } = useTasks();
  const bulkDeleteTasks = useBulkDeleteTasks();
  const [dismissed, setDismissed] = useState(false);

  const snapshot = (message.meta.tasks as ApiTask[] | undefined) ?? [];
  const liveIds = new Set(tasks?.map((t) => t.id) ?? []);
  const stillLive = snapshot.filter((t) => liveIds.has(t.id));
  if (snapshot.length === 0) return null;

  const allRemoved = stillLive.length === 0;
  const statusText = allRemoved
    ? 'Removed'
    : dismissed
      ? "Kept — didn't delete them"
      : `Delete these ${snapshot.length} tasks?`;
  const titleList = snapshot.map((t) => t.title).join(', ');

  return (
    <View style={styles.actionCard}>
      <View style={styles.removalRow}>
        <View style={styles.removalIconChip}>
          <Icon name="trash" size={18} color={theme.dim} stroke={1.9} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.removalTitle} numberOfLines={2}>
            {titleList}
          </Text>
          <Text style={styles.removalStatus}>{statusText}</Text>
        </View>
      </View>
      {!allRemoved && !dismissed && (
        <View style={styles.removalButtons}>
          <Pressable onPress={() => setDismissed(true)} style={styles.removalCancelButton} hitSlop={4}>
            <Text style={styles.removalCancelText}>Keep them</Text>
          </Pressable>
          <Pressable
            onPress={() => {
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
              // Only ids still actually present — one already gone (removed
              // elsewhere between this card rendering and the tap) would
              // otherwise fail the whole batch inside the server's single
              // transaction and silently leave everyone else undeleted too.
              bulkDeleteTasks.mutate(stillLive.map((t) => t.id));
            }}
            style={styles.removalConfirmButton}
            hitSlop={4}
          >
            <Icon name="trash" size={14} color="#fff" stroke={2.2} />
            <Text style={styles.removalConfirmText}>Delete all</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

// create_goal never saves anything by itself — this card's Create tap is
// the only confirmation (docs/goals-redesign-plan.md §2.1). "Not now" is
// client-local only, matching TaskRemovalConfirmCard's "Keep it".
function describeStarterTaskRecurrence(recurrence: StarterTask['recurrence']): string {
  if (!recurrence) return '';
  if (recurrence.freq === 'daily') return ' · daily';
  if (recurrence.freq === 'weekly') return ` · weekly on ${recurrence.byWeekday.join(',')}`;
  return ` · every ${recurrence.n} days`;
}

function describeTaskPreviewFields(preview: CreateTaskInput): string[] {
  const lines: string[] = [];
  if (preview.type === 'counter') lines.push(`Target: ${preview.target}${preview.unit ? ` ${preview.unit}` : ''}`);
  else if (preview.type === 'duration') lines.push(`Target: ${preview.targetMinutes} min`);
  else if (preview.type === 'checklist') lines.push(`${preview.items.length} item${preview.items.length === 1 ? '' : 's'}`);
  if (preview.recurrence) lines.push(`Repeats${describeStarterTaskRecurrence(preview.recurrence)}`);
  else if (preview.dueAt) {
    const due = new Date(preview.dueAt);
    lines.push(`Due ${due.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} at ${due.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`);
  }
  return lines;
}

// prefs.confirmBeforeCreate's card — chat-only, same preview-then-tap shape
// as GoalPreviewCard just below, for a task instead of a goal.
function TaskPreviewCard({ message }: { message: ChatMessage }) {
  const createTaskFromPreview = useCreateTaskFromPreview();
  const { data: liveTasks } = useTasks();
  const [dismissed, setDismissed] = useState(false);

  const preview = message.meta.preview as CreateTaskInput | undefined;
  if (!preview) return null;

  const createdTaskId =
    createTaskFromPreview.data?.task.id ?? (message.meta.createdTaskId as string | undefined);
  const created = !!createdTaskId;
  const createdButRemoved = created && !!liveTasks && !liveTasks.some((t) => t.id === createdTaskId);

  const statusText = created
    ? createdButRemoved
      ? 'Created — since removed'
      : 'Created ✓'
    : dismissed
      ? 'Not saved'
      : 'Create this task?';

  return (
    <View style={styles.actionCard}>
      <View style={styles.removalRow}>
        <View style={styles.removalIconChip}>
          <Icon name={toIconName(preview.icon)} size={18} color={theme.blue} stroke={1.9} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.removalTitle} numberOfLines={1}>
            {preview.title}
          </Text>
          <Text style={styles.removalStatus}>{statusText}</Text>
        </View>
      </View>
      <View style={styles.previewBody}>
        {describeTaskPreviewFields(preview).map((line, idx) => (
          <Text key={idx} style={styles.previewFields}>
            {line}
          </Text>
        ))}
      </View>
      {!created && !dismissed && (
        <View style={styles.removalButtons}>
          <Pressable onPress={() => setDismissed(true)} style={styles.removalCancelButton} hitSlop={4}>
            <Text style={styles.removalCancelText}>Not now</Text>
          </Pressable>
          <Pressable
            onPress={() => {
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
              createTaskFromPreview.mutate(message.id);
            }}
            style={styles.previewConfirmButton}
            hitSlop={4}
          >
            <Icon name="check" size={14} color="#fff" stroke={2.2} />
            <Text style={styles.removalConfirmText}>Create</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

function GoalPreviewCard({ message }: { message: ChatMessage }) {
  const createGoalFromPreview = useCreateGoalFromPreview();
  const { data: liveGoals } = useGoals();
  const [dismissed, setDismissed] = useState(false);

  const preview = message.meta.preview as GoalPreview | undefined;
  if (!preview) return null;

  // The handoff caption the card can't compute itself — "open in Goals to
  // add your stages" for a bare milestone template, or how many stages are
  // already set (docs/goal-manual-editing-plan.md §3.4). Server-computed,
  // same pattern as TaskActionCard's meta.detail.
  const detail = message.meta.detail as string | undefined;
  const definition = preview.definition;
  const createdGoalId =
    createGoalFromPreview.data?.goal.id ?? (message.meta.createdGoalId as string | undefined);
  const created = !!createdGoalId;
  // A goal created from this card can have been removed/undone since — the
  // card shouldn't keep saying "Created ✓" about a goal that no longer
  // exists. Only downgraded once the live list has actually loaded and the
  // id is genuinely absent (POST /goals stays strictly idempotent
  // server-side either way — one preview never creates twice).
  const createdButRemoved = created && !!liveGoals && !liveGoals.some((g) => g.id === createdGoalId);

  // A habit has no target amount or deadline — the check-in task + streak is
  // the whole mechanic, and the card says so instead of faking numbers. An
  // indirect goal has no target either unless the user actually stated one —
  // "just track it" is a complete goal on its own. A milestone goal has no
  // number at all — its stage list renders separately below instead of a
  // single Target line.
  const isSavings = definition.type === 'savings';
  const isIndirect = definition.type === 'indirect';
  const isMilestone = definition.type === 'milestone';
  const targetLine = isSavings
    ? `Target: ${definition.currency}${formatMoney(definition.targetValue)}`
    : isIndirect
      ? definition.targetValue !== undefined
        ? `Target: ${definition.targetValue}${definition.unit}`
        : `Tracking ${definition.unit} — no target set`
      : isMilestone
        ? null
        : 'Habit — daily check-ins build the streak';
  const deadlineLine = (isSavings || isIndirect) && definition.deadline ? `By ${definition.deadline}` : null;
  const starterTasks = preview.starterTasks ?? [];

  const statusText = created
    ? createdButRemoved
      ? 'Created — since removed'
      : 'Created ✓'
    : dismissed
      ? 'Not saved'
      : 'Create this goal?';

  return (
    <View style={styles.actionCard}>
      <View style={styles.removalRow}>
        <View style={styles.removalIconChip}>
          <Icon name={toIconName(preview.icon)} size={18} color={theme.blue} stroke={1.9} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.removalTitle} numberOfLines={1}>
            {preview.name}
          </Text>
          <Text style={styles.removalStatus}>{statusText}</Text>
        </View>
      </View>
      <View style={styles.previewBody}>
        {targetLine ? <Text style={styles.previewFields}>{targetLine}</Text> : null}
        {isMilestone &&
          definition.stages.map((stage, idx) => (
            <Text key={idx} style={styles.previewFields}>
              {idx + 1}. {stage}
            </Text>
          ))}
        {deadlineLine ? <Text style={styles.previewFields}>{deadlineLine}</Text> : null}
        {starterTasks.map((task, idx) => (
          <Text key={idx} style={styles.previewFields}>
            ✓ {task.title}
            {isSavings && task.contribution !== undefined
              ? ` — ${definition.currency}${formatMoney(task.contribution)}`
              : ''}
            {describeStarterTaskRecurrence(task.recurrence)}
          </Text>
        ))}
      </View>
      {!created && !dismissed && (
        <View style={styles.removalButtons}>
          <Pressable onPress={() => setDismissed(true)} style={styles.removalCancelButton} hitSlop={4}>
            <Text style={styles.removalCancelText}>Not now</Text>
          </Pressable>
          <Pressable
            onPress={() => {
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
              createGoalFromPreview.mutate(message.id);
            }}
            style={styles.previewConfirmButton}
            hitSlop={4}
          >
            <Icon name="check" size={14} color="#fff" stroke={2.2} />
            <Text style={styles.removalConfirmText}>Create</Text>
          </Pressable>
        </View>
      )}
      {detail ? <Text style={styles.actionDetail}>{detail}</Text> : null}
    </View>
  );
}

// Resolves the live goal by id (falls back to the meta snapshot, same
// The remember tool's card — a static snapshot, not a live view (unlike
// TaskActionCard/GoalActionCard): a memory has no live record to re-fetch
// by id, so it just shows what meta.memory captured at write time. Editing
// or deleting it happens in the You tab's memory screen, not from here.
function MemoryActionCard({ message }: { message: ChatMessage }) {
  const memory = message.meta.memory as { kind: string; content: string } | undefined;
  if (!memory) return null;

  return (
    <View style={styles.actionCard}>
      <View style={styles.removalRow}>
        <View style={styles.removalIconChip}>
          <Icon name="book" size={18} color={theme.blue} stroke={1.9} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.removalTitle} numberOfLines={2}>
            {memory.content}
          </Text>
          <Text style={styles.removalStatus} numberOfLines={1}>
            Remembered
          </Text>
        </View>
      </View>
    </View>
  );
}

// live-view-of-the-record pattern as TaskActionCard) — the summary sentence
// itself already states the concrete post-action fact (docs/ai-reliability-
// hardening.md lesson 16), so it's shown directly rather than re-derived.
function GoalActionCard({ message }: { message: ChatMessage }) {
  const { data: goals } = useGoals();
  const goalId = message.meta.goalId as string | undefined;
  const snapshot = message.meta.goal as { name: string; icon: string | null } | undefined;
  const goal = goals?.find((g) => g.id === goalId) ?? snapshot;
  if (!goal) return null;

  return (
    <View style={styles.actionCard}>
      <View style={styles.removalRow}>
        <View style={styles.removalIconChip}>
          <Icon name={toIconName(goal.icon)} size={18} color={theme.blue} stroke={1.9} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.removalTitle} numberOfLines={1}>
            {goal.name}
          </Text>
          <Text style={styles.removalStatus} numberOfLines={2}>
            {message.content}
          </Text>
        </View>
      </View>
    </View>
  );
}

// advance_goal_stage never mutates anything by itself — this card's Advance
// tap is the only confirmation (docs/milestone-goal-plan.md §2.1), same
// skeleton as TaskRemovalConfirmCard: shows the real proposal (from -> to
// stage, what retires, what's proposed next), and only a tap actually moves
// the goal (via POST /goals/:id/advance).
function GoalAdvanceConfirmCard({ message }: { message: ChatMessage }) {
  const advanceGoalStage = useAdvanceGoalStage();
  const { data: liveGoals } = useGoals();
  const [dismissed, setDismissed] = useState(false);

  const proposal = message.meta.proposal as AdvanceStageProposal | undefined;
  const snapshot = message.meta.goal as { name: string; icon: string | null } | undefined;
  if (!proposal || !snapshot) return null;

  const liveGoal = liveGoals?.find((g) => g.id === proposal.goalId);
  const liveDefinition = liveGoal?.definition;
  const liveActiveStageIndex =
    liveDefinition?.type === 'milestone' ? liveDefinition.activeStageIndex : undefined;

  const advancedRecordId =
    advanceGoalStage.data?.goal.id ?? (message.meta.advancedRecordId as string | undefined);
  const consumed = !!advancedRecordId;
  // Stale once the live goal has moved off the stage this card showed —
  // another advance, or an undo, since the card was rendered.
  const stale = !consumed && liveActiveStageIndex !== undefined && liveActiveStageIndex !== proposal.fromStageIndex;

  const statusText = consumed
    ? 'Advanced ✓'
    : stale
      ? 'Stale — ask again'
      : dismissed
        ? 'Not yet'
        : proposal.toStage
          ? `Move to "${proposal.toStage}"?`
          : 'Complete this goal?';

  return (
    <View style={styles.actionCard}>
      <View style={styles.removalRow}>
        <View style={styles.removalIconChip}>
          <Icon name={toIconName(snapshot.icon)} size={18} color={theme.blue} stroke={1.9} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.removalTitle} numberOfLines={1}>
            {snapshot.name}
          </Text>
          <Text style={styles.removalStatus}>{statusText}</Text>
        </View>
      </View>
      <View style={styles.previewBody}>
        <Text style={styles.previewFields}>
          {proposal.fromStage} → {proposal.toStage ?? 'Complete'}
        </Text>
        {proposal.retire.map((t) => (
          <Text key={t.taskId} style={styles.previewFields}>
            − {t.title}
          </Text>
        ))}
        {proposal.nextStageTasks?.map((t, idx) => (
          <Text key={idx} style={styles.previewFields}>
            + {t.title}
          </Text>
        ))}
      </View>
      {!consumed && !stale && !dismissed && (
        <View style={styles.removalButtons}>
          <Pressable onPress={() => setDismissed(true)} style={styles.removalCancelButton} hitSlop={4}>
            <Text style={styles.removalCancelText}>Not yet</Text>
          </Pressable>
          <Pressable
            onPress={() => {
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
              advanceGoalStage.mutate({ id: proposal.goalId, proposalMessageId: message.id });
            }}
            style={styles.previewConfirmButton}
            hitSlop={4}
          >
            <Icon name="check" size={14} color="#fff" stroke={2.2} />
            <Text style={styles.removalConfirmText}>Advance</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

function MessageRow({
  message,
  onRetry,
  isFirstInGroup = true,
  isLastInGroup = true,
}: {
  message: ChatMessage;
  onRetry: (m: ChatMessage) => void;
  isFirstInGroup?: boolean;
  isLastInGroup?: boolean;
}) {
  const isStreamingEmpty =
    message.role === 'assistant' && message.status === 'streaming' && !message.content;
  if (isStreamingEmpty) return <TypingDots />;

  if (message.role === 'assistant' && message.meta?.kind === 'task_action') {
    return <TaskActionCard message={message} />;
  }
  if (message.role === 'assistant' && message.meta?.kind === 'task_removal_pending') {
    return <TaskRemovalConfirmCard message={message} />;
  }
  if (message.role === 'assistant' && message.meta?.kind === 'task_bulk_removal_pending') {
    return <TaskBulkRemovalConfirmCard message={message} />;
  }
  if (message.role === 'assistant' && message.meta?.kind === 'task_creation_pending') {
    return <TaskPreviewCard message={message} />;
  }
  if (message.role === 'assistant' && message.meta?.kind === 'goal_preview') {
    return <GoalPreviewCard message={message} />;
  }
  if (message.role === 'assistant' && message.meta?.kind === 'goal_action') {
    return <GoalActionCard message={message} />;
  }
  if (message.role === 'assistant' && message.meta?.kind === 'goal_advance_pending') {
    return <GoalAdvanceConfirmCard message={message} />;
  }
  if (message.role === 'assistant' && message.meta?.kind === 'memory_action') {
    return <MemoryActionCard message={message} />;
  }

  return (
    <View>
      <Bubble
        from={message.role === 'user' ? 'me' : 'ai'}
        isFirstInGroup={isFirstInGroup}
        isLastInGroup={isLastInGroup}
      >
        {message.content}
      </Bubble>
      {message.status === 'failed' && (
        <Pressable onPress={() => onRetry(message)} style={styles.statusRow} hitSlop={8}>
          <Text style={styles.statusText}>Not delivered · Tap to retry</Text>
        </Pressable>
      )}
      {message.status === 'limit_reached' && (
        <View style={styles.statusRow}>
          <Text style={styles.statusText}>You&apos;ve reached today&apos;s message limit</Text>
        </View>
      )}
    </View>
  );
}

export default function ChatScreen() {
  const { data: messages = [], isLoading } = useMessages();
  const groupFlags = useMemo(() => computeGroupFlags(messages), [messages]);
  // A real state, not decoration: 'streaming' covers the whole round trip
  // from send through the last segment (the same status TypingDots keys off
  // of), so this is never true unless Meroa is actually generating a reply.
  const isReplying = messages.some((m) => m.status === 'streaming');
  const headerStatus = isReplying ? 'Typing…' : 'Listening';
  const { send, retry } = useSendMessage();
  const [draft, setDraft] = useState('');
  const [menuSheetOpen, setMenuSheetOpen] = useState(false);
  const [vibeSheetOpen, setVibeSheetOpen] = useState(false);
  const { data: me } = useMe();
  const communicationStyle = vibeLabel(me?.user.prefs.communicationStyle);
  const scrollRef = useRef<ScrollView>(null);
  const ellipsisFeedback = useTapFeedback();
  const attachFeedback = useTapFeedback();
  const micSendFeedback = useTapFeedback(0.9);
  const tabBarHeight = useTabBarHeight();
  // Mascot-lite reacts here too, not just the Goals tab header
  // (docs/goals-redesign-plan.md §1) — same mood derivation as goals.tsx.
  const { data: consistency } = useGoalConsistency();
  const streakCurrent = consistency?.current ?? 0;
  const streakLongest = consistency?.longest ?? 0;
  const headerMood: MeroaMood =
    streakCurrent >= 3 ? 'warm' : streakCurrent === 0 && streakLongest > 0 ? 'deflated' : 'idle';

  // The first scroll (loading a long history on open) snaps instantly —
  // animating through dozens of bubbles looks like a bug, and a large
  // backlog can retrigger content-size changes mid-animation and settle
  // short of the true bottom. Live messages after that animate normally.
  const hasScrolledInitially = useRef(false);
  const scrollToEnd = () => {
    scrollRef.current?.scrollToEnd({ animated: hasScrolledInitially.current });
    hasScrolledInitially.current = true;
  };

  const lastMessage = messages[messages.length - 1];
  const lastMessageContent = lastMessage?.content;
  useEffect(() => {
    scrollToEnd();
  }, [messages.length, lastMessageContent]);

  // A double-tap can fire before React re-renders to clear the draft and
  // hide the send button, sending the same text twice. This guard collapses
  // that within-the-same-gesture double-fire without blocking a genuinely
  // new message sent while a previous one is still streaming — it releases
  // on the very next tick, not after send() finishes.
  const isSubmittingRef = useRef(false);
  const sendDraft = () => {
    if (isSubmittingRef.current) return;
    const text = draft.trim().slice(0, MAX_MESSAGE_LENGTH);
    if (!text) return;
    isSubmittingRef.current = true;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    setDraft('');
    void send(text);
    setTimeout(() => {
      isSubmittingRef.current = false;
    }, 0);
  };

  const handleRetry = (message: ChatMessage) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    void retry(message);
  };

  // The menu sheet's own close animation has to finish before the next
  // sheet's Modal mounts — matches Sheet.tsx's ANIM_DURATION so this isn't
  // an unexplained magic number duplicated here.
  const openToneFromMenu = () => {
    setMenuSheetOpen(false);
    setTimeout(() => setVibeSheetOpen(true), ANIM_DURATION);
  };
  const openMemoryFromMenu = () => {
    setMenuSheetOpen(false);
    setTimeout(() => router.push('/memories'), ANIM_DURATION);
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <MeroaMark size={26} glow mood={headerMood} />
          <View>
            <Text style={styles.title}>Meroa</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
              <View style={styles.dot} />
              <Text style={styles.subtitle}>{headerStatus}</Text>
            </View>
          </View>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text style={styles.hint}>{communicationStyle}</Text>
          <AnimatedPressable
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
              setMenuSheetOpen(true);
            }}
            onPressIn={ellipsisFeedback.onPressIn}
            onPressOut={ellipsisFeedback.onPressOut}
            style={[styles.iconBtn, ellipsisFeedback.animatedStyle]}
          >
            <Icon name="ellipsis" size={16} color={theme.text} stroke={2.4} />
          </AnimatedPressable>
        </View>
      </View>
      <ChatMenuSheet
        visible={menuSheetOpen}
        onClose={() => setMenuSheetOpen(false)}
        communicationStyle={communicationStyle}
        onSelectTone={openToneFromMenu}
        onSelectMemory={openMemoryFromMenu}
      />
      <VibePickerSheet visible={vibeSheetOpen} onClose={() => setVibeSheetOpen(false)} />

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={80}
      >
        {isLoading ? (
          <View style={styles.loading}>
            <ActivityIndicator color={theme.dim} />
          </View>
        ) : (
          <ScrollView
            ref={scrollRef}
            style={{ flex: 1 }}
            contentContainerStyle={{ padding: 14, paddingBottom: 20 }}
            onContentSizeChange={scrollToEnd}
          >
            <Text style={styles.timestamp}>
              {new Date().toLocaleDateString(undefined, { weekday: 'long' })} ·{' '}
              {new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
            </Text>
            {messages.map((m) => {
              const flags = groupFlags.get(m.id);
              return (
                <MessageRow
                  key={m.id}
                  message={m}
                  onRetry={handleRetry}
                  isFirstInGroup={flags?.isFirst}
                  isLastInGroup={flags?.isLast}
                />
              );
            })}
          </ScrollView>
        )}

        <View style={[styles.composer, { paddingBottom: tabBarHeight + 16 }]}>
          <AnimatedPressable
            onPressIn={attachFeedback.onPressIn}
            onPressOut={attachFeedback.onPressOut}
            style={[styles.composerIcon, attachFeedback.animatedStyle]}
          >
            <Icon name="paperclip" size={20} color={theme.dim} />
          </AnimatedPressable>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder="Message Meroa"
            placeholderTextColor={theme.faint}
            style={styles.input}
            multiline
            maxLength={MAX_MESSAGE_LENGTH}
            onSubmitEditing={sendDraft}
          />
          {draft.trim() ? (
            <AnimatedPressable
              onPress={sendDraft}
              onPressIn={micSendFeedback.onPressIn}
              onPressOut={micSendFeedback.onPressOut}
              style={[styles.composerIcon, styles.sendBtn, micSendFeedback.animatedStyle]}
            >
              <Icon name="send" size={18} color="#fff" stroke={2} />
            </AnimatedPressable>
          ) : (
            <AnimatedPressable
              onPressIn={micSendFeedback.onPressIn}
              onPressOut={micSendFeedback.onPressOut}
              style={[styles.composerIcon, micSendFeedback.animatedStyle]}
            >
              <Icon name="mic" size={20} color={theme.dim} />
            </AnimatedPressable>
          )}
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  actionCard: { marginVertical: 4, alignSelf: 'stretch' },
  actionDetail: {
    color: theme.dim,
    fontSize: 12.5,
    lineHeight: 17,
    paddingHorizontal: 4,
    paddingTop: 6,
  },
  removalRow: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 },
  removalIconChip: {
    width: 34,
    height: 34,
    borderRadius: radii.chip,
    backgroundColor: theme.card2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  removalTitle: { color: theme.text, fontSize: 15, fontWeight: '600' },
  removalStatus: { color: theme.dim, fontSize: 12, marginTop: 2 },
  removalButtons: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 14,
    paddingBottom: 14,
  },
  removalCancelButton: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    borderRadius: radii.controlTight,
    borderWidth: 1,
    borderColor: theme.borderStrong,
  },
  removalCancelText: { color: theme.text, fontSize: 14, fontWeight: '600' },
  removalConfirmButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    borderRadius: radii.controlTight,
    backgroundColor: theme.danger,
  },
  removalConfirmText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  previewBody: { paddingHorizontal: 14, paddingBottom: 10, gap: 2 },
  previewFields: { color: theme.dim, fontSize: 12, lineHeight: 17 },
  previewConfirmButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    borderRadius: radii.controlTight,
    backgroundColor: theme.blue,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingBottom: 12,
    paddingTop: 4,
    borderBottomWidth: 1,
    borderBottomColor: theme.border,
  },
  title: { color: theme.text, fontSize: 16, fontWeight: '700', letterSpacing: -0.2 },
  subtitle: { color: theme.dim, fontSize: 11 },
  hint: { color: theme.dim, fontSize: 12, fontWeight: '600' },
  dot: { width: 6, height: 6, borderRadius: 999, backgroundColor: theme.success },
  iconBtn: {
    width: 32,
    height: 32,
    borderRadius: 999,
    backgroundColor: theme.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  timestamp: { color: theme.faint, fontSize: 11, textAlign: 'center', marginBottom: 8 },
  typingBubble: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: radii.bubble,
    borderBottomLeftRadius: radii.bubbleTail,
    backgroundColor: theme.bubbleAI,
  },
  typingDot: { width: 6, height: 6, borderRadius: 999, backgroundColor: theme.dim },
  statusRow: { alignSelf: 'flex-end', marginRight: 6, marginTop: 2, marginBottom: 4 },
  statusText: { color: theme.faint, fontSize: 11 },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: theme.border,
    backgroundColor: theme.bg,
  },
  composerIcon: {
    width: 36,
    height: 36,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendBtn: {
    backgroundColor: theme.blue,
    shadowColor: theme.blue,
    shadowOpacity: 0.5,
    shadowRadius: 10,
  },
  input: {
    flex: 1,
    minHeight: 36,
    maxHeight: 120,
    color: theme.text,
    fontSize: 15,
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: theme.surface,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: theme.border,
  },
});
