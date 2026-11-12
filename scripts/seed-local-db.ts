/**
 * Load the committed preview fixtures into the local dev database.
 *
 * Uses the same @libsql/client the Deno app uses, so it works against the
 * `file:` SQLite URL in TURSO_DATABASE_URL without depending on a sqlite3 CLI.
 * Idempotent: skips when the transactions table already has rows, so it never
 * clobbers data an agent may have ingested or backfilled.
 *
 * Run from app/ (for the deno.json import map):
 *   deno run --allow-net --allow-env --allow-read --allow-ffi \
 *     ../scripts/seed-local-db.ts
 */
import { createClient } from '@libsql/client';

const url = Deno.env.get('TURSO_DATABASE_URL');
if (!url) {
  console.error('[seed] TURSO_DATABASE_URL not set; refusing to seed');
  Deno.exit(1);
}
// Defense in depth: only ever seed a local file DB. The Cloud Agent VM injects a
// production libsql:// URL as a secret; refuse to write fixtures anywhere remote.
if (!url.startsWith('file:')) {
  console.error(`[seed] refusing to seed non-file database (${url.split(':')[0]}:...)`);
  Deno.exit(1);
}

const fixturesPath = new URL(
  '../app/scripts/seed-preview-fixtures.sql',
  import.meta.url,
);

const client = createClient({
  url,
  authToken: Deno.env.get('TURSO_AUTH_TOKEN') || undefined,
});

try {
  const existing = await client.execute('SELECT COUNT(*) AS n FROM transactions');
  const count = Number(existing.rows[0]?.n ?? 0);
  if (count > 0) {
    console.log(`[seed] transactions already has ${count} row(s); skipping`);
    Deno.exit(0);
  }
  const sql = await Deno.readTextFile(fixturesPath);
  await client.executeMultiple(sql);
  const after = await client.execute('SELECT COUNT(*) AS n FROM transactions');
  console.log(`[seed] loaded preview fixtures (${Number(after.rows[0]?.n ?? 0)} transactions)`);
} catch (err) {
  console.error('[seed] failed:', err instanceof Error ? err.message : String(err));
  Deno.exit(1);
}
