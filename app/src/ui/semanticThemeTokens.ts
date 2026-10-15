/**
 * Canonical buy / sell / good / warn / exchange hues for the dashboard CSS
 * variables and WCAG contrast gates.  Dark values match :root in
 * dashboardHtml.ts; light values are tuned for 4.5:1 body text on cards,
 * page chrome, and the tinted pill/badge backgrounds that reuse the same token
 * for both ink and color-mix fills.
 */

export type SemanticTokenSet = {
  buy: string;
  sell: string;
  exch: string;
  warn: string;
  good: string;
};

/** Dark theme (:root) — unchanged for CT-1356. */
export const SEMANTIC_DARK: SemanticTokenSet = {
  buy: '#22c55e',
  sell: '#ef4444',
  exch: '#eab308',
  warn: '#f59e0b',
  good: '#34d399',
};

/** Light theme (html[data-theme="light"]). */
export const SEMANTIC_LIGHT: SemanticTokenSet = {
  buy: '#166534',
  sell: '#991b1b',
  exch: '#9a3412',
  warn: '#9a3412',
  good: '#166534',
};

export const LIGHT_SEMANTIC_TEXT_SURFACES = [
  '#ffffff',
  '#eff3f8',
  '#e8eff8',
] as const;

/** Background mix percentages where semantic ink sits on a same-hue tint. */
export const LIGHT_SEMANTIC_TINT_PERCENTAGES = [6, 8, 12, 13, 14, 16, 18] as const;

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio for two sRGB hex colors. */
export function contrastRatio(foreground: string, background: string): number {
  const l1 = relativeLuminance(foreground);
  const l2 = relativeLuminance(background);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

export function mixSrgb(foreground: string, background: string, foregroundPercent: number): string {
  const p = foregroundPercent / 100;
  const fg = hexToRgb(foreground);
  const bg = hexToRgb(background);
  const mixed = fg.map((v, i) => Math.round(v * p + bg[i]! * (1 - p)));
  return `#${mixed.map((x) => x.toString(16).padStart(2, '0')).join('')}`;
}

export type SemanticContrastCase = {
  token: keyof SemanticTokenSet;
  foreground: string;
  background: string;
  ratio: number;
};

/** Every light-mode semantic text surface we regression-test. */
export function lightSemanticTextContrastCases(
  tokens: SemanticTokenSet = SEMANTIC_LIGHT,
): SemanticContrastCase[] {
  const cases: SemanticContrastCase[] = [];
  const tokenKeys: (keyof SemanticTokenSet)[] = ['buy', 'sell', 'exch', 'warn', 'good'];

  for (const token of tokenKeys) {
    const fg = tokens[token];
    for (const bg of LIGHT_SEMANTIC_TEXT_SURFACES) {
      cases.push({ token, foreground: fg, background: bg, ratio: contrastRatio(fg, bg) });
    }
    for (const pct of LIGHT_SEMANTIC_TINT_PERCENTAGES) {
      for (const bg of ['#ffffff', '#eff3f8'] as const) {
        const surface = mixSrgb(fg, bg, pct);
        cases.push({ token, foreground: fg, background: surface, ratio: contrastRatio(fg, surface) });
      }
    }
  }
  return cases;
}

export const WCAG_AA_NORMAL_TEXT = 4.5;
export const WCAG_AA_LARGE_TEXT = 3;
