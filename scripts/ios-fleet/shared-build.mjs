// Pure build planner.  No network, uploads or release state changes.
// One shared merge-timestamp build per app across iOS and macOS (owner, Oct 29 2026).
// build = max(S, M + 1), where S is the committer date of the commit being
// built (HEAD, the squash-merge commit on main) in America/Chicago as
// YYYYMMDDHHMM, and M is the highest first numeric component among every
// build of the app on iOS and macOS (expired included, all version trains)
// plus every extra floor.  Every build counts, iOS timestamp-style builds
// included.  There is no floor, but the plan is capped at 12 digits:  a
// result above 999999999999 throws instead of emitting a build the ship's
// 12-digit gate would reject.  A rebuild of the same commit still goes up:
// the first ship of a commit plans S, the next one M + 1.
export function nextSharedBuild({iosBuilds, macBuilds, extraFloors = [], complete, mergeStamp}) {
  if (complete !== true || !Array.isArray(iosBuilds) || !Array.isArray(macBuilds)) {
    throw new Error('complete build inventory required');
  }
  if (typeof mergeStamp !== 'string' || !/^[1-9][0-9]{11}$/.test(mergeStamp)) {
    throw new Error('malformed merge stamp');
  }
  if (!Array.isArray(extraFloors)) throw new Error('malformed build inventory');
  for (const floor of extraFloors) {
    if (typeof floor === 'number') {
      if (!Number.isSafeInteger(floor) || floor < 0) throw new Error('malformed build inventory');
    } else if (typeof floor !== 'string' || !/^[0-9]+$/.test(floor)) {
      throw new Error('malformed build inventory');
    }
  }
  // Validate everything before computing; malformed evidence is never ignored.
  const re = /^[0-9]+(\.[0-9]+){0,2}$/;
  for (const value of [...iosBuilds, ...macBuilds]) {
    if (typeof value !== 'string' || !re.test(value)) throw new Error('malformed build inventory');
  }
  let next = BigInt(mergeStamp);
  for (const value of [...iosBuilds, ...macBuilds]) {
    const candidate = BigInt(value.split('.')[0]) + 1n;
    if (candidate > next) next = candidate;
  }
  for (const floor of extraFloors) {
    const candidate = BigInt(floor) + 1n;
    if (candidate > next) next = candidate;
  }
  const build = String(next);
  if (build.length > 12) throw new Error('planned build exceeds 12 digits');
  return {build};
}
