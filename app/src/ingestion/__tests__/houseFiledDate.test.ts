import { describe, it, expect, afterEach } from 'vitest';
import {
  clearHouseIndexFilingDateCache,
  normalizeHouseFilingDateToIso,
  parseClerkReceivedStampFromOcrText,
  parseHousePipelineDocId,
  resolveHouseFiledDate,
} from '../houseFiledDate.ts';

afterEach(() => {
  clearHouseIndexFilingDateCache();
});

describe('normalizeHouseFilingDateToIso', () => {
  it('normalizes Clerk M/D/YYYY and ISO passthrough', () => {
    expect(normalizeHouseFilingDateToIso('11/10/2026')).toBe('2026-11-10');
    expect(normalizeHouseFilingDateToIso('2026-11-10T12:00:00Z')).toBe('2026-11-10');
    expect(normalizeHouseFilingDateToIso('')).toBeNull();
  });
});

describe('parseClerkReceivedStampFromOcrText', () => {
  it('reads a Received stamp in the header only', () => {
    const header = [
      'Clerk of the House of Representatives',
      'Received 11/10/2026',
      'Name: Hon. Chuck Fleischmann',
    ].join('\n');
    expect(parseClerkReceivedStampFromOcrText(header)).toBe('2026-11-10');
  });

  it('does not treat trade-row dates below the header window as the stamp', () => {
    const body = 'Clerk of the House\n'.padEnd(2800, ' ') + 'P 10/01/2026 10/05/2026 $1,001 - $15,000';
    expect(parseClerkReceivedStampFromOcrText(body)).toBeNull();
  });
});

describe('resolveHouseFiledDate precedence', () => {
  it('prefers index over clerk stamp', () => {
    const r = resolveHouseFiledDate({
      indexFilingDate: '11/10/2026',
      ocrText: 'Received 11/09/2026',
    });
    expect(r).toEqual({ iso: '2026-11-10', source: 'index' });
  });

  it('falls back to clerk stamp when index is empty', () => {
    const r = resolveHouseFiledDate({
      indexFilingDate: '',
      ocrText: 'Date Received: 11/10/2026',
    });
    expect(r).toEqual({ iso: '2026-11-10', source: 'clerk_stamp' });
  });

  it('never invents a date', () => {
    expect(resolveHouseFiledDate({ ocrText: 'no dates here' })).toBeNull();
  });
});

describe('parseHousePipelineDocId', () => {
  it('parses official House pipeline ids', () => {
    expect(parseHousePipelineDocId('H-2026-9116403')).toEqual({
      year: '2026',
      clerkDocId: '9116403',
    });
    expect(parseHousePipelineDocId('provider-missing-x')).toBeNull();
  });
});
