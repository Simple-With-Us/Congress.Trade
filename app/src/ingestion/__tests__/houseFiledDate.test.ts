import { describe, it, expect, afterEach, vi } from 'vitest';
import type { Env } from '../../shared/types.ts';
import { fetchHouseIndex, type HouseFiling } from '../houseSource.ts';
import {
  HOUSE_INDEX_FILING_DATE_CACHE_TTL_MS,
  clearHouseIndexFilingDateCache,
  ensureHouseFiledDateBeforeNormalize,
  lookupHouseIndexFilingDate,
  normalizeHouseFilingDateToIso,
  parseClerkReceivedStampFromOcrText,
  parseHousePipelineDocId,
  resolveHouseFiledDate,
} from '../houseFiledDate.ts';

vi.mock('../houseSource.ts', () => ({
  fetchHouseIndex: vi.fn(),
}));

afterEach(() => {
  clearHouseIndexFilingDateCache();
  vi.mocked(fetchHouseIndex).mockReset();
  vi.useRealTimers();
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

function indexRow(pipelineDocId: string, filingDate: string): HouseFiling {
  return { pipelineDocId, filingDate } as HouseFiling;
}

describe('House index filing-date cache', () => {
  it('reuses a year index inside the TTL and refetches after it expires', async () => {
    vi.mocked(fetchHouseIndex).mockResolvedValue([
      indexRow('H-2026-9116403', '11/10/2026'),
    ]);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-12T00:00:00Z'));
    try {
      expect(await lookupHouseIndexFilingDate('H-2026-9116403')).toBe('11/10/2026');
      expect(await lookupHouseIndexFilingDate('H-2026-9116403')).toBe('11/10/2026');
      expect(fetchHouseIndex).toHaveBeenCalledTimes(1);

      vi.setSystemTime(new Date('2026-11-12T00:30:00Z'));
      expect(await lookupHouseIndexFilingDate('H-2026-9999999')).toBeNull();
      expect(fetchHouseIndex).toHaveBeenCalledTimes(1);

      vi.mocked(fetchHouseIndex).mockResolvedValue([
        indexRow('H-2026-9116403', '11/10/2026'),
        indexRow('H-2026-9999999', '11/12/2026'),
      ]);
      vi.setSystemTime(new Date(Date.parse('2026-11-12T00:00:00Z') + HOUSE_INDEX_FILING_DATE_CACHE_TTL_MS + 1000));
      expect(await lookupHouseIndexFilingDate('H-2026-9999999')).toBe('11/12/2026');
      expect(fetchHouseIndex).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ensureHouseFiledDateBeforeNormalize', () => {
  it('does not download the year index when filedDate is already set', async () => {
    vi.mocked(fetchHouseIndex).mockRejectedValue(new Error('should not fetch'));
    const filing = { docId: 'H-2026-9116403', chamber: 'house', filedDate: '11/10/2026' };
    const iso = await ensureHouseFiledDateBeforeNormalize({} as Env, filing);
    expect(iso).toBe('2026-11-10');
    expect(filing.filedDate).toBe('2026-11-10');
    expect(fetchHouseIndex).not.toHaveBeenCalled();
  });

  it('consults the index when the House filing has no date yet', async () => {
    vi.mocked(fetchHouseIndex).mockResolvedValue([
      indexRow('H-2026-9116403', '11/10/2026'),
    ]);
    const filing = { docId: 'H-2026-9116403', chamber: 'house', filedDate: '' };
    await expect(ensureHouseFiledDateBeforeNormalize({
      DB: { prepare: () => { throw new Error('db unavailable'); } },
    } as unknown as Env, filing)).rejects.toThrow(/db unavailable/);
    expect(fetchHouseIndex).toHaveBeenCalledTimes(1);
  });
});
