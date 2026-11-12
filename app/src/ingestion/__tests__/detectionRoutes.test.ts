import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const insertFilingIfNew = vi.fn();
const enqueueFilingNew = vi.fn();

vi.mock('../watcher.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../watcher.ts')>();
  return {
    ...actual,
    insertFilingIfNew: (...args: unknown[]) => insertFilingIfNew(...args),
    enqueueFilingNew: (...args: unknown[]) => enqueueFilingNew(...args),
  };
});

const recordDisclosureLatencyCandidate = vi.fn(async () => undefined);
const ingestScoutLatencyPayload = vi.fn(async () => ({
  upserted: 2,
  matched: 0,
  pending: 1,
  errors: [],
  provider: 'fmp',
}));
vi.mock('../tradeLatency.ts', () => ({
  recordDisclosureLatencyCandidate: (...args: unknown[]) => recordDisclosureLatencyCandidate(...args),
  ingestScoutLatencyPayload: (...args: unknown[]) => ingestScoutLatencyPayload(...args),
}));

const buildScoutPlan = vi.fn(async () => ({
  generatedAt: '2026-08-10T12:00:00.000Z',
  latency: [],
  latencyNeedScout: [{ provider: 'fmp', needScout: true, needScoutReason: 'quiet 87h' }],
  rawFetch: [],
  notes: ['Filing storage is Cloudflare R2 (RAW_FILES), not Backblaze.'],
}));
vi.mock('../scoutHandoff.ts', () => ({
  buildScoutPlan: (...args: unknown[]) => buildScoutPlan(...args),
}));

import { buildDetectionRouter } from '../detectionRoutes.ts';

const app = buildDetectionRouter();
const okDb = {
  prepare: () => ({
    bind: () => ({ run: async () => ({ meta: {} }), all: async () => ({ results: [] }), first: async () => null }),
  }),
};
const rawPuts: Array<{ key: string; bytes: number }> = [];
const env = {
  INGEST_TOKEN: 'ingest-secret',
  DB: okDb,
  RAW_FILES: {
    put: async (key: string, bytes: Uint8Array) => {
      rawPuts.push({ key, bytes: bytes.byteLength });
    },
  },
  INGEST_QUEUE: {
    send: async () => undefined,
  },
} as unknown as Record<string, unknown>;

function post(token: string | null, body: unknown) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return app.request('/detection', { method: 'POST', headers, body: JSON.stringify(body) }, env as never);
}

function authGet(path: string, token: string | null) {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  return app.request(path, { method: 'GET', headers }, env as never);
}

function authPost(path: string, token: string | null, body: unknown) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return app.request(path, { method: 'POST', headers, body: JSON.stringify(body) }, env as never);
}

describe('POST /api/ingest/detection', () => {
  beforeEach(() => {
    insertFilingIfNew.mockReset();
    enqueueFilingNew.mockReset();
    recordDisclosureLatencyCandidate.mockClear();
    insertFilingIfNew.mockResolvedValue('inserted');
    enqueueFilingNew.mockResolvedValue(true);
  });

  // Belt-and-suspenders for every `vi.stubGlobal('fetch', ...)` below: if an
  // assertion throws between the stub and its manual `vi.unstubAllGlobals()`,
  // the stub would otherwise leak into the next test. A no-op when nothing
  // was stubbed.
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('401 without a token', async () => {
    expect((await post(null, { source: 'house', docKey: 'H-2026-1' })).status).toBe(401);
  });

  it('401 with a wrong token', async () => {
    expect((await post('nope', { source: 'house', docKey: 'H-2026-1' })).status).toBe(401);
  });

  it('400 when source or docKey is missing/invalid', async () => {
    expect((await post('ingest-secret', { source: 'house' })).status).toBe(400);
    expect((await post('ingest-secret', { docKey: 'H-2026-1' })).status).toBe(400);
    expect((await post('ingest-secret', { source: 'nope', docKey: 'H-2026-1' })).status).toBe(400);
  });

  it('records latency and ingests a new filing by default when link is present', async () => {
    // Stub HEAD validation instead of hitting the real efdsearch.senate.gov
    // (same reasoning as the house/403/404 stubs below): this test asserts
    // ingest wiring, not live reachability of a third-party .gov host. Left
    // unmocked, three tests here made a genuine outbound HTTPS HEAD request
    // apiece with no timeout of their own, racing vitest's 5000ms default --
    // flaky under CI's parallel workers precisely because more workers means
    // more simultaneous real requests to that one external host.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 200, headers: { 'content-type': 'text/html' } })),
    );
    const res = await post('ingest-secret', {
      source: 'senate',
      docKey: 'S-abc123',
      link: 'https://efdsearch.senate.gov/search/view/ptr/abc123/',
      filerName: 'Jane Doe',
      detectedAt: '2026-07-01T00:00:00.000Z',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      docKey: string;
      detectedAt: string;
      insert: string;
      enqueued: boolean;
    };
    expect(body).toMatchObject({
      ok: true,
      docKey: 'S-abc123',
      detectedAt: '2026-07-01T00:00:00.000Z',
      insert: 'inserted',
      enqueued: true,
    });
    expect(insertFilingIfNew).toHaveBeenCalledTimes(1);
    const filing = insertFilingIfNew.mock.calls[0][1] as {
      docId: string;
      chamber: string;
      filerId: string | null;
      sourceUrl: string;
    };
    expect(filing).toMatchObject({
      docId: 'S-abc123',
      chamber: 'senate',
      filerId: 'senate-jane-doe',
      sourceUrl: 'https://efdsearch.senate.gov/search/view/ptr/abc123/',
    });
    expect(enqueueFilingNew).toHaveBeenCalledTimes(1);
    expect(recordDisclosureLatencyCandidate).toHaveBeenCalledTimes(1);
  });

  it('computes houseFilerId for House filings using houseFilerId(first, last, stateDst)', async () => {
    // Stub HEAD validation to a real 200: this fixture docId does not
    // actually exist at the Clerk, and 404 is (correctly, as of the
    // 2026-08-09 autonomy fix) no longer a HEAD-validation pass-through —
    // this test is about houseFilerId derivation, not HEAD-status handling,
    // so it must not depend on live network reachability of the fixture URL.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 200, headers: { 'content-type': 'application/pdf' } })));
    const res = await post('ingest-secret', {
      source: 'house',
      docKey: 'H-2024-20024115',
      link: 'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2024/20024115.pdf',
      filerName: 'Pelosi, Nancy',
      stateDst: 'CA11',
      detectedAt: '2026-07-01T00:00:00.000Z',
    });
    expect(res.status).toBe(200);
    vi.unstubAllGlobals();
    expect(insertFilingIfNew).toHaveBeenCalledTimes(1);
    const filing = insertFilingIfNew.mock.calls[0][1] as {
      docId: string;
      chamber: string;
      filerId: string | null;
    };
    expect(filing).toMatchObject({
      docId: 'H-2024-20024115',
      chamber: 'house',
      filerId: 'house-ca11-nancy-pelosi',
    });
  });

  it('skips pipeline ingest when ingest:false (latency-only measurement)', async () => {
    const res = await post('ingest-secret', {
      source: 'house',
      docKey: 'H-2026-99',
      link: 'https://example.com/ptr.pdf',
      ingest: false,
      detectedAt: '2026-07-01T00:00:00.000Z',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { insert: string; enqueued: boolean };
    expect(body.insert).toBe('skipped');
    expect(body.enqueued).toBe(false);
    expect(insertFilingIfNew).not.toHaveBeenCalled();
    expect(enqueueFilingNew).not.toHaveBeenCalled();
    expect(recordDisclosureLatencyCandidate).toHaveBeenCalledTimes(1);
  });

  it('does not re-enqueue duplicates', async () => {
    // See the stub note above -- HEAD validation still runs for this
    // link-bearing request even though insertFilingIfNew short-circuits it,
    // so this must not depend on live efdsearch.senate.gov reachability.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 200, headers: { 'content-type': 'text/html' } })),
    );
    insertFilingIfNew.mockResolvedValueOnce('duplicate');
    const res = await post('ingest-secret', {
      source: 'senate',
      docKey: 'S-dup',
      link: 'https://efdsearch.senate.gov/search/view/ptr/dup/',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { insert: string; enqueued: boolean };
    expect(body.insert).toBe('duplicate');
    expect(body.enqueued).toBe(false);
    expect(enqueueFilingNew).not.toHaveBeenCalled();
  });

  it('rejects a frontier-probe guess whose HEAD is a definitive 404 (autonomy fix 2026-08-09)', async () => {
    // Root cause of the prod 2026-07-30 phantom-filing burst (900 rows,
    // doc_id 20035076-20035975): 404 used to be a HEAD-validation
    // pass-through, so a scout guess for a doc_id that does not exist yet
    // got written to filings anyway. It must now be rejected before
    // insertFilingIfNew ever runs.
    const fetchMock = vi.fn(async () => new Response(null, { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await post('ingest-secret', {
      source: 'house',
      docKey: 'H-2026-20035999',
      link: 'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20035999.pdf',
      detectedAt: '2026-07-30T15:45:00.000Z',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/HEAD validation failed.*404/);
    expect(insertFilingIfNew).not.toHaveBeenCalled();
    expect(enqueueFilingNew).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('still allows 403 (WAF burst) through HEAD validation', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await post('ingest-secret', {
      source: 'house',
      docKey: 'H-2026-20035050',
      link: 'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20035050.pdf',
    });
    expect(res.status).toBe(200);
    expect(insertFilingIfNew).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('returns 503 when the D1 write governor defers the insert', async () => {
    // See the stub note above -- HEAD validation still runs before the
    // governor's deferral is observed, so this must not depend on live
    // efdsearch.senate.gov reachability.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 200, headers: { 'content-type': 'text/html' } })),
    );
    insertFilingIfNew.mockResolvedValueOnce('deferred');
    const res = await post('ingest-secret', {
      source: 'senate',
      docKey: 'S-def',
      link: 'https://efdsearch.senate.gov/search/view/ptr/def/',
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body).toMatchObject({ ok: false, error: 'deferred' });
    expect(enqueueFilingNew).not.toHaveBeenCalled();
  });
});

describe('GET /api/ingest/scout-plan + POST latency-payload + raw', () => {
  beforeEach(() => {
    buildScoutPlan.mockClear();
    ingestScoutLatencyPayload.mockClear();
    rawPuts.length = 0;
  });

  it('401 without token on scout-plan', async () => {
    expect((await authGet('/scout-plan', null)).status).toBe(401);
  });

  it('returns handoff plan for the residential scout', async () => {
    const res = await authGet('/scout-plan', 'ingest-secret');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      latencyNeedScout: Array<{ provider: string }>;
      notes: string[];
    };
    expect(body.ok).toBe(true);
    expect(body.latencyNeedScout[0]?.provider).toBe('fmp');
    expect(body.notes.join(' ')).toMatch(/R2/);
  });

  it('rejects scout latency payloads with 410 Gone (scout retired 2026-09-09)', async () => {
    // The Mac scout that POSTed here is retired and the server probes FMP
    // itself now.  The route stays mounted so an in-flight Mac client gets a
    // clean, explanatory 410 rather than a 500 — and, importantly, so a stray
    // payload can no longer write latency observations into KV.
    const res = await authPost('/latency-payload', 'ingest-secret', {
      provider: 'fmp',
      fmpPathId: 'stable',
      chamberJson: { house: [{ name: 'A' }], senate: [] },
    });
    expect(res.status).toBe(410);
    expect(ingestScoutLatencyPayload).not.toHaveBeenCalled();
    const body = (await res.json()) as { ok: boolean; deprecated: boolean; error: string };
    expect(body).toMatchObject({ ok: false, deprecated: true });
    expect(body.error).toMatch(/retired/);
  });

  it('stores residential raw bytes in R2 for a known filing', async () => {
    // %PDF magic so content-type sniff works
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a]);
    const b64 = Buffer.from(pdf).toString('base64');
    const filingDb = {
      prepare: () => ({
        bind: (...params: unknown[]) => ({
          first: async () =>
            params[0] === 'H-2026-1'
              ? { doc_id: 'H-2026-1', raw_object_key: null, ingest_status: 'discovered' }
              : null,
          run: async () => ({ meta: {} }),
          all: async () => ({ results: [] }),
        }),
      }),
    };
    const envWithFiling = { ...env, DB: filingDb };
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      Authorization: 'Bearer ingest-secret',
    };
    const res = await app.request(
      '/raw',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ docId: 'H-2026-1', bytesBase64: b64, contentType: 'application/pdf' }),
      },
      envWithFiling as never,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; rawObjectKey: string; bytes: number };
    expect(body.ok).toBe(true);
    expect(body.rawObjectKey).toBe('raw/H-2026-1');
    expect(body.bytes).toBe(pdf.byteLength);
    expect(rawPuts.some((p) => p.key === 'raw/H-2026-1')).toBe(true);
  });
});
