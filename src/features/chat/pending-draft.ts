// A tiny cross-tab handoff for "Tell Meroa about this" (WS6). Tapping the
// affordance on a goal/task sets a draft here and navigates to the Chat tab;
// the chat screen consumes it on focus into its composer. A module-level
// one-shot is deliberately simpler than route params here: the tabs stay
// mounted, so a param would linger and re-seed on every refocus, and there's no
// global store to thread it through. Set-then-consume-once avoids both.
let pending: string | null = null;

export function setPendingChatDraft(text: string): void {
  pending = text;
}

// Returns the queued draft exactly once, then clears it — so refocusing Chat
// later doesn't re-seed a stale draft.
export function consumePendingChatDraft(): string | null {
  const value = pending;
  pending = null;
  return value;
}

// A natural, editable opener that hands Meroa the entity reference (it already
// sees the full task/goal list in its state block, so the name is enough).
export function tellMeroaDraft(kind: 'task' | 'goal', name: string): string {
  return `about my "${name}" ${kind}, `;
}
