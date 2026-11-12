/**
 * src/extraction/ogeRowIndex.ts
 *
 * Board row 3d31c7b9: OGE Form 278-T rows come back from the scanned/vision
 * path with the table's "#" column glued onto the asset name — "3641 Microsoft
 * Corp. Com", "1146 Jpmorgan Chase & Co. Perp NN 6.8750% (", "1123 the Mosaic Co."
 * — so the name is wrong on every surface and never resolves to a ticker.
 * Trump's 278-T runs past row 3600, so the index is up to four digits (the text
 * layer parser's old `\d{1,3}` row anchor could not even match those rows).
 *
 * A bare `^\d+\s+` strip is unsafe on its own: real issuers start with a number
 * ("360 DigiTech", "3 D Systems").  The index is only stripped when the FILING
 * shows the pattern is the table's own "#" column:
 *   - at least 3 rows and at least half of all rows carry a leading number, or
 *   - a tiny filing (1-2 rows) in which every row carries one and each is <= 99.
 * Exactly one leading token is removed, and only when a letter (or an opening
 * parenthesis, or a second number that is itself followed by a word) follows, so
 * "412 360 DigiTech Inc." keeps "360 DigiTech Inc.".
 *
 * Pure and deterministic; used by normalize() for chamber='executive' filings
 * and by the one-off cleanup of rows already stored (admin/ogeRowIndexCleanup.ts).
 */

const LEADING_ROW_INDEX_RE = /^\s*(\d{1,5})[.)]?\s+(?=[A-Za-z(]|\d+\s+[A-Za-z])/;

export interface OgeRowIndexVerdict {
  /** True when the filing's rows carry the "#" column and it should be stripped. */
  strip: boolean;
  /** Rows that carry a leading number. */
  withIndex: number;
}

/** Decide, for one filing's asset names, whether the leading numbers are the table's row column. */
export function ogeRowIndexVerdict(names: ReadonlyArray<string | null | undefined>): OgeRowIndexVerdict {
  const total = names.length;
  let withIndex = 0;
  let allSmall = true;
  for (const n of names) {
    const m = LEADING_ROW_INDEX_RE.exec(String(n ?? ''));
    if (m) {
      withIndex += 1;
      if (Number(m[1]) > 99) allSmall = false;
    }
  }
  const majority = withIndex >= 3 && withIndex / Math.max(total, 1) >= 0.5;
  const tiny = total >= 1 && total <= 2 && withIndex === total && allSmall;
  return { strip: majority || tiny, withIndex };
}

/** Remove the single leading row index from one asset name (no filing-level check). */
export function stripLeadingRowIndex(name: string): string {
  return name.replace(LEADING_ROW_INDEX_RE, '').trim();
}

/**
 * Return `rows` with the leading row index stripped from `assetName`, when the
 * filing-level verdict says the "#" column is present.  Rows that do not carry
 * an index, and the input array itself, are left untouched.
 */
export function stripOgeRowIndexes<T extends { assetName: string | null }>(rows: readonly T[]): T[] {
  const verdict = ogeRowIndexVerdict(rows.map((r) => r.assetName));
  if (!verdict.strip) return rows.slice();
  return rows.map((r) => {
    const name = r.assetName;
    if (!name || !LEADING_ROW_INDEX_RE.test(name)) return r;
    const stripped = stripLeadingRowIndex(name);
    return stripped ? { ...r, assetName: stripped } : r;
  });
}
