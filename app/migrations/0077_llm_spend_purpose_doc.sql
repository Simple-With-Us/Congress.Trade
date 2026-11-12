-- 0077_llm_spend_purpose_doc.sql
-- Owner 2026-08-07: meter LLM spend by purpose + doc_id for per-doc caps and
-- honest "what did we spend money on" admin views.
--
-- purpose: free-text call site (extraction | agreement | benchmark | autopilot | …)
-- Index on doc_id supports SUM(usd) WHERE doc_id = ? for the per-doc ceiling.

ALTER TABLE llm_spend_settlements ADD COLUMN purpose TEXT;

CREATE INDEX IF NOT EXISTS idx_llm_spend_settlements_doc
  ON llm_spend_settlements (doc_id)
  WHERE doc_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_llm_spend_settlements_purpose_day
  ON llm_spend_settlements (purpose, day)
  WHERE purpose IS NOT NULL;
