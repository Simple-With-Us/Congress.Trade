import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import {
  buildBatch, contextFromEnv, extractClaude, extractKody, parseMessages, postBatch, run, INGEST_URL,
} from '../report.mjs';

const SECRET = 'synthetic-ingest-token-not-real-0123456789';
const baseEnv = {
  GITHUB_REPOSITORY: 'Simple-With-Us/Example', GITHUB_RUN_ID: '991', GITHUB_RUN_ATTEMPT: '2',
  UM_HARNESS: 'claude-code-ci', UM_PR_NUMBER: '42', UM_STEP: 'fix', UM_PROVIDER: 'minimax',
  UM_REQUESTED_MODEL: 'MiniMax-M3.1-Flash-Preview', UM_WORKFLOW: 'pr-autofix-reusable',
};
const result = {
  type: 'result', subtype: 'success', is_error: false, duration_ms: 12345, num_turns: 7, total_cost_usd: 1.23,
  usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 4000, cache_creation_input_tokens: 300,
    cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 100 } },
  modelUsage: { 'MiniMax-M3.1-Flash-Preview': { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 4000,
    cacheCreationInputTokens: 300, costUSD: 1.23 } },
};
const stream = [{ type: 'system', subtype: 'init' }, { type: 'assistant', message: {} }, result].map((m) => JSON.stringify(m)).join('\n');

test('parses both the stream-json transcript and the SDK message array', () => {
  assert.equal(parseMessages(stream).length, 3);
  assert.equal(parseMessages(`not json\n${stream}\n{broken`).length, 3);
  assert.equal(parseMessages(JSON.stringify([{ type: 'result' }, 'x', 1])).length, 1);
  assert.equal(extractClaude(JSON.stringify([result]), '').models[0].input, 100);
});

test('claude result becomes tokens, duration, and a model from modelUsage', () => {
  const summary = extractClaude(stream, 'ignored');
  assert.deepEqual(summary.models[0], { model: 'MiniMax-M3.1-Flash-Preview', input: 100, output: 50, cacheRead: 4000, cacheWrite: 300, costUsd: 1.23 });
  assert.equal(summary.durationMs, 12345);
  assert.equal(summary.outcome, 'success');
  assert.equal(extractClaude('{"type":"assistant"}'), null);
});

test('without modelUsage the requested model and the cache write split are used', () => {
  const { modelUsage, ...bare } = result;
  const summary = extractClaude(JSON.stringify(bare), 'MiniMax-M3');
  assert.equal(summary.models[0].model, 'MiniMax-M3');
  assert.equal(summary.models[0].cacheWrite5m, 200);
  assert.equal(summary.models[0].cacheWrite1h, 100);
});

test('hostile numbers are clamped to zero instead of poisoning the ledger', () => {
  const summary = extractClaude(JSON.stringify({ type: 'result', duration_ms: -5, usage: { input_tokens: -1, output_tokens: 1e30, cache_read_input_tokens: '9', cache_creation_input_tokens: 1.5 } }), 'm');
  assert.deepEqual(summary.models[0], { model: 'm', input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite5m: null, cacheWrite1h: null, costUsd: null });
  assert.equal(summary.durationMs, null);
});

test('v2 event carries the canonical ai keys, the run identity, and an idempotent event id', () => {
  const batch = buildBatch(contextFromEnv(baseEnv), extractClaude(stream), new Date('2026-10-17T12:00:00Z'));
  assert.equal(batch.schemaVersion, 2);
  assert.equal(batch.producerId, 'ci-autofix');
  const [event] = batch.events;
  assert.equal(event.eventId, 'Simple-With-Us/Example:991:2:fix:MiniMax-M3.1-Flash-Preview');
  assert.equal(event.provider, 'minimax');
  assert.equal(event.metricType, 'usage');
  assert.equal(event.unit, 'token');
  assert.equal(event.quantity, 4450);
  assert.equal(event.occurredAt, '2026-10-17T12:00:00.000Z');
  assert.equal(event.metadata['ai.harness'], 'claude-code-ci');
  assert.equal(event.metadata['ai.billingMode'], 'payg');
  assert.equal(event.metadata['ai.model.served'], 'MiniMax-M3.1-Flash-Preview');
  assert.equal(event.metadata['ai.tokens.cacheRead'], 4000);
  assert.equal(event.metadata['ai.tokens.cacheWrite'], 300);
  assert.equal(event.metadata['ai.durationMs'], 12345);
  assert.equal(event.metadata.prNumber, 42);
  assert.equal(event.metadata.runId, '991');
  assert.equal(event.metadata.runUrl, 'https://github.com/Simple-With-Us/Example/actions/runs/991');
  assert(Object.keys(event.metadata).length <= 50);
  assert(Object.keys(event.metadata).every((key) => key.length <= 80));
});

test('the CLI cost is only a first-class cost for an Anthropic-served model', () => {
  const [minimax] = buildBatch(contextFromEnv(baseEnv), extractClaude(stream)).events;
  assert.equal('costUsd' in minimax, false);
  assert.equal(minimax.metadata['ai.cliReportedCostUsd'], 1.23);
  assert.equal(minimax.billingMode, 'actual');
  const anthropic = { ...result, modelUsage: { 'claude-sonnet-4-5': { ...result.modelUsage['MiniMax-M3.1-Flash-Preview'] } } };
  const [claude] = buildBatch(contextFromEnv(baseEnv), extractClaude(JSON.stringify(anthropic))).events;
  assert.equal(claude.costUsd, 1.23);
  assert.equal(claude.billingMode, 'estimated');
  assert.equal(claude.metadata['ai.costSource'], 'estimated');
});

test('several models share one run duration and one request', () => {
  const two = { ...result, modelUsage: { a: { inputTokens: 1, outputTokens: 1 }, b: { inputTokens: 2, outputTokens: 2 } } };
  const events = buildBatch(contextFromEnv(baseEnv), extractClaude(JSON.stringify(two))).events;
  assert.equal(events.length, 2);
  assert.equal(events[0].requests, 1);
  assert.equal(events[1].requests, 0);
  assert.equal('ai.durationMs' in events[1].metadata, false);
  assert.notEqual(events[0].eventId, events[1].eventId);
});

test('kody sidecar maps to the kody harness', () => {
  const sidecar = JSON.stringify({ model: 'MiniMax-M3', inputTokens: 900, outputTokens: 120, cacheReadTokens: 50, reasoningTokens: 30, durationMs: 8000, outcome: 'complete' });
  const batch = buildBatch(contextFromEnv({ ...baseEnv, UM_HARNESS: 'kody', UM_STEP: 'generate' }), extractKody(sidecar));
  const [event] = batch.events;
  assert.equal(event.metadata['ai.harness'], 'kody');
  assert.equal(event.metadata['ai.tokens.reasoning'], 30);
  assert.equal(event.quantity, 1070);
  assert.equal(extractKody('nope'), null);
});

test('an unknown harness or missing run identity builds nothing', () => {
  assert.equal(buildBatch(contextFromEnv({ ...baseEnv, UM_HARNESS: 'other' }), extractClaude(stream)), null);
  assert.equal(buildBatch(contextFromEnv({ ...baseEnv, GITHUB_RUN_ID: '' }), extractClaude(stream)), null);
});

test('posting retries server errors, stops on client errors, and never leaks the token', async () => {
  const batch = buildBatch(contextFromEnv(baseEnv), extractClaude(stream));
  const calls = [];
  const flaky = async (url, options) => {
    calls.push({ url, options });
    return calls.length < 3 ? new Response('{}', { status: 503 }) : new Response(JSON.stringify({ ok: true, received: 1, persisted: 1, duplicates: 0, rejected: 0 }), { status: 200 });
  };
  const waits = [];
  const status = await postBatch(batch, SECRET, { fetchImpl: flaky, wait: async (ms) => { waits.push(ms); } });
  assert.equal(status, 'ok received=1 persisted=1 duplicates=0 rejected=0');
  assert.equal(calls.length, 3);
  assert.deepEqual(waits, [1000, 2000]);
  assert.equal(calls[0].url, INGEST_URL);
  assert.equal(calls[0].options.headers['x-usage-telemetry-version'], '2');
  assert.equal(calls[0].options.redirect, 'error');

  const denied = [];
  assert.equal(await postBatch(batch, SECRET, { fetchImpl: async () => { denied.push(1); return new Response('{}', { status: 401 }); }, wait: async () => {} }), 'http_401');
  assert.equal(denied.length, 1);
  assert.equal(await postBatch(batch, SECRET, { fetchImpl: async () => { throw new Error(SECRET); }, wait: async () => {} }), 'network_error');
});

test('run is a quiet no-op without a token and never makes a request', async () => {
  let called = false;
  const line = await run({ ...baseEnv }, { fetchImpl: async () => { called = true; } });
  assert.match(line, /not set/);
  assert.equal(called, false);
});

test('run reports end to end, survives bad input, and does not print the token', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ci-usage-report-'));
  try {
    const file = join(dir, 'stream.ndjson');
    await writeFile(file, stream);
    const seen = [];
    const env = { ...baseEnv, USAGE_INGEST_TOKEN: SECRET, UM_INPUT_FILE: file, UM_INPUT_KIND: 'claude' };
    const line = await run(env, { fetchImpl: async (url, options) => { seen.push(JSON.parse(options.body)); return new Response(JSON.stringify({ ok: true, received: 1, persisted: 1, duplicates: 0, rejected: 0 })); } });
    assert.match(line, /^::notice::usage report ok/);
    assert.equal(seen[0].events[0].metadata['ai.tokens.output'], 50);
    assert(!JSON.stringify(seen).includes(SECRET));
    assert(!line.includes(SECRET));

    assert.match(await run({ ...env, UM_INPUT_FILE: join(dir, 'missing') }), /no readable result file/);
    await writeFile(file, 'not a transcript');
    assert.match(await run(env), /no usage in the result file/);
    const link = join(dir, 'link');
    await symlink(file, link);
    assert.match(await run({ ...env, UM_INPUT_FILE: link }), /no readable result file/);
    const failing = await run({ ...env, UM_INPUT_FILE: file }, { fetchImpl: async () => { throw new Error('boom'); } });
    assert.match(failing, /no usage in the result file/);
    await writeFile(file, stream);
    const offline = await run(env, { fetchImpl: async () => { throw new Error('offline'); }, wait: async () => {} });
    assert.match(offline, /^::warning::usage report not delivered \(network_error\)/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the composite action masks the token, skips quietly, and cannot fail the job', () => {
  const action = readFileSync(new URL('../action.yml', import.meta.url), 'utf8');
  assert.match(action, /continue-on-error: true/);
  assert.match(action, /::add-mask::\$USAGE_INGEST_TOKEN/);
  assert.match(action, /-z "\$\{USAGE_INGEST_TOKEN:-\}"/);
  assert.match(action, /\|\| echo "::warning::usage report did not complete"\n\s+exit 0/);
  assert(!/secrets\./.test(action), 'the action reads its credential only through an input');
});
