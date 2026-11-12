-- 0078_filer_identity_merges.sql
-- Durable, reversible identity-merge support for `filers` rows whose
-- synthetic bioguide_id slug forked into multiple rows for the same real
-- member (e.g. "Michael T. McCaul" vs "Michael McCaul" — the House PTR index
-- sometimes carries a legal middle initial and sometimes doesn't, minting two
-- different `house-<district>-<name>` slugs — see ingestion/watcher.ts
-- houseFilerId/senateFilerId and shared/filerIdentityMatch.ts).
--
-- Rows are NEVER deleted here. An alias filer row is tombstoned via
-- merged_into (pointing at the surviving canonical bioguide_id) instead of
-- being removed, and filer_identity_merges keeps a durable, auditable
-- mapping of every alias -> canonical rewrite so the merge can be inspected
-- (or reversed) later. See admin/filerIdentityDedupe.ts for the routine that
-- populates these, run via POST /api/admin/dedupe-filer-identities.

ALTER TABLE filers ADD COLUMN merged_into TEXT;

CREATE INDEX IF NOT EXISTS idx_filers_merged_into ON filers (merged_into);

CREATE TABLE IF NOT EXISTS filer_identity_merges (
  alias_filer_id     TEXT PRIMARY KEY,
  canonical_filer_id TEXT NOT NULL,
  chamber             TEXT,
  state               TEXT,
  reason              TEXT NOT NULL DEFAULT 'name-normalization',
  merged_at           TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_filer_identity_merges_canonical
  ON filer_identity_merges (canonical_filer_id);
