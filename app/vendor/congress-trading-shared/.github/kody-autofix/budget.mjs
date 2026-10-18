// Disabled-by-default trusted gateway.  No credentials reach the model process.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const BUDGET_LIMITS = Object.freeze({ inputTokens: 1_048_576, outputTokens: 4096,
  requestBytes: 256_000, responseBytes: 512_000, budgetResponseBytes: 16_000 });
const PROVIDERS = Object.freeze({
  deepseek: { model: 'deepseek-flash', url: 'https://api.deepseek.com/anthropic/v1/messages', key: 'DEEPSEEK_API_KEY' },
  minimax: { model: 'MiniMax-M2.7', url: 'https://api.minimax.io/anthropic/v1/messages', key: 'MINIMAX_API_KEY' },
});
const sha = value => createHash('sha256').update(value).digest('hex');
const serverClock = Symbol('budget-server-clock');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
function keys(value, allowed) {
  assert(object(value) && Object.keys(value).every(key => allowed.includes(key)), 'Unsupported gateway field.');
}
function textBlock(block) {
  keys(block, ['type', 'text', 'cache_control']);
  assert.equal(block.type, 'text'); assert.equal(typeof block.text, 'string');
  // Claude Code emits cache hints.  Never forward them to either provider.
  return { type: 'text', text: block.text };
}
function content(value, role) {
  if (typeof value === 'string') return value;
  assert(Array.isArray(value) && value.length <= 1000, 'Unsupported message content.');
  return value.map(block => {
    if (block?.type === 'text') return textBlock(block);
    if (block?.type === 'thinking' && role === 'assistant') {
      keys(block, ['type', 'thinking', 'signature']);
      assert.equal(typeof block.thinking, 'string');
      assert(block.signature === undefined || typeof block.signature === 'string');
      return { ...block };
    }
    if (block?.type === 'tool_use' && role === 'assistant') {
      keys(block, ['type', 'id', 'name', 'input']);
      assert.equal(block.name, 'StructuredOutput');
      assert.equal(typeof block.id, 'string'); assert(object(block.input));
      return { ...block };
    }
    if (block?.type === 'tool_result' && role === 'user') {
      keys(block, ['type', 'tool_use_id', 'content', 'is_error', 'cache_control']);
      assert.equal(typeof block.tool_use_id, 'string');
      assert(block.is_error === undefined || typeof block.is_error === 'boolean');
      return { type: 'tool_result', tool_use_id: block.tool_use_id,
        content: typeof block.content === 'string' ? block.content : block.content.map(textBlock),
        ...(block.is_error === undefined ? {} : { is_error: block.is_error }) };
    }
    throw new Error('Unsupported gateway content.');
  });
}
/** Rebuild the request; reject server tools, media, extensions and paid tiers. */
export function boundedMessage(body, outputSchema) {
  keys(body, ['model', 'messages', 'system', 'max_tokens', 'stream', 'tools', 'tool_choice',
    'thinking', 'temperature', 'top_p', 'metadata', 'output_config', 'service_tier', 'context_management']);
  assert.equal(body.model, 'deepseek-flash', 'Unexpected CLI model.');
  assert(body.service_tier === undefined || body.service_tier === 'standard', 'Unsupported tier.');
  assert(body.stream === undefined || typeof body.stream === 'boolean');
  assert(body.max_tokens === undefined || (integer(body.max_tokens) && body.max_tokens > 0));
  assert(Array.isArray(body.messages) && body.messages.length > 0 && body.messages.length <= 1000);
  const result = { model: body.model,
    max_tokens: Math.min(body.max_tokens ?? BUDGET_LIMITS.outputTokens, BUDGET_LIMITS.outputTokens),
    stream: body.stream ?? false,
    messages: body.messages.map(message => {
      keys(message, ['role', 'content']); assert(['user', 'assistant'].includes(message.role));
      return { role: message.role, content: content(message.content, message.role) };
    }),
  };
  if (body.system !== undefined) result.system = typeof body.system === 'string' ? body.system : body.system.map(textBlock);
  if (body.tools !== undefined) {
    assert(Array.isArray(body.tools) && body.tools.length <= 1);
    result.tools = body.tools.map(tool => {
      keys(tool, ['name', 'description', 'input_schema', 'cache_control']);
      assert.equal(tool.name, 'StructuredOutput'); assert.deepEqual(tool.input_schema, outputSchema);
      assert(tool.description === undefined || typeof tool.description === 'string');
      return { name: tool.name, input_schema: outputSchema, ...(tool.description ? { description: tool.description } : {}) };
    });
  }
  if (body.tool_choice !== undefined) {
    keys(body.tool_choice, ['type', 'name', 'disable_parallel_tool_use']);
    assert(['auto', 'any', 'tool', 'none'].includes(body.tool_choice.type));
    assert(body.tool_choice.name === undefined || body.tool_choice.name === 'StructuredOutput');
    assert(body.tool_choice.disable_parallel_tool_use === undefined || typeof body.tool_choice.disable_parallel_tool_use === 'boolean');
    result.tool_choice = { ...body.tool_choice, disable_parallel_tool_use: true };
  }
  // Both allowed providers count all thinking in max_tokens.  Their defaults
  // retain thinking; client-specific budget/effort/cache/context-management
  // hints are not copied.  The pinned CLI emits context_management even with
  // tools disabled; discarding it cannot expand provider capabilities.
  assert(Buffer.byteLength(JSON.stringify(result)) <= BUDGET_LIMITS.requestBytes);
  return result;
}

async function responseBytes(response, maxBytes) {
  assert(response.body, 'Missing response body.');
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length; assert(size <= maxBytes, 'Oversized response.'); chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
async function boundedFetch(fetcher, url, options, timeoutMs, maxBytes) {
  const controller = new AbortController(); let timer;
  try {
    return await Promise.race([
      (async () => {
        const response = await fetcher(url, { ...options, redirect: 'error', signal: controller.signal });
        return { response, bytes: await responseBytes(response, maxBytes) };
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Gateway deadline.')); }, timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); controller.abort(); }
}
function receipt(value, requestId) {
  assert(object(value) && value.ok === true && value.requestId === requestId);
  assert(typeof value.reservationId === 'string' && value.reservationId.length > 0);
  assert(Object.hasOwn(PROVIDERS, value.provider) && value.model === PROVIDERS[value.provider].model);
  assert(/^\d{4}-\d{2}-\d{2}$/.test(value.day));
  assert(Number.isFinite(Date.parse(value.dispatchBefore)));
  assert(typeof value.maximumCostMicros === 'string' && /^\d{1,16}$/.test(value.maximumCostMicros));
  return value;
}
/** Only a complete supported usage report releases liability; missing is unknown. */
export function completeUsage(provider, bytes, contentType) {
  try {
    let usage, model, complete = false;
    if (contentType.startsWith('application/json')) {
      const message = JSON.parse(bytes.toString('utf8'));
      assert.equal(message.type, 'message'); model = message.model; usage = message.usage;
      complete = typeof message.stop_reason === 'string' && message.stop_reason.length > 0;
    } else if (contentType.startsWith('text/event-stream')) {
      let started = false, delta = false, stopped = false;
      for (const block of bytes.toString('utf8').replace(/\r\n/g, '\n').split('\n\n')) {
        const lines = block.split('\n').filter(line => line.startsWith('data:'));
        if (!lines.length) continue;
        const event = JSON.parse(lines.map(line => line.slice(5).trimStart()).join('\n'));
        assert(!stopped, 'Data after terminal event.');
        if (event.type === 'message_start') {
          assert(!started); started = true; model = event.message.model; usage = event.message.usage;
          assert(object(usage) && integer(usage.output_tokens));
        } else if (event.type === 'message_delta') {
          assert(started && !delta && object(event.usage)); delta = true;
          // Never inherit message_start's initial zero as the final total.
          assert(Object.hasOwn(event.usage, 'output_tokens') && integer(event.usage.output_tokens));
          assert(event.usage.output_tokens >= usage.output_tokens, 'Output total decreased.');
          assert(typeof event.delta?.stop_reason === 'string' && event.delta.stop_reason.length > 0);
          // Output is cumulative, not additive.  Conflicting repeated input
          // counters are not accepted as evidence of a cheaper request.
          for (const key of ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
            assert(event.usage[key] === undefined || event.usage[key] === usage?.[key]);
          }
          usage = { ...usage, ...event.usage };
        } else if (event.type === 'message_stop') { assert(started && delta); stopped = true; }
        else if (event.type !== 'ping') {
          assert(started && !delta, 'Content outside generation phase.');
          assert(['content_block_start', 'content_block_delta', 'content_block_stop'].includes(event.type));
        }
      }
      complete = started && delta && stopped;
    }
    assert(complete && model === PROVIDERS[provider].model && object(usage));
    assert(integer(usage.input_tokens) && integer(usage.output_tokens));
    // MiniMax documents separate uncached/read/write counters.  Explicit cache
    // writes are disallowed; unknown fields must not silently become zero.
    assert(integer(usage.cache_read_input_tokens) && usage.cache_creation_input_tokens === 0);
    if (provider === 'deepseek' && usage.cache_read_input_tokens !== 0) {
      // DeepSeek's public Anthropic guide doesn't define cached-input response
      // counter composition.  Retain the full bound until that mapping is proved.
      return null;
    }
    const inputTokens = usage.input_tokens + usage.cache_read_input_tokens;
    assert(integer(inputTokens) && inputTokens <= 10_000_000 && usage.output_tokens <= 1_000_000);
    return { inputTokens, cachedInputTokens: usage.cache_read_input_tokens, outputTokens: usage.output_tokens };
  } catch { return null; }
}

/** No enabled flag, no monitor network, no provider network, and no CLI launch. */
export function createBudgetedProvider(env, identity, outputSchema, fetcher = fetch, beforeDispatch = () => {}) {
  env = Object.freeze({ ...env });
  assert.equal(env.SWU_KODY_FLEET_BUDGET_ENABLED, 'true', 'Fleet budget gateway is disabled.');
  assert.equal(env.FLEET_BUDGET_URL, 'https://usage.jays.services/api/ingest/fleet-budget', 'Unexpected budget destination.');
  assert(typeof env.FLEET_BUDGET_TOKEN === 'string' && env.FLEET_BUDGET_TOKEN.length >= 32 && env.FLEET_BUDGET_TOKEN.length <= 256,
    'Dedicated budget credential is required.');
  assert(typeof identity === 'string' && identity.length > 0 && identity.length <= 1000);
  let ordinal = 0, busy = false, failed = false;
  async function command(body, attempts = 3) {
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const { response, bytes } = await boundedFetch(fetcher, env.FLEET_BUDGET_URL, {
          method: 'POST', headers: { authorization: `Bearer ${env.FLEET_BUDGET_TOKEN}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }, 10_000, BUDGET_LIMITS.budgetResponseBytes);
        assert.equal(response.headers.get('x-api-version'), '1', 'Budget protocol mismatch.');
        if (!response.ok) {
          if ([429, 503].includes(response.status) && attempt + 1 < attempts) continue;
          throw new Error('Budget command rejected.');
        }
        const value = receipt(JSON.parse(bytes.toString('utf8')), body.requestId);
        if (body.action === 'dispatch') {
          // HTTP Date is second-resolution.  Refuse a materially skewed client
          // clock, then leave a larger safety margin before the server deadline.
          const serverDate = Date.parse(response.headers.get('date') ?? '');
          assert(Number.isFinite(serverDate) && Math.abs(Date.now() - serverDate) <= 2000);
          value[serverClock] = serverDate;
        }
        return value;
      } catch { if (attempt + 1 === attempts) throw new Error('Budget service unavailable.'); }
    }
  }
  return {
    async request(body) {
      assert(!busy && !failed, 'Gateway request unavailable.'); busy = true;
      let requestId, reserved, dispatchAttempted = false;
      try {
        const normalized = boundedMessage(body, outputSchema);
        requestId = `kody:${sha(`${identity}:${++ordinal}:${JSON.stringify(normalized)}`)}`;
        reserved = await command({ action: 'reserve', requestId, route: 'primary',
          maxInputTokens: BUDGET_LIMITS.inputTokens, maxOutputTokens: normalized.max_tokens });
        assert.equal(reserved.status, 'reserved'); assert.equal(reserved.dispatchAllowed, false);
        const provider = PROVIDERS[reserved.provider];
        assert(typeof env[provider.key] === 'string' && env[provider.key].length > 0, 'Selected provider credential is unavailable.');
        const checked = beforeDispatch(); assert(!checked?.then, 'Approval checks must be synchronous.');
        dispatchAttempted = true;
        const dispatched = await command({ action: 'dispatch', requestId }, 1);
        assert.equal(dispatched.reservationId, reserved.reservationId);
        assert.equal(dispatched.provider, reserved.provider); assert.equal(dispatched.model, reserved.model);
        assert.equal(dispatched.day, reserved.day); assert.equal(dispatched.dispatchBefore, reserved.dispatchBefore);
        assert.equal(dispatched.maximumCostMicros, reserved.maximumCostMicros);
        assert.equal(dispatched.status, 'dispatched'); assert.equal(dispatched.dispatchAllowed, true);
        const checkedAgain = beforeDispatch(); assert(!checkedAgain?.then, 'Approval checks must be synchronous.');
        assert(Math.abs(Date.now() - dispatched[serverClock]) <= 2000, 'Dispatch clock changed.');
        assert(Date.now() + 3000 < Date.parse(dispatched.dispatchBefore), 'Dispatch lease expired.');
        // Nothing asynchronous between the final lease/approval check and fetch.
        const { response, bytes } = await boundedFetch(fetcher, provider.url, {
          method: 'POST', headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': env[provider.key] },
          body: JSON.stringify({ ...normalized, model: provider.model, ...(reserved.provider === 'minimax' ? { service_tier: 'standard' } : {}) }),
        }, 90_000, BUDGET_LIMITS.responseBytes);
        const contentType = response.headers.get('content-type') ?? '';
        const usage = response.ok ? completeUsage(reserved.provider, bytes, contentType) : null;
        const settled = await command({ action: 'reconcile', requestId, usage });
        assert.equal(settled.status, usage === null ? 'uncertain' : 'settled');
        if (!response.ok || usage === null) { failed = true; throw new Error('Provider result could not be accounted.'); }
        assert(usage.inputTokens <= BUDGET_LIMITS.inputTokens && usage.outputTokens <= normalized.max_tokens,
          'Provider exceeded the admitted bound.');
        return new Response(bytes, { status: 200, headers: { 'content-type': contentType } });
      } catch {
        failed = true;
        if (reserved && requestId) {
          try {
            // A dispatch timeout may have committed.  Never cancel it or retry
            // upstream; the server retains liability across process loss too.
            await command(dispatchAttempted ? { action: 'reconcile', requestId, usage: null }
              : { action: 'cancel', requestId });
          } catch { /* Liability remains durable when acknowledgement is lost. */ }
        }
        throw new Error('Budgeted provider request failed closed.');
      } finally { busy = false; }
    },
  };
}
