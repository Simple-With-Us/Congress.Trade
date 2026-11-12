/**
 * src/enrichment/committeeSync.ts
 *
 * Committee membership sync: fills filers.committees, a free-text JSON
 * string-array column (see src/analytics/conflicts.ts for why there's no
 * controlled vocabulary) that was historically never populated by ingestion
 * paths — every INSERT hardcodes NULL/'[]'.
 *
 * Primary source: unitedstates/congress-legislators hosted JSON
 *   - committees-current.json
 *   - committee-membership-current.json
 *
 * Secondary source (House only, official Clerk of the House):
 *   - https://clerk.house.gov/xml/lists/MemberData.xml
 *     bioguide-keyed committee assignments using house_committee_id codes
 *     that map onto committees-current.json display names.
 *
 * The two sources are UNIONED per bioguide so either can fill a gap if the
 * other is stale or incomplete. Subcommittee memberships roll up to their
 * parent committee's official display name (e.g. "House Committee on
 * Financial Services"), which is what conflicts.ts's COMMITTEE_SECTOR_RULES
 * match against.
 *
 * Bioguide resolution order for each filer:
 *   1. filers.resolved_bioguide_id (set by photo enrichment / identity sync)
 *   2. filers.bioguide_id when it already looks like a bioguide (A000372)
 *
 * Safe to re-run — only rows whose computed value differs are written.
 */

import type { Env } from '../shared/types.ts';
import { all, batchPrepared } from '../shared/db.ts';
import { trackedFetch } from '../shared/thirdPartyTelemetry.ts';

export const COMMITTEES_CURRENT_URL =
  'https://unitedstates.github.io/congress-legislators/committees-current.json';
export const COMMITTEE_MEMBERSHIP_URL =
  'https://unitedstates.github.io/congress-legislators/committee-membership-current.json';
/** Official House Clerk member roster with bioguide + committee comcodes. */
export const HOUSE_CLERK_MEMBER_DATA_URL =
  'https://clerk.house.gov/xml/lists/MemberData.xml';

/** Bioguide ids look like A000372 / K000389 (letter + 6 digits). */
export const BIOGUIDE_ID_RE = /^[A-Z]\d{6}$/i;

export interface CommitteeSubcommittee {
  thomas_id?: string;
  name?: string;
}

export interface CommitteeRecord {
  type?: string; // "house" | "senate" | "joint"
  name?: string;
  thomas_id?: string;
  /** Clerk of the House short code (e.g. "AG" for Agriculture). */
  house_committee_id?: string;
  senate_committee_id?: string;
  subcommittees?: CommitteeSubcommittee[];
}

export interface CommitteeMembershipEntry {
  name?: string;
  party?: string;
  rank?: number;
  title?: string;
  bioguide?: string;
}

/** thomas_id (top-level) or thomas_id+subcommittee-thomas_id -> member list. */
export type CommitteeMembershipMap = Record<string, CommitteeMembershipEntry[]>;

export interface CommitteeIndex {
  /** Top-level committee thomas_id -> official display name. */
  nameByThomasId: Map<string, string>;
  /** Any membership-file key (top-level OR subcommittee) -> owning top-level thomas_id. */
  parentThomasIdByKey: Map<string, string>;
  /**
   * Clerk house comcode (e.g. "AG" from "AG00") -> official display name.
   * Built from committees-current house_committee_id fields.
   */
  nameByHouseCode: Map<string, string>;
}

/**
 * Index committees-current.json: top-level thomas_id -> display name, and a
 * lookup from every membership-file key (top-level id, or top-level id +
 * subcommittee id concatenated, e.g. "HSAG" + "15" -> "HSAG15") back to its
 * owning top-level committee. Unknown/malformed entries are skipped.
 */
export function buildCommitteeIndex(committees: CommitteeRecord[]): CommitteeIndex {
  const nameByThomasId = new Map<string, string>();
  const parentThomasIdByKey = new Map<string, string>();
  const nameByHouseCode = new Map<string, string>();
  for (const c of committees ?? []) {
    if (!c || typeof c.thomas_id !== 'string' || !c.thomas_id || typeof c.name !== 'string' || !c.name) continue;
    nameByThomasId.set(c.thomas_id, c.name);
    parentThomasIdByKey.set(c.thomas_id, c.thomas_id);
    if (typeof c.house_committee_id === 'string' && c.house_committee_id) {
      nameByHouseCode.set(c.house_committee_id.toUpperCase(), c.name);
    }
    for (const sub of c.subcommittees ?? []) {
      if (!sub || typeof sub.thomas_id !== 'string' || !sub.thomas_id) continue;
      parentThomasIdByKey.set(c.thomas_id + sub.thomas_id, c.thomas_id);
    }
  }
  return { nameByThomasId, parentThomasIdByKey, nameByHouseCode };
}

/**
 * Roll committee-membership-current.json up to bioguide_id -> sorted, deduped
 * top-level committee display names. Subcommittee-only memberships collapse
 * onto their parent; membership keys with no match in the committee index
 * (e.g. a stale/removed committee) are skipped rather than guessed at.
 */
export function buildBioguideCommitteeMap(
  membership: CommitteeMembershipMap,
  index: CommitteeIndex,
): Map<string, string[]> {
  const byBioguide = new Map<string, Set<string>>();
  for (const [key, members] of Object.entries(membership ?? {})) {
    const parentId = index.parentThomasIdByKey.get(key);
    if (!parentId) continue;
    const name = index.nameByThomasId.get(parentId);
    if (!name) continue;
    for (const m of members ?? []) {
      const bioguide = m?.bioguide;
      if (!bioguide) continue;
      if (!byBioguide.has(bioguide)) byBioguide.set(bioguide, new Set());
      byBioguide.get(bioguide)!.add(name);
    }
  }
  return finalizeBioguideMap(byBioguide);
}

function finalizeBioguideMap(byBioguide: Map<string, Set<string>>): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const [bioguide, names] of byBioguide) {
    result.set(bioguide, [...names].sort());
  }
  return result;
}

/** Merge committee name sets from a secondary source into an existing map. */
export function mergeBioguideCommitteeMaps(
  primary: ReadonlyMap<string, string[]>,
  secondary: ReadonlyMap<string, string[]>,
): Map<string, string[]> {
  const merged = new Map<string, Set<string>>();
  for (const [bio, names] of primary) {
    merged.set(bio, new Set(names));
  }
  for (const [bio, names] of secondary) {
    if (!merged.has(bio)) merged.set(bio, new Set());
    for (const n of names) merged.get(bio)!.add(n);
  }
  return finalizeBioguideMap(merged);
}

/**
 * Parse Clerk of the House MemberData.xml into bioguide -> committee display
 * names using the house_committee_id map from committees-current. Clerk codes
 * look like "AG00" / "JU00"; we strip trailing digits to get "AG" / "JU".
 * Only top-level `<committee comcode=...>` assignments are used (subcommittees
 * roll up via the parent comcode prefix).
 */
export function parseHouseClerkMemberData(
  xml: string,
  index: CommitteeIndex,
): Map<string, string[]> {
  const byBioguide = new Map<string, Set<string>>();
  // Lightweight tag scan — no full XML parser dependency in the Deno/Worker bundle.
  // Member blocks contain one bioguideID and zero+ committee comcode attrs.
  const memberBlocks = xml.split(/<member(?=[\s>])/i).slice(1);
  for (const block of memberBlocks) {
    const bioMatch = block.match(/<bioguideID>\s*([A-Za-z]\d{6})\s*<\/bioguideID>/i);
    if (!bioMatch) continue;
    const bioguide = bioMatch[1].toUpperCase();
    // Only full-committee assignments: <committee comcode="AG00" .../>
    // (not subcommittee subcomcode=...).
    const codeRe = /<committee\b[^>]*\bcomcode\s*=\s*"([A-Za-z]{2,4})\d{0,4}"/gi;
    let m: RegExpExecArray | null;
    while ((m = codeRe.exec(block)) !== null) {
      const code = m[1].toUpperCase();
      const name = index.nameByHouseCode.get(code);
      if (!name) continue;
      if (!byBioguide.has(bioguide)) byBioguide.set(bioguide, new Set());
      byBioguide.get(bioguide)!.add(name);
    }
  }
  return finalizeBioguideMap(byBioguide);
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await trackedFetch(
    url,
    {
      headers: {
        'user-agent': 'congress-feed/0.1 (+https://congress.trade)',
        accept: 'application/json',
      },
    },
    { service: 'committee-sync', operation: 'fetch-committee-data' },
  );
  if (!res.ok) {
    throw new Error(`committeeSync: fetch failed (${res.status}) for ${url}`);
  }
  return (await res.json()) as T;
}

async function fetchText(url: string, operation: string): Promise<string> {
  const res = await trackedFetch(
    url,
    {
      headers: {
        'user-agent': 'congress-feed/0.1 (+https://congress.trade)',
        accept: 'application/xml, text/xml, */*',
      },
    },
    { service: 'committee-sync', operation },
  );
  if (!res.ok) {
    throw new Error(`committeeSync: fetch failed (${res.status}) for ${url}`);
  }
  return await res.text();
}

/**
 * Fetch + build the bioguide_id -> committee display names map from the live
 * hosted JSON (primary) and House Clerk MemberData (secondary, best-effort).
 * Clerk failures are logged and ignored so congress-legislators alone still works.
 */
export async function fetchBioguideCommitteeMap(): Promise<Map<string, string[]>> {
  const [committees, membership] = await Promise.all([
    fetchJson<CommitteeRecord[]>(COMMITTEES_CURRENT_URL),
    fetchJson<CommitteeMembershipMap>(COMMITTEE_MEMBERSHIP_URL),
  ]);
  const index = buildCommitteeIndex(committees);
  const primary = buildBioguideCommitteeMap(membership, index);

  let secondary = new Map<string, string[]>();
  try {
    const xml = await fetchText(HOUSE_CLERK_MEMBER_DATA_URL, 'fetch-house-clerk-member-data');
    secondary = parseHouseClerkMemberData(xml, index);
  } catch (err) {
    console.warn(
      'committeeSync: House Clerk secondary source failed (continuing with congress-legislators only):',
      (err as Error).message,
    );
  }

  return mergeBioguideCommitteeMaps(primary, secondary);
}

/**
 * Prefer resolved_bioguide_id; fall back to bioguide_id when the filer PK itself
 * is already a bioguide (rare, but real for some seed/import paths).
 */
export function effectiveBioguide(filer: {
  bioguide_id: string;
  resolved_bioguide_id: string | null;
}): string | null {
  const resolved = (filer.resolved_bioguide_id ?? '').trim();
  if (resolved && BIOGUIDE_ID_RE.test(resolved)) return resolved.toUpperCase();
  const raw = (filer.bioguide_id ?? '').trim();
  if (raw && BIOGUIDE_ID_RE.test(raw)) return raw.toUpperCase();
  return null;
}

export interface FilerCommitteeRow {
  bioguide_id: string;
  resolved_bioguide_id: string | null;
  committees: string | null;
}

export interface CommitteeUpdatePlanEntry {
  filerId: string;
  committees: string[];
}

export interface CommitteeUpdatePlan {
  updates: CommitteeUpdatePlanEntry[];
  /** Bioguide present, memberships found, but already matches stored committees. */
  skipped: number;
  /** Bioguide present but no committee memberships found for that bioguide. */
  unmatched: number;
  /** Filers with neither resolved_bioguide_id nor a bioguide-shaped PK. */
  noBioguide: number;
}

/**
 * Pure planning step (no DB/network): decide which filers.committees rows
 * actually need writing. Uses effectiveBioguide so filers whose PK is already
 * a bioguide (or who carry resolved_bioguide_id) are considered. Skips rows
 * whose stored JSON already matches the (sorted, deduped) computed list.
 */
export function planCommitteeUpdates(
  filers: readonly FilerCommitteeRow[],
  bioguideMap: ReadonlyMap<string, string[]>,
): CommitteeUpdatePlan {
  const updates: CommitteeUpdatePlanEntry[] = [];
  let skipped = 0;
  let unmatched = 0;
  let noBioguide = 0;
  for (const f of filers) {
    const bioguide = effectiveBioguide(f);
    if (!bioguide) {
      noBioguide++;
      continue;
    }
    const names = bioguideMap.get(bioguide);
    if (!names || names.length === 0) {
      unmatched++;
      continue;
    }
    const nextJson = JSON.stringify(names);
    const current = (f.committees ?? '').trim();
    if (current === nextJson) {
      skipped++;
      continue;
    }
    updates.push({ filerId: f.bioguide_id, committees: names });
  }
  return { updates, skipped, unmatched, noBioguide };
}

export interface CommitteeSyncResult {
  /** All filers considered. */
  filersScanned: number;
  updated: number;
  skipped: number;
  unmatched: number;
  noBioguide: number;
  /** Distinct bioguides present in the source map. */
  sourceBioguides: number;
}

/**
 * Fetch current committee rosters and write filers.committees for every filer
 * with a usable bioguide, batching writes 50 at a time. Safe to re-run.
 */
export async function runCommitteeSync(env: Env): Promise<CommitteeSyncResult> {
  const bioguideMap = await fetchBioguideCommitteeMap();
  const filers = await all<FilerCommitteeRow>(
    env.DB,
    'SELECT bioguide_id, resolved_bioguide_id, committees FROM filers',
  );
  const { updates, skipped, unmatched, noBioguide } = planCommitteeUpdates(filers, bioguideMap);

  const statements = updates.map((u) =>
    env.DB.prepare('UPDATE filers SET committees = ? WHERE bioguide_id = ?').bind(
      JSON.stringify(u.committees),
      u.filerId,
    ),
  );
  for (let i = 0; i < statements.length; i += 50) {
    await batchPrepared(env.DB, statements.slice(i, i + 50));
  }

  return {
    filersScanned: filers.length,
    updated: updates.length,
    skipped,
    unmatched,
    noBioguide,
    sourceBioguides: bioguideMap.size,
  };
}
