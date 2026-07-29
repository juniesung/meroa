import { db } from '../../db/client.ts';
import { messages } from '../../db/schema.ts';
import { getOrCreateAppConversation } from '../conversations.ts';
import { stripEmDashes } from '../ai/system-prompt.ts';
import { claimNotification, deliverPush } from './send.ts';

// The shared "Meroa reaches out first" delivery step, used by BOTH the cron
// tick (notifications/tick.ts) and the event-driven reaction path
// (notifications/reactions.ts + the mutation routes). Callers compose their own
// bodies — the two paths word them differently — and this does the invariant
// part: claim (dedupe + cap logging) FIRST, then, only if the claim won,
// insert the real message into the chat thread and optionally push.
//
// Ordering matters and is the whole reason claim comes first: if a concurrent
// caller already claimed this exact dedupeKey, we produce neither a chat
// message nor a push. "A missed reach-out is cheaper than a duplicate one"
// (tick.ts) — and that now covers the in-chat message, not just the push.
export type ThreadReachOut = {
  kind: string;
  dedupeKey: string;
  // The real message dropped into the chat thread (Meroa's actual voice).
  chatBody: string;
  // The short push-preview alert. Omit for thread-only reach-outs (reactions
  // don't push in v1) — the claim then logs the chat body as its record.
  pushBody?: string;
  // Merged into the push payload's `data` (tap routing). Ignored when not pushing.
  data?: Record<string, unknown>;
};

/**
 * Claims, then delivers a proactive reach-out into the user's chat thread (and
 * optionally as a push). Returns true only if this call won the claim and the
 * message was inserted — false if a duplicate claim lost the race. Never throws
 * for a push failure (delivery is best-effort); a DB failure propagates to the
 * caller, which decides whether to swallow it (the reaction path does).
 */
export async function deliverThreadReachOut(
  userId: string,
  reachOut: ThreadReachOut,
  opts: { push?: boolean } = {},
): Promise<boolean> {
  // Strip em/en dashes — the classic AI-writing tell the app removes everywhere
  // else (system-prompt.ts stripEmDashes, enforced on every narrate reply). The
  // proactive composers ask the model to avoid them but can't guarantee it, so
  // enforce it here at the one boundary both the tick and reactions pass through.
  const chatBody = stripEmDashes(reachOut.chatBody);
  const pushBody = reachOut.pushBody ? stripEmDashes(reachOut.pushBody) : undefined;

  const claimed = await claimNotification(userId, {
    kind: reachOut.kind,
    title: 'Meroa',
    body: pushBody ?? chatBody,
    dedupeKey: reachOut.dedupeKey,
  });
  if (!claimed) return false;

  const conversation = await getOrCreateAppConversation(userId);
  // `meta.proactiveKind`, never `meta.kind`: `kind` is a reserved card/pending
  // classifier (routes/messages.ts) and a proactive message is plain prose.
  await db.insert(messages).values({
    conversationId: conversation.id,
    role: 'assistant',
    content: chatBody,
    meta: { proactive: true, proactiveKind: reachOut.kind },
  });

  if (opts.push && pushBody) {
    await deliverPush(userId, {
      kind: reachOut.kind,
      title: 'Meroa',
      body: pushBody,
      data: reachOut.data,
    });
  }
  return true;
}
