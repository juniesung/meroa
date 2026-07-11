import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

import { env } from '../env.ts';
import { logger } from '../logger.ts';

const migrationClient = postgres(env.DATABASE_URL, { max: 1 });

async function main() {
  const db = drizzle(migrationClient);
  logger.info('Running migrations...');
  await migrate(db, { migrationsFolder: 'drizzle' });
  logger.info('Migrations complete.');
  await migrationClient.end();
}

main().catch((err) => {
  logger.error(err, 'Migration failed');
  process.exit(1);
});
