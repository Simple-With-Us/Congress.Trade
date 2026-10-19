#!/usr/bin/env node
/**
 * Congress.Trade iOS 1.0.0 App Review resubmit.
 *
 * Uploads the physical-device account-deletion recording, updates review notes,
 * cancels the stale UNRESOLVED_ISSUES submission, creates a new IOS review
 * submission with the app version plus both Premium subscriptions, and submits.
 *
 * Auth: ASC_KEY_ID / ASC_ISSUER_ID / ASC_KEY_PATH from env, else Infisical /asc through
 * fleet-secrets (ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_P8).  Never printed.  Nothing reads ~/.secrets.
 * Usage:
 *   node scripts/asc-submit-review.mjs            # dry run
 *   node scripts/asc-submit-review.mjs --apply    # write to App Store Connect
 */
import { readFileSync, statSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash, createSign } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

const APPLY = process.argv.includes("--apply");
const buildArgIdx = process.argv.indexOf("--build");
const TARGET_BUILD = (buildArgIdx !== -1 && process.argv[buildArgIdx + 1])
  || process.env.ASC_TARGET_BUILD
  || "";
const APP = "6798076688";
const VERSION_ID = "7824c023-3f0c-41fa-abf6-be24d7fe217b";
const DETAIL_ID = "6bdc976e-ac42-44fd-9a95-4b33a4c14ac5";
const MONTHLY_ID = "6798078775";
const ANNUAL_ID = "6798078776";
const VIDEO_PATH = process.env.ASC_DELETION_VIDEO
  || join(homedir(), "apps/ios-fleet/artifacts/ct-account-deletion-2026-08-21.mp4");
const VIDEO_NAME = "account-deletion-physical-device.mp4";
const NOTES_PATH = process.env.ASC_REVIEW_NOTES
  || join(homedir(), "Code/Congress.Trade/docs/asc/REVIEW-NOTES.txt");

function fleetSecret(name) {
  const bin = process.env.FLEET_SECRETS || join(homedir(), ".local", "bin", "fleet-secrets");
  try {
    return execFileSync(bin, ["get", name, "--path", "/asc"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 30000
    }).replace(/\r?\n$/, "").trim();
  } catch {
    return "";
  }
}

function resolveAscCredentials() {
  const fromEnv = (n) => String(process.env[n] ?? "").trim();
  const keyId = fromEnv("ASC_KEY_ID") || fleetSecret("ASC_KEY_ID");
  const issuerId = fromEnv("ASC_ISSUER_ID") || fleetSecret("ASC_ISSUER_ID");
  const keyPath = fromEnv("ASC_KEY_PATH");
  const privateKeyPem = keyPath && existsSync(keyPath)
    ? readFileSync(keyPath, "utf8")
    : (fromEnv("ASC_KEY_P8") || fleetSecret("ASC_KEY_P8")).replace(/\\n/g, "\n");
  return { keyId, issuerId, privateKeyPem };
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
  const signature = signer.sign({ key: privateKeyPem, dsaEncoding: "ieee-p1363" });
  const encodedSig = signature.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${signingInput}.${encodedSig}`;
}

function errSummary(parsed) {
  const errs = parsed?.errors;
  if (!Array.isArray(errs) || errs.length === 0) return "";
  return errs.slice(0, 3).map((e) => e.detail || e.title || e.code || "error").join(" | ");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const { keyId, issuerId, privateKeyPem } = resolveAscCredentials();
  if (!keyId || !issuerId || !privateKeyPem) {
    console.error("missing ASC_KEY_ID / ASC_ISSUER_ID / key: set them in env or Infisical /asc (ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_P8)");
    process.exit(1);
  }
  const token = signJwt({ keyId, issuerId, privateKeyPem });

  async function api(method, apiPath, jsonBody) {
    const url = apiPath.startsWith("http") ? apiPath : `https://api.appstoreconnect.apple.com${apiPath}`;
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: jsonBody ? JSON.stringify(jsonBody) : undefined,
    });
    const text = await res.text();
    let parsed;
    try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text.slice(0, 200) }; }
    return { status: res.status, ok: res.ok, parsed };
  }

  function needOk(label, res) {
    if (res.ok) return res;
    console.error(`${label}: HTTP ${res.status} ${errSummary(res.parsed)}`);
    process.exit(2);
  }

  console.log(APPLY ? "MODE apply" : "MODE dry-run");

  const notes = readFileSync(NOTES_PATH, "utf8").trim();
  console.log(`notes chars=${notes.length}`);
  if (!notes.includes("physical-device") && !notes.includes("screen recording")) {
    console.error("notes do not mention a recording — refusing");
    process.exit(1);
  }

  const version = needOk("version", await api("GET", `/v1/appStoreVersions/${VERSION_ID}`));
  const vState = version.parsed.data?.attributes?.appStoreState;
  const vString = version.parsed.data?.attributes?.versionString;
  console.log(`version ${vString} state=${vState}`);

  // Fetch recent builds with polling if a specific target build was requested
  let selectedBuild = null;
  const deadline = Date.now() + (TARGET_BUILD ? 300_000 : 10_000);
  while (Date.now() < deadline) {
    const buildsRes = needOk("builds", await api("GET", `/v1/builds?filter[app]=${APP}&sort=-uploadedDate&limit=10`));
    const validBuilds = (buildsRes.parsed.data || []).filter((b) => b.attributes?.processingState === "VALID");
    if (TARGET_BUILD) {
      selectedBuild = validBuilds.find((b) => b.attributes?.version === TARGET_BUILD);
      if (selectedBuild) break;
      console.log(`waiting for target build ${TARGET_BUILD} to reach VALID... (visible valid: ${validBuilds.map((b) => b.attributes?.version).join(", ") || "none"})`);
      await sleep(6000);
    } else {
      if (validBuilds.length > 0) {
        selectedBuild = validBuilds[0];
        break;
      }
      console.log("waiting for a valid build...");
      await sleep(4000);
    }
  }
  if (!selectedBuild) {
    console.error(`target build ${TARGET_BUILD || "latest"} not found in VALID state`);
    process.exit(1);
  }
  console.log(`selected build version=${selectedBuild.attributes.version} id=${selectedBuild.id} uploaded=${selectedBuild.attributes.uploadedDate}`);

  // Check currently attached build
  const attached = await api("GET", `/v1/appStoreVersions/${VERSION_ID}/build?fields[builds]=version,processingState,expired`);
  const curBuildId = attached.parsed.data?.id;
  const curBuildVer = attached.parsed.data?.attributes?.version;
  console.log(`currently attached build=${curBuildVer} id=${curBuildId}`);

  async function updateVersionStringIfNeeded() {
    if (vString === "1.0.177") return;
    if (!APPLY) {
      console.log(`DRY RUN — would update versionString from ${vString} to 1.0.177`);
      return;
    }
    const res = await api("PATCH", `/v1/appStoreVersions/${VERSION_ID}`, {
      data: {
        type: "appStoreVersions",
        id: VERSION_ID,
        attributes: { versionString: "1.0.177" },
      },
    });
    if (!res.ok) {
      console.error(`update versionString: HTTP ${res.status} ${errSummary(res.parsed)}`);
      process.exit(2);
    }
    console.log(`updated versionString to 1.0.177: HTTP ${res.status}`);
  }

  async function attachBuildIfNeeded() {
    if (curBuildId === selectedBuild.id) {
      console.log(`build ${selectedBuild.attributes.version} already attached`);
      return;
    }
    if (!APPLY) {
      console.log(`DRY RUN — would attach build ${selectedBuild.attributes.version} (${selectedBuild.id}) to version ${VERSION_ID}`);
      return;
    }
    const res = await api("PATCH", `/v1/appStoreVersions/${VERSION_ID}/relationships/build`, {
      data: {
        type: "builds",
        id: selectedBuild.id,
      },
    });
    if (!res.ok) {
      console.error(`attach build: HTTP ${res.status} ${errSummary(res.parsed)}`);
      process.exit(2);
    }
    console.log(`attached build ${selectedBuild.attributes.version} (${selectedBuild.id}): HTTP ${res.status}`);
  }

  const subs = needOk("subs", await api("GET", `/v1/apps/${APP}/subscriptionGroups?limit=5&include=subscriptions`));
  const subRows = (subs.parsed.included || []).filter((x) => x.type === "subscriptions");
  for (const s of subRows) {
    console.log(`subscription ${s.attributes.productId} state=${s.attributes.state} id=${s.id}`);
  }
  const monthly = subRows.find((s) => s.id === MONTHLY_ID);
  const annual = subRows.find((s) => s.id === ANNUAL_ID);
  if (!monthly || !annual) {
    console.error("missing Premium subscription ids");
    process.exit(1);
  }
  const validSubStates = ["READY_TO_SUBMIT", "WAITING_FOR_REVIEW", "IN_REVIEW", "APPROVED"];
  if (!validSubStates.includes(monthly.attributes.state) || !validSubStates.includes(annual.attributes.state)) {
    console.error(`subscriptions in unexpected state: monthly=${monthly.attributes.state}, annual=${annual.attributes.state} — Guideline 2.1(b) requirement`);
    process.exit(1);
  }

  const submissions = needOk("submissions", await api("GET", `/v1/reviewSubmissions?filter[app]=${APP}&filter[platform]=IOS&limit=10`));
  for (const item of submissions.parsed.data || []) {
    const a = item.attributes || {};
    console.log(`submission ${item.id} state=${a.state} submitted=${a.submitted}`);
  }

  const existingAtt = needOk("attachments", await api("GET", `/v1/appStoreReviewDetails/${DETAIL_ID}/appStoreReviewAttachments`));
  let haveVideo = false;
  const extraAttachments = [];
  for (const item of existingAtt.parsed.data || []) {
    const a = item.attributes || {};
    const stt = a.assetDeliveryState?.state;
    console.log(`attachment ${item.id} file=${a.fileName} bytes=${a.fileSize} state=${stt}`);
    if (a.fileName === VIDEO_NAME && stt === "COMPLETE") haveVideo = true;
    else extraAttachments.push({ id: item.id, fileName: a.fileName });
  }

  async function uploadVideo() {
    if (haveVideo) {
      console.log("video already COMPLETE — skip upload");
      return;
    }
    // App Review Information allows one attachment.  Replace any other file
    // (the existing IMG_1079.MP4 is not the owner-approved deletion clip).
    for (const extra of extraAttachments) {
      if (!APPLY) {
        console.log(`DRY RUN — would delete leftover attachment ${extra.fileName}`);
        continue;
      }
      const del = await api("DELETE", `/v1/appStoreReviewAttachments/${extra.id}`);
      if (!del.ok && del.status !== 204 && del.status !== 404) {
        console.error(`delete attachment ${extra.fileName}: HTTP ${del.status} ${errSummary(del.parsed)}`);
        process.exit(2);
      }
      console.log(`deleted leftover attachment ${extra.fileName}: HTTP ${del.status}`);
    }
    const bytes = readFileSync(VIDEO_PATH);
    const checksum = createHash("md5").update(bytes).digest("base64");
    if (!APPLY) {
      console.log(`DRY RUN — would reserve+upload ${VIDEO_NAME} (${bytes.length} bytes)`);
      return;
    }
    const reserved = await api("POST", "/v1/appStoreReviewAttachments", {
      data: {
        type: "appStoreReviewAttachments",
        attributes: { fileName: VIDEO_NAME, fileSize: bytes.length },
        relationships: {
          appStoreReviewDetail: { data: { type: "appStoreReviewDetails", id: DETAIL_ID } },
        },
      },
    });
    if (!reserved.ok) {
      console.error(`reserve attachment: HTTP ${reserved.status} ${errSummary(reserved.parsed)}`);
      process.exit(2);
    }
    const attId = reserved.parsed.data?.id;
    const ops = reserved.parsed.data?.attributes?.uploadOperations || [];
    console.log(`reserved attachment ${attId} parts=${ops.length} attrKeys=${Object.keys(reserved.parsed.data?.attributes || {}).join(",")}`);
    for (const [i, op] of ops.entries()) {
      const offset = op.offset || 0;
      const length = op.length || bytes.length;
      const headers = {};
      for (const h of op.requestHeaders || []) {
        if (h?.name) headers[h.name] = h.value;
      }
      const put = await fetch(op.url, {
        method: op.method || "PUT",
        headers,
        body: bytes.subarray(offset, offset + length),
      });
      if (!put.ok) {
        console.error(`upload part ${i + 1}/${ops.length}: HTTP ${put.status}`);
        process.exit(2);
      }
      console.log(`upload part ${i + 1}/${ops.length}: HTTP ${put.status}`);
    }
    const commit = await api("PATCH", `/v1/appStoreReviewAttachments/${attId}`, {
      data: {
        type: "appStoreReviewAttachments",
        id: attId,
        attributes: { uploaded: true, sourceFileChecksum: checksum },
      },
    });
    if (!commit.ok) {
      console.error(`commit attachment: HTTP ${commit.status} ${errSummary(commit.parsed)}`);
      process.exit(2);
    }
    console.log(`commit attachment: HTTP ${commit.status}`);
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      const poll = await api("GET", `/v1/appStoreReviewAttachments/${attId}`);
      const stt = poll.parsed.data?.attributes?.assetDeliveryState?.state;
      console.log(`attachment state=${stt}`);
      if (stt === "COMPLETE") return;
      if (stt === "FAILED") {
        console.error("attachment processing FAILED");
        process.exit(2);
      }
      await sleep(4000);
    }
    console.error("attachment did not reach COMPLETE in 180s");
    process.exit(2);
  }

  async function updateNotes() {
    if (!APPLY) {
      console.log("DRY RUN — would PATCH review notes");
      return;
    }
    const res = await api("PATCH", `/v1/appStoreReviewDetails/${DETAIL_ID}`, {
      data: {
        type: "appStoreReviewDetails",
        id: DETAIL_ID,
        attributes: { notes },
      },
    });
    if (!res.ok) {
      console.error(`notes: HTTP ${res.status} ${errSummary(res.parsed)}`);
      process.exit(2);
    }
    console.log(`notes: HTTP ${res.status} chars=${notes.length}`);
  }

  async function cancelStale() {
    const listed = needOk("submissions-before-cancel", await api("GET", `/v1/reviewSubmissions?filter[app]=${APP}&filter[platform]=IOS&limit=10`));
    const unres = (listed.parsed.data || []).filter((s) => s.attributes?.state === "UNRESOLVED_ISSUES" || s.attributes?.state === "CANCELING");
    for (const s of unres) {
      if (s.attributes?.state !== "CANCELING") {
        console.log(`canceling unresolved submission ${s.id}`);
        if (APPLY) {
          const cancelRes = await api("PATCH", `/v1/reviewSubmissions/${s.id}`, {
            data: {
              type: "reviewSubmissions",
              id: s.id,
              attributes: { canceled: true },
            },
          });
          if (!cancelRes.ok) {
            console.error(`cancel submission ${s.id}: HTTP ${cancelRes.status} ${errSummary(cancelRes.parsed)}`);
            process.exit(2);
          }
        }
      }
      if (APPLY) {
        const deadline = Date.now() + 180_000;
        while (Date.now() < deadline) {
          const poll = await api("GET", `/v1/reviewSubmissions/${s.id}`);
          const stt = poll.parsed.data?.attributes?.state;
          console.log(`submission ${s.id} state=${stt}`);
          if (stt === "CANCELLED" || stt === "COMPLETE") break;
          await sleep(4000);
        }
      }
    }
  }

  async function createAndSubmit() {
    const listed = needOk("submissions-refresh", await api("GET", `/v1/reviewSubmissions?filter[app]=${APP}&filter[platform]=IOS&limit=10`));
    let ready = (listed.parsed.data || []).find((s) => {
      const stt = s.attributes?.state;
      return stt === "READY_FOR_REVIEW" || stt === "WAITING_FOR_REVIEW" || stt === "IN_REVIEW";
    });
    if (ready && (ready.attributes.state === "WAITING_FOR_REVIEW" || ready.attributes.state === "IN_REVIEW")) {
      console.log(`already ${ready.attributes.state} id=${ready.id} — nothing to submit`);
      return ready.id;
    }
    if (!APPLY) {
      console.log("DRY RUN — would create review submission, add version + monthly + annual, submit");
      return null;
    }
    if (!ready) {
      const created = await api("POST", "/v1/reviewSubmissions", {
        data: {
          type: "reviewSubmissions",
          attributes: { platform: "IOS" },
          relationships: { app: { data: { type: "apps", id: APP } } },
        },
      });
      if (!created.ok) {
        console.error(`create submission: HTTP ${created.status} ${errSummary(created.parsed)}`);
        process.exit(2);
      }
      ready = created.parsed.data;
      console.log(`created submission ${ready.id} state=${ready.attributes?.state}`);
    } else {
      console.log(`reusing submission ${ready.id} state=${ready.attributes?.state}`);
    }
    const rsId = ready.id;

    async function addItem(relName, relType, relId, label) {
      const body = {
        data: {
          type: "reviewSubmissionItems",
          relationships: {
            reviewSubmission: { data: { type: "reviewSubmissions", id: rsId } },
            [relName]: { data: { type: relType, id: relId } },
          },
        },
      };
      const res = await api("POST", "/v1/reviewSubmissionItems", body);
      if (res.ok) {
        console.log(`item ${label}: HTTP ${res.status} id=${res.parsed.data?.id}`);
        return true;
      }
      const detail = errSummary(res.parsed);
      console.error(`item ${label}: HTTP ${res.status} ${detail}`);
      return false;
    }

    // 2026 ASC: IAP products are subscriptionVersion + subscriptionGroupVersion,
    // not relationship name "subscription" (that 409s ENTITY_ERROR.RELATIONSHIP.UNKNOWN).
    const MONTHLY_VERSION = "efbef974-f24c-4ebb-b0c2-a6017f722957";
    const ANNUAL_VERSION = "f85b493e-7dcf-463a-821d-6ce0a327ccbc";
    const GROUP_VERSION = "3a37da1c-75e9-4284-929f-50ab6821d721";
    const okVersion = await addItem("appStoreVersion", "appStoreVersions", VERSION_ID, "app version");
    const okGroup = await addItem("subscriptionGroupVersion", "subscriptionGroupVersions", GROUP_VERSION, "premium group");
    const okMonthly = await addItem("subscriptionVersion", "subscriptionVersions", MONTHLY_VERSION, "premium.monthly");
    const okAnnual = await addItem("subscriptionVersion", "subscriptionVersions", ANNUAL_VERSION, "premium.annual");
    if (!okVersion) {
      console.error("version item failed — not submitting");
      process.exit(2);
    }
    if (!okMonthly || !okAnnual || !okGroup) {
      console.error("subscription items failed — not submitting (Guideline 2.1(b) needs group + both products)");
      process.exit(2);
    }

    const submitted = await api("PATCH", `/v1/reviewSubmissions/${rsId}`, {
      data: {
        type: "reviewSubmissions",
        id: rsId,
        attributes: { submitted: true },
      },
    });
    if (!submitted.ok) {
      console.error(`submit: HTTP ${submitted.status} ${errSummary(submitted.parsed)}`);
      process.exit(2);
    }
    console.log(`submit: HTTP ${submitted.status} state=${submitted.parsed.data?.attributes?.state} submitted=${submitted.parsed.data?.attributes?.submitted}`);
    return rsId;
  }

  await uploadVideo();
  await updateNotes();
  await cancelStale();
  await updateVersionStringIfNeeded();
  await attachBuildIfNeeded();
  const rsId = await createAndSubmit();

  const verAfter = await api("GET", `/v1/appStoreVersions/${VERSION_ID}`);
  console.log(`final version state=${verAfter.parsed.data?.attributes?.appStoreState}`);
  const subAfter = await api("GET", `/v1/reviewSubmissions?filter[app]=${APP}&filter[platform]=IOS&limit=5`);
  for (const item of subAfter.parsed.data || []) {
    const a = item.attributes || {};
    console.log(`final submission ${item.id} state=${a.state} submitted=${a.submitted}`);
  }
  if (rsId) console.log(`reviewSubmission=${rsId}`);
}

main().catch((err) => {
  console.error(String(err && err.stack ? err.stack.split("\n")[0] : err));
  process.exit(1);
});
