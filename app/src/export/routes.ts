/**
 * src/export/routes.ts
 * OWNER: export
 *
 * Bulk export API mounted under /api/export. Lets a sibling app (App B) pull the
 * full market-data tables as a date-partitioned NDJSON snapshot, instead of
 * paging the per-ticker REST endpoints, for first-time bootstrapping or catch-up
 * after a downtime gap.
 *
 * Auth: the scoped INGEST_TOKEN bearer (the same token that unlocks
 * POST /api/admin/securities/import) — so bulk access is granted to App B
 * without handing out the full ADMIN_TOKEN.
 *
 * Two endpoints:
 *   GET /api/export/bulk-snapshot            → the manifest (object keys, row
 *                                              counts, schema, per-table
 *                                              downloadPath). Generates today's
 *                                              snapshot inline if the cron hasn't
 *                                              written it yet.
 *   GET /api/export/bulk-snapshot/file       → streams one table's NDJSON straight
 *                                              from R2 (token-gated).
 *
 * NOTE on downloads: the R2 *binding* in the Workers runtime has no presigned-URL
 * method, so rather than returning S3-style signed links we expose a token-gated
 * streaming download path. App B fetches each file with the same INGEST_TOKEN.
 */

import { Hono } from 'hono';
import type { Env } from '../shared/types.ts';
import { constantTimeEqual } from '../auth/tokens.ts';
import { resolveSecret, resolveSecrets } from '../secrets/infisical.ts';
import {
  runBulkSnapshot,
  readManifest,
  snapshotObjectKey,
  SNAPSHOT_TABLES,
  type SnapshotTableName,
} from './snapshot.ts';
import type { SnapshotManifest } from '@jaywedgeworth22/congress-trading-shared';
import {
  buildPitScoreExport,
  parsePitScoreQuery,
  pitScoreRowsToNdjson,
  PIT_PLACEBOS,
  PIT_SCORE_VERSION,
} from './pitScores.ts';
import { buildPriceNeedsExport, parsePriceNeedsQuery } from './priceNeeds.ts';

/** Env augmented with cross-app sharing config (mirrors admin/share routes). */
type ExportEnv = Env & { INGEST_TOKEN?: string; APP_B_IMPORT_URL?: string; APP_B_INGEST_TOKEN?: string };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const RUN_ID_RE = /^[A-Za-z0-9-]{1,64}$/; // crypto.randomUUID() shape (hex + dashes)
const VALID_TABLES = new Set<string>(SNAPSHOT_TABLES.map((t) => t.name));
const CAPABILITIES_VERSION = 'congress-trade-crossapp-v1';

const IMPORT_DEFAULT_LIMITS = {
  bytes: 1_500_000,
  refs: 2_000,
  spx: 5_000,
  prices: 100,
  closesPerTicker: 1_500,
  insider: 5_000,
  shortVolume: 5_000,
};

const IMPORT_MAX_LIMITS = {
  bytes: 3_000_000,
  refs: 5_000,
  spx: 10_000,
  prices: 250,
  closesPerTicker: 3_000,
  insider: 10_000,
  shortVolume: 10_000,
};

function todayUtc(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** True when the request carries a valid `Bearer <INGEST_TOKEN>` header. */
async function isAuthorized(env: ExportEnv, authorization?: string): Promise<boolean> {
  const token = (await resolveSecret(env, 'INGEST_TOKEN')).value;
  if (!token) return false; // closed by default when the token isn't configured
  return constantTimeEqual(authorization ?? '', `Bearer ${token}`);
}

/** Parse + validate the optional ?tables= filter. Returns null on an invalid name. */
function parseTables(raw: string | undefined): SnapshotTableName[] | null {
  if (!raw) return SNAPSHOT_TABLES.map((t) => t.name);
  const wanted = raw.split(',').map((s) => s.trim()).filter(Boolean);
  for (const t of wanted) if (!VALID_TABLES.has(t)) return null;
  return wanted as SnapshotTableName[];
}

/** Narrow a full manifest to the requested tables and attach download paths. */
function shapeManifest(manifest: SnapshotManifest, tables: SnapshotTableName[]): Record<string, unknown> {
  const outTables: Record<string, unknown> = {};
  const outSchema: Record<string, string[]> = {};
  for (const name of tables) {
    const info = manifest.tables[name];
    if (!info) continue;
    outTables[name] = {
      ...info,
      // downloadPath pins the runId so a client that read THIS manifest always
      // downloads THIS run's files, even if a later same-day run republishes.
      downloadPath: `/api/export/bulk-snapshot/file?date=${manifest.snapshotDate}&runId=${manifest.runId}&table=${name}`,
    };
    if (manifest.schema[name]) outSchema[name] = manifest.schema[name];
  }
  return {
    generatedAt: manifest.generatedAt,
    snapshotDate: manifest.snapshotDate,
    runId: manifest.runId,
    format: manifest.format,
    tables: outTables,
    schema: outSchema,
  };
}

function positiveIntSetting(raw: string | undefined, fallback: number, max: number): number {
  const n = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

async function integrationImportLimits(env: ExportEnv): Promise<typeof IMPORT_DEFAULT_LIMITS> {
  const secrets = await resolveSecrets(env, [
    'IMPORT_MAX_BYTES',
    'IMPORT_MAX_REFS',
    'IMPORT_MAX_SPX',
    'IMPORT_MAX_PRICES',
    'IMPORT_MAX_CLOSES_PER_TICKER',
    'IMPORT_MAX_INSIDER',
    'IMPORT_MAX_SHORT_VOLUME',
  ]);
  return {
    bytes: positiveIntSetting(secrets.IMPORT_MAX_BYTES, IMPORT_DEFAULT_LIMITS.bytes, IMPORT_MAX_LIMITS.bytes),
    refs: positiveIntSetting(secrets.IMPORT_MAX_REFS, IMPORT_DEFAULT_LIMITS.refs, IMPORT_MAX_LIMITS.refs),
    spx: positiveIntSetting(secrets.IMPORT_MAX_SPX, IMPORT_DEFAULT_LIMITS.spx, IMPORT_MAX_LIMITS.spx),
    prices: positiveIntSetting(secrets.IMPORT_MAX_PRICES, IMPORT_DEFAULT_LIMITS.prices, IMPORT_MAX_LIMITS.prices),
    closesPerTicker: positiveIntSetting(
      secrets.IMPORT_MAX_CLOSES_PER_TICKER,
      IMPORT_DEFAULT_LIMITS.closesPerTicker,
      IMPORT_MAX_LIMITS.closesPerTicker,
    ),
    insider: positiveIntSetting(secrets.IMPORT_MAX_INSIDER, IMPORT_DEFAULT_LIMITS.insider, IMPORT_MAX_LIMITS.insider),
    shortVolume: positiveIntSetting(secrets.IMPORT_MAX_SHORT_VOLUME, IMPORT_DEFAULT_LIMITS.shortVolume, IMPORT_MAX_LIMITS.shortVolume),
  };
}

async function integrationCapabilities(env: ExportEnv): Promise<Record<string, unknown>> {
  const runtimeSecrets = await resolveSecrets(env, ['INGEST_TOKEN', 'APP_B_IMPORT_URL', 'APP_B_INGEST_TOKEN']);
  const configured = {
    ingestToken: Boolean(runtimeSecrets.INGEST_TOKEN),
    appBReturnPath: Boolean(runtimeSecrets.APP_B_IMPORT_URL && runtimeSecrets.APP_B_INGEST_TOKEN),
  };
  return {
    app: 'Congress.Trade',
    generatedAt: new Date().toISOString(),
    contractVersion: CAPABILITIES_VERSION,
    auth: {
      scheme: 'bearer',
      tokenName: 'INGEST_TOKEN',
      requiredFor: [
        '/api/admin/securities/import',
        '/api/export/capabilities',
        '/api/export/congress-pit-scores',
        '/api/export/price-needs',
        '/api/export/bulk-snapshot',
        '/api/export/bulk-snapshot/file',
      ],
    },
    configured,
    peerSharing: {
      role: 'source-of-truth-for-congressional-disclosures-and-point-in-time-scores',
      appBReturnPathConfigured: configured.appBReturnPath,
      appBImportUrlConfigured: Boolean(runtimeSecrets.APP_B_IMPORT_URL),
      appBIngestTokenConfigured: Boolean(runtimeSecrets.APP_B_INGEST_TOKEN),
      noEchoPolicy: 'Only freshly fetched local deltas are pushed to App B; App B-origin imports are not echoed back.',
    },
    endpoints: {
      imports: {
        securities: {
          method: 'POST',
          path: '/api/admin/securities/import',
          auth: 'bearer INGEST_TOKEN',
          accepts: ['refs', 'prices', 'spx', 'insider', 'shortVolume', 'fundamentals', 'analyst', 'origin'],
          limits: await integrationImportLimits(env),
        },
      },
      publicReads: {
        marketBundle: { method: 'GET', path: '/api/market/bundle/:ticker?from=&to=' },
        marketRef: { method: 'GET', path: '/api/market/ref/:ticker' },
        marketRefs: { method: 'GET', path: '/api/market/refs?tickers=AAPL,MSFT' },
        prices: { method: 'GET', path: '/api/market/prices/:ticker?from=&to=' },
        spx: { method: 'GET', path: '/api/market/spx?from=&to=' },
        insider: { method: 'GET', path: '/api/market/insider/:ticker?from=&to=' },
        shortVolume: { method: 'GET', path: '/api/market/short-volume/:ticker?from=&to=' },
        fundamentals: { method: 'GET', path: '/api/market/fundamentals/:ticker?from=&to=' },
        analyst: { method: 'GET', path: '/api/market/analyst/:ticker?from=&to=' },
        transactions: { method: 'GET', path: '/api/transactions?cursor=&limit=&member=&ticker=&type=&chamber=&stockAct=&owner=' },
      },
      analytics: {
        tickerLeaderboard: { method: 'GET', path: '/api/analytics/ticker-leaderboard?window=&rankBy=' },
        clusterBuys: { method: 'GET', path: '/api/analytics/cluster-buys?window=' },
        memberLeaderboard: { method: 'GET', path: '/api/analytics/member-leaderboard?window=&rankBy=' },
        memberPerformance: { method: 'GET', path: '/api/analytics/member/:filerId/performance?from=&to=' },
        conviction: { method: 'GET', path: '/api/analytics/conviction?ticker=&window=' },
        tickerBacktest: { method: 'GET', path: '/api/analytics/ticker/:ticker/backtest?from=&to=' },
        conflicts: { method: 'GET', path: '/api/analytics/conflicts?ticker=&sector=' },
      },
      exports: {
        pitScores: {
          method: 'GET',
          path: '/api/export/congress-pit-scores?from=&to=&ticker=&cursor=&limit=&format=json|ndjson&placebo=&source=&minConf=',
          auth: 'bearer INGEST_TOKEN',
          scoreVersion: PIT_SCORE_VERSION,
          maxLimit: 500,
          placebosAvailable: PIT_PLACEBOS,
        },
        priceNeeds: {
          method: 'GET',
          path: '/api/export/price-needs?limit=&cursor=',
          auth: 'bearer INGEST_TOKEN',
          purpose:
            'List congressional tickers whose trades lack price/SPX history for performance-vs-S&P; App B deep-shares those series.',
          maxLimit: 2000,
          defaultLimit: 500,
        },
        bulkSnapshot: {
          method: 'GET',
          path: '/api/export/bulk-snapshot?date=&tables=&format=ndjson',
          auth: 'bearer INGEST_TOKEN',
          format: 'ndjson',
          tables: SNAPSHOT_TABLES.map((t) => ({ name: t.name, keyColumns: t.keyCols })),
        },
        bulkSnapshotFile: {
          method: 'GET',
          path: '/api/export/bulk-snapshot/file?date=&runId=&table=',
          auth: 'bearer INGEST_TOKEN',
          format: 'ndjson',
        },
      },
    },
    recommendedSync: {
      bootstrap: 'Pull /api/export/bulk-snapshot, persist manifest runId/objectKeys, then stream each downloadPath.',
      incrementalMarketData: 'Use /api/market/* reads as a cache-aside tier before paid providers.',
      congressionalSignals: 'Use /api/export/congress-pit-scores for historical validation and /api/analytics/* for live overlays.',
      priceNeedsForPerformance:
        'GET /api/export/price-needs, then POST fullHistory prices+spx for those tickers to /api/admin/securities/import so tx_performance anchors fill.',
      writeBack: 'POST newly fetched refs/prices/spx/enrichment deltas to /api/admin/securities/import with origin set by the sender.',
    },
  };
}

export function buildExportRouter(): Hono<{ Bindings: ExportEnv }> {
  const r = new Hono<{ Bindings: ExportEnv }>();

  // --- GET /capabilities --------------------------------------------------
  // Token-gated machine-readable integration contract for sibling apps. App B
  // can use this before hardcoding a new route, limit, or export shape.
  r.get('/capabilities', async (c) => {
    if (!(await isAuthorized(c.env, c.req.header('authorization')))) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    return c.json(await integrationCapabilities(c.env));
  });

  // --- GET /congress-pit-scores ------------------------------------------
  // Token-gated point-in-time score export for App B historical validation.
  // Emits one row per (ticker, disclosure availability timestamp) observation.
  r.get('/congress-pit-scores', async (c) => {
    if (!(await isAuthorized(c.env, c.req.header('authorization')))) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    const parsed = parsePitScoreQuery(c.req.query());
    if ('error' in parsed) return c.json({ error: parsed.error }, parsed.status as 400);
    const exportData = await buildPitScoreExport(c.env, parsed);
    if (parsed.format === 'ndjson') {
      const headers: Record<string, string> = {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'cache-control': 'private, max-age=60',
        'x-score-version': exportData.scoreVersion,
        'x-row-count': String(exportData.rowCount),
      };
      if (exportData.pagination.nextCursor) headers['x-next-cursor'] = exportData.pagination.nextCursor;
      return new Response(pitScoreRowsToNdjson(exportData.rows), {
        headers,
      });
    }
    return c.json(exportData);
  });

  // --- GET /price-needs ---------------------------------------------------
  // Token-gated list of congressional tickers App B should deep-share so App A
  // can compute performance vs S&P for every dated equity trade.
  r.get('/price-needs', async (c) => {
    if (!(await isAuthorized(c.env, c.req.header('authorization')))) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    const query = parsePriceNeedsQuery(c.req.query());
    const exportData = await buildPriceNeedsExport(c.env, query);
    return c.json(exportData, 200, { 'cache-control': 'private, max-age=60' });
  });

  // --- GET /bulk-snapshot -------------------------------------------------
  r.get('/bulk-snapshot', async (c) => {
    if (!(await isAuthorized(c.env, c.req.header('authorization')))) {
      return c.json({ error: 'unauthorized' }, 401);
    }

    const q = c.req.query();
    if (q.format && q.format !== 'ndjson') {
      return c.json({ error: 'unsupported format; only ndjson is available', format: q.format }, 400);
    }
    const tables = parseTables(q.tables);
    if (!tables) return c.json({ error: 'unknown table in ?tables=' }, 400);

    const today = todayUtc();
    const date = q.date ?? today;
    if (!DATE_RE.test(date)) return c.json({ error: 'date must be YYYY-MM-DD', date }, 400);
    if (date > today) return c.json({ error: 'snapshot cannot exist for a future date', date }, 400);

    // Return the cron-written manifest if present; otherwise generate today's
    // snapshot inline (back-fill path). A missing past-date snapshot is a 404 —
    // we don't retroactively reconstruct historical days.
    const manifest = await readManifest(c.env, date);
    if (manifest) return c.json(shapeManifest(manifest, tables));
    if (date !== today) {
      return c.json({ error: 'snapshot not available for date', date }, 404);
    }

    // Inline generation is serialized by a per-date KV lock: a timed-out App B
    // retry, or the cron racing the first pull, must NOT each page all five D1
    // tables and write a full R2 run. Acquire the lock; if another run holds it,
    // return 202 so the client retries shortly rather than kicking a duplicate
    // export. (KV get→put has a tiny race window, acceptable for this fallback —
    // the normal path is the cron-written manifest.)
    const lockKey = `export:bulk:lock:${date}`;
    let held = false;
    try {
      held = !(await c.env.CONFIG_KV.get(lockKey));
    } catch {
      held = true; // KV unavailable → don't block the fallback path
    }
    if (!held) {
      return c.json({ status: 'generating', date, retryAfterSec: 30 }, 202);
    }
    try {
      await c.env.CONFIG_KV.put(lockKey, '1', { expirationTtl: 300 });
    } catch {
      /* best-effort lock; proceed even if KV write fails */
    }
    try {
      const fresh = await runBulkSnapshot(c.env, date);
      return c.json(shapeManifest(fresh, tables));
    } finally {
      try {
        await c.env.CONFIG_KV.delete(lockKey);
      } catch {
        /* lock self-expires via TTL if delete fails */
      }
    }
  });

  // --- GET /bulk-snapshot/file -------------------------------------------
  // Token-gated streaming download of one table's NDJSON object from R2.
  r.get('/bulk-snapshot/file', async (c) => {
    if (!(await isAuthorized(c.env, c.req.header('authorization')))) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    const q = c.req.query();
    const date = q.date ?? '';
    const table = q.table ?? '';
    const runId = q.runId ?? '';
    if (!DATE_RE.test(date)) return c.json({ error: 'date must be YYYY-MM-DD', date }, 400);
    if (!VALID_TABLES.has(table)) return c.json({ error: 'unknown table', table }, 400);
    if (!RUN_ID_RE.test(runId)) return c.json({ error: 'runId required (from the manifest downloadPath)', runId }, 400);

    // Serve the EXACT run named in the manifest the client read (the runId is
    // pinned in downloadPath). Old runs aren't deleted, so a client that fetched
    // run A's manifest keeps downloading run A's files even after a later run B
    // republishes — consistent row counts ↔ bytes.
    const obj = await c.env.RAW_FILES.get(snapshotObjectKey(date, runId, table));
    if (!obj) return c.json({ error: 'snapshot file not available', date, runId, table }, 404);
    return new Response(obj.body, {
      headers: {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'content-disposition': `attachment; filename="${table}-${date}.ndjson"`,
        'cache-control': 'private, max-age=3600',
      },
    });
  });

  return r;
}
