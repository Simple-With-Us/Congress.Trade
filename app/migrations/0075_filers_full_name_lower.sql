-- Speeds memberName → filer_id resolution (resolveMemberFilerId) so the feed
-- can filter on indexed transactions.filer_id instead of full-corpus LIKE.
CREATE INDEX IF NOT EXISTS idx_filers_full_name_lower ON filers (LOWER(full_name));
