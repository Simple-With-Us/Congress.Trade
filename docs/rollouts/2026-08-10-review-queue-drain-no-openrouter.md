# Rollout: Review-queue drain without OpenRouter

## Summary

Cleared production `review_queue` from **~329 unresolved → 0** with **zero OpenRouter spend**. Published trustworthy deterministic / local extractions via admin review API; rejected garbage `server_cpu_v1` OCR and unusable payloads.

## Results

| Action | Count |
|--------|------:|
| `confirm` (source=primary) | 135 filings |
| `manual` (provider gap) | 7 filings |
| `reject` | 182 filings |
| Transactions inserted | ~4,281 |
| Failures | 0 |
| Unresolved after | **0** |

Chambers with new publishes this pass: **House 135, Senate 10, Executive 1** (incl. E-2026 Frank Bisignano 278-T).

## Files / tooling

- Ops script (host-only, not required in repo): `/tmp/ct_review_drain.py` on Coolify — loads `ADMIN_TOKEN` from congress-app container, dry-run then `--apply`.
- Analysis + improvement backlog: `docs/analysis/2026-08-10-review-queue-drain-lessons.md`

## Verification

```text
SELECT COUNT(*) FROM review_queue WHERE COALESCE(resolved,0)=0;  -- 0
-- review_resolution_integrity: ok (GET /api/health pipeline checks)
```

## Follow-ups

- ~183 rejected scanned House PDFs still have R2 raw objects → reprocess with local vision / scan-cpu (no OR).
- Code: deterministic autopublish for textPdf/senateHtml; fix false invalid_amount; do not park server_cpu garbage in review (see analysis doc A1–A5).

## Non-goals

- Did not top up OpenRouter or re-enable agreement cascade.
- Did not force-publish form-chrome OCR as live trades.
