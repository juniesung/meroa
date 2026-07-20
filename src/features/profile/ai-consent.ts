// Client mirror of server/src/lib/constants.ts AI_CONSENT_VERSION. These two
// MUST move together: the server refuses sends unless the stored version is
// >= its own, so bumping one without the other either re-prompts everyone with
// no server change (harmless) or, worse, lets the client think consent is
// current when the server disagrees. Kept tiny and colocated with the reader
// so the coupling is obvious.
export const AI_CONSENT_VERSION = 1;

// Whether the user has valid, current AI-sharing consent. Same predicate the
// server enforces (lib/consent.ts) — the nav guard uses this to decide whether
// to route to the consent screen before chat. Reads the untyped prefs blob
// defensively.
export function consentGranted(prefs: Record<string, unknown> | undefined): boolean {
  const consent = (prefs as { aiConsent?: { granted?: unknown; version?: unknown } } | undefined)?.aiConsent;
  return (
    consent?.granted === true &&
    typeof consent.version === 'number' &&
    consent.version >= AI_CONSENT_VERSION
  );
}
