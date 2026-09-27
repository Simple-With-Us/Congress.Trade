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

  assert.match(prepare, /ASC_KEY_P8 or ASC_KEY_PATH required/);
  assert.doesNotMatch(prepare, /echo "\$ASC_KEY_P8"/);
  assert.doesNotMatch(prepare, /echo "\$IOS_DIST_P12/);
});
