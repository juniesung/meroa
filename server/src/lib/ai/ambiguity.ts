// Lives here (not actions.ts, which imports findAmbiguousTaskMatch below —
// a two-way import would be circular) so both the titleHint check and the
// ambiguity guard share one "what counts as a word" definition.
export function normalizeForMatch(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9\s]/g, '');
}

// Common words that appear in a completion request but say nothing about
// WHICH task is meant — without stripping these, "mark it done today"
// would spuriously "match" any task whose title happens to contain "today".
// Deliberately small: it only needs to remove the app's own command
// vocabulary and the highest-frequency fillers, not attempt real stopword
// coverage.
const STOPWORDS = new Set([
  'mark', 'marked', 'marking', 'done', 'complete', 'completed', 'finish', 'finished',
  'task', 'tasks', 'add', 'log', 'logged', 'today', 'tomorrow', 'please', 'now',
  'the', 'and', 'for', 'with', 'that', 'this', 'was', 'are', 'has', 'have', 'not', 'did', 'just',
]);

function significantWords(s: string): Set<string> {
  return new Set(
    normalizeForMatch(s)
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
  );
}

export type AmbiguityCandidate = { id: string; title: string };

/**
 * Deterministic backstop for chat-architecture.md §0's "make the server
 * refuse" — the model's own ambiguity judgment (system-prompt.ts's "if the
 * user's words could plausibly refer to more than one item, call
 * no_action") held only ~2/3 of the time live: "mark water done" with both
 * "Water the plants" and "drink 8 glasses of water" open wrote to one
 * instead of asking (docs/goal-manual-editing-plan.md §4).
 *
 * This re-derives the same judgment from the user's OWN words — never the
 * model's titleHint, which is the model's post-hoc justification for
 * whichever task it already picked, i.e. exactly the belief that's wrong
 * when this fails.
 *
 * Fires only when >= 2 candidates share a significant word with the
 * message AND no shared word is unique to exactly one of them — a word
 * that pins one candidate and rules out the rest means the reference was
 * distinguished, not ambiguous ("mark the plants done" matches only one
 * task even though "water" would also have matched a second). An empty
 * word set (anaphora — "mark that done") can't be judged this way at all;
 * model judgment stands, same as before this guard existed.
 */
export function findAmbiguousTaskMatch(
  userMessage: string,
  candidates: AmbiguityCandidate[],
): { candidates: AmbiguityCandidate[] } | null {
  const messageWords = significantWords(userMessage);
  if (messageWords.size === 0) return null;

  const matched = candidates
    .map((candidate) => ({ candidate, words: significantWords(candidate.title) }))
    .filter(({ words }) => [...words].some((w) => messageWords.has(w)));

  if (matched.length < 2) return null;

  const sharedWordCounts = new Map<string, number>();
  for (const { words } of matched) {
    for (const w of words) {
      if (!messageWords.has(w)) continue;
      sharedWordCounts.set(w, (sharedWordCounts.get(w) ?? 0) + 1);
    }
  }
  const isDistinguished = matched.some(({ words }) =>
    [...words].some((w) => messageWords.has(w) && sharedWordCounts.get(w) === 1),
  );
  if (isDistinguished) return null;

  return { candidates: matched.map((m) => m.candidate) };
}
