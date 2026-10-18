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
