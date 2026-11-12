# 2026-08-12 — Effort Issues Sync: shrink the page size when a response won't transfer

## Context & Objective

Follow-up to PR #1800 (`docs/rollouts/2026-08-12-effort-sync-transport-retry.md`). That change added
bounded transport retry to `scripts/sync-effort-issues.py` on the assumption that the
`http.client.IncompleteRead` failures were transient. **They are not.** The retry deployed and worked
exactly as designed, and the sync still failed.

## What the first fix proved

Run [31626620379](https://github.com/jaywedgeworth22/Congress.Trade/actions/runs/31626620379), after
#1800 was live:

```
transport error on GET .../issues?per_page=100&page=3&state=all
  (IncompleteRead: IncompleteRead(711744 bytes read, 10353 more expected)) — retrying in 2s (attempt 1/3)
transport error on GET ... (IncompleteRead(712343 bytes read,  9754 more expected)) — retrying in 4s (attempt 2/3)
transport error on GET ... (IncompleteRead(711592 bytes read, 10505 more expected)) — retrying in 8s (attempt 3/3)
http.client.IncompleteRead: IncompleteRead(712895 bytes read, 9202 more expected)
```

The retry fired all three times with correct exponential backoff. Every attempt died at ~712 KB of a
~722 KB body — the same page, the same place, every time. That is a **deterministic** failure, and
retrying a byte-identical request can never fix it.

Why this repo in particular: the effort board's issue bodies are unusually large (single effort-log rows
run to thousands of characters), so 100 issues/page produces a ~720 KB response. That is simply too big
to get across this runner's link to github.com intact.

## Changes Made

- `scripts/sync-effort-issues.py`
  - Split the old `_get_all_pages` into `_collect_pages(path, params, per_page)` (the original loop,
    now parameterised) and a new `_get_all_pages` wrapper that catches `IncompleteRead` and **halves
    `per_page`, restarting the listing**, down to a floor of `PAGE_SIZE_MIN = 10`. At the floor it
    re-raises rather than looping.
  - New constants `PAGE_SIZE_DEFAULT = 100`, `PAGE_SIZE_MIN = 10`.
  - `HTTP_TIMEOUT_SECONDS` 30 → 60. The same box took ~20 minutes to do a shallow clone of this repo
    during today's deploy, so a large list response needs a wider window to finish inside one timeout.

## Decisions & Trade-offs

- **Restart the whole listing rather than shrink mid-stream.** GitHub's `page` is relative to
  `per_page`, so changing the size partway through would silently skip or duplicate rows. Re-fetching
  the earlier pages is wasteful, but it only happens after a failure, and correctness beats the saved
  requests. The test below asserts no gaps and no duplicates.
- The transport retry from #1800 is kept. It is still right for genuinely flaky failures (the
  Socratic.Trade copy hit a one-off `SSL: CERTIFICATE_VERIFY_FAILED` that *did* clear on its own). The
  two mechanisms compose: retry handles flakes, shrink handles "too big".
- Not chosen: hardcoding a smaller `per_page`. That would slow every run for every repo to work around
  one repo's oversized bodies, and would silently break again if bodies grow further. Adaptive shrink
  costs nothing on the happy path.

## Verification State

```bash
python3 -m py_compile scripts/sync-effort-issues.py   # OK
```

Behavioural test with a stubbed `_request` (per_page > 50 always truncates; ≤ 50 succeeds; 120 items):

```
truncated response on issues (IncompleteRead(712895 bytes read, 9202 more expected)) -- retrying the whole listing at per_page=50
PASS: recovered 120 items with no dupes/gaps; per_page levels tried: [50, 100]
PASS: shrank 100 -> 50
PASS: hits PAGE_SIZE_MIN floor and re-raises instead of looping forever
ALL PASS
```

Not committed (it monkeypatches module internals). The three assertions — full recovery with no
gaps/duplicates, the shrink actually happening, and a bounded floor — are the contract to re-check.

## Next Steps & Blockers

- Confirm on the next scheduled run that the sync completes. The log should show one
  `retrying the whole listing at per_page=50` line and then succeed.
- The sibling copies (`Socratic.Trade`, `congress-trading-shared`, `Usage-Monitor`) are receiving the
  #1800 transport retry in their own PRs. They do **not** currently need this shrink — only
  Congress.Trade's board has bodies large enough to blow the page size — but if any of them starts
  failing the same way, this is the fix to port.
- Underlying condition not addressed here: the self-hosted runner's link to github.com is slow enough
  to make a 720 KB response unreliable. That is worth a separate look at the runner host's network.
