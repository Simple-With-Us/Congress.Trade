-- 0110_phantom_filer_aliases.sql
-- CT-1362 / CT-1360. Re-point known MANUAL-* phantom filers onto the roster
-- or EXEC id. Idempotent: a missing canonical row changes nothing, and a
-- second run finds the trades already moved. Source rows are tombstoned
-- (merged_into), never deleted. Chamber and party are not rewritten.
-- Generated from app/src/shared/phantomFilerAliases.ts.

UPDATE transactions
          SET deprecated_at = COALESCE(deprecated_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
              deprecated_reason = COALESCE(deprecated_reason, 'phantom-filer-alias-duplicate')
        WHERE filer_id = 'MANUAL-WRIGHT'
          AND deprecated_at IS NULL
          AND row_key IS NOT NULL
          AND EXISTS (SELECT 1 FROM filers WHERE bioguide_id = 'EXEC-CWRIGHT' AND merged_into IS NULL)
          AND EXISTS (
            SELECT 1 FROM transactions AS canon
             WHERE canon.filer_id = 'EXEC-CWRIGHT'
               AND canon.doc_id = transactions.doc_id
               AND canon.source IS transactions.source
               AND canon.row_key = transactions.row_key
               AND canon.deprecated_at IS NULL
          );

UPDATE transactions
          SET filer_id = 'EXEC-CWRIGHT'
        WHERE filer_id = 'MANUAL-WRIGHT'
          AND deprecated_at IS NULL
          AND EXISTS (SELECT 1 FROM filers WHERE bioguide_id = 'EXEC-CWRIGHT' AND merged_into IS NULL)
          AND NOT EXISTS (
            SELECT 1 FROM transactions AS canon
             WHERE canon.filer_id = 'EXEC-CWRIGHT'
               AND canon.doc_id = transactions.doc_id
               AND canon.source IS transactions.source
               AND canon.row_key IS NOT NULL
               AND canon.row_key = transactions.row_key
               AND transactions.row_key IS NOT NULL
               AND canon.deprecated_at IS NULL
          );

UPDATE filings SET filer_id = 'EXEC-CWRIGHT' WHERE filer_id = 'MANUAL-WRIGHT' AND EXISTS (SELECT 1 FROM filers WHERE bioguide_id = 'EXEC-CWRIGHT' AND merged_into IS NULL);

UPDATE filers SET merged_into = 'EXEC-CWRIGHT'
        WHERE bioguide_id = 'MANUAL-WRIGHT' AND merged_into IS NULL AND EXISTS (SELECT 1 FROM filers WHERE bioguide_id = 'EXEC-CWRIGHT' AND merged_into IS NULL);

INSERT INTO filer_identity_merges (alias_filer_id, canonical_filer_id, chamber, state, reason, merged_at)
       SELECT 'MANUAL-WRIGHT', f.bioguide_id, f.chamber, f.state, 'phantom-filer-alias', strftime('%Y-%m-%dT%H:%M:%fZ','now')
         FROM filers f
        WHERE f.bioguide_id = 'EXEC-CWRIGHT'
          AND f.merged_into IS NULL
          AND EXISTS (SELECT 1 FROM filers AS phantom WHERE phantom.bioguide_id = 'MANUAL-WRIGHT')
          AND NOT EXISTS (SELECT 1 FROM filer_identity_merges m WHERE m.alias_filer_id = 'MANUAL-WRIGHT');

UPDATE transactions
          SET deprecated_at = COALESCE(deprecated_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
              deprecated_reason = COALESCE(deprecated_reason, 'phantom-filer-alias-duplicate')
        WHERE filer_id = 'MANUAL-BURGUM'
          AND deprecated_at IS NULL
          AND row_key IS NOT NULL
          AND EXISTS (SELECT 1 FROM filers WHERE bioguide_id = 'EXEC-DOUGLAS-J-BURGUM' AND merged_into IS NULL)
          AND EXISTS (
            SELECT 1 FROM transactions AS canon
             WHERE canon.filer_id = 'EXEC-DOUGLAS-J-BURGUM'
               AND canon.doc_id = transactions.doc_id
               AND canon.source IS transactions.source
               AND canon.row_key = transactions.row_key
               AND canon.deprecated_at IS NULL
          );

UPDATE transactions
          SET filer_id = 'EXEC-DOUGLAS-J-BURGUM'
        WHERE filer_id = 'MANUAL-BURGUM'
          AND deprecated_at IS NULL
          AND EXISTS (SELECT 1 FROM filers WHERE bioguide_id = 'EXEC-DOUGLAS-J-BURGUM' AND merged_into IS NULL)
          AND NOT EXISTS (
            SELECT 1 FROM transactions AS canon
             WHERE canon.filer_id = 'EXEC-DOUGLAS-J-BURGUM'
               AND canon.doc_id = transactions.doc_id
               AND canon.source IS transactions.source
               AND canon.row_key IS NOT NULL
               AND canon.row_key = transactions.row_key
               AND transactions.row_key IS NOT NULL
               AND canon.deprecated_at IS NULL
          );

UPDATE filings SET filer_id = 'EXEC-DOUGLAS-J-BURGUM' WHERE filer_id = 'MANUAL-BURGUM' AND EXISTS (SELECT 1 FROM filers WHERE bioguide_id = 'EXEC-DOUGLAS-J-BURGUM' AND merged_into IS NULL);

UPDATE filers SET merged_into = 'EXEC-DOUGLAS-J-BURGUM'
        WHERE bioguide_id = 'MANUAL-BURGUM' AND merged_into IS NULL AND EXISTS (SELECT 1 FROM filers WHERE bioguide_id = 'EXEC-DOUGLAS-J-BURGUM' AND merged_into IS NULL);

INSERT INTO filer_identity_merges (alias_filer_id, canonical_filer_id, chamber, state, reason, merged_at)
       SELECT 'MANUAL-BURGUM', f.bioguide_id, f.chamber, f.state, 'phantom-filer-alias', strftime('%Y-%m-%dT%H:%M:%fZ','now')
         FROM filers f
        WHERE f.bioguide_id = 'EXEC-DOUGLAS-J-BURGUM'
          AND f.merged_into IS NULL
          AND EXISTS (SELECT 1 FROM filers AS phantom WHERE phantom.bioguide_id = 'MANUAL-BURGUM')
          AND NOT EXISTS (SELECT 1 FROM filer_identity_merges m WHERE m.alias_filer_id = 'MANUAL-BURGUM');

UPDATE transactions
          SET deprecated_at = COALESCE(deprecated_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
              deprecated_reason = COALESCE(deprecated_reason, 'phantom-filer-alias-duplicate')
        WHERE filer_id = 'MANUAL-KRATSIOS'
          AND deprecated_at IS NULL
          AND row_key IS NOT NULL
          AND EXISTS (SELECT 1 FROM filers WHERE bioguide_id = 'EXEC-MICHAEL-J-KRATSIOS' AND merged_into IS NULL)
          AND EXISTS (
            SELECT 1 FROM transactions AS canon
             WHERE canon.filer_id = 'EXEC-MICHAEL-J-KRATSIOS'
               AND canon.doc_id = transactions.doc_id
               AND canon.source IS transactions.source
               AND canon.row_key = transactions.row_key
               AND canon.deprecated_at IS NULL
          );

UPDATE transactions
          SET filer_id = 'EXEC-MICHAEL-J-KRATSIOS'
        WHERE filer_id = 'MANUAL-KRATSIOS'
          AND deprecated_at IS NULL
          AND EXISTS (SELECT 1 FROM filers WHERE bioguide_id = 'EXEC-MICHAEL-J-KRATSIOS' AND merged_into IS NULL)
          AND NOT EXISTS (
            SELECT 1 FROM transactions AS canon
             WHERE canon.filer_id = 'EXEC-MICHAEL-J-KRATSIOS'
               AND canon.doc_id = transactions.doc_id
               AND canon.source IS transactions.source
               AND canon.row_key IS NOT NULL
               AND canon.row_key = transactions.row_key
               AND transactions.row_key IS NOT NULL
               AND canon.deprecated_at IS NULL
          );

UPDATE filings SET filer_id = 'EXEC-MICHAEL-J-KRATSIOS' WHERE filer_id = 'MANUAL-KRATSIOS' AND EXISTS (SELECT 1 FROM filers WHERE bioguide_id = 'EXEC-MICHAEL-J-KRATSIOS' AND merged_into IS NULL);

UPDATE filers SET merged_into = 'EXEC-MICHAEL-J-KRATSIOS'
        WHERE bioguide_id = 'MANUAL-KRATSIOS' AND merged_into IS NULL AND EXISTS (SELECT 1 FROM filers WHERE bioguide_id = 'EXEC-MICHAEL-J-KRATSIOS' AND merged_into IS NULL);

INSERT INTO filer_identity_merges (alias_filer_id, canonical_filer_id, chamber, state, reason, merged_at)
       SELECT 'MANUAL-KRATSIOS', f.bioguide_id, f.chamber, f.state, 'phantom-filer-alias', strftime('%Y-%m-%dT%H:%M:%fZ','now')
         FROM filers f
        WHERE f.bioguide_id = 'EXEC-MICHAEL-J-KRATSIOS'
          AND f.merged_into IS NULL
          AND EXISTS (SELECT 1 FROM filers AS phantom WHERE phantom.bioguide_id = 'MANUAL-KRATSIOS')
          AND NOT EXISTS (SELECT 1 FROM filer_identity_merges m WHERE m.alias_filer_id = 'MANUAL-KRATSIOS');

UPDATE transactions
          SET deprecated_at = COALESCE(deprecated_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
              deprecated_reason = COALESCE(deprecated_reason, 'phantom-filer-alias-duplicate')
        WHERE filer_id = 'MANUAL-BISIGNANO'
          AND deprecated_at IS NULL
          AND row_key IS NOT NULL
          AND EXISTS (SELECT 1 FROM filers WHERE bioguide_id = 'EXEC-FRANK-J-BISIGNANO' AND merged_into IS NULL)
          AND EXISTS (
            SELECT 1 FROM transactions AS canon
             WHERE canon.filer_id = 'EXEC-FRANK-J-BISIGNANO'
               AND canon.doc_id = transactions.doc_id
               AND canon.source IS transactions.source
               AND canon.row_key = transactions.row_key
               AND canon.deprecated_at IS NULL
          );

UPDATE transactions
          SET filer_id = 'EXEC-FRANK-J-BISIGNANO'
        WHERE filer_id = 'MANUAL-BISIGNANO'
          AND deprecated_at IS NULL
          AND EXISTS (SELECT 1 FROM filers WHERE bioguide_id = 'EXEC-FRANK-J-BISIGNANO' AND merged_into IS NULL)
          AND NOT EXISTS (
            SELECT 1 FROM transactions AS canon
             WHERE canon.filer_id = 'EXEC-FRANK-J-BISIGNANO'
               AND canon.doc_id = transactions.doc_id
               AND canon.source IS transactions.source
               AND canon.row_key IS NOT NULL
               AND canon.row_key = transactions.row_key
               AND transactions.row_key IS NOT NULL
               AND canon.deprecated_at IS NULL
          );

UPDATE filings SET filer_id = 'EXEC-FRANK-J-BISIGNANO' WHERE filer_id = 'MANUAL-BISIGNANO' AND EXISTS (SELECT 1 FROM filers WHERE bioguide_id = 'EXEC-FRANK-J-BISIGNANO' AND merged_into IS NULL);

UPDATE filers SET merged_into = 'EXEC-FRANK-J-BISIGNANO'
        WHERE bioguide_id = 'MANUAL-BISIGNANO' AND merged_into IS NULL AND EXISTS (SELECT 1 FROM filers WHERE bioguide_id = 'EXEC-FRANK-J-BISIGNANO' AND merged_into IS NULL);

INSERT INTO filer_identity_merges (alias_filer_id, canonical_filer_id, chamber, state, reason, merged_at)
       SELECT 'MANUAL-BISIGNANO', f.bioguide_id, f.chamber, f.state, 'phantom-filer-alias', strftime('%Y-%m-%dT%H:%M:%fZ','now')
         FROM filers f
        WHERE f.bioguide_id = 'EXEC-FRANK-J-BISIGNANO'
          AND f.merged_into IS NULL
          AND EXISTS (SELECT 1 FROM filers AS phantom WHERE phantom.bioguide_id = 'MANUAL-BISIGNANO')
          AND NOT EXISTS (SELECT 1 FROM filer_identity_merges m WHERE m.alias_filer_id = 'MANUAL-BISIGNANO');

UPDATE transactions
          SET deprecated_at = COALESCE(deprecated_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
              deprecated_reason = COALESCE(deprecated_reason, 'phantom-filer-alias-duplicate')
        WHERE filer_id = 'MANUAL-BAILEY'
          AND deprecated_at IS NULL
          AND row_key IS NOT NULL
          AND EXISTS (SELECT 1 FROM filers WHERE bioguide_id = 'EXEC-SARA-BAILEY' AND merged_into IS NULL)
          AND EXISTS (
            SELECT 1 FROM transactions AS canon
             WHERE canon.filer_id = 'EXEC-SARA-BAILEY'
               AND canon.doc_id = transactions.doc_id
               AND canon.source IS transactions.source
               AND canon.row_key = transactions.row_key
               AND canon.deprecated_at IS NULL
          );

UPDATE transactions
          SET filer_id = 'EXEC-SARA-BAILEY'
        WHERE filer_id = 'MANUAL-BAILEY'
          AND deprecated_at IS NULL
          AND EXISTS (SELECT 1 FROM filers WHERE bioguide_id = 'EXEC-SARA-BAILEY' AND merged_into IS NULL)
          AND NOT EXISTS (
            SELECT 1 FROM transactions AS canon
             WHERE canon.filer_id = 'EXEC-SARA-BAILEY'
               AND canon.doc_id = transactions.doc_id
               AND canon.source IS transactions.source
               AND canon.row_key IS NOT NULL
               AND canon.row_key = transactions.row_key
               AND transactions.row_key IS NOT NULL
               AND canon.deprecated_at IS NULL
          );

UPDATE filings SET filer_id = 'EXEC-SARA-BAILEY' WHERE filer_id = 'MANUAL-BAILEY' AND EXISTS (SELECT 1 FROM filers WHERE bioguide_id = 'EXEC-SARA-BAILEY' AND merged_into IS NULL);

UPDATE filers SET merged_into = 'EXEC-SARA-BAILEY'
        WHERE bioguide_id = 'MANUAL-BAILEY' AND merged_into IS NULL AND EXISTS (SELECT 1 FROM filers WHERE bioguide_id = 'EXEC-SARA-BAILEY' AND merged_into IS NULL);

INSERT INTO filer_identity_merges (alias_filer_id, canonical_filer_id, chamber, state, reason, merged_at)
       SELECT 'MANUAL-BAILEY', f.bioguide_id, f.chamber, f.state, 'phantom-filer-alias', strftime('%Y-%m-%dT%H:%M:%fZ','now')
         FROM filers f
        WHERE f.bioguide_id = 'EXEC-SARA-BAILEY'
          AND f.merged_into IS NULL
          AND EXISTS (SELECT 1 FROM filers AS phantom WHERE phantom.bioguide_id = 'MANUAL-BAILEY')
          AND NOT EXISTS (SELECT 1 FROM filer_identity_merges m WHERE m.alias_filer_id = 'MANUAL-BAILEY');

UPDATE transactions
          SET deprecated_at = COALESCE(deprecated_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
              deprecated_reason = COALESCE(deprecated_reason, 'phantom-filer-alias-duplicate')
        WHERE filer_id = 'MANUAL-KUPOR'
          AND deprecated_at IS NULL
          AND row_key IS NOT NULL
          AND EXISTS (SELECT 1 FROM filers WHERE bioguide_id = 'EXEC-SCOTT-A-KUPOR' AND merged_into IS NULL)
          AND EXISTS (
            SELECT 1 FROM transactions AS canon
             WHERE canon.filer_id = 'EXEC-SCOTT-A-KUPOR'
               AND canon.doc_id = transactions.doc_id
               AND canon.source IS transactions.source
               AND canon.row_key = transactions.row_key
               AND canon.deprecated_at IS NULL
          );

UPDATE transactions
          SET filer_id = 'EXEC-SCOTT-A-KUPOR'
        WHERE filer_id = 'MANUAL-KUPOR'
          AND deprecated_at IS NULL
          AND EXISTS (SELECT 1 FROM filers WHERE bioguide_id = 'EXEC-SCOTT-A-KUPOR' AND merged_into IS NULL)
          AND NOT EXISTS (
            SELECT 1 FROM transactions AS canon
             WHERE canon.filer_id = 'EXEC-SCOTT-A-KUPOR'
               AND canon.doc_id = transactions.doc_id
               AND canon.source IS transactions.source
               AND canon.row_key IS NOT NULL
               AND canon.row_key = transactions.row_key
               AND transactions.row_key IS NOT NULL
               AND canon.deprecated_at IS NULL
          );

UPDATE filings SET filer_id = 'EXEC-SCOTT-A-KUPOR' WHERE filer_id = 'MANUAL-KUPOR' AND EXISTS (SELECT 1 FROM filers WHERE bioguide_id = 'EXEC-SCOTT-A-KUPOR' AND merged_into IS NULL);

UPDATE filers SET merged_into = 'EXEC-SCOTT-A-KUPOR'
        WHERE bioguide_id = 'MANUAL-KUPOR' AND merged_into IS NULL AND EXISTS (SELECT 1 FROM filers WHERE bioguide_id = 'EXEC-SCOTT-A-KUPOR' AND merged_into IS NULL);

INSERT INTO filer_identity_merges (alias_filer_id, canonical_filer_id, chamber, state, reason, merged_at)
       SELECT 'MANUAL-KUPOR', f.bioguide_id, f.chamber, f.state, 'phantom-filer-alias', strftime('%Y-%m-%dT%H:%M:%fZ','now')
         FROM filers f
        WHERE f.bioguide_id = 'EXEC-SCOTT-A-KUPOR'
          AND f.merged_into IS NULL
          AND EXISTS (SELECT 1 FROM filers AS phantom WHERE phantom.bioguide_id = 'MANUAL-KUPOR')
          AND NOT EXISTS (SELECT 1 FROM filer_identity_merges m WHERE m.alias_filer_id = 'MANUAL-KUPOR');

UPDATE transactions
          SET deprecated_at = COALESCE(deprecated_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
              deprecated_reason = COALESCE(deprecated_reason, 'phantom-filer-alias-duplicate')
        WHERE filer_id = 'MANUAL-KEAN'
          AND deprecated_at IS NULL
          AND row_key IS NOT NULL
          AND EXISTS (SELECT 1 FROM filers WHERE bioguide_id = 'house-nj07-thomas-h-kean' AND merged_into IS NULL)
          AND EXISTS (
            SELECT 1 FROM transactions AS canon
             WHERE canon.filer_id = 'house-nj07-thomas-h-kean'
               AND canon.doc_id = transactions.doc_id
               AND canon.source IS transactions.source
               AND canon.row_key = transactions.row_key
               AND canon.deprecated_at IS NULL
          );

UPDATE transactions
          SET filer_id = 'house-nj07-thomas-h-kean'
        WHERE filer_id = 'MANUAL-KEAN'
          AND deprecated_at IS NULL
          AND EXISTS (SELECT 1 FROM filers WHERE bioguide_id = 'house-nj07-thomas-h-kean' AND merged_into IS NULL)
          AND NOT EXISTS (
            SELECT 1 FROM transactions AS canon
             WHERE canon.filer_id = 'house-nj07-thomas-h-kean'
               AND canon.doc_id = transactions.doc_id
               AND canon.source IS transactions.source
               AND canon.row_key IS NOT NULL
               AND canon.row_key = transactions.row_key
               AND transactions.row_key IS NOT NULL
               AND canon.deprecated_at IS NULL
          );

UPDATE filings SET filer_id = 'house-nj07-thomas-h-kean' WHERE filer_id = 'MANUAL-KEAN' AND EXISTS (SELECT 1 FROM filers WHERE bioguide_id = 'house-nj07-thomas-h-kean' AND merged_into IS NULL);

UPDATE filers SET merged_into = 'house-nj07-thomas-h-kean'
        WHERE bioguide_id = 'MANUAL-KEAN' AND merged_into IS NULL AND EXISTS (SELECT 1 FROM filers WHERE bioguide_id = 'house-nj07-thomas-h-kean' AND merged_into IS NULL);

INSERT INTO filer_identity_merges (alias_filer_id, canonical_filer_id, chamber, state, reason, merged_at)
       SELECT 'MANUAL-KEAN', f.bioguide_id, f.chamber, f.state, 'phantom-filer-alias', strftime('%Y-%m-%dT%H:%M:%fZ','now')
         FROM filers f
        WHERE f.bioguide_id = 'house-nj07-thomas-h-kean'
          AND f.merged_into IS NULL
          AND EXISTS (SELECT 1 FROM filers AS phantom WHERE phantom.bioguide_id = 'MANUAL-KEAN')
          AND NOT EXISTS (SELECT 1 FROM filer_identity_merges m WHERE m.alias_filer_id = 'MANUAL-KEAN');

UPDATE transactions
          SET deprecated_at = COALESCE(deprecated_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
              deprecated_reason = COALESCE(deprecated_reason, 'phantom-filer-alias-duplicate')
        WHERE filer_id = 'MANUAL-STAUBER'
          AND deprecated_at IS NULL
          AND row_key IS NOT NULL
          AND EXISTS (SELECT 1 FROM filers WHERE bioguide_id = 'house-mn08-peter-allen-stauber' AND merged_into IS NULL)
          AND EXISTS (
            SELECT 1 FROM transactions AS canon
             WHERE canon.filer_id = 'house-mn08-peter-allen-stauber'
               AND canon.doc_id = transactions.doc_id
               AND canon.source IS transactions.source
               AND canon.row_key = transactions.row_key
               AND canon.deprecated_at IS NULL
          );

UPDATE transactions
          SET filer_id = 'house-mn08-peter-allen-stauber'
        WHERE filer_id = 'MANUAL-STAUBER'
          AND deprecated_at IS NULL
          AND EXISTS (SELECT 1 FROM filers WHERE bioguide_id = 'house-mn08-peter-allen-stauber' AND merged_into IS NULL)
          AND NOT EXISTS (
            SELECT 1 FROM transactions AS canon
             WHERE canon.filer_id = 'house-mn08-peter-allen-stauber'
               AND canon.doc_id = transactions.doc_id
               AND canon.source IS transactions.source
               AND canon.row_key IS NOT NULL
               AND canon.row_key = transactions.row_key
               AND transactions.row_key IS NOT NULL
               AND canon.deprecated_at IS NULL
          );

UPDATE filings SET filer_id = 'house-mn08-peter-allen-stauber' WHERE filer_id = 'MANUAL-STAUBER' AND EXISTS (SELECT 1 FROM filers WHERE bioguide_id = 'house-mn08-peter-allen-stauber' AND merged_into IS NULL);

UPDATE filers SET merged_into = 'house-mn08-peter-allen-stauber'
        WHERE bioguide_id = 'MANUAL-STAUBER' AND merged_into IS NULL AND EXISTS (SELECT 1 FROM filers WHERE bioguide_id = 'house-mn08-peter-allen-stauber' AND merged_into IS NULL);

INSERT INTO filer_identity_merges (alias_filer_id, canonical_filer_id, chamber, state, reason, merged_at)
       SELECT 'MANUAL-STAUBER', f.bioguide_id, f.chamber, f.state, 'phantom-filer-alias', strftime('%Y-%m-%dT%H:%M:%fZ','now')
         FROM filers f
        WHERE f.bioguide_id = 'house-mn08-peter-allen-stauber'
          AND f.merged_into IS NULL
          AND EXISTS (SELECT 1 FROM filers AS phantom WHERE phantom.bioguide_id = 'MANUAL-STAUBER')
          AND NOT EXISTS (SELECT 1 FROM filer_identity_merges m WHERE m.alias_filer_id = 'MANUAL-STAUBER');

UPDATE transactions
          SET deprecated_at = COALESCE(deprecated_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
              deprecated_reason = COALESCE(deprecated_reason, 'phantom-filer-alias-duplicate')
        WHERE filer_id = 'MANUAL-ELVIRA'
          AND deprecated_at IS NULL
          AND row_key IS NOT NULL
          AND EXISTS (SELECT 1 FROM filers WHERE bioguide_id = 'house-fl27-maria-elvira-salazar' AND merged_into IS NULL)
          AND EXISTS (
            SELECT 1 FROM transactions AS canon
             WHERE canon.filer_id = 'house-fl27-maria-elvira-salazar'
               AND canon.doc_id = transactions.doc_id
               AND canon.source IS transactions.source
               AND canon.row_key = transactions.row_key
               AND canon.deprecated_at IS NULL
          );

UPDATE transactions
          SET filer_id = 'house-fl27-maria-elvira-salazar'
        WHERE filer_id = 'MANUAL-ELVIRA'
          AND deprecated_at IS NULL
          AND EXISTS (SELECT 1 FROM filers WHERE bioguide_id = 'house-fl27-maria-elvira-salazar' AND merged_into IS NULL)
          AND NOT EXISTS (
            SELECT 1 FROM transactions AS canon
             WHERE canon.filer_id = 'house-fl27-maria-elvira-salazar'
               AND canon.doc_id = transactions.doc_id
               AND canon.source IS transactions.source
               AND canon.row_key IS NOT NULL
               AND canon.row_key = transactions.row_key
               AND transactions.row_key IS NOT NULL
               AND canon.deprecated_at IS NULL
          );

UPDATE filings SET filer_id = 'house-fl27-maria-elvira-salazar' WHERE filer_id = 'MANUAL-ELVIRA' AND EXISTS (SELECT 1 FROM filers WHERE bioguide_id = 'house-fl27-maria-elvira-salazar' AND merged_into IS NULL);

UPDATE filers SET merged_into = 'house-fl27-maria-elvira-salazar'
        WHERE bioguide_id = 'MANUAL-ELVIRA' AND merged_into IS NULL AND EXISTS (SELECT 1 FROM filers WHERE bioguide_id = 'house-fl27-maria-elvira-salazar' AND merged_into IS NULL);

INSERT INTO filer_identity_merges (alias_filer_id, canonical_filer_id, chamber, state, reason, merged_at)
       SELECT 'MANUAL-ELVIRA', f.bioguide_id, f.chamber, f.state, 'phantom-filer-alias', strftime('%Y-%m-%dT%H:%M:%fZ','now')
         FROM filers f
        WHERE f.bioguide_id = 'house-fl27-maria-elvira-salazar'
          AND f.merged_into IS NULL
          AND EXISTS (SELECT 1 FROM filers AS phantom WHERE phantom.bioguide_id = 'MANUAL-ELVIRA')
          AND NOT EXISTS (SELECT 1 FROM filer_identity_merges m WHERE m.alias_filer_id = 'MANUAL-ELVIRA');

UPDATE transactions
          SET deprecated_at = COALESCE(deprecated_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
              deprecated_reason = COALESCE(deprecated_reason, 'phantom-filer-alias-duplicate')
        WHERE filer_id = 'MANUAL-DELANEY'
          AND deprecated_at IS NULL
          AND row_key IS NOT NULL
          AND EXISTS (SELECT 1 FROM filers WHERE bioguide_id = 'house-md06-april-mcclain-delaney' AND merged_into IS NULL)
          AND EXISTS (
            SELECT 1 FROM transactions AS canon
             WHERE canon.filer_id = 'house-md06-april-mcclain-delaney'
               AND canon.doc_id = transactions.doc_id
               AND canon.source IS transactions.source
               AND canon.row_key = transactions.row_key
               AND canon.deprecated_at IS NULL
          );

UPDATE transactions
          SET filer_id = 'house-md06-april-mcclain-delaney'
        WHERE filer_id = 'MANUAL-DELANEY'
          AND deprecated_at IS NULL
          AND EXISTS (SELECT 1 FROM filers WHERE bioguide_id = 'house-md06-april-mcclain-delaney' AND merged_into IS NULL)
          AND NOT EXISTS (
            SELECT 1 FROM transactions AS canon
             WHERE canon.filer_id = 'house-md06-april-mcclain-delaney'
               AND canon.doc_id = transactions.doc_id
               AND canon.source IS transactions.source
               AND canon.row_key IS NOT NULL
               AND canon.row_key = transactions.row_key
               AND transactions.row_key IS NOT NULL
               AND canon.deprecated_at IS NULL
          );

UPDATE filings SET filer_id = 'house-md06-april-mcclain-delaney' WHERE filer_id = 'MANUAL-DELANEY' AND EXISTS (SELECT 1 FROM filers WHERE bioguide_id = 'house-md06-april-mcclain-delaney' AND merged_into IS NULL);

UPDATE filers SET merged_into = 'house-md06-april-mcclain-delaney'
        WHERE bioguide_id = 'MANUAL-DELANEY' AND merged_into IS NULL AND EXISTS (SELECT 1 FROM filers WHERE bioguide_id = 'house-md06-april-mcclain-delaney' AND merged_into IS NULL);

INSERT INTO filer_identity_merges (alias_filer_id, canonical_filer_id, chamber, state, reason, merged_at)
       SELECT 'MANUAL-DELANEY', f.bioguide_id, f.chamber, f.state, 'phantom-filer-alias', strftime('%Y-%m-%dT%H:%M:%fZ','now')
         FROM filers f
        WHERE f.bioguide_id = 'house-md06-april-mcclain-delaney'
          AND f.merged_into IS NULL
          AND EXISTS (SELECT 1 FROM filers AS phantom WHERE phantom.bioguide_id = 'MANUAL-DELANEY')
          AND NOT EXISTS (SELECT 1 FROM filer_identity_merges m WHERE m.alias_filer_id = 'MANUAL-DELANEY');
