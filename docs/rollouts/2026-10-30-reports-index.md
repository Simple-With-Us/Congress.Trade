# 2026-10-30 — Reports Index

## Summary

Added an in-repo reports index at docs/reports/README.md.  It links existing eligible reports in their canonical paths; docs/reports/2026-10-15-CT-2408-verification.md remains unchanged.  Central placement under Code/Docs/Congress.Trade/ is pending the native guard exception.

## Files Changed

- docs/reports/README.md
- STATUS.md
- docs/rollouts/2026-10-30-reports-index.md

## Verification

- `scripts/check-doc-links.py` is absent from the repository, so the documented inline check was run from the repository root instead:
  ```sh
  python3 -c 'from pathlib import Path; f=Path("docs/reports/README.md"); s=f.read_text(); ts=[x.split(")",1)[0] for x in s.split("](")[1:]]; rel=[t for t in ts if not t.startswith(("http","mailto:"))]; print(len(ts),len(rel),sum(not (f.parent/t.split("#",1)[0]).exists() for t in rel))'
  ```
- The command output was `328 326 0`: 328 total links, 326 relative links, and 0 missing relative links.
- `git diff --exit-code -- docs/reports/2026-10-15-CT-2408-verification.md` exited `0`, confirming the existing report has no diff.

## Follow-ups

- Central placement remains pending the native guard exception.
