import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), 'merge-local-dev-vars.mjs');

// Fake `fleet-secrets`: serves the keys in FAKE_KEYS (name=value;...), exit 3 for others.
function fakeFleetSecrets(dir) {
  const bin = join(dir, 'fleet-secrets');
  writeFileSync(
    bin,
    `#!/bin/sh
[ "$1" = get ] || exit 2
case ";$FAKE_KEYS;" in
  *";$2="*) v="\${FAKE_KEYS#*$2=}"; printf '%s' "\${v%%;*}"; exit 0 ;;
esac
exit 3
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

function run(env) {
  const dir = mkdtempSync(join(tmpdir(), 'ct-merge-'));
  const devVars = join(dir, '.dev.vars');
  const result = spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: dir,
      CT_LOCAL_BOOTSTRAP_TEST_MODE: '1',
      CT_LOCAL_BOOTSTRAP_TEST_APP_DIR: dir,
      CT_LOCAL_BOOTSTRAP_TEST_DEV_VARS_FILE: devVars,
      ...env(dir),
    },
  });
  return { dir, devVars, result };
}

test('reads machine identity from fleet-secrets when env has none', () => {
  const { devVars, result } = run((dir) => ({
    CT_LOCAL_BOOTSTRAP_TEST_FLEET_SECRETS_BIN: fakeFleetSecrets(dir),
    FAKE_KEYS: 'INFISICAL_CT_CLIENT_ID=fake-id;INFISICAL_CT_CLIENT_SECRET=fake-secret',
  }));
  assert.equal(result.status, 0);
  const out = readFileSync(devVars, 'utf8');
  assert.match(out, /INFISICAL_APP_CLIENT_ID=.*fake-id/);
  assert.match(out, /INFISICAL_APP_CLIENT_SECRET=.*fake-secret/);
});

test('environment wins over fleet-secrets', () => {
  const { devVars, result } = run((dir) => ({
    CT_LOCAL_BOOTSTRAP_TEST_FLEET_SECRETS_BIN: fakeFleetSecrets(dir),
    FAKE_KEYS: 'INFISICAL_CT_CLIENT_ID=from-cli;INFISICAL_CT_CLIENT_SECRET=from-cli',
    INFISICAL_CT_CLIENT_ID: 'from-env',
    INFISICAL_CT_CLIENT_SECRET: 'from-env',
  }));
  assert.equal(result.status, 0);
  const out = readFileSync(devVars, 'utf8');
  assert.match(out, /from-env/);
  assert.doesNotMatch(out, /from-cli/);
});

test('no fleet-secrets and no env is a clean no-op (cloud)', () => {
  const { devVars, result } = run(() => ({}));
  assert.equal(result.status, 0);
  assert.equal(existsSync(devVars), false);
});

test('half an identity pair from fleet-secrets fails closed', () => {
  const { result } = run((dir) => ({
    CT_LOCAL_BOOTSTRAP_TEST_FLEET_SECRETS_BIN: fakeFleetSecrets(dir),
    FAKE_KEYS: 'INFISICAL_CT_CLIENT_ID=only-id',
  }));
  assert.equal(result.status, 1);
});
