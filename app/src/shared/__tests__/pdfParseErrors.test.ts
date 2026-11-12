import { describe, expect, it } from 'vitest';
import {
  isExpectedPdfParseNoise,
  sentryEventLooksLikePdfParseNoise,
  SENTRY_PDF_IGNORE_ERRORS,
} from '../pdfParseErrors.ts';

describe('isExpectedPdfParseNoise', () => {
  it('matches the live CONGRESS-TRADE-1C XRefEntryException', () => {
    const err = Object.assign(new Error('Bad (uncompressed) XRef entry: 13R'), {
      name: 'XRefEntryException',
    });
    expect(isExpectedPdfParseNoise(err)).toBe(true);
    expect(isExpectedPdfParseNoise({
      name: 'XRefEntryException',
      message: 'Bad (uncompressed) XRef entry: 14R',
    })).toBe(true);
  });

  it('matches sibling pdf.js invalid-PDF exception names', () => {
    expect(isExpectedPdfParseNoise({ name: 'XRefParseException', message: 'bad xref' })).toBe(true);
    expect(isExpectedPdfParseNoise({ name: 'InvalidPDFException', message: 'Invalid PDF structure.' })).toBe(true);
    expect(isExpectedPdfParseNoise({ name: 'MissingPDFException', message: 'Missing PDF header.' })).toBe(true);
  });

  it('matches the message when the name is stripped', () => {
    expect(isExpectedPdfParseNoise(new Error('Bad (uncompressed) XRef entry: 13R'))).toBe(true);
    expect(isExpectedPdfParseNoise('Bad (uncompressed) XRef entry: 14R')).toBe(true);
  });

  it('does not swallow unrelated production errors', () => {
    expect(isExpectedPdfParseNoise(new Error('Deno cron tick exceeded 45000ms deadline'))).toBe(false);
    expect(isExpectedPdfParseNoise({ name: 'TypeError', message: 'Cannot read properties of null' })).toBe(false);
    expect(isExpectedPdfParseNoise(null)).toBe(false);
    expect(isExpectedPdfParseNoise(undefined)).toBe(false);
  });
});

describe('SENTRY_PDF_IGNORE_ERRORS', () => {
  it('covers the CONGRESS-TRADE-1C exception name and message', () => {
    expect(SENTRY_PDF_IGNORE_ERRORS).toContain('XRefEntryException');
    expect(SENTRY_PDF_IGNORE_ERRORS.some((item) =>
      item instanceof RegExp && item.test('Bad (uncompressed) XRef entry: 13R'),
    )).toBe(true);
  });
});

describe('sentryEventLooksLikePdfParseNoise', () => {
  it('drops the exception payload Sentry groups as CONGRESS-TRADE-1C', () => {
    expect(sentryEventLooksLikePdfParseNoise({
      exception: {
        values: [{
          type: 'XRefEntryException',
          value: 'Bad (uncompressed) XRef entry: 14R',
        }],
      },
    })).toBe(true);
  });

  it('leaves real application events alone', () => {
    expect(sentryEventLooksLikePdfParseNoise({
      exception: {
        values: [{
          type: 'Error',
          value: 'Deno cron tick exceeded 45000ms deadline',
        }],
      },
    })).toBe(false);
    expect(sentryEventLooksLikePdfParseNoise({ message: 'Sentry initialized' })).toBe(false);
    expect(sentryEventLooksLikePdfParseNoise(null)).toBe(false);
  });
});
