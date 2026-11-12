/**
 * src/analytics/conflicts.ts
 * OWNER: analytics
 *
 * Committee conflict-of-interest signal: flag when a politician who sits on a
 * committee trades a stock in a GICS sector that committee oversees. The
 * committee→sector mapping is the expert panel's curation. Pure + deterministic
 * (unit-tested without a DB).
 *
 * filers.committees is a free-text JSON string array with NO controlled
 * vocabulary ("Armed Services", "Committee on Armed Services", "House Financial
 * Services", subcommittee names, …), so we match by case-insensitive substring
 * containment of a distinctive committee token. Sectors are compared against
 * securities_ref.sector (GICS sector strings).
 */

/** Distinctive lowercase committee token → the GICS sectors it oversees. */
interface CommitteeRule {
  match: string; // substring tested against a lowercased politician committee name
  sectors: string[]; // GICS sectors (match securities_ref.sector values)
}

export const COMMITTEE_SECTOR_RULES: ReadonlyArray<CommitteeRule> = [
  { match: 'armed services', sectors: ['Industrials', 'Information Technology'] },
  { match: 'financial services', sectors: ['Financials', 'Real Estate'] },
  { match: 'banking', sectors: ['Financials', 'Real Estate'] }, // Senate Banking, Housing & Urban Affairs
  { match: 'energy and commerce', sectors: ['Energy', 'Utilities', 'Health Care', 'Communication Services', 'Information Technology'] },
  { match: 'energy and natural resources', sectors: ['Energy', 'Utilities', 'Materials'] },
  { match: 'natural resources', sectors: ['Energy', 'Materials'] }, // House Natural Resources
  { match: 'health, education', sectors: ['Health Care'] }, // Senate HELP
  { match: 'help', sectors: ['Health Care'] },
  { match: 'agriculture', sectors: ['Consumer Staples', 'Materials'] },
  { match: 'transportation and infrastructure', sectors: ['Industrials', 'Utilities'] },
  { match: 'transportation', sectors: ['Industrials'] },
  { match: 'commerce, science', sectors: ['Communication Services', 'Industrials', 'Consumer Discretionary', 'Information Technology'] },
  { match: 'science, space', sectors: ['Information Technology', 'Industrials'] },
  { match: 'science and technology', sectors: ['Information Technology', 'Industrials'] },
  { match: 'judiciary', sectors: ['Information Technology', 'Communication Services', 'Financials'] },
  { match: 'homeland security', sectors: ['Industrials', 'Information Technology', 'Communication Services'] },
  { match: 'intelligence', sectors: ['Industrials', 'Information Technology', 'Communication Services'] },
  { match: 'foreign affairs', sectors: ['Industrials', 'Energy', 'Materials'] },
  { match: 'foreign relations', sectors: ['Industrials', 'Energy', 'Materials'] },
  { match: 'ways and means', sectors: ['Health Care', 'Financials', 'Consumer Staples'] },
  { match: 'finance', sectors: ['Health Care', 'Financials', 'Consumer Staples'] }, // Senate Finance
  { match: 'small business', sectors: ['Financials', 'Consumer Discretionary', 'Industrials'] },
  { match: 'veterans', sectors: ['Health Care', 'Real Estate'] },
  { match: 'environment and public works', sectors: ['Utilities', 'Materials', 'Industrials'] },
  { match: 'oversight', sectors: ['Industrials', 'Information Technology', 'Health Care', 'Financials'] },
  { match: 'appropriations', sectors: ['Industrials', 'Health Care', 'Information Technology', 'Energy'] },
];

export interface ConflictMatch {
  conflict: boolean;
  /** GICS sectors the politician's committees oversee that intersect the traded sector. */
  sector: string | null;
  /** The politician-committee strings that triggered the flag. */
  viaCommittees: string[];
}

/** Sectors a politician oversees given their (free-text) committee list. */
export function oversightSectors(committees: string[]): Set<string> {
  const out = new Set<string>();
  for (const c of committees) {
    if (typeof c !== 'string') continue;
    const lc = c.toLowerCase();
    for (const rule of COMMITTEE_SECTOR_RULES) {
      if (lc.includes(rule.match)) rule.sectors.forEach((s) => out.add(s));
    }
  }
  return out;
}

/**
 * Does this politician, given their committees, have a conflict trading `sector`?
 * Case-insensitive sector comparison. Returns which committees triggered it.
 */
export function committeeConflict(committees: string[], sector: string | null): ConflictMatch {
  if (!sector) return { conflict: false, sector: null, viaCommittees: [] };
  const sectorLc = sector.trim().toLowerCase();
  const via: string[] = [];
  for (const c of committees) {
    if (typeof c !== 'string') continue;
    const lc = c.toLowerCase();
    const hit = COMMITTEE_SECTOR_RULES.some(
      (rule) => lc.includes(rule.match) && rule.sectors.some((s) => s.toLowerCase() === sectorLc),
    );
    if (hit) via.push(c);
  }
  return { conflict: via.length > 0, sector: via.length ? sector : null, viaCommittees: via };
}
