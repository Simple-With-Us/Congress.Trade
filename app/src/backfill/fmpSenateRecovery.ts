/**
 * src/backfill/fmpSenateRecovery.ts
 * OWNER: ingestion
 *
 * Admin FMP senate-history recovery — RETIRED.
 *
 * Historical helper mapped FMP stable `senate-latest` pages into seed_dataset
 * filings.  Jay binding: FMP keys are latency-probe only.  `runFmpSenateRecovery`
 * now refuses every invocation before any FMP credential or HTTP call.
 * Operators should use Quiver / official Senate eFD / existing disclosure paths.
 *
 * Pure helpers below (doc id / row key / mappers) remain for tests and any
 * residual seed rows already in the DB.
 */

import type { Env, Transaction } from '../shared/types.ts';
import { batch } from '../shared/db.ts';
import { loadResolver, type TickerResolver } from '../extraction/normalizer.ts';
import { estimateTransactionValue } from '../shared/transactionValue.ts';
import { computeDisclosureLagDays, computeStockActStatus } from '../shared/stockAct.ts';
import { resolveSecret } from '../secrets/infisical.ts';
import { trackedFetch } from '../shared/thirdPartyTelemetry.ts';
import { assertFmpTierOk } from '../shared/fmpStatus.ts';
import { addDailyUsed, getDailyUsed } from '../enrichment/service.ts';
import { senateFilerId } from '../ingestion/watcher.ts';
import {
  mapRecordToTransaction,
  normalizeDate,
  type RawWatcherRecord,
  SEED_BASE_CONFIDENCE,
} from './seed.ts';

const FMP_PAGE_LIMIT = 100;
const MAX_PAGE = 100;
const MAX_PAGES_PER_RUN = 5;
const WRITE_BATCH_SIZE = 50;
const DEFAULT_DAILY_CALL_CAP = 230;

export interface FmpSenateRecord extends Record<string, unknown> {
  firstName?: string;
  lastName?: string;
  senateID?: string;
  office?: string;
  district?: string;
  symbol?: string;
  assetDescription?: string;
  assetType?: string;
  type?: string;
  amount?: string;
  owner?: string;
  transactionDate?: string;
  disclosureDate?: string;
  link?: string;
  comment?: string;
}

export interface FmpSenateRecoveryOptions {
  fromPage?: number;
  toPage?: number;
  dryRun?: boolean;
  fetchImpl?: typeof fetch;
  now?: Date;
}

export interface FmpSenatePageResult {
  page: number;
  fetched: number;
  accepted: number;
  inserted: number;
  duplicates: number;
  rejected: number;
  filingsInserted: number;
  filersInserted: number;
  oldestTransactionDate: string | null;
  newestTransactionDate: string | null;
  exhausted: boolean;
}

export interface FmpSenateRecoveryResult {
  ok: boolean;
  dryRun: boolean;
  fromPage: number;
  toPage: number;
  fetched: number;
  accepted: number;
  inserted: number;
  duplicates: number;
  rejected: number;
  filingsInserted: number;
  filersInserted: number;
  pages: FmpSenatePageResult[];
  errors: string[];
}

export interface MappedFmpSenateRecord {
  transaction: Transaction;
  docId: string;
  filerId: string | null;
  filerName: string;
  filedDate: string | null;
  sourceUrl: string;
  rowKey: string;
}

type SqlStatement = [string, Array<string | number | null>];
type PendingKind = 'filer' | 'filing' | 'transaction';

function textField(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function stableHash(input: string): string {
  let first = 2166136261;
  let second = 2166136261;
  for (let i = 0; i < input.length; i++) {
    first ^= input.charCodeAt(i);
    first = Math.imul(first, 16777619);
    second ^= input.charCodeAt(input.length - i - 1);
    second = Math.imul(second, 16777619);
  }
  return `${(first >>> 0).toString(36)}${(second >>> 0).toString(36)}`;
}

function canonicalRow(record: FmpSenateRecord): string {
  return [
    record.senateID,
    record.firstName,
    record.lastName,
    record.office,
    record.district,
    record.symbol,
    record.assetDescription,
    record.assetType,
    record.type,
    record.amount,
    record.owner,
    record.transactionDate,
    record.disclosureDate,
    record.link,
    record.comment,
  ].map((value) => textField(value)).join('|');
}

export function fmpSenateFilerName(record: FmpSenateRecord): string {
  return [textField(record.firstName), textField(record.lastName)].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

export function fmpSenateDocId(record: FmpSenateRecord): string {
  const link = textField(record.link);
  const match = /\/search\/view\/ptr\/([^/?#]+)/i.exec(link);
  if (match?.[1]) return `S-${match[1].toLowerCase()}`;

  // A missing link is unusual, but grouping by member + disclosure date keeps
  // all rows from the same likely report together without using page position.
  const fallback = [record.senateID, fmpSenateFilerName(record), record.disclosureDate]
    .map((value) => textField(value))
    .join('|');
  return `S-fmp-${stableHash(fallback)}`;
}

export function fmpSenateRowKey(record: FmpSenateRecord, occurrence = 1): string {
  return `fmp-senate:${stableHash(canonicalRow(record))}:${Math.max(1, Math.trunc(occurrence))}`;
}

function firstSeenAt(filedDate: string | null, nowIso: string): string {
  return filedDate ? `${filedDate}T00:00:00.000Z` : nowIso;
}

export function mapFmpSenateRecord(
  record: FmpSenateRecord,
  occurrence: number,
  nowIso: string,
  resolve: TickerResolver,
): MappedFmpSenateRecord | null {
  const filerName = fmpSenateFilerName(record);
  const raw: RawWatcherRecord = {
    senator: filerName,
    ticker: textField(record.symbol),
    asset_description: textField(record.assetDescription),
    asset_type: textField(record.assetType),
    type: textField(record.type),
    transaction_date: textField(record.transactionDate),
    disclosure_date: textField(record.disclosureDate),
    amount: textField(record.amount),
    owner: textField(record.owner),
  };
  const mapped = mapRecordToTransaction(raw, 'senate', nowIso, resolve);
  if (!mapped || !filerName) return null;

  const docId = fmpSenateDocId(record);
  const filerId = senateFilerId(filerName);
  const filedDate = normalizeDate(textField(record.disclosureDate));
  const rowKey = fmpSenateRowKey(record, occurrence);
  const sourceUrl = textField(record.link);
  const seenAt = firstSeenAt(filedDate, nowIso);
  const id = `fmp_${stableHash(`${docId}|${rowKey}`)}`;

  return {
    transaction: {
      ...mapped,
      id,
      docId,
      filerId,
      rowKey,
      rawText: JSON.stringify({ provider: 'fmp', record }),
      firstSeenAt: seenAt,
      filedDate,
    },
    docId,
    filerId,
    filerName,
    filedDate,
    sourceUrl,
    rowKey,
  };
}

function filerStatement(row: MappedFmpSenateRecord): SqlStatement | null {
  if (!row.filerId) return null;
  return [
    `INSERT OR IGNORE INTO filers
       (bioguide_id, chamber, full_name, party, state, district, committees)
     VALUES (?, 'senate', ?, '', '', '', '[]')`,
    [row.filerId, row.filerName],
  ];
}

function filingStatement(row: MappedFmpSenateRecord, nowIso: string): SqlStatement {
  return [
    `INSERT OR IGNORE INTO filings
       (doc_id, chamber, filer_id, filing_type, filed_date, source_url,
        raw_object_key, ingest_status, doc_kind, extractor, model_version,
        confidence, first_seen_at, source_updated_at, error)
     VALUES (?, 'senate', ?, 'P', ?, ?, NULL, 'provider_seeded', 'ptr',
             'fmp-senate-latest', 'fmp-stable-v1', ?, ?, ?, NULL)`,
    [
      row.docId,
      row.filerId,
      row.filedDate,
      row.sourceUrl,
      SEED_BASE_CONFIDENCE,
      firstSeenAt(row.filedDate, nowIso),
      nowIso,
    ],
  ];
}

function transactionStatement(row: MappedFmpSenateRecord): SqlStatement {
  const tx = row.transaction;
  return [
    `INSERT OR IGNORE INTO transactions (
       id, doc_id, filer_id, tx_date, owner, asset_name, ticker, asset_type,
       tx_type, amount_min, amount_max, is_option, cap_gains_over_200,
       raw_text, confidence, source, row_key, created_at, cursor_seq,
       first_seen_at, filed_date, est_value, disclosure_lag_days, stock_act_status
     )
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'seed_dataset',
            ?, ?, NULL, ?, ?, ?, ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM transactions
         WHERE doc_id = ? AND source IN ('primary', 'manual')
           AND deprecated_at IS NULL
      )`,
    [
      tx.id,
      tx.docId,
      tx.filerId,
      tx.txDate,
      tx.owner,
      tx.assetName,
      tx.ticker,
      tx.assetType,
      tx.txType,
      tx.amountMin,
      tx.amountMax,
      tx.isOption ? 1 : 0,
      tx.capGainsOver200 ? 1 : 0,
      tx.rawText,
      tx.confidence,
      row.rowKey,
      tx.createdAt,
      tx.firstSeenAt ?? null,
      tx.filedDate ?? null,
      estimateTransactionValue(tx.amountMin, tx.amountMax),
      computeDisclosureLagDays(tx.txDate, tx.filedDate),
      computeStockActStatus(tx.txDate, tx.filedDate),
      tx.docId,
    ],
  ];
}

function validatedPages(opts: FmpSenateRecoveryOptions): { fromPage: number; toPage: number } {
  const fromPage = opts.fromPage ?? 0;
  const toPage = opts.toPage ?? fromPage;
  if (!Number.isInteger(fromPage) || !Number.isInteger(toPage)) throw new Error('pages must be integers');
  if (fromPage < 0 || toPage < fromPage || toPage > MAX_PAGE) {
    throw new Error(`pages must satisfy 0 <= fromPage <= toPage <= ${MAX_PAGE}`);
  }
  if (toPage - fromPage + 1 > MAX_PAGES_PER_RUN) {
    throw new Error(`at most ${MAX_PAGES_PER_RUN} pages may be recovered per run`);
  }
  return { fromPage, toPage };
}

async function fetchPage(
  apiKey: string,
  page: number,
  fetchImpl: typeof fetch,
  pace: () => Promise<void>,
): Promise<FmpSenateRecord[]> {
  const url = `https://financialmodelingprep.com/stable/senate-latest?page=${page}&limit=${FMP_PAGE_LIMIT}` +
    `&apikey=${encodeURIComponent(apiKey)}`;
  await pace();
  const response = await trackedFetch(
    url,
    { headers: { accept: 'application/json', 'user-agent': 'congress.trade/0.1 (+https://congress.trade)' } },
    { service: 'backfill', operation: 'fmp-senate-recovery' },
    fetchImpl,
  );
  if (!response.ok) {
    assertFmpTierOk(response.status);
    throw new Error(`FMP senate page ${page} returned HTTP ${response.status}`);
  }
  const payload = await response.json() as unknown;
  if (!Array.isArray(payload)) throw new Error(`FMP senate page ${page} was not a JSON array`);
  return payload.filter((value): value is FmpSenateRecord => !!value && typeof value === 'object' && !Array.isArray(value));
}

async function persistPage(
  env: Env,
  rows: MappedFmpSenateRecord[],
  nowIso: string,
  errors: string[],
): Promise<Pick<FmpSenatePageResult, 'inserted' | 'duplicates' | 'rejected' | 'filingsInserted' | 'filersInserted'>> {
  let statements: SqlStatement[] = [];
  let pending: PendingKind[] = [];
  let inserted = 0;
  let duplicates = 0;
  let rejected = 0;
  let filingsInserted = 0;
  let filersInserted = 0;

  const flush = async () => {
    if (statements.length === 0) return;
    const batchKinds = pending;
    try {
      const results = await batch(env.DB, statements);
      results.forEach((result, index) => {
        const changes = result.meta?.changes ?? 0;
        switch (batchKinds[index]) {
          case 'transaction':
            if (changes > 0) inserted += changes;
            else duplicates += 1;
            break;
          case 'filing':
            filingsInserted += changes;
            break;
          case 'filer':
            filersInserted += changes;
            break;
        }
      });
    } catch (error) {
      const transactionCount = batchKinds.filter((kind) => kind === 'transaction').length;
      rejected += transactionCount;
      errors.push(`FMP recovery batch write failed: ${(error as Error).message}`);
    } finally {
      statements = [];
      pending = [];
    }
  };

  const seenFilers = new Set<string>();
  const seenFilings = new Set<string>();
  for (const row of rows) {
    if (row.filerId && !seenFilers.has(row.filerId)) {
      const statement = filerStatement(row);
      if (statement) {
        statements.push(statement);
        pending.push('filer');
      }
      seenFilers.add(row.filerId);
    }
    if (!seenFilings.has(row.docId)) {
      statements.push(filingStatement(row, nowIso));
      pending.push('filing');
      seenFilings.add(row.docId);
    }
    statements.push(transactionStatement(row));
    pending.push('transaction');
    if (statements.length >= WRITE_BATCH_SIZE) await flush();
  }
  await flush();
  return { inserted, duplicates, rejected, filingsInserted, filersInserted };
}

/** Operator-facing message when admin senate recovery is invoked. */
export const FMP_SENATE_RECOVERY_RETIRED =
  'FMP senate recovery is retired.  FMP keys (including FMP_API_KEY and FMP_LATENCY_*) are reserved for disclosure-latency probes only and must not backfill senate disclosures.  Use Quiver / official Senate eFD / existing disclosure ingestion instead.';

export async function runFmpSenateRecovery(
  env: Env,
  opts: FmpSenateRecoveryOptions = {},
): Promise<FmpSenateRecoveryResult> {
  // Keep page-bound validation so oversized ranges still fail with the old message
  // before the retirement error (admin UI / scripts may rely on that check).
  validatedPages(opts);
  void env;
  throw new Error(FMP_SENATE_RECOVERY_RETIRED);
}
