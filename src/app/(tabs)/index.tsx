import * as Haptics from 'expo-haptics';
import { useEffect, useRef, useState } from 'react';
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
import { TaskCard } from '@/components/TaskCard';
import { radii, theme } from '@/constants/theme';
import { type ChatMessage, useMessages, useSendMessage } from '@/features/chat/queries';
import {
  useBulkDeleteTasks,
  useCompleteTask,
  useDeleteTask,
  useProgressTask,
  useTasks,
} from '@/features/tasks/queries';
import { useCreateGoalFromPreview, useGoalConsistency, useGoals } from '@/features/goals/queries';
import { useTabBarHeight } from '@/hooks/use-tab-bar-inset';
import type { ApiTask, GoalPreview, StarterTask } from '@/lib/api/types';
import { toIconName } from '@/lib/icon';
import { requestNotificationPermission } from '@/lib/notifications';

// Must match the server's `sendSchema` max (server/src/routes/messages.ts) —
// otherwise an over-limit send round-trips to a 400, gets marked "failed",
// and retry just resends the identical text into the same 400 forever.
const MAX_MESSAGE_LENGTH = 4000;

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

function GoalPreviewCard({ message }: { message: ChatMessage }) {
  const createGoalFromPreview = useCreateGoalFromPreview();
  const [dismissed, setDismissed] = useState(false);

  const preview = message.meta.preview as GoalPreview | undefined;
  if (!preview) return null;

  const definition = preview.definition;
  const createdGoalId =
    createGoalFromPreview.data?.goal.id ?? (message.meta.createdGoalId as string | undefined);
  const created = !!createdGoalId;

  const targetLine = `Target: ${definition.currency}${definition.targetValue}`;
  const deadlineLine = definition.deadline ? `By ${definition.deadline}` : null;
  const starterTasks = preview.starterTasks ?? [];

  const statusText = created ? 'Created ✓' : dismissed ? 'Not saved' : 'Create this goal?';

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
        <Text style={styles.previewFields}>{targetLine}</Text>
        {deadlineLine ? <Text style={styles.previewFields}>{deadlineLine}</Text> : null}
        {starterTasks.map((task, idx) => (
          <Text key={idx} style={styles.previewFields}>
            ✓ {task.title} — {definition.currency}
            {task.contribution}
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
    </View>
  );
}

// Resolves the live goal by id (falls back to the meta snapshot, same
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

function MessageRow({
  message,
  onRetry,
}: {
  message: ChatMessage;
  onRetry: (m: ChatMessage) => void;
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
  if (message.role === 'assistant' && message.meta?.kind === 'goal_preview') {
    return <GoalPreviewCard message={message} />;
  }
  if (message.role === 'assistant' && message.meta?.kind === 'goal_action') {
    return <GoalActionCard message={message} />;
  }

  return (
    <View>
      <Bubble from={message.role === 'user' ? 'me' : 'ai'}>{message.content}</Bubble>
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
  const { send, retry } = useSendMessage();
  const [draft, setDraft] = useState('');
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

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <MeroaMark size={26} glow mood={headerMood} />
          <View>
            <Text style={styles.title}>Meroa</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
              <View style={styles.dot} />
              <Text style={styles.subtitle}>Listening · learning your style</Text>
            </View>
          </View>
        </View>
        <AnimatedPressable
          onPressIn={ellipsisFeedback.onPressIn}
          onPressOut={ellipsisFeedback.onPressOut}
          style={[styles.iconBtn, ellipsisFeedback.animatedStyle]}
        >
          <Icon name="ellipsis" size={16} color={theme.text} stroke={2.4} />
        </AnimatedPressable>
      </View>

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
            {messages.map((m) => (
              <MessageRow key={m.id} message={m} onRetry={handleRetry} />
            ))}
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
