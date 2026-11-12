import { describe, expect, it } from 'vitest';
import type { Env } from '../types.ts';
import {
  OPENROUTER_APP_REFERER,
  OPENROUTER_APP_TITLE,
  OPENROUTER_PRIMARY_KEY_REF,
  OPENROUTER_PURPOSE,
  OPENROUTER_SOURCE_APP,
  buildOpenRouterClassifier,
  openRouterAttributionHeaders,
  openRouterTelemetryMetadata,
} from '../openRouterAttribution.ts';

const env = {
  USAGE_MONITOR_ENVIRONMENT: 'test',
  CF_VERSION_METADATA: { id: 'deadbeef', tag: 'v1' },
} as unknown as Env;

describe('openRouterAttributionHeaders', () => {
  it('sets the OpenRouter app page identity headers', () => {
    const headers = openRouterAttributionHeaders();
    expect(headers['HTTP-Referer']).toBe(OPENROUTER_APP_REFERER);
    expect(headers['X-OpenRouter-Title']).toBe(OPENROUTER_APP_TITLE);
    expect(headers['X-Title']).toBe(OPENROUTER_APP_TITLE);
  });
});

describe('buildOpenRouterClassifier', () => {
  it('builds flat trace enrichment with purpose + generation_name', () => {
    const enrichment = buildOpenRouterClassifier(env, {
      service: 'openRouterVision',
      purpose: OPENROUTER_PURPOSE.VISION_EXTRACT,
      feature: 'vision-extract-house',
      chamber: 'house',
      user: 'H-2025-1',
    });
    expect(enrichment).toBeDefined();
    expect(enrichment!.user).toBe('H-2025-1');
    expect(enrichment!.trace).toMatchObject({
      sourceApp: OPENROUTER_SOURCE_APP,
      environment: 'test',
      service: 'openRouterVision',
      feature: 'vision-extract-house',
      keyRef: OPENROUTER_PRIMARY_KEY_REF,
      gitSha: 'deadbeef',
      purpose: 'vision_extract',
      generation_name: 'PTR vision extraction',
      chamber: 'house',
    });
    expect((enrichment!.trace as { metadata?: unknown }).metadata).toBeUndefined();
  });

  it('omits blank user and defaults feature to purpose', () => {
    const enrichment = buildOpenRouterClassifier(env, {
      service: 'docClassifier',
      purpose: OPENROUTER_PURPOSE.DOC_CLASS,
      user: '',
    });
    expect(enrichment).toBeDefined();
    expect('user' in enrichment!).toBe(false);
    expect(enrichment!.trace.feature).toBe('doc_class');
    expect((enrichment!.trace as { purpose?: string }).purpose).toBe('doc_class');
  });
});

describe('openRouterTelemetryMetadata', () => {
  it('mirrors purpose for Usage-Monitor filters', () => {
    const meta = openRouterTelemetryMetadata(env, {
      service: 'senatePaperMedia',
      purpose: OPENROUTER_PURPOSE.SENATE_PAPER_OCR,
      feature: 'senate-paper-ocr',
      chamber: 'senate',
      user: 'S-1',
    });
    expect(meta.sourceApp).toBe(OPENROUTER_SOURCE_APP);
    expect(meta.purpose).toBe('senate_paper_ocr');
    expect(meta.chamber).toBe('senate');
    expect(meta.user).toBe('S-1');
  });
});
