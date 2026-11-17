# House And OGE Document Downloads Go Direct-First (CT-2442)

## Summary

The residential proxy outage that began on Sun, Nov 15, 2026 at 4:08 PM blocked House document downloads as well as Senate ones, even though the House Clerk serves its PDFs to direct egress and the House list check already goes direct.  Rep. David J. Taylor's House trade report H-2026-20035831 (Mon, Nov 16, 2026, 8:03 AM) failed at the fetch step on every retry and had to be published by hand.  Document downloads for the House and OGE (executive) chambers now try direct egress first and fall back to the residential proxy only when the direct attempt never receives a response.  Senate downloads are unchanged and still require the residential proxy, because eFD denies datacenter IPs outright.

## Files Changed

- `app/src/shared/proxyFetch.ts` — new `createDirectFirstFetch` helper.  It returns the base fetch when no proxy is configured.  Otherwise it attempts the direct fetch first, and on a rejection (fetch rejects only when no response was received) retries once through the proxied fetch.  A response of any status is returned as-is, so existing status handling (404 not-yet-published, 403, 5xx) is untouched.  Aborted requests are never retried, so a queue-lease cancellation cannot turn into a second, proxied request.
- `app/src/ingestion/fetcher.ts` — `fetchFiling` now picks its fetch by chamber.  Senate keeps `createProxiedFetch`; House and executive filings use `createDirectFirstFetch`.  This covers both the HEAD pre-validation and the document GET, which share the same effective fetch.
- `app/src/shared/__tests__/proxyFetch.test.ts` — five new tests for the helper: pass-through without a proxy URL, direct success without a proxy attempt, proxy retry after a no-response direct failure, no retry on abort, and HTTP error responses returned as-is.

## Verification

- `vitest run src/ingestion/__tests__ src/shared/__tests__` — 100 files, 1,365 tests, all pass (including the 5 new ones and the 28 pre-existing proxy and fetcher tests).
- `deno check src/deno/main.ts` — clean.
- `deno lint` on the two changed source files — only the two pre-existing `require-await` findings inside `createProxiedFetch`, identical on the base commit.
- Live proxy state at the time of the fix: the Mango proxy had recovered on its own (tunnel handshake current, tinyproxy running, the Taylor PDF downloading through the proxy and directly with identical bytes).  The fallback exists so the next proxy outage cannot stall House and OGE ingestion again.

## Follow-Ups

- GB-Publisher's local commit `3c846d1f` on `publisher/house-fetch-direct-fallback` implements the inverse order (proxy first, direct on no-response) for the same paths.  It is superseded by this change and should not be pushed.
- The Senate eFD Akamai edge deny (CT health `senate_efd` degraded) is a separate eFD-side refusal, not part of this fix.  Senate document fetches in this app stay on the Mango residential proxy via `createProxiedFetch` (the Mac scout relay was retired on 2026-09-09, board `ba810d46`); the health check’s “Mac fetcher relay” wording refers to the separate Mac eFD fetcher that discovers Senate filings.
- Post-merge review follow-up (CT#3188): the direct attempt is now bounded by `DIRECT_FIRST_TIMEOUT_MS` so a silently dropped direct connection falls back instead of hanging to the lease abort, and a double failure throws one combined error carrying the direct failure as its `cause`.
