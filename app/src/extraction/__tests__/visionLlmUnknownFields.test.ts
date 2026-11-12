import { afterEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import type { Env } from '../../shared/types.ts';
import { hasHardFailureFlags, scoreFields } from '../normalizer.ts';
import {
  EXTRACTION_PROMPT_VERSION,
  VisionLlmExtractor,
  toParsedTx,
} from '../visionLlm.ts';

const { mockGenerateContent } = vi.hoisted(() => ({ mockGenerateContent: vi.fn() }));

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = { generateContent: mockGenerateContent }
  }
}));

afterEach(() => {
  vi.restoreAllMocks();
  mockGenerateContent.mockClear();
});

const env = { GEMINI_API_KEY: 'gemini-test' } as unknown as Env;

describe('vision LLM unreadable fields', () => {
  it('allows nullable asset/type fields and preserves an invalid txType for hard-flagging', async () => {
    mockGenerateContent.mockResolvedValueOnce({
      text: JSON.stringify([
        {
          assetName: null,
          txType: null,
          amountRange: '$1,001 - $15,000',
          isOption: false,
          capGainsOver200: false,
        },
      ]),
      usageMetadata: {}
    });

    const result = await new VisionLlmExtractor(env, { apiKey: 'gemini-test', model: 'gemini-3.5-flash' }).extract({
      filing: { docKind: 'scanned_pdf', chamber: 'house' } as never,
      bytes: new TextEncoder().encode('%PDF-1.4').buffer as ArrayBuffer,
    });

    const request = mockGenerateContent.mock.calls[0][0];
    const properties = request.config.responseSchema.items.properties;
    expect(properties.assetName).toMatchObject({ type: 'STRING', nullable: true });
    expect(properties.txType).toMatchObject({ type: 'STRING', nullable: true });
    expect(properties.isOption).toMatchObject({ type: 'BOOLEAN', nullable: true });
    expect(properties.capGainsOver200).toMatchObject({ type: 'BOOLEAN', nullable: true });

    const tx = result.transactions[0];
    expect(tx.assetName).toBe('');
    expect(tx.txType).toBe('');
    expect(tx.txType).not.toBe('B');

    const scored = scoreFields(
      tx.confidence,
      {
        ticker: tx.ticker,
        assetName: tx.assetName,
        amountMin: tx.amountMin,
        amountMax: tx.amountMax,
        txType: tx.txType,
        txDate: tx.txDate,
      },
      null,
      () => null,
    );
    expect(scored.flags).toContain('bad_tx_type');
    expect(hasHardFailureFlags([{ flags: scored.flags }])).toBe(true);
  });

  it('marks unreadable boolean disclosure fields instead of silently treating them as false', () => {
    const tx = toParsedTx({
      assetName: 'Apple Inc.',
      txType: 'B',
      amountRange: '$1,001 - $15,000',
      isOption: null,
      capGainsOver200: null,
    });
    expect(tx).toMatchObject({
      isOption: false,
      capGainsOver200: false,
      extractionWarnings: ['unreadable_is_option', 'unreadable_cap_gains'],
    });
    expect(hasHardFailureFlags([{ flags: tx.extractionWarnings ?? [] }])).toBe(true);
  });

  it('uses the Executive OGE prompt for executive filings', async () => {
    mockGenerateContent.mockResolvedValueOnce({
      text: '[]',
      usageMetadata: {}
    });

    await new VisionLlmExtractor(env, { apiKey: 'gemini-test', model: 'gemini-3.5-flash' }).extract({
      filing: { docKind: 'scanned_pdf', chamber: 'executive' } as never,
      bytes: new TextEncoder().encode('%PDF-1.4').buffer as ArrayBuffer,
    });

    const request = mockGenerateContent.mock.calls[0][0];
    expect(request.contents[0].parts[0].text).toContain('Executive Branch OGE Form 278-T');
    expect(request.contents[0].parts[0].text).not.toContain('congressional STOCK Act');
  });

  it('retains valid transaction types and exports a stable prompt version', () => {
    expect(EXTRACTION_PROMPT_VERSION).toBe('stock-act-ptr-v5-grounded');
    expect(toParsedTx({ txType: 'B', assetName: 'Asset' }).txType).toBe('B');
    expect(toParsedTx({ txType: 'S', assetName: 'Asset' }).txType).toBe('S');
    expect(toParsedTx({ txType: 'E', assetName: 'Asset' }).txType).toBe('E');
  });

  it('attaches billed usage from successful chunks when a later chunk fails', async () => {
    const pdf = await PDFDocument.create();
    for (let page = 0; page < 51; page++) pdf.addPage([500, 500]);
    const bytes = await pdf.save();
    
    mockGenerateContent
      .mockResolvedValueOnce({
        text: '[]',
        usageMetadata: {
          promptTokenCount: 120,
          candidatesTokenCount: 9,
          totalTokenCount: 129,
        },
        modelVersion: 'legacy-model-variant',
      })
      .mockRejectedValueOnce(Object.assign(new Error('unprocessable chunk'), { status: 422 }));

    const extraction = new VisionLlmExtractor(env, { apiKey: 'gemini-test', model: 'legacy-model' }).extract({
      filing: { docKind: 'scanned_pdf', chamber: 'house' } as never,
      bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    });

    await expect(extraction).rejects.toMatchObject({
      usage: {
        promptTokens: 120,
        completionTokens: 9,
        cachedTokens: 0,
      },
      resolvedModel: 'legacy-model-variant',
    });
    expect(mockGenerateContent).toHaveBeenCalledTimes(2);
  });
});
