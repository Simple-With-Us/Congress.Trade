/**
 * src/enrichment/legislators.ts
 *
 * Shared congress-legislators roster fetch + name-matching for member
 * enrichment (photos, committees, bioguide resolution, display names).
 * Extracted from admin/routes.ts's original buildLegislatorMap/normName so
 * app/src/enrichment/identitySync.ts can reuse the exact same roster and
 * matching rules without duplicating the fetch.
 *
 * Two lookup shapes are exposed over the same roster:
 *   - the PRIMARY map (`indexLegislators`): normalized "first last" /
 *     "nickname last" / official_full -> LegislatorMatch. This is the
 *     original photo-enrichment lookup, unchanged in behavior.
 *   - the FALLBACK index (`indexLegislatorFallback`): a first-token +
 *     last-token key (see `fallbackNameKeys`) for free-text names that carry
 *     a middle name/initial the primary keys don't account for (e.g. "Richard
 *     Dean McCormick" when official_full/nickname don't literally contain
 *     "Dean"), or a multi-word surname referenced by only its last word (e.g.
 *     "Matthew Robert Van Epps" vs. legislator last name "Van Epps"). Callers
 *     MUST gate fallback matches on state (see identitySync.ts) — this index
 *     alone can return multiple candidates for one key and is not a safe
 *     1:1 lookup on its own.
 */

import { trackedFetch } from '../shared/thirdPartyTelemetry.ts';

export const LEGISLATOR_SOURCES = [
  'https://unitedstates.github.io/congress-legislators/legislators-current.json',
  'https://unitedstates.github.io/congress-legislators/legislators-historical.json',
];

/** Generational-suffix tokens dropped by both normalizers below. */
const NAME_SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);

/** Honorific/professional-title tokens dropped only by the fallback key (normName leaves these to the caller's own pre-cleaning). */
const HONORIFIC_TOKENS = new Set(['hon', 'honorable', 'dr', 'mr', 'mrs', 'ms', 'md', 'facs']);

/**
 * Curated bidirectional first-name diminutive groups (~40 common pairs).
 * Disclosure filings frequently carry a legal/formal first name ("William",
 * "Daniel") while congress-legislators indexes members under the informal
 * name they actually go by ("Bill", "Dan") — and occasionally the reverse.
 * Each group is a closed equivalence class: every member is considered
 * interchangeable with every other member of the same group for name-key
 * matching purposes (see `diminutiveEquivalents` / `diminutiveKeyVariants`).
 * This is deliberately NOT a general nickname engine — entries not listed
 * here (e.g. "Rafael" -> "Ted", which shares no lexical root) are handled
 * instead via the curated MEMBER_NAME_ALIASES allow-list in
 * shared/memberIdentity.ts, never guessed at.
 */
const DIMINUTIVE_GROUPS: readonly (readonly string[])[] = [
  ['william', 'bill', 'billy', 'will'],
  ['robert', 'bob', 'rob', 'bobby'],
  ['richard', 'rich', 'rick', 'dick'],
  ['james', 'jim', 'jimmy'],
  ['thomas', 'tom', 'thom'],
  ['daniel', 'dan', 'danny'],
  ['christopher', 'chris'],
  ['michael', 'mike'],
  ['joseph', 'joe'],
  ['edward', 'ed', 'ted'],
  ['john', 'jack', 'jon'],
  ['jacklyn', 'jacky', 'jackie'],
  ['jonathan', 'jon'],
  ['matthew', 'matt'],
  ['timothy', 'tim'],
  ['kenneth', 'ken'],
  ['ronald', 'ron'],
  ['donald', 'don'],
  ['steven', 'stephen', 'steve'],
  ['charles', 'charlie', 'chuck'],
  ['anthony', 'tony'],
  ['benjamin', 'ben'],
  ['samuel', 'sam'],
  ['joshua', 'josh'],
  ['andrew', 'andy', 'drew'],
  ['nicholas', 'nick'],
  ['patrick', 'pat'],
  ['gregory', 'greg'],
  ['lawrence', 'larry'],
  ['gerald', 'jerry'],
  ['theodore', 'ted'],
  ['elizabeth', 'liz', 'lizzie', 'beth'],
  ['katherine', 'kate', 'katie', 'kathy'],
  ['margaret', 'maggie', 'meg'],
  ['jennifer', 'jen'],
  ['deborah', 'deb', 'debbie'],
  ['cynthia', 'cindy'],
  ['tammy', 'tamara'],
  ['bernard', 'bernardo', 'bernie'],
  ['august', 'augie'],
  ['frederick', 'fred'],
];

const DIMINUTIVE_MAP: Map<string, Set<string>> = (() => {
  const map = new Map<string, Set<string>>();
  for (const group of DIMINUTIVE_GROUPS) {
    for (const name of group) {
      const set = map.get(name) ?? new Set<string>();
      for (const other of group) {
        if (other !== name) set.add(other);
      }
      map.set(name, set);
    }
  }
  return map;
})();

/** All curated diminutive-equivalents of a single lowercase name token (empty array if none). */
export function diminutiveEquivalents(token: string): string[] {
  return [...(DIMINUTIVE_MAP.get(token.toLowerCase()) ?? [])];
}

/**
 * Given a normalized "first ... last" key (space-joined, lowercase — the
 * shape both `normName` and `fallbackNameKeys` produce), return alternate
 * keys with the FIRST token swapped for each of its curated diminutive
 * equivalents. Returns [] when the first token has no known equivalents or
 * the key has fewer than two tokens. Callers are responsible for gating any
 * hit against these variants the same way as other fuzzy/fallback matches
 * (state match, or a globally-unique candidate) — a diminutive swap is not
 * an exact match and must never be trusted unconditionally.
 */
export function diminutiveKeyVariants(key: string): string[] {
  const tokens = key.split(' ').filter(Boolean);
  if (tokens.length < 2) return [];
  const equivalents = diminutiveEquivalents(tokens[0]);
  if (equivalents.length === 0) return [];
  const rest = tokens.slice(1).join(' ');
  return equivalents.map((eq) => `${eq} ${rest}`);
}

/**
 * Fold a name to plain ASCII letters for matching.
 *
 * Two failure modes this exists to kill, both observed live as members with no
 * photo at all:
 *
 *   - **Diacritics.** congress-legislators stores the accented spelling
 *     ("Nanette Diaz Barragán", "Raúl M. Grijalva", "Linda T. Sánchez") while
 *     disclosure filings carry the unaccented one. Without folding, those keys
 *     never meet and the member falls out of every name-driven enrichment.
 *   - **Typographic apostrophes.** The roster writes "O’Halleran" with U+2019;
 *     filings write "O'Halleran" with an ASCII quote. Same name, different
 *     bytes. Apostrophes are dropped entirely so both collapse to "ohalleran".
 *
 * Folding cannot create a false match here: two names that differ only by
 * accent or apostrophe style are the same name.
 */
export function foldNameChars(s: string): string {
  return s
    .normalize('NFD')
    // Combining diacritical marks.
    .replace(/[̀-ͯ]/g, '')
    // Curly quotes/apostrophes and hyphen variants that survive NFD.
    .replace(/[‘’ʼ′']/g, '')
    .replace(/[‐-―]/g, '-');
}

/**
 * Normalize a politician name for matching: fold accents/apostrophes,
 * lowercase, strip punctuation, drop middle initials (single letters) and
 * suffixes. "Ron L Wyden" -> "ron wyden"; "Raúl M. Grijalva" -> "raul grijalva".
 */
export function normName(s: string | null | undefined): string {
  return foldNameChars(s ?? '')
    .toLowerCase()
    .replace(/[.,]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !NAME_SUFFIXES.has(t))
    .join(' ')
    .trim();
}

export interface LegislatorTerm {
  type?: string;
  party?: string;
  state?: string;
  district?: number | string | null;
  start?: string;
  end?: string;
}

export interface Legislator {
  id?: { bioguide?: string };
  name?: { first?: string; middle?: string; last?: string; official_full?: string; nickname?: string };
  terms?: LegislatorTerm[];
}

export type LegislatorChamber = 'house' | 'senate';

export interface LegislatorMatch {
  bioguide: string;
  party: string | null;
  state: string | null;
  district: string | null;
  /** congress-legislators name.official_full — the preferred public display name. */
  officialFull: string | null;
  nickname: string | null;
  first: string | null;
  last: string | null;
  /** Chamber of the LATEST term: 'rep' -> house, 'sen' -> senate.  Null when the term type is absent/unknown. */
  chamber: LegislatorChamber | null;
  /** End date (YYYY-MM-DD) of the latest term; null when the roster carries none (treated as still serving). */
  lastTermEnd: string | null;
}

/**
 * The earliest date a legislator's last term can end and still be someone who
 * files periodic transaction reports we would ever ingest.  The STOCK Act
 * (April 2012) created the PTR duty, so a name-only match onto a legislator
 * whose service ended before this (Gillis Long d. 1985, the WWII-era John
 * Delaney, a 2007 Mark Green) is a mis-resolution by construction.
 */
export const DISCLOSURE_ERA_START = '2012-01-01';

export function latestLegislatorTerm(terms: LegislatorTerm[] | undefined): LegislatorTerm | undefined {
  return (terms ?? []).slice().sort((a, b) => String(b.start ?? '').localeCompare(String(a.start ?? '')))[0];
}

function chamberFromTermType(type: string | undefined): LegislatorChamber | null {
  if (type === 'rep') return 'house';
  if (type === 'sen') return 'senate';
  return null;
}

function toMatch(leg: Legislator): LegislatorMatch | null {
  const bio = leg.id?.bioguide;
  if (!bio) return null;
  const term = latestLegislatorTerm(leg.terms);
  const n = leg.name ?? {};
  return {
    bioguide: bio,
    party: term?.party ?? null,
    state: term?.state ?? null,
    district: term?.district == null ? null : String(term.district),
    officialFull: n.official_full ?? null,
    nickname: n.nickname ?? null,
    first: n.first ?? null,
    last: n.last ?? null,
    chamber: chamberFromTermType(term?.type),
    lastTermEnd: term?.end ? String(term.end) : null,
  };
}

/** True when the legislator's service reaches the STOCK Act / PTR era (a missing end date means still serving). */
export function isDisclosureEraLegislator(m: LegislatorMatch): boolean {
  return !m.lastTermEnd || m.lastTermEnd >= DISCLOSURE_ERA_START;
}

/** Sort key for "who is the more recent holder of this name": a missing end date means still serving. */
function recencyKey(m: LegislatorMatch): string {
  return m.lastTermEnd ?? '9999-12-31';
}

/**
 * Pure: build the normalized-name -> legislator metadata map from an
 * already-fetched legislator list.  When two legislators normalize to the same
 * name key the one whose latest term ends LATER wins (so the 2025 Mark Green
 * beats the 2007 one and John K. Delaney beats John J. Delaney); a tie keeps
 * the earlier entry, so callers should still pass the current roster before
 * the historical one, as `buildLegislatorMap` does.
 */
export function indexLegislators(list: readonly Legislator[]): Map<string, LegislatorMatch> {
  const map = new Map<string, LegislatorMatch>();
  for (const leg of list) {
    const match = toMatch(leg);
    if (!match) continue;
    const n = leg.name ?? {};
    const candidates = [
      n.first && n.last ? `${n.first} ${n.last}` : '',
      n.nickname && n.last ? `${n.nickname} ${n.last}` : '',
      n.official_full ?? '',
    ];
    for (const raw of candidates) {
      const k = normName(raw);
      if (!k) continue;
      const existing = map.get(k);
      if (!existing || (existing.bioguide !== match.bioguide && recencyKey(match) > recencyKey(existing))) {
        map.set(k, match);
      }
    }
  }
  return map;
}

/**
 * Tokens usable for the first+last fallback key: lowercase, punctuation
 * stripped, honorifics (Hon/Honorable/Dr/Mr/Mrs/Ms/MD/FACS) dropped,
 * generational suffixes dropped, a literal "ERM" token dropped, and any bare
 * 4-digit year dropped (executive filer rows carry things like "2021 ERM" or
 * a trailing disclosure year that must not become part of a name key).
 */
export function fallbackNameTokens(raw: string | null | undefined): string[] {
  return foldNameChars(String(raw ?? ''))
    .toLowerCase()
    .replace(/[.,]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .filter((t) => !HONORIFIC_TOKENS.has(t))
    .filter((t) => !NAME_SUFFIXES.has(t))
    .filter((t) => t !== 'erm')
    .filter((t) => !/^\d{4}$/.test(t));
}

/**
 * First+last fallback key candidates for a free-text name: the first token
 * paired with the last token, and (when at least 3 tokens remain) the first
 * token paired with the last TWO tokens joined — the second form is what lets
 * a multi-word surname ("Van Epps") match whether the query used the whole
 * surname or, symmetrically, lets a legislator whose registered name is only
 * "First Last" still match a query that carries an extra middle name/word
 * before that last name.
 *
 * Two more variants are generated when the tokens support them:
 *   - a "middle last" key (second token + last token) — catches a filer name
 *     that carries the member's actual middle name where congress-legislators
 *     also has a `name.middle` field ("Richard Dean McCormick" against a
 *     legislator indexed with middle "Dean"; see indexLegislatorFallback).
 *   - a first-INITIAL-stripped variant, when the leading token is a bare
 *     single-letter initial ("A. Mitchell Mcconnell" -> re-run key
 *     generation on ["mitchell", "mcconnell"] as if "Mitchell" were the
 *     first name) — catches formal filings that lead with a legal first
 *     initial ahead of the name the member actually goes by.
 *
 * Returns [] when fewer than 2 usable tokens remain (never a wildcard).
 */
export function fallbackNameKeys(raw: string | null | undefined): string[] {
  const tokens = fallbackNameTokens(raw);
  if (tokens.length < 2) return [];
  const keys = new Set<string>();
  const addKeysFor = (toks: string[]) => {
    if (toks.length < 2) return;
    const first = toks[0];
    keys.add(`${first} ${toks[toks.length - 1]}`);
    if (toks.length >= 3) {
      keys.add(`${first} ${toks.slice(-2).join(' ')}`);
      // "middle last": second token standing in for a legal middle name.
      keys.add(`${toks[1]} ${toks[toks.length - 1]}`);
    }
  };
  addKeysFor(tokens);
  if (tokens.length >= 3 && tokens[0].length === 1) {
    addKeysFor(tokens.slice(1));
  }
  return [...keys];
}

/**
 * Pure: index legislators by their first+last fallback key(s) (derived from
 * first+last, nickname+last, and official_full — the same three candidate
 * strings the primary map uses). Multiple legislators can share a key (e.g.
 * two different people who both key to "james banks" in different states) —
 * this index intentionally keeps every candidate; callers MUST disambiguate
 * (state match, or a unique candidate when the query has no state) before
 * trusting a hit. See identitySync.ts's resolveFallbackBioguide.
 */
export function indexLegislatorFallback(list: readonly Legislator[]): Map<string, LegislatorMatch[]> {
  const idx = new Map<string, LegislatorMatch[]>();
  for (const leg of list) {
    const match = toMatch(leg);
    if (!match) continue;
    const n = leg.name ?? {};
    const keys = new Set<string>();
    for (const k of fallbackNameKeys(n.first && n.last ? `${n.first} ${n.last}` : '')) keys.add(k);
    for (const k of fallbackNameKeys(n.nickname && n.last ? `${n.nickname} ${n.last}` : '')) keys.add(k);
    for (const k of fallbackNameKeys(n.official_full ?? '')) keys.add(k);
    // "middle last" — index a bare `middle last` pair directly (not just via
    // fallbackNameKeys, since a 2-token "middle last" input never produces
    // the middle-position variant fallbackNameKeys generates for >=3-token
    // input). Guarded to a real (non-initial) middle token so this can't
    // degrade into a last-name-only key.
    if (n.middle && n.last) {
      const middleToken = fallbackNameTokens(n.middle)[0];
      if (middleToken && middleToken.length > 1) {
        for (const k of fallbackNameKeys(`${middleToken} ${n.last}`)) keys.add(k);
      }
    }
    for (const key of keys) {
      const existing = idx.get(key);
      if (existing) {
        if (!existing.some((m) => m.bioguide === match.bioguide)) existing.push(match);
      } else {
        idx.set(key, [match]);
      }
    }
  }
  return idx;
}

/** Index legislators by bioguide id (first list entry wins per id — current roster loaded first). */
export function indexLegislatorsByBioguide(list: readonly Legislator[]): Map<string, LegislatorMatch> {
  const idx = new Map<string, LegislatorMatch>();
  for (const leg of list) {
    const match = toMatch(leg);
    if (!match || idx.has(match.bioguide)) continue;
    idx.set(match.bioguide, match);
  }
  return idx;
}

async function fetchAllLegislators(): Promise<Legislator[]> {
  const out: Legislator[] = [];
  for (const url of LEGISLATOR_SOURCES) {
    const res = await trackedFetch(
      url,
      {
        headers: {
          'user-agent': 'congress-feed/0.1 (+https://congress.trade)',
          accept: 'application/json',
        },
      },
      { service: 'member-enrichment', operation: 'fetch-legislator-roster' },
    );
    if (!res.ok) continue;
    out.push(...((await res.json()) as Legislator[]));
  }
  return out;
}

/** Fetch + build the normalized-name -> legislator metadata map from the live hosted JSON. */
export async function buildLegislatorMap(): Promise<Map<string, LegislatorMatch>> {
  return indexLegislators(await fetchAllLegislators());
}

export interface LegislatorIndexes {
  /** normalized "first last" / "nickname last" / official_full -> match. */
  primary: Map<string, LegislatorMatch>;
  /** first+last fallback key(s) -> candidate matches (needs state gating). */
  fallback: Map<string, LegislatorMatch[]>;
  /** bioguide id -> match, for filers that already carry a resolved id. */
  byBioguide: Map<string, LegislatorMatch>;
}

/** Fetch the roster once and build all three lookup shapes over it. */
export async function fetchLegislatorIndexes(): Promise<LegislatorIndexes> {
  const list = await fetchAllLegislators();
  return {
    primary: indexLegislators(list),
    fallback: indexLegislatorFallback(list),
    byBioguide: indexLegislatorsByBioguide(list),
  };
}
