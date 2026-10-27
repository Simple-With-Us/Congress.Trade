// Pure build planner.  No network, uploads or release state changes.
// Single-component three-digit builds must exceed the platform's upload floor.
export function nextThreeDigitBuild({platform, trainBuilds, allPlatformBuilds, complete}) {
  if (!['IOS','MAC_OS'].includes(platform) || complete !== true || !Array.isArray(trainBuilds) || !Array.isArray(allPlatformBuilds)) throw new Error('complete platform build inventory required');
  // Validate all supplied evidence before choosing the platform-specific floor.
  // Other iOS trains do not set its floor, but malformed evidence is never ignored.
  for (const value of [...trainBuilds, ...allPlatformBuilds]) {
    if (typeof value !== 'string' || !/^[0-9]+(?:\.[0-9]+){0,2}$/.test(value)) throw new Error('malformed build inventory');
  }
  const builds = platform === 'MAC_OS' ? [...trainBuilds,...allPlatformBuilds] : trainBuilds;
  let next=100;
  for (const value of builds) {
    if (typeof value !== 'string' || !/^[0-9]+(?:\.[0-9]+){0,2}$/.test(value)) throw new Error('malformed build inventory');
    const parts=value.split('.').map(BigInt);
    // An integer n equals n.0.0.  A fractional component, however small,
    // requires the next integer above the first component.
    const first=parts[0];
    const candidate=first+1n;
    if(candidate>999n) throw new Error(`three-digit build unavailable: existing ${value} requires >=${candidate}`);
    next=Math.max(next,Number(candidate));
  }
  if(next>999) throw new Error('three-digit build range exhausted');
  return String(next);
}
