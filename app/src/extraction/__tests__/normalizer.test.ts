import { describe, it, expect, beforeEach } from 'vitest';
import {
  normalize,
  CONFIDENCE_THRESHOLD,
  DETERMINISTIC_CONFIDENCE_THRESHOLD,
  isDeterministicExtractor,
  confidenceThresholdFor,
  persistTransactions,
  transactionRowKey,
  clearResolverCache,
  clearNameIndexCache,
  scoreFields,
  type NameIndex,
  looksLikeHeaderContaminatedAsset,
  isMostlyGarbageOcrExtraction,
} from '../normalizer.ts';
import type { Env, Filing, ParsedTx } from '../../shared/types.ts';
import { parseOgeTransactionRows } from '../ogeText.ts';

beforeEach(() => {
  clearResolverCache();
  clearNameIndexCache();
});

// ---------------------------------------------------------------------------
// Minimal in-memory D1 + Queue fakes. We only need to satisfy the prepared-
// statement surface the normalizer touches (prepare -> bind -> all/run/first),
// and capture which writes happened.
// ---------------------------------------------------------------------------

interface Captured {
  insertedTx: Array<Record<string, unknown>>;
  reviewRows: unknown[][];
  reviewSql: string[];
  filingUpdates: unknown[][];
  enqueued: Array<{ type: string; txId: string }>;
  batches: string[][];
  batchParams: unknown[][][];
  auditRows: unknown[][];
  masterReads: number;
  deprecated: unknown[][];
}

function makeEnv(
  securities: Array<{ ticker: string; name: string | null; aliases: string | null }>,
  opts: {
    failAudit?: boolean;
    resolvedReview?: {
      resolved: number;
      review_revision: number;
      agreement_suppressed_at: string | null;
      payload?: string | null;
    };
    refuseClose?: boolean;
    liveTxMatch?: boolean;
  } = {},
) {
  const cap: Captured = {
    insertedTx: [],
    reviewRows: [],
    reviewSql: [],
    filingUpdates: [],
    enqueued: [],
    batches: [],
    batchParams: [],
    auditRows: [],
    masterReads: 0,
    deprecated: [],
  };
  const insertedByRowKey = new Map<string, Record<string, unknown>>();
  const outboxSeen = new Set<string>();
  let failAudit = opts.failAudit ?? false;

  const prepare = (sql: string) => {
    const stmt = {
      _sql: sql,
      _params: [] as unknown[],
      bind(...params: unknown[]) {
        this._params = params;
        return this;
      },
      async all<T>() {
        if (/FROM securities_master/i.test(sql)) {
          cap.masterReads += 1;
          return { results: securities as unknown as T[] };
        }
        return { results: [] as T[] };
      },
      async first<T>() {
        if (/SELECT resolved, review_revision, agreement_suppressed_at/i.test(sql)) {
          return (opts.resolvedReview ?? null) as T | null;
        }
        if (opts.liveTxMatch && /SELECT id FROM transactions/i.test(sql)) {
          return { id: 'live-tx-1' } as T | null;
        }
        return null as T | null;
      },
      async run() {
        let changes = 1;
        if (opts.refuseClose && (/INSERT OR IGNORE INTO review_queue\s*\(\s*doc_id, reason, payload, created_at, resolved,/i.test(sql) || /UPDATE review_queue\s+SET resolved = 1/i.test(sql))) {
          changes = 0;
        } else if (/INSERT(?: OR IGNORE)? INTO transactions/i.test(sql) && /json_each/i.test(sql)) {
          const rows = JSON.parse(String(this._params[0])) as Array<Record<string, unknown>>;
          changes = 0;
          for (const row of rows) {
            const rowKey = String(row.rowKey ?? '');
            if (!insertedByRowKey.has(rowKey)) {
              insertedByRowKey.set(rowKey, row);
              cap.insertedTx.push(row);
              changes += 1;
            }
          }
        } else if (/INSERT OR IGNORE INTO delivery_outbox/i.test(sql)) {
          const rows = JSON.parse(String(this._params[3])) as Array<Record<string, unknown>>;
          changes = 0;
          for (const row of rows) {
            const rowKey = String(row.rowKey ?? '');
            const txId = String(insertedByRowKey.get(rowKey)?.id ?? '');
            if (txId && !outboxSeen.has(txId)) {
              outboxSeen.add(txId);
              changes += 1;
            }
          }
        } else if (/INSERT(?: OR IGNORE)? INTO review_queue/i.test(sql) || /UPDATE review_queue\s+SET reason/i.test(sql)) {
          cap.reviewRows.push(this._params);
          cap.reviewSql.push(sql);
        }
        else if (/INSERT(?: OR IGNORE)? INTO ingestion_decisions/i.test(sql)) cap.auditRows.push(this._params);
        else if (/UPDATE filings/i.test(sql)) cap.filingUpdates.push(this._params);
        else if (/SET deprecated_at/i.test(sql)) cap.deprecated.push(this._params);
        return { success: true, meta: { changes } } as unknown;
      },
    };
    return stmt;
  };

  const env = {
    DB: {
      prepare,
      async batch(statements: Array<{ _sql: string; _params: unknown[]; run(): Promise<unknown> }>) {
        cap.batches.push(statements.map((statement) => statement._sql));
        cap.batchParams.push(statements.map((statement) => statement._params));
        if (failAudit && statements.some((statement) => /ingestion_decisions/i.test(statement._sql))) {
          throw new Error('audit insert failed');
        }
        return Promise.all(statements.map((statement) => statement.run()));
      },
    } as unknown as D1Database,
    DELIVERY_QUEUE: {
      async send(msg: { type: string; txId: string }) {
        cap.enqueued.push(msg);
      },
      async sendBatch(msgs: { body: any }[]) {
        for (const m of msgs) cap.enqueued.push(m.body);
      },
    } as unknown as Env['DELIVERY_QUEUE'],
  } as unknown as Env;

  return { env, cap, allowAudit: () => { failAudit = false; } };
}

const filing = (over: Partial<Filing> = {}): Filing => ({
  docId: 'doc1',
  chamber: 'senate',
  filerId: 'F1',
  filingType: 'P',
  filedDate: '2024-07-01',
  sourceUrl: 'https://x',
  rawObjectKey: 'raw/senate/doc1.html',
  ingestStatus: 'extracted',
  docKind: 'senate_html',
  extractor: 'senateHtml',
  modelVersion: null,
  confidence: null,
  firstSeenAt: '2024-07-01T00:00:00.000Z',
  sourceUpdatedAt: null,
  error: null,
  ...over,
});

const tx = (over: Partial<ParsedTx> = {}): ParsedTx => ({
  txDate: '2024-06-14',
  owner: 'self',
  assetName: 'Apple Inc.',
  ticker: 'AAPL',
  assetType: 'Stock',
  txType: 'B',
  amountMin: 1001,
  amountMax: 15000,
  isOption: false,
  capGainsOver200: false,
  rawText: 'AAPL Apple Inc P $1,001 - $15,000',
  confidence: 0.97,
  ...over,
});

// Letters-only per-row tag (no digits) so varying rawText across synthetic
// fixture rows can't accidentally be mis-sniffed as a dollar amount by
// parseAmountRange's digit-stripping parser (which would trip a spurious
// invalid_amount flag unrelated to whatever the test is actually exercising).
function letterVariant(index: number): string {
  return String.fromCharCode(97 + (index % 26)) + String.fromCharCode(97 + Math.floor(index / 26));
}

describe('normalize', () => {
  it('holds a clean oversized scanned vision extraction for hand check instead of capping at 200', async () => {
    const { env, cap } = makeEnv([{ ticker: 'AAPL', name: 'Apple Inc.', aliases: '[]' }]);
    const parsed = Array.from(
      { length: 201 },
      (_, index) => tx({
        rawText: `AAPL Apple Inc P $1,001 - $15,000 (variant ${letterVariant(index)})`,
        confidence: 0.97,
      }),
    );
    const result = await normalize(
      env,
      filing({ docKind: 'scanned_pdf', extractor: 'visionLlm' }),
      parsed,
      { extractor: 'visionLlm' },
    );
    expect(result.needsReview).toBe(true);
    expect(result.published).toBe(false);
    expect(result.transactions.length).toBe(201);
    expect(cap.insertedTx).toHaveLength(0);
    expect(String(cap.reviewRows[0][1])).toContain('needs_hand_check:scanned_vision');
  });

  it('still holds a low-confidence uniform OCR flood above 200 rows', async () => {
    const { env, cap } = makeEnv([{ ticker: 'AAPL', name: 'Apple Inc.', aliases: '[]' }]);
    const parsed = Array.from(
      { length: 201 },
      (_, index) => tx({
        rawText: `AAPL Apple Inc P $1,001 - $15,000 (variant ${letterVariant(index)})`,
        confidence: 0.189,
      }),
    );
    const result = await normalize(
      env,
      filing({ docKind: 'scanned_pdf', extractor: 'visionLlm' }),
      parsed,
      { extractor: 'visionLlm' },
    );
    expect(result.needsReview).toBe(true);
    expect(cap.insertedTx).toHaveLength(0);
    expect(String(cap.reviewRows[0][1])).toBe(
      'needs_hand_check:scanned_vision,extraction_row_limit_exceeded_likely_garbage:0.00',
    );
  });

  it('makes the publication receipt part of the atomic batch and retries it idempotently', async () => {
    const { env, cap, allowAudit } = makeEnv(
      [{ ticker: 'AAPL', name: 'Apple Inc.', aliases: '[]' }],
      { failAudit: true },
    );
    await expect(normalize(env, filing(), [tx()])).rejects.toThrow('audit insert failed');
    expect(cap.insertedTx).toHaveLength(0);
    allowAudit();
    await normalize(env, filing(), [tx()]);
    await normalize(env, filing(), [tx()]);
    expect(cap.insertedTx).toHaveLength(1);
    expect(cap.auditRows).toHaveLength(2);
    expect(cap.auditRows[0][0]).toBe('decision:auto_published:doc1');
    expect(cap.auditRows[1][0]).toBe(cap.auditRows[0][0]);
  });

  it('atomically retries needs-review state with one deterministic receipt', async () => {
    const { env, cap, allowAudit } = makeEnv([], { failAudit: true });
    // Use a vision extractor so soft unresolved_ticker still lands in review
    // (deterministic text/html now autopublishes at a lower confidence gate).
    const f = filing({ docKind: 'scanned_pdf', extractor: 'visionLlm' });
    const parsed = [tx({ ticker: 'Bank of America Mystery', assetName: 'Mystery Co' })];
    await expect(normalize(env, f, parsed, { extractor: 'visionLlm' })).rejects.toThrow('audit insert failed');
    expect(cap.reviewRows).toHaveLength(0);
    expect(cap.filingUpdates).toHaveLength(0);

    allowAudit();
    await normalize(env, f, parsed, { extractor: 'visionLlm' });
    await normalize(env, f, parsed, { extractor: 'visionLlm' });
    expect(cap.reviewRows).toHaveLength(2);
    expect(cap.auditRows).toHaveLength(2);
    expect(cap.auditRows[0][0]).toBe('decision:review_opened:doc1');
    expect(cap.auditRows[1][0]).toBe(cap.auditRows[0][0]);
    expect(cap.batches.at(-1)).toEqual(expect.arrayContaining([
      expect.stringMatching(/UPDATE filings/),
      expect.stringMatching(/INSERT(?: OR IGNORE)? INTO review_queue/),
      expect.stringMatching(/INSERT OR IGNORE INTO ingestion_decisions/),
    ]));
  });

  it('keeps row identity stable when asset type labels are added as enrichment', () => {
    const parsed = tx({ assetType: 'Stock', assetTypeName: null });
    const enriched = tx({ assetType: 'Stock', assetTypeName: 'Stock' });

    expect(transactionRowKey('primary', 0, enriched)).toBe(transactionRowKey('primary', 0, parsed));

    const house = tx({ assetType: 'ST', assetTypeName: 'Stocks (including ADRs)' });
    const houseWithoutLabel = tx({ assetType: 'ST', assetTypeName: null });
    expect(transactionRowKey('primary', 0, house)).not.toBe(transactionRowKey('primary', 0, houseWithoutLabel));
  });

  it('publishes high-confidence, resolved, valid rows', async () => {
    const { env, cap } = makeEnv([{ ticker: 'AAPL', name: 'Apple Inc.', aliases: '["Apple"]' }]);
    const result = await normalize(env, filing(), [tx()]);

    expect(result.needsReview).toBe(false);
    expect(result.minConfidence).toBeGreaterThanOrEqual(CONFIDENCE_THRESHOLD);
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0].ticker).toBe('AAPL');
    expect(result.transactions[0].source).toBe('primary');

    // Persisted + delivery fan-out happened; no review row.
    expect(cap.insertedTx).toHaveLength(1);
    expect(cap.insertedTx[0].rowKey).toEqual(expect.stringMatching(/^v1:primary:0:/));
    expect(cap.insertedTx[0].estValue).toBe((1001 + 15000) / 2);
    expect(cap.reviewRows).toHaveLength(0);
    // Queue publication is now reconciled from the durable outbox. This minimal
    // fake does not materialize SELECT-based outbox rows for the flusher.
    expect(cap.enqueued).toEqual([]);
    // Filing metadata and persisted status are committed by one atomic update.
    expect(cap.filingUpdates).toHaveLength(1);
    expect(cap.filingUpdates[0].slice(0, 4)).toEqual([
      result.minConfidence,
      'senateHtml',
      null,
      'doc1',
    ]);
    expect(cap.batches).toEqual([
      expect.arrayContaining([
        expect.stringMatching(/INSERT OR IGNORE INTO transactions/),
        expect.stringMatching(/INSERT OR IGNORE INTO delivery_outbox/),
        expect.stringMatching(/ingest_status = 'persisted'/),
        expect.stringMatching(/INSERT OR IGNORE INTO ingestion_decisions/),
        expect.stringMatching(/deprecated_reason = 'upgraded_by_primary'/),
      ]),
    ]);
  });

  it('does not insert or enqueue duplicates when the same filing is normalized twice', async () => {
    const { env, cap } = makeEnv([{ ticker: 'AAPL', name: 'Apple Inc.', aliases: '["Apple"]' }]);
    const first = await normalize(env, filing(), [tx()]);
    const second = await normalize(env, filing(), [tx()]);

    expect(first.needsReview).toBe(false);
    expect(second.needsReview).toBe(false);
    expect(cap.insertedTx).toHaveLength(1);
    expect(cap.enqueued).toHaveLength(0);
    expect(cap.auditRows).toHaveLength(2);
    expect(cap.auditRows[0][0]).toBe(cap.auditRows[1][0]);
  });

  it('resolves ticker via alias when raw ticker is missing', async () => {
    const { env } = makeEnv([{ ticker: 'AAPL', name: 'Apple Inc.', aliases: '["apple inc."]' }]);
    const result = await normalize(env, filing(), [tx({ ticker: null })]);
    expect(result.transactions[0].ticker).toBe('AAPL');
    expect(result.needsReview).toBe(false);
  });

  it('routes to review when ticker is malformed/contaminated (confidence penalty pushes below threshold)', async () => {
    const { env, cap } = makeEnv([]); // empty securities_master
    // A header-contaminated, non-symbol string (spaces) is NOT a well-formed
    // ticker, so it stays unresolved and routes to review.
    const result = await normalize(
      env,
      filing(),
      [tx({ ticker: 'Bank of America Mystery', assetName: 'Mystery Co' })],
      { extractor: 'visionLlm', modelVersion: 'gemini-test' },
    );

    // 0.97 * 0.85 (unresolved) = 0.8245 < 0.85 threshold.
    expect(result.minConfidence).toBeLessThan(CONFIDENCE_THRESHOLD);
    expect(result.needsReview).toBe(true);
    expect(cap.insertedTx).toHaveLength(0);
    expect(cap.reviewRows).toHaveLength(1);
    expect(cap.enqueued).toHaveLength(0);
    expect(String(cap.reviewRows[0][1])).toContain('unresolved_ticker');
    expect(JSON.parse(String(cap.reviewRows[0][2]))).toMatchObject({
      extractor: 'visionLlm',
      modelVersion: 'gemini-test',
    });
    expect(cap.reviewSql[0]).toMatch(/INSERT OR IGNORE INTO review_queue/i);
    expect(cap.reviewSql[0]).not.toMatch(/agreement_legacy_replay_at\s*=/i);
  });

  it('publishes a well-formed symbol the master does not list yet (no false review)', async () => {
    const { env, cap } = makeEnv([]); // empty securities_master
    // "CTRA" (Coterra) is a valid current symbol absent from our master — the
    // deterministic fallback accepts it instead of penalizing it into review.
    const result = await normalize(env, filing(), [tx({ ticker: 'CTRA', assetName: 'Coterra Energy Inc.' })]);
    expect(result.needsReview).toBe(false);
    expect(result.minConfidence).toBeGreaterThanOrEqual(CONFIDENCE_THRESHOLD);
    expect(result.transactions[0].ticker).toBe('CTRA');
    expect(cap.insertedTx).toHaveLength(1);
    expect(cap.reviewRows).toHaveLength(0);
  });

  it('resolves preferred/depositary ticker variants and stale tickers', async () => {
    const { env } = makeEnv([
      { ticker: 'T', name: 'AT&T Inc.', aliases: '[]' },
      { ticker: 'JPM', name: 'JPMorgan Chase & Co.', aliases: '[]' },
      { ticker: 'AVGO', name: 'Broadcom Inc.', aliases: '[]' },
      { ticker: 'BRK-B', name: 'Berkshire Hathaway', aliases: '[]' },
    ]);
    const pref = await normalize(env, filing(), [tx({ ticker: 'T$A', assetName: 'AT&T Inc. Pfd A' })]);
    expect(pref.transactions[0].ticker).toBe('T^A'); // preferred variant normalized
    expect(pref.needsReview).toBe(false);

    const yahooPref = await normalize(env, filing(), [tx({ ticker: 'JPM-PJ', assetName: 'JPMorgan Chase & Co. Depositary Shares, Series GG' })]);
    expect(yahooPref.transactions[0].ticker).toBe('JPM^J');

    const nameOnlyPref = await normalize(env, filing(), [
      tx({
        ticker: null,
        assetName: 'JPMorgan Chase & Co. Depositary Shares, Series GG',
      }),
    ]);
    expect(nameOnlyPref.transactions[0].ticker).toBe('JPM^J');
    expect(nameOnlyPref.needsReview).toBe(false);

    const issuerCollapsedPref = await normalize(env, filing(), [
      tx({
        ticker: 'T',
        assetName: 'AT&T Inc. Depositary Shares, each representing a 1/1,000th interest in a share of 5.000% Perpetual Preferred Stock, Series A',
      }),
    ]);
    expect(issuerCollapsedPref.transactions[0].ticker).toBe('T^A');

    const stale = await normalize(env, filing(), [tx({ ticker: 'BRCM', assetName: 'Broadcom' })]);
    expect(stale.transactions[0].ticker).toBe('AVGO'); // acquisition; point-in-time ticker preserved

    const klass = await normalize(env, filing(), [tx({ ticker: 'BRK.B', assetName: 'Berkshire' })]);
    expect(klass.transactions[0].ticker).toBe('BRK-B'); // punctuation variant
  });

  it('treats a dash/N-A placeholder ticker as ticker-less (no penalty, no review)', async () => {
    const { env, cap } = makeEnv([]);
    const result = await normalize(env, filing(), [tx({ ticker: '--', assetName: 'US Treasury Note' })]);
    expect(result.needsReview).toBe(false);
    expect(result.transactions[0].ticker).toBeNull();
    expect(cap.insertedTx).toHaveLength(1);
    expect(cap.reviewRows).toHaveLength(0);
  });

  it('snaps a plausible non-canonical amount to the nearest bracket without penalty', async () => {
    const { env, cap } = makeEnv([{ ticker: 'AAPL', name: 'Apple Inc.', aliases: '[]' }]);
    // 1200–14000 isn't an exact STOCK Act bracket but is a sane range -> snap, no penalty.
    const result = await normalize(env, filing(), [
      tx({ amountMin: 1200, amountMax: 14000, rawText: 'AAPL Apple Inc P $1,200 - $14,000' }),
    ]);
    expect(result.needsReview).toBe(false);
    expect(result.minConfidence).toBeGreaterThanOrEqual(CONFIDENCE_THRESHOLD);
    expect(cap.insertedTx).toHaveLength(1);
  });

  it('routes to review when the amount is missing entirely', async () => {
    const { env, cap } = makeEnv([{ ticker: 'AAPL', name: 'Apple Inc.', aliases: '[]' }]);
    const result = await normalize(env, filing(), [tx({ amountMin: null, amountMax: null })]);
    expect(result.needsReview).toBe(true);
    expect(cap.reviewRows).toHaveLength(1);
    expect(String(cap.reviewRows[0][1])).toContain('no_amount');
  });

  it('local Grok vision publishes siblings when some PTR rows omit the amount checkbox', async () => {
    const { env, cap } = makeEnv([]);
    const result = await normalize(
      env,
      filing({ chamber: 'house', docKind: 'scanned_pdf', extractor: 'local_grok_cli_v1' }),
      [
        tx({
          ticker: null,
          assetName: 'Vng Growth Index',
          txType: 'S',
          amountMin: 1001,
          amountMax: 15000,
          confidence: 0.97,
          rawText: 'Vng Growth Index',
        }),
        tx({
          ticker: null,
          assetName: 'Bridge Builder Sm/Mid Value',
          txType: 'S',
          amountMin: null,
          amountMax: null,
          confidence: 0.97,
          rawText: 'Bridge Builder Sm/Mid Value',
        }),
      ],
      { extractor: 'local_grok_cli_v1', source: 'local_mac' },
    );
    expect(result.needsReview).toBe(true);
    expect(result.published).toBe(false);
    expect(result.transactions).toHaveLength(2);
    expect(cap.insertedTx).toHaveLength(0);
    expect(cap.reviewRows).toHaveLength(1);
    expect(String(cap.reviewRows[0][1])).toContain('needs_hand_check:mac_vision');
  });

  it('local Grok vision does not auto-publish when every row omitted the amount', async () => {
    const { env, cap } = makeEnv([]);
    const result = await normalize(
      env,
      filing({ chamber: 'house', docKind: 'scanned_pdf', extractor: 'local_grok_cli_v1' }),
      [
        tx({
          ticker: null,
          assetName: 'Vng Growth Index',
          txType: 'S',
          amountMin: null,
          amountMax: null,
          confidence: 0.97,
          rawText: 'Vng Growth Index',
        }),
        tx({
          ticker: null,
          assetName: 'Bridge Builder Sm/Mid Value',
          txType: 'S',
          amountMin: null,
          amountMax: null,
          confidence: 0.97,
          rawText: 'Bridge Builder Sm/Mid Value',
        }),
      ],
      { extractor: 'local_grok_cli_v1', source: 'local_mac' },
    );
    expect(result.needsReview).toBe(true);
    expect(result.published).toBe(false);
    expect(cap.insertedTx).toHaveLength(0);
    expect(cap.reviewRows).toHaveLength(1);
    expect(String(cap.reviewRows[0][1])).toContain('no_amount');
  });

  it('Mac Gemini cascade holds for hand check even when some PTR rows omit the amount checkbox', async () => {
    const { env, cap } = makeEnv([]);
    const result = await normalize(
      env,
      filing({ chamber: 'house', docKind: 'scanned_pdf', extractor: 'openrouter_google_gemini_3_7_flash' }),
      [
        tx({
          ticker: null,
          assetName: 'Vng Growth Index',
          txType: 'S',
          amountMin: 1001,
          amountMax: 15000,
          confidence: 0.97,
          rawText: 'Vng Growth Index',
        }),
        tx({
          ticker: null,
          assetName: 'Bridge Builder Sm/Mid Value',
          txType: 'S',
          amountMin: null,
          amountMax: null,
          confidence: 0.97,
          rawText: 'Bridge Builder Sm/Mid Value',
        }),
      ],
      { extractor: 'openrouter_google_gemini_3_7_flash', source: 'local_mac' },
    );
    expect(result.needsReview).toBe(true);
    expect(result.published).toBe(false);
    expect(result.transactions).toHaveLength(2);
    expect(cap.insertedTx).toHaveLength(0);
    expect(cap.reviewRows).toHaveLength(1);
    expect(String(cap.reviewRows[0][1])).toContain('needs_hand_check:mac_vision');
  });

  it('server-side OpenRouter still holds the filing when any row omitted the amount', async () => {
    const { env, cap } = makeEnv([]);
    const result = await normalize(
      env,
      filing({ chamber: 'house', docKind: 'scanned_pdf', extractor: 'openrouter_google_gemini_3_7_flash' }),
      [
        tx({
          ticker: null,
          assetName: 'Vng Growth Index',
          txType: 'S',
          amountMin: 1001,
          amountMax: 15000,
          confidence: 0.97,
          rawText: 'Vng Growth Index',
        }),
        tx({
          ticker: null,
          assetName: 'Bridge Builder Sm/Mid Value',
          txType: 'S',
          amountMin: null,
          amountMax: null,
          confidence: 0.97,
          rawText: 'Bridge Builder Sm/Mid Value',
        }),
      ],
      { extractor: 'openrouter_google_gemini_3_7_flash' },
    );
    expect(result.needsReview).toBe(true);
    expect(result.published).toBe(false);
    expect(cap.insertedTx).toHaveLength(0);
    expect(String(cap.reviewRows[0][1])).toContain('no_amount');
  });

  it('Mac Gemini cascade does not auto-publish when every row omitted the amount', async () => {
    const { env, cap } = makeEnv([]);
    const result = await normalize(
      env,
      filing({ chamber: 'house', docKind: 'scanned_pdf', extractor: 'openrouter_google_gemini_3_7_flash' }),
      [
        tx({
          ticker: null,
          assetName: 'Vng Growth Index',
          txType: 'S',
          amountMin: null,
          amountMax: null,
          confidence: 0.97,
          rawText: 'Vng Growth Index',
        }),
        tx({
          ticker: null,
          assetName: 'Bridge Builder Sm/Mid Value',
          txType: 'S',
          amountMin: null,
          amountMax: null,
          confidence: 0.97,
          rawText: 'Bridge Builder Sm/Mid Value',
        }),
      ],
      { extractor: 'openrouter_google_gemini_3_7_flash', source: 'local_mac' },
    );
    expect(result.needsReview).toBe(true);
    expect(result.published).toBe(false);
    expect(cap.insertedTx).toHaveLength(0);
    expect(cap.reviewRows).toHaveLength(1);
    expect(String(cap.reviewRows[0][1])).toContain('no_amount');
  });

  it('does not penalize a legitimately ticker-less asset (no ticker supplied)', async () => {
    const { env, cap } = makeEnv([]); // empty securities_master
    const result = await normalize(env, filing(), [
      tx({ ticker: null, assetName: 'US Treasury Bond 2.5% 2030' }),
    ]);
    expect(result.needsReview).toBe(false);
    expect(result.minConfidence).toBeGreaterThanOrEqual(CONFIDENCE_THRESHOLD);
    expect(cap.insertedTx).toHaveLength(1);
  });

  it('does not park a disclosed trade a few days after Clerk filed_date', async () => {
    const { env, cap } = makeEnv([{ ticker: 'AAPL', name: 'Apple Inc.', aliases: '[]' }]);
    const result = await normalize(env, filing({ filedDate: '2024-06-01' }), [
      tx({ txDate: '2024-06-14' }),
    ]);
    expect(result.needsReview).toBe(false);
    expect(result.published).toBe(true);
    expect(cap.insertedTx).toHaveLength(1);
  });

  it('publishes the OCR-repaired name and resolves its ticker from the repair', async () => {
    const { env, cap } = makeEnv([{ ticker: 'UBER', name: 'Uber Technologies Inc.', aliases: '[]' }]);
    const result = await normalize(env, filing(), [
      tx({ ticker: null, assetName: 'Uber Technolo1des Inc.' }),
    ]);
    expect(result.needsReview).toBe(false);
    expect(result.published).toBe(true);
    expect(cap.insertedTx).toHaveLength(1);
    expect(cap.insertedTx[0].assetName).toBe('Uber Technologies Inc.');
    expect(cap.insertedTx[0].ticker).toBe('UBER');
    expect(String(cap.insertedTx[0].cleaningNote)).toContain('normalized OCR artifacts');
  });

  it('holds a row whose OCR garble has no confident fix', async () => {
    const { env, cap } = makeEnv([{ ticker: 'AAPL', name: 'Apple Inc.', aliases: '[]' }]);
    const result = await normalize(env, filing(), [
      tx({ ticker: null, assetName: 'Legal200m Com Inc.' }),
    ]);
    expect(result.needsReview).toBe(true);
    expect(result.published).toBe(false);
    expect(cap.insertedTx).toHaveLength(0);
    expect(String(cap.reviewRows[0][1])).toContain('ocr_name_hold');
  });

  it('holds an impossible maturity date lifted into the cleaning note', async () => {
    const { env, cap } = makeEnv([{ ticker: 'AAPL', name: 'Apple Inc.', aliases: '[]' }]);
    // splitAssetNameDetail moves the shape-only "Due 02/30/2026" suffix into
    // the note before the OCR scan; the machine path must still hold (as the
    // admin path 400s the same raw string) instead of publishing it in Notes.
    const result = await normalize(env, filing(), [
      tx({ ticker: null, assetName: 'Bond Due 02/30/2026' }),
    ]);
    expect(result.needsReview).toBe(true);
    expect(result.published).toBe(false);
    expect(cap.insertedTx).toHaveLength(0);
    expect(String(cap.reviewRows[0][1])).toContain('ocr_date_hold');
  });

  it('routes empty extraction to review', async () => {
    const { env, cap } = makeEnv([]);
    const result = await normalize(env, filing(), []);
    expect(result.needsReview).toBe(true);
    expect(result.minConfidence).toBe(0);
    expect(cap.reviewRows).toHaveLength(1);
    expect(String(cap.reviewRows[0][1])).toContain('extract_empty_failure');
    expect(String(cap.reviewRows[0][1])).toContain('no_transactions_extracted');
    // Empty extract is hard failure — do not also tag low_confidence (no rows).
    expect(String(cap.reviewRows[0][1])).not.toContain('low_confidence');
  });

  const BONDI_PART7_NONE = [
    'OGE Form 278e',
    '7. Transactions',
    'None',
    '8. Liabilities',
    'None',
  ].join('\n');

  it('closes an OGE 278e Part 7 explicit None extract as verified_empty', async () => {
    const { env, cap } = makeEnv([]);
    const result = await normalize(
      env,
      filing({
        docId: 'E-undated-pam-bondi-2026-278term',
        chamber: 'executive',
        docKind: 'text_pdf',
        extractor: 'ogeText',
      }),
      [],
      { extractor: 'ogeText', sourceText: BONDI_PART7_NONE },
    );
    expect(result.needsReview).toBe(false);
    expect(result.published).toBe(false);
    expect(result.reviewReason).toBe('oge_part7_explicit_none');
    expect(cap.insertedTx).toHaveLength(0);
    expect(cap.filingUpdates[0][0]).toBe('verified_empty');
    expect(cap.reviewRows[0]).toEqual(expect.arrayContaining([
      'oge_part7_explicit_none',
      'verified_empty',
    ]));
  });

  it('closes an empty executive 278e as verified_empty instead of parking it', async () => {
    const { env, cap } = makeEnv([]);
    const result = await normalize(
      env,
      filing({
        docId: 'E-undated-pam-bondi-2026-278term',
        chamber: 'executive',
        docKind: 'text_pdf',
        extractor: 'ogeText',
      }),
      [],
      { extractor: 'ogeText', parseDisposition: 'empty' },
    );
    expect(result.needsReview).toBe(false);
    expect(result.reviewReason).toBe('executive_278e_no_transactions');
    const sql = cap.batches.flat().join('\n');
    expect(sql).toContain('resolution_kind = ?');
    expect(sql).toContain('ingest_status = ?');
    expect(cap.auditRows.some((row) => row[2] === 'auto_resolved_empty')).toBe(true);
    expect(cap.reviewRows.some((row) => String(row[1]).includes('extract_empty_failure'))).toBe(false);
  });

  it('does not verified_empty a zero-row extract without a Part 7 None marker or empty disposition', async () => {
    const { env, cap } = makeEnv([]);
    const result = await normalize(
      env,
      filing({
        docId: 'E-2026-donald-j-trump-08-12-2026-278t',
        chamber: 'executive',
        docKind: 'text_pdf',
        extractor: 'ogeText',
      }),
      [],
      {
        extractor: 'ogeText',
        sourceText: [
          'Periodic Transaction Report',
          '# DESCRIPTION TYPE DATE NOTIFICATION RECEIVED OVER 30 DAYS AGO AMOUNT',
          '1 SPOR SERIES TRUST HIGH YlELD BONO ETF ourchoeo 1/20/2028 no',
        ].join('\n'),
      },
    );
    expect(result.needsReview).toBe(true);
    expect(result.published).toBe(false);
    expect(result.reviewReason).not.toBe('oge_part7_explicit_none');
    expect(result.reviewReason).not.toBe('nothing_to_report');
    expect(String(cap.reviewRows[0][1])).toContain('extract_empty_failure');
    expect(cap.filingUpdates.some((row) => row[0] === 'verified_empty')).toBe(false);
  });

  it('does not verified_empty an executive extract whose Part 7 None points at an attachment', async () => {
    const { env, cap } = makeEnv([]);
    const result = await normalize(
      env,
      filing({
        docId: 'E-2026-someone-278e',
        chamber: 'executive',
        docKind: 'text_pdf',
        extractor: 'ogeText',
      }),
      [],
      {
        extractor: 'ogeText',
        sourceText: 'OGE Form 278e Part 7. Transactions None. See attachment. Part 8. Liabilities',
      },
    );
    // Rows live on the attachment: the doc stays in review instead of taking
    // the oge_part7_explicit_none verified_empty close.
    expect(result.needsReview).toBe(true);
    expect(result.reviewReason).not.toBe('oge_part7_explicit_none');
    expect(result.reviewReason).not.toBe('nothing_to_report');
    expect(cap.auditRows.some((row) => row[2] === 'auto_resolved_empty')).toBe(false);
    expect(String(cap.reviewRows[0][1])).toContain('extract_empty_failure');
  });

  it('parks a refused executive extract as unreadable, not verified_empty', async () => {
    const { env, cap } = makeEnv([]);
    const result = await normalize(
      env,
      filing({
        docId: 'E-2026-donald-j-trump-09-8-2026-278t',
        chamber: 'executive',
        docKind: 'text_pdf',
        extractor: 'ogeText',
      }),
      [],
      { extractor: 'ogeText', parseDisposition: 'unreadable' },
    );
    expect(result.needsReview).toBe(true);
    expect(result.published).toBe(false);
    expect(result.reviewReason).toContain('oge_text_unreadable');
    expect(result.reviewReason).toContain('ocr_unusable');
    const sql = cap.batches.flat().join('\n');
    expect(sql).toContain("ingest_status = 'needs_review'");
    expect(sql).not.toContain('resolution_kind = ?');
    expect(sql).not.toContain("ingest_status = 'verified_empty'");
    expect(sql).not.toMatch(/SET resolved = 1/i);
    expect(cap.auditRows.some((row) => row[2] === 'oge_text_unreadable' && row[3] === 'oge_text_unreadable')).toBe(true);
    expect(cap.auditRows.some((row) => row[2] === 'rejected')).toBe(false);
  });

  it('closes a refused executive extract only against the captured review revision', async () => {
    const { env, cap } = makeEnv([], {
      resolvedReview: { resolved: 0, review_revision: 7, agreement_suppressed_at: null },
    });
    const result = await normalize(
      env,
      filing({
        docId: 'E-2026-donald-j-trump-09-8-2026-278t',
        chamber: 'executive',
        docKind: 'text_pdf',
        extractor: 'ogeText',
      }),
      [],
      { extractor: 'ogeText', parseDisposition: 'unreadable' },
    );
    expect(result.needsReview).toBe(true);
    // The park UPDATE must carry the snapshot's review_revision in its guard
    // (openUnreadableParkSql appends the reviewWhere params after docId), so a
    // row revised after the snapshot is left for the human instead of relabeled
    // by a stale zero-row parse.  It must not resolve the row.
    const closeIdx = cap.batches.findIndex((batch) =>
      batch.some((sql) => /UPDATE review_queue\s+SET resolved = 0/i.test(sql)),
    );
    expect(closeIdx).toBeGreaterThanOrEqual(0);
    const closeParams = cap.batchParams[closeIdx][
      cap.batches[closeIdx].findIndex((sql) => /UPDATE review_queue\s+SET resolved = 0/i.test(sql))
    ];
    expect(closeParams).toContain(7);
    expect(cap.batches.flat().some((sql) => /SET resolved = 1/i.test(sql))).toBe(false);
  });

  it('closes a verified-empty executive extract only against the captured review revision', async () => {
    const { env, cap } = makeEnv([], {
      resolvedReview: { resolved: 0, review_revision: 7, agreement_suppressed_at: null },
    });
    const result = await normalize(
      env,
      filing({
        docId: 'E-2026-pam-bondi-08-20-2026-278t',
        chamber: 'executive',
        docKind: 'text_pdf',
        extractor: 'ogeText',
      }),
      [],
      { extractor: 'ogeText', parseDisposition: 'empty' },
    );
    expect(result.needsReview).toBe(false);
    // Same revision guard as the unreadable close: the close UPDATE must
    // carry the snapshot's review_revision, or a retry-auto that bumped the
    // revision would let a stale empty parse close the freshly released row.
    const closeIdx = cap.batches.findIndex((batch) =>
      batch.some((sql) => /UPDATE review_queue\s+SET resolved = 1/i.test(sql)),
    );
    expect(closeIdx).toBeGreaterThanOrEqual(0);
    const closeParams = cap.batchParams[closeIdx][
      cap.batches[closeIdx].findIndex((sql) => /UPDATE review_queue\s+SET resolved = 1/i.test(sql))
    ];
    expect(closeParams).toContain(7);
  });

  it('preserves staged payload candidates when a zero-row executive close is refused', async () => {
    // The terminal close is refused because the review payload stages
    // candidates; routeToReview must not then rewrite that payload with an
    // empty candidate list, or a later zero-row pass would close the filing
    // verified-empty and lose them.
    const stagedPayload = JSON.stringify({
      transactionCount: 2,
      transactions: [{ ticker: 'AAPL' }, { ticker: 'MSFT' }],
    });
    const { env, cap } = makeEnv([], {
      resolvedReview: {
        resolved: 0,
        review_revision: 3,
        agreement_suppressed_at: null,
        payload: stagedPayload,
      },
      refuseClose: true,
    });
    const result = await normalize(
      env,
      filing({
        docId: 'E-2026-pam-bondi-08-20-2026-278t',
        chamber: 'executive',
        docKind: 'text_pdf',
        extractor: 'ogeText',
      }),
      [],
      { extractor: 'ogeText', parseDisposition: 'empty' },
    );
    expect(result.needsReview).toBe(true);
    // The close was refused; no INSERT (insert-if-absent) or UPDATE
    // (routeToReview) against review_queue may have run.
    expect(cap.reviewRows).toHaveLength(0);
    expect(
      cap.batches.flat().some((sql) => /UPDATE review_queue\s+SET reason/i.test(sql)),
    ).toBe(false);
  });

  it('still rewrites the review when the existing payload holds no candidates', async () => {
    const { env, cap } = makeEnv([], {
      resolvedReview: {
        resolved: 0,
        review_revision: 3,
        agreement_suppressed_at: null,
        payload: JSON.stringify({ transactionCount: 0, transactions: [] }),
      },
      refuseClose: true,
    });
    const result = await normalize(
      env,
      filing({
        docId: 'E-2026-pam-bondi-08-20-2026-278t',
        chamber: 'executive',
        docKind: 'text_pdf',
        extractor: 'ogeText',
      }),
      [],
      { extractor: 'ogeText', parseDisposition: 'empty' },
    );
    expect(result.needsReview).toBe(true);
    // With nothing staged, the zero-row pass rewrites the review row with the
    // empty payload as before.
    expect(cap.reviewRows.length).toBeGreaterThan(0);
    const updateParams = cap.reviewRows[cap.reviewRows.length - 1];
    expect(String(updateParams[0])).toContain('extract_empty');
    const payload = JSON.parse(String(updateParams[1])) as { transactionCount: number };
    expect(payload.transactionCount).toBe(0);
  });

  it('closes a handwritten PTR sample / nothing-to-report extract as verified empty', async () => {
    const { env, cap } = makeEnv([]);
    const result = await normalize(env, filing(), [
      tx({
        assetName: 'Exemplje Mega Corp Common Stock',
        ticker: null,
        txDate: '2012-08-14',
        txType: 'S',
        amountMin: 1001,
        amountMax: 15000,
        confidence: 0.6,
      }),
      tx({
        assetName: 'Nothing to report for July 2026',
        ticker: null,
        txDate: null,
        txType: 'S',
        amountMin: null,
        amountMax: null,
        confidence: 0.2,
      }),
    ]);
    expect(result.needsReview).toBe(false);
    expect(result.published).toBe(false);
    expect(result.reviewReason).toBe('nothing_to_report');
    expect(cap.insertedTx).toHaveLength(0);
  });

  it('does not insert Deleted PTR rows as live trades', async () => {
    const { env, cap } = makeEnv([{ ticker: 'VSNT', name: 'Versant Media Group, Inc.', aliases: '[]' }]);
    const result = await normalize(env, filing({ filerId: 'house-ok01-kevin-hern' }), [
      tx({
        ticker: 'VSNT',
        assetName: 'Versant Media Group, Inc. Class A',
        txType: 'S',
        txDate: '2026-08-05',
        amountMin: 1001,
        amountMax: 15000,
        filingStatus: 'Deleted',
        owner: 'joint',
        confidence: 0.97,
      }),
    ]);
    expect(cap.insertedTx).toHaveLength(0);
    expect(result.needsReview).toBe(false);
    expect(result.published).toBe(false);
    expect(result.reviewReason).toBe('deleted_rows_applied');
    expect(result.settled).toBe(true);
    expect(cap.reviewRows[0]).toEqual(expect.arrayContaining(['verified_empty', 'deleted_rows_applied']));
    expect(cap.filingUpdates[0][0]).toBe('verified_empty');
    expect(cap.reviewSql.some((sql) => /resolution_kind = 'published'/.test(sql))).toBe(false);
  });

  it('marks an amendment whose rows already live on a predecessor as settled (not a CAS loss)', async () => {
    // Every row matches a live predecessor transaction: the publish path
    // resolves the review with nothing new to persist.  That success is
    // needsReview:false / published:false - the same shape as a lost CAS -
    // so it must carry the explicit settled flag.
    const { env, cap } = makeEnv(
      [{ ticker: 'VSNT', name: 'Versant Media Group, Inc.', aliases: '[]' }],
      { liveTxMatch: true },
    );
    const result = await normalize(
      env,
      // filedDate tracks the trade: a trade more than 31 days after the
      // filing date is held as tx_date_after_filing_window.
      filing({ filerId: 'house-ok01-kevin-hern', filingType: 'Amendment', filedDate: '2026-08-20' }),
      [
        tx({
          ticker: 'VSNT',
          assetName: 'Versant Media Group, Inc. Class A',
          txType: 'S',
          txDate: '2026-08-05',
          amountMin: 1001,
          amountMax: 15000,
          owner: 'joint',
          confidence: 0.97,
        }),
      ],
    );
    expect(result.needsReview).toBe(false);
    expect(result.published).toBe(false);
    expect(result.settled).toBe(true);
    expect(result.reviewReason).toBe('amendment_already_persisted');
    expect(cap.insertedTx).toHaveLength(0);
  });

  it('parks a form-sample-only extract for review instead of verified_empty', async () => {
    const { env, cap } = makeEnv([]);
    const result = await normalize(env, filing(), [
      tx({
        assetName: 'Example Mega Corp Common Stock',
        ticker: null,
        txDate: '2012-08-14',
        txType: 'S',
        amountMin: 1001,
        amountMax: 15000,
        confidence: 0.6,
      }),
    ]);
    expect(result.needsReview).toBe(true);
    expect(result.published).toBe(false);
    expect(result.reviewReason).not.toBe('nothing_to_report');
    expect(cap.insertedTx).toHaveLength(0);
    expect(String(cap.reviewRows[0][1])).toContain('form_chrome_only');
  });

  it('drops Senate IBM/Microsoft form samples so remaining paper rows can publish', async () => {
    const { env, cap } = makeEnv([
      { ticker: 'DBLEX', name: 'DoubleLine Emerging Markets Income', aliases: '[]' },
    ]);
    const result = await normalize(
      env,
      filing({ extractor: 'senatePaperMedia', docKind: 'senate_html' }),
      [
        tx({
          assetName: 'IBM Corp. (stock) NYSE',
          ticker: 'IBM',
          txDate: '2027-02-27',
          txType: 'S',
          amountMin: 50001,
          amountMax: 100000,
          confidence: 0.85,
          rawText: 'IBM Corp. (stock) NYSE S 2/27/1X X',
        }),
        tx({
          assetName: 'Doubleline Emg Mkts Inc I',
          ticker: 'DBLEX',
          txDate: '2023-02-06',
          txType: 'S',
          amountMin: 1001,
          amountMax: 15000,
          confidence: 0.85,
          rawText: 'Doubleline Emg Mkts Inc I (DBLEX) 2/6/23 $1,001-15,000',
        }),
      ],
      { extractor: 'senatePaperMedia' },
    );
    expect(result.needsReview).toBe(false);
    expect(result.published).toBe(true);
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0].ticker).toBe('DBLEX');
    expect(cap.insertedTx).toHaveLength(1);
    expect(cap.reviewRows).toHaveLength(0);
  });

  it('still deprecates matching live rows when the Deleted amendment was already rejected', async () => {
    const { env, cap } = makeEnv(
      [{ ticker: 'VSNT', name: 'Versant Media Group, Inc.', aliases: '[]' }],
      {
        resolvedReview: {
          resolved: 1,
          review_revision: 4,
          agreement_suppressed_at: null,
        },
      },
    );
    const result = await normalize(env, filing({ filerId: 'house-ok01-kevin-hern' }), [
      tx({
        ticker: 'VSNT',
        assetName: 'Versant Media Group, Inc. Class A',
        txType: 'S',
        txDate: '2026-08-05',
        amountMin: 1001,
        amountMax: 15000,
        filingStatus: 'Deleted',
        owner: 'joint',
        confidence: 0.97,
      }),
    ]);
    expect(result.needsReview).toBe(false);
    expect(result.published).toBe(false);
    expect(result.reviewReason).toBe('deleted_rows_applied');
    expect(cap.insertedTx).toHaveLength(0);
    expect(cap.deprecated).toHaveLength(1);
    expect(cap.deprecated[0]).toEqual(expect.arrayContaining([
      'house-ok01-kevin-hern',
      '2026-08-05',
      'S',
      'VSNT',
    ]));
  });

  it('drops pure form-chrome rows as extract_empty (not fake review trades)', async () => {
    const { env, cap } = makeEnv([{ ticker: 'GD', name: 'General Dynamics Corporation', aliases: '[]' }]);
    const result = await normalize(env, filing(), [
      tx({
        ticker: 'GD',
        assetName:
          'P T R Clerk of the House of Representatives Legislative Resource Center Name: Hon. Dwight Evans Status: Member State/District: PA03 T ID Owner Asset Transaction Type Date Notification Date Amount Cap. Gains >',
      }),
    ]);

    expect(result.needsReview).toBe(true);
    expect(result.transactions).toHaveLength(0);
    expect(result.minConfidence).toBe(0);
    expect(cap.insertedTx).toHaveLength(0);
    expect(cap.reviewRows).toHaveLength(1);
    const reason = String(cap.reviewRows[0][1]);
    expect(reason).toContain('form_chrome_only');
    expect(reason).toContain('extract_empty_failure');
    // Must not park as a soft "bad_asset_name" fake trade for humans/cascade.
    expect(reason).not.toContain('bad_asset_name');
  });

  it('drops form-chrome rows and still publishes remaining real trades', async () => {
    const { env, cap } = makeEnv([{ ticker: 'AAPL', name: 'Apple Inc.', aliases: '["Apple"]' }]);
    const result = await normalize(env, filing(), [
      tx({
        assetName:
          'Clerk of the House of Representatives + Legislative Resource Center * B81 Cannon Building',
        ticker: null,
        txDate: null,
        confidence: 0.25,
      }),
      tx({ ticker: 'AAPL', assetName: 'Apple Inc.', confidence: 0.97 }),
    ]);

    expect(result.needsReview).toBe(false);
    expect(result.published).toBe(true);
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0].ticker).toBe('AAPL');
    expect(cap.insertedTx).toHaveLength(1);
    expect(cap.reviewRows).toHaveLength(0);
  });

  it('routes unreadable or missing asset names to review instead of publishing a guessed row', async () => {
    for (const assetName of ['', '(unknown)', 'unreadable']) {
      const { env, cap } = makeEnv([]);
      const result = await normalize(env, filing(), [tx({ ticker: null, assetName })]);
      expect(result.needsReview).toBe(true);
      expect(cap.insertedTx).toHaveLength(0);
      expect(String(cap.reviewRows[0][1])).toContain('bad_asset_name');
    }
  });

  it('routes rows with unreadable option or capital-gains checkboxes to review', async () => {
    const { env, cap } = makeEnv([{ ticker: 'AAPL', name: 'Apple Inc.', aliases: '[]' }]);
    const result = await normalize(env, filing(), [tx({
      extractionWarnings: ['unreadable_is_option', 'unreadable_cap_gains'],
    })]);
    expect(result.needsReview).toBe(true);
    expect(cap.insertedTx).toHaveLength(0);
    expect(String(cap.reviewRows[0][1])).toContain('unreadable_is_option');
    expect(String(cap.reviewRows[0][1])).toContain('unreadable_cap_gains');
  });

  it('reuses the in-process securities_master resolver across calls until cleared', async () => {
    const first = makeEnv([{ ticker: 'AAPL', name: 'Apple Inc.', aliases: '[]' }]);
    await normalize(first.env, filing({ docId: 'doc-warm' }), [tx({ ticker: 'AAPL' })]);
    expect(first.cap.masterReads).toBe(1);

    const second = makeEnv([{ ticker: 'MSFT', name: 'Microsoft', aliases: '[]' }]);
    await normalize(second.env, filing({ docId: 'doc-cached' }), [tx({ ticker: 'AAPL' })]);
    expect(second.cap.masterReads).toBe(0);

    clearResolverCache();
    await normalize(second.env, filing({ docId: 'doc-cold' }), [tx({ ticker: 'AAPL' })]);
    expect(second.cap.masterReads).toBe(1);
  });

  it('differentiates duplicate trades across split trust accounts (e.g. Harshbarger CHEGG trades) using owner, subholding, description, and rowIndex', () => {
    const tradeBase = {
      txDate: '2024-05-15',
      ticker: 'CHGG',
      assetName: 'Chegg, Inc.',
      amountMin: 1001,
      amountMax: 15000,
      txType: 'B' as const,
    };

    const trust1 = tx({ ...tradeBase, owner: 'dependent' as const, subholding: 'Harshbarger Family Trust #1', description: 'Trust 1 Purchase' });
    const trust2 = tx({ ...tradeBase, owner: 'dependent' as const, subholding: 'Harshbarger Family Trust #2', description: 'Trust 2 Purchase' });

    // Different subholding / description -> different hash
    const key1 = transactionRowKey('primary', 0, trust1);
    const key2 = transactionRowKey('primary', 1, trust2);
    expect(key1).not.toBe(key2);

    // Same details, different rowIndex -> different row key string
    const key1Row0 = transactionRowKey('primary', 0, trust1);
    const key1Row1 = transactionRowKey('primary', 1, trust1);
    expect(key1Row0).not.toBe(key1Row1);
    expect(key1Row0).toContain('v1:primary:0:');
    expect(key1Row1).toContain('v1:primary:1:');
  });

  it('routes contradictory amount ranges or future trade dates to review queue', async () => {
    // 1. Contradictory amount range: rawText says $1,001 - $15,000 but amountMin/Max set to $50,001 - $100,000
    const { env: env1, cap: cap1 } = makeEnv([{ ticker: 'AAPL', name: 'Apple Inc.', aliases: '[]' }]);
    const result1 = await normalize(env1, filing(), [
      tx({
        rawText: '$1,001 - $15,000',
        amountMin: 50001,
        amountMax: 100000,
      }),
    ]);
    expect(result1.needsReview).toBe(true);
    expect(String(cap1.reviewRows[0][1])).toContain('invalid_amount');

    // 2. Trade date after today still parks (a date that has not happened).
    const { env: env2, cap: cap2 } = makeEnv([{ ticker: 'AAPL', name: 'Apple Inc.', aliases: '[]' }]);
    const result2 = await normalize(env2, filing({ filedDate: '2024-05-01' }), [
      tx({
        txDate: '2099-05-15',
      }),
    ]);
    expect(result2.needsReview).toBe(true);
    expect(String(cap2.reviewRows[0][1])).toContain('future_tx_date');

    // 3. Blumenthal paper PTR template rows (Microsoft/IBM with 1X placeholder years)
    // are dropped as form-chrome up front, preventing false future_tx_date review blocks.
    const { env: env3, cap: cap3 } = makeEnv([
      { ticker: 'AAPL', name: 'Apple Inc.', aliases: '[]' },
      { ticker: 'MSFT', name: 'Microsoft Corporation', aliases: '[]' },
    ]);
    const result3 = await normalize(env3, filing({ filedDate: '2026-08-01' }), [
      tx({
        assetName: 'Apple Inc.',
        ticker: 'AAPL',
        txDate: '2026-07-15',
        amountMin: 1001,
        amountMax: 15000,
        confidence: 0.98,
        rawText: 'Apple Inc. purchase 2026-07-15',
      }),
      tx({
        assetName: 'Microsoft',
        ticker: 'MSFT',
        txDate: '2027-01-17', // 1X OCR artifact
        amountMin: 1001,
        amountMax: 15000,
        confidence: 0.85,
        rawText: '(DC) Microsoft (stock) NASDAQ/OTC 2/27/1X EXAMPLE',
      }),
    ]);
    expect(result3.needsReview).toBe(false);
    expect(result3.transactions.length).toBe(1);
    expect(cap3.reviewRows.length).toBe(0);
  });

  it('local vision holds dated siblings for hand check when one grid row omitted the date', async () => {
    const { env, cap } = makeEnv([{ ticker: 'META', name: 'Meta Platforms', aliases: '[]' }]);
    const result = await normalize(
      env,
      filing({ docKind: 'scanned_pdf', extractor: 'local_grok_cli_v1', filedDate: '2025-12-08' }),
      [
        tx({
          assetName: 'Meta Platforms, Inc. -Class A CMN Class A',
          ticker: 'META',
          txDate: '2025-11-07',
          amountMin: 15001,
          amountMax: 50000,
          confidence: 0.97,
          rawText: 'Meta Platforms, Inc. -Class A CMN Class A P $15,001 - $50,000',
        }),
        tx({
          assetName: 'Sap Ag CMN',
          ticker: null,
          txDate: null,
          amountMin: null,
          amountMax: null,
          confidence: 0.97,
          rawText: 'Sap Ag CMN',
        }),
      ],
      { extractor: 'local_grok_cli_v1', source: 'local_mac' },
    );
    expect(result.needsReview).toBe(true);
    expect(result.published).toBe(false);
    expect(cap.insertedTx).toHaveLength(0);
    expect(cap.reviewRows).toHaveLength(1);
    expect(String(cap.reviewRows[0][1])).toContain('needs_hand_check:mac_vision');
  });

  it('publishes a disclosed trade a few days after Clerk filed_date when the date is not in the future', async () => {
    const { env, cap } = makeEnv([]);
    const result = await normalize(
      env,
      filing({ filedDate: '2025-10-22', docKind: 'text_pdf', extractor: 'textPdf' }),
      [
        tx({
          assetName: 'VLG FL CDD #14 SPL Assmnt Rev',
          ticker: null,
          txDate: '2025-10-24',
          txType: 'P',
          amountMin: 15001,
          amountMax: 50000,
          confidence: 0.9,
          rawText: 'JT VLG FL CDD #14 SPL ASSMNT REV [CS] P 10/24/2025 $15,001 - $50,000',
        }),
      ],
      { extractor: 'textPdf' },
    );
    expect(result.needsReview).toBe(false);
    expect(result.published).toBe(true);
    expect(cap.insertedTx).toHaveLength(1);
  });

  it('publishes an oversized extraction of distinct, varied-confidence rows', async () => {
    const { env, cap } = makeEnv([{ ticker: 'AAPL', name: 'Apple Inc.', aliases: '[]' }]);
    const parsed = Array.from(
      { length: 201 },
      (_, index) => tx({
        rawText: `AAPL Apple Inc P $1,001 - $15,000 (variant ${letterVariant(index)})`,
        confidence: 0.97 - (index % 7) * 0.03,
      }),
    );
    const result = await normalize(env, filing(), parsed);
    expect(result.needsReview).toBe(false);
    expect(result.published).toBe(true);
    expect(cap.insertedTx).toHaveLength(201);
  });

  it('classifies an oversized extraction of duplicated rows as likely_garbage', async () => {
    const { env, cap } = makeEnv([{ ticker: 'AAPL', name: 'Apple Inc.', aliases: '[]' }]);
    const parsed = Array.from({ length: 201 }, () => tx());
    const result = await normalize(env, filing(), parsed);
    expect(result.needsReview).toBe(true);
    expect(cap.insertedTx).toHaveLength(0);
    expect(String(cap.reviewRows[0][1])).toBe('extraction_row_limit_exceeded_likely_garbage:1.00');
  });

  it('does not false-flag invalid_amount when freeform rawText embeds the same canonical bracket', async () => {
    const { env, cap } = makeEnv([{ ticker: 'INTC', name: 'Intel Corporation', aliases: '[]' }]);
    const result = await normalize(
      env,
      filing({ docId: 'H-text', chamber: 'house', docKind: 'text_pdf', extractor: 'textPdf' }),
      [
        tx({
          ticker: 'INTC',
          assetName: 'Intel Corporation',
          amountMin: 1001,
          amountMax: 15000,
          confidence: 0.6,
          rawText:
            'SP Intel Corporation - Common Stock (INTC) [ST] S 11/08/2024 12/11/2024 $1,001 - $15,000 F S: New',
        }),
      ],
      { extractor: 'textPdf' },
    );
    expect(result.needsReview).toBe(false);
    expect(result.published).toBe(true);
    expect(result.minConfidence).toBeGreaterThanOrEqual(DETERMINISTIC_CONFIDENCE_THRESHOLD);
    expect(cap.insertedTx).toHaveLength(1);
    expect(cap.reviewRows).toHaveLength(0);
  });

  it('does not false-flag invalid_amount when rawText also has an address number', async () => {
    const { env, cap } = makeEnv([{ ticker: 'AGIO', name: 'Agios Pharmaceuticals, Inc.', aliases: '[]' }]);
    const result = await normalize(
      env,
      filing({ docId: 'H-agio', chamber: 'house', docKind: 'text_pdf', extractor: 'textPdf' }),
      [
        tx({
          ticker: 'AGIO',
          assetName: 'Agios Pharmaceuticals, Inc.',
          amountMin: 1001,
          amountMax: 15000,
          confidence: 0.6,
          rawText:
            'Agios Pharmaceuticals, Inc. - Common Stock (AGIO) [ST] P 01/29/2025 02/06/2025 $1,001 - $15,000 F S: New S O: 150 Main St',
        }),
      ],
      { extractor: 'textPdf' },
    );
    expect(result.needsReview).toBe(false);
    expect(result.published).toBe(true);
    expect(cap.insertedTx).toHaveLength(1);
  });

  it('demotes a House GS type code stuffed into ticker on a Treasury bill', async () => {
    const { env, cap } = makeEnv([]);
    const result = await normalize(
      env,
      filing({ docId: 'H-2025-20026666', chamber: 'house', docKind: 'text_pdf', extractor: 'openRouterText' }),
      [
        tx({
          ticker: 'GS',
          assetName: 'Treasury Bill (3-Month, Matures 5/1/2025)',
          assetType: 'GS',
          amountMin: 15001,
          amountMax: 50000,
          confidence: 0.6,
          rawText: 'Treasury Bill (3-Month, Matures 5/1/2025) [GS] P $15,001 - $50,000',
        }),
      ],
      { extractor: 'openRouterText' },
    );
    expect(result.published).toBe(true);
    expect(result.needsReview).toBe(false);
    expect(cap.insertedTx).toHaveLength(1);
  });

  it('treats cheap openRouterText on typed PTRs as deterministic', () => {
    expect(isDeterministicExtractor('openRouterText', 'text_pdf')).toBe(true);
    expect(isDeterministicExtractor('openRouterText', 'senate_html')).toBe(true);
    expect(isDeterministicExtractor('openRouterText', 'scanned_pdf')).toBe(false);
    expect(isDeterministicExtractor('openRouterVision', 'text_pdf')).toBe(false);
    expect(confidenceThresholdFor('openRouterText', 'text_pdf')).toBe(DETERMINISTIC_CONFIDENCE_THRESHOLD);
  });

  it('autopublishes cheap openRouterText rows at 0.6 on electronic House PTRs', async () => {
    const { env, cap } = makeEnv([{ ticker: 'AAPL', name: 'Apple Inc.', aliases: '[]' }]);
    const result = await normalize(
      env,
      filing({ docId: 'H-2026-20034898', chamber: 'house', docKind: 'text_pdf', extractor: 'openRouterText' }),
      [tx({ confidence: 0.6, rawText: 'AAPL Apple Inc B $1,001 - $15,000' })],
      { extractor: 'openRouterText' },
    );
    expect(result.minConfidence).toBeLessThan(CONFIDENCE_THRESHOLD);
    expect(result.minConfidence).toBeGreaterThanOrEqual(DETERMINISTIC_CONFIDENCE_THRESHOLD);
    expect(result.needsReview).toBe(false);
    expect(result.published).toBe(true);
    expect(cap.insertedTx).toHaveLength(1);
  });

  it('autopublishes deterministic textPdf rows below vision conf threshold when clean', async () => {
    const { env, cap } = makeEnv([{ ticker: 'AAPL', name: 'Apple Inc.', aliases: '[]' }]);
    const result = await normalize(
      env,
      filing({ docId: 'H-det', chamber: 'house', docKind: 'text_pdf', extractor: 'textPdf' }),
      [tx({ confidence: 0.6, rawText: 'AAPL Apple Inc B $1,001 - $15,000' })],
      { extractor: 'textPdf' },
    );
    expect(result.minConfidence).toBeLessThan(CONFIDENCE_THRESHOLD);
    expect(result.minConfidence).toBeGreaterThanOrEqual(DETERMINISTIC_CONFIDENCE_THRESHOLD);
    expect(result.needsReview).toBe(false);
    expect(result.published).toBe(true);
    expect(cap.insertedTx).toHaveLength(1);
  });

  it('parks mostly-garbage OCR as ocr_unusable extract_empty (not 200 fake review rows)', async () => {
    const { env, cap } = makeEnv([]);
    const garbage = Array.from({ length: 40 }, (_, i) =>
      tx({
        assetName: i % 2 === 0
          ? 'Member of the U.S. House of Representatives Officer or Employee'
          : `unreadable asset p1 y${300 + i}`,
        ticker: null,
        txDate: null,
        amountMin: 250001,
        amountMax: 500000,
        confidence: 0.19,
        rawText: 'form chrome',
      }),
    );
    const result = await normalize(
      env,
      filing({ docId: 'H-scan', chamber: 'house', docKind: 'scanned_pdf', extractor: 'server_cpu_v1' }),
      garbage,
      { extractor: 'server_cpu_v1' },
    );
    expect(result.needsReview).toBe(true);
    expect(result.transactions).toHaveLength(0);
    expect(cap.insertedTx).toHaveLength(0);
    expect(cap.reviewRows).toHaveLength(1);
    const reason = String(cap.reviewRows[0][1]);
    expect(reason).toContain('ocr_unusable');
    expect(reason).toContain('extract_empty_failure');
    const payload = JSON.parse(String(cap.reviewRows[0][2])) as { transactionCount: number };
    expect(payload.transactionCount).toBe(0);
  });

  it('keeps a dated real row in the review payload when the rest is OCR chrome', async () => {
    const { env, cap } = makeEnv([]);
    const garbage = Array.from({ length: 24 }, (_, i) =>
      tx({
        assetName: `unreadable asset p1 y${300 + i}`,
        ticker: null,
        txDate: null,
        amountMin: 250001,
        amountMax: 500000,
        confidence: 0.19,
        rawText: 'form chrome',
      }),
    );
    garbage.push(tx({
      assetName: 'Apple Inc.',
      ticker: 'AAPL',
      txDate: '2025-02-19',
      amountMin: 1001,
      amountMax: 15000,
      confidence: 0.95,
      rawText: 'Apple Inc. (AAPL) [ST] P 02/19/2025 02/19/2025 $1,001 - $15,000',
    }));
    const result = await normalize(
      env,
      filing({ docId: 'H-mix', chamber: 'house', docKind: 'scanned_pdf', extractor: 'server_cpu_v1' }),
      garbage,
      { extractor: 'server_cpu_v1' },
    );
    expect(result.needsReview).toBe(true);
    expect(result.published).toBe(false);
    expect(cap.insertedTx).toHaveLength(0);
    const payload = JSON.parse(String(cap.reviewRows[0][2])) as {
      transactionCount: number;
      transactions: Array<{ ticker?: string | null }>;
    };
    expect(payload.transactionCount).toBeGreaterThanOrEqual(1);
    expect(payload.transactions.some((row) => row.ticker === 'AAPL')).toBe(true);
  });

  it('classifies expanded form-chrome and garbage-ratio helpers', () => {
    expect(looksLikeHeaderContaminatedAsset('Member of the U.S. House of Representatives')).toBe(true);
    expect(looksLikeHeaderContaminatedAsset('unreadable asset p1 y331')).toBe(true);
    expect(looksLikeHeaderContaminatedAsset('Apple Inc.')).toBe(false);
    expect(looksLikeHeaderContaminatedAsset('The following information serves to identify the previously and erroneously filed periodic')).toBe(true);
    expect(isMostlyGarbageOcrExtraction(100, 5, 5)).toBe(true);
    expect(isMostlyGarbageOcrExtraction(10, 9, 0)).toBe(false);
  });
});


describe('scoreFields ticker/asset-name consistency (informational, unpenalized)', () => {
  const passthroughResolve = (ticker: string | null) => ticker;
  const baseFields = {
    ticker: 'AAPL',
    assetName: 'Apple Inc.',
    amountMin: 1001,
    amountMax: 15000,
    txType: 'B',
    txDate: '2024-06-14',
    rawText: 'AAPL Apple Inc P $1,001 - $15,000',
  };

  it('flags ticker_asset_mismatch when the ticker resolves to a known but different company', () => {
    const nameIndex: NameIndex = new Map([['AAPL', 'apple']]);
    const scored = scoreFields(
      0.97,
      { ...baseFields, ticker: 'AAPL', assetName: 'Tesla Inc' },
      '2024-07-01',
      passthroughResolve,
      nameIndex,
    );
    expect(scored.flags).toContain('ticker_asset_mismatch');
    // Informational only: no confidence penalty, unlike every other flag here.
    expect(scored.confidence).toBe(0.97);
  });

  it('does not flag a match (allowing partial/legacy company-name forms)', () => {
    const nameIndex: NameIndex = new Map([['AAPL', 'apple']]);
    const scored = scoreFields(0.97, baseFields, '2024-07-01', passthroughResolve, nameIndex);
    expect(scored.flags).not.toContain('ticker_asset_mismatch');
  });

  it('does not flag a mismatch when the ticker has no known name (e.g. crypto/bond tickers not in either table)', () => {
    const nameIndex: NameIndex = new Map(); // no BTC entry -- absence of data is not evidence of mismatch
    const scored = scoreFields(
      0.97,
      { ...baseFields, ticker: 'BTC', assetName: 'BTC' },
      '2024-07-01',
      passthroughResolve,
      nameIndex,
    );
    expect(scored.flags).not.toContain('ticker_asset_mismatch');
  });

  it('does not flag a mismatch when the asset name is just the ticker symbol', () => {
    const nameIndex: NameIndex = new Map([['ACN', 'accenture']]);
    const scored = scoreFields(
      0.97,
      { ...baseFields, ticker: 'ACN', assetName: 'ACN' },
      '2024-07-01',
      passthroughResolve,
      nameIndex,
    );
    expect(scored.flags).not.toContain('ticker_asset_mismatch');
  });

  it('does not flag a mismatch when no nameIndex is supplied (backward compatible with existing callers)', () => {
    const scored = scoreFields(
      0.97,
      { ...baseFields, ticker: 'AAPL', assetName: 'Tesla Inc' },
      '2024-07-01',
      passthroughResolve,
    );
    expect(scored.flags).not.toContain('ticker_asset_mismatch');
  });

  it('does not flag invalid_amount when rawText is a fund name with a digit', () => {
    const scored = scoreFields(
      0.97,
      {
        ticker: null,
        assetName: 'BDT Capital Partners Fund 4 LP',
        amountMin: 250001,
        amountMax: 500000,
        txType: 'S',
        txDate: '2025-12-19',
        rawText: 'BDT Capital Partners Fund 4 LP',
      },
      '2026-01-15',
      () => null,
    );
    expect(scored.flags).not.toContain('invalid_amount');
    expect(scored.confidence).toBe(0.97);
  });
});


describe('constant-type vision extraction review round trip', () => {
  it.each(['S', 'E'] as const)('preserves all-%s rows through staging and explicit confirmation', async (type) => {
    const { rejectConstantColumnReads, CONSTANT_COLUMN_WARNING } = await import('../visionIntegrityGuards.ts');
    const { buildAdminRouter } = await import('../../admin/routes.ts');
    const { env, cap } = makeEnv([{ ticker: 'AAPL', name: 'Apple Inc.', aliases: '[]' }]);
    const parsed = ['2024-06-14', '2024-06-15', '2024-06-16'].map((date) => tx({ txDate: date, txType: type, rawText: `AAPL Apple Inc ${type} $1,001 - $15,000` }));
    const guarded = rejectConstantColumnReads(parsed);
    expect(guarded.rows.map((r) => r.txType)).toEqual([type, type, type]);
    expect(parsed.every((r) => !r.extractionWarnings?.includes(CONSTANT_COLUMN_WARNING))).toBe(true);
    const result = await normalize(env, filing(), guarded.rows, { source: 'local_mac', extractor: 'mac_vision', modelVersion: 'fixture' });
    expect(result.needsReview).toBe(true);
    expect(result.published).toBe(false);
    expect(cap.insertedTx).toHaveLength(0);
    const payloadText = cap.reviewRows.flat().find((v) => typeof v === 'string' && v.startsWith('{') && v.includes('"transactions"')) as string;
    expect(payloadText).toBeDefined();
    const payload = JSON.parse(payloadText);
    expect(payload.transactions).toHaveLength(3);
    expect(payload.transactions.every((r: { txType: string; flags: string[] }) => r.txType === type && r.flags.includes(CONSTANT_COLUMN_WARNING))).toBe(true);

    // Exercise the real admin confirm handler with exactly the staged candidate
    // values. Capture its explicit insertRows payload, not a reimplemented writer.
    const originalPrepare = env.DB.prepare.bind(env.DB);
    env.DB.prepare = ((sql: string) => {
      const stmt = originalPrepare(sql);
      const first = stmt.first.bind(stmt);
      // Confirm's outbox INSERT selects already-inserted transactions rather
      // than normalize's JSON-backed row list; it is outside this type assertion.
      if (/INSERT OR IGNORE INTO delivery_outbox/i.test(sql)) {
        stmt.run = (async () => ({ success: true, meta: { changes: 3 } })) as typeof stmt.run;
      }
      stmt.first = (async () => {
        if (/FROM review_queue WHERE doc_id/i.test(sql)) return { doc_id: 'doc1', reason: CONSTANT_COLUMN_WARNING, payload: payloadText, resolved: 0, review_revision: 1 };
        if (/FROM filings WHERE doc_id/i.test(sql)) return { filer_id: 'F1', first_seen_at: null, filed_date: '2024-07-01', filing_status: null };
        return first();
      }) as typeof stmt.first;
      return stmt;
    }) as typeof env.DB.prepare;
    const response = await buildAdminRouter().request('/review/doc1', {
      method: 'POST', headers: { Authorization: 'Bearer admin-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'confirm', reviewRevision: 1, edits: payload.transactions }),
    }, { ...env, ADMIN_TOKEN: 'admin-secret' });
    expect(response.status).toBe(200);
    expect(cap.insertedTx).toHaveLength(3);
    expect(cap.insertedTx.map((r) => r.txType)).toEqual([type, type, type]);
  });
});

describe('normalize — 278-T row completeness gate', () => {
  const HEADER = 'Transactions # DESCRIPTION TYPE DATE NOTIFICATION RECEIVED OVER 30 DAYS AGO AMOUNT';
  const NAMES = ['Apple Inc.', 'Microsoft Corp.', 'Badger Meter Inc.', 'Teleflex Inc.', 'Etsy Inc.', 'Lazard Inc.', 'Costco Whsl Corp.', 'Plexus Corp.', 'Cooper Cos Inc.', 'Xencor Inc.'];
  const text = (garble: number[]) => `Trump, Donald J. - Page 2 ${HEADER} ${NAMES.map((name, i) =>
    `${i + 1} ${name} ${garble.includes(i + 1) ? 'Salo' : 'Sale'} 07/29/2026 No $1,001 - $15,000`).join(' ')} Endnotes`;
  const execFiling = () => filing({
    docId: 'E-2026-test-09-08-2026-278t',
    chamber: 'executive',
    filerId: 'EXEC-TEST',
    filedDate: '2026-09-08',
    docKind: 'text_pdf',
    extractor: 'ogeText',
  });

  it('holds a text-layer parse that dropped a numbered row instead of publishing the rest', async () => {
    const { env, cap } = makeEnv([]);
    const sourceText = text([5]);
    const parsed = parseOgeTransactionRows(sourceText);
    expect(parsed).toHaveLength(9);
    const result = await normalize(env, execFiling(), parsed, {
      extractor: 'ogeText',
      sourceText,
      parseDisposition: 'rows',
    });
    expect(result.needsReview).toBe(true);
    expect(result.published).toBe(false);
    expect(result.reviewReason?.split(',')[0]).toBe('oge_rows_incomplete');
    expect(cap.insertedTx).toHaveLength(0);
    expect(String(cap.reviewRows[0][1])).toContain('oge_rows_incomplete');
  });

  it('does not hold a complete parse for completeness', async () => {
    const { env } = makeEnv([]);
    const sourceText = text([]);
    const parsed = parseOgeTransactionRows(sourceText);
    expect(parsed).toHaveLength(10);
    const result = await normalize(env, execFiling(), parsed, {
      extractor: 'ogeText',
      sourceText,
      parseDisposition: 'rows',
    });
    expect(result.reviewReason ?? '').not.toContain('oge_rows_incomplete');
  });
});
