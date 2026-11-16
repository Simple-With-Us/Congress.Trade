import assert from "node:assert/strict";
import test from "node:test";
import { callerGrantsIssuesWrite, jobBlocks } from "./workflow-permissions.mjs";

const REUSABLE = "Simple-With-Us/AI-Fleet-Coordinator/.github/workflows/pr-autofix-reusable.yml@2f7d5b15de8385aff93ff559e3430c5bce9346a8";

const wrap = ({ workflowPermissions = "permissions: {}", jobPermissions = "" } = {}) => `name: t
on: pull_request
${workflowPermissions}
jobs:
  call:
    ${jobPermissions ? `permissions:\n      ${jobPermissions}\n    ` : ""}uses: ${REUSABLE}
  lint:
    runs-on: ubuntu-latest
    permissions:
      issues: write
    steps:
      - run: true
`;

test("grant inside the calling job's permissions block passes", () => {
  assert.equal(callerGrantsIssuesWrite(wrap({ jobPermissions: "issues: write" }), REUSABLE), true);
});

test("issues: write on an unrelated job does not satisfy the guard", () => {
  assert.equal(callerGrantsIssuesWrite(wrap(), REUSABLE), false);
});

test("job without its own permissions inherits the workflow-level grant", () => {
  const text = wrap().replace("permissions: {}", "permissions:\n  issues: write");
  assert.equal(callerGrantsIssuesWrite(text, REUSABLE), true);
});

test("job-level permissions replace the workflow-level grant", () => {
  const text = wrap({ workflowPermissions: "permissions:\n  issues: write", jobPermissions: "contents: read" })
    .split("  lint:")[0];
  assert.equal(callerGrantsIssuesWrite(text, REUSABLE), false);
});

test("jobBlocks splits the jobs section at two-space keys", () => {
  const names = jobBlocks(wrap()).map(([name]) => name);
  assert.deepEqual(names, ["call", "lint"]);
});
