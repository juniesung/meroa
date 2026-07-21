import { useEffect, useRef, useState } from 'react';
import { useReducedMotion } from 'react-native-reanimated';

/**
 * Animates a displayed number from its CURRENT value to `target` whenever
 * `target` changes — the goal total ticking up the moment an entry is logged,
 * rather than snapping. Distinct from onboarding's `useCountUp`, which counts
 * from 0 on mount; this one is quiet on mount (shows the value straight away)
 * and only animates real changes. The caller formats the returned number.
 *
 * Every state write happens inside the rAF callback (never synchronously in the
 * effect body), and reduce-motion collapses the animation to a single frame.
 */
export function useCountUp(target: number, durationMs = 600): number {
  const [display, setDisplay] = useState(target);
  const displayRef = useRef(target);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    displayRef.current = display;
  }, [display]);

  useEffect(() => {
    if (displayRef.current === target) return;
    const from = reduceMotion ? target : displayRef.current;
    const dur = reduceMotion ? 1 : durationMs;
    const start = Date.now();
    let raf: ReturnType<typeof requestAnimationFrame>;
    const tick = () => {
      const t = Math.min(1, (Date.now() - start) / dur);
      const eased = 1 - (1 - t) ** 3;
      setDisplay(from + (target - from) * eased);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, reduceMotion]);

  return display;
}
