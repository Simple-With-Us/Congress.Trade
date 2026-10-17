-- Which discovery path first surfaced a House filing: 'live' (intraday
-- live-search) or 'bulk' (daily bulk index).  NULL for non-House sources and
-- for rows inserted before this migration.  Feeds the stale bulk-discovery
-- alert in ingestion/watcher.ts.
-- (0105 is reserved for 0105_filers_bioguide_lower_indexes.sql, open PR #2775.)

ALTER TABLE filings ADD COLUMN discovered_via TEXT;
