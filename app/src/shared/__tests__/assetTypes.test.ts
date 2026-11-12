import { describe, expect, it } from 'vitest';
import {
  assetTypeCategoryLabel,
  canonicalAssetTypeCategorySql,
  canonicalizeAssetType,
  houseAssetTypeCodePattern,
  inferHouseAssetTypeCode,
} from '../assetTypes.ts';

describe('canonicalizeAssetType', () => {
  it('maps House codes and Senate labels into the same public equity category', () => {
    expect(canonicalizeAssetType('ST').category).toBe('public_equity');
    expect(canonicalizeAssetType('Stock').category).toBe('public_equity');
    expect(canonicalizeAssetType('ST').label).toBe('Stocks (including ADRs)');
  });

  it('maps government and municipal debt across chambers', () => {
    expect(canonicalizeAssetType('GS').category).toBe('fixed_income_government');
    expect(canonicalizeAssetType('Municipal Security').category).toBe('fixed_income_government');
    expect(canonicalizeAssetType('GS').categoryLabel).toBe('Government / Municipal Debt');
  });

  it('recognizes digit-prefixed retirement and 529 House codes', () => {
    for (const code of ['4K', '5C', '5F', '5P']) {
      expect(canonicalizeAssetType(code).category).toBe('retirement_or_529');
    }
  });

  it('keeps private/non-public equity distinct from public stock', () => {
    expect(canonicalizeAssetType('PS').category).toBe('private_equity');
    expect(canonicalizeAssetType('Non-Public Stock').category).toBe('private_equity');
  });

  it('falls back from explicit option flag when the raw type is missing', () => {
    expect(canonicalizeAssetType(null, null, { isOption: true }).category).toBe('option');
  });

  it('lets disclosed type labels override the option flag', () => {
    expect(canonicalizeAssetType('Stock', null, { isOption: true }).category).toBe('public_equity');
  });

  it('infers ST from Common Stock asset lines and [ST] brackets when the model left type blank', () => {
    expect(inferHouseAssetTypeCode(null, { assetName: '3M Company Common Stock (MMM)' })).toEqual({
      code: 'ST',
      label: 'Stocks (including ADRs)',
    });
    expect(inferHouseAssetTypeCode(null, { rawText: 'Adobe Inc. - Common Stock (ADBE) [ST]' })?.code).toBe('ST');
    expect(canonicalizeAssetType(null, null, { assetName: 'Boeing Company Common Stock (BA)' }).code).toBe('ST');
    expect(canonicalizeAssetType(null, null, { assetName: 'Boeing Company Common Stock (BA)' }).category).toBe(
      'public_equity',
    );
  });

  it('keeps present but unmapped values separate from missing values', () => {
    expect(canonicalizeAssetType('Bespoke Security').category).toBe('other');
  });

  it('treats blank and PDF placeholder rows as unknown', () => {
    expect(canonicalizeAssetType(null).category).toBe('unknown');
    expect(canonicalizeAssetType('PDF Disclosed Filing').category).toBe('unknown');
    expect(canonicalizeAssetType('N/A').category).toBe('unknown');
    expect(canonicalizeAssetType('-').category).toBe('unknown');
    expect(canonicalizeAssetType('--').category).toBe('unknown');
    expect(assetTypeCategoryLabel('unknown')).toBe('Unknown');
  });

  it('exposes a House-code pattern that includes digit-prefixed codes', () => {
    const pattern = houseAssetTypeCodePattern();
    expect(new RegExp(`^(?:${pattern})$`).test('4K')).toBe(true);
    expect(new RegExp(`^(?:${pattern})$`).test('GS')).toBe(true);
  });
});

describe('canonicalAssetTypeCategorySql', () => {
  it('generates a SQL CASE expression for grouped analytics', () => {
    const sql = canonicalAssetTypeCategorySql('t.asset_type', 't.asset_type_name', 't.is_option');
    expect(sql).toContain("THEN 'public_equity'");
    expect(sql).toContain("THEN 'fixed_income_government'");
    expect(sql).toContain('t.is_option = 1');
  });

  it('matches the canonical fallback order in SQL', () => {
    const sql = canonicalAssetTypeCategorySql('t.asset_type', 't.asset_type_name', 't.is_option');
    expect(sql.indexOf("WHEN t.is_option = 1 THEN 'option'")).toBeGreaterThan(
      sql.indexOf("THEN 'public_equity'"),
    );
    expect(sql).toContain(
      "WHEN lower(trim(coalesce(t.asset_type, ''))) = '' AND lower(trim(coalesce(t.asset_type_name, ''))) = '' THEN 'unknown'",
    );
    expect(sql).not.toContain("lower(trim(coalesce(t.asset_type_name, ''))) = '' OR");
  });
});
