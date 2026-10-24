# Senate eFD edge deny: honest failure and polite backoff

## Summary

CT-2442.  Since about 6:04 AM on Oct 23, 2026 the Akamai edge in front of efdsearch.senate.gov answers the agreement POST (`/search/home/`) and the data POST with 403 "Access Denied" (`Server: AkamaiGHost`) for automated clients on every network, while GETs still reach the origin (`Server: gunicorn`).  No client change restores that, and this change does not try to get past it.  It makes the failure honest and stops the app from making it worse.  Senate PTR discovery stays down until eFD accepts the agreement again.

What changes:

- The agreement POST is checked.  A 3xx, or a 200 whose page no longer carries the agreement form, counts as acceptance.  Anything else, an unreadable 200 body included, throws and writes nothing to KV.
- Senate HTTP errors name the `Server` header.  A 403 from `AkamaiGHost`, or one carrying Akamai's Access Denied page, is the persistent class `edge_denied`.  An origin 403 stays generic.
- On `edge_denied` the watcher backs Senate polling off for 60 minutes, doubling up to 6 hours, and resets on success.  The state is CONFIG_KV `senate_edge_deny:backoff` (2-day TTL, refreshed on each deny), so a restart keeps it.
- Egress order reverses the CT-2361 note (`2026-10-15-senate-efd-direct-peer-price-pending.md`).  With `RESIDENTIAL_PROXY_URL` or `SENATE_PROXY_URL` set, the proxy goes first, because the box's own egress has been edge-denied even for GET since at least Oct 16.  Direct is a fallback only when the proxy never answers: its fetch is refused or reset, or no HTTP answer arrives within 3 seconds (`SENATE_PROXY_FIRST_ANSWER_TIMEOUT_MS`), which covers a black-holed Mango peer.  An HTTP answer through the proxy is final.  A direct fallback never reads, writes or deletes the shared KV session.  A proxy outage whose fallback also fails is a `SenateProxyEgressError`, logged at error and not backed off.
- The `senate_efd` check comes from #2850's proxied functional probe (CT-2416, already on main): the landing GET and the agreement POST through the residential proxy, recorded as ok, blocked or degraded.  The old direct probe is gone.  The integration with #2850 keeps one design: the probe classifies with `classifySenateHttpFailure` (an edge deny is `blocked`), judges the agreement the way `establishSenateSession` does, scrubs transport errors with `sanitizeEfdTransportError`, dials at most every 30 minutes whatever the last verdict, and does not dial at all while the edge-deny backoff is active.  While an ingestion deny is newer than the probe's last eFD verdict, `senate_efd` reads critical "Senate eFD BLOCKED: Akamai edge deny on Senate ingestion ..." and says the probe is paused.  An ok record goes stale after 90 minutes.
- #2850's `SenateAkamaiBlockError`, its flat 30-minute CONFIG_KV backoff (`senate_efd:akamai_block_until`) and its separate watcher and senateSource paths are folded into this change's `SenateHttpError` / `edge_denied` class and its one backoff.  A leftover `senate_efd:akamai_block_until` key is no longer read and expires on its own TTL.
- The fetcher's agreement-wall retry uses the proxied fetch for both legs.  While the backoff is active it defers the document to the end of the window instead of sending the agreement POST.
- `polling_senate` stays stalled.  While the backoff explains the gap and the latest attempt is that deny, its detail reads "senate polling BACKED OFF after an edge deny (<error>): next attempt in Nm; no success in Xh".  Once polling resumes and fails for another reason, or the next attempt is more than 30 minutes overdue, it goes back to the FAILING or NOT RUNNING wording.  `sweepPollingHeartbeat` skips Senate while the backoff is active, so the planned gap does not page as a stuck cron.
- Logs: the first deny of an episode logs `console.error`, and the repeats log `console.warn`.  The Senate no longer claims a "bulk path".

`SENATE_MAX_LOOKBACK_DAYS` stays 30.  The first success after the outage widens the search window to cover the gap, up to 30 days, so an outage longer than about 29 days would leave filings outside that window.

No schema change, migration, backfill or admin call is needed.

## Files changed

- `app/src/ingestion/senateEdgeDeny.ts` (new): classification, `SenateHttpError`, `SenateProxyEgressError`, and the backoff state in CONFIG_KV
- `app/src/ingestion/senateSource.ts`: agreement check, Server header in errors, proxy-first egress with the first-answer deadline
- `app/src/ingestion/watcher.ts`: the backoff in place of the 600 s failure skip, log wording and levels
- `app/src/ingestion/fetcher.ts`: proxied wall retry, deferred while backed off
- `app/src/ingestion/residentialProxyHealth.ts`: the proxied eFD probe uses the one classifier and scrub, a 30-minute interval, and skips during the backoff
- `app/src/ingestion/senateEfdHealth.ts`: the probe record (the direct probe and its throttle are gone)
- `app/src/ingestion/autonomySweeps.ts`: heartbeat skip during the backoff
- `app/src/shared/pipelineHealth.ts`: the `polling_senate` BACKED OFF detail, and `senate_efd` reading the backoff
- Tests under `app/src/ingestion/__tests__/`: `senateEdgeDeny`, `senateSource`, `senateWallGuard`, `watcher`, `senateEfdHealth`, and `app/src/shared/__tests__/pipelineHealth`

## Verification

From `app/`: `npm run typecheck` and `npm test`.

After deploy, read-only checks:

- `/api/health` reports `polling_senate` stalled with "senate polling BACKED OFF after an edge deny (...)" while the deny lasts.
- CONFIG_KV holds `senate_edge_deny:backoff`.  Its `consecutive` grows, and `windowMs` goes 60, 120, 240, then 360 minutes.
- `source_attempts` rows for `senate` are 60, 120, 240, then 360 minutes apart, each with "... HTTP 403 (server=AkamaiGHost) [edge_denied]".
- One `console.error` "senate eFD edge denied (1 in a row ...)" per episode, then `console.warn` for the repeats.
- CONFIG_KV `senate-efd:health` is not rewritten by a dial while the backoff is active, and its `lastDialedAt` moves at most every 30 minutes.  `senate_efd` reads "Senate eFD BLOCKED: Akamai edge deny on Senate ingestion ..." meanwhile.
- When eFD accepts again, the first poll after the window succeeds and logs "senate eFD accepted the poll again ...", the backoff key is gone, and `polling_senate` returns to ok.

## Follow-ups

- Deleting CONFIG_KV `senate_edge_deny:backoff` forces an earlier Senate poll, for example once eFD is known to be back.  That is a production write and needs the owner's go-ahead.
- The fetcher still sends a document HEAD and GET (origin GETs, through the proxy) once per pending Senate document per window before it defers.  It could skip those too during the backoff, at the cost of documents a still-accepted session could fetch.
- A `senate_efd_session` jar cached before this deploy may be a refused one, because the old code cached the jar without checking the agreement.  The new code neither rewrites nor deletes it on an edge deny, so it stays until its 24-hour TTL ends, 24 hours after the last pre-deploy poll wrote it.  Deleting it on a deny was considered and declined: each later attempt would then send a landing GET and the agreement POST in place of one data POST, and the replay is bounded by the TTL anyway.
- The comment above `BROWSER_HEADERS` in `senateSource.ts` still says the daily bulk/backfill path is the source of truth if the live search is refused.  That is wrong for the Senate.
- `recordSourceError` still says "bulk path still authoritative" for executive (OGE) transient failures.  Whether OGE has a bulk path was not checked.
- The 3-second first-answer deadline was checked under Deno 2.9.3 against a refused and a black-holed proxy (fallback at about 50 ms and 3,004 ms), not against the live Mango path.  If healthy proxy polls start falling back to direct, raise it; the source budget is 7 seconds.
- The Sentry and Datadog alert rules for the new error and warn lines were not checked.
