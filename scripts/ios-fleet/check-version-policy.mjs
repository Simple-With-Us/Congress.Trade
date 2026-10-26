#!/usr/bin/env node
/** Deterministic checked-in release-policy guard; does not read runtime copies. */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(scriptDir, "../..");
const canonical = resolve(scriptDir, "ship-testflight.sh");

export function inspectReleasePolicy(file, source, { canonicalSource = false } = {}) {
  const errors = [];
  const forbidden = [
    ["unverified sequence fallback", /--allow-unverified-seq|UNVERIFIED patch/i],
    ["independent next-marketing-patch allocator", /nextMarketingPatch|NEXT_PATCH|P\s*\+\s*1/],
    ["build-floor replacement allocator", /BUILD_NUM\s*=\s*\$\(\(\s*(?:PLAN_)?FLOOR\s*\+\s*1/],
    ["redundant marketing/build display", /will show this as:.*\([^)]+\)/i],
  ];
  for (const [label, pattern] of forbidden) {
    if (pattern.test(source)) errors.push(`${file}: contains ${label}`);
  }
  if (canonicalSource) {
    const required = [
      ["full-history check", /rev-parse --is-shallow-repository/],
      ["complete repository count", /rev-list --count HEAD/],
      ["marketing pair", /MARKETING="1\.0\.\$\{COMMIT_COUNT\}"/],
      ["build pair", /BUILD_NUM="\$COMMIT_COUNT"/],
      ["published marketing regression guard", /refusing a marketing regression/],
      ["published build conflict guard", /refusing to mint a replacement number/],
      ["validation-only marketing override", /--version \$\{FORCE_VERSION\} conflicts with canonical marketing version/],
      ["validation-only build override", /--build \$\{FORCE_BUILD\} conflicts with canonical build number/],
    ];
    for (const [label, pattern] of required) {
      if (!pattern.test(source)) errors.push(`${file}: missing ${label}`);
    }
  }
  return errors;
}

function main() {
  let files = process.argv.slice(2).map((path) => resolve(process.cwd(), path));
  if (files.length === 0) {
    const tracked = execFileSync("git", ["-C", repoRoot, "ls-files", "-z"], { encoding: "utf8" })
      .split("\0").filter(Boolean);
    files = tracked
      .filter((path) => /(^|\/)(?:ship|publish|release)[^/]*\.(?:sh|mjs|js)$/.test(path))
      .map((path) => resolve(repoRoot, path));
  }
  if (!files.includes(canonical)) files.unshift(canonical);
  let errors = [];
  for (const file of files) {
    let source;
    try { source = readFileSync(file, "utf8"); }
    catch (error) { errors.push(`${file}: cannot read checked-in release source (${error.message})`); continue; }
    errors = errors.concat(inspectReleasePolicy(file, source, { canonicalSource: file === canonical }));
  }
  if (errors.length) {
    console.error(`[version-policy] FAIL (${errors.length})`);
    for (const error of errors) console.error(`  ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`[version-policy] OK: ${files.length} checked-in release source(s); runtime directory not consulted`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
