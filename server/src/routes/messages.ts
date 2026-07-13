import { zValidator } from '@hono/zod-validator';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';

import { db } from '../db/client.ts';
import { messages, records, users } from '../db/schema.ts';
import { streamChatReply, type ChatHistoryMessage } from '../lib/ai/chat.ts';
import { buildRecentChangesFeed, renderUndoTarget } from '../lib/ai/recent-changes.ts';
import { buildConversationTailBlock, buildTailBlock } from '../lib/ai/system-prompt.ts';
import { buildTaskContext } from '../lib/ai/task-context.ts';
import { buildGoalContext } from '../lib/ai/goal-context.ts';
import { findPendingPreview, renderPendingPreview } from '../lib/ai/pending-preview.ts';
import { buildGoalConsistency } from '../lib/goals/consistency.ts';
import { getOrCreateAppConversation, getRecentMessages } from '../lib/conversations.ts';
import { peekUndoTarget } from '../lib/tasks/executor.ts';
import { materializeRecurringInstances } from '../lib/tasks/recurrence.ts';
import { computeAllowance, withUserChatLock } from '../lib/usage.ts';
import { logger } from '../logger.ts';
import { isToolCallMarkupLeak } from '../lib/ai/providers/shared.ts';
import { requireAuth, type AuthVariables } from '../middleware/auth.ts';

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

const sendSchema = z.object({ text: z.string().trim().min(1).max(4000) });

function isChatRole(role: string): role is 'user' | 'assistant' {
  return role === 'user' || role === 'assistant';
}

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
  'goal_action',
  'goal_preview',
  'goal_advance_pending',
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
  'goal_advance_pending',
  'goal_preview',
]);

function isPendingCardMessage(m: { meta: unknown }): boolean {
  const meta = m.meta as { kind?: string } | null;
  return !!meta?.kind && PENDING_CARD_KINDS.has(meta.kind);
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
messageRoutes.post('/', zValidator('json', sendSchema), async (c) => {
  const userId = c.get('userId');
  const { text } = c.req.valid('json');

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
    return { limited: false as const, userMessage };
  });

  if (result.limited) {
    return c.json(
      { error: 'limit_reached', plan: result.allowance.plan, limit: result.allowance.limit },
      429,
    );
  }
  const { userMessage } = result;

  const [user] = await db
    .select({ displayName: users.displayName, timezone: users.timezone })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const userContext = user ?? { displayName: null, timezone: null };

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
  const [taskContext, consistency] = await Promise.all([
    buildTaskContext(userId, userContext.timezone),
    buildGoalConsistency(userId, userContext.timezone),
  ]);
  // Appends into the same TurnRefs map task context just built — one ref
  // namespace ("T*"/"G*") covers both tasks and goals for the turn.
  const goalContext = await buildGoalContext(userId, userContext.timezone, taskContext.refs);
  // Always a concrete sentence, never '' — with nothing here, "do I have a
  // streak?" left the model to invent an explanation (observed live:
  // "none of your tasks are set up for it", which isn't how streaks work).
  const streakText =
    consistency.current > 0
      ? `${consistency.current}-day perfect streak (longest: ${consistency.longest}).`
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
  const pendingPreviewText = renderPendingPreview(pendingPreview);

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
  const sharedTail = {
    now: new Date(),
    timezone: userContext.timezone,
    counts: taskContext.counts,
    taskListText: taskContext.text,
    goalListText: goalContext.text,
    streakText,
    pendingPreviewText,
  };
  const tailText = buildTailBlock({ ...sharedTail, recentChangesText, undoTargetText });
  const narrateTailText = buildTailBlock({ ...sharedTail, recentChangesText });
  const conversationTailText = buildConversationTailBlock(sharedTail.now, userContext.timezone);
  // What the GUARDS are shown (claim-check, figure-check): the plain truth about
  // what the user has, and nothing else. Deliberately NOT tailText — that carries
  // the recent-changes feed ("Since your last message, in the app: removed …") and
  // the undo target, and handing those to a classifier whose whole premise is
  // "nothing changed this turn" is a contradiction. It duly got confused and
  // retracted two perfectly honest replies live. A guard can only be as good as
  // the facts you give it.
  const stateFactsText = buildTailBlock(sharedTail);

  return streamSSE(c, async (stream) => {
    await stream.writeSSE({ event: 'user_message', data: JSON.stringify(userMessage) });

    // Hono's streamSSE only console.errors an uncaught throw — it never
    // notifies the client. Without this try/catch, a DB error mid-segment
    // (rare, but possible) would leave the client's typing indicator hanging
    // forever with no error and no retry path.
    try {
      for await (const event of streamChatReply(chatHistory, userContext, tailText, narrateTailText, conversationTailText, stateFactsText, {
        userId,
        timezone: userContext.timezone,
        sourceMessageId: userMessage.id,
        refs: taskContext.refs,
        pendingConfirmCard,
        hasPendingPreview: !!pendingPreview,
      })) {
        if (event.type === 'delta') {
          await stream.writeSSE({ event: 'delta', data: JSON.stringify({ text: event.text }) });
        } else if (event.type === 'segment_end') {
          const [assistantMessage] = await db
            .insert(messages)
            .values({ conversationId: conversation.id, role: 'assistant', content: event.text })
            .returning();
          await stream.writeSSE({
            event: 'segment',
            data: JSON.stringify({ message: assistantMessage }),
          });
        } else if (event.type === 'action') {
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
        } else if (event.type === 'action_preview') {
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
              meta: { kind: 'goal_preview', action: event.toolName, preview: event.preview },
            })
            .returning();
          await stream.writeSSE({
            event: 'action',
            data: JSON.stringify({ message: assistantMessage, preview: event.preview }),
          });
        } else if (event.type === 'action_goal') {
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
        } else if (event.type === 'stream_end') {
          await stream.writeSSE({ event: 'stream_end', data: JSON.stringify({}) });
        } else {
          await stream.writeSSE({
            event: 'error',
            data: JSON.stringify({ retryable: event.retryable, message: event.message }),
          });
        }
      }
    } catch (err) {
      logger.error(err, 'chat stream failed');
      await stream.writeSSE({
        event: 'error',
        data: JSON.stringify({ retryable: false, message: 'Something went wrong on my end.' }),
      });
    }
  });
});
