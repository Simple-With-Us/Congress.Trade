/**
 * Static SQL for ST peer stall detectors (no runtime SQL fragment interpolation).
 */

import { KEYED_ENRICHMENT_NEEDED_SR_SQL } from '../enrichment/service.ts';
import {
  ENRICHMENT_UNAVAILABLE_EXCLUDED_LEGACY_SQL,
  ENRICHMENT_UNAVAILABLE_EXCLUDED_SR_SQL,
} from '../enrichment/securitiesRefEnrichmentSchema.ts';

/** Transaction rows that are not competitor inject fixtures (alias `t`). */
export const ST_PEER_TX_EXCLUDE_COMPETITOR_FIXTURE =
  "(t.doc_id IS NULL OR t.doc_id NOT LIKE 'COMPETITOR-%')";

const ENRICHMENT_PENDING_HEAD = `
  FROM transactions t
  LEFT JOIN securities_ref sr ON sr.ticker = t.ticker
 WHERE t.ticker IS NOT NULL AND TRIM(t.ticker) != ''
   AND t.deprecated_at IS NULL
   AND ${ST_PEER_TX_EXCLUDE_COMPETITOR_FIXTURE}`;

/** Pending enrichment backlog with 0104 negative-cache columns. */
export const ST_PEER_ENRICHMENT_PENDING_BODY_MODERN =
  `${ENRICHMENT_PENDING_HEAD}
   AND ${ENRICHMENT_UNAVAILABLE_EXCLUDED_SR_SQL}
   AND ${KEYED_ENRICHMENT_NEEDED_SR_SQL}`;

/** Pending enrichment backlog before migration 0104 (no enrichment_unavailable). */
export const ST_PEER_ENRICHMENT_PENDING_BODY_LEGACY =
  `${ENRICHMENT_PENDING_HEAD}
   AND ${ENRICHMENT_UNAVAILABLE_EXCLUDED_LEGACY_SQL}
   AND ${KEYED_ENRICHMENT_NEEDED_SR_SQL}`;

export const ST_PEER_ENRICHMENT_PROGRESS_COL_MODERN = 'sr.enrichment_checked_at';
export const ST_PEER_ENRICHMENT_PROGRESS_COL_LEGACY = 'sr.enriched_at';

export const ST_PEER_PRICE_PENDING_BODY = `
  FROM transactions t
  JOIN securities_ref sr ON sr.ticker = t.ticker
 WHERE t.ticker IS NOT NULL AND TRIM(t.ticker) != ''
   AND t.deprecated_at IS NULL
   AND ${ST_PEER_TX_EXCLUDE_COMPETITOR_FIXTURE}
   AND COALESCE(sr.price_unavailable, 0) = 0
   AND (sr.latest_price_date IS NULL OR sr.price_checked_at IS NULL)`;

export const ST_PEER_ENRICHMENT_PENDING_COUNT_SQL_MODERN = `
SELECT
  (SELECT COUNT(DISTINCT t.ticker) ${ST_PEER_ENRICHMENT_PENDING_BODY_MODERN}) AS n,
  (SELECT MAX(${ST_PEER_ENRICHMENT_PROGRESS_COL_MODERN}) ${ST_PEER_ENRICHMENT_PENDING_BODY_MODERN}) AS last_at`;

export const ST_PEER_ENRICHMENT_PENDING_COUNT_SQL_LEGACY = `
SELECT
  (SELECT COUNT(DISTINCT t.ticker) ${ST_PEER_ENRICHMENT_PENDING_BODY_LEGACY}) AS n,
  (SELECT MAX(${ST_PEER_ENRICHMENT_PROGRESS_COL_LEGACY}) ${ST_PEER_ENRICHMENT_PENDING_BODY_LEGACY}) AS last_at`;

export const ST_PEER_ENRICHMENT_PENDING_SAMPLE_SQL_MODERN = `
SELECT DISTINCT t.ticker AS ticker ${ST_PEER_ENRICHMENT_PENDING_BODY_MODERN}
 ORDER BY t.ticker ASC
 LIMIT 10`;

export const ST_PEER_ENRICHMENT_PENDING_SAMPLE_SQL_LEGACY = `
SELECT DISTINCT t.ticker AS ticker ${ST_PEER_ENRICHMENT_PENDING_BODY_LEGACY}
 ORDER BY t.ticker ASC
 LIMIT 10`;

export const ST_PEER_PRICE_PENDING_COUNT_SQL = `
SELECT
  (SELECT COUNT(DISTINCT t.ticker) ${ST_PEER_PRICE_PENDING_BODY}) AS n,
  (SELECT MAX(sr.price_checked_at) ${ST_PEER_PRICE_PENDING_BODY}) AS last_at`;

export const ST_PEER_PRICE_PENDING_SAMPLE_SQL = `
SELECT DISTINCT t.ticker AS ticker ${ST_PEER_PRICE_PENDING_BODY}
 ORDER BY t.ticker ASC
 LIMIT 10`;
