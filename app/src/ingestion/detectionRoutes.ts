/**
 * src/ingestion/detectionRoutes.ts
 *
 * Ingest/detection endpoints (Mac scout/congress-scout.mjs retired #2351) — all INGEST_TOKEN-gated:
 *
 *   POST /api/ingest/detection
 *     Push each filing the scout detects on primary gov sources. Latency
 *     candidate + optional filings insert/enqueue (same path as the watcher).
 *
 *   GET  /api/ingest/scout-plan
 *     Server-first handoff plan: which latency providers the scout must cover
 *     (server failed / quiet) + filings still missing raw bytes in R2.
 *
 *   POST /api/ingest/latency-payload
 *     Scout posts provider JSON (FMP/UW/QQ) when the server cannot poll that
 *     source; server parses with the same parsers as the cron probe.
 *
 *   POST /api/ingest/raw
 *     Scout uploads raw PDF/HTML bytes (base64) into RAW_FILES (Cloudflare R2)
 *     when residential egress can fetch what the datacenter server cannot.
 *
 * Detection is existence + link, not extraction. Set `ingest: false` to record
 * latency only (used by pure measurement runs). Default is ingest when a
 * source URL is present.
 */
import { Hono } from 'hono';
import type { Env } from '../shared/types.ts';
import { resolveSecret } from '../secrets/infisical.ts';
import { constantTimeEqual } from '../auth/tokens.ts';
import { get, run } from '../shared/db.ts';
import {
  recordDisclosureLatencyCandidate,
} from './tradeLatency.ts';
import {
  buildScoutPlan,
  requestMacProbeLease,
  type LatencyProbeProviderId,
} from './scoutHandoff.ts';
import {
  macLeaseTtlMs,
  macTenureMs,
  readAllProbeLeases,
  releaseProbeLease,
} from './probeLease.ts';
import { checkLatencyCallBudget } from './latencyCallLedger.ts';
import {
  MAX_RAW_FILING_BYTES,
  isSenateAgreementWallBytes,
  rawKeyFor,
} from './fetcher.ts';
import { trackedFetch } from '../shared/thirdPartyTelemetry.ts';
import {
  enqueueFilingNew,
  houseFilerId,
  insertFilingIfNew,
  preclassifyDocKind,
  senateFilerId,
  type DiscoveredFiling,
  type InsertFilingResult,
} from './watcher.ts';

async function requireIngestToken(c: { env: Env; req: { header: (name: string) => string | undefined } }): Promise<Response | null> {
  const token =
    (await resolveSecret(c.env, 'INGEST_TOKEN')).value ||
    (await resolveSecret(c.env, 'CT_INGEST_TOKEN' as keyof Env & string)).value;
  if (!token || !(await constantTimeEqual(c.req.header('Authorization') ?? '', `Bearer ${token}`))) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }
  return null;
}

function decodeBase64Bytes(b64: string): Uint8Array {
  const cleaned = b64.replace(/\s+/g, '');
  // atob is available in Deno/Workers; Buffer is available in Node test env.
  if (typeof atob === 'function') {
    const bin = atob(cleaned);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Buf = (globalThis as any).Buffer;
  if (Buf) return new Uint8Array(Buf.from(cleaned, 'base64'));
  throw new Error('no base64 decoder available');
}

export function buildDetectionRouter(): Hono<{ Bindings: Env }> {
  const r = new Hono<{ Bindings: Env }>();

  r.get('/scout-plan', async (c) => {
    const denied = await requireIngestToken(c);
    if (denied) return denied;
    const plan = await buildScoutPlan(c.env);
    return c.json({ ok: true, ...plan });
  });

  // Operator surface: who owns each provider lane, until when, and how much of
  // the shared daily budget is left. This is the answer to "why is nothing
  // polling?" — a held lease with a far-off expiry, or an exhausted cap.
  r.get('/probe-leases', async (c) => {
    const denied = await requireIngestToken(c);
    if (denied) return denied;
    const now = new Date();
    const leases = await readAllProbeLeases(c.env, now);
    const providers: LatencyProbeProviderId[] = [
      'fmp',
      'fmp_rapidapi',
      'unusual_whales',
      'quiver',
    ];
    const budgets = await Promise.all(
      providers.map(async (provider) => ({
        provider,
        ...(await checkLatencyCallBudget(c.env, provider, now)),
      })),
    );
    return c.json({
      ok: true,
      now: now.toISOString(),
      leases,
      budgets,
      macLeaseTtlSec: Math.floor(macLeaseTtlMs(c.env) / 1000),
      macTenureHours: macTenureMs(c.env) / 3600000,
    });
  });

  // The scout MUST hold a lane before calling a provider. Grant also charges
  // the shared daily ledger, so one grant authorizes exactly one poll and Mac
  // spend counts against the same cap as server spend.
  r.post('/probe-lease', async (c) => {
    const denied = await requireIngestToken(c);
    if (denied) return denied;
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const known: LatencyProbeProviderId[] = [
      'fmp',
      'fmp_rapidapi',
      'unusual_whales',
      'quiver',
    ];
    const raw = typeof body.provider === 'string' ? body.provider.trim().toLowerCase() : '';
    const provider = known.find((id) => id === raw);
    if (!provider) {
      return c.json({ error: `provider must be one of ${known.join(', ')}` }, 400);
    }
    const holderId =
      typeof body.holderId === 'string' && body.holderId.trim()
        ? body.holderId.trim().slice(0, 120)
        : '';
    if (!holderId) return c.json({ error: 'holderId is required' }, 400);
    const action = body.action === 'release' ? 'release' : 'acquire';

    if (action === 'release') {
      const released = await releaseProbeLease(c.env, provider, 'mac', holderId);
      return c.json({ ok: true, action, provider, released });
    }

    const ttlSec =
      typeof body.ttlSec === 'number' && Number.isFinite(body.ttlSec) ? body.ttlSec : undefined;
    const fmpSlot = body.fmpSlot === '1' ? '1' : body.fmpSlot === '2' ? '2' : undefined;
    const result = await requestMacProbeLease(c.env, {
      provider,
      holderId,
      ttlSec,
      fmpSlot,
    });
    return c.json({ ok: true, action, provider, ...result });
  });

  r.post('/mac-heartbeat', async (c) => {
    const denied = await requireIngestToken(c);
    if (denied) return denied;
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const worker = typeof body.worker === 'string' ? body.worker.trim() : 'mac-host';
    const nowIso = new Date().toISOString();
    const payload = {
      worker,
      status: body.status || 'ok',
      uptimeSeconds: typeof body.uptimeSeconds === 'number' ? body.uptimeSeconds : null,
      activeJobs: typeof body.activeJobs === 'number' ? body.activeJobs : null,
      lastFiling: typeof body.lastFiling === 'string' ? body.lastFiling : null,
      timestamp: nowIso,
    };
    if (c.env.CONFIG_KV) {
      await c.env.CONFIG_KV.put(`mac-heartbeat:${worker}`, JSON.stringify(payload), { expirationTtl: 1800 });
    }
    return c.json({ ok: true, worker, timestamp: nowIso });
  });

  r.post('/latency-payload', async (c) => {
    // Owner 2026-09-09: the Mac scout that used to POST here is retired
    // (board `ba688ea5`).  Kept as a typed no-op so any in-flight Mac
    // client gets a clean 410 Gone instead of a 500, and so historical
    // telemetry replays still land in KV via the underlying call.  New
    // server-side FMP probes never call this endpoint.
    return c.json(
      {
        ok: false,
        deprecated: true,
        error:
          'POST /api/scout/latency-payload is deprecated — the Mac scout was retired 2026-09-09.  ' +
          'FMP latency is now probed by the server.  See docs/rollouts/2026-09-09-fmp-server-and-residential-mango.md.',
      },
      410,
    );
  });

  r.post('/raw', async (c) => {
    const denied = await requireIngestToken(c);
    if (denied) return denied;
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const docId = typeof body.docId === 'string' && body.docId.trim() ? body.docId.trim() : null;
    const b64 = typeof body.bytesBase64 === 'string' ? body.bytesBase64 : null;
    if (!docId || !b64) {
      return c.json({ error: 'docId and bytesBase64 are required' }, 400);
    }
    let bytes: Uint8Array;
    try {
      bytes = decodeBase64Bytes(b64);
    } catch (err) {
      return c.json({ error: `invalid base64: ${(err as Error).message}` }, 400);
    }
    if (bytes.byteLength === 0) return c.json({ error: 'empty payload' }, 400);
    if (bytes.byteLength > MAX_RAW_FILING_BYTES) {
      return c.json({ error: `payload exceeds ${MAX_RAW_FILING_BYTES} byte limit` }, 413);
    }
    if (isSenateAgreementWallBytes(bytes)) {
      return c.json({ error: 'payload looks like Senate agreement wall HTML, not a filing' }, 400);
    }

    const filing = await get<{
      doc_id: string;
      raw_object_key: string | null;
      ingest_status: string | null;
    }>(c.env.DB, `SELECT doc_id, raw_object_key, ingest_status FROM filings WHERE doc_id = ?`, [docId]);
    if (!filing) {
      return c.json({ error: `unknown docId ${docId}; POST /api/ingest/detection first` }, 404);
    }

    const contentType =
      typeof body.contentType === 'string' && body.contentType.trim()
        ? body.contentType.trim()
        : bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46
          ? 'application/pdf'
          : 'application/octet-stream';
    const key = rawKeyFor(docId);
    if (!c.env.RAW_FILES) {
      return c.json({ error: 'RAW_FILES binding unavailable' }, 503);
    }
    await c.env.RAW_FILES.put(key, bytes, {
      httpMetadata: { contentType },
    });
    await run(
      c.env.DB,
      `UPDATE filings
          SET raw_object_key = ?, ingest_status = 'fetched', error = NULL
        WHERE doc_id = ?`,
      [key, docId],
    );
    let enqueued = false;
    try {
      await c.env.INGEST_QUEUE.send({ type: 'filing.fetched', docId });
      enqueued = true;
    } catch (err) {
      console.warn('scout raw enqueue filing.fetched failed', docId, (err as Error).message);
    }
    return c.json({
      ok: true,
      docId,
      rawObjectKey: key,
      bytes: bytes.byteLength,
      contentType,
      enqueued,
      previousStatus: filing.ingest_status,
    });
  });

  r.post('/detection', async (c) => {
    const denied = await requireIngestToken(c);
    if (denied) return denied;

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }

    const chamber = body.source === 'senate' ? 'senate' : body.source === 'house' ? 'house' : null;
    const docKey = typeof body.docKey === 'string' && body.docKey.trim() ? body.docKey.trim() : null;
    if (!chamber || !docKey) {
      return c.json({ error: "source ('house'|'senate') and docKey are required" }, 400);
    }
    const detectedAt =
      typeof body.detectedAt === 'string' && !Number.isNaN(Date.parse(body.detectedAt))
        ? new Date(body.detectedAt).toISOString()
        : new Date().toISOString();

    const filerName = typeof body.filerName === 'string' && body.filerName.trim()
      ? body.filerName.trim()
      : null;
    const sourceUrl = typeof body.link === 'string' ? body.link.trim() : '';

    let houseId: string | null = null;
    if (chamber === 'house') {
      const first = typeof body.first === 'string' ? body.first.trim() : (typeof body.firstName === 'string' ? body.firstName.trim() : '');
      const last = typeof body.last === 'string' ? body.last.trim() : (typeof body.lastName === 'string' ? body.lastName.trim() : '');
      const stateDst = typeof body.stateDst === 'string' ? body.stateDst.trim() : (typeof body.district === 'string' ? body.district.trim() : '');

      let fName = first;
      let lName = last;
      if (!fName && !lName && filerName) {
        if (filerName.includes(',')) {
          const parts = filerName.split(',');
          lName = parts[0].trim();
          fName = parts.slice(1).join(',').trim();
        } else {
          fName = filerName;
        }
      }
      houseId = houseFilerId(fName, lName, stateDst);
    }

    const filing: DiscoveredFiling = {
      docId: docKey,
      chamber,
      sourceUrl,
      filedDate: typeof body.filedDate === 'string' ? body.filedDate : null,
      filerName,
      filerId: chamber === 'senate' ? senateFilerId(filerName) : (chamber === 'house' ? houseId : null),
    };

    // Default ON when a source URL is present so a residential scout push is
    // an official discovery, not just a latency stamp. Callers can set
    // `ingest: false` for pure measurement cycles.
    const wantIngest = body.ingest === true || (body.ingest !== false && Boolean(sourceUrl));

    let insert: InsertFilingResult | 'skipped' = 'skipped';
    let enqueued = false;
    if (wantIngest) {
      if (!sourceUrl) {
        return c.json({ error: 'link is required when ingest is enabled' }, 400);
      }
      try {
        const headRes = await trackedFetch(
          sourceUrl,
          {
            method: 'HEAD',
            headers: {
              'user-agent': 'congress-feed/0.1 (+https://congress.trade)',
              accept: chamber === 'senate' ? 'text/html,application/pdf,*/*' : 'application/pdf,*/*',
            },
          },
          { service: 'filing-ingestion', operation: 'head-validate-detection' },
        ).catch(() => null);

        // 404 is deliberately NOT in this pass-through list (autonomy fix
        // 2026-08-09): a definitively-missing document must be rejected here,
        // before insertFilingIfNew ever runs. Root cause of the prod
        // 2026-07-30 phantom-filing burst — the external detection scout's
        // speculative "frontier probe" feature guesses sequential doc IDs
        // ahead of the confirmed max and POSTs each guess here; a HEAD 404
        // used to pass validation, so every guessed ID that didn't exist got
        // written to filings anyway (900 rows, doc_id range
        // 20035076-20035975). 403 stays allowed: the Clerk/eFD WAF answers
        // request bursts with short-lived 403s unrelated to whether the
        // document exists (see fetcher.ts's identical exception).
        if (
          headRes &&
          !headRes.ok &&
          headRes.status !== 304 &&
          headRes.status !== 405 &&
          headRes.status !== 403
        ) {
          return c.json({ error: `HEAD validation failed: sourceUrl returned HTTP ${headRes.status}` }, 400);
        }
        const contentType = headRes?.headers?.get?.('content-type') ?? '';
        if (contentType && !/application\/pdf|text\/html|application\/octet-stream/i.test(contentType)) {
          return c.json({ error: `HEAD validation failed: invalid content-type '${contentType}'` }, 400);
        }
        filing.docKind = preclassifyDocKind(sourceUrl, chamber, contentType);
      } catch (err) {
        return c.json({ error: `HEAD validation failed: ${(err as Error).message}` }, 400);
      }

      try {
        const prevProbeAt =
          typeof body.prevProbeAt === 'string' && body.prevProbeAt.trim()
            ? body.prevProbeAt.trim()
            : typeof body.prevCheckedAt === 'string' && body.prevCheckedAt.trim()
            ? body.prevCheckedAt.trim()
            : null;
        const probeIntervalSec =
          typeof body.probeIntervalSec === 'number' && Number.isFinite(body.probeIntervalSec)
            ? Math.max(0, Math.round(body.probeIntervalSec))
            : null;
        insert = await insertFilingIfNew(c.env, filing, detectedAt, { prevProbeAt, probeIntervalSec });
      } catch (err) {
        return c.json({ error: (err as Error).message }, 500);
      }
      if (insert === 'deferred') {
        // Governor-capped; scout should retry on the next cycle (posted stays false).
        return c.json({ ok: false, error: 'deferred', reason: 'd1_write_governor', docKey, detectedAt }, 503);
      }
      if (insert === 'inserted') {
        try {
          enqueued = await enqueueFilingNew(c.env, filing);
        } catch (err) {
          // Row is durable in filings + outbox; enqueue failure is retried by
          // the scheduled outbox flush. Still stamp latency below.
          console.warn('detection enqueue failed', docKey, (err as Error).message);
        }
      }
    }

    try {
      await recordDisclosureLatencyCandidate(c.env, filing, detectedAt);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
    return c.json({ ok: true, docKey, detectedAt, insert, enqueued });
  });

  return r;
}
