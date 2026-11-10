/**
 * src/shared/competitorAttribution.ts
 *
 * Shared parsing + identity-guard helpers for `source='competitor_backfill'`
 * rows (doc_id LIKE 'COMPETITOR-%'). These rows are minted by
 * scripts/inject_competitor_data.ts from third-party datasets (Unusual
 * Whales, QuiverQuant, FMP, quiver_trump) whose raw payloads carry the TRUE
 * reporter name and (sometimes) office/district metadata in `raw_text` —
 * verbatim, whatever shape that provider's API returned.
 *
 * Verified-in-production bug this backs the repair for: the original
 * injector resolved filers by LAST NAME ONLY (`MANUAL-${lastName}`), so
 * e.g. Rep. Mike Collins (GA-10)'s crypto trades ended up sharing an
 * identity with Sen. Susan M. Collins (ME) — different chamber, different
 * state, same last name. See:
 *   - admin/competitorAttributionRepair.ts (POST
 *     /api/admin/repair-competitor-attribution) — one-shot repair using
 *     `parseCompetitorReporter` + `competitorReporterMismatch` to find and
 *     reassign already-poisoned rows.
 *   - scripts/inject_competitor_data.ts — the ingestion-time guard that uses
 *     the same parser so future runs never mint the collision in the first
 *     place.
 *
 * Deliberately dependency-light (no Hono/Cloudflare bindings) so it can be
 * imported from both the Worker (admin route) and the standalone Deno
 * backfill script.
 */

import { extractLastName } from '../ingestion/tradeLatency.ts';
import { cleanFilerName } from '../extraction/nameNormalizer.ts';

export type ParsedCompetitorChamber = 'house' | 'senate' | 'executive';

export interface ParsedCompetitorReporter {
  /** Best-effort reporter display name, straight off the payload (uncleaned). */
  name: string | null;
  /** Two-letter state code, upper-cased, when derivable. */
  state: string | null;
  /** District number as a plain string (no leading zeros), when derivable. */
  district: string | null;
  /** Chamber inferred from office/district shape or an explicit field. Never guessed from the name alone. */
  chamber: ParsedCompetitorChamber | null;
  /** Bioguide id, when the payload carries one directly (e.g. a BioGuideID field). */
  bioguideId: string | null;
}

/** Reporter identity currently on file for a transaction's assigned filer. */
export interface AssignedFilerIdentity {
  chamber: string | null;
  state: string | null;
  resolvedBioguideId: string | null;
}

function firstNonEmptyString(...values: unknown[]): string {
  for (const v of values) {
    const s = typeof v === 'string' ? v.trim() : '';
    if (s) return s;
  }
  return '';
}

/** Split a combined "GA10" / "GA-10" / "GA 10" office string into state+district. */
function splitOfficeString(raw: string): { state: string | null; district: string | null } {
  const combined = /^([A-Za-z]{2})[\s-]?(\d{1,3})$/.exec(raw.trim());
  if (combined) return { state: combined[1].toUpperCase(), district: String(Number(combined[2])) };
  const stateOnly = /^([A-Za-z]{2})$/.exec(raw.trim());
  if (stateOnly) return { state: stateOnly[1].toUpperCase(), district: null };
  return { state: null, district: null };
}

/**
 * Best-effort parse of a competitor payload's TRUE reporter identity. Tries
 * a broad set of provider-shaped keys rather than one fixed schema (see the
 * file doc comment for the providers this repo has ingested from). Returns
 * all-null fields (never throws) when nothing is derivable.
 */
export function parseCompetitorReporter(raw: unknown): ParsedCompetitorReporter {
  let obj: Record<string, unknown> | null = null;
  if (raw && typeof raw === 'object') {
    obj = raw as Record<string, unknown>;
  } else if (typeof raw === 'string') {
    try {
      const parsedJson = JSON.parse(raw) as unknown;
      if (parsedJson && typeof parsedJson === 'object') obj = parsedJson as Record<string, unknown>;
    } catch {
      obj = null;
    }
  }
  if (!obj) return { name: null, state: null, district: null, chamber: null, bioguideId: null };

  let name = firstNonEmptyString(
    obj.name, obj.Name, obj.reporter, obj.Reporter, obj.politician, obj.politician_name,
    obj.Representative, obj.representative, obj.Senator, obj.senator, obj.member, obj.Member,
  );
  if (!name) {
    const first = firstNonEmptyString(obj.firstName, obj.FirstName, obj.first_name, obj.First);
    const last = firstNonEmptyString(obj.lastName, obj.LastName, obj.last_name, obj.Last);
    if (first || last) name = [first, last].filter(Boolean).join(' ');
  }

  let state: string | null = null;
  let district: string | null = null;
  for (const v of [obj.office, obj.Office, obj.District, obj.district, obj.stateDistrict, obj.state_district, obj.stateDst]) {
    const s = typeof v === 'string' ? v.trim() : '';
    if (!s) continue;
    const split = splitOfficeString(s);
    if (split.state) {
      state = split.state;
      district = split.district;
      break;
    }
  }
  if (!state) {
    const stateField = firstNonEmptyString(obj.state, obj.State, obj.stateAbbrev, obj.stateCode);
    if (/^[A-Za-z]{2}$/.test(stateField)) state = stateField.toUpperCase();
  }

  let chamber: ParsedCompetitorChamber | null = null;
  if (district) {
    chamber = 'house';
  } else {
    chamber = chamberFromMemberType(
      firstNonEmptyString(obj.chamber, obj.Chamber, obj.House, obj.house, obj.member_type),
    );
  }

  const bioguideId = firstNonEmptyString(obj.BioGuideID, obj.bioguideId, obj.bioguide_id, obj.Bioguide, obj.bioguide) || null;

  return { name: name || null, state, district, chamber, bioguideId };
}

/**
 * True when a parsed TRUE reporter identity clearly does NOT match the
 * filer currently on file for a competitor_backfill row: different chamber,
 * different state, or a differing resolved bioguide id. Fails closed
 * (false) when there isn't enough signal on either side to compare — never
 * guesses a mismatch from partial data.
 */
export function competitorReporterMismatch(
  parsed: ParsedCompetitorReporter,
  assigned: AssignedFilerIdentity,
): boolean {
  if (parsed.chamber && assigned.chamber && parsed.chamber !== assigned.chamber) return true;
  if (parsed.state && assigned.state && parsed.state.toUpperCase() !== assigned.state.toUpperCase()) return true;
  if (parsed.bioguideId && assigned.resolvedBioguideId && parsed.bioguideId !== assigned.resolvedBioguideId) return true;
  return false;
}

/**
 * Chamber declared by a provider's `member_type` / `chamber` string.  Executive
 * comes first so a "senior executive" style value is never read as Senate.
 * Returns null for anything unrecognised — never a guess.
 */
export function chamberFromMemberType(value: unknown): ParsedCompetitorChamber | null {
  const s = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!s) return null;
  if (s.includes('exec')) return 'executive';
  if (s.includes('house') || s.includes('rep')) return 'house';
  if (s.includes('senate') || s.includes('sen')) return 'senate';
  return null;
}

/**
 * Every reporter-name string a competitor payload carries, most specific
 * first ("reporter" carries the full honorific name — "Hon. April McClain
 * Delaney" — where "name" is often a truncated "April Delaney").  Used to
 * match a payload onto an EXISTING filer instead of trusting a bare last
 * name.  Returns [] when nothing is derivable (never throws).
 */
export function competitorReporterNames(raw: unknown): string[] {
  let obj: Record<string, unknown> | null = null;
  if (raw && typeof raw === 'object') {
    obj = raw as Record<string, unknown>;
  } else if (typeof raw === 'string') {
    try {
      const parsedJson = JSON.parse(raw) as unknown;
      if (parsedJson && typeof parsedJson === 'object') obj = parsedJson as Record<string, unknown>;
    } catch {
      obj = null;
    }
  }
  if (!obj) return [];
  const out: string[] = [];
  const add = (v: unknown) => {
    const s = typeof v === 'string' ? v.trim() : '';
    if (s && !out.includes(s)) out.push(s);
  };
  for (const key of [
    'reporter', 'Reporter', 'name', 'Name', 'politician', 'politician_name',
    'Representative', 'representative', 'Senator', 'senator', 'member', 'Member',
  ]) {
    add(obj[key]);
  }
  const first = firstNonEmptyString(obj.firstName, obj.FirstName, obj.first_name, obj.First);
  const last = firstNonEmptyString(obj.lastName, obj.LastName, obj.last_name, obj.Last);
  if (first && last) add(`${first} ${last}`);
  return out;
}

function slugPart(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Mint the same `house-<district>-<name>` synthetic id
 * ingestion/watcher.ts's `houseFilerId` produces, without pulling in that
 * module's much heavier ingestion dependency chain (this module is also
 * imported by the standalone scripts/inject_competitor_data.ts Deno
 * script). Returns null when the name doesn't reduce to a usable slug.
 */
export function competitorHouseFilerId(name: string, state: string, district: string): string | null {
  const cleaned = cleanFilerName(name) || name;
  const slug = slugPart(cleaned);
  if (!slug) return null;
  const dst = slugPart(`${state}${district}`);
  return `house-${dst}-${slug}`;
}

/**
 * Mint the legacy `MANUAL-${LASTNAME}` synthetic id.  Last-name-only ids are
 * what created the phantom filers (one MANUAL-DELANEY holding two different
 * people, MANUAL-ELVIRA beside the real Maria Elvira Salazar), so new code
 * should prefer {@link competitorQualifiedManualFilerId}; this stays for the
 * existing ids and the repair's last-resort fallback.
 */
export function competitorManualFilerId(name: string): string | null {
  const last = extractLastName(name);
  return last ? `MANUAL-${last.toUpperCase()}` : null;
}

/**
 * Mint a first-name-qualified `MANUAL-<FIRST>-<LAST>` id.  Returns null for a
 * bare last name (a single token): the ingest guard refuses to create a filer
 * from a surname alone.
 */
export function competitorQualifiedManualFilerId(name: string): string | null {
  const cleaned = cleanFilerName(name) || name;
  const tokens = cleaned
    .replace(/[.,"']/g, ' ')
    .split(/\s+/)
    .map((t) => t.toLowerCase().replace(/[^a-z]/g, ''))
    .filter((t) => t.length > 1 && !NAME_NOISE_TOKENS.has(t));
  if (tokens.length < 2) return null;
  return `MANUAL-${tokens[0].toUpperCase()}-${tokens[tokens.length - 1].toUpperCase()}`;
}

/** Suffix / honorific tokens ignored when reducing a reporter name to first+last. */
export const NAME_NOISE_TOKENS: ReadonlySet<string> = new Set([
  'jr', 'sr', 'ii', 'iii', 'iv', 'md', 'facs', 'phd', 'hon', 'honorable', 'dr', 'mr', 'mrs', 'ms', 'rep', 'sen',
]);

const CRYPTO_KEYWORDS_RE = /\b(ethereum|bitcoin|sol|sui|usdc|token|coin)\b/i;

/**
 * True when a competitor_backfill row's raw payload is a crypto disclosure
 * mis-stored as an equity `assetType='stock'` row: provider raw notes carry
 * a '[CT]' crypto marker, or the notes/asset name/ticker name a common
 * crypto keyword (ethereum/bitcoin/sol/sui/usdc/token/coin). Only inspects
 * this row's own text (notes/asset name/ticker), never a wider blob, to
 * avoid false-positiving on unrelated payload keys.
 */
export function hasCompetitorCryptoMarker(
  raw: unknown,
  assetName?: string | null,
  ticker?: string | null,
): boolean {
  let notes = '';
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    notes = firstNonEmptyString(o.notes, o.Note, o.note, o.description, o.assetDescription, o.comment, o.Comment);
  } else if (typeof raw === 'string') {
    try {
      const parsedJson = JSON.parse(raw) as unknown;
      return hasCompetitorCryptoMarker(parsedJson, assetName, ticker);
    } catch {
      notes = raw;
    }
  }
  const haystack = [notes, assetName ?? '', ticker ?? ''].filter(Boolean).join(' \n ');
  if (!haystack) return false;
  if (/\[CT\]/i.test(haystack)) return true;
  return CRYPTO_KEYWORDS_RE.test(haystack);
}
