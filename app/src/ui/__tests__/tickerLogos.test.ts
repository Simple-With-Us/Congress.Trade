import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  isValidPngBytes,
  logoDevUrl,
  normalizeTickerLogoSymbol,
  readValidPng,
  tickerLogoCandidates,
} from '../tickerLogos.ts';

/** Minimal valid 1×1 PNG (67 bytes). */
const TINY_PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

describe('normalizeTickerLogoSymbol', () => {
  it('uppercases and strips $', () => {
    expect(normalizeTickerLogoSymbol(' $aapl ')).toBe('AAPL');
  });
  it('rejects junk', () => {
    expect(normalizeTickerLogoSymbol('../etc')).toBeNull();
    expect(normalizeTickerLogoSymbol('')).toBeNull();
  });
});

describe('tickerLogoCandidates', () => {
  it('includes dotted and dashed BRK variants', () => {
    const c = tickerLogoCandidates('BRK.B');
    expect(c).toContain('BRK.B');
    expect(c).toContain('BRK-B');
  });
});

describe('logoDevUrl', () => {
  it('embeds token and forces png+fallback=404', () => {
    const u = logoDevUrl('AAPL', 'pk_test');
    expect(u).toContain('img.logo.dev/ticker/AAPL');
    expect(u).toContain('token=pk_test');
    expect(u).toContain('format=png');
    expect(u).toContain('fallback=404');
  });

  it('requests a 96px (size=48, retina) image, not the old 256px oversize (WEBPERF-02)', () => {
    // The largest rendered .tkr-logo box is 36px (.trades-card); size=128
    // (256px effective) was ~7x oversized for the 22px table box and was the
    // single largest byte cost on the Trades tab.
    const u = logoDevUrl('AAPL', 'pk_test');
    expect(u).toContain('size=48');
    expect(u).toContain('retina=true');
    expect(u).not.toContain('size=128');
  });
});

describe('isValidPngBytes', () => {
  it('accepts a real tiny PNG', () => {
    expect(isValidPngBytes(TINY_PNG)).toBe(true);
  });
  it('rejects empty and non-PNG', () => {
    expect(isValidPngBytes(new Uint8Array(0))).toBe(false);
    expect(isValidPngBytes(new Uint8Array(200))).toBe(false);
    expect(isValidPngBytes(new TextEncoder().encode('<html>not a png</html>'.padEnd(80)))).toBe(false);
  });
});

describe('readValidPng', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null for empty 200 image responses (logo.dev blank body)', async () => {
    const res = new Response(new Uint8Array(0), {
      status: 200,
      headers: { 'content-type': 'image/png' },
    });
    expect(await readValidPng(res)).toBeNull();
  });

  it('returns bytes for a valid PNG body', async () => {
    const res = new Response(TINY_PNG, {
      status: 200,
      headers: { 'content-type': 'image/png' },
    });
    const out = await readValidPng(res);
    expect(out).not.toBeNull();
    expect(out!.byteLength).toBe(TINY_PNG.byteLength);
  });

  it('rejects HTML 404 disguised as ok content-type', async () => {
    const html = new TextEncoder().encode('<!doctype html><title>404</title>'.padEnd(100));
    const res = new Response(html, {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
    expect(await readValidPng(res)).toBeNull();
  });
});
