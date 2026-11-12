// Post-merge sentinel:  finds the post-merge workflows that never ran for the
// current main commit and dispatches them again.
//
// Why:  during GitHub's Actions incident on 2026-11-09 (CT-2463), the push and
// workflow_run runs for 2c493199 (#2956) ended "failure" with zero jobs.  Coolify
// watch paths and the Shared Package Pin Check never ran, and Sentry Deploy never
// recorded the production deploy.  Nothing noticed, and a run that never started
// can't be re-run.  This script looks only at main HEAD (an older commit's deploy
// is superseded by HEAD's), waits a grace period so normal runs can start, and
// dispatches each watched workflow whose runs for HEAD all failed to start, or
// that has no run at all.  It never re-runs a run that did start:  a red job is a
// real result for a person to read, not something to retry.
//
// Reads use the GitHub REST API with the workflow's GITHUB_TOKEN;  dispatches use
// workflow_dispatch, the one event a GITHUB_TOKEN may start.  It never touches
// production:  Sentry Deploy itself checks the live revision before it records.

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const WATCHED = Object.freeze([
  { file: 'coolify-watch-paths.yml', requiredJob: null, needsCiSuccess: false, shaInput: null },
  { file: 'shared-package-pin-check.yml', requiredJob: null, needsCiSuccess: false, shaInput: null },
  // Sentry Deploy runs on workflow_run from CI;  only its record job matters, and
  // it only runs after a successful push CI on main.  The dispatch pins the SHA
  // whose CI the sentinel checked, so a main that moved on since can't be
  // recorded in its place.
  { file: 'sentry-deploy.yml', requiredJob: 'record-production-deploy', needsCiSuccess: true, shaInput: 'expected_sha' },
]);

export const JOB_FETCH_CONCURRENCY = 5;

export const GRACE_MINUTES = 20;
export const MAX_DISPATCHES = 2;

/**
 * One run's state:  'pending' (queued or running), 'never_started' (GitHub
 * failed it before any job ran), 'not_relevant' (the job that matters was
 * skipped, so this run doesn't count) or 'ran'.
 */
export function classifyRun(run, requiredJob) {
  if (run.status !== 'completed') return 'pending';
  if (run.conclusion === 'startup_failure') return 'never_started';
  const jobs = run.jobs ?? [];
  if (jobs.length === 0) {
    // Only a failure with no jobs is GitHub failing the run before it started.
    // Cancelled, timed-out or approval-gated runs were a decision or a limit, so
    // they count as run and are never resurrected;  skipped runs don't count.
    if (run.conclusion === 'failure') return 'never_started';
    return run.conclusion === 'skipped' ? 'not_relevant' : 'ran';
  }
  if (requiredJob) {
    const job = jobs.find((j) => j.name === requiredJob);
    if (!job || job.conclusion === 'skipped') return 'not_relevant';
  }
  return 'ran';
}

/**
 * What to do for one watched workflow on main HEAD:  'ok', 'wait', 'dispatch'
 * or 'give_up' (dispatched MAX_DISPATCHES times already and still not run).
 */
export function decide({ watched, headAgeMinutes, ciSucceeded, runs }) {
  if (watched.needsCiSuccess && ciSucceeded !== true) return 'ok';
  const states = runs.map((run) => classifyRun(run, watched.requiredJob));
  if (states.includes('ran') || states.includes('pending')) return 'ok';
  if (headAgeMinutes < GRACE_MINUTES) return 'wait';
  const dispatched = runs.filter((run) => run.event === 'workflow_dispatch').length;
  if (dispatched >= MAX_DISPATCHES) return 'give_up';
  return 'dispatch';
}

// Shape checks for the GitHub payloads this script reads.  A response that has
// drifted from these shapes throws instead of feeding a dispatch decision.  The
// script runs with plain node and no install step, so these are hand-written
// rather than zod.
function fail(what) {
  throw new Error(`GitHub response did not match the expected shape:  ${what}`);
}
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const nullableString = (v) => v === null || typeof v === 'string';

export function parseCommit(data) {
  if (!isObject(data) || typeof data.sha !== 'string' || !/^[0-9a-f]{40}$/.test(data.sha)) fail('commit.sha');
  const date = data.commit?.committer?.date;
  if (typeof date !== 'string' || Number.isNaN(Date.parse(date))) fail('commit.committer.date');
  return { sha: data.sha, committedAt: date };
}

export function parseRuns(data) {
  if (!isObject(data) || !Array.isArray(data.workflow_runs)) fail('workflow_runs');
  return data.workflow_runs.map((run) => {
    if (!isObject(run) || !Number.isInteger(run.id) || typeof run.status !== 'string'
      || !nullableString(run.conclusion) || typeof run.event !== 'string') fail('workflow_runs[]');
    return { id: run.id, status: run.status, conclusion: run.conclusion, event: run.event };
  });
}

export function parseJobs(data) {
  if (!isObject(data) || !Array.isArray(data.jobs)) fail('jobs');
  return data.jobs.map((job) => {
    if (!isObject(job) || typeof job.name !== 'string' || !nullableString(job.conclusion)) fail('jobs[]');
    return { name: job.name, conclusion: job.conclusion };
  });
}

async function gh(path, { method = 'GET', body } = {}) {
  const headers = {
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`GitHub ${method} ${path} answered ${res.status}`);
  return res.status === 204 ? null : await res.json();
}

/**
 * Runs for one workflow on `sha`, with jobs filled in only where they decide
 * the answer.  A pending run already means 'ok', so no jobs are fetched then.
 * Otherwise jobs are fetched JOB_FETCH_CONCURRENCY runs at a time, stopping at
 * the first batch that holds a run that ran.  `fetchJobs` is injectable for tests.
 */
export async function runsFor(file, sha, requiredJob, {
  listRuns = async () => parseRuns(await gh(`/actions/workflows/${file}/runs?head_sha=${sha}&per_page=30`)),
  fetchJobs = async (id) => parseJobs(await gh(`/actions/runs/${id}/jobs?per_page=50`)),
} = {}) {
  const runs = (await listRuns()).map((run) => ({ ...run, jobs: [] }));
  if (runs.some((run) => run.status !== 'completed')) return runs;
  const needJobs = runs.filter((run) => run.conclusion !== 'startup_failure');
  for (let i = 0; i < needJobs.length; i += JOB_FETCH_CONCURRENCY) {
    const batch = needJobs.slice(i, i + JOB_FETCH_CONCURRENCY);
    const jobs = await Promise.all(batch.map((run) => fetchJobs(run.id)));
    batch.forEach((run, k) => { run.jobs = jobs[k]; });
    if (batch.some((run) => classifyRun(run, requiredJob) === 'ran')) break;
  }
  return runs;
}

/** The workflow_dispatch body for one watched workflow on main. */
export function dispatchBody(watched, sha) {
  return watched.shaInput ? { ref: 'main', inputs: { [watched.shaInput]: sha } } : { ref: 'main' };
}

export async function main(now = Date.now()) {
  const { sha, committedAt } = parseCommit(await gh('/commits/main'));
  const headAgeMinutes = (now - Date.parse(committedAt)) / 60000;
  const ci = parseRuns(await gh(`/actions/workflows/ci.yml/runs?head_sha=${sha}&event=push&per_page=10`));
  const ciSucceeded = ci.some((run) => run.conclusion === 'success');
  let gaveUp = false;
  for (const watched of WATCHED) {
    const runs = await runsFor(watched.file, sha, watched.requiredJob);
    const action = decide({ watched, headAgeMinutes, ciSucceeded, runs });
    console.log(`${watched.file} on ${sha.slice(0, 8)}: ${action}`);
    if (action === 'dispatch') {
      await gh(`/actions/workflows/${watched.file}/dispatches`, { method: 'POST', body: dispatchBody(watched, sha) });
      console.log(`::notice title=Post-merge run re-dispatched::${watched.file} never ran for ${sha.slice(0, 8)}; dispatched it on main.`);
    }
    if (action === 'give_up') {
      gaveUp = true;
      console.log(`::error title=Post-merge run still missing::${watched.file} has not run for ${sha.slice(0, 8)} after ${MAX_DISPATCHES} dispatches.`);
    }
  }
  if (gaveUp) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
