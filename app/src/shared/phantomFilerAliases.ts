/**
 * Known MANUAL-* phantoms (CT-1362 / CT-1360) whose stored metadata is a
 * last-name guess. The alias step re-points trades onto the roster or EXEC
 * id and tombstones the phantom. It does not delete the filer row and does
 * not rewrite chamber or party.
 *
 * John Delaney / NY-7 on MANUAL-DELANEY is that guess, not a second member.
 * Name matching refuses it; this map is the only reason those rows move to
 * April McClain Delaney (MD-6).
 */

const FILER_ID = /^[A-Za-z0-9-]+$/;

export const KNOWN_PHANTOM_FILER_ALIASES: readonly (readonly [aliasId: string, canonicalId: string])[] = [
  ['MANUAL-WRIGHT', 'EXEC-CWRIGHT'],
  ['MANUAL-BURGUM', 'EXEC-DOUGLAS-J-BURGUM'],
  ['MANUAL-KRATSIOS', 'EXEC-MICHAEL-J-KRATSIOS'],
  ['MANUAL-BISIGNANO', 'EXEC-FRANK-J-BISIGNANO'],
  ['MANUAL-BAILEY', 'EXEC-SARA-BAILEY'],
  ['MANUAL-KUPOR', 'EXEC-SCOTT-A-KUPOR'],
  ['MANUAL-KEAN', 'house-nj07-thomas-h-kean'],
  ['MANUAL-STAUBER', 'house-mn08-peter-allen-stauber'],
  ['MANUAL-ELVIRA', 'house-fl27-maria-elvira-salazar'],
  ['MANUAL-DELANEY', 'house-md06-april-mcclain-delaney'],
];

const PHANTOM_CANONICAL = new Map(KNOWN_PHANTOM_FILER_ALIASES);

export function phantomCanonicalId(aliasId: string | null | undefined): string | null {
  if (!aliasId) return null;
  return PHANTOM_CANONICAL.get(aliasId) ?? null;
}

function sqlId(id: string): string {
  if (!FILER_ID.test(id)) throw new Error(`refusing to embed filer id ${id}`);
  return `'${id}'`;
}

/**
 * Idempotent data statements for POST /api/admin/migrate. A missing canonical
 * row is a no-op, so an empty database and a second run both change nothing.
 * Colliding live (doc_id, source, row_key) rows are deprecated in place rather
 * than deleted, then every other live trade and filing is re-pointed.
 */
export function phantomFilerAliasStatements(): readonly string[] {
  const out: string[] = [];
  for (const [alias, canonical] of KNOWN_PHANTOM_FILER_ALIASES) {
    const a = sqlId(alias);
    const c = sqlId(canonical);
    const canonicalLive = `EXISTS (SELECT 1 FROM filers WHERE bioguide_id = ${c} AND merged_into IS NULL)`;
    out.push(
      `UPDATE transactions
          SET deprecated_at = COALESCE(deprecated_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
              deprecated_reason = COALESCE(deprecated_reason, 'phantom-filer-alias-duplicate')
        WHERE filer_id = ${a}
          AND deprecated_at IS NULL
          AND row_key IS NOT NULL
          AND ${canonicalLive}
          AND EXISTS (
            SELECT 1 FROM transactions AS canon
             WHERE canon.filer_id = ${c}
               AND canon.doc_id = transactions.doc_id
               AND canon.source IS transactions.source
               AND canon.row_key = transactions.row_key
               AND canon.deprecated_at IS NULL
          )`,
    );
    out.push(
      `UPDATE transactions
          SET filer_id = ${c}
        WHERE filer_id = ${a}
          AND deprecated_at IS NULL
          AND ${canonicalLive}
          AND NOT EXISTS (
            SELECT 1 FROM transactions AS canon
             WHERE canon.filer_id = ${c}
               AND canon.doc_id = transactions.doc_id
               AND canon.source IS transactions.source
               AND canon.row_key IS NOT NULL
               AND canon.row_key = transactions.row_key
               AND transactions.row_key IS NOT NULL
               AND canon.deprecated_at IS NULL
          )`,
    );
    out.push(
      `UPDATE filings SET filer_id = ${c} WHERE filer_id = ${a} AND ${canonicalLive}`,
    );
    out.push(
      `UPDATE filers SET merged_into = ${c}
        WHERE bioguide_id = ${a} AND merged_into IS NULL AND ${canonicalLive}`,
    );
    out.push(
      `INSERT INTO filer_identity_merges (alias_filer_id, canonical_filer_id, chamber, state, reason, merged_at)
       SELECT ${a}, f.bioguide_id, f.chamber, f.state, 'phantom-filer-alias', strftime('%Y-%m-%dT%H:%M:%fZ','now')
         FROM filers f
        WHERE f.bioguide_id = ${c}
          AND f.merged_into IS NULL
          AND EXISTS (SELECT 1 FROM filers AS phantom WHERE phantom.bioguide_id = ${a})
          AND NOT EXISTS (SELECT 1 FROM filer_identity_merges m WHERE m.alias_filer_id = ${a})`,
    );
  }
  return out;
}
