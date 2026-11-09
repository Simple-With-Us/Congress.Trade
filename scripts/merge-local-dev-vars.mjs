#!/usr/bin/env node

/**
 * Safely merge local bootstrap inputs into app/.dev.vars.
 *
 * Machine-identity keys come from the process environment first, then (on a Mac
 * with the CLI installed) from `fleet-secrets get NAME` (Infisical Fleet-OPS).
 * Cloud and CI have no `fleet-secrets` and use the environment only. Explicit
 * process-env imports are limited to documented bootstrap/early-init/local
 * selectors.
 */

import {
  chmodSync,
  lstatSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEST_PATH_OVERRIDES = process.env.CT_LOCAL_BOOTSTRAP_TEST_MODE === '1';
const APP_DIR = resolve(
  TEST_PATH_OVERRIDES && process.env.CT_LOCAL_BOOTSTRAP_TEST_APP_DIR
    ? process.env.CT_LOCAL_BOOTSTRAP_TEST_APP_DIR
    : resolve(REPO_ROOT, 'app'),
);
const DEV_VARS_FILE = resolve(
  TEST_PATH_OVERRIDES && process.env.CT_LOCAL_BOOTSTRAP_TEST_DEV_VARS_FILE
    ? process.env.CT_LOCAL_BOOTSTRAP_TEST_DEV_VARS_FILE
    : resolve(APP_DIR, '.dev.vars'),
);
// `fleet-secrets` binary used for the Mac-only fallback. Tests may point it at a
// fake binary; outside test mode it is looked up on PATH. A missing binary means
// "no fallback" (cloud, CI, keyless checkouts).
const FLEET_SECRETS_BIN = TEST_PATH_OVERRIDES
  ? process.env.CT_LOCAL_BOOTSTRAP_TEST_FLEET_SECRETS_BIN || ''
  : 'fleet-secrets';

const APP_PROJECT_ID = process.env.INFISICAL_APP_PROJECT_ID || process.env.INFISICAL_CT_PROJECT_ID || '';
const SHARED_PROJECT_ID = process.env.INFISICAL_SHARED_PROJECT_ID || '';

const GLOBAL_INFISICAL_KEYS = new Set([
  'INFISICAL_APP_PROJECT_ID',
  'INFISICAL_APP_CLIENT_ID',
  'INFISICAL_APP_CLIENT_SECRET',
  'INFISICAL_CT_PROJECT_ID',
  'INFISICAL_CT_CLIENT_ID',
  'INFISICAL_CT_CLIENT_SECRET',
  'INFISICAL_SHARED_PROJECT_ID',
  'INFISICAL_SHARED_CLIENT_ID',
  'INFISICAL_SHARED_CLIENT_SECRET',
  'INFISICAL_CT_SHARED_PROJECT_ID',
  'INFISICAL_CT_SHARED_CLIENT_ID',
  'INFISICAL_CT_SHARED_CLIENT_SECRET',
]);

const COMMON_BOOTSTRAP_ENV_KEYS = [
  'INFISICAL_BASE_URL',
  'INFISICAL_ENV',
  'INFISICAL_CACHE_TTL_SECONDS',
  'INFISICAL_ALLOW_ENV_FALLBACK',
];

// These values cannot be resolved asynchronously from Infisical early enough,
// or are required to make the local admin escape hatch non-production. Provider
// keys and normal runtime configuration are intentionally absent.
const EXPLICIT_LOCAL_ENV_KEYS = [
  'SENTRY_DSN',
  'SENTRY_ENVIRONMENT',
  'SENTRY_TRACES_SAMPLE_RATE',
  'ADMIN_OPEN_IN_DEV',
  'USAGE_MONITOR_ENVIRONMENT',
];

const TARGET_MANAGED_KEYS = new Set([
  'INFISICAL_APP_PROJECT_ID',
  'INFISICAL_APP_CLIENT_ID',
  'INFISICAL_APP_CLIENT_SECRET',
  'INFISICAL_APP_SECRET_PATH',
  'INFISICAL_SHARED_PROJECT_ID',
  'INFISICAL_SHARED_CLIENT_ID',
  'INFISICAL_SHARED_CLIENT_SECRET',
  'INFISICAL_SHARED_SECRET_PATH',
  ...COMMON_BOOTSTRAP_ENV_KEYS,
  ...EXPLICIT_LOCAL_ENV_KEYS,
]);

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

// Keep this grammar and value decoding byte-for-byte compatible with the
// dotenv 16.3.1 parser bundled by the pinned Wrangler version. In particular,
// dotenv accepts both KEY=value and KEY: value, treats an immediately preceding
// backslash as a quote escape without applying backslash-parity semantics, and
// only expands literal \\n / \\r sequences inside double quotes.
const DOTENV_16_3_1_LINE =
  /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/gm;

function decodeDotenvValue(rawValue = '') {
  let value = rawValue.trim();
  const maybeQuote = value[0];
  value = value.replace(/^(['"`])([\s\S]*)\1$/gm, '$2');
  if (maybeQuote === '"') {
    value = value.replace(/\\n/g, '\n');
    value = value.replace(/\\r/g, '\r');
  }
  return value;
}

function dotenvMatches(text) {
  const normalized = text.replace(/\r\n?/gm, '\n');
  DOTENV_16_3_1_LINE.lastIndex = 0;
  return { matches: [...normalized.matchAll(DOTENV_16_3_1_LINE)], normalized };
}

function splitLineRecords(text) {
  const records = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '\n' && text[i] !== '\r') continue;
    const ending = text[i] === '\r' && text[i + 1] === '\n' ? '\r\n' : text[i];
    records.push({ content: text.slice(start, i), ending });
    if (ending === '\r\n') i += 1;
    start = i + 1;
  }
  if (start < text.length) records.push({ content: text.slice(start), ending: '' });
  return records;
}

function parseAssignments(text, label, allowedKeys) {
  const lines = splitLineRecords(text);
  const entries = new Map();
  const { matches, normalized } = dotenvMatches(text);

  for (const match of matches) {
    const [, key, rawValue = ''] = match;
    if (allowedKeys && !allowedKeys.has(key)) continue;
    if (entries.has(key)) throw new Error(`${label}: duplicate assignment for ${key}`);
    // dotenv's leading `\s*` may include blank lines before the assignment, so
    // match.index is not necessarily the key's source line. Locate the key after
    // the exact leading-whitespace/optional-export prefix within this match.
    const prefix = match[0].match(/^\s*(?:export\s+)?/)?.[0] ?? '';
    const keyIndex = (match.index ?? 0) + prefix.length;
    if (normalized.slice(keyIndex, keyIndex + key.length) !== key) {
      throw new Error(`${label}: could not locate assignment for ${key}`);
    }
    const lineIndex = normalized.slice(0, keyIndex).split('\n').length - 1;
    entries.set(key, {
      value: decodeDotenvValue(rawValue),
      lineIndex,
    });
  }

  return { entries, lines };
}

function lstatIfPresent(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return null;
    throw error;
  }
}

function unlinkIfPresent(path) {
  try {
    unlinkSync(path);
  } catch (error) {
    if (!error || typeof error !== 'object' || error.code !== 'ENOENT') throw error;
  }
}

// Lazy Map-like view over `fleet-secrets get NAME`: one subprocess per key, only
// when an earlier source did not already supply the value. The first spawn error
// (binary missing) or fetch/auth failure (exit 4+) disables further lookups;
// exit 3 means only that key is absent. Values are never logged.
function fleetSecretsSource() {
  const cache = new Map();
  let disabled = !FLEET_SECRETS_BIN;
  return {
    get(key) {
      if (cache.has(key)) return cache.get(key);
      let entry;
      if (!disabled) {
        const result = spawnSync(FLEET_SECRETS_BIN, ['get', key], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 30_000,
        });
        if (result.error || (result.status !== 0 && result.status !== 3)) {
          disabled = true;
        } else if (result.status === 0 && nonEmpty(result.stdout)) {
          entry = { value: result.stdout.replace(/[\r\n]+$/, '') };
        }
      }
      cache.set(key, entry);
      return entry;
    },
  };
}

function sourceValue(source, key) {
  if (typeof source.get === 'function') return source.get(key)?.value;
  return source[key];
}

function credentialCandidate(label, source, clientIdKey, clientSecretKey) {
  const clientId = sourceValue(source, clientIdKey);
  const clientSecret = sourceValue(source, clientSecretKey);
  if (!nonEmpty(clientId) && !nonEmpty(clientSecret)) return null;
  if (!nonEmpty(clientId) || !nonEmpty(clientSecret)) {
    throw new Error(
      `${label}: ${clientIdKey} and ${clientSecretKey} must be configured together`,
    );
  }
  return { clientId, clientSecret, label };
}

function selectCredentialPair(specs) {
  const candidates = specs.map((spec) => credentialCandidate(...spec)).filter(Boolean);
  return candidates[0] || null;
}

function firstNonEmpty(values) {
  return values.find(nonEmpty);
}

function quoteDevValue(key, value) {
  if (value.includes('\n') || value.includes('\r')) {
    throw new Error(`local dev variable ${key} cannot be represented as a single line`);
  }

  // dotenv 16.3.1 does not JSON-unescape quotes, backslashes, or tabs, and it
  // converts literal \\n / \\r inside double quotes. Try the native syntaxes and
  // accept one only after the pinned parser proves an exact round trip.
  const candidates = [`"${value}"`, `'${value}'`, `\`${value}\``, value];
  for (const candidate of candidates) {
    const { matches } = dotenvMatches(`${key}=${candidate}\n`);
    if (
      matches.length === 1 &&
      matches[0][1] === key &&
      decodeDotenvValue(matches[0][2] || '') === value
    ) {
      return candidate;
    }
  }
  throw new Error(`local dev variable ${key} cannot be represented losslessly`);
}

function writeMergedValues(target, desired) {
  const changes = [];
  for (const [key, value] of desired) {
    if (!nonEmpty(value)) continue;
    const current = target.entries.get(key);
    if (current && nonEmpty(current.value)) continue;
    changes.push({ key, value, lineIndex: current?.lineIndex });
  }

  if (changes.length === 0) {
    if (target.stat) chmodSync(DEV_VARS_FILE, 0o600);
    return 0;
  }

  const lines = target.lines.map((line) => ({ ...line }));
  const newline = lines.find((line) => line.ending)?.ending || '\n';
  for (const change of changes) {
    const assignment = `${change.key}=${quoteDevValue(change.key, change.value)}`;
    if (change.lineIndex === undefined) {
      if (lines.length > 0 && lines.at(-1).ending === '') lines.at(-1).ending = newline;
      lines.push({ content: assignment, ending: newline });
    } else {
      lines[change.lineIndex].content = assignment;
    }
  }

  const tempFile = resolve(
    dirname(DEV_VARS_FILE),
    `.${basename(DEV_VARS_FILE)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    const output = lines.map((line) => `${line.content}${line.ending}`).join('');
    writeFileSync(tempFile, output, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    const current = lstatIfPresent(DEV_VARS_FILE);
    if (current?.isSymbolicLink() || (current && !current.isFile())) {
      throw new Error('app/.dev.vars must be a regular, non-symlink file');
    }
    renameSync(tempFile, DEV_VARS_FILE);
    chmodSync(DEV_VARS_FILE, 0o600);
  } finally {
    unlinkIfPresent(tempFile);
  }
  return changes.length;
}

function main() {
  const targetStat = lstatIfPresent(DEV_VARS_FILE);
  let target = { entries: new Map(), lines: [], stat: null };
  if (targetStat) {
    const stat = targetStat;
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error('app/.dev.vars must be a regular, non-symlink file');
    }
    target = {
      ...parseAssignments(
        readFileSync(DEV_VARS_FILE, 'utf8'),
        'app/.dev.vars',
        TARGET_MANAGED_KEYS,
      ),
      stat,
    };
  }

  const globalValues = fleetSecretsSource();
  const appPair = selectCredentialPair([
    ['app/.dev.vars app identity', target.entries, 'INFISICAL_APP_CLIENT_ID', 'INFISICAL_APP_CLIENT_SECRET'],
    ['explicit app environment identity', process.env, 'INFISICAL_APP_CLIENT_ID', 'INFISICAL_APP_CLIENT_SECRET'],
    ['canonical CT environment identity', process.env, 'INFISICAL_CT_CLIENT_ID', 'INFISICAL_CT_CLIENT_SECRET'],
    ['fleet-secrets app identity', globalValues, 'INFISICAL_APP_CLIENT_ID', 'INFISICAL_APP_CLIENT_SECRET'],
    ['fleet-secrets canonical CT identity', globalValues, 'INFISICAL_CT_CLIENT_ID', 'INFISICAL_CT_CLIENT_SECRET'],
  ]);
  const sharedPair = selectCredentialPair([
    ['app/.dev.vars shared identity', target.entries, 'INFISICAL_SHARED_CLIENT_ID', 'INFISICAL_SHARED_CLIENT_SECRET'],
    ['explicit shared environment identity', process.env, 'INFISICAL_SHARED_CLIENT_ID', 'INFISICAL_SHARED_CLIENT_SECRET'],
    ['canonical CT shared environment identity', process.env, 'INFISICAL_CT_SHARED_CLIENT_ID', 'INFISICAL_CT_SHARED_CLIENT_SECRET'],
    ['fleet-secrets shared identity', globalValues, 'INFISICAL_SHARED_CLIENT_ID', 'INFISICAL_SHARED_CLIENT_SECRET'],
    ['fleet-secrets canonical CT shared identity', globalValues, 'INFISICAL_CT_SHARED_CLIENT_ID', 'INFISICAL_CT_SHARED_CLIENT_SECRET'],
  ]);

  const desired = new Map();
  if (appPair) {
    desired.set('INFISICAL_APP_CLIENT_ID', appPair.clientId);
    desired.set('INFISICAL_APP_CLIENT_SECRET', appPair.clientSecret);
    desired.set(
      'INFISICAL_APP_PROJECT_ID',
      firstNonEmpty([
        target.entries.get('INFISICAL_APP_PROJECT_ID')?.value,
        process.env.INFISICAL_APP_PROJECT_ID,
        process.env.INFISICAL_CT_PROJECT_ID,
        globalValues.get('INFISICAL_APP_PROJECT_ID')?.value,
        globalValues.get('INFISICAL_CT_PROJECT_ID')?.value,
        APP_PROJECT_ID,
      ]),
    );
    if (nonEmpty(process.env.INFISICAL_APP_SECRET_PATH)) {
      desired.set('INFISICAL_APP_SECRET_PATH', process.env.INFISICAL_APP_SECRET_PATH);
    }
  }
  if (sharedPair) {
    desired.set('INFISICAL_SHARED_CLIENT_ID', sharedPair.clientId);
    desired.set('INFISICAL_SHARED_CLIENT_SECRET', sharedPair.clientSecret);
    desired.set(
      'INFISICAL_SHARED_PROJECT_ID',
      firstNonEmpty([
        target.entries.get('INFISICAL_SHARED_PROJECT_ID')?.value,
        process.env.INFISICAL_SHARED_PROJECT_ID,
        process.env.INFISICAL_CT_SHARED_PROJECT_ID,
        globalValues.get('INFISICAL_SHARED_PROJECT_ID')?.value,
        globalValues.get('INFISICAL_CT_SHARED_PROJECT_ID')?.value,
        SHARED_PROJECT_ID,
      ]),
    );
    if (nonEmpty(process.env.INFISICAL_SHARED_SECRET_PATH)) {
      desired.set('INFISICAL_SHARED_SECRET_PATH', process.env.INFISICAL_SHARED_SECRET_PATH);
    }
  }

  if (appPair || sharedPair) {
    for (const key of COMMON_BOOTSTRAP_ENV_KEYS) {
      if (nonEmpty(process.env[key])) desired.set(key, process.env[key]);
    }
  }
  for (const key of EXPLICIT_LOCAL_ENV_KEYS) {
    if (nonEmpty(process.env[key])) desired.set(key, process.env[key]);
  }

  const merged = writeMergedValues(target, desired);
  if (merged > 0) {
    console.log(`==> app/.dev.vars: merged ${merged} var(s) from safe local bootstrap inputs`);
  } else {
    console.log('==> app/.dev.vars: nothing to merge (existing values preserved)');
  }
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : 'unknown bootstrap error';
  console.error(`==> ERROR: Infisical local bootstrap failed: ${message}`);
  process.exitCode = 1;
}
