# Root disk usage report (CT-2515)

## Summary

Adds a read-only, low-IO disk usage finder for the Coolify/Hetzner root filesystem.  It lists top directories at a configurable depth, largest files, stale large files, and Docker overlay/volume usage grouped by container and volume name (via `docker inspect`, not raw overlay hashes).  Output is JSON plus a short markdown summary.  The script never deletes anything.

Host install is out of scope for this PR (GB-HOUSEKEEPER / Housekeeper after merge).

## Files changed

- `scripts/ops/root-disk-usage-report.py` — core report
- `scripts/ops/root-disk-usage-report.sh` — host-facing entrypoint
- `scripts/ops/test-root-disk-usage-report.sh` — offline test runner
- `scripts/ops/tests/test_root_disk_usage_report.py` — temp-dir fixture tests

## Verification

```bash
bash scripts/ops/test-root-disk-usage-report.sh
```

On a host (manual, after install):

```bash
bash scripts/ops/root-disk-usage-report.sh \
  --json-out /tmp/root-disk-report.json \
  --md-out /tmp/root-disk-report.md
```

## Follow-ups

- Housekeeper: optional systemd timer and `/etc/root-disk-usage-report.env` on `fleet-hetzner-nbg1` when Jay wants scheduled reports.
