# 2026-08-09 — Off-host backups live: B2 primary + weekly R2 (fleet)

Post-Oracle-decommission, fleet backups were LOCAL-ONLY (same disk as prod:
`/data/backups` on fleet-hetzner-nbg1). Fixed 2026-08-09 (MONET):

| Layer | What | Cadence |
|---|---|---|
| Local | consistent SQLite snapshots + sha256, `/usr/local/sbin/fleet-sqlite-backup.sh` | every 6h (cron `/etc/cron.d/fleet-backups`) |
| **B2 primary** | rclone copy of each run's snapshots → `b2:jays-{congress-trade,socratic-trade,usage-monitor}-eu/hetzner/` | every run (6h) |
| **R2 weekly** | same snapshots → `r2:<bucket>/weekly/` — ONE copy/week keeps R2 definitively inside the free tier | Sundays, **pending an R2 API token** (logs "skipped: no r2 remote configured yet" until then) |
| Verify | integrity-check restore drill | weekly (Sun 04:30) |

Security: the box holds ONLY a scoped B2 key `fleet-backup-writer-hetzner`
(listBuckets/listFiles/readFiles/writeFiles — no delete, no master caps) in
root-only `/root/.config/rclone/rclone.conf`. The Backblaze master key never
touched the box. B2 buckets are allPrivate with 30-day version lifecycle.

First verified run 20260808T210858Z: congress 1.69GB db + kv + sha256,
usage-monitor 103MB, socratic — all present in B2.

**To finish the R2 leg (owner):** Cloudflare dashboard → R2 → Manage R2 API
Tokens → create Object Read & Write token scoped to the backup bucket(s), then
hand credentials per the secret protocol; configure `[r2]` remote in
`/root/.config/rclone/rclone.conf` (type s3, provider Cloudflare). The script
picks it up automatically the next Sunday.

Script edit is appended at the end of fleet-sqlite-backup.sh (pre-edit copy at
fleet-sqlite-backup.sh.bak-20260809 on the box).
