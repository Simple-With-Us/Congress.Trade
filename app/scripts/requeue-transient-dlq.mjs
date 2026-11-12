#!/usr/bin/env node
/**
 * Bounded transient DLQ requeue.  Leaves poison (invalid payload / unknown
 * message type / R2-disabled) failed.
 *
 * Default is dry-run.  Pass --apply to write.
 *
 *   ADMIN_TOKEN=... node app/scripts/requeue-transient-dlq.mjs
 *   ADMIN_TOKEN=... node app/scripts/requeue-transient-dlq.mjs --apply --limit 100
 *   ADMIN_TOKEN=... node app/scripts/requeue-transient-dlq.mjs --queue
 *
 * Does not print the token.
 */

const BASE = process.env.BASE || 'https://congress.trade';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || process.env.ADMIN_MAINTENANCE_TOKEN;
const apply = process.argv.includes('--apply');
const queue = process.argv.includes('--queue');
const limitArg = process.argv.find((arg, i, all) => all[i - 1] === '--limit');
const limit = Number.parseInt(limitArg ?? '100', 10);

if (!ADMIN_TOKEN) {
  console.error('ADMIN_TOKEN (or ADMIN_MAINTENANCE_TOKEN) is required.');
  process.exit(2);
}

const path = queue ? '/api/admin/queue-requeue-failed' : '/api/admin/ingest-requeue-failed';
const body = {
  transientOnly: true,
  dryRun: !apply,
  limit: Number.isFinite(limit) ? limit : 100,
};

const res = await fetch(`${BASE}${path}`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${ADMIN_TOKEN}`,
    'content-type': 'application/json',
  },
  body: JSON.stringify(body),
});

const text = await res.text();
let parsed;
try {
  parsed = JSON.parse(text);
} catch {
  console.error(`HTTP ${res.status}: non-JSON response`);
  process.exit(1);
}
if (!res.ok) {
  console.error(`HTTP ${res.status}: ${parsed.error ?? 'request failed'}`);
  process.exit(1);
}
console.log(JSON.stringify({ apply, path, ...parsed }, null, 2));
