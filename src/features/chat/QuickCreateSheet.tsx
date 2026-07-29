import * as Haptics from 'expo-haptics';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { Icon } from '@/components/Icon';
import { Sheet } from '@/components/Sheet';
import { GoalPreviewCard, TaskPreviewCard } from '@/features/chat/cards';
import { messagesQueryKey, type ChatMessage } from '@/features/chat/queries';
import { radii, theme } from '@/constants/theme';
import { streamMessage } from '@/lib/api/stream';

// Which "+" opened this — picks the entity the server create-scopes to, the
// title, and the placeholder. The whole point of scoping by tab is that the
// Tasks "+" always makes a task and the Goals "+" always makes a goal (see
// server system-prompt.ts CREATE_MODE_ACTION_PROMPT), so the sheet never has to
// guess and can't drift across entity types.
export type QuickCreateMode = 'task' | 'goal';

const COPY: Record<QuickCreateMode, { title: string; placeholder: string; apiMode: 'create_task' | 'create_goal' }> = {
  task: {
    title: 'Add a task',
    placeholder: 'Tell Meroa what to add… (e.g. stretch every morning)',
    apiMode: 'create_task',
  },
  goal: {
    title: 'Add a goal',
    placeholder: 'Tell Meroa what to add… (e.g. save $2,000 for a trip)',
    apiMode: 'create_goal',
  },
};

// A preview card only renders for these kinds — the create-scoped turn should
// only ever emit one of them, but the guard keeps a stray action kind from
// rendering as a blank card.
const PREVIEW_KINDS = new Set(['task_creation_pending', 'goal_preview']);

/**
 * Meroa-first quick-add for the Tasks/Goals tabs — the "+" opens this instead
 * of the manual form. The user types in plain language; the server runs a
 * create-scoped turn (routes/messages.ts `mode`) that can only preview that one
 * kind of create or ask one clarifying question, so it can't misfire into a
 * conversation or a wrong-guess write. The returned preview renders inline with
 * the SAME card the chat thread uses; Create confirms through the same
 * `{previewMessageId}` endpoint. The exchange also lands in the chat thread
 * (chat is the hub), so on close we refresh the messages cache.
 */
export function QuickCreateSheet({
  visible,
  onClose,
  mode,
  onManual,
}: {
  visible: boolean;
  onClose: () => void;
  mode: QuickCreateMode;
  // "fill in manually" — the tab screen closes this sheet and opens the
  // existing TaskFormSheet/GoalFormSheet (kept for precise/offline control).
  onManual: () => void;
}) {
  return (
    <Sheet visible={visible} onClose={onClose} title={COPY[mode].title}>
      {/* Remount per open so each visit starts on a clean input, same pattern
          as TaskFormSheet's keyed body. */}
      <QuickCreateBody key={visible ? 'open' : 'closed'} mode={mode} onClose={onClose} onManual={onManual} />
    </Sheet>
  );
}

function QuickCreateBody({
  mode,
  onClose,
  onManual,
}: {
  mode: QuickCreateMode;
  onClose: () => void;
  onManual: () => void;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Meroa's clarifying question (when it couldn't build a preview yet), shown as
  // a plain line above the input so the user can answer and keep going.
  const [question, setQuestion] = useState<string | null>(null);
  const [preview, setPreview] = useState<ChatMessage | null>(null);
  // Guards against a double-submit firing a second overlapping stream.
  const inFlight = useRef(false);

  // Refresh the thread so the request + preview/question show there too — chat
  // is the hub. Cheap: the tab isn't showing the thread, so this just marks it
  // stale for the next Chat visit.
  const refreshThread = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: messagesQueryKey });
  }, [queryClient]);

  const close = useCallback(() => {
    refreshThread();
    onClose();
  }, [refreshThread, onClose]);

  const submit = useCallback(async () => {
    const text = draft.trim();
    if (!text || inFlight.current) return;
    inFlight.current = true;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    setBusy(true);
    setError(null);
    setQuestion(null);
    setPreview(null);
    setDraft('');

    // Accumulate, then decide once at stream end. A create turn can also carry
    // noise the sheet must not show as a "question": the recurring AI-disclosure
    // line (meta.kind 'ai_disclosure') and any pre-written ack/quip
    // (meta.actionAck). And if a preview arrives, the card IS the answer — any
    // stray prose is dropped.
    const questionParts: string[] = [];
    let previewMsg: ChatMessage | null = null;
    try {
      for await (const event of streamMessage(text, { mode: COPY[mode].apiMode })) {
        if (event.type === 'segment') {
          const meta = event.message.meta ?? {};
          if (meta.kind === 'ai_disclosure' || meta.actionAck) continue;
          questionParts.push(event.message.content);
        } else if (event.type === 'action') {
          const kind = event.message.meta?.kind;
          if (typeof kind === 'string' && PREVIEW_KINDS.has(kind)) previewMsg = event.message;
        } else if (event.type === 'error') {
          setError(event.message);
        } else if (event.type === 'limit_reached') {
          setError("You've hit today's limit for new items — try again tomorrow, or subscribe to Meroa.");
        } else if (event.type === 'consent_required') {
          setError('Turn on AI in Settings to use quick add.');
        }
      }
      if (previewMsg) {
        setPreview(previewMsg); // the card is the answer; ignore any stray prose
      } else if (questionParts.length) {
        setQuestion(questionParts.join('\n\n'));
      }
    } catch {
      setError("Couldn't reach Meroa — check your connection and try again.");
    } finally {
      setBusy(false);
      inFlight.current = false;
    }
  }, [draft, mode]);

  return (
    <View style={styles.body}>
      {question ? (
        <View style={styles.questionRow}>
          <Text style={styles.questionText}>{question}</Text>
        </View>
      ) : null}

      {preview ? (
        // Same card the chat thread renders. onCreated closes the sheet once the
        // Create tap actually saves (the hook invalidates tasks/goals itself).
        <View style={styles.previewWrap}>
          {mode === 'task' ? (
            <TaskPreviewCard message={preview} onCreated={close} />
          ) : (
            <GoalPreviewCard message={preview} onCreated={close} />
          )}
        </View>
      ) : null}

      {error ? <Text style={styles.errorText}>{error}</Text> : null}

      <View style={styles.composer}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          placeholder={COPY[mode].placeholder}
          placeholderTextColor={theme.faint}
          style={styles.input}
          multiline
          editable={!busy}
          onSubmitEditing={submit}
          autoFocus
        />
        <Pressable
          onPress={submit}
          disabled={busy || !draft.trim()}
          style={[styles.sendBtn, busy || !draft.trim() ? styles.sendBtnDisabled : null]}
          hitSlop={6}
        >
          {busy ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Icon name="send" size={18} color="#fff" stroke={2} />
          )}
        </Pressable>
      </View>

      <Pressable onPress={onManual} style={styles.manualLink} hitSlop={8}>
        <Text style={styles.manualLinkText}>or fill it in manually</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { paddingBottom: 4 },
  questionRow: {
    backgroundColor: theme.bubbleAI,
    borderRadius: radii.card,
    borderBottomLeftRadius: radii.bubbleTail,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 12,
    alignSelf: 'flex-start',
    maxWidth: '92%',
  },
  questionText: { color: theme.text, fontSize: 15, lineHeight: 20 },
  previewWrap: { marginBottom: 12 },
  errorText: { color: theme.danger, fontSize: 13, marginBottom: 10 },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 120,
    color: theme.text,
    fontSize: 15,
    paddingHorizontal: 14,
    paddingVertical: 11,
    backgroundColor: theme.surface,
    borderRadius: radii.controlTight,
    borderWidth: 1,
    borderColor: theme.border,
  },
  sendBtn: {
    width: 44,
    height: 44,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.blue,
  },
  sendBtnDisabled: { opacity: 0.4 },
  manualLink: { alignSelf: 'center', paddingVertical: 12, marginTop: 4 },
  manualLinkText: { color: theme.dim, fontSize: 13, fontWeight: '600' },
});
