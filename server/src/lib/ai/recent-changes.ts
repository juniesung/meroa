import { and, asc, eq, gt, inArray, or } from 'drizzle-orm';

import { db } from '../../db/client.ts';
import { records, tasks } from '../../db/schema.ts';

const MAX_FEED_ENTRIES = 5;

function describeChange(kind: string, title: string): string {
  switch (kind) {
    case 'task_created':
      return `"${title}" was added`;
    case 'task_edited':
      return `"${title}" was edited`;
    case 'task_completion':
      return `"${title}" was marked done`;
    case 'task_progress':
      return `"${title}" progress was updated`;
    case 'task_postponed':
      return `"${title}" was postponed`;
    case 'task_removed':
      return `"${title}" was removed (you confirmed it)`;
    case 'tool_created':
      return `the "${title}" tool was created (you tapped Create)`;
    case 'tool_edited':
      return `the "${title}" tool was edited`;
    case 'tool_entry':
      return `an entry was logged to "${title}"`;
    case 'tool_archived':
      return `the "${title}" tool was removed`;
    default:
      return `"${title}" changed`;
  }
}

// An undo reverses whichever kind of change it originally was — "restored"
// only reads right for a removal; the others need their own phrasing so the
// feed doesn't say something misleading like "X was restored" for an undone
// edit.
function describeUndo(undidKind: string, title: string): string {
  switch (undidKind) {
    case 'task_removed':
      return `"${title}" was restored (you undid removing it)`;
    case 'task_created':
      return `"${title}" was removed (you undid creating it)`;
    case 'task_completion':
    case 'task_progress':
      return `"${title}" progress was reverted (you undid the last change)`;
    case 'task_edited':
      return `"${title}" was reverted to its previous version (you undid the edit)`;
    case 'task_postponed':
      return `"${title}" was reverted to its previous due date (you undid the postpone)`;
    case 'tool_created':
      return `the "${title}" tool was removed (you undid creating it)`;
    case 'tool_archived':
      return `the "${title}" tool was brought back (you undid removing it)`;
    case 'tool_edited':
      return `the "${title}" tool was reverted to its previous version (you undid the edit)`;
    case 'tool_entry':
      return `that entry on "${title}" was removed (you undid logging it)`;
    default:
      return `"${title}" was reverted (you undid the last change)`;
  }
}

/**
 * Out-of-band task/tool mutations — a Tasks-tab tap, a tool preview
 * Create-tap, a quick-entry log — are otherwise invisible to the model: its
 * own history only ever shows the "pending confirmation" side of the story,
 * never how it resolved. This surfaces everything recorded with source
 * 'tasks_ui' or 'tool_ui' since the previous user message as short prose, so
 * the model's next reply can reflect what actually happened instead of
 * completing an unresolved narrative wrongly (docs/ai-reliability-
 * hardening.md item 4, class 7). Returns '' when there's nothing to report
 * (including the first-ever message, when `since` is null).
 */
export async function buildRecentChangesFeed(userId: string, since: Date | null): Promise<string> {
  if (!since) return '';

  const rows = await db
    .select({ kind: records.kind, payload: records.payload })
    .from(records)
    .where(
      and(
        eq(records.userId, userId),
        or(eq(records.source, 'tasks_ui'), eq(records.source, 'tool_ui')),
        gt(records.occurredAt, since),
      ),
    )
    .orderBy(asc(records.occurredAt))
    .limit(MAX_FEED_ENTRIES);

  if (rows.length === 0) return '';

  const parsed = rows.map((row) => ({
    kind: row.kind,
    payload: row.payload as {
      taskId?: string;
      title?: string;
      // Tool payloads always carry `name` (the executor always has the
      // tool row in hand) — unlike task_edited's `title`, no batched lookup
      // is ever needed for these.
      name?: string;
      tasks?: { taskId: string; title: string }[];
      undidKind?: string;
    },
  }));

  // Only task_edited's payload lacks a title today, but this stays generic
  // rather than special-casing that kind by name — one batched lookup for
  // whichever rows need it, instead of one query per row.
  const missingTitleIds = [
    ...new Set(
      parsed
        .filter((r) => !r.payload.title && !r.payload.name && !r.payload.tasks?.length && r.payload.taskId)
        .map((r) => r.payload.taskId!),
    ),
  ];
  const titleById = new Map<string, string>();
  if (missingTitleIds.length > 0) {
    const found = await db
      .select({ id: tasks.id, title: tasks.title })
      .from(tasks)
      .where(inArray(tasks.id, missingTitleIds));
    for (const t of found) titleById.set(t.id, t.title);
  }

  const sentences: string[] = [];
  for (const { kind, payload } of parsed) {
    if (kind === 'task_undo' || kind === 'tool_undo') {
      const undidKind = payload.undidKind ?? 'unknown';
      if (payload.tasks?.length) {
        for (const t of payload.tasks) sentences.push(describeUndo(undidKind, t.title));
        continue;
      }
      const title = payload.title ?? payload.name ?? (payload.taskId && titleById.get(payload.taskId));
      sentences.push(describeUndo(undidKind, title || 'a task'));
      continue;
    }
    if (payload.tasks?.length) {
      for (const t of payload.tasks) sentences.push(describeChange(kind, t.title));
      continue;
    }
    const title = payload.title ?? payload.name ?? (payload.taskId && titleById.get(payload.taskId));
    sentences.push(describeChange(kind, title || 'a task'));
  }

  return `Since your last message, in the app: ${sentences.join('; ')}.`;
}
