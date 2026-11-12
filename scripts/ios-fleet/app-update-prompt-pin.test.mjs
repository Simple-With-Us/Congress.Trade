import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import test from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PIN = join(ROOT, "scripts/ios-fleet/AppUpdatePrompt.swift");
const COPY = join(ROOT, "clients/ios/CongressTrade/AppUpdatePrompt.swift");
const APP_SWIFT = join(ROOT, "clients/ios/CongressTrade/App.swift");
const APPS_JSON = join(ROOT, "scripts/ios-fleet/apps.json");
const PBXPROJ = join(ROOT, "clients/ios/CongressTrade.xcodeproj/project.pbxproj");
const INFO_PLIST = join(ROOT, "clients/ios/CongressTrade/Info.plist");
const STALE_MANIFEST = join(ROOT, "scripts/ios-fleet/ios-app-versions.json");

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

test("Congress.Trade copies the ios-fleet AppUpdatePrompt pin byte-for-byte", () => {
  assert.equal(sha256(COPY), sha256(PIN));
});

test("App.swift no longer defines AppUpdatePrompt", () => {
  const src = readFileSync(APP_SWIFT, "utf8");
  assert.match(src, /scripts\/ios-fleet\/AppUpdatePrompt\.swift/);
  assert.doesNotMatch(src, /^\s*enum AppUpdatePrompt\b/m);
  assert.doesNotMatch(src, /knownAppleIds/);
  assert.doesNotMatch(src, /online\.dealdex/);
});

test("the pin has no hardcoded knownAppleIds map", () => {
  const src = readFileSync(PIN, "utf8");
  assert.doesNotMatch(src, /static let knownAppleIds/);
  assert.doesNotMatch(src, /"[^"]+"\s*:\s*\d[\d_]*\s*,/);
  assert.doesNotMatch(src, /"online\.dealdex"\s*:/);
  assert.doesNotMatch(src, /"me\.grok\.dealdex"/);
  assert.match(src, /net\.dealdex/);
  assert.match(src, /AppUpdateAppleId/);
});

test("apps.json DealDex is live net.dealdex, not stale online.dealdex", () => {
  const apps = JSON.parse(readFileSync(APPS_JSON, "utf8"));
  const dealdex = apps.apps.dealdex;
  assert.equal(dealdex.bundleId, "net.dealdex");
  assert.equal(dealdex.appleId, 6802474288);
  assert.match(dealdex.notes, /Do not upload me\.grok\.dealdex/);
  assert.match(dealdex.notes, /online\.dealdex is a stale leftover/);
});

test("CongressTrade target compiles the copied pin", () => {
  const pbx = readFileSync(PBXPROJ, "utf8");
  assert.match(pbx, /AppUpdatePrompt\.swift in Sources/);
  assert.match(pbx, /path = AppUpdatePrompt\.swift/);
});

test("Congress.Trade Info.plist carries AppUpdateAppleId 6798076688", () => {
  const plist = readFileSync(INFO_PLIST, "utf8");
  assert.match(plist, /<key>AppUpdateAppleId<\/key>/);
  assert.match(plist, /<integer>6798076688<\/integer>/);
});

test("vendored ios-app-versions.json stays the stale failing fixture", () => {
  const stale = JSON.parse(readFileSync(STALE_MANIFEST, "utf8"));
  assert.ok(!stale.apps["net.dealdex"], "do not rewrite the failing fixture");
  assert.equal(stale.apps["online.dealdex"]?.appleId, 6802474288);
});
