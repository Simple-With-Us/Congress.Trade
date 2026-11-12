/**
 * src/shared/filerIdentityMatch.ts
 *
 * Generic (non-curated) filer identity matching. `memberIdentity.ts` holds a
 * small hand-curated allow-list (e.g. Rohit -> Ro Khanna) for known legal-name
 * renames; this module is the opposite — a narrow, automatic rule that
 * recognizes when two synthetic filer slugs (see ingestion/watcher.ts
 * houseFilerId/senateFilerId) most likely represent the SAME real member
 * because the disclosed name differs only by a middle initial, punctuation,
 * or a generational suffix. Example: "Michael T. McCaul" vs "Michael
 * McCaul" — the House PTR index sometimes carries a filer's legal middle
 * initial and sometimes doesn't, which forks the slug (and therefore the
 * filers row + every stat derived from it) in two.
 *
 * Deliberately conservative — both of these must hold before two names are
 * considered the same identity:
 *   1. Same chamber AND same state (missing/blank on either side fails
 *      closed — we never guess).
 *   2. The same first + last name once middle initials, punctuation, and
 *      generational suffixes (Jr/Sr/II/III/IV) are dropped. A full middle
 *      NAME (not initial) that differs is NOT dropped — two different middle
 *      names is treated as insufficient evidence, not stripped away.
 *
 * This never merges across chamber or state, and never merges on last name
 * alone — a shared last name with a different first name is a hard non-match.
 * Backs both ingestion/watcher.ts match-time resolution (so a new filing
 * doesn't fork a new slug for an already-known member) and the one-time /
 * repeatable backfill in admin/filerIdentityDedupe.ts (which merges any
 * earlier forks already sitting in `filers`).
 */

import { fallbackCleanDisplayName } from '../enrichment/identitySync.ts';

/** Tokens dropped as generational suffixes once middle initials are gone. */
const NAME_SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv']);

/**
 * Reduce a full name to a comparison key: lowercase, strip punctuation, drop
 * single-letter tokens (middle initials, with or without the trailing period
 * already stripped) and generational suffixes, then rejoin the rest in order.
 * "Michael T. McCaul" and "Michael McCaul" both key to "michael mccaul";
 * "Michael Thomas McCaul" keys to "michael thomas mccaul" — a full middle
 * name is preserved, not collapsed, because that is no longer "modulo a
 * middle initial".
 *
 * Returns '' for input that doesn't reduce to at least two tokens (a bare
 * last name can't safely be compared — callers should treat '' as "no key",
 * never as a wildcard match).
 */
export function memberNameMatchKey(raw: string | null | undefined): string {
  const tokens = String(raw ?? '')
    .toLowerCase()
    .replace(/[.,]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 1 && !NAME_SUFFIXES.has(t));
  if (tokens.length < 2) return '';
  return tokens.join(' ');
}

export interface FilerIdentityCandidate {
  fullName: string | null | undefined;
  chamber: string | null | undefined;
  /** Two-letter state code (case-insensitive); required to match. */
  state: string | null | undefined;
}

/**
 * True when `a` and `b` are, with high confidence, the same real member —
 * same chamber, same state, and the same {@link memberNameMatchKey}. Never
 * true when chamber or state is missing on either side (fails closed rather
 * than guessing), and never true on a name-key miss (different first name,
 * or a middle name that isn't just an initial).
 */
export function sameFilerIdentity(a: FilerIdentityCandidate, b: FilerIdentityCandidate): boolean {
  const chamberA = String(a.chamber ?? '').trim().toLowerCase();
  const chamberB = String(b.chamber ?? '').trim().toLowerCase();
  if (!chamberA || chamberA !== chamberB) return false;

  const stateA = String(a.state ?? '').trim().toUpperCase();
  const stateB = String(b.state ?? '').trim().toUpperCase();
  if (!stateA || stateA !== stateB) return false;

  const keyA = memberNameMatchKey(a.fullName);
  const keyB = memberNameMatchKey(b.fullName);
  if (!keyA || !keyB) return false;

  return keyA === keyB;
}

/**
 * Name-match key for `chamber='executive'` filers only. Executive disclosure
 * rows carry no state (see the doc comment above — {@link sameFilerIdentity}
 * fails closed on a blank state, which means it can NEVER match two exec
 * rows to each other), so admin/filerIdentityDedupe.ts's exec pass uses this
 * narrower key instead: chamber-scoped by the caller (never applied outside
 * `chamber='executive'`), state is not consulted at all.
 *
 * Reuses enrichment/identitySync.ts's `fallbackCleanDisplayName` (the same
 * cleanup identity sync already applies when computing a display name for a
 * filer that never resolves to a bioguide) to strip ERM markers, bare years,
 * and dotted/dashed date fragments — the noise that forks one real person
 * into several exec filer rows, e.g. "Barbara M Barrett" vs "Barbara M
 * Barrett 2021 ERM" vs "Alice Albright 10.24..2022" — then reduces the
 * cleaned name the same way {@link memberNameMatchKey} does (drop middle
 * initials/generational suffixes). Returns '' (never a wildcard) when the
 * cleaned name doesn't reduce to at least two tokens.
 */
export function execNameMatchKey(raw: string | null | undefined): string {
  return memberNameMatchKey(fallbackCleanDisplayName(raw));
}
