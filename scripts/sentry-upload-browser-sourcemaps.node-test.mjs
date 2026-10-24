import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DASHBOARD_SOURCE,
  DASHBOARD_URL_PREFIX,
  SENTRY_CLI,
  formatUploadSuccess,
  maskToken,
  scrubChildOutput,
  toSingleLine,
  resolveBrowserRelease,
  uploadBrowserSourcemaps,
} from './sentry-upload-browser-sourcemaps.mjs';

const sha = 'a'.repeat(40);
const SELF = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// What the CLI prints when it found a map and stored it.
const ok = {
  status: 0,
  stdout: [
    '> File upload complete (processing pending on server)',
    'Source Map Upload Report',
    '  Scripts',
    '    ~/assets/dashboard.js (sourcemap at dashboard.js.map)',
  ].join('\n'),
};

// What the CLI prints when there was no map to store.  The release then holds
// no artifact at all, which is why the report has to be read rather than the
// exit code.
const nothingStored = {
  status: 0,
  stdout: [
    '> File upload complete (processing pending on server)',
    'Source Map Upload Report',
    '  Scripts',
    '    ~/assets/dashboard.js (no sourcemap found)',
    '      - warning: could not determine a source map reference',
  ].join('\n'),
};

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
  assert.match(result.detail, /sourcemap at/);
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
// Kody finding: the comment above DASHBOARD_SOURCE had the direction of truth
// inverted.  The durable guard is the generator's own declaration of which file
// it reads and which it writes, so the invariant is asserted against that
// instead of against a filename that either side could change independently.
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

test('the upload target is browser JavaScript, not a TypeScript module', () => {
  assert.match(DASHBOARD_SOURCE, /app\/src\/ui\/client\/dashboard\.js$/);
  assert.ok(existsSync(DASHBOARD_SOURCE), 'the upload target must exist in the repo');
});

// Workflow text with full-line comments dropped, so prose that quotes a gate is
// never read as one.
function withoutComments(text) {
  return text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

// Split every job's `steps:` list into one { name, text } entry per step,
// without a YAML dependency:  this file runs under a bare `node --test` with no
// node_modules.  A step starts at a `- ` item on the list's own indent and runs
// until the next one or until a line outdents past the list.
function workflowSteps(text) {
  const steps = [];
  let stepsIndent = -1;
  let itemIndent = null;
  for (const line of withoutComments(text).split('\n')) {
    if (line.trim() === '') continue;
    const stepsKey = /^(\s*)steps:\s*$/.exec(line);
    if (stepsKey) {
      stepsIndent = stepsKey[1].length;
      itemIndent = null;
      continue;
    }
    if (stepsIndent === -1) continue;
    if (itemIndent === null) {
      const item = /^(\s*)- /.exec(line);
      if (!item || item[1].length < stepsIndent) {
        stepsIndent = -1;
        continue;
      }
      itemIndent = item[1];
    }
    if (line.startsWith(`${itemIndent}- `)) {
      steps.push({ name: '', lines: [] });
    } else if (!line.startsWith(`${itemIndent}  `)) {
      stepsIndent = -1;
      itemIndent = null;
      continue;
    }
    const step = steps[steps.length - 1];
    step.lines.push(line);
    const name = /^name:\s*(.+)$/.exec(line.slice(itemIndent.length + 2));
    if (name && !step.name) step.name = name[1].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return steps.map(({ name, lines }) => ({ name, text: lines.join('\n') }));
}

// Review findings:  the Sentry Deploy workflow gates the CLI install, the
// upload and the skip notice on a literal map path, and nothing else ties that
// literal to DASHBOARD_SOURCE.  A moved source would leave the gate shut with
// no error, and the notice would keep naming a map that is no longer the one
// uploaded.  The operator matters as much as the path:  `!= ''` opens a step
// when the map exists and `== ''` runs the skip notice when it does not.  The
// checks are count-agnostic and leave the notice wording free, so a routine
// workflow edit does not fail the deploy job's pre-receipt test step.
test('the Sentry Deploy gate keys on the map beside the upload target', () => {
  const workflow = readFileSync(resolve(ROOT, '.github/workflows/sentry-deploy.yml'), 'utf8');
  const expected = `${relative(ROOT, DASHBOARD_SOURCE)}.map`;
  const GATE = /hashFiles\('([^']+\.map)'\)\s*(!=|==)\s*''/g;

  const paths = [...withoutComments(workflow).matchAll(/hashFiles\('([^']+\.map)'\)/g)].map((match) => match[1]);
  assert.ok(paths.length > 0, 'the workflow must gate on a source map');
  for (const path of paths) {
    assert.equal(path, expected, 'every source map gate must name the map beside DASHBOARD_SOURCE');
  }

  const steps = workflowSteps(workflow);
  const gatedOn = (op) => steps.filter((step) => [...step.text.matchAll(GATE)].some((match) => match[2] === op));

  const upload = steps.find((step) => step.name === 'Upload browser dashboard source maps');
  assert.ok(upload, 'the workflow must keep a step named "Upload browser dashboard source maps"');
  assert.ok(
    gatedOn('!=').includes(upload),
    `the upload must run only when ${expected} exists (hashFiles(...) != '')`,
  );

  const skips = gatedOn('==');
  assert.ok(skips.length > 0, `a skip step must run when ${expected} is missing (hashFiles(...) == '')`);
  assert.ok(
    skips.some((step) => {
      const rest = step.text.replace(GATE, '');
      const notice = rest.indexOf('::notice');
      return notice !== -1 && rest.slice(notice).includes(expected);
    }),
    `the skip notice must name ${expected}`,
  );
});

// Sentry matches a browser stack frame to its artifact by NAME, and the frame
// reports the path the browser requested.  An artifact named after anything but
// the served path matches no frame at all.
test('the artifact is named for the path the browser requests', () => {
  assert.equal(DASHBOARD_URL_PREFIX, '~/assets');
  const calls = [];
  uploadBrowserSourcemaps({
    release: sha,
    token: 'test-only-token',
    cli: SELF,
    spawn: (cmd, args) => { calls.push(args); return ok; },
  });
  const args = calls[0];
  assert.ok(args.includes('--url-prefix'), 'the upload must name the artifact');
  assert.equal(args[args.indexOf('--url-prefix') + 1], '~/assets');
  assert.match(DASHBOARD_URL_PREFIX, /^\~\/assets$/);
});

test('a missing upload target names the resolved path, not a stale filename', () => {
  assert.throws(
    () => uploadBrowserSourcemaps({ release: sha, token: 'tok', spawn: () => assert.fail('must not spawn'), source: '/nonexistent/dashboardClient.ts', cli: SELF }),
    /nonexistent\/dashboardClient\.ts is missing/,
  );
});

// Kody finding: the success gate read stdout only, so a stderr-only upload
// summary failed the deploy despite a successful upload.
test('a stderr-only upload summary still confirms success', () => {
  const spawn = () => ({
    status: 0,
    stdout: '',
    stderr: 'Source Map Upload Report\n  ~/assets/dashboard.js (sourcemap at dashboard.js.map)',
  });
  const result = uploadBrowserSourcemaps({ release: sha, token: 'tok', spawn, cli: SELF });
  assert.match(result.detail, /sourcemap at/);
});

// The CLI exits 0 and prints "File upload complete" whether or not it stored
// anything, so its own artifact report is the only evidence.
test('the CLI report decides whether a source map was stored', () => {
  const stored = uploadBrowserSourcemaps({
    release: sha,
    token: 'tok',
    cli: SELF,
    spawn: () => ok,
  });
  assert.equal(stored.stored, true);
  assert.equal(stored.warning, null);

  const empty = uploadBrowserSourcemaps({
    release: sha,
    token: 'tok',
    cli: SELF,
    spawn: () => nothingStored,
  });
  assert.equal(empty.stored, false);
  assert.ok(empty.warning, 'a run that stored nothing must not pass unnoticed');
  assert.match(empty.warning, /will not symbolicate/);
});

test('output that does not say what was stored is not reported as success', () => {
  assert.throws(
    () => uploadBrowserSourcemaps({ release: sha, token: 'tok', cli: SELF, spawn: () => ({ status: 0, stdout: 'sourcemaps upload complete' }) }),
    /did not report what it stored/,
  );
});

// A map on disk that the CLI did not store is a misconfiguration:  the bundle
// does not reference the map beside it, so the upload silently stores nothing.
test('a map on disk that the CLI did not store is a misconfiguration and fails', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'sentry-upload-'));
  try {
    const bundle = resolve(dir, 'bundle.js');
    writeFileSync(bundle, 'console.log(1)\n');
    writeFileSync(`${bundle}.map`, '{"version":3,"sources":[],"mappings":""}\n');
    assert.throws(
      () => uploadBrowserSourcemaps({ release: sha, token: 'tok', cli: SELF, source: bundle, spawn: () => nothingStored }),
      /does not reference it/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Kody finding: the success log claimed source maps were uploaded even when
// the run proved it stored nothing.  The message follows what was stored.
test('the success message is honest about a missing source map', () => {
  assert.match(formatUploadSuccess({ release: sha, stored: true }), /Uploaded browser source maps/);
  const honest = formatUploadSuccess({ release: sha, stored: false });
  assert.match(honest, /No browser source maps stored/);
  assert.ok(
    !/Uploaded browser source maps/.test(honest),
    `the message must not claim an upload that never happened: ${honest}`,
  );
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
