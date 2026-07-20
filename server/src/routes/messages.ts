import { zValidator } from '@hono/zod-validator';
import * as Sentry from '@sentry/node';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';

import { db } from '../db/client.ts';
import { conversations, messageReports, messages, records, users } from '../db/schema.ts';
import { streamChatReply, type ChatHistoryMessage } from '../lib/ai/chat.ts';
import { maybeExtractMemories } from '../lib/ai/memory-extractor.ts';
import { pickTaskCreatedQuip } from '../lib/ai/quips.ts';
import { buildRecentChangesFeed, renderUndoTarget } from '../lib/ai/recent-changes.ts';
import { hasValidAiConsent } from '../lib/consent.ts';
import {
  applyStyleCasing,
  buildConversationTailBlock,
  buildMemoryFactsText,
  buildTailBlock,
  isStyleAdjustments,
  type ChatUserContext,
} from '../lib/ai/system-prompt.ts';
import { computeActiveGoalAllowance, computeTaskCreateAllowance } from '../lib/limits.ts';
import { listMemories } from '../lib/memories/executor.ts';
import { buildTaskContext } from '../lib/ai/task-context.ts';
import { buildGoalContext } from '../lib/ai/goal-context.ts';
import {
  findPendingPreview,
  hasPendingTaskPreview,
  renderPendingPreview,
  renderPendingTaskPreview,
} from '../lib/ai/pending-preview.ts';
import { buildGoalConsistency } from '../lib/goals/consistency.ts';
import { getOrCreateAppConversation, getRecentMessages } from '../lib/conversations.ts';
import { peekUndoTarget } from '../lib/tasks/executor.ts';
import { materializeRecurringInstances } from '../lib/tasks/recurrence.ts';
import { computeAllowance, withUserChatLock } from '../lib/usage.ts';
import { logger } from '../logger.ts';
import { isToolCallMarkupLeak } from '../lib/ai/providers/shared.ts';
import { requireAuth, type AuthVariables } from '../middleware/auth.ts';
import { rateLimit } from '../middleware/rate-limit.ts';

export const messageRoutes = new Hono<{ Variables: AuthVariables }>();
messageRoutes.use('*', requireAuth);

const listQuerySchema = z.object({
  cursor: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

messageRoutes.get('/', zValidator('query', listQuerySchema), async (c) => {
  const userId = c.get('userId');
  const { cursor, limit } = c.req.valid('query');
  const rows = await getRecentMessages(userId, limit ?? 50, cursor ? new Date(cursor) : undefined);
  return c.json({ messages: rows });
});

// Google Play AI-Generated Content policy: an in-app way to flag an offensive
// AI response. Plain record, NO model call. You can only report an assistant
// message (Meroa's own reply, never your own) in one of your OWN conversations,
// and re-reporting the same message is a no-op (unique on (userId, messageId)).
const reportSchema = z.object({ reason: z.string().trim().max(1000).optional() });

messageRoutes.post('/:id/report', zValidator('json', reportSchema), async (c) => {
  const userId = c.get('userId');
  const messageId = c.req.param('id');
  const { reason } = c.req.valid('json');

  const [target] = await db
    .select({ role: messages.role })
    .from(messages)
    .innerJoin(conversations, eq(messages.conversationId, conversations.id))
    .where(and(eq(messages.id, messageId), eq(conversations.userId, userId)))
    .limit(1);
  if (!target) return c.json({ error: 'not_found' }, 404);
  if (target.role !== 'assistant') return c.json({ error: 'not_reportable' }, 400);

  await db
    .insert(messageReports)
    .values({ userId, messageId, reason: reason ?? null })
    .onConflictDoNothing({ target: [messageReports.userId, messageReports.messageId] });

  return c.json({ ok: true });
});

const sendSchema = z.object({ text: z.string().trim().min(1).max(4000) });

function isChatRole(role: string): role is 'user' | 'assistant' {
  return role === 'user' || role === 'assistant';
}

const VIBE_PRESETS = new Set(['chill', 'supportive', 'direct', 'playful', 'balanced']);

// An action turn's card IS the assistant's reply — so it has to appear in the
// model's history as one, or the conversation record lies about what happened.
//
// These used to be dropped entirely (empty string, filtered out downstream).
// That was SAFE under an assumption that no longer holds, and the original
// comment said so out loud: "the model's own immediately-following
// natural-language reply still carries the conversational continuity." That
// reply is gone — a successful action turn now emits no prose at all, because
// the card says everything and the prose was where every lie lived
// (providers/act-narrate.ts). Dropping the card too left a HOLE: history became
//
//     user: "make a task to pick up brother daily at 7pm"
//     user: "what's up"
//
// with no assistant turn between them. The model sees an unanswered request and
// catches up on it — observed live, answering a plain "what's up" with "Already
// in there — daily at 7pm." Not a prompt problem: a truthfulness problem in the
// record we hand it. Fill the hole and there is nothing to catch up on.
//
// The old worry was that a fixed, repeated shape in history is a template the
// model copies into a real reply on a turn where no tool ran. That risk is real
// (it happened, with a bracket marker) and it is now backstopped rather than
// avoided: FAKE_ACTION_PATTERN plus the claim-check catch exactly that shape,
// and the model no longer WRITES these lines itself, so its only exposure is
// reading them here.
const CARD_KINDS = new Set([
  'task_action',
  'task_removal_pending',
  'task_bulk_removal_pending',
  'task_creation_pending',
  'goal_action',
  'goal_preview',
  'goal_advance_pending',
  'memory_action',
]);

function isCardMessage(m: { meta: unknown }): boolean {
  const meta = m.meta as { kind?: string } | null;
  return !!meta?.kind && CARD_KINDS.has(meta.kind);
}

// A card that mutated NOTHING and is still waiting on a tap. These belong in the
// ACT pass's history — dropping them tore a hole in the record (two user messages
// in a row, no assistant turn) and the act pass, seeing an apparently-unanswered
// request, stopped acting on the NEXT one: "add gym mon wed fri and remind me to
// call my mom sunday" created neither task, and the reply pass then claimed it had.
//
// But they must NOT reach the REPLY pass. Their text is an instruction to the user
// ("Tap to confirm removing X"), and replayed there it reads as an open request the
// assistant still owes a follow-up on — which is how a plain "What's up dawg" came
// back as "Already got you — just tapped that confirm, so they're all gone now."
//
// So: same history, filtered per pass (providers/act-narrate.ts). The pass that
// ACTS gets the full record; the pass that TALKS doesn't get the loose ends.
const PENDING_CARD_KINDS = new Set([
  'task_removal_pending',
  'task_bulk_removal_pending',
  'task_creation_pending',
  'goal_advance_pending',
  'goal_preview',
]);

function isPendingCardMessage(m: { meta: unknown }): boolean {
  const meta = m.meta as { kind?: string } | null;
  return !!meta?.kind && PENDING_CARD_KINDS.has(meta.kind);
}

// A plain narrate reply persisted on a turn that ALSO produced a real card
// (the "mixed success + failure" case — see the loop in this file that sets
// turnHadAction). Its only content was acknowledging something the card
// already shows in full, live from the DB, so it carries nothing worth
// reading back later — and read out of context by a LATER, ungrounded turn
// (the conversation fast path, providers/act-narrate.ts, which gets only the
// clock, no task list), it reads as an open thread still needing a close.
// Observed live: "On it." here baited an unrelated later "Nice" into
// inventing "Done. Your aloe's officially on the clock now." — a claim the
// claim-check guard correctly caught and replaced with a generic correction,
// confusing since the ACTUAL task creation, two turns earlier, was fine.
function isActionAckMessage(m: { meta: unknown }): boolean {
  const meta = m.meta as { actionAck?: boolean } | null;
  return meta?.actionAck === true;
}

function historyContentFor(m: { content: string; meta: unknown }): string {
  const meta = m.meta as { kind?: string; preview?: { name?: string } } | null;
  switch (meta?.kind) {
    // create_goal's stored `content` is written for the MODEL mid-turn ("do not
    // ask them to confirm in chat text…") — instructions, not something the
    // assistant said. Synthesized from the preview instead, and deliberately
    // VARIABLE (the goal's real name), never a constant: a fixed, repeated string
    // in history is a template the model eventually reproduces, which is how
    // "[showing a confirmation card — tap it to confirm]" once reached the chat.
    // This is only ever shown to the ACT pass (see isPendingCard below), and the
    // act pass emits no prose at all — so there is nothing here to copy into.
    case 'goal_preview':
      return meta.preview?.name
        ? `Put a preview card up for a "${meta.preview.name}" goal — not saved until they tap Create.`
        : 'Put a goal preview card up.';
    // Every other card's `content` is the user-facing, server-computed sentence
    // for exactly what happened. That is what the assistant "said" by putting the
    // card up, and it must be in the record — see isPendingCard.
    default:
      return m.content;
  }
}

// Server-sent events on this stream:
//   user_message  — the persisted user message row (client reconciles its optimistic id)
//   delta         — { text } incremental text for the segment currently arriving
//   segment       — { message } a persisted assistant message row (one "text" of a
//                   possibly multi-bubble reply); more may follow
//   action        — { message, task } a task action executed (create/edit/complete/
//                   postpone/remove/undo); the client renders `message` as a task card
//   stream_end    — the whole reply is done; no further segments
//   error         — { retryable, message } — the in-flight segment was not persisted;
//                   any earlier segments in this turn already were
messageRoutes.post('/', rateLimit({ windowMs: 60_000, max: 20 }), zValidator('json', sendSchema), async (c) => {
  const userId = c.get('userId');
  const { text } = c.req.valid('json');

  // Apple 5.1.2(i): nothing reaches the third-party AI provider without explicit,
  // current consent. This is THE compliance boundary — enforced server-side so a
  // client that bypassed the consent nav guard (or an outdated build) still cannot
  // reach the model. Checked before the message is persisted, so a blocked send
  // leaves no orphan user row behind. (lib/consent.ts, docs/data-inventory.md §3.)
  const [consentUser] = await db
    .select({ prefs: users.prefs })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!consentUser) return c.json({ error: 'not_found' }, 404);
  if (!hasValidAiConsent(consentUser.prefs)) {
    return c.json({ error: 'ai_consent_required' }, 403);
  }

  const conversation = await getOrCreateAppConversation(userId);

  // The allowance check and the user-message insert must be atomic, or two
  // concurrent sends can both read "under limit" before either commits and
  // both get through — bypassing the cap. withUserChatLock holds a Postgres
  // advisory lock (keyed on userId) for the duration of this transaction,
  // serializing concurrent sends from the *same* user (other users' requests
  // aren't blocked) — same pattern as the OTP rate limit in auth.ts.
  const result = await withUserChatLock(userId, async (tx) => {
    const allowance = await computeAllowance(tx, userId);
    if (!allowance.allowed) return { limited: true as const, allowance };

    const [userMessage] = await tx
      .insert(messages)
      .values({ conversationId: conversation.id, role: 'user', content: text })
      .returning();
    if (!userMessage) throw new Error('message_insert_failed');
    return { limited: false as const, userMessage, allowance };
  });

  if (result.limited) {
    return c.json(
      { error: 'limit_reached', feature: 'messages', plan: result.allowance.plan, limit: result.allowance.limit },
      429,
    );
  }
  const { userMessage, allowance: chatAllowance } = result;

  const [user] = await db
    .select({ displayName: users.displayName, timezone: users.timezone, prefs: users.prefs })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const prefs = (user?.prefs ?? {}) as Record<string, unknown>;
  const style = VIBE_PRESETS.has(prefs.communicationStyle as string)
    ? (prefs.communicationStyle as ChatUserContext['style'])
    : undefined;
  const styleAdjustments = isStyleAdjustments(prefs.styleAdjustments)
    ? (prefs.styleAdjustments as ChatUserContext['styleAdjustments'])
    : undefined;
  // Capped at 50 — stable between extractions (memory-extractor.ts runs in
  // batches, not per-turn), so this stays cache-friendly the same way
  // buildStyleBlock's per-user text does. Non-suppressed only: a "don't
  // bring this up unless I do" memory must not reach the model at all — a
  // guarantee, not a prompt instruction (docs/chat-architecture.md's whole
  // point about where invariants have to live).
  const memoryRows = (await listMemories(userId)).slice(0, 50);
  const memoryContext = memoryRows.map((m) => ({ kind: m.kind, content: m.content, sensitive: m.sensitive }));
  const userContext: ChatUserContext = {
    displayName: user?.displayName ?? null,
    timezone: user?.timezone ?? null,
    style,
    styleAdjustments,
    memories: memoryContext,
  };

  // Includes the message just inserted above, and merges the sms-channel
  // continuity history (Phase 1) chronologically with the app channel.
  const history = await getRecentMessages(userId, 50);
  const chatHistory: ChatHistoryMessage[] = history
    .filter((m): m is typeof m & { role: 'user' | 'assistant' } => isChatRole(m.role))
    // `isCard` marks an assistant turn that was a CARD rather than spoken words.
    // The conversation fast path drops these entirely (providers/act-narrate.ts):
    // on a plain "What's up dawg" the model has no business narrating a task, and
    // the surest way to stop it is to not show it one.
    .map((m) => ({
      role: m.role,
      content: historyContentFor(m),
      isCard: isCardMessage(m),
      isPendingCard: isPendingCardMessage(m),
      isActionAck: isActionAckMessage(m),
    }))
    // Never feed a past tool-call leak back to the model. This is the fix that
    // actually matters, because a leak is SELF-REINFORCING: any leaked reply is
    // persisted as an assistant message, so on the next turn the model reads its
    // own `calling create_task with title "..."` in history and does it again —
    // observed live, and the copy it produced was degraded ("calling create"),
    // slipping past a guard that only knew the full tool name. Suppressing the
    // leak at the output boundary is not enough on its own: one that escaped
    // before the guard existed keeps teaching the model forever. An assistant
    // message that looks like tool mechanics carries no conversational value
    // worth preserving, so dropping it from context costs nothing.
    .filter((m) => !(m.role === 'assistant' && isToolCallMarkupLeak(m.content)));

  // Is the very last thing the assistant put on screen a tap-to-confirm card
  // the user hasn't acted on? If so it changed NOTHING, and "undo that" cannot
  // mean it — see the guard in lib/ai/actions.ts. Only the newest assistant
  // message counts: an older card they have since moved past is not what "that"
  // refers to.
  const newestAssistant = [...history].reverse().find((m) => m.role === 'assistant');
  const newestMeta = (newestAssistant?.meta ?? null) as { kind?: string } | null;
  const newestIsConfirmCard =
    newestMeta?.kind === 'task_removal_pending' ||
    newestMeta?.kind === 'task_bulk_removal_pending' ||
    newestMeta?.kind === 'goal_advance_pending';

  // A confirm card is only "pending" until it is TAPPED. The first version of this
  // guard asked "is the newest assistant message a confirm card?" — but the card
  // message stays newest after the tap, so it went on refusing undo forever. Seen
  // live end-to-end: tap Delete, say "undo that", and the undo is REFUSED — the
  // task stays deleted while the reply says "Undid the deletion, it's back."
  // Exactly the false refusal the guard was built to prevent, pointed the wrong
  // way.
  //
  // The right question is not "is a card on screen" but "did that card change
  // anything?" — and that is a fact, not a guess: a tap writes a record. If any
  // live record was written AFTER the card was shown, it was acted on, and there
  // is something real to undo. If none was, the card truly did nothing and "undo
  // that" must not reach past it.
  let pendingConfirmCard: string | null = null;
  if (newestIsConfirmCard && newestAssistant) {
    const [actedOn] = await db
      .select({ id: records.id })
      .from(records)
      .where(
        and(
          eq(records.userId, userId),
          isNull(records.revertedAt),
          gt(records.occurredAt, newestAssistant.createdAt),
        ),
      )
      .limit(1);
    if (!actedOn) pendingConfirmCard = newestAssistant.content ?? 'a confirmation card';
  }

  // The AI action layer needs a settled, up-to-date task list to reference
  // by ref and see today's recurring instances. Materialization has to land
  // before anything reads tasks, but after that only ONE real dependency
  // remains — goal context needs the ref map task context builds — so the
  // rest runs concurrently instead of as a four-query chain (measured 418ms
  // sequential, and every millisecond here is upstream of the first token).
  await materializeRecurringInstances(userId, userContext.timezone, db);
  const isFreePlan = chatAllowance.plan === 'free';
  const [taskContext, consistency, taskAllowance, goalAllowance] = await Promise.all([
    buildTaskContext(userId, userContext.timezone),
    buildGoalConsistency(userId, userContext.timezone),
    isFreePlan ? computeTaskCreateAllowance(db, userId) : Promise.resolve(null),
    isFreePlan ? computeActiveGoalAllowance(db, userId) : Promise.resolve(null),
  ]);
  // Appends into the same TurnRefs map task context just built — one ref
  // namespace ("T*"/"G*") covers both tasks and goals for the turn.
  const goalContext = await buildGoalContext(userId, userContext.timezone, taskContext.refs);
  // Always a concrete sentence, never '' — with nothing here, "do I have a
  // streak?" left the model to invent an explanation (observed live:
  // "none of your tasks are set up for it", which isn't how streaks work).
  // One missed day per week doesn't break a run (lib/goals/consistency.ts's
  // applyWeeklyGrace). Stated only when it actually happened in the last
  // week, so it's a fact about their streak rather than boilerplate on every
  // turn — without it, "wait, why didn't my streak reset?" is exactly the
  // kind of question the model would answer by inventing a mechanic.
  const graceClause = consistency.calendar.slice(-7).some((d) => d.forgiven)
    ? ' A missed day this week was forgiven — one miss a week is, so the run held.'
    : '';
  const streakText =
    consistency.current > 0
      ? `${consistency.current}-day perfect streak (longest: ${consistency.longest}).${graceClause}`
      : consistency.longest > 0
        ? `No streak right now (longest: ${consistency.longest}) — it resumes the next day every due task gets done.`
        : 'No completion streak yet — one starts automatically the first day every due task gets done.';

  // Out-of-band mutations (a Tasks-tab tap, a removal-card confirm) since
  // the user's *previous* message are otherwise invisible to the model —
  // its own history only shows the unresolved "pending" side of the story.
  // The previous user message is whatever real user turn immediately
  // precedes the one just inserted above.
  const priorUserMessages = history.filter((m) => m.role === 'user');
  const previousUserMessage = priorUserMessages[priorUserMessages.length - 2] ?? null;
  const recentChangesText = await buildRecentChangesFeed(
    userId,
    previousUserMessage?.createdAt ?? null,
  );

  // Pending (unsaved) preview state — derived from the history already
  // fetched above, no extra query. The act/narrate action pass depends on
  // this: it sees only a tiny recent-turn window, so "make it $120 instead"
  // must resolve against state rather than deep history.
  const pendingPreview = findPendingPreview(history);
  // A pending TASK preview carries no extra descriptive content of its own
  // (its contents already reached the model via create_task's tool result,
  // and the task list only ever reflects real, saved rows) — but the
  // claim-check guard still needs a stated FACT that one exists, or it has
  // nothing to weigh an honest "still waiting on you to tap Create" against
  // (see renderPendingTaskPreview and CLASSIFIER_SYSTEM_PROMPT in
  // claim-check.ts). Falls back to it only when there's no goal preview,
  // same "newest wins" precedence findPendingPreview already uses.
  const hasPendingTask = hasPendingTaskPreview(history);
  const pendingPreviewText = renderPendingPreview(pendingPreview) || renderPendingTaskPreview(hasPendingTask);

  // "undo that" must work even when the thing to undo happened in the app,
  // not in chat — state it as a fact rather than leaving the model to infer
  // it from the recent-changes narrative (it didn't, observed live).
  const undoTargetText = renderUndoTarget(await peekUndoTarget(userId));

  // TWO tails, because the two passes need different things and one of them was
  // actively harmful to the other.
  //
  // The recent-changes feed ("Since your last message, in the app: removed
  // \"Pick up brother\"; removed \"Pick up sister\"…") exists so the model can't
  // CONTRADICT something the user did out of band — a Tasks-tab tap, a Confirm
  // on a removal card. That is grounding, and the ACTION pass genuinely needs it
  // ("undo that" has to know what the last change was).
  //
  // The REPLY pass read it as news and announced it, unprompted. Observed live:
  // the user tapped Confirm on a bulk-removal card, then typed "What's up dawg",
  // and got "Already got you — just tapped that confirm, so they're all gone
  // now. Tasks are cleared out." — a status report nobody asked for, on a
  // greeting, which the claim-check then retracted for good measure.
  //
  // The reply pass does not need it: the task list right above already shows the
  // current state, so it cannot say anything stale. So it simply doesn't get it.
  // A pass cannot announce what it cannot see — which is a guarantee, where "do
  // not announce this" would only have been a request.
  // Free-plan-only fact so the ACT pass can decline a doomed create_task/
  // create_goal gracefully before ever attempting it, the NARRATE pass can
  // quote the real remaining counts if asked or if a create just failed,
  // and the figure guard's stateFactsText sees these numbers as grounded
  // (chat-architecture.md §9: every number is server-computed and quoted).
  // Omitted entirely for Plus — there is nothing to say. Rides sharedTail,
  // not a separate block, so it reaches ACT/NARRATE/guards in one place and
  // is deliberately absent from conversationTailText (the fast path gets
  // only the clock — no plan/limit talk on a plain greeting).
  const limitsText =
    taskAllowance && goalAllowance
      ? `Plan: free. New tasks left today: ${taskAllowance.remaining} of ${taskAllowance.limit} (resets on a rolling 24-hour window). Active goals: ${goalAllowance.used} of ${goalAllowance.limit}${goalAllowance.remaining === 0 ? ' (at the limit)' : ''}. Completing tasks and logging progress are never limited. Meroa Plus lifts these caps.`
      : undefined;

  const sharedTail = {
    now: new Date(),
    timezone: userContext.timezone,
    counts: taskContext.counts,
    taskListText: taskContext.text,
    goalListText: goalContext.text,
    streakText,
    pendingPreviewText,
    limitsText,
  };
  const tailText = buildTailBlock({ ...sharedTail, recentChangesText, undoTargetText });
  // recentChangesText is grounding for the ACT pass only (undo needs to know
  // what the last out-of-band change was) — the reply pass must NOT get it,
  // or it announces it as news on an unrelated turn. See the comment above
  // sharedTail: this is the guarantee it describes, restored.
  const narrateTailText = buildTailBlock({ ...sharedTail });
  const conversationTailText = buildConversationTailBlock(sharedTail.now, userContext.timezone);
  // What the GUARDS are shown (claim-check, figure-check): the plain truth about
  // what the user has, and nothing else. Deliberately NOT tailText — that carries
  // the recent-changes feed ("Since your last message, in the app: removed …") and
  // the undo target, and handing those to a classifier whose whole premise is
  // "nothing changed this turn" is a contradiction. It duly got confused and
  // retracted two perfectly honest replies live. A guard can only be as good as
  // the facts you give it.
  // Memories are appended here too — a reply that quotes a remembered
  // detail with a number in it must be judged against facts that actually
  // contain it, or the figure guard retracts an honest reply (§4's "a guard
  // can only be as good as the facts you give it").
  const stateFactsText = buildTailBlock(sharedTail) + buildMemoryFactsText(memoryContext);

  return streamSSE(c, async (stream) => {
    await stream.writeSSE({ event: 'user_message', data: JSON.stringify(userMessage) });

    // Hono's streamSSE only console.errors an uncaught throw — it never
    // notifies the client. Without this try/catch, a DB error mid-segment
    // (rare, but possible) would leave the client's typing indicator hanging
    // forever with no error and no retry path.
    try {
      // Cards are always yielded before any narrate segment_end in the SAME
      // turn (the tool-call loop runs, then the narrate pass) — see the
      // "mixed success + failure" case: the failure means the turn doesn't
      // qualify for §3's silence rule, so the narrate pass runs anyway and
      // produces a plain, informationally-empty acknowledgment ("On it.")
      // ALONGSIDE the real card. That bubble carries nothing the card
      // doesn't already show, and tagging it here lets act-narrate.ts strip
      // it from history the same way a pending card is stripped — see
      // isActionAckMessage below.
      let turnHadAction = false;
      for await (const event of streamChatReply(chatHistory, userContext, tailText, narrateTailText, conversationTailText, stateFactsText, {
        userId,
        timezone: userContext.timezone,
        sourceMessageId: userMessage.id,
        refs: taskContext.refs,
        pendingConfirmCard,
        hasPendingPreview: !!pendingPreview || hasPendingTask,
        userMessageText: userMessage.content,
      })) {
        if (event.type === 'delta') {
          await stream.writeSSE({
            event: 'delta',
            data: JSON.stringify({ text: applyStyleCasing(event.text, userContext.style) }),
          });
        } else if (event.type === 'segment_end') {
          const [assistantMessage] = await db
            .insert(messages)
            .values({
              conversationId: conversation.id,
              role: 'assistant',
              content: applyStyleCasing(event.text, userContext.style),
              ...(turnHadAction ? { meta: { actionAck: true } } : {}),
            })
            .returning();
          await stream.writeSSE({
            event: 'segment',
            data: JSON.stringify({ message: assistantMessage }),
          });
        } else if (event.type === 'action') {
          turnHadAction = true;
          // remove_task doesn't delete outright — it comes back with
          // recordKind: 'task_removal_pending' so the client renders a
          // Confirm/Cancel card instead of a read-only one.
          const kind = event.recordKind === 'task_removal_pending' ? 'task_removal_pending' : 'task_action';
          const [assistantMessage] = await db
            .insert(messages)
            .values({
              conversationId: conversation.id,
              role: 'assistant',
              content: event.summary,
              meta: {
                kind,
                action: event.toolName,
                taskId: event.task.id,
                task: event.task,
                // The one fact the task card can't render itself — goal impact,
                // history. Shown as a caption under the card now that a
                // successful action turn writes no prose (act-narrate.ts).
                ...(event.detail ? { detail: event.detail } : {}),
              },
            })
            .returning();
          await stream.writeSSE({
            event: 'action',
            data: JSON.stringify({ message: assistantMessage, task: event.task }),
          });
          // A short, PRE-WRITTEN follow-up — never model-generated, so it
          // can't hallucinate and needs no claim-check. Tagged actionAck for
          // the same reason "On it." needed to be: untagged, it would sit in
          // later history as bait for a fabricated claim on an unrelated
          // turn (see isActionAckMessage). Real creations only — never fires
          // on the task_creation_pending preview path (a different branch
          // entirely), so it never congratulates something not yet saved.
          if (event.toolName === 'create_task' && event.recordKind === 'task_created') {
            const quip = pickTaskCreatedQuip(style);
            if (quip) {
              const [quipMessage] = await db
                .insert(messages)
                .values({ conversationId: conversation.id, role: 'assistant', content: quip, meta: { actionAck: true } })
                .returning();
              await stream.writeSSE({ event: 'segment', data: JSON.stringify({ message: quipMessage }) });
            }
          }
        } else if (event.type === 'action_preview') {
          turnHadAction = true;
          // create_goal never saves — this is a preview card only. Its
          // meta.preview is exactly what POST /goals {previewMessageId}
          // re-validates and saves once the user taps Create
          // (docs/goals-redesign-plan.md §2.1).
          const [assistantMessage] = await db
            .insert(messages)
            .values({
              conversationId: conversation.id,
              role: 'assistant',
              content: event.summary,
              meta: {
                kind: 'goal_preview',
                action: event.toolName,
                preview: event.preview,
                // The handoff caption the card can't compute itself — "open
                // in Goals to add your stages" for a bare milestone
                // template, or how many stages are set (docs/goal-manual-
                // editing-plan.md §3.4). Client renders it the same way
                // TaskActionCard renders meta.detail.
                ...(event.detail ? { detail: event.detail } : {}),
              },
            })
            .returning();
          await stream.writeSSE({
            event: 'action',
            data: JSON.stringify({ message: assistantMessage, preview: event.preview }),
          });
        } else if (event.type === 'action_task_preview') {
          turnHadAction = true;
          // create_task via chat never saves by itself — this is a preview
          // card only, same shape as create_goal's. Its meta.preview is
          // exactly what POST /tasks {previewMessageId} re-validates and
          // creates once the user taps Create.
          const [assistantMessage] = await db
            .insert(messages)
            .values({
              conversationId: conversation.id,
              role: 'assistant',
              content: event.summary,
              meta: { kind: 'task_creation_pending', action: event.toolName, preview: event.preview },
            })
            .returning();
          await stream.writeSSE({
            event: 'action',
            data: JSON.stringify({ message: assistantMessage, preview: event.preview }),
          });
        } else if (event.type === 'action_goal') {
          turnHadAction = true;
          // advance_goal_stage doesn't mutate anything — it comes back with
          // recordKind: 'goal_advance_pending' so the client renders a
          // Confirm/Cancel card (same `task_removal_pending` trick as the
          // `action` branch above) instead of a read-only one, and the
          // proposal is stamped onto meta so POST /goals/:id/advance can
          // re-validate exactly what the card showed.
          const kind = event.recordKind === 'goal_advance_pending' ? 'goal_advance_pending' : 'goal_action';
          const [assistantMessage] = await db
            .insert(messages)
            .values({
              conversationId: conversation.id,
              role: 'assistant',
              content: event.summary,
              meta: {
                kind,
                action: event.toolName,
                goalId: event.goal.id,
                goal: event.goal,
                ...(event.proposal ? { proposal: event.proposal } : {}),
              },
            })
            .returning();
          await stream.writeSSE({
            event: 'action',
            data: JSON.stringify({ message: assistantMessage, goal: event.goal }),
          });
        } else if (event.type === 'action_bulk') {
          turnHadAction = true;
          // remove_tasks — one card, one confirm, for the whole batch. The
          // client's Confirm button calls POST /tasks/bulk-remove with
          // every taskId listed here.
          const [assistantMessage] = await db
            .insert(messages)
            .values({
              conversationId: conversation.id,
              role: 'assistant',
              content: event.summary,
              meta: {
                kind: 'task_bulk_removal_pending',
                action: event.toolName,
                taskIds: event.tasks.map((t) => t.id),
                tasks: event.tasks,
              },
            })
            .returning();
          await stream.writeSSE({
            event: 'action',
            data: JSON.stringify({ message: assistantMessage, tasks: event.tasks }),
          });
        } else if (event.type === 'action_memory') {
          turnHadAction = true;
          // remember — a real write, always applied immediately (no
          // confirm-card flow; the memory-controls UI is the undo path).
          const [assistantMessage] = await db
            .insert(messages)
            .values({
              conversationId: conversation.id,
              role: 'assistant',
              content: event.summary,
              meta: { kind: 'memory_action', action: event.toolName, memoryId: event.memory.id, memory: event.memory },
            })
            .returning();
          await stream.writeSSE({
            event: 'action',
            data: JSON.stringify({ message: assistantMessage, memory: event.memory }),
          });
        } else if (event.type === 'stream_end') {
          await stream.writeSSE({ event: 'stream_end', data: JSON.stringify({}) });
          // Fire-and-forget, deliberately never awaited — the reply has
          // already fully reached the user by this point, so nothing about
          // this call can add latency to it or surface as a chat error
          // (memory-extractor.ts already catches everything internally;
          // this .catch is a second backstop against a truly unexpected throw).
          void maybeExtractMemories(userId).catch((err) => {
            Sentry.captureException(err);
            logger.error({ err, userId }, 'memory extraction trigger failed');
          });
        } else {
          await stream.writeSSE({
            event: 'error',
            data: JSON.stringify({ retryable: event.retryable, message: event.message }),
          });
        }
      }
    } catch (err) {
      Sentry.captureException(err);
      logger.error(err, 'chat stream failed');
      await stream.writeSSE({
        event: 'error',
        data: JSON.stringify({ retryable: false, message: 'Something went wrong on my end.' }),
      });
    }
  });
});
