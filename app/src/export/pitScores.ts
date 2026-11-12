/**
 * src/export/pitScores.ts
 * OWNER: export
 *
 * Point-in-time congressional score export for App B historical validation.
 * Scores are keyed by (ticker, disclosure availability timestamp), never by the
 * private trade date. Score inputs are cut off at that availability timestamp;
 * forward labels may use later price data but are separated under `labels`.
 */

import type { Env, TxType } from '../shared/types.ts';
import { all, type SqlParam, parseJson } from '../shared/db.ts';
import { bracketMidpoint, netSentiment, round } from '../analytics/compute.ts';
import { committeeConflict } from '../analytics/conflicts.ts';
import { TICKER_RENAMES, classifyTickerAlias } from '@jaywedgeworth22/congress-trading-shared';
import { pctChange } from '../prices/compute.ts';
import { canonicalizeAssetType } from '../shared/assetTypes.ts';

export const PIT_SCORE_VERSION = 'congress-pit-v2';
export const TICKER_MAP_VERSION = 'ticker-normalize-v1';
export const COMMITTEE_SECTOR_MAPPING_VERSION = 'committee-sector-v1';
export const MEMBER_SKILL_VERSION = 'member-skill-pit-v1';
export const MEMBER_SKILL_HORIZON_DAYS = 63;
export const MEMBER_SKILL_HORIZONS = [
  { key: '1m', days: 21, weight: 0.2 },
  { key: '3m', days: 63, weight: 0.35 },
  { key: '6m', days: 126, weight: 0.25 },
  { key: '12m', days: 252, weight: 0.2 },
] as const;
export const LABEL_HORIZONS_DAYS = [1, 5, 21, 63, 126, 252] as const;
export const CLUSTER_WINDOWS = [
  { key: '21d_1m', label: '21d/1m', days: 21 },
  { key: '63d_3m', label: '63d/3m', days: 63 },
] as const;

export const PIT_SCORE_WEIGHTS = {
  consensus: 0.35,
  flow: 0.2,
  freshness: 0.15,
  member_skill: 0.2,
  committee_sector_overlap: 0,
} as const;

export const PIT_PLACEBOS = [
  'none',
  'within_date_score_permutation',
  'member_shuffle',
  'disclosure_date_jitter',
  'buy_sell_flip',
  'no_member_skill',
  'no_freshness',
  'no_flow',
  'activity_only_proxy',
  'future_shift_leakage_detector',
  'split_dividend_event_stress_subset',
] as const;

export type PitPlacebo = (typeof PIT_PLACEBOS)[number];
type Basis = 'sourced' | 'computed' | 'inferred' | 'missing';
type Direction = 'BUY' | 'SELL' | 'MIXED' | null;
type SkillBasis = 'filing' | 'trade';
type SkillSide = 'buy' | 'sell';

export interface PitScoreQuery {
  from?: string;
  to?: string;
  ticker?: string;
  cursor?: PitScoreCursor;
  limit: number;
  format: 'json' | 'ndjson';
  placebo: PitPlacebo;
  source?: 'primary' | 'seed_dataset' | 'manual' | 'all';
  minConf?: number;
}

interface PitScoreCursor {
  asOf: string;
  ticker: string;
}

interface TxRow {
  id: string;
  doc_id: string | null;
  filer_id: string | null;
  tx_date: string | null;
  owner: string | null;
  asset_name: string | null;
  ticker: string;
  asset_type: string | null;
  asset_type_name: string | null;
  tx_type: TxType;
  amount_min: number | null;
  amount_max: number | null;
  is_option: number | null;
  raw_text: string | null;
  confidence: number | null;
  source: string | null;
  created_at: string | null;
  filed_date: string | null;
  first_seen_at: string | null;
  source_url: string | null;
  filing_chamber: string | null;
  full_name: string | null;
  filer_chamber: string | null;
  party: string | null;
  state: string | null;
  committees: string | null;
  company_name: string | null;
  sector: string | null;
  industry: string | null;
  asset_class: string | null;
  cik: string | null;
  exchange_short: string | null;
}

export interface PriceBar {
  date: string;
  close: number;
}

interface Component {
  name: keyof typeof PIT_SCORE_WEIGHTS | 'activity_prominence';
  value: number | null;
  weight: number;
  basis: Basis;
  fallback: string | null;
  sourceRecordIds: string[];
}

interface MemberSkillSummary {
  skillScore: number | null;
  filingAlpha: number | null;
  tradeAlpha: number | null;
  decayRatio: number | null;
  skillAsOf: string;
  skillScoredThrough: string | null;
  trainingWindow: string;
  trainingWindowDetails: Record<string, unknown>;
  horizonDays: number;
  horizonWeights: Record<string, number>;
  scoredCount: number;
  wins: number;
  winRate: number | null;
  avgExcessReturn: number | null;
  shrinkagePrior: { alpha: number; beta: number };
  dispersionWinsorization: Record<string, unknown>;
  byBasis: Record<SkillBasis, Record<string, unknown>>;
  byDirection: Record<SkillSide, Record<string, unknown>>;
  horizons: Record<string, Record<string, unknown>>;
  fallback: 'activity_prominence' | null;
  fallbackScore: number | null;
  sourceRecordIds: string[];
}

interface PitScoreRow {
  observationId: string;
  ticker: string;
  stableSecurityId: string | null;
  cusip: string | null;
  cik: string | null;
  assetType: string | null;
  assetTypeName: string | null;
  assetTypeCategory: string;
  assetTypeCategoryLabel: string;
  assetTypeCategorySource: string;
  tickerMapVersion: string;
  delistingTickerChangeMetadata: Record<string, unknown>;
  asOf: string;
  disclosureAvailableAt: string;
  computedAt: string;
  dataCutoffAt: string;
  scoreVersion: string;
  parameterManifest: Record<string, unknown>;
  direction: Direction;
  congressScore: number | null;
  signedScore: number | null;
  components: Component[];
  rawInputs: Record<string, unknown>;
  provenance: Record<string, unknown>;
  pitValidity: Record<string, unknown>;
  includedDisclosures: Array<Record<string, unknown>>;
  memberSkill: MemberSkillSummary;
  clusterConsensus: Record<string, unknown>;
  committeeSectorOverlap: Record<string, unknown>;
  labels: Record<string, unknown>;
  baselines: Record<string, unknown>;
  placebo: Record<string, unknown>;
}

export interface PitScoreExportResult {
  generatedAt: string;
  scoreVersion: string;
  format: 'json' | 'ndjson';
  requested: PitScoreQuery;
  parameterManifest: Record<string, unknown>;
  placebosAvailable: readonly PitPlacebo[];
  rowCount: number;
  pagination: {
    limit: number;
    nextCursor: string | null;
  };
  validationReadiness: Record<string, unknown>;
  rows: PitScoreRow[];
  notes: string[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TICKER_RE = /^[A-Z0-9._-]{1,20}$/;
const SOURCE_FILTERS = new Set(['primary', 'seed_dataset', 'manual', 'all']);

const ASOF_SQL = 't.disclosure_available_at';

interface AvailabilityInfo {
  timestamp: string | null;
  source: 'first_seen_at' | 'filed_date' | 'created_at' | 'missing';
  precision: 'timestamp' | 'date' | 'missing';
  conservativeLabelEntryDate: string | null;
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function finiteOrNull(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function dateOnly(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  return m ? m[1] : null;
}

function isoTimestamp(value: string | null | undefined): string | null {
  const d = dateOnly(value);
  if (!d) return null;
  if (value && value.includes('T')) return value;
  return `${d}T00:00:00.000Z`;
}

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

function maxDate(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

function transactionQueryLimit(q: PitScoreQuery): number {
  return Math.min(50_000, Math.max(10_000, q.limit * 100));
}

function availabilityFor(row: Pick<TxRow, 'first_seen_at' | 'filed_date' | 'created_at'>): AvailabilityInfo {
  const source: AvailabilityInfo['source'] =
    dateOnly(row.first_seen_at) ? 'first_seen_at' :
    dateOnly(row.filed_date) ? 'filed_date' :
    dateOnly(row.created_at) ? 'created_at' :
    'missing';
  const raw = source === 'first_seen_at' ? row.first_seen_at : source === 'filed_date' ? row.filed_date : source === 'created_at' ? row.created_at : null;
  const timestamp = isoTimestamp(raw);
  const precision: AvailabilityInfo['precision'] = !timestamp ? 'missing' : raw && raw.includes('T') ? 'timestamp' : 'date';
  const d = dateOnly(timestamp);
  return {
    timestamp,
    source,
    precision,
    conservativeLabelEntryDate: d ? addDays(d, precision === 'date' ? 1 : 0) : null,
  };
}

function daysBetween(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const ta = Date.parse(`${a}T00:00:00.000Z`);
  const tb = Date.parse(`${b}T00:00:00.000Z`);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return null;
  return Math.floor((tb - ta) / 86_400_000);
}

function normalizeTicker(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const t = raw.trim().toUpperCase();
  return TICKER_RE.test(t) ? t : undefined;
}

function parseCursor(raw: string | undefined): PitScoreCursor | { error: string; status: number } | undefined {
  if (!raw) return undefined;
  const parts = raw.split('~');
  if (parts.length !== 2) return { error: 'invalid cursor', status: 400 };
  const asOf = parts[0];
  const ticker = normalizeTicker(parts[1]);
  if (!dateOnly(asOf) || !ticker) return { error: 'invalid cursor', status: 400 };
  return { asOf, ticker };
}

function encodeCursor(asOf: string, ticker: string): string {
  return `${asOf}~${ticker}`;
}

export function parsePitScoreQuery(q: Record<string, string | undefined>): PitScoreQuery | { error: string; status: number } {
  const from = q.from?.trim();
  const to = q.to?.trim();
  if (from && !DATE_RE.test(from)) return { error: 'from must be YYYY-MM-DD', status: 400 };
  if (to && !DATE_RE.test(to)) return { error: 'to must be YYYY-MM-DD', status: 400 };
  if (from && to && from > to) return { error: 'from must be <= to', status: 400 };
  const ticker = normalizeTicker(q.ticker);
  if (q.ticker && !ticker) return { error: 'invalid ticker', status: 400 };
  const limitRaw = Math.floor(Number(q.limit) || 100);
  const limit = Math.max(1, Math.min(500, limitRaw));
  const format = q.format === 'ndjson' ? 'ndjson' : 'json';
  const placebo = (q.placebo || 'none') as PitPlacebo;
  if (!(PIT_PLACEBOS as readonly string[]).includes(placebo)) {
    return { error: 'unknown placebo', status: 400 };
  }
  if (q.source && !SOURCE_FILTERS.has(q.source)) return { error: 'unknown source', status: 400 };
  const source = q.source ? (q.source as PitScoreQuery['source']) : 'all';
  const minConf =
    q.minConf !== undefined && q.minConf !== '' && Number.isFinite(Number(q.minConf))
      ? Number(q.minConf)
      : undefined;
  if (minConf !== undefined && (minConf < 0 || minConf > 1)) return { error: 'minConf must be between 0 and 1', status: 400 };
  const cursor = parseCursor(q.cursor);
  if (cursor && 'error' in cursor) return cursor;
  return { from, to, ticker, cursor, limit, format, placebo, source, minConf } as any;
}

function parameterManifest(): Record<string, unknown> {
  return {
    scoreVersion: PIT_SCORE_VERSION,
    tickerMapVersion: TICKER_MAP_VERSION,
    committeeSectorMappingVersion: COMMITTEE_SECTOR_MAPPING_VERSION,
    memberSkillVersion: MEMBER_SKILL_VERSION,
    weights: PIT_SCORE_WEIGHTS,
    memberSkill: {
      primaryHorizonDays: MEMBER_SKILL_HORIZON_DAYS,
      horizons: MEMBER_SKILL_HORIZONS,
      horizonWeights: horizonWeightsRecord(),
      bases: ['filing_date_basis', 'trade_date_basis'],
      directions: ['buy', 'sell'],
      noLeakageRule:
        'At asOf, skill uses only prior disclosures whose horizon close exists at or before asOf; trade-date basis is computed only after the disclosure is market-available.',
      maxTrainingRowsPerObservation: 1000,
      trainingSelection: 'newest prior disclosed transactions first; older rows beyond the cap are truncated',
      shrinkagePrior: { alpha: 2.5, beta: 2.5, meaning: 'Beta prior on directional win rate; alpha mean is shrunk toward 0 by sample weighting.' },
      dispersionWinsorization:
        'Sample standard deviation is reported on raw direction-adjusted excess returns; returns are winsorized at 5th/95th percentile per basis/direction/horizon when n >= 20.',
    },
    clusterConsensus: {
      windows: CLUSTER_WINDOWS,
      perMemberCapsAndDiminishingReturns: {
        maxContributionPerMemberPerDirectionPerWindow: 1,
        amountWeight: '0.5 + 0.5 * min(1, log10(1 + STOCK Act bracket midpoint) / 6)',
        diminishingReturn: 'log1p(dominant distinct members) / log1p(12)',
      },
      currentStateMetadata:
        'party/chamber breadth uses current filer metadata until PIT filer history exists; it is context only.',
    },
    labels: {
      horizonsDays: LABEL_HORIZONS_DAYS,
      horizonBasis: 'trading_days',
      entryBasis: 'first_adjusted_close_on_or_after_conservative_actionable_date',
      benchmark: 'S&P 500 from spx_eod',
    },
    committeeSectorOverlap:
      'Current committee/security reference metadata is exported as context only. Weight is 0 until PIT committee/security reference vintages exist.',
  };
}

function midpoint(row: Pick<TxRow, 'amount_min' | 'amount_max'>): number {
  return bracketMidpoint(row.amount_min == null ? null : num(row.amount_min), row.amount_max == null ? null : num(row.amount_max));
}

function directionFrom(buyCount: number, sellCount: number, netFlowUsd: number): Direction {
  const sentiment = netSentiment(buyCount, sellCount);
  if (sentiment == null) return null;
  if (sentiment > 0.5) return 'BUY';
  if (sentiment < 0.5) return 'SELL';
  if (netFlowUsd > 0) return 'BUY';
  if (netFlowUsd < 0) return 'SELL';
  return 'MIXED';
}

function scoreComponents(components: Component[]): { score: number | null; signed: number | null } {
  let total = 0;
  let weight = 0;
  for (const c of components) {
    if (c.value == null || c.weight <= 0) continue;
    total += c.value * c.weight;
    weight += c.weight;
  }
  if (weight <= 0) return { score: null, signed: null };
  const score = Math.round(total / weight);
  return { score, signed: score };
}

function hashString(input: string): string {
  let h = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < input.length; i += 1) {
    const c = input.charCodeAt(i);
    h ^= c;
    h = Math.imul(h, 0x01000193);
    h2 ^= c + i;
    h2 = Math.imul(h2, 0x85ebca6b);
  }
  return (h >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

function stableFilerHash(filerId: string | null): string | null {
  if (!filerId) return null;
  return `filer_${hashString(`congress.trade:filer:${filerId}`)}`;
}

function stableObservationId(scoreVersion: string, ticker: string, asOf: string, txIds: string[], placebo: PitPlacebo): string {
  return `obs_${hashString([scoreVersion, ticker, asOf, txIds.sort().join(','), placebo].join('|'))}`;
}

async function loadTransactions(env: Env, q: PitScoreQuery): Promise<TxRow[]> {
  const where = [
    't.deprecated_at IS NULL',
    "t.ticker IS NOT NULL AND t.ticker <> ''",
    "t.tx_type IN ('B', 'P', 'S')",
    // Congress PIT scores are a CONGRESSIONAL contract for App B: executive
    // (OGE 278-T) rows stay out until the shared package carries the chamber.
    "(COALESCE(fl.chamber, f.chamber) IS NULL OR COALESCE(fl.chamber, f.chamber) <> 'executive')",
  ];
  const params: SqlParam[] = [];
  const cursorDate = dateOnly(q.cursor?.asOf);
  const contextAnchor = cursorDate ? maxDate(q.from, cursorDate) : q.from;
  if (contextAnchor) {
    const contextFrom = addDays(contextAnchor, -63);
    where.push(`substr(${ASOF_SQL}, 1, 10) >= ?`);
    params.push(contextFrom);
  }
  if (q.to) {
    where.push(`substr(${ASOF_SQL}, 1, 10) <= ?`);
    params.push(q.to);
  }
  if (q.ticker) {
    where.push('t.ticker = ?');
    params.push(q.ticker);
  }
  if (q.source && q.source !== 'all') {
    where.push('t.source = ?');
    params.push(q.source);
  }
  if (typeof q.minConf === 'number') {
    where.push('t.confidence >= ?');
    params.push(q.minConf);
  }
  const txLimit = transactionQueryLimit(q);
  const sql =
    `SELECT t.id, t.doc_id, t.filer_id, t.tx_date, t.owner, t.asset_name, t.ticker, ` +
    `t.asset_type, t.asset_type_name, t.tx_type, t.amount_min, t.amount_max, t.is_option, ` +
    `t.raw_text, t.confidence, t.source, t.created_at, ` +
    `f.filed_date, f.first_seen_at, f.source_url, f.chamber AS filing_chamber, ` +
    `COALESCE(fl.display_name, fl.full_name) AS full_name, fl.chamber AS filer_chamber, fl.party, fl.state, fl.committees, ` +
    `sr.company_name, sr.sector, sr.industry, sr.asset_class, sr.cik, sr.exchange_short ` +
    `FROM transactions t ` +
    `LEFT JOIN filings f ON f.doc_id = t.doc_id ` +
    `LEFT JOIN filers fl ON fl.bioguide_id = t.filer_id ` +
    `LEFT JOIN securities_ref sr ON sr.ticker = t.ticker ` +
    `WHERE ${where.join(' AND ')} ` +
    `ORDER BY ${ASOF_SQL} ASC, t.ticker ASC, t.id ASC LIMIT ${txLimit}`;
  return all<TxRow>(env.DB, sql, params);
}

async function priceSeries(env: Env, ticker: string): Promise<PriceBar[]> {
  return all<PriceBar>(env.DB, 'SELECT date, close FROM price_eod WHERE ticker = ? ORDER BY date ASC', [ticker]);
}

async function spxSeries(env: Env): Promise<PriceBar[]> {
  return all<PriceBar>(env.DB, 'SELECT date, close FROM spx_eod ORDER BY date ASC');
}

function idxOnOrBefore(series: PriceBar[], date: string): number {
  let lo = 0;
  let hi = series.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid].date <= date) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

function idxOnOrAfter(series: PriceBar[], date: string): number {
  let lo = 0;
  let hi = series.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid].date >= date) {
      ans = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return ans;
}

export interface PitSkillTrainingRow {
  id: string;
  filerId: string;
  ticker: string;
  disclosureAvailableAt: string;
  filingEntryDate?: string | null;
  txDate?: string | null;
  side?: TxType;
}

interface SkillObservation {
  id: string;
  basis: SkillBasis;
  side: SkillSide;
  horizonKey: string;
  horizonDays: number;
  horizonWeight: number;
  alpha: number;
  exitDate: string;
}

interface SkillSegmentStats {
  alpha: number | null;
  rawAlpha: number | null;
  scoredCount: number;
  wins: number;
  winRate: number | null;
  dispersionStddev: number | null;
  winsorLower: number | null;
  winsorUpper: number | null;
  skillScoredThrough: string | null;
  sourceRecordIds: string[];
}

const SKILL_BASES: SkillBasis[] = ['filing', 'trade'];
const SKILL_SIDES: SkillSide[] = ['buy', 'sell'];

function horizonWeightsRecord(): Record<string, number> {
  return Object.fromEntries(MEMBER_SKILL_HORIZONS.map((h) => [h.key, h.weight]));
}

function isBuySide(txType: string | null | undefined): boolean {
  const c = String(txType ?? '').toUpperCase();
  return c === 'B' || c === 'P';
}

function sideFromTxType(txType: TxType | undefined): SkillSide | null {
  if (isBuySide(txType)) return 'buy';
  if (txType === 'S') return 'sell';
  return null;
}

function quantile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const frac = idx - lo;
  return sorted[lo] + (sorted[hi] - sorted[lo]) * frac;
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

function stddev(values: number[]): number | null {
  if (values.length < 2) return null;
  const m = mean(values);
  if (m == null) return null;
  const variance = values.reduce((s, v) => s + Math.pow(v - m, 2), 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function winsorized(values: number[]): { values: number[]; lower: number | null; upper: number | null } {
  if (values.length < 20) return { values, lower: null, upper: null };
  const sorted = [...values].sort((a, b) => a - b);
  const lower = quantile(sorted, 0.05);
  const upper = quantile(sorted, 0.95);
  if (lower == null || upper == null) return { values, lower: null, upper: null };
  return { values: values.map((v) => Math.max(lower, Math.min(upper, v))), lower, upper };
}

function summarizeSkillObservations(observations: SkillObservation[]): SkillSegmentStats {
  const values = observations.map((o) => o.alpha).filter((v) => Number.isFinite(v));
  const rawAlpha = mean(values);
  const clipped = winsorized(values);
  const alpha = mean(clipped.values);
  const wins = clipped.values.filter((v) => v > 0).length;
  const sourceRecordIds = Array.from(new Set(observations.map((o) => o.id))).sort();
  const scoredThrough = observations.reduce<string | null>(
    (max, o) => (!max || o.exitDate > max ? o.exitDate : max),
    null,
  );
  return {
    alpha: alpha == null ? null : round(alpha, 6),
    rawAlpha: rawAlpha == null ? null : round(rawAlpha, 6),
    scoredCount: sourceRecordIds.length,
    wins,
    winRate: clipped.values.length ? round(wins / clipped.values.length, 4) : null,
    dispersionStddev: values.length >= 2 ? round(stddev(values) as number, 6) : null,
    winsorLower: clipped.lower == null ? null : round(clipped.lower, 6),
    winsorUpper: clipped.upper == null ? null : round(clipped.upper, 6),
    skillScoredThrough: scoredThrough,
    sourceRecordIds,
  };
}

function aggregateAlpha(observations: SkillObservation[], basis?: SkillBasis, side?: SkillSide): number | null {
  const filtered = observations.filter((o) => (!basis || o.basis === basis) && (!side || o.side === side));
  let total = 0;
  let weight = 0;
  for (const o of filtered) {
    total += o.alpha * o.horizonWeight;
    weight += o.horizonWeight;
  }
  return weight > 0 ? round(total / weight, 6) : null;
}

function skillScoreFromAlpha(alpha: number | null, observations: SkillObservation[]): number | null {
  if (alpha == null) return null;
  const values = observations.map((o) => o.alpha);
  const wins = values.filter((v) => v > 0).length;
  const prior = { alpha: 2.5, beta: 2.5 };
  const shrunkWinRate = values.length
    ? (wins + prior.alpha) / (values.length + prior.alpha + prior.beta)
    : 0.5;
  const alphaScore = Math.max(0, Math.min(100, 50 + (alpha / 0.2) * 50));
  return Math.round(0.6 * alphaScore + 0.4 * shrunkWinRate * 100);
}

function evaluateSkillObservation(
  row: PitSkillTrainingRow,
  basis: SkillBasis,
  side: SkillSide,
  horizon: (typeof MEMBER_SKILL_HORIZONS)[number],
  pricesByTicker: Map<string, PriceBar[]>,
  spx: PriceBar[],
  asOfDate: string,
): SkillObservation | null {
  const entryDate = basis === 'filing' ? dateOnly(row.filingEntryDate) ?? dateOnly(row.disclosureAvailableAt) : dateOnly(row.txDate);
  if (!entryDate) return null;
  const targetDate = addDays(entryDate, horizon.days);
  if (targetDate > asOfDate) return null;
  const px = pricesByTicker.get(row.ticker) ?? [];
  const entryIdx = idxOnOrBefore(px, entryDate);
  const exitIdx = idxOnOrAfter(px, targetDate);
  const spxEntryIdx = idxOnOrBefore(spx, entryDate);
  const spxExitIdx = idxOnOrAfter(spx, targetDate);
  if (entryIdx < 0 || exitIdx < 0 || spxEntryIdx < 0 || spxExitIdx < 0) return null;
  const exitDate = px[exitIdx].date;
  if (exitDate > asOfDate || spx[spxExitIdx].date > asOfDate) return null;
  const assetReturn = pctChange(px[entryIdx].close, px[exitIdx].close);
  const spxReturn = pctChange(spx[spxEntryIdx].close, spx[spxExitIdx].close);
  if (assetReturn == null || spxReturn == null) return null;
  const rawExcess = assetReturn - spxReturn;
  return {
    id: row.id,
    basis,
    side,
    horizonKey: horizon.key,
    horizonDays: horizon.days,
    horizonWeight: horizon.weight,
    alpha: side === 'sell' ? -rawExcess : rawExcess,
    exitDate,
  };
}

export function computePitMemberSkillFromRows(
  rows: PitSkillTrainingRow[],
  pricesByTicker: Map<string, PriceBar[]>,
  spx: PriceBar[],
  asOfDate: string,
  activityFallbackScore: number,
): MemberSkillSummary {
  const observations: SkillObservation[] = [];
  for (const row of rows) {
    const side = sideFromTxType(row.side);
    if (!side) continue;
    for (const basis of SKILL_BASES) {
      for (const horizon of MEMBER_SKILL_HORIZONS) {
        const observation = evaluateSkillObservation(row, basis, side, horizon, pricesByTicker, spx, asOfDate);
        if (observation) observations.push(observation);
      }
    }
  }
  const prior = { alpha: 2.5, beta: 2.5 };
  const uniqueSourceRecordIds = Array.from(new Set(observations.map((o) => o.id))).sort();
  const filingObservations = observations.filter((o) => o.basis === 'filing');
  const filingAlpha = aggregateAlpha(observations, 'filing');
  const tradeAlpha = aggregateAlpha(observations, 'trade');
  const decayRatio = filingAlpha != null && tradeAlpha != null && Math.abs(tradeAlpha) > 0.000001
    ? round(filingAlpha / tradeAlpha, 4)
    : null;
  const filingStats = summarizeSkillObservations(filingObservations);
  const allStats = summarizeSkillObservations(observations);
  const skillScore = skillScoreFromAlpha(filingAlpha, filingObservations);

  const byBasis = Object.fromEntries(
    SKILL_BASES.map((basis) => {
      const basisObs = observations.filter((o) => o.basis === basis);
      return [
        basis,
        {
          ...summarizeSkillObservations(basisObs),
          alpha: aggregateAlpha(observations, basis),
          directions: Object.fromEntries(
            SKILL_SIDES.map((side) => [side, summarizeSkillObservations(basisObs.filter((o) => o.side === side))]),
          ),
        },
      ];
    }),
  ) as unknown as Record<SkillBasis, Record<string, unknown>>;

  const byDirection = Object.fromEntries(
    SKILL_SIDES.map((side) => {
      const sideObs = observations.filter((o) => o.side === side);
      return [
        side,
        {
          ...summarizeSkillObservations(sideObs),
          filingAlpha: aggregateAlpha(observations, 'filing', side),
          tradeAlpha: aggregateAlpha(observations, 'trade', side),
          bases: Object.fromEntries(
            SKILL_BASES.map((basis) => [basis, summarizeSkillObservations(sideObs.filter((o) => o.basis === basis))]),
          ),
        },
      ];
    }),
  ) as unknown as Record<SkillSide, Record<string, unknown>>;

  const horizons = Object.fromEntries(
    MEMBER_SKILL_HORIZONS.map((h) => {
      const hObs = observations.filter((o) => o.horizonKey === h.key);
      return [
        h.key,
        {
          days: h.days,
          weight: h.weight,
          filingAlpha: aggregateAlpha(hObs, 'filing'),
          tradeAlpha: aggregateAlpha(hObs, 'trade'),
          byBasis: Object.fromEntries(SKILL_BASES.map((basis) => [basis, summarizeSkillObservations(hObs.filter((o) => o.basis === basis))])),
          byDirection: Object.fromEntries(SKILL_SIDES.map((side) => [side, summarizeSkillObservations(hObs.filter((o) => o.side === side))])),
        },
      ];
    }),
  ) as Record<string, Record<string, unknown>>;

  if (observations.length === 0) {
    return {
      skillScore: null,
      filingAlpha: null,
      tradeAlpha: null,
      decayRatio: null,
      skillAsOf: `${asOfDate}T00:00:00.000Z`,
      skillScoredThrough: null,
      trainingWindow: 'all_prior_matured_disclosures',
      trainingWindowDetails: {
        disclosureCutoff: `${asOfDate}T00:00:00.000Z`,
        includes: 'prior disclosed transactions only; filing-date basis uses conservative actionable date when availability is date-only',
        excludes: 'outcomes whose horizon close is after asOf',
        maxTrainingRowsPerObservation: 1000,
        selection: 'newest prior disclosed transactions first; older rows beyond the cap are truncated',
      },
      horizonDays: MEMBER_SKILL_HORIZON_DAYS,
      horizonWeights: horizonWeightsRecord(),
      scoredCount: 0,
      wins: 0,
      winRate: null,
      avgExcessReturn: null,
      shrinkagePrior: prior,
      dispersionWinsorization: {
        dispersion: 'sample_standard_deviation_of_direction_adjusted_excess_returns',
        winsorization: 'two_sided_5_95_percentile_per_basis_direction_horizon_when_n_at_least_20',
        minSamplesForWinsorization: 20,
      },
      byBasis,
      byDirection,
      horizons,
      fallback: 'activity_prominence',
      fallbackScore: Math.round(activityFallbackScore),
      sourceRecordIds: [],
    };
  }
  return {
    skillScore,
    filingAlpha,
    tradeAlpha,
    decayRatio,
    skillAsOf: `${asOfDate}T00:00:00.000Z`,
    skillScoredThrough: allStats.skillScoredThrough,
    trainingWindow: 'all_prior_matured_disclosures',
    trainingWindowDetails: {
      disclosureCutoff: `${asOfDate}T00:00:00.000Z`,
      includes: 'prior disclosed transactions only; filing-date basis uses conservative actionable date when availability is date-only',
      excludes: 'outcomes whose horizon close is after asOf',
      maxTrainingRowsPerObservation: 1000,
      selection: 'newest prior disclosed transactions first; older rows beyond the cap are truncated',
    },
    horizonDays: MEMBER_SKILL_HORIZON_DAYS,
    horizonWeights: horizonWeightsRecord(),
    scoredCount: uniqueSourceRecordIds.length,
    wins: filingStats.wins,
    winRate: filingStats.winRate,
    avgExcessReturn: filingAlpha,
    shrinkagePrior: prior,
    dispersionWinsorization: {
      dispersion: 'sample_standard_deviation_of_direction_adjusted_excess_returns',
      winsorization: 'two_sided_5_95_percentile_per_basis_direction_horizon_when_n_at_least_20',
      minSamplesForWinsorization: 20,
    },
    byBasis,
    byDirection,
    horizons,
    fallback: null,
    fallbackScore: null,
    sourceRecordIds: uniqueSourceRecordIds,
  };
}

async function memberSkillFor(
  env: Env,
  filerIds: string[],
  asOf: string,
  asOfDate: string,
  activityFallbackScore: number,
  priceCache: Map<string, Promise<PriceBar[]>>,
  spx: PriceBar[],
  q: PitScoreQuery,
): Promise<MemberSkillSummary> {
  const cleanIds = Array.from(new Set(filerIds.filter(Boolean))).slice(0, 80);
  if (cleanIds.length === 0) {
    return computePitMemberSkillFromRows([], new Map(), spx, asOfDate, activityFallbackScore);
  }
  const where = [
    't.deprecated_at IS NULL',
    "t.tx_type IN ('B', 'P', 'S')",
    't.is_option = 0',
    "t.ticker IS NOT NULL AND t.ticker <> ''",
    `COALESCE(f.first_seen_at, CASE WHEN f.filed_date IS NOT NULL THEN f.filed_date || 'T00:00:00.000Z' END, t.created_at) < ?`,
    `t.filer_id IN (${cleanIds.map(() => '?').join(', ')})`,
  ];
  const params: SqlParam[] = [asOf, ...cleanIds];
  if (q.source && q.source !== 'all') {
    where.push('t.source = ?');
    params.push(q.source);
  }
  if (typeof q.minConf === 'number') {
    where.push('t.confidence >= ?');
    params.push(q.minConf);
  }
  const rows = await all<{ id: string; filer_id: string; ticker: string; tx_date: string | null; tx_type: TxType; first_seen_at: string | null; filed_date: string | null; created_at: string | null; disclosure_available_at: string }>(
    env.DB,
    `SELECT t.id, t.filer_id, t.ticker, t.tx_date, t.tx_type, f.first_seen_at, f.filed_date, t.created_at, ` +
      `COALESCE(f.first_seen_at, CASE WHEN f.filed_date IS NOT NULL THEN f.filed_date || 'T00:00:00.000Z' END, t.created_at) AS disclosure_available_at ` +
      `FROM transactions t LEFT JOIN filings f ON f.doc_id = t.doc_id ` +
      `WHERE ${where.join(' AND ')} ORDER BY disclosure_available_at DESC, t.id DESC LIMIT 1000`,
    params,
  );
  const tickers = Array.from(new Set(rows.map((r) => r.ticker).filter(Boolean)));
  await Promise.all(tickers.map((t) => priceCache.get(t) ?? priceCache.set(t, priceSeries(env, t)).get(t)));
  const map = new Map<string, PriceBar[]>();
  for (const t of tickers) map.set(t, await priceCache.get(t)!);
  return computePitMemberSkillFromRows(
    rows.map((r) => ({
      id: r.id,
      filerId: r.filer_id,
      ticker: r.ticker,
      txDate: r.tx_date,
      side: r.tx_type,
      filingEntryDate: availabilityFor(r).conservativeLabelEntryDate,
      disclosureAvailableAt: r.disclosure_available_at,
    })),
    map,
    spx,
    asOfDate,
    activityFallbackScore,
  );
}

function buildLabels(
  ticker: string,
  scoreAsOfDate: string,
  labelEntryDate: string | null,
  availability: AvailabilityInfo,
  price: PriceBar[],
  spx: PriceBar[],
  computedAt: string,
): Record<string, unknown> {
  const entryIdx = labelEntryDate ? idxOnOrAfter(price, labelEntryDate) : -1;
  const spxEntryIdx = labelEntryDate ? idxOnOrAfter(spx, labelEntryDate) : -1;
  const entry = entryIdx >= 0 ? price[entryIdx] : null;
  const spxEntry = spxEntryIdx >= 0 ? spx[spxEntryIdx] : null;
  const horizons = LABEL_HORIZONS_DAYS.map((days) => {
    if (!entry || !spxEntry) {
      return { horizon: `${days}d`, days, assetReturn: null, spxReturn: null, excessReturn: null, missingLabelReason: 'missing_entry_price' };
    }
    const exitIdx = entryIdx + days;
    if (exitIdx >= price.length) {
      return { horizon: `${days}d`, days, assetReturn: null, spxReturn: null, excessReturn: null, missingLabelReason: 'insufficient_forward_history' };
    }
    const exit = price[exitIdx];
    const spxExitIdx = idxOnOrBefore(spx, exit.date);
    const spxExit = spxExitIdx >= 0 ? spx[spxExitIdx] : null;
    const assetReturn = pctChange(entry.close, exit.close);
    const spxReturn = spxExit ? pctChange(spxEntry.close, spxExit.close) : null;
    return {
      horizon: `${days}d`,
      days,
      entryDate: entry.date,
      exitDate: exit.date,
      entryPrice: entry.close,
      exitPrice: exit.close,
      spxEntry: spxEntry.close,
      spxExit: spxExit?.close ?? null,
      assetReturn: assetReturn == null ? null : round(assetReturn, 4),
      spxReturn: spxReturn == null ? null : round(spxReturn, 4),
      excessReturn: assetReturn != null && spxReturn != null ? round(assetReturn - spxReturn, 4) : null,
      missingLabelReason: assetReturn == null ? 'missing_asset_return' : spxReturn == null ? 'missing_spx_return' : null,
      sourceRecordIds: [`price_eod:${ticker}:${entry.date}`, `price_eod:${ticker}:${exit.date}`, `spx_eod:${spxEntry.date}`, spxExit ? `spx_eod:${spxExit.date}` : null].filter(Boolean),
    };
  });
  return {
    basis: 'adjusted_close_from_price_eod',
    horizonBasis: 'trading_days',
    scoreAsOfDate,
    conservativeLabelEntryDate: labelEntryDate,
    entryRule:
      availability.precision === 'date'
        ? 'first_close_on_or_after_next_calendar_day_because_availability_is_date_only'
        : 'first_close_on_or_after_market_available_date',
    availabilitySource: availability.source,
    availabilityPrecision: availability.precision,
    priceDataThrough: price.length ? price[price.length - 1].date : null,
    benchmarkDataThrough: spx.length ? spx[spx.length - 1].date : null,
    totalReturnBasis: false,
    labelComputedAt: computedAt,
    corporateActionVintage: null,
    missingCorporateActionVintageReason: 'no_corporate_action_vintage_table',
    horizons,
  };
}

function component(name: Component['name'], value: number | null, weight: number, basis: Basis, fallback: string | null, ids: string[]): Component {
  return { name, value: value == null ? null : Math.round(value), weight, basis, fallback, sourceRecordIds: ids };
}

function disclosureAvailableAt(row: Pick<TxRow, 'first_seen_at' | 'filed_date' | 'created_at'>): string | null {
  return isoTimestamp(row.first_seen_at) ?? isoTimestamp(row.filed_date) ?? isoTimestamp(row.created_at);
}

function afterCursor(cursor: PitScoreCursor | undefined, asOf: string, ticker: string): boolean {
  if (!cursor) return true;
  if (asOf > cursor.asOf) return true;
  if (asOf < cursor.asOf) return false;
  return ticker > cursor.ticker;
}

function inOutputRange(q: PitScoreQuery, asOf: string, ticker: string): boolean {
  const d = dateOnly(asOf);
  if (!d) return false;
  if (q.from && d < q.from) return false;
  if (q.to && d > q.to) return false;
  return afterCursor(q.cursor, asOf, ticker);
}

function countBy(values: Array<string | null | undefined>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) {
    if (!v) continue;
    out[v] = (out[v] ?? 0) + 1;
  }
  return out;
}

function buildPitValidity(txs: TxRow[]): Record<string, unknown> {
  const availabilityInfos = txs.map((tx) => availabilityFor(tx));
  const availabilitySources = countBy(availabilityInfos.map((a) => a.source));
  const availabilityPrecisions = countBy(availabilityInfos.map((a) => a.precision));
  const disclosureSources = countBy(txs.map((tx) => tx.source));
  const allObservedTimestamp = availabilityInfos.every((a) => a.source === 'first_seen_at' && a.precision === 'timestamp');
  const allPrimary = txs.every((tx) => tx.source === 'primary');
  const reasonCodes: string[] = [];
  if (!allObservedTimestamp) reasonCodes.push('missing_true_market_observed_disclosure_timestamp');
  if (!allPrimary) reasonCodes.push('non_primary_or_historical_seed_source');
  reasonCodes.push('missing_pit_security_reference_vintage');
  reasonCodes.push('missing_pit_filer_committee_party_vintage');
  reasonCodes.push('missing_corporate_action_vintage');
  reasonCodes.push('missing_no_signal_decision_universe');
  const scoreInputsPitSafe = allObservedTimestamp && allPrimary;
  const metadataPitComplete = false;
  return {
    historicalValidationReady: scoreInputsPitSafe && metadataPitComplete,
    scoreInputsPitSafe,
    metadataPitComplete,
    recommendedUse: scoreInputsPitSafe ? 'score_input_validation_only_pending_metadata_vintages' : 'research_contract_or_live_forward_collection_only',
    reasonCodes,
    availabilitySources,
    availabilityPrecisions,
    disclosureSources,
    note:
      'A row is true score-input PIT only when the disclosure was observed by Congress.Trade with a timestamped first_seen_at and came from primary live ingestion. Context metadata remains current-state until vintage tables exist.',
  };
}

function summarizeValidationReadiness(rows: PitScoreRow[]): Record<string, unknown> {
  let scoreInputsPitSafeRows = 0;
  let historicalValidationReadyRows = 0;
  const reasonCounts: Record<string, number> = {};
  for (const row of rows) {
    const validity = row.pitValidity as { scoreInputsPitSafe?: boolean; historicalValidationReady?: boolean; reasonCodes?: string[] };
    if (validity.scoreInputsPitSafe) scoreInputsPitSafeRows += 1;
    if (validity.historicalValidationReady) historicalValidationReadyRows += 1;
    for (const reason of validity.reasonCodes ?? []) reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
  }
  return {
    historicalValidationReady: rows.length > 0 && historicalValidationReadyRows === rows.length,
    scoreInputsPitSafeRows,
    historicalValidationReadyRows,
    researchOnlyRows: rows.length - historicalValidationReadyRows,
    rowCount: rows.length,
    reasonCounts,
    blocker:
      rows.length === 0
        ? null
        : historicalValidationReadyRows === rows.length
          ? null
          : 'True historical validation requires timestamped primary first_seen_at disclosures plus PIT metadata vintages / no-signal universe coverage.',
  };
}

function weightedClusterContribution(row: TxRow): number {
  const conf = Math.max(0.1, Math.min(1, finiteOrNull(row.confidence) ?? 0.75));
  const amountWeight = Math.min(1, Math.log10(1 + midpoint(row)) / 6);
  return conf * (0.5 + 0.5 * amountWeight);
}

function buildClusterWindow(ticker: string, asOf: string, allRows: TxRow[], days: number): Record<string, unknown> {
  const endDate = dateOnly(asOf) ?? '9999-12-31';
  const startDate = addDays(endDate, -(days - 1));
  const rows = allRows.filter((row) => {
    if (row.ticker.toUpperCase() !== ticker) return false;
    const available = disclosureAvailableAt(row);
    const d = dateOnly(available);
    return !!available && !!d && available <= asOf && d >= startDate && d <= endDate;
  });
  const buyMemberIds = new Set(rows.filter((r) => isBuySide(r.tx_type) && r.filer_id).map((r) => r.filer_id as string));
  const sellMemberIds = new Set(rows.filter((r) => r.tx_type === 'S' && r.filer_id).map((r) => r.filer_id as string));
  const allMemberIds = new Set(rows.filter((r) => r.filer_id).map((r) => r.filer_id as string));
  const memberSideWeights = new Map<string, number>();
  for (const row of rows) {
    const side = isBuySide(row.tx_type) ? 'buy' : row.tx_type === 'S' ? 'sell' : null;
    const member = row.filer_id ?? row.id;
    if (!side) continue;
    const key = `${side}:${member}`;
    memberSideWeights.set(key, Math.min(1, (memberSideWeights.get(key) ?? 0) + weightedClusterContribution(row)));
  }
  let buyWeighted = 0;
  let sellWeighted = 0;
  for (const [key, value] of memberSideWeights) {
    if (key.startsWith('buy:')) buyWeighted += value;
    if (key.startsWith('sell:')) sellWeighted += value;
  }
  const dominantDistinct = Math.max(buyMemberIds.size, sellMemberIds.size);
  const totalWeighted = buyWeighted + sellWeighted;
  const agreementRatio = allMemberIds.size ? dominantDistinct / allMemberIds.size : null;
  const breadth = Math.log(1 + dominantDistinct) / Math.log(1 + 12);
  const qualityWeightedClusterScore = totalWeighted > 0
    ? Math.round(100 * (Math.max(buyWeighted, sellWeighted) / totalWeighted) * breadth)
    : null;
  return {
    days,
    startDate,
    endDate,
    tradeCount: rows.length,
    directionalDistinctMemberCounts: {
      buy: buyMemberIds.size,
      sell: sellMemberIds.size,
      net: buyMemberIds.size - sellMemberIds.size,
    },
    qualityWeightedClusterScore,
    agreementRatio: agreementRatio == null ? null : round(agreementRatio, 4),
    weightedDirectionTotals: {
      buy: round(buyWeighted, 4),
      sell: round(sellWeighted, 4),
    },
    partyBreadth: {
      basis: 'current_state_metadata_context_only',
      distinct: Object.keys(countBy(rows.map((r) => r.party))).length,
      counts: countBy(rows.map((r) => r.party)),
    },
    chamberBreadth: {
      basis: 'current_state_metadata_context_only',
      distinct: Object.keys(countBy(rows.map((r) => r.filer_chamber ?? r.filing_chamber))).length,
      counts: countBy(rows.map((r) => r.filer_chamber ?? r.filing_chamber)),
    },
  };
}

function buildClusterConsensus(ticker: string, asOf: string, currentRows: TxRow[], allRows: TxRow[], memberSkill: MemberSkillSummary): Record<string, unknown> {
  const buyCount = currentRows.filter((t) => isBuySide(t.tx_type)).length;
  const sellCount = currentRows.filter((t) => t.tx_type === 'S').length;
  const buyMembers = new Set(currentRows.filter((t) => isBuySide(t.tx_type) && t.filer_id).map((t) => t.filer_id as string));
  const sellMembers = new Set(currentRows.filter((t) => t.tx_type === 'S' && t.filer_id).map((t) => t.filer_id as string));
  const allMembers = new Set(currentRows.filter((t) => t.filer_id).map((t) => t.filer_id as string));
  const direction = directionFrom(buyCount, sellCount, currentRows.reduce((s, t) => s + (isBuySide(t.tx_type) ? midpoint(t) : t.tx_type === 'S' ? -midpoint(t) : 0), 0));
  const sameSideMembers = direction === 'SELL' ? sellMembers.size : direction === 'BUY' ? buyMembers.size : allMembers.size;
  const netFlowUsd = currentRows.reduce((s, t) => s + (isBuySide(t.tx_type) ? midpoint(t) : t.tx_type === 'S' ? -midpoint(t) : 0), 0);
  const windows = Object.fromEntries(
    CLUSTER_WINDOWS.map((w) => [w.key, { label: w.label, ...buildClusterWindow(ticker, asOf, allRows, w.days) }]),
  );
  return {
    directionalTradeCount: buyCount + sellCount,
    directionalMemberCount: allMembers.size,
    clusterMemberCount: sameSideMembers,
    buyCount,
    sellCount,
    netFlowUsd: Math.round(netFlowUsd),
    netSentiment: netSentiment(buyCount, sellCount),
    confidence: Math.min(1, round((currentRows.reduce((s, t) => s + num(t.confidence), 0) / Math.max(1, currentRows.length)) * Math.min(1, allMembers.size / 3), 4)),
    windows,
    perMemberCapsAndDiminishingReturns: {
      maxContributionPerMemberPerDirectionPerWindow: 1,
      amountWeight: '0.5 + 0.5 * min(1, log10(1 + STOCK Act bracket midpoint) / 6)',
      diminishingReturn: 'quality score multiplies dominant side weight share by log1p(dominant distinct members) / log1p(12)',
    },
    coverageQuality: {
      transactionConfidenceMean: round(currentRows.reduce((s, t) => s + num(t.confidence), 0) / Math.max(1, currentRows.length), 4),
      memberSkillScoredCount: memberSkill.scoredCount,
      windowContextDaysLoaded: Math.max(...CLUSTER_WINDOWS.map((w) => w.days)),
    },
  };
}

async function buildRow(
  env: Env,
  ticker: string,
  asOf: string,
  txs: TxRow[],
  allTxRows: TxRow[],
  computedAt: string,
  q: PitScoreQuery,
  priceCache: Map<string, Promise<PriceBar[]>>,
  spx: PriceBar[],
): Promise<PitScoreRow> {
  const asOfDate = dateOnly(asOf) ?? computedAt.slice(0, 10);
  const ids = txs.map((t) => t.id);
  const buyCount = txs.filter((t) => isBuySide(t.tx_type)).length;
  const sellCount = txs.filter((t) => t.tx_type === 'S').length;
  const buyMembers = new Set(txs.filter((t) => isBuySide(t.tx_type) && t.filer_id).map((t) => t.filer_id as string));
  const sellMembers = new Set(txs.filter((t) => t.tx_type === 'S' && t.filer_id).map((t) => t.filer_id as string));
  const allMembers = new Set(txs.filter((t) => t.filer_id).map((t) => t.filer_id as string));
  const estVolumeUsd = txs.reduce((s, t) => s + midpoint(t), 0);
  const netFlowUsd = txs.reduce((s, t) => s + (isBuySide(t.tx_type) ? midpoint(t) : t.tx_type === 'S' ? -midpoint(t) : 0), 0);
  const direction = directionFrom(buyCount, sellCount, netFlowUsd);
  const directionSign = direction === 'SELL' ? -1 : direction === 'BUY' ? 1 : 0;
  const sameSideMembers = direction === 'SELL' ? sellMembers.size : direction === 'BUY' ? buyMembers.size : allMembers.size;
  const avgLagDays = txs
    .map((t) => daysBetween(dateOnly(t.tx_date), dateOnly(isoTimestamp(t.first_seen_at) ?? t.filed_date ?? t.created_at)))
    .filter((n): n is number => n != null && Number.isFinite(n))
    .reduce((a, b, _, arr) => a + b / arr.length, 0);
  const availability = availabilityFor(txs[0]);
  const freshness = Math.max(0, Math.min(100, 100 - (Number.isFinite(avgLagDays) ? avgLagDays : 45) * (100 / 90)));
  const consensus = Math.min(100, (Math.log(1 + sameSideMembers) / Math.log(1 + 12)) * 100);
  const supportingFlow = Math.max(0, directionSign * netFlowUsd);
  const flow = Math.min(100, supportingFlow / 50_000);
  const committees = txs.flatMap((t) => parseJson<string[]>(t.committees, []));
  const sector = txs.find((t) => t.sector)?.sector ?? null;
  const overlap = committeeConflict(committees, sector);
  const committeeScore = overlap.conflict ? 100 : 0;
  const activityFallbackScore = Math.min(100, Math.log(1 + allMembers.size + txs.length) / Math.log(1 + 20) * 100);
  const memberSkill = await memberSkillFor(env, [...allMembers], asOf, asOfDate, activityFallbackScore, priceCache, spx, q);
  const memberSkillValue = memberSkill.skillScore ?? memberSkill.fallbackScore;
  const components = [
    component('consensus', consensus, PIT_SCORE_WEIGHTS.consensus, 'computed', null, ids),
    component('flow', flow, PIT_SCORE_WEIGHTS.flow, 'computed', null, ids),
    component('freshness', freshness, PIT_SCORE_WEIGHTS.freshness, 'computed', null, ids),
    component(
      'member_skill',
      memberSkillValue,
      PIT_SCORE_WEIGHTS.member_skill,
      memberSkill.skillScore == null ? 'inferred' : 'computed',
      memberSkill.fallback,
      memberSkill.sourceRecordIds.length ? memberSkill.sourceRecordIds : ids,
    ),
    component(
      'committee_sector_overlap',
      committeeScore,
      PIT_SCORE_WEIGHTS.committee_sector_overlap,
      sector ? 'sourced' : 'missing',
      sector ? 'current_state_context_only_not_pit_scored' : 'missing_sector_or_committees',
      ids,
    ),
  ];
  const scored = scoreComponents(components);
  const score = scored.score;
  const signedScore = score == null ? null : direction === 'SELL' ? -score : direction === 'BUY' ? score : 0;
  const price = await (priceCache.get(ticker) ?? priceCache.set(ticker, priceSeries(env, ticker)).get(ticker)!);
  const ref = txs.find((t) => t.company_name || t.cik || t.asset_class || t.sector) ?? txs[0];
  const disclosureAssetType = canonicalizeAssetType(ref?.asset_type ?? null, ref?.asset_type_name ?? null, {
    isOption: txs.some((t) => t.is_option === 1),
    assetName: ref?.asset_name ?? null,
  });
  const canonicalAssetType = disclosureAssetType.category === 'unknown' && ref?.asset_class
    ? canonicalizeAssetType(ref.asset_class, ref?.asset_type_name ?? null, {
        isOption: txs.some((t) => t.is_option === 1),
        assetName: ref?.asset_name ?? null,
      })
    : disclosureAssetType;
  const includedDisclosures = txs.map((t) => {
    const disclosureAssetType = canonicalizeAssetType(t.asset_type, t.asset_type_name, {
      isOption: t.is_option === 1,
      assetName: t.asset_name,
    });
    return {
      availabilitySource: availabilityFor(t).source,
      availabilityPrecision: availabilityFor(t).precision,
      disclosureId: t.id,
      docId: t.doc_id,
      sourceUrl: t.source_url,
      hashedFilerId: stableFilerHash(t.filer_id),
      txDate: t.tx_date,
      disclosedAt: isoTimestamp(t.first_seen_at) ?? isoTimestamp(t.filed_date) ?? t.created_at,
      filedAt: t.filed_date,
      side: t.tx_type,
      owner: t.owner,
      amountLow: finiteOrNull(t.amount_min),
      amountHigh: finiteOrNull(t.amount_max),
      amountEstimate: Math.round(midpoint(t)),
      chamber: t.filer_chamber ?? t.filing_chamber,
      assetType: t.asset_type,
      assetTypeName: t.asset_type_name,
      assetTypeCategory: disclosureAssetType.category,
      assetTypeCategoryLabel: disclosureAssetType.categoryLabel,
      amendmentFlag: false,
      cancelFlag: false,
    };
  });
  const aliasesFrom = Object.entries(TICKER_RENAMES).filter(([, to]) => to === ticker).map(([from]) => from);
  // If THIS ticker is itself a curated alias source, classify it. Rename sources are normally
  // folded to their current ticker upstream (resolveContinuousTicker at ingest), so the case that
  // actually reaches here is an ACQUISITION source (e.g. ATVI) — deliberately NOT folded, so its
  // delisted series stays distinct. Record that delisting explicitly instead of dropping it.
  const aliasClassification = classifyTickerAlias(ticker);
  const isAcquisitionSource = aliasClassification?.class === 'acquisition';
  const clusterConsensus = buildClusterConsensus(ticker, asOf, txs, allTxRows, memberSkill);
  const pitValidity = buildPitValidity(txs);
  return {
    observationId: stableObservationId(PIT_SCORE_VERSION, ticker, asOf, ids, 'none'),
    ticker,
    stableSecurityId: `ticker:${ticker}`,
    cusip: null,
    cik: ref?.cik ?? null,
    assetType: ref?.asset_class ?? ref?.asset_type ?? null,
    assetTypeName: ref?.asset_type_name ?? null,
    assetTypeCategory: canonicalAssetType.category,
    assetTypeCategoryLabel: canonicalAssetType.categoryLabel,
    assetTypeCategorySource: canonicalAssetType.source,
    tickerMapVersion: TICKER_MAP_VERSION,
    delistingTickerChangeMetadata: {
      knownPriorTickers: aliasesFrom,
      mappedToCurrentTicker: TICKER_RENAMES[ticker] ?? null,
      aliasClass: aliasClassification?.class ?? null,
      delisted: isAcquisitionSource,
      acquiredBy: isAcquisitionSource ? aliasClassification!.to : null,
      reason:
        aliasesFrom.length || TICKER_RENAMES[ticker] || isAcquisitionSource
          ? 'curated_alias_map'
          : null,
    },
    asOf,
    disclosureAvailableAt: asOf,
    computedAt,
    dataCutoffAt: asOf,
    scoreVersion: PIT_SCORE_VERSION,
    parameterManifest: parameterManifest(),
    direction,
    congressScore: score,
    signedScore,
    components,
    rawInputs: {
      buyCount,
      sellCount,
      directionalTradeCount: buyCount + sellCount,
      directionalMemberCount: allMembers.size,
      buyMemberCount: buyMembers.size,
      sellMemberCount: sellMembers.size,
      estVolumeUsd: Math.round(estVolumeUsd),
      netFlowUsd: Math.round(netFlowUsd),
      netSentiment: netSentiment(buyCount, sellCount),
      avgDisclosureLagDays: Number.isFinite(avgLagDays) ? round(avgLagDays, 2) : null,
      availabilitySource: availability.source,
      availabilityPrecision: availability.precision,
      conservativeLabelEntryDate: availability.conservativeLabelEntryDate,
      sourceRecordIds: ids,
    },
    provenance: {
      scoreInputsCutoffAt: asOf,
      scoreInputBasis: 'disclosures_available_at_or_before_asOf; current-state ref metadata is marked context-only',
      amountBasis: 'STOCK Act bracket midpoint; open top tier uses floor',
      currentStateMetadata: ['filers.party', 'filers.chamber', 'filers.committees', 'securities_ref.sector', 'securities_ref.cik'],
      sources: ['transactions', 'filings', 'filers', 'securities_ref', 'price_eod', 'spx_eod'],
    },
    pitValidity,
    includedDisclosures,
    memberSkill,
    clusterConsensus: {
      ...clusterConsensus,
      coverageQuality: {
        ...(clusterConsensus.coverageQuality as Record<string, unknown>),
        hasSector: !!sector,
      },
    },
    committeeSectorOverlap: {
      committee: overlap.viaCommittees[0] ?? null,
      viaCommittees: overlap.viaCommittees,
      sector,
      mappingVersion: COMMITTEE_SECTOR_MAPPING_VERSION,
      confidence: sector && committees.length ? 0.75 : 0,
      legalConclusion: false,
      scoringWeight: PIT_SCORE_WEIGHTS.committee_sector_overlap,
      basis: 'current_state_metadata_context_only',
      note: 'Sector overlap is an analytical feature only; it is not a misconduct or conflict finding.',
    },
    labels: buildLabels(ticker, asOfDate, availability.conservativeLabelEntryDate, availability, price, spx, computedAt),
    baselines: {
      noSignalUniverseRow: false,
      noSignalUniverseReason: 'No App B decision-universe input was supplied to this export.',
      appBPreCongressScanScore: null,
      appBPreCongressScanFactors: null,
    },
    placebo: { type: 'none', applied: false },
  };
}

function rowDate(row: PitScoreRow): string {
  return dateOnly(row.asOf) ?? '0000-00-00';
}

function recomputeWithDisabled(row: PitScoreRow, disabled: Set<Component['name']>, type: PitPlacebo): PitScoreRow {
  const components = row.components.map((c) =>
    disabled.has(c.name) ? { ...c, weight: 0, fallback: c.fallback ?? 'component_ablation' } : c,
  );
  const scored = scoreComponents(components);
  const congressScore = scored.score;
  const signedScore = congressScore == null ? null : row.direction === 'SELL' ? -congressScore : row.direction === 'BUY' ? congressScore : 0;
  return {
    ...row,
    observationId: stableObservationId(row.scoreVersion, row.ticker, row.asOf, row.includedDisclosures.map((d) => String(d.disclosureId)), type),
    congressScore,
    signedScore,
    components,
    placebo: { type, applied: true },
  };
}

function applyPlacebo(rows: PitScoreRow[], type: PitPlacebo): PitScoreRow[] {
  if (type === 'none') return rows;
  if (type === 'split_dividend_event_stress_subset') {
    return [];
  }
  if (type === 'no_member_skill') return rows.map((r) => recomputeWithDisabled(r, new Set(['member_skill']), type));
  if (type === 'no_freshness') return rows.map((r) => recomputeWithDisabled(r, new Set(['freshness']), type));
  if (type === 'no_flow') return rows.map((r) => recomputeWithDisabled(r, new Set(['flow']), type));
  if (type === 'activity_only_proxy') {
    return rows.map((r) => ({
      ...recomputeWithDisabled(r, new Set(['flow', 'freshness', 'member_skill', 'committee_sector_overlap']), type),
      placebo: { type, applied: true, basis: 'consensus/activity proxy only' },
    }));
  }
  if (type === 'buy_sell_flip') {
    return rows.map((r) => {
      const direction = r.direction === 'BUY' ? 'SELL' : r.direction === 'SELL' ? 'BUY' : r.direction;
      const signedScore = r.congressScore == null ? null : direction === 'SELL' ? -r.congressScore : direction === 'BUY' ? r.congressScore : 0;
      return {
        ...r,
        observationId: stableObservationId(r.scoreVersion, r.ticker, r.asOf, r.includedDisclosures.map((d) => String(d.disclosureId)), type),
        direction,
        signedScore,
        placebo: { type, applied: true, preserves: ['date', 'ticker', 'amount'], flips: ['side', 'direction'] },
      };
    });
  }
  if (type === 'disclosure_date_jitter') {
    return rows.map((r) => {
      const jitter = (parseInt(hashString(r.observationId).slice(0, 2), 16) % 7) - 3;
      const jitteredDate = addDays(rowDate(r), jitter);
      const asOf = `${jitteredDate}T00:00:00.000Z`;
      return {
        ...r,
        observationId: stableObservationId(r.scoreVersion, r.ticker, asOf, r.includedDisclosures.map((d) => String(d.disclosureId)), type),
        asOf,
        disclosureAvailableAt: asOf,
        dataCutoffAt: asOf,
        placebo: { type, applied: true, jitterDays: jitter },
      };
    });
  }
  if (type === 'future_shift_leakage_detector') {
    return rows.map((r) => {
      const shifted = `${addDays(rowDate(r), 252)}T00:00:00.000Z`;
      return {
        ...r,
        observationId: stableObservationId(r.scoreVersion, r.ticker, shifted, r.includedDisclosures.map((d) => String(d.disclosureId)), type),
        asOf: shifted,
        disclosureAvailableAt: shifted,
        dataCutoffAt: shifted,
        placebo: { type, applied: true, futureShiftDays: 252, expectedUse: 'leakage detector only; not a tradable signal' },
      };
    });
  }
  if (type === 'member_shuffle') {
    const hashes = rows.flatMap((r) => r.includedDisclosures.map((d) => String(d.hashedFilerId ?? ''))).filter(Boolean).sort();
    return rows.map((r) => {
      const includedDisclosures = r.includedDisclosures.map((d, i) => ({
        ...d,
        hashedFilerId: hashes.length ? hashes[(i + parseInt(hashString(r.observationId).slice(0, 2), 16)) % hashes.length] : d.hashedFilerId,
      }));
      return {
        ...recomputeWithDisabled(r, new Set(['member_skill']), type),
        includedDisclosures,
        memberSkill: { ...r.memberSkill, skillScore: null, fallback: 'activity_prominence', sourceRecordIds: [] },
        placebo: { type, applied: true, preserves: ['date', 'ticker', 'side', 'amount'], shuffles: ['filer'] },
      };
    });
  }
  if (type === 'within_date_score_permutation') {
    const byDate = new Map<string, PitScoreRow[]>();
    for (const r of rows) (byDate.get(rowDate(r)) ?? byDate.set(rowDate(r), []).get(rowDate(r))!).push(r);
    const out: PitScoreRow[] = [];
    for (const [date, group] of byDate) {
      const shift = group.length ? parseInt(hashString(date), 16) % group.length : 0;
      const scores = group.map((g) => ({ congressScore: g.congressScore, signedScore: g.signedScore, direction: g.direction }));
      group.forEach((r, i) => {
        const s = scores[(i + shift) % scores.length];
        out.push({
          ...r,
          observationId: stableObservationId(r.scoreVersion, r.ticker, r.asOf, r.includedDisclosures.map((d) => String(d.disclosureId)), type),
          congressScore: s.congressScore,
          signedScore: s.signedScore,
          direction: s.direction,
          placebo: { type, applied: true, withinDate: date, permutationShift: shift },
        });
      });
    }
    return out.sort((a, b) => (a.asOf === b.asOf ? a.ticker.localeCompare(b.ticker) : a.asOf.localeCompare(b.asOf)));
  }
  return rows;
}

export async function buildPitScoreExport(env: Env, q: PitScoreQuery, now = new Date()): Promise<PitScoreExportResult> {
  const generatedAt = now.toISOString();
  const txRows = await loadTransactions(env, q);
  const sourceRowsMayBeTruncated = txRows.length >= transactionQueryLimit(q);
  const normalizedRows = txRows.map((row) => ({ ...row, ticker: row.ticker.toUpperCase() }));
  const groups = new Map<string, TxRow[]>();
  for (const row of normalizedRows) {
    const ticker = row.ticker;
    const asOf = disclosureAvailableAt(row);
    if (!asOf) continue;
    if (!inOutputRange(q, asOf, ticker)) continue;
    const key = `${ticker}|${asOf}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push({ ...row, ticker });
  }
  const priceCache = new Map<string, Promise<PriceBar[]>>();
  const spx = await spxSeries(env);
  const baseRows: PitScoreRow[] = [];
  const sortedGroups = Array.from(groups.entries()).sort(([a], [b]) => {
    const [ta, aa] = a.split('|');
    const [tb, ab] = b.split('|');
    return aa === ab ? ta.localeCompare(tb) : aa.localeCompare(ab);
  });
  const pageGroups = sortedGroups.slice(0, q.limit);
  const nextCursor = (sortedGroups.length > q.limit || sourceRowsMayBeTruncated) && pageGroups.length
    ? (() => {
        const [lastKey] = pageGroups[pageGroups.length - 1];
        const [ticker, asOf] = lastKey.split('|');
        return encodeCursor(asOf, ticker);
      })()
    : null;
  for (const [key, rows] of pageGroups) {
    if (baseRows.length >= q.limit) break;
    const [ticker, asOf] = key.split('|');
    baseRows.push(await buildRow(env, ticker, asOf, rows, normalizedRows, generatedAt, q, priceCache, spx));
  }
  const rows = applyPlacebo(baseRows, q.placebo);
  const notes = [
    'Scores are point-in-time at disclosure availability; trade dates are included only as raw disclosure fields.',
    'Forward labels are outcomes and are not used in score inputs.',
    'Rows with pitValidity.historicalValidationReady=false are not a true historical validation set; use them for contract testing or live-forward collection only.',
    'CUSIP, ticker-change history, corporate-action vintage, and App B pre-Congress scan factors are null until source tables exist.',
  ];
  if (sourceRowsMayBeTruncated) {
    notes.push('The source transaction scan hit its safety cap; continue with pagination.nextCursor or use a narrower date range.');
  }
  if (q.placebo === 'split_dividend_event_stress_subset') {
    notes.push('split_dividend_event_stress_subset returned no rows because no corporate-action event table exists yet.');
  }
  return {
    generatedAt,
    scoreVersion: PIT_SCORE_VERSION,
    format: q.format,
    requested: q,
    parameterManifest: parameterManifest(),
    placebosAvailable: PIT_PLACEBOS,
    rowCount: rows.length,
    pagination: {
      limit: q.limit,
      nextCursor,
    },
    validationReadiness: summarizeValidationReadiness(rows),
    rows,
    notes,
  };
}

export function pitScoreRowsToNdjson(rows: PitScoreRow[]): string {
  return rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '');
}
