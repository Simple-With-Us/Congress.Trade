-- 0084_latency_probe_leases.sql
-- Mutual exclusion for disclosure-latency provider polling.
--
-- WHY: before this table the server/Mac handoff was a one-way *advisory* hint
-- (`needScout` in the latency-probe-health KV blob). The server never read it,
-- so once handoff opened both hosts polled the same provider — every duplicate
-- call is wasted spend against a shared free-tier quota.
--
-- WHY D1 AND NOT KV: Cloudflare KV is eventually consistent and has no
-- compare-and-set, so two acquirers can both read "free" and both write "mine".
-- SQLite gives us a real conditional upsert: a single
--   INSERT ... ON CONFLICT(provider) DO UPDATE ... WHERE <still-claimable>
-- statement runs in one implicit transaction, and `meta.changes` tells the
-- caller whether it won. Exactly one acquirer can observe changes=1. This is
-- the same primitive `acquireDenoCronSingleton` (deno/scheduledTick.ts) already
-- relies on in production for the tick lock.
--
-- The PRIMARY KEY on `provider` is the uniqueness constraint that makes the
-- upsert a contended write rather than two independent inserts.

CREATE TABLE IF NOT EXISTS latency_probe_leases (
  -- One lane per provider id ('fmp' | 'fmp_rapidapi' | 'unusual_whales' | 'quiver').
  provider          TEXT PRIMARY KEY,
  -- 'server' (Deno cron, preferred) or 'mac' (residential scout).
  holder            TEXT NOT NULL,
  -- Instance token. Renewal requires holder AND holder_id to match, so a
  -- restarted process waits out the TTL instead of stealing from its old self.
  holder_id         TEXT NOT NULL,
  acquired_at       TEXT NOT NULL,
  -- Epoch ms. Self-expiring: a crashed holder frees the lane at this instant,
  -- so a crash can never stop polling forever.
  expires_at        INTEGER NOT NULL,
  -- Epoch ms when the CURRENT holder's tenure began. Survives renewals; resets
  -- on takeover. Bounds how long the Mac may keep a lane before the server
  -- reclaims it (owner: the server must come back when it can).
  tenure_started_at INTEGER NOT NULL,
  -- Human-readable why, surfaced by GET /api/ingest/probe-leases.
  reason            TEXT,
  renewals          INTEGER NOT NULL DEFAULT 0,
  updated_at        TEXT NOT NULL
);

-- Operator view: "who is holding a lane right now, and until when".
CREATE INDEX IF NOT EXISTS idx_latency_probe_leases_expires
  ON latency_probe_leases (expires_at DESC);
