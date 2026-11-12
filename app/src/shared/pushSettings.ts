/**
 * Account-owned phone-push preferences.
 *
 * `user_preferences.notification_settings` is a JSON object. Missing keys
 * default to filing digests (one alert per new disclosure) so a previously
 * registered device stops the per-trade firehose without a migration.
 */

import { STOCK_ACT_BRACKETS } from './brackets.ts';
import { DEFAULT_EXECUTIVE_TITLE, executiveTitleFor } from './executiveTitles.ts';

export const PUSH_MODES = ['off', 'filings', 'watchlist'] as const;
export type PushMode = (typeof PUSH_MODES)[number];

export const PUSH_SIDES = ['all', 'buys', 'sells'] as const;
export type PushSides = (typeof PUSH_SIDES)[number];

export interface TickerAlertRule {
  minAmount: number | null;
  sides: PushSides;
}

export interface PushSettings {
  pushMode: PushMode;
  watchlistRules: Record<string, TickerAlertRule>;
}

/** STOCK Act bracket floors except the $0–$1,000 product tier. */
export const PUSH_AMOUNT_CUTOFFS: readonly number[] = STOCK_ACT_BRACKETS
  .map((b) => b.min)
  .filter((min) => min > 0);

export const DEFAULT_PUSH_SETTINGS: PushSettings = {
  pushMode: 'filings',
  watchlistRules: {},
};

const US_STATES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi',
  MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire',
  NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina',
  ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee',
  TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington',
  WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', DC: 'District of Columbia',
  PR: 'Puerto Rico', GU: 'Guam', VI: 'U.S. Virgin Islands', AS: 'American Samoa',
  MP: 'Northern Mariana Islands',
};

export function isPushMode(value: unknown): value is PushMode {
  return value === 'off' || value === 'filings' || value === 'watchlist';
}

export function isPushSides(value: unknown): value is PushSides {
  return value === 'all' || value === 'buys' || value === 'sells';
}

export function formatPushAmountCutoff(min: number): string {
  return `$${Math.trunc(min).toLocaleString('en-US')}+`;
}

function asInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return null;
}

function parseRule(raw: unknown): TickerAlertRule {
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const min = asInt(obj.minAmount);
  return {
    minAmount: min != null && min > 0 ? min : null,
    sides: isPushSides(obj.sides) ? obj.sides : 'all',
  };
}

export function parsePushSettings(raw: unknown): PushSettings {
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const rulesRaw = obj.watchlistRules && typeof obj.watchlistRules === 'object' && !Array.isArray(obj.watchlistRules)
    ? obj.watchlistRules as Record<string, unknown>
    : {};
  const watchlistRules: Record<string, TickerAlertRule> = {};
  for (const [ticker, rule] of Object.entries(rulesRaw)) {
    const symbol = ticker.trim().toUpperCase();
    if (!symbol) continue;
    watchlistRules[symbol] = parseRule(rule);
  }
  return {
    pushMode: isPushMode(obj.pushMode) ? obj.pushMode : DEFAULT_PUSH_SETTINGS.pushMode,
    watchlistRules,
  };
}

export function serializePushSettings(settings: PushSettings): Record<string, unknown> {
  const watchlistRules: Record<string, { minAmount: number | null; sides: PushSides }> = {};
  for (const [ticker, rule] of Object.entries(settings.watchlistRules)) {
    watchlistRules[ticker] = { minAmount: rule.minAmount, sides: rule.sides };
  }
  return { pushMode: settings.pushMode, watchlistRules };
}

export function stateDisplayName(abbr: string | null | undefined): string {
  const s = String(abbr ?? '').trim().toUpperCase();
  return US_STATES[s] || String(abbr ?? '').trim();
}

function ordinal(n: number): string {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

export interface FilerPositionInput {
  filerId?: string | null;
  chamber?: string | null;
  state?: string | null;
  district?: string | null;
}

/** Plain-English seat/office, e.g. "Senator from California". */
export function filerPosition(input: FilerPositionInput): string {
  const chamber = String(input.chamber ?? '').trim().toLowerCase();
  const state = stateDisplayName(input.state);
  if (chamber === 'senate') {
    return state ? `Senator from ${state}` : 'Senator';
  }
  if (chamber === 'house') {
    const rawDistrict = String(input.district ?? '').trim();
    const n = Number(rawDistrict);
    if (state && Number.isFinite(n) && n > 0) {
      return `Representative from ${state}'s ${ordinal(n)} District`;
    }
    return state ? `Representative from ${state}` : 'Representative';
  }
  if (chamber === 'executive' || String(input.filerId ?? '').startsWith('EXEC-')) {
    return executiveTitleFor(input.filerId) || DEFAULT_EXECUTIVE_TITLE;
  }
  return '';
}

export type TradeSideKind = 'buys' | 'sells' | 'exchanges';

export function tradeSideKind(txType: string | null | undefined): TradeSideKind | null {
  const t = String(txType ?? '').trim().toUpperCase();
  if (t === 'S') return 'sells';
  if (t === 'E') return 'exchanges';
  if (t === 'B' || t === 'P') return 'buys';
  return null;
}

export interface PushTradeLike {
  id?: string | null;
  doc_id?: string | null;
  ticker?: string | null;
  tx_type?: string | null;
  amount_min?: number | null;
  filer_id?: string | null;
  filer_name?: string | null;
  chamber?: string | null;
  state?: string | null;
  district?: string | null;
  created_at?: string | null;
}

export function filingGroupKey(row: PushTradeLike): string {
  const doc = String(row.doc_id ?? '').trim();
  if (doc) return `doc:${doc}`;
  const filer = String(row.filer_id ?? '').trim();
  const created = String(row.created_at ?? '').slice(0, 16);
  if (filer && created) return `filer:${filer}:${created}`;
  return `tx:${String(row.id ?? 'unknown')}`;
}

export function groupTradesByFiling<T extends PushTradeLike>(rows: T[]): T[][] {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const key = filingGroupKey(row);
    const list = map.get(key);
    if (list) list.push(row);
    else map.set(key, [row]);
  }
  return [...map.values()];
}

function noun(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function tradeCountPhrase(rows: PushTradeLike[]): string {
  let buys = 0;
  let sells = 0;
  let exchanges = 0;
  for (const row of rows) {
    const side = tradeSideKind(row.tx_type);
    if (side === 'buys') buys += 1;
    else if (side === 'sells') sells += 1;
    else if (side === 'exchanges') exchanges += 1;
  }
  const n = rows.length;
  const parts: string[] = [];
  if (buys) parts.push(noun(buys, 'buy', 'buys'));
  if (sells) parts.push(noun(sells, 'sell', 'sells'));
  if (exchanges) parts.push(noun(exchanges, 'exchange', 'exchanges'));
  const counts = parts.length ? ` (${parts.join(', ')})` : '';
  return `filed ${noun(n, 'trade', 'trades')}${counts}`;
}

export function filingAlertCopy(rows: PushTradeLike[]): { title: string; body: string } {
  const first = rows[0];
  const name = first?.filer_name?.trim() || 'A filer';
  const position = first ? filerPosition(first) : '';
  const title = position ? `${name}, ${position}` : name;
  const phrase = tradeCountPhrase(rows);
  const body = phrase.charAt(0).toUpperCase() + phrase.slice(1) + '.';
  return { title, body };
}

export function matchesWatchlistTrade(
  row: PushTradeLike,
  watchlist: string[],
  settings: PushSettings,
): boolean {
  const ticker = String(row.ticker ?? '').trim().toUpperCase();
  if (!ticker) return false;
  const wanted = new Set(watchlist.map((t) => t.trim().toUpperCase()).filter(Boolean));
  if (!wanted.has(ticker)) return false;
  const rule = settings.watchlistRules[ticker] ?? { minAmount: null, sides: 'all' as PushSides };
  if (rule.minAmount != null) {
    const min = asInt(row.amount_min);
    if (min == null || min < rule.minAmount) return false;
  }
  if (rule.sides === 'all') return true;
  const side = tradeSideKind(row.tx_type);
  if (rule.sides === 'buys') return side === 'buys';
  if (rule.sides === 'sells') return side === 'sells';
  return false;
}
