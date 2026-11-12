/**
 * src/shared/competitorFilerMatch.ts
 *
 * Match a competitor payload's TRUE reporter onto an EXISTING filer, so the
 * ingest path never mints a second identity for someone we already track.
 *
 * Why this exists (board rows 2c0b428c / 591011b9): scripts/inject_competitor_data.ts
 * and admin/competitorAttributionRepair.ts used to key new filers by LAST NAME
 * ONLY (`MANUAL-<LAST>`).  Live results were a phantom `MANUAL-ELVIRA` beside
 * the real Maria Elvira Salazar, a `MANUAL-DELANEY` that fused April McClain
 * Delaney's trades with another "Delaney" entirely, and `MANUAL-BURGUM` /
 * `MANUAL-WRIGHT` / `MANUAL-KRATSIOS` beside their `EXEC-*` twins.
 *
 * The matcher is deliberately conservative — it returns a filer only when the
 * evidence points at exactly one live, non-synthetic candidate:
 *   - a payload-carried bioguide id wins outright (unique candidate);
 *   - otherwise first + last name must agree (a curated diminutive such as
 *     Mike/Michael counts as the same first name; middle names and initials
 *     are ignored, so "April Delaney" matches "April McClain Delaney");
 *   - a KNOWN state or chamber that disagrees with the candidate's is a hard
 *     miss (a Senator Collins never absorbs Rep. Collins);
 *   - two or more candidates is ambiguous and yields null — the dedupe pass
 *     merges true duplicates first, then a re-run resolves them.
 *
 * `MANUAL-*` candidates and tombstoned rows are never a target: a phantom must
 * not be chosen as the canonical home for another phantom's rows.
 */

import { cleanFilerName } from '../extraction/nameNormalizer.ts';
import { diminutiveEquivalents } from '../enrichment/legislators.ts';
import {
  competitorHouseFilerId,
  competitorQualifiedManualFilerId,
  NAME_NOISE_TOKENS,
  type ParsedCompetitorChamber,
} from './competitorAttribution.ts';
import { resolveExecutiveFilerIdFromName } from './executiveIdentity.ts';
import { applyMemberNameAlias } from './memberIdentity.ts';

export interface ExistingFilerCandidate {
  filerId: string;
  fullName: string | null;
  displayName?: string | null;
  chamber: string | null;
  state: string | null;
  resolvedBioguideId: string | null;
}

/** True for the synthetic last-name ids the competitor injector mints. */
export function isMintedCompetitorFilerId(filerId: string | null | undefined): boolean {
  return typeof filerId === 'string' && /^MANUAL-/i.test(filerId);
}

/** Lowercase first..last tokens with honorifics, suffixes and single-letter initials removed. */
export function competitorNameTokens(raw: string | null | undefined): string[] {
  const cleaned = cleanFilerName(raw) || String(raw ?? '');
  return cleaned
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[.,"'\u2018\u2019]/g, ' ')
    .split(/\s+/)
    .map((t) => t.toLowerCase().replace(/[^a-z-]/g, ''))
    .filter((t) => t.length > 1 && !NAME_NOISE_TOKENS.has(t));
}

function firstNamesAgree(a: string, b: string): boolean {
  return a === b || diminutiveEquivalents(a).includes(b);
}

/** Same first name (diminutive-aware) and same last name; needs at least two tokens each. */
export function competitorNamesMatch(a: readonly string[], b: readonly string[]): boolean {
  if (a.length < 2 || b.length < 2) return false;
  return firstNamesAgree(a[0], b[0]) && a[a.length - 1] === b[b.length - 1];
}

function chamberCompatible(payload: ParsedCompetitorChamber | null | undefined, filer: string | null): boolean {
  const f = (filer ?? '').trim().toLowerCase();
  if (!payload || !f) return true;
  return payload === f;
}

function uniqueOrNull<T extends { filerId: string }>(hits: readonly T[]): T | null {
  const ids = new Set(hits.map((h) => h.filerId));
  return ids.size === 1 ? hits[0] : null;
}

/** Reporter strings plus curated member aliases ("Maria Elvira" → "Maria Elvira Salazar"). */
function expandReporterNames(names: readonly string[]): string[] {
  const out: string[] = [];
  const add = (raw: string) => {
    const trimmed = raw.trim();
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  };
  for (const name of names) {
    add(name);
    add(applyMemberNameAlias(name));
  }
  return out;
}

function stateCompatible(wanted: string, filerState: string | null): boolean {
  const have = (filerState ?? '').trim().toUpperCase();
  if (!wanted || !have) return true;
  return wanted === have;
}

/**
 * The single existing filer a competitor payload's reporter belongs to, or
 * null when there is no confident, unambiguous match.  See the module doc for
 * the rules.
 */
export function findExistingFilerForCompetitorReporter(args: {
  names: readonly string[];
  chamber?: ParsedCompetitorChamber | null;
  state?: string | null;
  bioguideId?: string | null;
  candidates: readonly ExistingFilerCandidate[];
}): ExistingFilerCandidate | null {
  const real = args.candidates.filter((c) => !isMintedCompetitorFilerId(c.filerId));
  const state = (args.state ?? '').trim().toUpperCase();
  const names = expandReporterNames(args.names);

  if (args.bioguideId) {
    const hits = real.filter(
      (c) => c.resolvedBioguideId === args.bioguideId && chamberCompatible(args.chamber, c.chamber),
    );
    const one = uniqueOrNull(hits);
    if (one) return one;
  }

  // A curated EXEC-* id wins over a same-name roster row. MANUAL-* rows are
  // already excluded, so a phantom is never the canonical home.
  const execHits = real.filter((c) => {
    if (!chamberCompatible(args.chamber, c.chamber) || !stateCompatible(state, c.state)) return false;
    return names.some((name) => resolveExecutiveFilerIdFromName(name) === c.filerId);
  });
  const execOne = uniqueOrNull(execHits);
  if (execOne) return execOne;

  const wanted = names.map(competitorNameTokens).filter((t) => t.length >= 2);
  if (wanted.length === 0) return null;

  const hits = real.filter((c) => {
    if (!chamberCompatible(args.chamber, c.chamber) || !stateCompatible(state, c.state)) return false;
    const have = [c.fullName, c.displayName]
      .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
      .map(competitorNameTokens)
      .filter((t) => t.length >= 2);
    return wanted.some((w) => have.some((h) => competitorNamesMatch(w, h)));
  });
  return uniqueOrNull(hits);
}

export interface CompetitorFilerAssignment {
  filerId: string;
  /** True when the caller must insert this id. An existing roster or EXEC id is never minted. */
  minted: boolean;
}

/**
 * Resolve a competitor reporter onto an existing filer, or mint a qualified id.
 * Returns null for a bare surname: a last-name-only match never creates a filer
 * and never attaches to someone who merely shares that surname.
 */
export function assignCompetitorFilerId(args: {
  rawName: string;
  names?: readonly string[];
  chamber?: ParsedCompetitorChamber | null;
  state?: string | null;
  district?: string | null;
  bioguideId?: string | null;
  candidates: readonly ExistingFilerCandidate[];
}): CompetitorFilerAssignment | null {
  const names = expandReporterNames(args.names && args.names.length > 0 ? args.names : [args.rawName]);
  if (!names.includes(args.rawName.trim()) && args.rawName.trim()) names.unshift(args.rawName.trim());

  const existing = findExistingFilerForCompetitorReporter({
    names,
    chamber: args.chamber,
    state: args.state,
    bioguideId: args.bioguideId,
    candidates: args.candidates,
  });
  if (existing) return { filerId: existing.filerId, minted: false };

  // Refuse before any mint. House slugs and MANUAL-<FIRST>-<LAST> both need
  // a first and a last; "Delaney" must not become house-ny7-delaney.
  const qualified = competitorQualifiedManualFilerId(args.rawName);
  if (!qualified) return null;

  if (args.state && args.district) {
    const houseId = competitorHouseFilerId(args.rawName, args.state, args.district);
    if (houseId) {
      const already = args.candidates.some((c) => c.filerId === houseId);
      return { filerId: houseId, minted: !already };
    }
  }

  const alreadyManual = args.candidates.some((c) => c.filerId === qualified);
  return { filerId: qualified, minted: !alreadyManual };
}
