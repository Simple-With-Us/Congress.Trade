import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { inspectReleasePolicy } from "./check-version-policy.mjs";

const ascApiPath = fileURLToPath(new URL("./asc-api.mjs", import.meta.url));

const canonical = `
const SHALLOW="$(git rev-parse --is-shallow-repository)";
git rev-list --count HEAD
MARKETING="1.0.\${COMMIT_COUNT}"
BUILD_NUM="$COMMIT_COUNT"
die "refusing a marketing regression"
die "refusing to mint a replacement number"
die "--version \${FORCE_VERSION} conflicts with canonical marketing version"
die "--build \${FORCE_BUILD} conflicts with canonical build number"
`;

test("canonical checked-in ship selector states the shared protocol", () => {
  assert.deepEqual(inspectReleasePolicy("ship-testflight.sh", canonical, { canonicalSource: true }), []);
});

test("checked-in copies with independent allocation or fallback are rejected", () => {
  const bad = `${canonical}\nconst next = nextMarketingPatch();\n--allow-unverified-seq`;
  const errors = inspectReleasePolicy("app/scripts/ship.sh", bad);
  assert.ok(errors.some((error) => error.includes("independent next-marketing-patch allocator")));
  assert.ok(errors.some((error) => error.includes("unverified sequence fallback")));
});

test("missing required canonical checks are rejected", () => {
  assert.ok(inspectReleasePolicy("ship-testflight.sh", "MARKETING='1.0.1'", { canonicalSource: true }).length > 0);
});

test("the App Store Connect helper carries no independent next-marketing allocator", () => {
  const source = readFileSync(ascApiPath, "utf8");
  assert.deepEqual(inspectReleasePolicy("asc-api.mjs", source), []);
  assert.ok(!source.includes("nextMarketingPatch"));
  assert.ok(!source.includes("nextMarketing"));
});
