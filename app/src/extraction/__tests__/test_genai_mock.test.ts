import { expect, test, vi } from 'vitest';
import { VisionLlmExtractor } from '../visionLlm.ts';

export const mockGenerateContent = vi.fn().mockResolvedValue({
  text: JSON.stringify([{
    txDate: '2024-06-14',
    owner: 'spouse',
    assetName: 'Apple Inc.',
    ticker: 'aapl',
    assetType: 'ST',
    txType: 'B',
    amountRange: '$1,001 - $15,000',
    isOption: false,
    capGainsOver200: false,
    confidence: 0.95,
  }]),
  usageMetadata: {
    promptTokenCount: 10,
    candidatesTokenCount: 5,
    totalTokenCount: 15
  }
});

vi.mock('@google/genai', () => {
  return {
    GoogleGenAI: class {
      models = {
        generateContent: mockGenerateContent
      };
    }
  }
});

test('extractor uses genai mock', async () => {
  const env = { GEMINI_API_KEY: 'test-key' } as any;
  const ex = new VisionLlmExtractor(env);
  const bytes = new ArrayBuffer(0);
  const filing = {
    docId: 'doc1',
    chamber: 'house',
    filerId: 'F1',
    filingType: 'P',
    filedDate: '2024-07-01',
    sourceUrl: 'https://x',
    rawObjectKey: 'raw/house/doc1.pdf',
    ingestStatus: 'classified',
    docKind: 'scanned_pdf',
  } as any;
  
  const res = await ex.extract({ filing, bytes });
  expect(res.transactions.length).toBe(1);
});
