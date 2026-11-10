/**
 * src/admin/filerIdentityDedupe.ts
 *
 * One-time / repeatable backfill that merges `filers` rows which forked for
 * the same real member. Three passes, run in order on every call:
 *
 *   A. Name-key: see shared/filerIdentityMatch.ts for the matching rule —
 *      same chamber + state, first+last name equal modulo a middle
 *      initial/punctuation/generational suffix. Fixes issue #1452 — the live
 *      directory showing "Michael T. McCaul" and "Michael McCaul" as two
 *      separate filers with split stats.
 *   B. Bioguide-key: any non-tombstoned filers sharing the same
 *      (resolved_bioguide_id, chamber) are the same person by definition —
 *      an authoritative congress-legislators match already agrees on both.
 *      Chamber is part of the key on purpose: a member who separately filed
 *      as an executive-branch nominee keeps a distinct row from their
 *      House/Senate one (e.g. EXEC-MCCORMICK vs the Senate Dave McCormick
 *      rows — same bioguide, deliberately different chamber, not merged).
 *   C. Exec name-key: `chamber='executive'` filers have no state (exec
 *      disclosures don't carry one), so pass A's same-state requirement
 *      fails closed on every exec row and never fires for them. This pass
 *      clusters exec filers by shared/filerIdentityMatch.ts's
 *      execNameMatchKey instead — the same name-key idea as pass A, minus
 *      the state check, after stripping the "20XX ERM" / bare-year / dotted
 *      date-fragment noise that forks one real nominee into several rows
 *      (e.g. "Barbara M Barrett" vs "Barbara M Barrett 2021 ERM").
 *
 * Reversible-safe: NEVER deletes a filer row. The alias row is tombstoned
 * via `merged_into` (migration 0078) and every alias -> canonical rewrite is
 * recorded in `filer_identity_merges` (with a reason tag per pass — see
 * `reason` on each detail) so the merge is auditable (and, if ever
 * necessary, reversible by hand from that mapping).
 *
 * Idempotent: safe to call repeatedly (POST /api/admin/dedupe-filer-identities,
 * or a cron). Already-tombstoned rows are excluded from re-clustering
 * (`WHERE merged_into IS NULL`), and every previously-recorded alias ->
 * canonical mapping is re-swept on each call so any straggler transactions/
 * filings that land under an old alias id (e.g. a narrow race with
 * ingestion's match-time resolution, ingestion/watcher.ts
 * resolveIngestFilerId) get pulled onto the canonical id too.
 *
 * dryRun (`?dryRun=1` on the route): plans and reports every pass exactly as
 * it would run for real — same clustering, same canonical pick, same
 * transaction/filing counts (via COUNT(*) reads instead of UPDATEs) — but
 * performs no writes at all: no filer row is tombstoned, no metadata is
 * backfilled, no filer_identity_merges row is written, and the resweep is
 * skipped. Because nothing is tombstoned between passes in dryRun, all three
 * passes see the same starting snapshot rather than each seeing the prior
 * pass's writes; the live (non-dryRun) run always re-reads between passes.
 */

import type { Env } from '../shared/types.ts';
import { all, get, run } from '../shared/db.ts';
import { execNameMatchKey, memberNameMatchKey, sameFilerIdentity } from '../shared/filerIdentityMatch.ts';
import { isMintedCompetitorFilerId } from '../shared/competitorFilerMatch.ts';
import { resolveExecutiveFilerIdFromName } from '../shared/executiveIdentity.ts';

interface FilerRow {
  bioguide_id: string;
  full_name: string | null;
  chamber: string | null;
  party: string | null;
  state: string | null;
  district: string | null;
  photo_url: string | null;
  resolved_bioguide_id: string | null;
}

export interface FilerIdentityMergeDetail {
  canonicalId: string;
  canonicalName: string | null;
  aliasIds: string[];
  transactionsMoved: number;
  filingsMoved: number;
  /** Which pass produced this cluster: 'name-normalization' (A), 'bioguide' (B), or 'exec-name-normalization' (C). */
  reason: string;
}

export interface FilerIdentityDedupeResult {
  clustersFound: number;
  aliasesTombstoned: number;
  transactionsMoved: number;
  filingsMoved: number;
  /** Rows re-pointed by the defensive resweep of already-recorded merges. */
  resweptRows: number;
  details: FilerIdentityMergeDetail[];
}

/**
 * Deterministic canonical pick within a matched cluster:
 *   0. Never a competitor-minted `MANUAL-<LAST>` id while a real one exists:
 *      `EXEC-*`, `house-*` and `senate-*` ids come from the actual filings (and
 *      `EXEC-*` carries the curated position title), so a MANUAL-* phantom is
 *      always the alias, even when it holds more transactions.  Its metadata is
 *      COALESCE-backfilled onto the canonical row by mergeClusterOnto.
 *   1. Prefer a row that already carries resolved_bioguide_id — an
 *      authoritative congress-legislators enrichment match.
 *   2. Otherwise prefer the row with the most live (non-deprecated)
 *      transactions — the majority-evidence variant.
 *   3. Tie-break on the lexicographically smallest bioguide_id, so reruns
 *      (and reruns against a snapshot with the same data) always agree.
 */
function pickCanonical(cluster: FilerRow[], txCounts: Map<string, number>): FilerRow {
  const real = cluster.filter((r) => !isMintedCompetitorFilerId(r.bioguide_id));
  const base = real.length ? real : cluster;
  const withResolved = base.filter((r) => r.resolved_bioguide_id);
  const pool = withResolved.length ? withResolved : base;
  return pool.slice().sort((a, b) => {
    const countDiff = (txCounts.get(b.bioguide_id) ?? 0) - (txCounts.get(a.bioguide_id) ?? 0);
    if (countDiff !== 0) return countDiff;
    return a.bioguide_id.localeCompare(b.bioguide_id);
  })[0];
}

async function mergeClusterOnto(
  env: Env,
  canonical: FilerRow,
  aliases: FilerRow[],
  nowIso: string,
  opts: { reason: string; dryRun: boolean },
): Promise<FilerIdentityMergeDetail> {
  let transactionsMoved = 0;
  let filingsMoved = 0;
  const aliasIds: string[] = [];

  for (const alias of aliases) {
    if (opts.dryRun) {
      // Report-only: count what would move without writing anything — no
      // filer tombstoned, no metadata backfilled, no audit row inserted.
      const txCount = await get<{ n: number }>(
        env.DB,
        'SELECT COUNT(*) AS n FROM transactions WHERE filer_id = ?',
        [alias.bioguide_id],
      );
      transactionsMoved += txCount?.n ?? 0;

      const filCount = await get<{ n: number }>(
        env.DB,
        'SELECT COUNT(*) AS n FROM filings WHERE filer_id = ?',
        [alias.bioguide_id],
      );
      filingsMoved += filCount?.n ?? 0;

      aliasIds.push(alias.bioguide_id);
      continue;
    }

    const txRes = await run(env.DB, 'UPDATE transactions SET filer_id = ? WHERE filer_id = ?', [
      canonical.bioguide_id,
      alias.bioguide_id,
    ]);
    transactionsMoved += txRes.meta?.changes ?? 0;

    const filRes = await run(env.DB, 'UPDATE filings SET filer_id = ? WHERE filer_id = ?', [
      canonical.bioguide_id,
      alias.bioguide_id,
    ]);
    filingsMoved += filRes.meta?.changes ?? 0;

    // Backfill metadata onto the canonical row from the alias without ever
    // overwriting a value canonical already has (COALESCE-preserve — mirrors
    // admin/routes.ts applyMemberFilerMerge's curated-merge pattern).
    await run(
      env.DB,
      `UPDATE filers SET
         party = COALESCE(NULLIF(party, ''), ?),
         state = COALESCE(NULLIF(state, ''), ?),
         district = COALESCE(NULLIF(district, ''), ?),
         photo_url = COALESCE(NULLIF(photo_url, ''), ?),
         resolved_bioguide_id = COALESCE(NULLIF(resolved_bioguide_id, ''), ?)
       WHERE bioguide_id = ?`,
      [alias.party, alias.state, alias.district, alias.photo_url, alias.resolved_bioguide_id, canonical.bioguide_id],
    );

    // Tombstone — never delete. merged_into makes the alias row inert for
    // every future dedupe pass and for any read that filters it out.
    await run(env.DB, 'UPDATE filers SET merged_into = ? WHERE bioguide_id = ?', [
      canonical.bioguide_id,
      alias.bioguide_id,
    ]);

    await run(
      env.DB,
      `INSERT INTO filer_identity_merges (alias_filer_id, canonical_filer_id, chamber, state, reason, merged_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(alias_filer_id) DO UPDATE SET
         canonical_filer_id = excluded.canonical_filer_id,
         merged_at = excluded.merged_at`,
      [alias.bioguide_id, canonical.bioguide_id, canonical.chamber, canonical.state, opts.reason, nowIso],
    );

    aliasIds.push(alias.bioguide_id);
  }

  return {
    canonicalId: canonical.bioguide_id,
    canonicalName: canonical.full_name,
    aliasIds,
    transactionsMoved,
    filingsMoved,
    reason: opts.reason,
  };
}

/** Re-apply every already-recorded alias -> canonical rewrite. Cheap
 *  (indexed filer_id lookups, bounded by the number of past merges — not a
 *  table scan) and is what makes the whole routine safe to run on a
 *  schedule, not just once. Never called in dryRun (it writes). */
async function resweepRecordedMerges(env: Env): Promise<number> {
  const merges = await all<{ alias_filer_id: string; canonical_filer_id: string }>(
    env.DB,
    'SELECT alias_filer_id, canonical_filer_id FROM filer_identity_merges',
  );
  let rows = 0;
  for (const m of merges) {
    const txRes = await run(env.DB, 'UPDATE transactions SET filer_id = ? WHERE filer_id = ?', [
      m.canonical_filer_id,
      m.alias_filer_id,
    ]);
    const filRes = await run(env.DB, 'UPDATE filings SET filer_id = ? WHERE filer_id = ?', [
      m.canonical_filer_id,
      m.alias_filer_id,
    ]);
    rows += (txRes.meta?.changes ?? 0) + (filRes.meta?.changes ?? 0);
  }
  return rows;
}

async function loadNonTombstonedFilers(env: Env): Promise<FilerRow[]> {
  return all<FilerRow>(
    env.DB,
    `SELECT bioguide_id, full_name, chamber, party, state, district, photo_url, resolved_bioguide_id
       FROM filers
      WHERE merged_into IS NULL`,
  );
}

async function loadTxCounts(env: Env): Promise<Map<string, number>> {
  const txCountRows = await all<{ filer_id: string; tx_count: number }>(
    env.DB,
    `SELECT filer_id, COUNT(*) AS tx_count
       FROM transactions
      WHERE filer_id IS NOT NULL AND deprecated_at IS NULL
      GROUP BY filer_id`,
  );
  return new Map(txCountRows.map((r) => [r.filer_id, r.tx_count]));
}

/** Pass A grouping: chamber + state + name-key (see module doc comment). */
function groupByChamberStateNameKey(filers: readonly FilerRow[]): Map<string, FilerRow[]> {
  const groups = new Map<string, FilerRow[]>();
  for (const f of filers) {
    const chamber = String(f.chamber ?? '').trim().toLowerCase();
    const state = String(f.state ?? '').trim().toUpperCase();
    const key = memberNameMatchKey(f.full_name);
    if (!chamber || !state || !key) continue;
    const groupKey = `${chamber}|${state}|${key}`;
    const list = groups.get(groupKey);
    if (list) list.push(f);
    else groups.set(groupKey, [f]);
  }
  return groups;
}

/**
 * Pass B grouping: (resolved_bioguide_id, chamber). Chamber is part of the
 * key so a member's executive-branch filer row never merges with their
 * House/Senate row even when both already resolved to the same bioguide.
 */
function groupByBioguideChamber(filers: readonly FilerRow[]): Map<string, FilerRow[]> {
  const groups = new Map<string, FilerRow[]>();
  for (const f of filers) {
    const bioguide = String(f.resolved_bioguide_id ?? '').trim();
    const chamber = String(f.chamber ?? '').trim().toLowerCase();
    if (!bioguide || !chamber) continue;
    const groupKey = `${bioguide}|${chamber}`;
    const list = groups.get(groupKey);
    if (list) list.push(f);
    else groups.set(groupKey, [f]);
  }
  return groups;
}

/**
 * Pass C grouping: chamber='executive' filers only, clustered by
 * execNameMatchKey (state is never consulted — exec disclosures don't carry
 * one). Scoped to 'executive' in the filter itself, not just by execNameMatchKey
 * happening to key exec names distinctly, so this can never reach a House/
 * Senate row even if a name coincidentally cleaned to the same key.
 */
/**
 * Cluster key for an executive filer: the curated EXEC-* id when the name is a
 * known alias ("Christopher A Wright" and "Chris Wright" are one Secretary even
 * though their name keys differ), else the plain exec name key.  Curated ids
 * are prefixed so they can never collide with a name key.
 */
function execClusterKey(fullName: string | null): string {
  const curated = resolveExecutiveFilerIdFromName(fullName);
  return curated ? `curated:${curated}` : execNameMatchKey(fullName);
}

function groupExecByNameKey(filers: readonly FilerRow[]): Map<string, FilerRow[]> {
  const groups = new Map<string, FilerRow[]>();
  for (const f of filers) {
    const chamber = String(f.chamber ?? '').trim().toLowerCase();
    if (chamber !== 'executive') continue;
    const key = execClusterKey(f.full_name);
    if (!key) continue;
    const list = groups.get(key);
    if (list) list.push(f);
    else groups.set(key, [f]);
  }
  return groups;
}

interface ClusterPassResult {
  details: FilerIdentityMergeDetail[];
  aliasesTombstoned: number;
  transactionsMoved: number;
  filingsMoved: number;
}

/**
 * Run one clustering pass: pick a canonical per cluster (skipping singleton
 * groups), optionally re-verify each alias with `verify` (belt-and-suspenders
 * against the grouping logic drifting from the matching rule it's supposed to
 * encode), and merge. `dryRun` is forwarded straight through to
 * mergeClusterOnto — no writes happen when set.
 */
async function runClusterPass(
  env: Env,
  groups: Iterable<FilerRow[]>,
  txCounts: Map<string, number>,
  reason: string,
  nowIso: string,
  dryRun: boolean,
  verify?: (canonical: FilerRow, alias: FilerRow) => boolean,
): Promise<ClusterPassResult> {
  const details: FilerIdentityMergeDetail[] = [];
  let aliasesTombstoned = 0;
  let transactionsMoved = 0;
  let filingsMoved = 0;

  for (const cluster of groups) {
    if (cluster.length < 2) continue;
    const canonical = pickCanonical(cluster, txCounts);
    let aliases = cluster.filter((f) => f.bioguide_id !== canonical.bioguide_id);
    if (verify) aliases = aliases.filter((f) => verify(canonical, f));
    if (!aliases.length) continue;

    const merged = await mergeClusterOnto(env, canonical, aliases, nowIso, { reason, dryRun });
    transactionsMoved += merged.transactionsMoved;
    filingsMoved += merged.filingsMoved;
    aliasesTombstoned += merged.aliasIds.length;
    details.push(merged);
  }

  return { details, aliasesTombstoned, transactionsMoved, filingsMoved };
}

export async function dedupeSplitFilerIdentities(
  env: Env,
  opts: { dryRun?: boolean } = {},
): Promise<FilerIdentityDedupeResult> {
  const dryRun = opts.dryRun === true;
  const nowIso = new Date().toISOString();

  // Pass A — name-key (chamber + state scoped; see module doc comment).
  // Belt-and-suspenders: re-verify every alias against sameFilerIdentity (the
  // group key already encodes the same chamber+state+name-key equality, so
  // this should never filter anything out — it's a guard against the
  // grouping logic ever drifting from the matching rule).
  let filers = await loadNonTombstonedFilers(env);
  let txCounts = await loadTxCounts(env);
  const passA = await runClusterPass(
    env,
    groupByChamberStateNameKey(filers).values(),
    txCounts,
    'name-normalization',
    nowIso,
    dryRun,
    (canonical, alias) =>
      sameFilerIdentity(
        { fullName: canonical.full_name, chamber: canonical.chamber, state: canonical.state },
        { fullName: alias.full_name, chamber: alias.chamber, state: alias.state },
      ),
  );

  // Pass B — bioguide-key. Re-read so pass A's tombstones (live run only)
  // are excluded rather than re-clustered; in dryRun nothing was written, so
  // this intentionally re-plans from the same starting snapshot as pass A.
  if (!dryRun) {
    filers = await loadNonTombstonedFilers(env);
    txCounts = await loadTxCounts(env);
  }
  const passB = await runClusterPass(
    env,
    groupByBioguideChamber(filers).values(),
    txCounts,
    'bioguide',
    nowIso,
    dryRun,
    (canonical, alias) =>
      String(canonical.resolved_bioguide_id ?? '') === String(alias.resolved_bioguide_id ?? '') &&
      String(canonical.chamber ?? '').trim().toLowerCase() === String(alias.chamber ?? '').trim().toLowerCase(),
  );

  // Pass C — exec name-key (chamber='executive' only; state never consulted).
  if (!dryRun) {
    filers = await loadNonTombstonedFilers(env);
    txCounts = await loadTxCounts(env);
  }
  const passC = await runClusterPass(
    env,
    groupExecByNameKey(filers).values(),
    txCounts,
    'exec-name-normalization',
    nowIso,
    dryRun,
    (canonical, alias) =>
      String(canonical.chamber ?? '').trim().toLowerCase() === 'executive' &&
      String(alias.chamber ?? '').trim().toLowerCase() === 'executive' &&
      execClusterKey(canonical.full_name) === execClusterKey(alias.full_name),
  );

  const resweptRows = dryRun ? 0 : await resweepRecordedMerges(env);

  const details = [...passA.details, ...passB.details, ...passC.details];
  return {
    clustersFound: details.length,
    aliasesTombstoned: passA.aliasesTombstoned + passB.aliasesTombstoned + passC.aliasesTombstoned,
    transactionsMoved: passA.transactionsMoved + passB.transactionsMoved + passC.transactionsMoved,
    filingsMoved: passA.filingsMoved + passB.filingsMoved + passC.filingsMoved,
    resweptRows,
    details,
  };
}
