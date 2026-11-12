/**
 * src/extraction/senateHtml.ts
 * OWNER: extraction agent
 *
 * Extractor for Senate eFD HTML disclosures (docKind 'senate_html').
 *
 * The Senate Electronic Financial Disclosure (eFD) Periodic Transaction Report
 * renders trades as an HTML <table>. The canonical electronic-PTR columns are:
 *
 *   #  | Transaction Date | Owner | Ticker | Asset Name | Asset Type | Type |
 *   Amount | Comment
 *
 * Older / variant reports may omit "Owner" or "Asset Type" or carry an extra
 * "Cap Gains > $200?" column. We therefore drive parsing from the header row
 * (mapping a column label -> index) rather than fixed positions, and fall back
 * to a positional heuristic when no recognizable header exists.
 *
 * Paper PTRs (`/search/view/paper/<uuid>/`) are an HTML viewer whose real content
 * is multi-page scans on efd-media-public.senate.gov. When the table path yields
 * zero rows but paper media images are present, we OCR those public page images
 * via OpenRouter (see senatePaperMedia.ts).
 */

import { parse } from 'node-html-parser';
import type { HTMLElement } from 'node-html-parser';

import type { Extractor, ExtractorInput, ExtractorResult } from '../extractors/types.ts';
import type { Env, Filing, Owner, ParsedTx, TxType } from '../shared/types.ts';
import { parseAmountRange } from './amounts.ts';
import {
  extractFromSenatePaperMedia,
  extractSenatePaperMediaUrls,
  isSenatePaperViewerHtml,
} from './senatePaperMedia.ts';

/** Confidence assigned to a clean electronic-table parse. */
const CLEAN_CONFIDENCE = 0.97;
/** Confidence when we had to fall back to positional column heuristics. */
const FALLBACK_CONFIDENCE = 0.8;

export class SenateHtmlExtractor implements Extractor {
  readonly name = 'senateHtml';

  constructor(private readonly env?: Env) {}

  /** Handles Senate eFD HTML documents. */
  canHandle(f: Filing): boolean {
    return f.docKind === 'senate_html';
  }

  async extract(input: ExtractorInput): Promise<ExtractorResult> {
    const html = input.html ?? bytesToString(input.bytes);
    if (!html) {
      throw new Error('senateHtml: no html/bytes provided on ExtractorInput');
    }

    const root = parse(html);
    const table = pickTransactionTable(root);
    if (table) {
      const { rows, usedHeader } = parseTable(table);
      if (rows.length > 0) {
        const baseConfidence = usedHeader ? CLEAN_CONFIDENCE : FALLBACK_CONFIDENCE;
        return {
          transactions: rows,
          confidence: baseConfidence,
          raw: table.toString(),
          extractor: this.name,
        };
      }
    }

    // Paper viewer shell: real content is public page-scan images.
    const mediaUrls = extractSenatePaperMediaUrls(html);
    if (this.env && mediaUrls.length > 0 && isSenatePaperViewerHtml(html)) {
      const paper = await extractFromSenatePaperMedia(this.env, mediaUrls, {
        signal: input.signal,
      });
      return {
        transactions: paper.transactions,
        confidence: paper.confidence,
        raw: `paper-media:${mediaUrls.length}`,
        extractor: 'senatePaperMedia',
        modelVersion: paper.modelVersion || null,
        usage: paper.usage
          ? {
              promptTokens: paper.usage.promptTokens,
              completionTokens: paper.usage.completionTokens,
              costUsd: paper.usage.costUsd,
            }
          : undefined,
      };
    }

    return {
      transactions: [],
      confidence: 0.3,
      raw: html,
      extractor: this.name,
    };
  }
}

// ---------------------------------------------------------------------------
// Table selection + parsing
// ---------------------------------------------------------------------------

const HEADER_HINTS = ['transaction', 'ticker', 'asset', 'amount', 'type'];

/** Pick the table most likely to be the transaction table. */
function pickTransactionTable(root: HTMLElement): HTMLElement | null {
  const tables = root.querySelectorAll('table');
  if (tables.length === 0) return null;
  let best: HTMLElement | null = null;
  let bestScore = -1;
  for (const t of tables) {
    const text = t.text.toLowerCase();
    let score = 0;
    for (const hint of HEADER_HINTS) if (text.includes(hint)) score += 1;
    score += Math.min(t.querySelectorAll('tr').length, 5) * 0.1;
    if (score > bestScore) {
      bestScore = score;
      best = t;
    }
  }
  return bestScore >= 2 ? best : tables[0];
}

interface ColumnMap {
  date: number;
  owner: number;
  ticker: number;
  assetName: number;
  assetType: number;
  type: number;
  amount: number;
  capGains: number;
  comment: number;
}

const EMPTY_MAP: ColumnMap = {
  date: -1,
  owner: -1,
  ticker: -1,
  assetName: -1,
  assetType: -1,
  type: -1,
  amount: -1,
  capGains: -1,
  comment: -1,
};

function buildColumnMap(headerCells: string[]): ColumnMap | null {
  const map: ColumnMap = { ...EMPTY_MAP };
  let matched = 0;
  headerCells.forEach((raw, i) => {
    const h = raw.toLowerCase().trim();
    if (h.includes('transaction date') || h === 'date') {
      map.date = i;
      matched++;
    } else if (h === 'owner') {
      map.owner = i;
      matched++;
    } else if (h === 'ticker') {
      map.ticker = i;
      matched++;
    } else if (h.includes('asset name') || h === 'asset' || h.includes('description')) {
      map.assetName = i;
      matched++;
    } else if (h.includes('asset type')) {
      map.assetType = i;
      matched++;
    } else if (h === 'type' || h.includes('transaction type')) {
      map.type = i;
      matched++;
    } else if (h.includes('amount')) {
      map.amount = i;
      matched++;
    } else if (h.includes('cap') && h.includes('gain')) {
      map.capGains = i;
      matched++;
    } else if (h.includes('comment')) {
      map.comment = i;
      matched++;
    }
  });
  if (map.amount >= 0 && map.type >= 0 && (map.assetName >= 0 || map.ticker >= 0) && matched >= 3) {
    return map;
  }
  return null;
}

/**
 * Positional fallback mirroring the canonical electronic-PTR layout:
 *   0:#  1:date  2:owner  3:ticker  4:assetName  5:assetType  6:type  7:amount
 */
function positionalMap(cols: number): ColumnMap {
  if (cols >= 8) {
    return {
      date: 1,
      owner: 2,
      ticker: 3,
      assetName: 4,
      assetType: 5,
      type: 6,
      amount: 7,
      capGains: -1,
      comment: cols > 8 ? 8 : -1,
    };
  }
  return {
    date: 1,
    owner: -1,
    ticker: 2,
    assetName: 3,
    assetType: -1,
    type: 4,
    amount: 5,
    capGains: -1,
    comment: -1,
  };
}

function parseTable(table: HTMLElement): { rows: ParsedTx[]; usedHeader: boolean } {
  const trs = table.querySelectorAll('tr');
  if (trs.length === 0) return { rows: [], usedHeader: false };

  let headerIdx = trs.findIndex((tr) => tr.querySelectorAll('th').length > 0);
  if (headerIdx < 0) headerIdx = 0;
  const headerCells = cellTexts(trs[headerIdx]);

  let map = buildColumnMap(headerCells);
  const usedHeader = map !== null;
  if (!map) {
    let widest = headerCells.length;
    for (let i = headerIdx + 1; i < trs.length; i++) {
      widest = Math.max(widest, cellTexts(trs[i]).length);
    }
    map = positionalMap(widest);
  }

  const rows: ParsedTx[] = [];
  for (let i = headerIdx + 1; i < trs.length; i++) {
    const cells = cellTexts(trs[i]);
    if (cells.length === 0) continue;
    if (looksLikeHeader(cells)) continue;
    const tx = rowToParsedTx(cells, map, usedHeader ? CLEAN_CONFIDENCE : FALLBACK_CONFIDENCE);
    if (tx) {
      const detail = splitAssetDetail(trs[i], map.assetName);
      if (detail) {
        tx.assetName = detail.name || tx.ticker || '(unknown)';
        tx.description = detail.description;
      }
      rows.push(tx);
    }
  }

  return { rows, usedHeader };
}

function rowToParsedTx(cells: string[], map: ColumnMap, confidence: number): ParsedTx | null {
  const get = (i: number): string => (i >= 0 && i < cells.length ? cells[i] : '');

  const rawType = get(map.type);
  const txType = normalizeTxType(rawType);
  const assetName = get(map.assetName).trim();
  const tickerRaw = get(map.ticker).trim();
  const amountRaw = get(map.amount);

  if (!assetName && !tickerRaw && !amountRaw) return null;
  if (!txType) return null;

  const { min, max } = parseAmountRange(amountRaw);
  const ticker = normalizeTicker(tickerRaw);
  const combinedText = cells.join(' ');
  const capGainsCell = get(map.capGains);
  const assetType = get(map.assetType).trim() || null;

  return {
    txDate: normalizeDate(get(map.date)),
    owner: normalizeOwner(get(map.owner), assetName),
    assetName: assetName || tickerRaw || '(unknown)',
    ticker,
    assetType,
    assetTypeName: assetType,
    txType,
    amountMin: min,
    amountMax: max,
    isOption: detectOption(`${assetName} ${get(map.assetType)} ${get(map.comment)}`),
    capGainsOver200: detectCapGains(capGainsCell, combinedText),
    rawText: combinedText.replace(/\s+/g, ' ').trim(),
    confidence,
  };
}

// ---------------------------------------------------------------------------
// Field normalizers (exported for unit tests)
// ---------------------------------------------------------------------------

/** Map a Buy/Sell/Exchange (Purchase/Sale) label to the storage TxType code P|S|E. */
export function normalizeTxType(raw: string): TxType | null {
  const s = (raw || '').toLowerCase().trim();
  if (!s) return null;
  // Product short letter B (= Buy) aliases storage P.
  if (s.includes('purchase') || s.includes('buy') || s === 'p' || s === 'b') return 'B';
  if (s.includes('exchange') || s === 'e') return 'E';
  if (s.includes('sale') || s.includes('sold') || s.includes('sell') || s === 's') return 'S';
  if (s.includes('partial') || s.includes('full')) return 'S';
  return null;
}

/**
 * Derive beneficial owner from the Senate owner cell. Senate eFD uses the codes
 * Self / Spouse / Joint / Child (dependent). The asset name occasionally carries
 * the marker when the column is absent, hence the second argument.
 */
export function normalizeOwner(raw: string, assetFallback = ''): Owner | null {
  const s = `${raw} ${assetFallback}`.toLowerCase();
  if (s.includes('spouse') || /\bsp\b/.test(s)) return 'spouse';
  if (s.includes('joint') || /\bjt\b/.test(s)) return 'joint';
  if (s.includes('child') || s.includes('dependent') || /\bdc\b/.test(s)) return 'dependent';
  if (s.includes('self') || /\bself\b/.test(s)) return 'self';
  return raw.trim() ? 'self' : null;
}

/** Strip a ticker cell down to a usable symbol, or null when absent. */
export function normalizeTicker(raw: string): string | null {
  const t = (raw || '').trim().toUpperCase();
  if (!t || t === '--' || t === '-' || t === 'N/A' || t === 'NA') return null;
  const m = t.match(/[A-Z][A-Z0-9.^\-]{0,9}/);
  return m ? m[0] : null;
}

/** Detect option-style holdings. */
export function detectOption(text: string): boolean {
  const s = (text || '').toLowerCase();
  return /\boption\b|\bcall\b|\bput\b|\bwarrant\b/.test(s);
}

/** Detect a ">$200" capital-gains flag (column-cell or inline text). */
export function detectCapGains(cell: string, fullText: string): boolean {
  const c = (cell || '').toLowerCase().trim();
  if (c === 'yes' || c === 'y' || c === 'true' || c === 'x' || c === '✓') return true;
  if (c === '') {
    return /(>|over|exceed).{0,8}\$?\s*200|cap.{0,6}gain.{0,12}(>|over)\s*\$?200/i.test(fullText || '');
  }
  if (c === 'no' || c === 'n' || c === 'false') return false;
  return /(>|over|exceed).{0,8}\$?\s*200/i.test(c);
}

/** Pass through an ISO-ish or MM/DD/YYYY date as a trimmed string (or null). */
export function normalizeDate(raw: string): string | null {
  const t = (raw || '').trim();
  if (!t) return null;
  const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    const [, mm, dd, yy] = m;
    const year = yy.length === 2 ? `20${yy}` : yy;
    return `${year}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
  }
  return t;
}

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

function cellTexts(tr: HTMLElement): string[] {
  const cells = tr.querySelectorAll('th, td');
  return cells.map((c) => c.text.replace(/ /g, ' ').replace(/\s+/g, ' ').trim());
}

/**
 * eFD renders non-ticker assets (partnerships, private funds) with muted
 * detail lines inside the Asset Name cell:
 *
 *   MH Built to Last LLC
 *   <div class="text-muted"><em>Company:</em> MH Built to Last LLC (New York, NY)</div>
 *   <div class="text-muted"><em>Description:</em> Partnership</div>
 *
 * Flattening the cell glued those lines into assetName, and the ':' then
 * tripped the OCR name hold on a typed HTML filing.  Keep the primary name as
 * assetName and move the detail lines to description.  Returns null when the
 * cell has no muted detail lines (the cell text is used as-is).
 */
export function splitAssetDetail(
  tr: HTMLElement,
  assetCol: number,
): { name: string; description: string } | null {
  if (assetCol < 0) return null;
  const cell = tr.querySelectorAll('th, td')[assetCol];
  if (!cell) return null;
  const details = cell.querySelectorAll('.text-muted');
  if (details.length === 0) return null;
  const clean = (t: string): string => t.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').replace(/\s+\(/g, ' (').trim();
  const lines = details.map((d) => clean(d.text)).filter(Boolean);
  // Strip the muted nodes from a clone so the parsed tree (and the table
  // serialized into ExtractorResult.raw) keeps the original detail lines.
  const nameCell = cell.clone() as HTMLElement;
  for (const d of nameCell.querySelectorAll('.text-muted')) d.remove();
  return { name: clean(nameCell.text), description: lines.join('; ') };
}

function looksLikeHeader(cells: string[]): boolean {
  const joined = cells.join(' ').toLowerCase();
  return joined.includes('transaction date') && joined.includes('amount');
}

function bytesToString(bytes?: ArrayBuffer): string | null {
  if (!bytes) return null;
  return new TextDecoder('utf-8').decode(bytes);
}
