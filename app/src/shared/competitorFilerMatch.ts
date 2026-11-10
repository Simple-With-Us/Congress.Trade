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
import { NAME_NOISE_TOKENS, type ParsedCompetitorChamber } from './competitorAttribution.ts';

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

  if (args.bioguideId) {
    const hits = real.filter(
      (c) => c.resolvedBioguideId === args.bioguideId && chamberCompatible(args.chamber, c.chamber),
    );
    const one = uniqueOrNull(hits);
    if (one) return one;
  }

  const wanted = args.names.map(competitorNameTokens).filter((t) => t.length >= 2);
  if (wanted.length === 0) return null;

  const hits = real.filter((c) => {
    if (!chamberCompatible(args.chamber, c.chamber)) return false;
    const cState = (c.state ?? '').trim().toUpperCase();
    if (state && cState && state !== cState) return false;
    const have = [c.fullName, c.displayName]
      .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
      .map(competitorNameTokens)
      .filter((t) => t.length >= 2);
    return wanted.some((w) => have.some((h) => competitorNamesMatch(w, h)));
  });
  return uniqueOrNull(hits);
}
