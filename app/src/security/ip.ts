/**
 * Minimal IPv4 / IPv6 parsing and CIDR checks. No network, no dependency.
 * Used by the origin lock so a range refresh stays a text paste.
 */

export type ParsedIp =
  | { kind: 'v4'; value: number }
  | { kind: 'v6'; value: bigint };

export function parseIp(raw: string | null | undefined): ParsedIp | null {
  if (!raw) return null;
  let text = raw.trim();
  if (!text) return null;
  if (text.toLowerCase() === 'localhost') text = '127.0.0.1';
  if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(text)) {
    text = text.slice(0, text.lastIndexOf(':'));
  }
  if (text.startsWith('[')) {
    const end = text.indexOf(']');
    if (end > 1) text = text.slice(1, end);
  }
  const zone = text.indexOf('%');
  if (zone >= 0) text = text.slice(0, zone);

  const mapped = text.toLowerCase().match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) {
    const v4 = ipv4ToInt(mapped[1]);
    return v4 === null ? null : { kind: 'v4', value: v4 };
  }
  if (text.includes('.')) {
    const v4 = ipv4ToInt(text);
    return v4 === null ? null : { kind: 'v4', value: v4 };
  }
  const v6 = ipv6ToBigInt(text);
  return v6 === null ? null : { kind: 'v6', value: v6 };
}

export function formatIp(ip: ParsedIp): string {
  if (ip.kind === 'v4') {
    return [24, 16, 8, 0].map((shift) => ((ip.value >>> shift) & 255).toString()).join('.');
  }
  const groups: string[] = [];
  let value = ip.value;
  for (let i = 0; i < 8; i++) {
    groups.unshift((value & 0xffffn).toString(16));
    value >>= 16n;
  }
  let bestStart = -1;
  let bestLen = 0;
  let runStart = -1;
  for (let i = 0; i <= groups.length; i++) {
    const zero = i < groups.length && groups[i] === '0';
    if (zero && runStart < 0) runStart = i;
    if (!zero && runStart >= 0) {
      const len = i - runStart;
      if (len > bestLen) {
        bestStart = runStart;
        bestLen = len;
      }
      runStart = -1;
    }
  }
  if (bestLen < 2) return groups.join(':');
  const left = groups.slice(0, bestStart).join(':');
  const right = groups.slice(bestStart + bestLen).join(':');
  return `${left}::${right}`;
}

export function ipInCidr(ip: ParsedIp, cidr: string): boolean {
  const slash = cidr.lastIndexOf('/');
  if (slash <= 0) return false;
  const bits = Number(cidr.slice(slash + 1));
  const network = parseIp(cidr.slice(0, slash));
  if (!network || network.kind !== ip.kind || !Number.isInteger(bits)) return false;
  if (ip.kind === 'v4' && network.kind === 'v4') {
    if (bits < 0 || bits > 32) return false;
    const mask = bits === 0 ? 0 : (0x100000000 - 2 ** (32 - bits)) >>> 0;
    return (ip.value & mask) === (network.value & mask);
  }
  if (ip.kind === 'v6' && network.kind === 'v6') {
    if (bits < 0 || bits > 128) return false;
    if (bits === 0) return true;
    const shift = BigInt(128 - bits);
    return (ip.value >> shift) === (network.value >> shift);
  }
  return false;
}

export function ipInAnyCidr(ip: ParsedIp, cidrs: readonly string[]): boolean {
  for (const cidr of cidrs) {
    if (ipInCidr(ip, cidr)) return true;
  }
  return false;
}

function ipv4ToInt(text: string): number | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^[0-9]{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

function ipv6ToBigInt(text: string): bigint | null {
  let body = text;
  if (body.includes('.')) {
    const lastColon = body.lastIndexOf(':');
    if (lastColon < 0) return null;
    const v4 = ipv4ToInt(body.slice(lastColon + 1));
    if (v4 === null) return null;
    const hi = ((v4 >>> 16) & 0xffff).toString(16);
    const lo = (v4 & 0xffff).toString(16);
    body = `${body.slice(0, lastColon + 1)}${hi}:${lo}`;
  }
  const lower = body.toLowerCase();
  const halves = lower.split('::');
  if (halves.length > 2) return null;
  const parseSide = (side: string): string[] | null => {
    if (!side) return [];
    const groups = side.split(':');
    for (const group of groups) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    }
    return groups;
  };
  let groups: string[];
  if (halves.length === 2) {
    const left = parseSide(halves[0]);
    const right = parseSide(halves[1]);
    if (!left || !right || left.length + right.length > 7) return null;
    groups = [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  } else {
    const all = parseSide(lower);
    if (!all || all.length !== 8) return null;
    groups = all;
  }
  if (groups.length !== 8) return null;
  let out = 0n;
  for (const group of groups) {
    out = (out << 16n) + BigInt(parseInt(group, 16));
  }
  return out;
}
