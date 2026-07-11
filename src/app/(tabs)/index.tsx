import * as Haptics from 'expo-haptics';
import { useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AnimatedPressable, useTapFeedback } from '@/components/AnimatedPressable';
import { Bubble } from '@/components/Bubble';
import { Icon } from '@/components/Icon';
import { MeroaMark } from '@/components/MeroaMark';
import { theme } from '@/constants/theme';
import { useTabBarHeight } from '@/hooks/use-tab-bar-inset';

type Msg = { id: string; from: 'me' | 'ai'; text: string };

const seed: Msg[] = [
  { id: '1', from: 'ai', text: "Hey — how's the day going?" },
  { id: '2', from: 'me', text: 'honestly kinda tired. i really need to work out though 😮‍💨' },
  { id: '3', from: 'ai', text: 'Totally hear you. Want to commit to it today — even a short one? I can lock it in.' },
  { id: '4', from: 'me', text: "yeah let's do chest today" },
  { id: '5', from: 'ai', text: 'Done. Added it to today.' },
];

export default function ChatScreen() {
  const [messages, setMessages] = useState<Msg[]>(seed);
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<ScrollView>(null);
  const ellipsisFeedback = useTapFeedback();
  const attachFeedback = useTapFeedback();
  const micSendFeedback = useTapFeedback(0.9);
  const tabBarHeight = useTabBarHeight();

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    setMessages((prev) => [...prev, { id: `${Date.now()}`, from: 'me', text }]);
    setDraft('');
    setTimeout(() => {
      setMessages((prev) => [
        ...prev,
        { id: `${Date.now()}-ai`, from: 'ai', text: 'Got it. Weaving that into your day.' },
      ]);
      scrollRef.current?.scrollToEnd({ animated: true });
    }, 500);
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
        <ScrollView
          ref={scrollRef}
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: 14, paddingBottom: 20 }}
          onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
        >
          <Text style={styles.timestamp}>
            {new Date().toLocaleDateString(undefined, { weekday: 'long' })} ·{' '}
            {new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
          </Text>
          {messages.map((m) => (
            <Bubble key={m.id} from={m.from}>
              {m.text}
            </Bubble>
          ))}
        </ScrollView>

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
            onSubmitEditing={send}
          />
          {draft.trim() ? (
            <AnimatedPressable
              onPress={send}
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
  timestamp: { color: theme.faint, fontSize: 11, textAlign: 'center', marginBottom: 8 },
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
