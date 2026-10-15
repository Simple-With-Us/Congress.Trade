import { describe, it, expect, afterEach, vi } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import {
  allSuccessfulReadsEmpty,
  handleAgreementCheck,
  processAgreementCascadeTier2,
  processAgreementDoc,
  type AgreementModelsC,
} from '../agreement.ts';
import type { CandidateDocResult } from '../bakeoff.ts';

/** A genuinely-parseable PDF: the Anthropic candidate pre-validates bytes
 *  with pdf-lib (normalizePdfForAnthropic) before any provider call. */
async function validPdfArrayBuffer(): Promise<ArrayBuffer> {
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 200]);
  const bytes = await pdf.save();
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** A 278-T PDF whose text layer holds one real transaction row: the
 *  deterministic ogeText parser must recover it from a zero-read settlement. */
async function executiveRowsPdfArrayBuffer(): Promise<ArrayBuffer> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const lines = [
    '# DESCRIPTION TYPE DATE NOTIFICATION RECEIVED OVER 30 DAYS AGO AMOUNT',
    '1 Apple Inc. (AAPL) Purchase 01/05/2026 No $1,001 - $15,000',
  ];
  lines.forEach((line, i) => page.drawText(line, { x: 36, y: 740 - i * 14, size: 10, font }));
  const bytes = await pdf.save();
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/**
 * Tiered agreement cascade (money path). Exercises the escalation ladder end to
 * end with a scenario-driven in-memory D1 fake:
 *   Tier 1  A + B unanimous  → publish (regression: unchanged behavior).
 *   Tier 1  A + B disagree   → enqueue an escalationTier:2 check (attempt cap
 *                              permitting); at the cap, leave in human review.
 *   Tier 2  A + B + C unanimous → publish.
 *   Tier 3  2-of-3 majority with per-field majority on type/date/amount → publish
 *                              with a resolvedBy:'agreement-cascade' audit row.
 *   Tier 3  no amount-bracket majority → do NOT publish (human review).
 *   Tier 3  hard-fail flag on the majority set → do NOT publish (human review).
 * Providers are stubbed via global.fetch; models are pinned to openai (A),
 * anthropic (B), mistral (C) so each provider maps to one candidate.
 */

// --- Row + response helpers ------------------------------------------------
const row = (
  ticker: string,
  txType: string,
  amountRange: string | null,
  extra: Record<string, unknown> = {},
) => ({
  ticker,
  assetName: `${ticker} Inc.`,
  txDate: '2026-06-19',
  txType,
  amountRange,
  isOption: false,
  capGainsOver200: false,
  confidence: 0.9,
  ...extra,
});
const asJson = (rows: unknown[]) => JSON.stringify(rows);

const AB = '$1,001 - $15,000';
const AB2 = '$15,001 - $50,000';
const AB3 = '$50,001 - $100,000';

/** Stub openai (A) / anthropic (B) / mistral (C) with per-provider payloads. */
function stub(openai: string, anthropic: string, mistral?: string) {
  const seen: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes('api.openai.com')) { seen.push('openai'); return { ok: true, json: async () => ({ output_text: openai, choices: [{ message: { content: openai } }] }) } as unknown as Response; }
    if (u.includes('api.anthropic.com')) { seen.push('anthropic'); return { ok: true, json: async () => ({ content: [{ type: 'text', text: anthropic }] }) } as unknown as Response; }
    if (u.includes('api.mistral.ai') && mistral) { seen.push('mistral'); return { ok: true, json: async () => ({ document_annotation: mistral }) } as unknown as Response; }
    return { ok: false, status: 404, text: async () => 'nope' } as unknown as Response;
  }));
  return seen;
}

interface Captured {
  inserted: unknown[][];
  resolved: string[];
  sent: unknown[];
  reviewFlags: Array<{ reason: unknown; payload: unknown }>;
  decisions: Array<{ action: unknown; source: unknown; reason: unknown; payload: Record<string, unknown> | null }>;
}

function makeEnv(opts: { pageCount?: number | null; rawBytes?: number | null; priorAttempts?: number; maxAttempts?: string; env?: Record<string, unknown>; rawDocBytes?: ArrayBuffer } = {}) {
  const cap: Captured = { inserted: [], resolved: [], sent: [], reviewFlags: [], decisions: [] };
  const review = {
    resolved: 0,
    attempts: opts.priorAttempts ?? 0,
    tier: null as number | null,
    nextAttemptAt: null as string | null,
    claimToken: null as string | null,
    claimedAt: null as string | null,
    revision: 1,
  };
  const db = {
    prepare(sql: string) {
      return {
        params: [] as unknown[],
        bind(...p: unknown[]) { this.params = p; return this; },
        async first<T>() {
          if (/SELECT doc_id, chamber, filer_id/i.test(sql)) {
            const docId = String(this.params[0]);
            const executive = docId.startsWith('E-');
            return { doc_id: docId, chamber: executive ? 'executive' : 'house', filer_id: 'P1', filing_type: 'P', filed_date: '2026-06-20', source_url: 'u', raw_object_key: 'raw/x', ingest_status: 'needs_review', doc_kind: executive ? 'text_pdf' : 'scanned_pdf', extractor: executive ? 'ogeText' : null, model_version: null, confidence: null, first_seen_at: '2026-06-20', source_updated_at: null, error: null } as T;
          }
          if (/SELECT page_count, raw_bytes FROM filings/i.test(sql)) {
            return { page_count: opts.pageCount ?? null, raw_bytes: opts.rawBytes ?? null } as T;
          }
          if (/SELECT resolved, agreement_attempts, agreement_tier/i.test(sql)) {
            return {
              resolved: review.resolved,
              agreement_attempts: review.attempts,
              agreement_tier: review.tier,
              agreement_next_attempt_at: review.nextAttemptAt,
              agreement_claim_token: review.claimToken,
              agreement_claimed_at: review.claimedAt,
              agreement_suppressed_at: null,
              agreement_suppression_reason: null,
              review_revision: review.revision,
              payload: null,
            } as T;
          }
          if (/SELECT payload, review_revision FROM review_queue/i.test(sql)) {
            return { payload: null, review_revision: review.revision } as T;
          }
          if (/SELECT review_revision, resolved FROM review_queue/i.test(sql)) {
            return { review_revision: review.revision, resolved: review.resolved } as T;
          }
          if (/SELECT review_revision FROM review_queue/i.test(sql)) {
            return { review_revision: review.revision } as T;
          }
          return null as T | null;
        },
        async all<T>() {
          return { results: [] as T[] };
        },
        async run() {
          if (/SET agreement_attempts = \?,\s*agreement_tier = \?/i.test(sql)) {
            const [nextAttempts, tier, , token, claimedAt, , expectedToken, observedAttempts, max] = this.params as [number, number, string, string, string, string, string, number, number];
            if (review.resolved === 0 && review.claimToken === expectedToken && review.attempts === observedAttempts && review.attempts < max) {
              review.attempts = nextAttempts;
              review.tier = tier;
              review.claimToken = token;
              review.claimedAt = claimedAt;
              review.nextAttemptAt = null;
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 0 } };
          }
          if (/SET agreement_claimed_at = \?, agreement_next_attempt_at = NULL/i.test(sql)) {
            const [claimedAt, , expectedToken, max] = this.params as [string, string, string, number];
            if (review.resolved === 0 && review.claimToken === expectedToken && review.attempts < max) {
              review.claimedAt = claimedAt;
              review.nextAttemptAt = null;
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 0 } };
          }
          if (/SET agreement_claim_token = \?, agreement_claimed_at = \?, agreement_next_attempt_at = NULL/i.test(sql)) {
            const [token, claimedAt, , max] = this.params as [string, string, string, number];
            if (review.resolved === 0 && review.attempts < max && review.claimToken === null) {
              review.claimToken = token;
              review.claimedAt = claimedAt;
              review.nextAttemptAt = null;
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 0 } };
          }
          if (/SET agreement_claim_token = \?, agreement_claimed_at = \?/i.test(sql)) {
            const [token, claimedAt, , expected] = this.params as [string, string, string, string];
            if (review.resolved === 0 && (review.claimToken === expected || review.claimToken === null)) {
              review.claimToken = token;
              review.claimedAt = claimedAt;
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 0 } };
          }
          if (/INSERT (?:OR IGNORE )?INTO transactions/i.test(sql)) {
            const guardToken = String(this.params[this.params.length - 1]);
            if (review.resolved === 0 && review.claimToken === guardToken) {
              cap.inserted.push(this.params);
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 0 } };
          }
          else if (/INSERT INTO ingestion_decisions/i.test(sql)) {
            // (id, doc_id, action, source, actor, reason, payload, transaction_ids, created_at)
            const payloadRaw = this.params[6];
            cap.decisions.push({
              action: this.params[2], source: this.params[3], reason: this.params[5],
              payload: typeof payloadRaw === 'string' ? JSON.parse(payloadRaw) : null,
            });
          } else if (/UPDATE review_queue\s+SET reason/i.test(sql)) {
            const expectedToken = /agreement_claim_token = \?/i.test(sql) ? this.params[3] : undefined;
            if (review.resolved === 0 && (expectedToken === undefined || expectedToken === review.claimToken)) {
              review.revision += 1;
              cap.reviewFlags.push({ reason: this.params[0], payload: typeof this.params[1] === 'string' ? JSON.parse(this.params[1] as string) : this.params[1] });
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 0 } };
          } else if (/SET resolved = 1,/i.test(sql)) {
            const [docId, expectedToken] = this.params as [string, string];
            if (review.resolved === 0 && review.claimToken === expectedToken) {
              review.resolved = 1;
              review.claimToken = null;
              review.claimedAt = null;
              review.revision += 1;
              cap.resolved.push(docId);
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 0 } };
          } else if (/agreement_claim_token = NULL/i.test(sql)) {
            const expectedToken = String(this.params[this.params.length - 1]);
            if (review.claimToken === expectedToken) {
              if (/agreement_attempts = MAX\(COALESCE/i.test(sql)) review.attempts = Math.max(review.attempts, Number(this.params[0]));
              review.claimToken = null;
              review.claimedAt = null;
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 0 } };
          }
          return { success: true, meta: { changes: 1 } };
        },
      };
    },
    async batch(statements: Array<{ run(): Promise<unknown> }>) {
      return Promise.all(statements.map((statement) => statement.run()));
    },
  } as unknown as D1Database;

  const env = {
    AGREEMENT_AUTOPUBLISH_ENABLED: 'true',
    AGREEMENT_HOUSE_MODEL_C: 'openai:gpt-4o',
    AGREEMENT_HOUSE_MODEL_D: 'anthropic:claude-sonnet-5',
    AGREEMENT_HOUSE_MODEL_E: 'mistral:mistral-ocr-latest',
    AGREEMENT_MAX_ATTEMPTS: opts.maxAttempts,
    OPENAI_API_KEY: 'k', ANTHROPIC_API_KEY: 'k', MISTRAL_API_KEY: 'k',
    DB: db,
    RAW_FILES: {
      get: async () => ({
        arrayBuffer: opts.rawDocBytes ? async () => opts.rawDocBytes : validPdfArrayBuffer,
      }),
    },
    INGEST_QUEUE: { send: async (m: unknown) => { cap.sent.push(m); } },
    DELIVERY_QUEUE: { send: async () => {}, sendBatch: async () => {} },
    ...(opts.env ?? {}),
  } as never;
  return { env, cap, review };
}

const MODELS_C: AgreementModelsC = {
  a: { provider: 'openai', model: 'gpt-5.6-terra' },
  b: { provider: 'anthropic', model: 'claude-sonnet-5' },
  c: { provider: 'mistral', model: 'mistral-ocr-latest' },
};

describe('allSuccessfulReadsEmpty', () => {
  const emptyOk = { ok: true, rows: [], rowCount: 0 } as unknown as CandidateDocResult;
  const withRows = {
    ok: true,
    rows: [{ ticker: 'AAPL' }],
    rowCount: 1,
  } as unknown as CandidateDocResult;
  const failed = { ok: false, rows: [], rowCount: 0, error: 'x' } as unknown as CandidateDocResult;

  it('is true only when every read ok and empty', () => {
    expect(allSuccessfulReadsEmpty([emptyOk, emptyOk])).toBe(true);
    expect(allSuccessfulReadsEmpty([emptyOk, withRows])).toBe(false);
    expect(allSuccessfulReadsEmpty([emptyOk, failed])).toBe(false);
    expect(allSuccessfulReadsEmpty([])).toBe(false);
  });
});

describe('agreement cascade — tier 1', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('tier-1 unanimous publishes (regression)', async () => {
    stub(asJson([row('AAPL', 'B', AB)]), asJson([row('AAPL', 'B', AB)]));
    const { env, cap } = makeEnv();
    await handleAgreementCheck(env, 'H-1', 'raw/H-1'); // no tier → tier 1
    expect(cap.inserted).toHaveLength(1);
    expect(cap.resolved).toContain('H-1');
    expect(cap.sent).toHaveLength(0); // agreed → no escalation
  });

  it('tier-1 disagreement enqueues an escalationTier:2 check (under the cap)', async () => {
    stub(asJson([row('AAPL', 'B', AB)]), asJson([row('MSFT', 'S', AB)]));
    const { env, cap } = makeEnv();
    await handleAgreementCheck(env, 'H-2', 'raw/H-2');
    expect(cap.inserted).toHaveLength(0);
    expect(cap.sent).toEqual([
      expect.objectContaining({
        type: 'agreement.check', docId: 'H-2', rawObjectKey: 'raw/H-2', escalationTier: 2,
        claimToken: expect.any(String),
      }),
    ]);
  });

  it('stops escalating and flags human review once AGREEMENT_MAX_ATTEMPTS is reached', async () => {
    stub(asJson([row('AAPL', 'B', AB)]), asJson([row('MSFT', 'S', AB)]));
    const { env, cap } = makeEnv({ maxAttempts: '1' }); // first attempt already at the cap
    await handleAgreementCheck(env, 'H-3', 'raw/H-3');
    expect(cap.sent).toHaveLength(0); // no escalation
    expect(cap.inserted).toHaveLength(0);
    expect(cap.reviewFlags).toHaveLength(1);
    expect(cap.reviewFlags[0].reason).toBe('agreement_cascade_unresolved');
  });

  it('empty×empty is extract_empty_failure hard fail — no tier-2 escalation', async () => {
    stub(asJson([]), asJson([]));
    const { env, cap, review } = makeEnv();
    const res = await handleAgreementCheck(env, 'H-empty', 'raw/H-empty');
    expect(res).toMatchObject({
      outcome: 'agree_but_hardfail',
      reason: 'extract_empty_failure',
      flags: expect.arrayContaining(['extract_empty_failure']),
    });
    expect(cap.sent).toHaveLength(0); // must NOT escalate
    expect(cap.inserted).toHaveLength(0);
    const emptyDecision = cap.decisions.find((d) => d.action === 'extract_empty_failure');
    expect(emptyDecision).toBeTruthy();
    expect(emptyDecision?.reason).toBe('extract_empty_failure');
    // finishTerminalClaim must still match the claim and pin attempts at the cap
    // (default AGREEMENT_MAX_ATTEMPTS = 3) so autopilot cannot re-burn empty docs.
    expect(review.claimToken).toBeNull();
    expect(review.attempts).toBeGreaterThanOrEqual(3);
    expect(cap.reviewFlags.some((f) => f.reason === 'extract_empty_failure')).toBe(true);
  });

  it('executive zero-read settlement routes deterministic rows through normalization', async () => {
    // Both agreement reads come back empty, but the deterministic parser
    // finds a real 278-T row in the stored PDF.  The settlement must route
    // that row through normalization instead of stamping
    // extract_empty_failure over it.
    stub(asJson([]), asJson([]));
    const rawDocBytes = await executiveRowsPdfArrayBuffer();
    const { env, cap } = makeEnv({ rawDocBytes });
    const res = await handleAgreementCheck(env, 'E-2026-jane-doe-01-15-2026-278t', 'raw/x');
    expect(res).toMatchObject({
      reason: 'deterministic_rows_recovered',
      flags: expect.arrayContaining(['deterministic_rows_recovered']),
    });
    expect(res?.outcome).not.toBe('agree_but_hardfail');
    expect(cap.decisions.some((d) => d.action === 'extract_empty_failure')).toBe(false);
    expect(cap.reviewFlags.some((f) => String(f.reason).includes('extract_empty_failure'))).toBe(false);
  });

  it('operator reprocess (processAgreementDoc, non-dry) settles an executive zero-read', async () => {
    // The /agreement-reprocess route calls processAgreementDoc directly with
    // no claim token; its empty path must run the same executive settlement
    // as the tier-1 queue handler instead of stamping extract_empty_failure.
    stub(asJson([]), asJson([]));
    const rawDocBytes = await executiveRowsPdfArrayBuffer();
    const { env, cap } = makeEnv({ rawDocBytes });
    const models = { a: MODELS_C.a, b: MODELS_C.b };
    const res = await processAgreementDoc(
      env, models, 'E-2026-jane-doe-01-15-2026-278t', 'raw/x', false,
    );
    expect(res).toMatchObject({
      reason: 'deterministic_rows_recovered',
      flags: expect.arrayContaining(['deterministic_rows_recovered']),
    });
    expect(res.outcome).not.toBe('agree_but_hardfail');
    expect(cap.decisions.some((d) => d.action === 'extract_empty_failure')).toBe(false);
    expect(cap.reviewFlags.some((f) => String(f.reason).includes('extract_empty_failure'))).toBe(false);
  });

  it('a big doc (page_count over threshold) starts directly at tier 2', async () => {
    const seen = stub(asJson([row('AAPL', 'B', AB)]), asJson([row('AAPL', 'B', AB)]), asJson([row('AAPL', 'B', AB)]));
    const { env, cap } = makeEnv({ pageCount: 20 });
    await handleAgreementCheck(env, 'H-4', 'raw/H-4'); // fresh, but big → tier 2
    expect(seen).toContain('mistral'); // the third model was consulted
    expect(cap.inserted).toHaveLength(1); // 3-way unanimous publish
  });
});

describe('agreement cascade — tier 2 / tier 3', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('3-way unanimous publishes (tier 2)', async () => {
    stub(asJson([row('AAPL', 'B', AB)]), asJson([row('AAPL', 'B', AB)]), asJson([row('AAPL', 'B', AB)]));
    const { env, cap } = makeEnv();
    const res = await processAgreementCascadeTier2(env, MODELS_C, 'H-5', 'raw/H-5', false);
    expect(res).toMatchObject({ outcome: 'published', tier: 2 });
    expect(cap.inserted).toHaveLength(1);
    const decision = cap.decisions.find((d) => d.action === 'agreement_published');
    expect(decision?.payload).toMatchObject({ resolvedBy: 'agreement-cascade', tier: 2, unanimous: true });
  });

  it('2-of-3 majority on every material field publishes with a cascade audit (tier 3)', async () => {
    // Same row identity in all reads; C disagrees on owner, so exact tier-2
    // unanimity fails and tier 3 resolves the 2-of-3 material-field majority.
    stub(
      asJson([row('AAPL', 'B', AB, { owner: 'self' })]),
      asJson([row('AAPL', 'B', AB, { owner: 'self' })]),
      asJson([row('AAPL', 'B', AB, { owner: 'spouse' })]),
    );
    const { env, cap } = makeEnv();
    const res = await processAgreementCascadeTier2(env, MODELS_C, 'H-6', 'raw/H-6', false);
    expect(res).toMatchObject({ outcome: 'published', tier: 3 });
    expect(cap.inserted).toHaveLength(1); // only the majority AAPL row
    const decision = cap.decisions.find((d) => d.action === 'agreement_published');
    expect(decision?.payload).toMatchObject({ resolvedBy: 'agreement-cascade', tier: 3 });
    expect(decision?.payload?.votes).toBeTruthy(); // per-field vote summary present
  });

  it('does not drop a minority-only extra row', async () => {
    stub(
      asJson([row('AAPL', 'B', AB)]),
      asJson([row('AAPL', 'B', AB)]),
      asJson([row('AAPL', 'B', AB), row('MSFT', 'B', AB)]),
    );
    const { env, cap } = makeEnv();
    const res = await processAgreementCascadeTier2(env, MODELS_C, 'H-minority-extra', 'raw/x', false);
    expect(res).toMatchObject({ outcome: 'review_flagged', tier: 3 });
    expect(String(res.reason)).toContain('minority_extra_row');
    expect(cap.inserted).toHaveLength(0);
  });

  it('a majority row WITHOUT an amount-bracket majority does NOT publish (tier 3)', async () => {
    // All three read AAPL but each a different amount.
    stub(
      asJson([row('AAPL', 'B', AB)]),
      asJson([row('AAPL', 'B', AB2)]),
      asJson([row('AAPL', 'B', AB3)]),
    );
    const { env, cap } = makeEnv();
    const res = await processAgreementCascadeTier2(env, MODELS_C, 'H-7', 'raw/H-7', false);
    expect(res.outcome).toBe('review_flagged');
    expect(String(res.reason)).toContain('field_disagreement');
    expect(cap.inserted).toHaveLength(0);
    expect(cap.reviewFlags).toHaveLength(1);
    const decision = cap.decisions.find((d) => d.action === 'review_opened');
    expect(decision?.payload).toMatchObject({ resolvedBy: 'agreement-cascade', priority: 'high', tier: 3 });
  });

  it('soft free-text 1/1/1 (supplementalText) does NOT block publish when material fields agree', async () => {
    // Prod regression H-2026-20035035: 3 models agreed on ticker/date/type/amount/ST
    // but split 1/1/1 on optional supplementalText → cascade_unresolved. Soft
    // free-text is excluded from the material fingerprint, so this can now
    // resolve at tier 2 (3-way material unanimity) instead of parking for a human.
    stub(
      asJson([row('MDT', 'S', AB, {
        owner: 'joint', assetType: 'ST', assetTypeName: 'Stock',
        supplementalText: 'See note A', confidence: 0.55,
      })]),
      asJson([row('MDT', 'S', AB, {
        owner: 'joint', assetType: 'ST', assetTypeName: 'Stocks (including ADRs)',
        supplementalText: 'See note B', confidence: 0.5,
      })]),
      asJson([row('MDT', 'S', AB, {
        owner: 'joint', assetType: 'ST', assetTypeName: null,
        supplementalText: null, confidence: 0.45,
      })]),
    );
    const { env, cap } = makeEnv();
    const res = await processAgreementCascadeTier2(env, MODELS_C, 'H-soft-supp', 'raw/H-soft', false);
    expect(res.outcome).toBe('published');
    expect([2, 3]).toContain(res.tier);
    expect(cap.inserted).toHaveLength(1);
  });

  it('a multi-lot majority row (same key, distinct brackets) is NOT auto-published (tier 3)', async () => {
    // A + B each disclose TWO AAPL purchases the same day (same ticker|date|type,
    // different dollar brackets) — a real multi-lot filing. A also reads an extra
    // TSLA row so the row-set is not 3-way unanimous → tier 3. The consensus key
    // excludes amount, so the second AAPL lot would silently vanish; the guard
    // must leave the whole doc in review instead of publishing an incomplete set.
    stub(
      asJson([row('AAPL', 'B', AB), row('AAPL', 'B', AB3), row('TSLA', 'B', AB)]),
      asJson([row('AAPL', 'B', AB), row('AAPL', 'B', AB3)]),
      asJson([row('AAPL', 'B', AB), row('AAPL', 'B', AB3)]),
    );
    const { env, cap } = makeEnv();
    const res = await processAgreementCascadeTier2(env, MODELS_C, 'H-9', 'raw/H-9', false);
    expect(res.outcome).toBe('review_flagged');
    expect(String(res.reason)).toContain('multi_lot');
    expect(cap.inserted).toHaveLength(0);
    expect(cap.reviewFlags).toHaveLength(1);
  });

  it('a hard-fail flag on the majority set blocks the publish (tier 3)', async () => {
    // A+B agree on a NULL amount (→ no_amount hard-fail); C has a valid bracket.
    stub(asJson([row('AAPL', 'B', null)]), asJson([row('AAPL', 'B', null)]), asJson([row('AAPL', 'B', AB)]));
    const { env, cap } = makeEnv();
    const res = await processAgreementCascadeTier2(env, MODELS_C, 'H-8', 'raw/H-8', false);
    expect(res.outcome).toBe('review_flagged');
    expect(String(res.reason)).toContain('hard_fail');
    expect(cap.inserted).toHaveLength(0);
    expect(cap.reviewFlags).toHaveLength(1);
  });
});

/**
 * Text-field agreement normalization (AGREEMENT_TEXT_NORMALIZATION, default
 * on): production regression shape — every model correctly reads "First Data
 * Corp." but formats it differently (casing/punctuation), which used to make
 * EVERY tier require byte-identical text and left the doc unresolved.
 *
 * NOTE on confidence values: toParsedTx (visionLlm.ts) caps every parsed row's
 * confidence at DEFAULT_CONFIDENCE (0.6) via `Math.min(modelConf, 0.6)` — a
 * pre-existing, deliberate conservative-vision-read policy unrelated to this
 * PR. Any stubbed row confidence >= 0.6 is therefore indistinguishable from
 * any other after parsing; these tests use values below 0.6 so the
 * confidence-preferred selection in resolveAgreedRows/buildMajorityRows is
 * actually exercised instead of silently degenerating to a tie every time.
 */
describe('agreement cascade — text-field normalization', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('tier 1: near-miss text (casing/punctuation only) now agrees, and publishes the higher-confidence model\'s own text — not simply "always A"', async () => {
    // A is listed FIRST (slot order) but has the LOWER confidence; B has the
    // higher confidence. The old code always used A's raw rows on unanimity,
    // which would have published A's "FIRST DATA CORP" wording (re-cleaned to
    // "First Data Corp." at persist time — no comma). B's own wording
    // ("First Data, Corp.") is already in cleanAssetString's fixed-point form,
    // so it round-trips unchanged through the persist-time re-clean and stays
    // distinguishable from what "always A" would have produced.
    stub(
      asJson([row('AAPL', 'B', AB, { assetName: 'FIRST DATA CORP', ticker: null, confidence: 0.3 })]),
      asJson([row('AAPL', 'B', AB, { assetName: 'First Data, Corp.', ticker: null, confidence: 0.55 })]),
    );
    const { env, cap } = makeEnv();
    await handleAgreementCheck(env, 'H-text-tier1', 'raw/H-text-tier1');
    expect(cap.inserted).toHaveLength(1);
    expect(cap.sent).toHaveLength(0); // agreed → no escalation to tier 2
    const insertedRows = JSON.parse(cap.inserted[0][0] as string) as Array<{ assetName: string }>;
    expect(insertedRows[0].assetName).toBe('First Data, Corp.'); // B's wording, not A's
  });

  it('tier 3: 2-of-3 normalize-equal text + 1 different picks the MAJORITY text, preferring the higher-confidence contributor within the winning bloc', async () => {
    // A and B both correctly read "First Data Corp." (different casing /
    // punctuation); C reads a genuinely different suffix ("LLC") — a real
    // disagreement, not formatting drift — so C is the minority. B has the
    // higher confidence of the two majority contributors. Ticker ('AAPL', from
    // the row() helper's first arg) is deliberately left populated (not
    // nulled like the tier-1 test above): tier 3's buildMajorityRows groups
    // reads into rows via arbitrationRowKey, which is untouched by this PR
    // and falls back to raw (non-normalized) assetName only when ticker is
    // absent — an orthogonal, pre-existing row-identity concern, not the
    // per-field text-comparator behavior this test targets.
    stub(
      asJson([row('AAPL', 'B', AB, { assetName: 'FIRST DATA CORP', confidence: 0.3 })]),
      asJson([row('AAPL', 'B', AB, { assetName: 'First Data, Corp.', confidence: 0.55 })]),
      asJson([row('AAPL', 'B', AB, { assetName: 'First Data LLC', confidence: 0.5 })]),
    );
    const { env, cap } = makeEnv();
    const res = await processAgreementCascadeTier2(env, MODELS_C, 'H-text-tier3', 'raw/x', false);
    expect(res).toMatchObject({ outcome: 'published', tier: 3 });
    const insertedRows = JSON.parse(cap.inserted[0][0] as string) as Array<{ assetName: string }>;
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0].assetName).toBe('First Data, Corp.'); // majority (A+B) text, B's wording
  });

  it('tier 1: House GS type-code as ticker still agrees with a no-ticker T-bill read', async () => {
    stub(
      asJson([row('GS', 'B', AB, {
        assetName: 'Treasury Bill (3-Month, Matures 5/1/2025)',
        ticker: 'GS',
        assetType: 'GS',
        confidence: 0.55,
      })]),
      asJson([row('GS', 'B', AB, {
        assetName: 'Treasury Bill (3-Month, Matures 5/1/2025)',
        ticker: null,
        assetType: 'GS',
        confidence: 0.5,
      })]),
    );
    const { env, cap } = makeEnv();
    await handleAgreementCheck(env, 'H-tbill-gs', 'raw/H-tbill-gs');
    expect(cap.inserted).toHaveLength(1);
    expect(cap.sent).toHaveLength(0);
  });

  it('kill switch (AGREEMENT_TEXT_NORMALIZATION=false) restores byte-strict comparison: the SAME near-miss pair that agrees by default now disagrees', async () => {
    stub(
      asJson([row('AAPL', 'B', AB, { assetName: 'FIRST DATA CORP', ticker: null })]),
      asJson([row('AAPL', 'B', AB, { assetName: 'First Data, Corp.', ticker: null })]),
    );
    const { env, cap } = makeEnv({ env: { AGREEMENT_TEXT_NORMALIZATION: 'false' } });
    await handleAgreementCheck(env, 'H-text-killswitch', 'raw/H-text-killswitch');
    expect(cap.inserted).toHaveLength(0); // byte-strict → disagree, no publish
    expect(cap.sent).toEqual([
      expect.objectContaining({ type: 'agreement.check', escalationTier: 2 }),
    ]);
  });
});
