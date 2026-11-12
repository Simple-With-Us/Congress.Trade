# 2026-08-12 — Effort Issues Sync: retry transient transport failures

## Context & Objective

`Effort Issues Sync` on `main` has been failing intermittently and paging into the
`fleet-infra` Sentry project (FLEET-INFRA-3Q, 14 events; the sibling no-suffix
issue FLEET-INFRA-3E covers the Socratic.Trade copy, 18 events). Both were still
firing as of this morning. The failures are transient — the following scheduled
run succeeds — but each one files a Sentry issue, so the board accumulates noise
that looks like a broken sync.

This change makes `scripts/sync-effort-issues.py` survive a transient transport
failure instead of aborting the whole run.

## Changes Made

Root cause, from run [31584402033](https://github.com/jaywedgeworth22/Congress.Trade/actions/runs/31584402033):

```
File "scripts/sync-effort-issues.py", line 307, in http_request
    raw = resp.read()
http.client.IncompleteRead: IncompleteRead(714456 bytes read, 6207 more expected)
```

`http_request` caught only `urllib.error.HTTPError` — a *real HTTP response*.
Transport-level failures (`IncompleteRead`, `URLError`, connection resets,
timeouts) escaped the function entirely, so they never reached the rate-limit
retry loop in `GitHubClient._request` and killed the run. `list_all_issues()`
pages `issues?state=all` and pulls ~700 KB, so a single mid-body disconnect was
enough to fail the sync.

- `scripts/sync-effort-issues.py`
  - `http_request` now retries transient transport errors with exponential
    backoff (`IncompleteRead`, `HTTPException`, `URLError`, `ConnectionError`,
    `TimeoutError`, `JSONDecodeError`).
  - `urlopen` now passes `timeout=HTTP_TIMEOUT_SECONDS` (30s). It previously had
    no timeout at all, so a half-open connection would hang until Actions killed
    the whole job.
  - New constants: `HTTP_TIMEOUT_SECONDS`, `TRANSPORT_RETRY_METHODS`,
    `TRANSPORT_RETRY_ATTEMPTS`, `TRANSPORT_BACKOFF_BASE_SECONDS`,
    `TRANSPORT_BACKOFF_MAX_SECONDS`.
  - `import http.client` added.

## Decisions & Trade-offs

- **POST is deliberately NOT retried.** This is the important one. A POST that
  created an issue but whose *response body* was truncated has already mutated
  the repo — replaying it would file a duplicate issue, which is worse than the
  failure being fixed. Only idempotent methods (`GET`/`HEAD`/`PUT`/`PATCH`/
  `DELETE`) retry; a POST surfaces the error and the next scheduled run
  reconciles, since creation is keyed off the board and is self-healing.
- `HTTPError` is still returned, not retried, and its `except` clause stays
  ahead of `URLError` (it subclasses it). The existing secondary-rate-limit
  backoff in `_request` is untouched and still sees every 403/429.
- `JSONDecodeError` is treated as a transport failure because a body cut short
  without tripping `IncompleteRead` still fails to parse — same root cause, same
  remedy. A genuine API contract change would still surface after the attempts
  are exhausted.
- Retries are capped at 4 attempts / ~14s total backoff, well inside the job
  timeout. A *persistent* fault (e.g. the TLS error below) still fails the run,
  so no genuine outage signal is suppressed.

## Verification State

Syntax/compile:

```bash
python3 -m py_compile scripts/sync-effort-issues.py   # OK
```

Behavioural test (temporary harness, stubbed `urlopen`, `time.sleep` patched out):

```
PASS 1: GET retries IncompleteRead and succeeds after 2 attempts
PASS 2: POST raised without retry ( 1 attempt ) - no duplicate issue risk
PASS 3: GET gave up after 4 attempts and re-raised
PASS 4: HTTPError still returned to rate-limit handler (status 403 )
ALL TESTS PASSED
```

The harness was not committed — it monkeypatches module globals and does not fit
the repo's test layout. The four cases above are the contract to re-check if this
function is touched again.

## Next Steps & Blockers

- **The same bug exists in three sibling copies** of this script, none of which
  have transport retry:
  - `/Users/jay/Code/Socratic.Trade/scripts/sync-effort-issues.py` (has
    `timeout=30`, no retry)
  - `/Users/jay/Code/congress-trading-shared/scripts/sync-effort-issues.py`
  - `/Users/jay/Code/Usage-Monitor/scripts/sync-effort-issues.py`
  - plus the vendored `app/vendor/congress-trading-shared/scripts/sync-effort-issues.py`
  Each needs the same patch in its own repo/PR.
- **Separate finding, owner-actionable, NOT fixed here.** The Socratic.Trade
  Effort Issues Sync failure at 09:48 UTC today failed for a *different* reason:

  ```
  urllib.error.URLError: <urlopen error [SSL: CERTIFICATE_VERIFY_FAILED]
    certificate verify failed: self-signed certificate>
  ```

  A self-signed certificate presented for `api.github.com` on a self-hosted
  runner. It recovered on the next run, so it was transient, but it is worth an
  explicit look — it is the signature of TLS interception on the runner's
  network. This change does not paper over it: a persistent cert failure still
  fails the run after the retry budget.
