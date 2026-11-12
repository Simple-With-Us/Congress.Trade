#!/usr/bin/env node
// Best-effort usage report for CI autofix runs (UM-1593).  Reads the tool's own result file,
// builds one Usage Monitor v2 event per served model, and posts it.  It has no dependencies,
// never logs the credential, and never exits non-zero:  metering must not fail the job.
import { lstatSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const INGEST_URL = 'https://usage.jays.services/api/ingest/usage';
export const PRODUCER_ID = 'ci-autofix';
const HARNESSES = new Set(['claude-code-ci', 'kody', 'codex-ci']);
const MAX_INPUT_BYTES = 32 * 1024 * 1024;
const MAX_TOKENS = 10_000_000_000;
const MAX_DURATION_MS = 86_400_000;
const POST_ATTEMPTS = 3;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const tokenCount = (value) => (Number.isSafeInteger(value) && value >= 0 && value <= MAX_TOKENS ? value : 0);
const durationOf = (value) => (Number.isSafeInteger(value) && value >= 0 && value <= MAX_DURATION_MS ? value : null);
const text = (value, max = 200) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

/** Parse a transcript that is either one JSON array of messages or newline-delimited JSON. */
export function parseMessages(raw) {
  try {
    const whole = JSON.parse(raw);
    if (Array.isArray(whole)) return whole.filter(isObject);
    if (isObject(whole)) return [whole];
  } catch { /* fall through to line-delimited */ }
  const messages = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (isObject(value)) messages.push(value);
    } catch { /* a stray log line is not a message */ }
  }
  return messages;
}

/** Claude Code result message (`claude -p --output-format stream-json|json`, or claude-code-action). */
export function extractClaude(raw, requestedModel = '') {
  const messages = parseMessages(raw);
  const result = [...messages].reverse().find((message) => message.type === 'result');
  if (!result) return null;
  const usage = isObject(result.usage) ? result.usage : {};
  const models = [];
  if (isObject(result.modelUsage)) {
    for (const [name, row] of Object.entries(result.modelUsage).slice(0, 8)) {
      if (!isObject(row) || !text(name)) continue;
      models.push({
        model: text(name),
        input: tokenCount(row.inputTokens),
        output: tokenCount(row.outputTokens),
        cacheRead: tokenCount(row.cacheReadInputTokens),
        cacheWrite: tokenCount(row.cacheCreationInputTokens),
        costUsd: typeof row.costUSD === 'number' && Number.isFinite(row.costUSD) && row.costUSD >= 0 ? row.costUSD : null,
      });
    }
  }
  if (models.length === 0) {
    const split = isObject(usage.cache_creation) ? usage.cache_creation : {};
    models.push({
      model: text(requestedModel) || 'unknown',
      input: tokenCount(usage.input_tokens),
      output: tokenCount(usage.output_tokens),
      cacheRead: tokenCount(usage.cache_read_input_tokens),
      cacheWrite: tokenCount(usage.cache_creation_input_tokens),
      cacheWrite5m: split.ephemeral_5m_input_tokens === undefined ? null : tokenCount(split.ephemeral_5m_input_tokens),
      cacheWrite1h: split.ephemeral_1h_input_tokens === undefined ? null : tokenCount(split.ephemeral_1h_input_tokens),
      costUsd: typeof result.total_cost_usd === 'number' && Number.isFinite(result.total_cost_usd) && result.total_cost_usd >= 0
        ? result.total_cost_usd : null,
    });
  }
  return {
    source: 'claude-result',
    outcome: text(result.subtype, 80) || 'unknown',
    isError: result.is_error === true,
    durationMs: durationOf(result.duration_ms),
    turns: Number.isSafeInteger(result.num_turns) && result.num_turns >= 0 ? Math.min(result.num_turns, 1_000_000) : null,
    models,
  };
}

/** Sidecar written by the Kody helper (`usage.json`):  one OpenAI-compatible chat completion. */
export function extractKody(raw, requestedModel = '') {
  let sidecar;
  try { sidecar = JSON.parse(raw); } catch { return null; }
  if (!isObject(sidecar)) return null;
  return {
    source: 'kody-chat-completion',
    outcome: text(sidecar.outcome, 80) || 'unknown',
    isError: sidecar.outcome === 'incomplete',
    durationMs: durationOf(sidecar.durationMs),
    turns: 1,
    models: [{
      model: text(sidecar.model) || text(requestedModel) || 'unknown',
      input: tokenCount(sidecar.inputTokens),
      output: tokenCount(sidecar.outputTokens),
      cacheRead: tokenCount(sidecar.cacheReadTokens),
      cacheWrite: 0,
      reasoning: sidecar.reasoningTokens === undefined ? null : tokenCount(sidecar.reasoningTokens),
      costUsd: null,
    }],
  };
}

/** Everything about the run that is not in the tool result.  Plain strings only. */
export function contextFromEnv(env) {
  const harness = text(env.UM_HARNESS, 40);
  return {
    harness,
    provider: text(env.UM_PROVIDER, 80) || 'minimax',
    requestedModel: text(env.UM_REQUESTED_MODEL, 120),
    repo: text(env.GITHUB_REPOSITORY, 140),
    runId: text(env.GITHUB_RUN_ID, 40),
    runAttempt: text(env.GITHUB_RUN_ATTEMPT, 10) || '1',
    step: text(env.UM_STEP, 60) || 'autofix',
    prNumber: /^[0-9]{1,10}$/.test(text(env.UM_PR_NUMBER, 12)) ? Number(env.UM_PR_NUMBER) : null,
    workflow: text(env.UM_WORKFLOW, 120),
    server: text(env.GITHUB_SERVER_URL, 100) || 'https://github.com',
  };
}

/** Build the v2 batch, or null when there is nothing trustworthy to report. */
export function buildBatch(context, summary, now = new Date()) {
  if (!summary || !HARNESSES.has(context.harness) || !context.repo || !context.runId) return null;
  const events = summary.models.slice(0, 8).map((row, index) => {
    const cacheWrite = row.cacheWrite ?? 0;
    const total = row.input + row.output + row.cacheRead + cacheWrite;
    // The CLI prices every model it does not know at a default Anthropic rate, so a figure for a
    // non-Anthropic model is only a hint.  Only an Anthropic-served model's cost goes in costUsd.
    const trustedCost = row.costUsd !== null && /^claude-/.test(row.model);
    const metadata = {
      'ai.schemaRef': 'UM-1592-draft',
      'ai.harness': context.harness,
      'ai.model.requested': context.requestedModel || row.model,
      'ai.model.served': row.model,
      'ai.tokens.input': row.input,
      'ai.tokens.output': row.output,
      'ai.tokens.cacheRead': row.cacheRead,
      'ai.tokens.cacheWrite': cacheWrite,
      'ai.billingMode': 'payg',
      'ai.tokenSource': summary.source,
      ci: true,
      repo: context.repo,
      runId: context.runId,
      runAttempt: Number(context.runAttempt) || 1,
      step: context.step,
      outcome: summary.outcome,
      failed: summary.isError,
      runUrl: `${context.server}/${context.repo}/actions/runs/${context.runId}`,
    };
    if (row.cacheWrite5m !== undefined && row.cacheWrite5m !== null) metadata['ai.tokens.cacheWrite5m'] = row.cacheWrite5m;
    if (row.cacheWrite1h !== undefined && row.cacheWrite1h !== null) metadata['ai.tokens.cacheWrite1h'] = row.cacheWrite1h;
    if (row.reasoning !== undefined && row.reasoning !== null) metadata['ai.tokens.reasoning'] = row.reasoning;
    // One run is one duration:  record it on the first model only so a sum is not inflated.
    if (index === 0 && summary.durationMs !== null) metadata['ai.durationMs'] = summary.durationMs;
    if (index === 0 && summary.turns !== null) metadata.turns = summary.turns;
    if (context.prNumber !== null) metadata.prNumber = context.prNumber;
    if (context.workflow) metadata.workflow = context.workflow;
    if (trustedCost) metadata['ai.costSource'] = 'estimated';
    else if (row.costUsd !== null) metadata['ai.cliReportedCostUsd'] = row.costUsd;
    return {
      eventId: `${context.repo}:${context.runId}:${context.runAttempt}:${context.step}:${row.model}`.slice(0, 200),
      provider: context.provider,
      service: 'ci-autofix',
      environment: 'ci',
      label: `${context.repo}${context.prNumber !== null ? `#${context.prNumber}` : ''}`.slice(0, 160),
      producerKeyRef: row.model.slice(0, 160),
      billingMode: trustedCost ? 'estimated' : 'actual',
      metricType: 'usage',
      quantity: total,
      unit: 'token',
      requests: index === 0 ? 1 : 0,
      ...(trustedCost ? { costUsd: row.costUsd } : {}),
      confidence: trustedCost ? 'estimated' : 'actual',
      occurredAt: now.toISOString(),
      metadata,
    };
  });
  if (events.length === 0) return null;
  return { schemaVersion: 2, producerId: PRODUCER_ID, producerInstanceId: 'github-actions', events };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** POST with a short bounded retry.  Resolves to a status string and never rejects or logs the token. */
export async function postBatch(batch, token, { fetchImpl = fetch, url = INGEST_URL, wait = sleep } = {}) {
  let last = 'no_attempt';
  for (let attempt = 1; attempt <= POST_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'x-usage-telemetry-version': '2',
        },
        body: JSON.stringify(batch),
      });
      if (response.ok) {
        const ack = await response.json().catch(() => ({}));
        return `ok received=${ack.received ?? '?'} persisted=${ack.persisted ?? '?'} duplicates=${ack.duplicates ?? '?'} rejected=${ack.rejected ?? '?'}`;
      }
      last = `http_${response.status}`;
      if (response.status !== 429 && response.status < 500) return last;
    } catch (error) {
      last = `network_${error?.name === 'TimeoutError' ? 'timeout' : 'error'}`;
    }
    if (attempt < POST_ATTEMPTS) await wait(attempt * 1000);
  }
  return last;
}

function readResultFile(path) {
  const info = lstatSync(path);
  if (!info.isFile() || info.size > MAX_INPUT_BYTES) throw new Error('unsafe');
  return readFileSync(path, 'utf8');
}

/** Entry point.  Returns the log line;  never throws. */
export async function run(env = process.env, options = {}) {
  try {
    const token = (env.USAGE_INGEST_TOKEN ?? '').trim();
    if (!token) return '::notice::USAGE_INGEST_TOKEN is not set;  skipping the usage report';
    const context = contextFromEnv(env);
    if (!HARNESSES.has(context.harness)) return '::warning::usage report skipped:  unknown harness';
    let raw;
    try { raw = readResultFile(env.UM_INPUT_FILE ?? ''); } catch { return '::notice::usage report skipped:  no readable result file'; }
    const kind = env.UM_INPUT_KIND;
    const summary = kind === 'claude' ? extractClaude(raw, context.requestedModel)
      : kind === 'kody' ? extractKody(raw, context.requestedModel) : null;
    if (!summary) return '::notice::usage report skipped:  no usage in the result file';
    const batch = buildBatch(context, summary);
    if (!batch) return '::notice::usage report skipped:  nothing to report';
    const status = await postBatch(batch, token, options);
    return status.startsWith('ok')
      ? `::notice::usage report ${status}`
      : `::warning::usage report not delivered (${status})`;
  } catch {
    return '::warning::usage report failed';
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().then((line) => { console.log(line); }, () => {}).finally(() => { process.exitCode = 0; });
}
