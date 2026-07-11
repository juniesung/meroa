import type { MiddlewareHandler } from 'hono';

import { verifyAccessToken } from '../lib/jwt.ts';

export type AuthVariables = { userId: string };

export const requireAuth: MiddlewareHandler<{ Variables: AuthVariables }> = async (c, next) => {
  const header = c.req.header('authorization');
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;

  if (!token) return c.json({ error: 'unauthorized' }, 401);

  try {
    const userId = await verifyAccessToken(token);
    c.set('userId', userId);
  } catch {
    return c.json({ error: 'unauthorized' }, 401);
  }

  await next();
};
