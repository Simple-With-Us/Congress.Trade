/**
 * src/shared/committeeNames.ts
 *
 * `filers.committees` is a free-text JSON string array. Some runtimes return
 * that column already parsed; some sibling identity rows keep the list on the
 * official-bioguide PK while trades hang off a house-/senate- slug. Both
 * shapes must still produce the same display list.
 */

import { get } from './db.ts';

export function parseCommitteeNames(value: unknown): string[] {
  if (value == null || value === '') return [];
  let parsed: unknown = value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed || trimmed === '[]') return [];
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return uniqueNames(trimmed.split(','));
    }
  }
  if (!Array.isArray(parsed)) return [];
  const names: string[] = [];
  for (const item of parsed) {
    if (typeof item === 'string') {
      const name = item.trim();
      if (name) names.push(name);
      continue;
    }
    if (item && typeof item === 'object') {
      const rec = item as Record<string, unknown>;
      const raw = rec.name ?? rec.committee ?? rec.committeeName ?? rec.title;
      if (typeof raw === 'string' && raw.trim()) names.push(raw.trim());
    }
  }
  return uniqueNames(names);
}

function uniqueNames(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const name = value.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/**
 * Prefer the row we already loaded; if that list is empty, look up any sibling
 * filer that shares the official bioguide (slug PK vs T000278-style PK).
 */
export async function resolveFilerCommittees(
  db: D1Database,
  filerId: string,
  stored: unknown,
  resolvedBioguide?: string | null,
): Promise<string[]> {
  const direct = parseCommitteeNames(stored);
  if (direct.length) return direct;
  const keys = [filerId, resolvedBioguide]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter((value) => value.length > 0 && value.length <= 64);
  const uniq = [...new Set(keys)];
  if (!uniq.length) return [];
  const placeholders = uniq.map(() => '?').join(', ');
  const row = await get<{ committees: unknown }>(
    db,
    `SELECT committees FROM filers
     WHERE (bioguide_id IN (${placeholders}) OR resolved_bioguide_id IN (${placeholders}))
       AND committees IS NOT NULL
       AND TRIM(CAST(committees AS TEXT)) NOT IN ('', '[]')
     LIMIT 1`,
    [...uniq, ...uniq],
  );
  return parseCommitteeNames(row?.committees);
}
