/**
 * src/admin/competitorAttributionRepair.ts
 *
 * POST /api/admin/repair-competitor-attribution — one-shot + repeatable
 * hygiene for `source='competitor_backfill'` rows (doc_id LIKE
 * 'COMPETITOR-%'), modeled on the existing /repair-competitor-executive job
 * (see admin/routes.ts). Fixes two verified-in-production defects in the
 * same pass:
 *
 *   1. Attribution: the original injector (scripts/inject_competitor_data.ts)
 *      resolved filers by LAST NAME ONLY, so e.g. Rep. Mike Collins
 *      (GA-10)'s crypto trades landed on Sen. Susan M. Collins (ME)'s filer
 *      row. `raw_text` still carries the TRUE reporter's name and (often)
 *      office/district — see shared/competitorAttribution.ts's
 *      `parseCompetitorReporter`. When that parsed identity clearly
 *      disagrees with the assigned filer (different chamber, different
 *      state, or a differing resolved bioguide id —
 *      `competitorReporterMismatch`), the row is reassigned to the correct
 *      filer, minting one if it doesn't exist yet: a curated EXEC-* id when
 *      the name matches a known executive alias, a real
 *      `house-<state><district>-<slug>` id when office metadata gives
 *      state+district, else the existing `MANUAL-${LASTNAME}` convention.
 *
 *   2. Crypto mis-typed as equity: rows whose raw notes carry the
 *      provider's '[CT]' crypto marker (or an explicit crypto keyword) got
 *      stored with `asset_type='stock'`, colliding with unrelated tickers
 *      (SUI -> Sun Communities, USDC -> Usdata Corp, AERO -> Aeroméxico).
 *      Reclassified to the House 'CT' (Cryptocurrency) asset-type code so
 *      performance/leaderboard queries can exclude them.
 *
 *   3. Last-name-minted phantoms (board rows 2c0b428c / 591011b9): rows still
 *      sitting on a `MANUAL-<LAST>` filer are re-keyed onto the EXISTING real
 *      filer their payload's reporter names — "Hon. April McClain Delaney" onto
 *      house-md06-april-mcclain-delaney, "Maria Elvira Salazar" onto
 *      house-fl27-maria-elvira-salazar, "Douglas J Burgum" onto its EXEC-* twin
 *      — using shared/competitorFilerMatch.ts (first+last name, diminutive-aware,
 *      hard-miss on a known state/chamber conflict, null when ambiguous).  Row by
 *      row, never filer by filer: MANUAL-DELANEY fused April McClain Delaney's
 *      rows with a differently-named "John Delaney" payload, and only the rows
 *      whose reporter matches move; the rest stay put and are counted in
 *      `unmatchedMinted`.  A phantom left with no transactions and no filings
 *      is tombstoned (`merged_into` + filer_identity_merges), never deleted.
 *
 * Never deletes rows. `dryRun: true` reports without writing (reassigned/
 * created/cryptoReclassified/rekeyed reflect what WOULD change). Safe to
 * re-run — once a row is fixed it no longer matches on the next pass.
 */

import type { Env } from '../shared/types.ts';
import { all, run } from '../shared/db.ts';
import { HOUSE_ASSET_TYPE_NAMES } from '../shared/assetTypes.ts';
import { resolveExecutiveFilerIdFromName } from '../shared/executiveIdentity.ts';
import { fallbackCleanDisplayName } from '../enrichment/identitySync.ts';
import {
  competitorHouseFilerId,
  competitorQualifiedManualFilerId,
  competitorReporterMismatch,
  competitorReporterNames,
  hasCompetitorCryptoMarker,
  parseCompetitorReporter,
  type ParsedCompetitorReporter,
} from '../shared/competitorAttribution.ts';
import {
  findExistingFilerForCompetitorReporter,
  isMintedCompetitorFilerId,
  type ExistingFilerCandidate,
} from '../shared/competitorFilerMatch.ts';

export interface RepairCompetitorAttributionCluster {
  fromFilerId: string | null;
  toFilerId: string;
  count: number;
  reporterName: string | null;
  sampleTransactionIds: string[];
}

export interface RepairCompetitorAttributionResult {
  scanned: number;
  mismatched: number;
  reassigned: number;
  created: number;
  cryptoReclassified: number;
  unparseable: number;
  /** Rows on a MANUAL-<LAST> filer re-keyed onto the existing real filer their reporter names. */
  rekeyed: number;
  /** Rows on a MANUAL-<LAST> filer whose reporter matched no single existing filer (left in place). */
  unmatchedMinted: number;
  /** Emptied MANUAL-* phantoms tombstoned onto the filer their rows moved to. */
  tombstoned: number;
  dryRun: boolean;
  details: RepairCompetitorAttributionCluster[];
}

interface CompetitorRow {
  id: string;
  filer_id: string | null;
  raw_text: string | null;
  asset_name: string | null;
  asset_type: string | null;
  ticker: string | null;
  filer_chamber: string | null;
  filer_state: string | null;
  filer_resolved_bioguide_id: string | null;
}

function resolveNewFilerId(parsed: ParsedCompetitorReporter, existing: readonly ExistingFilerCandidate[]): string | null {
  if (!parsed.name) return null;
  const execId = resolveExecutiveFilerIdFromName(parsed.name);
  if (execId) return execId;
  if (parsed.state && parsed.district) {
    const houseId = competitorHouseFilerId(parsed.name, parsed.state, parsed.district);
    if (houseId) return houseId;
  }
  // Ingest guard: never mint a filer from a bare last name when a real filer
  // already matches, and never mint `MANUAL-<LAST>` for a surname alone.
  const match = findExistingFilerForCompetitorReporter({
    names: [parsed.name],
    chamber: parsed.chamber,
    state: parsed.state,
    bioguideId: parsed.bioguideId,
    candidates: existing,
  });
  if (match) return match.filerId;
  return competitorQualifiedManualFilerId(parsed.name);
}

function chamberForFilerId(filerId: string, parsed: ParsedCompetitorReporter): string | null {
  if (filerId.startsWith('EXEC-')) return 'executive';
  if (filerId.startsWith('house-')) return 'house';
  return parsed.chamber ?? null;
}

export async function repairCompetitorAttribution(
  env: Env,
  opts: { dryRun: boolean },
): Promise<RepairCompetitorAttributionResult> {
  const dryRun = opts.dryRun === true;

  const rows = await all<CompetitorRow>(
    env.DB,
    `SELECT t.id, t.filer_id, t.raw_text, t.asset_name, t.asset_type, t.ticker,
            f.chamber AS filer_chamber, f.state AS filer_state,
            f.resolved_bioguide_id AS filer_resolved_bioguide_id
       FROM transactions t
       LEFT JOIN filers f ON f.bioguide_id = t.filer_id
      WHERE t.source = 'competitor_backfill'
        AND t.doc_id LIKE 'COMPETITOR-%'
        AND t.deprecated_at IS NULL
      LIMIT 20000`,
  );

  let mismatched = 0;
  let reassigned = 0;
  let created = 0;
  let cryptoReclassified = 0;
  let unparseable = 0;
  let rekeyed = 0;
  let unmatchedMinted = 0;
  const filersEnsured = new Set<string>();
  const clusters = new Map<string, RepairCompetitorAttributionCluster>();
  const movedFrom = new Map<string, Map<string, number>>();

  // Live real (non-MANUAL, non-tombstoned) filers: the only valid re-key targets.
  const candidates: ExistingFilerCandidate[] = rows.some((r) => isMintedCompetitorFilerId(r.filer_id))
    ? (
        await all<{
          bioguide_id: string;
          full_name: string | null;
          display_name: string | null;
          chamber: string | null;
          state: string | null;
          resolved_bioguide_id: string | null;
        }>(
          env.DB,
          `SELECT bioguide_id, full_name, display_name, chamber, state, resolved_bioguide_id
             FROM filers
            WHERE merged_into IS NULL AND bioguide_id NOT LIKE 'MANUAL-%'`,
        )
      ).map((f) => ({
        filerId: f.bioguide_id,
        fullName: f.full_name,
        displayName: f.display_name,
        chamber: f.chamber,
        state: f.state,
        resolvedBioguideId: f.resolved_bioguide_id,
      }))
    : [];

  for (const row of rows) {
    const parsed = parseCompetitorReporter(row.raw_text);
    if (!parsed.name) unparseable += 1;

    // --- 0) last-name-minted phantom: re-key onto the existing real filer ----
    let rekeyedThisRow = false;
    let unmatchedThisRow = false;
    let reassignedThisRow = false;
    if (isMintedCompetitorFilerId(row.filer_id)) {
      const target = findExistingFilerForCompetitorReporter({
        names: competitorReporterNames(row.raw_text),
        chamber: parsed.chamber,
        state: parsed.state,
        bioguideId: parsed.bioguideId,
        candidates,
      });
      if (target && target.filerId !== row.filer_id) {
        const key = `${row.filer_id}->${target.filerId}`;
        let cluster = clusters.get(key);
        if (!cluster) {
          cluster = {
            fromFilerId: row.filer_id,
            toFilerId: target.filerId,
            count: 0,
            reporterName: parsed.name,
            sampleTransactionIds: [],
          };
          clusters.set(key, cluster);
        }
        cluster.count += 1;
        if (cluster.sampleTransactionIds.length < 5) cluster.sampleTransactionIds.push(row.id);
        const perTarget = movedFrom.get(row.filer_id as string) ?? new Map<string, number>();
        perTarget.set(target.filerId, (perTarget.get(target.filerId) ?? 0) + 1);
        movedFrom.set(row.filer_id as string, perTarget);
        if (!dryRun) {
          await run(env.DB, `UPDATE transactions SET filer_id = ? WHERE id = ?`, [target.filerId, row.id]);
        }
        rekeyed += 1;
        rekeyedThisRow = true;
      } else {
        // Counted only once the whole row is settled (below): step 1 may still
        // reassign it, and a row that ends up moved is not "left in place".
        unmatchedThisRow = true;
      }
    }

    // --- 1) attribution mismatch --------------------------------------
    if (!rekeyedThisRow && parsed.name && row.filer_id) {
      const mismatch = competitorReporterMismatch(parsed, {
        chamber: row.filer_chamber,
        state: row.filer_state,
        resolvedBioguideId: row.filer_resolved_bioguide_id,
      });
      if (mismatch) {
        mismatched += 1;
        const newFilerId = resolveNewFilerId(parsed, candidates);
        if (newFilerId && newFilerId !== row.filer_id) {
          const key = `${row.filer_id ?? 'null'}->${newFilerId}`;
          let cluster = clusters.get(key);
          if (!cluster) {
            cluster = {
              fromFilerId: row.filer_id,
              toFilerId: newFilerId,
              count: 0,
              reporterName: parsed.name,
              sampleTransactionIds: [],
            };
            clusters.set(key, cluster);
          }
          cluster.count += 1;
          if (cluster.sampleTransactionIds.length < 5) cluster.sampleTransactionIds.push(row.id);

          if (!filersEnsured.has(newFilerId)) {
            const existing = await all<{ bioguide_id: string }>(
              env.DB,
              `SELECT bioguide_id FROM filers WHERE bioguide_id = ?`,
              [newFilerId],
            );
            if (existing.length === 0) {
              created += 1;
              if (!dryRun) {
                await run(
                  env.DB,
                  `INSERT OR IGNORE INTO filers (bioguide_id, chamber, full_name, state, district)
                   VALUES (?, ?, ?, ?, ?)`,
                  [
                    newFilerId,
                    chamberForFilerId(newFilerId, parsed),
                    fallbackCleanDisplayName(parsed.name) ?? parsed.name,
                    parsed.state,
                    parsed.district,
                  ],
                );
              }
            }
            filersEnsured.add(newFilerId);
          }

          if (!dryRun) {
            await run(env.DB, `UPDATE transactions SET filer_id = ? WHERE id = ?`, [newFilerId, row.id]);
          }
          reassigned += 1;
          reassignedThisRow = true;
        }
      }
    }

    if (unmatchedThisRow && !reassignedThisRow) unmatchedMinted += 1;

    // --- 2) crypto disclosures mis-typed as equity -----------------------
    const alreadyCrypto = (row.asset_type ?? '').trim().toUpperCase() === 'CT';
    if (!alreadyCrypto && hasCompetitorCryptoMarker(row.raw_text, row.asset_name, row.ticker)) {
      cryptoReclassified += 1;
      if (!dryRun) {
        await run(
          env.DB,
          `UPDATE transactions SET asset_type = 'CT', asset_type_name = ? WHERE id = ?`,
          [HOUSE_ASSET_TYPE_NAMES.CT, row.id],
        );
      }
    }
  }

  // Tombstone (never delete) any phantom this pass emptied: no transactions and
  // no filings left, and every moved row went to one target.
  let tombstoned = 0;
  for (const [fromId, perTarget] of movedFrom) {
    if (perTarget.size !== 1) continue;
    const targetId = [...perTarget.keys()][0];
    const remaining = await all<{ n: number }>(
      env.DB,
      `SELECT (SELECT COUNT(*) FROM transactions WHERE filer_id = ?) +
              (SELECT COUNT(*) FROM filings WHERE filer_id = ?) AS n`,
      [fromId, fromId],
    );
    const leftBehind = Number(remaining[0]?.n ?? 0);
    // In a dry run nothing moved, so the phantom "would be" empty exactly when
    // every one of its rows was a re-key candidate.
    const movable = perTarget.get(targetId) ?? 0;
    const wouldEmpty = dryRun ? leftBehind === movable : leftBehind === 0;
    if (!wouldEmpty) continue;
    tombstoned += 1;
    if (dryRun) continue;
    await run(env.DB, `UPDATE filers SET merged_into = ? WHERE bioguide_id = ? AND merged_into IS NULL`, [targetId, fromId]);
    await run(
      env.DB,
      `INSERT INTO filer_identity_merges (alias_filer_id, canonical_filer_id, chamber, state, reason, merged_at)
       SELECT ?, f.bioguide_id, f.chamber, f.state, 'competitor-last-name-rekey', ?
         FROM filers f WHERE f.bioguide_id = ?
       ON CONFLICT(alias_filer_id) DO UPDATE SET
         canonical_filer_id = excluded.canonical_filer_id,
         merged_at = excluded.merged_at`,
      [fromId, new Date().toISOString(), targetId],
    );
  }

  return {
    scanned: rows.length,
    mismatched,
    reassigned,
    created,
    cryptoReclassified,
    unparseable,
    rekeyed,
    unmatchedMinted,
    tombstoned,
    dryRun,
    details: Array.from(clusters.values()),
  };
}
