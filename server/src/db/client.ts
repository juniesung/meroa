import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { env } from '../env.ts';
import * as schema from './schema.ts';

// Compatible with Supabase's Session Pooler (port 5432, the connection this
// app always uses — see .env.example) — the Transaction Pooler (6543) would
// need `prepare: false` and only matters if part of the API ever runs
// serverless, which it doesn't on a persistent Railway container. `max: 10`
// matches postgres.js's own default; the timeouts are defensive so a
// stalled connection doesn't hang indefinitely, not because the previous
// bare defaults were known-broken. Revisit `max` if ever scaled to multiple
// instances (Supabase's connection ceiling is shared across all of them).
const queryClient = postgres(env.DATABASE_URL, {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 10,
});

export const db = drizzle(queryClient, { schema });

// Drain + close the connection pool on shutdown (SIGTERM on every Railway
// deploy) so in-flight queries finish and sockets close cleanly instead of
// being severed mid-flight. `timeout` bounds how long we wait for in-flight
// queries before force-closing.
export async function closePool(): Promise<void> {
  await queryClient.end({ timeout: 5 });
}
