import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  APPSTORE_VERSION_PLAN_LOC_CONCURRENCY,
  ASC_GET_TIMEOUT_MS,
  appStoreVersionLocalizationsPath,
  appStoreVersionResourcePath,
  mapWithConcurrency
} from "./asc-api.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const ascSrc = readFileSync(join(here, "asc-api.mjs"), "utf8");

test("appStoreVersionLocalizationsPath encodes reserved characters in version ids", () => {
  const raw = "abc/def?x=1";
  const path = appStoreVersionLocalizationsPath(raw);
  assert.match(path, /^\/v1\/appStoreVersions\/[^/]+\/appStoreVersionLocalizations\?limit=200$/);
  assert.doesNotMatch(path, /\/abc\/def/);
  assert.ok(path.includes(encodeURIComponent(raw)));
});

test("appStoreVersionResourcePath encodes ids used as path segments", () => {
  const id = "id+special";
  assert.equal(
    appStoreVersionResourcePath(id, "/relationships/build"),
    `/v1/appStoreVersions/${encodeURIComponent(id)}/relationships/build`
  );
});

test("mapWithConcurrency runs at most limit tasks in parallel", async () => {
  const items = [0, 1, 2, 3, 4, 5, 6, 7];
  let inFlight = 0;
  let maxInFlight = 0;
  await mapWithConcurrency(items, 3, async (n) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight -= 1;
    return n * 2;
  });
  assert.ok(maxInFlight <= 3);
  assert.ok(maxInFlight >= 2);
});

test("mapWithConcurrency preserves result order", async () => {
  const out = await mapWithConcurrency([3, 2, 1], 2, async (n) => n + 10);
  assert.deepEqual(out, [13, 12, 11]);
});

test("appstore-version-plan constants match the owner concurrency and timeout targets", () => {
  assert.equal(APPSTORE_VERSION_PLAN_LOC_CONCURRENCY, 5);
  assert.equal(ASC_GET_TIMEOUT_MS, 30_000);
});

test("asc-api appstore-version-plan uses bounded concurrency and encoded localization paths", () => {
  assert.match(ascSrc, /mapWithConcurrency\(\s*\n\s*promoVersions,\s*\n\s*APPSTORE_VERSION_PLAN_LOC_CONCURRENCY/);
  assert.match(ascSrc, /appStoreVersionLocalizationsPath\(v\.id\)/);
  assert.match(ascSrc, /appStoreVersionLocalizationsPath\(id\)/);
  assert.doesNotMatch(
    ascSrc,
    /appStoreVersions\/\$\{v\.id\}\/appStoreVersionLocalizations/
  );
  assert.doesNotMatch(
    ascSrc,
    /appStoreVersions\/\$\{id\}\/appStoreVersionLocalizations/
  );
  assert.match(ascSrc, /error: `HTTP \$\{code\}`/);
  assert.match(ascSrc, /error: "timeout"/);
  assert.match(ascSrc, /AbortSignal\.timeout\(timeoutMs\)/);
});
