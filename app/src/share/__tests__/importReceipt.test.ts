import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  SCHEMA_DROP_REASON,
  acceptedCountsFromSummary,
  countSchemaDropped,
  rejectedCountsFromErrors,
  resolvePeerImportRequestId,
  totalDroppedCount,
  warnPeerImportSchemaDrops,
} from '../importReceipt.ts';
import { SecurityRefInputSchema } from '@jaywedgeworth22/congress-trading-shared';

describe('resolvePeerImportRequestId', () => {
  it('prefers x-request-id', () => {
    const headers = new Headers({ 'x-request-id': 'st-req-1' });
    expect(resolvePeerImportRequestId(headers)).toBe('st-req-1');
  });
});

describe('countSchemaDropped', () => {
  it('counts rows removed by shared-schema filtering per stream', () => {
    const raw = {
      refs: [{ ticker: 'AAPL' }, { nope: true }],
      prices: [{ ticker: 'MSFT', closes: [] }],
    };
    const filtered = {
      refs: [{ ticker: 'AAPL' }],
      prices: [{ ticker: 'MSFT', closes: [] }],
    };
    const dropped = countSchemaDropped(raw, filtered);
    expect(dropped.refs).toEqual({ count: 1, reason: SCHEMA_DROP_REASON });
    expect(dropped.prices).toBeUndefined();
  });
});

describe('rejectedCountsFromErrors', () => {
  it('attributes processing errors to streams from message suffixes', () => {
    const rejected = rejectedCountsFromErrors(['ZZZ ref: boom', 'AAA price: fail']);
    expect(rejected.refs).toBe(1);
    expect(rejected.prices).toBe(1);
  });
});

describe('acceptedCountsFromSummary', () => {
  it('maps summary counters onto share streams', () => {
    const accepted = acceptedCountsFromSummary({
      refs: 2,
      spxRows: 3,
      pricedTickers: 1,
      priceRows: 10,
      perfTickers: 1,
      insiderRows: 0,
      shortVolumeRows: 0,
      fundamentalsRows: 4,
      analystRows: 5,
    });
    expect(accepted).toEqual({
      refs: 2,
      spx: 3,
      prices: 10,
      insider: 0,
      shortVolume: 0,
      fundamentals: 4,
      analyst: 5,
    });
  });
});

describe('warnPeerImportSchemaDrops', () => {
  afterEach(() => vi.restoreAllMocks());

  it('emits sentry warn when any stream had schema drops', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    warnPeerImportSchemaDrops({
      requestId: 'r1',
      origin: 'app-b',
      payloadBytes: 100,
      dropped: { refs: { count: 2, reason: SCHEMA_DROP_REASON } },
    });
    expect(totalDroppedCount({ refs: { count: 2, reason: SCHEMA_DROP_REASON } })).toBe(2);
    expect(warn).toHaveBeenCalled();
  });

  it('no-ops when nothing was dropped', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    warnPeerImportSchemaDrops({
      requestId: 'r1',
      origin: null,
      payloadBytes: 0,
      dropped: {},
    });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('SecurityRefInputSchema parity', () => {
  it('accepts a minimal valid ref row used in drop counting', () => {
    expect(SecurityRefInputSchema.safeParse({ ticker: 'AAPL' }).success).toBe(true);
  });
});
