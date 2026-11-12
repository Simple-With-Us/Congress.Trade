/**
 * Restore last-ship state from a previous successful GitHub Actions run.
 *
 * Hosted runners start with an empty home, and this repo forbids
 * actions/cache. The GM workflow can use the newest successful run, because
 * a skip fails that job. ios-ship's scheduled skips exit 0, and so does a
 * rate-gate skip inside the ship script. Seeding either one would write a
 * recent timestamp for a sha that was not uploaded, and the 1 hour rate
 * gate would then block every real push.
 *
 * The CLI is what scripts/ios-fleet/seed-last-ship.sh calls. The exports
 * are the tested part.
 */

import { pathToFileURL } from "node:url";

/** A cron skip finishes well under this. An archive does not. */
export const DEFAULT_MIN_RUN_SECONDS = 180;

/** The ship step itself, not the checkout. A rate-gate skip is a few seconds. */
export const DEFAULT_MIN_STEP_SECONDS = 60;

const FULL_SHA = /^[0-9a-f]{40}$/;
const SECOND_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/**
 * @param {string} value RFC 3339 from `gh`, with or without a fraction.
 * @returns {{ iso: string, unix: number } | null}
 */
export function normalizeUpdatedAt(value) {
  if (typeof value !== "string") return null;
  let text = value.trim();
  const dot = text.indexOf(".");
  if (dot !== -1) text = text.slice(0, dot);
  text = text.replace(/Z$/, "");
  text = text.replace(/\+00:00$/, "");
  text += "Z";
  if (!SECOND_STAMP.test(text)) return null;
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) return null;
  return { iso: text, unix: Math.floor(ms / 1000) };
}

/**
 * @param {string} updatedAt
 * @param {string} headSha
 * @returns {string | null} "<unix_ts> <git_sha>"
 */
export function stateLine(updatedAt, headSha) {
  if (typeof headSha !== "string" || !FULL_SHA.test(headSha)) return null;
  const when = normalizeUpdatedAt(updatedAt);
  if (!when) return null;
  return `${when.unix} ${headSha}`;
}

/**
 * Newest successful run only. A bad sha does not fall through to an older
 * run: the GM workflow asks `gh run list --limit 1` and skips seeding.
 *
 * @param {unknown} listJson
 * @returns {string | null}
 */
export function firstListedRunLine(listJson) {
  if (!Array.isArray(listJson) || listJson.length === 0) return null;
  const first = listJson[0];
  if (!first || typeof first !== "object") return null;
  const row = /** @type {{ updatedAt?: string, updated_at?: string, headSha?: string, head_sha?: string }} */ (first);
  return stateLine(row.updatedAt ?? row.updated_at ?? "", row.headSha ?? row.head_sha ?? "");
}

/**
 * @param {{ run_started_at?: string, runStartedAt?: string, created_at?: string, createdAt?: string, updated_at?: string, updatedAt?: string }} run
 * @returns {number | null}
 */
export function runDurationSeconds(run) {
  const startRaw = run.run_started_at ?? run.runStartedAt ?? run.created_at ?? run.createdAt;
  const endRaw = run.updated_at ?? run.updatedAt;
  const start = Date.parse(startRaw ?? "");
  const end = Date.parse(endRaw ?? "");
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return Math.floor((end - start) / 1000);
}

/**
 * Newest-first long runs from one Actions runs page. Short skips are dropped
 * here so the shell does not request jobs for every cron tick.
 *
 * @param {unknown} page
 * @param {number} minRunSeconds
 * @returns {{ id: number, headSha: string, updatedAt: string, durationSeconds: number }[]}
 */
export function longRunCandidates(page, minRunSeconds) {
  const body = page && typeof page === "object"
    ? /** @type {{ workflow_runs?: unknown, workflowRuns?: unknown }} */ (page)
    : {};
  const runs = body.workflow_runs ?? body.workflowRuns;
  if (!Array.isArray(runs)) return [];
  /** @type {{ id: number, headSha: string, updatedAt: string, durationSeconds: number }[]} */
  const out = [];
  for (const run of runs) {
    if (!run || typeof run !== "object") continue;
    const row = /** @type {{ id?: unknown, head_sha?: unknown, headSha?: unknown, updated_at?: unknown, updatedAt?: unknown }} */ (run);
    const duration = runDurationSeconds(row);
    if (duration === null || duration < minRunSeconds) continue;
    const sha = typeof row.head_sha === "string"
      ? row.head_sha
      : typeof row.headSha === "string"
        ? row.headSha
        : "";
    const updated = typeof row.updated_at === "string"
      ? row.updated_at
      : typeof row.updatedAt === "string"
        ? row.updatedAt
        : "";
    if (typeof row.id !== "number" || !FULL_SHA.test(sha) || updated.length === 0) continue;
    out.push({ id: row.id, headSha: sha, updatedAt: updated, durationSeconds: duration });
  }
  return out;
}

/**
 * @param {unknown} page
 * @returns {number}
 */
export function pageLength(page) {
  if (!page || typeof page !== "object") return 0;
  const runs = /** @type {{ workflow_runs?: unknown }} */ (page).workflow_runs;
  return Array.isArray(runs) ? runs.length : 0;
}

/**
 * @param {unknown} jobsPayload
 * @param {string} stepName
 * @returns {{ conclusion: string | null, seconds: number | null } | null}
 */
export function shipStepTiming(jobsPayload, stepName) {
  const jobs = Array.isArray(jobsPayload)
    ? jobsPayload
    : jobsPayload && typeof jobsPayload === "object"
      ? /** @type {{ jobs?: unknown }} */ (jobsPayload).jobs
      : null;
  if (!Array.isArray(jobs)) return null;
  for (const job of jobs) {
    if (!job || typeof job !== "object") continue;
    const steps = /** @type {{ steps?: unknown }} */ (job).steps;
    if (!Array.isArray(steps)) continue;
    for (const step of steps) {
      if (!step || typeof step !== "object") continue;
      const row = /** @type {{ name?: unknown, conclusion?: unknown, started_at?: unknown, startedAt?: unknown, completed_at?: unknown, completedAt?: unknown }} */ (step);
      if (row.name !== stepName) continue;
      const start = Date.parse(String(row.started_at ?? row.startedAt ?? ""));
      const end = Date.parse(String(row.completed_at ?? row.completedAt ?? ""));
      const seconds = Number.isFinite(start) && Number.isFinite(end) && end >= start
        ? Math.floor((end - start) / 1000)
        : null;
      const conclusion = typeof row.conclusion === "string" ? row.conclusion : null;
      return { conclusion, seconds };
    }
  }
  return null;
}

/**
 * @param {{ conclusion: string | null, seconds: number | null } | null} timing
 * @param {number} minStepSeconds
 * @returns {boolean}
 */
export function isUploadStep(timing, minStepSeconds) {
  return timing?.conclusion === "success"
    && typeof timing.seconds === "number"
    && timing.seconds >= minStepSeconds;
}

/**
 * @param {string[]} argv
 * @param {string} name
 * @returns {string | null}
 */
function flag(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1 || index + 1 >= argv.length) return null;
  return argv[index + 1];
}

/**
 * @param {string[]} argv
 * @param {string} name
 * @param {number} fallback
 * @returns {number}
 */
function secondsFlag(argv, name, fallback) {
  const raw = flag(argv, name);
  if (raw === null) return fallback;
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return Number(raw);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * @param {string} raw
 * @returns {unknown}
 */
function parseJson(raw) {
  const text = raw.trim();
  if (text.length === 0) return null;
  return JSON.parse(text);
}

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0] ?? "";
  switch (command) {
    case "from-run-list": {
      const line = firstListedRunLine(parseJson(await readStdin()) ?? []);
      if (line) process.stdout.write(`${line}\n`);
      return;
    }
    case "long-runs": {
      const min = secondsFlag(argv.slice(1), "--min-seconds", DEFAULT_MIN_RUN_SECONDS);
      const rows = longRunCandidates(parseJson(await readStdin()), min);
      for (const row of rows) {
        process.stdout.write(`${row.id}\t${row.updatedAt}\t${row.headSha}\n`);
      }
      return;
    }
    case "page-count": {
      process.stdout.write(`${pageLength(parseJson(await readStdin()))}\n`);
      return;
    }
    case "step-uploaded": {
      const step = flag(argv.slice(1), "--step");
      if (!step) throw new Error("--step is required");
      const min = secondsFlag(argv.slice(1), "--min-seconds", DEFAULT_MIN_STEP_SECONDS);
      const timing = shipStepTiming(parseJson(await readStdin()), step);
      process.stdout.write(isUploadStep(timing, min) ? "yes\n" : "no\n");
      return;
    }
    case "state-line": {
      const updated = flag(argv.slice(1), "--updated-at");
      const sha = flag(argv.slice(1), "--sha");
      if (updated === null || sha === null) throw new Error("--updated-at and --sha are required");
      const line = stateLine(updated, sha);
      if (line) process.stdout.write(`${line}\n`);
      return;
    }
    default: {
      const unexpected = command;
      throw new Error(`unknown command: ${unexpected}`);
    }
  }
}

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`seed-last-ship: ${message}\n`);
    process.exit(1);
  });
}
