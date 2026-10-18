/**
 * src/ui/__tests__/dashboardClient.test.ts
 *
 * CT-1500: the first tests that actually RUN the dashboard's browser JavaScript.
 *
 * The 546 KB of client code shipped as a TypeScript template literal, so `tsc`
 * saw a string and eslint saw nothing. dashboardHtml.test.ts closes part of that
 * gap by asserting on `toContain` patterns and compiling individual functions
 * with `new Function` (which parses without executing). This file takes the
 * other half: it boots the whole script inside a jsdom window built from the
 * real document, then calls the pure functions and asserts on their return
 * values. Behaviour, not markup.
 *
 * Why the whole script and not more `new Function` extraction: `new Function`
 * can only reach one function at a time and needs its dependencies hand-fed, so
 * it structurally cannot catch a broken dependency — which is exactly how
 * `makeTradesFilterMatcher` stayed referenced-but-undefined for months. Booting
 * the real script means every top-level declaration exists, so a call that
 * resolves here resolves in the browser too.
 *
 * What is NOT asserted here: rendering, network calls, and interaction. Those
 * need a real browser (Playwright), which this file deliberately does not fake.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { JSDOM, VirtualConsole } from 'jsdom';
import { DASHBOARD_HTML } from '../dashboardHtml.ts';
import { DASHBOARD_APP_JS } from '../dashboardClient.ts';

/** The subset of window the tests actually call. Kept narrow on purpose: a
 *  broad `any` here would let a typo in a function name pass as a test. */
type Client = {
  fmtCount: (n: number | string | null) => string;
  ordinalSuffix: (n: number) => string;
  fmtDistrictOrdinal: (n: number | null) => string;
  fmtBracketAmount: (n: number | null) => string;
  fmtName: (raw: string) => string;
  fmtCompany: (raw: string) => string;
  fmtDuration: (seconds: number) => string;
  fmtMs: (ms: number) => string;
  pctText: (v: number) => string;
  pluralCount: (n: number, one: string, many?: string) => string;
  tradeRowMatchesSearch: (row: Record<string, string>, query: string) => boolean;
  applySearchToServerParams: (params: URLSearchParams, query: string) => void;
  makeTradesFilterMatcher: () => (row: Record<string, string>) => boolean;
  resolveViewId: (raw: string) => string;
  windowLabel: (v: string) => string;
  amountTier: (amount: number) => string;
  parsePx: (raw: string) => number;
  clampNum: (v: number, lo: number, hi: number) => number;
  entityFingerprint: (s: string) => string;
  isJunkAssetString: (s: string) => boolean;
  cleanAsset: (s: string) => string;
  esc: (s: string) => string;
  sortRows: (rows: Array<Record<string, unknown>>) => Array<Record<string, unknown>>;
};

let dom: JSDOM;
let win: Window & typeof globalThis & Record<string, unknown>;
let client: Client;
let timers: Array<ReturnType<typeof setInterval>> = [];

/**
 * The script ends with `setInterval(refreshSpeedUpdated, 60000)` and starts
 * polling. Vitest would wait for those handles forever, so they are captured
 * and cleared rather than left to hang the run.
 */
function trackTimer<T extends (...args: never[]) => unknown>(fn: T, ms: number): T {
  const wrapped = ((...args: Parameters<T>) => {
    // Never actually fire: these are UI refresh loops, not logic under test.
    return undefined;
  }) as unknown as T;
  timers.push(setInterval(wrapped, ms) as ReturnType<typeof setInterval>);
  return wrapped;
}

beforeAll(() => {
  // The script logs through these; swallow rather than pollute test output.
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', () => {});

  dom = new JSDOM(DASHBOARD_HTML, {
    runScripts: 'outside-only',
    url: 'http://localhost/',
    pretendToBeVisual: true,
    virtualConsole,
  });

  win = dom.window as unknown as Window & typeof globalThis & Record<string, unknown>;

  // jsdom has no matchMedia; the script already guards every use with
  // `window.matchMedia &&`, so leaving it undefined exercises the real guard.
  win.fetch = vi.fn(() => Promise.resolve(new Response('{}', {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }))) as unknown as typeof fetch;
  win.setInterval = trackTimer as unknown as typeof setInterval;
  win.clearInterval = ((h?: ReturnType<typeof setInterval>) => {
    if (h) clearInterval(h as unknown as NodeJS.Timeout);
  }) as typeof clearInterval;

  // The real boot. `runScripts: 'outside-only'` means the document's own inline
  // boot script did not execute, so the DOM is the served markup untouched.
  win.eval(DASHBOARD_APP_JS);

  client = win as unknown as Client;
}, 120_000);

afterAll(() => {
  for (const t of timers) clearInterval(t as unknown as NodeJS.Timeout);
  timers = [];
  dom?.window.close();
});

describe('dashboard client boots as a classic script (CT-1500)', () => {
  it('evaluates the whole script without throwing', () => {
    // If this fails, the document would ship a blank page. Every other test in
    // this file is downstream of it.
    expect(() => win.eval(DASHBOARD_APP_JS)).not.toThrow();
  });

  it('puts the declarations inline handlers depend on on window', () => {
    // ~163 inline onclick/onchange attributes in the markup resolve these as bare
    // globals at dispatch time. If any of these is missing, a handler dies
    // silently on click — which is why the boot being a CLASSIC script matters.
    for (const name of ['esc', 'el', 'fmtCount', 'loadTrades', 'setTickerSort', 'showView']) {
      expect(typeof win[name], name).toBe('function');
    }
  });

  it('defines makeTradesFilterMatcher, which the SSE handler calls', () => {
    // Regression guard for the exact bug eslint's no-undef found: the function
    // was deleted in 06993059 along with its renderTrades() caller, but the SSE
    // congress.trade handler kept calling it. PUBLIC_STREAM_ENABLED is false
    // today so the line never ran, which is why nothing noticed.
    expect(typeof client.makeTradesFilterMatcher).toBe('function');
  });

  it('defines stampWindowChips, which replaced the never-defined updateTrWindowLabels', () => {
    expect(typeof win['stampWindowChips']).toBe('function');
    expect(win['updateTrWindowLabels']).toBeUndefined();
  });
});

describe('formatters', () => {
  it('fmtCount groups thousands and renders an em dash for nothing', () => {
    // fmtCount is a grouped-number formatter, not an abbreviator: 1,500,000 is
    // the correct output, and abbreviating a trade count would be a lie about
    // precision on the number that IS displayed.
    expect(client.fmtCount(999)).toBe('999');
    expect(client.fmtCount(1000)).toBe('1,000');
    expect(client.fmtCount(1_500_000)).toBe('1,500,000');
    expect(client.fmtCount(null)).toBe('—');
    expect(client.fmtCount('')).toBe('—');
    expect(client.fmtCount('not a number')).toBe('not a number');
  });

  it('ordinalSuffix handles the 11/12/13 exception', () => {
    expect(client.ordinalSuffix(1)).toBe('st');
    expect(client.ordinalSuffix(2)).toBe('nd');
    expect(client.ordinalSuffix(3)).toBe('rd');
    expect(client.ordinalSuffix(4)).toBe('th');
    // The classic trap: 11th/12th/13th, not 11st/12nd/13rd.
    expect(client.ordinalSuffix(11)).toBe('th');
    expect(client.ordinalSuffix(12)).toBe('th');
    expect(client.ordinalSuffix(13)).toBe('th');
    expect(client.ordinalSuffix(21)).toBe('st');
    expect(client.ordinalSuffix(111)).toBe('th');
  });

  it('fmtDistrictOrdinal renders 0 and null distinctly from a real district', () => {
    expect(client.fmtDistrictOrdinal(null)).not.toContain('0');
    expect(client.fmtDistrictOrdinal(1)).toMatch(/1st/);
    expect(client.fmtDistrictOrdinal(12)).toMatch(/12th/);
  });

  it('fmtBracketAmount abbreviates by magnitude and keeps the sign', () => {
    // One amount, not a range: the caller formats the two bounds of a
    // transaction's disclosed bracket separately.
    expect(client.fmtBracketAmount(999)).toBe('$999');
    expect(client.fmtBracketAmount(1_500)).toBe('$1.5k');
    expect(client.fmtBracketAmount(2_500_000)).toBe('$2.5m');
    expect(client.fmtBracketAmount(3_620_000_000_000)).toBe('$3.62t');
    // A negative amount keeps its sign rather than reading as a magnitude.
    expect(client.fmtBracketAmount(-1_500)).toBe('-$1.5k');
    expect(client.fmtBracketAmount(null)).toBe('—');
  });

  it('pluralCount picks singular or plural', () => {
    expect(client.pluralCount(1, 'trade')).toBe('1 trade');
    expect(client.pluralCount(2, 'trade')).toBe('2 trades');
  });

  it('windowLabel maps window codes to human labels and passes unknown ones through', () => {
    expect(client.windowLabel('90d')).toBe('3 Months');
    expect(client.windowLabel('this_cy')).toBe('This Year');
    // Unknown input must not become undefined text in the UI.
    expect(client.windowLabel('nonsense')).toBe('nonsense');
  });

  it('esc escapes the characters that would break out of an attribute', () => {
    expect(client.esc('a"b')).toBe('a&quot;b');
    expect(client.esc('a<b')).not.toContain('<b');
    expect(client.esc('a&b')).toMatch(/&/);
  });
});

describe('tradeRowMatchesSearch — multi-token AND matching', () => {
  const row = {
    member: 'Ro Khanna', ticker: 'MSFT', asset: 'Microsoft Corp',
    st: 'CA', state: 'California', party: 'D',
  };

  it('matches everything on an empty query', () => {
    expect(client.tradeRowMatchesSearch(row, '')).toBe(true);
    expect(client.tradeRowMatchesSearch(row, '   ')).toBe(true);
  });

  it('matches a single token against any field, in any case', () => {
    expect(client.tradeRowMatchesSearch(row, 'khanna')).toBe(true);
    expect(client.tradeRowMatchesSearch(row, 'MSFT')).toBe(true);
    expect(client.tradeRowMatchesSearch(row, 'microsoft')).toBe(true);
    expect(client.tradeRowMatchesSearch(row, 'CA')).toBe(true);
  });

  it('requires EVERY token to match (AND, not OR)', () => {
    expect(client.tradeRowMatchesSearch(row, 'khanna microsoft')).toBe(true);
    expect(client.tradeRowMatchesSearch(row, 'khanna tesla')).toBe(false);
  });

  it('is order-independent', () => {
    expect(client.tradeRowMatchesSearch(row, 'microsoft khanna')).toBe(true);
  });

  it('matches on a name part, not only a prefix of the whole name', () => {
    expect(client.tradeRowMatchesSearch(row, 'kha')).toBe(true);
  });
});

describe('applySearchToServerParams — filter-to-query builder', () => {
  it('leaves the params untouched for an empty query', () => {
    const p = new URLSearchParams();
    client.applySearchToServerParams(p, '');
    expect([...p.keys()]).toEqual([]);
  });

  it('classifies a bare ticker as a ticker, not a name', () => {
    // A bare all-caps token is the shape of a ticker; treating it as a member
    // name would send a query the server answers with nothing.
    const p = new URLSearchParams();
    client.applySearchToServerParams(p, 'AAPL');
    expect(p.get('ticker')).toBe('AAPL');
    expect(p.get('memberName')).toBeNull();
  });

  it('classifies a two-word name as memberName', () => {
    const p = new URLSearchParams();
    client.applySearchToServerParams(p, 'Ro Khanna');
    expect(p.get('memberName')).toBeTruthy();
  });

  it('splits a mixed query into both a name and a ticker hint', () => {
    const p = new URLSearchParams();
    client.applySearchToServerParams(p, 'Khanna MSFT');
    expect(p.get('ticker')).toBe('MSFT');
    expect(p.get('memberName')).toBeTruthy();
  });
});

describe('makeTradesFilterMatcher — the live-push filter', () => {
  const row = { chamber: 'house', type: 'Purchase', member: 'Ro Khanna', st: 'CA' };

  it('accepts everything when no filter is active', () => {
    const match = client.makeTradesFilterMatcher();
    expect(match(row)).toBe(true);
  });

  it('excludes a row whose chamber is not selected', () => {
    const cb = win['chipSel'] as (id: string) => string[];
    const sel = win['chamberParam'] as (id: string) => string;
    const origChip = cb;
    // Stand in the DOM-derived filter state; the real one depends on the
    // chip markup, which this document does have but with nothing selected.
    (win as Record<string, unknown>)['chipSel'] = () => ['senate'];
    (win as Record<string, unknown>)['chamberParam'] = () => 'senate';
    try {
      expect(client.makeTradesFilterMatcher()(row)).toBe(false);
      expect(client.makeTradesFilterMatcher()({ ...row, chamber: 'senate' })).toBe(true);
    } finally {
      (win as Record<string, unknown>)['chipSel'] = origChip;
    }
  });

  it('honours the empty-selection-means-all semantics', () => {
    (win as Record<string, unknown>)['chipSel'] = () => ['house'];
    (win as Record<string, unknown>)['chamberParam'] = () => '';
    try {
      // No chamber selected = ALL branches, including unresolved-chamber rows.
      expect(client.makeTradesFilterMatcher()({ ...row, chamber: 'executive' })).toBe(true);
    } finally {
      delete (win as Record<string, unknown>)['chipSel'];
      delete (win as Record<string, unknown>)['chamberParam'];
    }
  });
});

describe('resolveViewId — the view alias map', () => {
  it('maps legacy aliases onto current tab ids', () => {
    expect(client.resolveViewId('feed')).toBe('trades');
    expect(client.resolveViewId('delivery')).toBe('subs');
    expect(client.resolveViewId('directory')).toBe('people');
  });

  it('passes a known view through unchanged', () => {
    expect(client.resolveViewId('trends')).toBe('trends');
    expect(client.resolveViewId('trades')).toBe('trades');
  });

  it('does not throw on an unknown view', () => {
    expect(() => client.resolveViewId('nonsense')).not.toThrow();
  });
});

describe('asset-name hygiene', () => {
  it('isJunkAssetString rejects junk without rejecting real names', () => {
    expect(client.isJunkAssetString('')).toBe(true);
    expect(client.isJunkAssetString('  ..  ')).toBe(true);
    expect(client.isJunkAssetString('Microsoft Corp')).toBe(false);
    expect(client.isJunkAssetString('Apple Inc.')).toBe(false);
  });

  it('cleanAsset strips exchange suffixes and trailing noise', () => {
    // The rewritten regex in this change is the one that had to keep working:
    // it previously read /[\/\-\s]+$/ and must still trim a trailing separator.
    expect(client.cleanAsset('Apple Inc.   ')).not.toMatch(/[\s]$/);
    expect(client.cleanAsset('Apple Inc -')).not.toMatch(/-$/);
    expect(client.cleanAsset('Apple Inc (NASDAQ)')).not.toContain('NASDAQ');
  });
});

describe('small numeric and identity helpers', () => {
  it('parsePx reads a CSS pixel value and survives junk', () => {
    expect(client.parsePx('120px')).toBe(120);
    expect(Number.isFinite(client.parsePx('auto'))).toBe(true);
    expect(Number.isFinite(client.parsePx(''))).toBe(true);
  });

  it('clampNum bounds both ends', () => {
    expect(client.clampNum(5, 0, 10)).toBe(5);
    expect(client.clampNum(-1, 0, 10)).toBe(0);
    expect(client.clampNum(99, 0, 10)).toBe(10);
  });

  it('entityFingerprint is stable for the same input and differs across entities', () => {
    expect(client.entityFingerprint('abc')).toBe(client.entityFingerprint('abc'));
    expect(client.entityFingerprint('abc')).not.toBe(client.entityFingerprint('abd'));
  });

  it('sortRows does not mutate its input', () => {
    const rows = [{ n: 3 }, { n: 1 }, { n: 2 }];
    const before = JSON.stringify(rows);
    client.sortRows(rows);
    expect(JSON.stringify(rows)).toBe(before);
  });
});