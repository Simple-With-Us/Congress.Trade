/**
 * Congressional member identity helpers.
 *
 * Some disclosure sources use a member's legal first name while congress-
 * legislators and public surfaces use their preferred / official short name.
 * Without an explicit map, those rows land under separate filer rows and
 * split analytics, photos, and bioguide enrichment.
 *
 * This module is the small, curated allow-list for those renames + the
 * durable filer_id merges that accompany them. Extend carefully — only add
 * pairs that are known to be the same person.
 */

import { normalizePersonName } from './executiveIdentity.ts';

export interface MemberNameAlias {
  /** Official / preferred display name (congress-legislators official_full). */
  canonicalName: string;
  /** Normalized aliases (via normalizePersonName) that map to canonicalName. */
  aliases: readonly string[];
}

/**
 * Preferred public name for known legal-name variants on House/Senate PTRs.
 * Keys are compared after {@link normalizePersonName}.
 */
export const MEMBER_NAME_ALIASES: readonly MemberNameAlias[] = [
  {
    // CA-17 House: legal filings sometimes use "Rohit"; official_full is "Ro Khanna".
    canonicalName: 'Ro Khanna',
    aliases: ['rohit khanna', 'khanna rohit'],
  },
  {
    // TX Senate: PTR/disclosure filings sometimes carry Sen. Cruz's legal
    // first name "Rafael" (birth name Rafael Edward Cruz). Unlike the
    // formal/informal pairs the diminutive table in
    // enrichment/legislators.ts bridges ("William" <-> "Bill"), "Rafael" and
    // "Ted" share no lexical root, and congress-legislators' live JSON
    // indexes him only under "Ted" with no nickname/legal-name field
    // connecting the two (confirmed against the hosted current-legislators
    // JSON — his name record is just {first: "Ted", last: "Cruz",
    // official_full: "Ted Cruz"}, no "Rafael" anywhere). No generic key
    // matching can derive this; it is curated here instead.
    canonicalName: 'Ted Cruz',
    aliases: ['rafael cruz', 'rafael e cruz', 'rafael edward cruz', 'cruz rafael edward'],
  },
  {
    // KY Senate: Sen. McConnell's legal name is Addison Mitchell McConnell,
    // Jr. Same situation as Cruz above — congress-legislators' live JSON
    // indexes him only under "Mitch" with no first/middle/nickname field
    // linking "Addison" or "Mitchell" to "Mitch" (his name record is just
    // {first: "Mitch", last: "McConnell", official_full: "Mitch
    // McConnell"}, no middle field at all). Curated here for the same
    // reason as the Cruz entry above.
    canonicalName: 'Mitch McConnell',
    aliases: ['a mitchell mcconnell', 'addison mitchell mcconnell', 'mcconnell a mitchell'],
  },
  {
    // TN-3 House: a filing spells the surname "Fleishmann", dropping the "c".
    // congress-legislators has {first: "Charles", middle: "J.", last:
    // "Fleischmann", nickname: "Chuck"} — the filer's first name and middle
    // initial match exactly and only the surname spelling differs, so this is
    // a transcription error rather than a different person. Left unmapped, the
    // filer resolves to nothing and shows no photo, party or state.
    canonicalName: 'Chuck Fleischmann',
    aliases: ['charles fleishmann', 'charles j fleishmann', 'fleishmann charles'],
  },
  {
    // WV Senate: filings use Sen. Justice's full legal name. Unlike the Cruz /
    // McConnell entries this one IS derivable from the roster (his record is
    // {first: "Jim", middle: "Conley", last: "Justice", official_full: "James
    // C. Justice"}), but only through the middle-name field that the primary
    // name index does not key on — so the pairing is pinned here.
    canonicalName: 'Jim Justice',
    aliases: ['james conley justice', 'justice ii james conley', 'justice james conley'],
  },
  {
    // FL-27 House: competitor backfill sources sometimes truncate her surname
    // to "Maria Elvira". Official full is "Maria Elvira Salazar".
    canonicalName: 'Maria Elvira Salazar',
    aliases: ['maria elvira', 'elvira maria'],
  },
];

/**
 * Durable filer_id merges. First entry is the id we keep; the rest are absorbed.
 * Canonical ids prefer the post-alias house slug (district + preferred name)
 * over MANUAL-* competitor injects and pre-alias legal-name slugs.
 */
export interface MemberFilerMerge {
  /** Filer id that survives. */
  canonicalId: string;
  /** Preferred full_name on the surviving row. */
  canonicalName: string;
  chamber: 'house' | 'senate';
  state?: string | null;
  district?: string | null;
  /** Official Bioguide id when known (stored on filers.resolved_bioguide_id). */
  resolvedBioguideId?: string | null;
  /** Alias filer ids that should be rewritten onto canonicalId. */
  aliasIds: readonly string[];
}

export const MEMBER_FILER_MERGES: readonly MemberFilerMerge[] = [
  {
    canonicalId: 'house-ca17-ro-khanna',
    canonicalName: 'Ro Khanna',
    chamber: 'house',
    state: 'CA',
    district: '17',
    resolvedBioguideId: 'K000389',
    aliasIds: [
      'house-ca17-rohit-khanna',
      'MANUAL-KHANNA',
    ],
  },
  {
    // FL-02 House: production carries three duplicate/malformed filer rows
    // for Rep. Neal Patrick Dunn on top of the canonical one — 'MANUAL-FACS'
    // (full_name 'Neal Patrick Dunn FACS', a competitor-backfill artifact
    // that kept his post-nominal), and the blank-name 'MANUAL-' filer
    // (full_name ' ', 8 transactions with source='competitor_backfill')
    // whose 8 raw_text payloads all cite House Clerk filing #20026140,
    // which names "Hon. Neal Patrick Dunn, MD, FACS — FL02" and matches all
    // 8 assets/dates/amounts exactly. Confirmed via that filing PDF.
    canonicalId: 'house-fl02-neal-patrick-dunn',
    canonicalName: 'Neal Patrick Dunn',
    chamber: 'house',
    state: 'FL',
    district: '02',
    resolvedBioguideId: 'D000628',
    aliasIds: [
      'MANUAL-FACS',
      'MANUAL-',
    ],
  },
  {
    // FL-27 House: Rep. Maria Elvira Salazar
    canonicalId: 'house-fl27-maria-elvira-salazar',
    canonicalName: 'Maria Elvira Salazar',
    chamber: 'house',
    state: 'FL',
    district: '27',
    resolvedBioguideId: 'S000168',
    aliasIds: [
      'MANUAL-ELVIRA',
      'MANUAL-MARIA-ELVIRA',
      'house-fl27-maria-elvira',
    ],
  },
];

/**
 * Apply curated legal → preferred name renames. Input should already have
 * honorifics stripped and "Last, First" flipped (cleanFilerName does that
 * first). Returns the preferred display name when an alias matches, else the
 * original string.
 */
export function applyMemberNameAlias(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return trimmed;
  const norm = normalizePersonName(trimmed);
  if (!norm) return trimmed;
  for (const entry of MEMBER_NAME_ALIASES) {
    if (normalizePersonName(entry.canonicalName) === norm) {
      return entry.canonicalName;
    }
    if (entry.aliases.some((a) => a === norm)) {
      return entry.canonicalName;
    }
  }
  return trimmed;
}

/** Look up the merge group that owns a given filer id, if any. */
export function memberMergeForFilerId(filerId: string | null | undefined): MemberFilerMerge | null {
  if (!filerId) return null;
  for (const group of MEMBER_FILER_MERGES) {
    if (group.canonicalId === filerId || group.aliasIds.includes(filerId)) {
      return group;
    }
  }
  return null;
}

/**
 * Map a filer id onto its durable canonical id when the id is a known alias.
 * Unknown ids pass through unchanged.
 */
export function resolveCanonicalFilerId(filerId: string | null | undefined): string | null {
  if (!filerId) return null;
  const group = memberMergeForFilerId(filerId);
  return group ? group.canonicalId : filerId;
}
