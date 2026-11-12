/**
 * CT-2511: blank owner cells mean self on House PTRs; member-name ocr_name_hold
 * only on real mismatches.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, beforeEach } from 'vitest';
import { parseHousePtrText } from '../textPdf.ts';
import {
  clearNameIndexCache,
  clearResolverCache,
  recomputeTransactions,
} from '../normalizer.ts';
import type { Env, Filing, ParsedTx } from '../../shared/types.ts';

beforeEach(() => {
  clearResolverCache();
  clearNameIndexCache();
});

function tx(over: Partial<ParsedTx> = {}): ParsedTx {
  return {
    txDate: '2026-10-20',
    owner: 'self',
    assetName: 'Argenx SE - American Depositary Shares',
    ticker: 'ARGX',
    assetType: 'ST',
    txType: 'B',
    amountMin: 1001,
    amountMax: 15000,
    isOption: false,
    capGainsOver200: false,
    rawText: 'argenx',
    confidence: 0.97,
    ...over,
  };
}

describe('Cisneros H-2026-20035788 typed PTR', () => {
  it('parses every holding as self-owned', () => {
    const text = readFileSync(
      new URL('../__fixtures__/H-2026-20035788-text-layer.txt', import.meta.url),
      'utf8',
    );
    const rows = parseHousePtrText(text);
    expect(rows).toHaveLength(65);
    expect(rows.every((r) => r.owner === 'self')).toBe(true);
  });

  it('publishes without ocr_name_hold when disclosed name matches the filer', async () => {
    const text = readFileSync(
      new URL('../__fixtures__/H-2026-20035788-text-layer.txt', import.meta.url),
      'utf8',
    );
    const parsed = parseHousePtrText(text).slice(0, 3);
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            async all<T>() {
              if (/securities_master/i.test(sql)) return { results: [] as T[] };
              if (/securities_ref/i.test(sql)) return { results: [] as T[] };
              return { results: [] as T[] };
            },
            async first<T>() {
              if (/FROM filers WHERE bioguide_id = \?/i.test(sql)) {
                return {
                  full_name: 'Gilbert Ray Cisneros, Jr',
                  chamber: 'house',
                  state: 'CA',
                } as T;
              }
              return null as T | null;
            },
            async run() {
              return { success: true, meta: { changes: 1 } };
            },
            bind() {
              return this;
            },
          };
        },
        batch: async () => [{ meta: { changes: 1 } }],
      },
      DELIVERY_QUEUE: { send: async () => {}, sendBatch: async () => {} },
    } as unknown as Env;

    const filing: Filing = {
      docId: 'H-2026-20035788',
      chamber: 'house',
      filerId: 'house-ca31-gilbert-cisneros',
      filingType: 'P',
      filedDate: '2026-11-10',
      sourceUrl: 'https://example.test/cisneros.pdf',
      rawObjectKey: 'raw/cisneros.pdf',
      ingestStatus: 'extracted',
      docKind: 'text_pdf',
      extractor: 'textPdf',
      modelVersion: null,
      confidence: null,
      firstSeenAt: '2026-11-10T00:00:00.000Z',
      sourceUpdatedAt: null,
      error: null,
    };

    const flagged = await recomputeTransactions(env, filing, parsed, 'primary', {
      identity: {
        disclosedName: 'Gilbert Cisneros',
        registeredName: 'Gilbert Ray Cisneros, Jr',
        chamber: 'house',
        state: 'CA',
      },
    });
    expect(flagged.every((f) => !f.flags.includes('ocr_name_hold'))).toBe(true);
    expect(flagged.every((f) => f.tx.confidence >= 0.95)).toBe(true);
  });

  it('restores publish confidence when member bleed suppresses asset ocr_name_hold', async () => {
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            async all<T>() {
              if (/securities_master/i.test(sql)) return { results: [] as T[] };
              if (/securities_ref/i.test(sql)) return { results: [] as T[] };
              return { results: [] as T[] };
            },
            async first<T>() {
              if (/FROM filers WHERE bioguide_id = \?/i.test(sql)) {
                return {
                  full_name: 'Gilbert Ray Cisneros, Jr',
                  chamber: 'house',
                  state: 'CA',
                } as T;
              }
              return null as T | null;
            },
            async run() {
              return { success: true, meta: { changes: 1 } };
            },
            bind() {
              return this;
            },
          };
        },
        batch: async () => [{ meta: { changes: 1 } }],
      },
      DELIVERY_QUEUE: { send: async () => {}, sendBatch: async () => {} },
    } as unknown as Env;

    const filing: Filing = {
      docId: 'H-2026-20035788',
      chamber: 'house',
      filerId: 'house-ca31-gilbert-cisneros',
      filingType: 'P',
      filedDate: '2026-11-10',
      sourceUrl: 'https://example.test/cisneros.pdf',
      rawObjectKey: 'raw/cisneros.pdf',
      ingestStatus: 'extracted',
      docKind: 'text_pdf',
      extractor: 'textPdf',
      modelVersion: null,
      confidence: null,
      firstSeenAt: '2026-11-10T00:00:00.000Z',
      sourceUpdatedAt: null,
      error: null,
    };

    const flagged = await recomputeTransactions(env, filing, [
      tx({ assetName: 'Gilbert Cisneros Legal200m Com Inc', owner: 'self' }),
    ], 'primary', {
      identity: {
        disclosedName: 'Gilbert Cisneros',
        registeredName: 'Gilbert Ray Cisneros, Jr',
        chamber: 'house',
        state: 'CA',
      },
    });
    expect(flagged[0]?.flags).not.toContain('ocr_name_hold');
    expect(flagged[0]?.tx.confidence).toBeGreaterThanOrEqual(0.95);
  });
});

describe('Khanna-style grid owner_unread', () => {
  it('keeps unread owner cells below the publish threshold via recompute', async () => {
    const env = {
      DB: {
        prepare() {
          return {
            async all<T>() {
              return { results: [] as T[] };
            },
            async first<T>() {
              return null as T | null;
            },
            async run() {
              return { success: true, meta: { changes: 1 } };
            },
            bind() {
              return this;
            },
          };
        },
        batch: async () => [{ meta: { changes: 1 } }],
      },
      DELIVERY_QUEUE: { send: async () => {}, sendBatch: async () => {} },
    } as unknown as Env;

    const filing: Filing = {
      docId: 'H-2026-9116399',
      chamber: 'house',
      filerId: 'house-ca17-ro-khanna',
      filingType: 'P',
      filedDate: '2026-11-02',
      sourceUrl: 'https://example.test/khanna.pdf',
      rawObjectKey: 'raw/khanna.pdf',
      ingestStatus: 'extracted',
      docKind: 'scanned_pdf',
      extractor: 'house_grid_form',
      modelVersion: null,
      confidence: null,
      firstSeenAt: '2026-11-02T00:00:00.000Z',
      sourceUpdatedAt: null,
      error: null,
    };

    const flagged = await recomputeTransactions(env, filing, [
      tx({ owner: null, extractionWarnings: ['owner_unread'], confidence: 0.97 }),
    ]);
    expect(flagged[0]?.flags).toContain('owner_unread');
    expect(flagged[0]?.tx.confidence).toBeLessThan(0.95);
    expect(flagged[0]?.flags).not.toContain('ocr_name_hold');
  });
});
