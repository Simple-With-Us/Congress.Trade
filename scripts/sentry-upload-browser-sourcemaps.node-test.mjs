import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import {
  DASHBOARD_SOURCE,
  SENTRY_CLI,
  scrubChildOutput,
  resolveBrowserRelease,
  uploadBrowserSourcemaps,
} from './sentry-upload-browser-sourcemaps.mjs';

const sha = 'a'.repeat(40);
const SELF = fileURLToPath(import.meta.url);

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
    return { status: 0, stdout: 'ok' };
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
  assert.equal(scrubChildOutput('Authorization: Bearer abcdef123456', 'other'), 'Authorization: Bearer [redacted]');
  assert.equal(scrubChildOutput('token=abcdef123456', 'other'), 'token=[redacted]');
  assert.equal(scrubChildOutput('https://key@o1.ingest.sentry.io/1', 'other'), 'https://[redacted]@o1.ingest.sentry.io/1');
  assert.equal(scrubChildOutput('plain harmless text', 'other'), 'plain harmless text');
});

test('caps a runaway diagnostic', () => {
  const out = scrubChildOutput('x'.repeat(5000), 'other');
  assert.ok(out.length <= 2100, `expected a capped diagnostic, got ${out.length}`);
  assert.ok(out.startsWith('...'));
});