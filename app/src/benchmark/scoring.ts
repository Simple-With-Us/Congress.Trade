export interface BenchmarkRowComparison {
  resolved: true;
  /** Exact equality across every material field and duplicate occurrence. */
  perfectMatch: boolean;
  /** Row-detection counts keyed independently from strict field equality. */
  tp: number;
  fp: number;
  fn: number;
  gtCount: number;
  candCount: number;
}

type BenchmarkRow = Record<string, unknown>;

export const BENCHMARK_SCORING_PROFILE = 'ct-benchmark-scoring-v2-row-identity-strict-document';

export interface BenchmarkDocumentForScoring {
  docId: string;
  resolved: boolean;
  groundTruth: unknown;
}

export interface BenchmarkResultForScoring {
  docId: string;
  invoked: boolean;
  ok: boolean;
  outcome: string | null;
  result: unknown;
}

function firstDefined(row: BenchmarkRow, ...keys: string[]): unknown {
  for (const key of keys) {
    if (row[key] !== undefined) return row[key];
  }
  return undefined;
}

function normalizedText(value: unknown): string {
  return String(value ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
}

function normalizedAmount(value: unknown): number | null | string {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'string') {
    const compact = value.trim().replace(/[$,]/g, '');
    if (compact && Number.isFinite(Number(compact))) return Number(compact);
  }
  return normalizedText(value);
}

/** Canonical side letter for fingerprinting: Purchase/P/buy → B. */
function normalizedTxType(value: unknown): string {
  const s = String(value ?? '').trim().toUpperCase().replace(/[_\-]+/g, ' ');
  if (!s) return '';
  if (s === 'B' || s === 'P' || s.includes('PURCHASE') || s.includes('BUY') || s.includes('BOUGHT')) return 'B';
  if (s === 'S' || s.includes('SALE') || s.includes('SELL') || s.includes('SOLD')) return 'S';
  if (s === 'E' || s.includes('EXCHANGE')) return 'E';
  return s;
}

function normalizedBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

/**
 * Stable identity for row-detection precision/recall. Optional classifications,
 * ticker resolution, owner, and free-text details are deliberately excluded:
 * they describe fields on a detected disclosure row rather than whether the row
 * itself was found. Amounts keep otherwise-identical lots distinct.
 */
function benchmarkRowIdentityFingerprint(row: BenchmarkRow): string {
  return JSON.stringify([
    normalizedText(firstDefined(row, 'assetName', 'asset_name')),
    firstDefined(row, 'txDate', 'tx_date') ?? '',
    normalizedTxType(firstDefined(row, 'txType', 'tx_type')),
    normalizedAmount(firstDefined(row, 'amountMin', 'amount_min')),
    normalizedAmount(firstDefined(row, 'amountMax', 'amount_max')),
  ]);
}

/** Exact material-row equality used only for strict document accuracy. */
function benchmarkStrictRowFingerprint(row: BenchmarkRow): string {
  return JSON.stringify([
    normalizedText(row.ticker),
    normalizedText(firstDefined(row, 'assetName', 'asset_name')),
    firstDefined(row, 'txDate', 'tx_date') ?? '',
    normalizedTxType(firstDefined(row, 'txType', 'tx_type')),
    normalizedAmount(firstDefined(row, 'amountMin', 'amount_min')),
    normalizedAmount(firstDefined(row, 'amountMax', 'amount_max')),
    normalizedText(row.owner),
    normalizedText(firstDefined(row, 'assetType', 'asset_type')),
    normalizedText(firstDefined(row, 'assetTypeName', 'asset_type_name')),
    normalizedBoolean(firstDefined(row, 'isOption', 'is_option')),
    normalizedBoolean(firstDefined(row, 'capGainsOver200', 'cap_gains_over_200')),
    normalizedText(firstDefined(row, 'filingStatus', 'filing_status')),
    normalizedText(row.subholding),
    normalizedText(row.location),
    normalizedText(row.description),
    normalizedText(firstDefined(row, 'supplementalText', 'supplemental_text')),
  ]);
}

function multisetCounts(rows: BenchmarkRow[], fingerprint: (row: BenchmarkRow) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = fingerprint(row);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function multisetsEqual(left: Map<string, number>, right: Map<string, number>): boolean {
  if (left.size !== right.size) return false;
  for (const [key, count] of left) {
    if (right.get(key) !== count) return false;
  }
  return true;
}

/**
 * Score one model read against a human-resolved document.
 *
 * `perfectMatch` remains strict across all material fields. TP/FP/FN instead
 * measure row detection on a stable identity key, so an optional narrative-field
 * difference does not turn one found row into both a false positive and a false
 * negative. Both comparisons are order-independent and preserve duplicates.
 */
export function compareBenchmarkRows(
  candidateRows: BenchmarkRow[],
  groundTruth: BenchmarkRow[],
): BenchmarkRowComparison {
  const candidateStrict = multisetCounts(candidateRows, benchmarkStrictRowFingerprint);
  const truthStrict = multisetCounts(groundTruth, benchmarkStrictRowFingerprint);
  const candidateIdentity = multisetCounts(candidateRows, benchmarkRowIdentityFingerprint);
  const truthIdentity = multisetCounts(groundTruth, benchmarkRowIdentityFingerprint);
  let tp = 0;
  let fp = 0;
  let fn = 0;

  for (const fingerprint of new Set([...candidateIdentity.keys(), ...truthIdentity.keys()])) {
    const candidate = candidateIdentity.get(fingerprint) ?? 0;
    const truth = truthIdentity.get(fingerprint) ?? 0;
    const matches = Math.min(candidate, truth);
    tp += matches;
    fp += Math.max(0, candidate - matches);
    fn += Math.max(0, truth - matches);
  }

  return {
    resolved: true,
    perfectMatch: multisetsEqual(candidateStrict, truthStrict),
    tp,
    fp,
    fn,
    gtCount: groundTruth.length,
    candCount: candidateRows.length,
  };
}

function resultRows(value: unknown): BenchmarkRow[] {
  if (!value || typeof value !== 'object') return [];
  const rows = (value as { rows?: unknown }).rows;
  return Array.isArray(rows)
    ? rows.filter((row): row is BenchmarkRow => Boolean(row) && typeof row === 'object' && !Array.isArray(row))
    : [];
}

/**
 * Deterministically re-score a saved terminal cell without contacting a provider.
 * Provider/account failures, unavailable calls, and unresolved cells remain
 * unscored. End-to-end reliability is reported separately from OCR accuracy.
 */
export function scorePersistedBenchmarkResult(
  document: BenchmarkDocumentForScoring,
  result: BenchmarkResultForScoring,
): BenchmarkRowComparison | null {
  if (!document.resolved || result.outcome === 'running' || !result.invoked || !result.ok) return null;
  const truth = Array.isArray(document.groundTruth)
    ? document.groundTruth.filter(
        (row): row is BenchmarkRow => Boolean(row) && typeof row === 'object' && !Array.isArray(row),
      )
    : [];
  return compareBenchmarkRows(resultRows(result.result), truth);
}
