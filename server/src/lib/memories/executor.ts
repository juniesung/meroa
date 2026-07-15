import { and, desc, eq, isNull } from 'drizzle-orm';

import { db } from '../../db/client.ts';
import { memories } from '../../db/schema.ts';

export type MemoryRow = typeof memories.$inferSelect;
export type MemoryKind = 'preference' | 'trait' | 'relationship' | 'situation';
export type MemorySource = 'chat_explicit' | 'extracted' | 'manual';

export class MemoryActionError extends Error {}

// Sensitive/health/financial/emotional keywords a memory's own content might
// contain even when neither the remember-tool caller nor the extractor
// flagged it — a deterministic backstop, not a replacement for the model's
// own judgment. Deliberately never used to LOWER sensitivity, only raise it
// (see raiseSensitivityIfNeeded) — a one-way ratchet, same asymmetry as the
// two-key gate in docs/chat-architecture.md §8: the safe direction is free,
// the unsafe direction needs a guarantee.
const SENSITIVE_KEYWORDS =
  /\b(depress|anxiety|anxious|therap|suicid|self.?harm|medication|diagnos|debt|bankrupt|salary|income|divorce|grief|miscarr|abuse|addiction|relapse)\w*\b/i;

function deriveSensitive(content: string, requested: boolean): boolean {
  return requested || SENSITIVE_KEYWORDS.test(content);
}

export async function createMemory(
  userId: string,
  input: {
    kind: MemoryKind;
    content: string;
    sensitive?: boolean;
    source: MemorySource;
    sourceMessageId?: string | null;
  },
): Promise<MemoryRow> {
  const [row] = await db
    .insert(memories)
    .values({
      userId,
      kind: input.kind,
      content: input.content,
      sensitive: deriveSensitive(input.content, input.sensitive ?? false),
      source: input.source,
      sourceMessageId: input.sourceMessageId ?? null,
    })
    .returning();
  if (!row) throw new MemoryActionError('memory_insert_failed');
  return row;
}

// Live rows only (not deleted). `includeSuppressed` controls whether a
// "don't bring this up unless I do" row comes back — the memory-controls UI
// needs to see it to let the user un-suppress it; chat injection never does.
export async function listMemories(
  userId: string,
  opts: { includeSuppressed?: boolean } = {},
): Promise<MemoryRow[]> {
  const conditions = [eq(memories.userId, userId), isNull(memories.deletedAt)];
  if (!opts.includeSuppressed) conditions.push(eq(memories.suppressed, false));
  return db
    .select()
    .from(memories)
    .where(and(...conditions))
    .orderBy(desc(memories.createdAt));
}

export async function getMemory(userId: string, id: string): Promise<MemoryRow | null> {
  const [row] = await db
    .select()
    .from(memories)
    .where(and(eq(memories.id, id), eq(memories.userId, userId), isNull(memories.deletedAt)))
    .limit(1);
  return row ?? null;
}

// The extractor's update/supersede ops both land here — refining a fact's
// wording and replacing it outright are the same storage operation; what
// differs is the extractor's own reasoning about WHY, not how it's stored.
// Deliberately narrow: content only. Sensitivity can never be LOWERED by
// this path (see raiseSensitivityIfNeeded) — only a real person acting
// through the memory-controls UI (updateMemoryFromUser) can do that.
export async function updateMemoryContent(userId: string, id: string, content: string): Promise<MemoryRow | null> {
  const [row] = await db
    .update(memories)
    .set({ content })
    .where(and(eq(memories.id, id), eq(memories.userId, userId), isNull(memories.deletedAt)))
    .returning();
  return row ?? null;
}

// The one-way ratchet: may only flip sensitive false -> true, never the
// reverse. Called after any AI-authored write (remember, extractor) so a
// memory whose content plainly is sensitive can't slip through unflagged
// just because the caller didn't say so.
export async function raiseSensitivityIfNeeded(userId: string, id: string, content: string): Promise<void> {
  if (!SENSITIVE_KEYWORDS.test(content)) return;
  await db
    .update(memories)
    .set({ sensitive: true })
    .where(and(eq(memories.id, id), eq(memories.userId, userId), eq(memories.sensitive, false)));
}

// User-initiated only (the memory-controls UI) — unlike updateMemoryContent,
// this MAY lower sensitivity or flip suppressed, because a real person
// correcting their own data is the one channel that's always allowed to.
export async function updateMemoryFromUser(
  userId: string,
  id: string,
  patch: { content?: string; sensitive?: boolean; suppressed?: boolean },
): Promise<MemoryRow | null> {
  const [row] = await db
    .update(memories)
    .set(patch)
    .where(and(eq(memories.id, id), eq(memories.userId, userId), isNull(memories.deletedAt)))
    .returning();
  return row ?? null;
}

export async function deleteMemory(userId: string, id: string): Promise<boolean> {
  const [row] = await db
    .update(memories)
    .set({ deletedAt: new Date() })
    .where(and(eq(memories.id, id), eq(memories.userId, userId), isNull(memories.deletedAt)))
    .returning({ id: memories.id });
  return !!row;
}
