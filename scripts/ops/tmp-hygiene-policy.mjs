/**
 * Safety rule for stale symdb-pids markers.
 * systemd-tmpfiles cannot see file size or /proc, so the conf only names
 * marker globs and excludes sockets, locks, and pid files. This module is
 * the stricter rule tests assert, and it does not delete anything.
 */

export const MARKER_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export const REMOVAL_ALLOWLIST = new Set([
  '/tmp/symdb-pids/[0-9]*',
  '/tmp/symdb-pids/*-symdb-pids',
  '/tmp/*-symdb-pids',
  '/tmp/ct-coolify-restart.out',
]);

export const REQUIRED_EXCLUSIONS = [
  '/tmp/*.socket',
  '/tmp/*.lock',
  '/tmp/*.pid',
  '/tmp/symdb-pids/*.socket',
  '/tmp/symdb-pids/*.lock',
  '/tmp/symdb-pids/*.pid',
  '/tmp/.X11-unix',
  '/tmp/systemd-private-*',
  '/tmp/ctdb',
];

export function parseTmpfiles(text) {
  const lines = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    lines.push({
      type: parts[0],
      path: parts[1],
      age: parts[5] ?? '-',
    });
  }
  return lines;
}

export function assertTmpfilesPolicy(text) {
  const lines = parseTmpfiles(text);
  const removals = lines.filter((line) => line.type === 'r' || line.type === 'R');
  if (removals.length === 0) throw new Error('policy has no removal lines');
  for (const line of removals) {
    if (line.type === 'R') throw new Error(`recursive removal is not allowed: ${line.path}`);
    if (!REMOVAL_ALLOWLIST.has(line.path)) {
      throw new Error(`removal path is not allowlisted: ${line.path}`);
    }
    if (!line.age || line.age === '-' || line.age === '0') {
      throw new Error(`removal must have a non-zero age: ${line.path}`);
    }
  }
  const excluded = new Set(lines.filter((line) => line.type === 'x').map((line) => line.path));
  for (const path of REQUIRED_EXCLUSIONS) {
    if (!excluded.has(path)) throw new Error(`missing exclusion ${path}`);
  }
  return lines;
}

export function markerPid(name) {
  const match = /^([0-9]+)(?:-symdb-pids)?$/.exec(name);
  if (!match) return null;
  return Number(match[1]);
}

/**
 * A marker may be aged out only when it is an old zero-byte regular file,
 * not locked, and its PID (when the name is a PID) is not alive.
 * Sockets, fifos, lock names, and pid names never qualify.
 */
export function shouldAgeOut(entry, { now, livePids }) {
  if (!entry || entry.kind !== 'file') return false;
  if (entry.flocked) return false;
  if (entry.size !== 0) return false;
  const name = entry.name;
  if (name.endsWith('.socket') || name.endsWith('.lock') || name.endsWith('.pid')) return false;
  if (!/^[0-9]+$/.test(name) && !/^[0-9]+-symdb-pids$/.test(name)) return false;
  if (now - entry.mtimeMs < MARKER_MAX_AGE_MS) return false;
  const pid = markerPid(name);
  if (pid !== null && livePids.has(pid)) return false;
  return true;
}
