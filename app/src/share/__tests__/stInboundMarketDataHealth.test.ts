import { describe, expect, it } from 'vitest';
import {
  decideStInboundStatus,
  pushOnlyStreamsWhenPeerPullFresh,
  type PeerImportReceiptSummary,
} from '../stInboundMarketDataHealth.ts';
import type { StaleStream } from '../freshness.ts';

const receipts: PeerImportReceiptSummary = {
  lastReceivedAt: '2026-11-01T00:00:00Z',
  lastOkAt: '2026-11-01T00:00:00Z',
  lastFailedAt: null,
};

const staleFundamentals: StaleStream[] = [
  { stream: 'fundamentals', latest: '2026-10-06', ageDays: 9 },
  { stream: 'analyst', latest: '2026-10-06T08:20:38Z', ageDays: 9 },
];

describe('pushOnlyStreamsWhenPeerPullFresh', () => {
  it('drops prices when peer pull covers EOD', () => {
    const stale: StaleStream[] = [
      { stream: 'prices', latest: '2026-08-03', ageDays: 40 },
      { stream: 'fundamentals', latest: '2026-10-06', ageDays: 9 },
    ];
    expect(pushOnlyStreamsWhenPeerPullFresh(stale)).toEqual(['fundamentals']);
  });
});

describe('decideStInboundStatus', () => {
  it('stays ok when every stream is fresh', () => {
    const decided = decideStInboundStatus({
      staleStreams: [],
      stalePushStreams: [],
      peerPullStalled: false,
      peerPullConfigured: true,
      receipts,
    });
    expect(decided.status).toBe('ok');
    expect(decided.stalled).toBe(false);
  });

  it('stays ok when only the prices push stream is stale but peer pull is healthy', () => {
    const stale: StaleStream[] = [{ stream: 'prices', latest: '2026-08-03', ageDays: 40 }];
    const decided = decideStInboundStatus({
      staleStreams: stale,
      stalePushStreams: [],
      peerPullStalled: false,
      peerPullConfigured: true,
      receipts,
    });
    expect(decided.status).toBe('ok');
    expect(decided.stalled).toBe(false);
    expect(decided.detail).toContain('st_peer_prices pull');
  });

  it('degrades (does not stall) when push streams are stale but peer pull still advances', () => {
    const pushStreams = pushOnlyStreamsWhenPeerPullFresh(staleFundamentals);
    const decided = decideStInboundStatus({
      staleStreams: staleFundamentals,
      stalePushStreams: pushStreams,
      peerPullStalled: false,
      peerPullConfigured: true,
      receipts,
    });
    expect(decided.status).toBe('degraded');
    expect(decided.stalled).toBe(false);
    expect(decided.detail).toContain('push lane stale');
    expect(decided.detail).toContain('st_peer_prices pull still advancing');
  });

  it('stalls when both push and peer pull are stale', () => {
    const pushStreams = pushOnlyStreamsWhenPeerPullFresh(staleFundamentals);
    const decided = decideStInboundStatus({
      staleStreams: staleFundamentals,
      stalePushStreams: pushStreams,
      peerPullStalled: true,
      peerPullConfigured: true,
      receipts,
    });
    expect(decided.status).toBe('stalled');
    expect(decided.stalled).toBe(true);
    expect(decided.detail).toContain('both ST push and st_peer_prices pull are stale');
  });
});
