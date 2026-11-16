import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  DEFAULT_MIN_RUN_SECONDS,
  DEFAULT_MIN_STEP_SECONDS,
  firstListedRunLine,
  isUploadStep,
  longRunCandidates,
  pageLength,
  runDurationSeconds,
  shipStepTiming,
  stateLine,
} from "./seed-last-ship.mjs";

const MJS = join(dirname(fileURLToPath(import.meta.url)), "seed-last-ship.mjs");
const SHA_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SHA_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const STAMP = "2026-11-01T12:00:00Z";
const UNIX = Math.floor(Date.parse(STAMP) / 1000);

function cli(args, stdin = "") {
  const list = Array.isArray(args) ? args : [args];
  return spawnSync(process.execPath, [MJS, ...list], { input: stdin, encoding: "utf8" });
}

test("state line drops a fractional timestamp and rejects a short sha", () => {
  assert.equal(stateLine(`${STAMP.slice(0, -1)}.999Z`, SHA_A), `${UNIX} ${SHA_A}`);
  assert.equal(stateLine(`${STAMP.slice(0, -1)}.999+00:00`, SHA_A), `${UNIX} ${SHA_A}`);
  assert.equal(stateLine(STAMP, SHA_A), `${UNIX} ${SHA_A}`);
  assert.equal(stateLine(STAMP, "abc"), null);
  assert.equal(stateLine("not-a-time", SHA_A), null);
});

test("the newest listed run is the only GM candidate", () => {
  const line = firstListedRunLine([
    { updatedAt: STAMP, headSha: SHA_A },
    { updatedAt: "2026-11-02T12:00:00Z", headSha: SHA_B },
  ]);
  assert.equal(line, `${UNIX} ${SHA_A}`);
  assert.equal(firstListedRunLine([{ updatedAt: STAMP, headSha: "deadbeef" }]), null);
  assert.equal(firstListedRunLine([]), null);
});

test("long-run selection keeps upload-length runs in page order", () => {
  const page = {
    workflow_runs: [
      {
        id: 1,
        head_sha: SHA_A,
        run_started_at: "2026-11-03T12:00:00Z",
        updated_at: "2026-11-03T12:00:09Z",
      },
      {
        id: 2,
        head_sha: SHA_B,
        run_started_at: "2026-11-02T12:00:00Z",
        updated_at: "2026-11-02T12:10:00Z",
      },
    ],
  };
  assert.equal(runDurationSeconds(page.workflow_runs[0]), 9);
  assert.equal(runDurationSeconds(page.workflow_runs[1]), 600);
  assert.equal(pageLength(page), 2);
  const rows = longRunCandidates(page, DEFAULT_MIN_RUN_SECONDS);
  assert.deepEqual(rows.map((row) => row.id), [2]);
  assert.equal(rows[0].headSha, SHA_B);
  assert.deepEqual(longRunCandidates(page, 601), []);
});

test("a skipped or brief ship step is not an upload", () => {
  const jobs = {
    jobs: [
      {
        name: "TestFlight archive + upload",
        steps: [
          {
            name: "Ship CongressTrade to TestFlight",
            conclusion: "success",
            started_at: "2026-11-02T12:00:00Z",
            completed_at: "2026-11-02T12:08:00Z",
          },
        ],
      },
    ],
  };
  const uploaded = shipStepTiming(jobs, "Ship CongressTrade to TestFlight");
  assert.equal(uploaded?.seconds, 480);
  assert.equal(isUploadStep(uploaded, DEFAULT_MIN_STEP_SECONDS), true);
  assert.equal(isUploadStep({ conclusion: "success", seconds: 5 }, DEFAULT_MIN_STEP_SECONDS), false);
  assert.equal(isUploadStep({ conclusion: "skipped", seconds: 500 }, DEFAULT_MIN_STEP_SECONDS), false);
  assert.equal(isUploadStep({ conclusion: "success", seconds: null }, DEFAULT_MIN_STEP_SECONDS), false);
  assert.equal(shipStepTiming(jobs, "Other step"), null);
});

test("cli contracts the shell parses", () => {
  const listed = cli("from-run-list", JSON.stringify([{ updatedAt: STAMP, headSha: SHA_A }]));
  assert.equal(listed.status, 0);
  assert.equal(listed.stdout, `${UNIX} ${SHA_A}\n`);

  const page = cli(
    ["long-runs", "--min-seconds", "180"],
    JSON.stringify({
      workflow_runs: [
        {
          id: 9,
          head_sha: SHA_B,
          run_started_at: "2026-11-02T12:00:00Z",
          updated_at: "2026-11-02T12:10:00.5Z",
        },
      ],
    }),
  );
  assert.equal(page.status, 0);
  assert.equal(page.stdout, `9\t2026-11-02T12:10:00.5Z\t${SHA_B}\n`);

  const count = cli("page-count", JSON.stringify({ workflow_runs: [{}, {}] }));
  assert.equal(count.stdout, "2\n");

  const step = cli(
    ["step-uploaded", "--step", "Ship CongressTrade to TestFlight", "--min-seconds", "60"],
    JSON.stringify({
      jobs: [{
        steps: [{
          name: "Ship CongressTrade to TestFlight",
          conclusion: "skipped",
          started_at: "2026-11-02T12:00:00Z",
          completed_at: "2026-11-02T12:05:00Z",
        }],
      }],
    }),
  );
  assert.equal(step.stdout, "no\n");

  const line = cli(["state-line", "--updated-at", STAMP, "--sha", SHA_A]);
  assert.equal(line.status, 0);
  assert.equal(line.stdout, `${UNIX} ${SHA_A}\n`);

  const unknown = cli("nope");
  assert.equal(unknown.status, 1);
});
