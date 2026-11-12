# 2026-08-05 — Congress.Trade R2 Class A emergency pause [GROK]

## Context & objective

CT R2 Class A was **~410k / 1M MTD (~41%)** with pace **~256%** of free tier.
Storage ~8.5 GiB (absolute over 70%). Owner priority: stay on free tier.

## Root cause

Litestream 0.5 L0 **PutObject per SQLite TXID**. Host journal showed continuous
~4 LTX uploads/sec (~975/hour) even with `sync-interval: 5m`. Sync interval does
not collapse L0 object count under write-heavy load.

Class A MTD mix: PutObject ~256k, ListObjects ~137k, DeleteObjects ~15k.

Bucket live inventory (~7.95 GiB / 25.7k objects):

| Prefix | ~GiB |
|--------|------|
| `congress-trade/db.sqlite` (litestream LTX) | 6.84 |
| `bulk/2026-08-04` … `08-02` | ~0.85 |
| `historical-dumps/` | 0.09 |
| `_ops/usage-telemetry` | 0.01 |
| `raw/` filings | small |

## Change (host, immediate)

```text
systemctl stop litestream-congress
systemctl disable litestream-congress
# marker: /etc/litestream/congress-r2-paused.flag
# config parked: sync-interval 30m, snapshot.retention 24h for future resume
```

**App request path unchanged.** Only off-site PITR is paused; SQLite on the
local volume continues.

## Resume (operator)

1. Confirm Class A remaining headroom (or wait for month rollover).
2. Prefer app write batching before re-enabling continuous L0 spam.
3. `sudo systemctl enable --now litestream-congress`
4. Verify: `journalctl -u litestream-congress -n 20` shows low LTX rate.

## Labels

Canonical display name is **Congress.Trade** (period, no space) — fixed in
Usage Monitor fleet card companion PR.
