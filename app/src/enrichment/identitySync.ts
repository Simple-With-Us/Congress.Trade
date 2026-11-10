/**
 * src/enrichment/identitySync.ts
 *
 * Bioguide-driven identity sync for `filers`: backfills missing
 * resolved_bioguide_id on house/senate filers, computes each filer's
 * "campaign sign" display_name (the preferred public name — "Bernie Moreno"
 * not "Bernardo Moreno", "Ted Cruz" not "Rafael Edward Cruz"), and overwrites
 * party/state/district from the legislator's latest term for any resolved
 * filer (fixing missing Senator states and wrong MANUAL-* metadata). Filers
 * that never resolve to a bioguide (executive branch, MANUAL-* competitor
 * injects, blank-name rows) instead get a best-effort display_name cleaned
 * from full_name.
 *
 * Three separate lookups over the same congress-legislators roster
 * (src/enrichment/legislators.ts) drive resolution, tried in order:
 *   1. The PRIMARY map, keyed by normalized "first last" / "nickname last" /
 *      official_full — the same lookup runPhotoEnrichment already uses.
 *   2. The FALLBACK index, keyed by a first+last token pair extracted from
 *      the free-text filer name after stripping honorifics/ERM/years/
 *      suffixes (see legislators.fallbackNameKeys — this also covers a
 *      "middle last" pairing and a first-initial-stripped variant). When
 *      none of those keys hit, each key is retried with its first token
 *      swapped for a curated diminutive equivalent (legislators.
 *      diminutiveKeyVariants — "William" retries as "Bill", "Daniel" as
 *      "Dan", etc.) to bridge a formal/legal first name in the filing
 *      against the informal name congress-legislators indexes the member
 *      under. Every one of these keys — diminutive or not — is only counted
 *      as a match when it resolves to exactly one candidate: either because
 *      the filer's state matches that candidate's state, or because the
 *      filer has no state on file and the key is unambiguous on its own.
 *      Never a last-name-only guess. Name pairs that share no lexical root
 *      (e.g. "Rafael" filed for a member who goes by "Ted") cannot be
 *      bridged by either mechanism and are instead handled, when confirmed,
 *      by the curated MEMBER_NAME_ALIASES allow-list in
 *      shared/memberIdentity.ts (consumed upstream via cleanFilerName), not
 *      by a resolution path here.
 *   3. Nothing: resolved_bioguide_id is never set on a guess, and an
 *      already-set resolved_bioguide_id is never overwritten.
 *
 * Chamber authority (board row 85f2170a).  `filers.chamber` was never written
 * here, so competitor-minted `MANUAL-*` filers kept whatever the injector
 * guessed — mostly 'senate' — and the chamber filter, the per-chamber KPIs and
 * the dedupe passes (which key on chamber) all failed closed on them.  For
 * `MANUAL-*` filers ONLY (a `house-*`/`senate-*`/`EXEC-*` id already carries the
 * chamber of the filing that minted it, and a member who moved from House to
 * Senate legitimately has one row per chamber) the chamber is now decided from
 * evidence, in this order: the competitor payloads' own `member_type`
 * (executive officials — including former legislators now in the cabinet — say
 * 'executive'), curated executive data (the photo pack's executive faces, the
 * curated EXEC-* aliases), the resolved legislator's latest term, the payload's
 * house/senate, and last an existing `chamber='executive'` twin by name.  No
 * evidence means no change: 'senate' is never a default.
 *
 * A name-only match onto a legislator who could not have filed (last term ended
 * before the STOCK Act, or more than a year before the filer's latest trade)
 * is rejected, and a stored resolution that points at one is re-resolved or
 * cleared — the "Gillis Long" / "Mark Green WI-8" / 1940s "John Delaney"
 * mis-resolutions came from `middle last` and first-listed-wins keys.
 *
 * Writes are batched (batchPrepared, 50 statements/D1 batch) the same way
 * committeeSync.ts does. dryRun returns the full plan (counts + first 50
 * sample changes) without writing anything.
 */

import type { Env } from '../shared/types.ts';
import { all, batchPrepared } from '../shared/db.ts';
import {
  fetchLegislatorIndexes,
  fallbackNameKeys,
  diminutiveKeyVariants,
  isDisclosureEraLegislator,
  normName,
  type LegislatorIndexes,
  type LegislatorMatch,
} from './legislators.ts';
import { cleanFilerName } from '../extraction/nameNormalizer.ts';
import { dedupeSplitFilerIdentities } from '../admin/filerIdentityDedupe.ts';
import { chamberFromMemberType, type ParsedCompetitorChamber } from '../shared/competitorAttribution.ts';
import { isMintedCompetitorFilerId } from '../shared/competitorFilerMatch.ts';
import { resolveExecutiveFilerIdFromName } from '../shared/executiveIdentity.ts';
import { packFacesWithFilerIds } from './memberPhotoPack.ts';

export interface IdentityFilerRow {
  bioguide_id: string;
  chamber: string | null;
  full_name: string | null;
  party: string | null;
  state: string | null;
  district: string | null;
  resolved_bioguide_id: string | null;
  display_name: string | null;
}

export interface IdentityPlanChange {
  filerId: string;
  kind: 'resolved' | 'display-name' | 'fields' | 'cleaned' | 'chamber' | 'cleared';
  before: Partial<IdentityFilerRow>;
  after: Partial<IdentityFilerRow>;
}

export interface IdentityPlan {
  changes: IdentityPlanChange[];
  filersScanned: number;
  bioguideResolved: number;
  displayNamesSet: number;
  fieldsBackfilled: number;
  cleaned: number;
  unresolved: number;
  /** MANUAL-* filers whose chamber was corrected from evidence. */
  chambersCorrected: number;
  /** Stored resolutions that pointed at a legislator who cannot be the filer, re-resolved or cleared. */
  staleResolutionsFixed: number;
}

/**
 * Evidence gathered from the database (see {@link loadIdentityEvidence}) that
 * the pure planner cannot derive from the `filers` rows alone.  Every field is
 * optional: a missing map simply means "no evidence", never a default.
 */
export interface IdentityEvidence {
  /** MANUAL-* filer id -> the chamber its competitor payloads overwhelmingly declare. */
  payloadChamber?: ReadonlyMap<string, ParsedCompetitorChamber>;
  /** MANUAL-* filer id -> latest live tx_date (YYYY-MM-DD); bounds which legislators could be the filer. */
  latestTxDate?: ReadonlyMap<string, string>;
  /** Filer ids that curated data (the executive photo pack) marks as executive-branch officials. */
  executiveFilerIds?: ReadonlySet<string>;
}

/** Share of typed payload rows that must agree before a chamber counts as "declared". */
const PAYLOAD_CHAMBER_MAJORITY = 0.8;

/** "2019-01-03" -> "2020-01-03" (string math; the roster dates are ISO). */
function plusOneYear(isoDate: string): string {
  const year = Number(isoDate.slice(0, 4));
  return Number.isFinite(year) ? `${year + 1}${isoDate.slice(4)}` : isoDate;
}

interface Plausibility {
  /** Latest live trade date on the filer (MANUAL-* only). */
  latestTxDate: string | null;
  /** Executive-branch evidence: skip the tx-date bound (a former legislator can be a current official). */
  executive: boolean;
}

/**
 * Could this legislator be the person behind the filer?  Never for someone who
 * left before the disclosure era; and, for a competitor-minted filer with a
 * known latest trade, never when their last term ended more than a year before
 * that trade (executives are exempt — a former Representative can be a
 * Secretary today).
 */
function plausibleLegislator(m: LegislatorMatch, ctx: Plausibility): boolean {
  if (!isDisclosureEraLegislator(m)) return false;
  if (ctx.executive || !ctx.latestTxDate || !m.lastTermEnd) return true;
  return plusOneYear(m.lastTermEnd) >= ctx.latestTxDate;
}

/** Resolve a filer's bioguide via the primary name map (cleaned name, then raw name). Mirrors runPhotoEnrichment's lookup exactly. */
function resolvePrimary(
  fullName: string | null,
  primary: Map<string, LegislatorMatch>,
  accept: (m: LegislatorMatch) => boolean,
): LegislatorMatch | null {
  const cleaned = cleanFilerName(fullName);
  for (const key of [normName(cleaned || fullName), normName(fullName)]) {
    const hit = primary.get(key);
    if (hit && accept(hit)) return hit;
  }
  return null;
}

/**
 * Look up a single fallback key and, per the module doc comment, only
 * accept the hit when it narrows to exactly one legislator: either the
 * filer's state matches exactly one candidate, or the filer has no state on
 * file and the key itself is unambiguous.
 */
function lookupFallbackKey(
  key: string,
  state: string,
  fallback: Map<string, LegislatorMatch[]>,
  accept: (m: LegislatorMatch) => boolean,
): LegislatorMatch | null {
  const candidates = (fallback.get(key) ?? []).filter(accept);
  if (candidates.length === 0) return null;
  if (state) {
    const stateMatches = candidates.filter((m) => (m.state ?? '').toUpperCase() === state);
    if (stateMatches.length === 1) return stateMatches[0];
    return null;
  }
  return candidates.length === 1 ? candidates[0] : null;
}

/**
 * Resolve via the first+last fallback index, gated by state per the module
 * doc comment. Tries each fallback key derived from the raw filer name in
 * turn (first token + last token, first token + last-two-tokens for a
 * multi-word surname, middle token + last token, and a first-initial-
 * stripped variant — see legislators.fallbackNameKeys), then — only if none
 * of those hit — retries every one of those same keys with its first token
 * swapped for each curated diminutive equivalent (legislators.
 * diminutiveKeyVariants). Every lookup, diminutive or not, goes through the
 * same state-gated `lookupFallbackKey` acceptance rule.
 */
function resolveFallback(
  fullName: string | null,
  filerState: string | null,
  fallback: Map<string, LegislatorMatch[]>,
  accept: (m: LegislatorMatch) => boolean,
): LegislatorMatch | null {
  const keys = fallbackNameKeys(fullName);
  const state = (filerState ?? '').trim().toUpperCase();

  for (const key of keys) {
    const hit = lookupFallbackKey(key, state, fallback, accept);
    if (hit) return hit;
  }

  for (const key of keys) {
    for (const variant of diminutiveKeyVariants(key)) {
      const hit = lookupFallbackKey(variant, state, fallback, accept);
      if (hit) return hit;
    }
  }

  return null;
}

/** Name-only roster resolution (primary map, then the state-gated fallback), restricted to plausible legislators. */
function resolveByName(
  f: IdentityFilerRow,
  indexes: LegislatorIndexes,
  accept: (m: LegislatorMatch) => boolean,
  opts: { ignoreStoredState?: boolean } = {},
): LegislatorMatch | null {
  return (
    resolvePrimary(f.full_name, indexes.primary, accept) ??
    // When re-resolving a mis-resolution the stored state was itself copied
    // from the WRONG legislator (Gillis Long's "LA" would veto Billy Long's
    // "MO"), so it must not gate the retry.
    resolveFallback(f.full_name, opts.ignoreStoredState ? null : f.state, indexes.fallback, accept)
  );
}

/** The legislator's preferred public display name: official_full, else "nickname last", else "first last". */
function legislatorDisplayName(m: LegislatorMatch): string | null {
  if (m.officialFull && m.officialFull.trim()) return m.officialFull.trim();
  if (m.nickname && m.last) return `${m.nickname} ${m.last}`.trim();
  if (m.first && m.last) return `${m.first} ${m.last}`.trim();
  return null;
}

const HONORIFIC_CLEANUP_RE = /\b(?:HON|HONORABLE|DR|MR|MRS|MS|MD|FACS|REP|SEN)\b\.?,?/gi;
// "10.24..2022" / "8.12.2025"-style dotted date fragments, and "8-12-25"-style dashed ones.
const DATE_FRAGMENT_RE = /\b\d{1,2}\.\d{1,2}\.{1,2}\d{2,4}\b|\b\d{1,2}-\d{1,2}-\d{2,4}\b/g;
// "2021 ERM" or a bare standalone "ERM" marker.
const ERM_RE = /\b(?:\d{4}\s+)?ERM\b/gi;
const BARE_YEAR_RE = /\b(?:19|20)\d{2}\b/g;
const EMPTY_PARENS_RE = /\(\s*\)/g;

const SUFFIX_NORMALIZATION: Record<string, { display: string; comma: boolean }> = {
  jr: { display: 'Jr.', comma: true },
  sr: { display: 'Sr.', comma: true },
  ii: { display: 'II', comma: false },
  iii: { display: 'III', comma: false },
  iv: { display: 'IV', comma: false },
  v: { display: 'V', comma: false },
};

/** Title-case a string if it's primarily ALL CAPS (mirrors cleanFilerName/cleanAssetString's naive detector). */
function titleCaseIfShouting(str: string): string {
  const upperCount = (str.match(/[A-Z]/g) || []).length;
  const lowerCount = (str.match(/[a-z]/g) || []).length;
  if (upperCount > 0 && upperCount > lowerCount * 2) {
    return str.toLowerCase().replace(/(^|\s|-|\.)\w/g, (c) => c.toUpperCase());
  }
  return str;
}

/**
 * Best-effort display_name for a filer that never resolves to a bioguide
 * (executive branch, MANUAL-* competitor injects, blank-name rows). Strips
 * ERM/date/year noise and honorifics, flips "Last, First" (including a
 * multi-word "last" chunk, e.g. "Justice II, James Conley"), normalizes
 * generational-suffix casing/punctuation, title-cases ALL-CAPS input, and
 * collapses whitespace. Returns null for input that cleans down to nothing
 * (the known blank ' ' MANUAL- filer).
 */
export function fallbackCleanDisplayName(fullName: string | null | undefined): string | null {
  let str = String(fullName ?? '');
  if (!str.trim()) return null;

  str = str.replace(DATE_FRAGMENT_RE, ' ');
  str = str.replace(ERM_RE, ' ');
  str = str.replace(BARE_YEAR_RE, ' ');
  str = str.replace(EMPTY_PARENS_RE, ' ');
  str = str.replace(HONORIFIC_CLEANUP_RE, ' ');
  str = str.replace(/\s{2,}/g, ' ').trim();
  // Leading/trailing comma or whitespace only — NOT period, which a
  // generational-suffix normalization below may legitimately need to keep
  // ("Jr." at the very end).
  str = str.replace(/^[,\s]+|[,\s]+$/g, '').trim();

  if (!str) return null;

  // "Last[, multi-word ok], First [Suffix]" -> "First [Suffix] Last[, multi-word ok]",
  // unless what follows the comma is JUST a generational suffix (that's a
  // trailing-suffix comma on an already First-Last-ordered name, not a flip).
  const commaIdx = str.indexOf(',');
  if (commaIdx > -1 && str.indexOf(',', commaIdx + 1) === -1) {
    const before = str.slice(0, commaIdx).trim();
    const after = str.slice(commaIdx + 1).trim();
    const afterSuffix = SUFFIX_NORMALIZATION[after.toLowerCase().replace(/\.$/, '')];
    if (before && after) {
      if (afterSuffix) {
        str = afterSuffix.comma ? `${before}, ${afterSuffix.display}` : `${before} ${afterSuffix.display}`;
      } else {
        str = `${after} ${before}`;
      }
    }
  }

  // Normalize any remaining bare generational-suffix token's casing/punctuation
  // wherever it landed (the comma-flip above already handled the trailing-comma
  // case). Lookahead instead of a trailing \b: a `\b` immediately after an
  // optional period is unreliable (period is a non-word char, so there is no
  // boundary between it and end-of-string), which would otherwise make the
  // period backtrack out of the match and get orphaned.
  str = str.replace(/\b(jr|sr|ii|iii|iv|v)\.?(?=$|[\s,])/gi, (_m, suf: string) => {
    const norm = SUFFIX_NORMALIZATION[suf.toLowerCase()];
    return norm ? norm.display : _m;
  });

  str = titleCaseIfShouting(str);
  str = str.replace(/\s{2,}/g, ' ').trim();
  str = str.replace(/^[,\s]+|[,\s]+$/g, '').trim();

  return str || null;
}

/** Filer ids curated as executive-branch officials by the executive photo pack. */
export function executiveFilerIdsFromPhotoPack(): Set<string> {
  const ids = new Set<string>();
  try {
    for (const face of packFacesWithFilerIds()) {
      if (face.branch !== 'executive') continue;
      for (const id of face.filerIds ?? []) ids.add(id);
    }
  } catch {
    // The pack is an optimisation over other evidence; never fail the sync on it.
  }
  return ids;
}

/**
 * Decide the chamber for a competitor-minted (`MANUAL-*`) filer from evidence,
 * or null for "no evidence — leave it alone".  See the module doc for the
 * precedence; the one rule worth repeating is that 'senate' is never a default.
 */
export function decideMintedChamber(input: {
  legislator: LegislatorMatch | null;
  payloadChamber: ParsedCompetitorChamber | null;
  curatedExecutive: boolean;
  executiveTwin: boolean;
}): ParsedCompetitorChamber | null {
  if (input.payloadChamber === 'executive' || input.curatedExecutive) return 'executive';
  if (input.legislator?.chamber) return input.legislator.chamber;
  if (input.payloadChamber) return input.payloadChamber;
  if (input.executiveTwin) return 'executive';
  return null;
}

/**
 * Pure planning step (no DB/network): decide resolved_bioguide_id backfills,
 * display_name writes, authoritative party/state/district overwrites, chamber
 * corrections for competitor-minted filers, and fallback-cleaned display names
 * for unresolved filers. Idempotent — a filer whose computed values already
 * match what's stored produces no change entry.
 */
export function planIdentitySync(
  filers: readonly IdentityFilerRow[],
  indexes: LegislatorIndexes,
  evidence: IdentityEvidence = {},
): IdentityPlan {
  const changes: IdentityPlanChange[] = [];
  let bioguideResolved = 0;
  let displayNamesSet = 0;
  let fieldsBackfilled = 0;
  let cleaned = 0;
  let unresolved = 0;
  let chambersCorrected = 0;
  let staleResolutionsFixed = 0;

  // Name keys of the live executive-branch filers (the OGE-sourced EXEC-* rows):
  // a MANUAL-* filer sharing one is that same official.
  const executiveNameKeys = new Set<string>();
  for (const f of filers) {
    if (f.chamber === 'executive' && !isMintedCompetitorFilerId(f.bioguide_id)) {
      const key = normName(fallbackCleanDisplayName(f.full_name));
      if (key) executiveNameKeys.add(key);
    }
  }

  for (const f of filers) {
    const minted = isMintedCompetitorFilerId(f.bioguide_id);
    const payloadChamber = minted ? evidence.payloadChamber?.get(f.bioguide_id) ?? null : null;
    const latestTxDate = minted ? evidence.latestTxDate?.get(f.bioguide_id) ?? null : null;
    const curatedExecutive =
      minted &&
      (evidence.executiveFilerIds?.has(f.bioguide_id) === true || resolveExecutiveFilerIdFromName(f.full_name) !== null);
    const executive = payloadChamber === 'executive' || curatedExecutive;
    const accept = (m: LegislatorMatch) => plausibleLegislator(m, { latestTxDate, executive });
    const canResolve = f.chamber === 'house' || f.chamber === 'senate';

    let resolvedBioguide = f.resolved_bioguide_id;
    let newlyResolved = false;
    let staleCleared = false;

    // A stored resolution onto a legislator who cannot be this filer is a
    // mis-resolution: re-resolve to a plausible one, or clear it.
    if (resolvedBioguide && (canResolve || minted)) {
      const stored = indexes.byBioguide.get(resolvedBioguide);
      if (stored && !accept(stored)) {
        const better = executive ? null : resolveByName(f, indexes, accept, { ignoreStoredState: true });
        if (better && better.bioguide !== resolvedBioguide) {
          resolvedBioguide = better.bioguide;
          newlyResolved = true;
        } else if (!better) {
          resolvedBioguide = null;
          staleCleared = true;
        }
        staleResolutionsFixed++;
      }
    }

    if (!resolvedBioguide && !staleCleared && !executive && canResolve) {
      const match = resolveByName(f, indexes, accept);
      if (match) {
        resolvedBioguide = match.bioguide;
        newlyResolved = true;
      }
    }

    const legislator = resolvedBioguide ? indexes.byBioguide.get(resolvedBioguide) ?? null : null;
    const twin =
      minted && executiveNameKeys.has(normName(fallbackCleanDisplayName(f.full_name)));
    const nextChamber = minted
      ? decideMintedChamber({ legislator, payloadChamber, curatedExecutive, executiveTwin: twin })
      : null;
    const chamberChanged = nextChamber !== null && nextChamber !== f.chamber;
    const effectiveChamber = chamberChanged ? nextChamber : f.chamber;
    const isExecutive = effectiveChamber === 'executive';

    if (resolvedBioguide) {
      if (!legislator) {
        // Bioguide known but not present in this fetch of the roster (stale
        // id, or a fetch that failed to include it) — nothing more we can
        // safely compute this run beyond the backfill itself.
        if (newlyResolved) {
          changes.push({
            filerId: f.bioguide_id,
            kind: 'resolved',
            before: { resolved_bioguide_id: f.resolved_bioguide_id },
            after: { resolved_bioguide_id: resolvedBioguide },
          });
          bioguideResolved++;
        }
        continue;
      }

      const displayName = legislatorDisplayName(legislator);
      // An executive filer shows a position, never a district; a competitor-
      // minted executive also drops the geography/party of a FORMER legislative
      // career (a sitting Secretary is not "D HI-2").
      const nextParty = isExecutive && minted ? null : legislator.party;
      const nextState = isExecutive && minted ? null : legislator.state;
      const nextDistrict = isExecutive ? null : legislator.district;

      const displayChanged = displayName !== null && displayName !== f.display_name;
      const fieldsChanged =
        nextParty !== f.party || nextState !== f.state || nextDistrict !== f.district;

      if (newlyResolved || displayChanged || fieldsChanged || chamberChanged) {
        const after: Partial<IdentityFilerRow> = {
          resolved_bioguide_id: resolvedBioguide,
          display_name: displayName ?? f.display_name,
          party: nextParty,
          state: nextState,
          district: nextDistrict,
        };
        if (chamberChanged) after.chamber = nextChamber;
        changes.push({
          filerId: f.bioguide_id,
          kind: newlyResolved ? 'resolved' : chamberChanged ? 'chamber' : displayChanged ? 'display-name' : 'fields',
          before: {
            resolved_bioguide_id: f.resolved_bioguide_id,
            display_name: f.display_name,
            party: f.party,
            state: f.state,
            district: f.district,
            ...(chamberChanged ? { chamber: f.chamber } : {}),
          },
          after,
        });
        if (newlyResolved) bioguideResolved++;
        if (displayChanged) displayNamesSet++;
        if (fieldsChanged) fieldsBackfilled++;
        if (chamberChanged) chambersCorrected++;
      }
    } else {
      unresolved++;
      const next = fallbackCleanDisplayName(f.full_name);
      const nameChanged = next !== f.display_name;
      if (nameChanged || chamberChanged || staleCleared) {
        const before: Partial<IdentityFilerRow> = { display_name: f.display_name };
        const after: Partial<IdentityFilerRow> = { display_name: next };
        if (staleCleared) {
          before.resolved_bioguide_id = f.resolved_bioguide_id;
          before.party = f.party;
          before.state = f.state;
          before.district = f.district;
          after.resolved_bioguide_id = null;
          after.party = null;
          after.state = null;
          after.district = null;
        }
        if (chamberChanged) {
          before.chamber = f.chamber;
          after.chamber = nextChamber;
        }
        changes.push({
          filerId: f.bioguide_id,
          kind: staleCleared ? 'cleared' : chamberChanged ? 'chamber' : 'cleaned',
          before,
          after,
        });
        if (nameChanged) cleaned++;
        if (chamberChanged) chambersCorrected++;
      }
    }
  }

  return {
    changes,
    filersScanned: filers.length,
    bioguideResolved,
    displayNamesSet,
    fieldsBackfilled,
    cleaned,
    unresolved,
    chambersCorrected,
    staleResolutionsFixed,
  };
}

/**
 * Read the evidence the planner needs for competitor-minted filers in two
 * bounded aggregate queries over `MANUAL-*` rows (a few thousand at most):
 * the chamber their payloads' `member_type` declares, and their latest trade
 * date.  Never throws — a failed read just means "no evidence".
 */
export async function loadIdentityEvidence(env: Env): Promise<IdentityEvidence> {
  const payloadChamber = new Map<string, ParsedCompetitorChamber>();
  const latestTxDate = new Map<string, string>();
  try {
    const rows = await all<{ filer_id: string; member_type: string | null; n: number; last_tx: string | null }>(
      env.DB,
      `SELECT filer_id,
              CASE WHEN json_valid(raw_text) THEN lower(COALESCE(json_extract(raw_text, '$.member_type'), '')) ELSE '' END AS member_type,
              COUNT(*) AS n,
              MAX(tx_date) AS last_tx
         FROM transactions
        WHERE filer_id >= 'MANUAL-' AND filer_id < 'MANUAL.'
          AND deprecated_at IS NULL
          AND source = 'competitor_backfill'
        GROUP BY filer_id, member_type`,
    );
    const tally = new Map<string, Map<ParsedCompetitorChamber, number>>();
    for (const r of rows) {
      if (r.last_tx && (latestTxDate.get(r.filer_id) ?? '') < r.last_tx) latestTxDate.set(r.filer_id, r.last_tx);
      const chamber = chamberFromMemberType(r.member_type);
      if (!chamber) continue;
      const byChamber = tally.get(r.filer_id) ?? new Map<ParsedCompetitorChamber, number>();
      byChamber.set(chamber, (byChamber.get(chamber) ?? 0) + Number(r.n));
      tally.set(r.filer_id, byChamber);
    }
    for (const [filerId, byChamber] of tally) {
      const total = [...byChamber.values()].reduce((a, b) => a + b, 0);
      for (const [chamber, n] of byChamber) {
        if (total > 0 && n / total >= PAYLOAD_CHAMBER_MAJORITY) payloadChamber.set(filerId, chamber);
      }
    }
  } catch (err) {
    console.warn('identity sync: competitor payload evidence unavailable:', (err as Error).message);
  }
  return { payloadChamber, latestTxDate, executiveFilerIds: executiveFilerIdsFromPhotoPack() };
}

export interface IdentitySyncResult {
  filersScanned: number;
  bioguideResolved: number;
  displayNamesSet: number;
  fieldsBackfilled: number;
  cleaned: number;
  unresolved: number;
  chambersCorrected: number;
  staleResolutionsFixed: number;
  dryRun: boolean;
  /** Present only for dryRun: first 50 planned changes. */
  sample?: IdentityPlanChange[];
}

export async function runIdentitySync(
  env: Env,
  opts: { dryRun?: boolean } = {},
): Promise<IdentitySyncResult> {
  const dryRun = opts.dryRun === true;
  const indexes = await fetchLegislatorIndexes();
  const filers = await all<IdentityFilerRow>(
    env.DB,
    'SELECT bioguide_id, chamber, full_name, party, state, district, resolved_bioguide_id, display_name FROM filers',
  );
  const evidence = await loadIdentityEvidence(env);
  const plan = planIdentitySync(filers, indexes, evidence);

  if (dryRun) {
    return {
      filersScanned: plan.filersScanned,
      bioguideResolved: plan.bioguideResolved,
      displayNamesSet: plan.displayNamesSet,
      fieldsBackfilled: plan.fieldsBackfilled,
      cleaned: plan.cleaned,
      unresolved: plan.unresolved,
      chambersCorrected: plan.chambersCorrected,
      staleResolutionsFixed: plan.staleResolutionsFixed,
      dryRun: true,
      sample: plan.changes.slice(0, 50),
    };
  }

  // Each change writes exactly the columns its `after` names (a 'cleaned'
  // change touches display_name only; a chamber correction adds `chamber`).
  const WRITABLE: ReadonlyArray<keyof IdentityFilerRow> = [
    'resolved_bioguide_id',
    'display_name',
    'party',
    'state',
    'district',
    'chamber',
  ];
  const statements = plan.changes.map((change) => {
    const after = change.after;
    const cols = WRITABLE.filter((c) => Object.prototype.hasOwnProperty.call(after, c));
    return env.DB.prepare(
      `UPDATE filers SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE bioguide_id = ?`,
    ).bind(...cols.map((c) => after[c] ?? null), change.filerId);
  });
  for (let i = 0; i < statements.length; i += 50) {
    await batchPrepared(env.DB, statements.slice(i, i + 50));
  }

  // Post-sync deduplication sweep: merges any split filers sharing the same bioguide or name key
  await dedupeSplitFilerIdentities(env).catch(() => {});

  return {
    filersScanned: plan.filersScanned,
    bioguideResolved: plan.bioguideResolved,
    displayNamesSet: plan.displayNamesSet,
    fieldsBackfilled: plan.fieldsBackfilled,
    cleaned: plan.cleaned,
    unresolved: plan.unresolved,
    chambersCorrected: plan.chambersCorrected,
    staleResolutionsFixed: plan.staleResolutionsFixed,
    dryRun: false,
  };
}
