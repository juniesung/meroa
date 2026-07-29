import * as Haptics from 'expo-haptics';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Keyboard,
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
  FadeIn,
  FadeInDown,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
  ZoomIn,
  ZoomOut,
} from 'react-native-reanimated';

import { AnimatedPressable, useTapFeedback } from '@/components/AnimatedPressable';
import { Bubble } from '@/components/Bubble';
import { Icon } from '@/components/Icon';
import { MeroaMark, type MeroaMood } from '@/components/MeroaMark';
import { ANIM_DURATION } from '@/components/Sheet';
import { ChatSkeleton } from '@/components/Skeleton';
import { radii, theme } from '@/constants/theme';
import { CARD_BY_KIND } from '@/features/chat/cards';
import { ChatMenuSheet } from '@/features/chat/ChatMenuSheet';
import { type ChatMessage, useClearConversation, useMessages, useReportMessage, useSendMessage } from '@/features/chat/queries';
import { useGoalConsistency } from '@/features/goals/queries';
import { useMe } from '@/features/profile/queries';
import { VibePickerSheet } from '@/features/profile/VibePickerSheet';
import { toneFromPrefs, toneLabel } from '@/features/profile/tone';
import { consumePendingChatDraft } from '@/features/chat/pending-draft';
import { useTabBarHeight } from '@/hooks/use-tab-bar-inset';

// Must match the server's `sendSchema` max (server/src/routes/messages.ts) —
// otherwise an over-limit send round-trips to a 400, gets marked "failed",
// and retry just resends the identical text into the same 400 forever.
const MAX_MESSAGE_LENGTH = 4000;

// The composer input auto-grows with wrapped lines, between these bounds. Its
// height is CONTROLLED (driven by onContentSizeChange) rather than left to the
// native auto-size: on iOS a `multiline` TextInput does not re-measure its
// content height when the value is cleared programmatically, so after sending a
// two-plus-line message the box kept its tall frame and left dead space at the
// bottom. Controlling the height lets sendDraft snap it back to one line.
const MIN_INPUT_HEIGHT = 36;
const MAX_INPUT_HEIGHT = 120;

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
    <Animated.View
      entering={FadeIn.duration(200)}
      style={{ flexDirection: 'row', justifyContent: 'flex-start', marginVertical: 3 }}
    >
      <View style={styles.typingBubble}>
        <Animated.View style={[styles.typingDot, s1]} />
        <Animated.View style={[styles.typingDot, s2]} />
        <Animated.View style={[styles.typingDot, s3]} />
      </View>
    </Animated.View>
  );
}

function MessageRow({
  message,
  onRetry,
  onReport,
  isFirstInGroup = true,
  isLastInGroup = true,
  animate = false,
}: {
  message: ChatMessage;
  onRetry: (m: ChatMessage) => void;
  onReport: (m: ChatMessage) => void;
  isFirstInGroup?: boolean;
  isLastInGroup?: boolean;
  // Play an entrance for this row. Gated by the parent so history loading in a
  // batch doesn't replay dozens of entrances — only rows that arrive live do.
  animate?: boolean;
}) {
  const isStreamingEmpty =
    message.role === 'assistant' && message.status === 'streaming' && !message.content;
  if (isStreamingEmpty) return <TypingDots />;

  const kind = message.role === 'assistant' ? message.meta?.kind : undefined;

  // Recurring AI-disclosure notice (NY GBL §1700 / CA SB 243) — rendered as a
  // quiet centered divider, not a chat bubble, so it reads as a system notice
  // rather than something Meroa "said". Injected server-side every ~3h of
  // continuing interaction (routes/messages.ts).
  if (kind === 'ai_disclosure') {
    return (
      <Animated.View entering={animate ? FadeInDown.duration(300) : undefined} style={styles.disclosureRow}>
        <Text style={styles.disclosureText}>{message.content}</Text>
      </Animated.View>
    );
  }

  const Card = typeof kind === 'string' ? CARD_BY_KIND[kind] : undefined;
  if (Card) {
    // Meroa's action cards glide in when they land — a card is created once
    // (via an `action` event) and never reconciles again, so this fires exactly
    // once. The confirmation still lives in the card itself (§4).
    return (
      <Animated.View entering={animate ? FadeInDown.duration(300) : undefined}>
        <Card message={message} />
      </Animated.View>
    );
  }

  // Long-press to report is offered only on a settled assistant reply (not the
  // user's own bubbles, not a still-streaming/failed placeholder) — matching the
  // server rule that only an assistant message is reportable.
  const canReport = message.role === 'assistant' && !message.status;
  // Only the user's own send gets an entrance, and only while it's the optimistic
  // 'sending' temp (queries.ts) — the persisted copy that replaces it in place
  // carries no status, so it swaps in silently instead of re-animating. Assistant
  // text bubbles are left to grow in via streaming, their own motion.
  const bubbleEntrance =
    message.role === 'user' && message.status === 'sending'
      ? FadeInDown.springify().damping(20).stiffness(180)
      : undefined;
  return (
    <Animated.View entering={bubbleEntrance}>
      <Bubble
        from={message.role === 'user' ? 'me' : 'ai'}
        isFirstInGroup={isFirstInGroup}
        isLastInGroup={isLastInGroup}
        onLongPress={canReport ? () => onReport(message) : undefined}
      >
        {message.content}
      </Bubble>
      {message.status === 'failed' && (
        <Pressable onPress={() => onRetry(message)} style={styles.statusRow} hitSlop={8}>
          <Text style={styles.statusText}>Not delivered · Tap to retry</Text>
        </Pressable>
      )}
      {message.status === 'limit_reached' && (
        // A member hit the daily fair-use ceiling — there's no higher tier to
        // sell, so this is informational, not a paywall prompt. (A locked user
        // never reaches chat: the nav guard keeps them on the paywall.)
        <View style={styles.statusRow}>
          <Text style={styles.statusText}>
            You&apos;ve reached today&apos;s message limit — check back tomorrow.
          </Text>
        </View>
      )}
    </Animated.View>
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
  // Controlled composer height — see MIN/MAX_INPUT_HEIGHT for why it isn't left
  // to the native auto-size.
  const [inputHeight, setInputHeight] = useState(MIN_INPUT_HEIGHT);
  const [menuSheetOpen, setMenuSheetOpen] = useState(false);
  const [vibeSheetOpen, setVibeSheetOpen] = useState(false);
  const { data: me } = useMe();
  const communicationStyle = toneLabel(toneFromPrefs(me?.user.prefs));
  const scrollRef = useRef<ScrollView>(null);
  const inputRef = useRef<TextInput>(null);

  // "Tell Meroa about this" (WS6): a goal/task screen queued a draft and jumped
  // to this tab. Consume it once on focus into the composer and focus the input,
  // so the user lands ready to finish the sentence and send.
  useFocusEffect(
    useCallback(() => {
      const queued = consumePendingChatDraft();
      if (queued) {
        setDraft(queued);
        setTimeout(() => inputRef.current?.focus(), 350);
      }
    }, []),
  );
  const ellipsisFeedback = useTapFeedback();
  const sendFeedback = useTapFeedback(0.9);
  const tabBarHeight = useTabBarHeight();

  // The composer normally pads its bottom by the translucent tab bar's height
  // so it floats clear of it. But when the keyboard is up it covers the tab
  // bar, so that same padding becomes dead space that pushes the input far
  // above the keyboard's top. Collapse it to a small gap while typing.
  const [keyboardShown, setKeyboardShown] = useState(false);
  useEffect(() => {
    const show = Keyboard.addListener('keyboardWillShow', () => setKeyboardShown(true));
    const hide = Keyboard.addListener('keyboardWillHide', () => setKeyboardShown(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

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

  // Same reasoning as the scroll snap above, for entrance animations: the first
  // loaded batch is history and must not replay entrances. Seed the "already
  // seen" set once from that batch — React's guarded set-state-during-render
  // (the documented "store info from previous renders" pattern) captures it
  // without an effect, so nothing in that first render animates. Anything with
  // an id not in the set arrived live (a new card or send) and earns its
  // entrance. Seeded once and never grown — a card's id is stable once
  // persisted, so it enters exactly once.
  const [seenIds, setSeenIds] = useState<Set<string> | null>(null);
  if (seenIds === null && !isLoading) {
    setSeenIds(new Set(messages.map((m) => m.id)));
  }
  const isFreshMessage = (id: string) => seenIds !== null && !seenIds.has(id);

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
    setInputHeight(MIN_INPUT_HEIGHT); // snap the box back to one line, don't leave the tall frame
    void send(text);
    setTimeout(() => {
      isSubmittingRef.current = false;
    }, 0);
  };

  const reportMessage = useReportMessage();
  const clearConversation = useClearConversation();
  const handleReport = (message: ChatMessage) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    Alert.alert(
      'Report this response?',
      'Let us know if this reply was offensive or inappropriate. We review reports to make Meroa better.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Report',
          style: 'destructive',
          onPress: () =>
            reportMessage.mutate(
              { id: message.id },
              {
                onSuccess: () => Alert.alert('Thanks', "We'll take a look at this response."),
                onError: () =>
                  Alert.alert('Something went wrong', "Couldn't send that report. Please try again."),
              },
            ),
        },
      ],
    );
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
  const clearFromMenu = () => {
    setMenuSheetOpen(false);
    setTimeout(() => {
      Alert.alert(
        'Clear conversation?',
        'This wipes your chat with Meroa and starts fresh. Your tasks, goals, and progress are kept.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Clear',
            style: 'destructive',
            onPress: () => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
              clearConversation.mutate(undefined, {
                onError: () =>
                  Alert.alert('Something went wrong', "Couldn't clear the conversation. Please try again."),
              });
            },
          },
        ],
      );
    }, ANIM_DURATION);
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <MeroaMark size={26} glow mood={headerMood} />
          <View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Text style={styles.title}>Meroa</Text>
              {/* Persistent AI disclosure — conspicuous at the start of every
                  conversation (NY GBL §1700 / CA SB 243). Always visible, not a
                  one-time onboarding line. The recurring 3-hour reminder is
                  injected into the thread server-side (routes/messages.ts). */}
              <Text style={styles.aiTag}>AI</Text>
            </View>
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
        toneName={communicationStyle}
        onSelectTone={openToneFromMenu}
        onSelectMemory={openMemoryFromMenu}
        onSelectClear={clearFromMenu}
      />
      <VibePickerSheet visible={vibeSheetOpen} onClose={() => setVibeSheetOpen(false)} />

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        {isLoading ? (
          <ChatSkeleton />
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
                  onReport={handleReport}
                  isFirstInGroup={flags?.isFirst}
                  isLastInGroup={flags?.isLast}
                  animate={isFreshMessage(m.id)}
                />
              );
            })}
          </ScrollView>
        )}

        <View style={[styles.composer, { paddingBottom: keyboardShown ? 16 : tabBarHeight + 16 }]}>
          <TextInput
            ref={inputRef}
            value={draft}
            onChangeText={setDraft}
            placeholder="Message Meroa"
            placeholderTextColor={theme.faint}
            style={[
              styles.input,
              { height: Math.min(Math.max(inputHeight, MIN_INPUT_HEIGHT), MAX_INPUT_HEIGHT) },
            ]}
            onContentSizeChange={(e) => setInputHeight(e.nativeEvent.contentSize.height)}
            multiline
            maxLength={MAX_MESSAGE_LENGTH}
            onSubmitEditing={sendDraft}
          />
          {/* Send appears only when there's text — no dead-end mic/attach
              controls (neither voice nor attachments exist server-side). It
              scales in as you start typing and out when the draft clears, so
              it feels like a live control rather than a hard pop. */}
          {draft.trim() ? (
            <Animated.View entering={ZoomIn.duration(160)} exiting={ZoomOut.duration(140)}>
              <AnimatedPressable
                onPress={sendDraft}
                onPressIn={sendFeedback.onPressIn}
                onPressOut={sendFeedback.onPressOut}
                style={[styles.composerIcon, styles.sendBtn, sendFeedback.animatedStyle]}
              >
                <Icon name="send" size={18} color="#fff" stroke={2} />
              </AnimatedPressable>
            </Animated.View>
          ) : null}
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
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
  // Recurring AI-disclosure notice — quiet, centered, non-bubble.
  disclosureRow: { alignItems: 'center', paddingVertical: 10, paddingHorizontal: 24 },
  disclosureText: { color: theme.faint, fontSize: 11.5, textAlign: 'center', lineHeight: 16 },
  title: { color: theme.text, fontSize: 16, fontWeight: '700', letterSpacing: -0.2 },
  // Small persistent "AI" disclosure pill next to the title.
  aiTag: {
    color: theme.dim,
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.6,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 5,
    borderWidth: 1,
    borderColor: theme.border,
    overflow: 'hidden',
  },
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
    // Height is controlled (inputHeight state) — see MIN/MAX_INPUT_HEIGHT.
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
