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
import Animated, { useAnimatedStyle, useSharedValue, withRepeat, withSequence, withTiming } from 'react-native-reanimated';

import { AnimatedPressable, useTapFeedback } from '@/components/AnimatedPressable';
import { Bubble } from '@/components/Bubble';
import { Icon } from '@/components/Icon';
import { MeroaMark } from '@/components/MeroaMark';
import { radii, theme } from '@/constants/theme';
import { type ChatMessage, useMessages, useSendMessage } from '@/features/chat/queries';
import { useTabBarHeight } from '@/hooks/use-tab-bar-inset';

// Must match the server's `sendSchema` max (server/src/routes/messages.ts) —
// otherwise an over-limit send round-trips to a 400, gets marked "failed",
// and retry just resends the identical text into the same 400 forever.
const MAX_MESSAGE_LENGTH = 4000;

function TypingDots() {
  const d1 = useSharedValue(0.3);
  const d2 = useSharedValue(0.3);
  const d3 = useSharedValue(0.3);

  useEffect(() => {
    const loop = () => withRepeat(withSequence(withTiming(1, { duration: 350 }), withTiming(0.3, { duration: 350 })), -1);
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

function MessageRow({ message, onRetry }: { message: ChatMessage; onRetry: (m: ChatMessage) => void }) {
  const isStreamingEmpty = message.role === 'assistant' && message.status === 'streaming' && !message.content;
  if (isStreamingEmpty) return <TypingDots />;

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
          <MeroaMark size={26} glow />
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
