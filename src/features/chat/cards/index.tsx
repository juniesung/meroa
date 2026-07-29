// The chat action/preview cards, extracted from app/(tabs)/index.tsx so both
// the Chat screen and the Tasks/Goals QuickCreateSheet render the SAME cards
// (CLAUDE.md §2: a card is a view of the one record, wherever it's shown).
// Pure move — behavior is unchanged from the original screen. A chat action
// always renders as exactly one of these, resolved by `meta.kind` via the
// CARD_BY_KIND map at the bottom.
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';

import { Icon } from '@/components/Icon';
import { Progress } from '@/components/Progress';
import { Ring } from '@/components/Ring';
import { TaskCard } from '@/components/TaskCard';
import { radii, theme } from '@/constants/theme';
import { banner3dStyle } from '@/lib/banner';
import { goalAccent } from '@/features/goals/goal-accent';
import type { ChatMessage } from '@/features/chat/queries';
import {
  useBulkDeleteTasks,
  useCompleteTask,
  useCreateTaskFromPreview,
  useDeleteTask,
  useProgressTask,
  useTasks,
} from '@/features/tasks/queries';
import { useAdvanceGoalStage, useCreateGoalFromPreview, useGoals } from '@/features/goals/queries';
import { asLimitReached, limitReachedMessage } from '@/lib/api/limits';
import type { AdvanceStageProposal, ApiTask, CreateTaskInput, GoalPreview, StarterTask } from '@/lib/api/types';
import { formatMoney } from '@/lib/format';
import { toIconName } from '@/lib/icon';
import { requestNotificationPermission } from '@/lib/notifications';

// A card's status line ("Create this task?" → "Created ✓") is the confirmation
// surface (CLAUDE.md §4: the card is the confirmation). Keying on the text so a
// change remounts it lets each transition fade-rise in — the moment an action
// lands gets a beat of motion to match its Success haptic, without any prose.
export function CardStatus({ children }: { children: ReactNode }) {
  return (
    <Animated.Text key={String(children)} entering={FadeInDown.duration(200)} style={styles.removalStatus}>
      {children}
    </Animated.Text>
  );
}

// The task card in a chat reply is a view of the same record as the Tasks
// tab (CLAUDE.md §2) — it resolves live state from the tasks query by id so
// completing it elsewhere updates the card here too, falling back to the
// meta snapshot taken at creation time only if that task can't be found
// (e.g. history loaded before the tasks query has settled).
export function TaskActionCard({ message }: { message: ChatMessage }) {
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
export function TaskRemovalConfirmCard({ message }: { message: ChatMessage }) {
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
    <View style={[styles.actionCard, styles.chatCard, banner3dStyle(theme.blue, { tint: theme.card })]}>
      <View style={styles.removalRow}>
        <View style={[styles.removalIconChip, { backgroundColor: theme.blue + '24' }]}>
          <Icon name={toIconName(task.icon)} size={18} color={theme.blue} stroke={1.9} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.removalTitle} numberOfLines={1}>
            {task.title}
          </Text>
          <CardStatus>{statusText}</CardStatus>
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
export function TaskBulkRemovalConfirmCard({ message }: { message: ChatMessage }) {
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
    <View style={[styles.actionCard, styles.chatCard, banner3dStyle(theme.blue, { tint: theme.card })]}>
      <View style={styles.removalRow}>
        <View style={[styles.removalIconChip, { backgroundColor: theme.blue + '24' }]}>
          <Icon name="trash" size={18} color={theme.blue} stroke={1.9} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.removalTitle} numberOfLines={2}>
            {titleList}
          </Text>
          <CardStatus>{statusText}</CardStatus>
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
export function describeStarterTaskRecurrence(recurrence: StarterTask['recurrence']): string {
  if (!recurrence) return '';
  if (recurrence.freq === 'daily') return ' · daily';
  if (recurrence.freq === 'weekly') return ` · weekly on ${recurrence.byWeekday.join(',')}`;
  return ` · every ${recurrence.n} days`;
}

export function describeTaskPreviewFields(preview: CreateTaskInput): string[] {
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
// as GoalPreviewCard just below, for a task instead of a goal. `onCreated`
// fires after a successful Create tap — the QuickCreateSheet uses it to close
// itself; in the chat thread it's unset (the card just settles to "Created ✓").
export function TaskPreviewCard({ message, onCreated }: { message: ChatMessage; onCreated?: () => void }) {
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
    <View style={[styles.actionCard, styles.chatCard, banner3dStyle(theme.blue, { tint: theme.card })]}>
      <View style={styles.removalRow}>
        <View style={[styles.removalIconChip, { backgroundColor: theme.blue + '24' }]}>
          <Icon name={toIconName(preview.icon)} size={18} color={theme.blue} stroke={1.9} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.removalTitle} numberOfLines={1}>
            {preview.title}
          </Text>
          <CardStatus>{statusText}</CardStatus>
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
              createTaskFromPreview.mutate(message.id, { onSuccess: () => onCreated?.() });
            }}
            style={styles.previewConfirmButton}
            hitSlop={4}
          >
            <Icon name="check" size={14} color="#fff" stroke={2.2} />
            <Text style={styles.removalConfirmText}>Create</Text>
          </Pressable>
        </View>
      )}
      {createTaskFromPreview.isError && !created && (
        <PreviewLimitBanner error={createTaskFromPreview.error} />
      )}
    </View>
  );
}

// A TOCTOU edge case (rare — see docs/phase-7 plan): the AI's create_task
// pre-check passes, then the free-plan quota gets used up elsewhere before
// this exact card is tapped. The card can't prevent it, only fail gracefully
// instead of doing nothing on tap.
export function PreviewLimitBanner({ error }: { error: unknown }) {
  const limit = asLimitReached(error);
  return (
    <View style={styles.previewErrorBox}>
      <Text style={styles.previewErrorText}>
        {limit ? limitReachedMessage(limit) : "Couldn't create — try again."}
      </Text>
      {limit?.plan === 'free' && (
        <Text style={styles.previewUpgradeLink} onPress={() => router.push('/paywall')}>
          Subscribe to Meroa →
        </Text>
      )}
    </View>
  );
}

export function GoalPreviewCard({ message, onCreated }: { message: ChatMessage; onCreated?: () => void }) {
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

  const accent = goalAccent(definition.type);
  return (
    <View style={[styles.actionCard, styles.chatCard, banner3dStyle(accent, { tint: theme.card })]}>
      <View style={styles.removalRow}>
        <View style={[styles.removalIconChip, { backgroundColor: accent + '24' }]}>
          <Icon name={toIconName(preview.icon)} size={18} color={accent} stroke={1.9} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.removalTitle} numberOfLines={1}>
            {preview.name}
          </Text>
          <CardStatus>{statusText}</CardStatus>
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
              createGoalFromPreview.mutate(message.id, { onSuccess: () => onCreated?.() });
            }}
            style={[styles.previewConfirmButton, { backgroundColor: accent }]}
            hitSlop={4}
          >
            <Icon name="check" size={14} color="#fff" stroke={2.2} />
            <Text style={styles.removalConfirmText}>Create</Text>
          </Pressable>
        </View>
      )}
      {createGoalFromPreview.isError && !created && (
        <PreviewLimitBanner error={createGoalFromPreview.error} />
      )}
      {detail ? <Text style={styles.actionDetail}>{detail}</Text> : null}
    </View>
  );
}

// The remember tool's card — a static snapshot, not a live view (unlike
// TaskActionCard/GoalActionCard): a memory has no live record to re-fetch
// by id, so it just shows what meta.memory captured at write time. Editing
// or deleting it happens in the You tab's memory screen, not from here.
export function MemoryActionCard({ message }: { message: ChatMessage }) {
  const memory = message.meta.memory as { kind: string; content: string } | undefined;
  if (!memory) return null;

  return (
    <View style={[styles.actionCard, styles.chatCard, banner3dStyle(theme.blue, { tint: theme.card })]}>
      <View style={styles.removalRow}>
        <View style={[styles.removalIconChip, { backgroundColor: theme.blue + '24' }]}>
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

// Resolves the live goal by id (falls back to the meta snapshot, same
// live-view-of-the-record pattern as TaskActionCard) — the summary sentence
// itself already states the concrete post-action fact (docs/ai-reliability-
// hardening.md lesson 16), so it's shown directly rather than re-derived.
export function GoalActionCard({ message }: { message: ChatMessage }) {
  const { data: goals } = useGoals();
  const goalId = message.meta.goalId as string | undefined;
  const snapshot = message.meta.goal as { name: string; icon: string | null } | undefined;
  const liveGoal = goals?.find((g) => g.id === goalId);
  const goal = liveGoal ?? snapshot;
  if (!goal) return null;
  const accent = liveGoal ? goalAccent(liveGoal.definition.type) : theme.blue;

  return (
    <View style={[styles.actionCard, styles.chatCard, banner3dStyle(accent, { tint: theme.card })]}>
      <View style={styles.removalRow}>
        <View style={[styles.removalIconChip, { backgroundColor: accent + '24' }]}>
          <Icon name={toIconName(goal.icon)} size={18} color={accent} stroke={1.9} />
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

// A log_goal_entry put a real number on the board, so the reward lives IN the
// conversation now (WS3): a live progress ring + bar, not just a text line. Like
// GoalActionCard it resolves the goal by id so the ring reflects live state
// (undo/another log updates it here too), reusing the exact Ring/Progress the
// Goals tab renders and the same 0..1 -> 0..100 conversion. The summary sentence
// stays as the caption because it carries what the bar can't — the goal-impact
// and history fact ("that's your 4th time this week"), server-computed.
export function GoalProgressCard({ message }: { message: ChatMessage }) {
  const { data: goals } = useGoals();
  const goalId = message.meta.goalId as string | undefined;
  const snapshot = message.meta.goal as { name: string; icon: string | null } | undefined;
  const liveGoal = goals?.find((g) => g.id === goalId);
  const goal = liveGoal ?? snapshot;
  if (!goal) return null;

  const accent = liveGoal ? goalAccent(liveGoal.definition.type) : theme.blue;
  const pct = liveGoal?.progress != null ? Math.round(liveGoal.progress * 100) : null;
  const headline = liveGoal?.headline;

  return (
    <View style={[styles.actionCard, styles.chatCard, banner3dStyle(accent, { tint: theme.card })]}>
      <View style={styles.removalRow}>
        <View style={[styles.removalIconChip, { backgroundColor: accent + '24' }]}>
          <Icon name={toIconName(goal.icon)} size={18} color={accent} stroke={1.9} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.removalTitle} numberOfLines={1}>
            {goal.name}
          </Text>
          {headline ? (
            <Text style={styles.removalStatus} numberOfLines={1}>
              {headline}
            </Text>
          ) : null}
        </View>
        {pct != null ? <Ring value={pct} size={40} stroke={4} label={`${pct}`} /> : null}
      </View>
      {pct != null ? (
        <View style={styles.previewBody}>
          <Progress value={pct} color={accent} />
        </View>
      ) : null}
      {message.content ? <Text style={styles.actionDetail}>{message.content}</Text> : null}
    </View>
  );
}

// advance_goal_stage never mutates anything by itself — this card's Advance
// tap is the only confirmation (docs/milestone-goal-plan.md §2.1), same
// skeleton as TaskRemovalConfirmCard: shows the real proposal (from -> to
// stage, what retires, what's proposed next), and only a tap actually moves
// the goal (via POST /goals/:id/advance).
export function GoalAdvanceConfirmCard({ message }: { message: ChatMessage }) {
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

  // Advance is a milestone-only action — wear the milestone accent.
  const accent = goalAccent('milestone');
  return (
    <View style={[styles.actionCard, styles.chatCard, banner3dStyle(accent, { tint: theme.card })]}>
      <View style={styles.removalRow}>
        <View style={[styles.removalIconChip, { backgroundColor: accent + '24' }]}>
          <Icon name={toIconName(snapshot.icon)} size={18} color={accent} stroke={1.9} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.removalTitle} numberOfLines={1}>
            {snapshot.name}
          </Text>
          <CardStatus>{statusText}</CardStatus>
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
            style={[styles.previewConfirmButton, { backgroundColor: accent }]}
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

// The card components resolved by `meta.kind` — a chat action always renders
// as exactly one of these.
export const CARD_BY_KIND: Record<string, (props: { message: ChatMessage }) => ReactNode> = {
  task_action: TaskActionCard,
  task_removal_pending: TaskRemovalConfirmCard,
  task_bulk_removal_pending: TaskBulkRemovalConfirmCard,
  task_creation_pending: TaskPreviewCard,
  goal_preview: GoalPreviewCard,
  goal_action: GoalActionCard,
  goal_progress: GoalProgressCard,
  goal_advance_pending: GoalAdvanceConfirmCard,
  memory_action: MemoryActionCard,
};

const styles = StyleSheet.create({
  actionCard: { marginVertical: 4, alignSelf: 'stretch' },
  // The card surface for chat's goal/preview/removal cards — a rounded
  // container so the 3D colored banner (applied per card in its type accent)
  // has an edge to sit on. Task action cards skip this; they wrap TaskCard,
  // which brings its own card + banner.
  chatCard: { borderRadius: radii.card },
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
  previewErrorBox: { paddingHorizontal: 14, paddingBottom: 12, gap: 4 },
  previewErrorText: { color: theme.danger, fontSize: 12 },
  previewUpgradeLink: { color: theme.blue, fontSize: 12, fontWeight: '600' },
});
