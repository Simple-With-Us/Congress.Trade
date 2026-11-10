# 2026-09-13 — Remove committed ADMIN_TOKEN scratch script

Boards `010936c8` `ab7cf3be`.  Branch `fx/drop-admin-token-script`.

`filed_date_week_latency.ts` at repo root POSTed a hardcoded bearer to `POST /api/admin/debug-sql`.  Deleted from git.  Path gitignored.

Owner must rotate `ADMIN_TOKEN`.  Git history on this public repo still contains the old value.  Do not force-push history.
