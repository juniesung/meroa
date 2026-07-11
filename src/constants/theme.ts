import { Platform } from 'react-native';

export const theme = {
  blue: '#0A84FF',
  blueDeep: '#2563EB',
  blueLight: '#5AB0FF',
  gradient: ['#1E8BFF', '#0A6DF0'] as const,
  text: '#F5F7FA',
  dim: '#8E949E',
  faint: '#5B6068',
  bg: '#030507',
  surface: '#111318',
  card: '#191C22',
  card2: '#1F232B',
  bubbleAI: '#1C1F25',
  border: 'rgba(255,255,255,0.06)',
  borderStrong: 'rgba(255,255,255,0.1)',
  success: '#30D158',
  danger: '#FF453A',
} as const;

export type Theme = typeof theme;

export const radii = {
  bubble: 20,
  bubbleTail: 6,
  card: 18,
  section: 16,
  control: 18,
  controlTight: 14,
  chip: 10,
  pill: 999,
} as const;

export const type = {
  title: { fontSize: 16, fontWeight: '700' as const },
  header: { fontSize: 28, fontWeight: '700' as const, letterSpacing: -0.5 },
  eyebrow: { fontSize: 11, fontWeight: '700' as const, letterSpacing: 1.2, textTransform: 'uppercase' as const },
  body: { fontSize: 15, fontWeight: '400' as const },
  meta: { fontSize: 13, fontWeight: '400' as const },
  bubble: { fontSize: 15, lineHeight: 20 },
} as const;

export const Fonts = Platform.select({
  ios: {
    sans: 'system-ui',
    rounded: 'ui-rounded',
    mono: 'ui-monospace',
  },
  default: {
    sans: 'normal',
    rounded: 'normal',
    mono: 'monospace',
  },
});

export const Spacing = {
  half: 2,
  one: 4,
  two: 8,
  three: 16,
  four: 24,
  five: 32,
  six: 64,
} as const;

export const TAB_BAR_CONTENT_HEIGHT = 56;
export const MaxContentWidth = 800;
