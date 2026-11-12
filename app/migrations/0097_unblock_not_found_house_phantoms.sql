-- 0097_unblock_not_found_house_phantoms.sql
-- Cleanse 2026-07-30 sequential frontier-probe phantom rows that blocked official House filings
-- (e.g. Cisneros H-2026-20035190, Taylor H-2026-20035146, H-2026-20035392).

DELETE FROM ingestion_outbox
WHERE doc_id IN (
  SELECT doc_id FROM filings
  WHERE chamber = 'house'
    AND ingest_status = 'not_found'
    AND raw_object_key IS NULL
    AND (error LIKE '%phantom%' OR error LIKE '%scout frontier-probe%')
);

DELETE FROM filings
WHERE chamber = 'house'
  AND ingest_status = 'not_found'
  AND raw_object_key IS NULL
  AND (error LIKE '%phantom%' OR error LIKE '%scout frontier-probe%');
