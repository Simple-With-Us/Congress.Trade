/**
 * Inbound peer share-push receipts for POST /api/admin/securities/import.
 * Outbound CT->ST pushes use share/outbound.ts; this module is inbound-only.
 */

import { sentryLoggerWarn } from '../shared/sentryRuntime.ts';
import type { Env } from '../shared/types.ts';

export const PEER_IMPORT_KIND = 'share_push' as const;
export const SCHEMA_DROP_REASON = 'schema_invalid' as const;

export const SHARE_IMPORT_STREAMS = [
  'refs',
  'prices',
  'spx',
  'insider',
  'shortVolume',
  'fundamentals',
  'analyst',
] as const;

export type ShareImportStream = (typeof SHARE_IMPORT_STREAMS)[number];

export type DroppedEntry = { count: number; reason: string };
export type DroppedMap = Partial<Record<ShareImportStream, DroppedEntry>>;

export interface ShareImportSummaryCounts {
  refs: number;
  spxRows: number;
  pricedTickers: number;
  priceRows: number;
  perfTickers: number;
  insiderRows: number;
  shortVolumeRows: number;
  fundamentalsRows: number;
  analystRows: number;
}

const STREAM_ERROR_PREFIX: Record<ShareImportStream, string> = {
  refs: ' ref:',
  prices: ' price:',
  spx: ' spx:',
  insider: ' insider:',
  shortVolume: ' shortVolume:',
  fundamentals: ' fundamentals:',
  analyst: ' analyst:',
};

/** Resolve a stable id for correlating with peer logs (header-first). */
export function resolvePeerImportRequestId(headers: Headers): string {
  const fromHeader =
    headers.get('x-request-id')?.trim() ||
    headers.get('cf-ray')?.trim() ||
    headers.get('x-correlation-id')?.trim();
  if (fromHeader) return fromHeader.slice(0, 128);
  return crypto.randomUUID();
}

export function countSchemaDropped(
  rawBody: Record<string, unknown>,
  filteredBody: Record<string, unknown>,
): DroppedMap {
  const dropped: DroppedMap = {};
  for (const stream of SHARE_IMPORT_STREAMS) {
    const raw = rawBody[stream];
    if (!Array.isArray(raw)) continue;
    const kept = filteredBody[stream];
    const keptLen = Array.isArray(kept) ? kept.length : 0;
    const count = Math.max(0, raw.length - keptLen);
    if (count > 0) {
      dropped[stream] = { count, reason: SCHEMA_DROP_REASON };
    }
  }
  return dropped;
}

export function acceptedCountsFromSummary(summary: ShareImportSummaryCounts): Record<ShareImportStream, number> {
  return {
    refs: summary.refs,
    // Series rows, same unit as dropped.prices. priceRows counts closes written
    // and leaves a valid series with an empty closes array uncounted.
    prices: summary.pricedTickers,
    spx: summary.spxRows,
    insider: summary.insiderRows,
    shortVolume: summary.shortVolumeRows,
    fundamentals: summary.fundamentalsRows,
    analyst: summary.analystRows,
  };
}

/** Attribute row-level processing failures in summary.errors to streams. */
export function rejectedCountsFromErrors(errors: readonly string[]): Partial<Record<ShareImportStream, number>> {
  const rejected: Partial<Record<ShareImportStream, number>> = {};
  for (const err of errors) {
    for (const stream of SHARE_IMPORT_STREAMS) {
      const needle = STREAM_ERROR_PREFIX[stream];
      if (err.includes(needle)) {
        rejected[stream] = (rejected[stream] ?? 0) + 1;
        break;
      }
    }
  }
  return rejected;
}

export function totalDroppedCount(dropped: DroppedMap): number {
  let n = 0;
  for (const stream of SHARE_IMPORT_STREAMS) {
    n += dropped[stream]?.count ?? 0;
  }
  return n;
}

export function warnPeerImportSchemaDrops(input: {
  requestId: string;
  origin: string | null;
  dropped: DroppedMap;
  payloadBytes: number;
}): void {
  const total = totalDroppedCount(input.dropped);
  if (total <= 0) return;
  const attrs = {
    requestId: input.requestId,
    origin: input.origin ?? 'unknown',
    payloadBytes: input.payloadBytes,
    droppedTotal: total,
    droppedJson: JSON.stringify(input.dropped),
  };
  sentryLoggerWarn('peer.import.schema_drops', attrs);
}

export interface PersistPeerImportReceiptInput {
  requestId: string;
  receivedAt: string;
  origin: string | null;
  payloadBytes: number;
  ok: boolean;
  accepted: Record<ShareImportStream, number>;
  dropped: DroppedMap;
  rejected: Partial<Record<ShareImportStream, number>>;
  errors: readonly string[];
}

export async function persistPeerImportReceipt(
  db: Env['DB'],
  input: PersistPeerImportReceiptInput,
): Promise<void> {
  const errorsJson = JSON.stringify(input.errors.slice(0, 50));
  await db
    .prepare(
      `INSERT INTO peer_import_receipts (
         request_id, received_at, origin, kind, payload_bytes, ok,
         accepted_json, dropped_json, rejected_json, errors_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.requestId,
      input.receivedAt,
      input.origin,
      PEER_IMPORT_KIND,
      input.payloadBytes,
      input.ok ? 1 : 0,
      JSON.stringify(input.accepted),
      JSON.stringify(input.dropped),
      JSON.stringify(input.rejected),
      errorsJson,
    )
    .run();
}
