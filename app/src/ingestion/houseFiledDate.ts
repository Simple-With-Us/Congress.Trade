/**
 * House PTR filed-date resolution (CT-2481).
 *
 * Precedence (first non-empty wins; never invent a date):
 *   1. House yearly FD index XML `<FilingDate>` for the doc (M/D/YYYY).
 *   2. Clerk "Received" reception stamp parsed from PDF/OCR text (scanned hand-deliveries).
 *
 * Live search and fast-path ingest omit FilingDate; scanned 9xxxxxx PTRs may publish
 * before a later bulk pass backfills `filings.filed_date`. Resolution here runs at
 * extraction (before normalize) and in admin/cron backfills so `transactions.filed_date`
 * is populated from authoritative sources only.
 */

import type { Env } from '../shared/types.ts';
import { run, all } from '../shared/db.ts';
import { computeDisclosureLagDays, computeStockActStatus } from '../shared/stockAct.ts';
import { fetchHouseIndex, type HouseFiling } from './houseSource.ts';

/** Parse `H-{year}-{clerkDocId}` pipeline ids. */
export function parseHousePipelineDocId(docId: string): { year: string; clerkDocId: string } | null {
  const m = /^H-(\d{4})-(\d+)$/.exec((docId ?? '').trim());
  if (!m) return null;
  return { year: m[1], clerkDocId: m[2] };
}

/** Normalize House / Clerk date strings to ISO `YYYY-MM-DD`. */
export function normalizeHouseFilingDateToIso(raw: string | null | undefined): string | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (us) {
    return `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`;
  }
  const loose = /^(\d{1,2})\s*\/\s*(\d{1,2})\s*\/\s*(\d{4})$/.exec(s);
  if (loose) {
    return `${loose[3]}-${loose[1].padStart(2, '0')}-${loose[2].padStart(2, '0')}`;
  }
  return null;
}

const CLERK_RECEIVED_STAMP_RES = [
  /\bDate\s+Received\b[:\s]*(\d{1,2}\s*\/\s*\d{1,2}\s*\/\s*\d{4})/i,
  /\bReceived\b[:\s]+(\d{1,2}\s*\/\s*\d{1,2}\s*\/\s*\d{4})/i,
  /\bRECEIVED\b[:\s]+(\d{1,2}\s*\/\s*\d{1,2}\s*\/\s*\d{4})/i,
] as const;

/**
 * Parse the Clerk reception stamp from House PTR OCR/text. Searches only the
 * document header (first ~3k chars) so transaction-row dates are not mistaken
 * for the filing stamp.
 */
export function parseClerkReceivedStampFromOcrText(text: string | null | undefined): string | null {
  const raw = (text ?? '').trim();
  if (!raw) return null;
  const header = raw.slice(0, 3000);
  for (const re of CLERK_RECEIVED_STAMP_RES) {
    const m = re.exec(header);
    if (m?.[1]) {
      const iso = normalizeHouseFilingDateToIso(m[1].replace(/\s+/g, ''));
      if (iso) return iso;
    }
  }
  return null;
}

export type HouseFiledDateSource = 'index' | 'clerk_stamp' | 'existing';

export interface ResolvedHouseFiledDate {
  iso: string;
  source: HouseFiledDateSource;
}

/**
 * Apply documented precedence. `existingIso` is kept when already set.
 */
export function resolveHouseFiledDate(opts: {
  existingIso?: string | null;
  indexFilingDate?: string | null;
  ocrText?: string | null;
}): ResolvedHouseFiledDate | null {
  const existing = normalizeHouseFilingDateToIso(opts.existingIso);
  if (existing) return { iso: existing, source: 'existing' };

  const fromIndex = normalizeHouseFilingDateToIso(opts.indexFilingDate);
  if (fromIndex) return { iso: fromIndex, source: 'index' };

  const fromStamp = parseClerkReceivedStampFromOcrText(opts.ocrText ?? '');
  if (fromStamp) return { iso: fromStamp, source: 'clerk_stamp' };

  return null;
}

/**
 * The Clerk regenerates the year ZIP about daily, and this process stays up
 * across that refresh. A hit inside the window avoids a repeat download.
 * After it, the next lookup fetches again so a filing added to the index is
 * visible without a process restart.
 */
export const HOUSE_INDEX_FILING_DATE_CACHE_TTL_MS = 60 * 60 * 1000;

type HouseIndexYearCache = {
  loadedAt: number;
  map: Map<string, string>;
};

const indexCacheByYear = new Map<string, HouseIndexYearCache>();

export function filingDateFromHouseIndexRows(rows: HouseFiling[], pipelineDocId: string): string | null {
  const row = rows.find((f) => f.pipelineDocId === pipelineDocId);
  const raw = row?.filingDate?.trim();
  return raw ? raw : null;
}

export async function loadHouseIndexFilingDateMap(
  year: string,
  opts: { relayUrl?: string; fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<Map<string, string>> {
  const now = Date.now();
  const cached = indexCacheByYear.get(year);
  if (cached && now - cached.loadedAt < HOUSE_INDEX_FILING_DATE_CACHE_TTL_MS) {
    return cached.map;
  }
  const index = await fetchHouseIndex(year, opts);
  const map = new Map<string, string>();
  for (const f of index) {
    if (f.filingDate?.trim()) {
      map.set(f.pipelineDocId, f.filingDate.trim());
    }
  }
  indexCacheByYear.set(year, { loadedAt: now, map });
  return map;
}

/** Clear the in-process index cache (tests). */
export function clearHouseIndexFilingDateCache(): void {
  indexCacheByYear.clear();
}

export async function lookupHouseIndexFilingDate(
  pipelineDocId: string,
  opts: { relayUrl?: string; fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<string | null> {
  const parts = parseHousePipelineDocId(pipelineDocId);
  if (!parts) return null;
  const map = await loadHouseIndexFilingDateMap(parts.year, opts);
  return map.get(pipelineDocId) ?? null;
}

export interface ApplyHouseFiledDateResult {
  applied: boolean;
  iso: string | null;
  source: HouseFiledDateSource | null;
  transactionsUpdated: number;
}

/**
 * Persist a resolved filed date on `filings` and backfill NULL `transactions.filed_date`
 * for the same doc. Only fills missing values; never overwrites an existing date.
 */
export async function applyHouseFiledDateIfMissing(
  env: Env,
  docId: string,
  resolved: ResolvedHouseFiledDate,
): Promise<ApplyHouseFiledDateResult> {
  const res = await run(
    env.DB,
    `UPDATE filings SET filed_date = ? WHERE doc_id = ? AND (filed_date IS NULL OR filed_date = '')`,
    [resolved.iso, docId],
  );
  const filingUpdated = (res.meta?.changes ?? 0) > 0;

  try {
    await run(
      env.DB,
      `UPDATE disclosure_latency_candidates SET filed_date = ? WHERE doc_id = ? AND (filed_date IS NULL OR filed_date = '')`,
      [resolved.iso, docId],
    );
  } catch {
    /* optional table (migration 0021) */
  }

  const transactionsUpdated = await backfillTransactionFiledDatesForDoc(env, docId, resolved.iso);

  return {
    applied: filingUpdated,
    iso: resolved.iso,
    source: resolved.source,
    transactionsUpdated,
  };
}

export async function backfillTransactionFiledDatesForDoc(
  env: Env,
  docId: string,
  filedIso: string,
): Promise<number> {
  const rows = await all<{ id: string; tx_date: string | null }>(
    env.DB,
    `SELECT id, tx_date FROM transactions WHERE doc_id = ? AND (filed_date IS NULL OR filed_date = '')`,
    [docId],
  );
  if (rows.length === 0) return 0;

  let updated = 0;
  for (const row of rows) {
    const lag = computeDisclosureLagDays(row.tx_date, filedIso);
    const status = computeStockActStatus(row.tx_date, filedIso);
    const r = await run(
      env.DB,
      `UPDATE transactions SET filed_date = ?, disclosure_lag_days = ?, stock_act_status = ?
       WHERE id = ? AND (filed_date IS NULL OR filed_date = '')`,
      [filedIso, lag, status, row.id],
    );
    if ((r.meta?.changes ?? 0) > 0) updated += 1;
  }
  return updated;
}

export interface EnsureHouseFiledDateOpts {
  ocrText?: string | null;
  relayUrl?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

/**
 * Resolve and persist House filed_date immediately before normalize, using index
 * then OCR stamp when the filings row is still empty.
 */
export async function ensureHouseFiledDateBeforeNormalize(
  env: Env,
  filing: { docId: string; chamber?: string | null; filedDate?: string | null },
  opts: EnsureHouseFiledDateOpts = {},
): Promise<string | null> {
  if (filing.chamber && filing.chamber !== 'house') {
    return normalizeHouseFilingDateToIso(filing.filedDate);
  }
  const parts = parseHousePipelineDocId(filing.docId);
  if (!parts) {
    return normalizeHouseFilingDateToIso(filing.filedDate);
  }

  // Existing dates win (resolveHouseFiledDate). Skip the year-ZIP download.
  const existing = normalizeHouseFilingDateToIso(filing.filedDate);
  if (existing) {
    filing.filedDate = existing;
    return existing;
  }

  const indexDate = await lookupHouseIndexFilingDate(filing.docId, {
    relayUrl: opts.relayUrl,
    fetchImpl: opts.fetchImpl,
    signal: opts.signal,
  }).catch((err) => {
    console.warn('houseFiledDate: index lookup failed:', filing.docId, (err as Error).message);
    return null;
  });

  const resolved = resolveHouseFiledDate({
    existingIso: filing.filedDate,
    indexFilingDate: indexDate,
    ocrText: opts.ocrText,
  });
  if (!resolved || resolved.source === 'existing') {
    const iso = resolved?.iso ?? normalizeHouseFilingDateToIso(filing.filedDate);
    if (iso) filing.filedDate = iso;
    return iso;
  }

  const applied = await applyHouseFiledDateIfMissing(env, filing.docId, resolved);
  filing.filedDate = resolved.iso;
  if (applied.applied) {
    console.info(
      `houseFiledDate: set ${filing.docId} filed_date=${resolved.iso} via ${resolved.source}`
      + (applied.transactionsUpdated ? ` (+${applied.transactionsUpdated} tx)` : ''),
    );
  }
  return resolved.iso;
}
