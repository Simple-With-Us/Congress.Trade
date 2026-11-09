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

export const WATCHED = Object.freeze([
  { file: 'coolify-watch-paths.yml', requiredJob: null, needsCiSuccess: false },
  { file: 'shared-package-pin-check.yml', requiredJob: null, needsCiSuccess: false },
  // Sentry Deploy runs on workflow_run from CI;  only its record job matters, and
  // it only runs after a successful push CI on main.
  { file: 'sentry-deploy.yml', requiredJob: 'record-production-deploy', needsCiSuccess: true },
]);

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
  if (jobs.length === 0) return run.conclusion === 'skipped' ? 'not_relevant' : 'never_started';
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

async function gh(path, { method = 'GET', body } = {}) {
  const res = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`GitHub ${method} ${path} answered ${res.status}`);
  return res.status === 204 ? null : res.json();
}

async function runsFor(file, sha) {
  const page = await gh(`/actions/workflows/${file}/runs?head_sha=${sha}&per_page=30`);
  const runs = [];
  for (const run of page.workflow_runs ?? []) {
    let jobs = [];
    if (run.status === 'completed' && run.conclusion !== 'startup_failure') {
      jobs = (await gh(`/actions/runs/${run.id}/jobs?per_page=50`)).jobs ?? [];
    }
    runs.push({ ...run, jobs: jobs.map((j) => ({ name: j.name, conclusion: j.conclusion })) });
  }
  return runs;
}

export async function main(now = Date.now()) {
  const head = await gh('/commits/main');
  const sha = head.sha;
  const headAgeMinutes = (now - Date.parse(head.commit.committer.date)) / 60000;
  const ci = await gh(`/actions/workflows/ci.yml/runs?head_sha=${sha}&event=push&per_page=10`);
  const ciSucceeded = (ci.workflow_runs ?? []).some((run) => run.conclusion === 'success');
  let gaveUp = false;
  for (const watched of WATCHED) {
    const runs = await runsFor(watched.file, sha);
    const action = decide({ watched, headAgeMinutes, ciSucceeded, runs });
    console.log(`${watched.file} on ${sha.slice(0, 8)}: ${action}`);
    if (action === 'dispatch') {
      await gh(`/actions/workflows/${watched.file}/dispatches`, { method: 'POST', body: { ref: 'main' } });
      console.log(`::notice title=Post-merge run re-dispatched::${watched.file} never ran for ${sha.slice(0, 8)}; dispatched it on main.`);
    }
    if (action === 'give_up') {
      gaveUp = true;
      console.log(`::error title=Post-merge run still missing::${watched.file} has not run for ${sha.slice(0, 8)} after ${MAX_DISPATCHES} dispatches.`);
    }
  }
  if (gaveUp) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
