import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DASHBOARD_SOURCE,
  SENTRY_CLI,
  maskToken,
  scrubChildOutput,
  toSingleLine,
  resolveBrowserRelease,
  uploadBrowserSourcemaps,
} from './sentry-upload-browser-sourcemaps.mjs';

const sha = 'a'.repeat(40);
const SELF = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ok = { status: 0, stdout: 'sourcemaps upload complete, 1 artifact uploaded' };

test('requires a full SHA release from env', () => {
  assert.equal(resolveBrowserRelease({ SENTRY_RELEASE: sha }), sha);
  assert.equal(resolveBrowserRelease({ CT_BUILD_SHA: sha.toUpperCase() }), sha);
  assert.throws(() => resolveBrowserRelease({}), /full SHA/);
  assert.throws(() => resolveBrowserRelease({ SOURCE_COMMIT: 'abc' }), /full SHA/);
});

test('refuses to upload without a token or a real SHA', () => {
  assert.throws(() => uploadBrowserSourcemaps({ release: sha, token: '', cli: SELF }), /SENTRY_AUTH_TOKEN/);
  assert.throws(() => uploadBrowserSourcemaps({ release: 'abc', token: 'tok', cli: SELF }), /full SHA/);
});

// Regression guard.  The old build spawned `npx --yes @sentry/cli`, which asks
// npx for a binary named after the package rather than the bin.  In CI there was
// no node_modules at all, so it resolved to nothing and exited non-zero in under
// two seconds.  Asserting the command is `npx` is what let that survive.
test('spawns the resolved CLI binary directly, never npx', () => {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, envToken: opts.env.SENTRY_AUTH_TOKEN });
    return ok;
  };
  const result = uploadBrowserSourcemaps({ release: sha, token: 'test-only-token', spawn, cli: SELF });
  assert.equal(result.release, sha);
  assert.equal(result.uploaded, DASHBOARD_SOURCE);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, SELF);
  assert.notEqual(calls[0].cmd, 'npx');
  assert.ok(calls[0].args.includes('sourcemaps'));
  assert.ok(calls[0].args.includes(sha));
  assert.ok(calls[0].args.includes(DASHBOARD_SOURCE));
  assert.equal(calls[0].envToken, 'test-only-token');
});

// Kody finding: every other case passed `cli` explicitly, so the production
// default was never exercised and the suite stayed green if it reverted to npx.
test('the production default is the resolved CLI path, never npx', () => {
  if (existsSync(SENTRY_CLI)) {
    const calls = [];
    uploadBrowserSourcemaps({
      release: sha,
      token: 'test-only-token',
      cli: undefined,
      spawn: (cmd) => { calls.push(cmd); return ok; },
    });
    assert.equal(calls[0], SENTRY_CLI);
    assert.notEqual(calls[0], 'npx');
  } else {
    assert.throws(
      () => uploadBrowserSourcemaps({ release: sha, token: 'tok' }),
      /@sentry\/cli is not installed/,
    );
  }
});

test('names the default CLI path under app/node_modules', () => {
  assert.match(SENTRY_CLI, /app\/node_modules\/\.bin\/sentry-cli$/);
});

test('a missing CLI install fails with the fix in the message', () => {
  const spawn = () => assert.fail('must not spawn when the CLI is absent');
  assert.throws(
    () => uploadBrowserSourcemaps({ release: sha, token: 'tok', spawn, cli: '/nonexistent/sentry-cli' }),
    /npm ci/,
  );
});

test('surfaces the child error instead of only the exit code', () => {
  const spawn = () => ({ status: 1, stderr: 'error: release version is not valid' });
  assert.throws(
    () => uploadBrowserSourcemaps({ release: sha, token: 'tok', spawn, cli: SELF }),
    /sourcemaps upload failed \(exit 1\): error: release version is not valid/,
  );
});

// Kody critical finding: a rejected credential is undiagnosable from a fully
// redacted log, so the preview is required while the whole token stays hidden.
test('a rejected credential reports a masked first-eight last-four preview', () => {
  const token = 'sntrs_super_secret_value';
  const spawn = () => ({ status: 1, stderr: 'error: unauthorized (401) invalid token' });
  let message = '';
  try {
    uploadBrowserSourcemaps({ release: sha, token, spawn, cli: SELF });
    assert.fail('expected a throw');
  } catch (error) {
    message = error.message;
  }
  assert.match(message, /rejected credential sntrs_su…alue/);
  assert.ok(!message.includes(token), 'the full token must never appear');
});

test('a non-auth failure carries no credential preview', () => {
  const spawn = () => ({ status: 1, stderr: 'error: release version is not valid' });
  assert.throws(
    () => uploadBrowserSourcemaps({ release: sha, token: 'tok', spawn, cli: SELF }),
    (error) => !error.message.includes('rejected credential'),
  );
});

test('maskToken refuses to preview a value too short to mask', () => {
  assert.equal(maskToken('short'), '[redacted]');
  assert.equal(maskToken('sntrs_super_secret_value'), 'sntrs_su…alue');
});

// Kody finding: the success path computed a detail nothing consumed, so a
// zero-artifact upload still logged success.
test('a zero exit with no output is not reported as success', () => {
  const spawn = () => ({ status: 0, stdout: '' });
  assert.throws(
    () => uploadBrowserSourcemaps({ release: sha, token: 'tok', spawn, cli: SELF }),
    /produced no output/,
  );
});

test('output that never mentions an upload is not reported as success', () => {
  const spawn = () => ({ status: 0, stdout: 'done' });
  assert.throws(
    () => uploadBrowserSourcemaps({ release: sha, token: 'tok', spawn, cli: SELF }),
    /did not confirm an upload/,
  );
});

test('the success path returns the scrubbed CLI detail', () => {
  const spawn = () => ok;
  const result = uploadBrowserSourcemaps({ release: sha, token: 'tok', spawn, cli: SELF });
  assert.match(result.detail, /artifact uploaded/);
});

// Kody finding: raw multi-line child output inside a single `::error::`
// annotation truncates it, and a line starting with `::` executes as a command.
test('child output is collapsed so it cannot break the annotation', () => {
  const spawn = () => ({
    status: 1,
    stderr: 'first line\n::set-output name=evil::yep\nlast line',
  });
  let message = '';
  try {
    uploadBrowserSourcemaps({ release: sha, token: 'tok', spawn, cli: SELF });
    assert.fail('expected a throw');
  } catch (error) {
    message = error.message;
  }
  assert.ok(!message.includes('\n'), 'the annotation must stay single-line');
  assert.match(message, /%0A/);
});

test('toSingleLine escapes percent, CR and LF', () => {
  assert.equal(toSingleLine('a%b'), 'a%25b');
  assert.equal(toSingleLine('a\rb'), 'a%0Db');
  assert.equal(toSingleLine('a\nb'), 'a%0Ab');
});

// The teeth check.  Forwarding child output into a CI log is only safe if the
// token cannot ride along, so the scrub is asserted rather than assumed.
test('never leaks the token through forwarded child output', () => {
  const token = 'sntrs_super_secret_value';
  const spawn = () => ({
    status: 1,
    stderr: `Authorization: Bearer ${token}\nauth failed for ${token}`,
  });
  let message = '';
  try {
    uploadBrowserSourcemaps({ release: sha, token, spawn, cli: SELF });
    assert.fail('expected a throw');
  } catch (error) {
    message = error.message;
  }
  assert.ok(!message.includes(token), 'token must not appear in the error');
  assert.match(message, /\[redacted\]/);
  assert.match(message, /auth failed for/);
});

test('scrubs credential shapes even when the literal token is absent', () => {
  assert.equal(scrubChildOutput('Authorization: Bearer PLACEHOLDER_VALUE', 'other'), 'Authorization: Bearer [redacted]');
  assert.equal(scrubChildOutput('token=PLACEHOLDER_VALUE', 'other'), 'token=[redacted]');
  assert.equal(scrubChildOutput('https://key@o1.ingest.sentry.io/1', 'other'), 'https://[redacted]@o1.ingest.sentry.io/1');
  assert.equal(scrubChildOutput('plain harmless text', 'other'), 'plain harmless text');
});

test('caps a runaway diagnostic', () => {
  const out = scrubChildOutput('x'.repeat(5000), 'other');
  assert.ok(out.length <= 2100, `expected a capped diagnostic, got ${out.length}`);
  assert.ok(out.startsWith('...'));
});
// Kody finding: the previous target was a TypeScript module with no generated
// map, so a green step could imply symbolication that cannot happen.
test('the upload target is the browser source, not the generated TypeScript module', () => {
  assert.match(DASHBOARD_SOURCE, /app\/src\/ui\/client\/dashboard\.js$/);
});

// Kody round-3 finding: the code comment had the direction of truth inverted.
// The durable guard is the generator's own declaration of which file it reads
// and which it writes, so the invariant is asserted against that instead of
// against a filename that could be changed on either side independently.
test('the upload target is the file the generator reads, not the file it writes', () => {
  const generator = readFileSync(resolve(ROOT, 'app/scripts/build-dashboard-client.ts'), 'utf8');
  const source = generator.match(/SOURCE_PATH = new URL\('([^']+)'/)?.[1];
  const target = generator.match(/TARGET_PATH = new URL\('([^']+)'/)?.[1];
  assert.ok(source, 'the generator must declare a SOURCE_PATH');
  assert.ok(target, 'the generator must declare a TARGET_PATH');
  assert.ok(
    DASHBOARD_SOURCE.endsWith(source.replace(/^\.\.\//, 'app/')),
    `the release must hold the generator's source (${source}), got ${DASHBOARD_SOURCE}`,
  );
  assert.ok(
    !DASHBOARD_SOURCE.endsWith(target.replace(/^\.\.\//, 'app/')),
    `the release must not hold the generator's output (${target})`,
  );
});

test('a green upload still says so when there is no source map to symbolicate', () => {
  const spawn = () => ok;
  const result = uploadBrowserSourcemaps({ release: sha, token: 'tok', spawn, cli: SELF });
  assert.ok(result.warning, 'a missing source map must not pass unnoticed');
  assert.match(result.warning, /will not symbolicate/);
});

test('a spawn failure is collapsed onto one line like any other child output', () => {
  const spawn = () => ({ error: new Error('ENOENT\n::set-output name=x::1'), status: null });
  let message = '';
  try {
    uploadBrowserSourcemaps({ release: sha, token: 'tok', spawn, cli: SELF });
    assert.fail('expected a throw');
  } catch (error) {
    message = error.message;
  }
  assert.match(message, /failed to start/);
  assert.ok(!message.includes('\n'), 'the annotation must stay single-line');
  assert.match(message, /%0A/);
});

// Self-review found this while Codex was unavailable:  at a threshold of 12,
// first-eight plus last-four of a 13-character value discloses nearly all of it.
test('maskToken withholds a preview that would disclose most of a short value', () => {
  const thirteen = 'abcdefghijklm';
  assert.equal(thirteen.length, 13);
  assert.equal(maskToken(thirteen), '[redacted]');
  assert.equal(maskToken('a'.repeat(23)), '[redacted]');
  assert.notEqual(maskToken('a'.repeat(24)), '[redacted]');
});

// Kody round-3 finding:  the success gate read stdout only while the failure
// path prefers stderr, so a CLI that writes its upload summary to stderr made
// a successful upload look like a silent one and failed the deploy job.
test('a stderr-only upload summary still satisfies the success gate', () => {
  const spawn = () => ({
    status: 0,
    stdout: '',
    stderr: 'sourcemaps upload complete, 1 artifact uploaded',
  });
  const result = uploadBrowserSourcemaps({ release: sha, token: 'tok', spawn, cli: SELF });
  assert.match(result.detail, /artifact uploaded/);
});

test('a summary on either stream satisfies the success gate', () => {
  const spawn = () => ({
    status: 0,
    stdout: 'sourcemaps upload complete',
    stderr: '1 artifact uploaded',
  });
  const result = uploadBrowserSourcemaps({ release: sha, token: 'tok', spawn, cli: SELF });
  assert.match(result.detail, /artifact uploaded/);
});

// Kody round-3 finding:  the success log claimed source maps were uploaded
// while the same run had proven there are none.  The summary has to follow the
// warning, in both directions.
test('the success summary never claims source maps that do not exist', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'sentry-upload-'));
  try {
    const bare = resolve(dir, 'bundle.js');
    writeFileSync(bare, 'console.log(1)\n');
    const mapped = resolve(dir, 'mapped.js');
    writeFileSync(mapped, 'console.log(1)\n');
    writeFileSync(`${mapped}.map`, '{"version":3,"sources":[],"mappings":""}\n');

    const noMap = uploadBrowserSourcemaps({
      release: sha,
      token: 'tok',
      spawn: () => ok,
      cli: SELF,
      source: bare,
    });
    assert.ok(noMap.warning, 'a missing source map must not pass unnoticed');
    assert.match(noMap.summary, /no source map/);
    assert.ok(
      !/Uploaded browser source maps/.test(noMap.summary),
      `the summary must not claim source maps when there is none: ${noMap.summary}`,
    );

    const withMap = uploadBrowserSourcemaps({
      release: sha,
      token: 'tok',
      spawn: () => ok,
      cli: SELF,
      source: mapped,
    });
    assert.equal(withMap.warning, null);
    assert.match(withMap.summary, /Uploaded browser source maps/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Kody round-3 finding:  the missing-target error still named dashboardHtml.ts
// after the target had moved, sending the operator to the wrong file.
test('the missing-target error names the target that is actually missing', () => {
  const missing = '/nonexistent/app/src/ui/client/dashboard.js';
  assert.throws(
    () =>
      uploadBrowserSourcemaps({
        release: sha,
        token: 'tok',
        spawn: () => assert.fail('must not spawn when the target is absent'),
        cli: SELF,
        source: missing,
      }),
    (error) =>
      error.message.includes(missing) && !error.message.includes('dashboardHtml.ts'),
  );
});
