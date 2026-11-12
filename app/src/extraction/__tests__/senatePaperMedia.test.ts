import { describe, it, expect } from 'vitest';
import {
  extractSenatePaperMediaUrls,
  isSenatePaperViewerHtml,
  renderSenatePaperViewer,
  enhanceSenateHtmlDocument,
} from '../senatePaperMedia.ts';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PAPER_SHELL = `<!DOCTYPE HTML><html><title>eFD: View Report</title>
<body>
Page 1 of 5
<img class="filingImage" src="https://efd-media-public.senate.gov/media/2026/2/000/000/000000145.gif" alt="filing document" />
<img class="filingImage" src="https://efd-media-public.senate.gov/media/2026/2/000/000/000000146.gif" alt="filing document" />
<a href="/search/print/paper/3a4c5095-028a-4614-a692-836719da4e63/">Printer-Friendly</a>
</body></html>`;

const ELECTRONIC_PTR = `<!DOCTYPE HTML><html><table class="report-data">
<tr><th>Transaction Date</th><th>Ticker</th><th>Type</th><th>Amount</th></tr>
<tr><td>06/01/2026</td><td>AAPL</td><td>Purchase</td><td>$1,001 - $15,000</td></tr>
</table></html>`;

describe('senate paper media URL extraction', () => {
  it('detects paper viewer shells', () => {
    expect(isSenatePaperViewerHtml(PAPER_SHELL)).toBe(true);
    expect(isSenatePaperViewerHtml(ELECTRONIC_PTR)).toBe(false);
  });

  it('collects efd-media-public filingImage URLs in order', () => {
    const urls = extractSenatePaperMediaUrls(PAPER_SHELL);
    expect(urls).toEqual([
      'https://efd-media-public.senate.gov/media/2026/2/000/000/000000145.gif',
      'https://efd-media-public.senate.gov/media/2026/2/000/000/000000146.gif',
    ]);
  });

  it('ignores non-media hosts and dedupes', () => {
    const html = `
      <img class="filingImage" src="https://efd-media-public.senate.gov/media/a.gif" />
      <img class="filingImage" src="https://efd-media-public.senate.gov/media/a.gif" />
      <img class="filingImage" src="https://evil.example/media/x.gif" />
      <img src="/static/images/logo.svg" />
    `;
    expect(extractSenatePaperMediaUrls(html)).toEqual([
      'https://efd-media-public.senate.gov/media/a.gif',
    ]);
  });

  it('handles unreachable relay gracefully when loading media', async () => {
    const { extractFromSenatePaperMedia } = await import('../senatePaperMedia.ts');
    const mockEnv = {
      SENATE_RELAY_URL: 'http://127.0.0.1:9999',
      OPENROUTER_API_KEY: 'test-key',
    } as any;

    await expect(
      extractFromSenatePaperMedia(mockEnv, ['https://efd-media-public.senate.gov/media/a.gif']),
    ).rejects.toThrow('senatePaperMedia: unable to load page scan images');
  });
});

describe('senate paper OCR prompt', () => {
  it('tells the model to skip printed IBM/Microsoft examples and read attachments', () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../senatePaperMedia.ts'),
      'utf8',
    );
    expect(src).toMatch(/IBM Corp\. \(stock\) NYSE/);
    expect(src).toMatch(/Microsoft \(stock\) NASDAQ\/OTC/);
    expect(src).toMatch(/See Attachment/);
    expect(src).toMatch(/1X\/XX placeholder years/);
  });
});

describe('senate paper viewer and HTML enhancement', () => {
  it('renders a clean, standalone multi-page reader for paper filings', () => {
    const mediaUrls = [
      'https://efd-media-public.senate.gov/media/2026/2/000/000/000000145.gif',
      'https://efd-media-public.senate.gov/media/2026/2/000/000/000000146.gif',
    ];
    const docId = 'S-16afdd38-c0ec-4e37-bc05-cbd82901b43f';
    const sourceUrl = 'https://efdsearch.senate.gov/search/view/paper/16afdd38-c0ec-4e37-bc05-cbd82901b43f/';
    const rendered = renderSenatePaperViewer(mediaUrls, docId, sourceUrl);

    expect(rendered).toContain('<!DOCTYPE html>');
    expect(rendered).toContain(docId);
    expect(rendered).toContain('Page 1 of 2');
    expect(rendered).toContain('Page 2 of 2');
    expect(rendered).toContain('https://efd-media-public.senate.gov/media/2026/2/000/000/000000145.gif');
    expect(rendered).toContain('https://efd-media-public.senate.gov/media/2026/2/000/000/000000146.gif');
    // Must NOT contain any script tags because it serves under CSP sandbox
    expect(rendered).not.toContain('<script');
  });

  it('transforms Senate paper viewer HTML shell into image viewer', () => {
    const enhanced = enhanceSenateHtmlDocument(PAPER_SHELL, 'S-test-paper', 'https://example.com/source');
    expect(enhanced).toContain('Page 1 of 2');
    expect(enhanced).toContain('https://efd-media-public.senate.gov/media/2026/2/000/000/000000145.gif');
    expect(enhanced).not.toContain('<script');
  });

  it('injects fallback CSS into electronic Senate table HTML', () => {
    const enhanced = enhanceSenateHtmlDocument(ELECTRONIC_PTR, 'S-test-elec');
    expect(enhanced).toContain('/* fallback-injected-style */');
    expect(enhanced).toContain('table {');
    expect(enhanced).toContain('AAPL');
  });

  it('returns plain text or non-table HTML as-is', () => {
    const plain = 'Plain text content without tables';
    expect(enhanceSenateHtmlDocument(plain)).toBe(plain);
  });
});


