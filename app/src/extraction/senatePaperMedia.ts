/**
 * Senate paper PTR media recovery.
 *
 * Electronic PTRs are HTML tables. Paper PTRs (`/search/view/paper/<uuid>/`) are
 * an HTML viewer shell whose real content is multi-page scans hosted on
 * efd-media-public.senate.gov as <img class="filingImage"> GIFs. Storing only
 * the shell and running senateHtml yields zero rows even though the trades are
 * public page images.
 *
 * This module extracts those public media URLs and OCRs them via OpenRouter
 * vision (image_url — CDN is public, no R2 rewrite required).
 */

import type { Env, Owner, ParsedTx, TxType } from '../shared/types.ts';
import { resolveSecret } from '../secrets/infisical.ts';
import { parseAmountRange } from './amounts.ts';
import {
  looksLikePtrFormSampleAsset,
  looksLikePtrFormSampleRow,
  looksLikeSeeAttachmentPointer,
} from './extractRouting.ts';
import { parseTruncationAwareJson, fetchWithRetry, arrayBufferToBase64 } from './visionLlm.ts';
import { createProxiedFetch, resolveResidentialProxyUrl } from '../shared/proxyFetch.ts';
import { trackedFetch } from '../shared/thirdPartyTelemetry.ts';
import { senateRelayAuthHeaders } from '../ingestion/senateRelayHealth.ts';
import {
  OPENROUTER_PURPOSE,
  buildOpenRouterClassifier,
  openRouterAttributionHeaders,
} from '../shared/openRouterAttribution.ts';

const EFD_MEDIA_HOST = 'efd-media-public.senate.gov';
const DEFAULT_MODEL = 'google/gemini-2.5-flash';
const PAPER_CONFIDENCE = 0.85;

const PAPER_OCR_PROMPT = `This is page image(s) of a Senate paper PERIODIC DISCLOSURE OF FINANCIAL TRANSACTIONS form.
Amount columns are checkbox bands left-to-right:
$1,001 - $15,000 | $15,001 - $50,000 | $50,001 - $100,000 | $100,001 - $250,000 | $250,001 - $500,000 | $500,001 - $1,000,000 | Over $1,000,000 | ...
Only emit a transaction when Purchase/Sale/Exchange (Buy/Sell/Exchange) has an X AND one amount band has an X.
txType: B=Buy (Purchase/P), S=Sell (Sale), E=Exchange. Always emit B for buys.
owner: self if no prefix, spouse if (S), joint if (J), dependent if (DC).
Include parent fund/header as subholding when the row is nested under a fund name.
Skip blank rows, cover letters, and header-only fund labels without a date.
NEVER emit the printed Example rows: "IBM Corp. (stock) NYSE" dated 2/1/1X and "(DC) Microsoft (stock) NASDAQ/OTC" dated 2/27/1X. Their amount columns spell EXAMPLE. They are form instructions, not trades. Do not turn 1X/XX placeholder years into 2027.
If a row says "See Attachment", skip it and extract the attached schedule pages. You are given every page image — read the typed attachment, not only the PTR grid.
Return ONLY JSON: {"transactions":[{"txDate":"YYYY-MM-DD","owner":"self|spouse|joint|dependent|unknown","ticker":null,"assetName":"string","subholding":null,"txType":"P|S|E","amountRange":"$A - $B","rawText":"short quote"}]}`;


/** True when HTML looks like the eFD paper filing viewer (carousel of page scans). */
export function isSenatePaperViewerHtml(html: string): boolean {
  const h = html.toLowerCase();
  return (
    h.includes('filingimage')
    || h.includes('/search/view/paper/')
    || h.includes('/search/print/paper/')
    || (h.includes('efd-media-public.senate.gov') && h.includes('page 1 of'))
  );
}

/**
 * Collect absolute page-scan URLs from a paper viewer HTML shell.
 * Prefer img.filingImage; fall back to any efd-media-public media URL.
 */
export function extractSenatePaperMediaUrls(html: string): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();

  const filingImg = /class=["'][^"']*filingImage[^"']*["'][^>]*src=["']([^"']+)["']/gi;
  const filingImg2 = /src=["']([^"']+)["'][^>]*class=["'][^"']*filingImage[^"']*["']/gi;
  for (const re of [filingImg, filingImg2]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      pushUrl(urls, seen, m[1]);
    }
  }

  if (urls.length === 0) {
    const anyMedia = /https?:\/\/efd-media-public\.senate\.gov\/media\/[^"'>\s]+/gi;
    let m: RegExpExecArray | null;
    while ((m = anyMedia.exec(html)) !== null) {
      pushUrl(urls, seen, m[0]);
    }
  }

  return urls;
}

function pushUrl(out: string[], seen: Set<string>, raw: string): void {
  let u = raw.trim();
  if (!u) return;
  if (u.startsWith('//')) u = `https:${u}`;
  if (u.startsWith('/')) return; // relative static assets only
  try {
    const parsed = new URL(u);
    if (parsed.hostname.toLowerCase() !== EFD_MEDIA_HOST) return;
    if (!parsed.pathname.includes('/media/')) return;
  } catch {
    return;
  }
  if (seen.has(u)) return;
  seen.add(u);
  out.push(u);
}

export interface PaperMediaExtractResult {
  transactions: ParsedTx[];
  confidence: number;
  modelVersion: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    costUsd?: number;
  };
  mediaCount: number;
}

async function loadMediaAsDataUrl(
  env: Env,
  url: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const proxyUrl = await resolveResidentialProxyUrl(env);
  const effectiveFetch = proxyUrl ? createProxiedFetch(proxyUrl, fetch) : fetch;
  const senateRelayUrl = env.SENATE_RELAY_URL ? env.SENATE_RELAY_URL.replace(/\/$/, '') : undefined;

  // 1. Try residential proxy if configured
  if (proxyUrl) {
    try {
      const res = await trackedFetch(
        url,
        {
          signal,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer': 'https://efdsearch.senate.gov/',
          },
        },
        {
          service: 'senatePaperMedia',
          operation: 'fetch_paper_image_proxy',
        },
        effectiveFetch,
        { envOverride: env },
      );
      if (res.ok) {
        const contentType = res.headers.get('content-type') || (url.endsWith('.png') ? 'image/png' : url.endsWith('.gif') ? 'image/gif' : 'image/jpeg');
        const buf = await res.arrayBuffer();
        if (buf.byteLength > 0) {
          return `data:${contentType.split(';')[0].trim()};base64,${arrayBufferToBase64(buf)}`;
        }
      }
    } catch {}
  }

  // 2. Try Senate relay /fetch-doc if configured
  if (senateRelayUrl) {
    try {
      const res = await trackedFetch(
        `${senateRelayUrl}/fetch-doc`,
        {
          method: 'POST',
          signal,
          headers: {
            'content-type': 'application/json',
            accept: '*/*',
            ...senateRelayAuthHeaders(env.SENATE_RELAY_SECRET),
          },
          body: JSON.stringify({ url }),
        },
        {
          service: 'senatePaperMedia',
          operation: 'fetch_paper_image_relay',
        },
        fetch,
        { envOverride: env },
      );
      if (res.ok) {
        const contentType = res.headers.get('content-type') || (url.endsWith('.png') ? 'image/png' : url.endsWith('.gif') ? 'image/gif' : 'image/jpeg');
        const buf = await res.arrayBuffer();
        if (buf.byteLength > 0) {
          return `data:${contentType.split(';')[0].trim()};base64,${arrayBufferToBase64(buf)}`;
        }
      }
    } catch {}
  }

  // 3. Fallback direct fetch with browser headers & Referer
  try {
    const res = await trackedFetch(
      url,
      {
        signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer': 'https://efdsearch.senate.gov/',
        },
      },
      {
        service: 'senatePaperMedia',
        operation: 'fetch_paper_image_direct',
      },
      fetch,
      { envOverride: env },
    );
    if (res.ok) {
      const contentType = res.headers.get('content-type') || (url.endsWith('.png') ? 'image/png' : url.endsWith('.gif') ? 'image/gif' : 'image/jpeg');
      const buf = await res.arrayBuffer();
      if (buf.byteLength > 0) {
        return `data:${contentType.split(';')[0].trim()};base64,${arrayBufferToBase64(buf)}`;
      }
    }
  } catch {}

  return null;
}

/**
 * OCR public paper page scans via OpenRouter vision (inline base64 data URLs).
 */
export async function extractFromSenatePaperMedia(
  env: Env,
  mediaUrls: string[],
  opts: { signal?: AbortSignal; model?: string } = {},
): Promise<PaperMediaExtractResult> {
  if (mediaUrls.length === 0) {
    return { transactions: [], confidence: 0.2, modelVersion: '', mediaCount: 0 };
  }

  const keyRes = await resolveSecret(env, 'OPENROUTER_API_KEY');
  const apiKey = keyRes.value?.trim();
  if (!apiKey) {
    throw new Error('senatePaperMedia: OPENROUTER_API_KEY not configured');
  }

  // Prefer explicit opt, else Grok 4.5 via OpenRouter (matches live senate primary).
  const model = opts.model ?? DEFAULT_MODEL;

  const resolvedUrls = await Promise.all(
    mediaUrls.slice(0, 12).map((url) => loadMediaAsDataUrl(env, url, opts.signal)),
  );

  const validDataUrls = resolvedUrls.filter((u): u is string => typeof u === 'string' && u.startsWith('data:'));
  if (validDataUrls.length === 0) {
    throw new Error('senatePaperMedia: unable to load page scan images from Senate eFD (relay/proxy unreachable)');
  }

  const classifierEnrichment = buildOpenRouterClassifier(env, {
    service: 'senatePaperMedia',
    purpose: OPENROUTER_PURPOSE.SENATE_PAPER_OCR,
    feature: 'senate-paper-ocr',
    chamber: 'senate',
    keyRef: 'OPENROUTER_API_KEY',
  });

  // Chunk pages into batches of at most 4 pages to avoid JSON truncation on large filings
  const CHUNK_SIZE = 4;
  const chunks: string[][] = [];
  for (let i = 0; i < validDataUrls.length; i += CHUNK_SIZE) {
    chunks.push(validDataUrls.slice(i, i + CHUNK_SIZE));
  }

  const allTransactions: ParsedTx[] = [];
  let lastModel = model;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalCostUsd: number | undefined = undefined;

  for (const chunk of chunks) {
    const content: Array<Record<string, unknown>> = [
      { type: 'text', text: PAPER_OCR_PROMPT },
    ];
    for (const url of chunk) {
      content.push({ type: 'image_url', image_url: { url } });
    }

    const body = {
      model,
      messages: [{ role: 'user', content }],
      temperature: 0,
      max_tokens: 16000,
      usage: { include: true },
      ...classifierEnrichment,
    };

    const res = await fetchWithRetry(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          ...openRouterAttributionHeaders(),
        },
        body: JSON.stringify(body),
        signal: opts.signal,
      },
      'senate-paper-media-ocr',
      { model, spendGuard: { env, provider: 'openrouter' } },
    );

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`senatePaperMedia: OpenRouter HTTP ${res.status} ${errText.slice(0, 240)}`);
    }

    const payload = await res.json() as {
      model?: string;
      choices?: Array<{ message?: { content?: string } }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        cost?: number;
      };
    };

    if (payload.model) lastModel = payload.model;
    if (typeof payload.usage?.prompt_tokens === 'number') totalPromptTokens += payload.usage.prompt_tokens;
    if (typeof payload.usage?.completion_tokens === 'number') totalCompletionTokens += payload.usage.completion_tokens;
    if (typeof payload.usage?.cost === 'number') {
      totalCostUsd = (totalCostUsd ?? 0) + payload.usage.cost;
    }

    const text = payload.choices?.[0]?.message?.content ?? '';
    const parsed = parseTruncationAwareJson(text);
    const rawRows = Array.isArray(parsed?.rows) ? parsed.rows : [];
    const transactions = rawRows.map(mapPaperRow).filter((t): t is ParsedTx => t !== null);
    allTransactions.push(...transactions);
  }

  return {
    transactions: allTransactions,
    confidence: allTransactions.length > 0 ? PAPER_CONFIDENCE : 0.25,
    modelVersion: `openrouter:${lastModel}`,
    usage: {
      promptTokens: totalPromptTokens || undefined,
      completionTokens: totalCompletionTokens || undefined,
      costUsd: totalCostUsd,
    },
    mediaCount: mediaUrls.length,
  };
}

function normalizeTxDate(raw: unknown): string | null {
  const t = String(raw ?? '').trim();
  if (!t) return null;
  // Printed example years are "1X" / "XX", not a calendar date.
  if (/[xX]/.test(t)) return null;
  const currentYear = new Date().getFullYear();
  let parsedDate: string | null = null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) {
    parsedDate = t;
  } else {
    const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (m) {
      const [, mm, dd, yy] = m;
      const year = yy.length === 2 ? `20${yy}` : yy;
      parsedDate = `${year}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
    } else {
      const iso = new Date(t);
      if (!isNaN(iso.getTime()) && t.length >= 8) {
        parsedDate = iso.toISOString().slice(0, 10);
      }
    }
  }
  if (!parsedDate) return null;
  const y = parseInt(parsedDate.slice(0, 4), 10);
  // Do not accept dates beyond current calendar year (guards against 1X parsed as 2027 etc.)
  if (isNaN(y) || y > currentYear) return null;
  return parsedDate;
}

function mapPaperRow(row: Record<string, unknown>): ParsedTx | null {
  const assetName = typeof row.assetName === 'string'
    ? row.assetName.trim()
    : typeof row.asset_name === 'string'
    ? row.asset_name.trim()
    : typeof row.identification_of_assets === 'string'
    ? row.identification_of_assets.trim()
    : '';
  if (!assetName) return null;
  if (looksLikePtrFormSampleAsset(assetName)) return null;
  if (looksLikeSeeAttachmentPointer(assetName)) return null;

  const rawDate = row.txDate ?? row.transaction_date ?? row.date ?? row.tx_date;
  const txDate = normalizeTxDate(rawDate);
  if (!txDate) return null;

  const rawTxType = row.txType ?? row.transaction_type ?? row.type ?? row.tx_type;
  const txType = normalizeTxType(rawTxType);
  if (!txType) return null;

  const amountRange = typeof row.amountRange === 'string'
    ? row.amountRange
    : typeof row.amount_of_transaction === 'string'
    ? row.amount_of_transaction
    : typeof row.amount === 'string'
    ? row.amount
    : '';
  const { min, max } = parseAmountRange(amountRange);

  const owner = normalizeOwner(row.owner);
  const subholding = typeof row.subholding === 'string' && row.subholding.trim()
    ? row.subholding.trim()
    : null;
  const ticker = typeof row.ticker === 'string' && row.ticker.trim()
    ? row.ticker.trim().toUpperCase()
    : null;
  const rawText = typeof row.rawText === 'string' ? row.rawText : `${assetName} ${txDate} ${txType}`;

  if (looksLikePtrFormSampleRow({ assetName, rawText, amountRange, txDate, amountMin: min, amountMax: max })) {
    return null;
  }

  return {
    txDate,
    owner,
    assetName,
    ticker,
    assetType: 'other',
    txType,
    amountMin: min,
    amountMax: max,
    isOption: false,
    capGainsOver200: false,
    rawText,
    subholding,
    confidence: PAPER_CONFIDENCE,
  };
}

function normalizeTxType(raw: unknown): TxType | null {
  const s = String(raw ?? '').trim().toUpperCase();
  // Storage P|S|E; product buy letter B aliases P.
  if (s === 'P' || s === 'B' || s.startsWith('PURCH') || s === 'BUY') return 'B';
  if (s === 'S' || s.startsWith('SALE') || s.startsWith('SELL')) return 'S';
  if (s === 'E' || s.startsWith('EXCH')) return 'E';
  return null;
}

function normalizeOwner(raw: unknown): Owner {
  const s = String(raw ?? '').trim().toLowerCase();
  if (s === 'spouse' || s === 's' || s === '(s)') return 'spouse';
  if (s === 'joint' || s === 'j' || s === '(j)') return 'joint';
  if (s === 'dependent' || s === 'dc' || s === '(dc)') return 'dependent';
  // Owner is a closed enum (self|spouse|joint|dependent). Unspecified/blank PTR
  // rows match vision extraction: default to self rather than inventing "unknown".
  return 'self';
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Renders a clean, standalone multi-page reader for Senate paper PTRs.
 * The upstream eFD paper shell requires scripts and relative resources that 404
 * or fail under CSP sandbox. This viewer displays the scanned pages sequentially
 * using the public efd-media-public.senate.gov image links with zero script dependencies.
 */
export function renderSenatePaperViewer(
  mediaUrls: string[],
  docId?: string,
  sourceUrl?: string | null,
): string {
  const pageCount = mediaUrls.length;
  const title = docId ? `Senate Paper Disclosure — ${escapeHtml(docId)}` : 'Senate Paper Disclosure';
  const sourceLink = sourceUrl
    ? `<a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer" class="source-link">View original on eFD &rarr;</a>`
    : '';

  const pagesHtml = mediaUrls
    .map((url, idx) => {
      const pageNum = idx + 1;
      return `
      <section class="paper-page-card" id="page-${pageNum}">
        <div class="page-header">
          <span class="page-badge">Page ${pageNum} of ${pageCount}</span>
          <a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" class="raw-image-link" download>Download Image</a>
        </div>
        <div class="image-wrapper">
          <img class="paper-scan-img" src="${escapeHtml(url)}" alt="Page scan ${pageNum} of ${pageCount}" loading="${pageNum <= 2 ? 'eager' : 'lazy'}" />
        </div>
      </section>`;
    })
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    :root {
      --bg: #0b0f17;
      --card-bg: #141c2b;
      --border: #233047;
      --text: #e2e8f0;
      --text-muted: #94a3b8;
      --accent: #38bdf8;
      --badge-bg: #1e293b;
    }
    @media (prefers-color-scheme: light) {
      :root {
        --bg: #f8fafc;
        --card-bg: #ffffff;
        --border: #e2e8f0;
        --text: #0f172a;
        --text-muted: #64748b;
        --accent: #0284c7;
        --badge-bg: #f1f5f9;
      }
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      line-height: 1.5;
      padding: 1.5rem 1rem 4rem;
      display: flex;
      flex-direction: column;
      align-items: center;
    }
    header {
      width: 100%;
      max-width: 900px;
      margin-bottom: 2rem;
      padding-bottom: 1rem;
      border-bottom: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 1rem;
    }
    h1 {
      font-size: 1.25rem;
      font-weight: 700;
      letter-spacing: -0.01em;
    }
    .header-links {
      display: flex;
      gap: 1rem;
      font-size: 0.875rem;
    }
    a {
      color: var(--accent);
      text-decoration: none;
    }
    a:hover {
      text-decoration: underline;
    }
    .main-container {
      width: 100%;
      max-width: 900px;
      display: flex;
      flex-direction: column;
      gap: 2rem;
    }
    .paper-page-card {
      background-color: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      overflow: hidden;
      box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -2px rgba(0, 0, 0, 0.1);
    }
    .page-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 0.75rem 1.25rem;
      background-color: var(--badge-bg);
      border-bottom: 1px solid var(--border);
      font-size: 0.875rem;
    }
    .page-badge {
      font-weight: 600;
      color: var(--text);
    }
    .image-wrapper {
      padding: 1rem;
      display: flex;
      justify-content: center;
      background-color: #fff; /* Scanned documents require white background for readability */
    }
    .paper-scan-img {
      max-width: 100%;
      height: auto;
      display: block;
      border: 1px solid #e2e8f0;
    }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>${title}</h1>
      <p style="font-size: 0.875rem; color: var(--text-muted); margin-top: 0.25rem;">
        Official multi-page public disclosure scan (${pageCount} page${pageCount === 1 ? '' : 's'})
      </p>
    </div>
    <div class="header-links">
      ${sourceLink}
    </div>
  </header>
  <main class="main-container">
    ${pagesHtml}
  </main>
</body>
</html>`;
}

/**
 * Enhances stored Senate HTML (paper viewer shell or electronic tables) so that
 * when served read-only under CSP sandbox ('sandbox' disables all scripts),
 * the document renders cleanly and legibly instead of as a broken shell.
 */
export function enhanceSenateHtmlDocument(
  html: string,
  docId?: string,
  sourceUrl?: string | null,
): string {
  if (isSenatePaperViewerHtml(html)) {
    const urls = extractSenatePaperMediaUrls(html);
    if (urls.length > 0) {
      return renderSenatePaperViewer(urls, docId, sourceUrl);
    }
  }

  // If it's an electronic report or fallback, ensure styling is present so it renders legibly
  // under sandbox CSP where external stylesheets are blocked.
  if (html.includes('<table') && !html.includes('/* fallback-injected-style */')) {
    const fallbackStyle = `
<style id="ct-fallback-style">
  /* fallback-injected-style */
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    line-height: 1.5;
    padding: 1.5rem;
    color: #1e293b;
    background: #f8fafc;
  }
  table {
    border-collapse: collapse;
    width: 100%;
    margin: 1rem 0 2rem;
    background: #fff;
    border: 1px solid #cbd5e1;
    border-radius: 6px;
    overflow: hidden;
  }
  th, td {
    border: 1px solid #cbd5e1;
    padding: 0.6rem 0.8rem;
    text-align: left;
    font-size: 0.875rem;
  }
  th {
    background: #f1f5f9;
    font-weight: 600;
  }
  tr:nth-child(even) td {
    background: #f8fafc;
  }
</style>`;
    if (html.includes('</head>')) {
      return html.replace('</head>', `${fallbackStyle}\n</head>`);
    } else {
      return `${fallbackStyle}\n${html}`;
    }
  }

  return html;
}
