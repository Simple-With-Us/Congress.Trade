/**
 * src/admin/reviewCorrection.ts
 *
 * Correction mode for an admin manual/confirm republish (POST /review/:docId
 * with `correction: true`).
 *
 * The problem: fixing a published filing meant Unpublish (soft-deprecate every
 * live row) and then a manual decision that INSERTs the corrected set with new
 * transaction ids.  Every row then gets a fresh delivery_outbox entry, a fresh
 * cursor_seq and a fresh created_at, so webhooks, APNs and SSE re-announce the
 * whole filing as new trades (Trump 09-08-2026: 1,156 rows re-alerted to fix
 * 7 dates and add 43 missing rows).
 *
 * Correction mode keeps transaction identity instead.  Each submitted row is
 * matched against the rows that were live just before the republish (the most
 * recent deprecation batch for this doc) and, when it matches, the old row is
 * revived in place with the corrected fields: same id, same cursor_seq, same
 * created_at, no new outbox entry.  Only rows with no match are inserted, and
 * only those deliver.
 *
 * Matching, in order (each prior row is claimed at most once):
 *   1. explicit  — the edit names `correctsTxId`, any previously published
 *                  (deprecated) row of this doc.  The caller's word wins.
 *   2. unchanged — same tx date, owner, type and amount bracket, and the same
 *                  asset (ticker, or the simplified company name).  Case and
 *                  punctuation changes ("Plexus Corp." vs "PLEXUS CORP") are
 *                  still "unchanged".
 *   3. corrected — same asset, type and owner, with the date and/or amount
 *                  changed, and the pairing is unique BOTH ways among the rows
 *                  still unmatched.  Anything ambiguous (two lots of the same
 *                  stock) is left unmatched and inserts as a new row rather
 *                  than risk folding a real new trade into an old one.
 *
 * Prior rows that match nothing stay deprecated (they were wrong or removed).
 * Pure: no I/O here; the route loads candidates and writes the result.
 */

import { simplifyCompanyName } from '../extraction/nameNormalizer.ts';

export type CorrectionMatchKind = 'explicit' | 'unchanged' | 'corrected';

/** A previously published row of the doc (deprecated by the unpublish). */
export interface PriorTxRow {
  id: string;
  tx_date: string | null;
  owner: string | null;
  asset_name: string | null;
  ticker: string | null;
  tx_type: string | null;
  amount_min: number | null;
  amount_max: number | null;
  deprecated_at: string | null;
}

/** The fields of a validated edit that matching looks at. */
export interface CorrectionEdit {
  txDate: string;
  owner: string | null;
  assetName?: string | null;
  ticker?: string | null;
  txType: string;
  amountMin?: number | null;
  amountMax?: number | null;
  correctsTxId?: string | null;
}

export interface CorrectionMatch {
  /** Index into the edits array. */
  editIndex: number;
  /** Prior transaction id the edit revives. */
  txId: string;
  kind: CorrectionMatchKind;
}

export type CorrectionPlan =
  | {
    ok: true;
    matches: CorrectionMatch[];
    /** Edit indexes with no prior match: inserted as new rows (these deliver). */
    added: number[];
    /** Prior ids from the latest live set that matched nothing (stay deprecated). */
    retired: string[];
  }
  | { ok: false; error: string };

function assetKeys(name: string | null | undefined, ticker: string | null | undefined): string[] {
  const keys: string[] = [];
  const t = (ticker ?? '').trim().toUpperCase();
  if (t) keys.push(`T:${t}`);
  const n = simplifyCompanyName((name ?? '').trim());
  if (n) keys.push(`N:${n}`);
  return keys;
}

function sameAsset(a: readonly string[], b: readonly string[]): boolean {
  // Two tickers that differ are different assets even if names overlap.
  const at = a.find((k) => k.startsWith('T:'));
  const bt = b.find((k) => k.startsWith('T:'));
  if (at && bt) return at === bt;
  return a.some((k) => b.includes(k));
}

function norm(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function coreKey(date: string | null, owner: string | null, type: string | null, min: number | null, max: number | null): string {
  return [date ?? '', norm(owner), (type ?? '').toUpperCase(), min ?? '', max ?? ''].join('|');
}

/**
 * The rows that were live just before this republish: the latest
 * deprecation batch.  Unpublish deprecates the whole live set with one
 * timestamp, so older cycles (already superseded before) are excluded from
 * implicit matching; `correctsTxId` may still name any of them.
 */
export function latestLiveSet(prior: readonly PriorTxRow[]): PriorTxRow[] {
  let latest: string | null = null;
  for (const row of prior) {
    if (row.deprecated_at && (latest === null || row.deprecated_at > latest)) latest = row.deprecated_at;
  }
  if (latest === null) return [];
  return prior.filter((row) => row.deprecated_at === latest);
}

export function planCorrection(
  edits: readonly CorrectionEdit[],
  prior: readonly PriorTxRow[],
): CorrectionPlan {
  const byId = new Map(prior.map((row) => [row.id, row]));
  const claimed = new Set<string>();
  const matched = new Map<number, CorrectionMatch>();

  // 1. explicit
  for (const [editIndex, edit] of edits.entries()) {
    const id = edit.correctsTxId ?? null;
    if (!id) continue;
    if (!byId.has(id)) {
      return { ok: false, error: `edits[${editIndex}].correctsTxId '${id}' is not a previously published row of this filing` };
    }
    if (claimed.has(id)) {
      return { ok: false, error: `edits[${editIndex}].correctsTxId '${id}' is claimed by more than one edit` };
    }
    claimed.add(id);
    matched.set(editIndex, { editIndex, txId: id, kind: 'explicit' });
  }

  const live = latestLiveSet(prior);
  const liveKeys = new Map(live.map((row) => [row.id, assetKeys(row.asset_name, row.ticker)]));

  // 2. unchanged: bucket the live set by core fields, newest first within.
  const buckets = new Map<string, PriorTxRow[]>();
  for (const row of live) {
    if (claimed.has(row.id)) continue;
    const key = coreKey(row.tx_date, row.owner, row.tx_type, row.amount_min, row.amount_max);
    const list = buckets.get(key) ?? [];
    list.push(row);
    buckets.set(key, list);
  }
  for (const [editIndex, edit] of edits.entries()) {
    if (matched.has(editIndex)) continue;
    const key = coreKey(edit.txDate, edit.owner, edit.txType, edit.amountMin ?? null, edit.amountMax ?? null);
    const candidates = buckets.get(key);
    if (!candidates) continue;
    const keys = assetKeys(edit.assetName, edit.ticker);
    const hit = candidates.find((row) => !claimed.has(row.id) && sameAsset(keys, liveKeys.get(row.id) ?? []));
    if (!hit) continue;
    claimed.add(hit.id);
    matched.set(editIndex, { editIndex, txId: hit.id, kind: 'unchanged' });
  }

  // 3. corrected: same asset + type + owner, unique both ways.
  const openEdits = edits
    .map((edit, editIndex) => ({ edit, editIndex, keys: assetKeys(edit.assetName, edit.ticker) }))
    .filter(({ editIndex }) => !matched.has(editIndex));
  const openPrior = live.filter((row) => !claimed.has(row.id));
  const sameLot = (e: typeof openEdits[number], row: PriorTxRow) =>
    (e.edit.txType ?? '').toUpperCase() === (row.tx_type ?? '').toUpperCase()
    && norm(e.edit.owner) === norm(row.owner)
    && sameAsset(e.keys, liveKeys.get(row.id) ?? []);
  for (const e of openEdits) {
    const rows = openPrior.filter((row) => sameLot(e, row));
    if (rows.length !== 1) continue;
    const row = rows[0];
    if (claimed.has(row.id)) continue;
    const rivals = openEdits.filter((other) => !matched.has(other.editIndex) && sameLot(other, row));
    if (rivals.length !== 1) continue;
    claimed.add(row.id);
    matched.set(e.editIndex, { editIndex: e.editIndex, txId: row.id, kind: 'corrected' });
  }

  const matches = [...matched.values()].sort((a, b) => a.editIndex - b.editIndex);
  const added = edits.map((_, i) => i).filter((i) => !matched.has(i));
  const retired = live.filter((row) => !claimed.has(row.id)).map((row) => row.id);
  return { ok: true, matches, added, retired };
}
