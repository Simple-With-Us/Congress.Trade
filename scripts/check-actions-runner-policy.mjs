import { readdir, readFile } from "node:fs/promises";

/** default-main-protection ruleset on Simple-With-Us/Congress.Trade */
const MAIN_RULESET_ID = "20961339";
const REQUIRED_MAIN_STATUS_CHECKS = [
  "typecheck + test",
  "gitleaks",
  "xcodebuild (unsigned)",
];

const workflowsDir = new URL("../.github/workflows/", import.meta.url);
const workflowNames = (await readdir(workflowsDir))
  .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
  .sort();

const errors = [];
const allowedRunners = new Set([
  // GitHub-hosted standard cloud runners (free for public repos)
  "ubuntu-latest",
  "macos-latest",
  "macos-15",
  "macos-14",
  "macos-26",
  "[self-hosted, macOS, ARM64, xcode26]",
]);

const fullCommitSha = /^[0-9a-f]{40}$/;

// Fleet autofix reusable workflows (board 04b963b7).  Exact path + full SHA only;
// both run on ubuntu-latest, so the hosted-runner policy still holds.  A caller
// may not pass GH_PAT (checked below), so these pushes use GITHUB_TOKEN.
const allowedReusableWorkflows = new Set([
  "Simple-With-Us/AI-Fleet-Coordinator/.github/workflows/pr-autofix-reusable.yml@b634b5113a3293e3b6f7f534abc3594f92c3c900",
  "Simple-With-Us/AI-Fleet-Coordinator/.github/workflows/claude-code-autofix-reusable.yml@c79c7840d4d3d71bffad08067ce4a1084f0bbb34",
  "Simple-With-Us/AI-Fleet-Coordinator/.github/workflows/codex-autofix-reusable.yml@c79c7840d4d3d71bffad08067ce4a1084f0bbb34",
  "Simple-With-Us/congress-trading-shared/.github/workflows/codex-autofix-reusable.yml@31659885f58f08e129b6dc092f3493d7cdb74a11",
]);

for (const name of workflowNames) {
  const text = await readFile(new URL(name, workflowsDir), "utf8");
  const lines = text.split("\n");

  if (name === "sentry-ci-report.yml") {
    for (const required of [
      "  report:\n    if: >-\n",
      "github.event.workflow_run.conclusion == 'failure'",
      "github.event.workflow_run.conclusion == 'timed_out'",
      "github.event.workflow_run.conclusion == 'startup_failure'",
      "github.event.workflow_run.event == 'schedule'",
    ]) {
      if (!text.includes(required)) {
        errors.push(`${name}: Sentry reporter must reject guaranteed no-op workflow completions before runner scheduling`);
        break;
      }
    }
  }

  for (const forbidden of [
    "windows-latest",
    "sparse-checkout:",
  ]) {
    if (text.includes(forbidden)) {
      errors.push(`${name}: forbidden hosted-runner or billable-cache token: ${forbidden}`);
    }
  }

  // IOSENGINEERING-14: iOS compile + XCTest must fail the job.  Advisory
  // continue-on-error let red Mac builds merge.  Do not skip tests.
  if (name === "ios-build.yml") {
    if (/\bcontinue-on-error\s*:/.test(text)) {
      errors.push(`${name}: iOS compile+test must fail the job (no continue-on-error)`);
    }
    if (!text.includes("scripts/ios-ci-xctest.sh")) {
      errors.push(`${name}: must run scripts/ios-ci-xctest.sh (do not only build)`);
    }
    if (!text.includes("name: xcodebuild (unsigned)")) {
      errors.push(`${name}: required-check job must keep name 'xcodebuild (unsigned)'`);
    }
    if (!text.includes("always() && !cancelled()")) {
      errors.push(`${name}: required-check wrapper must always report (not skip on Mac failure)`);
    }
  }

  lines.forEach((line, index) => {
    const runner = line.match(/^\s*runs-on:\s*(.+?)\s*$/);
    if (runner) {
      const value = runner[1];
      if (!allowedRunners.has(value)) {
        errors.push(`${name}:${index + 1}: runner must be ubuntu-latest, macos-26 (GM ship only), or the Mac xcode26 label set`);
      }
      if (
        value.includes("oracle-ci") ||
        (/self-hosted/.test(value) && value !== "[self-hosted, macOS, ARM64, xcode26]")
      ) {
        errors.push(`${name}:${index + 1}: leftover Linux self-hosted / oracle-ci selector`);
      }
    }

    const action = line.match(/^\s*(?:-\s*)?uses:\s*([^\s#]+)/);
    if (/^\s*cache\s*:/.test(line)) {
      errors.push(`${name}:${index + 1}: GitHub Actions cache storage is disabled`);
    }
    if (!action || action[1].startsWith("./")) return;
    if (action[1].startsWith("actions/cache")) {
      errors.push(`${name}:${index + 1}: GitHub Actions cache storage is disabled`);
    }
    const at = action[1].lastIndexOf("@");
    const ref = at === -1 ? "" : action[1].slice(at + 1);
    if (!fullCommitSha.test(ref)) {
      errors.push(`${name}:${index + 1}: third-party action must be pinned to a full commit SHA`);
    }
    if (action[1].includes("/.github/workflows/") && !allowedReusableWorkflows.has(action[1])) {
      errors.push(`${name}:${index + 1}: reusable workflow runner policy is not locally auditable`);
    }
  });

  const uncommented = text
    .split("\n")
    .map((line) => line.replace(/#.*$/, ""))
    .join("\n");
  if (/\bpull_request_target\b/.test(uncommented)) {
    errors.push(`${name}: pull_request_target is forbidden (write token on untrusted PRs; use pull_request + same-repo guard)`);
  }
  if (/\bsecrets\.GH_PAT\b/.test(uncommented) || /\bsecrets\.SHEPHERD_TOKEN\b/.test(uncommented)) {
    errors.push(`${name}: GH_PAT / SHEPHERD_TOKEN must not appear; congress-trading-shared is public and vendored`);
  }
}

const xctestPath = new URL("./ios-ci-xctest.sh", import.meta.url);
const xctest = await readFile(xctestPath, "utf8");
if (!/\bxcodebuild\s+test\b/.test(xctest)) {
  errors.push("scripts/ios-ci-xctest.sh: must run xcodebuild test (do not only build)");
}
if (!xctest.includes("-only-testing:CongressTradeTests")) {
  errors.push("scripts/ios-ci-xctest.sh: must target CongressTradeTests (do not skip XCTest)");
}
if (!xctest.includes("IOS_CI_MIN_TESTS:-71") && !xctest.includes("-lt \"$MIN_TESTS\"")) {
  errors.push("scripts/ios-ci-xctest.sh: must assert at least 71 XCTest cases ran");
}

async function assertMainRulesetRequiredChecks() {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  const inCi = process.env.GITHUB_ACTIONS === "true" || process.env.CI === "true";
  if (!token || !repo) {
    if (inCi) {
      errors.push(
        "ruleset check: GITHUB_TOKEN (or GH_TOKEN) and GITHUB_REPOSITORY must be set in CI — do not skip validation",
      );
      return;
    }
    console.log(
      "Ruleset check skipped locally (no GITHUB_TOKEN/GH_TOKEN or GITHUB_REPOSITORY).",
    );
    return;
  }

  const url = `https://api.github.com/repos/${repo}/rulesets/${MAIN_RULESET_ID}`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) {
    errors.push(
      `ruleset ${MAIN_RULESET_ID}: API ${response.status} — cannot verify required status checks`,
    );
    return;
  }

  const ruleset = await response.json();
  const rule = (ruleset.rules ?? []).find((entry) => entry.type === "required_status_checks");
  const contexts = (rule?.parameters?.required_status_checks ?? []).map(
    (entry) => entry.context,
  );
  for (const required of REQUIRED_MAIN_STATUS_CHECKS) {
    if (!contexts.includes(required)) {
      errors.push(
        `ruleset ${MAIN_RULESET_ID}: required status check missing "${required}" (have: ${contexts.join(", ") || "(none)"})`,
      );
    }
  }
}

await assertMainRulesetRequiredChecks();

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}

console.log(`Actions policy OK: ${workflowNames.length} workflows use GitHub-hosted cloud runners.`);
