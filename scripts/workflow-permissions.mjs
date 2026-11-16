/**
 * Job-scoped `issues: write` evaluation for GitHub Actions workflow text.
 *
 * A job-level `permissions:` block REPLACES the workflow-level one, so a
 * file-wide regex can accept an unrelated grant while the job that calls a
 * reusable workflow receives no `issues` scope (Kody on #2823).  These
 * helpers parse the workflow into job blocks and evaluate the exact block
 * whose `uses:` invokes the reusable, without a YAML dependency.
 */

const TOP_LEVEL_KEY = /^[A-Za-z][^\s:]*:/;
const JOB_KEY = /^ {2}([A-Za-z0-9_-][A-Za-z0-9 _-]*):\s*$/;

/** Split the `jobs:` section into [jobName, blockText] pairs. */
export function jobBlocks(text) {
  const lines = text.split("\n");
  const jobsStart = lines.findIndex((line) => line === "jobs:");
  if (jobsStart === -1) return [];
  const blocks = [];
  let current = null;
  for (let index = jobsStart + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (TOP_LEVEL_KEY.test(line)) break;
    const match = JOB_KEY.exec(line);
    if (match) {
      current = [match[1], []];
      blocks.push(current);
    } else if (current) {
      current[1].push(line);
    }
  }
  return blocks.map(([name, block]) => [name, block.join("\n")]);
}

/** True when a permission block grants `issues: write`. */
function grantsIssuesWrite(blockText, indent) {
  const lines = blockText.split("\n");
  const permissionsIndex = lines.findIndex((line) => line === `${indent}permissions:`);
  if (permissionsIndex === -1) return false;
  for (let index = permissionsIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "") continue;
    if (!line.startsWith(`${indent}  `)) break;
    if (new RegExp(`^${indent} {2}issues:\\s*write\\s*$`).test(line)) return true;
  }
  return false;
}

/** Workflow-level permissions live before `jobs:` at zero indent. */
function workflowLevelGrants(text) {
  const beforeJobs = text.split(/^jobs:$/m)[0];
  return grantsIssuesWrite(beforeJobs, "");
}

/**
 * True when the job whose block contains `uses: <reusable>` effectively
 * grants `issues: write`: either its own permissions block does, or it has
 * no permissions block and the workflow-level grant does.
 */
export function callerGrantsIssuesWrite(text, reusable) {
  for (const [, block] of jobBlocks(text)) {
    if (!block.includes(reusable)) continue;
    if (/^ {4}permissions:$/m.test(block)) return grantsIssuesWrite(block, "    ");
    return workflowLevelGrants(text);
  }
  return false;
}
