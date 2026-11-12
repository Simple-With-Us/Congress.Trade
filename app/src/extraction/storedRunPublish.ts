/**
 * Publish a held filing from extraction_runs already stored for it.
 * No new LLM calls — the expensive reads already happened.
 * A single quality survivor is enough (H-2026-9116328).
 */
import type { Env, ParsedTx } from '../shared/types.ts';
import { all } from '../shared/db.ts';
import type { CandidateDocResult } from './bakeoff.ts';
import {
  decideAgreementPublish,
  finalizePublish,
  loadFilingRow,
  qualityGateAgreementRead,
} from './agreement.ts';
import { prepareExtractedRows } from './prepareTx.ts';
import { loadResolver } from './normalizer.ts';
import { recordIngestionDecision } from '../shared/ingestionDecisions.ts';

export interface StoredRunPublishResult {
  scanned: number;
  published: number;
  skipped: number;
  failed: number;
}

const DEFAULT_LIMIT = 20;

function asRead(docId: string, model: string, rows: ParsedTx[]): CandidateDocResult {
  return {
    provider: 'openrouter',
    model,
    docId,
    ok: true,
    latencyMs: 0,
    rowCount: rows.length,
    rowKeys: [],
    avgConfidence: rows.length
      ? rows.reduce((sum, tx) => sum + (tx.confidence ?? 0), 0) / rows.length
      : 0,
    rows,
  } as CandidateDocResult;
}

function parseRows(raw: string | null): ParsedTx[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed as ParsedTx[] : [];
  } catch {
    return [];
  }
}

/**
 * Vote the latest successful reading per distinct model and publish when
 * identity fields have a majority and assetName has a unique plurality.
 */
export async function maybePublishFromStoredRuns(
  env: Env,
  opts: { limit?: number; signal?: AbortSignal } = {},
): Promise<StoredRunPublishResult> {
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), 50);
  const out: StoredRunPublishResult = { scanned: 0, published: 0, skipped: 0, failed: 0 };

  let docs: Array<{ doc_id: string }>;
  try {
    docs = await all(
      env.DB,
      `SELECT rq.doc_id
         FROM review_queue rq
         JOIN filings f ON f.doc_id = rq.doc_id
        WHERE rq.resolved = 0
          AND rq.agreement_suppressed_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM transactions t
             WHERE t.doc_id = rq.doc_id
               AND t.source IN ('primary', 'manual')
               AND t.deprecated_at IS NULL
          )
          AND (
            SELECT COUNT(DISTINCT er.provider || ':' || er.model)
              FROM extraction_runs er
             WHERE er.doc_id = rq.doc_id AND er.ok = 1
          ) >= 1
        ORDER BY rq.created_at DESC
        LIMIT ?`,
      [limit],
    );
  } catch (err) {
    console.warn('storedRunPublish selector failed:', (err as Error).message);
    return out;
  }

  const resolver = await loadResolver(env);

  for (const { doc_id: docId } of docs) {
    if (opts.signal?.aborted) break;
    out.scanned += 1;
    try {
      const runRows = await all<{
        provider: string;
        model: string;
        result_json: string | null;
        created_at: string;
      }>(
        env.DB,
        `SELECT provider, model, result_json, created_at
           FROM extraction_runs
          WHERE doc_id = ? AND ok = 1
          ORDER BY created_at DESC`,
        [docId],
      );
      const latest = new Map<string, ParsedTx[]>();
      for (const row of runRows) {
        const id = `${row.provider}:${row.model}`;
        if (latest.has(id)) continue;
        const rows = prepareExtractedRows(parseRows(row.result_json)).map((tx) => {
          const resolved = resolver(tx.ticker, tx.assetName);
          return resolved ? { ...tx, ticker: resolved } : tx;
        });
        if (rows.length > 0) latest.set(id, rows);
      }
      const reads = [...latest.entries()]
        .map(([model, modelRows]) => asRead(docId, model, modelRows))
        .map((read) => qualityGateAgreementRead(read))
        .filter((read): read is NonNullable<ReturnType<typeof qualityGateAgreementRead>> => read != null);
      if (reads.length < 1) {
        out.skipped += 1;
        continue;
      }

      // Stored-only sweep: lineup is empty; quality survivors are stored evidence
      // so decideAgreementPublish admits the single-survivor (>=1) publish path.
      const decision = decideAgreementPublish([], reads, true);
      const parsed = decision.action === 'publish' ? decision.rows : null;
      if (!parsed || parsed.length === 0) {
        out.skipped += 1;
        continue;
      }

      const frow = await loadFilingRow(env, docId);
      if (!frow) {
        out.skipped += 1;
        continue;
      }
      const res = await finalizePublish(env, frow, docId, parsed, false, {
        tier: 3,
        models: Object.fromEntries(reads.map((r, i) => [String.fromCharCode(97 + i), r.model])),
        unanimous: false,
      });
      if (res.outcome === 'published') {
        out.published += 1;
        await recordIngestionDecision(env.DB, {
          docId,
          source: 'pipeline',
          action: 'auto_published',
          reason: 'stored_run_consensus',
          payload: { models: reads.map((r) => r.model), rowCount: parsed.length },
        }).catch(() => undefined);
      } else {
        out.skipped += 1;
      }
    } catch (err) {
      out.failed += 1;
      console.warn('storedRunPublish failed for', docId, (err as Error).message);
    }
  }

  if (out.scanned > 0) {
    console.log('storedRunPublish:', JSON.stringify(out));
  }
  return out;
}
