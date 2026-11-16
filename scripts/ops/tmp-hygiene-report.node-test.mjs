import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  MARKER_MAX_AGE_MS,
  assertTmpfilesPolicy,
  shouldAgeOut,
} from './tmp-hygiene-policy.mjs';

const policyPath = new URL('./tmpfiles.d/fleet-tmp-hygiene.conf', import.meta.url);
const reportPath = new URL('./tmp-hygiene-report.sh', import.meta.url);

test('the tmpfiles policy only ages allowlisted marker paths', () => {
  const text = readFileSync(policyPath, 'utf8');
  const lines = assertTmpfilesPolicy(text);
  const removals = lines.filter((line) => line.type === 'r').map((line) => line.path);
  assert.deepEqual(removals, [
    '/tmp/symdb-pids/[0-9]*',
    '/tmp/symdb-pids/*-symdb-pids',
    '/tmp/*-symdb-pids',
    '/tmp/ct-coolify-restart.out',
  ]);
  assert.equal(lines.some((line) => line.type === 'R'), false);
  assert.equal(text.includes('/tmp/ctdb'), true);
});

test('stale zero-byte markers age out and live, locked, or non-empty files do not', () => {
  const now = Date.now();
  const old = now - MARKER_MAX_AGE_MS - 1000;
  const young = now - 1000;
  const live = new Set([4242]);
  const base = { kind: 'file', size: 0, flocked: false, mtimeMs: old };

  assert.equal(shouldAgeOut({ ...base, name: '111' }, { now, livePids: live }), true);
  assert.equal(shouldAgeOut({ ...base, name: '99-symdb-pids' }, { now, livePids: live }), true);
  assert.equal(shouldAgeOut({ ...base, name: '4242' }, { now, livePids: live }), false);
  assert.equal(shouldAgeOut({ ...base, name: '4242-symdb-pids' }, { now, livePids: live }), false);
  assert.equal(shouldAgeOut({ ...base, name: '111', flocked: true }, { now, livePids: new Set() }), false);
  assert.equal(shouldAgeOut({ ...base, name: '111', size: 12 }, { now, livePids: new Set() }), false);
  assert.equal(shouldAgeOut({ ...base, name: '111', mtimeMs: young }, { now, livePids: new Set() }), false);
  assert.equal(shouldAgeOut({ ...base, name: '111', kind: 'socket' }, { now, livePids: new Set() }), false);
  assert.equal(shouldAgeOut({ ...base, name: '111.lock' }, { now, livePids: new Set() }), false);
  assert.equal(shouldAgeOut({ ...base, name: '111.pid' }, { now, livePids: new Set() }), false);
  assert.equal(shouldAgeOut({ ...base, name: '111.socket' }, { now, livePids: new Set() }), false);
  assert.equal(shouldAgeOut({ ...base, name: 'notes.txt' }, { now, livePids: new Set() }), false);
});

test('the report is read-only and prints bytes, inodes, and top directories', () => {
  const src = readFileSync(reportPath, 'utf8');
  assert.doesNotMatch(src, /\b(rm|rmdir|unlink|mkdir|touch|shred|truncate)\b/);

  const syntax = spawnSync('bash', ['-n', reportPath.pathname], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);

  const root = mkdtempSync(join(tmpdir(), 'tmp-hygiene-report-'));
  const symdb = join(root, 'symdb-pids');
  const other = join(root, 'other');
  const ctdb = join(root, 'ctdb');
  mkdirSync(symdb);
  mkdirSync(other);
  mkdirSync(ctdb);
  writeFileSync(join(symdb, '111'), '');
  writeFileSync(join(symdb, 'keep.txt'), 'abcd');
  writeFileSync(join(other, 'a'), 'ef');
  writeFileSync(join(ctdb, 'db.sqlite'), 'gh');
  symlinkSync(join(other, 'a'), join(root, 'link-out'));
  const before = readFileSync(join(symdb, '111'), 'utf8');

  const run = spawnSync('bash', [reportPath.pathname, root], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, new RegExp(`^root=${root}$`, 'm'));
  assert.match(run.stdout, /^filesystem_bytes_used=\d+$/m);
  assert.match(run.stdout, /^filesystem_inodes_used=\d+$/m);
  assert.match(run.stdout, /^walk_files=4$/m);
  assert.match(run.stdout, /^walk_bytes=8$/m);
  assert.match(run.stdout, /^2\tsymdb-pids$/m);
  assert.match(run.stdout, /^1\tctdb$/m);
  assert.match(run.stdout, /^1\tother$/m);
  assert.equal(readFileSync(join(symdb, '111'), 'utf8'), before);
});

test('a long top-level listing still exits 0', () => {
  const root = mkdtempSync(join(tmpdir(), 'tmp-hygiene-many-'));
  const directories = 380;
  const pad = 'x'.repeat(180);
  try {
    for (let i = 0; i < directories; i += 1) {
      mkdirSync(join(root, `d${String(i).padStart(4, '0')}${pad}`));
    }
    // About 70KB, past one 64KB pipe. A sort|head status is not asserted:
    // head can drain a 5KB overflow before sort's next write, so 141 is a race.
    const lineBytes = `0\td0000${pad}\n`.length;
    assert.ok(directories * lineBytes > 65_536);
    const run = spawnSync('bash', [reportPath.pathname, root], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const listed = run.stdout.split('\n').filter((line) => /^\d+\td\d{4}x{180}$/.test(line));
    assert.equal(listed.length, 10);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an unreadable directory does not abort the report', () => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) return;
  const root = mkdtempSync(join(tmpdir(), 'tmp-hygiene-unreadable-'));
  const hidden = join(root, 'hidden');
  mkdirSync(hidden);
  writeFileSync(join(hidden, 'secret'), 'zzzz');
  writeFileSync(join(root, 'visible'), 'ab');
  chmodSync(hidden, 0);
  try {
    const run = spawnSync('bash', [reportPath.pathname, root], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr, '');
    assert.match(run.stdout, /^walk_files=1$/m);
    assert.match(run.stdout, /^walk_bytes=2$/m);
    assert.match(run.stdout, /^top_directories$/m);
  } finally {
    chmodSync(hidden, 0o755);
    rmSync(root, { recursive: true, force: true });
  }
});
