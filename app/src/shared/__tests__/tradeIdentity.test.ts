/**
 * src/shared/__tests__/tradeIdentity.test.ts
 *
 * Pure pins for the canonical-trade key and competitor publish sanitizer
 * (DATACORRECTNESS-01 / DATACORRECTNESS-02).
 */

import { describe, expect, it } from 'vitest';
import {
  canonicalBracketSql,
  fabricatedCompetitorAmountSql,
  isFabricatedCompetitorAmount,
  isFabricatedCompetitorFiledDate,
  sanitizeCompetitorPublication,
  TWIN_DEDUPE_SQL,
  TWIN_SEEK_INDEX,
} from '../tradeIdentity.ts';

describe('tradeIdentity SQL', () => {
  it('builds a correlated twin guard with source precedence and wildcard competitor fields', () => {
    expect(TWIN_SEEK_INDEX).toBe('idx_tx_twin_seek');
    expect(TWIN_DEDUPE_SQL).toContain('NOT EXISTS');
    expect(TWIN_DEDUPE_SQL.indexOf('d.filer_id = t.filer_id')).toBeLessThan(
      TWIN_DEDUPE_SQL.indexOf('d.deprecated_at IS NULL'),
    );
    expect(TWIN_DEDUPE_SQL.indexOf('d.tx_date = t.tx_date')).toBeLessThan(
      TWIN_DEDUPE_SQL.indexOf('UPPER(TRIM'),
    );
    expect(TWIN_DEDUPE_SQL).toContain("WHEN 'primary' THEN 1");
    expect(TWIN_DEDUPE_SQL).toContain("WHEN 'manual' THEN 2");
    expect(TWIN_DEDUPE_SQL).toContain("WHEN 'local_mac' THEN 3");
    expect(TWIN_DEDUPE_SQL).toContain("WHEN 'competitor_backfill' THEN 4");
    expect(TWIN_DEDUPE_SQL).toContain("d.source = 'competitor_backfill'");
    expect(TWIN_DEDUPE_SQL).toContain('1001-15000');
    expect(canonicalBracketSql('t')).toContain('1000, 1001');
    expect(fabricatedCompetitorAmountSql('t')).toContain("t.source = 'competitor_backfill'");
  });
});

describe('fabricated competitor publication', () => {
  it('treats the injector default band and missing amounts as fabricated', () => {
    expect(isFabricatedCompetitorAmount('competitor_backfill', 1001, 15000)).toBe(true);
    expect(isFabricatedCompetitorAmount('competitor_backfill', 1000, 15000)).toBe(true);
    expect(isFabricatedCompetitorAmount('competitor_backfill', null, null)).toBe(true);
    expect(isFabricatedCompetitorAmount('competitor_backfill', 50001, 100000)).toBe(false);
    expect(isFabricatedCompetitorAmount('primary', 1001, 15000)).toBe(false);
  });

  it('treats filed_date = tx_date as fabricated on competitor rows only', () => {
    expect(isFabricatedCompetitorFiledDate('competitor_backfill', '2026-06-09', '2026-06-09')).toBe(true);
    expect(isFabricatedCompetitorFiledDate('competitor_backfill', '2026-06-20', '2026-06-09')).toBe(false);
    expect(isFabricatedCompetitorFiledDate('primary', '2026-06-09', '2026-06-09')).toBe(false);
  });

  it('nulls fabricated competitor amounts, lag, and confidence at the publish boundary', () => {
    const published = sanitizeCompetitorPublication({
      source: 'competitor_backfill',
      amountMin: 1001,
      amountMax: 15000,
      estValue: 8000.5,
      filedDate: '2026-06-09',
      txDate: '2026-06-09',
      disclosureLagDays: 0,
      stockActStatus: 'on_time',
      confidence: 100,
    });
    expect(published.amountMin).toBeNull();
    expect(published.amountMax).toBeNull();
    expect(published.estValue).toBeNull();
    expect(published.filedDate).toBeNull();
    expect(published.disclosureLagDays).toBeNull();
    expect(published.stockActStatus).toBeNull();
    expect(published.confidence).toBe(0);
  });

  it('leaves official rows and real competitor brackets alone', () => {
    const official = sanitizeCompetitorPublication({
      source: 'primary',
      amountMin: 1001,
      amountMax: 15000,
      filedDate: '2026-06-09',
      txDate: '2026-06-09',
      confidence: 0.9,
    });
    expect(official.amountMin).toBe(1001);
    expect(official.filedDate).toBe('2026-06-09');

    const realCompetitor = sanitizeCompetitorPublication({
      source: 'competitor_backfill',
      amountMin: 50001,
      amountMax: 100000,
      filedDate: '2026-06-20',
      txDate: '2026-06-09',
      confidence: 0.4,
    });
    expect(realCompetitor.amountMin).toBe(50001);
    expect(realCompetitor.filedDate).toBe('2026-06-20');
    expect(realCompetitor.confidence).toBe(0.4);
  });
});
