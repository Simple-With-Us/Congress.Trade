-- 0105_filers_bioguide_lower_indexes.sql
-- CT-2418. Member identity lookups wrap the id column in LOWER() so a
-- caller-chosen case still resolves, but SQLite cannot use the TEXT PRIMARY KEY
-- (bioguide_id) or the plain resolved_bioguide_id index through a function call,
-- so both predicates degraded to `SCAN filers` over the whole table.
--
-- Expression indexes follow the existing 0075_filers_full_name_lower precedent:
-- one per wrapped column, named _lower to match.
--
-- Serves:
--   src/ui/routes.ts        LOWER(bioguide_id)          (?member= share card, every deep link)
--   src/client/queries.ts   LOWER(bioguide_id)          resolveMember (iOS member resolution)
--   src/client/queries.ts   LOWER(resolved_bioguide_id) resolveMember fallback

CREATE INDEX IF NOT EXISTS idx_filers_bioguide_lower ON filers (LOWER(bioguide_id));
CREATE INDEX IF NOT EXISTS idx_filers_resolved_bioguide_lower ON filers (LOWER(resolved_bioguide_id));