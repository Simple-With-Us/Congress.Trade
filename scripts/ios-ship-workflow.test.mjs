import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function read(rel) {
  return readFileSync(join(ROOT, rel), "utf8");
}

test("ios-ship.yml keeps the ship gate and never uses secrets in if", () => {
  const yml = read(".github/workflows/ios-ship.yml");
  const prepare = read("scripts/ios-appstore-gm-prepare.sh");

  assert.match(yml, /runs-on:\s*macos-latest/);
  assert.doesNotMatch(yml, /runs-on:\s*\[self-hosted/);
  assert.match(yml, /github\.event\.repository\.fork == false/);
  assert.match(yml, /id: gate/);
  assert.match(yml, /if: steps\.gate\.outputs\.should_ship == '1'/);
  assert.match(yml, /ios-appstore-gm-prepare\.sh/);
  assert.match(yml, /Load Infisical signing secrets/);
  assert.match(yml, /secrets\.INFISICAL_PROJECT_ID/);
  assert.match(yml, /secrets\.INFISICAL_UNIVERSAL_AUTH_CLIENT_ID/);
  assert.match(yml, /infisical login --method=universal-auth/);
  assert.match(yml, /ASC_KEY_ID/);
  assert.match(yml, /scripts\/ios-stage-asc-key\.sh/);
  assert.doesNotMatch(yml, /for name in .*ASC_KEY_P8/);
  assert.doesNotMatch(yml, /secrets\.ASC_KEY_ID/);
  assert.doesNotMatch(yml, /ASC_KEY_ID: \$\{\{ secrets\.ASC_KEY_ID \}\}/);
  assert.doesNotMatch(yml, /if:.*secrets\./);
  assert.doesNotMatch(yml, /ios-ship-testflight\.sh["'\s].*--force-ship/);
  assert.match(yml, /workflow_dispatch/);
  assert.match(yml, /scripts\/ios-ship-testflight\.sh/);
  assert.match(yml, /Infisical prod SENTRY_DSN is missing/);

  const ship = read("scripts/ios-fleet/ship-testflight.sh");
  assert.match(ship, /refusing to archive a mute TestFlight build/);
  assert.match(ship, /SENTRY_DSN present for archive/);

  assert.match(prepare, /ASC_KEY_P8 or ASC_KEY_PATH required/);
  assert.doesNotMatch(prepare, /echo "\$ASC_KEY_P8"/);
  assert.doesNotMatch(prepare, /echo "\$IOS_DIST_P12/);
});

test("ios ship workflows quote ASC name comparisons", () => {
  for (const rel of [
    ".github/workflows/ios-ship.yml",
    ".github/workflows/ios-appstore-gm.yml",
  ]) {
    const yml = read(rel);
    const quoted = yml.match(/\[\[ "\$name" == "ASC_KEY_ID" \|\| "\$name" == "ASC_ISSUER_ID" \]\]/g) || [];
    assert.ok(quoted.length >= 2, `${rel} must quote both ASC routing checks`);
    assert.doesNotMatch(yml, /== ASC_KEY_ID(?!")/);
    assert.doesNotMatch(yml, /== ASC_ISSUER_ID(?!")/);
    assert.doesNotMatch(yml, /== SENTRY_DSN(?!")/);
  }
});

test("ios-appstore-gm.yml ships with notes, Sentry, and a per-run gate override", () => {
  const yml = read(".github/workflows/ios-appstore-gm.yml");

  // What to Test is mandatory on every upload (owner 2026-09-08): publish, never dry-log.
  assert.match(yml, /IOS_TF_RELEASE_NOTES:\s*"1"/);
  // A mute archive is refused by ship-testflight.sh, so the DSN must be loaded here too.
  assert.match(yml, /Infisical prod SENTRY_DSN is missing/);
  assert.match(yml, /"\$name" == "SENTRY_DSN"/);
  // No standing gate override.  The only bypass is the per-run force_ship input.
  assert.doesNotMatch(yml, /IOS_TF_MIN_INTERVAL_SEC/);
  assert.doesNotMatch(yml, /ios-ship-testflight\.sh["'\s].*--force-ship/);
  assert.match(yml, /force_ship:\s*\n\s+description:[^\n]*\n\s+type: boolean\s*\n\s+default: false/);
  assert.match(yml, /FORCE_SHIP:\s*\$\{\{ inputs\.force_ship \}\}/);
  // Hosted runners start empty, so the gate and the notes range are seeded.
  assert.match(yml, /actions: read/);
  assert.match(yml, /Seed last-ship state/);
  assert.match(yml, /last-ship-congress\.txt/);
  assert.match(yml, /prev_at="\$\{prev_at%%\.\*\}"/);
  // A gate skip must not look like a shipped build.
  assert.match(yml, /Assert this checkout was uploaded/);
  assert.match(yml, /fetch-depth: 0/);
});

test("release notes timestamp uses the owner clock without a timezone abbreviation", () => {
  const src = read("scripts/ios-fleet/asc-api.mjs");
  const fn = src.match(/function centralTimestamp[\s\S]*?\n}\n/)[0];
  assert.doesNotMatch(fn, /\bCT\b[`"']/);
  assert.match(fn, /toLowerCase\(\)/);
});

// ---- Auto-ship contract for ios-ship.yml (owner 2026-10-17) ---------------
// A merge to main that touches the app's native tree must upload a TestFlight
// build with no human step.  These checks pin every piece of that wiring so a
// refactor cannot quietly turn the pipeline back into a manual one.

function withoutComments(text) {
  return text
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

function onBlock(yml) {
  // The top-level `on:` mapping, up to the next top-level key.
  const m = yml.match(/^on:\n((?:[ \t]+.*\n|[ \t]*#.*\n|\n)*)/m);
  assert.ok(m, "ios-ship.yml must declare an on: block");
  return m[1];
}

test("ios-ship.yml ships automatically on a merge that touches the native tree", () => {
  const yml = read(".github/workflows/ios-ship.yml");
  const code = withoutComments(yml);
  const on = withoutComments(onBlock(yml));

  // Trigger: push to main, filtered to the native tree (and the workflow file).
  assert.match(on, /push:\s*\n\s+branches:\s*\[main\]/);
  assert.match(on, /paths:\s*\n(?:\s+-\s+'[^']+'\n)*?\s+-\s+'clients\/ios\/\*\*'/);
  assert.match(on, /workflow_dispatch:/);

  // A scheduled catch-up is allowed only behind the scheduled path gate.
  if (/^\s+schedule:/m.test(on)) {
    assert.match(code, /scheduled-ship-gate\.sh/);
    assert.match(code, /--path-prefix 'clients\/ios\/'/);
    assert.match(code, /--event "\$\{\{ github\.event_name \}\}"/);
  }

  // The gate diffs against an older sha, and the notes need the commit range.
  assert.match(code, /fetch-depth:\s*0/);
  // What to Test is mandatory and published, never dry-rendered.
  assert.match(code, /IOS_TF_RELEASE_NOTES:\s*"1"/);
  // Ship through the wrapper that runs ship-testflight.sh (ensure-tf-ready inside).
  assert.match(code, /bash "\$GITHUB_WORKSPACE\/scripts\/ios-ship-testflight\.sh"\s*$/m);
  // Hosted macOS with the stable-Xcode guard; ASC credentials from Fleet Secrets /asc.
  assert.match(code, /runs-on:\s*macos-latest/);
  assert.match(code, /Assert stable Xcode/);
  assert.match(code, /secret_path=\/asc/);
  assert.match(code, /ASC_INFISICAL_PROJECT_ID:\s*8dae6d03-8f12-48b2-adf3-e5c1b881c8c5/);
});

test("no iOS ship workflow carries a standing gate override", () => {
  for (const rel of [
    ".github/workflows/ios-ship.yml",
    ".github/workflows/ios-appstore-gm.yml",
  ]) {
    const code = withoutComments(read(rel));
    assert.doesNotMatch(code, /IOS_TF_MIN_INTERVAL_SEC/, `${rel} must not set the interval override`);
    assert.doesNotMatch(code, /ios-ship-testflight\.sh["'\s].*--force-ship/, `${rel} must not hard-code --force-ship`);
    assert.doesNotMatch(code, /IOS_TF_RELEASE_NOTES:\s*"0"/, `${rel} must not turn What to Test off`);
  }
});

test("the push paths filter matches the native tree and not backend code", () => {
  const on = withoutComments(onBlock(read(".github/workflows/ios-ship.yml")));
  const globs = [...on.matchAll(/^\s+-\s+'([^']+)'$/gm)].map((m) => m[1]);
  // GitHub's `dir/**` matches anything under dir/.
  const matches = (glob, file) => glob.endsWith("/**")
    ? file.startsWith(glob.slice(0, -2))
    : file === glob;
  const hit = (file) => globs.some((g) => matches(g, file));

  assert.ok(hit("clients/ios/CongressTrade/ContentView.swift"));
  assert.ok(hit("clients/ios/CongressTrade.xcodeproj/project.pbxproj"));
  assert.ok(!hit("app/src/deno/main.ts"), "backend-only commits must not ship a TestFlight build");
  assert.ok(!hit("docs/rollouts/2026-10-17-ios-autoship-reenable.md"));
});
