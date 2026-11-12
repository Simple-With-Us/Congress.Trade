-- 0083_filers_display_name.sql
-- Add filers.display_name — the member's "campaign sign" preferred public
-- name (e.g. "Bernie Moreno" not "Bernardo Moreno", "Ted Cruz" not "Rafael
-- Edward Cruz", "Mitch McConnell" not "A. Mitchell Jr. McConnell"), distinct
-- from full_name (which stays whatever the source disclosure literally
-- printed, including duplicated/legal/ERM-suffixed variants).
--
-- Populated by app/src/enrichment/identitySync.ts via
-- POST /api/admin/identity/sync: for filers resolved to a congress-legislators
-- bioguide, display_name = that legislator's official_full (fallback
-- "nickname + last"); for unresolved filers (executive branch, MANUAL-*
-- competitor injects, blank-name rows), display_name is a best-effort cleanup
-- of full_name (ERM/date/year noise stripped, honorifics dropped, "Last,
-- First" flipped, generational suffix casing normalized).
--
-- Mirrored idempotently in POST /api/admin/migrate via
-- src/admin/migrations.ts (FILERS_DISPLAY_NAME_SCHEMA_STATEMENTS).

ALTER TABLE filers ADD COLUMN display_name TEXT;
