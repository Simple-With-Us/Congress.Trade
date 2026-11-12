/**
 * Idempotent admin/cron backfill for House filings published with NULL filed_date.
 */

import type { Env } from '../shared/types.ts';
import { all } from '../shared/db.ts';
import {
  applyHouseFiledDateIfMissing,
  loadHouseIndexFilingDateMap,
  parseClerkReceivedStampFromOcrText,
  parseHousePipelineDocId,
  resolveHouseFiledDate,
  type HouseFiledDateSource,
} from './houseFiledDate.ts';

export interface HouseFiledDateBackfillRow {
  doc_id: string;
  resolvedIso: string | null;
  source: HouseFiledDateSource | null;
  applied: boolean;
  transactionsUpdated: number;
}

export interface HouseFiledDateBackfillResult {
  dryRun: boolean;
  scanned: number;
  resolved: number;
  applied: number;
  transactionsUpdated: number;
  yearsFetched: string[];
  rows: HouseFiledDateBackfillRow[];
}

export async function backfillHouseEmptyFiledDates(
  env: Env,
  opts: {
    dryRun?: boolean;
    limit?: number;
    maxYears?: number;
    useOcr?: boolean;
    relayUrl?: string;
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
  } = {},
): Promise<HouseFiledDateBackfillResult> {
  const dryRun = opts.dryRun !== false;
  const limit = opts.limit ?? 200;
  const maxYears = opts.maxYears ?? 2;
  const useOcr = opts.useOcr !== false;

  const candidates = await all<{ doc_id: string; raw_object_key: string | null }>(
    env.DB,
    `SELECT f.doc_id, f.raw_object_key
       FROM filings f
      WHERE f.chamber = 'house'
        AND (f.filed_date IS NULL OR f.filed_date = '')
        AND f.ingest_status NOT IN ('not_found', 'error')
        AND f.doc_id LIKE 'H-____-%'
      ORDER BY f.first_seen_at DESC
      LIMIT ?`,
    [limit],
  );

  const yearsNeeded = new Set<string>();
  for (const row of candidates) {
    const parts = parseHousePipelineDocId(row.doc_id);
    if (parts) yearsNeeded.add(parts.year);
  }
  const years = [...yearsNeeded].slice(0, maxYears);

  const indexByYear = new Map<string, Map<string, string>>();
  for (const year of years) {
    try {
      indexByYear.set(
        year,
        await loadHouseIndexFilingDateMap(year, {
          relayUrl: opts.relayUrl,
          fetchImpl: opts.fetchImpl,
          signal: opts.signal,
        }),
      );
    } catch (err) {
      console.warn(`houseFiledDateBackfill: index fetch failed for ${year}:`, (err as Error).message);
    }
  }

  const out: HouseFiledDateBackfillRow[] = [];
  let resolvedCount = 0;
  let appliedCount = 0;
  let txUpdated = 0;

  for (const row of candidates) {
    const parts = parseHousePipelineDocId(row.doc_id);
    let ocrText: string | null = null;
    if (useOcr && row.raw_object_key) {
      try {
        const obj = await env.RAW_FILES.get(row.raw_object_key);
        if (obj) {
          const bytes = new Uint8Array(await obj.arrayBuffer());
          const { extractText, getDocumentProxy } = await import('unpdf');
          const pdf = await getDocumentProxy(bytes.slice());
          const { text } = await extractText(pdf, { mergePages: true });
          ocrText = typeof text === 'string' ? text : (text as string[]).join('\n');
          if (typeof (pdf as unknown as { destroy?: () => void }).destroy === 'function') {
            (pdf as unknown as { destroy: () => void }).destroy();
          }
        }
      } catch (err) {
        console.warn(`houseFiledDateBackfill: OCR text read failed for ${row.doc_id}:`, (err as Error).message);
      }
    }

    const indexDate = parts
      ? indexByYear.get(parts.year)?.get(row.doc_id) ?? null
      : null;

    const resolved = resolveHouseFiledDate({ indexFilingDate: indexDate, ocrText });
    if (!resolved) {
      out.push({
        doc_id: row.doc_id,
        resolvedIso: null,
        source: null,
        applied: false,
        transactionsUpdated: 0,
      });
      continue;
    }
    resolvedCount += 1;

    if (dryRun) {
      out.push({
        doc_id: row.doc_id,
        resolvedIso: resolved.iso,
        source: resolved.source,
        applied: false,
        transactionsUpdated: 0,
      });
      continue;
    }

    const applied = await applyHouseFiledDateIfMissing(env, row.doc_id, resolved);
    if (applied.applied) appliedCount += 1;
    txUpdated += applied.transactionsUpdated;
    out.push({
      doc_id: row.doc_id,
      resolvedIso: resolved.iso,
      source: resolved.source,
      applied: applied.applied,
      transactionsUpdated: applied.transactionsUpdated,
    });
  }

  return {
    dryRun,
    scanned: candidates.length,
    resolved: resolvedCount,
    applied: appliedCount,
    transactionsUpdated: txUpdated,
    yearsFetched: years,
    rows: out,
  };
}
