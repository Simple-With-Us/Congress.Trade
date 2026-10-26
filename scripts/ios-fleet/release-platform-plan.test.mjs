/** Pure offline tests for the cross-platform half of the AFC-356 protocol. */
import assert from "node:assert/strict";
import test from "node:test";

import {
  nativePathsChanged,
  planFromDocument,
  planIsConsistent,
  planRelease
} from "./release-platform-plan.mjs";

const IOS = {
  key: "ct-ios",
  platform: "IOS",
  nativePrefixes: ["clients/ios/"],
  published: { marketing: "1.0.118", build: "118" }
};

const MAC = {
  key: "ct-mac",
  platform: "MAC_OS",
  nativePrefixes: ["clients/macos/"],
  published: { marketing: "1.0.120", build: "120" }
};

test("native-path gating matches only the platform's own tree", () => {
  assert.equal(nativePathsChanged(["clients/ios/"], ["clients/ios/App.swift"]), true);
  assert.equal(nativePathsChanged(["clients/ios/"], ["clients/iosx/App.swift"]), false);
  assert.equal(nativePathsChanged(["clients/ios/"], ["server/api.ts"]), false);
  assert.equal(nativePathsChanged(["clients/ios/"], ["docs/readme.md"]), false);
});

test("a prefix without a trailing slash still matches only its own directory", () => {
  assert.equal(nativePathsChanged(["clients/ios"], ["clients/ios/App.swift"]), true);
  assert.equal(nativePathsChanged(["clients/ios"], ["clients/iosx/App.swift"]), false);
});

test("a platform with no declared native tree never ships on a path change", () => {
  assert.equal(nativePathsChanged([], ["clients/ios/App.swift"]), false);
  assert.equal(nativePathsChanged([null, "  "], ["clients/ios/App.swift"]), false);
});

test("a half-empty published record fails closed instead of pretending there is no floor", () => {
  const halfEmpty = (published) => () => planRelease({
    platforms: [{ ...IOS, published }],
    changedPaths: ["clients/ios/App.swift"],
    commitCount: 130
  });
  assert.throws(halfEmpty({ marketing: "1.0.118" }), /incomplete/);
  assert.throws(halfEmpty({ build: "118" }), /incomplete/);
  assert.throws(halfEmpty({ marketing: "", build: "" }), /incomplete/);
  // A platform that has never shipped still has no published release, and
  // that is not an error.
  const neverShipped = planRelease({
    platforms: [{ ...IOS, published: null }],
    changedPaths: ["clients/ios/App.swift"],
    commitCount: 130
  });
  assert.equal(neverShipped.shipping.length, 1);
});

test("a native change releases only the platform whose tree changed", () => {
  const iosOnly = planRelease({
    platforms: [IOS, MAC],
    changedPaths: ["clients/ios/App.swift", "server/api.ts"],
    commitCount: 130
  });
  assert.deepEqual(iosOnly.shipping.map((entry) => entry.key), ["ct-ios"]);
  assert.deepEqual(iosOnly.holding.map((entry) => entry.key), ["ct-mac"]);

  const macOnly = planRelease({
    platforms: [IOS, MAC],
    changedPaths: ["clients/macos/App.swift"],
    commitCount: 130
  });
  assert.deepEqual(macOnly.shipping.map((entry) => entry.key), ["ct-mac"]);
  assert.deepEqual(macOnly.holding.map((entry) => entry.key), ["ct-ios"]);

  const neither = planRelease({
    platforms: [IOS, MAC],
    changedPaths: ["server/api.ts", "docs/readme.md"],
    commitCount: 130
  });
  assert.deepEqual(neither.shipping, []);
  assert.deepEqual(neither.holding.map((entry) => entry.key), ["ct-ios", "ct-mac"]);
});

test("a paired release gives every platform the same number", () => {
  const plan = planRelease({
    platforms: [IOS, MAC],
    changedPaths: ["clients/ios/App.swift", "clients/macos/App.swift"],
    commitCount: 130
  });
  assert.equal(plan.shipping.length, 2);
  assert.deepEqual(
    plan.shipping.map((entry) => [entry.marketing, entry.build]),
    [["1.0.130", "130"], ["1.0.130", "130"]]
  );
  assert.equal(plan.marketing, "1.0.130");
  assert.equal(plan.build, "130");
  assert.equal(planIsConsistent(plan), true);
});

test("a platform that does not ship keeps the release it already had", () => {
  const plan = planRelease({
    platforms: [IOS, MAC],
    changedPaths: ["clients/ios/App.swift"],
    commitCount: 130
  });
  assert.equal(plan.holding.length, 1);
  assert.equal(plan.holding[0].key, "ct-mac");
  assert.equal(plan.holding[0].marketing, "1.0.120");
  assert.equal(plan.holding[0].build, "120");
  assert.match(plan.holding[0].reason, /no native files changed under clients\/macos\//);
});

test("a delayed companion build is a later release with a later number", () => {
  // Release 1: only iOS changed, so only iOS ships.
  const first = planRelease({
    platforms: [IOS, MAC],
    changedPaths: ["clients/ios/App.swift"],
    commitCount: 130
  });
  assert.deepEqual(first.shipping.map((entry) => entry.key), ["ct-ios"]);
  assert.equal(first.shipping[0].marketing, "1.0.130");

  // Release 2: only macOS changed, later commit count. The macOS build is
  // the companion, and it is a later release with a later number. The iOS
  // release from release 1 is untouched.
  const second = planRelease({
    platforms: [
      { ...IOS, published: { marketing: first.shipping[0].marketing, build: first.shipping[0].build } },
      MAC
    ],
    changedPaths: ["clients/macos/App.swift"],
    commitCount: 140
  });
  assert.deepEqual(second.shipping.map((entry) => entry.key), ["ct-mac"]);
  assert.equal(second.shipping[0].marketing, "1.0.140");
  assert.equal(second.shipping[0].build, "140");
  assert.ok(
    Number(second.shipping[0].build) > Number(first.shipping[0].build),
    "the companion build number must be larger than the one its partner shipped with"
  );
  assert.equal(second.holding[0].key, "ct-ios");
  assert.equal(second.holding[0].marketing, "1.0.130");
  assert.equal(second.holding[0].build, "130");
});

test("a platform that has never shipped releases at N with no floor", () => {
  const fresh = { key: "ct-new", platform: "IOS", nativePrefixes: ["clients/ios/"], published: null };
  const plan = planRelease({
    platforms: [fresh],
    changedPaths: ["clients/ios/App.swift"],
    commitCount: 130
  });
  assert.equal(plan.shipping.length, 1);
  assert.equal(plan.shipping[0].marketing, "1.0.130");
  assert.equal(plan.shipping[0].build, "130");
});

test("a published release at or above N fails closed instead of minting a replacement", () => {
  assert.throws(() => planRelease({
    platforms: [{ ...IOS, published: { marketing: "1.0.130", build: "118" } }],
    changedPaths: ["clients/ios/App.swift"],
    commitCount: 130
  }), /conflicts with repository commit count/);

  assert.throws(() => planRelease({
    platforms: [{ ...IOS, published: { marketing: "1.0.118", build: "130" } }],
    changedPaths: ["clients/ios/App.swift"],
    commitCount: 130
  }), /conflicts with repository commit count/);
});

test("an unknown or malformed published release fails closed", () => {
  assert.throws(() => planRelease({
    platforms: [{ ...IOS, published: { marketing: "2.0.118", build: "118" } }],
    changedPaths: ["clients/ios/App.swift"],
    commitCount: 130
  }), /not on the 1\.0\.N train/);

  assert.throws(() => planRelease({
    platforms: [{ ...IOS, published: { marketing: "1.0.118", build: "not-a-build" } }],
    changedPaths: ["clients/ios/App.swift"],
    commitCount: 130
  }), /unknown or invalid/);
});

test("a missing or invalid commit count cannot produce a release number", () => {
  assert.throws(() => planRelease({
    platforms: [IOS],
    changedPaths: ["clients/ios/App.swift"],
    commitCount: 0
  }), /commit count is unavailable/);
  assert.throws(() => planRelease({
    platforms: [IOS],
    changedPaths: ["clients/ios/App.swift"],
    commitCount: Number.NaN
  }), /commit count is unavailable/);
});

test("the plan document reader produces the same plan as the builder", () => {
  const plan = planFromDocument({
    commitCount: 130,
    changedPaths: ["clients/macos/App.swift"],
    platforms: [IOS, MAC]
  });
  assert.deepEqual(plan.shipping.map((entry) => entry.key), ["ct-mac"]);
  assert.equal(plan.holding[0].marketing, "1.0.118");
});
