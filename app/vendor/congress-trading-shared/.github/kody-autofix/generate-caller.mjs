#!/usr/bin/env node
// Offline only.  This generator never contacts GitHub or changes repository settings.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { sourcePath } from './profiles.mjs';

export const PROFILES = Object.freeze(['web', 'swift', 'python', 'static', 'blocked']);
export const SHARED_REPOSITORY = 'Simple-With-Us/congress-trading-shared';
const SHA = /^[a-f0-9]{40}$/;
const ID = /^[1-9][0-9]{0,15}$/;
const POLICY = /^(?:pending|approved-[A-Za-z0-9_-]{1,64})$/;
const OPTIONS = new Set(['repository-id', 'profile', 'source-prefixes', 'shared-sha',
  'daily-attempt-limit', 'budget-policy-id', 'model', 'model-base-url']);
// Kept identical to fleet.mjs (asserted by the tests) so this generator runs without npm dependencies.
export const DEFAULT_MODEL = 'MiniMax-M3';
export const DEFAULT_MODEL_BASE_URL = 'https://api.minimax.io/v1';
export const MODEL_BASE_URLS = Object.freeze([DEFAULT_MODEL_BASE_URL, 'https://ai-gateway.vercel.sh/v1', 'https://api.meta.ai/v1']);
export const MODEL_PATTERN = /^(?:[A-Za-z0-9][A-Za-z0-9-]{0,31}\/)?[A-Za-z0-9][A-Za-z0-9.-]{0,63}$/;

// Single-quoted YAML scalars also safely preserve JSON's quotes and backslashes.
export const yamlString = (value) => `'${String(value).replaceAll("'", "''")}'`;

export function parseArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    assert(argument.startsWith('--'), 'Expected named arguments only.');
    const key = argument.slice(2);
    assert(!Object.hasOwn(options, key), `Duplicate option: --${key}`);
    if (key === 'acknowledge-paid-attempts') {
      options[key] = true;
      continue;
    }
    assert(OPTIONS.has(key), `Unknown option: --${key}`);
    const value = args[++index];
    assert(typeof value === 'string' && !value.startsWith('--'), `Missing value: --${key}`);
    options[key] = value;
  }
  return options;
}

export function validateOptions(options) {
  assert(options && typeof options === 'object' && !Array.isArray(options), 'Expected an options object.');
  for (const key of Object.keys(options)) {
    assert(OPTIONS.has(key) || key === 'acknowledge-paid-attempts', `Unknown option: --${key}`);
  }
  assert(typeof options['repository-id'] === 'string' && ID.test(options['repository-id'])
    && Number.isSafeInteger(Number(options['repository-id'])), 'A safe positive numeric repository ID is required.');
  assert(PROFILES.includes(options.profile), 'An explicit supported profile is required.');
  assert(typeof options['shared-sha'] === 'string' && SHA.test(options['shared-sha'])
    && options['shared-sha'] !== '0'.repeat(40), 'A real immutable shared workflow commit SHA is required.');
  assert(typeof options['source-prefixes'] === 'string', '--source-prefixes must be a JSON array.');
  let prefixes;
  try { prefixes = JSON.parse(options['source-prefixes']); }
  catch { throw new Error('--source-prefixes must be a JSON array.'); }
  assert(Array.isArray(prefixes) && prefixes.length <= 8, 'Expected at most eight source scopes.');
  assert(prefixes.length > 0 || options.profile === 'blocked', 'An active profile requires explicit source prefixes.');
  assert(new Set(prefixes).size === prefixes.length, 'Duplicate source prefixes are not allowed.');
  for (const prefix of prefixes) {
    assert(typeof prefix === 'string' && prefix.length <= 200
      && /^[A-Za-z0-9_-][A-Za-z0-9_./-]*$/.test(prefix)
      && !prefix.includes('//') && !prefix.split('/').filter(Boolean).some(part => part.startsWith('.')),
    'Source scopes must be normalized relative directories ending in / or exact source files.');
    assert(prefix.endsWith('/') || options.profile === 'blocked' || sourcePath(prefix, options.profile, [prefix]),
      'Exact files must be eligible source files for the selected profile.');
    assert(!/^(?:node_modules|vendor|dist|build|coverage)\//i.test(prefix), 'Generated and dependency paths are not source prefixes.');
  }
  const rawLimit = options['daily-attempt-limit'] ?? '0';
  assert(typeof rawLimit === 'string' && /^[0-5]$/.test(rawLimit), 'Daily attempt limit must be an integer from 0 through 5.');
  const limit = Number(rawLimit);
  const policy = options['budget-policy-id'] ?? 'pending';
  assert(typeof policy === 'string' && POLICY.test(policy), 'Budget policy ID must be pending or approved- followed by 1 to 64 letters, digits, underscores, or hyphens.');
  if (limit > 0) {
    assert(options.profile !== 'blocked', 'Blocked profiles cannot authorize paid attempts.');
    assert(Object.hasOwn(options, 'daily-attempt-limit') && Object.hasOwn(options, 'budget-policy-id')
      && policy !== 'pending' && options['acknowledge-paid-attempts'] === true,
    'A positive limit requires explicit --daily-attempt-limit, approved --budget-policy-id, and --acknowledge-paid-attempts.');
  }
  if (Object.hasOwn(options, 'acknowledge-paid-attempts')) {
    assert(options['acknowledge-paid-attempts'] === true && limit > 0, 'Paid-attempt acknowledgement requires an explicit positive limit.');
  }
  const modelBaseUrl = options['model-base-url'] ?? DEFAULT_MODEL_BASE_URL;
  assert(MODEL_BASE_URLS.includes(modelBaseUrl), `Model base URL must be one of: ${MODEL_BASE_URLS.join(', ')}.`);
  assert(Object.hasOwn(options, 'model') || modelBaseUrl === DEFAULT_MODEL_BASE_URL,
    '--model is required when --model-base-url selects a nonnative MiniMax endpoint.');
  const model = options.model ?? DEFAULT_MODEL;
  assert(typeof model === 'string' && MODEL_PATTERN.test(model), 'Model must be a plain provider model identifier.');
  return { repositoryId: options['repository-id'], profile: options.profile, prefixes,
    sharedSha: options['shared-sha'], limit, policy, model, modelBaseUrl,
    apiKeySecret: modelBaseUrl === 'https://api.minimax.io/v1' ? 'MINIMAX_API_KEY' : 'VERCEL_AI_GATEWAY_API_KEY' };
}

export function generateCaller(options) {
  const config = validateOptions(options);
  return `name: Kody MiniMax M3 Fix Proposals

# Generated offline.  Missing SWU_KODY_AUTOFIX_ENABLED means disabled.
# MODEL_API_KEY is forwarded explicitly; secrets are never inherited.
# Budget approval and protected-environment setup are separate owner actions.
# Daily attempt slots bound this repository only; they are not a dollar cap.
on:
  check_run:
    types: [completed]

permissions: {}
# Shared with the fleet's other PR autofix callers so only one autofix runs per PR.
concurrency:
  group: pr-autofix-\${{ github.repository }}-\${{ github.event.check_run.pull_requests[0].number || github.event.check_run.id }}
  cancel-in-progress: false

jobs:
  propose:
    if: >-
      vars.SWU_KODY_AUTOFIX_ENABLED == 'true' &&
      github.event_name == 'check_run' && github.event.action == 'completed' &&
      github.run_attempt == 1 &&
      github.event.check_run.app.id == 413034 &&
      github.event.sender.type == 'Bot' && github.event.sender.id == 148880201 &&
      github.event.sender.login == 'kody-ai[bot]' &&
      github.event.check_run.conclusion == 'success' &&
      github.event.check_run.pull_requests[0].number != null &&
      github.event.check_run.pull_requests[1] == null
    permissions:
      contents: write
      pull-requests: write
      checks: read
      actions: read
    uses: ${SHARED_REPOSITORY}/.github/workflows/kody-autofix-reusable.yml@${config.sharedSha}
    with:
      repository_id: ${yamlString(config.repositoryId)}
      profile: ${yamlString(config.profile)}
      source_prefixes: ${yamlString(JSON.stringify(config.prefixes))}
      daily_attempt_limit: ${config.limit}
      budget_policy_id: ${yamlString(config.policy)}
      model: ${yamlString(config.model)}
      model_base_url: ${yamlString(config.modelBaseUrl)}
    secrets:
      MODEL_API_KEY: \${{ secrets.${config.apiKeySecret} }}
      USAGE_INGEST_TOKEN: \${{ secrets.USAGE_INGEST_TOKEN }}
`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.stdout.write(generateCaller(parseArguments(process.argv.slice(2)))); }
  catch (error) {
    process.stderr.write(`Caller generation refused: ${error.message}\n`);
    process.exitCode = 1;
  }
}
