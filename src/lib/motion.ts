import { ReduceMotion, useReducedMotion } from 'react-native-reanimated';

/**
 * One import point for reduce-motion awareness.
 *
 * - Reanimated's declarative entering/exiting/layout animations already honor the
 *   system setting by default (ReduceMotion.System), so those need no extra guard.
 * - Manually-driven shared-value animations (celebration blooms, shimmer loops,
 *   count-ups) do NOT — gate them on `useReduceMotion()` and fall back to the
 *   final/static value when it's true. Feedback-critical motion (press scale)
 *   should keep animating regardless.
 */
export function useReduceMotion() {
  return useReducedMotion();
}

export { ReduceMotion };
