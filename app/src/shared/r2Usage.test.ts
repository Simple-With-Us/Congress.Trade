import { describe, expect, it, vi } from 'vitest';
import {
  buildSummary,
  classifyOps,
  fetchR2Usage,
  formatOwnBackupRegimenLine,
  formatUsageMessage,
  R2_FREE_TIER,
  type R2OpsCount,
  type R2StoragePoint,
} from './r2Usage.ts';

const NOW = new Date('2026-07-31T12:00:00Z'); // day 31 of 31, ~99.9% elapsed

function storagePoint(over: Partial<R2StoragePoint> = {}): R2StoragePoint {
  return {
    bucketName: 'congress-trade-bucket',
    datetime: '2026-07-31T10:00:00Z',
    payloadSize: 1_900_000_000,
    metadataSize: 50_000,
    objectCount: 1700,
    ...over,
  };
}

describe('classifyOps', () => {
  it('splits Class A / Class B / unclassified', () => {
    const ops: R2OpsCount[] = [
      { actionType: 'PutObject', requests: 2000 },
      { actionType: 'UploadPart', requests: 100 },
      { actionType: 'DeleteObject', requests: 500 },
      { actionType: 'GetObject', requests: 17000 },
      { actionType: 'HeadBucket', requests: 100 },
      { actionType: 'SomeFutureOp', requests: 42 },
    ];
    expect(classifyOps(ops)).toEqual({ classA: 2600, classB: 17100, other: 42 });
  });

  it('handles empty input', () => {
    expect(classifyOps([])).toEqual({ classA: 0, classB: 0, other: 0 });
  });
});

describe('buildSummary', () => {
  it('uses the latest sample per bucket and sums across buckets', () => {
    const storage: R2StoragePoint[] = [
      storagePoint({ bucketName: 'a', datetime: '2026-07-30T10:00:00Z', payloadSize: 100 }),
      storagePoint({ bucketName: 'a', datetime: '2026-07-31T10:00:00Z', payloadSize: 200 }),
      storagePoint({ bucketName: 'b', datetime: '2026-07-31T09:00:00Z', payloadSize: 300, metadataSize: 0, objectCount: 5 }),
    ];
    const s = buildSummary(storage, [], NOW);
    expect(s.storageBytes).toBe(200 + 50_000 + 300);
    expect(s.objectCount).toBe(1700 + 5);
  });

  it('reports storage from ~7 days ago when a sample exists', () => {
    const storage: R2StoragePoint[] = [
      storagePoint({ datetime: '2026-07-24T10:00:00Z', payloadSize: 1_000_000_000, metadataSize: 0 }),
      storagePoint({ datetime: '2026-07-31T10:00:00Z', payloadSize: 1_900_000_000, metadataSize: 0 }),
    ];
    const s = buildSummary(storage, [], NOW);
    expect(s.storageBytesWeekAgo).toBe(1_000_000_000);
  });

  it('returns null week-ago storage when no old sample exists', () => {
    const s = buildSummary([storagePoint()], [], NOW);
    expect(s.storageBytesWeekAgo).toBeNull();
  });

  it('computes month progress for a mid-month date', () => {
    const mid = new Date('2026-07-16T00:00:00Z');
    const s = buildSummary([], [], mid);
    expect(s.daysInMonth).toBe(31);
    expect(s.dayOfMonth).toBe(16);
    expect(s.monthElapsed).toBeGreaterThan(0.48);
    expect(s.monthElapsed).toBeLessThan(0.5);
  });
});

describe('formatOwnBackupRegimenLine', () => {
  it('reports the configured 15m Litestream RPO', () => {
    const line = formatOwnBackupRegimenLine();
    expect(line).toContain('(15m sync');
    expect(line).not.toContain('(5m sync');
  });
});

describe('formatUsageMessage', () => {
  it('includes all three dimensions with percentages and pace', () => {
    const s = buildSummary(
      [
        storagePoint({ datetime: '2026-07-24T10:00:00Z', payloadSize: 1_400_000_000, metadataSize: 0 }),
        storagePoint({ datetime: '2026-07-31T10:00:00Z', payloadSize: 1_950_000_000, metadataSize: 50_000 }),
      ],
      [
        { actionType: 'PutObject', requests: 2500 },
        { actionType: 'GetObject', requests: 17500 },
      ],
      NOW,
    );
    const msg = formatUsageMessage(s, NOW);
    expect(msg).toContain('Storage: 1.82 GB / 10.00 GB (18.2%)');
    expect(msg).toContain('1700 objects');
    expect(msg).toContain('Class A ops: 2500 (0.25% MTD, pace → 0.25% at month-end)');
    expect(msg).toContain('Class B ops: 17.5K (0.18% MTD, pace → 0.18% at month-end)');
    expect(msg).toContain('Status: OK — well within free tier');
    expect(msg).toContain('Backup:');
    expect(msg).toContain('(15m sync');
    expect(msg).not.toContain('(5m sync');
    expect(msg).toContain('Hetzner');
    // Own free tier under CT logo — no sent-from footer.
    expect(msg).not.toContain('(sent from');
  });

  it('warns when any dimension projects over 80%', () => {
    const early = new Date('2026-07-05T00:00:00Z'); // ~13% of month elapsed
    const s = buildSummary(
      [storagePoint()],
      [{ actionType: 'PutObject', requests: 700_000 }], // 70% in 13% of month
      early,
    );
    const msg = formatUsageMessage(s, early);
    expect(msg).toContain('OVER 80%');
    expect(msg).toContain('pace →');
  });

  it('omits pace early in the month', () => {
    const first = new Date('2026-07-01T01:00:00Z'); // <3% elapsed
    const s = buildSummary([storagePoint()], [{ actionType: 'GetObject', requests: 100 }], first);
    const msg = formatUsageMessage(s, first);
    expect(msg).toContain('0.00% of free tier');
    expect(msg).not.toContain('pace →');
  });

  it('shows storage growth and month-end projection when week-ago data exists', () => {
    const s = buildSummary(
      [
        storagePoint({ datetime: '2026-07-24T10:00:00Z', payloadSize: 1_000_000_000, metadataSize: 0 }),
        storagePoint({ datetime: '2026-07-31T10:00:00Z', payloadSize: 1_700_000_000, metadataSize: 0 }),
      ],
      [],
      NOW,
    );
    const msg = formatUsageMessage(s, NOW);
    expect(msg).toContain('+0.65 GB vs 7d ago');
  });
});

describe('fetchR2Usage', () => {
  it('maps GraphQL groups into storage points and op counts', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      data: {
        viewer: {
          accounts: [{
            storage: [{
              dimensions: { bucketName: 'b1', datetime: '2026-07-31T10:00:00Z' },
              max: { payloadSize: 100, metadataSize: 5, objectCount: 3 },
            }],
            ops: [{ dimensions: { actionType: 'PutObject' }, sum: { requests: 7 } }],
          }],
        },
      },
    }), { status: 200 }));
    const { storage, ops } = await fetchR2Usage('acct', 'token', NOW, fetchFn as unknown as typeof fetch);
    expect(storage).toEqual([{
      bucketName: 'b1',
      datetime: '2026-07-31T10:00:00Z',
      payloadSize: 100,
      metadataSize: 5,
      objectCount: 3,
    }]);
    expect(ops).toEqual([{ actionType: 'PutObject', requests: 7 }]);
    const init = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer token');
  });

  it('throws on GraphQL errors', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ errors: [{ message: 'bad query' }] }), { status: 200 }));
    await expect(fetchR2Usage('acct', 'token', NOW, fetchFn as unknown as typeof fetch)).rejects.toThrow('bad query');
  });

  it('throws on HTTP failure', async () => {
    const fetchFn = vi.fn(async () => new Response('nope', { status: 403 }));
    await expect(fetchR2Usage('acct', 'token', NOW, fetchFn as unknown as typeof fetch)).rejects.toThrow('HTTP 403');
  });
});

describe('free tier constants', () => {
  it('match the documented R2 free tier', () => {
    expect(R2_FREE_TIER.storageBytes).toBe(10 * 1024 * 1024 * 1024);
    expect(R2_FREE_TIER.classAOps).toBe(1_000_000);
    expect(R2_FREE_TIER.classBOps).toBe(10_000_000);
  });
});
