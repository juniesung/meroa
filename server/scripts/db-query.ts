// Read-only-ish DB console for the battery (scripts/battery.sh) and for
// hand-checking state after a live chat turn. Exists because `psql` is not a
// dependency of this project and the DB is remote (Supabase) — every past
// session rebuilt this file from scratch under a different name, then deleted
// it, then rebuilt it. It lives here now.
//
//   npx tsx scripts/db-query.ts "select id, title, status from tasks limit 5"
//
// Prints one JSON array on stdout, so it composes with jq. Not wired into the
// app; nothing imports it.
import 'dotenv/config';
import postgres from 'postgres';

const query = process.argv[2];
if (!query) {
  console.error('usage: npx tsx scripts/db-query.ts "<sql>"');
  process.exit(1);
}

const sql = postgres(process.env.DATABASE_URL!, { prepare: false });
try {
  console.log(JSON.stringify(await sql.unsafe(query)));
} finally {
  await sql.end();
}
