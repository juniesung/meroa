import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';

import { env } from './env.ts';
import { logger } from './logger.ts';
import { authRoutes } from './routes/auth.ts';
import { bootstrapRoutes } from './routes/bootstrap.ts';
import { meRoutes } from './routes/me.ts';
import { messageRoutes } from './routes/messages.ts';
import { taskRoutes } from './routes/tasks.ts';
import { toolRoutes } from './routes/tools.ts';

const app = new Hono();

// Dev-only permissive CORS — the app talks to this server directly during
// local development; tighten this if/when the server is ever deployed.
app.use('*', cors());

app.get('/health', (c) => c.json({ ok: true }));

app.route('/auth', authRoutes);
app.route('/me', meRoutes);
app.route('/bootstrap', bootstrapRoutes);
app.route('/conversations/current/messages', messageRoutes);
app.route('/tasks', taskRoutes);
app.route('/tools', toolRoutes);

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  logger.info(`meroa-server listening on http://localhost:${info.port}`);
});
