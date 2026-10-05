/**
 * src/share/freshness.ts
 * OWNER: foundation
 *
 * Cross-app freshness watchdog (App A's half of the mutual health check). Once a
 * day the cron compares how stale the market-data streams a sibling app keeps
 * current — S&P closes, per-ticker prices, fundamentals, insider / short-volume,
 * analyst consensus, and imported reference enrichment — are against generous
 * thresholds. If a stream that should be kept current goes stale (App B's nightly
 * push silently broke, or our own price refresh is failing), we email a throttled
 * admin alert via the same path as the FMP-tier alert. A never-populated stream
 * (null latest) is treated as stale so a silent partner cannot hide behind an
 * empty table.
 *
 * The decision logic (evaluateFreshness) is pure + deterministic so it unit-
 * tests without a database or clock.
 */

import type { Env } from '../shared/types.ts';
import { get } from '../shared/db.ts';
import { notifyAdmin } from '../alerts/notify.ts';

export type FreshnessStream =
  | 'spx'
  | 'prices'
  | 'fundamentals'
  | 'insider'
  | 'shortVolume'
  | 'analyst'
  | 'refEnrichment';

/** Latest timestamp seen per donated stream (YYYY-MM-DD or ISO; null = never). */
export interface FreshnessSnapshot {
  spxLatestDate: string | null;
  priceLatestDate: string | null;
  fundamentalsLatest: string | null;
  insiderLatestDate: string | null;
  shortVolumeLatestDate: string | null;
  analystLatest: string | null;
  /** Proxy for sibling-pushed company reference rows (`source = imported`). */
  refEnrichmentLatest: string | null;
}

export interface StaleStream {
  stream: FreshnessStream;
  latest: string;
  ageDays: number;
}

/**
 * Max age (whole days) before a kept-current stream is considered stale. Roomy
 * enough to absorb weekends + a market holiday (closes don't update Sat/Sun)
 * without false alarms; fundamentals / analyst / ref enrichment get extra slack
 * for a nightly cadence; insider / short-volume follow daily EOD with the same
 * weekend headroom as prices.
 */
export const FRESHNESS_MAX_AGE_DAYS: Record<FreshnessStream, number> = {
  spx: 5,
  prices: 5,
  fundamentals: 8,
  insider: 5,
  shortVolume: 5,
  analyst: 8,
  refEnrichment: 8,
};

/** Shown in alerts when a stream has never received data. */
export const FRESHNESS_NEVER_LABEL = 'never';

const DAY_MS = 86_400_000;

/** Whole days between a date/ISO string and `nowMs`; null when unparseable. */
export function ageInDays(value: string | null, nowMs: number): number | null {
  if (!value) return null;
  // Bare YYYY-MM-DD → treat as UTC midnight so day math is stable.
  const iso = value.length <= 10 ? `${value}T00:00:00Z` : value;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.floor((nowMs - t) / DAY_MS);
}

/**
 * Pure: which donated streams are stale beyond their threshold. Null latest is
 * stale (never populated) for every stream in the snapshot.
 */
export function evaluateFreshness(
  snapshot: FreshnessSnapshot,
  nowMs: number,
  max: Record<FreshnessStream, number> = FRESHNESS_MAX_AGE_DAYS,
): StaleStream[] {
  const checks: Array<[FreshnessStream, string | null]> = [
    ['spx', snapshot.spxLatestDate],
    ['prices', snapshot.priceLatestDate],
    ['fundamentals', snapshot.fundamentalsLatest],
    ['insider', snapshot.insiderLatestDate],
    ['shortVolume', snapshot.shortVolumeLatestDate],
    ['analyst', snapshot.analystLatest],
    ['refEnrichment', snapshot.refEnrichmentLatest],
  ];
  const stale: StaleStream[] = [];
  for (const [stream, latest] of checks) {
    if (latest == null) {
      stale.push({ stream, latest: FRESHNESS_NEVER_LABEL, ageDays: max[stream] + 1 });
      continue;
    }
    const age = ageInDays(latest, nowMs);
    if (age != null && age > max[stream]) {
      stale.push({ stream, latest, ageDays: age });
    }
  }
  return stale;
}

/**
 * Read the latest-seen timestamp for each donated stream and email a throttled
 * alert if any has gone stale. Best-effort: a DB or KV failure is swallowed
 * (skip rather than crash the cron / spam on transient errors).
 */
export async function runFreshnessCheck(env: Env, now = new Date()): Promise<StaleStream[]> {
  let snapshot: FreshnessSnapshot;
  try {
    const row = await get<{
      spx_latest: string | null;
      price_latest: string | null;
      fundamentals_latest: string | null;
      insider_latest: string | null;
      short_volume_latest: string | null;
      analyst_latest: string | null;
      ref_enrichment_latest: string | null;
    }>(
      env.DB,
      // price_latest is the WORST (oldest) latest_price_date among the 25 most-
      // recently-traded priceable tickers — the names users actually look at.
      // It used to be MAX(latest_price_date) across the whole table, which one
      // freshly-priced quiet ticker keeps green forever: in the 2026-08-10
      // incident most megacaps sat 12+ sessions stale while SOFI/RKT (fresh)
      // masked the backlog and this alert never fired. Still reads only the
      // maintained, indexed securities_ref.latest_price_date (never price_eod).
      'SELECT (SELECT MAX(date) FROM spx_eod) AS spx_latest, ' +
        '(SELECT MIN(latest_price_date) FROM (' +
        'SELECT sr.latest_price_date AS latest_price_date FROM transactions t ' +
        'JOIN securities_ref sr ON sr.ticker = t.ticker ' +
        "WHERE t.ticker IS NOT NULL AND t.ticker <> '' " +
        'AND COALESCE(sr.price_unavailable, 0) = 0 AND sr.latest_price_date IS NOT NULL ' +
        'GROUP BY t.ticker ORDER BY MAX(t.cursor_seq) DESC LIMIT 25' +
        ')) AS price_latest, ' +
        '(SELECT MAX(updated_at) FROM fundamentals_eod) AS fundamentals_latest, ' +
        '(SELECT MAX(date) FROM insider_eod) AS insider_latest, ' +
        '(SELECT MAX(date) FROM short_volume_eod) AS short_volume_latest, ' +
        "(SELECT MAX(updated_at) FROM analyst_consensus WHERE source = 'imported') AS analyst_latest, " +
        "(SELECT MAX(price_checked_at) FROM securities_ref WHERE source = 'imported') AS ref_enrichment_latest",
    );
    snapshot = {
      spxLatestDate: row?.spx_latest ?? null,
      priceLatestDate: row?.price_latest ?? null,
      fundamentalsLatest: row?.fundamentals_latest ?? null,
      insiderLatestDate: row?.insider_latest ?? null,
      shortVolumeLatestDate: row?.short_volume_latest ?? null,
      analystLatest: row?.analyst_latest ?? null,
      refEnrichmentLatest: row?.ref_enrichment_latest ?? null,
    };
  } catch {
    return []; // DB unavailable → skip rather than false-alarm
  }

  const stale = evaluateFreshness(snapshot, now.getTime());
  if (stale.length === 0) return [];

  const lines = stale
    .map((s) => {
      const ago = s.latest === FRESHNESS_NEVER_LABEL
        ? 'never populated'
        : `${s.ageDays}d ago`;
      return `  • ${s.stream}: last update ${s.latest} (${ago})`;
    })
    .join('\n');
  await notifyAdmin(env, {
    dedupeKey: 'data-freshness',
    subject: 'Congress.Trade ⚠️ shared market data is going stale',
    text:
      'A market-data stream that should be kept current has gone stale. The\n' +
      "sibling app's nightly push may have stopped, or our own price/enrichment\n" +
      'refresh is failing. Stale streams:\n\n' +
      lines +
      '\n\nThresholds (days): ' +
      JSON.stringify(FRESHNESS_MAX_AGE_DAYS) +
      '\n\nCheck the partner import push + the daily FMP price/enrichment job.\n' +
      "You'll get at most one of these alerts every 12 hours.",
  });
  return stale;
}
