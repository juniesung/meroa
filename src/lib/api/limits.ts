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
  if (body.feature === 'tasks') {
    return `Free plan limit — ${body.limit} new task${body.limit === 1 ? '' : 's'} a day. Upgrade for unlimited.`;
  }
  if (body.feature === 'goals') {
    return `Free plan limit — ${body.limit} active goal${body.limit === 1 ? '' : 's'}. Upgrade for more.`;
  }
  return "You've reached today's message limit. Upgrade for more.";
}
