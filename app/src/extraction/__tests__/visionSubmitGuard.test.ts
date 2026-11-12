import { describe, expect, it } from 'vitest';
import {
  storedReviewBlocksSmallerVisionSubmit,
  storedReviewDatedCount,
  storedReviewTransactionCount,
} from '../visionSubmitGuard.ts';

function payload(count: number, transactionCount?: number): string {
  return JSON.stringify({
    transactionCount: transactionCount ?? count,
    transactions: Array.from({ length: count }, (_, i) => ({ assetName: `Row ${i}` })),
  });
}

describe('storedReviewTransactionCount', () => {
  it('uses the larger of listed rows and claimed transactionCount', () => {
    expect(storedReviewTransactionCount(payload(200, 219))).toBe(219);
    expect(storedReviewTransactionCount(payload(2, 2))).toBe(2);
    expect(storedReviewTransactionCount(null)).toBe(0);
    expect(storedReviewTransactionCount('not-json')).toBe(0);
  });

  it('ignores claimed transactionCount when the stored payload is truncated', () => {
    const truncated = JSON.stringify({
      truncated: true,
      transactionCount: 501,
      transactions: Array.from({ length: 200 }, (_, i) => ({ assetName: `Row ${i}` })),
    });
    expect(storedReviewTransactionCount(truncated)).toBe(200);
  });
});

describe('storedReviewBlocksSmallerVisionSubmit', () => {
  it('blocks a shorter vision submit over cascade / mismatch / needs-reprocess payloads', () => {
    expect(storedReviewBlocksSmallerVisionSubmit(
      'agreement_cascade_unresolved',
      payload(40),
      12,
    )).toBe(true);
    expect(storedReviewBlocksSmallerVisionSubmit(
      'ticker_asset_mismatch,invalid_amount,low_confidence',
      payload(15),
      8,
    )).toBe(true);
    expect(storedReviewBlocksSmallerVisionSubmit(
      'extraction_row_limit_exceeded_needs_reprocess:0.00',
      payload(200, 219),
      180,
    )).toBe(true);
  });

  it('allows empty / OCR-garbage / likely_garbage parks to be replaced', () => {
    expect(storedReviewBlocksSmallerVisionSubmit(
      'extract_empty_failure,no_transactions_extracted',
      payload(0),
      4,
    )).toBe(false);
    expect(storedReviewBlocksSmallerVisionSubmit(
      'ocr_unusable,form_chrome_only',
      payload(80),
      6,
    )).toBe(false);
    expect(storedReviewBlocksSmallerVisionSubmit(
      'extraction_row_limit_exceeded_likely_garbage:0.93',
      payload(200),
      8,
    )).toBe(false);
  });

  it('allows a vision submit that is at least as large as the stored extract', () => {
    expect(storedReviewBlocksSmallerVisionSubmit(
      'agreement_cascade_unresolved',
      payload(12),
      12,
    )).toBe(false);
    expect(storedReviewBlocksSmallerVisionSubmit(
      'agreement_cascade_unresolved',
      payload(12),
      14,
    )).toBe(false);
  });

  it('allows a shorter vision submit when it has more dated rows than a chrome flood', () => {
    const chrome = JSON.stringify({
      transactionCount: 421,
      transactions: Array.from({ length: 200 }, (_, i) => ({
        assetName: i < 3 ? 'Public Offering?' : `Row ${i}`,
        txDate: i === 0 ? '2025-01-02' : null,
      })),
    });
    expect(storedReviewDatedCount(chrome)).toBe(1);
    expect(storedReviewBlocksSmallerVisionSubmit(
      'agreement_cascade_unresolved',
      chrome,
      40,
      38,
    )).toBe(false);
    expect(storedReviewBlocksSmallerVisionSubmit(
      'agreement_cascade_unresolved',
      chrome,
      40,
    )).toBe(true);
  });

  it('blocks a padded incoming whose persistable dated rows are shorter than the stored extract', () => {
    const stored = JSON.stringify({
      transactionCount: 40,
      transactions: Array.from({ length: 40 }, (_, i) => ({
        assetName: `City of El Paso TX GO ${i}`,
        txDate: '2024-01-01',
      })),
    });
    // 40 raw rows, 12 dated — #2151 would publish the 12 and resolve review.
    expect(storedReviewBlocksSmallerVisionSubmit(
      'agreement_cascade_unresolved',
      stored,
      40,
      12,
    )).toBe(true);
    expect(storedReviewBlocksSmallerVisionSubmit(
      'agreement_cascade_unresolved',
      stored,
      40,
    )).toBe(false);
  });

  it('does not let a truncated 200-of-501 payload block a complete 265/409 vision read', () => {
    const truncated = JSON.stringify({
      truncated: true,
      transactionCount: 501,
      transactions: Array.from({ length: 200 }, (_, i) => ({ assetName: `Row ${i}` })),
    });
    expect(storedReviewBlocksSmallerVisionSubmit(
      'agreement_cascade_unresolved',
      truncated,
      265,
    )).toBe(false);
    expect(storedReviewBlocksSmallerVisionSubmit(
      'agreement_cascade_unresolved',
      truncated,
      409,
    )).toBe(false);
  });
});
