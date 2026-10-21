// Upload the inline dashboard source as a Sentry release artifact.
// Never prints SENTRY_AUTH_TOKEN.  Release is the verified Coolify SHA.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DASHBOARD_SOURCE = resolve(ROOT, 'app/src/ui/dashboardHtml.ts');

// The CLI is a pinned devDependency of app/, not a global install.  Resolving it
// directly is deliberate:  `npx --yes @sentry/cli` asks npx for a binary named
// after the *package*, which is unreliable for a scoped package and silently
// resolved to nothing in CI, which had no node_modules at all.
export const SENTRY_CLI = resolve(ROOT, 'app/node_modules/.bin/sentry-cli');

const SHA = /^[0-9a-f]{40}$/;
const MAX_DIAGNOSTIC = 2000;

export function resolveBrowserRelease(env = process.env) {
  const raw = (env.SENTRY_RELEASE || env.CT_BUILD_SHA || env.SOURCE_COMMIT || '').trim().toLowerCase();
  if (!SHA.test(raw)) throw new Error('SENTRY_RELEASE (or CT_BUILD_SHA / SOURCE_COMMIT) must be a full SHA');
  return raw;
}

// Child output is forwarded into an error that lands in a CI log, so it has to
// pass the same scrubbing the token itself needs.  Redact the literal token
// first, then anything shaped like a credential in the general case.
export function scrubChildOutput(text, token) {
  let out = String(text ?? '');
  if (token) out = out.split(token).join('[redacted]');
  out = out.replace(/(authorization\s*[:=]\s*)(bearer\s+)?\S+/gi, '$1$2[redacted]');
  out = out.replace(/(bearer\s+)\S+/gi, '$1[redacted]');
  out = out.replace(/((?:auth_)?token\s*[:=]\s*)(\S+)/gi, '$1[redacted]');
  out = out.replace(/(https:\/\/)([A-Za-z0-9._~+/=-]+)@/g, '$1[redacted]@');
  out = out.trim();
  return out.length > MAX_DIAGNOSTIC ? `...${out.slice(-MAX_DIAGNOSTIC)}` : out;
}

export function uploadBrowserSourcemaps({
  release,
  token,
  spawn = spawnSync,
  source = DASHBOARD_SOURCE,
  cli = SENTRY_CLI,
} = {}) {
  if (!token?.trim()) throw new Error('SENTRY_AUTH_TOKEN is required');
  if (!SHA.test(release || '')) throw new Error('release must be a full SHA');
  if (!existsSync(source)) throw new Error('dashboardHtml.ts is missing');
  if (!existsSync(cli)) {
    throw new Error(`@sentry/cli is not installed at ${cli} - run \`npm ci\` in app/ before uploading`);
  }
  const result = spawn(cli, [
    'sourcemaps',
    'upload',
    '--org',
    'simple-with-us',
    '--project',
    'congress-trade',
    '--release',
    release,
    '--strip-prefix',
    ROOT,
    source,
  ], {
    encoding: 'utf8',
    timeout: 120000,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, SENTRY_AUTH_TOKEN: token },
  });
  if (result.error) {
    throw new Error(`sentry-cli sourcemaps upload failed to start: ${scrubChildOutput(result.error.message, token)}`);
  }
  if (result.status !== 0) {
    const detail = scrubChildOutput(result.stderr || result.stdout, token);
    throw new Error(
      `sentry-cli sourcemaps upload failed (exit ${result.status})${detail ? `: ${detail}` : ''}`,
    );
  }
  return { release, uploaded: source, detail: scrubChildOutput(result.stdout, token) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const release = resolveBrowserRelease();
    if (!process.env.SENTRY_AUTH_TOKEN?.trim()) throw new Error('SENTRY_AUTH_TOKEN is required');
    const result = uploadBrowserSourcemaps({ release, token: process.env.SENTRY_AUTH_TOKEN });
    console.log(`Uploaded browser source maps for release ${result.release}`);
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}