/**
 * src/ingestion/fetcher.ts
 * OWNER: ingestion agent
 *
 * Handles {type:'filing.new'}: downloads the raw disclosure (PDF/HTML), stores
 * it in R2 (RAW_FILES) under key `raw/{docId}`, updates filings.raw_object_key +
 * ingest_status='fetched', then enqueues {type:'filing.fetched'}.
 *
 *   HOUSE PTR  -> PDF at
 *     https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/{YEAR}/{DocID}.pdf
 *     (we already stored this exact url as filings.source_url at watch time).
 *   SENATE     -> GET the report sourceUrl. Electronic PTRs render as HTML;
 *     paper PTRs are an HTML shell linking to a PDF. We store the response body
 *     verbatim (HTML or PDF bytes); the classifier decides the DocKind.
 */

import type { Env } from '../shared/types.ts';
import type { DurableQueueLeaseContext } from '../deno/durableQueue.ts';
import { get, run } from '../shared/db.ts';
import { trackedFetch } from '../shared/thirdPartyTelemetry.ts';
import { isReviewResolved } from './reviewQueueGuard.ts';
import {
  SENATE_SESSION_KV_KEY,
  establishSenateSession,
  looksLikeSenateAgreementWall,
} from './senateSource.ts';
import { isSenateRelayUnreachable, senateRelayAuthHeaders } from './senateRelayHealth.ts';
import { isSenateEdgeBackoffActive, readSenateEdgeBackoff } from './senateEdgeDeny.ts';
import { createProxiedFetch, resolveResidentialProxyUrl } from '../shared/proxyFetch.ts';

const UA = 'congress-feed/0.1 (+https://congress.trade)';

interface FilingRow {
  doc_id: string;
  chamber: string | null;
  source_url: string | null;
  ingest_status: string | null;
  first_seen_at?: string | null;
}

export const MAX_RAW_FILING_BYTES = 50 * 1024 * 1024;
const MAX_INGEST_BACKOFF_SECONDS = 900;

export class IngestRetryError extends Error {
  constructor(message: string, readonly delaySeconds: number) {
    super(message);
  }
}

export class FilingTooLargeError extends Error {}

/** HTTP responses that should be retried by the ingest queue. */
export function isRetryableFilingHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/**
 * How long a 404-ing filing keeps retrying before going terminal. House bulk
 * FD index entries are published before the Clerk posts the matching PDF, so
 * a fresh filing's 404 usually means "not yet published", not "does not
 * exist" (prod 2026-07-30: 707 filings errored terminally on same-day 404s).
 */
export const FETCH_NOT_PUBLISHED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Full transient-fetch classification. Beyond the generic retryable statuses:
 * - 403: the Clerk/eFD WAF answers request bursts with short-lived 403s
 *   (observed 2026-08-01 during a backlog drain); a terminal error loses the
 *   filing, so retry with the standard backoff instead. A genuinely
 *   permanent block still terminates via the queue's retry budget.
 * - 404: retry only while the filing is fresh (see window above); an old
 *   filing's 404 is treated as genuinely missing and stays terminal.
 */
export function shouldRetryFetchStatus(
  status: number,
  firstSeenAt: string | null | undefined,
  now: Date,
): boolean {
  if (isRetryableFilingHttpStatus(status)) return true;
  if (status === 403) return true;
  if (status === 404) {
    const seen = firstSeenAt ? Date.parse(firstSeenAt) : NaN;
    if (Number.isFinite(seen) && now.getTime() - seen < FETCH_NOT_PUBLISHED_WINDOW_MS) return true;
  }
  return false;
}

export function retryAfterSeconds(value: string | null, nowMs = Date.now()): number | null {
  if (!value) return null;
  const numeric = Number(value.trim());
  if (Number.isFinite(numeric) && numeric >= 0) {
    return Math.max(1, Math.min(3600, Math.ceil(numeric)));
  }
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return null;
  return Math.max(1, Math.min(3600, Math.ceil((at - nowMs) / 1000)));
}

/** Exponential fallback with bounded half-to-full jitter. attempt is 1-based. */
export function ingestBackoffSeconds(attempt: number, random = Math.random): number {
  const cap = Math.min(MAX_INGEST_BACKOFF_SECONDS, 5 * 2 ** Math.max(0, attempt - 1));
  return Math.max(1, Math.floor(cap * (0.5 + random() * 0.5)));
}

/** Queue-boundary classifier shared by later provider-backed ingest stages. */
export function classifyTransientIngestError(
  error: unknown,
  attempt: number,
): IngestRetryError | null {
  if (error instanceof IngestRetryError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const transient =
    /\bHTTP\s+(408|425|429|5\d\d)\b/i.test(message) ||
    /rate[ -]?limit|quota|temporar(?:y|ily) unavailable|timeout|timed out|network|fetch failed|ECONN(?:RESET|REFUSED)|overloaded/i.test(message);
  if (!transient) return null;
  const retryAfterMatch = /retry-after\s*[:=]\s*([^\s,;]+)/i.exec(message);
  const delay = retryAfterMatch
    ? retryAfterSeconds(retryAfterMatch[1]) ?? ingestBackoffSeconds(attempt)
    : ingestBackoffSeconds(attempt);
  return new IngestRetryError(message, delay);
}



/**
 * Buffer the size-guarded body into memory. R2 `put()` rejects a plain JS
 * ReadableStream because it has no known length ("Provided readable stream
 * must have a known length"), and sources like OGE's Domino server respond
 * chunked with no Content-Length — so the raw bytes must be buffered (capped
 * at MAX_RAW_FILING_BYTES) before the R2 write.
 */
export async function bufferFilingBody(
  body: ReadableStream<Uint8Array>,
  limit = MAX_RAW_FILING_BYTES,
): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    chunks.push(next.value);
    total += next.value.byteLength;
    if (total > limit) {
      await reader.cancel('filing exceeds size limit').catch(() => {});
      throw new FilingTooLargeError(`filing exceeds ${limit} byte limit`);
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** R2 object key for a filing's raw original. Matches the spec: `raw/{docId}`. */
export function rawKeyFor(docId: string): string {
  return `raw/${docId}`;
}

/**
 * True when already-buffered raw bytes are the Senate eFD agreement wall
 * instead of a filing. A sessionless (or expired-session) GET of any
 * /search/view/... report URL is transparently redirected to the wall, which
 * arrives as HTTP 200 text/html — so it MUST be sniffed by content before the
 * bytes are persisted. PDFs can never be the wall; only HTML-ish bodies are
 * decoded and tested.
 */
export function isSenateAgreementWallBytes(bytes: Uint8Array): boolean {
  if (bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
    return false; // %PDF — a real document, never the wall
  }
  const prefix = new TextDecoder('utf-8').decode(bytes.subarray(0, Math.min(bytes.length, 65536)));
  return looksLikeSenateAgreementWall(prefix);
}

/** Mark a filing as errored (does not throw). */
async function markError(
  env: Env,
  docId: string,
  message: string,
  lease?: DurableQueueLeaseContext,
): Promise<void> {
  try {
    await lease?.assertOwned();
    await run(
      env.DB,
      `UPDATE filings SET ingest_status = 'error', error = ? WHERE doc_id = ?`,
      [message.slice(0, 1000), docId],
    );
  } catch (e) {
    console.error(`fetcher: failed to record error for ${docId}:`, e);
  }
}

/**
 * Fetch + persist the raw bytes for a filing, then advance the pipeline.
 */
export async function fetchFiling(
  env: Env,
  docId: string,
  queueAttempt = 1,
  lease?: DurableQueueLeaseContext,
): Promise<void> {
  await lease?.assertOwned();
  const row = await get<FilingRow>(
    env.DB,
    `SELECT doc_id, chamber, source_url, ingest_status, first_seen_at FROM filings WHERE doc_id = ?`,
    [docId],
  );
  if (!row) {
    console.warn(`fetcher: no filings row for ${docId}; skipping`);
    return;
  }
  // Autonomy guard: see reviewQueueGuard.ts. A re-triggered filing.new
  // message must not clobber a terminal ingest_status the review process
  // already stamped for this doc_id.
  if (await isReviewResolved(env.DB, docId)) {
    console.warn(`fetcher: ${docId} already review-resolved; skipping re-fetch (no-op)`);
    return;
  }
  const sourceUrl = row.source_url;
  if (!sourceUrl) {
    await markError(env, docId, 'fetcher: missing source_url', lease);
    return;
  }

  try {
    const headers: Record<string, string> = {
      'user-agent': UA,
      accept:
        row.chamber === 'senate'
          ? 'text/html,application/xhtml+xml,application/pdf,*/*'
          : 'application/pdf,*/*',
    };

    // Imperva blocks datacenter IPs on efdsearch.senate.gov (bare 403), so
    // when a relay is configured every senate DOCUMENT fetch must go through
    // it too — not just the search flow in senateSource.ts. The relay's
    // /fetch-doc mirrors the upstream status + content-type, so the retry
    // semantics below work unchanged. Found 2026-08-10: the historical
    // backfill discovered ~650 filings whose fetches then all 403'd direct.
    const residentialProxyUrl = resolveResidentialProxyUrl(env);
    const effectiveFetch = residentialProxyUrl ? createProxiedFetch(residentialProxyUrl, fetch) : fetch;

    // Owner 2026-09-09: the Mac Senate relay (`https://scout.jays.services`)
    // is retired (board `ba810d46`).  `resolveResidentialProxyUrl` always
    // resolves now — the Mango HTTP CONNECT proxy at `http://10.99.0.2:8888`
    // is the fleet default — so `senateRelayUrl` is always undefined and the
    // relay branch below is dead, kept one release per the rollout doc.
    const senateRelayUrl =
      !residentialProxyUrl && row.chamber === 'senate' && env.SENATE_RELAY_URL
        ? env.SENATE_RELAY_URL.replace(/\/$/, '')
        : undefined;
    // Warn on the env itself rather than on `!residentialProxyUrl`, which can
    // no longer be true: gating the warning on it would make it unreachable
    // and leave a stale SENATE_RELAY_URL silently ignored forever.
    if (row.chamber === 'senate' && env.SENATE_RELAY_URL) {
      console.warn(
        `fetcher: SENATE_RELAY_URL=${env.SENATE_RELAY_URL} is configured but the Mac Senate relay has been retired (2026-09-09). ` +
        'Ignoring it and fetching the document directly via the Mango residential proxy.',
      );
    }
    const fetchSenateDocViaRelay = () =>
      trackedFetch(`${senateRelayUrl}/fetch-doc`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: '*/*',
          ...senateRelayAuthHeaders(env.SENATE_RELAY_SECRET),
        },
        body: JSON.stringify({ url: sourceUrl }),
        signal: lease?.signal,
      }, { service: 'filing-ingestion', operation: 'fetch-filing-document-relay', dynamicTarget: 'filing-source' });

    // Prefer #1610's /fetch-doc when the relay answers.  Cloudflare 502/5xx
    // on the named tunnel means the Mac origin is gone — fall back to direct
    // eFD so a sleeping laptop does not fail-close Senate document fetch.
    // Mirrored upstream statuses (404/403) still travel the relay path.
    let usedRelay = false;
    let relayRes: Response | null = null;
    if (senateRelayUrl) {
      try {
        const candidate = await fetchSenateDocViaRelay();
        if (!isSenateRelayUnreachable(candidate)) {
          usedRelay = true;
          relayRes = candidate;
        } else {
          await candidate.body?.cancel().catch(() => {});
          console.warn(`fetcher: senate relay unreachable (HTTP ${candidate.status}); falling back to direct eFD`);
        }
      } catch (err) {
        console.warn('fetcher: senate relay failed; falling back to direct eFD:', (err as Error).message);
      }
    }

    if (row.chamber === 'senate' && env.CONFIG_KV && !usedRelay) {
      try {
        const session = await env.CONFIG_KV.get<{ cookieHeader: string }>('senate_efd_session', 'json');
        if (session?.cookieHeader) {
          headers['cookie'] = session.cookieHeader;
        }
      } catch (err) {
        console.warn('fetcher: failed to load senate session cookies from KV:', err);
      }
    }
    // The HEAD pre-validation is skipped on the relay path: the relay only
    // exposes POST endpoints, and the GET below surfaces the same statuses.
    const headRes = usedRelay ? null : await trackedFetch(
      sourceUrl,
      {
        method: 'HEAD',
        headers,
        signal: lease?.signal,
      },
      { service: 'filing-ingestion', operation: 'head-validate-fetch', dynamicTarget: 'filing-source' },
      effectiveFetch,
    ).catch(() => null);

    if (headRes && !headRes.ok && headRes.status !== 304 && headRes.status !== 405) {
      const notYetPublished = headRes.status === 404 && shouldRetryFetchStatus(headRes.status, row.first_seen_at, new Date());
      const message = notYetPublished
        ? `fetcher: HEAD source ${sourceUrl} -> HTTP 404 (not yet published; will retry)`
        : `fetcher: HEAD source ${sourceUrl} -> HTTP ${headRes.status}`;
      await headRes.body?.cancel().catch(() => {});
      await markError(env, docId, message, lease);
      if (shouldRetryFetchStatus(headRes.status, row.first_seen_at, new Date())) {
        throw new IngestRetryError(
          message,
          retryAfterSeconds(headRes.headers.get('retry-after')) ?? ingestBackoffSeconds(queueAttempt),
        );
      }
      return;
    }

    const res = usedRelay && relayRes
      ? relayRes
      : await trackedFetch(sourceUrl, {
        headers,
        redirect: 'follow',
        signal: lease?.signal,
      }, { service: 'filing-ingestion', operation: 'fetch-filing-document', dynamicTarget: 'filing-source' }, effectiveFetch);
    if (!res.ok) {
      const notYetPublished = res.status === 404 && shouldRetryFetchStatus(res.status, row.first_seen_at, new Date());
      const message = notYetPublished
        ? `fetcher: source ${sourceUrl} -> HTTP 404 (not yet published; will retry)`
        : `fetcher: source ${sourceUrl} -> HTTP ${res.status}`;
      await res.body?.cancel().catch(() => {});
      await markError(env, docId, message, lease);
      if (shouldRetryFetchStatus(res.status, row.first_seen_at, new Date())) {
        throw new IngestRetryError(
          message,
          retryAfterSeconds(res.headers.get('retry-after')) ?? ingestBackoffSeconds(queueAttempt),
        );
      }
      return;
    }

    let contentType = res.headers.get('content-type') ?? '';
    const contentLength = Number(res.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_RAW_FILING_BYTES) {
      await res.body?.cancel().catch(() => {});
      throw new FilingTooLargeError(`filing exceeds ${MAX_RAW_FILING_BYTES} byte limit`);
    }
    if (!res.body) throw new Error('source response body is missing');
    const key = rawKeyFor(docId);

    // Persist raw bytes verbatim; retain content-type so the classifier can use
    // it as a cheap signal without re-fetching.
    let rawBytes = await bufferFilingBody(res.body);

    // SENATE AGREEMENT-WALL GUARD. When the KV session is missing or expired,
    // eFD answers the report URL with the agreement wall (HTTP 200, text/html).
    // Storing that page as the filing's raw bytes silently yields a
    // zero-transaction "senate_html" extraction, so: detect the wall BEFORE the
    // R2 write, negotiate a fresh agreement-accepted session (cached back to
    // KV for subsequent filings), and refetch once. If the wall persists, the
    // message is retried later rather than poisoning the pipeline.
    if (row.chamber === 'senate' && isSenateAgreementWallBytes(rawBytes)) {
      // On the relay path the relay negotiates its own session (and already
      // retried once internally); a second relay call is the correct retry.
      // Direct path: negotiate a fresh agreement-accepted session ourselves,
      // on the same proxied egress as the document GETs above.  Both legs
      // used to go out on the default (unproxied) fetch, from the box IP the
      // eFD edge denies.
      let retry: Response;
      if (usedRelay) {
        retry = await fetchSenateDocViaRelay();
      } else {
        // While the watcher is backed off after an eFD edge deny (CT-2442),
        // the handshake would send the edge the very agreement POST it is
        // refusing, now from the residential IP.  Defer the document until
        // the window ends instead, jittered past the watcher's own attempt.
        const edgeBackoff = await readSenateEdgeBackoff(env);
        const now = new Date();
        if (edgeBackoff && isSenateEdgeBackoffActive(edgeBackoff, now)) {
          const waitSeconds = Math.max(1, Math.ceil((Date.parse(edgeBackoff.until) - now.getTime()) / 1000));
          const message = `fetcher: senate agreement wall for ${sourceUrl}; handshake deferred until ${edgeBackoff.until} (eFD edge-deny backoff)`;
          await markError(env, docId, message, lease);
          throw new IngestRetryError(message, waitSeconds + ingestBackoffSeconds(queueAttempt));
        }
        // The lease signal bounds the handshake like every other request
        // here, so a hung proxy aborts it with the lease instead of holding
        // the queue consumer.
        const session = await establishSenateSession({ kv: env.CONFIG_KV, signal: lease?.signal }, effectiveFetch);
        retry = await trackedFetch(sourceUrl, {
          headers: { ...headers, cookie: session.cookieHeader },
          redirect: 'follow',
          signal: lease?.signal,
        }, { service: 'filing-ingestion', operation: 'fetch-filing-document', dynamicTarget: 'filing-source' }, effectiveFetch);
      }
      if (!retry.ok || !retry.body) {
        await retry.body?.cancel().catch(() => {});
        const message = `fetcher: senate agreement wall for ${sourceUrl}; refetch -> HTTP ${retry.status}`;
        await markError(env, docId, message, lease);
        throw new IngestRetryError(message, ingestBackoffSeconds(queueAttempt));
      }
      const retryBytes = await bufferFilingBody(retry.body);
      if (isSenateAgreementWallBytes(retryBytes)) {
        // Session refresh did not clear the wall (likely anti-bot). Drop the
        // cached session so the next attempt re-negotiates from scratch.
        if (env.CONFIG_KV) await env.CONFIG_KV.delete(SENATE_SESSION_KV_KEY).catch(() => {});
        const message = `fetcher: senate agreement wall persisted after session refresh for ${sourceUrl}`;
        await markError(env, docId, message, lease);
        throw new IngestRetryError(message, ingestBackoffSeconds(queueAttempt));
      }
      rawBytes = retryBytes;
      contentType = retry.headers.get('content-type') ?? contentType;
    }
    await lease?.assertOwned();
    await env.RAW_FILES.put(key, rawBytes, {
      httpMetadata: { contentType: contentType || 'application/octet-stream' },
    });
    await lease?.assertOwned();
    await run(
      env.DB,
      `UPDATE filings
          SET raw_object_key = ?, ingest_status = 'fetched', error = NULL
        WHERE doc_id = ?`,
      [key, docId],
    );

    await lease?.assertOwned();
    await env.INGEST_QUEUE.send({ type: 'filing.fetched', docId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof FilingTooLargeError || /filing exceeds \d+ byte limit/i.test(message)) {
      await markError(env, docId, `fetcher: ${message}`, lease);
      return;
    }
    if (err instanceof IngestRetryError) throw err;
    await markError(env, docId, `fetcher: ${message}`, lease);
    // Network, R2, D1, and queue failures are transient unless explicitly
    // classified above; carry an explicit delay into the queue consumer.
    throw new IngestRetryError(`fetcher: ${message}`, ingestBackoffSeconds(queueAttempt));
  }
}
