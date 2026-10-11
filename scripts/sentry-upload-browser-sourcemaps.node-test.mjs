import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DASHBOARD_SOURCE,
  resolveBrowserRelease,
  uploadBrowserSourcemaps,
} from './sentry-upload-browser-sourcemaps.mjs';

const sha = 'a'.repeat(40);

test('requires a full SHA release from env', () => {
  assert.equal(resolveBrowserRelease({ SENTRY_RELEASE: sha }), sha);
  assert.equal(resolveBrowserRelease({ CT_BUILD_SHA: sha.toUpperCase() }), sha);
  assert.throws(() => resolveBrowserRelease({}), /full SHA/);
  assert.throws(() => resolveBrowserRelease({ SOURCE_COMMIT: 'abc' }), /full SHA/);
});

test('refuses to upload without a token or a real SHA', () => {
  assert.throws(() => uploadBrowserSourcemaps({ release: sha, token: '' }), /SENTRY_AUTH_TOKEN/);
  assert.throws(() => uploadBrowserSourcemaps({ release: 'abc', token: 'tok' }), /full SHA/);
});

test('invokes sentry-cli against dashboardHtml.ts and never echoes the token', () => {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, envToken: opts.env.SENTRY_AUTH_TOKEN });
    return { status: 0 };
  };
  const result = uploadBrowserSourcemaps({ release: sha, token: 'test-only-token', spawn });
  assert.equal(result.release, sha);
  assert.equal(result.uploaded, DASHBOARD_SOURCE);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'npx');
  assert.ok(calls[0].args.includes('sourcemaps'));
  assert.ok(calls[0].args.includes(sha));
  assert.ok(calls[0].args.includes(DASHBOARD_SOURCE));
  assert.equal(calls[0].envToken, 'test-only-token');
});
