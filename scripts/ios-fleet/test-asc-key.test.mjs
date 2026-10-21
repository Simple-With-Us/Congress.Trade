// The staged App Store Connect key file:  how it is validated, and how it is
// read.
//
// The private key is a secret, and the approved secret sources are the
// process environment, a captured `fleet-secrets get NAME` and bootstrap-only
// Keychain credentials.  A caller-supplied file is not one of them, so the
// node client never reads a key file:  the shell layer that owns the
// credential reads the staged key and hands it over in the environment.  These
// tests cover that reader, because it is the one place a file is read.
//
// Everything here is synthetic:  the keys are generated at test time and are
// never committed, and nothing reaches the network.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { normalizePrivateKey, readPrivateKeyFile } from "./asc-key.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const helper = join(here, "asc-key.mjs");
const client = join(here, "asc-api.mjs");
const root = mkdtempSync(join(tmpdir(), "asc-key-test-"));
//  A PATH with node and nothing else:  the fleet reader lives in the operator's
//  own bin directory, and a test must never reach it or Infisical.
const safePath = [dirname(process.execPath), "/usr/bin", "/bin"].join(":");

const keyPem = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey
  .export({ type: "pkcs8", format: "pem" });

function staged(name, content = keyPem, mode = 0o600) {
  const path = join(root, name);
  writeFileSync(path, content);
  chmodSync(path, mode);
  return path;
}

function run(args, stdin = "") {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [helper, ...args], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
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

test("a staged key file is read and its key is returned", () => {
  const path = staged("good.p8");
  const read = readPrivateKeyFile(path);
  assert.ok(read.pem, `the staged key was not read: ${read.error}`);
  assert.equal(read.pem.trim(), keyPem.trim());
});

test("a path that names nothing is reported apart from every other failure", () => {
  //  A path that names nothing is not a credential, so the caller falls
  //  through to the next source instead of aborting the run.
  const read = readPrivateKeyFile(join(root, "no-such-key.p8"));
  assert.equal(read.missing, true);
  assert.equal(read.error, undefined);
});

test("a symlink is refused rather than followed", () => {
  //  Every ordinary file read follows a symlink, so a path that looks like a
  //  key file could resolve to something else entirely.  The path is opened
  //  once with O_NOFOLLOW, so the symlink is never followed.
  const target = staged("target.p8");
  const link = join(root, "linked.p8");
  symlinkSync(target, link);
  const read = readPrivateKeyFile(link);
  assert.ok(read.error, "a symlinked key path was read");
  assert.match(read.error, /symbolic link/);
});

test("a key file other users can read is refused", () => {
  //  A private key another user can read is already leaked.
  const path = staged("loose.p8", keyPem, 0o644);
  const read = readPrivateKeyFile(path);
  assert.ok(read.error, "a key file readable by others was accepted");
  assert.match(read.error, /readable by others/);
});

test("a file that is not a private key is refused", () => {
  const path = staged("not-a-key.p8", "hunter2 this is not a private key\n");
  const read = readPrivateKeyFile(path);
  assert.ok(read.error, "a file that is not a key was accepted");
  assert.match(read.error, /does not hold a PEM private key/);
});

test("the command line reports the status of a staged key and never prints it", async () => {
  //  A key on stdout is a key in every log that captures it, so the reader
  //  reports whether the file is usable and nothing else.
  const path = staged("cli.p8");
  const ok = await run(["read", path]);
  assert.equal(ok.code, 0, `the staged key was refused: ${ok.stderr}`);
  assert.match(ok.stdout, /holds a PEM private key/, `the status was not reported:\n${ok.stdout}`);
  assert.doesNotMatch(ok.stdout, /PRIVATE KEY/, "the key reached stdout");
  assert.doesNotMatch(ok.stderr, /PRIVATE KEY/, "the key reached stderr");

  const missing = await run(["read", join(root, "no-such-key.p8")]);
  assert.equal(missing.code, 3, "a path that names nothing must report EXIT_MISSING");
  assert.match(missing.stderr, /does not exist/);
  assert.equal(missing.stdout, "", "a missing key must not put anything on stdout");

  const malformed = await run(["read", staged("bad.p8", "this is not a private key\n")]);
  assert.equal(malformed.code, 1, "a file that is not a key must be refused");
  assert.match(malformed.stderr, /does not hold a PEM private key/);
  assert.equal(malformed.stdout, "", "a refused key must not put anything on stdout");
});

test("the key never travels in the command arguments", async () => {
  //  The key goes in on stdin, and the command reports the status of it
  //  without printing it, so it is never an argument of any process and never
  //  on stdout.
  const result = await run(["validate"], keyPem);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /is a PEM private key/, `the status was not reported:\n${result.stdout}`);
  assert.doesNotMatch(result.stdout, /PRIVATE KEY/, "the key reached stdout");
  assert.ok(!result.stderr.includes("PRIVATE KEY"), "the key envelope reached a log line");
});

test("the exec command hands the key to the child in its environment", async () => {
  //  This is the handoff the hosted runner uses:  the staged key reaches the
  //  consumer in the child's environment, and in nowhere else.  Not in an
  //  argument, not on stdout, not on stderr, not in a log line.
  const path = staged("exec.p8");
  const child = await run(["exec", path, "--", process.execPath, "-e",
    "process.stdout.write('seen:' + (process.env.ASC_KEY_P8 ? 'yes' : 'no') + ':' + String(process.env.ASC_KEY_P8 || '').length)"]);
  assert.equal(child.code, 0, `the child did not run: ${child.stderr}`);
  assert.match(child.stdout, /^seen:yes:\d+$/, `the child did not receive the key:\n${child.stdout}`);
  assert.doesNotMatch(child.stdout + child.stderr, /PRIVATE KEY/, "the key reached the output");
});

test("the exec command reports a missing key and passes the child's exit code on", async () => {
  const missing = await run(["exec", join(root, "no-such-key.p8"), "--", process.execPath, "-e", "process.exit(0)"]);
  assert.equal(missing.code, 3, "a path that names nothing must report EXIT_MISSING");
  assert.match(missing.stderr, /does not exist/);

  const path = staged("exit.p8");
  const child = await run(["exec", path, "--", process.execPath, "-e", "process.exit(7)"]);
  assert.equal(child.code, 7, "the child's exit code was not passed on");
});

test("the command line writes a key to a file only its owner can read", async () => {
  const path = join(root, "written.p8");
  const result = await run(["write", path], keyPem);
  assert.equal(result.code, 0, `the write failed: ${result.stderr}`);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(readFileSync(path, "utf8").trim(), keyPem.trim());
});

test("the command line refuses a value that is not a key", async () => {
  const path = join(root, "refused.p8");
  const result = await run(["write", path], "not a private key");
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /not a PEM private key/);
});

// The client, driven the way the shell layer drives it:  the reader hands the
// staged key to the client in the child's environment, and the client takes the
// key from the environment.  The client reads no file at all, which is why the
// path is in the environment here and the file is still the credential in play.

function localServer({ holdFirst = 0 } = {}) {
  const seen = [];
  let requests = 0;
  const server = createServer((req, res) => {
    seen.push({ url: req.url, authorization: req.headers.authorization || "" });
    requests += 1;
    //  The first request is held open, so the child process is still alive
    //  while the process table is read.
    const delay = requests === 1 ? holdFirst : 0;
    setTimeout(() => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [] }));
    }, delay);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({
      base: `http://127.0.0.1:${server.address().port}`,
      seen,
      close: () => server.close()
    }));
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

//  A throwaway HOME keeps the fleet reader out of the way, so the client
//  really has no source left in the tests that want none.
function clientHome(name) {
  const home = join(root, name);
  mkdirSync(home, { recursive: true });
  return home;
}

function jwtKeyId(authorization) {
  const token = String(authorization || "").replace(/^Bearer /, "");
  if (!token) return null;
  return JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString()).kid;
}

test("the staged key reaches the client through the environment", async () => {
  //  This is the hosted CI path end to end:  the runner stages the key to a
  //  mode-600 file and publishes only its path, the hardened reader hands
  //  that key to the client in the child's environment, and the client takes
  //  the key from the environment.
  const path = staged("ci.p8");
  const server = await localServer();
  try {
    const result = await spawnNode([
      helper, "exec", path, "--", process.execPath, client, "GET", `${server.base}/v1/apps`
    ], {
      PATH: safePath,
      HOME: clientHome("home-ci"),
      ASC_KEY_ID: "SYNTHETICKEYID1",
      ASC_ISSUER_ID: "synthetic-issuer",
      ASC_KEY_PATH: path
    });
    assert.match(result.stderr, /asc-auth: using ASC_KEY_P8 environment/,
      `the client did not take the key from the environment:\n${result.stderr}`);
    assert.doesNotMatch(result.stderr, /using ASC_KEY_PATH environment/);
    assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE KEY/, "the key reached the output");
    assert.equal(jwtKeyId(server.seen[0] && server.seen[0].authorization), "SYNTHETICKEYID1",
      "the request was not signed with the staged key");
  } finally {
    server.close();
  }
});

test("the child client reports the ASC_KEY_P8 environment source", async () => {
  const server = await localServer();
  try {
    const result = await spawnNode([
      helper, "exec", staged("client.p8"), "--", process.execPath, client, "GET", `${server.base}/v1/apps`
    ], {
      PATH: safePath,
      HOME: clientHome("home-client"),
      ASC_KEY_ID: "SYNTHETICKEYID1",
      ASC_ISSUER_ID: "synthetic-issuer"
    });
    assert.match(result.stderr, /asc-auth: using ASC_KEY_P8 environment/,
      `the client did not report the environment source:\n${result.stderr}`);
    assert.equal(jwtKeyId(server.seen[0] && server.seen[0].authorization), "SYNTHETICKEYID1",
      "the request was not signed with the staged key");
  } finally {
    server.close();
  }
});

test("with no staged key and no ambient key the client reports that it has no credential", async () => {
  const result = await spawnNode([client, "GET", "http://127.0.0.1:1/v1/apps"], {
    //  A bare PATH and a throwaway HOME keep the fleet reader out of the way,
    //  so the client really has no source left.
    PATH: "/usr/bin:/bin",
    HOME: clientHome("home-empty"),
    ASC_KEY_ID: "SYNTHETICKEYID1",
    ASC_ISSUER_ID: "synthetic-issuer"
  });
  assert.equal(result.code, 1, `expected the refusal exit, got ${result.code}: ${result.stderr}`);
  assert.match(result.stderr, /no App Store Connect credential found/);
});

test("the client never reads a key file", async () => {
  //  A named path in the environment is not a credential source, so the client
  //  refuses instead of reading it, and it says why.
  const path = staged("never-read.p8");
  const result = await spawnNode([client, "GET", "http://127.0.0.1:1/v1/apps"], {
    PATH: "/usr/bin:/bin",
    HOME: clientHome("home-noread"),
    ASC_KEY_ID: "SYNTHETICKEYID1",
    ASC_ISSUER_ID: "synthetic-issuer",
    ASC_KEY_PATH: path
  });
  assert.equal(result.code, 1, `expected the refusal exit, got ${result.code}: ${result.stderr}`);
  assert.match(result.stderr, /no App Store Connect credential found/);
  assert.match(result.stderr, /ASC_KEY_PATH is not a credential source/);
});

test("the key never reaches argv and never reaches the output", async () => {
  const needle = keyPem.split("\n").find((line) => line.length > 32);
  const server = await localServer({ holdFirst: 1500 });
  const path = staged("argv.p8");
  const running = spawnNode([
    helper, "exec", path, "--", process.execPath, client, "GET", `${server.base}/v1/apps`
  ], {
    PATH: safePath,
    HOME: clientHome("home-argv"),
    ASC_KEY_ID: "SYNTHETICKEYID1",
    ASC_ISSUER_ID: "synthetic-issuer",
    ASC_KEY_PATH: path
  });
  try {
    //  While the client is waiting on App Store Connect, no process may carry
    //  the key in its command line.
    await new Promise((resolve) => setTimeout(resolve, 700));
    const table = execFileSync("ps", ["-A", "-o", "args="], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
    assert.ok(!table.includes(needle), "the key reached a command line");
    const result = await running;
    assert.doesNotMatch(result.stdout + result.stderr, /BEGIN PRIVATE KEY/,
      "the key reached the output");
    const signed = server.seen.filter((entry) => jwtKeyId(entry.authorization) === "SYNTHETICKEYID1");
    assert.ok(signed.length >= 1, `only ${signed.length} of the requests carried the staged key`);
  } finally {
    server.close();
  }
});
