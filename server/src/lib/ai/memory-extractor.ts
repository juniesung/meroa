import { and, asc, eq, gt, sql } from 'drizzle-orm';
import OpenAI from 'openai';
import { z } from 'zod';

import { env } from '../../env.ts';
import { logger } from '../../logger.ts';
import { db } from '../../db/client.ts';
import { conversations, memoryExtractionState, messages } from '../../db/schema.ts';
import { isMemoryGrounded } from './claim-check.ts';
import {
  createMemory,
  getMemory,
  listMemories,
  raiseSensitivityIfNeeded,
  updateMemoryContent,
} from '../memories/executor.ts';

/**
 * Learns durable facts about the user from ordinary conversation, without
 * being asked — the passive half of memory (the `remember` tool, lib/ai/
 * actions.ts, is the explicit half). Deliberately kept OFF the reply's
 * critical path in every sense that matters:
 *
 * - Called fire-and-forget, AFTER stream_end (routes/messages.ts) — nothing
 *   ever awaits this, so it cannot add latency to a reply, and a failure
 *   here can never surface as a chat error.
 * - Batched, not per-turn — most messages have nothing worth learning, and
 *   a model call per message would be latency-free but not COST-free. Waits
 *   for EXTRACTION_MIN_BATCH unprocessed user messages before running at
 *   all (see the watermark in memory_extraction_state).
 * - Writes to exactly ONE table: memories. This file can create, reword, or
 *   retire a memory row — it can never touch records, tasks, goals, or
 *   goal_entries. That boundary is deliberate: the worst bug this file can
 *   ship is a wrong sentence on a settings screen with a delete button next
 *   to it, never a silent write to the ledger.
 *
 * The model output is constrained to three ops (create/update/supersede)
 * against a closed kind enum, and every id it references is verified
 * against real rows before anything is written — the same resolve-then-
 * verify discipline lib/ai/actions.ts uses for task/goal refs
 * (docs/chat-architecture.md §7). A model that cannot express "here's a
 * fresh list of everything I know" cannot duplicate or contradict what's
 * already there; it can only add to, refine, or retire a specific row.
 */

const EXTRACTION_MIN_BATCH = 8;
// Safety cap on one run's input, not a target — a user who goes quiet for
// months and comes back still gets processed in one pass, just a capped one.
// The next trigger picks up wherever this one left off.
const EXTRACTION_MAX_MESSAGES = 40;
const EXTRACTION_MAX_OPS = 5;
const EXTRACTION_TIMEOUT_MS = 15_000;
const EXTRACTION_MAX_TOKENS = 1200;
// Past this many live memories, the extractor is told to prefer update/
// supersede over create, and a create past the cap is refused and logged —
// never silently dropped without a trace.
const MEMORY_CAP_PER_USER = 100;
// How many existing memories the model sees for dedupe context — capped
// independently of the hard per-user cap so the prompt itself stays small.
const EXISTING_MEMORIES_CONTEXT_CAP = 60;

const createOpSchema = z.object({
  op: z.literal('create'),
  content: z.string().trim().min(1).max(200),
  kind: z.enum(['preference', 'trait', 'relationship', 'situation']),
  sensitive: z.boolean().optional(),
  sourceMessageId: z.string(),
});
const updateOpSchema = z.object({
  op: z.literal('update'),
  id: z.string(),
  content: z.string().trim().min(1).max(200),
});
const supersedeOpSchema = z.object({
  op: z.literal('supersede'),
  id: z.string(),
  content: z.string().trim().min(1).max(200),
});
const extractionOpSchema = z.discriminatedUnion('op', [createOpSchema, updateOpSchema, supersedeOpSchema]);
const extractionResponseSchema = z.object({ ops: z.array(extractionOpSchema).max(EXTRACTION_MAX_OPS) });

const EXTRACTION_SYSTEM_PROMPT = `You read a slice of a conversation between a companion app and its user, and decide what — if anything — is worth remembering about the USER long-term.

Output ONLY a JSON object: {"ops": [...]}. Each op is one of:
- {"op":"create","content":"...","kind":"preference|trait|relationship|situation","sensitive":true|false,"sourceMessageId":"..."} — a genuinely new, durable fact. sourceMessageId MUST be the exact id of one of the numbered messages you were shown.
- {"op":"update","id":"...","content":"..."} — refines the WORDING of an existing memory (the "id" of a memory you were shown) without changing what it means.
- {"op":"supersede","id":"...","content":"..."} — an existing memory is now WRONG or outdated; replaces its content with the corrected fact.

Kind meanings: preference = how they like things done. trait = a durable fact about who they are. relationship = a person in their life. situation = something ongoing right now (will eventually stop being true — a job search, a recovery, a project).

Rules:
- Only the user's own words are evidence. Never invent, infer beyond what they said, or use anything the assistant said as a fact about the user.
- Forget the trivial. A single day's mood, a one-off event, or small talk is NOT worth a memory. Only durable, useful facts: something that would still be true and still matter weeks from now.
- The EXISTING MEMORIES you're shown are your own prior output, given ONLY so you can avoid re-creating the same fact and can catch a contradiction — never treat them as new evidence about the user.
- If a new message plainly contradicts an existing memory (moved cities, broke up, changed jobs), use "supersede", not a second "create" for the same fact.
- If nothing here is worth remembering, return {"ops": []}. Most batches should produce zero or one op — this is deliberately conservative, not a places-to-fill quota.
- Never a task, a to-do, or a trackable number — this app tracks those separately; you are only capturing context about who the person is.
- sensitive: true for anything touching health, money, or emotional wellbeing. When genuinely unsure, prefer true.`;

let client: OpenAI | null = null;
function getClient(): OpenAI | null {
  if (!env.DEEPSEEK_API_KEY) return null;
  if (!client) client = new OpenAI({ apiKey: env.DEEPSEEK_API_KEY, baseURL: 'https://api.deepseek.com' });
  return client;
}

const LOCK_NAMESPACE = 'memory:';

type ClaimedBatch = { messages: { id: string; content: string; createdAt: Date }[] };

/**
 * Transactional claim: holds the advisory lock only long enough to read the
 * unprocessed batch and advance the watermark past it — never across the
 * slow LLM call that follows. That means two overlapping triggers for the
 * same user can't double-process the same messages (the second sees an
 * already-advanced watermark), and a failed/slow LLM call never holds a
 * lock open. The tradeoff, deliberately accepted: if the LLM call after
 * this fails, this batch is not retried — memory extraction is best-effort,
 * not a data-integrity path like records/tasks.
 */
async function claimBatch(userId: string): Promise<ClaimedBatch | null> {
  return db.transaction(async (tx) => {
    const [lockRow] = await tx.execute<{ locked: boolean }>(
      sql`select pg_try_advisory_xact_lock(hashtext(${LOCK_NAMESPACE + userId})::bigint) as locked`,
    );
    if (!lockRow?.locked) return null; // another extraction is already in flight for this user

    const [state] = await tx
      .select()
      .from(memoryExtractionState)
      .where(eq(memoryExtractionState.userId, userId))
      .limit(1);

    let since: Date | null = null;
    if (state?.lastMessageId) {
      const [watermark] = await tx
        .select({ createdAt: messages.createdAt })
        .from(messages)
        .where(eq(messages.id, state.lastMessageId))
        .limit(1);
      since = watermark?.createdAt ?? null;
    }

    const conditions = [eq(conversations.userId, userId), eq(messages.role, 'user')];
    if (since) conditions.push(gt(messages.createdAt, since));

    const batch = await tx
      .select({ id: messages.id, content: messages.content, createdAt: messages.createdAt })
      .from(messages)
      .innerJoin(conversations, eq(messages.conversationId, conversations.id))
      .where(and(...conditions))
      .orderBy(asc(messages.createdAt))
      .limit(EXTRACTION_MAX_MESSAGES);

    if (batch.length < EXTRACTION_MIN_BATCH) return null; // not enough yet — try again next trigger

    const newest = batch[batch.length - 1]!;
    await tx
      .insert(memoryExtractionState)
      .values({ userId, lastMessageId: newest.id, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: memoryExtractionState.userId,
        set: { lastMessageId: newest.id, updatedAt: new Date() },
      });

    return { messages: batch };
  });
}

function buildUserPrompt(
  batch: ClaimedBatch['messages'],
  existing: { id: string; kind: string; content: string }[],
): string {
  const messagesText = batch.map((m) => `[${m.id}] ${m.content}`).join('\n');
  const existingText =
    existing.length > 0
      ? existing.map((m) => `[${m.id}] (${m.kind}) ${m.content}`).join('\n')
      : '(none yet)';
  return `EXISTING MEMORIES (your own prior output — for dedupe/contradiction only, not evidence):\n${existingText}\n\nNEW MESSAGES FROM THE USER, oldest first, each tagged with its real id:\n${messagesText}`;
}

async function runExtraction(
  batch: ClaimedBatch['messages'],
  existing: { id: string; kind: string; content: string }[],
): Promise<z.infer<typeof extractionResponseSchema>['ops']> {
  const openai = getClient();
  if (!openai) return [];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EXTRACTION_TIMEOUT_MS);
  try {
    const completion = await openai.chat.completions.create(
      {
        model: env.CLAIM_CHECK_MODEL,
        max_tokens: EXTRACTION_MAX_TOKENS,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
          { role: 'user', content: buildUserPrompt(batch, existing) },
        ],
      },
      { signal: controller.signal },
    );
    const raw = completion.choices[0]?.message?.content?.trim() ?? '';
    if (!raw) return [];
    const parsed = extractionResponseSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      logger.warn({ issues: parsed.error.issues }, 'memory extraction — malformed model output, discarded');
      return [];
    }
    return parsed.data.ops;
  } catch (err) {
    logger.warn({ err }, 'memory extraction — model call failed, batch dropped');
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

async function applyOps(
  userId: string,
  ops: z.infer<typeof extractionResponseSchema>['ops'],
  batchMessages: Map<string, string>,
): Promise<void> {
  let liveCount: number | null = null;
  for (const op of ops) {
    try {
      if (op.op === 'create') {
        // resolve-then-verify (docs/chat-architecture.md §7): a
        // sourceMessageId the model couldn't have known is hallucinated,
        // stale, or copied — reject rather than trust it.
        const sourceText = batchMessages.get(op.sourceMessageId);
        if (sourceText === undefined) {
          logger.warn({ userId, sourceMessageId: op.sourceMessageId }, 'memory extraction — create referenced a message outside this batch, dropped');
          continue;
        }
        // The id being real doesn't mean the CLAIM is — see isMemoryGrounded's
        // doc comment for the live incident this closes. Checked against the
        // real text of the cited message, not the model's own paraphrase of it.
        if (!(await isMemoryGrounded(op.content, sourceText))) {
          logger.warn({ userId, content: op.content, sourceMessageId: op.sourceMessageId }, 'memory extraction — create not grounded in its cited message, dropped');
          continue;
        }
        if (liveCount === null) liveCount = (await listMemories(userId, { includeSuppressed: true })).length;
        if (liveCount >= MEMORY_CAP_PER_USER) {
          logger.warn({ userId, cap: MEMORY_CAP_PER_USER }, 'memory extraction — user at memory cap, create refused');
          continue;
        }
        await createMemory(userId, {
          kind: op.kind,
          content: op.content,
          sensitive: op.sensitive,
          source: 'extracted',
          sourceMessageId: op.sourceMessageId,
        });
        liveCount += 1;
      } else {
        const existingRow = await getMemory(userId, op.id);
        if (!existingRow) {
          logger.warn({ userId, id: op.id, op: op.op }, 'memory extraction — referenced a memory that does not exist, dropped');
          continue;
        }
        await updateMemoryContent(userId, op.id, op.content);
        // Never lowers sensitivity — only ever raises it (see the ratchet
        // note on raiseSensitivityIfNeeded). A reworded fact might now read
        // as sensitive even if the original didn't.
        await raiseSensitivityIfNeeded(userId, op.id, op.content);
      }
    } catch (err) {
      logger.error({ err, userId, op }, 'memory extraction — applying one op failed, continuing with the rest');
    }
  }
}

/**
 * Fire-and-forget entry point — call as `void maybeExtractMemories(userId)`
 * (or with its own .catch) AFTER a turn's stream_end, never awaited on the
 * request path. Safe to call on every turn: the batch-size gate inside
 * claimBatch makes every call before the threshold a single cheap SELECT.
 */
export async function maybeExtractMemories(userId: string): Promise<void> {
  try {
    const claimed = await claimBatch(userId);
    if (!claimed) return;

    const existing = (await listMemories(userId, { includeSuppressed: true }))
      .slice(0, EXISTING_MEMORIES_CONTEXT_CAP)
      .map((m) => ({ id: m.id, kind: m.kind, content: m.content }));

    const ops = await runExtraction(claimed.messages, existing);
    if (ops.length === 0) return;

    const batchMessages = new Map(claimed.messages.map((m) => [m.id, m.content]));
    await applyOps(userId, ops, batchMessages);
  } catch (err) {
    // Never let an extraction failure be visible to the request that
    // triggered it — this is called fire-and-forget specifically so it
    // can't be.
    logger.error({ err, userId }, 'memory extraction run failed');
  }
}
