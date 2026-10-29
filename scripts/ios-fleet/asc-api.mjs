#!/usr/bin/env node
/**
 * Minimal App Store Connect API client. No dependencies beyond Node's
 * built-in crypto (ES256 JWT signing) and fetch (Node 18+).
 *
 * Auth: resolveAscCredentials() takes the first source that is present, and
 * never prints values:
 *   1. APPLE_API_KEY_ID / APPLE_API_ISSUER_ID / APPLE_API_KEY_P8_BASE64 in
 *      process.env (the hosted workflow exports the key as base64),
 *   2. ASC_KEY_ID / ASC_ISSUER_ID / ASC_KEY_P8 in process.env,
 *   3. `fleet-secrets get` (Infisical /asc: ASC_KEY_ID, ASC_ISSUER_ID,
 *      ASC_KEY_P8).
 * A path on disk is NOT a credential source (AFC-459, revision 2, Kody rule
 * 42):  the private key is a secret, and the approved sources are the process
 * environment and a captured `fleet-secrets get`.  ASC_KEY_PATH is never read
 * here:  the shell layer that owns the credential writes the staging copy the
 * Apple tools need and hands the key over in the environment
 * (scripts/ios-fleet/asc-key.mjs).
 * No local secrets folder is read (AFC-359).
 *
 * Usage:
 *   node asc-api.mjs GET /v1/apps
 *   node asc-api.mjs GET "/v1/apps?filter[bundleId]=trade.socratic.app"
 *   node asc-api.mjs PATCH /v1/betaAppReviewDetails/<id> '{"data":{...}}'
 *   node asc-api.mjs latest-build-seq <bundleId> <prefix>   # e.g. ... trade.congress.ios 1.0
 *   node asc-api.mjs latest-marketing-patch <bundleId> <prefix> [platform=IOS]
 *   node asc-api.mjs build-floor <bundleId> <version> [platform=IOS]
 *   node asc-api.mjs appstore-version-plan <bundleId> [platform=IOS]
 *   node asc-api.mjs appstore-version-prepare <bundleId> <version> <build> [platform=IOS]
 *
 * The version-numbering rules live in ./version-plan.mjs (pure, no I/O); this
 * client only fetches the App Store Connect state they need.
 *
 * Prints the raw JSON response to stdout. Caller is responsible for not
 * echoing anything secret-shaped from the response (ASC responses don't
 * carry credentials, only app metadata, so this is safe to print as-is).
 */
import { execFileSync } from "node:child_process";
import { createSign } from "node:crypto";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { nextSharedBuild } from "./shared-build.mjs";
import { normalizePrivateKey } from "./asc-key.mjs";
import {
  buildFloor,
  isDriftTrain,
  nextMarketingPatch
} from "./version-plan.mjs";

const INFISICAL_ASC_FOLDER = "/asc";

// The train an app ships on ("1.1" for marketingVersionDefault "1.1.0"), read
// from this directory's apps.json by bundle id.  Falls back to "1.0" when the
// bundle is not listed, which is the train every app used before per-app trains.
function trainPrefixForBundle(bundleId) {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const apps = JSON.parse(readFileSync(join(here, "apps.json"), "utf8")).apps || {};
    const entry = Object.values(apps).find((a) => a && a.bundleId === bundleId);
    const m = entry && /^(\d+)\.(\d+)\./.exec(String(entry.marketingVersionDefault || ""));
    if (m) return `${m[1]}.${m[2]}`;
  } catch {
    // fall through to the default train
  }
  return "1.0";
}

/**
 * Read one value from Infisical Fleet-OPS through `fleet-secrets get`.
 * FLEET_SECRETS_BIN, then FLEET_SECRETS (tests inject a fake), override the
 * installed binary.  Returns "" when the CLI is absent, the key is absent, or
 * the call fails.  Never logs stdout or stderr.
 */
function fleetSecret(name, folder = INFISICAL_ASC_FOLDER) {
  // The explicit/installed binary first, then fleet-secrets on PATH.
  const candidates = [
    process.env.FLEET_SECRETS_BIN || process.env.FLEET_SECRETS || join(homedir(), ".local", "bin", "fleet-secrets")
  ];
  if (!process.env.FLEET_SECRETS_BIN && !process.env.FLEET_SECRETS) candidates.push("fleet-secrets");
  for (const bin of candidates) {
    try {
      return execFileSync(bin, ["get", name, "--path", folder], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 30000
      })
        .replace(/\r?\n$/, "")
        .trim();
    } catch {
      // try the next candidate
    }
  }
  return "";
}

/**
 * Decode a base64 private key (the form the hosted workflow exports).
 * Returns "" when the value does not decode to text.
 */
function decodeP8(base64) {
  try {
    return Buffer.from(String(base64), "base64").toString("utf8");
  } catch {
    return "";
  }
}

/**
 * Resolve the App Store Connect credential.
 *
 * The order is the rule:  the environment beats the network, and a file on
 * disk is not a source at all.  ASC_KEY_PATH is never read here:  the shell
 * layer that owns the credential hands the key over in the environment.
 *
 * Returns { keyId, issuerId, privateKeyPem, source } on success,
 * { error } when a source is present but unusable, and { error: null } when
 * there is no credential at all.  Never prints values.
 */
export function resolveAscCredentials() {
  const fromEnv = (name) => {
    const v = process.env[name];
    return v != null && String(v).trim() !== "" ? String(v).trim() : "";
  };

  // 1. The APPLE_API_* trio:  the key is in the environment, so it wins.
  const appleKeyId = fromEnv("APPLE_API_KEY_ID");
  const appleIssuerId = fromEnv("APPLE_API_ISSUER_ID");
  const appleBase64 = fromEnv("APPLE_API_KEY_P8_BASE64");
  if (appleKeyId && appleIssuerId && appleBase64) {
    const pem = normalizePrivateKey(decodeP8(appleBase64));
    if (!pem) {
      return { error: "APPLE_API_KEY_P8_BASE64 is set but did not decode to a PEM private key" };
    }
    return {
      keyId: appleKeyId,
      issuerId: appleIssuerId,
      privateKeyPem: pem,
      source: "APPLE_API_* environment (base64 p8)"
    };
  }

  // 2. The same secret as a plain environment variable.  This is the form the
  //    shell layer hands a staged key over in.
  const envKeyId = fromEnv("ASC_KEY_ID");
  const envIssuerId = fromEnv("ASC_ISSUER_ID");
  const envKeyPem = fromEnv("ASC_KEY_P8");
  if (envKeyId && envIssuerId && envKeyPem) {
    const pem = normalizePrivateKey(envKeyPem.replace(/\\n/g, "\n"));
    if (!pem) {
      return { error: "ASC_KEY_P8 is set but is not a PEM private key" };
    }
    return {
      keyId: envKeyId,
      issuerId: envIssuerId,
      privateKeyPem: pem,
      source: "ASC_KEY_P8 environment"
    };
  }

  // 3. Infisical Fleet-OPS /asc.  The /asc issuer belongs to the /asc key, so
  //    a key id that is not the /asc one never gets the /asc issuer; it gets
  //    its own key from /authkey-<id>-p8.
  const infisicalKeyId = fleetSecret("ASC_KEY_ID");
  const keyId = envKeyId || infisicalKeyId;
  const issuerId =
    envIssuerId || (keyId && keyId === infisicalKeyId ? fleetSecret("ASC_ISSUER_ID") : "");
  if (!keyId || !issuerId) {
    return { error: null };
  }
  let keyPem = "";
  if (keyId === infisicalKeyId) {
    keyPem = fleetSecret("ASC_KEY_P8");
  }
  if (!keyPem) {
    keyPem = fleetSecret(`AUTHKEY_${keyId}`, `/authkey-${keyId.toLowerCase()}-p8`);
  }
  if (!keyPem) {
    return { error: null };
  }
  const pem = normalizePrivateKey(keyPem.replace(/\\n/g, "\n"));
  if (!pem) {
    return { error: "the App Store Connect key in Infisical /asc is not a PEM private key" };
  }
  return { keyId, issuerId, privateKeyPem: pem, source: "Infisical /asc" };
}

function base64url(input) {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function signJwt({ keyId, issuerId, privateKeyPem }) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "ES256", kid: keyId, typ: "JWT" };
  const payload = { iss: issuerId, iat: now, exp: now + 1190, aud: "appstoreconnect-v1" };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signer = createSign("SHA256");
  signer.update(signingInput);
  signer.end();
  // ASC requires the JOSE (r||s) signature encoding, not DER.
  const signature = signer.sign({ key: privateKeyPem, dsaEncoding: "ieee-p1363" });
  const encodedSig = signature.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${signingInput}.${encodedSig}`;
}

// ---------------------------------------------------------------------------
// TestFlight "What to Test" (betaBuildLocalizations.whatsNew)
// ---------------------------------------------------------------------------
// Every build of every fleet app shipped with this EMPTY (24 builds checked
// 2026-08-13; `GET /v1/builds/<id>/betaBuildLocalizations` returns `data: []`,
// i.e. the en-US row is ABSENT, not blank -- so this must CREATE, not only
// PATCH). /Users/jay/apps/AGENT-SYNC.md "App Versioning & TestFlight Build
// Policy" defines a mandatory template that nothing implemented.
//
// PUBLISHING SAFETY. This is the only step in the ship pipeline that writes
// owner-facing copy every TestFlight tester reads, generated from commit
// subjects nobody reviewed. So it is OPT-IN:
//   IOS_TF_RELEASE_NOTES=1      upload the rendered notes to App Store Connect
//   IOS_TF_RELEASE_NOTES=0      disabled entirely (render nothing)
//   unset / anything else       DRY RENDER: print the exact body, write nothing
// The default is the dry render, so the owner can read the real output of real
// ships before a single character reaches a tester. Flipping it to 1 is the
// owner's call, not an agent's.
//
// A hard deny-list assertion runs on the FULLY RENDERED body: if any internal
// agent name survives, the upload is skipped entirely rather than publishing a
// violation (AGENT-SYNC forbids agent names in release notes). Offending
// bullets are dropped whole -- never word-deleted in place, which yields
// mangled copy like "Fix:  lane".
const AGENT_NAMES = "grok|claude|monet|codex|antigravity|cursor|kimi|fable|gemini|deepseek|opus|sonnet|haiku";
// Bracketed agent markers, stripped ANYWHERE in the subject -- not only at
// position 0. The fleet's actual convention puts the tag at the END, e.g.
// "fix(ios): set App Category to Finance (#1030) [AG] (#1264)". Measured
// 2026-08-13: Congress.Trade has 48 subjects carrying a NON-leading [AG] and
// ZERO leading ones (Socratic.Trade: 2 and 2). An earlier version of this file
// stripped only /^\[[A-Za-z]+\]/ and left "AG" out of the deny-list below on
// the stated assumption that the strip covered it. It did not: every one of
// those 48 subjects would have published "[AG]" straight to TestFlight, which
// AGENT-SYNC's STRICT no-agent-names rule names explicitly.
const AGENT_MARKER = new RegExp(`\\[\\s*(?:ag|${AGENT_NAMES})\\s*\\]`, "gi");
// Bare "AG" stays OUT of the word-boundary deny-list -- as a naked token it
// fires on ordinary English and on tickers. The bracketed form is unambiguous,
// so the final rendered-body assertion tests for that form specifically.
const AGENT_NAME_DENY = new RegExp(`(?:\\b(?:${AGENT_NAMES})\\b|\\[\\s*ag\\s*\\])`, "i");

function centralTimestamp(now = new Date()) {
  // AGENT-SYNC template: "Wed, Aug 12, 2026 at 1:15am" -- the owner's clock
  // (America/Chicago, so DST is automatic), 12-hour, lower-case am or pm, and
  // NO timezone abbreviation.  Intl yields "1:15 PM" with a space or a narrow
  // no-break space (U+202F) before the meridiem, so fold both into "1:15pm".
  const d = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    weekday: "short", month: "short", day: "numeric", year: "numeric"
  }).format(now);
  const t = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    hour: "numeric", minute: "2-digit", hour12: true
  }).format(now).replace(/\s*([AP])M$/i, (_m, x) => `${x.toLowerCase()}m`);
  return `${d} at ${t}`;
}

function gitSubjects(repoRoot, prevSha) {
  // Returns { subjects, note }. Never throws: notes must not fail a ship.
  const run = (args) => execFileSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30000
  }).trim();
  try {
    if (prevSha) {
      let reachable = true;
      try { run(["merge-base", "--is-ancestor", prevSha, "HEAD"]); }
      catch { reachable = false; }
      if (!reachable) {
        // Shallow clone, force-push, or a squash-merge orphan. One deepen attempt.
        try { run(["fetch", "--deepen=200"]); } catch { /* offline is fine */ }
        try { run(["merge-base", "--is-ancestor", prevSha, "HEAD"]); reachable = true; }
        catch { reachable = false; }
      }
      if (reachable) {
        const out = run(["log", "--no-merges", "--format=%s", `${prevSha}..HEAD`]);
        return { subjects: out ? out.split("\n") : [], note: "" };
      }
      return {
        subjects: [run(["log", "-1", "--format=%s"])],
        note: `previous ship sha ${prevSha.slice(0, 10)} unreachable from HEAD; using HEAD subject only`
      };
    }
    return { subjects: [run(["log", "-1", "--format=%s"])], note: "no previous ship recorded; using HEAD subject only" };
  } catch (err) {
    return { subjects: [], note: `git unavailable (${err && err.message ? err.message.split("\n")[0] : err})` };
  }
}

function buildReleaseNotes({ marketing, displayName, title, subjects, iosPathPrefix, repoRoot, prevSha }) {
  // PR numbers are harvested only from bullets that SURVIVE filtering, so the
  // header line and the body describe the same set of changes.
  const prByBullet = new Map();
  const bullets = [];
  const seen = new Set();

  for (const raw of subjects) {
    let s = String(raw || "").trim();
    if (!s) continue;
    // 1. structured agent markers first, so a bracketed tag never survives as
    //    prose. AGENT_MARKER is global and unanchored because the fleet writes
    //    the tag at the END far more often than at the start.
    s = s.replace(AGENT_MARKER, " ")
         .replace(/^\[[A-Za-z]+\]\s*/, "")
         .replace(/\bAgent:\s*\S+\b/gi, "")
         .replace(/\bCo-Authored-By:.*$/gi, "");
    // 2. conventional-commit prefix
    s = s.replace(/^(feat|fix|chore|docs|refactor|perf|test|build|ci|style|revert)(\([^)]*\))?!?:\s*/i, "");
    // 3. harvest + strip the trailing PR ref; the numbers go in the header line
    const pr = s.match(/\s*\(#(\d+)\)\s*$/);
    let prNum = "";
    if (pr) {
      prNum = pr[1];
      s = s.replace(/\s*\(#\d+\)\s*$/, "");
    }
    s = s.replace(/\s+/g, " ").trim();
    if (!s) continue;
    // 4. noise
    if (/^(merge|bump|wip|revert)\b/i.test(s)) continue;
    if (s.length < 12) continue;
    // 5. agent names -> drop the whole bullet
    if (AGENT_NAME_DENY.test(s)) continue;
    s = s.charAt(0).toUpperCase() + s.slice(1);
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (prNum) prByBullet.set(s, prNum);
    bullets.push(s);
  }

  let kept = bullets;
  if (bullets.length > 10) {
    // Over the cap: prefer commits that touched this app's iOS tree, then backfill.
    let iosFirst = [];
    if (iosPathPrefix && repoRoot && prevSha) {
      try {
        const touched = execFileSync("git", [
          "-C", repoRoot, "log", "--no-merges", "--format=%s", `${prevSha}..HEAD`, "--", iosPathPrefix
        ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30000 })
          .trim().toLowerCase();
        iosFirst = bullets.filter((b) => touched.includes(b.slice(0, 20).toLowerCase()));
      } catch { /* tie-break only */ }
    }
    kept = [...iosFirst, ...bullets.filter((b) => !iosFirst.includes(b))].slice(0, 10);
  }
  if (kept.length === 0) kept = ["Maintenance and reliability updates"];

  const LIMIT = 4000;
  const heading = `[${marketing || "unversioned"}] ${title || `${displayName || "App"} Update`}`;

  const render = (keptBullets) => {
    const prNumbers = [];
    for (const b of keptBullets) {
      const n = prByBullet.get(b);
      if (n && !prNumbers.includes(n)) prNumbers.push(n);
    }
    let released = `Released: ${centralTimestamp()}`;
    if (prNumbers.length === 1) released += ` · PR #${prNumbers[0]}`;
    else if (prNumbers.length > 1 && prNumbers.length <= 5) {
      released += ` · PRs ${prNumbers.map((n) => `#${n}`).join(", ")}`;
    } else if (prNumbers.length > 5) {
      released += ` · PRs ${prNumbers.slice(0, 5).map((n) => `#${n}`).join(", ")} +${prNumbers.length - 5} more`;
    }
    return `${heading}\n${released}\n\nWhat's New:\n`;
  };

  const header = render(kept);
  const lines = [];
  let used = header.length;
  for (const b of kept) {
    const line = `- ${b}`;
    if (used + line.length + 1 > LIMIT) break;   // truncate at a bullet boundary
    lines.push(line);
    used += line.length + 1;
  }
  if (lines.length === 0) lines.push("- Maintenance and reliability updates");
  return `${header}${lines.join("\n")}`;
}

async function setWhatToTest({ api, buildId, appId, marketing }) {
  const mode = process.env.IOS_TF_RELEASE_NOTES;
  if (mode === "0") {
    console.error("release-notes: disabled (IOS_TF_RELEASE_NOTES=0)");
    return;
  }
  const repoRoot = process.env.IOS_TF_NOTES_REPO || "";
  const prevSha = process.env.IOS_TF_NOTES_PREV_SHA || "";
  const displayName = process.env.IOS_TF_NOTES_APP || "";
  const title = process.env.IOS_TF_RELEASE_TITLE || "";
  const iosPathPrefix = process.env.IOS_TF_NOTES_IOS_PREFIX || "";
  if (!repoRoot) {
    console.error("release-notes: IOS_TF_NOTES_REPO not set; skipping");
    return;
  }

  const { subjects, note } = gitSubjects(repoRoot, prevSha);
  if (note) console.error(`release-notes: ${note}`);
  const bodyText = buildReleaseNotes({
    marketing, displayName, title, subjects, iosPathPrefix, repoRoot, prevSha
  });

  console.error("release-notes: rendered body follows");
  for (const line of bodyText.split("\n")) console.error(`release-notes:   ${line}`);

  // Final assertion on the FULLY RENDERED body. Skip the upload rather than
  // publish a violation; never fail the ship over it.
  if (AGENT_NAME_DENY.test(bodyText)) {
    console.error("release-notes: ERROR - an internal agent name survived into the rendered body; NOT uploading");
    return;
  }

  if (mode !== "1") {
    console.error("release-notes: DRY RENDER only (set IOS_TF_RELEASE_NOTES=1 to publish this to TestFlight)");
    return;
  }

  const existing = await api("GET", `/v1/builds/${buildId}/betaBuildLocalizations`);
  if (!existing.ok) {
    console.error(`release-notes: could not read localizations (HTTP ${existing.status}); skipping`);
    return;
  }
  const enUs = (existing.parsed.data || []).find((x) => x.attributes?.locale === "en-US");
  if (enUs) {
    const res = await api("PATCH", `/v1/betaBuildLocalizations/${enUs.id}`, JSON.stringify({
      data: { type: "betaBuildLocalizations", id: enUs.id, attributes: { whatsNew: bodyText } }
    }));
    console.error(res.ok
      ? `release-notes: updated en-US What to Test (${bodyText.length} chars)`
      : `release-notes: PATCH failed HTTP ${res.status}`);
    return;
  }
  // No row exists yet -- CREATE it. This POST shape was NOT verified against a
  // live write (no ASC write was performed while implementing this); treat the
  // first real run as the verification, and read the printed HTTP status.
  let res = await api("POST", "/v1/betaBuildLocalizations", JSON.stringify({
    data: {
      type: "betaBuildLocalizations",
      attributes: { locale: "en-US", whatsNew: bodyText },
      relationships: { build: { data: { type: "builds", id: buildId } } }
    }
  }));
  if (!res.ok && appId) {
    // Some apps are not localized to en-US; fall back to a locale the app has.
    const locales = await api("GET", `/v1/apps/${appId}/betaAppLocalizations`);
    const alt = (locales.parsed?.data || [])[0]?.attributes?.locale;
    if (alt && alt !== "en-US") {
      console.error(`release-notes: en-US rejected (HTTP ${res.status}); retrying with ${alt}`);
      res = await api("POST", "/v1/betaBuildLocalizations", JSON.stringify({
        data: {
          type: "betaBuildLocalizations",
          attributes: { locale: alt, whatsNew: bodyText },
          relationships: { build: { data: { type: "builds", id: buildId } } }
        }
      }));
    }
  }
  console.error(res.ok
    ? `release-notes: created What to Test (${bodyText.length} chars)`
    : `release-notes: POST failed HTTP ${res.status}`);
}

async function main() {
  const cred = resolveAscCredentials();
  if (cred.error) {
    console.error(`asc-auth: ${cred.error}`);
    process.exit(1);
  }
  if (!cred.privateKeyPem) {
    console.error(
      "asc-auth: no App Store Connect credential found. Tried, in order:\n" +
        "  1) APPLE_API_KEY_ID / APPLE_API_ISSUER_ID / APPLE_API_KEY_P8_BASE64 in the environment\n" +
        "  2) ASC_KEY_ID / ASC_ISSUER_ID / ASC_KEY_P8 in the environment\n" +
        "  3) Fleet-OPS prod /asc through fleet-secrets\n" +
        "  A path in ASC_KEY_PATH is not a credential source:  the shell layer that owns the\n" +
        "  credential hands the key over in ASC_KEY_P8."
    );
    process.exit(1);
  }
  const { keyId, issuerId, privateKeyPem } = cred;
  console.error(`asc-auth: using ${cred.source} (key id length ${keyId.length})`);
  const token = signJwt({ keyId, issuerId, privateKeyPem });

  const argv = process.argv.slice(2);
  const [method, path, body, arg4] = argv;
  if (!method || !path) {
    console.error("Usage: node asc-api.mjs <METHOD> <PATH> [JSON_BODY]");
    console.error("       node asc-api.mjs ensure-tf-ready <bundleId> <buildVersion> [marketingVersion]");
    console.error("       node asc-api.mjs latest-build-seq <bundleId> <prefix>");
    console.error("       node asc-api.mjs latest-marketing-patch <bundleId> <prefix> [platform=IOS]");
    console.error("       node asc-api.mjs build-floor <bundleId> <version> [platform=IOS]");
    console.error("       node asc-api.mjs appstore-version-plan <bundleId> [platform=IOS]");
    console.error("       node asc-api.mjs appstore-version-prepare <bundleId> <version> <buildNumber> [platform=IOS]");
    process.exit(1);
  }

  // Test seam: the offline contract tests point the client at a stub server
  // through ASC_API_BASE (already allowlisted for the child environment in
  // asc-key.mjs). Unset everywhere else, so production always talks to
  // App Store Connect.
  const apiBase = process.env.ASC_API_BASE || "https://api.appstoreconnect.apple.com";

  async function api(methodName, apiPath, jsonBody) {
    const url = apiPath.startsWith("http") ? apiPath : `${apiBase}${apiPath}`;
    const res = await fetch(url, {
      method: methodName,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: jsonBody ? jsonBody : undefined
    });
    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
    return { status: res.status, ok: res.ok, parsed, text };
  }

  // Highest N already used by the "<prefix>.N" MARKETING version train
  // (e.g. 1.0.7). This is what makes App Store Connect -- not a single unbacked
  // local file -- the source of truth for "what has already shipped", so a
  // lost/reset counter cannot silently reuse a version that ASC rejects as a
  // duplicate.
  //
  // WHICH ASC FIELD IS WHICH (verified against live data 2026-08-12):
  //   preReleaseVersions[].attributes.version = CFBundleShortVersionString
  //                                             (the MARKETING version, "1.0.7")
  //   builds[].attributes.version             = CFBundleVersion
  //                                             (the BUILD number, "202608120521")
  // ship-testflight.sh sequences the MARKETING version, so this must read
  // preReleaseVersions. Reading builds[].version only ever worked by accident,
  // during the window when the ship script wrote the same dotted string into
  // both fields. It was already silently wrong for socratic, whose newest
  // marketing version is 1.0.1 but whose build numbers are "2" / "1" /
  // "202608120212" -- none of which match "1.0.N", so ASC contributed 0 and
  // "verification" verified nothing.
  //
  // Build numbers are still scanned afterwards, purely so this can never report
  // a LOWER floor than the old behaviour did for an app whose build numbers do
  // happen to be dotted (congress 1.0.7/1.0.1, usage 1.0.1).
  //
  // stdout: the integer N (0 when the train has no versions yet). stderr: notes.
  // exit 0 = authoritative answer; exit 2 = could not determine (caller must
  // treat that as "unverified", NOT as zero).
  if (method === "latest-build-seq") {
    const bundleId = path;
    const prefix = body;
    if (!bundleId || !prefix) {
      console.error("Usage: node asc-api.mjs latest-build-seq <bundleId> <prefix>");
      process.exit(2);
    }
    const apps = await api("GET", `/v1/apps?filter[bundleId]=${encodeURIComponent(bundleId)}&limit=1`);
    if (!apps.ok || !apps.parsed.data?.[0]) {
      console.error(`latest-build-seq: app not found for bundle (HTTP ${apps.status})`);
      process.exit(2);
    }
    const appId = apps.parsed.data[0].id;

    // Escape the prefix so "1.0" cannot match "120" via the regex dot.
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`^${escaped}\\.(\\d+)$`);

    let best = 0;
    const consider = (value) => {
      const m = re.exec(value || "");
      if (!m) return;
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n > best) best = n;
    };

    // 1) Marketing version trains -- the authoritative record.
    let url = `/v1/preReleaseVersions?filter[app]=${appId}&limit=200`;
    let seenVersions = 0;
    for (let page = 0; page < 10 && url; page++) {
      const res = await api("GET", url);
      if (!res.ok) {
        console.error(`latest-build-seq: preReleaseVersions query failed (HTTP ${res.status})`);
        process.exit(2);
      }
      for (const v of res.parsed.data || []) {
        // A macOS/tvOS train must not bump the iOS sequence.
        if ((v.attributes?.platform || "IOS") !== "IOS") continue;
        seenVersions++;
        consider(v.attributes?.version);
      }
      url = res.parsed.links?.next || "";
    }

    // 2) Build numbers, so the floor can never regress below what the previous
    //    implementation reported.
    url = `/v1/builds?filter[app]=${appId}&sort=-uploadedDate&limit=200`;
    let seenBuilds = 0;
    for (let page = 0; page < 10 && url; page++) {
      const res = await api("GET", url);
      if (!res.ok) {
        console.error(`latest-build-seq: builds query failed (HTTP ${res.status})`);
        process.exit(2);
      }
      for (const b of res.parsed.data || []) {
        seenBuilds++;
        consider(b.attributes?.version);
      }
      url = res.parsed.links?.next || "";
    }

    console.error(
      `latest-build-seq: ${seenVersions} marketing version(s) + ${seenBuilds} build(s) inspected; highest ${prefix}.N is N=${best}`
    );
    console.log(String(best));
    process.exit(0);
  }

  // After upload: find THE BUILD THIS RUN JUST UPLOADED, declare export
  // compliance on it, set its TestFlight "What to Test" notes, and wait until
  // internal testers can actually install it.
  //
  // WHY THE BUILD VERSION IS A REQUIRED ARGUMENT (defect found 2026-08-13):
  // this used to do
  //     GET /v1/builds?filter[app]=<id>&sort=-uploadedDate&limit=1
  // and assume "newest" was the build the run had just uploaded. It never is.
  // ASC ingestion is asynchronous, so for the first minutes after an upload the
  // new build has NO record at all -- the newest build is the PREVIOUS ship,
  // which is already VALID and already IN_BETA_TESTING. So the compliance PATCH
  // was a no-op on an old build and the readiness poll returned success on poll
  // 1, printing "TestFlight internal testers can install this build" about a
  // build it had never inspected.
  //
  // Reproduced from two ships on 2026-08-13:
  //   usage       archive CURRENT_PROJECT_VERSION=202608131759
  //               ensure-tf-ready.json version=202608130439  (13h older)
  //   usage-local archive CURRENT_PROJECT_VERSION=202608131801
  //               ensure-tf-ready.json version=202608130441  (previous ship)
  //
  // CFBundleVersion is known exactly at archive time (ship-testflight.sh passes
  // it to xcodebuild as CURRENT_PROJECT_VERSION) and ASC ingests it verbatim as
  // builds[].attributes.version, so it is an exact key. There is deliberately NO
  // "newest build" fallback: that fallback IS the defect.
  //
  // Exit codes: 0 ready | 2 usage/API error | 3 readiness timeout (build found,
  // still processing) | 4 the uploaded build never appeared within the discovery
  // budget, so compliance was NOT declared on it.
  if (method === "ensure-tf-ready") {
    const bundleId = path;
    const wantBuildVersion = body;
    const wantMarketing = arg4;
    if (!bundleId || !wantBuildVersion) {
      console.error("Usage: node asc-api.mjs ensure-tf-ready <bundleId> <buildVersion> [marketingVersion]");
      console.error("  <buildVersion> is CFBundleVersion (CURRENT_PROJECT_VERSION) of the build");
      console.error("  this run uploaded. It is required: without it there is no way to tell the");
      console.error("  new build from the previous ship, and ASC has no record of the new build");
      console.error("  for the first minutes after upload.");
      process.exit(2);
    }

    const totalTimeoutSec = (() => {
      const raw = process.env.IOS_TF_READY_TIMEOUT_SEC;
      const n = raw ? parseInt(raw, 10) : NaN;
      return Number.isFinite(n) && n > 0 ? n : 900;
    })();
    const deadline = Date.now() + totalTimeoutSec * 1000;
    const POLL_MS = 15000;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    const apps = await api("GET", `/v1/apps?filter[bundleId]=${encodeURIComponent(bundleId)}&limit=1`);
    if (!apps.ok || !apps.parsed.data?.[0]) {
      console.error(`ensure-tf-ready: app not found for bundle (HTTP ${apps.status})`);
      process.exit(2);
    }
    const appId = apps.parsed.data[0].id;

    // ---- Phase A: discovery. Poll until the uploaded build has an ASC record.
    let query = `/v1/builds?filter[app]=${appId}&filter[version]=${encodeURIComponent(wantBuildVersion)}`;
    if (wantMarketing) {
      query += `&filter[preReleaseVersion.version]=${encodeURIComponent(wantMarketing)}`;
    }
    query += "&limit=2&include=buildBetaDetail,preReleaseVersion";

    let build = null;
    let attempt = 0;
    let transientErrors = 0;
    while (Date.now() < deadline) {
      attempt++;
      const res = await api("GET", query);
      if (!res.ok) {
        // A rate-limit or a 5xx is exactly what a ~60-poll loop against a
        // third-party API should expect, and the whole export-compliance fix
        // hangs off this loop -- so one transient blip must not abandon it.
        // Genuine client errors (400/401/403/404) still fail fast.
        if (res.status === 429 || res.status >= 500) {
          transientErrors++;
          console.error(`ensure-tf-ready: discovery query transient HTTP ${res.status} (attempt ${attempt}); retrying`);
          await sleep(POLL_MS);
          continue;
        }
        console.error(`ensure-tf-ready: discovery query failed (HTTP ${res.status})`);
        process.exit(2);
      }
      const rows = res.parsed.data || [];
      if (rows.length > 1) {
        console.error(`ensure-tf-ready: ${rows.length} builds match version ${wantBuildVersion} -- ambiguous, refusing to guess`);
        process.exit(2);
      }
      if (rows.length === 1) {
        build = rows[0];
        build.__included = res.parsed.included || [];
        console.error(`ensure-tf-ready: discovered build ${wantBuildVersion} after ${attempt} attempt(s)`);
        break;
      }
      console.error(`ensure-tf-ready: build ${wantBuildVersion} not visible yet (attempt ${attempt}); waiting`);
      await sleep(POLL_MS);
    }

    if (!build) {
      // Name what IS present, so the log answers "then what did ASC have?".
      let newest = "unknown";
      try {
        const probe = await api("GET", `/v1/builds?filter[app]=${appId}&sort=-uploadedDate&limit=1`);
        newest = probe.parsed?.data?.[0]?.attributes?.version || "none";
      } catch { /* diagnostic only */ }
      console.error(
        `ensure-tf-ready: build version ${wantBuildVersion} never appeared for ${bundleId} within ${totalTimeoutSec}s; ` +
        `newest present is ${newest}. Export compliance was NOT declared on the build this run uploaded.` +
        (transientErrors ? ` (${transientErrors} transient API error(s) during discovery)` : "")
      );
      console.log(JSON.stringify({
        ok: false, wanted: wantBuildVersion, newestPresent: newest,
        discoveryTimedOut: true, transientErrors
      }));
      process.exit(4);
    }

    const buildId = build.id;
    const version = build.attributes?.version;
    const enc = build.attributes?.usesNonExemptEncryption;
    const beta = (build.__included || []).find((x) => x.type === "buildBetaDetails")?.attributes || {};
    console.error(`ensure-tf-ready: build=${version} id=${buildId} enc=${enc} internal=${beta.internalBuildState || "unknown"}`);

    // ---- Phase B: export compliance, on the DISCOVERED build.
    if (enc !== false) {
      const patch = await api("PATCH", `/v1/builds/${buildId}`, JSON.stringify({
        data: { type: "builds", id: buildId, attributes: { usesNonExemptEncryption: false } }
      }));
      if (!patch.ok) {
        console.error(`ensure-tf-ready: compliance patch failed HTTP ${patch.status}`);
        process.exit(2);
      }
      console.error("ensure-tf-ready: declared usesNonExemptEncryption=false");
    }

    // ---- Phase B2: TestFlight "What to Test". Before the readiness wait, so a
    // Phase C timeout cannot lose the notes. Never fails the caller.
    try {
      await setWhatToTest({ api, buildId, appId, marketing: wantMarketing });
    } catch (err) {
      console.error(`ensure-tf-ready: release-notes step failed (non-fatal): ${err && err.message ? err.message : err}`);
    }

    // ---- Phase C: readiness, drawing from the same overall deadline. Always
    // polls at least once: if discovery consumed nearly the whole budget, a
    // zero-poll "timed out" line would be misleading, and by this point the
    // compliance PATCH (the part that actually matters) has already landed.
    let pollNo = 0;
    while (pollNo === 0 || Date.now() < deadline) {
      pollNo++;
      const again = await api("GET", `/v1/builds/${buildId}?include=buildBetaDetail`);
      const attrs = again.parsed.data?.attributes || {};
      const detail = (again.parsed.included || []).find((x) => x.type === "buildBetaDetails")?.attributes || {};
      const state = detail.internalBuildState || "";
      console.error(`ensure-tf-ready: poll ${pollNo} enc=${attrs.usesNonExemptEncryption} internal=${state}`);
      if (state === "IN_BETA_TESTING" || state === "READY_FOR_BETA_TESTING") {
        console.log(JSON.stringify({
          ok: true,
          buildId,
          version,
          internalBuildState: state,
          usesNonExemptEncryption: attrs.usesNonExemptEncryption
        }));
        process.exit(0);
      }
      await sleep(POLL_MS);
    }
    console.error("ensure-tf-ready: timed out waiting for IN_BETA_TESTING (upload may still be processing)");
    console.log(JSON.stringify({ ok: false, buildId, version, timedOut: true }));
    process.exit(3);
  }

  // -------------------------------------------------------------------------
  // VERSION NUMBERING (owner directive 2026-10-24, AFC-517 / CT-2444)
  // -------------------------------------------------------------------------
  // These four commands feed scripts/ios-fleet/ship-testflight.sh and the
  // App Store version workflow.  The RULES live in ./version-plan.mjs (pure,
  // no I/O); this client only reads the App Store Connect state they need.
  //
  //   latest-marketing-patch  one less than the next FREE patch on a train (P, so P + 1 is free);
  //                          drift trains (a <prefix>.N train holding build
  //                          "N") ignored
  //   build-floor             the build number the next ship has to exceed
  //   appstore-version-plan   READ ONLY report of the App Store versions and
  //                          the newest builds
  //   appstore-version-prepare creates (or reuses) an App Store version and
  //                          attaches a build to it.  IT NEVER SUBMITS:  no
  //                          appStoreVersionSubmission, no reviewSubmission,
  //                          no reviewSubmissionItem is ever created, and no
  //                          localization is ever written.  A human submits
  //                          the version for review in App Store Connect.

  const EDITABLE_VERSION_STATES = new Set([
    "PREPARE_FOR_SUBMISSION",
    "DEVELOPER_REJECTED",
    "REJECTED",
    "METADATA_REJECTED",
    "INVALID_BINARY"
  ]);
  const IN_FLIGHT_VERSION_STATES = new Set([
    "WAITING_FOR_REVIEW",
    "IN_REVIEW",
    "PENDING_DEVELOPER_RELEASE",
    "PROCESSING_FOR_APP_STORE",
    "PENDING_APPLE_RELEASE"
  ]);
  const RELEASED_VERSION_STATES = new Set(["READY_FOR_SALE", "READY_FOR_DISTRIBUTION"]);

  // A to-one relationship's data is one { type, id } object (or null), not a list.
  const toOneId = (data) => (data && !Array.isArray(data) ? data.id || null : null);

  // Every App Store Connect read below goes through ascGet:  a throttled (429),
  // 5xx or network-failed answer is retried with backoff, because these
  // queries gate every ship and one rate-limit blip must not fail it.
  async function ascGet(url) {
    // A dropped connection or DNS failure makes fetch throw rather than
    // return a status, so a throw counts as a retryable failure too; the last
    // one is re-thrown.
    const once = async (last) => {
      try {
        return await api("GET", url);
      } catch (err) {
        if (last) throw err;
        return { ok: false, status: 0, networkError: true, parsed: {} };
      }
    };
    let res = await once(false);
    for (let attempt = 1; attempt <= 3 && !res.ok && (!res.status || res.status === 429 || res.status >= 500); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
      res = await once(attempt === 3);
    }
    return res;
  }

  // A rejected credential (401/403) exits 4, not 2, so the ship script can
  // refuse it even under --allow-unverified-seq.
  const failExit = (status) => process.exit(status === 401 || status === 403 ? 4 : 2);

  // App Store Connect data is checked before it is used:  a version string
  // that is not dotted integers would misclassify drift trains, so a
  // malformed record fails the query instead of being guessed at.
  const ASC_VERSION_RE = /^\d+(\.\d+)*$/;
  // v === String(v) admits only a primitive string (a number or null fails).
  const validVersion = (v) => v === String(v) && ASC_VERSION_RE.test(v);

  // Every build of one train, page by page.  Used when the train's inline
  // build list is truncated, so a drift train is never mistaken for an
  // empty one.
  async function trainBuildVersions(trainId) {
    const out = [];
    let url = `/v1/preReleaseVersions/${encodeURIComponent(trainId)}/builds?limit=200`;
    for (let page = 0; page < 50 && url; page++) {
      const res = await ascGet(url);
      if (!res.ok) return { ok: false, status: res.status, builds: out };
      for (const b of res.parsed.data || []) {
        const bv = b?.attributes?.version;
        if (!validVersion(bv)) return { ok: false, status: `malformed build ${b?.id || "?"}`, builds: out };
        out.push(bv);
      }
      url = res.parsed.links?.next || "";
    }
    if (url) return { ok: false, status: "build list longer than 50 pages", builds: out };
    return { ok: true, status: 200, builds: out };
  }

  async function appIdForBundle(bundleId) {
    const res = await ascGet(`/v1/apps?filter[bundleId]=${encodeURIComponent(bundleId)}&limit=1`);
    // A rejected key is not "app not found":  exit 4 so the ship refuses it.
    if (res.status === 401 || res.status === 403) {
      console.error(`${method}: App Store Connect rejected the API key (HTTP ${res.status})`);
      failExit(res.status);
    }
    if (!res.ok || !res.parsed.data?.[0]) return null;
    return res.parsed.data[0].id;
  }

  // The trains of an app: the TestFlight version strings and the builds each
  // one holds.  `include=builds` puts the build records in `included`.
  async function fetchTrains(appId, platform) {
    const trains = [];
    const buildVersionById = new Map();
    let url =
      `/v1/preReleaseVersions?filter[app]=${appId}` +
      `&filter[platform]=${encodeURIComponent(platform)}` +
      `&include=builds&limit=200&limit[builds]=50`;
    for (let page = 0; page < 10 && url; page++) {
      const res = await ascGet(url);
      if (!res.ok) return { ok: false, status: res.status, trains };
      for (const inc of res.parsed.included || []) {
        if (inc && inc.type === "builds") {
          if (!validVersion(inc.attributes?.version)) {
            return { ok: false, status: `malformed build ${inc.id || "?"}`, trains };
          }
          buildVersionById.set(inc.id, inc.attributes.version);
        }
      }
      for (const v of res.parsed.data || []) {
        if (!validVersion(v?.attributes?.version)) {
          return { ok: false, status: `malformed preReleaseVersion ${v?.id || "?"}`, trains };
        }
        const rel = v.relationships?.builds;
        const ids = (rel?.data || []).map((b) => b && b.id).filter(Boolean);
        let builds = ids.map((id) => buildVersionById.get(id)).filter((x) => x !== undefined);
        // The inline list stops at limit[builds]; when it is cut short (or a
        // build record is missing from `included`), read the whole train.
        const total = rel?.meta?.paging?.total;
        if (builds.length < ids.length || (Number.isInteger(total) && total > ids.length)) {
          const full = await trainBuildVersions(v.id);
          if (!full.ok) return { ok: false, status: full.status, trains };
          builds = full.builds;
        }
        trains.push({ version: v.attributes.version, builds });
      }
      url = res.parsed.links?.next || "";
    }
    if (url) return { ok: false, status: "more than 10 pages of trains", trains };
    return { ok: true, status: 200, trains };
  }

  // Highest patch already used on the <prefix> train, drift trains ignored.
  if (method === "latest-marketing-patch") {
    const bundleId = path;
    const prefix = body;
    const platform = arg4 || "IOS";
    if (!bundleId || !prefix) {
      console.error("Usage: node asc-api.mjs latest-marketing-patch <bundleId> <prefix> [platform=IOS]");
      process.exit(2);
    }
    const appId = await appIdForBundle(bundleId);
    if (!appId) {
      console.error(`latest-marketing-patch: app not found for bundle ${bundleId}`);
      process.exit(2);
    }

    // 1) The App Store versions.  They are never ignored:  a version that is
    //    on sale counts even when no TestFlight train carries it.
    const storeRes = await ascGet(`/v1/apps/${appId}/appStoreVersions?filter[platform]=${encodeURIComponent(platform)}&limit=200`
    );
    if (!storeRes.ok) {
      console.error(`latest-marketing-patch: appStoreVersions query failed (HTTP ${storeRes.status})`);
      failExit(storeRes.status);
    }
    const appStoreVersions = (storeRes.parsed.data || [])
      .map((v) => v?.attributes?.versionString);
    const badStore = appStoreVersions.findIndex((v) => !validVersion(v));
    if (badStore !== -1) {
      console.error(`latest-marketing-patch: malformed App Store version ${JSON.stringify(appStoreVersions[badStore] ?? null)}`);
      process.exit(2);
    }

    // 2) The TestFlight trains and their builds.
    const trainRes = await fetchTrains(appId, platform);
    if (!trainRes.ok) {
      console.error(`latest-marketing-patch: preReleaseVersions query failed (HTTP ${trainRes.status})`);
      failExit(trainRes.status);
    }
    const trains = trainRes.trains;

    // Print one less than the next FREE patch, so the caller's P + 1 never
    // lands on a patch a drift train already holds (see nextMarketingPatch).
    const patch = nextMarketingPatch({ prefix, appStoreVersions, trains }) - 1;
    const drift = trains.filter((t) => isDriftTrain(t.version, t.builds, prefix)).map((t) => t.version);

    console.error(
      `latest-marketing-patch: ${appStoreVersions.length} App Store version(s) + ${trains.length} train(s) ` +
      `inspected on ${platform}; next free ${prefix}.N is N=${patch + 1} (printed as ${patch}, so the caller's P + 1 lands on it)`
    );
    if (drift.length) {
      const shown = drift.slice(0, 5).join(", ");
      console.error(
        `latest-marketing-patch: ignored ${drift.length} drift train(s) (a ${prefix}.N train holding build "N"): ${shown}` +
        (drift.length > 5 ? ", ..." : "")
      );
    }
    console.log(String(patch));
    process.exit(0);
  }

  // Highest App Store version that has been (or is being) released, i.e. whose
  // train is closed to a lower or equal version.  Prints the version string,
  // or nothing when the app has none.  READ ONLY.
  if (method === "released-store-version") {
    const bundleId = path;
    const platform = String(body || "IOS").toUpperCase();
    if (!bundleId) {
      console.error("Usage: node asc-api.mjs released-store-version <bundleId> [platform=IOS]");
      process.exit(2);
    }
    const appId = await appIdForBundle(bundleId);
    if (!appId) {
      console.error(`released-store-version: app not found for bundle ${bundleId}`);
      process.exit(2);
    }
    const storeData = [];
    let storeUrl = `/v1/apps/${appId}/appStoreVersions?filter[platform]=${encodeURIComponent(platform)}&limit=200`;
    for (let page = 0; page < 10 && storeUrl; page += 1) {
      const storeRes = await ascGet(storeUrl);
      if (!storeRes.ok) {
        console.error(`released-store-version: appStoreVersions query failed (HTTP ${storeRes.status})`);
        failExit(storeRes.status);
      }
      storeData.push(...(storeRes.parsed.data || []));
      storeUrl = storeRes.parsed.links?.next || "";
    }
    if (storeUrl) {
      console.error("released-store-version: more than 10 pages of App Store versions; refusing to guess");
      process.exit(2);
    }
    // AppStoreVersionState enum:  every state must land in one set, or the
    // run refuses to guess (exit 3 below) rather than misread the floor.
    const RELEASED = new Set([
      "READY_FOR_SALE", "READY_FOR_DISTRIBUTION", "REPLACED_WITH_NEW_VERSION",
      "REMOVED_FROM_SALE", "DEVELOPER_REMOVED_FROM_SALE", "PREORDER_READY_FOR_SALE",
      "PENDING_DEVELOPER_RELEASE", "PENDING_APPLE_RELEASE", "ACCEPTED",
      // post-review, waiting on contract or export compliance: the version is approved
      // and holds its train, so it counts as released (fail closed)
      "PENDING_CONTRACT", "WAITING_FOR_EXPORT_COMPLIANCE",
      "PROCESSING_FOR_DISTRIBUTION", "PROCESSING_FOR_APP_STORE"
    ]);
    const NOT_RELEASED = new Set([
      "PREPARE_FOR_SUBMISSION", "READY_FOR_REVIEW", "WAITING_FOR_REVIEW", "IN_REVIEW",
      "UNRESOLVED_ISSUES", "REJECTED", "METADATA_REJECTED", "DEVELOPER_REJECTED", "INVALID_BINARY"
    ]);
    const parse = (v) => String(v).split(".").map((n) => parseInt(n, 10) || 0);
    const cmp = (a, b) => {
      const x = parse(a), y = parse(b);
      for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
        const d = (x[i] || 0) - (y[i] || 0);
        if (d) return d;
      }
      return 0;
    };
    let best = "";
    for (const v of storeData) {
      const a = v?.attributes || {};
      if (!a.versionString) continue;
      const st = [a.appVersionState, a.appStoreState].filter(Boolean);
      if (st.length === 0 || st.some((x) => !RELEASED.has(x) && !NOT_RELEASED.has(x))) {
        console.error("released-store-version: unknown state; refusing to guess"); process.exit(3);
      }
      if (!st.some((x) => RELEASED.has(x))) {
        if (st.length === 0 || !st.every((x) => NOT_RELEASED.has(x))) {
          console.error(`released-store-version: version ${a.versionString} has state ${JSON.stringify(st)}, which is not a known released or not-released state; not guessing`);
          process.exit(3);
        }
        continue;
      }
      if (!best || cmp(a.versionString, best) > 0) best = a.versionString;
    }
    console.error(`released-store-version: ${storeData.length} App Store version(s) inspected on ${platform}; highest released = ${best || "none"}`);
    console.log(best);
    process.exit(0);
  }

  // Read-only, fully paged shared four-digit counter (owner, Oct 28 2026):
  // next = max(every iOS build on ALL trains, every macOS build on ALL trains,
  // every extra floor, 999) + 1, floored at 1000.  iOS UTC timestamp builds are
  // ignored by the planner (those trains are closed); macOS builds all count.
  if (method === "next-shared-build") {
    const restArgs = argv.slice(1);
    const bundleId = restArgs[0] || "";
    const rest = restArgs.slice(1);
    if (!bundleId) {
      console.error("Usage: node asc-api.mjs next-shared-build <bundleId> [macBundleId] [floor...]"); process.exit(2);
    }
    // A pure-integer second arg is a floor, not a bundle id (bundle ids are
    // never bare integers), so a caller with no mac app passes only floors.
    let macBundleId = "";
    let floorArgs = [];
    if (rest.length > 0) {
      if (/^[0-9]+$/.test(rest[0])) floorArgs = rest;
      else { macBundleId = rest[0] || ""; floorArgs = rest.slice(1); }
    }
    const extraFloors = [];
    for (const f of floorArgs) {
      if (!/^[0-9]+$/.test(f) || !Number.isSafeInteger(Number(f))) {
        console.error(`next-shared-build: floor ${JSON.stringify(f)} is not a non-negative safe integer`); process.exit(2);
      }
      extraFloors.push(Number(f));
    }
    const appId = await appIdForBundle(bundleId);
    if (!appId) { console.error("next-shared-build: app not found"); process.exit(2); }
    let macAppId = "";
    if (macBundleId && macBundleId !== bundleId) {
      macAppId = await appIdForBundle(macBundleId);
      if (!macAppId) { console.error("next-shared-build: mac app not found"); process.exit(2); }
    }
    async function allBuilds(forAppId, platform) {
      const out = [];
      const isRecord = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
      let url = `/v1/builds?filter[app]=${forAppId}&filter[preReleaseVersion.platform]=${platform}&limit=200`;
      for (let page = 0; page < 100 && url; page++) {
        const res = await ascGet(url);
        if (!res.ok || !Array.isArray(res.parsed?.data)) { console.error("next-shared-build: inventory unavailable"); process.exit(2); }
        if (!isRecord(res.parsed)) { console.error("next-shared-build: malformed pagination"); process.exit(2); }
        const links = res.parsed.links;
        if (links !== undefined && links !== null && !isRecord(links)) { console.error("next-shared-build: malformed pagination"); process.exit(2); }
        const next = (links === undefined || links === null) ? null : links.next;
        if (next !== undefined && next !== null && typeof next !== "string") { console.error("next-shared-build: malformed pagination"); process.exit(2); }
        for (const b of res.parsed.data) out.push(b?.attributes?.version);
        url = typeof next === "string" ? next : "";
      }
      if (url) { console.error("next-shared-build: incomplete pagination"); process.exit(2); }
      return out;
    }
    // One counter per app across iOS and macOS: when a paired app is named
    // (an iOS ship names its Mac pair, a macOS ship its iOS pair), both
    // platforms of both apps join the counter.
    let iosBuilds;
    let macBuilds;
    if (macAppId) {
      const [iosA, macA, iosB, macB] = await Promise.all([
        allBuilds(appId, "IOS"),
        allBuilds(appId, "MAC_OS"),
        allBuilds(macAppId, "IOS"),
        allBuilds(macAppId, "MAC_OS")
      ]);
      iosBuilds = iosA.concat(iosB);
      macBuilds = macA.concat(macB);
    } else {
      const [iosA, macA] = await Promise.all([
        allBuilds(appId, "IOS"),
        allBuilds(appId, "MAC_OS")
      ]);
      iosBuilds = iosA;
      macBuilds = macA;
    }
    try {
      const planned = nextSharedBuild({iosBuilds, macBuilds, extraFloors, complete: true});
      console.error(`next-shared-build: ${iosBuilds.length} iOS build(s) + ${macBuilds.length} macOS build(s) inspected; ignored ${planned.ignoredIos} iOS timestamp build(s); next is ${planned.build}`);
      console.log(planned.build);
    } catch (error) { console.error(`next-shared-build: ${error.message}`); process.exit(3); }
    process.exit(0);
  }

  // Next dotted build for a fixed marketing version M.m.p:  the train's builds
  // must be M.m.<n>, and the next one is M.m.<max n + 1>; an empty train starts
  // at M.m.p, so the first build reads like its version (1.1.2 (1.1.2)).  A
  // train that holds any build of another shape stops the run with the reason,
  // because the ordering between shapes (239 is 239.0.0, above 1.1.2) is not
  // something to guess.  READ ONLY.
  //
  // Two ships at once would read the same train and pick the same n.  The CI
  // ship is serialised (ios-ship.yml concurrency group, cancel-in-progress
  // false), and a duplicate CFBundleVersion is refused by App Store Connect at
  // upload, so the loser fails loudly and nothing is promoted.  Do not run a
  // local ship while the workflow is running.
  if (method === "next-dotted-build") {
    const bundleId = path;
    const version = body;
    const platform = String(arg4 || "IOS").toUpperCase();
    const vm = /^(\d+)\.(\d+)\.(\d+)$/.exec(version || "");
    if (!bundleId || !vm) {
      console.error("Usage: node asc-api.mjs next-dotted-build <bundleId> <M.m.p> [platform=IOS]");
      process.exit(2);
    }
    const appId = await appIdForBundle(bundleId);
    if (!appId) {
      console.error(`next-dotted-build: app not found for bundle ${bundleId}`);
      process.exit(2);
    }
    const prefix = `${vm[1]}.${vm[2]}.`;
    let max = -1;
    let seen = 0;
    let nextUrl =
      `/v1/builds?filter[app]=${appId}` +
      `&filter[preReleaseVersion.version]=${encodeURIComponent(version)}` +
      `&filter[preReleaseVersion.platform]=${encodeURIComponent(platform)}&limit=200`;
    for (let page = 0; page < 10 && nextUrl; page++) {
      const res = await ascGet(nextUrl);
      if (!res.ok) {
        console.error(`next-dotted-build: train builds query failed (HTTP ${res.status})`);
        failExit(res.status);
      }
      for (const b of res.parsed.data || []) {
        const bv = b?.attributes?.version;
        const bm = typeof bv === "string" && bv.startsWith(prefix) ? /^\d+$/.exec(bv.slice(prefix.length)) : null;
        if (!bm) {
          console.error(`next-dotted-build: train ${version} holds build ${JSON.stringify(bv ?? null)}, which is not ${prefix}<n>; not guessing how it orders against a dotted build`);
          process.exit(3);
        }
        seen += 1;
        max = Math.max(max, parseInt(bm[0], 10));
      }
      nextUrl = res.parsed.links?.next || "";
    }
    if (nextUrl) {
      console.error("next-dotted-build: more than 10 pages of builds in one train; refusing to guess");
      process.exit(2);
    }
    const next = Math.max(max + 1, parseInt(vm[3], 10));
    console.error(`next-dotted-build: ${seen} build(s) in train ${version}; next is ${prefix}${next}`);
    console.log(`${prefix}${next}`);
    process.exit(0);
  }

  // The build number the next ship has to exceed:  every build already in the
  // target train, plus the app's plain-integer builds below 1000000000 (every
  // build on macOS, where build numbers grow across all trains).
  if (method === "build-floor") {
    const bundleId = path;
    const version = body;
    const platform = arg4 || "IOS";
    if (!bundleId || !version) {
      console.error("Usage: node asc-api.mjs build-floor <bundleId> <version> [platform=IOS]");
      process.exit(2);
    }
    const appId = await appIdForBundle(bundleId);
    if (!appId) {
      console.error(`build-floor: app not found for bundle ${bundleId}`);
      process.exit(2);
    }

    const trainBuilds = [];
    let url =
      `/v1/builds?filter[app]=${appId}` +
      `&filter[preReleaseVersion.version]=${encodeURIComponent(version)}` +
      `&filter[preReleaseVersion.platform]=${encodeURIComponent(platform)}&limit=200`;
    for (let page = 0; page < 10 && url; page++) {
      const res = await ascGet(url);
      if (!res.ok) {
        console.error(`build-floor: train builds query failed (HTTP ${res.status})`);
        failExit(res.status);
      }
      for (const b of res.parsed.data || []) {
        if (!validVersion(b?.attributes?.version)) {
          console.error(`build-floor: malformed build ${b?.id || "?"}`);
          process.exit(2);
        }
        trainBuilds.push(b.attributes.version);
      }
      url = res.parsed.links?.next || "";
    }

    const appBuilds = [];
    url =
      `/v1/builds?filter[app]=${appId}` +
      `&filter[preReleaseVersion.platform]=${encodeURIComponent(platform)}` +
      `&sort=-uploadedDate&limit=200`;
    for (let page = 0; page < 10 && url; page++) {
      const res = await ascGet(url);
      if (!res.ok) {
        console.error(`build-floor: app builds query failed (HTTP ${res.status})`);
        failExit(res.status);
      }
      for (const b of res.parsed.data || []) {
        if (!validVersion(b?.attributes?.version)) {
          console.error(`build-floor: malformed build ${b?.id || "?"}`);
          process.exit(2);
        }
        appBuilds.push(b.attributes.version);
      }
      url = res.parsed.links?.next || "";
    }

    const floor = buildFloor({ trainBuilds, appBuilds, platform });
    const trainFloor = buildFloor({ trainBuilds, appBuilds: [], platform });
    const appFloor = buildFloor({ trainBuilds: [], appBuilds, platform });
    // The note is machine-readable:  the shell layer splits it into the two
    // floors it prints in the version-plan log line.
    console.error(`build-floor: train=${trainFloor} app=${appFloor} -> floor=${floor}`);
    console.log(String(floor));
    process.exit(0);
  }

  // READ ONLY:  what the App Store looks like right now.
  if (method === "appstore-version-plan") {
    const bundleId = path;
    const platform = body || "IOS";
    if (!bundleId) {
      console.error("Usage: node asc-api.mjs appstore-version-plan <bundleId> [platform=IOS]");
      process.exit(2);
    }
    const appId = await appIdForBundle(bundleId);
    if (!appId) {
      console.error(`appstore-version-plan: app not found for bundle ${bundleId}`);
      process.exit(2);
    }

    const storeRes = await ascGet(`/v1/apps/${appId}/appStoreVersions?filter[platform]=${encodeURIComponent(platform)}` +
        `&include=build&limit=200`
    );
    if (!storeRes.ok) {
      console.error(`appstore-version-plan: appStoreVersions query failed (HTTP ${storeRes.status})`);
      process.exit(2);
    }
    const includedBuilds = new Map();
    for (const inc of storeRes.parsed.included || []) {
      if (inc && inc.type === "builds" && inc.attributes?.version) {
        includedBuilds.set(inc.id, String(inc.attributes.version));
      }
    }
    const appStoreVersions = (storeRes.parsed.data || []).map((v) => {
      const buildId = toOneId(v.relationships?.build?.data);
      return {
        versionString: v.attributes?.versionString || "",
        appStoreState: v.attributes?.appStoreState || "",
        createdDate: v.attributes?.createdDate || "",
        build: buildId ? includedBuilds.get(buildId) || null : null
      };
    });

    const buildsRes = await ascGet(`/v1/builds?filter[app]=${appId}` +
        `&filter[preReleaseVersion.platform]=${encodeURIComponent(platform)}` +
        `&include=preReleaseVersion&sort=-uploadedDate&limit=15`
    );
    if (!buildsRes.ok) {
      console.error(`appstore-version-plan: builds query failed (HTTP ${buildsRes.status})`);
      process.exit(2);
    }
    const includedTrains = new Map();
    for (const inc of buildsRes.parsed.included || []) {
      if (inc && inc.type === "preReleaseVersions" && inc.attributes?.version) {
        includedTrains.set(inc.id, String(inc.attributes.version));
      }
    }
    const newestBuilds = (buildsRes.parsed.data || []).map((b) => {
      const trainId = toOneId(b.relationships?.preReleaseVersion?.data);
      return {
        version: b.attributes?.version || "",
        preReleaseVersion: trainId ? includedTrains.get(trainId) || null : null,
        processingState: b.attributes?.processingState || "",
        uploadedDate: b.attributes?.uploadedDate || ""
      };
    });

    const trainRes = await fetchTrains(appId, platform);
    if (!trainRes.ok) {
      console.error(`appstore-version-plan: preReleaseVersions query failed (HTTP ${trainRes.status})`);
      process.exit(2);
    }
    const storeVersionStrings = appStoreVersions.map((v) => v.versionString);
    const planPrefix = trainPrefixForBundle(bundleId);
    const patch = nextMarketingPatch({
      prefix: planPrefix,
      appStoreVersions: storeVersionStrings,
      trains: trainRes.trains
    }) - 1;

    console.log(
      JSON.stringify(
        {
          bundleId,
          platform,
          appStoreVersions,
          newestBuilds,
          nextMarketing: `${planPrefix}.${patch + 1}`
        },
        null,
        2
      )
    );
    process.exit(0);
  }

  // Create (or reuse) an App Store version and attach a build to it.
  // NEVER SUBMITS.  No appStoreVersionSubmission, no reviewSubmission, no
  // reviewSubmissionItem is ever created here, and no localization is ever
  // written:  submission for review is deliberately left to a human in App
  // Store Connect.
  if (method === "appstore-version-prepare") {
    const bundleId = path;
    const version = body;
    const buildNumber = arg4;
    const platform = argv[4] || "IOS";
    if (!bundleId || !version || !buildNumber) {
      console.error(
        "Usage: node asc-api.mjs appstore-version-prepare <bundleId> <version> <buildNumber> [platform=IOS]"
      );
      process.exit(2);
    }
    const appId = await appIdForBundle(bundleId);
    if (!appId) {
      console.error(`appstore-version-prepare: app not found for bundle ${bundleId}`);
      process.exit(2);
    }

    const listRes = await ascGet(`/v1/apps/${appId}/appStoreVersions?filter[platform]=${encodeURIComponent(platform)}&limit=200`
    );
    if (!listRes.ok) {
      console.error(`appstore-version-prepare: appStoreVersions query failed (HTTP ${listRes.status})`);
      process.exit(2);
    }
    const rows = listRes.parsed.data || [];

    let target = rows.find((v) => v.attributes?.versionString === version);
    if (target) {
      const state = target.attributes?.appStoreState || "";
      if (!EDITABLE_VERSION_STATES.has(state)) {
        console.error(
          `appstore-version-prepare: version ${version} already exists in state ${state}, which cannot be edited. ` +
          `Resolve it in App Store Connect, or prepare a different version.`
        );
        process.exit(2);
      }
      console.error(`appstore-version-prepare: reusing existing version ${version} (${state})`);
    } else {
      // Never rename or delete another version:  if one is still in flight,
      // stop and say which one.
      const blocker = rows.find((v) => {
        const state = v.attributes?.appStoreState || "";
        return EDITABLE_VERSION_STATES.has(state) || IN_FLIGHT_VERSION_STATES.has(state);
      });
      if (blocker) {
        console.error(
          `appstore-version-prepare: version ${version} does not exist, but ` +
          `${blocker.attributes?.versionString} is still ${blocker.attributes?.appStoreState}. ` +
          `Resolve that version in App Store Connect first; this tool never renames or deletes a version.`
        );
        process.exit(2);
      }
      // ONLY platform and versionString:  App Store Connect copies the
      // previous version's metadata (copyright, release type, localizations)
      // itself.  Sending anything else can wipe it.
      const created = await api("POST", "/v1/appStoreVersions", JSON.stringify({
        data: {
          type: "appStoreVersions",
          attributes: { platform, versionString: version },
          relationships: { app: { data: { type: "apps", id: appId } } }
        }
      }));
      if (!created.ok || !created.parsed.data?.id) {
        console.error(
          `appstore-version-prepare: could not create version ${version} (HTTP ${created.status}): ${created.text}`
        );
        process.exit(2);
      }
      target = created.parsed.data;
      console.error(`appstore-version-prepare: created version ${version} (${target.attributes?.appStoreState || "unknown state"})`);
    }

    const versionId = target.id;
    const buildsRes = await ascGet(`/v1/builds?filter[app]=${appId}&filter[version]=${encodeURIComponent(buildNumber)}` +
        `&filter[preReleaseVersion.version]=${encodeURIComponent(version)}` +
        `&filter[preReleaseVersion.platform]=${encodeURIComponent(platform)}&limit=10`
    );
    if (!buildsRes.ok) {
      console.error(`appstore-version-prepare: builds query failed (HTTP ${buildsRes.status})`);
      process.exit(2);
    }
    const matches = buildsRes.parsed.data || [];
    if (matches.length !== 1) {
      console.error(
        `appstore-version-prepare: ${matches.length} builds match ${buildNumber} in train ${version} on ${platform}; ` +
        `expected exactly one.`
      );
      process.exit(2);
    }
    const build = matches[0];
    const processingState = build.attributes?.processingState || "";
    if (processingState !== "VALID") {
      console.error(
        `appstore-version-prepare: build ${buildNumber} is ${processingState}, not processed yet; re-run later.`
      );
      process.exit(3);
    }

    const attach = await api(
      "PATCH",
      `/v1/appStoreVersions/${versionId}/relationships/build`,
      JSON.stringify({ data: { type: "builds", id: build.id } })
    );
    if (!attach.ok) {
      console.error(
        `appstore-version-prepare: could not attach build ${buildNumber} to ${version} (HTTP ${attach.status}): ${attach.text}`
      );
      process.exit(2);
    }

    // ---- verify -----------------------------------------------------------
    const verifyRes = await ascGet(`/v1/appStoreVersions/${versionId}?include=build`
    );
    if (!verifyRes.ok) {
      console.error(`appstore-version-prepare: could not read the version back (HTTP ${verifyRes.status})`);
      process.exit(2);
    }
    const verified = verifyRes.parsed.data || {};
    let attachedBuild = null;
    for (const inc of verifyRes.parsed.included || []) {
      if (inc && inc.type === "builds" && inc.attributes?.version) attachedBuild = String(inc.attributes.version);
    }

    // ---- metadata comparison (booleans and lengths only) ------------------
    // The reference is the newest RELEASED version:  that is what App Store
    // Connect copies the metadata from, so it is what the operator has to
    // check.  The TEXT is never printed, only whether it matches.
    const released = rows
      .filter((v) => RELEASED_VERSION_STATES.has(v.attributes?.appStoreState || ""))
      .sort((a, b) => String(b.attributes?.createdDate || "").localeCompare(String(a.attributes?.createdDate || "")));
    const reference = released[0] || null;

    const localizationsFor = async (id) => {
      const res = await ascGet(`/v1/appStoreVersions/${id}/appStoreVersionLocalizations?limit=200`);
      if (!res.ok) return new Map();
      const map = new Map();
      for (const loc of res.parsed.data || []) {
        map.set(loc.attributes?.locale || "", loc.attributes || {});
      }
      return map;
    };
    const newLocales = await localizationsFor(versionId);
    const refLocales = reference ? await localizationsFor(reference.id) : new Map();

    const localeNames = [...new Set([...newLocales.keys(), ...refLocales.keys()])].sort();
    const locales = localeNames.map((locale) => {
      const now = newLocales.get(locale) || {};
      const was = refLocales.get(locale) || {};
      const same = (field) => (now[field] || "") === (was[field] || "");
      return {
        locale,
        descriptionEqual: same("description"),
        keywordsEqual: same("keywords"),
        promotionalTextEqual: same("promotionalText"),
        marketingUrlEqual: same("marketingUrl"),
        supportUrlEqual: same("supportUrl"),
        whatsNewLength: String(now.whatsNew || "").length
      };
    });

    console.log(
      JSON.stringify(
        {
          version: verified.attributes?.versionString || version,
          appStoreState: verified.attributes?.appStoreState || "",
          build: attachedBuild,
          metadataComparison: {
            referenceVersion: reference ? reference.attributes?.versionString || "" : "",
            referenceState: reference ? reference.attributes?.appStoreState || "" : "",
            locales
          },
          submission:
            "not submitted: a human submits this version for review in App Store Connect. " +
            "This tool never creates a submission and never writes a localization."
        },
        null,
        2
      )
    );
    process.exit(0);
  }

  const url = path.startsWith("http") ? path : `${apiBase}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: body ? body : undefined
  });
  const text = await res.text();
  console.error(`HTTP ${res.status}`);
  console.log(text);
  if (!res.ok) process.exit(2);
}

main().catch((err) => {
  console.error(String(err && err.stack ? err.stack : err));
  process.exit(1);
});
