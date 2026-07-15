export type VibePreset = 'chill' | 'supportive' | 'direct' | 'playful' | 'balanced';

export const VIBE_OPTIONS: { key: VibePreset; label: string; description: string }[] = [
  { key: 'balanced', label: 'Balanced', description: 'A little of everything — the default feel.' },
  { key: 'chill', label: 'Chill', description: 'Low-key, brief, no fuss.' },
  { key: 'supportive', label: 'Supportive', description: 'Warmer and more encouraging.' },
  { key: 'direct', label: 'Direct', description: 'Short, plain, straight to it.' },
  { key: 'playful', label: 'Playful', description: 'More banter, more texture.' },
];

export function vibeLabel(key: unknown): string {
  const match = VIBE_OPTIONS.find((v) => v.key === key);
  return match?.label ?? 'Balanced';
}
