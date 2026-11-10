#!/usr/bin/env node
/**
 * Vendor-era shared-package pin check for Congress.Trade.
 *
 * CT no longer npm-installs @jaywedgeworth22/congress-trading-shared. Deno
 * resolves it from app/vendor/congress-trading-shared (see VENDOR-PROVENANCE.md).
 * Peer apps (Socratic.Trade, Usage-Monitor) still npm-pin the git tag.
 *
 * Hard fails (local):
 *   1. VENDOR-PROVENANCE.md parse (release + commit)
 *   2. vendor package.json version matches provenance release (without leading v)
 *   3. deno.json + app/deno.json map the package to the vendor src/index.ts
 *   4. root/app package.json do not reintroduce an npm dependency on shared
 *
 * Soft peer check (when GH_TOKEN / GITHUB_TOKEN can read peer repos):
 *   peer package-lock resolved ref after '#' must equal the provenance commit
 *   (annotated tags like v2.0.0 are accepted when the lock resolves to that sha).
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PKG = "@jaywedgeworth22/congress-trading-shared";
const PROVENANCE_PATH = join(ROOT, "app/vendor/congress-trading-shared/VENDOR-PROVENANCE.md");
const VENDOR_PKG_PATH = join(ROOT, "app/vendor/congress-trading-shared/package.json");
const PEERS = [
  { repo: "Simple-With-Us/Socratic-Trade", lockPath: "package-lock.json" },
  { repo: "Simple-With-Us/Usage-Monitor", lockPath: "package-lock.json" },
];

function read(path) {
  return readFileSync(path, "utf8");
}

function fail(msg) {
  console.error(`::error::${msg}`);
  process.exit(1);
}

function parseProvenance(text) {
  const release = text.match(/^- Immutable release:\s*`([^`]+)`/m)?.[1];
  const commit = text.match(/^- Commit:\s*`([0-9a-f]{40})`/m)?.[1];
  if (!release || !commit) {
    fail(`could not parse release/commit from ${PROVENANCE_PATH}`);
  }
  return { release, commit };
}

function assertImportMaps(expectedSuffix) {
  for (const rel of ["deno.json", "app/deno.json"]) {
    const path = join(ROOT, rel);
    const json = JSON.parse(read(path));
    const mapped = json?.imports?.[PKG];
    if (!mapped) fail(`${rel}: missing imports["${PKG}"]`);
    const normalized = mapped.replace(/^\.\//, "");
    if (!normalized.endsWith(expectedSuffix) && mapped !== expectedSuffix && !mapped.endsWith(`/${expectedSuffix}`)) {
      // Accept either "./vendor/.../src/index.ts" or "./app/vendor/.../src/index.ts"
      if (!mapped.includes("vendor/congress-trading-shared/src/index.ts")) {
        fail(`${rel}: imports["${PKG}"] must point at vendored src/index.ts (got ${mapped})`);
      }
    }
  }
}

function assertNoNpmDep() {
  for (const rel of ["package.json", "app/package.json"]) {
    const path = join(ROOT, rel);
    if (!existsSync(path)) continue;
    const json = JSON.parse(read(path));
    for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      if (json[field]?.[PKG]) {
        fail(`${rel}: unexpected npm ${field} entry for ${PKG} (CT is vendor-only)`);
      }
    }
  }
}

function stripRef(resolved) {
  if (!resolved) return "";
  const hash = resolved.lastIndexOf("#");
  return hash === -1 ? resolved : resolved.slice(hash + 1);
}

async function peerLockRef(repo, lockPath, token) {
  const url = `https://api.github.com/repos/${repo}/contents/${lockPath}`;
  const res = await fetch(url, {
    headers: {
      Accept: "application/vnd.github.raw",
      Authorization: `Bearer ${token}`,
      "User-Agent": "congress-trade-shared-pin-check",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    return { ok: false, status: res.status, ref: "" };
  }
  const lock = JSON.parse(await res.text());
  const entry = lock.packages?.[`node_modules/${PKG}`] || {};
  const resolved = entry.resolved || entry.version || "";
  return { ok: true, status: res.status, ref: stripRef(resolved), resolved };
}

async function main() {
  if (!existsSync(PROVENANCE_PATH)) fail(`missing ${PROVENANCE_PATH}`);
  const provenance = parseProvenance(read(PROVENANCE_PATH));
  const vendorPkg = JSON.parse(read(VENDOR_PKG_PATH));
  const releaseNoV = provenance.release.replace(/^v/, "");
  if (vendorPkg.version !== releaseNoV) {
    fail(
      `vendor package.json version ${vendorPkg.version} != provenance release ${provenance.release}`,
    );
  }
  console.log(`Provenance: ${provenance.release} @ ${provenance.commit}`);
  console.log(`Vendor package.json version: ${vendorPkg.version}`);

  assertImportMaps("vendor/congress-trading-shared/src/index.ts");
  console.log("OK: Deno import maps point at vendored src/index.ts");

  assertNoNpmDep();
  console.log("OK: CT package.json files do not npm-depend on shared");

  const token = process.env.GH_PACKAGES_TOKEN || process.env.GITHUB_TOKEN || "";
  if (!token) {
    console.log("::notice::No GH_PACKAGES_TOKEN/GITHUB_TOKEN — skipping peer lock comparison");
    return;
  }

  let peerHardFail = process.env.SHARED_PIN_PEER_REQUIRED === "1";
  for (const peer of PEERS) {
    const result = await peerLockRef(peer.repo, peer.lockPath, token);
    if (!result.ok) {
      const msg = `could not fetch ${peer.repo}/${peer.lockPath} (HTTP ${result.status})`;
      if (peerHardFail) fail(msg);
      console.log(`::warning::${msg} — skipping`);
      continue;
    }
    if (!result.ref) {
      const msg = `${PKG} missing from ${peer.repo}/${peer.lockPath}`;
      if (peerHardFail) fail(msg);
      console.log(`::warning::${msg} — peer may not have adopted shared yet`);
      continue;
    }
    // Accept exact commit or the release tag when lock still points at the tag name.
    const ok =
      result.ref === provenance.commit ||
      result.ref === provenance.release ||
      result.ref === releaseNoV;
    if (!ok) {
      fail(
        `${PKG} peer drift: ${peer.repo} lock ref '${result.ref}' != provenance commit ${provenance.commit} / ${provenance.release}`,
      );
    }
    console.log(`OK: ${peer.repo} lock ref ${result.ref} matches provenance`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
