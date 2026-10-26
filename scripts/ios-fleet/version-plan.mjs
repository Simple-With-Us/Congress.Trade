/**
 * version-plan.mjs - the pure rules behind the fleet's version numbering.
 *
 * Restored owner protocol (AFC-356): MARKETING_VERSION is 1.0.<full repo
 * commit count> and CURRENT_PROJECT_VERSION is that same integer. A platform
 * only ships when its own native files changed.
 *
 * The rules, in one place:
 *
 *   MARKETING_VERSION = 1.0.N
 *   CURRENT_PROJECT_VERSION = N
 *
 * N is the full repository commit count. Published floors validate N; they
 * never allocate a replacement. Shallow/missing history, unknown floors, and
 * conflicting published numbers fail closed. Explicit overrides are accepted
 * only when they equal the canonical pair.
 *
 * This module is PURE:  no I/O, no network, no environment.  The bash ship
 * script implements the same rules; this module is the readable reference
 * and the unit-testable copy of them.
 */

/** Escape a string for literal use inside a RegExp. */
function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The patch number of a version on a train.
 *
 * parsePatch("1.0.236", "1.0") -> 236
 * parsePatch("1.0", "1.0")     -> null   (no patch component)
 * parsePatch("1.01.5", "1.0")  -> null   (not "<prefix>.<digits>")
 * parsePatch("2.0.5", "1.0")   -> null   (a different train)
 *
 * The prefix is escaped, so a prefix of "1.0" can never match "120.5".
 */
export function parsePatch(version, prefix) {
  if (version === null || version === undefined) return null;
  if (prefix === null || prefix === undefined) return null;
  const value = String(version).trim();
  const train = String(prefix).trim();
  if (!value || !train) return null;
  const re = new RegExp(`^${escapeRegExp(train)}\\.(\\d+)$`);
  const match = re.exec(value);
  if (!match) return null;
  const patch = parseInt(match[1], 10);
  return Number.isFinite(patch) ? patch : null;
}

/**
 * The patch of a version on ITS OWN train ("2.0.5" -> 5), used for the
 * "never 1.0.N (N)" rule when an operator pins a version explicitly.
 */
export function ownPatch(version) {
  if (version === null || version === undefined) return null;
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version).trim());
  if (!match) return null;
  const patch = parseInt(match[3], 10);
  return Number.isFinite(patch) ? patch : null;
}

/**
 * True when a TestFlight train is a "drift train":  a <prefix>.N train that
 * holds a build whose CFBundleVersion is exactly the string "N".
 *
 * Those trains came from the retired 1.0.<commit_count> scheme (1.0.2358
 * holding build 2358) and must not push the next marketing patch forward.
 * App Store versions are never drift -- only trains can be.
 */
export function isDriftTrain(trainVersion, buildVersions, prefix) {
  const patch = parsePatch(trainVersion, prefix);
  if (patch === null) return false;
  const target = String(patch);
  for (const build of buildVersions || []) {
    if (build === null || build === undefined) continue;
    if (String(build) === target) return true;
  }
  return false;
}

/**
 * The highest patch already used on a train.
 *
 * appStoreVersions: ["1.0.235"]  -- the App Store versions, never ignored.
 * trains: [{ version: "1.0.236", builds: ["202610180036"] }]  -- the
 * TestFlight trains; a drift train is ignored.
 *
 * Returns 0 when the train has nothing on it yet.
 */
export function latestMarketingPatch({ prefix, appStoreVersions = [], trains = [] } = {}) {
  let best = 0;
  const consider = (patch) => {
    if (patch !== null && patch !== undefined && Number.isFinite(patch) && patch > best) {
      best = patch;
    }
  };

  for (const version of appStoreVersions || []) {
    const value = typeof version === "string" ? version : version?.versionString;
    consider(parsePatch(value, prefix));
  }

  for (const train of trains || []) {
    if (!train) continue;
    const version = typeof train === "string" ? train : train.version;
    const builds = typeof train === "string" ? [] : train.builds || [];
    if (isDriftTrain(version, builds, prefix)) continue;
    consider(parsePatch(version, prefix));
  }

  return best;
}

/** Highest actually published marketing patch; drift-shaped uploads are still floors. */
export function highestPublishedMarketingPatch({ prefix, appStoreVersions = [], trains = [] } = {}) {
  let best = 0;
  const consider = (version) => {
    const patch = parsePatch(version, prefix);
    if (patch !== null && patch > best) best = patch;
  };
  for (const version of appStoreVersions || []) {
    consider(typeof version === "string" ? version : version?.versionString);
  }
  for (const train of trains || []) {
    consider(typeof train === "string" ? train : train?.version);
  }
  return best;
}

/**
 * The next free patch on a train:  one past latestMarketingPatch, skipping
 * every patch a TestFlight train already holds.  Drift trains are ignored for
 * the maximum, but their numbers are still taken:  shipping into a drift train
 * (say 1.0.312 holding build "312") would add a build to it, the train would
 * stay a drift train, and every later ship would compute the same patch and
 * freeze there.  Skipping taken numbers keeps the sequence moving.
 */
export function nextMarketingPatch({ prefix, appStoreVersions = [], trains = [] } = {}) {
  const taken = new Set();
  for (const train of trains || []) {
    if (!train) continue;
    const version = typeof train === "string" ? train : train.version;
    const patch = parsePatch(version, prefix);
    if (patch !== null) taken.add(patch);
  }
  for (const version of appStoreVersions || []) {
    const value = typeof version === "string" ? version : version?.versionString;
    const patch = parsePatch(value, prefix);
    if (patch !== null) taken.add(patch);
  }
  let next = latestMarketingPatch({ prefix, appStoreVersions, trains }) + 1;
  while (taken.has(next)) next += 1;
  return next;
}

/** A plain integer build number, or null when the value is not one. */
export function integerBuild(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) return null;
  const parsed = parseInt(text, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** The macOS platform key used by the App Store Connect API. */
export const MAC_PLATFORM = "MAC_OS";

/**
 * The build number the next ship has to exceed.
 *
 * trainBuilds: every build already in the target marketing train.  All of
 *   them count, any size:  Apple requires build numbers to increase inside
 *   one version train, so an old 12-digit UTC stamp (202610180036) still
 *   holds the floor up.
 * appBuilds: the app's builds on that platform.  Only the plain integers
 *   below 1000000000 count on iOS, so the retired UTC stamps do not push the
 *   commit count out of the way forever.  On macOS EVERY build counts,
 *   because macOS build numbers must increase across all trains.
 *
 * Non-numeric or dotted build values (e.g. "1.0.5") are ignored.
 */
export function buildFloor({ trainBuilds = [], appBuilds = [], platform = "" } = {}) {
  const isMac = String(platform || "").toUpperCase() === MAC_PLATFORM;
  let floor = 0;

  for (const build of trainBuilds || []) {
    const parsed = integerBuild(build);
    // A published value outside the repository's control is skipped, never
    // fatal: one malformed record must not abort every release.
    if (parsed === null) continue;
    if (parsed > floor) floor = parsed;
  }

  for (const build of appBuilds || []) {
    const parsed = integerBuild(build);
    if (parsed === null) continue;
    if (isMac) {
      if (parsed > floor) floor = parsed;
    } else if (parsed < 1000000000 && parsed > floor) {
      floor = parsed;
    }
  }

  return floor;
}

/**
 * The marketing version and the build number for one ship.
 *
 *   prefix          the only supported train, "1.0"
 *   commitCount     the full repository commit count
 *   ascPatch        the highest published patch, used only to detect regression
 *   floor           the published build floor for the canonical marketing version
 *   forcedVersion   accepted only when exactly equal to 1.0.<commitCount>
 *   forcedBuild     accepted only when exactly equal to <commitCount>
 *
 * Returns { marketing, build } as strings.
 */
export function planVersion({
  prefix = "1.0",
  ascPatch,
  forcedVersion = "",
  forcedBuild = "",
  commitCount,
  floor,
  historyIsShallow = false,
  projectMarketing = ""
} = {}) {
  const train = String(prefix || "1.0");
  const commits = Number(commitCount);
  if (train !== "1.0") throw new Error(`fleet releases must use the 1.0.N marketing train (received ${train})`);
  if (historyIsShallow) throw new Error("full repository history is required to select the release number");
  if (!Number.isSafeInteger(commits) || commits < 1) throw new Error("full repository commit count is unavailable");
  const publishedPatch = integerBuild(ascPatch);
  if (publishedPatch === null) throw new Error("published marketing version is unknown or invalid");
  if (publishedPatch >= commits) {
    throw new Error(`published marketing patch ${publishedPatch} conflicts with repository commit count ${commits}; refusing a marketing regression`);
  }
  const knownFloor = integerBuild(floor);
  if (knownFloor === null) throw new Error("published build floor is unknown or invalid");
  if (knownFloor >= commits) {
    throw new Error(`published build floor ${knownFloor} conflicts with repository commit count ${commits}; refusing to mint a replacement number`);
  }
  const marketing = `${train}.${commits}`;
  const build = String(commits);
  if (forcedVersion && String(forcedVersion) !== marketing) {
    throw new Error(`--version ${forcedVersion} conflicts with canonical marketing version ${marketing}`);
  }
  if (forcedBuild !== "" && forcedBuild !== null && forcedBuild !== undefined && String(forcedBuild) !== build) {
    throw new Error(`--build ${forcedBuild} conflicts with canonical build number ${build}`);
  }
  const recordedPatch = parsePatch(projectMarketing, train);
  if (projectMarketing && recordedPatch === null) {
    throw new Error(`project marketing version ${projectMarketing} is not on the ${train}.N train`);
  }
  if (recordedPatch !== null && recordedPatch >= commits) {
    throw new Error(`project marketing version ${projectMarketing} conflicts with canonical version ${marketing}`);
  }
  return { marketing, build };
}
