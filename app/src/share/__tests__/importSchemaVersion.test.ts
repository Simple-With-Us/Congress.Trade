/**
 * ST-3853: inbound peer share payload contract version resolution.
 * A version mismatch is reported and warned about, never rejected.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../shared/sentryRuntime.ts', () => ({
  sentryLoggerWarn: vi.fn(),
}));

import { sentryLoggerWarn } from '../../shared/sentryRuntime.ts';
import { resolvePeerImportSchemaVersion } from '../importReceipt.ts';

const warn = vi.mocked(sentryLoggerWarn);
const ctx = { requestId: 'req-1', origin: 'app-b' as string | null };

describe('resolvePeerImportSchemaVersion', () => {
  beforeEach(() => {
    warn.mockClear();
  });

  it('treats a payload without schemaVersion as the legacy version', () => {
    const result = resolvePeerImportSchemaVersion(undefined, ctx);
    expect(result).toEqual({ schemaVersion: 1, supported: true });
    expect(warn).not.toHaveBeenCalled();
  });

  it('accepts the current supported version without warning', () => {
    const result = resolvePeerImportSchemaVersion(1, ctx);
    expect(result).toEqual({ schemaVersion: 1, supported: true });
    expect(warn).not.toHaveBeenCalled();
  });

  it('reports an unsupported version without rejecting it', () => {
    const result = resolvePeerImportSchemaVersion(2, ctx);
    expect(result).toEqual({ schemaVersion: 2, supported: false });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      'peer.import.unsupported_schema_version',
      expect.objectContaining({ requestId: 'req-1', origin: 'app-b', schemaVersion: 2, supportedMax: 1 }),
    );
  });

  it.each([
    ['null', null],
    ['string', '1'],
    ['zero', 0],
    ['negative', -1],
    ['float', 1.5],
  ])('flags a malformed %s version as unsupported and null', (_label, raw) => {
    const result = resolvePeerImportSchemaVersion(raw, ctx);
    expect(result).toEqual({ schemaVersion: null, supported: false });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      'peer.import.malformed_schema_version',
      expect.objectContaining({ requestId: 'req-1', origin: 'app-b' }),
    );
  });

  it('falls back to the unknown origin when the peer sent none', () => {
    resolvePeerImportSchemaVersion(2, { requestId: 'req-2', origin: null });
    expect(warn).toHaveBeenCalledWith(
      'peer.import.unsupported_schema_version',
      expect.objectContaining({ origin: 'unknown' }),
    );
  });
});
