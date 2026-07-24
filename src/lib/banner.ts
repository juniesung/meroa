import type { ViewStyle } from 'react-native';

// Darken a #rrggbb hex toward black by `factor` (0..1). Used for the shadow /
// deep edge of the 3D banner so it reads as a shadow, not a neon glow.
function darken(hex: string, factor = 0.55): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const r = Math.round(((n >> 16) & 0xff) * factor);
  const g = Math.round(((n >> 8) & 0xff) * factor);
  const b = Math.round((n & 0xff) * factor);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

// The shared "3D extruded banner" look: a faint accent-tinted surface with the
// accent bright on the thick LEFT + BOTTOM edges, a dimmer accent hairline on
// TOP + RIGHT, and a darker colored drop-shadow toward the bottom-left. One
// definition so achievement badges, task cards, and goal cards all extrude the
// same way. Pass the family/domain accent (tasks blue, goals their type color,
// etc.). `tint` controls how much the surface picks up the accent (0 keeps the
// card's own dark surface — good for dense lists; a small value pops more).
export function banner3dStyle(accent: string, opts: { tint?: string } = {}): ViewStyle {
  return {
    backgroundColor: opts.tint ?? accent + '14',
    borderTopWidth: 1,
    borderRightWidth: 1,
    borderLeftWidth: 3,
    borderBottomWidth: 4,
    borderTopColor: accent + '55',
    borderRightColor: accent + '55',
    borderLeftColor: accent,
    borderBottomColor: accent,
    shadowColor: darken(accent),
    shadowOffset: { width: -2, height: 3 },
    shadowOpacity: 0.5,
    shadowRadius: 5,
    elevation: 4,
  };
}
