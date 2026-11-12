/**
 * src/shared/executiveTitles.ts
 *
 * Curated `filerId -> title` map for executive-branch (`chamber='executive'`)
 * filers. Neither the OGE ingestion source nor the `filings`/`filers` schema
 * captures a filer's agency/position anywhere (see scout report
 * scout2-name-surfaces-exec.md §3) — `full_name` and `filer_id` are the only
 * identity signals we have. This map fills that gap for display purposes
 * only; it is never written back to the DB.
 *
 * Scope: only the executive filers that actually carry live transactions in
 * production (scout2-prod-data.md §3 — 21 of 152 `EXEC-*` rows have
 * `tx_count > 0`; the rest are dormant duplicate/near-empty rows from a
 * separate "-YYYY-ERM" ingestion pass and are omitted here). Where the same
 * person has both a base id and one or more `-ERM`/dated-suffix duplicate
 * ids in the roster, every variant is mapped to the same title, since the
 * identity-dedupe merge may pick any of them as canonical.
 *
 * Anything not in this map falls back to 'Executive Branch' at display time
 * (see {@link executiveTitleFor}) — never guess a title here without
 * verifying it first.
 */

export const EXECUTIVE_TITLES: Readonly<Record<string, string>> = {
  // Donald J. Trump — President
  'EXEC-DJT': 'President',

  // Scott Bessent — Treasury Secretary
  'EXEC-BESSENT': 'Treasury Secretary',

  // Chris Wright — Energy Secretary
  'EXEC-CWRIGHT': 'Energy Secretary',

  // Linda McMahon — Education Secretary
  'EXEC-MCMAHON': 'Education Secretary',

  // Barbara M. Barrett — Secretary of the Air Force (2020-2021)
  'EXEC-BARBARA-M-BARRETT-2021-ERM': 'Secretary of the Air Force',
  'EXEC-BARBARA-M-BARRETT': 'Secretary of the Air Force',
  'EXEC-BABARA-M-BARRETT': 'Secretary of the Air Force', // typo'd duplicate filer id

  // Alex M. Azar II — HHS Secretary (2018-2021)
  'EXEC-ALEX-M-AZAR-2021-ERM': 'HHS Secretary',

  // Antony J. Blinken — Secretary of State (2021-2025)
  'EXEC-ANTHONY-J-BLINKEN-2025-ERM': 'Secretary of State',
  'EXEC-ANTHONY-J-BLINKEN': 'Secretary of State',

  // Lloyd Austin — Defense Secretary (2021-2025)
  'EXEC-LLOYD-AUSTIN-2025-ERM': 'Defense Secretary',
  'EXEC-LLOYD-AUSTIN': 'Defense Secretary',

  // Eric S. Lander — OSTP Director (2021-2022)
  'EXEC-ERIC-S-LANDER-2022-ERM': 'OSTP Director',
  'EXEC-ERIC-S-LANDER': 'OSTP Director',

  // Michael J. Kratsios — OSTP Director (2025-present)
  'EXEC-MICHAEL-J-KRATSIOS': 'OSTP Director',
  'EXEC-MICHAEL-KRATSIOS': 'OSTP Director',

  // Adewale (Wally) Adeyemo — Deputy Treasury Secretary (2021-2025)
  'EXEC-ADEWALE-ADEYEMO': 'Deputy Treasury Secretary',
  'EXEC-ADEWALE-ADEYEMO-2025-ERM': 'Deputy Treasury Secretary', // gitleaks:allow — filer id, not a key

  // Tommy Beaudreau — Deputy Interior Secretary (2021-2023)
  'EXEC-TOMMY-BEAUDREAU': 'Deputy Interior Secretary',
  'EXEC-TOMMY-BEAUDREAU-2023-ERM': 'Deputy Interior Secretary', // gitleaks:allow — filer id, not a key

  // Frank J. Bisignano — Social Security Commissioner (2025-present)
  'EXEC-FRANK-J-BISIGNANO': 'Social Security Commissioner',

  // Sean Duffy — Transportation Secretary (2025-present)
  'EXEC-SEAN-DUFFY': 'Transportation Secretary',

  // David McCormick — U.S. Senator (PA); files an executive-style OGE
  // disclosure alongside his Senate one (see prod-data scout §2 "mccormick"
  // cluster — same bioguide M001243 as the Senate filer rows).
  'EXEC-MCCORMICK': 'U.S. Senator (PA)',

  // Christine Abizaid — NCTC Director (2021-2024)
  'EXEC-CHRISTINE-ABIZAID': 'NCTC Director',

  // Scott A. Kupor — OPM Director (2025-present)
  'EXEC-SCOTT-A-KUPOR': 'OPM Director',

  // Alice P. Albright — Millennium Challenge Corporation CEO (2022-2025)
  'EXEC-ALICE-ALBRIGHT-10-24-2022': 'MCC Chief Executive Officer',
  'EXEC-ALICE-ALBRIGHT': 'MCC Chief Executive Officer',
  'EXEC-ALICE-ALBRIGHT-2025-ERM': 'MCC Chief Executive Officer',

  // Deanne Criswell — FEMA Administrator (2021-2025)
  'EXEC-DEANNE-CRISWELL': 'FEMA Administrator',
  'EXEC-DEANNE-CRISWELL-2025-ERM': 'FEMA Administrator',
  'EXEC-DEANNE-CHRISWELL': 'FEMA Administrator', // typo'd duplicate filer id
  'EXEC-DIANNE-CRISWELL': 'FEMA Administrator', // typo'd duplicate filer id

  // Doug Burgum — Interior Secretary (2025-present)
  'EXEC-DOUGLAS-J-BURGUM': 'Interior Secretary',
  'EXEC-DOUG-BURGUM': 'Interior Secretary',

  // Sara Bailey — Director, Office of National Drug Control Policy
  // (confirmed Dec 2025)
  'EXEC-SARA-BAILEY': 'ONDCP Director',
};

/** Curated titles are display-only; never present a raw title-less string. */
export const DEFAULT_EXECUTIVE_TITLE = 'Executive Branch';

/**
 * Shortest *professionally formatted* form of each curated title, keyed by the
 * LONG title rather than by filer id — one entry per distinct position instead
 * of one per filer-id variant, so a new `-ERM` duplicate id inherits its short
 * form for free and the two maps can never disagree about the same person.
 *
 * Abbreviation house style (owner 2026-08-11, "'Treasury Secretary' or
 * 'Treasury Sec.' if not room for whole thing"):
 *   - 'Secretary' -> 'Sec.', 'Director' -> 'Dir.', 'Administrator' -> 'Admin.',
 *     'Deputy' -> 'Dep.'  — always with the period; these are abbreviations,
 *     not initialisms.
 *   - Where the agency has a household initialism that is SHORTER than the
 *     abbreviated role ('SSA Commissioner', 'MCC CEO'), prefer the initialism —
 *     it stays a real title rather than a clipped one.
 *   - 'Secretary of State' keeps its preposition ('Sec. of State'): "State
 *     Secretary" is not a title anyone holds.
 *   - Never truncate mid-word, and never emit a bare surname-less fragment.
 *
 * Every value in {@link EXECUTIVE_TITLES} (plus {@link DEFAULT_EXECUTIVE_TITLE})
 * must have an entry here; `executiveTitles.test.ts` asserts that exhaustively
 * so adding a filer without a short form fails CI rather than silently
 * overflowing a narrow cell.
 */
export const EXECUTIVE_TITLES_SHORT: Readonly<Record<string, string>> = {
  President: 'President', // already the shortest correct form
  'Treasury Secretary': 'Treasury Sec.',
  'Energy Secretary': 'Energy Sec.',
  'Education Secretary': 'Education Sec.',
  'Secretary of the Air Force': 'Air Force Sec.',
  'HHS Secretary': 'HHS Sec.',
  'Secretary of State': 'Sec. of State',
  'Defense Secretary': 'Defense Sec.',
  'OSTP Director': 'OSTP Dir.',
  'Deputy Treasury Secretary': 'Dep. Treasury Sec.',
  'Deputy Interior Secretary': 'Dep. Interior Sec.',
  'Social Security Commissioner': 'SSA Commissioner',
  'Transportation Secretary': 'Transportation Sec.',
  'U.S. Senator (PA)': 'Sen. (PA)',
  'NCTC Director': 'NCTC Dir.',
  'OPM Director': 'OPM Dir.',
  'MCC Chief Executive Officer': 'MCC CEO',
  'FEMA Administrator': 'FEMA Admin.',
  'Interior Secretary': 'Interior Sec.',
  'ONDCP Director': 'ONDCP Dir.',
  // Last-resort label for an uncurated EXEC-* filer. Acceptable on its own;
  // never acceptable as a PREFIX in front of a real title (owner 2026-08-11 —
  // no "Exec - Treasury Secretary" anywhere).
  [DEFAULT_EXECUTIVE_TITLE]: 'Executive',
};

/**
 * Longest curated title in characters — 'Social Security Commissioner' (28).
 * Exported so a layout can ask "does my column fit every title?" without
 * re-deriving it, and so the test suite fails loudly if a longer one is added
 * without the callers being re-checked.
 */
export const EXECUTIVE_TITLE_MAX_LENGTH: number = Object.values(EXECUTIVE_TITLES)
  .concat(DEFAULT_EXECUTIVE_TITLE)
  .reduce((longest, title) => Math.max(longest, title.length), 0);

/**
 * Resolve a display title for an executive-branch filer id. Returns null for
 * non-`EXEC-*` ids (callers should not surface a title for congressional
 * filers), and {@link DEFAULT_EXECUTIVE_TITLE} for an `EXEC-*` id with no
 * curated entry.
 */
export function executiveTitleFor(
  filerId: string | null | undefined,
  chamber?: string | null,
): string | null {
  if (!filerId) return null;
  if (!filerId.startsWith('EXEC-')) {
    // A non-EXEC id (a competitor-minted MANUAL-* official) that is filed under
    // chamber='executive' still shows a position — never the bare word
    // "Executive".  Only the truthful fallback here: no title is guessed.
    return chamber === 'executive' ? DEFAULT_EXECUTIVE_TITLE : null;
  }
  return EXECUTIVE_TITLES[filerId] ?? DEFAULT_EXECUTIVE_TITLE;
}

/**
 * Short form of a already-resolved title, or the title itself when it is
 * already as short as it gets. Returns null for a null/blank input, and passes
 * an unrecognised title through unchanged rather than inventing an
 * abbreviation for it.
 */
export function shortExecutiveTitle(title: string | null | undefined): string | null {
  const t = (title ?? '').trim();
  if (!t) return null;
  return EXECUTIVE_TITLES_SHORT[t] ?? t;
}

/**
 * Pick the LONGEST form of `title` that fits `maxChars`.
 *
 *   fitExecutiveTitle('Treasury Secretary', 30) -> 'Treasury Secretary'
 *   fitExecutiveTitle('Treasury Secretary', 14) -> 'Treasury Sec.'
 *   fitExecutiveTitle('Treasury Secretary')     -> 'Treasury Secretary'
 *
 * With no budget (or a non-positive / non-finite one) the full title wins —
 * "no budget" means "unconstrained", never "shrink by default". When even the
 * short form overflows, the short form is still returned: a real, complete
 * title that the layout may ellipsize beats a string this module chopped in
 * half.
 */
export function fitExecutiveTitle(
  title: string | null | undefined,
  maxChars?: number | null,
): string | null {
  const t = (title ?? '').trim();
  if (!t) return null;
  const budget = typeof maxChars === 'number' && Number.isFinite(maxChars) ? Math.floor(maxChars) : 0;
  if (budget <= 0 || t.length <= budget) return t;
  const short = EXECUTIVE_TITLES_SHORT[t];
  if (!short) return t; // uncurated: pass through rather than fabricate
  return short;
}

/**
 * `executiveTitleFor` + `fitExecutiveTitle` in one call: the longest curated
 * form of this filer's position that fits `maxChars`. Null for non-`EXEC-*`
 * ids, exactly like {@link executiveTitleFor}.
 */
export function executiveTitleForBudget(
  filerId: string | null | undefined,
  maxChars?: number | null,
): string | null {
  return fitExecutiveTitle(executiveTitleFor(filerId), maxChars);
}

/**
 * Serializable snapshot of both maps for clients that cannot import this
 * module — the browser dashboard inlines it into its bundle at build time (see
 * ui/dashboardHtml.ts `EXEC_TITLES`), the same way the benchmark catalog is
 * inlined, so the web title list can never drift from this file.
 */
export function executiveTitleForms(): {
  titles: Record<string, string>;
  short: Record<string, string>;
  fallback: string;
  fallbackShort: string;
} {
  return {
    titles: { ...EXECUTIVE_TITLES },
    short: { ...EXECUTIVE_TITLES_SHORT },
    fallback: DEFAULT_EXECUTIVE_TITLE,
    fallbackShort: EXECUTIVE_TITLES_SHORT[DEFAULT_EXECUTIVE_TITLE] ?? DEFAULT_EXECUTIVE_TITLE,
  };
}
