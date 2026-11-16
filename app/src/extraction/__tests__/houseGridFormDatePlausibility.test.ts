import { describe, expect, it } from 'vitest';
import {
  gridFormDatesPlausible,
  parseGridFormLooseDate,
  refineGridFormRowDates,
} from '../houseGridFormDatePlausibility.ts';

const FILED = '2026-11-05';

describe('parseGridFormLooseDate', () => {
  it('reads impossible month 40 as October', () => {
    expect(parseGridFormLooseDate('40/22/26')).toBe('2026-10-22');
  });
});

describe('gridFormDatesPlausible', () => {
  it('accepts trade on or before notification within 45 days', () => {
    expect(gridFormDatesPlausible('2026-10-12', '2026-11-02', { filedDate: FILED })).toBe(true);
  });

  it('rejects notification before trade', () => {
    expect(gridFormDatesPlausible('2026-11-02', '2026-10-12', { filedDate: FILED })).toBe(false);
  });

  it('rejects notification more than 45 days after trade', () => {
    expect(gridFormDatesPlausible('2026-08-01', '2026-11-02', { filedDate: FILED })).toBe(false);
  });
});

describe('refineGridFormRowDates', () => {
  it('repairs notification 8/3 when OCR puts it after the filed date', () => {
    const repaired = refineGridFormRowDates(
      {
        tradeDate: '2026-10-12',
        notifDate: '2026-11-08',
        tradeRaw: '10/12/26',
        notifRaw: '11/08/26',
      },
      { filedDate: FILED },
    );
    expect(repaired.notifDate).toBe('2026-11-03');
    expect(repaired.repaired).toBe(true);
    expect(repaired.dateConfidenceOk).toBe(true);
  });

  it('keeps the OCR read and lowers confidence when trade and notification repairs both fit', () => {
    const out = refineGridFormRowDates(
      {
        tradeDate: '2026-10-27',
        notifDate: '2026-11-02',
        tradeRaw: '10/27/26',
        notifRaw: '11/02/26',
      },
      { filedDate: FILED },
    );
    expect(out.tradeDate).toBe('2026-10-27');
    expect(out.dateConfidenceOk).toBe(true);
  });

  it('does not copy notification into a missing trade date', () => {
    const out = refineGridFormRowDates(
      {
        tradeDate: null,
        notifDate: '2026-11-02',
        tradeRaw: null,
        notifRaw: '11/02/26',
      },
      { filedDate: FILED },
    );
    expect(out.tradeDate).toBeNull();
    expect(out.repaired).toBe(false);
  });

  it('keeps ambiguous reads without inventing a date', () => {
    const out = refineGridFormRowDates(
      {
        tradeDate: '2026-10-12',
        notifDate: '2026-11-02',
        tradeRaw: '1O/12/26',
        notifRaw: '11/02/26',
      },
      { filedDate: FILED },
    );
    expect(out.tradeDate).toBe('2026-10-12');
    expect(out.dateConfidenceOk).toBe(true);
  });
});
