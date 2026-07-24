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

// A live example of how Meroa replies at each level — the same situation
// ("skipped the gym again") answered five ways, so moving the slider shows the
// voice change instead of describing it. Shown under the slider (ToneSlider).
export const TONE_EXAMPLE_PROMPT = 'skipped the gym again 😩';
const TONE_EXAMPLE: Record<number, string> = {
  0: 'no shame at all, some weeks are just heavy. want to start tiny tomorrow?',
  1: "hey, it happens. what'd make tomorrow a little easier to show up?",
  2: "third one this week though. what's actually getting in the way?",
  3: 'third this week. "tomorrow" isn\'t a plan. what\'s the real blocker?',
  4: 'you and the gym are basically pen pals now. three skips, quit stalling. what\'s up?',
};
export function toneExample(level: number): string {
  return TONE_EXAMPLE[level] ?? TONE_EXAMPLE[DEFAULT_TONE] ?? '';
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
