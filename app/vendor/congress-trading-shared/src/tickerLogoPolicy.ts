/**
 * Per-ticker, per-theme company-logo source order shared by Congress.Trade
 * and Socratic.Trade.
 *
 * Owner jury letters:
 *   A = GitHub pack on a light plate
 *   B = GitHub pack on a dark plate
 *   C = logo.dev light
 *   D = logo.dev dark
 *
 * GitHub ships one PNG; A vs B is that file on light vs dark chrome.
 * logo.dev can ship two theme variants (rarely different in practice).
 *
 * `local` means an app-hosted file (CT repo pack / ST disk upload). Serving
 * and caching stay in each app. Seeded from the 2026-08-23 CT top-30 jury.
 */

export type LogoSource = "local" | "github" | "logodev";
export type LogoTheme = "light" | "dark";

export interface SymbolLogoPolicy {
  light: LogoSource[];
  dark: LogoSource[];
  notes?: string;
}

export type TickerLogoPolicyMap = Record<string, SymbolLogoPolicy>;

/** Default when a symbol has no jury row (ABCD — any source is fine). */
export const DEFAULT_LOGO_SOURCE_ORDER: readonly LogoSource[] = Object.freeze([
  "logodev",
  "local",
  "github",
]);

/** ST historical cascade for ungraded names (GitHub first). */
export const SOCRATIC_DEFAULT_LOGO_SOURCE_ORDER: readonly LogoSource[] = Object.freeze([
  "github",
  "logodev",
]);

function ghThenLd(): LogoSource[] {
  return ["github", "logodev", "local"];
}
function ldOnly(): LogoSource[] {
  return ["logodev", "local"];
}
function ldThenGh(): LogoSource[] {
  return ["logodev", "github", "local"];
}
function ghDarkLdLight(): SymbolLogoPolicy {
  return { light: ["logodev", "local"], dark: ["github", "logodev", "local"] };
}

/**
 * Top 30 by 90-day trade count (congress.trade 2026-08-23). Omitted symbols
 * use the caller fallback (CT: DEFAULT_LOGO_SOURCE_ORDER; ST: SOCRATIC_DEFAULT).
 */
export const SEEDED_LOGO_POLICY: TickerLogoPolicyMap = {
  HUBB: { light: ldOnly(), dark: ldOnly() },
  AAPL: ghDarkLdLight(),
  NVDA: { light: ghThenLd(), dark: ghThenLd() },
  WAB: { light: ghThenLd(), dark: ghThenLd() },
  HONAV: { light: ldOnly(), dark: ldOnly(), notes: "Honeywell Aerospace disclosure name" },
  TSCO: { light: ldOnly(), dark: ldOnly() },
  ABT: { light: ghThenLd(), dark: ["github", "local"] },
  BSX: { light: ghThenLd(), dark: ldOnly() },
  SPCX: {
    light: ["local", "logodev"],
    dark: ["local", "logodev"],
    notes: "Upload a SpaceX mark; logo.dev is a stopgap",
  },
  LYV: ghDarkLdLight(),
  MA: { light: ghThenLd(), dark: ["github", "local"] },
  MSFT: { light: ghThenLd(), dark: ghThenLd() },
  HD: { light: ldThenGh(), dark: ldThenGh() },
  IBM: {
    light: ["local", "logodev"],
    dark: ["github", "logodev", "local"],
    notes: "Upload light and dark IBM marks",
  },
  MELI: { light: ghThenLd(), dark: ["github", "local"] },
  META: { light: ghThenLd(), dark: ["github", "local"] },
  UBER: {
    light: ["local", "logodev"],
    dark: ["github", "logodev", "local"],
    notes: "Upload a light-mode Uber mark",
  },
  UNH: {
    light: ["local", "logodev"],
    dark: ["github", "local"],
    notes: "Upload a light-mode UNH mark; GitHub on light is not usable",
  },
  ACN: { light: ghThenLd(), dark: ["github", "local"] },
  AMZN: ghDarkLdLight(),
  BLK: {
    light: ["local", "logodev"],
    dark: ["github", "logodev", "local"],
    notes: "Upload a light-mode BlackRock mark",
  },
  "BRK-B": { light: ldOnly(), dark: ldOnly() },
  "BRK.B": { light: ldOnly(), dark: ldOnly() },
  BRKB: { light: ldOnly(), dark: ldOnly() },
};

const POLICY_ALIASES: Record<string, string> = {
  GOOGL: "GOOGL",
  GOOG: "GOOG",
  HONAV: "HONAV",
  BRK_B: "BRK-B",
};

export function canonicalLogoPolicySymbol(symbol: string): string {
  const upper = symbol.trim().replace(/^\$/, "").toUpperCase();
  if (POLICY_ALIASES[upper]) return POLICY_ALIASES[upper];
  if (upper === "BRK.B" || upper === "BRKB" || upper === "BRK_B") return "BRK-B";
  return upper;
}

export function mergeLogoPolicy(overlay: TickerLogoPolicyMap | undefined): TickerLogoPolicyMap {
  return { ...SEEDED_LOGO_POLICY, ...(overlay ?? {}) };
}

export function sourceOrderFor(
  symbol: string,
  theme: LogoTheme,
  overlay?: TickerLogoPolicyMap,
  fallback: readonly LogoSource[] = DEFAULT_LOGO_SOURCE_ORDER,
): LogoSource[] {
  const key = canonicalLogoPolicySymbol(symbol);
  const merged = mergeLogoPolicy(overlay);
  const row = merged[key] ?? merged[symbol.toUpperCase()];
  const order = row?.[theme] ?? fallback;
  return order.filter((src, i) => order.indexOf(src) === i);
}

/** Drop `local` for apps that only fetch GitHub / logo.dev (ST after disk cache). */
export function remoteLogoSources(order: readonly LogoSource[]): Array<"github" | "logodev"> {
  return order.filter((src): src is "github" | "logodev" => src === "github" || src === "logodev");
}

export function parseLogoSources(value: unknown): LogoSource[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const out: LogoSource[] = [];
  for (const item of value) {
    if (item !== "local" && item !== "github" && item !== "logodev") return null;
    if (!out.includes(item)) out.push(item);
  }
  return out.length ? out : null;
}

export function parseSymbolLogoPolicy(value: unknown): SymbolLogoPolicy | null {
  if (!value || typeof value !== "object") return null;
  const rec = value as Record<string, unknown>;
  const light = parseLogoSources(rec.light);
  const dark = parseLogoSources(rec.dark);
  if (!light || !dark) return null;
  const notes = typeof rec.notes === "string" && rec.notes.trim() ? rec.notes.trim() : undefined;
  return notes ? { light, dark, notes } : { light, dark };
}

export function parseTickerLogoPolicyMap(value: unknown): TickerLogoPolicyMap | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out: TickerLogoPolicyMap = {};
  for (const [rawKey, rawVal] of Object.entries(value as Record<string, unknown>)) {
    const key = canonicalLogoPolicySymbol(rawKey);
    if (!/^[A-Z0-9._-]{1,20}$/.test(key)) return null;
    const parsed = parseSymbolLogoPolicy(rawVal);
    if (!parsed) return null;
    out[key] = parsed;
  }
  return out;
}

/** Letters from the owner jury (e.g. "BCD") → source lists for both themes. */
export function policyFromLetters(letters: string): SymbolLogoPolicy | null {
  const ordered = letters.toUpperCase().replace(/[^ABCD]/g, "");
  if (!ordered.length) return null;
  const light: LogoSource[] = [];
  const dark: LogoSource[] = [];
  const seenL = new Set<LogoSource>();
  const seenD = new Set<LogoSource>();
  for (const ch of ordered) {
    if (ch === "A" && !seenL.has("github")) {
      light.push("github");
      seenL.add("github");
    }
    if (ch === "C" && !seenL.has("logodev")) {
      light.push("logodev");
      seenL.add("logodev");
    }
    if (ch === "B" && !seenD.has("github")) {
      dark.push("github");
      seenD.add("github");
    }
    if (ch === "D" && !seenD.has("logodev")) {
      dark.push("logodev");
      seenD.add("logodev");
    }
  }
  if (!light.length) light.push("local");
  if (!dark.length) dark.push("local");
  if (!light.includes("local")) light.push("local");
  if (!dark.includes("local")) dark.push("local");
  return { light, dark };
}
