# 2026-08-12 — Effort-issue sync: bounded transport-level retry

## Context & Objective

The effort-board mirror (`.github/workflows/effort-issues-sync.yml` →
`scripts/sync-effort-issues.py`) hardened its *HTTP-level* handling last time
(secondary-rate-limit backoff against a bounded per-run budget), but nothing
below HTTP.  `http_request` caught only `urllib.error.HTTPError`, so a
transport-level failure escaped the function entirely, never reached the
rate-limit retry in `GitHubClient._request`, and killed the whole run with a
traceback.

Two failure modes were observed in production on the sibling fleet repos:

- `http.client.IncompleteRead(714456 bytes read, 6207 more expected)` — the
  connection dropped mid-body while paging `issues?state=all`.  That listing
  pulls several hundred KB across pages, so a single mid-body disconnect was
  enough to fail the run.
- `SSL: CERTIFICATE_VERIFY_FAILED` — a transient TLS handshake failure at
  connect time, surfacing as `urllib.error.URLError`.

Both are retryable.  Neither was retried.

## Changes Made

`http_request` now wraps the `urlopen` call in a bounded exponential-backoff
retry loop:

- Retried exceptions: `http.client.IncompleteRead`,
  `http.client.HTTPException`, `urllib.error.URLError`, `ConnectionError`,
  `TimeoutError`, `json.JSONDecodeError`.  The last one is included because a
  body cut short *without* tripping `IncompleteRead` still fails to parse —
  same root cause, same remedy.
- **Only idempotent methods are retried** (`GET`/`HEAD`/`PUT`/`PATCH`/`DELETE`).
  A `POST` whose response body was truncated has *already* created the issue
  server-side; replaying it would file a duplicate, which is worse than the
  failure being fixed.  POSTs raise, and the next scheduled run reconciles —
  creation is keyed off the board, so a re-run is self-healing.
- The `urllib.error.HTTPError` clause stays **ahead** of the `URLError` clause.
  `HTTPError` subclasses `URLError`; reordering them would swallow every 403/429
  as a transport failure and silently disable the rate-limit backoff.
- A socket timeout (`HTTP_TIMEOUT_SECONDS = 30.0`) is now passed to `urlopen`.
  Without one it blocks forever on a half-open connection and the job only ends
  when Actions kills the whole run.

Budget: 4 attempts, 2s → 4s → 8s backoff capped at 15s, so a fully-failing
idempotent call adds at most ~14s before it surfaces the original exception.

Touched files:

- `scripts/sync-effort-issues.py`
- `scripts/test_sync_effort_issues.py`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-08-12-effort-sync-transport-retry.md` (this note)

## Decisions & Trade-offs

- **Retry budget is per-call, not per-run.** The existing
  `RATE_LIMIT_RETRY_BUDGET_SECONDS` deliberately governs long rate-limit sleeps
  (minutes).  Transport retries are seconds and orthogonal, so they were kept on
  their own small bounded counter rather than drawing down a budget whose
  exhaustion means "partial sync, resume next run".
- **`json.JSONDecodeError` inside the `HTTPError` handler is unchanged.** There
  it means an error response with a non-JSON body, which is already handled by
  falling back to the raw text — not a truncation signal.
- **A `CERTIFICATE_VERIFY_FAILED` that is genuinely persistent still burns 4
  attempts (~14s) before failing.** Accepted: distinguishing transient from
  persistent TLS failure is not worth the complexity, and the bound is small.
- No new dependency; `http.client` is stdlib and already transitively in use.

## Verification State

```
python3 -m py_compile scripts/sync-effort-issues.py     # clean
python3 -m unittest scripts/test_sync_effort_issues.py  # Ran 22 tests, OK (was 15)
npm run typecheck                                       # clean
npm test                                                # pass
npm run build                                           # pass
npm run lint:package                                    # publint
npm run pack:dry                                        # pass
```

Seven regression tests were added under `HttpTransportRetryTests`.  Six of them
were confirmed to **fail against the pre-fix script** (checked out from `HEAD`
into a scratch dir and run with the new test file), so they gate the fix rather
than merely describing it.  The seventh
(`test_http_error_still_reaches_the_rate_limit_handler`) passes both before and
after by design — it is a guard against a future reordering of the `HTTPError` /
`URLError` clauses.

Coverage: retry-then-succeed, bounded give-up, POST-is-never-replayed,
`URLError`/SSL recovery, truncated-JSON recovery, `HTTPError` still reaching the
rate-limit handler, and the timeout actually reaching `urlopen`.

## Next Steps & Blockers

None blocking.  The identical fix lands in parallel on `Usage-Monitor`, whose
copy of the script had the same defect (Congress.Trade PR #1800 is the reference
implementation this follows).  Follow-up worth considering separately:
`Usage-Monitor`'s `ci.yml` does not run `python3 -m unittest
scripts/test_sync_effort_issues.py` the way this repo's does, so its copy of the
suite is not gated by CI.
