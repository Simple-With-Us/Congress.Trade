// Upload the inline dashboard source as a Sentry release artifact.
// Never prints SENTRY_AUTH_TOKEN in full.  Release is the verified Coolify SHA.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// The browser source, and the artifact the release holds.
//
// Direction of truth:  `app/src/ui/client/dashboard.js` is the SOURCE;
// `app/src/ui/dashboardClient.ts` is the GENERATED file, written by
// `app/scripts/build-dashboard-client.ts`.  routes.ts serves the generated
// `DASHBOARD_APP_JS` string at /assets/dashboard.js, and that string is
// `escapeForTemplateLiteral(inject(dashboard.js))`.
//
// The release holds dashboard.js rather than dashboardClient.ts:
//   - Sentry matches a browser stack frame to its artifact by NAME, and the
//     frame reports the path the browser requested.  Uploaded under
//     dashboardClient.ts the artifact is named ~/assets/dashboardClient.ts,
//     which no frame for /assets/dashboard.js can ever match.  A .ts artifact
//     is also not among the extensions sentry-cli processes by default
//     (js, cjs, mjs, map, jsbundle, bundle).
//   - The transformation is line-aligned.  The escaper doubles backslashes and
//     the injector substitutes four sentinels, and neither adds or removes a
//     line, so the served bundle has exactly as many lines as dashboard.js and
//     a line number in one is the same line in the other.
//   - CI enforces the correspondence:  `npm run check:client` runs
//     `build-dashboard-client.ts --check`, which fails the build when
//     dashboardClient.ts drifts from dashboard.js.  The artifact therefore
//     cannot silently drift from what production serves.
//
// No file on disk IS the served bytes, and none of them carries a source map,
// so browser stack traces still will not symbolicate.  That is the build gap in
// CT-2438:  the generator has to emit the served bundle and its map.
//
// The Sentry Deploy workflow (.github/workflows/sentry-deploy.yml) runs this
// upload only when `${DASHBOARD_SOURCE}.map` exists in its `main` checkout, and
// that job builds nothing.  So the CT-2438 fix has to commit the map at that
// path or add a build step before the gate, and moving DASHBOARD_SOURCE means
// moving the workflow's hashFiles() paths with it.  The node test checks that
// the two agree.
export const DASHBOARD_SOURCE = resolve(ROOT, 'app/src/ui/client/dashboard.js');

// The artifact name has to be the path the browser requests, because that is
// what Sentry matches a stack frame against.  routes.ts serves this bundle at
// /assets/dashboard.js, so the artifact is named ~/assets/dashboard.js.  Without
// --url-prefix sentry-cli names the artifact ~/dashboard.js, which matches no
// frame either.
export const DASHBOARD_URL_PREFIX = '~/assets';

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
// The CLI exits 0 and prints "File upload complete" whether or not it stored
// anything, so neither the exit code nor the word "upload" is evidence of an
// upload.  Its own artifact report is the evidence:
//   "sourcemap at <map>"  ->  a map was found and stored
//   "no sourcemap found"  ->  the bundle went into the release with nothing
// Verified against real Sentry: with no map beside the bundle, the release's
// file list comes back EMPTY, so "no sourcemap found" means nothing was
// stored, not that an artifact landed without its map.
const SOURCEMAP_STORED = /sourcemap at /i;
const NOTHING_STORED = /no sourcemap found/i;

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
  if (!existsSync(source)) throw new Error(`${relative(ROOT, source)} is missing`);
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
    // The artifact has to carry the name the browser requests, or Sentry has
    // nothing to match a stack frame against.
    '--url-prefix',
    DASHBOARD_URL_PREFIX,
    '--strip-prefix',
    ROOT,
    // Pinned explicitly:  the success gate below reads the CLI's artifact
    // report, and that report is only printed at info level and above.
    '--log-level',
    'info',
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
  // never map back to source and nothing in any log says so.  sentry-cli may
  // report on either stream, and the failure branch above already prefers
  // stderr, so the success gate reads both: a stderr-only summary with an
  // empty stdout is still proof of an upload.
  const detail = scrubChildOutput([result.stdout, result.stderr].filter(Boolean).join('\n'), token);
  if (!detail) {
    throw new Error(`sentry-cli sourcemaps upload produced no output for release ${release}; refusing to report success`);
  }
  if (!UPLOAD_CONFIRMED.test(detail)) {
    throw new Error(`sentry-cli did not confirm an upload for release ${release}: ${toSingleLine(detail)}`);
  }
  // What did the CLI actually store?  Its artifact report is the only evidence
  // that means anything:  a zero exit and the words "File upload complete" are
  // printed whether or not anything landed in the release.
  const map = `${source}.map`;
  const hasMap = existsSync(map);
  const stored = SOURCEMAP_STORED.test(detail);
  if (!stored && !NOTHING_STORED.test(detail)) {
    throw new Error(
      `sentry-cli did not report what it stored for release ${release}; refusing to report success: ${toSingleLine(detail)}`,
    );
  }
  // A map on disk that the CLI did not store is a misconfiguration rather than
  // a gap:  the bundle does not reference the map sitting beside it, so the
  // upload silently stores nothing.  That is worth failing on.
  if (hasMap && !stored) {
    throw new Error(
      `sentry-cli stored no source map for ${relative(ROOT, source)} although ${relative(ROOT, map)} exists; the bundle does not reference it`,
    );
  }
  // Holding the bundle gives Sentry an artifact for the release, but it is NOT
  // symbolication: a source map has to exist beside it for a browser frame to
  // resolve back to source.  Say that outright rather than let a green step
  // imply mapped stack traces.
  const warning = stored
    ? null
    : `no source map at ${relative(ROOT, map)} - sentry-cli stored no artifact for ${relative(ROOT, source)}, so browser stack traces will not symbolicate`;
  return { release, uploaded: source, detail, stored, warning };
}

// A green step must not claim source maps were uploaded when the run proved it
// stored nothing.  The CLI reports "no sourcemap found" in exactly that case,
// and the release then holds no artifact at all, so the line has to say that
// rather than report an artifact upload that never happened.
export function formatUploadSuccess(result) {
  return result.stored
    ? `Uploaded browser source maps for release ${result.release}`
    : `No browser source maps stored for release ${result.release}: no source map beside the bundle, so browser stack traces will not symbolicate`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const release = resolveBrowserRelease();
    if (!process.env.SENTRY_AUTH_TOKEN?.trim()) throw new Error('SENTRY_AUTH_TOKEN is required');
    const result = uploadBrowserSourcemaps({ release, token: process.env.SENTRY_AUTH_TOKEN });
    console.log(formatUploadSuccess(result));
    console.log(`sentry-cli output: ${toSingleLine(result.detail)}`);
    if (result.warning) console.warn(`::warning::${result.warning}`);
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}