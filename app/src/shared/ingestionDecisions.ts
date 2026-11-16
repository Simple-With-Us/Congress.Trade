import { all, parseJson, run, type SqlParam } from './db.ts';
import { uuid } from './ids.ts';

export type IngestionDecisionAction =
  | 'auto_published'
  | 'review_opened'
  | 'confirmed'
  | 'manual'
  | 'rejected'
  | 'reopened_after_reject'
  | 'unpublished'
  | 'auto_retry_requested'
  | 'agreement_published'
  /** Runtime provider-health overlay substituted a blocked slot's model. */
  | 'provider_substituted'
  /** Autopilot auto-resolved a doc_class='empty' review item (no transactions). */
  | 'auto_resolved_empty'
  /** Autopilot quarantined a doc_class='corrupt' review item (cascade suppressed). */
  | 'doc_quarantined'
  /**
   * Agreement/pipeline total extract failure: successful model reads returned
   * zero rows (empty×empty). Loud hard-fail — not soft cascade_unresolved.
   */
  | 'extract_empty_failure'
  /**
   * Executive 278-T whose text layer could not be read.  Parked for a human.
   * Not a terminal reject: the same reason hid real rows on the Sep 8 Trump
   * filing.  Counted by the filing-skip alarm.
   */
  | 'oge_text_unreadable';

/** Ingestion-decision action for a parked unreadable executive 278-T. */
export const OGE_TEXT_UNREADABLE_DECISION_ACTION = 'oge_text_unreadable' as const;

export type IngestionDecisionSource = 'pipeline' | 'admin' | 'agreement';

export interface IngestionDecisionInput {
  docId: string;
  action: IngestionDecisionAction;
  source: IngestionDecisionSource;
  actor?: string | null;
  reason?: string | null;
  payload?: Record<string, unknown> | null;
  transactionIds?: string[];
  createdAt?: string;
}

interface IngestionDecisionRow {
  id: string;
  doc_id: string;
  action: string;
  source: string;
  actor: string | null;
  reason: string | null;
  payload: string | null;
  transaction_ids: string | null;
  created_at: string;
  chamber?: string | null;
  ingest_status?: string | null;
  source_url?: string | null;
  raw_object_key?: string | null;
}

export interface ListedIngestionDecision {
  id: string;
  docId: string;
  action: string;
  source: string;
  actor: string | null;
  reason: string | null;
  payload: Record<string, unknown> | null;
  transactionIds: string[];
  createdAt: string;
  chamber: string | null;
  ingestStatus: string | null;
  sourceUrl: string | null;
  /** Present when filings.raw_object_key is set — UI opens stored copy only. */
  rawObjectKey: string | null;
  /** Admin stored-raw path (never a government URL). */
  storedDocumentUrl: string | null;
}

/**
 * Best-effort audit write. The decision trail should never block ingestion or
 * admin remediation if a deployment reaches code before the D1 migration.
 */
export async function recordIngestionDecision(
  db: D1Database,
  input: IngestionDecisionInput,
): Promise<string | null> {
  const id = uuid();
  const createdAt = input.createdAt ?? new Date().toISOString();
  try {
    await run(
      db,
      `INSERT INTO ingestion_decisions
         (id, doc_id, action, source, actor, reason, payload, transaction_ids, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.docId,
        input.action,
        input.source,
        input.actor ?? null,
        input.reason ?? null,
        input.payload ? JSON.stringify(input.payload) : null,
        JSON.stringify(input.transactionIds ?? []),
        createdAt,
      ],
    );
    return id;
  } catch (err) {
    console.warn(
      'ingestion decision audit write skipped:',
      input.docId,
      input.action,
      (err as Error).message,
    );
    return null;
  }
}

export async function listIngestionDecisions(
  db: D1Database,
  opts: { limit?: number; docId?: string | null } = {},
): Promise<ListedIngestionDecision[]> {
  const requestedLimit = Number.isFinite(opts.limit) ? Math.floor(opts.limit as number) : 100;
  const limit = Math.min(Math.max(requestedLimit, 1), 200);
  const where: string[] = [];
  const params: SqlParam[] = [];
  if (opts.docId) {
    where.push('d.doc_id = ?');
    params.push(opts.docId);
  }
  params.push(limit);

  const rows = await all<IngestionDecisionRow>(
    db,
    `SELECT
        d.id, d.doc_id, d.action, d.source, d.actor, d.reason, d.payload,
        d.transaction_ids, d.created_at,
        f.chamber, f.ingest_status, f.source_url, f.raw_object_key
       FROM ingestion_decisions d
       LEFT JOIN filings f ON f.doc_id = d.doc_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY d.created_at DESC
       LIMIT ?`,
    params,
  );

  return rows.map((row) => {
    const rawKey = row.raw_object_key ?? null;
    return {
      id: row.id,
      docId: row.doc_id,
      action: row.action,
      source: row.source,
      actor: row.actor ?? null,
      reason: row.reason ?? null,
      payload: parseJson<Record<string, unknown> | null>(row.payload, null),
      transactionIds: parseJson<string[]>(row.transaction_ids, []),
      createdAt: row.created_at,
      chamber: row.chamber ?? null,
      ingestStatus: row.ingest_status ?? null,
      // Metadata only — admin UI must not navigate here for document open.
      sourceUrl: row.source_url ?? null,
      rawObjectKey: rawKey,
      storedDocumentUrl: row.doc_id
        ? `/api/admin/filings/${encodeURIComponent(row.doc_id)}/raw`
        : null,
    };
  });
}
