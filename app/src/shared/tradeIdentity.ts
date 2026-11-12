/**
 * src/shared/tradeIdentity.ts
 * OWNER: analytics + delivery
 *
 * Canonical real-world trade identity for DATACORRECTNESS-01/02.
 * The same disclosed trade can sit under several `source` values
 * (primary, manual, local_mac, competitor_backfill). Analytics and the
 * public feed must count it once, preferring the official row.
 *
 * Canonical key: (filer_id, tx_date, ticker-or-normalized-asset, side,
 * bracket, owner). Source precedence: primary > manual > local_mac >
 * competitor_backfill. Empty competitor owner / fabricated competitor
 * brackets are wildcards so a provider copy still loses to the official
 * twin even when those fields were never supplied.
 *
 * Also owns the publish-time sanitizer for competitor_backfill rows whose
 * provider did not supply a real bracket or filing date (DATACORRECTNESS-02).
 * Those rows must not ship $1,001–$15,000 or filed_date = tx_date as
 * first-class facts.
 */

export const SOURCE_RANK = {
  primary: 1,
  manual: 2,
  local_mac: 3,
  server_cpu: 3,
  competitor_backfill: 4,
  seed_dataset: 5,
} as const;

const FABRICATED_COMPETITOR_MIN = new Set([1000, 1001]);
const FABRICATED_COMPETITOR_MAX = 15000;

export function sourceRankSql(alias = 't'): string {
  return (
    `CASE ${alias}.source ` +
    "WHEN 'primary' THEN 1 " +
    "WHEN 'manual' THEN 2 " +
    "WHEN 'local_mac' THEN 3 " +
    "WHEN 'server_cpu' THEN 3 " +
    "WHEN 'competitor_backfill' THEN 4 " +
    "WHEN 'seed_dataset' THEN 5 " +
    'ELSE 6 END'
  );
}

/** Ticker if present, else the trimmed asset name. Uppercased so twins match. */
export function canonicalAssetSql(alias = 't'): string {
  return (
    `UPPER(TRIM(COALESCE(NULLIF(${alias}.ticker, ''), NULLIF(${alias}.asset_name, ''), '')))`
  );
}

/** Buy letters B and legacy P collapse to B. */
export function canonicalSideSql(alias = 't'): string {
  return (
    `CASE WHEN ${alias}.tx_type IN ('B', 'P') THEN 'B' ELSE COALESCE(${alias}.tx_type, '') END`
  );
}

export function canonicalOwnerSql(alias = 't'): string {
  return `LOWER(TRIM(COALESCE(${alias}.owner, '')))`;
}

/**
 * Normalized STOCK Act band. The 1000–15000 OCR miss snaps to 1001–15000
 * so Fleischmann-style manual+primary twins share a key. Fabricated
 * competitor defaults and fully-missing amounts become '' (wildcard).
 */
export function canonicalBracketSql(alias = 't'): string {
  return (
    `CASE WHEN ${fabricatedCompetitorAmountSql(alias)} THEN '' ` +
    `WHEN ${alias}.amount_min IS NULL AND ${alias}.amount_max IS NULL THEN '' ` +
    `WHEN (${alias}.amount_min IN (1000, 1001) AND ${alias}.amount_max = 15000) THEN '1001-15000' ` +
    `ELSE CAST(${alias}.amount_min AS TEXT) || '-' || COALESCE(CAST(${alias}.amount_max AS TEXT), 'open') END`
  );
}

/** True when a competitor_backfill row is carrying the injector default band. */
export function fabricatedCompetitorAmountSql(alias = 't'): string {
  return (
    `(${alias}.source = 'competitor_backfill' AND (` +
    `${alias}.amount_min IS NULL OR (` +
    `(${alias}.amount_min = 1000 OR ${alias}.amount_min = 1001) AND ${alias}.amount_max = 15000` +
    ')))'
  );
}

/** Competitor filed_date that is missing or equal to the trade date. */
export function fabricatedCompetitorFiledDateSql(alias = 't'): string {
  return (
    `(${alias}.source = 'competitor_backfill' AND (` +
    `${alias}.filed_date IS NULL OR ${alias}.filed_date = ${alias}.tx_date))`
  );
}

/**
 * Covering seek for the twin-guard subquery. Equality on (filer_id, tx_date)
 * must be able to SEARCH this index; a SCAN of transactions per outer row is
 * what hung GET /transactions and Trends after PR 2037 (issue #2062).
 */
export const TWIN_SEEK_INDEX = 'idx_tx_twin_seek';

/**
 * Keep the highest-precedence live twin. Same-rank ties keep the stable
 * smaller id — never confidence, because competitor rows were stamped 100.
 *
 * Indexed predicates (filer_id, tx_date, live) come first so SQLite can
 * SEARCH {@link TWIN_SEEK_INDEX} instead of scanning the corpus per row.
 */
export const TWIN_DEDUPE_SQL =
  'NOT EXISTS (' +
  'SELECT 1 FROM transactions d ' +
  'WHERE d.filer_id = t.filer_id ' +
  'AND d.tx_date = t.tx_date ' +
  'AND d.deprecated_at IS NULL ' +
  'AND d.id != t.id ' +
  'AND d.filer_id IS NOT NULL ' +
  `AND ${canonicalAssetSql('d')} = ${canonicalAssetSql('t')} ` +
  `AND ${canonicalSideSql('d')} = ${canonicalSideSql('t')} ` +
  `AND (${canonicalOwnerSql('d')} = ${canonicalOwnerSql('t')} ` +
  `OR (d.source = 'competitor_backfill' AND ${canonicalOwnerSql('d')} = '') ` +
  `OR (t.source = 'competitor_backfill' AND ${canonicalOwnerSql('t')} = '')) ` +
  `AND (${canonicalBracketSql('d')} = ${canonicalBracketSql('t')} ` +
  `OR ${canonicalBracketSql('d')} = '' ` +
  `OR ${canonicalBracketSql('t')} = '') ` +
  `AND (${sourceRankSql('d')} < ${sourceRankSql('t')} ` +
  `OR (${sourceRankSql('d')} = ${sourceRankSql('t')} AND d.id < t.id))` +
  ')';

export function isFabricatedCompetitorAmount(
  source: string | null | undefined,
  amountMin: number | null | undefined,
  amountMax: number | null | undefined,
): boolean {
  if (source !== 'competitor_backfill') return false;
  if (amountMin == null && amountMax == null) return true;
  return (
    amountMin != null &&
    FABRICATED_COMPETITOR_MIN.has(amountMin) &&
    amountMax === FABRICATED_COMPETITOR_MAX
  );
}

export function isFabricatedCompetitorFiledDate(
  source: string | null | undefined,
  filedDate: string | null | undefined,
  txDate: string | null | undefined,
): boolean {
  if (source !== 'competitor_backfill') return false;
  if (filedDate == null || filedDate === '') return true;
  if (txDate == null || txDate === '') return false;
  return filedDate.slice(0, 10) === txDate.slice(0, 10);
}

export interface PublishedCompetitorFields {
  source?: string | null;
  amountMin?: number | null;
  amountMax?: number | null;
  estValue?: number | null;
  filedDate?: string | null;
  txDate?: string | null;
  disclosureLagDays?: number | null;
  stockActStatus?: string | null;
  confidence?: number | null;
}

/**
 * Strip injector defaults from a competitor_backfill row at the publish
 * boundary. Official sources are returned unchanged.
 */
export function sanitizeCompetitorPublication<T extends PublishedCompetitorFields>(row: T): T {
  if (row.source !== 'competitor_backfill') return row;
  const next = { ...row };
  if (isFabricatedCompetitorAmount(row.source, row.amountMin ?? null, row.amountMax ?? null)) {
    next.amountMin = null;
    next.amountMax = null;
    next.estValue = null;
  }
  if (isFabricatedCompetitorFiledDate(row.source, row.filedDate ?? null, row.txDate ?? null)) {
    next.filedDate = null;
    next.disclosureLagDays = null;
    next.stockActStatus = null;
  }
  if (row.confidence == null || row.confidence >= 1) {
    next.confidence = 0;
  }
  return next;
}
