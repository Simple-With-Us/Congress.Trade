import { describe, expect, it } from 'vitest';
import { parseHousePtrDisclosedName } from '../textPdf.ts';
import {
  houseMemberNameMismatch,
  suppressAssetOcrHoldForMemberBleed,
} from '../housePtrMember.ts';
import { readFileSync } from 'node:fs';

describe('parseHousePtrDisclosedName', () => {
  it('reads Gilbert Cisneros from the typed Cisneros fixture', () => {
    const text = readFileSync(
      new URL('../__fixtures__/H-2026-20035788-text-layer.txt', import.meta.url),
      'utf8',
    );
    expect(parseHousePtrDisclosedName(text)).toBe('Gilbert Cisneros');
  });
});

describe('houseMemberNameMismatch', () => {
  const base = {
    chamber: 'house',
    state: 'CA',
  };

  it('does not mismatch middle names or suffixes on the same member', () => {
    expect(
      houseMemberNameMismatch({
        ...base,
        disclosedName: 'Gilbert Cisneros',
        registeredName: 'Gilbert Ray Cisneros, Jr',
      }),
    ).toBe(false);
    expect(
      houseMemberNameMismatch({
        ...base,
        disclosedName: 'Ro Khanna',
        registeredName: 'Rohit Khanna',
      }),
    ).toBe(false);
  });

  it('flags a different member on the same state', () => {
    expect(
      houseMemberNameMismatch({
        ...base,
        disclosedName: 'Pete Sessions',
        registeredName: 'Gilbert Cisneros',
      }),
    ).toBe(true);
  });
});

describe('suppressAssetOcrHoldForMemberBleed', () => {
  it('drops asset holds when the filer own name bled into a self row', () => {
    expect(
      suppressAssetOcrHoldForMemberBleed('Gilbert Cisneros', 'self', 'Gilbert Cisneros'),
    ).toBe(true);
    expect(
      suppressAssetOcrHoldForMemberBleed('Apple Inc.', 'self', 'Gilbert Cisneros'),
    ).toBe(false);
    expect(
      suppressAssetOcrHoldForMemberBleed('Gilbert Cisneros', 'spouse', 'Gilbert Cisneros'),
    ).toBe(false);
  });
});
