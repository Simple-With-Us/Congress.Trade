import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  chooseExternalGroup,
  promoteExternalBeta,
  resolveExpectedBuildNumber,
} from "./promote-external-beta.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function read(rel) {
  return readFileSync(join(ROOT, rel), "utf8");
}

/**
 * A fake App Store Connect client.  `state` describes the app;  `calls`
 * records every request so a test can assert what was and was not written.
 */
function fakeAsc(state = {}) {
  const calls = [];
  const s = {
    groups: state.groups || [
      { id: "int1", attributes: { name: "App Testers", isInternalGroup: true, publicLinkEnabled: null } },
      { id: "ext1", attributes: { name: "Public Beta", isInternalGroup: false, publicLinkEnabled: true } },
    ],
    builds: state.builds || [
      { id: "b1", attributes: { version: "2320", processingState: "VALID", uploadedDate: "2026-10-19T11:54:52-07:00" } },
    ],
    inGroup: state.inGroup || [],
    externalState: state.externalState || "READY_FOR_BETA_SUBMISSION",
    linkOk: state.linkOk !== false,
    submitOk: state.submitOk !== false,
    groupsOk: state.groupsOk !== false,
    buildsOk: state.buildsOk !== false,
    ...state,
  };

  const asc = (method, path, body) => {
    calls.push({ method, path, body });
    // Match on the path without its query string;  the real client is called
    // with the full path, query and all.
    const p = path.split("?")[0];
    const ok = (parsed, status = 200) => ({ ok: true, status, parsed, text: JSON.stringify(parsed) });
    const fail = (detail, status = 409) => ({
      ok: false,
      status,
      parsed: { errors: [{ code: "ENTITY_ERROR", detail }] },
      text: "",
    });

    if (/^\/v1\/apps\/[^/]+\/betaGroups$/.test(p)) {
      if (!s.groupsOk) return fail("beta group list failed", 500);
      return ok({ data: s.groups });
    }
    if (p === "/v1/builds" && path.includes("filter[app]")) {
      if (!s.buildsOk) return fail("build list failed", 500);
      // App Store Connect matches filter[version] on CFBundleVersion, verbatim.
      const wanted = path.match(/filter\[version\]=(\d+)/)?.[1];
      if (wanted) {
        return ok({ data: s.builds.filter((b) => b.attributes?.version === wanted) });
      }
      // The diagnostic "newest" query.
      const newest = [...s.builds].sort(
        (a, b) => String(b.attributes?.uploadedDate || "").localeCompare(String(a.attributes?.uploadedDate || ""))
      );
      return ok({ data: newest.slice(0, 1) });
    }
    if (/^\/v1\/betaGroups\/[^/]+\/builds$/.test(p)) {
      return ok({ data: s.inGroup });
    }
    if (/^\/v1\/betaGroups\/[^/]+\/relationships\/builds$/.test(p)) {
      if (!s.linkOk) return fail("the build number is not higher than the current build");
      return { ok: true, status: 204, parsed: null, text: "" };
    }
    if (/^\/v1\/builds\/[^/]+\/buildBetaDetail$/.test(p)) {
      return ok({ data: { id: "b1", attributes: { externalBuildState: s.externalState, internalBuildState: "IN_BETA_TESTING" } } });
    }
    if (p === "/v1/betaAppReviewSubmissions") {
      if (!s.submitOk) return fail("the app record has no review details");
      return ok({ data: { type: "betaAppReviewSubmissions", id: "b1" } }, 201);
    }
    return fail(`unexpected call ${method} ${path}`, 404);
  };
  asc.calls = calls;
  asc.state = s;
  return asc;
}

const noop = () => {};
const TARGET = 2320;

test("promotes the exact build it was told to promote and submits it for Beta App Review", () => {
  const asc = fakeAsc();
  const result = promoteExternalBeta({ asc, appId: "6798076688", buildNumber: TARGET, log: noop, warn: noop });

  assert.equal(result.added, true);
  assert.equal(result.submitted, true);
  assert.equal(result.buildVersion, "2320");
  assert.equal(result.targetBuildNumber, TARGET);
  assert.equal(result.outcome, "promoted");
  assert.equal(result.groupName, "Public Beta");
  assert.equal(result.warnings, 0);

  const link = asc.calls.find((c) => c.method === "POST" && c.path.includes("/relationships/builds"));
  assert.ok(link, "the build must be linked to the group");
  assert.deepEqual(JSON.parse(link.body).data, [{ type: "builds", id: "b1" }]);

  const sub = asc.calls.find((c) => c.path === "/v1/betaAppReviewSubmissions");
  assert.ok(sub, "the build must be submitted for Beta App Review");
  assert.equal(JSON.parse(sub.body).data.relationships.build.data.id, "b1");
});

test("looks the build up by number and never asks for the newest build", () => {
  const asc = fakeAsc();
  promoteExternalBeta({ asc, appId: "6798076688", buildNumber: TARGET, log: noop, warn: noop });

  const buildQueries = asc.calls.filter((c) => c.path.split("?")[0] === "/v1/builds");
  assert.equal(buildQueries.length, 1, "exactly one builds query, the exact-match one");
  assert.match(buildQueries[0].path, /filter\[version\]=2320/);
  assert.doesNotMatch(buildQueries[0].path, /sort=-uploadedDate/);
});

test("promotes the target build, not the newest one, when a newer build exists", () => {
  const asc = fakeAsc({
    builds: [
      { id: "b2", attributes: { version: "2325", processingState: "VALID", uploadedDate: "2026-10-19T20:00:00-07:00" } },
      { id: "b1", attributes: { version: "2320", processingState: "VALID", uploadedDate: "2026-10-19T11:54:52-07:00" } },
    ],
  });
  const result = promoteExternalBeta({ asc, appId: "6798076688", buildNumber: TARGET, log: noop, warn: noop });

  assert.equal(result.added, true);
  assert.equal(result.buildVersion, "2320");
  const link = asc.calls.find((c) => c.method === "POST" && c.path.includes("/relationships/builds"));
  assert.deepEqual(JSON.parse(link.body).data, [{ type: "builds", id: "b1" }]);
});

test("refuses to promote when the build number matches more than one build", () => {
  const asc = fakeAsc({
    builds: [
      { id: "b1", attributes: { version: "2320", processingState: "VALID" } },
      { id: "b2", attributes: { version: "2320", processingState: "VALID" } },
    ],
  });
  const result = promoteExternalBeta({ asc, appId: "6798076688", buildNumber: TARGET, log: noop, warn: noop });

  assert.equal(result.outcome, "ambiguous");
  assert.equal(result.added, false);
  assert.equal(result.warnings, 1);
  assert.equal(asc.calls.some((c) => c.method === "POST"), false);
});

test("reports the shipped build as not yet visible instead of promoting another build", () => {
  const asc = fakeAsc({
    builds: [{ id: "b2", attributes: { version: "2325", processingState: "VALID", uploadedDate: "2026-10-19T20:00:00-07:00" } }],
  });
  const result = promoteExternalBeta({ asc, appId: "6798076688", buildNumber: TARGET, log: noop, warn: noop });

  assert.equal(result.outcome, "not-visible");
  assert.equal(result.added, false);
  assert.equal(result.buildId, null);
  assert.equal(result.warnings, 1);
  assert.equal(asc.calls.some((c) => c.method === "POST"), false, "no other build may be promoted instead");
});

test("refuses to promote a build that is still processing", () => {
  const asc = fakeAsc({
    builds: [{ id: "b1", attributes: { version: "2320", processingState: "PROCESSING" } }],
  });
  const result = promoteExternalBeta({ asc, appId: "6798076688", buildNumber: TARGET, log: noop, warn: noop });

  assert.equal(result.outcome, "not-ready");
  assert.equal(result.added, false);
  assert.equal(result.warnings, 1);
  assert.equal(asc.calls.some((c) => c.method === "POST"), false);
});

test("does nothing at all without a build number to promote", () => {
  const asc = fakeAsc();
  const result = promoteExternalBeta({ asc, appId: "6798076688", buildNumber: null, log: noop, warn: noop });

  assert.equal(result.outcome, "no-target-build");
  assert.equal(result.added, false);
  assert.equal(result.warnings, 1);
  assert.equal(asc.calls.length, 0, "nothing may be asked of App Store Connect without a target");
});

test("is idempotent: a build already in the group is not linked twice", () => {
  const asc = fakeAsc({ inGroup: [{ id: "b1", attributes: { version: "2320" } }] });
  const result = promoteExternalBeta({ asc, appId: "6798076688", buildNumber: TARGET, log: noop, warn: noop });

  assert.equal(result.alreadyPresent, true);
  assert.equal(result.added, false);
  assert.equal(result.outcome, "already-present");
  assert.equal(
    asc.calls.some((c) => c.method === "POST" && c.path.includes("/relationships/builds")),
    false,
    "an already-present build must not be posted again"
  );
});

test("idempotence matches the build id, not the version string", () => {
  // Two builds can carry the same version string;  only the id is unique.
  // Matching on the version alone can call a build present that is not, and
  // then skip the POST and leave the group stale.
  const asc = fakeAsc({ inGroup: [{ id: "other-id", attributes: { version: "2320" } }] });
  const result = promoteExternalBeta({ asc, appId: "6798076688", buildNumber: TARGET, log: noop, warn: noop });

  assert.equal(result.alreadyPresent, false, "a different build with the same version is not this build");
  assert.equal(result.added, true);
  const link = asc.calls.find((c) => c.method === "POST" && c.path.includes("/relationships/builds"));
  assert.deepEqual(JSON.parse(link.body).data, [{ type: "builds", id: "b1" }]);
});

test("does not submit a second review for a build already in review", () => {
  const asc = fakeAsc({
    inGroup: [{ id: "b1", attributes: { version: "2320" } }],
    externalState: "WAITING_FOR_BETA_REVIEW",
  });
  const result = promoteExternalBeta({ asc, appId: "6798076688", buildNumber: TARGET, log: noop, warn: noop });

  assert.equal(result.alreadyPresent, true);
  assert.equal(result.submitted, false);
  assert.equal(result.externalState, "WAITING_FOR_BETA_REVIEW");
  assert.equal(result.warnings, 0);
  assert.equal(asc.calls.some((c) => c.path === "/v1/betaAppReviewSubmissions"), false);
});

test("warns and does nothing when the app has no external beta group", () => {
  const asc = fakeAsc({
    groups: [{ id: "int1", attributes: { name: "App Testers", isInternalGroup: true } }],
  });
  const result = promoteExternalBeta({ asc, appId: "6798076688", buildNumber: TARGET, log: noop, warn: noop });

  assert.equal(result.outcome, "no-external-group");
  assert.equal(result.added, false);
  assert.equal(result.warnings, 1);
  assert.equal(asc.calls.some((c) => c.method === "POST"), false);
});

test("picks the public-link group when an app has several external groups", () => {
  const groups = [
    { id: "int1", attributes: { name: "App Testers", isInternalGroup: true } },
    { id: "ext1", attributes: { name: "Invite Only", isInternalGroup: false, publicLinkEnabled: false } },
    { id: "ext2", attributes: { name: "Public Beta", isInternalGroup: false, publicLinkEnabled: true } },
  ];
  assert.equal(chooseExternalGroup(groups).id, "ext2");
  assert.equal(chooseExternalGroup(groups, "Invite Only").id, "ext1");
  assert.equal(chooseExternalGroup(groups, "Nope"), null);
  assert.equal(chooseExternalGroup([]), null);
});

test("a failed ASC call is a warning, never a throw and never a ship failure", () => {
  const asc = fakeAsc({ linkOk: false });
  const result = promoteExternalBeta({ asc, appId: "6798076688", buildNumber: TARGET, log: noop, warn: noop });

  assert.equal(result.added, false);
  assert.equal(result.outcome, "asc-error");
  assert.equal(result.warnings, 1);
  assert.equal(result.submitted, false);
  assert.equal(asc.calls.some((c) => c.path === "/v1/betaAppReviewSubmissions"), false);
});

test("a build Apple refuses is reported, not silently dropped", () => {
  const asc = fakeAsc({ externalState: "BETA_REJECTED" });
  const result = promoteExternalBeta({ asc, appId: "6798076688", buildNumber: TARGET, log: noop, warn: noop });

  assert.equal(result.added, true);
  assert.equal(result.submitted, false);
  assert.equal(result.warnings, 1);
});

test("a build number that is not a positive integer is refused, not guessed at", () => {
  for (const junk of ["0", "-1", "-2320", "nope", "2320.5", "1e3"]) {
    assert.equal(resolveExpectedBuildNumber({ explicit: junk }), null, `refused: ${JSON.stringify(junk)}`);
  }
  assert.equal(resolveExpectedBuildNumber({ explicit: "2320" }), 2320);
  assert.equal(resolveExpectedBuildNumber({ explicit: " 2320 " }), 2320);
});

test("an absent build number falls back to the checkout's commit count", () => {
  // "" is what an empty step output arrives as, so it means "not provided"
  // rather than "invalid":  the commit count is the right fallback.
  const expected = Number(
    spawnSync("git", ["-C", ROOT, "rev-list", "--count", "HEAD"], { encoding: "utf8" }).stdout.trim()
  );
  assert.equal(resolveExpectedBuildNumber({ explicit: "" }), expected);
  assert.equal(resolveExpectedBuildNumber({ explicit: null }), expected);
});

test("without an explicit number the build number is the checkout's commit count", () => {
  const n = resolveExpectedBuildNumber({ repoRoot: ROOT });
  const expected = Number(
    spawnSync("git", ["-C", ROOT, "rev-list", "--count", "HEAD"], { encoding: "utf8" }).stdout.trim()
  );
  assert.equal(n, expected);
  assert.ok(Number.isInteger(n) && n > 0);
});

// ---- The wiring this file exists for --------------------------------------

test("ios-ship.yml refreshes the public beta after every ship and never fails on it", () => {
  const yml = read(".github/workflows/ios-ship.yml");

  assert.match(yml, /promote-external-beta\.mjs/);
  // The step must ride the same gate as the ship, or it would promote a build
  // that was never uploaded.
  assert.match(yml, /if: success\(\) && steps\.gate\.outputs\.should_ship == '1'/);
  // A promotion problem is a warning;  it must never turn a good ship red.
  assert.match(yml, /continue-on-error: true/);
  // The external group is the whole point, so the step may not be skipped by a
  // later refactor that drops the name of the script.
  assert.match(yml, /name: [^\n]*public TestFlight beta/i);
});

test("the promotion is told which build the ship uploaded", () => {
  const yml = read(".github/workflows/ios-ship.yml");

  // The exact build number, not "the newest one".
  assert.match(yml, /promote-external-beta\.mjs"[\s\S]{0,200}--build/);
  // It comes from the ship run's own log, read by the extractor.
  assert.match(yml, /ios-ship-build-number\.sh/);
  // The ship log has to survive the ship step for that to work.
  assert.match(yml, /congress-ship\.log/);
});

test("the build-number extractor reads the format the fleet script actually prints", () => {
  const fleet = read("scripts/ios-fleet/ship-testflight.sh");

  // If the vendored script stops printing the version this way, the extractor
  // has to change with it --  and this test is what says so.
  assert.match(fleet, /log "marketing=\$\{MARKETING\} build=\$\{BUILD_NUM\}"/);

  const dir = mkdtempSync(join(tmpdir(), "ct-build-number-"));
  const log = join(dir, "ship.log");
  writeFileSync(log, "[ios-ship] bundleId=trade.congress.ios\n[ios-ship] marketing=1.0.2320 build=2320\n");

  const res = spawnSync("bash", [join(ROOT, "scripts", "ios-ship-build-number.sh"), log, ROOT], {
    encoding: "utf8",
  });
  assert.equal(res.status, 0);
  assert.equal(res.stdout.trim(), "2320");
});

test("the promotion script only ever reads the vendored ios-fleet pin", () => {
  const src = read("scripts/promote-external-beta.mjs");

  // Every ASC call goes through the vendored client, which owns the key.
  assert.match(src, /scripts\/ios-fleet\/asc-api\.mjs/);
  assert.doesNotMatch(src, /ASC_KEY_P8/);
  assert.doesNotMatch(src, /fleet-secrets/);
  assert.doesNotMatch(src, /\.secrets/);
  assert.doesNotMatch(src, /createSign|privateKey/);

  // scripts/ios-fleet/ is a sha256-pinned copy of the runtime tooling
  // (scripts/ios-fleet/check-drift.sh).  A script that wrote into it would
  // drift the pin, so this one may only read.
  assert.doesNotMatch(src, /writeFileSync|appendFileSync|createWriteStream|rmSync|unlinkSync/);
  assert.match(src, /readFileSync/);
});

test("the promotion never falls back to the newest build", () => {
  const src = read("scripts/promote-external-beta.mjs");

  // The only "newest" query is the diagnostic one, which reports what IS in
  // App Store Connect;  it must never feed the selection.
  assert.doesNotMatch(src, /sort=-uploadedDate[^\n]*\n[^\n]*build\s*=\s*buildsRes/);
  assert.match(src, /newestKnownBuild/);
});
