import { ApiError } from './client';

// Mirrors server/src/lib/limits.ts's limitReachedBody + routes/messages.ts's
// chat 429 — the one shared shape every free-plan cap responds with, so a
// single check here covers task creates, goal creates, and chat sends.
export type LimitReachedBody = {
  error: 'limit_reached';
  feature: 'tasks' | 'goals' | 'messages';
  plan: 'free' | 'plus';
  limit: number;
  used?: number;
};

export function asLimitReached(err: unknown): LimitReachedBody | null {
  if (!(err instanceof ApiError) || err.status !== 429) return null;
  const body = err.body as Partial<LimitReachedBody> | undefined;
  if (body?.error !== 'limit_reached' || !body.feature) return null;
  return body as LimitReachedBody;
}

export function limitReachedMessage(body: LimitReachedBody): string {
  // Hard paywall (no free tier): a `plan: 'free'` body means the user is locked
  // out entirely and needs to subscribe — not that they hit a graduated cap.
  // (In practice the nav guard keeps a locked user off these screens, so this
  // mainly covers a trial expiring mid-session.) A `plan: 'plus'` body is a
  // member hitting the daily fair-use ceiling — there's no higher tier to sell,
  // so the copy just states the limit, no "upgrade".
  if (body.plan === 'free') {
    return 'Subscribe to Meroa for full access.';
  }
  if (body.feature === 'tasks') {
    return `You've hit today's limit of ${body.limit} new task${body.limit === 1 ? '' : 's'}.`;
  }
  if (body.feature === 'goals') {
    return `You've reached your limit of ${body.limit} active goal${body.limit === 1 ? '' : 's'}.`;
  }
  return "You've reached today's message limit — check back tomorrow.";
}
