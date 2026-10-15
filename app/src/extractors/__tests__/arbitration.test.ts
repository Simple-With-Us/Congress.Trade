import { describe, it, expect, vi } from 'vitest';
import {
  ArbitratingExtractor,
  arbitrationRowKey,
  buildExtractorPipeline,
  fieldAgreement,
  HousePdfExtractor,
  OgePdfExtractor,
  mergeResults,
  type Extractor,
  type ExtractorResult,
} from '../types.ts';
import { IngestRetryError } from '../../ingestion/fetcher.ts';
import type { Env, Filing, ParsedTx } from '../../shared/types.ts';

function tx(over: Partial<ParsedTx> = {}): ParsedTx {
  return {
    txDate: '2026-01-02',
    owner: 'self',
    assetName: 'Apple Inc',
    ticker: 'AAPL',
    assetType: 'ST',
    txType: 'B',
    amountMin: 1001,
    amountMax: 15000,
    isOption: false,
    capGainsOver200: false,
    rawText: '',
    confidence: 0.6,
    ...over,
  };
}

function result(rows: ParsedTx[], over: Partial<ExtractorResult> = {}): ExtractorResult {
  return {
    transactions: rows,
    confidence: rows.length ? rows.reduce((s, r) => s + r.confidence, 0) / rows.length : 0,
    raw: 'raw',
    extractor: 'primary',
    ...over,
  };
}

const filing = (over: Partial<Filing> = {}): Filing => ({
  docId: 'H-1',
  chamber: 'house',
  filerId: 'F1',
  filingType: 'P',
  filedDate: '2026-06-24',
  sourceUrl: 'https://example.test/doc.pdf',
  rawObjectKey: 'raw/doc.pdf',
  ingestStatus: 'classified',
  docKind: 'scanned_pdf',
  extractor: null,
  modelVersion: null,
  confidence: null,
  firstSeenAt: '2026-06-24T00:00:00.000Z',
  sourceUpdatedAt: null,
  error: null,
  ...over,
});

function extractor(name: string, out: ExtractorResult): Extractor {
  return {
    name,
    canHandle: () => true,
    extract: async () => out,
  };
}

describe('arbitrationRowKey', () => {
  it('keys on ticker + date + type + owner, uppercased', () => {
    expect(arbitrationRowKey(tx({ ticker: 'aapl' }))).toBe('AAPL|2026-01-02|B|self');
  });
  it('falls back to asset name when no ticker', () => {
    expect(arbitrationRowKey(tx({ ticker: null, assetName: 'US T-Bill' }))).toBe(
      'US T-BILL|2026-01-02|B|self',
    );
  });
  it('splits same ticker/date/type when owner differs (H-2026-9116376)', () => {
    const base = {
      ticker: 'COO',
      assetName: 'The Cooper Companies, Inc.',
      txDate: '2026-09-11',
      txType: 'B' as const,
    };
    const dependent = arbitrationRowKey(tx({ ...base, owner: 'dependent' }));
    const spouse = arbitrationRowKey(tx({ ...base, owner: 'spouse' }));
    expect(dependent).toBe('COO|2026-09-11|B|dependent');
    expect(spouse).toBe('COO|2026-09-11|B|spouse');
    expect(dependent).not.toBe(spouse);
  });
});

describe('fieldAgreement', () => {
  it('counts matching comparable fields', () => {
    expect(fieldAgreement(tx(), tx())).toEqual({ agree: 5, total: 5 });
    expect(fieldAgreement(tx(), tx({ amountMin: 50000 }))).toEqual({ agree: 4, total: 5 });
    expect(fieldAgreement(tx(), tx({ owner: 'spouse', isOption: true }))).toEqual({
      agree: 3,
      total: 5,
    });
  });
});

describe('mergeResults', () => {
  it('boosts confidence when both extractors fully agree', () => {
    const merged = mergeResults(result([tx({ confidence: 0.6 })]), result([tx({ confidence: 0.6 })]));
    expect(merged.transactions).toHaveLength(1);
    // (0.6 + 0.6)/2 + 0.1 = 0.7
    expect(merged.transactions[0].confidence).toBeCloseTo(0.7, 5);
    expect(merged.extractor).toBe('arbitrating(primary,primary)');
  });

  it('scales row confidence down on partial field disagreement', () => {
    const primary = result([tx({ confidence: 1 })]);
    const secondary = result([tx({ confidence: 1, amountMin: 50000, amountMax: 100000 })]);
    const merged = mergeResults(primary, secondary);
    // 4/5 fields agree -> 1 * 0.8
    expect(merged.transactions[0].confidence).toBeCloseTo(0.8, 5);
  });

  it('halves confidence for primary-only rows (no corroboration)', () => {
    const primary = result([tx({ ticker: 'AAPL', confidence: 0.8 })]);
    const secondary = result([tx({ ticker: 'MSFT', confidence: 0.8 })]);
    const merged = mergeResults(primary, secondary);
    // primary row has no secondary match -> 0.8 * 0.5
    expect(merged.transactions[0].confidence).toBeCloseTo(0.4, 5);
  });

  it('keeps the primary row set authoritative and lowers doc confidence when contested', () => {
    const primary = result([tx({ ticker: 'AAPL' })]);
    const secondary = result([tx({ ticker: 'AAPL' }), tx({ ticker: 'TSLA' })]);
    const merged = mergeResults(primary, secondary);
    // Output is still just the one primary row...
    expect(merged.transactions).toHaveLength(1);
    // ...but the secondary-only row drags doc confidence below the row confidence.
    expect(merged.confidence).toBeLessThan(merged.transactions[0].confidence);
    expect(merged.raw).toContain('secondaryOnly=1');
  });

  it('exposes the per-side only counts so downstream empty checks see a contested empty', () => {
    const merged = mergeResults(result([]), result([tx({ ticker: 'TSLA' })]));
    expect(merged.transactions).toHaveLength(0);
    expect(merged.arbitrationCounts).toEqual({ primaryOnly: 0, secondaryOnly: 1 });
    const agreed = mergeResults(result([]), result([]));
    expect(agreed.arbitrationCounts).toEqual({ primaryOnly: 0, secondaryOnly: 0 });
  });

  it('retains usage and provider request identity for every arbitrated model call', () => {
    const primary = result([tx()], {
      extractor: 'vision-primary',
      modelVersion: 'gemini-3.5-flash',
      providerRequestId: 'primary-request',
      usage: { promptTokens: 100, completionTokens: 20 },
    });
    const secondary = result([tx()], {
      extractor: 'vision-secondary',
      modelVersion: 'gemini-2.5-pro',
      providerRequestId: 'secondary-request',
      usage: { promptTokens: 120, completionTokens: 30 },
    });

    const merged = mergeResults(primary, secondary);

    expect(merged.providerRequestId).toBe('primary-request');
    expect(merged.usage).toEqual({ promptTokens: 100, completionTokens: 20 });
    expect(merged.modelRuns).toEqual([
      {
        extractor: 'vision-primary',
        modelVersion: 'gemini-3.5-flash',
        providerRequestId: 'primary-request',
        usage: { promptTokens: 100, completionTokens: 20 },
      },
      {
        extractor: 'vision-secondary',
        modelVersion: 'gemini-2.5-pro',
        providerRequestId: 'secondary-request',
        usage: { promptTokens: 120, completionTokens: 30 },
      },
    ]);
  });
});

describe('ArbitratingExtractor usage preservation', () => {
  it('attaches the billed primary run when the secondary fails after consuming usage', async () => {
    const primary = result([tx()], {
      extractor: 'vision-primary',
      modelVersion: 'gemini-3.5-flash',
      providerRequestId: 'primary-request',
      usage: { promptTokens: 100, completionTokens: 20 },
    });
    const secondaryError = Object.assign(new Error('secondary parse failed'), {
      resolvedModel: 'gemini-2.5-pro',
      providerRequestId: 'secondary-request',
      usage: { promptTokens: 120, completionTokens: 30 },
    });
    const secondary: Extractor = {
      name: 'vision-secondary',
      canHandle: () => true,
      extract: async () => { throw secondaryError; },
    };
    const arbitrating = new ArbitratingExtractor(
      extractor('vision-primary', primary),
      { ARBITRATION_ENABLED: 'true' } as unknown as Env,
      secondary,
    );

    await expect(arbitrating.extract({ filing: filing() })).rejects.toBe(secondaryError);
    expect((secondaryError as Error & { modelRuns?: unknown[] }).modelRuns).toEqual([
      {
        extractor: 'vision-primary',
        modelVersion: 'gemini-3.5-flash',
        providerRequestId: 'primary-request',
        usage: { promptTokens: 100, completionTokens: 20 },
      },
      {
        extractor: 'vision-secondary',
        modelVersion: 'gemini-2.5-pro',
        providerRequestId: 'secondary-request',
        usage: { promptTokens: 120, completionTokens: 30 },
      },
    ]);
  });
});

describe('HousePdfExtractor', () => {
  it('uses text extraction first for House scanned PDFs when rows are found', async () => {
    const text = extractor('textPdf', result([tx({ confidence: 0.9 })], { extractor: 'textPdf' }));
    const vision = extractor('vision', result([tx({ ticker: 'MSFT' })], { extractor: 'vision' }));
    const house = new HousePdfExtractor(text, vision);

    const out = await house.extract({ filing: filing() });

    expect(house.canHandle(filing())).toBe(true);
    expect(out.extractor).toBe('textPdf');
    expect(out.transactions[0].ticker).toBe('AAPL');
  });

  it('falls back to vision when a real House scan has no text rows', async () => {
    const text = extractor('textPdf', result([], { extractor: 'textPdf' }));
    const vision = extractor('vision', result([tx({ ticker: 'INTC' })], { extractor: 'vision' }));
    const house = new HousePdfExtractor(text, vision);

    const out = await house.extract({
      filing: filing({ docId: 'H-2025-8221302', docKind: 'scanned_pdf' }),
    });

    expect(out.extractor).toBe('vision');
    expect(out.transactions[0].ticker).toBe('INTC');
  });

  it('does not call Files/vision on an electronic House PTR with zero text rows', async () => {
    const text = extractor('textPdf', result([], { extractor: 'textPdf', raw: 'Periodic Transaction Report header only' }));
    let visionCalls = 0;
    const vision: Extractor = {
      name: 'vision',
      canHandle: () => true,
      extract: async () => {
        visionCalls += 1;
        return result([tx({ ticker: 'INTC' })], { extractor: 'vision' });
      },
    };
    const house = new HousePdfExtractor(text, vision);

    const out = await house.extract({
      filing: filing({ docId: 'H-2025-20030634', docKind: 'scanned_pdf' }),
    });

    expect(visionCalls).toBe(0);
    expect(out.extractor).toBe('textPdf');
    expect(out.transactions).toEqual([]);
  });

  it('does not escalate a letterhead cheap read to Files/vision', async () => {
    const letterhead = result([
      tx({
        assetName: 'Clerk of the House of Representatives',
        ticker: null,
        txDate: null,
        confidence: 0.15,
      }),
    ], { extractor: 'textPdf' });
    let visionCalls = 0;
    const vision: Extractor = {
      name: 'vision',
      canHandle: () => true,
      extract: async () => {
        visionCalls += 1;
        return result([tx()], { extractor: 'vision' });
      },
    };
    const house = new HousePdfExtractor(
      extractor('textPdf', letterhead),
      vision,
    );

    const out = await house.extract({
      filing: filing({ docId: 'H-2025-20030634', docKind: 'text_pdf' }),
    });

    expect(visionCalls).toBe(0);
    expect(out.transactions[0]?.assetName).toMatch(/Clerk of the House/);
  });

  it('uses cheap text (not Files) when an electronic PTR has a plausible table but zero structured rows', async () => {
    const emptyText = result([], {
      extractor: 'textPdf',
      raw: 'SP  Apple Inc. (AAPL) [ST]\nP  06/14/2024  06/20/2024  $1,001 - $15,000',
    });
    let visionCalls = 0;
    let cheapCalls = 0;
    const vision: Extractor = {
      name: 'vision',
      canHandle: () => true,
      extract: async () => {
        visionCalls += 1;
        return result([tx({ ticker: 'MSFT' })], { extractor: 'vision' });
      },
    };
    const cheap: Extractor = {
      name: 'openRouterText',
      canHandle: () => true,
      extract: async (input) => {
        cheapCalls += 1;
        expect(input.extractedText).toContain('AAPL');
        return result([tx({ ticker: 'AAPL' })], { extractor: 'openRouterText' });
      },
    };
    const house = new HousePdfExtractor(extractor('textPdf', emptyText), vision, cheap);

    const out = await house.extract({
      filing: filing({ docId: 'H-2025-20030634', docKind: 'text_pdf' }),
    });

    expect(cheapCalls).toBe(1);
    expect(visionCalls).toBe(0);
    expect(out.extractor).toBe('openRouterText');
    expect(out.transactions[0]?.ticker).toBe('AAPL');
  });

  it('skips a doc when cheap text returns Unauthorized, without Files', async () => {
    const emptyText = result([], {
      extractor: 'textPdf',
      raw: 'SP  Apple Inc. (AAPL) [ST]\nP  06/14/2024  06/20/2024  $1,001 - $15,000',
    });
    let visionCalls = 0;
    const vision: Extractor = {
      name: 'vision',
      canHandle: () => true,
      extract: async () => {
        visionCalls += 1;
        return result([tx({ ticker: 'MSFT' })], { extractor: 'vision' });
      },
    };
    const cheap: Extractor = {
      name: 'openRouterText',
      canHandle: () => true,
      extract: async () => {
        throw new Error('openRouterReply:unauth_reply: 401 Unauthorized');
      },
    };
    const house = new HousePdfExtractor(extractor('textPdf', emptyText), vision, cheap);
    const out = await house.extract({
      filing: filing({ docId: 'H-2025-20030634', docKind: 'text_pdf' }),
    });
    expect(visionCalls).toBe(0);
    expect(out.extractor).toBe('textPdf');
    expect(out.transactions).toEqual([]);
  });

  it('still fail-closes a proven OpenRouter dead-key rejection', async () => {
    const emptyText = result([], {
      extractor: 'textPdf',
      raw: 'SP  Apple Inc. (AAPL) [ST]\nP  06/14/2024  06/20/2024  $1,001 - $15,000',
    });
    const cheap: Extractor = {
      name: 'openRouterText',
      canHandle: () => true,
      extract: async () => {
        throw new Error('openRouterText: OpenRouter API 401 Unauthorized {"error":{"message":"User not found.","code":401}}');
      },
    };
    const house = new HousePdfExtractor(
      extractor('textPdf', emptyText),
      extractor('vision', result([])),
      cheap,
    );
    await expect(house.extract({
      filing: filing({ docId: 'H-2025-20030634', docKind: 'text_pdf' }),
    })).rejects.toThrow(/User not found/);
  });

  it('does not claim non-House scanned PDFs', () => {
    const text = extractor('textPdf', result([]));
    const vision = extractor('vision', result([]));
    const house = new HousePdfExtractor(text, vision);

    expect(house.canHandle(filing({ chamber: 'senate' }))).toBe(false);
  });
});

describe('OgePdfExtractor', () => {
  const execScan = () => filing({ chamber: 'executive', docKind: 'scanned_pdf', docId: 'E-1' });
  const execText = () => filing({ chamber: 'executive', docKind: 'text_pdf', docId: 'E-1' });

  it('uses unpdf/ogeText first for executive scanned PDFs when rows are found', async () => {
    const ogeText = extractor('ogeText', result([tx({ confidence: 0.97 })], { extractor: 'ogeText' }));
    const visionExtract = vi.fn(async () => result([tx({ ticker: 'MSFT' })], { extractor: 'vision' }));
    const vision = { name: 'vision', canHandle: () => true, extract: visionExtract };
    const ogePdf = new OgePdfExtractor(ogeText, vision);

    const out = await ogePdf.extract({ filing: execScan() });

    expect(ogePdf.canHandle(execScan())).toBe(true);
    expect(ogePdf.canHandle(execText())).toBe(true);
    expect(out.extractor).toBe('ogeText');
    expect(out.transactions[0].ticker).toBe('AAPL');
    expect(visionExtract).not.toHaveBeenCalled();
  });

  it('falls back to OpenRouter vision when a scan yields zero unpdf rows', async () => {
    const ogeText = extractor('ogeText', result([], { extractor: 'ogeText' }));
    const vision = extractor('vision', result([tx({ ticker: 'XOM' })], { extractor: 'vision' }));
    const ogePdf = new OgePdfExtractor(ogeText, vision);

    const out = await ogePdf.extract({ filing: execScan() });

    expect(out.extractor).toBe('vision');
    expect(out.transactions[0].ticker).toBe('XOM');
  });

  it('preserves ogeText throws on typed executive PDFs instead of spending vision', async () => {
    const ogeText = {
      name: 'ogeText',
      canHandle: () => true,
      extract: async () => {
        throw new Error('ogeText: no bytes provided on ExtractorInput');
      },
    };
    const vision = {
      name: 'vision',
      canHandle: () => true,
      extract: async () => {
        throw new Error('vision must not run for typed ogeText throws');
      },
    };
    const ogePdf = new OgePdfExtractor(ogeText, vision);

    await expect(ogePdf.extract({ filing: execText() })).rejects.toThrow('ogeText: no bytes provided');
  });

  it('does not charge vision when a scanned 278e text layer says Part 7 is None', async () => {
    const bondi = [
      'OGE Form 278e',
      '7. Transactions',
      'None',
      '8. Liabilities',
      'None',
    ].join('\n');
    const ogeText = extractor('ogeText', result([], { extractor: 'ogeText', raw: bondi }));
    const visionExtract = vi.fn(async () => result([tx({ ticker: 'XOM' })], { extractor: 'vision' }));
    const vision = { name: 'vision', canHandle: () => true, extract: visionExtract };
    const ogePdf = new OgePdfExtractor(ogeText, vision);

    const out = await ogePdf.extract({ filing: execScan() });

    expect(out.extractor).toBe('ogeText');
    expect(out.transactions).toHaveLength(0);
    expect(out.raw).toContain('7. Transactions');
    expect(visionExtract).not.toHaveBeenCalled();
  });

  it('keeps a refused typed executive PDF on the unreadable disposition and does not spend vision', async () => {
    const ogeText = extractor('ogeText', result([], {
      extractor: 'ogeText',
      parseDisposition: 'unreadable',
    }));
    const vision = {
      name: 'vision',
      canHandle: () => true,
      extract: async () => {
        throw new Error('vision must not run for a refused typed 278-T');
      },
    };
    const ogePdf = new OgePdfExtractor(ogeText, vision);
    const out = await ogePdf.extract({ filing: execText() });
    expect(out.parseDisposition).toBe('unreadable');
    expect(out.transactions).toHaveLength(0);
  });

  it('keeps a refused scan unreadable when vision also returns nothing', async () => {
    const ogeText = extractor('ogeText', result([], {
      extractor: 'ogeText',
      parseDisposition: 'unreadable',
    }));
    const vision = extractor('vision', result([], { extractor: 'vision' }));
    const ogePdf = new OgePdfExtractor(ogeText, vision);
    const out = await ogePdf.extract({ filing: execScan() });
    expect(out.parseDisposition).toBe('unreadable');
    expect(out.transactions).toHaveLength(0);
  });

  it('does not restore the empty/unreadable terminal when the arbitrated secondary vision read saw rows', async () => {
    const ogeText = extractor('ogeText', result([], {
      extractor: 'ogeText',
      parseDisposition: 'unreadable',
    }));
    // Primary vision finds nothing; the arbitration secondary finds a row.
    // mergeResults keeps the merged array empty (primary-authoritative) but
    // marks the doc contested for human review.
    const primary = extractor('vision-primary', result([], { extractor: 'vision-primary' }));
    const secondary = extractor('vision-secondary', result([tx({ ticker: 'XOM' })], { extractor: 'vision-secondary' }));
    const arbitrating = new ArbitratingExtractor(
      primary,
      { ARBITRATION_ENABLED: 'true' } as unknown as Env,
      secondary,
    );
    const ogePdf = new OgePdfExtractor(ogeText, arbitrating);

    const out = await ogePdf.extract({ filing: execScan() });

    // The terminal unreadable label must not bury the contested doc.
    expect(out.parseDisposition).toBeUndefined();
    expect(out.transactions).toHaveLength(0);
    expect(out.raw).toContain('secondaryOnly=1');
  });

  it('restores the terminal state when every arbitrated vision read found nothing', async () => {
    const ogeText = extractor('ogeText', result([], {
      extractor: 'ogeText',
      parseDisposition: 'unreadable',
    }));
    const primary = extractor('vision-primary', result([], { extractor: 'vision-primary' }));
    const secondary = extractor('vision-secondary', result([], { extractor: 'vision-secondary' }));
    const arbitrating = new ArbitratingExtractor(
      primary,
      { ARBITRATION_ENABLED: 'true' } as unknown as Env,
      secondary,
    );
    const ogePdf = new OgePdfExtractor(ogeText, arbitrating);

    const out = await ogePdf.extract({ filing: execScan() });

    expect(out.parseDisposition).toBe('unreadable');
    expect(out.transactions).toHaveLength(0);
    expect(out.arbitrationCounts).toEqual({ primaryOnly: 0, secondaryOnly: 0 });
  });

  it('does not restore the empty terminal on an honest-empty 278e when the arbitrated secondary saw rows', async () => {
    const ogeText = extractor('ogeText', result([], {
      extractor: 'ogeText',
      parseDisposition: 'empty',
    }));
    const primary = extractor('vision-primary', result([], { extractor: 'vision-primary' }));
    const secondary = extractor('vision-secondary', result([tx({ ticker: 'MSFT' })], { extractor: 'vision-secondary' }));
    const arbitrating = new ArbitratingExtractor(
      primary,
      { ARBITRATION_ENABLED: 'true' } as unknown as Env,
      secondary,
    );
    const ogePdf = new OgePdfExtractor(ogeText, arbitrating);

    const out = await ogePdf.extract({ filing: execScan() });

    expect(out.parseDisposition).toBeUndefined();
    expect(out.raw).toContain('secondaryOnly=1');
  });

  it('does not charge vision for typed executive PDFs that parse to zero rows', async () => {
    const ogeText = extractor('ogeText', result([], { extractor: 'ogeText', raw: 'none' }));
    const vision = {
      name: 'vision',
      canHandle: () => true,
      extract: async () => {
        throw new Error('vision must not run for typed empty 278-T');
      },
    };
    const ogePdf = new OgePdfExtractor(ogeText, vision);

    const out = await ogePdf.extract({ filing: execText() });

    expect(out.extractor).toBe('ogeText');
    expect(out.transactions).toHaveLength(0);
  });

  it('strips the terminal disposition when vision never confirmed the read (fail-soft)', async () => {
    // A garbled scan whose vision fallback throws must not reach normalize()
    // carrying 'unreadable': rejection requires a successful zero-row vision
    // read, and this one never happened.
    const ogeText = extractor('ogeText', result([], {
      extractor: 'ogeText',
      parseDisposition: 'unreadable',
      raw: 'garbled scan text',
    }));
    const vision = {
      name: 'vision',
      canHandle: () => true,
      extract: async () => {
        throw new Error('OPENROUTER_API_KEY is not configured');
      },
    };
    const ogePdf = new OgePdfExtractor(ogeText, vision);

    const out = await ogePdf.extract({ filing: execScan() });

    expect(out.parseDisposition).toBeUndefined();
    expect(out.transactions).toHaveLength(0);
    expect(out.raw).toContain('ogePdf vision fail-soft');
  });

  it('keeps a positively-read empty disposition through vision fail-soft', async () => {
    // 'empty' is the text layer's own positive evidence (a bounded, readable
    // empty Part 7); unlike 'unreadable' it needs no vision confirmation, so
    // the fail-soft must not wipe it.
    const ogeText = extractor('ogeText', result([], {
      extractor: 'ogeText',
      parseDisposition: 'empty',
      raw: 'OGE Form 278e Part 7. Transactions Part 8. Liabilities',
    }));
    const vision = {
      name: 'vision',
      canHandle: () => true,
      extract: async () => {
        throw new Error('OPENROUTER_API_KEY is not configured');
      },
    };
    const ogePdf = new OgePdfExtractor(ogeText, vision);

    const out = await ogePdf.extract({ filing: execScan() });

    expect(out.parseDisposition).toBe('empty');
    expect(out.transactions).toHaveLength(0);
    expect(out.raw).toContain('ogePdf vision fail-soft');
  });

  it('rethrows budget/rate-limit IngestRetryError so the queue can back off', async () => {
    const ogeText = extractor('ogeText', result([], { extractor: 'ogeText' }));
    const retry = new IngestRetryError('openrouter key budget circuit open', 3600);
    const vision = {
      name: 'vision',
      canHandle: () => true,
      extract: async () => {
        throw retry;
      },
    };
    const ogePdf = new OgePdfExtractor(ogeText, vision);

    await expect(ogePdf.extract({ filing: execScan() })).rejects.toBe(retry);
  });

  it('fail-softs paid vision errors on scans and keeps the empty unpdf result', async () => {
    const ogeText = extractor('ogeText', result([], { extractor: 'ogeText', raw: 'scan text' }));
    const vision = {
      name: 'vision',
      canHandle: () => true,
      extract: async () => {
        throw new Error('OPENROUTER_API_KEY is not configured');
      },
    };
    const ogePdf = new OgePdfExtractor(ogeText, vision);

    const out = await ogePdf.extract({ filing: execScan() });

    expect(out.extractor).toBe('ogeText');
    expect(out.transactions).toHaveLength(0);
    expect(out.raw).toContain('ogePdf vision fail-soft');
    expect(out.raw).toContain('OPENROUTER_API_KEY');
  });

  it('does not claim House or Senate filings', () => {
    const ogeText = extractor('ogeText', result([]));
    const vision = extractor('vision', result([]));
    const ogePdf = new OgePdfExtractor(ogeText, vision);

    expect(ogePdf.canHandle(filing({ chamber: 'house', docKind: 'scanned_pdf' }))).toBe(false);
    expect(ogePdf.canHandle(filing({ chamber: 'senate', docKind: 'scanned_pdf' }))).toBe(false);
  });
});

describe('buildExtractorPipeline routing', () => {
  // Construction does no I/O (secrets/keys resolve lazily inside extract()),
  // so a bare fake Env is safe here — this only exercises canHandle() routing.
  const pipeline = buildExtractorPipeline({} as Env);

  function firstMatch(f: Filing): string | undefined {
    return pipeline.find((e) => e.canHandle(f))?.name;
  }

  it('still routes House text_pdf filings through housePdf (text-first, Files only for real scans)', () => {
    const name = firstMatch(filing({ chamber: 'house', docKind: 'text_pdf' }));
    expect(name).toMatch(/^housePdf\(/);
    expect(name).toContain('openRouterText');
  });

  it('still routes Senate HTML filings to senateHtml', () => {
    expect(firstMatch(filing({ chamber: 'senate', docKind: 'senate_html' }))).toBe('senateHtml');
  });

  it('routes executive scanned_pdf filings through ogePdf (unpdf first, fail-soft vision)', () => {
    const name = firstMatch(filing({ chamber: 'executive', docKind: 'scanned_pdf' }));
    expect(name).toMatch(/^ogePdf\(/);
  });

  it('routes executive text_pdf filings through ogePdf, not the House-tuned textPdf or raw vision', () => {
    const name = firstMatch(filing({ chamber: 'executive', docKind: 'text_pdf' }));
    expect(name).toMatch(/^ogePdf\(/);
  });
});
