import { describe, expect, it } from 'vitest';
import {
  fingerprintFailedIngestionDocIds,
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

  it('formatIngestionDeadLetterIdentityDetail includes short fp and doc preview', () => {
    const detail = formatIngestionDeadLetterIdentityDetail({
      count: 2,
      fingerprint: 'abcdef0123456789'.padEnd(64, '0'),
      doc_ids: ['S-6bf3b6f7', 'S-9e2ff733'],
    });
    expect(detail).toContain('fp=abcdef012345');
    expect(detail).toContain('S-6bf3b6f7');
    expect(detail).toContain('S-9e2ff733');
  });
});
