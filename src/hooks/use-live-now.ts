import { useEffect, useState } from 'react';

import { getClockOffsetMs } from '@/lib/api/client';

/**
 * A timestamp that updates every `intervalMs` while `active`, meant to be
 * passed explicitly into `Date.now()`-based computations (elapsed timer
 * minutes, live progress) instead of those functions reading `Date.now()`
 * internally. With the React Compiler on, a value computed only from stable
 * props (e.g. `metaText(task)`) gets memoized and stops updating even though
 * it's secretly impure — threading `now` through as a real argument makes
 * the dependency visible so it recomputes on each tick.
 *
 * Corrected by the device's rough offset from the server clock (see
 * api/client.ts's getClockOffsetMs) — a genuinely misconfigured device clock
 * would otherwise make elapsed-time math (e.g. currentLoggedMinutes) clamp
 * negative and freeze a running timer's display at its start value for the
 * whole run.
 */
export function useLiveNow(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now() + getClockOffsetMs());

  useEffect(() => {
    if (!active) return;
    const tick = () => setNow(Date.now() + getClockOffsetMs());
    // Resync on the next tick rather than synchronously in the effect body
    // (which the lint rule against cascading renders forbids) — otherwise
    // `now` sits at whatever stale value it last held while inactive
    // (possibly from mount) until the first interval fire, up to
    // `intervalMs` later.
    const immediate = setTimeout(tick, 0);
    const id = setInterval(tick, intervalMs);
    return () => {
      clearTimeout(immediate);
      clearInterval(id);
    };
  }, [active, intervalMs]);

  return now;
}
