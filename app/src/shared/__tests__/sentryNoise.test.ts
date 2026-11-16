import { describe, expect, it } from 'vitest';
import {
  sentryOperationalNoiseShouldDrop,
  SENTRY_BROWSER_IGNORE_ERRORS,
} from '../sentryNoise.ts';
import { buildSentryInitOptions } from '../sentryRuntime.ts';

describe('sentryOperationalNoiseShouldDrop', () => {
  it('drops pipeline stall recovery info messages', () => {
    expect(sentryOperationalNoiseShouldDrop({
      message: 'Pipeline stall recovered: st_peer_enrichment — ST enrichment moving',
    })).toBe(true);
    expect(sentryOperationalNoiseShouldDrop({
      message: 'Pipeline stall: st_peer_enrichment — still stalled',
    })).toBe(false);
  });
});

describe('server beforeSend', () => {
  it('filters pipeline stall recovery via beforeSend', () => {
    const options = buildSentryInitOptions({
      SENTRY_DSN: 'https://key@o1.ingest.us.sentry.io/1',
    });
    const beforeSend = options.beforeSend as (event: { message: string }) => unknown;
    expect(beforeSend({ message: 'Pipeline stall recovered: ocr — cleared' })).toBeNull();
    expect(beforeSend({ message: 'real outage' })).toEqual({ message: 'real outage' });
  });
});

describe('SENTRY_BROWSER_IGNORE_ERRORS', () => {
  it('includes truncated JSON parse noise on the homepage', () => {
    expect(SENTRY_BROWSER_IGNORE_ERRORS).toContain('Unexpected end of input');
  });
});
