// Voice tone is a single warmth↔edge slider (it replaced the five named vibe
// presets). 0 = warmest/gentlest, 4 = edgiest/most roast-y, 2 = balanced.
// Mirrors the server's lib/ai/system-prompt.ts (resolveTone + DEFAULT_TONE) so
// the label the user sees matches the voice they get.
export const TONE_MIN = 0;
export const TONE_MAX = 4;
export const DEFAULT_TONE = 2;

export const TONE_STOPS: { level: number; label: string }[] = [
  { level: 0, label: 'Warmest' },
  { level: 1, label: 'Warm' },
  { level: 2, label: 'Balanced' },
  { level: 3, label: 'Edgy' },
  { level: 4, label: 'Edgiest' },
];

export function toneLabel(level: number): string {
  return TONE_STOPS.find((s) => s.level === level)?.label ?? 'Balanced';
}

// A one-line description under the slider so the setting is more than a word.
const TONE_BLURB: Record<number, string> = {
  0: 'Gentle and encouraging. All warmth, no teasing.',
  1: 'Warm and supportive, with just a little candor.',
  2: 'A real friend: honest, a little humor, holds you to your word.',
  3: 'Blunter and more teasing. Calls things as they are.',
  4: 'Sharp, dry, and a little roast-y. Tough love, full send.',
};
export function toneBlurb(level: number): string {
  return TONE_BLURB[level] ?? TONE_BLURB[DEFAULT_TONE] ?? '';
}

// Client mirror of the server's resolveTone: prefer prefs.tone, otherwise map a
// legacy communicationStyle preset onto the scale, else the default. Keeps a
// user onboarded before the slider existed showing a coherent label.
const LEGACY_STYLE_TONE: Record<string, number> = {
  supportive: 1,
  chill: 2,
  balanced: 2,
  playful: 3,
  direct: 3,
};
export function toneFromPrefs(prefs: Record<string, unknown> | null | undefined): number {
  const t = prefs?.tone;
  if (typeof t === 'number' && Number.isInteger(t) && t >= TONE_MIN && t <= TONE_MAX) return t;
  const legacy = prefs?.communicationStyle;
  const mapped = typeof legacy === 'string' ? LEGACY_STYLE_TONE[legacy] : undefined;
  return mapped ?? DEFAULT_TONE;
}
