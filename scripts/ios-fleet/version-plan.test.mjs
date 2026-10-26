/** Pure offline tests for the AFC-356 shared 1.0.N/N release protocol. */
import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFloor,
  highestPublishedMarketingPatch,
  isDriftTrain,
  latestMarketingPatch,
  nextMarketingPatch,
  parsePatch,
  planVersion
} from "./version-plan.mjs";

test("parsePatch accepts only a patch on the requested train", () => {
  assert.equal(parsePatch("1.0.236", "1.0"), 236);
  assert.equal(parsePatch("1.01.5", "1.0"), null);
  assert.equal(parsePatch("2.0.5", "1.0"), null);
  assert.equal(parsePatch("1.0.236.1", "1.0"), null);
});

test("the App Store planner can inspect old trains without using them to allocate TestFlight releases", () => {
  assert.equal(isDriftTrain("1.0.2358", ["2358"], "1.0"), true);
  assert.equal(latestMarketingPatch({
    prefix: "1.0",
    appStoreVersions: ["1.0.235"],
    trains: [
      { version: "1.0.236", builds: ["202610180036"] },
      { version: "1.0.2358", builds: ["2358"] }
    ]
  }), 236);
  assert.equal(nextMarketingPatch({
    prefix: "1.0",
    appStoreVersions: ["1.0.235"],
    trains: [{ version: "1.0.236", builds: ["202610180036"] }]
  }), 237);
});

test("the ship validator treats drift-shaped uploads as published marketing floors", () => {
  assert.equal(highestPublishedMarketingPatch({
    prefix: "1.0",
    appStoreVersions: ["1.0.235"],
    trains: [
      { version: "1.0.236", builds: ["202610180036"] },
      { version: "1.0.2358", builds: ["2358"] }
    ]
  }), 2358);
});

test("known published floors below N validate but never alter the paired number", () => {
  assert.equal(buildFloor({ trainBuilds: ["225"], appBuilds: ["224"], platform: "IOS" }), 225);
  assert.deepEqual(planVersion({
    commitCount: 237,
    ascPatch: 236,
    floor: 225,
    projectMarketing: "1.0.225"
  }), { marketing: "1.0.237", build: "237" });
});

test("both explicit overrides are validation-only and accept the canonical pair", () => {
  assert.deepEqual(planVersion({
    commitCount: 2380,
    ascPatch: 2379,
    floor: 2378,
    forcedVersion: "1.0.2380",
    forcedBuild: "2380"
  }), { marketing: "1.0.2380", build: "2380" });
});

test("a sample or stale --build override cannot allocate a different number", () => {
  assert.throws(() => planVersion({
    commitCount: 237,
    ascPatch: 236,
    floor: 225,
    forcedBuild: "148"
  }), /conflicts with canonical build number 237/);
});

test("a --version override cannot regress or change the 1.0.N train", () => {
  assert.throws(() => planVersion({
    commitCount: 237,
    ascPatch: 236,
    floor: 225,
    forcedVersion: "1.0.236"
  }), /conflicts with canonical marketing version 1.0.237/);
  assert.throws(() => planVersion({
    commitCount: 237,
    ascPatch: 236,
    floor: 225,
    forcedVersion: "2.0.237"
  }), /conflicts with canonical marketing version 1.0.237/);
});

test("unknown, malformed, or conflicting published floors fail closed", () => {
  assert.throws(() => buildFloor({ trainBuilds: ["not-a-build"] }), /unknown build/);
  assert.throws(() => planVersion({ commitCount: 237, ascPatch: 236, floor: Number.NaN }), /unknown or invalid/);
  for (const unknown of [null, undefined, "", "   "]) {
    assert.throws(() => planVersion({ commitCount: 237, ascPatch: 236, floor: unknown }), /unknown or invalid/);
    assert.throws(() => planVersion({ commitCount: 237, ascPatch: unknown, floor: 225 }), /unknown or invalid/);
  }
  assert.throws(() => planVersion({ commitCount: 237, ascPatch: 236, floor: 237 }), /conflicts with repository commit count/);
  assert.throws(() => planVersion({ commitCount: 237, ascPatch: 237, floor: 225 }), /marketing patch 237 conflicts/);
});

test("shallow or missing history cannot mint a lower or fallback number", () => {
  assert.throws(() => planVersion({ commitCount: 40, ascPatch: 20, floor: 30, historyIsShallow: true }), /full repository history/);
  assert.throws(() => planVersion({ commitCount: 0, ascPatch: 0, floor: 0 }), /commit count is unavailable/);
  assert.throws(() => planVersion({ commitCount: Number.NaN, ascPatch: 0, floor: 0 }), /commit count is unavailable/);
});

test("a project marketing record at or ahead of N is a regression/conflict", () => {
  assert.throws(() => planVersion({
    commitCount: 237,
    ascPatch: 236,
    floor: 225,
    projectMarketing: "1.0.237"
  }), /project marketing version 1.0.237 conflicts/);
  assert.throws(() => planVersion({
    commitCount: 237,
    ascPatch: 236,
    floor: 225,
    projectMarketing: "2.0.200"
  }), /not on the 1.0.N train/);
});

test("the original protocol returns plain 1.0.N and N values", () => {
  const pair = planVersion({ commitCount: 148, ascPatch: 147, floor: 146 });
  assert.deepEqual(pair, { marketing: "1.0.148", build: "148" });
  assert.equal(pair.marketing, "1.0.148");
});
