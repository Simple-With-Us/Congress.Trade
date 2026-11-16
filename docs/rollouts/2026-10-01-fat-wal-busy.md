# Fat-WAL / SQLITE_BUSY durable fix (CONGRESS-TRADE-1M)

## Summary

On 2026-10-01 house/senate polling went dark ~15–16h after a fat WAL (~235MB) and `SQLITE_BUSY` storm (CONGRESS-TRADE-1M / sibling 1J; same class as the 2026-09-29 ~500MB truncate storm). PR #2600 correctly skips the cron tick while the lock is held; that made the skip the steady state until an emergency stop + `wal_checkpoint(TRUNCATE)`.

Root cause: `@libsql/client` 0.18 pools `file:` DBs at concurrency 20 with `busy_timeout` 0 unless `timeout` is set, so boot pragmas on one connection left the rest failing busy immediately and pinning a second read snapshot. Litestream **0.5.13** (pin unchanged) holds a long read transaction; at default `truncate-page-n` (~500MB) it runs blocking `wal_checkpoint(TRUNCATE)`. On this pin, `truncate-page-n: 0` disables that checkpoint so writers are not starved.

This rollout sets file clients to `concurrency: 1` + `timeout: 10000`, runs boot pragmas through one `executeMultiple`, and updates `app/litestream.yml` to `truncate-page-n: 0`, `busy-timeout: 5s`, `checkpoint-interval: 30s`, `min-checkpoint-page-count: 1000` (PASSIVE checkpoints stay on).

## Files changed

- `app/` libsql file-client construction + boot pragmas (`concurrency: 1`, `timeout: 10000`, single `executeMultiple`)
- `app/litestream.yml` — `truncate-page-n: 0`, shorter busy/checkpoint intervals (read at container start)
- Tests covering file vs remote client options, pragma script, 0.5.13 pin, litestream keys, busy tick skip
- Effort log + this rollout note

## Verification

- Local: `deno check src/deno/main.ts`; targeted vitest (sqliteClient / pipelineRobustification / scheduledTick) — 28 tests green before open
- CI: required `typecheck + test` + `gitleaks` green on tip
- After Coolify auto-deploy picks up the tip: confirm `/api/health/polling` ok for all chambers; WAL size stays modest under load; no sustained `SQLITE_BUSY` tick skips
- Confirm running Litestream binary is still **0.5.13** (`scripts/fetch-litestream.sh` pin / tag `0a2a39f`)

## Follow-ups

- Do **not** bump Litestream off 0.5.13 without re-reading `truncate-page-n: 0` semantics (post-0.5.13, `0` may mean “keep the default” ~500MB TRUNCATE)
- Do not add an app-side `wal_checkpoint` or set `wal_autocheckpoint=0`
- Do not wrap every write in `withSqliteLockRetry` on top of the 10s busy timeout
- sqlite-web is unchanged (separate process can still hold a snapshot); concurrency 1 only covers the app
- #2600 tick-skip stays as defense; this PR should keep it from being the steady state

PR: https://github.com/jaywedgeworth22/Congress.Trade/pull/2603
