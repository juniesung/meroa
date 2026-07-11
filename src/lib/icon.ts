import { iconPaths, type IconName } from '@/components/Icon';

/** Server-side icon values are freeform text; fall back safely if unrecognized. */
export function toIconName(icon: string | null | undefined, fallback: IconName = 'sparkle'): IconName {
  return icon && icon in iconPaths ? (icon as IconName) : fallback;
}
