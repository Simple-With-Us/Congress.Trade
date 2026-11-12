/**
 * Material multiset hash for admin republish idempotency (CT-2510).
 * Provenance fields (source, row_key, confidence, cleaning_note, ids) are
 * excluded — only normalized disclosure content counts.
 */
import { sha256Hex } from '../auth/tokens.ts';
import { simplifyCompanyName } from '../extraction/nameNormalizer.ts';
import type { Transaction } from '../shared/types.ts';
import { all } from '../shared/db.ts';
import { PIPELINE_TX_SOURCES_SQL } from '../extraction/sourceSupersede.ts';
import type { CorrectionPlan, PriorTxRow } from './reviewCorrection.ts';
import { reviveChangedIds } from './reviewCorrection.ts';

export interface PublishMaterialRow {
  txDate: string;
  owner: string | null;
  assetName?: string;
  ticker?: string | null;
  txType: string;
  amountMin?: number | null;
  amountMax?: number | null;
  isOption?: boolean;
  capGainsOver200?: boolean;
  filingStatus?: string | null;
  subholding?: string | null;
  location?: string | null;
  description?: string | null;
  supplementalText?: string | null;
}

function normText(value: string | null | undefined): string {
  return (value ?? '').trim();
}

function normOwner(value: string | null | undefined): string {
  return normText(value).toLowerCase();
}

export function materialRowFingerprint(row: PublishMaterialRow): string {
  return JSON.stringify([
    row.txDate,
    normOwner(row.owner),
    simplifyCompanyName(normText(row.assetName)),
    normText(row.ticker).toUpperCase() || null,
    normText(row.txType).toUpperCase(),
    row.amountMin ?? null,
    row.amountMax ?? null,
    Boolean(row.isOption),
    Boolean(row.capGainsOver200),
    normText(row.filingStatus).toLowerCase() || null,
    normText(row.subholding).toLowerCase() || null,
    normText(row.location).toLowerCase() || null,
    normText(row.description) || null,
    normText(row.supplementalText) || null,
  ]);
}

export function materialFingerprintFromPrior(row: PriorTxRow & {
  is_option?: number | null;
  cap_gains_over_200?: number | null;
  filing_status?: string | null;
  subholding?: string | null;
  location?: string | null;
  description?: string | null;
  supplemental_text?: string | null;
}): string {
  return materialRowFingerprint({
    txDate: row.tx_date ?? '',
    owner: row.owner,
    assetName: row.asset_name ?? undefined,
    ticker: row.ticker,
    txType: row.tx_type ?? '',
    amountMin: row.amount_min,
    amountMax: row.amount_max,
    isOption: Boolean(row.is_option),
    capGainsOver200: Boolean(row.cap_gains_over_200),
    filingStatus: row.filing_status ?? null,
    subholding: row.subholding ?? null,
    location: row.location ?? null,
    description: row.description ?? null,
    supplementalText: row.supplemental_text ?? null,
  });
}

export async function multisetContentHash(fingerprints: readonly string[]): Promise<string> {
  const sorted = [...fingerprints].sort();
  return sha256Hex(`${sorted.length}\n${sorted.join('\n')}`);
}

export async function hashPublishMaterialRows(rows: readonly PublishMaterialRow[]): Promise<string> {
  return multisetContentHash(rows.map((row) => materialRowFingerprint(row)));
}

export function materialFingerprintFromTransaction(tx: Transaction): string {
  return materialRowFingerprint({
    txDate: tx.txDate,
    owner: tx.owner,
    assetName: tx.assetName,
    ticker: tx.ticker,
    txType: tx.txType,
    amountMin: tx.amountMin,
    amountMax: tx.amountMax,
    isOption: tx.isOption,
    capGainsOver200: tx.capGainsOver200,
    filingStatus: tx.filingStatus,
    subholding: tx.subholding,
    location: tx.location,
    description: tx.description,
    supplementalText: tx.supplementalText,
  });
}

type LiveMaterialRow = PriorTxRow & {
  is_option?: number | null;
  cap_gains_over_200?: number | null;
  filing_status?: string | null;
  subholding?: string | null;
  location?: string | null;
  description?: string | null;
  supplemental_text?: string | null;
};

/** Multiset hash of the current live pipeline rows for a filing. */
export async function livePipelineContentHash(
  db: D1Database,
  docId: string,
): Promise<{ hash: string | null; count: number }> {
  const rows = await all<LiveMaterialRow>(
    db,
    `SELECT tx_date, owner, asset_name, ticker, tx_type, amount_min, amount_max,
            is_option, cap_gains_over_200, filing_status, subholding, location,
            description, supplemental_text
       FROM transactions
      WHERE doc_id = ? AND source IN (${PIPELINE_TX_SOURCES_SQL}) AND deprecated_at IS NULL`,
    [docId],
  );
  if (rows.length === 0) {
    return { hash: null, count: 0 };
  }
  return {
    hash: await multisetContentHash(rows.map((row) => materialFingerprintFromPrior(row))),
    count: rows.length,
  };
}

/** True when proposed normalized rows match the live pipeline multiset. */
export async function proposedMatchesLivePipeline(
  db: D1Database,
  docId: string,
  transactions: readonly Transaction[],
): Promise<{ identical: boolean; contentHash: string }> {
  const proposedHash = await hashPublishMaterialRows(
    transactions.map((tx) => ({
      txDate: tx.txDate,
      owner: tx.owner,
      assetName: tx.assetName,
      ticker: tx.ticker,
      txType: tx.txType,
      amountMin: tx.amountMin,
      amountMax: tx.amountMax,
      isOption: tx.isOption,
      capGainsOver200: tx.capGainsOver200,
      filingStatus: tx.filingStatus,
      subholding: tx.subholding,
      location: tx.location,
      description: tx.description,
      supplementalText: tx.supplementalText,
    })),
  );
  const live = await livePipelineContentHash(db, docId);
  return {
    identical: live.count === transactions.length && live.hash === proposedHash,
    contentHash: proposedHash,
  };
}

type StoredReviveRow = Readonly<Record<string, string | number | null | undefined>>;

/**
 * True when the admin edit set would leave the live disclosure content
 * unchanged (republish / duplicate publish no-op).
 */
export async function assessIdenticalAdminRepublish(input: {
  edits: readonly PublishMaterialRow[];
  plan: CorrectionPlan;
  prior: readonly PriorTxRow[];
  insertCount: number;
  reviveRows: readonly StoredReviveRow[];
  storedById: ReadonlyMap<string, Readonly<Record<string, string | number | null | undefined>>>;
}): Promise<{ identical: boolean; contentHash: string }> {
  const contentHash = await hashPublishMaterialRows(input.edits);
  const plan = input.plan;
  if (!plan.ok || plan.added.length > 0 || plan.retired.length > 0 || input.insertCount > 0) {
    return { identical: false, contentHash };
  }
  if (plan.matches.length !== input.edits.length) {
    return { identical: false, contentHash };
  }
  if (plan.matches.some((m) => m.kind === 'corrected')) {
    return { identical: false, contentHash };
  }

  const live = input.prior.filter((row) => !row.deprecated_at);
  if (live.length === input.edits.length) {
    const liveHash = await multisetContentHash(live.map((row) => materialFingerprintFromPrior(row)));
    if (liveHash === contentHash) {
      return { identical: true, contentHash };
    }
  }

  const matchedPrior = plan.matches
    .map((match) => input.prior.find((row) => row.id === match.txId))
    .filter((row): row is NonNullable<typeof row> => row != null);
  if (matchedPrior.length === input.edits.length) {
    const priorHash = await multisetContentHash(matchedPrior.map((row) => materialFingerprintFromPrior(row)));
    if (priorHash === contentHash) {
      return { identical: true, contentHash };
    }
  }

  if (input.reviveRows.length === input.edits.length
    && reviveChangedIds(input.storedById, input.reviveRows).length === 0) {
    return { identical: true, contentHash };
  }

  return { identical: false, contentHash };
}
