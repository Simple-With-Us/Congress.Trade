/**
 * Republish-never-resends for admin manual decisions (POST /review/:docId,
 * the default for any previously published filing; there is no flag) plus the admin-side halves of the pipeline hardening (GB-Publisher):
 * junk asset names, off-by-one bracket lower bounds, and the after-filing
 * date window.
 *
 * The correction tests run the real route against a real SQLite database with
 * every migration applied, so the revive UPDATE ... FROM, the partial unique
 * row_key index, the cursor_seq trigger and the outbox insert all execute.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { buildAdminRouter } from '../routes.ts';
import { latestLiveSet, planCorrection, type CorrectionEdit, type PriorTxRow } from '../reviewCorrection.ts';
import { openMigratedD1, type SqliteDatabase } from '../../prices/__tests__/sqliteD1.ts';

const app = buildAdminRouter();
const AUTH = { Authorization: 'Bearer admin-secret', 'content-type': 'application/json' };
const DOC = 'E-2026-donald-j-trump-09-8-2026-278t';
const DEPRECATED_AT = '2026-10-25T20:00:00.000Z';
const OLDER_DEPRECATED_AT = '2026-09-30T20:00:00.000Z';

// ---------------------------------------------------------------------------
// planCorrection (pure)
// ---------------------------------------------------------------------------

const prior = (over: Partial<PriorTxRow> & { id: string }): PriorTxRow => ({
  tx_date: '2026-07-29',
  owner: null,
  asset_name: 'Badger Meter Inc.',
  ticker: null,
  tx_type: 'S',
  amount_min: 50001,
  amount_max: 100000,
  deprecated_at: DEPRECATED_AT,
  ...over,
});
const edit = (over: Partial<CorrectionEdit> = {}): CorrectionEdit => ({
  txDate: '2026-07-29',
  owner: null,
  assetName: 'BADGER METER INC',
  ticker: null,
  txType: 'S',
  amountMin: 50001,
  amountMax: 100000,
  ...over,
});

describe('planCorrection', () => {
  it('matches unchanged rows across case/punctuation and date-fixed rows as corrections', () => {
    const plan = planCorrection(
      [
        edit({ assetName: 'PLEXUS CORP', amountMin: 15001, amountMax: 50000 }),
        edit({ assetName: 'BADGER METER INC', txDate: '2026-07-29' }),
        edit({ assetName: 'AT&T INC', txType: 'B', txDate: '2026-07-17', amountMin: 1001, amountMax: 15000 }),
      ],
      [
        prior({ id: 'plexus', asset_name: 'Plexus Corp.', amount_min: 15001, amount_max: 50000 }),
        prior({ id: 'badger', asset_name: 'Badger Meter Inc.', tx_date: '1202-07-02' }),
        prior({ id: 'oracle', asset_name: 'Oracle Corporation', tx_type: 'S', amount_min: 250001, amount_max: 500000 }),
      ],
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.matches).toEqual([
      { editIndex: 0, txId: 'plexus', kind: 'unchanged' },
      { editIndex: 1, txId: 'badger', kind: 'corrected' },
    ]);
    expect(plan.added).toEqual([2]);
    expect(plan.retired).toEqual(['oracle']);
  });

  it('leaves ambiguous same-asset lots unmatched instead of guessing', () => {
    const plan = planCorrection(
      [edit({ txDate: '2026-07-08' }), edit({ txDate: '2026-07-09' })],
      [prior({ id: 'a', tx_date: '1202-07-02' }), prior({ id: 'b', tx_date: '1202-07-03' })],
    );
    expect(plan.ok && plan.matches).toEqual([]);
    expect(plan.ok && plan.added).toEqual([0, 1]);
  });

  it('honours an explicit correctsTxId, including a row from an older cycle', () => {
    const plan = planCorrection(
      [edit({ assetName: 'TELEFLEX INC', correctsTxId: 'old-cycle' })],
      [prior({ id: 'old-cycle', asset_name: 'Eleflex Inc.', deprecated_at: OLDER_DEPRECATED_AT }), prior({ id: 'live' })],
    );
    expect(plan.ok && plan.matches).toEqual([{ editIndex: 0, txId: 'old-cycle', kind: 'explicit' }]);
  });

  it('rejects an unknown or doubly-claimed correctsTxId', () => {
    const unknown = planCorrection([edit({ correctsTxId: 'nope' })], [prior({ id: 'a' })]);
    expect(unknown).toMatchObject({ ok: false });
    const twice = planCorrection(
      [edit({ correctsTxId: 'a' }), edit({ correctsTxId: 'a' })],
      [prior({ id: 'a' })],
    );
    expect(twice).toMatchObject({ ok: false });
  });

  it('revives an unchanged trade from an older publish cycle instead of re-sending it', () => {
    expect(latestLiveSet([prior({ id: 'old', deprecated_at: OLDER_DEPRECATED_AT }), prior({ id: 'new' })]).map((r) => r.id))
      .toEqual(['new']);
    // The identical trade was delivered in an older cycle only; it must come
    // back under its old id, never as a new (alerting) row.
    const plan = planCorrection(
      [edit()],
      [prior({ id: 'old', deprecated_at: OLDER_DEPRECATED_AT }), prior({ id: 'new', asset_name: 'Oracle Corporation' })],
    );
    expect(plan.ok && plan.matches).toEqual([{ editIndex: 0, txId: 'old', kind: 'unchanged_older_cycle' }]);
    expect(plan.ok && plan.added).toEqual([]);
    expect(plan.ok && plan.retired).toEqual(['new']);
  });

  it('prefers the latest cycle over an older one for an unchanged trade', () => {
    const plan = planCorrection(
      [edit()],
      [prior({ id: 'old', deprecated_at: OLDER_DEPRECATED_AT }), prior({ id: 'new' })],
    );
    expect(plan.ok && plan.matches).toEqual([{ editIndex: 0, txId: 'new', kind: 'unchanged' }]);
  });

  it('does not fuzzy-correct against an older cycle', () => {
    // Same asset with a changed date exists only in an older cycle: that is
    // not a safe "corrected" pairing, so the edit is a new row.
    const plan = planCorrection(
      [edit({ txDate: '2026-07-30' })],
      [prior({ id: 'old', deprecated_at: OLDER_DEPRECATED_AT }), prior({ id: 'new', asset_name: 'Oracle Corporation' })],
    );
    expect(plan.ok && plan.added).toEqual([0]);
  });

  it('treats a first publish (no prior rows) as all new', () => {
    const plan = planCorrection([edit(), edit({ assetName: 'PLEXUS CORP' })], []);
    expect(plan).toEqual({ ok: true, matches: [], added: [0, 1], retired: [] });
  });
});

// ---------------------------------------------------------------------------
// Route against real SQLite
// ---------------------------------------------------------------------------

let closeDb: (() => void) | null = null;
afterEach(() => {
  closeDb?.();
  closeDb = null;
});

async function seededDb() {
  const { db, d1, close } = await openMigratedD1();
  closeDb = close;
  db.prepare(
    `INSERT INTO filings (doc_id, chamber, filer_id, filing_type, filed_date, ingest_status, first_seen_at)
     VALUES (?, 'executive', 'EXEC-DJT', 'P', '2026-09-08', 'needs_review', '2026-09-22T12:14:00.001Z')`,
  ).run(DOC);
  db.prepare(
    `INSERT INTO review_queue (doc_id, reason, payload, created_at, resolved, review_revision)
     VALUES (?, 'unpublished: correction', NULL, '2026-10-25T20:00:00.000Z', 0, 3)`,
  ).run(DOC);
  const insertTx = db.prepare(
    `INSERT INTO transactions (id, doc_id, filer_id, tx_date, owner, asset_name, ticker, tx_type,
       amount_min, amount_max, is_option, cap_gains_over_200, raw_text, confidence, source, row_key,
       created_at, deprecated_at, deprecated_reason)
     VALUES (?, ?, 'EXEC-DJT', ?, NULL, ?, NULL, ?, ?, ?, 0, 0, '', 1, 'manual', ?, ?, ?, 'unpublished: correction')`,
  );
  const insertOutbox = db.prepare(
    `INSERT INTO delivery_outbox (tx_id, status, attempts, available_at, created_at, updated_at)
     VALUES (?, 'completed', 1, '2026-09-25T02:37:34.062Z', '2026-09-25T02:37:34.062Z', '2026-09-25T02:37:35.000Z')`,
  );
  const seed = [
    ['tx-plexus', '2026-07-29', 'Plexus Corp.', 'S', 15001, 50000],
    ['tx-badger', '1202-07-02', 'Badger Meter Inc.', 'S', 50001, 100000],
    ['tx-oracle', '2026-07-20', 'Oracle Corporation', 'S', 250001, 500000],
  ] as const;
  for (const [i, [id, date, name, type, min, max]] of seed.entries()) {
    insertTx.run(id, DOC, date, name, type, min, max, `v1:manual:${i}:seed`, '2026-09-25T02:37:34.062Z', DEPRECATED_AT);
    insertOutbox.run(id);
  }
  return { db, d1 };
}

function env(d1: unknown) {
  return {
    ADMIN_TOKEN: 'admin-secret',
    DB: d1,
    DELIVERY_QUEUE: { send: async () => {}, sendBatch: async () => {} },
  } as never;
}

const RepublishSummary = z.object({
  revived: z.number(),
  unchanged: z.number(),
  unchangedOlderCycle: z.number(),
  corrected: z.number(),
  explicit: z.number(),
  added: z.number(),
  retired: z.number(),
  correctedTxIds: z.array(z.string()),
  retiredTxIds: z.array(z.string()),
});
const ReviewResponse = z.object({
  error: z.string().optional(),
  republish: RepublishSummary.optional(),
}).passthrough();

async function post(d1: unknown, body: Record<string, unknown>) {
  const res = await app.request(`/review/${DOC}`, { method: 'POST', headers: AUTH, body: JSON.stringify(body) }, env(d1));
  return { status: res.status, body: ReviewResponse.parse(await res.json()) };
}

function undeliveredCount(db: SqliteDatabase): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM delivery_outbox WHERE status <> 'completed'").get() as { n: number }).n;
}

const EDITS = [
  { assetName: 'PLEXUS CORP', ticker: null, txType: 'S', txDate: '2026-07-29', owner: null, amountMin: 15001, amountMax: 50000, rawText: '#518 PLEXUS CORP sale 7/29/2026 No $15,001 - $50,000' },
  { assetName: 'BADGER METER INC', ticker: null, txType: 'S', txDate: '2026-07-29', owner: null, amountMin: 50001, amountMax: 100000, rawText: '#661 BADGER METER INC sale 7/29/2026 No $50,001 - $100,000' },
  { assetName: 'AT&T INC', ticker: null, txType: 'B', txDate: '2026-07-17', owner: null, amountMin: 1001, amountMax: 15000, rawText: '#77 AT&T INC purchase 7/17/2026 No $1,001 - $15,000' },
];

function live(db: SqliteDatabase) {
  return db.prepare(
    `SELECT id, tx_date, asset_name, cursor_seq, created_at, deprecated_at FROM transactions
      WHERE doc_id = ? AND deprecated_at IS NULL ORDER BY id`,
  ).all(DOC) as Array<Record<string, unknown>>;
}

describe('POST /review/:docId — republish never re-sends', () => {
  it('by default revives matching rows in place and only enqueues delivery for added rows', async () => {
    const { db, d1 } = await seededDb();
    const before = new Map(
      (db.prepare('SELECT id, cursor_seq, created_at FROM transactions WHERE doc_id = ?').all(DOC) as Array<Record<string, unknown>>)
        .map((r) => [r.id, r]),
    );
    // No flag of any kind: correction semantics are the default.
    const { status, body } = await post(d1, { decision: 'manual', reviewRevision: 3, edits: EDITS });
    expect(status).toBe(200);
    expect(body.republish).toMatchObject({ revived: 2, unchanged: 1, corrected: 1, explicit: 0, added: 1, retired: 1 });
    expect(body.republish?.retiredTxIds).toEqual(['tx-oracle']);

    const rows = live(db);
    expect(rows).toHaveLength(3);
    const byId = new Map(rows.map((r) => [r.id, r]));
    // Stable identity: same id, cursor_seq and created_at; corrected fields.
    for (const id of ['tx-plexus', 'tx-badger']) {
      expect(byId.get(id)?.cursor_seq).toBe(before.get(id)?.cursor_seq);
      expect(byId.get(id)?.created_at).toBe(before.get(id)?.created_at);
    }
    expect(byId.get('tx-badger')?.tx_date).toBe('2026-07-29');
    expect(byId.get('tx-plexus')?.asset_name).toBe('PLEXUS CORP');
    expect(byId.has('tx-oracle')).toBe(false);

    // Delivery: the revived rows keep their completed outbox rows; only the
    // added row gets a new one.
    const outbox = db.prepare('SELECT tx_id, status FROM delivery_outbox ORDER BY tx_id').all() as Array<{ tx_id: string; status: string }>;
    const added = rows.find((r) => !['tx-plexus', 'tx-badger'].includes(String(r.id)))!;
    expect(outbox.filter((o) => o.status === 'completed').map((o) => o.tx_id).sort()).toEqual(['tx-badger', 'tx-oracle', 'tx-plexus']);
    expect(outbox.filter((o) => o.status !== 'completed').map((o) => o.tx_id)).toEqual([added.id]);

    const review = db.prepare('SELECT resolved, resolution_reason FROM review_queue WHERE doc_id = ?').get(DOC) as Record<string, unknown>;
    expect(review).toMatchObject({ resolved: 1, resolution_reason: 'admin_manual' });
  });

  it('ignores a legacy correction: false field; matched rows still never re-enqueue', async () => {
    const { db, d1 } = await seededDb();
    const { status, body } = await post(d1, { decision: 'manual', reviewRevision: 3, correction: false, edits: EDITS });
    expect(status).toBe(200);
    expect(body.republish).toMatchObject({ revived: 2, added: 1 });
    expect(undeliveredCount(db)).toBe(1);
  });

  it('revives a trade delivered in an older cycle without re-enqueueing it', async () => {
    const { db, d1 } = await seededDb();
    // Plexus was last live two cycles ago; the latest Unpublish never saw it.
    db.prepare('UPDATE transactions SET deprecated_at = ? WHERE id = ?').run(OLDER_DEPRECATED_AT, 'tx-plexus');
    const { status, body } = await post(d1, { decision: 'manual', reviewRevision: 3, edits: [EDITS[0]] });
    expect(status).toBe(200);
    expect(body.republish).toMatchObject({ revived: 1, unchangedOlderCycle: 1, added: 0 });
    expect(live(db).map((r) => r.id)).toEqual(['tx-plexus']);
    expect(undeliveredCount(db)).toBe(0);
  });

  it('an all-revived republish skips the flush and leaves other filings\' pending rows alone', async () => {
    const { db, d1 } = await seededDb();
    // An unrelated filing's row waiting in the outbox.  flushDeliveryOutbox
    // with an empty id list would claim it.
    db.prepare(
      `INSERT INTO filings (doc_id, chamber, filer_id, filing_type, filed_date, ingest_status, first_seen_at)
       VALUES ('H-2026-OTHER', 'house', 'H-OTHER', 'P', '2026-10-20', 'published', '2026-10-20T12:00:00.000Z')`,
    ).run();
    db.prepare(
      `INSERT INTO transactions (id, doc_id, filer_id, tx_date, owner, asset_name, ticker, tx_type,
         amount_min, amount_max, is_option, cap_gains_over_200, raw_text, confidence, source, row_key, created_at)
       VALUES ('tx-other', 'H-2026-OTHER', 'H-OTHER', '2026-10-01', NULL, 'Apple Inc.', 'AAPL', 'P',
         1001, 15000, 0, 0, '', 1, 'pdf', 'v1:pdf:0:other', '2026-10-20T12:00:00.000Z')`,
    ).run();
    db.prepare(
      `INSERT INTO delivery_outbox (tx_id, status, attempts, available_at, created_at, updated_at)
       VALUES ('tx-other', 'pending', 0, '2026-10-20T12:00:00.000Z', '2026-10-20T12:00:00.000Z', '2026-10-20T12:00:00.000Z')`,
    ).run();
    const { status, body } = await post(d1, { decision: 'manual', reviewRevision: 3, edits: EDITS.slice(0, 2) });
    expect(status).toBe(200);
    expect(body.republish).toMatchObject({ revived: 2, added: 0 });
    expect(body.delivery ?? null).toBeNull();
    const other = db.prepare("SELECT status, attempts FROM delivery_outbox WHERE tx_id = 'tx-other'").get();
    expect(other).toEqual({ status: 'pending', attempts: 0 });
  });

  it('a first publish (no prior rows) inserts and enqueues every row', async () => {
    const { db, d1 } = await seededDb();
    db.prepare('DELETE FROM delivery_outbox').run();
    db.prepare('DELETE FROM transactions WHERE doc_id = ?').run(DOC);
    const { status, body } = await post(d1, { decision: 'manual', reviewRevision: 3, edits: EDITS });
    expect(status).toBe(200);
    expect(body.republish).toMatchObject({ revived: 0, added: 3, retired: 0 });
    expect(live(db)).toHaveLength(3);
    expect(undeliveredCount(db)).toBe(3);
  });

  it('validates correctsTxId', async () => {
    const { d1 } = await seededDb();
    const unknown = await post(d1, { decision: 'manual', reviewRevision: 3, edits: [{ ...EDITS[0], correctsTxId: 'tx-nope' }] });
    expect(unknown.status).toBe(400);
    expect(String(unknown.body.error)).toContain('correctsTxId');
    const explicit = await post(d1, { decision: 'manual', reviewRevision: 3, edits: [{ ...EDITS[2], correctsTxId: 'tx-oracle' }] });
    expect(explicit.status).toBe(200);
    expect(explicit.body.republish).toMatchObject({ explicit: 1, revived: 1, added: 0 });
  });
});

describe('POST /review/:docId — hardened edit validation', () => {
  it('rejects a junk-led asset name', async () => {
    const { d1 } = await seededDb();
    const res = await post(d1, { decision: 'manual', reviewRevision: 3, edits: [{ ...EDITS[0], assetName: '••• PLEXUS CORP' }] });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toContain('edits[0].assetName');
  });

  it('rejects a trade dated more than 31 days after the filing', async () => {
    const { d1 } = await seededDb();
    const res = await post(d1, { decision: 'manual', reviewRevision: 3, edits: [{ ...EDITS[0], txDate: '2026-10-20' }] });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toContain('after the filing date');
  });

  it('stores $1,000-$15,000 as the canonical $1,001-$15,000 bracket', async () => {
    const { db, d1 } = await seededDb();
    const res = await post(d1, {
      decision: 'manual',
      reviewRevision: 3,
      edits: [{ ...EDITS[2], amountMin: 1000, amountMax: 15000 }],
      acknowledgeUnderTranscription: true,
    });
    expect(res.status).toBe(200);
    const row = db.prepare('SELECT amount_min, amount_max FROM transactions WHERE doc_id = ? AND deprecated_at IS NULL').get(DOC);
    expect(row).toEqual({ amount_min: 1001, amount_max: 15000 });
  });
});
