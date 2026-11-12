/**
 * CT-2505: primary tabs expose one accessible name, and light-mode sell
 * text and badge fills meet WCAG AA.
 */

import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { DASHBOARD_HTML } from '../dashboardHtml.ts';
import { DASHBOARD_CSS } from '../dashboardStyles.ts';
import { DASHBOARD_APP_JS } from '../dashboardClient.ts';
import {
  SEMANTIC_DARK,
  SEMANTIC_LIGHT,
  WCAG_AA_LARGE_TEXT,
  WCAG_AA_NORMAL_TEXT,
  contrastRatio,
} from '../semanticThemeTokens.ts';

const TABLIST_MARKUP = DASHBOARD_HTML.match(/<nav class="tabs"[\s\S]*?<\/nav>/)?.[0] ?? '';

function mixSrgb(foreground: string, background: string, foregroundPercent: number): string {
  const p = foregroundPercent / 100;
  const hex = (value: string) => [
    parseInt(value.slice(1, 3), 16),
    parseInt(value.slice(3, 5), 16),
    parseInt(value.slice(5, 7), 16),
  ];
  const fg = hex(foreground);
  const bg = hex(background);
  const mixed = fg.map((channel, i) => Math.round(channel * p + bg[i]! * (1 - p)));
  return `#${mixed.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

function accessibleName(el: Element): string {
  const explicit = el.getAttribute('aria-label');
  if (explicit && explicit.trim()) return explicit.replace(/\s+/g, ' ').trim();
  const parts: string[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === 3) {
      parts.push(node.textContent ?? '');
      return;
    }
    if (node.nodeType !== 1) return;
    const child = node as Element;
    if (child.getAttribute('aria-hidden') === 'true') return;
    if (child.hasAttribute('hidden')) return;
    const view = child.ownerDocument.defaultView;
    if (view && view.getComputedStyle(child).display === 'none') return;
    child.childNodes.forEach(walk);
  };
  el.childNodes.forEach(walk);
  return parts.join('').replace(/\s+/g, ' ').trim();
}

function renderTabs(css: string): Element[] {
  const dom = new JSDOM(
    `<!doctype html><html><head><style>${css}</style></head><body>${TABLIST_MARKUP}</body></html>`,
  );
  const tablist = dom.window.document.querySelector('[role="tablist"]');
  if (!tablist) throw new Error('primary tablist missing');
  return [...tablist.querySelectorAll('[role="tab"]')];
}

const DESKTOP_NAME_CSS = `
  nav.tabs .tab-label-short { display: none; }
  [hidden] { display: none !important; }
`;

const MOBILE_NAME_CSS = `
  nav.tabs a[data-admin-tab] .tab-label-full { display: none; }
  nav.tabs a[data-admin-tab] .tab-label-short { display: block; }
  [hidden] { display: none !important; }
`;

describe('primary tab accessible names (CT-2505)', () => {
  it('exposes one name per tab from the visible label, with the icon aria-hidden', () => {
    expect(TABLIST_MARKUP).not.toBe('');
    const tabs = renderTabs(DESKTOP_NAME_CSS);
    const names = tabs.map((tab) => accessibleName(tab));
    expect(names).toEqual([
      'Trends',
      'Trades',
      'Directory',
      'Review Queue',
      'Delivery',
      'Admin · Cadence',
    ]);
    for (const tab of tabs) {
      expect(tab.getAttribute('role')).toBe('tab');
      expect(tab.hasAttribute('aria-label')).toBe(false);
      expect(tab.getAttribute('aria-controls')).toMatch(/^view-/);
      const icon = tab.querySelector('.tab-ico');
      expect(icon?.getAttribute('aria-hidden')).toBe('true');
    }
    const tablist = tabs[0]?.closest('[role="tablist"]');
    expect(tablist?.getAttribute('aria-label')).toBe('Primary views');
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true');
    expect(tabs[0]?.hasAttribute('tabindex')).toBe(false);
    for (const tab of tabs.slice(1)) expect(tab.getAttribute('tabindex')).toBe('-1');
  });

  it('keeps a single name when the phone dock shows the icon and the short admin label', () => {
    const names = renderTabs(MOBILE_NAME_CSS).map((tab) => accessibleName(tab));
    expect(names).toEqual(['Trends', 'Trades', 'Directory', 'Review', 'Delivery', 'Admin']);
    for (const name of names) {
      const words = name.split(/\s+/);
      expect(new Set(words).size).toBe(words.length);
    }
  });

  it('does not put the label into CSS generated content, and keeps tablist keys', () => {
    expect(DASHBOARD_CSS).not.toMatch(
      /nav\.tabs[^{]*::(?:before|after)[^{]*content:\s*attr\(data-(?:icon|mobile)\)/,
    );
    expect(DASHBOARD_CSS).toContain('nav.tabs .tab-label-short { display: none; }');
    expect(DASHBOARD_CSS).toContain('nav.tabs a[data-admin-tab] .tab-label-full { display: none; }');
    expect(DASHBOARD_APP_JS).toContain("nav.querySelectorAll('a[role=\"tab\"]')");
    expect(DASHBOARD_APP_JS).toContain("'ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End'");
  });
});

describe('light-mode sell contrast (CT-2505)', () => {
  const sell = SEMANTIC_LIGHT.sell;
  const page = '#eff3f8';
  const card = '#ffffff';
  const panel2 = '#e8eff8';
  const dirpill = mixSrgb(sell, card, 16);
  const darkSell = SEMANTIC_DARK.sell;
  const darkBadgeEnd = mixSrgb(darkSell, '#000000', 82);

  it('keeps sell text at or above 4.5:1 on page, card, panel, and the sell pill tint', () => {
    // Token on main before this change.  These already cleared AA; the
    // assertion locks them so a lighter red cannot come back.
    expect(contrastRatio(sell, page)).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
    expect(contrastRatio(sell, card)).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
    expect(contrastRatio(sell, panel2)).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
    expect(contrastRatio(sell, dirpill)).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
    expect(contrastRatio(sell, page)).toBeCloseTo(7.46, 1);
    expect(contrastRatio(sell, card)).toBeCloseTo(8.31, 1);
    expect(contrastRatio(sell, dirpill)).toBeCloseTo(6.26, 1);
  });

  it('uses white badge ink on the light sell fill (near-black ink was 2.29:1)', () => {
    expect(contrastRatio('#09101c', sell)).toBeCloseTo(2.29, 1);
    expect(contrastRatio('#09101c', sell)).toBeLessThan(WCAG_AA_NORMAL_TEXT);
    expect(contrastRatio('#ffffff', sell)).toBeCloseTo(8.31, 1);
    expect(contrastRatio('#ffffff', sell)).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
    expect(contrastRatio(sell, card)).toBeGreaterThanOrEqual(WCAG_AA_LARGE_TEXT);
    expect(contrastRatio(sell, page)).toBeGreaterThanOrEqual(WCAG_AA_LARGE_TEXT);
    expect(DASHBOARD_CSS).toMatch(/\.tag\.S \{[^}]*color:\s*#fff/);
    expect(DASHBOARD_CSS).toContain('.party-chip.on[data-party="R"] { background: var(--sell); color: #fff;');
    expect(DASHBOARD_CSS).toContain('.side-chip.on[data-side="S"] { background: var(--sell); color: #fff;');
  });

  it('keeps dark-mode sell badges on dark ink so the light pink fill still clears 4.5:1', () => {
    expect(contrastRatio('#ffffff', darkSell)).toBeCloseTo(2.55, 1);
    expect(contrastRatio('#ffffff', darkSell)).toBeLessThan(WCAG_AA_NORMAL_TEXT);
    expect(contrastRatio('#080c17', darkSell)).toBeCloseTo(7.66, 1);
    expect(contrastRatio('#080c17', darkBadgeEnd)).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
    expect(contrastRatio(darkSell, '#172440')).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
    expect(DASHBOARD_CSS).toContain('html[data-theme="dark"] .tag.S { color: #080c17;');
    expect(DASHBOARD_CSS).toContain('html[data-theme="dark"] .party-chip.on[data-party="R"] { color: #080c17; }');
    expect(DASHBOARD_CSS).toContain('html[data-theme="dark"] .side-chip.on[data-side="S"] { color: #080c17; }');
  });
});
