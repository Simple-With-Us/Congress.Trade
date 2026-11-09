import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  WATCHED, GRACE_MINUTES, MAX_DISPATCHES, JOB_FETCH_CONCURRENCY,
  classifyRun, decide, runsFor, dispatchBody, parseCommit, parseRuns, parseJobs,
} from './post-merge-sentinel.mjs';

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

test('cancelled, timed-out and approval-gated runs with no jobs are never resurrected', () => {
  for (const conclusion of ['cancelled', 'timed_out', 'action_required']) {
    const run = { status: 'completed', conclusion, event: 'push', jobs: [] };
    assert.equal(classifyRun(run, null), 'ran', conclusion);
    assert.equal(decide({ watched: plain, headAgeMinutes: old, ciSucceeded: true, runs: [run] }), 'ok', conclusion);
  }
  assert.equal(classifyRun({ status: 'completed', conclusion: 'skipped', jobs: [] }, null), 'not_relevant');
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
  assert.match(deploy, /EXPECTED_SHA: \$\{\{ github\.event_name == 'workflow_dispatch' && \(inputs\.expected_sha \|\| github\.sha\) \|\| github\.event\.workflow_run\.head_sha \}\}/);
  assert.match(deploy, /^\s{6}expected_sha:/m, 'sentry-deploy.yml must declare the expected_sha input');
  // Only a main dispatch joins the production concurrency group.
  assert.match(deploy, /\(github\.event_name == 'workflow_dispatch' && github\.ref == 'refs\/heads\/main'\)\) && 'production' \|\| github\.ref/);
});

test('the Sentry Deploy dispatch pins the SHA whose CI was checked; the others take no inputs', () => {
  const sha = 'a'.repeat(40);
  assert.deepEqual(dispatchBody(sentry, sha), { ref: 'main', inputs: { expected_sha: sha } });
  assert.deepEqual(dispatchBody(plain, sha), { ref: 'main' });
});

test('GitHub payloads that drifted from the expected shape throw', () => {
  const sha = 'b'.repeat(40);
  assert.deepEqual(parseCommit({ sha, commit: { committer: { date: '2026-11-09T20:00:00Z' } } }), { sha, committedAt: '2026-11-09T20:00:00Z' });
  assert.throws(() => parseCommit({ sha: 'nope', commit: { committer: { date: '2026-11-09T20:00:00Z' } } }), /commit\.sha/);
  assert.throws(() => parseCommit({ sha, commit: {} }), /committer\.date/);
  assert.deepEqual(parseRuns({ workflow_runs: [{ id: 1, status: 'completed', conclusion: null, event: 'push', extra: 1 }] }),
    [{ id: 1, status: 'completed', conclusion: null, event: 'push' }]);
  assert.throws(() => parseRuns({}), /workflow_runs/);
  assert.throws(() => parseRuns({ workflow_runs: [{ id: '1', status: 'completed', conclusion: null, event: 'push' }] }), /workflow_runs\[\]/);
  assert.deepEqual(parseJobs({ jobs: [{ name: 'apply', conclusion: 'success' }] }), [{ name: 'apply', conclusion: 'success' }]);
  assert.throws(() => parseJobs({ jobs: [{ conclusion: 'success' }] }), /jobs\[\]/);
});

test('jobs are fetched in bounded batches, skipped when a run is pending, and stop once a run ran', async () => {
  const completed = (id) => ({ id, status: 'completed', conclusion: 'failure', event: 'push' });
  let calls = [];
  const fetchJobs = async (id) => { calls.push(id); return id === 2 ? [{ name: 'apply', conclusion: 'failure' }] : []; };
  const many = Array.from({ length: 12 }, (_, i) => completed(i + 1));
  const runs = await runsFor('x.yml', 'c'.repeat(40), null, { listRuns: async () => many, fetchJobs });
  assert.deepEqual(calls, [1, 2, 3, 4, 5].slice(0, JOB_FETCH_CONCURRENCY));
  assert.equal(decide({ watched: plain, headAgeMinutes: old, ciSucceeded: true, runs }), 'ok');

  calls = [];
  await runsFor('x.yml', 'c'.repeat(40), null, { listRuns: async () => [completed(1), { ...completed(2), status: 'queued' }], fetchJobs });
  assert.deepEqual(calls, []);

  calls = [];
  await runsFor('x.yml', 'c'.repeat(40), null, { listRuns: async () => many.map((r) => ({ ...r, id: r.id + 100 })), fetchJobs });
  assert.equal(calls.length, 12, 'every run is checked when none ran');
});

test('the entrypoint runs main from a relative path, even when the path needs URL escaping', () => {
  // Node hands the script an absolute argv[1], but import.meta.url is a URL, so a
  // plain string comparison misses any path with a space or other escaped
  // character and main() silently never runs.  Copy the script under such a
  // directory and run it by a relative path.
  const dir = mkdtempSync(join(tmpdir(), 'sentinel dir '));
  try {
    copyFileSync(new URL('./post-merge-sentinel.mjs', import.meta.url), join(dir, 'post-merge-sentinel.mjs'));
    // With no token and a bogus repository, main() must start and fail on its
    // first request, which proves the guard matched.
    const out = spawnSync(process.execPath, ['post-merge-sentinel.mjs'], {
      cwd: dir, encoding: 'utf8', timeout: 20000,
      env: { ...process.env, GITHUB_TOKEN: '', GITHUB_REPOSITORY: 'invalid/invalid' },
    });
    assert.equal(out.status, 1, `expected main() to run and fail; stderr: ${out.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('JSON request bodies carry a Content-Type header', () => {
  const text = readFileSync(new URL('./post-merge-sentinel.mjs', import.meta.url), 'utf8');
  assert.match(text, /if \(body\) headers\['Content-Type'\] = 'application\/json';/);
});
