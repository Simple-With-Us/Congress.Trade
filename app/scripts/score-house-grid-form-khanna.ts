/**
 * Score H-2026-9116399 grid-form output against the 275 manual rows on
 * congress.trade. Requires pdftoppm, tesseract, and outbound HTTPS.
 *
 *   deno run --allow-read --allow-write --allow-run --allow-env --allow-net \
 *     app/scripts/score-house-grid-form-khanna.ts [/path/to/filing.pdf]
 */

import { createDenoHouseGridReader } from '../src/extraction/houseGridFormRuntime.ts';
import { scoreGridFormAlignment, type GridAlignRow } from '../src/extraction/houseGridFormAlign.ts';
import type { ParsedTx } from '../src/shared/types.ts';

const DOC_ID = 'H-2026-9116399';

function pageFromSupplemental(text: string | null | undefined): number {
  if (!text) return 1;
  const grid = /grid page\s+(\d+)/i.exec(text);
  if (grid) return Number(grid[1]);
  const manual = /page\s+(\d+)(?:\s+of)?/i.exec(text);
  return manual ? Number(manual[1]) : 1;
}

function notificationFromDescription(desc: string | null | undefined): string | null {
  if (!desc) return null;
  const m = /date notified\s+(\d{4}-\d{2}-\d{2})/i.exec(desc);
  if (m) return m[1];
  const loose = /date notified\s+(\d{1,2}\/\d{1,2}\/\d{2,4})/i.exec(desc);
  if (!loose) return null;
  const parts = loose[1].split('/');
  const year = parts[2].length === 2 ? 2000 + Number(parts[2]) : Number(parts[2]);
  return `${year}-${parts[0].padStart(2, '0')}-${parts[1].padStart(2, '0')}`;
}

function toAlignRow(tx: {
  txType?: string | null;
  txDate?: string | null;
  owner?: string | null;
  assetName?: string | null;
  ticker?: string | null;
  amountMin?: number | null;
  amountMax?: number | null;
  supplementalText?: string | null;
  description?: string | null;
  confidence?: number | null;
}): GridAlignRow {
  return {
    page: pageFromSupplemental(tx.supplementalText),
    txType: tx.txType ?? null,
    txDate: tx.txDate ?? null,
    notificationDate: notificationFromDescription(tx.description),
    owner: tx.owner ?? null,
    assetName: tx.assetName ?? '',
    ticker: tx.ticker ?? null,
    amountMin: tx.amountMin ?? null,
    amountMax: tx.amountMax ?? null,
  };
}

async function loadManualHandRows(): Promise<{ filedDate: string; rows: GridAlignRow[] }> {
  const url = `https://congress.trade/api/filings/${DOC_ID}`;
  const res = await fetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; CongressTradeGridScore/1.0)' },
  });
  if (!res.ok) throw new Error(`hand rows fetch ${res.status}`);
  const body = await res.json() as {
    filing: { filedDate: string };
    transactions: ParsedTx[];
  };
  return {
    filedDate: body.filing.filedDate,
    rows: body.transactions.map((tx) => toAlignRow(tx)),
  };
}

function printScore(label: string, score: ReturnType<typeof scoreGridFormAlignment>): void {
  console.log(label);
  console.log(
    JSON.stringify(
      {
        emitted: score.emitted,
        aligned: score.aligned,
        missed: score.missed,
        extra: score.extra,
        type: `${score.type}/${score.aligned}`,
        amount: `${score.amount}/${score.aligned}`,
        date: `${score.date}/${score.aligned}`,
        owner: `${score.owner}/${score.aligned}`,
        asset075: `${score.asset075}/${score.aligned}`,
        allFive: `${score.allFive}/${score.handTotal}`,
        confidenceGte095: score.confidenceGte095,
        confidenceLt095: score.confidenceLt095,
      },
      null,
      2,
    ),
  );
}

const pdfPath = Deno.args[0] ?? '/tmp/khanna.pdf';
const bytes = await Deno.readFile(pdfPath);
const { filedDate, rows: hand } = await loadManualHandRows();
const reader = createDenoHouseGridReader();
const read = await reader.read(bytes.buffer, { filedDate });
if (!read?.detected) {
  console.error('grid reader did not detect a form');
  Deno.exit(1);
}
const pred = read.transactions.map((tx) => toAlignRow(tx));
const confidences = read.transactions.map((tx) => tx.confidence);
const score = scoreGridFormAlignment(hand, pred, confidences);
printScore(`H-2026-9116399 grid score (filed ${filedDate})`, score);
