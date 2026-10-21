// The App Store Connect private key:  how it is validated, and how it is
// staged for the Apple tools that need a key on disk.
//
// AFC-459, revision 2 (Kody rule 42):  a path on disk is not an approved
// credential source at all, so this module never reads a file.  The approved
// sources are the process environment, a captured `fleet-secrets get NAME` and
// bootstrap-only Keychain credentials.  The module therefore validates a key,
// writes a mode-600 staging copy for altool and Xcode, and builds the
// allowlisted environment a child process runs with.
//
// Everything here is synthetic:  the keys are generated at test time and are
// never committed, and nothing reaches the network.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { normalizePrivateKey, writePrivateKeyFile, CLIENT_ENV_ALLOWLIST, clientEnvironment } from "./asc-key.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const helper = join(here, "asc-key.mjs");
const client = join(here, "asc-api.mjs");
const root = mkdtempSync(join(tmpdir(), "asc-key-test-"));
//  A PATH with node and nothing else:  the fleet reader lives in the operator's
//  own bin directory, and a test must never reach it or Infisical.
const safePath = [dirname(process.execPath), "/usr/bin", "/bin"].join(":");
//  Two key pairs:  the first one signs the requests, the second one only ever
//  appears in a named key file, so a test can tell which key was used.
const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const keyPem = pair.privateKey.export({ type: "pkcs8", format: "pem" });
const otherPair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const otherPem = otherPair.privateKey.export({ type: "pkcs8", format: "pem" });

function staged(name, content = keyPem, mode = 0o600) {
  const path = join(root, name);
  writeFileSync(path, content);
  chmodSync(path, mode);
  return path;
}

function run(args, stdin = "", env = undefined) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [helper, ...args], {
      ...(env ? { env } : {}),
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

function spawnNode(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function localServer() {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url, authorization: req.headers.authorization || "" });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [] }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({
      base: `http://127.0.0.1:${server.address().port}`,
      seen,
      close: () => server.close()
    }));
  });
}

function jwtKeyId(authorization) {
  const token = String(authorization || "").replace(/^Bearer /, "");
  if (!token) return null;
  return JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString()).kid;
}

//  True when the request was signed with the given key pair:  the client signs
//  with the JOSE (r||s) encoding, so the signature is verified the same way.
function jwtSignedBy(authorization, publicKey) {
  const token = String(authorization || "").replace(/^Bearer /, "");
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const verifier = createVerify("SHA256");
  verifier.update(`${parts[0]}.${parts[1]}`);
  verifier.end();
  return verifier.verify({ key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(parts[2], "base64url"));
}

test("a generated key is accepted and comes back with a trailing newline", () => {
  const normalized = normalizePrivateKey(keyPem);
  assert.ok(normalized, "a real key was refused");
  assert.ok(normalized.endsWith("\n"), "the key has to end with a newline");
  assert.equal(normalized.trim(), keyPem.trim());
});

test("a malformed PEM is refused, because the envelope is not a key", () => {
  //  A truncated key, an armored block and a mangled export all carry the
  //  envelope and still fail to parse.  Accepting them would hand the signer
  //  something it cannot use, and the failure would come back as a stack
  //  trace instead of a credential error.
  assert.equal(normalizePrivateKey("-----BEGIN PRIVATE KEY-----\nnot base64 at all\n-----END PRIVATE KEY-----\n"), null); // gitleaks:allow
  assert.equal(normalizePrivateKey("-----BEGIN PRIVATE KEY-----\n-----END PRIVATE KEY-----\n"), null); // gitleaks:allow
  assert.equal(normalizePrivateKey(""), null);
  assert.equal(normalizePrivateKey(undefined), null);
  assert.equal(normalizePrivateKey("hunter2"), null);
});

test("the module exports exactly the four approved names", async () => {
  //  The module is small on purpose:  it validates a key, stages it and builds
  //  the child's environment.  A reader, an executor or any other way in
  //  would make a path on disk a credential source again.
  const mod = await import("./asc-key.mjs");
  assert.deepEqual(
    Object.keys(mod).sort(),
    ["CLIENT_ENV_ALLOWLIST", "clientEnvironment", "normalizePrivateKey", "writePrivateKeyFile"]
  );
});

test("the module never reads a key file", () => {
  const source = readFileSync(helper, "utf8");
  assert.doesNotMatch(source, /readFileSync/, "the module reads a file");
  assert.doesNotMatch(source, /O_NOFOLLOW/, "the module opens a file with O_NOFOLLOW");
  assert.doesNotMatch(source, /readPrivateKeyFile/, "the module exposes a file reader");
  assert.doesNotMatch(source, /execWithKey/, "the module exposes a key executor");
});

test("the command line validates a key on stdin and never prints it", async () => {
  //  A key on stdout is a key in every log that captures it, so the module
  //  reports whether the key is usable and nothing else.
  const ok = await run(["validate"], keyPem);
  assert.equal(ok.code, 0, `the key was refused: ${ok.stderr}`);
  assert.match(ok.stdout, /is a PEM private key/, `the status was not reported:\n${ok.stdout}`);
  assert.doesNotMatch(ok.stdout, /PRIVATE KEY/, "the key reached stdout");
  assert.doesNotMatch(ok.stderr, /PRIVATE KEY/, "the key reached stderr");
});

test("the command line refuses a value that is not a key", async () => {
  const bad = await run(["validate"], "not a private key at all");
  assert.notEqual(bad.code, 0);
  assert.match(bad.stderr, /not a PEM private key/);
  assert.equal(bad.stdout, "", "a refused key must not put anything on stdout");
});

test("there is no read subcommand and no exec subcommand", async () => {
  //  Revision 2 removed both:  a path on disk is not an approved credential
  //  source, so there is nothing for them to do.
  const path = staged("no-such-command.p8");
  const read = await run(["read", path]);
  assert.notEqual(read.code, 0, "the module still has a read subcommand");
  assert.match(read.stderr, /usage: asc-key\.mjs validate \| write <path>/);

  const exec = await run(["exec", path, "--", process.execPath, "-e", "process.exit(0)"]);
  assert.notEqual(exec.code, 0, "the module still has an exec subcommand");
  assert.match(exec.stderr, /usage: asc-key\.mjs validate \| write <path>/);
});

test("the command line writes a key to a file only its owner can read", async () => {
  const path = join(root, "written.p8");
  const result = await run(["write", path], keyPem);
  assert.equal(result.code, 0, `the write failed: ${result.stderr}`);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(readFileSync(path, "utf8").trim(), keyPem.trim());
});

test("the command line refuses to write a value that is not a key", async () => {
  const path = join(root, "refused.p8");
  const result = await run(["write", path], "not a private key");
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /not a PEM private key/);
  assert.equal(existsSync(path), false, "a refused key must not leave a file behind");
});

test("writePrivateKeyFile normalizes the key and refuses anything else", () => {
  const path = join(root, "direct.p8");
  const written = writePrivateKeyFile(path, keyPem.replace(/\r\n/g, "\n"));
  assert.ok(written.pem, `the write failed: ${written.error}`);
  assert.equal(written.pem.endsWith("\n"), true);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const refused = writePrivateKeyFile(join(root, "direct-bad.p8"), "hunter2");
  assert.ok(refused.error, "a value that is not a key was written");
  assert.match(refused.error, /not a PEM private key/);
});

test("the child's environment is an allowlist, never a copy of the parent's", () => {
  //  A wholesale copy hands every credential on the operator's machine to the
  //  child, including the ones that have nothing to do with App Store Connect.
  const child = clientEnvironment({
    PATH: "/usr/bin:/bin",
    HOME: "/tmp/home",
    ASC_KEY_ID: "SYNTHETICKEYID1",
    ASC_ISSUER_ID: "synthetic-issuer",
    SECRET_TOKEN: "not-for-the-child"
  });
  assert.equal(child.PATH, "/usr/bin:/bin");
  assert.equal(child.HOME, "/tmp/home");
  assert.equal(child.ASC_KEY_ID, "SYNTHETICKEYID1");
  assert.equal(child.SECRET_TOKEN, undefined, "a credential crossed over to the child");
  assert.ok(!Object.keys(child).includes("ASC_KEY_P8"), "the key belongs in no inherited variable");
  assert.ok(!CLIENT_ENV_ALLOWLIST.includes("ASC_KEY_P8"), "the key must not be an inherited variable");
  //  The key is added separately, by the caller that owns it.
  const withKey = clientEnvironment({ PATH: "/usr/bin:/bin" }, { ASC_KEY_P8: keyPem });
  assert.equal(withKey.ASC_KEY_P8, keyPem);
});

test("the client takes the key from the environment and ignores a named ASC_KEY_PATH", async () => {
  //  The environment wins over a named file:  a stale or foreign path in an
  //  operator's shell must never decide which key signs the request.
  const server = await localServer();
  try {
    const result = await spawnNode([client, "GET", `${server.base}/v1/apps`], {
      PATH: safePath,
      HOME: join(root, "home-client"),
      FLEET_SECRETS_BIN: join(root, "no-fleet-secrets"),
      ASC_API_BASE: server.base,
      ASC_KEY_ID: "SYNTHETICKEYID1",
      ASC_ISSUER_ID: "synthetic-issuer",
      ASC_KEY_P8: keyPem,
      ASC_KEY_PATH: staged("named-client.p8", otherPem)
    });
    assert.equal(result.code, 0, `the client failed: ${result.stderr}`);
    assert.match(result.stderr, /asc-auth: using ASC_KEY_P8 environment/,
      `the client did not report the environment source:\n${result.stderr}`);
    assert.doesNotMatch(result.stderr, /ASC_KEY_PATH/, "the client talked about a named path");
    assert.ok(server.seen.length > 0, "the client never reached App Store Connect");
    assert.equal(jwtKeyId(server.seen[0].authorization), "SYNTHETICKEYID1");
    assert.ok(jwtSignedBy(server.seen[0].authorization, pair.publicKey),
      "the request was not signed with the key from the environment");
    assert.ok(!jwtSignedBy(server.seen[0].authorization, otherPair.publicKey),
      "the request was signed with the key from the named file");
    assert.doesNotMatch(result.stdout + result.stderr, /BEGIN PRIVATE KEY/,
      "the key reached the client's output");
  } finally {
    server.close();
  }
});

test("a named ASC_KEY_PATH is not a credential for the client either", async () => {
  //  With a named file and no key in the environment the client has no
  //  credential at all:  a path on disk is not an approved source, and the
  //  refusal says so.
  const result = await spawnNode([client, "GET", "http://127.0.0.1:1/v1/apps"], {
    PATH: safePath,
    HOME: join(root, "home-empty"),
    FLEET_SECRETS_BIN: join(root, "no-fleet-secrets"),
    ASC_API_BASE: "http://127.0.0.1:1",
    ASC_KEY_ID: "SYNTHETICKEYID1",
    ASC_ISSUER_ID: "synthetic-issuer",
    ASC_KEY_PATH: staged("named-only.p8", otherPem)
  });
  assert.equal(result.code, 1, `expected the refusal exit, got ${result.code}: ${result.stderr}`);
  assert.match(result.stderr, /no App Store Connect credential found/);
  assert.match(result.stderr, /A path in ASC_KEY_PATH is not a credential source/);
});

test("the client source never reads a key path", () => {
  const source = readFileSync(client, "utf8");
  assert.doesNotMatch(source, /process\.env\.ASC_KEY_PATH/, "the client reads a named key path");
  assert.doesNotMatch(source, /fromFile/, "the client still has a file reader");
});
