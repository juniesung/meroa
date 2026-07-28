import { serve } from '@hono/node-server';
import * as Sentry from '@sentry/node';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { cors } from 'hono/cors';

import { closePool, db } from './db/client.ts';
import { env } from './env.ts';
import { logger } from './logger.ts';
import { authRoutes } from './routes/auth.ts';
import { billingRoutes } from './routes/billing.ts';
import { bootstrapRoutes } from './routes/bootstrap.ts';
import { internalRoutes } from './routes/internal.ts';
import { legalRoutes } from './routes/legal.ts';
import { meRoutes } from './routes/me.ts';
import { profileRoutes } from './routes/profile.ts';
import { memoryRoutes } from './routes/memories.ts';
import { messageRoutes } from './routes/messages.ts';
import { taskRoutes } from './routes/tasks.ts';
import { goalRoutes } from './routes/goals.ts';

// Optional — same graceful-degradation pattern as every other third-party
// key in this app (RevenueCat, etc.): runs fine with no error reporting if
// SENTRY_DSN isn't set. Must be called before any route handling.
if (env.SENTRY_DSN) {
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
    // Companion app — chat content is sensitive (CLAUDE.md §2). Never let PII
    // ride along by default, and scrub request bodies/headers/cookies off every
    // event so a captured error can't carry a user's message to the dashboard.
    sendDefaultPii: false,
    beforeSend(event) {
      if (event.request) {
        delete event.request.data;
        delete event.request.cookies;
        delete event.request.headers;
        delete event.request.query_string;
      }
      return event;
    },
  });
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

// Liveness AND readiness: a process that's up but can't reach Postgres is not
// healthy, and a load balancer routing to it just serves errors. Ping the DB.
app.get('/health', async (c) => {
  try {
    await db.execute(sql`select 1`);
    return c.json({ ok: true });
  } catch (err) {
    logger.error({ err }, 'health check failed — DB unreachable');
    return c.json({ ok: false, error: 'db_unreachable' }, 503);
  }
});

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
app.route('/profile', profileRoutes);
app.route('/bootstrap', bootstrapRoutes);
app.route('/conversations/current/messages', messageRoutes);
app.route('/tasks', taskRoutes);
app.route('/goals', goalRoutes);
app.route('/memories', memoryRoutes);
app.route('/billing', billingRoutes);
app.route('/internal', internalRoutes);

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  logger.info(`meroa-server listening on http://localhost:${info.port}`);
});

// Graceful shutdown. Railway sends SIGTERM on every deploy; without this, the
// process is killed mid-request and the pg pool's sockets are severed. Stop
// accepting new connections, let in-flight requests drain, close the pool, exit.
// A hard timeout backstops a stream that never ends (SSE chat can be long-lived)
// so a deploy can't hang forever.
let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down — draining');
  const force = setTimeout(() => {
    logger.warn('graceful shutdown timed out — forcing exit');
    process.exit(1);
  }, 10_000);
  force.unref();
  server.close(async () => {
    try {
      await closePool();
    } catch (err) {
      logger.error({ err }, 'error closing DB pool on shutdown');
    }
    clearTimeout(force);
    process.exit(0);
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
