import { AI_CONSENT_VERSION } from './constants.ts';

// The shape stored at users.prefs.aiConsent. `at`/`version` are always
// server-stamped (routes/me.ts) — the client only ever asserts `granted`, so
// it cannot forge agreement to a disclosure version it never saw.
export type AiConsent = { granted: boolean; at: string; version: number };

// Apple 5.1.2(i): the compliance boundary is HERE, in code — not in the client
// nav guard. The server refuses to send anything to the third-party AI provider
// until the user has granted consent to the CURRENT disclosure version, so a
// client that skipped the gate (or an old build) still cannot reach the model.
// This is docs/chat-architecture.md §0: a guarantee lives in code, not a prompt
// or a screen.
export function hasValidAiConsent(prefs: unknown): boolean {
  const consent = (prefs as { aiConsent?: Partial<AiConsent> } | null | undefined)?.aiConsent;
  return (
    consent?.granted === true &&
    typeof consent.version === 'number' &&
    consent.version >= AI_CONSENT_VERSION
  );
}
