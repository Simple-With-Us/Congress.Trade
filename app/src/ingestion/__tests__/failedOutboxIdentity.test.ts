import { describe, expect, it } from 'vitest';
import {
  fingerprintFailedIngestionDocIds,
  fingerprintFailedIngestionIdentity,
  formatIngestionDeadLetterIdentityDetail,
} from '../failedOutboxIdentity.ts';

describe('failedOutboxIdentity', () => {
  it('fingerprint is order-independent', async () => {
    const a = await fingerprintFailedIngestionDocIds(['S-9e2ff733', 'S-6bf3b6f7']);
    const b = await fingerprintFailedIngestionDocIds(['S-6bf3b6f7', 'S-9e2ff733']);
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });

  it('fingerprint changes when doc_id set changes at the same count', async () => {
    const senatePair = await fingerprintFailedIngestionDocIds(['S-aaa', 'S-bbb']);
    const otherPair = await fingerprintFailedIngestionDocIds(['S-aaa', 'S-ccc']);
    expect(senatePair).not.toBe(otherPair);
  });

  it('identity fingerprint differs when tail doc_ids differ at the same count (truncated head)', async () => {
    const head = ['s-00001', 's-00002'];
    const a = await fingerprintFailedIngestionIdentity(600, head, ['s-00777']);
    const b = await fingerprintFailedIngestionIdentity(600, head, ['s-00888']);
    expect(a).not.toBe(b);
  });

  it('identity fingerprint differs when count differs with the same head window', async () => {
    const head = ['s-00001', 's-00002'];
    const a = await fingerprintFailedIngestionIdentity(500, head, []);
    const b = await fingerprintFailedIngestionIdentity(501, head, ['s-00999']);
    expect(a).not.toBe(b);
  });

  it('formatIngestionDeadLetterIdentityDetail includes short fp and doc preview', () => {
    const detail = formatIngestionDeadLetterIdentityDetail({
      count: 2,
      fingerprint: 'abcdef0123456789'.padEnd(64, '0'),
      doc_ids: ['S-6bf3b6f7', 'S-9e2ff733'],
      fingerprintCoversAll: true,
    });
    expect(detail).toContain('fp=abcdef012345');
    expect(detail).toContain('S-6bf3b6f7');
    expect(detail).toContain('S-9e2ff733');
  });

  it('omits doc_id preview on public health surfaces', () => {
    const detail = formatIngestionDeadLetterIdentityDetail(
      {
        count: 2,
        fingerprint: 'abcdef0123456789'.padEnd(64, '0'),
        doc_ids: ['S-6bf3b6f7', 'S-9e2ff733'],
        fingerprintCoversAll: true,
      },
      { includeDocIdPreview: false },
    );
    expect(detail).toContain('fp=abcdef012345');
    expect(detail).toContain('all failed=2');
    expect(detail).not.toContain('S-6bf3b6f7');
  });
});
