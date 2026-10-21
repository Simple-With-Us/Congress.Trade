// Upload the inline dashboard source as a Sentry release artifact.
// Never prints SENTRY_AUTH_TOKEN in full.  Release is the verified Coolify SHA.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// The generated client bundle is what actually ships, so it is what Sentry should
// hold against the release.  The TypeScript module it is generated from is not an
// ingestible source map and was the previous target.
export const DASHBOARD_SOURCE = resolve(ROOT, 'app/src/ui/client/dashboard.js');

// The CLI is a pinned devDependency of app/, not a global install.  Resolving it
// directly is deliberate:  `npx --yes @sentry/cli` asks npx for a binary named
// after the *package*, which is unreliable for a scoped package and silently
// resolved to nothing in CI, which had no node_modules at all.
export const SENTRY_CLI = resolve(ROOT, 'app/node_modules/.bin/sentry-cli');

const SHA = /^[0-9a-f]{40}$/;
const MAX_DIAGNOSTIC = 2000;
const AUTH_FAILURE =
  /\b(?:401|403)\b|unauthor|forbidden|invalid\s+(?:auth\s+)?token|authentication\s+(?:failed|error)|api\s+key/i;
const UPLOAD_CONFIRMED = /upload|artifact|release/i;

export function resolveBrowserRelease(env = process.env) {
  const raw = (env.SENTRY_RELEASE || env.CT_BUILD_SHA || env.SOURCE_COMMIT || '').trim().toLowerCase();
  if (!SHA.test(raw)) throw new Error('SENTRY_RELEASE (or CT_BUILD_SHA / SOURCE_COMMIT) must be a full SHA');
  return raw;
}

// A rejected credential is the one failure nobody can diagnose from a fully
// redacted log, so the preview is required:  first eight, last four, never the
// whole value.  The threshold is deliberately well above 12, because first-eight
// plus last-four of a 13-character value would disclose nearly all of it.  A real
// Sentry auth token is far longer than this, so anything short of it is not one.
const MIN_PREVIEW_LENGTH = 24;

export function maskToken(token) {
  const value = String(token ?? '').trim();
  if (value.length < MIN_PREVIEW_LENGTH) return '[redacted]';
  return `${value.slice(0, 8)}…${value.slice(-4)}`;
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

// The entrypoint prints this as a single `::error::` annotation.  A raw newline
// would truncate the annotation, and a continuation line starting with `::`
// would be parsed as a workflow command, so child output is collapsed onto one
// line using the escapes Actions documents for exactly this.
export function toSingleLine(text) {
  return String(text ?? '')
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A');
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
    const detail = toSingleLine(scrubChildOutput(result.error.message, token));
    throw new Error(`sentry-cli sourcemaps upload failed to start: ${detail}`);
  }
  if (result.status !== 0) {
    const raw = result.stderr || result.stdout || '';
    const detail = toSingleLine(scrubChildOutput(raw, token));
    const rejected = AUTH_FAILURE.test(raw) ? ` (rejected credential ${maskToken(token)})` : '';
    throw new Error(
      `sentry-cli sourcemaps upload failed (exit ${result.status})${rejected}${detail ? `: ${detail}` : ''}`,
    );
  }
  // A zero exit with nothing to say is not proof of an upload.  Treat silence as
  // failure, because the cost of a silent success here is browser errors that
  // never map back to source and nothing in any log says so.
  const detail = scrubChildOutput(result.stdout, token);
  if (!detail) {
    throw new Error(`sentry-cli sourcemaps upload produced no output for release ${release}; refusing to report success`);
  }
  if (!UPLOAD_CONFIRMED.test(detail)) {
    throw new Error(`sentry-cli did not confirm an upload for release ${release}: ${toSingleLine(detail)}`);
  }
  // Holding the bundle gives Sentry the real artifact for the release, but it is
  // NOT symbolication: a source map has to exist beside it for a browser frame to
  // resolve back to source.  Say that outright rather than let a green step imply
  // mapped stack traces.
  const map = `${source}.map`;
  const warning = existsSync(map)
    ? null
    : `no source map at ${map} - the release now holds the bundle as an artifact, but browser stack traces will not symbolicate`;
  return { release, uploaded: source, detail, warning };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const release = resolveBrowserRelease();
    if (!process.env.SENTRY_AUTH_TOKEN?.trim()) throw new Error('SENTRY_AUTH_TOKEN is required');
    const result = uploadBrowserSourcemaps({ release, token: process.env.SENTRY_AUTH_TOKEN });
    console.log(`Uploaded browser source maps for release ${result.release}`);
    console.log(`sentry-cli output: ${toSingleLine(result.detail)}`);
    if (result.warning) console.warn(`::warning::${result.warning}`);
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}