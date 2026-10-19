#!/usr/bin/env node
/**
 * Promote the newest TestFlight build into the app's EXTERNAL beta group.
 *
 * WHY THIS EXISTS (CT-2434, 2026-10-19):  the Congress.Trade Public Beta group
 * (external, public link, three testers) served build 202608311519, uploaded
 * 2026-08-31, while every other fleet app's external group tracked the current
 * build.  Nothing refreshed it:  external beta promotion was only wired into
 * BotFleet and Clutch (asc-api.mjs ensure-standing-testers), and this repo's
 * ios-ship.yml had no such step.  That one build expired 2026-11-29, after
 * which the public link served nothing at all.
 *
 * WHAT IT DOES, in order:
 *   1. find the app's external beta group,
 *   2. add the newest processed build to it (idempotent),
 *   3. submit that build for Beta App Review when Apple wants a submission.
 *
 * Auth:  every App Store Connect call goes through the vendored
 * scripts/ios-fleet/asc-api.mjs, which owns credential handling.  This file
 * never reads, holds or prints a credential, and it never mutates the vendored
 * pin (scripts/ios-fleet/check-drift.sh compares that pin by sha256).
 *
 * Usage:
 *   node scripts/promote-external-beta.mjs [--apple-id <id>] [--group <name>]
 *
 * Exit codes:  0 done or nothing to do  |  3 partial (warnings printed).
 * The ship workflow treats a non-zero exit as a warning and never lets it fail
 * the TestFlight ship.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const APPS_JSON = join(ROOT, "scripts", "ios-fleet", "apps.json");
const DEFAULT_APP_KEY = "congress";

// Build states that mean Apple will not accept this build for external testing.
// Anything not listed is passed through to the caller to decide on.
const BLOCKED_EXTERNAL_STATES = [
  "BETA_REJECTED",
  "MISSING_EXPORT_COMPLIANCE",
  "PROCESSING_EXCEPTION",
  "EXPIRED",
  "REMOVED",
];

/** Pull a short, human-readable reason out of an App Store Connect error body. */
export function ascErrorText(res) {
  const errors = res?.parsed?.errors;
  if (Array.isArray(errors) && errors.length) {
    return errors
      .map((e) => `${e.code || e.status || "ERROR"}: ${e.detail || e.title || "request failed"}`)
      .join(" | ");
  }
  const text = (res?.text || "").trim();
  if (text) return text.slice(0, 300);
  return `HTTP ${res?.status ?? "?"}`;
}

/**
 * Pick the external group to promote into.  A named group wins outright;  with
 * several external groups the one carrying the public link wins, because that
 * is the surface a tester actually reaches.
 */
export function chooseExternalGroup(groups, groupName = null) {
  const external = (groups || []).filter((g) => g?.attributes?.isInternalGroup === false);
  if (!external.length) return null;
  if (groupName) {
    const wanted = groupName.trim().toLowerCase();
    return external.find((g) => String(g.attributes?.name || "").toLowerCase() === wanted) || null;
  }
  const publicLink = external.find((g) => g.attributes?.publicLinkEnabled === true);
  return publicLink || external[0];
}

/**
 * Do the promotion.  `asc` is injected so the test can drive it without a
 * network or a credential;  the real one shells out to the vendored client.
 *
 * Returns a summary object.  Never throws:  a failure is a warning, because
 * this runs inside a ship that already succeeded.
 */
export function promoteExternalBeta({
  asc,
  appId,
  groupName = null,
  log = () => {},
  warn = () => {},
}) {
  const out = {
    appId: appId || null,
    groupId: null,
    groupName: null,
    buildId: null,
    buildVersion: null,
    added: false,
    submitted: false,
    alreadyPresent: false,
    externalState: null,
    warnings: 0,
  };
  const note = (msg) => {
    out.warnings += 1;
    warn(msg);
  };

  if (!appId) {
    note("no App Store Connect app id; nothing promoted");
    return out;
  }

  // 1. The external group.
  const groupsRes = asc(
    "GET",
    `/v1/apps/${appId}/betaGroups?limit=200&fields[betaGroups]=name,isInternalGroup,publicLinkEnabled`
  );
  if (!groupsRes.ok) {
    note(`could not list beta groups: ${ascErrorText(groupsRes)}`);
    return out;
  }
  const group = chooseExternalGroup(groupsRes.parsed?.data, groupName);
  if (!group) {
    note(
      groupName
        ? `no external beta group named "${groupName}" for app ${appId}; create it in App Store Connect > TestFlight > External Testing`
        : `app ${appId} has no external beta group; create one in App Store Connect > TestFlight > External Testing`
    );
    return out;
  }
  out.groupId = group.id;
  out.groupName = group.attributes?.name || null;

  // 2. The newest build.  A build that is still processing cannot be
  //    distributed, and promoting it would put the group in a half state.
  //    Ask App Store Connect for VALID builds only:  right after a ship the
  //    newest upload is still PROCESSING, so without the filter this query
  //    returns that build, the guard below bails, and the public group never
  //    gets refreshed.  The guard stays as a safety net.
  const buildsRes = asc(
    "GET",
    `/v1/builds?filter[app]=${appId}&filter[processingState]=VALID&sort=-uploadedDate&limit=1&fields[builds]=version,processingState,uploadedDate`
  );
  if (!buildsRes.ok) {
    note(`could not list builds: ${ascErrorText(buildsRes)}`);
    return out;
  }
  const build = buildsRes.parsed?.data?.[0];
  if (!build) {
    note(`app ${appId} has no TestFlight build to promote`);
    return out;
  }
  const state = build.attributes?.processingState;
  if (state !== "VALID") {
    note(`newest build ${build.attributes?.version} is still ${state}; not promoted yet`);
    return out;
  }
  out.buildId = build.id;
  out.buildVersion = build.attributes?.version || null;

  // 3. Idempotence:  a build already in the group needs no second link.
  //    Match on the immutable build `id`, never on `version`:  that is the
  //    marketing version, which two distinct build numbers can share, and a
  //    false match here would skip the POST and leave the group stale.
  const inGroupRes = asc("GET", `/v1/betaGroups/${group.id}/builds?limit=200&fields[builds]=version`);
  const already = inGroupRes.ok
    ? (inGroupRes.parsed?.data || []).some((b) => b.id === out.buildId)
    : false;
  if (already) {
    out.alreadyPresent = true;
    log(`build ${out.buildVersion} is already in "${out.groupName}"`);
  } else {
    const linkRes = asc(
      "POST",
      `/v1/betaGroups/${group.id}/relationships/builds`,
      JSON.stringify({ data: [{ type: "builds", id: build.id }] })
    );
    if (!linkRes.ok) {
      note(`could not add build ${out.buildVersion} to "${out.groupName}": ${ascErrorText(linkRes)}`);
      return out;
    }
    out.added = true;
    log(`build ${out.buildVersion} added to "${out.groupName}"`);
  }

  // 4. Beta App Review.  External testers only get a build Apple approved, and
  //    Apple only wants one submission per build.
  const detailRes = asc(
    "GET",
    `/v1/builds/${build.id}/buildBetaDetail?fields[buildBetaDetails]=externalBuildState,internalBuildState`
  );
  if (!detailRes.ok) {
    note(`could not read the build's external state: ${ascErrorText(detailRes)}`);
    return out;
  }
  const externalState = detailRes.parsed?.data?.attributes?.externalBuildState || "unknown";
  out.externalState = externalState;
  if (externalState === "READY_FOR_BETA_SUBMISSION") {
    const subRes = asc(
      "POST",
      "/v1/betaAppReviewSubmissions",
      JSON.stringify({
        data: { type: "betaAppReviewSubmissions", relationships: { build: { data: { type: "builds", id: build.id } } } },
      })
    );
    if (subRes.ok) {
      out.submitted = true;
      log(`build ${out.buildVersion} submitted for Beta App Review`);
    } else {
      note(`Beta App Review submission failed: ${ascErrorText(subRes)}`);
    }
  } else if (BLOCKED_EXTERNAL_STATES.includes(externalState)) {
    note(`build ${out.buildVersion} cannot reach external testers (externalBuildState=${externalState})`);
  } else {
    log(`build ${out.buildVersion} external state is ${externalState}; no submission needed`);
  }

  return out;
}

/**
 * The real App Store Connect client:  the vendored scripts/ios-fleet/asc-api.mjs
 * owns the credential, so this only shells out and parses what it prints.
 */
export function makeAscClient(root = ROOT) {
  const client = join(root, "scripts", "ios-fleet", "asc-api.mjs");
  return (method, path, body) => {
    const args = [client, method, path];
    if (body) args.push(body);
    const res = spawnSync(process.execPath, args, { encoding: "utf8" });
    const stdout = (res.stdout || "").trim();
    let parsed = null;
    try {
      parsed = stdout ? JSON.parse(stdout) : null;
    } catch {
      parsed = null;
    }
    const httpStatus = Number((res.stderr || "").match(/HTTP (\d+)/)?.[1] || 0);
    return {
      ok: res.status === 0,
      status: httpStatus || res.status || 0,
      parsed,
      text: stdout,
      stderr: res.stderr || "",
    };
  };
}

/** Read the app's App Store Connect id out of the vendored apps.json. */
export function readAppleId(root = ROOT, appKey = DEFAULT_APP_KEY) {
  const raw = readFileSync(join(root, "scripts", "ios-fleet", "apps.json"), "utf8");
  const apps = JSON.parse(raw)?.apps || {};
  const id = apps[appKey]?.appleId;
  return id == null ? null : String(id);
}

function parseArgs(argv) {
  const out = { appleId: null, group: null, appKey: DEFAULT_APP_KEY };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--apple-id") out.appleId = argv[++i] || null;
    else if (argv[i] === "--group") out.group = argv[++i] || null;
    else if (argv[i] === "--app") out.appKey = argv[++i] || DEFAULT_APP_KEY;
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  let appId = args.appleId;
  if (!appId) {
    // A missing or malformed apps.json throws out of readAppleId.  This runs
    // inside a ship that already succeeded, so that is a warning on the
    // documented exit 3, never an unhandled throw and exit 1.
    try {
      appId = readAppleId(ROOT, args.appKey);
    } catch (err) {
      console.error(
        `promote-external-beta: warning: could not read the app id from apps.json (${err?.message || err})`
      );
      process.exit(3);
    }
  }
  if (!appId) {
    console.error("promote-external-beta: no App Store Connect app id; pass --apple-id");
    process.exit(3);
  }
  const asc = makeAscClient(ROOT);
  const result = promoteExternalBeta({
    asc,
    appId,
    groupName: args.group,
    log: (m) => console.error(`promote-external-beta: ${m}`),
    warn: (m) => console.error(`promote-external-beta: warning: ${m}`),
  });
  console.log(JSON.stringify(result));
  process.exit(result.warnings ? 3 : 0);
}

// pathToFileURL, not `file://${process.argv[1]}`:  on Windows the argv path
// carries backslashes, so the naive comparison never matches and the CLI body
// would be a silent no-op that still exits 0.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
