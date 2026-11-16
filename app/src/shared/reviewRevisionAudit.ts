import { run } from './db.ts';
import { uuid } from './ids.ts';

export interface ReviewRevisionAuditInput {
  docId: string;
  /** review_revision value this event describes (unchanged for identical no-ops). */
  revision: number;
  trigger: string;
  contentHash?: string | null;
  detail?: Record<string, unknown> | null;
  createdAt?: string;
}

/**
 * Append one row to review_revision_audit. Failures are logged and swallowed so
 * publication paths never fail closed on audit writes.
 */
export async function recordReviewRevisionAudit(
  db: D1Database,
  input: ReviewRevisionAuditInput,
): Promise<void> {
  const createdAt = input.createdAt ?? new Date().toISOString();
  try {
    await run(
      db,
      `INSERT INTO review_revision_audit
         (id, doc_id, revision, trigger, content_hash, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        uuid(),
        input.docId,
        input.revision,
        input.trigger,
        input.contentHash ?? null,
        input.detail ? JSON.stringify(input.detail) : null,
        createdAt,
      ],
    );
  } catch (err) {
    console.error(
      'review_revision_audit write failed',
      input.docId,
      input.trigger,
      (err as Error).message,
    );
  }
}
