/**
 * Order-preserving grid-form scoring aligner used for Khanna H-2026-9116399
 * bakeoffs. Described in docs/rollouts/2026-11-12-house-grid-form-recall.md.
 */

import { simplifyCompanyName } from './nameNormalizer.ts';

export interface GridAlignRow {
  page: number;
  txType: string | null;
  txDate: string | null;
  notificationDate: string | null;
  owner: string | null;
  assetName: string;
  ticker: string | null;
  amountMin: number | null;
  amountMax: number | null;
}

export interface GridAlignPair {
  hand: GridAlignRow;
  pred: GridAlignRow;
}

export interface GridAlignScore {
  emitted: number;
  aligned: number;
  missed: number;
  extra: number;
  type: number;
  amount: number;
  date: number;
  owner: number;
  asset075: number;
  allFive: number;
  handTotal: number;
  confidenceGte095: number;
  confidenceLt095: number;
}

function tokens(name: string): Set<string> {
  return new Set(
    simplifyCompanyName(name)
      .split(/\s+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 1),
  );
}

export function assetTokenOverlap(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let hit = 0;
  for (const t of ta) if (tb.has(t)) hit += 1;
  return hit / Math.max(ta.size, tb.size);
}

function sameAmount(a: GridAlignRow, b: GridAlignRow): boolean {
  return a.amountMin === b.amountMin && a.amountMax === b.amountMax;
}

function sameOwner(a: GridAlignRow, b: GridAlignRow): boolean {
  const ao = (a.owner ?? '').trim();
  const bo = (b.owner ?? '').trim();
  if (!ao && !bo) return true;
  return ao === bo;
}

function sameDate(a: GridAlignRow, b: GridAlignRow): boolean {
  if (!a.txDate || !b.txDate) return false;
  return a.txDate === b.txDate;
}

/** Rollout pairing rule: type agrees, or asset and trade date identify the same row. */
export function rowMatches(hand: GridAlignRow, pred: GridAlignRow): boolean {
  if (hand.txType && pred.txType && hand.txType === pred.txType) return true;
  if (
    hand.txDate
    && pred.txDate
    && hand.txDate === pred.txDate
    && assetTokenOverlap(hand.assetName, pred.assetName) >= 0.75
  ) {
    return true;
  }
  return false;
}

export function alignGridFormRowsByPage(
  hand: readonly GridAlignRow[],
  pred: readonly GridAlignRow[],
): GridAlignPair[] {
  const pairs: GridAlignPair[] = [];
  const pages = [...new Set([...hand.map((r) => r.page), ...pred.map((r) => r.page)])].sort((a, b) => a - b);
  for (const page of pages) {
    const h = hand.filter((r) => r.page === page);
    const p = pred.filter((r) => r.page === page);
    pairs.push(...orderPreservingAlign(h, p));
  }
  return pairs;
}

/**
 * Walk each hand row in page order. Scan preds only forward from the last match
 * so phantom rows in the middle do not steal preds from later hand rows.
 */
function orderPreservingAlign(
  hand: readonly GridAlignRow[],
  pred: readonly GridAlignRow[],
): GridAlignPair[] {
  const pairs: GridAlignPair[] = [];
  let predIndex = 0;
  for (const hr of hand) {
    let match = -1;
    for (let i = predIndex; i < pred.length; i += 1) {
      const pr = pred[i];
      const assetHit = assetTokenOverlap(hr.assetName, pr.assetName) >= 0.75;
      if (hr.txDate && pr.txDate && hr.txDate === pr.txDate && assetHit) {
        match = i;
        break;
      }
    }
    if (match < 0) {
      for (let i = predIndex; i < pred.length; i += 1) {
        if (rowMatches(hr, pred[i])) {
          match = i;
          break;
        }
      }
    }
    if (match >= 0) {
      pairs.push({ hand: hr, pred: pred[match] });
      predIndex = match + 1;
    }
  }
  return pairs;
}

export function scoreGridFormAlignment(
  hand: readonly GridAlignRow[],
  pred: readonly GridAlignRow[],
  confidences?: readonly number[],
): GridAlignScore {
  const pairs = alignGridFormRowsByPage(hand, pred);
  let type = 0;
  let amount = 0;
  let date = 0;
  let owner = 0;
  let asset075 = 0;
  let allFive = 0;
  for (const { hand: h, pred: p } of pairs) {
    const typeHit = h.txType === p.txType;
    const amountHit = sameAmount(h, p);
    const dateHit = sameDate(h, p);
    const ownerHit = sameOwner(h, p);
    const assetHit = assetTokenOverlap(h.assetName, p.assetName) >= 0.75;
    if (typeHit) type += 1;
    if (amountHit) amount += 1;
    if (dateHit) date += 1;
    if (ownerHit) owner += 1;
    if (assetHit) asset075 += 1;
    if (typeHit && amountHit && dateHit && ownerHit && assetHit) allFive += 1;
  }
  const aligned = pairs.length;
  const gte = confidences ? confidences.filter((c) => c >= 0.95).length : 0;
  const lt = confidences ? confidences.filter((c) => c < 0.95).length : 0;
  return {
    emitted: pred.length,
    aligned,
    missed: hand.length - aligned,
    extra: pred.length - aligned,
    type,
    amount,
    date,
    owner,
    asset075,
    allFive,
    handTotal: hand.length,
    confidenceGte095: gte,
    confidenceLt095: lt,
  };
}
