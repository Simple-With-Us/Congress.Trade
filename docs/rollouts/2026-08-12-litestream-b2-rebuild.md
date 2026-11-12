# 2026-08-12 — Rebuild continuous Litestream replication to Backblaze B2 [CLAUDE]

## Context

CT had **no litestream process running at all** after the Oracle->Hetzner
migration — the old host-level systemd unit (`litestream-congress`,
`/etc/litestream/congress.yml`) was Oracle-box-specific and never recreated on
Hetzner. Confirmed live via `docker top` on the `congress-app` container:
only the Deno process runs.

**Correction (verified live 2026-08-12 09:45Z).**  The original draft of this
doc said the Hetzner volume's ~24h snapshot floor was CT's *only* remaining
PITR path.  That was wrong, and the claim mattered because it overstated the
risk this change removes.  A fleet cron is also writing 6h full-DB snapshots
to the *same* B2 bucket under the `hetzner/` prefix, and it is current — 16
snapshots present, most recent `hetzner/congress-trade-20260812T072754Z.db` at
07:32Z, on cadence.  (This is the layer `main` had already started describing
in `formatOwnBackupRegimenLine()` while this branch was in flight.)

So the accurate before/after is: CT's tightest RPO was **~6h** (the cron), not
~24h, and this change takes it to **~5m** without removing either coarser
layer.  The three are independent and complementary — Litestream LTX under
`congress-trade/`, 6h self-contained full-DB snapshots under `hetzner/`
(disjoint prefixes, no collision), and the Hetzner volume floor.  A ~6h window
was still well behind the sibling apps' near-real-time in-container
replication (Socratic.Trade `litestream.coolify.yml`, Usage-Monitor
`litestream.yml`, both already proven working on the same Coolify/Hetzner
box), which is what motivated the rebuild.

## What changed

Rebuilt the **in-container** pattern (litestream as a sibling process inside
`congress-app`, not a host-level systemd unit), matching ST/UM field-by-field:

- `app/litestream.yml` — new config. DB `/data/congress-trade/db.sqlite` ->
  Backblaze B2 bucket `jays-congress-trade-eu`
  (`s3.eu-central-003.backblazeb2.com`, verified against
  `~/.secrets/backblaze-app-keys.env` `B2_CT_*` keys, not guessed).
  `sync-interval: 5m`, `snapshot: {interval: 24h, retention: 168h}`.
- `app/scripts/fetch-litestream.sh` — build-time pinned + sha256-verified
  litestream v0.5.13 download (adapted from Usage-Monitor's script; **not**
  v0.5.14 — Socratic.Trade hit a socket-churn regression in 0.5.14 on this
  same Coolify/Hetzner box, see their
  `docs/rollouts/2026-07-10-deploy-blocker-tcpmem-litestream.md`).
- `app/scripts/start-with-litestream.sh` — new entrypoint. Resolves the 5
  `LITESTREAM_S3_*` secrets from Infisical (congress-trade prod project,
  reusing the app's existing `INFISICAL_APP_CLIENT_ID`/`_CLIENT_SECRET`
  bootstrap identity — no new bootstrap credential needed), then execs
  `litestream replicate -config litestream.yml -exec "deno run ..."` as PID 1.
  Falls straight through to the unmodified `deno run ...` when B2 credentials
  are absent (local/preview) — zero behavior change there. Fails closed (exit
  1) if only some of the 5 keys resolve, matching Usage-Monitor's
  partial-config guard.
- `app/Dockerfile` — installs `bash`/`tar`/`ca-certificates`, the pinned
  litestream binary, and the Infisical CLI (via Alpine's official apk repo —
  the generic glibc release tarball ST/UM use on Debian does not reliably run
  on Alpine/musl, see
  [Infisical/infisical#3511](https://github.com/Infisical/infisical/issues/3511)).
  `CMD` changed from the raw `deno run ...` to
  `bash scripts/start-with-litestream.sh`.
- `app/src/shared/r2Usage.ts` — `formatOwnBackupRegimenLine()` (Pushover
  digest reminder line) now reports all three layers: continuous
  litestream→B2, the fleet cron's 6h full-DB snapshots, and the Hetzner ~24h
  volume floor.  The rebase onto `main` had a real conflict here, not a
  mechanical one: `main` had replaced the old R2 text with a cron-snapshots
  line while this branch replaced it with a litestream line.  Neither
  supersedes the other, so the resolution reports both.

## Deliberately separate secret names

`LITESTREAM_S3_BUCKET` / `_ENDPOINT` / `_REGION` / `_ACCESS_KEY_ID` /
`_SECRET_ACCESS_KEY` are **new** Infisical secrets (added to the
congress-trade prod project, `<CT_INFISICAL_PROJECT_ID>`) — not a
repoint of the app's existing `AWS_S3_BUCKET_NAME` /
`AWS_S3_ENDPOINT`/`AWS_REGION`/`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`.
Those existing secrets already point at Cloudflare R2 and back the `raw/`
filing-PDF object store consumed in-process by `src/deno/main.ts`
(`S3Client`). Reusing those names for the DB backup replica would have
silently repointed PDF storage at the B2 bucket instead of R2 — checked this
explicitly (`app/src/deno/main.ts` lines ~82-107) before choosing names, since
the naming convention that matched ST/UM's `AWS_S3_*` vars is exactly the one
already in live use for something else in this app.

## Sync interval reasoning (5m, within the 60s-1h fleet range)

The 2026-08-05 R2 Class A incident
(`docs/rollouts/2026-08-05-r2-freetier-class-a-survival.md`) showed
Litestream 0.5's L0-object-per-commit behavior keeps uploading at a high rate
during CT's bulk-load ingestion bursts (~975 PUT/hr observed) *independent of
the configured sync interval*. That incident was specifically about R2's
free-tier Class A/storage caps; B2 has no equivalent free-tier trap (2,500
Class A ops/day free, ~$0.004/10k after — trivial even at CT's observed peak
rate). `docs/rollouts/2026-08-06-backup-steady-state-policy.md`'s **15m**
guidance for CT was written for that R2 constraint and is superseded here for
the B2 destination. Chose **5m**: a large RPO improvement over the current
up-to-6h gap, while staying conservative against another write-burst spike
given CT's demonstrated write volume — the middle of ST's 60s and UM's 1h.

## Verification still needed (post-merge, on the box)

This PR is **not** self-verifying — it changes the container's running
process topology. Per standing instruction, this was not merged/deployed by
the authoring session. After merge + deploy, confirm on `fleet-hetzner-nbg1`:

```bash
ssh coolify
docker top congress-app | grep litestream   # litestream should now appear alongside deno
docker logs congress-app --tail 100 | grep -i litestream
# expect: "Litestream B2 replica credentials resolved ... replication ENABLED"
#         "starting litestream replicate (B2) as PID 1, wrapping: deno run ..."
```

If `INFISICAL_APP_CLIENT_ID`/`_CLIENT_SECRET` are somehow absent as Coolify
env vars for `congress-app` (they should already be present — the app's own
in-process secret resolution already depends on them for `AWS_S3_*`), the
container falls through to running Deno without litestream and logs why; it
does not crash-loop.

## Rollback

Revert this PR (or set `CMD` back to the raw `deno run ...` array) — the
container returns to exactly its pre-change behavior. No schema/data changes;
`/data/congress-trade/db.sqlite` and its Hetzner volume snapshots are
untouched either way.
