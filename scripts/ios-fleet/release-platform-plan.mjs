/**
 * release-platform-plan.mjs - the cross-platform half of the fleet release protocol.
 *
 * version-plan.mjs answers "what number does THIS ship get?". This module
 * answers the question that comes first when an app has more than one native
 * platform (macOS and iOS): "which platforms ship at all, and do they agree
 * on the number?"
 *
 * The owner rules it encodes (AGENT-SYNC.md, "Version Numbers", 2026-10-18):
 *
 *   1. NATIVE-PATH GATING. A platform ships only when its own native files
 *      changed. A commit that touches the server, or only the other platform,
 *      does not release this platform.
 *   2. PAIRED RELEASE. When several platforms ship together they are one
 *      release, so they share one number N.
 *   3. PLATFORM-ONLY UPDATE. A platform that does not ship keeps the release
 *      it already has. It is not bumped to match its neighbour.
 *   4. DELAYED COMPANION BUILD. When the other platform ships later it is a
 *      later release: it gets the later N, which is larger than the N its
 *      partner shipped with. The partner's release is untouched.
 *
 * Published versions are floors and guards, never allocators. A platform whose
 * published release is already at or above N fails closed instead of minting a
 * replacement number.
 *
 * This module is PURE: no I/O, no network, no environment. The CLI at the
 * bottom is a thin reader on top of it; every rule lives in the functions.
 */

import { integerBuild, parsePatch, planVersion } from "./version-plan.mjs";

/** The App Store Connect platform key for the iOS app. */
export const IOS_PLATFORM = "IOS";

/** The App Store Connect platform key for the macOS app. */
export const MAC_PLATFORM = "MAC_OS";

/**
 * Normalise a native path prefix to a directory prefix.
 *
 * "clients/ios"  -> "clients/ios/"
 * "clients/ios/" -> "clients/ios/"
 *
 * The trailing slash matters: without it "clients/ios" would also match
 * "clients/iosx/Thing.swift", which is a different platform's tree.
 */
function normalisePrefix(prefix) {
  const text = String(prefix == null ? "" : prefix).trim();
  if (!text) return "";
  return text.endsWith("/") ? text : `${text}/`;
}

/**
 * True when a changed path lives inside one of the platform's native trees.
 *
 * nativePathsChanged(["clients/ios/"], ["clients/ios/App.swift"]) -> true
 * nativePathsChanged(["clients/ios/"], ["clients/iosx/App.swift"]) -> false
 * nativePathsChanged(["clients/ios/"], ["server/api.ts"]) -> false
 *
 * A platform with no native prefix never ships on a path change: an app that
 * has not declared its native tree is not released by guessing.
 */
export function nativePathsChanged(nativePrefixes, changedPaths) {
  const prefixes = (nativePrefixes || [])
    .map(normalisePrefix)
    .filter(Boolean);
  if (!prefixes.length) return false;
  for (const raw of changedPaths || []) {
    const path = String(raw == null ? "" : raw).trim();
    if (!path) continue;
    for (const prefix of prefixes) {
      if (path.startsWith(prefix)) return true;
    }
  }
  return false;
}

/**
 * The published release of one platform.
 *
 * published: { marketing: "1.0.118", build: "118" }
 *
 * A platform that has never shipped has no published release: pass null, and
 * it ships at N with no floor to validate against.
 */
function publishedFloors(published, prefix) {
  if (published === null || published === undefined) {
    return { ascPatch: 0, floor: 0, marketing: "", build: "" };
  }
  const marketing = String(published.marketing == null ? "" : published.marketing).trim();
  const build = String(published.build == null ? "" : published.build).trim();
  // A record that claims a published release but is missing a field is an
  // inconsistent published state, not "no published release": fail closed
  // instead of pretending the floor is 0.
  if (!marketing || !build) {
    throw new Error(`published release record is incomplete: marketing=${JSON.stringify(marketing)} build=${JSON.stringify(build)}`);
  }
  const ascPatch = parsePatch(marketing, prefix);
  const floor = integerBuild(build);
  if (ascPatch === null) {
    throw new Error(`published marketing version ${marketing} is not on the ${prefix}.N train`);
  }
  if (floor === null) {
    throw new Error(`published build ${build} is unknown or invalid`);
  }
  return { ascPatch, floor, marketing, build };
}

/**
 * The release plan for every native platform of one app.
 *
 * platforms: one entry per platform.
 *   {
 *     key:             "ct-ios",
 *     platform:        "IOS" | "MAC_OS",
 *     nativePrefixes:  ["clients/ios/"],
 *     published:       { marketing: "1.0.118", build: "118" } | null
 *   }
 * changedPaths: the repo-relative paths that changed in this release.
 * commitCount: the full repository commit count N.
 *
 * Returns:
 *   {
 *     commitCount: N,
 *     marketing: "1.0.N",
 *     build: "N",
 *     shipping: [{ key, platform, marketing, build, commitCount }],
 *     holding:  [{ key, platform, marketing, build, reason }]
 *   }
 *
 * Every shipping platform carries the SAME marketing version and the SAME
 * build number, because they are one release. Every holding platform carries
 * the release it already had, unchanged.
 */
export function planRelease({ platforms = [], changedPaths = [], commitCount, prefix = "1.0" } = {}) {
  const train = String(prefix || "1.0");
  const commits = Number(commitCount);
  if (!Number.isSafeInteger(commits) || commits < 1) {
    throw new Error("full repository commit count is unavailable");
  }

  const shipping = [];
  const holding = [];

  for (const entry of platforms || []) {
    if (!entry || !entry.key) throw new Error("every platform needs a key");
    const key = String(entry.key);
    const platform = String(entry.platform || "");
    const prefixes = (entry.nativePrefixes || []).map(normalisePrefix).filter(Boolean);
    const floors = publishedFloors(entry.published, train);

    if (!nativePathsChanged(prefixes, changedPaths)) {
      holding.push({
        key,
        platform,
        marketing: floors.marketing,
        build: floors.build,
        reason: prefixes.length
          ? `no native files changed under ${prefixes.join(", ")}`
          : "no native path prefix is declared for this platform"
      });
      continue;
    }

    // planVersion applies the published floors and the regression guards, so
    // a platform whose published release is already at or above N fails here
    // instead of minting a replacement number.
    const pair = planVersion({
      prefix: train,
      commitCount: commits,
      ascPatch: floors.ascPatch,
      floor: floors.floor,
      projectMarketing: floors.marketing
    });
    shipping.push({
      key,
      platform,
      marketing: pair.marketing,
      build: pair.build,
      commitCount: commits
    });
  }

  return {
    commitCount: commits,
    marketing: `${train}.${commits}`,
    build: String(commits),
    shipping,
    holding
  };
}

/**
 * True when a plan is internally consistent: every shipping platform carries
 * the same number, and that number is the release number of the plan.
 *
 * The plan builder already guarantees this, so this is the assertion a
 * caller makes about a plan that crossed a process boundary (a CI job reading
 * a plan file, for example) rather than about its own output.
 */
export function planIsConsistent(plan) {
  if (!plan || !Array.isArray(plan.shipping)) return false;
  const numbers = new Set(plan.shipping.map((entry) => `${entry.marketing}/${entry.build}`));
  if (numbers.size > 1) return false;
  for (const entry of plan.shipping) {
    if (entry.marketing !== plan.marketing || entry.build !== plan.build) return false;
  }
  return true;
}

/**
 * The shared read-only entry point.
 *
 * Reads a registry of platforms, a list of changed paths and a repository, and
 * prints the release plan. Used by the fleet's CI and by the offline
 * integration test; it never writes and never contacts App Store Connect.
 *
 * Usage:
 *   node release-platform-plan.mjs --plan <file.json>
 *
 * The file is JSON:
 *   {
 *     "commitCount": 130,
 *     "changedPaths": ["clients/ios/App.swift"],
 *     "platforms": [
 *       { "key": "ct-ios", "platform": "IOS", "nativePrefixes": ["clients/ios/"],
 *         "published": { "marketing": "1.0.118", "build": "118" } }
 *     ]
 *   }
 */
export function planFromDocument(document) {
  const doc = document || {};
  return planRelease({
    platforms: doc.platforms || [],
    changedPaths: doc.changedPaths || [],
    commitCount: doc.commitCount,
    prefix: doc.prefix || "1.0"
  });
}

async function main() {
  const args = process.argv.slice(2);
  const fileIndex = args.indexOf("--plan");
  if (fileIndex === -1 || !args[fileIndex + 1]) {
    console.error("usage: release-platform-plan.mjs --plan <file.json>");
    process.exitCode = 2;
    return;
  }
  const { readFile } = await import("node:fs/promises");
  let document;
  try {
    document = JSON.parse(await readFile(args[fileIndex + 1], "utf8"));
  } catch (error) {
    console.error(`release-platform-plan: cannot read the plan document: ${error.message}`);
    process.exitCode = 2;
    return;
  }
  try {
    const plan = planFromDocument(document);
    console.log(JSON.stringify(plan, null, 2));
  } catch (error) {
    console.error(`release-platform-plan: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && process.argv[1].endsWith("release-platform-plan.mjs")) {
  main();
}
