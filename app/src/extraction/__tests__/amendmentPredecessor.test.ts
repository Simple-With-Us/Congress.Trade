/**
 * src/extraction/__tests__/amendmentPredecessor.test.ts
 *
 * CT-2452 (P1): publishing an amended filing must supersede ONLY the filing
 * that amendment actually amends.
 *
 * The old rule ("same filer + same filed_date, or a shared doc-id prefix")
 * deprecated every sibling PTR filed on the same day, so publishing the July
 * 2025 Trump 278-T amendment soft-deprecated 545 real transactions (the Jan-Jun
 * base and the Jul 25/Aug 1 third report) whose reporting periods are
 * DISJOINT from the amendment's.
 *
 * These cases are asserted on the resulting TRANSACTION ROWS, not on a log
 * line: a guard written without a matrix test is invisible on the next miss.
 * The fixture is the real 2025-08-12 Trump 278-T family:
 *
 *   278T.pdf              Jan 21 - Jun 13   (507 rows in prod)
 *   278T(2).pdf           Jul  1 - Jul  23   (the July PTR)
 *   278T(2) AMENDED.pdf   Jul  1 - Jul  23   (the amendment)
 *   278T(3).pdf           Jul 25 + Aug  1   (38 rows in prod)
 *
 * The row counts here are 2-3 per filing: the rule reads the periods, not the
 * counts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openMigratedD1 } from '../../prices/__tests__/sqliteD1.ts';
import { deprecatePredecessorFilingTransactions } from '../amendmentPredecessor.ts';

const FILER = 'EXEC-DONALD-J-TRUMP';
const FILED_0812 = '2025-08-12';
const NOW = '2026-10-26T00:19:00.813Z';

/** 278T.pdf — Jan 21 .. Jun 13. */
const BASE = 'E-2025-donald-j-trump-08-12-2025-278t';
/** 278T(2).pdf — Jul 1 .. Jul 23: the filing the July amendment amends. */
const JULY_PTR = 'E-2025-donald-j-trump-08-12-2025-278t-2';
/** 278T(2) AMENDED.pdf — Jul 1 .. Jul 23. */
const AMENDED = 'E-2025-donald-j-trump-08-12-2025-278t-2-amended';
/** 278T(3).pdf — Jul 25 + Aug 1. */
const THIRD = 'E-2025-donald-j-trump-08-12-2025-278t-3';
/** The same family filed a month earlier, with rows INSIDE the July period. */
const EARLIER_JULY = 'E-2025-donald-j-trump-07-12-2025-278t';

interface FixtureRow {
  date: string;
  asset: string;
}

const FIXTURE: Record<string, { filedDate: string; rows: FixtureRow[] }> = {
  [BASE]: {
    filedDate: FILED_0812,
    rows: [
      { date: '2025-01-21', asset: 'Alpha Corp' },
      { date: '2025-03-05', asset: 'Beta Inc' },
      { date: '2025-06-13', asset: 'Gamma LLC' },
    ],
  },
  [JULY_PTR]: {
    filedDate: FILED_0812,
    rows: [
      { date: '2025-07-01', asset: 'Delta Co' },
      { date: '2025-07-23', asset: 'Epsilon Ltd' },
    ],
  },
  [AMENDED]: {
    filedDate: FILED_0812,
    rows: [
      { date: '2025-07-02', asset: 'Delta Co' },
      { date: '2025-07-22', asset: 'Epsilon Ltd' },
    ],
  },
  [THIRD]: {
    filedDate: FILED_0812,
    rows: [
      { date: '2025-07-25', asset: 'Zeta Inc' },
      { date: '2025-08-01', asset: 'Eta Corp' },
    ],
  },
  [EARLIER_JULY]: {
    filedDate: '2025-07-12',
    rows: [
      { date: '2025-07-10', asset: 'Theta Ltd' },
      { date: '2025-07-20', asset: 'Iota Co' },
    ],
  },
};

describe('amendment predecessor rule (CT-2452)', () => {
  let db: Awaited<ReturnType<typeof openMigratedD1>>;

  beforeEach(async () => {
    db = await openMigratedD1();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });

  /** Seed the fixture filings and their transaction rows. */
  async function seed(docIds: string[] = Object.keys(FIXTURE)): Promise<void> {
    for (const docId of docIds) {
      const filing = FIXTURE[docId];
      await db.d1
        .prepare(
          `INSERT INTO filings (doc_id, chamber, filer_id, filing_type, filed_date,
                                 source_url, ingest_status, doc_kind, first_seen_at)
           VALUES (?, 'executive', ?, 'P', ?, ?, 'persisted', 'text_pdf', ?)`,
        )
        .bind(docId, FILER, filing.filedDate, `https://example.test/${docId}.pdf`, NOW)
        .run();
      for (const [index, row] of filing.rows.entries()) {
        await db.d1
          .prepare(
            `INSERT INTO transactions (id, doc_id, filer_id, tx_date, owner, asset_name,
                                       ticker, asset_type, tx_type, amount_min, amount_max,
                                       is_option, cap_gains_over_200, raw_text, confidence,
                                       source, created_at, filed_date)
             VALUES (?, ?, ?, ?, NULL, ?, ?, 'stock', 'B', 1001, 15000, 0, 0, ?, 0.9,
                     'primary', ?, ?)`,
          )
          .bind(
            `${docId}-row-${index}`,
            docId,
            FILER,
            row.date,
            row.asset,
            row.asset.slice(0, 4).toUpperCase(),
            `${row.asset} purchase`,
            NOW,
            filing.filedDate,
          )
          .run();
      }
    }
  }

  /** Live (not deprecated) row count for a filing. */
  async function liveRows(docId: string): Promise<number> {
    const row = await db.d1
      .prepare('SELECT COUNT(*) AS n FROM transactions WHERE doc_id = ? AND deprecated_at IS NULL')
      .bind(docId)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  /** Deprecated rows for a filing, with the reason they were deprecated. */
  async function deprecatedRows(docId: string): Promise<{ n: number; reason: string | null; at: string | null }> {
    const row = await db.d1
      .prepare(
        `SELECT COUNT(*) AS n, MIN(deprecated_reason) AS reason, MIN(deprecated_at) AS at
           FROM transactions WHERE doc_id = ? AND deprecated_at IS NOT NULL`,
      )
      .bind(docId)
      .first<{ n: number; reason: string | null; at: string | null }>();
    return { n: row?.n ?? 0, reason: row?.reason ?? null, at: row?.at ?? null };
  }

  it('(a) deprecates the true predecessor the amendment actually amends', async () => {
    await seed();

    const deprecated = await deprecatePredecessorFilingTransactions(
      db.d1 as never,
      AMENDED,
      FILER,
      FILED_0812,
      NOW,
    );

    expect(deprecated).toBe(2);
    expect(await liveRows(JULY_PTR)).toBe(0);
    const rows = await deprecatedRows(JULY_PTR);
    expect(rows.n).toBe(2);
    expect(rows.reason).toBe(`superseded by amendment ${AMENDED}`);
    expect(rows.at).toBe(NOW);
  });

  it('(b) leaves a same-filer, same-filed_date sibling with a DISJOINT period live', async () => {
    await seed();

    const deprecated = await deprecatePredecessorFilingTransactions(
      db.d1 as never,
      AMENDED,
      FILER,
      FILED_0812,
      NOW,
    );

    // Jan 21 - Jun 13 does not overlap the amendment's Jul 2 - Jul 22.
    expect(deprecated).toBe(2);
    expect(await liveRows(BASE)).toBe(3);
    expect((await deprecatedRows(BASE)).n).toBe(0);
  });

  it('(c) leaves a same-filer, same-filed_date sibling with NO amendment relationship live', async () => {
    await seed();

    await deprecatePredecessorFilingTransactions(db.d1 as never, AMENDED, FILER, FILED_0812, NOW);

    // Jul 25 + Aug 1 is a separate PTR, not the amended document.
    expect(await liveRows(THIRD)).toBe(2);
    expect((await deprecatedRows(THIRD)).n).toBe(0);
  });

  it('(d) leaves the same filer on a different filed_date live', async () => {
    await seed();

    await deprecatePredecessorFilingTransactions(db.d1 as never, AMENDED, FILER, FILED_0812, NOW);

    // Filed 2025-07-12 and its rows fall INSIDE the amendment's period, so
    // only the amended-document relationship protects it.
    expect(await liveRows(EARLIER_JULY)).toBe(2);
    expect((await deprecatedRows(EARLIER_JULY)).n).toBe(0);
  });

  it('(e) keeps the successor live and deprecates the predecessor exactly once', async () => {
    await seed();

    await deprecatePredecessorFilingTransactions(db.d1 as never, AMENDED, FILER, FILED_0812, NOW);
    const second = await deprecatePredecessorFilingTransactions(
      db.d1 as never,
      AMENDED,
      FILER,
      FILED_0812,
      NOW,
    );

    expect(second).toBe(0);
    expect(await liveRows(AMENDED)).toBe(2);
    expect((await deprecatedRows(AMENDED)).n).toBe(0);
    const rows = await deprecatedRows(JULY_PTR);
    expect(rows.n).toBe(2);
    expect(rows.at).toBe(NOW);
  });

  it('deprecates nothing when the amended filing was never ingested', async () => {
    // The incident shape: the July PTR (278T(2).pdf) was never ingested, so
    // the amendment has no document it is allowed to supersede.
    await seed([BASE, AMENDED, THIRD]);

    const deprecated = await deprecatePredecessorFilingTransactions(
      db.d1 as never,
      AMENDED,
      FILER,
      FILED_0812,
      NOW,
    );

    expect(deprecated).toBe(0);
    expect(await liveRows(BASE)).toBe(3);
    expect(await liveRows(THIRD)).toBe(2);
    expect(await liveRows(AMENDED)).toBe(2);
  });

  it('deprecates nothing for a doc id that carries no amendment marker', async () => {
    await seed();

    // A plain sibling PTR is not an amendment, whatever the trigger said.
    const deprecated = await deprecatePredecessorFilingTransactions(
      db.d1 as never,
      JULY_PTR,
      FILER,
      FILED_0812,
      NOW,
    );

    expect(deprecated).toBe(0);
    expect(await liveRows(JULY_PTR)).toBe(2);
    expect(await liveRows(AMENDED)).toBe(2);
    expect(await liveRows(BASE)).toBe(3);
    expect(await liveRows(THIRD)).toBe(2);
  });
});
