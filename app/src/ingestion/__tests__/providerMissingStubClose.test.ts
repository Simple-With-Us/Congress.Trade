import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'libsql';
import { d1Database } from '../../prices/__tests__/sqliteD1.ts';
import { runMigrations } from '../../admin/migrations.ts';
import type { Env } from '../../shared/types.ts';
import {
  providerStubReviewPayload,
  routeProviderOnlyObservationsToReview,
  type DisclosureProviderRow,
} from '../tradeLatency.ts';
import {
  closeProviderMissingStubIfOfficialPersisted,
  enqueueOfficialSenateFromProviderObservation,
  reconcileProviderMissingStubsWithOfficial,
  findPersistedOfficialCounterpartForObservation,
  senateOfficialDocIdFromProvider,
} from '../providerMissingStubClose.ts';
import { sweepProviderOnlyReviewStubs } from '../autonomySweeps.ts';

const { notifySpy } = vi.hoisted(() => ({ notifySpy: vi.fn(async () => undefined) }));
vi.mock('../reviewQueueNotify.ts', () => ({ notifyReviewQueuePublisher: notifySpy }));

const SENATE_UUID = '51455bcd-4966-4e77-b481-09897ada81ae';
const OFFICIAL_SENATE_ID = `S-${SENATE_UUID}`;
const STUB_SENATE_ID = `provider-missing-fmp-senate-${SENATE_UUID}`;
const SOURCE_URL = `https://efdsearch.senate.gov/search/view/ptr/${SENATE_UUID}/`;

function senateObservation(over: Partial<DisclosureProviderRow> = {}): DisclosureProviderRow {
  return {
    provider: 'fmp',
    chamber: 'senate',
    providerKey: SENATE_UUID,
    tradeHash: 'tuberville_VEA_2025-11-21_sell',
    payload: { ticker: 'VEA', type: 'Sale' },
    sourceUrl: SOURCE_URL,
    filedDate: '2025-11-21',
    filerName: 'Tommy Tuberville',
    providerPublishedAt: '2026-08-25T10:00:00.000Z',
    ...over,
  };
}

describe('providerMissingStubClose', () => {
  let fileDb: Database.Database;
  let d1: ReturnType<typeof d1Database>;

  function makeEnv(): Env {
    return {
      DB: d1,
      INGEST_QUEUE: { send: async () => undefined, sendBatch: async () => undefined },
    } as unknown as Env;
  }

  beforeEach(async () => {
    fileDb = new Database(':memory:');
    d1 = d1Database(fileDb);
    await runMigrations(d1);
  });

  afterEach(() => {
    fileDb.close();
  });

  async function seedFiling(docId: string, ingestStatus: string, sourceUrl?: string | null) {
    await d1.prepare(
      `INSERT INTO filings (doc_id, chamber, ingest_status, filing_type, first_seen_at, source_url)
       VALUES (?, ?, ?, 'P', '2026-08-25T00:00:00.000Z', ?)`,
    ).bind(
      docId,
      docId.startsWith('S-') ? 'senate' : docId.startsWith('H-') ? 'house' : 'senate',
      ingestStatus,
      sourceUrl ?? null,
    ).run();
  }

  async function seedStubReview(stubDocId: string) {
    await seedFiling(stubDocId, 'needs_review');
    await d1.prepare(
      `INSERT INTO review_queue (doc_id, reason, payload, created_at, resolved, review_revision)
       VALUES (?, 'provider_discovered_missing_official', '{}', '2026-08-25T00:00:00.000Z', 0, 1)`,
    ).bind(stubDocId).run();
  }

  async function seedOfficialTx(docId: string) {
    await d1.prepare(
      `INSERT INTO transactions (id, doc_id, filer_id, tx_date, tx_type, source, owner, asset_name)
       VALUES (?, ?, 'senate-tuberville', '2025-11-21', 'S', 'primary', 'joint', 'VEA')`,
    ).bind(`tx-${docId}`, docId).run();
  }

  it('finds persisted Senate official by S-{providerKey}', async () => {
    await seedFiling(OFFICIAL_SENATE_ID, 'persisted', SOURCE_URL);
    const official = await findPersistedOfficialCounterpartForObservation(d1, senateObservation());
    expect(official).toBe(OFFICIAL_SENATE_ID);
  });

  it('does not treat in-pipeline official as persisted counterpart', async () => {
    await seedFiling(OFFICIAL_SENATE_ID, 'classified', SOURCE_URL);
    const official = await findPersistedOfficialCounterpartForObservation(d1, senateObservation());
    expect(official).toBeNull();
  });

  it('auto-rejects open provider-missing stub when official is persisted', async () => {
    await seedOfficialTx(OFFICIAL_SENATE_ID);
    await seedFiling(OFFICIAL_SENATE_ID, 'persisted', SOURCE_URL);
    await seedStubReview(STUB_SENATE_ID);

    const nowIso = '2026-08-25T12:00:00.000Z';
    const result = await closeProviderMissingStubIfOfficialPersisted(
      makeEnv(),
      senateObservation(),
      STUB_SENATE_ID,
      nowIso,
    );

    expect(result.closed).toBe(true);
    expect(result.officialDocId).toBe(OFFICIAL_SENATE_ID);

    const review = await d1.prepare(
      'SELECT resolved, resolution_kind, resolution_reason FROM review_queue WHERE doc_id = ?',
    ).bind(STUB_SENATE_ID).first<{
      resolved: number;
      resolution_kind: string;
      resolution_reason: string;
    }>();
    expect(review?.resolved).toBe(1);
    expect(review?.resolution_kind).toBe('rejected');
    expect(review?.resolution_reason).toContain(OFFICIAL_SENATE_ID);

    const stubFiling = await d1.prepare(
      'SELECT ingest_status FROM filings WHERE doc_id = ?',
    ).bind(STUB_SENATE_ID).first<{ ingest_status: string }>();
    expect(stubFiling?.ingest_status).toBe('error');

    const officialTxCount = await d1.prepare(
      'SELECT COUNT(*) AS n FROM transactions WHERE doc_id = ? AND deprecated_at IS NULL',
    ).bind(OFFICIAL_SENATE_ID).first<{ n: number }>();
    expect(officialTxCount?.n).toBe(1);

    const stubTxCount = await d1.prepare(
      'SELECT COUNT(*) AS n FROM transactions WHERE doc_id = ?',
    ).bind(STUB_SENATE_ID).first<{ n: number }>();
    expect(stubTxCount?.n).toBe(0);
  });

  it('reclassifies a stub the hourly sweep closed once the official filing persists', async () => {
    await seedStubReview(STUB_SENATE_ID);
    const swept = await sweepProviderOnlyReviewStubs(makeEnv());
    expect(swept.cleared).toBe(1);
    const sweptFiling = await d1.prepare(
      'SELECT ingest_status FROM filings WHERE doc_id = ?',
    ).bind(STUB_SENATE_ID).first<{ ingest_status: string }>();
    expect(sweptFiling?.ingest_status).toBe('verified_empty');

    await seedOfficialTx(OFFICIAL_SENATE_ID);
    await seedFiling(OFFICIAL_SENATE_ID, 'persisted', SOURCE_URL);

    const result = await closeProviderMissingStubIfOfficialPersisted(
      makeEnv(),
      senateObservation(),
      STUB_SENATE_ID,
      '2026-08-26T12:00:00.000Z',
    );
    expect(result.closed).toBe(true);
    expect(result.officialDocId).toBe(OFFICIAL_SENATE_ID);

    const review = await d1.prepare(
      'SELECT resolved, resolution_kind, resolution_reason FROM review_queue WHERE doc_id = ?',
    ).bind(STUB_SENATE_ID).first<{
      resolved: number;
      resolution_kind: string;
      resolution_reason: string;
    }>();
    expect(review?.resolved).toBe(1);
    expect(review?.resolution_kind).toBe('rejected');
    expect(review?.resolution_reason).toContain(OFFICIAL_SENATE_ID);

    const stubFiling = await d1.prepare(
      'SELECT ingest_status FROM filings WHERE doc_id = ?',
    ).bind(STUB_SENATE_ID).first<{ ingest_status: string }>();
    expect(stubFiling?.ingest_status).toBe('error');

    const again = await closeProviderMissingStubIfOfficialPersisted(
      makeEnv(),
      senateObservation(),
      STUB_SENATE_ID,
      '2026-08-26T13:00:00.000Z',
    );
    expect(again.closed).toBe(false);
  });

  it('does not override a stub resolution that did not come from the sweep', async () => {
    await seedFiling(STUB_SENATE_ID, 'verified_empty');
    await d1.prepare(
      `INSERT INTO review_queue (doc_id, reason, payload, created_at, resolved, resolution_kind, resolution_reason, review_revision)
       VALUES (?, 'provider_discovered_missing_official', '{}', '2026-08-25T00:00:00.000Z', 1, 'verified_empty', 'reviewer: checked by hand', 2)`,
    ).bind(STUB_SENATE_ID).run();
    await seedOfficialTx(OFFICIAL_SENATE_ID);
    await seedFiling(OFFICIAL_SENATE_ID, 'persisted', SOURCE_URL);

    const result = await closeProviderMissingStubIfOfficialPersisted(
      makeEnv(),
      senateObservation(),
      STUB_SENATE_ID,
      '2026-08-26T12:00:00.000Z',
    );
    expect(result.closed).toBe(false);
    const review = await d1.prepare(
      'SELECT resolution_kind, resolution_reason FROM review_queue WHERE doc_id = ?',
    ).bind(STUB_SENATE_ID).first<{ resolution_kind: string; resolution_reason: string }>();
    expect(review?.resolution_kind).toBe('verified_empty');
    expect(review?.resolution_reason).toBe('reviewer: checked by hand');
  });

  it('leaves stub pending when official is not persisted yet', async () => {
    await seedFiling(OFFICIAL_SENATE_ID, 'extracted', SOURCE_URL);
    await seedStubReview(STUB_SENATE_ID);

    const result = await closeProviderMissingStubIfOfficialPersisted(
      makeEnv(),
      senateObservation(),
      STUB_SENATE_ID,
      '2026-08-25T12:00:00.000Z',
    );

    expect(result.closed).toBe(false);
    expect(result.officialDocId).toBeUndefined();

    const review = await d1.prepare(
      'SELECT resolved FROM review_queue WHERE doc_id = ?',
    ).bind(STUB_SENATE_ID).first<{ resolved: number }>();
    expect(review?.resolved).toBe(0);

    const stubFiling = await d1.prepare(
      'SELECT ingest_status FROM filings WHERE doc_id = ?',
    ).bind(STUB_SENATE_ID).first<{ ingest_status: string }>();
    expect(stubFiling?.ingest_status).toBe('needs_review');
  });

  it('maps a Senate PTR UUID to S-{uuid} and ignores House / non-uuid keys', () => {
    expect(senateOfficialDocIdFromProvider(senateObservation())).toBe(OFFICIAL_SENATE_ID);
    expect(senateOfficialDocIdFromProvider(senateObservation({ chamber: 'house', providerKey: '2026-8221264' }))).toBeNull();
    expect(senateOfficialDocIdFromProvider(senateObservation({ providerKey: 'not-a-uuid' }))).toBeNull();
  });

  it('enqueues the official Senate PTR instead of waiting for a review stub', async () => {
    const nowIso = '2026-09-15T08:00:00.000Z';
    const official = await enqueueOfficialSenateFromProviderObservation(
      makeEnv(),
      senateObservation(),
      nowIso,
    );
    expect(official).toBe(OFFICIAL_SENATE_ID);

    const filing = await d1.prepare(
      'SELECT ingest_status, doc_kind, source_url FROM filings WHERE doc_id = ?',
    ).bind(OFFICIAL_SENATE_ID).first<{
      ingest_status: string;
      doc_kind: string | null;
      source_url: string | null;
    }>();
    expect(filing?.ingest_status).toBe('new');
    expect(filing?.doc_kind).toBe('senate_html');
    expect(filing?.source_url).toBe(SOURCE_URL);

    const outbox = await d1.prepare(
      'SELECT status FROM ingestion_outbox WHERE doc_id = ?',
    ).bind(OFFICIAL_SENATE_ID).first<{ status: string }>();
    expect(outbox?.status).toMatch(/pending|enqueued/);

    const again = await enqueueOfficialSenateFromProviderObservation(
      makeEnv(),
      senateObservation(),
      nowIso,
    );
    expect(again).toBe(OFFICIAL_SENATE_ID);
    const count = await d1.prepare(
      'SELECT COUNT(*) AS n FROM filings WHERE doc_id = ?',
    ).bind(OFFICIAL_SENATE_ID).first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it('creates a provider-only stub without waking the Publisher (review_queue.entered)', async () => {
    notifySpy.mockClear();
    const row: DisclosureProviderRow = {
      provider: 'fmp',
      chamber: 'house',
      providerKey: '20035492',
      tradeHash: 'h',
      payload: { ticker: 'VEA' },
      sourceUrl: null,
      filedDate: '2026-09-20',
      filerName: 'Example Member',
      providerPublishedAt: '2026-09-21T10:00:00.000Z',
    };

    await routeProviderOnlyObservationsToReview(makeEnv(), 'fmp', [row], '2026-09-21T12:00:00.000Z');

    const review = await d1.prepare('SELECT reason, resolved FROM review_queue WHERE doc_id = ?')
      .bind('provider-missing-fmp-house-20035492').first<{ reason: string; resolved: number }>();
    expect(review?.reason).toBe('provider_discovered_missing_official');
    expect(review?.resolved).toBe(0);
    expect(notifySpy).not.toHaveBeenCalled();
  });

  describe('reconcileProviderMissingStubsWithOfficial (official lands after provider row aged out)', () => {
    const NOW = new Date('2026-08-26T12:00:00.000Z');

    async function reviewState(docId: string) {
      return d1.prepare(
        'SELECT resolved, resolution_kind, resolution_reason FROM review_queue WHERE doc_id = ?',
      ).bind(docId).first<{ resolved: number; resolution_kind: string | null; resolution_reason: string | null }>();
    }

    async function filingStatus(docId: string) {
      const row = await d1.prepare('SELECT ingest_status FROM filings WHERE doc_id = ?')
        .bind(docId).first<{ ingest_status: string }>();
      return row?.ingest_status;
    }

    it('rejects a swept stub once its official filing persists, without a provider observation', async () => {
      await seedStubReview(STUB_SENATE_ID);
      expect((await sweepProviderOnlyReviewStubs(makeEnv())).cleared).toBe(1);
      expect(await filingStatus(STUB_SENATE_ID)).toBe('verified_empty');

      await seedOfficialTx(OFFICIAL_SENATE_ID);
      await seedFiling(OFFICIAL_SENATE_ID, 'persisted', SOURCE_URL);

      // payload is '{}' here, so the provider key comes from the stub doc_id.
      const result = await reconcileProviderMissingStubsWithOfficial(makeEnv(), { now: NOW });
      expect(result).toEqual({ scanned: 1, rejected: 1 });
      const review = await reviewState(STUB_SENATE_ID);
      expect(review?.resolution_kind).toBe('rejected');
      expect(review?.resolution_reason).toContain(OFFICIAL_SENATE_ID);
      expect(await filingStatus(STUB_SENATE_ID)).toBe('error');

      const again = await reconcileProviderMissingStubsWithOfficial(makeEnv(), { now: NOW });
      expect(again).toEqual({ scanned: 0, rejected: 0 });
    });

    it('rejects an open House stub using the provider key stored in its payload', async () => {
      const stub = 'provider-missing-fmp-house-20035492';
      await d1.prepare(
        `INSERT INTO filings (doc_id, chamber, ingest_status, filing_type, first_seen_at, source_url)
         VALUES (?, 'house', 'needs_review', 'P', '2026-08-25T00:00:00.000Z', NULL)`,
      ).bind(stub).run();
      await d1.prepare(
        `INSERT INTO review_queue (doc_id, reason, payload, created_at, resolved, review_revision)
         VALUES (?, 'provider_discovered_missing_official', ?, '2026-08-25T00:00:00.000Z', 0, 1)`,
      ).bind(stub, JSON.stringify({ reason: 'provider_discovered_missing_official', provider: 'fmp', providerKey: '20035492' })).run();
      await d1.prepare(
        `INSERT INTO filings (doc_id, chamber, ingest_status, filing_type, first_seen_at)
         VALUES ('H-2026-20035492', 'house', 'persisted', 'P', '2026-08-26T00:00:00.000Z')`,
      ).run();

      const result = await reconcileProviderMissingStubsWithOfficial(makeEnv(), { now: NOW });
      expect(result.rejected).toBe(1);
      const review = await reviewState(stub);
      expect(review?.resolution_kind).toBe('rejected');
      expect(review?.resolution_reason).toContain('H-2026-20035492');
    });

    it('leaves stubs alone when the official is not persisted, or a human resolved them', async () => {
      await seedStubReview(STUB_SENATE_ID);
      await seedFiling(OFFICIAL_SENATE_ID, 'extracted', SOURCE_URL);
      const pending = await reconcileProviderMissingStubsWithOfficial(makeEnv(), { now: NOW });
      expect(pending).toEqual({ scanned: 1, rejected: 0 });
      expect((await reviewState(STUB_SENATE_ID))?.resolved).toBe(0);

      await d1.prepare(
        `UPDATE review_queue SET resolved = 1, resolution_kind = 'verified_empty',
                resolution_reason = 'reviewer: checked by hand', resolved_at = CURRENT_TIMESTAMP
          WHERE doc_id = ?`,
      ).bind(STUB_SENATE_ID).run();
      await d1.prepare(`UPDATE filings SET ingest_status = 'persisted' WHERE doc_id = ?`)
        .bind(OFFICIAL_SENATE_ID).run();
      const human = await reconcileProviderMissingStubsWithOfficial(makeEnv(), { now: NOW });
      expect(human).toEqual({ scanned: 0, rejected: 0 });
      expect((await reviewState(STUB_SENATE_ID))?.resolution_reason).toBe('reviewer: checked by hand');
    });

    async function seedHouseStub(stub: string, payload: string, errorMarker: string | null, createdAt = '2026-08-25T00:00:00.000Z') {
      await d1.prepare(
        `INSERT INTO filings (doc_id, chamber, ingest_status, filing_type, first_seen_at, source_url, error)
         VALUES (?, 'house', 'needs_review', 'P', ?, NULL, ?)`,
      ).bind(stub, createdAt, errorMarker).run();
      await d1.prepare(
        `INSERT INTO review_queue (doc_id, reason, payload, created_at, resolved, review_revision)
         VALUES (?, 'provider_discovered_missing_official', ?, ?, 0, 1)`,
      ).bind(stub, payload, createdAt).run();
    }

    async function seedMatchedCandidate(provider: string, providerKey: string, officialDocId: string) {
      await d1.prepare(
        `INSERT INTO trade_latency_candidates
           (trade_hash, doc_id, provider, chamber, congress_first_seen_at, provider_key, status, created_at, updated_at)
         VALUES (?, ?, ?, 'house', '2026-08-26T00:00:00.000Z', ?, 'matched', '2026-08-26T00:00:00.000Z', '2026-08-26T00:00:00.000Z')`,
      ).bind(`hash-${providerKey}`, officialDocId, provider, providerKey).run();
    }

    it('matches a hashed Unusual Whales key through its matched trade_latency_candidates row', async () => {
      const hashKey = 'uw-hash-fixture-a';
      const stub = `provider-missing-unusual_whales-house-${hashKey}`;
      await seedHouseStub(
        stub,
        JSON.stringify({ reason: 'provider_discovered_missing_official', provider: 'unusual_whales', providerKey: hashKey }),
        `provider-only:unusual_whales:${hashKey}`,
      );
      await d1.prepare(
        `INSERT INTO filings (doc_id, chamber, ingest_status, filing_type, first_seen_at)
         VALUES ('H-2026-20040001', 'house', 'persisted', 'P', '2026-08-26T00:00:00.000Z')`,
      ).run();

      // No S-/H- key match exists, and no candidate yet: stays open.
      expect(await reconcileProviderMissingStubsWithOfficial(makeEnv(), { now: NOW }))
        .toEqual({ scanned: 1, rejected: 0 });

      await seedMatchedCandidate('unusual_whales', hashKey, 'H-2026-20040001');
      expect(await reconcileProviderMissingStubsWithOfficial(makeEnv(), { now: NOW }))
        .toEqual({ scanned: 1, rejected: 1 });
      const review = await reviewState(stub);
      expect(review?.resolution_kind).toBe('rejected');
      expect(review?.resolution_reason).toContain('H-2026-20040001');
    });

    it('recovers provider and raw key from the filings.error marker when the payload is truncated', async () => {
      const rawKey = 'Quiver:ab/12#x';
      const stub = 'provider-missing-quiver-house-Quiver-ab-12-x';
      await seedHouseStub(stub, '{"reason":"provider_discovered_missing_official","prov', `provider-only:quiver:${rawKey}`);
      await d1.prepare(
        `INSERT INTO filings (doc_id, chamber, ingest_status, filing_type, first_seen_at)
         VALUES ('H-2026-20040002', 'house', 'persisted', 'P', '2026-08-26T00:00:00.000Z')`,
      ).run();
      await seedMatchedCandidate('quiver', rawKey, 'H-2026-20040002');

      expect(await reconcileProviderMissingStubsWithOfficial(makeEnv(), { now: NOW }))
        .toEqual({ scanned: 1, rejected: 1 });
      expect((await reviewState(stub))?.resolution_reason).toContain('H-2026-20040002');
    });

    it('keeps the raw key after the provider-only sweep closes a truncated-payload stub', async () => {
      const rawKey = 'quiver:9c1e4f07aa';
      const stub = 'provider-missing-quiver-house-quiver-9c1e4f07aa';
      const marker = `provider-only:quiver:${rawKey}`;
      await seedHouseStub(stub, '{"reason":"provider_discovered_missing_official","prov', marker);

      // The hourly sweep runs right after the reconcile and closes the stub.
      expect((await sweepProviderOnlyReviewStubs(makeEnv())).cleared).toBe(1);
      expect(await filingStatus(stub)).toBe('verified_empty');
      const swept = await d1.prepare('SELECT error FROM filings WHERE doc_id = ?')
        .bind(stub).first<{ error: string | null }>();
      expect(swept?.error).toBe(marker);

      // The official filing lands later; only the raw key matches the candidate.
      await d1.prepare(
        `INSERT INTO filings (doc_id, chamber, ingest_status, filing_type, first_seen_at)
         VALUES ('H-2026-20040003', 'house', 'persisted', 'P', '2026-08-26T00:00:00.000Z')`,
      ).run();
      await seedMatchedCandidate('quiver', rawKey, 'H-2026-20040003');

      expect(await reconcileProviderMissingStubsWithOfficial(makeEnv(), { now: NOW }))
        .toEqual({ scanned: 1, rejected: 1 });
      const review = await reviewState(stub);
      expect(review?.resolution_kind).toBe('rejected');
      expect(review?.resolution_reason).toContain('H-2026-20040003');
    });

    it('still clears filings.error on sweep when the payload holds the raw key', async () => {
      const rawKey = 'quiver:5d20b8e1c4';
      const stub = 'provider-missing-quiver-house-quiver-5d20b8e1c4';
      await seedHouseStub(
        stub,
        JSON.stringify({ reason: 'provider_discovered_missing_official', provider: 'quiver', providerKey: rawKey }),
        `provider-only:quiver:${rawKey}`,
      );

      expect((await sweepProviderOnlyReviewStubs(makeEnv())).cleared).toBe(1);
      const swept = await d1.prepare('SELECT error FROM filings WHERE doc_id = ?')
        .bind(stub).first<{ error: string | null }>();
      expect(swept?.error).toBeNull();

      await d1.prepare(
        `INSERT INTO filings (doc_id, chamber, ingest_status, filing_type, first_seen_at)
         VALUES ('H-2026-20040004', 'house', 'persisted', 'P', '2026-08-26T00:00:00.000Z')`,
      ).run();
      await seedMatchedCandidate('quiver', rawKey, 'H-2026-20040004');
      expect(await reconcileProviderMissingStubsWithOfficial(makeEnv(), { now: NOW }))
        .toEqual({ scanned: 1, rejected: 1 });
    });

    it('stores an oversized provider payload as parseable JSON that keeps the raw key', async () => {
      const rawKey = 'quiver:77ab03e9f1';
      const row: DisclosureProviderRow = {
        provider: 'quiver',
        chamber: 'house',
        providerKey: rawKey,
        tradeHash: 'h',
        payload: { notes: 'x'.repeat(30_000) },
        sourceUrl: null,
        filedDate: '2026-08-20',
        filerName: 'Example Member',
        providerPublishedAt: '2026-08-25T10:00:00.000Z',
      };
      await routeProviderOnlyObservationsToReview(makeEnv(), 'quiver', [row], '2026-08-25T12:00:00.000Z');

      const stub = 'provider-missing-quiver-house-quiver-77ab03e9f1';
      const stored = await d1.prepare('SELECT payload FROM review_queue WHERE doc_id = ?')
        .bind(stub).first<{ payload: string }>();
      const parsed = JSON.parse(stored?.payload ?? '');
      expect(parsed.providerKey).toBe(rawKey);
      expect(parsed.provider).toBe('quiver');
      expect(parsed.payloadTruncated).toBe(true);

      // The sweep may clear filings.error now: the payload still carries the key.
      await sweepProviderOnlyReviewStubs(makeEnv());
      await d1.prepare(
        `INSERT INTO filings (doc_id, chamber, ingest_status, filing_type, first_seen_at)
         VALUES ('H-2026-20040005', 'house', 'persisted', 'P', '2026-08-26T00:00:00.000Z')`,
      ).run();
      await seedMatchedCandidate('quiver', rawKey, 'H-2026-20040005');
      expect(await reconcileProviderMissingStubsWithOfficial(makeEnv(), { now: NOW }))
        .toEqual({ scanned: 1, rejected: 1 });
    });

    it('caps the stub payload without touching payloads under the limit', () => {
      const small = { reason: 'r', provider: 'quiver', providerKey: 'k', payload: { a: 1 } };
      expect(providerStubReviewPayload(small, 1_000)).toBe(JSON.stringify(small));
      const big = { ...small, payload: { a: 'y'.repeat(2_000) } };
      const capped = providerStubReviewPayload(big, 1_000);
      expect(capped.length).toBeLessThanOrEqual(1_000);
      expect(JSON.parse(capped)).toMatchObject({ providerKey: 'k', payload: null, payloadTruncated: true });
    });

    it('ignores a matched candidate whose official filing is not persisted yet', async () => {
      const hashKey = 'uw-00aa11bb22';
      const stub = `provider-missing-unusual_whales-house-${hashKey}`;
      await seedHouseStub(stub, JSON.stringify({ provider: 'unusual_whales', providerKey: hashKey }), null);
      await d1.prepare(
        `INSERT INTO filings (doc_id, chamber, ingest_status, filing_type, first_seen_at)
         VALUES ('H-2026-20040003', 'house', 'extracted', 'P', '2026-08-26T00:00:00.000Z')`,
      ).run();
      await seedMatchedCandidate('unusual_whales', hashKey, 'H-2026-20040003');
      expect(await reconcileProviderMissingStubsWithOfficial(makeEnv(), { now: NOW }))
        .toEqual({ scanned: 1, rejected: 0 });
      expect((await reviewState(stub))?.resolved).toBe(0);
    });

    it('rotates through every eligible stub instead of re-scanning the newest page each hour', async () => {
      // 7 open stubs, none with an official counterpart, so the eligible set is stable.
      for (let i = 0; i < 7; i += 1) {
        await seedHouseStub(
          `provider-missing-fmp-house-3000000${i}`,
          JSON.stringify({ provider: 'fmp', providerKey: `3000000${i}` }),
          null,
          `2026-08-25T0${i}:00:00.000Z`,
        );
      }
      const hour0 = Date.parse('2026-08-26T00:00:00.000Z');
      let scannedTotal = 0;
      for (let h = 0; h < 7; h += 1) {
        const r = await reconcileProviderMissingStubsWithOfficial(makeEnv(), {
          now: new Date(hour0 + h * 3_600_000),
          limit: 2,
        });
        expect(r.scanned).toBeLessThanOrEqual(2);
        scannedTotal += r.scanned;
      }
      // Buckets are disjoint (rowid % buckets), so 7 over one full rotation = all covered.
      expect(scannedTotal).toBe(7);
    });

    it('drains an oversized bucket in one visit instead of starving its oldest stubs', async () => {
      // review_queue also holds non-stub rows, so stub rowids are uneven and
      // rowid % N only bounds the *average* bucket size.  Space 5 stubs 5
      // review_queue rowids apart with ineligible filler rows: with 5 buckets
      // every stub lands in the SAME bucket, which then holds 5 eligible rows
      // against a limit of 2.  A single newest-first page would re-scan the
      // newest 2 on every visit and never reach the oldest 3.
      for (let i = 0; i < 5; i += 1) {
        await seedHouseStub(
          `provider-missing-fmp-house-5000000${i}`,
          JSON.stringify({ provider: 'fmp', providerKey: `5000000${i}` }),
          null,
          `2026-08-25T0${i}:00:00.000Z`,
        );
        for (let f = 0; f < 4 && i < 4; f += 1) {
          await d1.prepare(
            `INSERT INTO review_queue (doc_id, reason, payload, created_at, resolved, review_revision)
             VALUES (?, 'extract_banner_eligible', '{}', '2026-08-25T00:00:00.000Z', 0, 1)`,
          ).bind(`filler-${i}-${f}`).run();
        }
      }
      const stubRows = await d1.prepare(
        `SELECT rowid FROM review_queue WHERE reason = 'provider_discovered_missing_official'`,
      ).all<{ rowid: number }>();
      const residues = new Set(stubRows.results.map((r) => r.rowid % 5));
      expect(residues.size).toBe(1);

      const hour0 = Date.parse('2026-08-26T00:00:00.000Z');
      let scannedTotal = 0;
      let maxScannedInOneVisit = 0;
      for (let h = 0; h < 5; h += 1) {
        const r = await reconcileProviderMissingStubsWithOfficial(makeEnv(), {
          now: new Date(hour0 + h * 3_600_000),
          limit: 2,
        });
        scannedTotal += r.scanned;
        maxScannedInOneVisit = Math.max(maxScannedInOneVisit, r.scanned);
      }
      // The bucket visit must drain all 5 in a single run, not just the newest 2.
      expect(maxScannedInOneVisit).toBe(5);
      expect(scannedTotal).toBe(5);
    });

    it('eventually rejects the oldest stub even when newer stubs exceed the row limit', async () => {
      for (let i = 0; i < 6; i += 1) {
        await seedHouseStub(
          `provider-missing-fmp-house-4000000${i}`,
          JSON.stringify({ provider: 'fmp', providerKey: `4000000${i}` }),
          null,
          `2026-08-25T0${i}:00:00.000Z`,
        );
      }
      // Only the oldest stub has a persisted official filing.
      await d1.prepare(
        `INSERT INTO filings (doc_id, chamber, ingest_status, filing_type, first_seen_at)
         VALUES ('H-2026-40000000', 'house', 'persisted', 'P', '2026-08-26T00:00:00.000Z')`,
      ).run();
      const hour0 = Date.parse('2026-08-26T00:00:00.000Z');
      let rejected = 0;
      for (let h = 0; h < 6 && rejected === 0; h += 1) {
        rejected += (await reconcileProviderMissingStubsWithOfficial(makeEnv(), {
          now: new Date(hour0 + h * 3_600_000),
          limit: 2,
        })).rejected;
      }
      expect(rejected).toBe(1);
      expect((await reviewState('provider-missing-fmp-house-40000000'))?.resolution_kind).toBe('rejected');
    });

    it('skips stubs older than the reconcile window', async () => {
      await seedStubReview(STUB_SENATE_ID);
      await seedOfficialTx(OFFICIAL_SENATE_ID);
      await seedFiling(OFFICIAL_SENATE_ID, 'persisted', SOURCE_URL);
      const result = await reconcileProviderMissingStubsWithOfficial(makeEnv(), {
        now: new Date('2027-06-01T00:00:00.000Z'),
      });
      expect(result).toEqual({ scanned: 0, rejected: 0 });
    });
  });
});
