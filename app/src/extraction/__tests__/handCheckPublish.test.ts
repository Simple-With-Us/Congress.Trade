import { describe, expect, it } from 'vitest';
import type { Filing } from '../../shared/types.ts';
import {
  NEEDS_HAND_CHECK_MAC_VISION,
  NEEDS_HAND_CHECK_SCANNED_VISION,
  requiresHandCheckBeforePublish,
} from '../handCheckPublish.ts';

function filing(overrides: Partial<Filing> = {}): Filing {
  return {
    docId: 'H-2026-9116355',
    chamber: 'house',
    filerId: 'F1',
    filingType: 'P',
    filedDate: '2026-10-01',
    sourceUrl: 'https://example.test',
    ingestStatus: 'classified',
    docKind: 'scanned_pdf',
    firstSeenAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('requiresHandCheckBeforePublish', () => {
  it('always requires hand check for local_mac vision', () => {
    const f = filing({ docKind: 'text_pdf' });
    expect(requiresHandCheckBeforePublish(f, 'mac_vision_v1', 'local_mac')).toBe(true);
  });

  it('requires hand check for server_cpu OCR on scanned PDFs', () => {
    expect(requiresHandCheckBeforePublish(filing(), 'server_cpu_tesseract', 'server_cpu')).toBe(true);
  });

  it('allows typed primary extraction on electronic filings', () => {
    const f = filing({ docId: 'H-2026-20035190', docKind: 'text_pdf' });
    expect(requiresHandCheckBeforePublish(f, 'textPdf', 'primary')).toBe(false);
  });

  it('blocks OpenRouter vision on scanned paper doc ids', () => {
    const f = filing({ docKind: 'unknown' });
    expect(requiresHandCheckBeforePublish(f, 'openrouter_google_gemini_flash', 'primary')).toBe(true);
  });

  it('manual confirm is never blocked', () => {
    expect(requiresHandCheckBeforePublish(filing(), 'admin', 'manual')).toBe(false);
  });

  it('uses distinct review reason tokens', () => {
    expect(NEEDS_HAND_CHECK_MAC_VISION).toBe('needs_hand_check:mac_vision');
    expect(NEEDS_HAND_CHECK_SCANNED_VISION).toBe('needs_hand_check:scanned_vision');
  });
});
