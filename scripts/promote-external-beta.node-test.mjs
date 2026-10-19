import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { chooseExternalGroup, promoteExternalBeta } from "./promote-external-beta.mjs";

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
    build: state.build || {
      id: "b1",
      attributes: { version: "2320", processingState: "VALID", uploadedDate: "2026-10-19T11:54:52-07:00" },
    },
    // The build list, newest first.  Defaults to the single `build` above.
    builds: state.builds || null,
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
      const all = s.builds || (s.build ? [s.build] : []);
      // App Store Connect honours filter[processingState]; the fake does too,
      // so a test can prove which build the script actually selects.
      if (path.includes("filter[processingState]=VALID")) {
        return ok({ data: all.filter((b) => b.attributes?.processingState === "VALID") });
      }
      return ok({ data: all });
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

test("promotes the newest build and submits it for Beta App Review", () => {
  const asc = fakeAsc();
  const result = promoteExternalBeta({ asc, appId: "6798076688", log: noop, warn: noop });

  assert.equal(result.added, true);
  assert.equal(result.submitted, true);
  assert.equal(result.buildVersion, "2320");
  assert.equal(result.groupName, "Public Beta");
  assert.equal(result.warnings, 0);

  const link = asc.calls.find((c) => c.method === "POST" && c.path.includes("/relationships/builds"));
  assert.ok(link, "the build must be linked to the group");
  assert.deepEqual(JSON.parse(link.body).data, [{ type: "builds", id: "b1" }]);

  const sub = asc.calls.find((c) => c.path === "/v1/betaAppReviewSubmissions");
  assert.ok(sub, "the build must be submitted for Beta App Review");
  assert.equal(JSON.parse(sub.body).data.relationships.build.data.id, "b1");
});

test("is idempotent: a build already in the group is not linked twice", () => {
  const asc = fakeAsc({ inGroup: [{ id: "b1", attributes: { version: "2320" } }] });
  const result = promoteExternalBeta({ asc, appId: "6798076688", log: noop, warn: noop });

  assert.equal(result.alreadyPresent, true);
  assert.equal(result.added, false);
  assert.equal(
    asc.calls.some((c) => c.method === "POST" && c.path.includes("/relationships/builds")),
    false,
    "an already-present build must not be posted again"
  );
});

test("does not submit a second review for a build already in review", () => {
  const asc = fakeAsc({
    inGroup: [{ id: "b1", attributes: { version: "2320" } }],
    externalState: "WAITING_FOR_BETA_REVIEW",
  });
  const result = promoteExternalBeta({ asc, appId: "6798076688", log: noop, warn: noop });

  assert.equal(result.alreadyPresent, true);
  assert.equal(result.submitted, false);
  assert.equal(result.externalState, "WAITING_FOR_BETA_REVIEW");
  assert.equal(result.warnings, 0);
  assert.equal(asc.calls.some((c) => c.path === "/v1/betaAppReviewSubmissions"), false);
});

test("refuses to promote a build that is still processing", () => {
  const asc = fakeAsc({
    build: { id: "b1", attributes: { version: "2320", processingState: "PROCESSING" } },
  });
  const result = promoteExternalBeta({ asc, appId: "6798076688", log: noop, warn: noop });

  assert.equal(result.added, false);
  assert.equal(result.warnings, 1);
  assert.equal(asc.calls.some((c) => c.method === "POST"), false);
});

test("promotes the newest VALID build when the newest upload is still processing", () => {
  // The shape right after a ship: the build just uploaded is PROCESSING and the
  // previous one is VALID.  Without filter[processingState]=VALID the script
  // sees only the PROCESSING build and never refreshes the public group.
  const asc = fakeAsc({
    builds: [
      { id: "b2", attributes: { version: "2321", processingState: "PROCESSING" } },
      { id: "b1", attributes: { version: "2320", processingState: "VALID" } },
    ],
  });
  const result = promoteExternalBeta({ asc, appId: "6798076688", log: noop, warn: noop });

  assert.equal(result.added, true);
  assert.equal(result.buildId, "b1");
  assert.equal(result.buildVersion, "2320");

  const list = asc.calls.find((c) => c.path.startsWith("/v1/builds?"));
  assert.match(list.path, /filter\[processingState\]=VALID/);
});

test("links a build that shares a marketing version with an in-group build", () => {
  // `version` is the marketing version, which two build numbers can share.
  // Matching on it made this look already-present and skipped the POST.
  const asc = fakeAsc({
    build: { id: "b2", attributes: { version: "1.0.0", processingState: "VALID" } },
    inGroup: [{ id: "b1", attributes: { version: "1.0.0" } }],
  });
  const result = promoteExternalBeta({ asc, appId: "6798076688", log: noop, warn: noop });

  assert.equal(result.alreadyPresent, false);
  assert.equal(result.added, true);

  const link = asc.calls.find((c) => c.method === "POST" && c.path.includes("/relationships/builds"));
  assert.ok(link, "a distinct build id must be linked even with the same version");
  assert.deepEqual(JSON.parse(link.body).data, [{ type: "builds", id: "b2" }]);
});

test("warns and does nothing when the app has no external beta group", () => {
  const asc = fakeAsc({
    groups: [{ id: "int1", attributes: { name: "App Testers", isInternalGroup: true } }],
  });
  const result = promoteExternalBeta({ asc, appId: "6798076688", log: noop, warn: noop });

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
  const result = promoteExternalBeta({ asc, appId: "6798076688", log: noop, warn: noop });

  assert.equal(result.added, false);
  assert.equal(result.warnings, 1);
  assert.equal(result.submitted, false);
  assert.equal(asc.calls.some((c) => c.path === "/v1/betaAppReviewSubmissions"), false);
});

test("a build Apple refuses is reported, not silently dropped", () => {
  const asc = fakeAsc({ externalState: "BETA_REJECTED" });
  const result = promoteExternalBeta({ asc, appId: "6798076688", log: noop, warn: noop });

  assert.equal(result.added, true);
  assert.equal(result.submitted, false);
  assert.equal(result.warnings, 1);
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
