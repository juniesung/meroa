import type { MiddlewareHandler } from 'hono';

import type { AuthVariables } from './auth.ts';

// Additional abuse/burst guard on top of (never a replacement for) the
// Phase 7 daily-cap business logic in lib/limits.ts and lib/usage.ts — those
// enforce the free-vs-plus product limits; this just stops a burst of rapid
// requests (buggy client retry loop, a script hitting the API directly)
// from running up AI-provider cost before those checks even get a chance to
// matter. Runs after requireAuth (which sets c.get('userId')), so every
// caller here is already authenticated.
//
// In-memory, per-process — resets on every deploy/restart and doesn't
// coordinate across multiple instances. Fine at current single-instance
// scale; would need a shared store (Redis) if ever scaled horizontally.
export function rateLimit({
  windowMs,
  max,
}: {
  windowMs: number;
  max: number;
}): MiddlewareHandler<{ Variables: AuthVariables }> {
  const hits = new Map<string, { count: number; resetAt: number }>();

  return async (c, next) => {
    const userId = c.get('userId');
    const now = Date.now();

    const entry = hits.get(userId);
    if (!entry || entry.resetAt <= now) {
      hits.set(userId, { count: 1, resetAt: now + windowMs });
      return next();
    }

    if (entry.count >= max) {
      return c.json(
        { error: 'rate_limited', retryAfterMs: entry.resetAt - now },
        429,
      );
    }

    entry.count += 1;
    return next();
  };
}
