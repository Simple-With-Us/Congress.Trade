-- Retraction signal (trade.retract).  Every time a live transaction is
-- deprecated (admin unpublish, reject, republish retirement, amendment
-- supersede, any other path) the trigger records one tx_retractions row and
-- one delivery_outbox event.
--
-- tx_retractions.seq is the retraction cursor served by
-- GET /api/transactions/retractions?since=<seq> and the SSE trade.retract
-- frames.  revived_at is set when a republish revives the row (it then takes
-- a new transactions.cursor_seq so pollers re-add it).  The second trigger
-- does both for every revive path: it allocates a fresh cursor_seq from
-- tx_cursor_seq unless the reviving UPDATE already moved it (the admin
-- republish bumps rows whose fields changed), and closes the retraction.
-- Rows deprecated before this migration have no retraction, so a
-- byte-identical revive of one keeps its cursor.  Rows the public feed never
-- serves (no filer, provider-missing placeholders, competitor-only executive
-- injects) get no retraction either, so their ids are never exposed.
--
-- POST /api/admin/migrate adds delivery_outbox.event_kind only when PRAGMA
-- table_info shows it missing (applyGuardedRetractionColumnMigrations); the
-- ALTER below then lands on the runner's duplicate-column skip.
--
-- delivery_outbox stays keyed by tx_id.  A retract event uses the key
-- 'retract:<seq>' with event_kind 'trade.retract', so it never collides with
-- the transaction's original 'trade.new' row (key = the bare tx id).  The
-- APNs fan-out joins outbox keys to transactions.id, so retract events never
-- produce a push.

CREATE TABLE IF NOT EXISTS tx_retractions (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  tx_id        TEXT NOT NULL,
  doc_id       TEXT NOT NULL,
  retracted_at TEXT NOT NULL,
  reason       TEXT,
  revived_at   TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_tx_retractions_tx ON tx_retractions (tx_id, revived_at);

CREATE INDEX IF NOT EXISTS idx_tx_retractions_created ON tx_retractions (created_at);

ALTER TABLE delivery_outbox ADD COLUMN event_kind TEXT NOT NULL DEFAULT 'trade.new';

CREATE TRIGGER IF NOT EXISTS trg_transactions_retract
AFTER UPDATE OF deprecated_at ON transactions
FOR EACH ROW
WHEN OLD.deprecated_at IS NULL AND NEW.deprecated_at IS NOT NULL
  -- Only rows the public feed could have served (buildTxFilters in
  -- delivery/rows.ts): never expose ids of hidden placeholder/competitor rows.
  AND NEW.filer_id IS NOT NULL
  AND SUBSTR(NEW.doc_id, 1, 17) != 'provider-missing-'
  AND NOT (NEW.source = 'competitor_backfill' AND NEW.filer_id LIKE 'EXEC-%' AND NEW.doc_id LIKE 'COMPETITOR%')
BEGIN
  INSERT INTO tx_retractions (tx_id, doc_id, retracted_at, reason)
  VALUES (NEW.id, NEW.doc_id, NEW.deprecated_at, NEW.deprecated_reason);
  INSERT OR IGNORE INTO delivery_outbox
    (tx_id, status, attempts, available_at, last_error, created_at, updated_at, event_kind)
  VALUES (
    'retract:' || (SELECT MAX(seq) FROM tx_retractions WHERE tx_id = NEW.id),
    'pending', 0,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    'trade.retract'
  );
END;

CREATE TRIGGER IF NOT EXISTS trg_transactions_unretract
AFTER UPDATE OF deprecated_at ON transactions
FOR EACH ROW
WHEN OLD.deprecated_at IS NOT NULL AND NEW.deprecated_at IS NULL
  AND EXISTS (SELECT 1 FROM tx_retractions WHERE tx_id = NEW.id AND revived_at IS NULL)
BEGIN
  INSERT INTO tx_cursor_seq (tx_id) SELECT NEW.id WHERE NEW.cursor_seq IS OLD.cursor_seq;
  UPDATE transactions
     SET cursor_seq = (SELECT MAX(seq) FROM tx_cursor_seq WHERE tx_id = NEW.id)
   WHERE id = NEW.id AND NEW.cursor_seq IS OLD.cursor_seq;
  UPDATE tx_retractions
     SET revived_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
   WHERE tx_id = NEW.id AND revived_at IS NULL;
END;
