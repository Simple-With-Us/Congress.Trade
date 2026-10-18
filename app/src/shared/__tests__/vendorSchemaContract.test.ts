import { describe, expect, it } from 'vitest';
import {
  ClientTradeSchema,
  CongressTransactionReadSchema,
  CongressTransactionSchema,
  TransactionsPageSchema,
} from '@jaywedgeworth22/congress-trading-shared';

// The app suite excludes vendor/**. Keep this consumer contract in the app
// suite so re-vendoring cannot silently remove the approved schema extensions.
const transaction = {
  id: 'tx-1',
  docId: 'doc-1',
  filerId: null,
  txDate: '2026-01-15',
  owner: 'self',
  assetName: 'Apple Inc.',
  ticker: 'AAPL',
  assetType: 'stock',
  txType: 'P',
  amountMin: 1001,
  amountMax: 15000,
  estValue: 8000,
  isOption: false,
  capGainsOver200: false,
  rawText: 'purchased Apple shares',
  confidence: 0.95,
  source: 'primary',
  createdAt: '2026-01-16T00:00:00Z',
  cursorSeq: 50,
};

const clientTrade = {
  id: 'trade-1',
  cursor: 42,
  docId: 'doc-1',
  member: { id: null, name: null, chamber: null, party: null, state: null, photoUrl: null },
  asset: { name: 'Apple Inc.', ticker: 'AAPL', type: null, sector: null, marketCapBucket: null },
  transaction: { date: null, type: 'P', owner: null, amountMin: null, amountMax: null, isOption: false },
  filing: { filedDate: null, firstSeenAt: null, sourceUrl: null },
  confidence: 0.95,
};

function page(row: typeof transaction & Record<string, unknown>) {
  return { transactions: [row], cursor: 50, count: 1, total: 100, limit: 20 };
}

describe('vendored transaction consumer contract', () => {
  it.each(['primary', 'seed_dataset', 'manual', 'competitor_backfill', 'local_mac', 'server_cpu'])(
    'accepts %s consistently in write, read, page and client schemas',
    (source) => {
      const row = { ...transaction, source };
      expect(CongressTransactionSchema.parse(row).source).toBe(source);
      expect(CongressTransactionReadSchema.parse(row).source).toBe(source);
      expect(TransactionsPageSchema.parse(page(row)).transactions[0].source).toBe(source);
      expect(ClientTradeSchema.parse({ ...clientTrade, source }).source).toBe(source);
    },
  );

  it('retains disclosure and enrichment fields instead of silently stripping them', () => {
    const enrichment = {
      party: 'D',
      bioguideId: 'P000197',
      pdfUrl: '/api/documents/doc-1/pdf',
      disclosureLagDays: -2,
      stockActStatus: 'on_time',
      priceAtTrade: 10.5,
      spxAtTrade: 5000,
      priceAtFiling: 11,
      spxAtFiling: 5010,
      latency: {
        provider: 'fmp',
        observedAt: '2026-01-16T00:00:00Z',
        providerPublishedAt: '2026-01-16T01:00:00Z',
        congressFirstSeenAt: '2026-01-16T00:00:10Z',
        providerDeltaSec: 12,
        providerPublishedDeltaSec: 50,
        status: 'matched',
      },
    };
    const parsed = TransactionsPageSchema.parse(page({ ...transaction, ...enrichment }));
    expect(parsed.transactions[0]).toMatchObject(enrichment);
  });

  it('retains explicitly null enrichment values', () => {
    const enrichment = {
      party: null,
      bioguideId: null,
      pdfUrl: null,
      disclosureLagDays: null,
      stockActStatus: null,
      priceAtTrade: null,
      spxAtTrade: null,
      priceAtFiling: null,
      spxAtFiling: null,
      latency: null,
    };
    expect(TransactionsPageSchema.parse(page({ ...transaction, ...enrichment })).transactions[0])
      .toMatchObject(enrichment);
  });

  it('still rejects an unrecognized source at every schema boundary', () => {
    const row = { ...transaction, source: 'unknown_source' };
    expect(CongressTransactionSchema.safeParse(row).success).toBe(false);
    expect(CongressTransactionReadSchema.safeParse(row).success).toBe(false);
    expect(TransactionsPageSchema.safeParse(page(row)).success).toBe(false);
    expect(ClientTradeSchema.safeParse({ ...clientTrade, source: 'unknown_source' }).success).toBe(false);
  });
});
