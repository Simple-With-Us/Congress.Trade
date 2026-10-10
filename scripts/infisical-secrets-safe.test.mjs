// Offline contract test for scripts/infisical-secrets-safe.sh.
//
// prod is the only Infisical environment (owner 2026-10-10).  The infisical CLI
// defaults to `--env dev`, so the wrapper must add `--env prod` when none is
// given and refuse any other value.  Every case runs against a stub `infisical`
// placed first on PATH that only records its arguments:  nothing here reaches
// the real CLI, the network, or any credential.
//
// Run:  node --test scripts/infisical-secrets-safe.test.mjs

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = resolve(fileURLToPath(new URL('./infisical-secrets-safe.sh', import.meta.url)));
const HAS_JQ = spawnSync('jq', ['--version'], { encoding: 'utf8' }).status === 0;

const STUB = `#!/bin/sh
# Test double for the infisical CLI:  record argv, print canned output.
{ for a in "$@"; do printf '%s\\n' "$a"; done; echo '---'; } >> "$STUB_LOG"
case "$2" in
  get) echo "stub-value-not-a-secret" ;;
  --output) echo '[{"secretKey":"B_KEY"},{"secretKey":"A_KEY"}]' ;;
esac
`;

let work;
let stubDir;

before(() => {
  work = mkdtempSync(join(tmpdir(), 'infisical-safe-test-'));
  stubDir = join(work, 'bin');
  spawnSync('mkdir', ['-p', stubDir]);
  writeFileSync(join(stubDir, 'infisical'), STUB);
  chmodSync(join(stubDir, 'infisical'), 0o755);
});

after(() => {
  rmSync(work, { recursive: true, force: true });
});

function run(args) {
  const log = join(work, `log-${Math.random().toString(36).slice(2)}.txt`);
  const result = spawnSync('/bin/bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: {
      PATH: `${stubDir}:/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin`,
      HOME: work,
      STUB_LOG: log,
    },
  });
  const calls = existsSync(log)
    ? readFileSync(log, 'utf8').split('---\n').filter(Boolean).map((c) => c.split('\n').filter(Boolean))
    : [];
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls };
}

function envFlags(argv) {
  const out = [];
  argv.forEach((a, i) => {
    if (a === '--env') out.push(argv[i + 1]);
    else if (a.startsWith('--env=')) out.push(a.slice('--env='.length));
  });
  return out;
}

describe('infisical-secrets-safe.sh is prod-only', () => {
  it('has:  adds --env prod when no --env is given', () => {
    const r = run(['has', 'SOME_KEY', '--projectId', 'proj']);
    assert.equal(r.status, 0);
    assert.equal(r.calls.length, 1);
    assert.deepEqual(r.calls[0], ['secrets', 'get', 'SOME_KEY', '--plain', '--projectId', 'proj', '--env', 'prod']);
    assert.match(r.stderr, /present key=SOME_KEY/);
  });

  it('has:  keeps a single explicit --env prod and --env=prod', () => {
    for (const flag of [['--env', 'prod'], ['--env=prod']]) {
      const r = run(['has', 'SOME_KEY', '--projectId', 'proj', ...flag]);
      assert.equal(r.status, 0);
      assert.deepEqual(envFlags(r.calls[0]), ['prod']);
    }
  });

  it('set:  adds --env prod and never echoes the value', () => {
    const r = run(['set', 'SOME_KEY=hunter2-not-real', '--projectId', 'proj']);
    assert.equal(r.status, 0);
    assert.deepEqual(r.calls[0], ['secrets', 'set', 'SOME_KEY=hunter2-not-real', '--projectId', 'proj', '--env', 'prod']);
    assert.ok(!r.stdout.includes('hunter2') && !r.stderr.includes('hunter2'));
  });

  it('names:  adds --env prod and prints sorted names only', { skip: !HAS_JQ && 'jq not installed' }, () => {
    const r = run(['names', '--projectId', 'proj']);
    assert.equal(r.status, 0);
    assert.deepEqual(r.calls[0], ['secrets', '--output', 'json', '--projectId', 'proj', '--env', 'prod']);
    assert.equal(r.stdout, 'A_KEY\nB_KEY\n');
  });

  const refusals = [
    ['--env dev', ['--env', 'dev']],
    ['--env staging', ['--env', 'staging']],
    ['--env=dev', ['--env=dev']],
    ['--env=staging', ['--env=staging']],
    ['--env production (not a real slug)', ['--env', 'production']],
    ['--env= (empty)', ['--env=']],
    ['trailing --env with no value', ['--env']],
    ['prod then dev', ['--env', 'prod', '--env', 'dev']],
    ['dev then prod', ['--env=dev', '--env', 'prod']],
  ];
  for (const [label, flags] of refusals) {
    for (const base of [['has', 'SOME_KEY'], ['set', 'SOME_KEY=x'], ['names']]) {
      it(`${base[0]}:  refuses ${label} and never calls infisical`, () => {
        const r = run([...base, '--projectId', 'proj', ...flags]);
        assert.notEqual(r.status, 0);
        assert.equal(r.calls.length, 0);
        assert.match(r.stderr, /prod is the only Infisical environment|only prod is allowed/);
      });
    }
  }

  it('still refuses the leaky output flags', () => {
    const r = run(['names', '--projectId', 'proj', '--output=json']);
    assert.notEqual(r.status, 0);
    assert.equal(r.calls.length, 0);
  });
});
