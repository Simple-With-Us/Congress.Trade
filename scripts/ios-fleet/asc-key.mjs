#!/usr/bin/env node
/**
 * The App Store Connect private key: how it is validated, and how a staged
 * key file is read.
 *
 * WHY THIS IS ITS OWN MODULE (2026-10-21, Kody rule 42 on PR #271):
 * The private key is a secret, and the fleet's approved secret sources are the
 * process environment, a captured `fleet-secrets get NAME`, and bootstrap-only
 * Keychain credentials.  A caller-supplied local file is not one of them, so
 * the node client never reads a key file.  The shell layer that already owns
 * the credential reads the staged key and hands it to the client through the
 * environment; this module is the part of that handoff the shell needs.
 *
 * The file read opens the path ONCE with O_NOFOLLOW and inspects and reads the
 * descriptor it got, so a path that is swapped for a symlink between the check
 * and the read cannot be followed.  ENOENT is reported apart from every other
 * failure, because a path that names nothing is not a credential and the
 * caller falls through to the next source, while a path that names the wrong
 * file is a hard stop.
 *
 * The command line never carries key material:
 *   read <path>    check that a staged key file holds a usable key
 *   validate       check that a key on stdin holds a usable key
 *   write <path>   read a key on stdin and write it to a mode-600 file
 *   exec <path> -- <command> [args...]
 *                  run a command with the staged key in its environment
 *
 * WHY NOTHING PRINTS THE KEY (2026-10-21, Kody rule 42 on PR #271):
 * A key on stdout is a key in a log, in a CI transcript, in a process
 * listing and in whatever captures that output next.  So `read` and
 * `validate` report the STATUS of a key and never the key itself, and the
 * only way the key reaches a consumer is `exec`, which puts it in the
 * child's environment as ASC_KEY_P8:  never in an argument, never on
 * stdout, never in a log line.
 */
import { closeSync, constants, fstatSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createPrivateKey } from "node:crypto";

// A private key is a few kilobytes.  Anything larger is not one.
const MAX_KEY_BYTES = 64 * 1024;

// Normalizes a PEM private key and refuses anything that is not one.
//
// The envelope alone is not enough: a truncated key, an armored block or a
// mangled export carries the envelope and still fails to parse, and an
// unparsable key that reaches the signer comes back as a raw stack trace
// instead of a credential error.  So the key is parsed before it is accepted.
//
// Returns the normalized PEM, or null when the value is not a private key.
export function normalizePrivateKey(value) {
  const pem = String(value || "").replace(/\r\n/g, "\n").trim();
  if (!pem) return null;
  if (!/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(pem)) return null;
  try {
    createPrivateKey(pem);
  } catch {
    return null;
  }
  return pem.endsWith("\n") ? pem : `${pem}\n`;
}

// Reads a staged key file.
//
// Returns { pem } when the file holds a usable private key, { missing: true }
// when the path names nothing at all, and { error } for every other problem.
//
// The open, the inspection and the read all use one descriptor, so nothing
// that happens to the path afterwards can change what is read.
export function readPrivateKeyFile(keyPath) {
  let fd;
  try {
    fd = openSync(keyPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (err) {
    if (err && err.code === "ENOENT") return { missing: true };
    if (err && err.code === "ELOOP") {
      return { error: `the key path ${keyPath} is a symbolic link, which is not read` };
    }
    return { error: `the key file ${keyPath} could not be read` };
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) {
      return { error: `the key path ${keyPath} is not a regular file` };
    }
    if ((info.mode & 0o077) !== 0) {
      const mode = (info.mode & 0o777).toString(8).padStart(3, "0");
      return { error: `the key file ${keyPath} is readable by others (mode ${mode}); a private key has to be owner-only (chmod 600)` };
    }
    if (info.size > MAX_KEY_BYTES) {
      return { error: `the key file ${keyPath} is ${info.size} bytes, which is not a private key` };
    }
    const pem = normalizePrivateKey(readFileSync(fd, "utf8"));
    if (!pem) {
      return { error: `the key file ${keyPath} does not hold a PEM private key` };
    }
    return { pem };
  } finally {
    closeSync(fd);
  }
}

// Writes a key to a file only its owner can read.
//
// The key arrives on stdin, so it never becomes a command argument, and the
// file is created with mode 600 whatever the umask of the caller says.
export function writePrivateKeyFile(keyPath, value) {
  const pem = normalizePrivateKey(value);
  if (!pem) return { error: "the value is not a PEM private key" };
  try {
    writeFileSync(keyPath, pem, { mode: 0o600 });
  } catch {
    return { error: `the key file ${keyPath} could not be written` };
  }
  return { pem };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

// Runs a command with the staged key in its environment.
//
// The key goes into the child's environment as ASC_KEY_P8, which is where the
// client looks for it.  It is never an argument, never reaches this process's
// stdout or stderr, and never reaches a log line.
//
// The child's exit code is returned, so a caller that runs the client through
// this keeps the client's own result.
export function execWithKey(keyPath, command, args) {
  const read = readPrivateKeyFile(keyPath);
  if (read.missing) return { missing: true };
  if (read.error) return { error: read.error };
  const child = spawnSync(command, args, {
    stdio: "inherit",
    env: { ...process.env, ASC_KEY_P8: read.pem }
  });
  if (child.error) {
    return { error: `the command could not be started: ${child.error.message}` };
  }
  if (child.signal) {
    return { error: `the command was killed by ${child.signal}` };
  }
  return { status: typeof child.status === "number" ? child.status : 1 };
}

// The exit codes the shell layer reads:
//   0  the key was read
//   1  the path names something that is not a usable key
//   3  the path names nothing at all
export const EXIT_MISSING = 3;

async function main() {
  const [command, target] = process.argv.slice(2);
  if (command === "read") {
    if (!target) {
      console.error("asc-key: usage: asc-key.mjs read <path>");
      return 1;
    }
    const read = readPrivateKeyFile(target);
    if (read.missing) {
      console.error(`asc-key: the key file ${target} does not exist`);
      return EXIT_MISSING;
    }
    if (read.error) {
      console.error(`asc-key: ${read.error}`);
      return 1;
    }
    //  The status is reported and the key is not:  a key on stdout is a key
    //  in every log that captures it.
    console.log(`asc-key: ${target} holds a PEM private key`);
    return 0;
  }
  if (command === "validate") {
    const pem = normalizePrivateKey(await readStdin());
    if (!pem) {
      console.error("asc-key: the value is not a PEM private key");
      return 1;
    }
    //  The key is not printed here either:  see the read command.
    console.log("asc-key: the value is a PEM private key");
    return 0;
  }
  if (command === "write") {
    if (!target) {
      console.error("asc-key: usage: asc-key.mjs write <path>");
      return 1;
    }
    const written = writePrivateKeyFile(target, await readStdin());
    if (written.error) {
      console.error(`asc-key: ${written.error}`);
      return 1;
    }
    return 0;
  }
  if (command === "exec") {
    const rest = process.argv.slice(3);
    const separator = rest.indexOf("--");
    if (!target || separator < 0 || separator === rest.length - 1) {
      console.error("asc-key: usage: asc-key.mjs exec <path> -- <command> [args...]");
      return 1;
    }
    const child = execWithKey(target, rest[separator + 1], rest.slice(separator + 2));
    if (child.missing) {
      console.error(`asc-key: the key file ${target} does not exist`);
      return EXIT_MISSING;
    }
    if (child.error) {
      console.error(`asc-key: ${child.error}`);
      return 1;
    }
    return child.status;
  }
  console.error("asc-key: usage: asc-key.mjs read <path> | validate | write <path> | exec <path> -- <command> [args...]");
  return 1;
}

if (process.argv[1] && process.argv[1].endsWith("asc-key.mjs")) {
  main().then((code) => { process.exitCode = code; });
}
