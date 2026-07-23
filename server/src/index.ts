import { serve } from '@hono/node-server';
import * as Sentry from '@sentry/node';
import { Hono } from 'hono';
import { cors } from 'hono/cors';

import { env } from './env.ts';
import { logger } from './logger.ts';
import { authRoutes } from './routes/auth.ts';
import { billingRoutes } from './routes/billing.ts';
import { bootstrapRoutes } from './routes/bootstrap.ts';
import { internalRoutes } from './routes/internal.ts';
import { legalRoutes } from './routes/legal.ts';
import { meRoutes } from './routes/me.ts';
import { memoryRoutes } from './routes/memories.ts';
import { messageRoutes } from './routes/messages.ts';
import { taskRoutes } from './routes/tasks.ts';
import { goalRoutes } from './routes/goals.ts';

// Optional — same graceful-degradation pattern as every other third-party
// key in this app (RevenueCat, etc.): runs fine with no error reporting if
// SENTRY_DSN isn't set. Must be called before any route handling.
if (env.SENTRY_DSN) {
  Sentry.init({ dsn: env.SENTRY_DSN, environment: env.NODE_ENV });
}

const app = new Hono();

// CORS only ever mattered for browsers. The two real clients are a native app
// (React Native's fetch sends no Origin, so CORS never applies to it) and the
// server-rendered legal/support pages (same-origin). So production denies all
// cross-origin requests by default, and CORS_ORIGINS exists purely as an
// escape hatch if a real web surface is ever added.
const corsOrigins = (env.CORS_ORIGINS ?? '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  '*',
  cors({
    origin: (origin) => {
      if (env.NODE_ENV !== 'production') return origin || '*';
      return corsOrigins.includes(origin) ? origin : null;
    },
  }),
);

app.get('/health', (c) => c.json({ ok: true }));

// Public legal/support pages + the web account-deletion flow, mounted at the
// root (GET /privacy, /terms, /support, /account/delete). See routes/legal.ts's
// review gate before deploying the copy publicly.
app.route('/', legalRoutes);

// Backstop for anything that reaches here uncaught — most AI-provider
// errors never do (they're caught internally and turned into SSE error
// events, see providers/*.ts), so this mainly covers routes/middleware
// throwing outside that path.
app.onError((err, c) => {
  Sentry.captureException(err);
  logger.error(err, 'unhandled error');
  return c.json({ error: 'internal_error' }, 500);
});

app.route('/auth', authRoutes);
app.route('/me', meRoutes);
app.route('/bootstrap', bootstrapRoutes);
app.route('/conversations/current/messages', messageRoutes);
app.route('/tasks', taskRoutes);
app.route('/goals', goalRoutes);
app.route('/memories', memoryRoutes);
app.route('/billing', billingRoutes);
app.route('/internal', internalRoutes);

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  logger.info(`meroa-server listening on http://localhost:${info.port}`);
});
