/**
 * src/ingestion/__tests__/latencySnapshotWiring.test.ts
 *
 * Behavioral tests (real migrated SQLite, not the always-empty stub DB most
 * of tradeLatency.test.ts uses) for the two places the latency-snapshot
 * repair touches trade_latency_candidates matching:
 *
 *   1. recordTradeLatencyCandidates schedules a ct_publish snapshot INLINE,
 *      at mint time — before any match has happened.
 *   2. A trade-hash match (exact or fuzzy) populates provider_window_start /
 *      provider_window_end from the matched observation's prev_probe_at /
 *      first_observed_at, so snapshotPlan can derive real confidence instead
 *      of every row reporting 'unbounded'.
 *
 * These two SQL UPDATE statements are otherwise only exercised through
 * always-empty-result stub DBs elsewhere in the suite, which would never
 * catch a syntax error in them.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Env, Transaction } from '../../shared/types.ts';
import { openMigratedD1, type SqliteDatabase } from '../../prices/__tests__/sqliteD1.ts';
import { backfillTradeLatencyCandidates, generateTradeHash, recordTradeLatencyCandidates } from '../tradeLatency.ts';

let db: SqliteDatabase;
let env: Env;
let close: () => void;

beforeEach(async () => {
  const opened = await openMigratedD1();
  db = opened.db;
  close = opened.close;
  env = { DB: opened.d1 } as unknown as Env;
});
afterEach(() => close());

function baseTx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: 'tx-1',
    docId: 'doc-1',
    filerId: null,
    txDate: '2026-08-16',
    owner: null,
    assetName: 'Apple Inc',
    ticker: 'AAPL',
    assetType: null,
    txType: 'P',
    amountMin: 1001,
    amountMax: 15000,
    isOption: false,
    capGainsOver200: false,
    rawText: '',
    confidence: 1,
    source: 'primary',
    createdAt: '2026-08-16T15:00:00.000Z',
    cursorSeq: 0,
    fullName: 'Ro Khanna',
    filedDate: null,
    firstSeenAt: '2026-08-16T15:00:00.000Z',
    sourceUrl: null,
    ...overrides,
  } as Transaction;
}

describe('recordTradeLatencyCandidates — inline ct_publish scheduling', () => {
  it('schedules a ct_publish snapshot row at mint time, with confidence=exact and the real first_seen stamp', async () => {
    await recordTradeLatencyCandidates(env, [baseTx()], '2026-08-16T15:00:00.000Z');

    // recordTradeLatencyCandidates mints one candidate per DIRECT_PROVIDER_ID
    // (fmp, fmp_rapidapi, unusual_whales, quiver), so one ct_publish row is
    // scheduled per provider too — check the 'fmp' one specifically.
    const tradeHash = generateTradeHash('Ro Khanna', 'AAPL', '2026-08-16', 'P');
    const rows = db
      .prepare(`SELECT * FROM latency_price_snapshots WHERE trade_hash = ? AND provider = 'fmp' AND event = 'ct_publish'`)
      .all(tradeHash) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.due_at).toBe('2026-08-16T15:00:00.000Z');
    expect(rows[0]!.confidence).toBe('exact');
    expect(rows[0]!.due_at_uncertainty_sec).toBe(0);
    expect(rows[0]!.captured_at).toBeNull();

    // And one ct_publish row per provider overall, never duplicated within a provider.
    const allRows = db
      .prepare(`SELECT provider FROM latency_price_snapshots WHERE trade_hash = ? AND event = 'ct_publish'`)
      .all(tradeHash) as Array<{ provider: string }>;
    expect(new Set(allRows.map((r) => r.provider)).size).toBe(allRows.length);
  });

  it('never breaks candidate minting even if the scheduling write races an existing row (idempotent)', async () => {
    // Two calls for the same transaction (e.g. a retried batch) must not
    // throw and must not duplicate the ct_publish row for any provider.
    await recordTradeLatencyCandidates(env, [baseTx()], '2026-08-16T15:00:00.000Z');
    await recordTradeLatencyCandidates(env, [baseTx()], '2026-08-16T15:00:05.000Z');

    const tradeHash = generateTradeHash('Ro Khanna', 'AAPL', '2026-08-16', 'P');
    const rows = db
      .prepare(`SELECT provider FROM latency_price_snapshots WHERE trade_hash = ? AND event = 'ct_publish'`)
      .all(tradeHash) as Array<{ provider: string }>;
    expect(new Set(rows.map((r) => r.provider)).size).toBe(rows.length);

    const candidates = db
      .prepare(`SELECT COUNT(*) AS n FROM trade_latency_candidates WHERE trade_hash = ?`)
      .get(tradeHash) as { n: number };
    expect(candidates.n).toBeGreaterThan(0);
  });

  it('does not schedule ct_publish for a backfill/seed import (never mints a race for it at all)', async () => {
    await recordTradeLatencyCandidates(env, [baseTx({ source: 'seed_dataset' })], '2026-08-16T15:00:00.000Z');
    const rows = db.prepare(`SELECT COUNT(*) AS n FROM latency_price_snapshots`).get() as { n: number };
    expect(rows.n).toBe(0);
  });

  it('does not schedule ct_publish when the minted transaction is an option', async () => {
    await recordTradeLatencyCandidates(env, [baseTx({ isOption: true, assetType: 'OP' })], '2026-08-16T15:00:00.000Z');
    const rows = db.prepare(`SELECT COUNT(*) AS n FROM latency_price_snapshots`).get() as { n: number };
    expect(rows.n).toBe(0);
    const candidates = db.prepare(`SELECT COUNT(*) AS n FROM trade_latency_candidates`).get() as { n: number };
    expect(candidates.n).toBeGreaterThan(0);
  });
});

describe('backfillTradeLatencyCandidates — persist option flags into the snapshot gate', () => {
  function seedLiveTx(opts: {
    id: string;
    ticker: string;
    txDate: string;
    isOption: number;
    assetType?: string;
    assetName?: string;
  }): void {
    const nowIso = new Date().toISOString();
    const filed = nowIso.slice(0, 10);
    db.prepare(
      `INSERT OR IGNORE INTO filers (bioguide_id, chamber, full_name) VALUES ('K000001', 'house', 'Ro Khanna')`,
    ).run();
    db.prepare(
      `INSERT OR IGNORE INTO filings (doc_id, chamber, filer_id, filing_type, filed_date, ingest_status, first_seen_at)
       VALUES ('H-live', 'house', 'K000001', 'P', ?, 'persisted', ?)`,
    ).run(filed, nowIso);
    db.prepare(
      `INSERT INTO transactions
         (id, doc_id, filer_id, tx_date, owner, asset_name, ticker, asset_type, tx_type,
          is_option, source, created_at, first_seen_at, filed_date)
       VALUES (?, 'H-live', 'K000001', ?, 'self', ?, ?, ?, 'P', ?, 'primary', ?, ?, ?)`,
    ).run(opts.id, opts.txDate, opts.assetName ?? opts.ticker, opts.ticker, opts.assetType ?? null, opts.isOption, nowIso, nowIso, filed);
  }

  it('does not stamp equity minute snapshots onto an is_option=1 row', async () => {
    const txDate = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    seedLiveTx({ id: 'tx-opt', ticker: 'AAPL', txDate, isOption: 1, assetType: 'OP', assetName: 'AAPL Call' });
    seedLiveTx({ id: 'tx-eq', ticker: 'MSFT', txDate, isOption: 0, assetType: 'ST', assetName: 'Microsoft' });

    const result = await backfillTradeLatencyCandidates(env, { limit: 20, days: 7 });
    expect(result.recorded).toBe(2);

    const optHash = generateTradeHash('Ro Khanna', 'AAPL', txDate, 'P');
    const eqHash = generateTradeHash('Ro Khanna', 'MSFT', txDate, 'P');
    const optSnaps = db.prepare(`SELECT COUNT(*) AS n FROM latency_price_snapshots WHERE trade_hash = ?`).get(optHash) as { n: number };
    const eqSnaps = db.prepare(`SELECT COUNT(*) AS n FROM latency_price_snapshots WHERE trade_hash = ?`).get(eqHash) as { n: number };
    expect(optSnaps.n).toBe(0);
    expect(eqSnaps.n).toBeGreaterThan(0);
  });
});

describe('trade-hash match — provider_window_start/end population', () => {
  it('an immediate match at mint time (matchJustMintedCandidates -> matchAndUpdateCandidates) brackets the window from prev_probe_at', async () => {
    const tradeHash = generateTradeHash('Ro Khanna', 'AAPL', '2026-08-16', 'P');
    // A competitor observation already on file, bracketed by a prior probe —
    // exactly the shape upsertProviderRows would have written after #2080.
    db.prepare(
      `INSERT INTO trade_provider_observations
         (provider, chamber, provider_key, trade_hash, first_observed_at, last_observed_at, prev_probe_at, provider_published_at, source_url, filed_date, filer_name, payload)
       VALUES ('fmp', 'house', 'key-1', ?, '2026-08-16T15:05:00.000Z', '2026-08-16T15:05:00.000Z', '2026-08-16T14:35:00.000Z', NULL, NULL, NULL, 'Ro Khanna', NULL)`,
    ).run(tradeHash);

    // Minting the candidate triggers matchJustMintedCandidates immediately —
    // the observation above already exists, so this is a same-tick match.
    await recordTradeLatencyCandidates(env, [baseTx()], '2026-08-16T15:00:00.000Z');

    const candidate = db
      .prepare(`SELECT status, provider_window_start, provider_window_end FROM trade_latency_candidates WHERE trade_hash = ? AND provider = 'fmp'`)
      .get(tradeHash) as { status: string; provider_window_start: string | null; provider_window_end: string | null };
    expect(candidate.status).toBe('matched');
    expect(candidate.provider_window_start).toBe('2026-08-16T14:35:00.000Z');
    expect(candidate.provider_window_end).toBe('2026-08-16T15:05:00.000Z');
  });

  it('a cold-start observation (no prev_probe_at) leaves the window NULL, never a fabricated bracket', async () => {
    const tradeHash = generateTradeHash('Ro Khanna', 'AAPL', '2026-08-16', 'P');
    db.prepare(
      `INSERT INTO trade_provider_observations
         (provider, chamber, provider_key, trade_hash, first_observed_at, last_observed_at, prev_probe_at, provider_published_at, source_url, filed_date, filer_name, payload)
       VALUES ('fmp', 'house', 'key-1', ?, '2026-08-16T15:05:00.000Z', '2026-08-16T15:05:00.000Z', NULL, NULL, NULL, NULL, 'Ro Khanna', NULL)`,
    ).run(tradeHash);

    await recordTradeLatencyCandidates(env, [baseTx()], '2026-08-16T15:00:00.000Z');

    const candidate = db
      .prepare(`SELECT provider_window_start, provider_window_end FROM trade_latency_candidates WHERE trade_hash = ? AND provider = 'fmp'`)
      .get(tradeHash) as { provider_window_start: string | null; provider_window_end: string | null };
    expect(candidate.provider_window_start).toBeNull();
    // provider_window_end still records first_observed_at even when the
    // start is unknown — only the WIDTH is unbounded, not the upper bound.
    expect(candidate.provider_window_end).toBe('2026-08-16T15:05:00.000Z');
  });
});
