import test from 'node:test';
import assert from 'node:assert/strict';
import { createBudgetedProvider, boundedMessage, completeUsage, BUDGET_LIMITS } from './budget.mjs';

// Every monitor/provider request is injected; no real network is permitted.
globalThis.fetch = async () => assert.fail('Live network is forbidden.');
const outputSchema = { type: 'object', properties: { edits: { type: 'array' } } };
const body = () => ({ model: 'deepseek-flash', max_tokens: 100_000, stream: false,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Synthetic fixture.', cache_control: { type: 'ephemeral' } }] }] });
const env = () => ({ SWU_KODY_FLEET_BUDGET_ENABLED: 'true',
  FLEET_BUDGET_URL: 'https://usage.jays.services/api/ingest/fleet-budget',
  FLEET_BUDGET_TOKEN: 'synthetic-offline-budget-client-token-only',
  DEEPSEEK_API_KEY: 'synthetic-deepseek-only', MINIMAX_API_KEY: 'synthetic-minimax-only' });
function fixture(provider = 'deepseek', change = () => {}) {
  const commands = [], calls = [], rows = new Map();
  const model = provider === 'deepseek' ? 'deepseek-flash' : 'MiniMax-M2.7';
  const settings = { lose: null, loseAlways: false, providerError: false, status: 200, usage: {},
    lease: 60_000, malformed: false, noDate: false, contentType: 'application/json', stream: null };
  const fetcher = async (url, options) => {
    assert.equal(options.redirect, 'error'); assert(options.signal instanceof AbortSignal);
    if (url === env().FLEET_BUDGET_URL) {
      const command = JSON.parse(options.body); commands.push(command);
      assert.equal(options.headers.authorization, `Bearer ${env().FLEET_BUDGET_TOKEN}`);
      assert(!('prompt' in command)); change(command, settings);
      let row = rows.get(command.requestId), dispatchAllowed = false;
      if (command.action === 'reserve') {
        row ??= { reservationId: `id-${rows.size}`, requestId: command.requestId, provider, model,
          day: '2026-10-06', status: 'reserved', maximumCostMicros: '319488',
          dispatchBefore: new Date(Date.now() + settings.lease).toISOString() };
        rows.set(command.requestId, row);
      } else if (command.action === 'dispatch') {
        if (row.status === 'reserved') { row.status = 'dispatched'; dispatchAllowed = true; }
      } else if (command.action === 'cancel') {
        assert.equal(row.status, 'reserved'); row.status = 'cancelled';
      } else if (command.action === 'reconcile') {
        assert(['dispatched', 'uncertain', 'settled'].includes(row.status));
        if (row.status !== 'settled') row.status = command.usage === null ? 'uncertain' : 'settled';
      }
      if (settings.lose === command.action) {
        if (!settings.loseAlways) settings.lose = null;
        throw new Error('Synthetic response loss after commit.');
      }
      return new Response(JSON.stringify({ ok: true, ...row, dispatchAllowed }), { headers: {
        'x-api-version': '1', ...(settings.noDate ? {} : { date: new Date().toUTCString() }),
      } });
    }
    assert.equal(url, provider === 'deepseek' ? 'https://api.deepseek.com/anthropic/v1/messages' : 'https://api.minimax.io/anthropic/v1/messages');
    assert.equal(options.headers['x-api-key'], env()[provider === 'deepseek' ? 'DEEPSEEK_API_KEY' : 'MINIMAX_API_KEY']);
    assert.equal(options.headers.authorization, undefined);
    calls.push(JSON.parse(options.body));
    if (settings.providerError) throw new Error('Synthetic network loss.');
    const response = { id: 'synthetic', type: 'message', role: 'assistant', model, stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Synthetic answer.' }],
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...settings.usage } };
    return new Response(settings.stream ?? (settings.malformed ? 'malformed' : JSON.stringify(response)),
      { status: settings.status, headers: { 'content-type': settings.contentType } });
  };
  return { settings, commands, calls, rows, fetcher,
    gateway: createBudgetedProvider(env(), 'synthetic-run-and-snapshot', outputSchema, fetcher) };
}
test('default off and invalid configuration perform zero network calls', () => {
  for (const config of [{}, { ...env(), SWU_KODY_FLEET_BUDGET_ENABLED: 'false' }, { ...env(), FLEET_BUDGET_URL: 'https://other.invalid' }, { ...env(), FLEET_BUDGET_TOKEN: '' }]) {
    assert.throws(() => createBudgetedProvider(config, 'fixture', outputSchema));
  }
});
test('one-shot reserve and dispatch precede each provider call, then complete usage settles', async () => {
  for (const provider of ['deepseek', 'minimax']) {
    const f = fixture(provider); assert.equal((await f.gateway.request(body())).status, 200);
    assert.deepEqual(f.commands.map(c => c.action), ['reserve', 'dispatch', 'reconcile']);
    assert.equal(f.commands[0].maxInputTokens, 1_048_576); assert.equal(f.commands[0].maxOutputTokens, 4096);
    assert.equal(f.calls[0].max_tokens, 4096); assert.equal(f.calls[0].model, provider === 'deepseek' ? 'deepseek-flash' : 'MiniMax-M2.7');
    assert(!JSON.stringify(f.calls[0]).includes('cache_control'));
    assert.deepEqual(f.commands[2].usage, { inputTokens: 100, cachedInputTokens: 0, outputTokens: 20 });
  }
});
test('invalid media/tools/tiers/extensions cannot reach admission or provider', async () => {
  for (const extra of [{ service_tier: 'priority' }, { tools: [{ name: 'web_search', type: 'web_search' }] },
    { messages: [{ role: 'user', content: [{ type: 'image', source: { url: 'https://private.invalid' } }] }] },
    { mcp_servers: [] }, { max_tokens: -1 }, { max_tokens: 1.5 }, { model: 'claude-opus' }]) {
    const f = fixture(); await assert.rejects(f.gateway.request({ ...body(), ...extra }));
    assert.equal(f.calls.length, 0); assert.equal(f.commands.length, 0);
  }
});
test('only the trusted structured-output tool schema is allowed', () => {
  const input = { ...body(), tools: [{ name: 'StructuredOutput', input_schema: outputSchema, cache_control: { type: 'ephemeral' } }], tool_choice: { type: 'tool', name: 'StructuredOutput' } };
  assert.equal(boundedMessage(input, outputSchema).tools[0].cache_control, undefined);
  assert.throws(() => boundedMessage({ ...input, tools: [{ name: 'StructuredOutput', input_schema: {} }] }, outputSchema));
});
test('pinned CLI context-management hints are discarded, never forwarded upstream', () => {
  const normalized = boundedMessage({ ...body(), context_management: { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] } }, outputSchema);
  assert.equal(normalized.context_management, undefined);
  assert.equal(normalized.max_tokens, 4096);
});
test('lost reserve and reconciliation replies replay the same identity without a second provider call', async () => {
  for (const lost of ['reserve', 'reconcile']) {
    const f = fixture(); f.settings.lose = lost;
    assert.equal((await f.gateway.request(body())).status, 200);
    assert.equal(f.calls.length, 1); assert.equal(f.rows.size, 1);
    assert.equal(new Set(f.commands.map(c => c.requestId)).size, 1);
    assert.equal(f.commands.filter(c => c.action === lost).length, 2);
  }
});
test('lost dispatch reply is never retried and leaves unknown liability without any provider call', async () => {
  const f = fixture(); f.settings.lose = 'dispatch';
  await assert.rejects(f.gateway.request(body()));
  assert.equal(f.calls.length, 0); assert.equal(f.commands.filter(c => c.action === 'dispatch').length, 1);
  assert.equal([...f.rows.values()][0].status, 'uncertain');
  assert(!f.commands.some(c => c.action === 'cancel'));
});
test('a restarted client cannot reuse an already dispatched request as a new permit', async () => {
  const f = fixture(); await f.gateway.request(body());
  const restarted = createBudgetedProvider(env(), 'synthetic-run-and-snapshot', outputSchema, f.fetcher);
  await assert.rejects(restarted.request(body())); assert.equal(f.calls.length, 1);
});
test('expired and unverifiable-clock dispatches do not invoke the provider or cancel liability', async () => {
  for (const change of [s => { s.lease = 2500; }, s => { s.noDate = true; }]) {
    const f = fixture(); change(f.settings); await assert.rejects(f.gateway.request(body()));
    assert.equal(f.calls.length, 0); assert.equal([...f.rows.values()][0].status, 'uncertain');
  }
});
test('approval expiry after dispatch is checked before provider fetch', async () => {
  const f = fixture(); let checks = 0;
  const gateway = createBudgetedProvider(env(), 'fixture', outputSchema, f.fetcher, () => { if (++checks === 2) throw new Error('Expired.'); });
  await assert.rejects(gateway.request(body())); assert.equal(f.calls.length, 0);
  assert.equal([...f.rows.values()][0].status, 'uncertain');
});
test('missing selected-provider credential cancels only a never-dispatched reservation', async () => {
  const f = fixture('minimax'); const settings = env(); delete settings.MINIMAX_API_KEY;
  const gateway = createBudgetedProvider(settings, 'fixture', outputSchema, f.fetcher);
  await assert.rejects(gateway.request(body())); assert.equal(f.calls.length, 0);
  assert.deepEqual(f.commands.map(c => c.action), ['reserve', 'cancel']);
});
test('timeouts, non-success, malformed and unknown usage retain liability and stop later requests', async () => {
  for (const change of [s => { s.providerError = true; }, s => { s.status = 429; }, s => { s.malformed = true; },
    s => { s.usage.output_tokens = null; }, s => { s.usage.cache_read_input_tokens = 1; }, s => { s.usage.cache_creation_input_tokens = 1; }]) {
    const f = fixture(); change(f.settings); await assert.rejects(f.gateway.request(body()));
    await assert.rejects(f.gateway.request(body())); assert.equal(f.calls.length, 1);
    assert.equal([...f.rows.values()][0].status, 'uncertain'); assert(!f.commands.some(c => c.action === 'cancel'));
  }
});
test('MiniMax cached usage counts the documented complete input partition', async () => {
  const f = fixture('minimax'); f.settings.usage.cache_read_input_tokens = 90;
  await f.gateway.request(body()); assert.deepEqual(f.commands.at(-1).usage, { inputTokens: 190, cachedInputTokens: 90, outputTokens: 20 });
});
test('genuine reported token overruns are not clamped away before reconciliation', async () => {
  const f = fixture(); f.settings.usage.output_tokens = 5000;
  await assert.rejects(f.gateway.request(body()));
  assert.equal(f.commands.find(c => c.action === 'reconcile' && c.usage !== null).usage.outputTokens, 5000);
  assert.equal([...f.rows.values()][0].status, 'settled');
  await assert.rejects(f.gateway.request(body())); assert.equal(f.calls.length, 1);
});
test('stream accounting requires start, terminal cumulative output, and message_stop', () => {
  const events = [
    { type: 'message_start', message: { model: 'MiniMax-M2.7', usage: { input_tokens: 5, output_tokens: 0, cache_read_input_tokens: 7, cache_creation_input_tokens: 0 } } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 11 } },
    { type: 'message_stop' },
  ];
  const buffer = list => Buffer.from(list.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''));
  assert.deepEqual(completeUsage('minimax', buffer(events), 'text/event-stream'), { inputTokens: 12, cachedInputTokens: 7, outputTokens: 11 });
  assert.equal(completeUsage('minimax', buffer(events.slice(0, -1)), 'text/event-stream'), null);
  assert.equal(completeUsage('minimax', buffer([...events, events[1]]), 'text/event-stream'), null);
  assert.equal(completeUsage('minimax', buffer([events[0], events[1], events[1], events[2]]), 'text/event-stream'), null);
  for (const usage of [{}, { output_tokens: null }, { output_tokens: '11' }, { output_tokens: -1 }]) {
    assert.equal(completeUsage('minimax', buffer([events[0], { ...events[1], usage }, events[2]]), 'text/event-stream'), null);
  }
  const startWithOutput = { ...events[0], message: { ...events[0].message, usage: { ...events[0].message.usage, output_tokens: 12 } } };
  assert.equal(completeUsage('minimax', buffer([startWithOutput, events[1], events[2]]), 'text/event-stream'), null);
  const content = { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'More output.' } };
  assert.equal(completeUsage('minimax', buffer([content, ...events]), 'text/event-stream'), null);
  assert.equal(completeUsage('minimax', buffer([events[0], events[1], content, events[2]]), 'text/event-stream'), null);
});
test('oversized provider replies cannot settle as zero', async () => {
  const f = fixture(); f.settings.stream = 'x'.repeat(BUDGET_LIMITS.responseBytes + 1);
  await assert.rejects(f.gateway.request(body())); assert.equal([...f.rows.values()][0].status, 'uncertain');
});
test('concurrent calls cannot multiply one client request while admission is pending', async () => {
  const f = fixture(); let release;
  const held = new Promise(resolve => { release = resolve; });
  const gateway = createBudgetedProvider(env(), 'fixture', outputSchema, async (url, options) => {
    if (JSON.parse(options.body).action === 'reserve') await held;
    return f.fetcher(url, options);
  });
  const first = gateway.request(body());
  await assert.rejects(gateway.request(body())); release();
  await first; assert.equal(f.calls.length, 1); assert.equal(f.rows.size, 1);
});
test('a provider fetch that never settles hits the deadline and retains liability', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); let began;
  const started = new Promise(resolve => { began = resolve; });
  const gateway = createBudgetedProvider(env(), 'fixture', outputSchema, async (url, options) => {
    if (url !== env().FLEET_BUDGET_URL) { began(); return new Promise(() => {}); }
    return f.fetcher(url, options);
  });
  const pending = gateway.request(body()); await started;
  t.mock.timers.tick(90_001); await assert.rejects(pending);
  assert.equal([...f.rows.values()][0].status, 'uncertain');
});
