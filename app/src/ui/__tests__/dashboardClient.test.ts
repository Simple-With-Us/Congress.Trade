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
  // txdate is today's UTC date so the date window is never the reason a
  // dimension-specific assertion below fails. These tests isolate chamber,
  // side, party and search; the real document ships a live rolling-window
  // select, so without a date the matcher would reject the row for an unrelated
  // reason (a bound is active and an undated row cannot satisfy it).
  const row = {
    chamber: 'house',
    type: 'Purchase',
    member: 'Ro Khanna',
    st: 'CA',
    txdate: new Date().toISOString().slice(0, 10),
  };

  it('accepts everything when no filter is active', () => {
    const match = client.makeTradesFilterMatcher();
    expect(match(row)).toBe(true);
  });

  it('excludes a row whose chamber is not selected', () => {
    const origChip = win['chipSel'] as (id: string) => string[];
    const origParam = win['chamberParam'] as (id: string) => string;
    // Stand in the DOM-derived filter state; the real one depends on the
    // chip markup, which this document does have but with nothing selected.
    (win as Record<string, unknown>)['chipSel'] = () => ['senate'];
    (win as Record<string, unknown>)['chamberParam'] = () => 'senate';
    try {
      expect(client.makeTradesFilterMatcher()(row)).toBe(false);
      expect(client.makeTradesFilterMatcher()({ ...row, chamber: 'senate' })).toBe(true);
    } finally {
      (win as Record<string, unknown>)['chipSel'] = origChip;
      (win as Record<string, unknown>)['chamberParam'] = origParam;
    }
  });

  it('honours the empty-selection-means-all semantics', () => {
    const origChip = win['chipSel'] as (id: string) => string[];
    const origParam = win['chamberParam'] as (id: string) => string;
    (win as Record<string, unknown>)['chipSel'] = () => ['house'];
    (win as Record<string, unknown>)['chamberParam'] = () => '';
    try {
      // No chamber selected = ALL branches, including unresolved-chamber rows.
      expect(client.makeTradesFilterMatcher()({ ...row, chamber: 'executive' })).toBe(true);
    } finally {
      (win as Record<string, unknown>)['chipSel'] = origChip;
      (win as Record<string, unknown>)['chamberParam'] = origParam;
    }
  });

  // Codex found this on the restored function: the matcher filtered chamber and
  // side but not party, while the HTTP feed does pass partyParam('qPartyGroup').
  // It predates this change, but the function is being re-enabled here.
  it('excludes a row whose party is not selected', () => {
    const origChip = win['chipSel'] as (id: string) => string[];
    const origParam = win['chamberParam'] as (id: string) => string;
    const origParty = win['partyParam'] as (id: string) => string;
    (win as Record<string, unknown>)['chipSel'] = () => ['house'];
    (win as Record<string, unknown>)['chamberParam'] = () => '';
    (win as Record<string, unknown>)['partyParam'] = () => 'D';
    try {
      expect(client.makeTradesFilterMatcher()({ ...row, party: 'R' })).toBe(false);
      expect(client.makeTradesFilterMatcher()({ ...row, party: 'D' })).toBe(true);
      // Rows that only carry the bucket spelling must still be filtered.
      expect(client.makeTradesFilterMatcher()({ ...row, partyBucket: 'R' })).toBe(false);
      expect(client.makeTradesFilterMatcher()({ ...row, partyBucket: 'D' })).toBe(true);
    } finally {
      (win as Record<string, unknown>)['chipSel'] = origChip;
      (win as Record<string, unknown>)['chamberParam'] = origParam;
      (win as Record<string, unknown>)['partyParam'] = origParty;
    }
  });

  // The test above only ever used bucket codes, which is exactly why it passed
  // while the real feed would have failed. mapFeedTransaction() copies
  // fl.party through unchanged (delivery/rows.ts:322) and the feed SELECT
  // aliases the full label, so a streamed row arrives as 'Democratic', not 'D'.
  // Comparing that against the chip's 'D' rejects every row while a chip is on.
  it('matches the chip bucket against the row\'s full party label', () => {
    const origChip = win['chipSel'] as (id: string) => string[];
    const origParam = win['chamberParam'] as (id: string) => string;
    const origParty = win['partyParam'] as (id: string) => string;
    (win as Record<string, unknown>)['chipSel'] = () => ['house'];
    (win as Record<string, unknown>)['chamberParam'] = () => '';
    (win as Record<string, unknown>)['partyParam'] = () => 'D';
    try {
      // The failure this pins: with 'D' selected, a Democratic row must PASS.
      expect(client.makeTradesFilterMatcher()({ ...row, party: 'Democratic' })).toBe(true);
      expect(client.makeTradesFilterMatcher()({ ...row, party: 'Republican' })).toBe(false);
      // Minor parties and Independents are 'O' on both sides of the filter.
      (win as Record<string, unknown>)['partyParam'] = () => 'O';
      expect(client.makeTradesFilterMatcher()({ ...row, party: 'Independent' })).toBe(true);
      expect(client.makeTradesFilterMatcher()({ ...row, party: 'Democratic' })).toBe(false);
      // The server's PARTY_BUCKET_SQL_LOCAL ELSE branch is 'O', never NULL, so a
      // row with no party on file belongs to the "Other / No party" chip.
      (win as Record<string, unknown>)['partyParam'] = () => 'O';
      expect(client.makeTradesFilterMatcher()({ ...row, party: '' })).toBe(true);
      (win as Record<string, unknown>)['partyParam'] = () => 'D';
      expect(client.makeTradesFilterMatcher()({ ...row, party: '' })).toBe(false);
    } finally {
      (win as Record<string, unknown>)['chipSel'] = origChip;
      (win as Record<string, unknown>)['chamberParam'] = origParam;
      (win as Record<string, unknown>)['partyParam'] = origParty;
    }
  });

  it('accepts any party when no party is selected', () => {
    const origChip = win['chipSel'] as (id: string) => string[];
    const origParam = win['chamberParam'] as (id: string) => string;
    const origParty = win['partyParam'] as (id: string) => string;
    (win as Record<string, unknown>)['chipSel'] = () => ['house'];
    (win as Record<string, unknown>)['chamberParam'] = () => '';
    (win as Record<string, unknown>)['partyParam'] = () => '';
    try {
      expect(client.makeTradesFilterMatcher()({ ...row, party: 'R' })).toBe(true);
      expect(client.makeTradesFilterMatcher()({ ...row, chamber: 'executive' })).toBe(true);
    } finally {
      (win as Record<string, unknown>)['chipSel'] = origChip;
      (win as Record<string, unknown>)['chamberParam'] = origParam;
      (win as Record<string, unknown>)['partyParam'] = origParty;
    }
  });

  // Codex's second finding, on the same function: the predicate checked
  // chamber, side, party and search but not the date window that
  // tradesFilterParams() applies to the HTTP feed. A late filing outside the
  // window would be appended into a narrowed table.
  // Codex, on the same function again: the server sends `ticker=` for an
  // all-caps token and filters it with "t.ticker = ?" — exact — while the client
  // used indexOf, so an AAPL view accepted a streamed AAPLX and counted it.
  it('matches a ticker token exactly, the way the server does', () => {
    const origChip = win['chipSel'] as (id: string) => string[];
    const origParam = win['chamberParam'] as (id: string) => string;
    const origParty = win['partyParam'] as (id: string) => string;
    const origQuery = win['tradesSearchQuery'] as () => string;
    (win as Record<string, unknown>)['chipSel'] = () => [];
    (win as Record<string, unknown>)['chamberParam'] = () => '';
    (win as Record<string, unknown>)['partyParam'] = () => '';
    (win as Record<string, unknown>)['tradesSearchQuery'] = () => 'AAPL';
    try {
      expect(
        client.makeTradesFilterMatcher()({ ...row, ticker: 'AAPL', asset: '' }),
      ).toBe(true);
      // The failure this pins: a longer ticker must NOT satisfy an AAPL search.
      expect(
        client.makeTradesFilterMatcher()({ ...row, ticker: 'AAPLX', asset: '' }),
      ).toBe(false);
      // Case is irrelevant — the server upper-cases before comparing.
      expect(
        client.makeTradesFilterMatcher()({ ...row, ticker: 'aapl', asset: '' }),
      ).toBe(true);
      // An exact ticker row with no ticker at all is excluded, same as the feed.
      expect(client.makeTradesFilterMatcher()({ ...row, asset: '' })).toBe(false);
    } finally {
      (win as Record<string, unknown>)['chipSel'] = origChip;
      (win as Record<string, unknown>)['chamberParam'] = origParam;
      (win as Record<string, unknown>)['partyParam'] = origParty;
      (win as Record<string, unknown>)['tradesSearchQuery'] = origQuery;
    }
  });

  // The classification must be case-sensitive in the way the server's is: a
  // lower-case word is a name, not a ticker, so it keeps substring matching.
  it('still matches a lower-case token as a name, not an exact ticker', () => {
    const origQuery = win['tradesSearchQuery'] as () => string;
    (win as Record<string, unknown>)['tradesSearchQuery'] = () => 'khanna';
    try {
      expect(
        client.makeTradesFilterMatcher()({ ...row, member: 'Ro Khanna', ticker: '' }),
      ).toBe(true);
      // Substring still applies to the ticker field for a non-ticker token.
      expect(
        client.makeTradesFilterMatcher()({ ...row, member: '', ticker: 'AAPL' }),
      ).toBe(false);
    } finally {
      (win as Record<string, unknown>)['tradesSearchQuery'] = origQuery;
    }
  });

  describe('the active date window', () => {
    const base = { chamber: 'house', type: 'Purchase', member: 'Ro Khanna', st: 'CA' };

    /* Pin every OTHER filter open so only the date bounds are under test, and
       set the explicit from/to values. The real document supplies real chip and
       window state, which would otherwise decide these assertions. */
    function withWindow(from: string, to: string): () => void {
      const origChip = win['chipSel'] as (id: string) => string[];
      const origParam = win['chamberParam'] as (id: string) => string;
      const origParty = win['partyParam'] as (id: string) => string;
      const origSide = win['selectedSideParam'] as (id: string) => string;
      (win as Record<string, unknown>)['chipSel'] = () => ['house'];
      (win as Record<string, unknown>)['chamberParam'] = () => '';
      (win as Record<string, unknown>)['partyParam'] = () => '';
      (win as Record<string, unknown>)['selectedSideParam'] = () => '';

      // The real document carries a rolling-window control with a live value,
      // which would supply a `from` whenever the explicit one is blank and make
      // a to-only test fail for an unrelated reason. Blank it too, and restore.
      const made: string[] = [];
      const restoreValues: Array<() => void> = [];
      const setValue = (id: string, value: string) => {
        const existing = win.document.getElementById(id) as
          | (HTMLInputElement & { selectedIndex?: number })
          | null;
        if (existing) {
          const prior = existing.value;
          const priorIndex = existing.selectedIndex;
          // A <select> carrying no empty <option> cannot hold the value ''.
          // Assigning '' already deselects every option (measured in jsdom:
          // selectedIndex goes to -1 and the value reads back as '', it does NOT
          // fall back to the first option), but relying on that subtle rule
          // would leave the intent implicit. State it instead.
          if (existing.tagName === 'SELECT' && value === '') {
            existing.selectedIndex = -1;
          } else {
            existing.value = value;
          }
          restoreValues.push(() => {
            if (existing.tagName === 'SELECT') {
              existing.selectedIndex = priorIndex ?? -1;
            } else {
              existing.value = prior;
            }
          });
          return;
        }
        const input = win.document.createElement('input');
        input.id = id;
        input.value = value;
        win.document.body.appendChild(input);
        made.push(id);
      };
      setValue('qFrom', from);
      setValue('qTo', to);
      setValue('tradesGlobalWindow', '');
      setValue('trGlobalWindow', '');
      return () => {
        for (const id of made) win.document.getElementById(id)?.remove();
        for (const undo of restoreValues) undo();
        (win as Record<string, unknown>)['chipSel'] = origChip;
        (win as Record<string, unknown>)['chamberParam'] = origParam;
        (win as Record<string, unknown>)['partyParam'] = origParty;
        (win as Record<string, unknown>)['selectedSideParam'] = origSide;
      };
    }

    it('rejects a dated row older than the from bound', () => {
      const restore = withWindow('2026-01-01', '');
      try {
        expect(client.makeTradesFilterMatcher()({ ...base, txdate: '2025-06-01' })).toBe(false);
        expect(client.makeTradesFilterMatcher()({ ...base, txdate: '2026-05-01' })).toBe(true);
      } finally {
        restore();
      }
    });

    it('rejects a dated row after the to bound', () => {
      const restore = withWindow('', '2026-06-30');
      try {
        expect(client.makeTradesFilterMatcher()({ ...base, txdate: '2026-09-01' })).toBe(false);
        expect(client.makeTradesFilterMatcher()({ ...base, txdate: '2026-01-05' })).toBe(true);
      } finally {
        restore();
      }
    });

    it('rejects an undated row once a bound is active, matching the server', () => {
      // delivery/rows.ts pushes `t.tx_date >= ?` / `<= ?`, and its comment says a
      // null tx_date "can't satisfy a date comparison, so it's naturally
      // excluded once a bound is set". The predicate has to agree, or a streamed
      // row appears and increments totalRows and then vanishes on reload.
      const restore = withWindow('2026-01-01', '');
      try {
        expect(client.makeTradesFilterMatcher()({ ...base })).toBe(false);
        expect(client.makeTradesFilterMatcher()({ ...base, txdate: '' })).toBe(false);
        // And a dated row inside the same bounds still passes, so this is the
        // date filter rejecting an undated row and not the fixture failing.
        expect(
          client.makeTradesFilterMatcher()({ ...base, txdate: '2026-05-01' }),
        ).toBe(true);
      } finally {
        restore();
      }
    });

    it('accepts an undated row when no bound is active', () => {
      // With the window controls blanked there is nothing to compare against,
      // so an undated row is not "outside" any window and survives.
      const restore = withWindow('', '');
      try {
        expect(client.makeTradesFilterMatcher()({ ...base })).toBe(true);
      } finally {
        restore();
      }
    });
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
    expect(client.cleanAsset('Apple Inc.   ')).not.toMatch(/[\s]$/);
    expect(client.cleanAsset('Apple Inc -')).not.toMatch(/-$/);
    expect(client.cleanAsset('Apple Inc (NASDAQ)')).not.toContain('NASDAQ');
  });

  // The two cases below are regressions caught in review of this change: a
  // mechanical "remove the useless escapes" rewrite silently dropped one
  // character from each of these two character classes, and the test above had
  // a comment claiming to cover the separator while asserting only whitespace
  // and a hyphen. The comment was the false comfort.
  it('cleanAsset trims a trailing slash, not just whitespace and hyphens', () => {
    expect(client.cleanAsset('Vanguard Group /')).toBe('Vanguard Group');
    expect(client.cleanAsset('Berkshire Hathaway //')).toBe('Berkshire Hathaway');
    expect(client.cleanAsset('Berkshire -/')).toBe('Berkshire');
    // Normalization runs after the trim, so this is 'Apple Inc' -> 'Apple Inc.'.
    expect(client.cleanAsset('Apple Inc /')).toBe('Apple Inc.');
  });

  it('isJunkAssetString treats a semicolon-only value as junk', () => {
    // OCR extraction noise arrives as punctuation-only runs. `;` must stay in
    // the stripped character class or these render as real asset names.
    expect(client.isJunkAssetString(';;;')).toBe(true);
    expect(client.isJunkAssetString('.,;:!?')).toBe(true);
    expect(client.cleanAsset(';;;')).toBe('');
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