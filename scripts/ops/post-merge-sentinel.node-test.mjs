import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WATCHED, GRACE_MINUTES, MAX_DISPATCHES, classifyRun, decide } from './post-merge-sentinel.mjs';

const plain = WATCHED.find((w) => w.file === 'coolify-watch-paths.yml');
const sentry = WATCHED.find((w) => w.file === 'sentry-deploy.yml');
const old = GRACE_MINUTES + 5;
const zeroJobFailure = { status: 'completed', conclusion: 'failure', event: 'push', jobs: [] };

test('a failure with zero jobs never started; a red job did', () => {
  assert.equal(classifyRun(zeroJobFailure, null), 'never_started');
  assert.equal(classifyRun({ status: 'completed', conclusion: 'startup_failure', jobs: [] }, null), 'never_started');
  assert.equal(classifyRun({ status: 'completed', conclusion: 'failure', jobs: [{ name: 'apply', conclusion: 'failure' }] }, null), 'ran');
  assert.equal(classifyRun({ status: 'in_progress', jobs: [] }, null), 'pending');
});

test('the incident case is dispatched once the grace period passes', () => {
  assert.equal(decide({ watched: plain, headAgeMinutes: old, ciSucceeded: true, runs: [zeroJobFailure] }), 'dispatch');
  assert.equal(decide({ watched: plain, headAgeMinutes: 3, ciSucceeded: true, runs: [zeroJobFailure] }), 'wait');
  assert.equal(decide({ watched: plain, headAgeMinutes: old, ciSucceeded: true, runs: [] }), 'dispatch');
});

test('a run that started, even a red one, is never retried', () => {
  const red = { status: 'completed', conclusion: 'failure', event: 'push', jobs: [{ name: 'apply', conclusion: 'failure' }] };
  assert.equal(decide({ watched: plain, headAgeMinutes: old, ciSucceeded: true, runs: [zeroJobFailure, red] }), 'ok');
});

test('Sentry Deploy counts only a run whose record job ran, and only after push CI passed', () => {
  const skippedRecord = { status: 'completed', conclusion: 'success', event: 'workflow_run',
    jobs: [{ name: 'test-reporter', conclusion: 'success' }, { name: 'record-production-deploy', conclusion: 'skipped' }] };
  assert.equal(decide({ watched: sentry, headAgeMinutes: old, ciSucceeded: true, runs: [zeroJobFailure, skippedRecord] }), 'dispatch');
  assert.equal(decide({ watched: sentry, headAgeMinutes: old, ciSucceeded: false, runs: [zeroJobFailure] }), 'ok');
  const recorded = { ...skippedRecord, jobs: [{ name: 'record-production-deploy', conclusion: 'success' }] };
  assert.equal(decide({ watched: sentry, headAgeMinutes: old, ciSucceeded: true, runs: [recorded] }), 'ok');
});

test('dispatches stop after the cap and the sentinel gives up loudly', () => {
  const dispatchedZero = { ...zeroJobFailure, event: 'workflow_dispatch' };
  const runs = [zeroJobFailure, ...Array(MAX_DISPATCHES).fill(dispatchedZero)];
  assert.equal(decide({ watched: plain, headAgeMinutes: old, ciSucceeded: true, runs }), 'give_up');
});

test('every watched workflow can be dispatched, and Sentry Deploy records on a main dispatch', () => {
  for (const { file } of WATCHED) {
    const text = readFileSync(new URL(`../../.github/workflows/${file}`, import.meta.url), 'utf8');
    assert.match(text, /^\s{2}workflow_dispatch:/m, `${file} must accept workflow_dispatch`);
  }
  const deploy = readFileSync(new URL('../../.github/workflows/sentry-deploy.yml', import.meta.url), 'utf8');
  assert.match(deploy, /github\.event_name == 'workflow_dispatch' && github\.ref == 'refs\/heads\/main'/);
  assert.match(deploy, /EXPECTED_SHA: \$\{\{ github\.event_name == 'workflow_dispatch' && github\.sha \|\| github\.event\.workflow_run\.head_sha \}\}/);
});
