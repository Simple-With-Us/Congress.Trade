/**
 * src/ui/__tests__/dashboardHtml.test.ts
 *
 * The dashboard ships as one big TypeScript template literal, so `tsc` only
 * type-checks it as a STRING — it never parses the embedded browser JS. These
 * tests close that gap: they extract every <script> block from DASHBOARD_HTML
 * and assert it parses (via `new Function`, which compiles without executing),
 * catching template-literal / syntax breakage that the type-checker can't see.
 * They also assert the Trends tab + its API wiring are present.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'node-html-parser';
import { DASHBOARD_HTML } from '../dashboardHtml.ts';
import { browserSecurityHeaders } from '../../security/headers.ts';
import { MAX_PUBLIC_TX_OFFSET } from '../../security/botDefense.ts';

function scriptBlocks(html: string): string[] {
  const blocks: string[] = [];
  const re = /<script>([\s\S]*?)<\/script>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) blocks.push(m[1]);
  return blocks;
}

function loadSortVal() {
  const match = DASHBOARD_HTML.match(/function sortVal\(r, key\) \{[\s\S]*?\n\}/);
  if (!match) throw new Error('sortVal was not found in DASHBOARD_HTML');
  return new Function(
    'seenRaw',
    'lagDays',
    'NUMERIC_SORT',
    'sortDir',
    match[0] + '\nreturn sortVal;',
  )(
    () => '',
    () => null,
    {},
    1,
  ) as (row: Record<string, string>, key: string) => string;
}

/** Extracts just the named top-level functions (each matched independently to
 *  its own closing brace) rather than a wide template span, so unrelated
 *  top-level statements between them are never executed. */
function loadDashboardFunctions(names: string[]): string[] {
  return names.map((name) => {
    const match = DASHBOARD_HTML.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
    if (!match) throw new Error(`${name} was not found in DASHBOARD_HTML`);
    return match[0];
  });
}

function loadBenchmarkManualOptionHtml(state: { settings: { catalog: Array<Record<string, unknown>> } }) {
  const sources = loadDashboardFunctions([
    'esc', 'benchmarkModelKey', 'benchmarkCatalogModels', 'benchmarkManualOptionHtml',
  ]);
  const factory = new Function('benchmarkState', sources.join('\n\n') + '\nreturn benchmarkManualOptionHtml;');
  return factory(state) as (selected: string) => string;
}

function loadBenchmarkPresentationHelpers() {
  const match = DASHBOARD_HTML.match(
    /function benchmarkResultIsComplete\(result\) \{[\s\S]*?\n\}\n\nfunction normalizedBenchmarkLineup/,
  );
  if (!match) throw new Error('Benchmark presentation helpers were not found');
  const source = match[0].replace(/\n\nfunction normalizedBenchmarkLineup$/, '');
  return new Function(
    source + '\nreturn { benchmarkRunCellProgress, benchmarkModelPresentation, benchmarkModelEligibleForSimulation, benchmarkCompletionFeedback };',
  )() as {
    benchmarkRunCellProgress: (run: Record<string, unknown>) => Record<string, number | boolean | null>;
    benchmarkModelPresentation: (
      run: Record<string, unknown>,
      model: { provider: string; model: string },
      persisted?: Record<string, unknown>,
    ) => Record<string, unknown>;
    benchmarkModelEligibleForSimulation: (model: Record<string, unknown>) => boolean;
    benchmarkCompletionFeedback: (
      label: string,
      run: Record<string, unknown>,
      browserFailureCount: number,
      skippedModelCount?: number,
    ) => { warning: boolean; message: string };
  };
}

describe('DASHBOARD_HTML', () => {
  it('fills <title>/meta description from server-side OgMeta, per view/entity (SEOSOCIAL-04)', () => {
    // %TITLE%/%META_DESCRIPTION% are filled by applyOgMeta from the same
    // OgMeta the og:/twitter: tags use — no more hardcoded "Congress.Trade"
    // literal identical on every page.
    expect(DASHBOARD_HTML).toContain('<title>%TITLE%</title>');
    expect(DASHBOARD_HTML).toContain('<meta name="description" content="%META_DESCRIPTION%" />');
    expect(DASHBOARD_HTML).not.toContain('<title>Congress.Trade</title>');
    // OG tags are server-filled placeholders (deep-link context cards).
    expect(DASHBOARD_HTML).toContain('property="og:image" content="%OG_IMAGE%"');
    expect(DASHBOARD_HTML).toContain('name="twitter:card" content="summary_large_image"');
  });

  it('self-hosts the Zilla Slab wordmark face as a cached static asset', () => {
    expect(DASHBOARD_HTML).toContain('src:url(/assets/zilla-slab-700.woff2)');
    expect(DASHBOARD_HTML).not.toContain('data:font/woff2;base64,');
    expect(DASHBOARD_HTML).toContain("'Zilla Slab'");
  });

  it('self-hosts Inter instead of the Google Fonts <link> that 400s (QABUGHUNT-01 / WEBPERF-01)', () => {
    // The old combined request 400'd because Source Serif 4's axis tuple was
    // invalid for the css2 API, so Inter (the declared --sans body font)
    // never actually loaded on production. It must never come back as a
    // render-blocking cross-origin request.
    expect(DASHBOARD_HTML).not.toContain('fonts.googleapis.com');
    expect(DASHBOARD_HTML).not.toContain('fonts.gstatic.com');
    expect(DASHBOARD_HTML).not.toContain('rel="preconnect"');
    // IBM Plex Mono / Source Serif 4 were requested but never referenced by
    // any CSS rule (--mono is a system stack) — dropped rather than fixed.
    expect(DASHBOARD_HTML).not.toContain('IBM+Plex+Mono');
    expect(DASHBOARD_HTML).not.toContain('Source+Serif');
    expect(DASHBOARD_HTML).not.toMatch(/font-family:\s*['"]?Source Serif/);
    expect(DASHBOARD_HTML).not.toMatch(/font-family:\s*['"]?IBM Plex Mono/);
    // Every weight the CSS actually sets (400/500/600/700/800) is self-hosted
    // with font-display:swap, matching the Zilla Slab pattern.
    for (const weight of [400, 500, 600, 700, 800]) {
      expect(DASHBOARD_HTML).toContain(
        `@font-face { font-family:'Inter'; font-style:normal; font-weight:${weight}; font-display:swap; src:url(/assets/inter-${weight}.woff2) format('woff2'); }`,
      );
    }
    expect(DASHBOARD_HTML).toContain('--sans:      "Inter",');
  });

  it('references icons/logos via cacheable URL paths (not inline base64 data URIs)', () => {
    // Issue #1040 — heavy brand/icon assets must not ship inside the HTML document.
    expect(DASHBOARD_HTML).not.toMatch(/data:image\/png;base64,/);
    expect(DASHBOARD_HTML).not.toMatch(/data:image\/jpeg;base64,/);
    expect(DASHBOARD_HTML).not.toMatch(/data:image\/webp;base64,/);
    expect(DASHBOARD_HTML).toContain('href="/favicon.ico');
    expect(DASHBOARD_HTML).toContain('href="/icon-192.png');
    expect(DASHBOARD_HTML).toContain('href="/icon-512.png');
    expect(DASHBOARD_HTML).toContain('href="/apple-touch-icon.png');
    expect(DASHBOARD_HTML).toContain('src="/assets/brand-logo-light.png');
    expect(DASHBOARD_HTML).toContain('data-src-dark="/assets/brand-logo-dark.png');
    expect(DASHBOARD_HTML).toContain('data-src-light="/assets/brand-logo-light.png');
    expect(DASHBOARD_HTML).toContain('content="%OG_IMAGE%"');
  });

  it('contains at least the boot + main script blocks', () => {
    expect(scriptBlocks(DASHBOARD_HTML).length).toBeGreaterThanOrEqual(2);
  });

  it('every embedded <script> parses as valid JavaScript', () => {
    for (const js of scriptBlocks(DASHBOARD_HTML)) {
      // new Function compiles (parses) the body without running it — DOM refs OK.
      expect(() => new Function(js)).not.toThrow();
    }
  });

  it('Admin Premium Members roster uses Title Case chrome and Trial vs Paid copy', () => {
    expect(DASHBOARD_HTML).toContain('>Premium Members</h3>');
    expect(DASHBOARD_HTML).toContain('Everyone currently on Premium.&nbsp; Trial and Paid are listed separately.&nbsp; Stripe and Apple show as the billing source, with Sandbox or Production.');
    expect(DASHBOARD_HTML).toContain('<th>Email</th><th>Plan</th><th>Billing</th><th>Source</th><th>Environment</th><th>Period End</th><th>Stripe</th>');
    expect(DASHBOARD_HTML).toContain("fetch('/api/admin/premium-roster'");
    expect(DASHBOARD_HTML).toContain("diagMetricCard('Trial'");
    expect(DASHBOARD_HTML).toContain("diagMetricCard('Paid'");
    expect(DASHBOARD_HTML).toContain("diagMetricCard('Sandbox'");
    expect(DASHBOARD_HTML).toContain("diagMetricCard('Production'");
    expect(DASHBOARD_HTML).not.toMatch(/Premium Members[\s\S]{0,800}subscription_status/);
    expect(DASHBOARD_HTML).not.toMatch(/Premium Members[\s\S]{0,800}livemode/);
  });

  it('preserves same-day timestamp precision while clamping future dates', () => {
    const sortVal = loadSortVal();
    const today = new Date().toISOString().slice(0, 10);
    const sameDay = `${today}T15:00:00Z`;
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    expect(sortVal({ imported: sameDay }, 'imported')).toBe(sameDay.toLowerCase());
    expect(sortVal({ imported: tomorrow }, 'imported')).toBe(`${today}${tomorrow.slice(10)}`.toLowerCase());
  });

  it('keeps every primary view as a direct child of main', () => {
    const document = parse(DASHBOARD_HTML);
    const main = document.querySelector('main');
    expect(main).not.toBeNull();

    const viewIds = ['view-trades', 'view-trends', 'view-people', 'view-review', 'view-subs', 'view-admin'];
    expect(document.querySelectorAll('section.view').map((view) => view.id)).toEqual(viewIds);

    for (const id of viewIds) {
      const view = document.querySelector('#' + id);
      if (!view) throw new Error(id + ' should exist');
      expect(view.parentNode, id + ' must not be nested inside another hidden view').toBe(main);
    }
  });

  it('cleanAsset normalizes whitespace/suffixes without deleting letters (regex escaping)', () => {
    // The regexes live inside the template literal, so a single "\s" would be
    // cooked to "s" and cleanAsset would delete the letter s. Extract the real
    // emitted function body and exercise it.
    const m = DASHBOARD_HTML.match(/function cleanAsset\(s\) \{[\s\S]*?return t;\s*\}/);
    expect(m).not.toBeNull();
    // isScannedPdfPlaceholder is called by cleanAsset — stub it for isolation.
    const cleanAsset = new Function(
      'function isJunkAssetString() { return false; }\n' +
        'function isScannedPdfPlaceholder() { return false; }\n' +
        m![0] +
        '\nreturn cleanAsset;',
    )() as (s: string) => string;
    expect(cleanAsset('TESLA INC')).toBe('Tesla Inc.'); // 's' survives, suffix normalized
    expect(cleanAsset('Microsoft   Corporation')).toBe('Microsoft Corporation'); // ws collapsed, not deleted
    expect(cleanAsset('Apple Inc (NASDAQ: AAPL)')).toBe('Apple Inc.'); // exchange suffix stripped
  });

  it('keeps the What-Is-Being-Traded header aligned to loadTrTickers row cells', () => {
    const thead = DASHBOARD_HTML.match(/<table id="tableTrTickers">\s*<thead>\s*<tr>([\s\S]*?)<\/tr>/);
    expect(thead).not.toBeNull();
    const headerCells = (thead![1].match(/<th/g) || []).length;
    expect(headerCells).toBe(5); // Asset + Trades + Politicians + Est. Volume + Net Flow
  });

  it('wires the Trends tab, its containers, and the analytics API', () => {
    expect(DASHBOARD_HTML).toContain('data-view="trends"');
    expect(DASHBOARD_HTML).toContain('id="view-trends"');
    expect(DASHBOARD_HTML).toContain('/api/analytics/');
    expect(DASHBOARD_HTML).toContain('function loadTrends(');
    // key section containers the loaders target
    for (const id of ['trKpis', 'trTickers', 'trClusters', 'trTime', 'trMembers', 'trLateFilers']) {
      expect(DASHBOARD_HTML).toContain('id="' + id + '"');
    }
  });

  it('makes Trends the first, default-active view and renames Live Feed to Trades', () => {
    // Trends nav button comes before the Trades button and is the active one.
    const trendsIdx = DASHBOARD_HTML.indexOf('data-view="trends"');
    const tradesIdx = DASHBOARD_HTML.indexOf('data-view="trades"');
    expect(trendsIdx).toBeGreaterThan(0);
    expect(trendsIdx).toBeLessThan(tradesIdx);
    expect(DASHBOARD_HTML).toContain('data-view="trends" data-mobile="Trends"');
    expect(DASHBOARD_HTML).toContain('class="active" id="tab-trends"');
    expect(DASHBOARD_HTML).toContain('<nav class="tabs" role="tablist" aria-label="Primary views">');
    expect(DASHBOARD_HTML).toContain('role="tab" aria-selected="true" aria-current="page" aria-controls="view-trends"');
    expect(DASHBOARD_HTML).toContain('role="tabpanel" aria-labelledby="tab-trends" aria-hidden="false"');
    expect(DASHBOARD_HTML).toContain("x.setAttribute('aria-selected', 'false')");
    expect(DASHBOARD_HTML).toContain("view.setAttribute('aria-hidden', 'false')");
    // The Trends section is the default-active view; the Trades section is not.
    expect(DASHBOARD_HTML).toContain('<section class="view active" id="view-trends" role="tabpanel"');
    expect(DASHBOARD_HTML).toContain('<section class="view" id="view-trades" role="tabpanel"');
    // The former "Live Feed" tab is now labelled "Trades" — canonical id is
    // now "trades" too (owner follow-up batch #25), not the pre-rename "feed".
    expect(DASHBOARD_HTML).toContain('data-view="trades" data-mobile="Trades"');
    expect(DASHBOARD_HTML).toContain('aria-controls="view-trades" aria-label="Trades"><span aria-hidden="true">Trades</span></a>');
    // People tab is Directory (owner rename); view id stays "people" for deep links.
    expect(DASHBOARD_HTML).toContain('data-view="people" data-mobile="Directory"');
    expect(DASHBOARD_HTML).toContain('aria-controls="view-people" aria-label="Directory"><span aria-hidden="true">Directory</span></a>');
    // Trends is warmed on boot since it is the landing view.
    expect(DASHBOARD_HTML).toContain('loadTrends(); // Trends is the default landing view');
  });

  it('renders the primary view tabs as real crawlable <a href> links (SEOSOCIAL-02)', () => {
    // Progressive enhancement: search engines and ctrl/cmd-click can follow
    // these; the click handler still preventDefault()s to keep SPA routing.
    expect(DASHBOARD_HTML).toContain('<a href="/?view=trends" data-view="trends"');
    expect(DASHBOARD_HTML).toContain('<a href="/?view=trades" data-view="trades"');
    expect(DASHBOARD_HTML).toContain('<a href="/?view=people" data-view="people"');
    expect(DASHBOARD_HTML).toContain('<a href="/?view=subs" data-view="subs"');
    expect(DASHBOARD_HTML).not.toMatch(/<button[^>]+data-view=/);
    expect(DASHBOARD_HTML).toContain("if (e && e.preventDefault) e.preventDefault();");
  });

  it('gives every primary tab exactly one accessible name (aria-label + aria-hidden inner text, #2186)', () => {
    // Issue #2186: the CSS3 `content: attr(data-icon) / ""` alt-text spec is not
    // honored by every screen reader, so the visible "Trends" text inside the tab
    // could double up with the data-icon ::before content.  The belt-and-suspenders
    // fix is: aria-label on the tab + aria-hidden inner span, so screen readers
    // hear exactly the canonical label once.
    const tabIds = ['trends', 'trades', 'people', 'review', 'subs', 'admin'];
    for (const id of tabIds) {
      // Anchor carries aria-label + aria-controls (attr order is from the source
      // markup, not assumed by this regex) + inner aria-hidden span.  Review
      // and Admin tabs nest a badge span inside the aria-hidden label; allow
      // an optional nested span so the regex matches both shapes.
      const inner = '<span aria-hidden="true">(?:[^<]+<span[^>]*></span>|[^<]+)</span>';
      const anchorRe = new RegExp(
        '<a[^>]+id="tab-' + id + '"[^>]*>\\s*' + inner + '\\s*</a>',
      );
      expect(DASHBOARD_HTML, 'tab-' + id).toMatch(anchorRe);
      expect(DASHBOARD_HTML, 'tab-' + id).toContain('id="tab-' + id + '"');
      expect(DASHBOARD_HTML, 'tab-' + id).toMatch(
        new RegExp('id="tab-' + id + '"[^>]*aria-label="[^"]+"'),
      );
      expect(DASHBOARD_HTML, 'tab-' + id).toMatch(
        new RegExp('id="tab-' + id + '"[^>]*aria-controls="view-' + id + '"'),
      );
    }
    // Benchmark tablist also exposes three buttons with aria-label + aria-hidden
    // span so the CSS3 alt-text fallback path is not the only accessibility gate.
    for (const id of ['House', 'Senate', 'Exec']) {
      const btnRe = new RegExp(
        '<button[^>]+id="btnBench' + id + '"[^>]*>\\s*<span aria-hidden="true">[^<]+</span>\\s*</button>',
      );
      expect(DASHBOARD_HTML, 'btnBench' + id).toMatch(btnRe);
      expect(DASHBOARD_HTML, 'btnBench' + id).toMatch(
        new RegExp('id="btnBench' + id + '"[^>]*aria-label="[^"]+"'),
      );
    }
  });

  it('gives entity deep links (drawer "Copy link", Directory member/ticker cells) real hrefs (SEOSOCIAL-02)', () => {
    const sources = loadDashboardFunctions(['esc', 'entityHref', 'copyLinkHtml']);
    const helpers = new Function(
      sources.join('\n\n') + '\nreturn { entityHref, copyLinkHtml };',
    )() as {
      entityHref: (param: string, value: string) => string;
      copyLinkHtml: (param: string, value: string, entityLabel: string) => string;
    };

    expect(helpers.entityHref('member', 'P000197')).toBe('/?member=P000197');
    expect(helpers.entityHref('ticker', 'NVDA')).toBe('/?ticker=NVDA');
    // Values are percent-encoded — a filer id or ticker can never break out
    // of the query string.
    expect(helpers.entityHref('member', 'a&b=c')).toBe('/?member=a%26b%3Dc');

    // copyLinkHtml() must build its href through entityHref() — the exact
    // same URL builder the Directory member/ticker cells use below — not a
    // second, independently-maintained copy of the '/?param=value' string
    // construction.
    const [copyLinkHtmlSrc] = loadDashboardFunctions(['copyLinkHtml']);
    expect(copyLinkHtmlSrc).toContain('entityHref(param, value)');
    expect(copyLinkHtmlSrc).not.toContain('encodeURIComponent(param)');

    const link = helpers.copyLinkHtml('ticker', 'NVDA', 'NVDA');
    expect(link).toContain('<a class="drawer-all-link clickable" href="/?ticker=NVDA">🔗 NVDA</a>');
  });

  it('splits the drawer "Copy link" control into a real navigable <a href> and a separate, focusable copy <button> (SEOSOCIAL-02 + WEBA11Y-08)', () => {
    // SEOSOCIAL-02 (crawlable permalink) and WEBA11Y-08 (a real, keyboard-
    // operable copy control) each rewrote this ONE element to fix their own
    // finding, which made the two mutually exclusive: a href-less <a> has no
    // working navigation for crawlers/new-tab/middle-click, while a <button>
    // alone has no href at all. Splitting into two controls keeps both true.
    const sources = loadDashboardFunctions(['esc', 'entityHref', 'copyLinkHtml']);
    const helpers = new Function(
      sources.join('\n\n') + '\nreturn { copyLinkHtml };',
    )() as { copyLinkHtml: (param: string, value: string, entityLabel: string) => string };

    const html = helpers.copyLinkHtml('member', 'P000197', 'Nancy Pelosi');
    const root = parse(html);

    // Control 1: a real <a href> a crawler can follow and a user can
    // right-click "open in new tab" / middle-click — genuine navigation, not
    // a data-* attribute a JS click handler reads.
    const a = root.querySelector('a.drawer-all-link');
    expect(a).not.toBeNull();
    expect(a!.getAttribute('href')).toBe('/?member=P000197');
    expect(a!.getAttribute('data-copy-param')).toBeUndefined();

    // Control 2: a real <button> — natively focusable and Enter/Space-
    // activatable, unlike the href-less <a> it replaces — whose accessible
    // name says what it copies (WEBA11Y-08). The visible text is a prefix of
    // the aria-label (WCAG 2.5.3 Label in Name).
    const btn = root.querySelector('button.drawer-copy-link-btn');
    expect(btn).not.toBeNull();
    expect(btn!.getAttribute('type')).toBe('button');
    expect(btn!.getAttribute('data-copy-param')).toBe('member');
    expect(btn!.getAttribute('data-copy-value')).toBe('P000197');
    const ariaLabel = btn!.getAttribute('aria-label') || '';
    expect(ariaLabel).toBe('Copy Link to Nancy Pelosi’s page');
    expect(ariaLabel.startsWith(btn!.text.trim().replace(/^\S+\s/, ''))).toBe(true);
    // Repo copy convention: button labels use Title Case (AGENTS.md) — "Copy
    // link" (sentence case) was flagged and corrected to "Copy Link".
    expect(btn!.text.trim().replace(/^\S+\s/, '')).toBe('Copy Link');

    // Neither the pre-#2075 href-less <a> nor the pre-#2072 <a>-doubling-as-
    // copy-button shape survives the merge.
    expect(DASHBOARD_HTML).not.toContain('<a class="drawer-all-link clickable" data-copy-param="');
    expect(DASHBOARD_HTML).not.toContain('<button type="button" class="drawer-all-link clickable" data-copy-param="');

    // The click delegate for the copy button reuses the shared copyText()
    // helper with an explicit "Link copied." message; #toast (asserted
    // elsewhere to carry role="status" aria-live="polite") is the live
    // region that announces it to screen-reader users.
    const clickHandlerMatch = DASHBOARD_HTML.match(
      /document\.addEventListener\('click', function \(e\) \{\n {2}var b = e\.target[\s\S]*?copyText\(u\.toString\(\), 'Link copied\.'\);\n\}\);/,
    );
    expect(clickHandlerMatch).not.toBeNull();

    // Both controls carry the shared 'clickable' class, which is where the
    // app's generic keyboard focus-visible ring (.clickable:focus-visible)
    // comes from, so both get a visible focus state without any bespoke CSS.
    expect(DASHBOARD_HTML).toContain('.clickable:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }');

    // Placement: a flex row lays the two controls side by side without
    // otherwise restyling the drawer — same font-size/color/cursor as the
    // single control this replaces, just two of them now.
    expect(DASHBOARD_HTML).toContain(
      '.drawer-link-row { display:flex; align-items:center; gap:14px; flex-wrap:wrap; margin-top:9px; }',
    );
    expect(DASHBOARD_HTML).toContain(
      '.drawer-all-link, .drawer-copy-link-btn { display:inline-block; margin:0; font-size:13px; background:none; border:0; padding:0; color:var(--accent); text-decoration:none; cursor:pointer; text-align:left; font-family:inherit; }',
    );
  });

  it('links Directory table rows to real crawlable /?member= and /?ticker= hrefs (SEOSOCIAL-02)', () => {
    expect(DASHBOARD_HTML).toContain(
      "var memberAttr = m.filerId\n      ? ' class=\"member-cell clickable\" href=\"' + esc(entityHref('member', m.filerId)) + '\" data-member=\"' + esc(m.filerId) + '\" title=\"Open ' + esc(name) + '\"'",
    );
    expect(DASHBOARD_HTML).toContain("var memberTag = m.filerId ? 'a' : 'div';");
    expect(DASHBOARD_HTML).toContain("var assetTag = tkr ? 'a' : 'div';");
    expect(DASHBOARD_HTML).toContain("var hrefAttr = tkr ? (' href=\"' + esc(entityHref('ticker', tkr)) + '\"') : '';");
  });

  it('setDocumentTitle appends " — Congress.Trade" to a label, or restores the bare site name (SEOSOCIAL-04)', () => {
    const [src] = loadDashboardFunctions(['setDocumentTitle']);
    const stubDoc = { title: 'stale' };
    const setDocumentTitle = new Function('document', src + '\nreturn setDocumentTitle;')(stubDoc) as (
      label: string | null,
    ) => void;

    setDocumentTitle('Trends');
    expect(stubDoc.title).toBe('Trends — Congress.Trade');
    setDocumentTitle('NVDA');
    expect(stubDoc.title).toBe('NVDA — Congress.Trade');
    setDocumentTitle(null);
    expect(stubDoc.title).toBe('Congress.Trade');
  });

  it('keeps document.title in sync with the active tab and open drawer (SEOSOCIAL-04)', () => {
    // Tab-switch path: sets the title right after marking the clicked tab active.
    expect(DASHBOARD_HTML).toContain(
      "b.setAttribute('aria-current', 'page');\n    if (TAB_PAGE_TITLES[b.dataset.view]) setDocumentTitle(TAB_PAGE_TITLES[b.dataset.view]);",
    );
    // Boot-time restore-from-localStorage path (no ?view= in the request URL,
    // so the server-rendered <title> couldn't have known which tab this is).
    expect(DASHBOARD_HTML).toContain('if (TAB_PAGE_TITLES[initialView]) setDocumentTitle(TAB_PAGE_TITLES[initialView]);');
    // Drawer-open paths.
    expect(DASHBOARD_HTML).toContain('setDocumentTitle(d.ticker); // SEOSOCIAL-04: drawer-open path');
    expect(DASHBOARD_HTML).toContain('setDocumentTitle(name); // SEOSOCIAL-04: drawer-open path');
    // Drawer-close path restores whatever the active tab's title should be.
    expect(DASHBOARD_HTML).toContain("setDocumentTitle(activeView ? TAB_PAGE_TITLES[activeView] : null);");
    // The map mirrors resolveOgMeta's trades/people/subs titles (ogMeta.ts).
    expect(DASHBOARD_HTML).toContain(
      "var TAB_PAGE_TITLES = { trends: 'Trends', trades: 'Trades', people: 'Directory', subs: 'Delivery' };",
    );
  });

  it('exposes a public Delivery tab with account-gated management', () => {
    expect(DASHBOARD_HTML).toMatch(/<a[^>]+data-view="subs"[^>]*aria-label="Delivery"[^>]*><span aria-hidden="true">Delivery<\/span><\/a>/);
    expect(DASHBOARD_HTML).toMatch(/data-mobile="Delivery"/);
    expect(DASHBOARD_HTML).not.toMatch(/<a[^>]+data-view="subs"[^>]+data-admin-tab/);
    expect(DASHBOARD_HTML).toContain('id="subsManage"');
    expect(DASHBOARD_HTML).toContain('id="subsGate"');
    expect(DASHBOARD_HTML).toContain('<h3>Delivery</h3>');
    expect(DASHBOARD_HTML).toContain("fetch('/api/client/v1/subscriptions'");
    expect(DASHBOARD_HTML).toContain("fetch('/api/client/v1/commands'");
    expect(DASHBOARD_HTML).toContain("type: 'create_subscription'");
    expect(DASHBOARD_HTML).toContain('Sign in with Google to use Delivery');
    expect(DASHBOARD_HTML).toContain('updateDeliveryGate()');
    expect(DASHBOARD_HTML).not.toContain('Developer Alert Delivery');
    expect(DASHBOARD_HTML).not.toContain('>Alerts</button>');
    expect(DASHBOARD_HTML).not.toContain("fetch('/api/admin/subscriptions', {");
  });

  it('teaches the two paid delivery methods to signed-out visitors', () => {
    expect(DASHBOARD_HTML).toContain('id="subsMarketing"');
    expect(DASHBOARD_HTML).toContain('id="subsPush"');
    expect(DASHBOARD_HTML).toContain('<h3>Push Notifications</h3>');
    expect(DASHBOARD_HTML).toContain('one digest per new filing');
    expect(DASHBOARD_HTML).toContain('<h3>Alerts</h3>');
    expect(DASHBOARD_HTML).toContain('Get the Filing First');
    expect(DASHBOARD_HTML).toContain('Signed Webhooks');
    expect(DASHBOARD_HTML).toContain('HMAC-SHA256');
    expect(DASHBOARD_HTML).toContain('Live Stream (SSE)');
    expect(DASHBOARD_HTML).toContain('EventSource');
    expect(DASHBOARD_HTML).toContain('openPricing(\'alerts\')');
    // CTA hides for premium/admin via the existing premium-cue mechanism.
    expect(DASHBOARD_HTML).toContain('data-premium-cue="alerts"');
    // Pricing modal now sells the delivery methods.
    expect(DASHBOARD_HTML).toContain("intent === 'alerts'");
    expect(DASHBOARD_HTML).toContain('signed webhooks (HMAC-verified) to any URL');
    expect(DASHBOARD_HTML).toContain('Live SSE stream of every new filing');
  });

  it('filters by branch via the segmented H·S·P strip, congressional by default', () => {
    // The strip replaces the old two-option chamber selects in BOTH views
    // (the admin seed-backfill selector stays congressional by design).
    expect(DASHBOARD_HTML).not.toContain('>Both Chambers</option><option value="house">House</option>');
    expect(DASHBOARD_HTML).toContain('id="qChamber"');
    expect(DASHBOARD_HTML).toContain('id="trChamber"');
    expect(DASHBOARD_HTML).toMatch(/data-ch="executive"[^>]*aria-pressed="false"/);
    // H/S/P default unselected (like party chips): nothing on = all branches.
    expect(DASHBOARD_HTML).toMatch(/data-ch="house"[^>]*aria-pressed="false"/);
    expect(DASHBOARD_HTML).toMatch(/data-ch="senate"[^>]*aria-pressed="false"/);
    expect(DASHBOARD_HTML).toMatch(/data-ch="executive"[^>]*aria-pressed="false"/);
    // The executive toggle reads P (President), analogous to H and S — and each
    // letter carries the owner-specified hover text.
    expect(DASHBOARD_HTML).toContain('data-ch="house"');
    expect(DASHBOARD_HTML).toContain('data-ch="senate"');
    expect(DASHBOARD_HTML).toContain('data-ch="executive"');
    expect(DASHBOARD_HTML).toContain('class="ios-filter-pop"');
    expect(DASHBOARD_HTML).toContain('All Branches');
    expect(DASHBOARD_HTML).not.toContain('aria-controls="qChamberInfo"');
    expect(DASHBOARD_HTML).not.toContain('aria-controls="trChamberInfo"');
    expect(DASHBOARD_HTML).not.toContain('aria-controls="trPartyInfo"');
    expect(DASHBOARD_HTML).toContain("window.matchMedia('(hover: hover)').matches");
    // No selection = all chambers (no param); partial selection sends a CSV.
    expect(DASHBOARD_HTML).toContain("var CHAMBER_ALL = ['house', 'senate', 'executive']");
    expect(DASHBOARD_HTML).toContain('function chamberParam(');
    expect(DASHBOARD_HTML).toContain("initChamberChips('qChamber', 'shared-chambers-v1'");
    expect(DASHBOARD_HTML).toContain("initChamberChips('trChamber', 'shared-chambers-v1'");
    expect(DASHBOARD_HTML).toContain('<option value="all">All Time</option>');
    expect(DASHBOARD_HTML).not.toContain('id="searchPanel"');
    expect(DASHBOARD_HTML).not.toContain('id="qPageMinAmt"');
    expect(DASHBOARD_HTML).toContain("return on.length ? on.slice().sort().join(',') : '';");
    expect(DASHBOARD_HTML).toContain("if (ac) p.set('assetClass', ac)");
    expect(DASHBOARD_HTML).toContain('function exportCsv() {');
    expect(DASHBOARD_HTML).toContain('var p = tradesFilterParams();');
    // HSP sits on the same row as party chips; no redundant Timeframe label / Refresh.
    expect(DASHBOARD_HTML).toMatch(/class="[^"]*trends-filter-row[^"]*"/);

    // Regression (#1531 verifier): .trends-filter-row shares an element with
    // .toolbar; an inline-flex override made the Trends row shrink-to-fit on
    // desktop, breaking shared-row parity and the $-select right-align.
    expect(DASHBOARD_HTML).not.toMatch(/\.trends-filter-row\s*\{[^}]*inline-flex/);
    expect(DASHBOARD_HTML).toMatch(/\.trends-filter-row\s*\{[^}]*display:\s*flex/);
    expect(DASHBOARD_HTML).not.toContain('>Timeframe</label>');
    expect(DASHBOARD_HTML).not.toContain('↻ Refresh');
    expect(DASHBOARD_HTML).toContain('class="brand-logo"');
    expect(DASHBOARD_HTML).toContain('src="/assets/brand-logo-light.png');
    expect(DASHBOARD_HTML).not.toMatch(/class="brand-text"/);
  });

  it('renders the honest speed-vs-providers scoreboard on Trends', () => {
    expect(DASHBOARD_HTML).toContain('id="trLatencySection"');
    expect(DASHBOARD_HTML).toContain("fetch('/api/analytics/latency-summary')");
    // Filter-independent: not stamped with the Trends window chip and not in loadTrends.
    expect(DASHBOARD_HTML).not.toMatch(/Speed vs\. Data Providers[^<]*<\/h3[^>]*class="tf-h"/);
    expect(DASHBOARD_HTML).toContain('function renderSpeedProof(');
    // Honesty guard rails: lane threshold, concurrent-race empty-state copy,
    // losses always displayed, sample sizes visible, trademark fine print.
    expect(DASHBOARD_HTML).toContain('var SPEED_LANE_MIN_MATCHED = 2');
    expect(DASHBOARD_HTML).toContain("Probes haven't matched live new imports yet");
    expect(DASHBOARD_HTML).toContain('live new imports only');
    expect(DASHBOARD_HTML).toContain('<span class="sp-wlt-key">Losses</span>');
    expect(DASHBOARD_HTML).toContain('live matched · ');
    expect(DASHBOARD_HTML).toContain('A live measurement, not a promise');
    expect(DASHBOARD_HTML).toContain('trademarks of their respective owners');
    // Every comparable provider rides the same honesty rails — no name-based
    // exclusions (Quiver/Unusual Whales were once hidden here; owner restored).
    expect(DASHBOARD_HTML).not.toContain("p.label === 'Quiver Quantitative'");
    expect(DASHBOARD_HTML).not.toContain("p.label !== 'Quiver Quantitative'");
    // Accessible table twin + never buy/sell colors for the race.
    expect(DASHBOARD_HTML).toContain('id="speedTableBody"');
    expect(DASHBOARD_HTML).toContain('<th>Public</th>');
    expect(DASHBOARD_HTML).toContain('--rival');
    // Intentional OFF (grey) for FMP family — distinct from green running / red error.
    expect(DASHBOARD_HTML).toContain('.diag-status.off');
    expect(DASHBOARD_HTML).toContain('.sp-badge.off');
    expect(DASHBOARD_HTML).toContain('.sp-badge.shown');
    expect(DASHBOARD_HTML).toContain('.sp-badge.hidden-public');
    expect(DASHBOARD_HTML).toContain("p.operationalStatus === 'off'");
    expect(DASHBOARD_HTML).toContain('FMP_LATENCY_PROBE_ENABLED');
    // The public pager mirrors the server's anti-scrape offset cap.
    expect(DASHBOARD_HTML).toContain(`var MAX_PUBLIC_TRADES_OFFSET = ${MAX_PUBLIC_TX_OFFSET}`);
    // Trades pager: range-of-total count + full first/prev/next/last controls.
    expect(DASHBOARD_HTML).toContain('id="tradesCountMsg"');
    expect(DASHBOARD_HTML).toContain('id="firstPageBtn"');
    expect(DASHBOARD_HTML).toContain('id="prevPageBtn"');
    expect(DASHBOARD_HTML).toContain('id="nextPageBtn"');
    expect(DASHBOARD_HTML).toContain('id="lastPageBtn"');
    expect(DASHBOARD_HTML).toContain('function firstTradesPage(');
    expect(DASHBOARD_HTML).toContain('function lastTradesPage(');
    expect(DASHBOARD_HTML).toContain('function maxReachableTradesPage(');
    expect(DASHBOARD_HTML).toContain("aria-label=\"Trades pagination\"");
  });

  it('requires explicit review type/date and preserves an unknown owner', () => {
    expect(DASHBOARD_HTML).toContain('>Transaction type</option>');
    expect(DASHBOARD_HTML).toContain('>Owner unknown</option>');
    expect(DASHBOARD_HTML).not.toContain("t.txType || t.type || 'P'");
    expect(DASHBOARD_HTML).not.toContain("t.owner || 'self'");
    expect(DASHBOARD_HTML).toContain("needs an explicit transaction type and date");
  });

  it('surfaces durable human holds with an explicit Retry Auto action', () => {
    expect(DASHBOARD_HTML).toContain('agreementSuppressedAt');
    expect(DASHBOARD_HTML).toContain('>Retry Auto</button>');
    expect(DASHBOARD_HTML).toContain('/retry-auto');
    expect(DASHBOARD_HTML).toContain('body: JSON.stringify({ reviewRevision: item && item.reviewRevision })');
  });

  it('surfaces the GICS sector flow, market-cap, and performer analytics in Trends', () => {
    for (const id of ['trSectorFlow', 'trCapFlow', 'trPerformers']) {
      expect(DASHBOARD_HTML).toContain('id="' + id + '"');
    }
    for (const fn of ['function loadTrSectorFlow(', 'function loadTrCapFlow(', 'function loadTrPerformers(']) {
      expect(DASHBOARD_HTML).toContain(fn);
    }
    expect(DASHBOARD_HTML).toContain("aGet('sector-flow?'");
    expect(DASHBOARD_HTML).toContain("aGet('market-cap-breakdown?'");
    expect(DASHBOARD_HTML).toContain("aGet('member-performance?'");
  });

  it('renders By Asset Type with the same flowRow layout as By Market Cap (not crushed hbar labels)', () => {
    // Regression: #trSectors used inline .hbar with max-width:50% label/track
    // so long labels like "Government / Municipal Bonds" looked broken.
    expect(DASHBOARD_HTML).toContain('function loadTrSectors(');
    expect(DASHBOARD_HTML).toContain("aGet('sector-breakdown?'");
    // loadTrSectors must call the shared flowRowHtml helper (same as cap/party).
    const sectorsFn = DASHBOARD_HTML.match(/function loadTrSectors\(\) \{[\s\S]*?\n\}/);
    expect(sectorsFn?.[0] ?? '').toContain('flowRowHtml(');
    expect(sectorsFn?.[0] ?? '').not.toContain('class="hbar"');
    // And the broken special-case CSS must stay gone.
    expect(DASHBOARD_HTML).not.toContain('#trSectors .hbar .hlabel');
    expect(DASHBOARD_HTML).not.toContain('#trSectors .hbar .htrack');
  });

  it('wires the configurable column registry + chooser', () => {
    expect(DASHBOARD_HTML).toContain('var TRADES_COLS');
    expect(DASHBOARD_HTML).toContain('function renderTradesHeader(');
    expect(DASHBOARD_HTML).toContain('id="colChooser"');
    expect(DASHBOARD_HTML).toContain('id="colChooserBody"');
    expect(DASHBOARD_HTML).toContain('function resetCols(');
    expect(DASHBOARD_HTML).toContain("var COL_ORDER_KEY = 'feed-cols-order-v3'");
    expect(DASHBOARD_HTML).toContain('function moveColumn(');
    expect(DASHBOARD_HTML).toContain('Drag columns here to reorder the Trades table.');
    expect(DASHBOARD_HTML).toContain('draggable="true" data-colid');
    // the new date/lag columns the user asked for
    expect(DASHBOARD_HTML).toContain("id: 'traded'");
    expect(DASHBOARD_HTML).toContain("id: 'lag'");
    expect(DASHBOARD_HTML).toContain("id: 'published'");
    expect(DASHBOARD_HTML).toContain("id: 'filed'");
    expect(DASHBOARD_HTML).toContain("id: 'imported'");
  });

  it('gives mobile a compact sort control and hides the dead Columns chooser', () => {
    // The mobile-only sort select/direction toggle sits near the other feed filter
    // controls and shares sortKey/sortDir + the setSort() refetch path.
    expect(DASHBOARD_HTML).toContain('id="tradesSortMobile"');
    expect(DASHBOARD_HTML).toContain('id="mobileSortKey"');
    expect(DASHBOARD_HTML).toContain('onchange="handleMobileSortKeyChange()"');
    expect(DASHBOARD_HTML).toContain('id="mobileSortDirBtn"');
    expect(DASHBOARD_HTML).toContain('onclick="toggleMobileSortDir()"');
    expect(DASHBOARD_HTML).toContain('function mobileSortableCols(');
    expect(DASHBOARD_HTML).toContain('function syncMobileSortControl(');
    expect(DASHBOARD_HTML).toContain('function handleMobileSortKeyChange(');
    expect(DASHBOARD_HTML).toContain('function toggleMobileSortDir(');
    expect(DASHBOARD_HTML).toContain('setSort(sel.value)');
    expect(DASHBOARD_HTML).toContain('setSort(sortKey); // same key -> setSort() flips sortDir');
    // updateSortIndicators() is the single hook both setSort() and renderTradesHeader()
    // already call, so the mobile control resyncs from state restored/changed elsewhere.
    expect(DASHBOARD_HTML).toContain('syncMobileSortControl();\n}');
    expect(DASHBOARD_HTML).toContain('.trades-sort-mobile { display: none;');
    expect(DASHBOARD_HTML).toContain('#view-trades .pager-top .trades-sort-mobile { display: flex; }');
    // Columns chooser lives in the Options (⋯) menu; hidden on mobile because
    // tradesCardHtml() renders a fixed field set on phones.
    expect(DASHBOARD_HTML).toContain('feed-options-item-cols');
    expect(DASHBOARD_HTML).toContain('.feed-options-item-cols { display: none !important; }');
    expect(DASHBOARD_HTML).toContain('toggleFeedOptions');
    expect(DASHBOARD_HTML).toContain('id="exportCsvBtn"');
  });

  it('uses subtle Premium cues without implying the public feed is paywalled', () => {
    // Public feed + columns stay free. Premium is delivery + full-history CSV
    // (subtle Pro badge / gateRow CTA — not a paywalled feed).
    expect(DASHBOARD_HTML).not.toContain('data-premium-col');
    expect(DASHBOARD_HTML).not.toContain('Premium enrichment');
    expect(DASHBOARD_HTML).not.toContain("tier: 'premium'");
    expect(DASHBOARD_HTML).not.toContain('Premium Enrichment Columns');
    expect(DASHBOARD_HTML).not.toContain('Free view shows the last 30 days');
    expect(DASHBOARD_HTML).not.toContain('soon) real-time alerts');
    expect(DASHBOARD_HTML).not.toContain('Go Premium');
    // Export is Premium but cued subtly (Pro badge + pricing intent), not a hard feed wall.
    expect(DASHBOARD_HTML).toContain('data-premium-cue="export"');
    expect(DASHBOARD_HTML).toContain('Export CSV');
    expect(DASHBOARD_HTML).toContain('premium-mark');
  });

  it('gates Premium checkout copy and actions on server billing availability', () => {
    expect(DASHBOARD_HTML).toContain('billing: { checkoutConfigured: false, portalConfigured: false, hasCustomer: false }');
    expect(DASHBOARD_HTML).toContain('function checkoutConfigured()');
    expect(DASHBOARD_HTML).toContain("ME.billing = d.billing || { checkoutConfigured: false, portalConfigured: false, hasCustomer: false }");
    expect(DASHBOARD_HTML).toContain('Premium checkout is not available yet.');
    expect(DASHBOARD_HTML).toContain("el('subscribeBtn').disabled = !available");
    expect(DASHBOARD_HTML).toContain('checkoutConfigured() ? \'<button class="btn sm" type="button" onclick="openPricing()">Upgrade</button>\' : \'\'');
    expect(DASHBOARD_HTML).not.toContain('function billingConfigured()');
    // ?pricing=1 used to paint Billing Unavailable before /auth/me returned.
    expect(DASHBOARD_HTML).toContain('function applyPricingAvailability()');
    expect(DASHBOARD_HTML).toContain('ME.billingReady');
    expect(DASHBOARD_HTML).toContain('Checking Checkout…');
    expect(DASHBOARD_HTML).toContain('if (!ME.billingReady) loadMe()');
    expect(DASHBOARD_HTML).toContain('applyPricingAvailability()');
  });

  // ---- duplicate-subscription guard (pricing modal) ------------------------
  // Stripe opens a SECOND subscription on a customer that already has one, so
  // every route into the pricing modal while Premium (/pricing, ?pricing=1, the
  // footer link, the PDF redirect) was a double-billing hole. POST
  // /billing/checkout returns 409 already_subscribed; this is the surface half.
  describe('pricing modal duplicate-subscription guard', () => {
    interface FakeNode { hidden: boolean; disabled: boolean; textContent: string; innerHTML: string }

    function runApplyPricingAvailability(state: {
      billingReady?: boolean;
      premium?: boolean;
      source?: string | null;
      checkoutConfigured?: boolean;
      blocked?: string;
    }): Record<string, FakeNode> {
      const copy = DASHBOARD_HTML.match(/function pricingPremiumCopy\(\) \{[\s\S]*?\n\}/);
      const apply = DASHBOARD_HTML.match(/function applyPricingAvailability\(\) \{[\s\S]*?\n\}/);
      if (!copy || !apply) throw new Error('pricing availability functions were not found in DASHBOARD_HTML');
      const nodes: Record<string, FakeNode> = {};
      for (const id of ['pricingPlans', 'pricingTrialNote', 'pricingPremiumNote', 'subscribeBtn', 'pricingMsg']) {
        nodes[id] = { hidden: false, disabled: false, textContent: '', innerHTML: '' };
      }
      new Function(
        'ME', 'el', 'isPremium', 'checkoutConfigured', 'pricingBlockedMsg',
        `${copy[0]}\n${apply[0]}\napplyPricingAvailability();`,
      )(
        { billingReady: state.billingReady !== false, entitlement: { premium: !!state.premium, source: state.source ?? null } },
        (id: string) => nodes[id],
        () => !!state.premium,
        () => state.checkoutConfigured !== false,
        state.blocked ?? '',
      );
      return nodes;
    }

    it('replaces the plan grid with Manage Subscription for a Premium (Stripe) user', () => {
      const n = runApplyPricingAvailability({ premium: true, source: 'stripe' });
      expect(n.pricingPlans.hidden).toBe(true);
      expect(n.pricingTrialNote.hidden).toBe(true);
      expect(n.pricingPremiumNote.hidden).toBe(false);
      expect(n.pricingPremiumNote.innerHTML).toContain('You have Premium.');
      expect(n.pricingPremiumNote.innerHTML).toContain('billing portal');
      expect(n.subscribeBtn.textContent).toBe('Manage Subscription');
      expect(n.subscribeBtn.disabled).toBe(false);
      expect(n.pricingMsg.textContent).toBe('');
    });

    it('points an Apple IAP subscriber at the App Store, not a second Stripe purchase', () => {
      const n = runApplyPricingAvailability({ premium: true, source: 'apple' });
      expect(n.pricingPlans.hidden).toBe(true);
      expect(n.pricingPremiumNote.innerHTML).toContain('App Store');
      expect(n.pricingPremiumNote.innerHTML).toContain('Apple subscriptions');
      expect(n.subscribeBtn.textContent).toBe('Manage Subscription');
    });

    it('still offers the plan grid to a non-Premium visitor', () => {
      const n = runApplyPricingAvailability({ premium: false });
      expect(n.pricingPlans.hidden).toBe(false);
      expect(n.pricingTrialNote.hidden).toBe(false);
      expect(n.pricingPremiumNote.hidden).toBe(true);
      expect(n.subscribeBtn.textContent).toBe('Start Free Trial');
      expect(n.subscribeBtn.disabled).toBe(false);
    });

    it('keeps the server 409 reason visible through the loadMe repaint', () => {
      const n = runApplyPricingAvailability({ premium: false, blocked: 'You already have Premium through the App Store.' });
      expect(n.pricingMsg.textContent).toBe('You already have Premium through the App Store.');
      expect(n.pricingPlans.hidden).toBe(true);
      expect(n.subscribeBtn.textContent).toBe('Manage Subscription');
    });

    it('short-circuits startCheckout and handles 409 already_subscribed', () => {
      // Never POST a second checkout from a client that already knows it pays.
      expect(DASHBOARD_HTML).toContain('if (isPremium() || pricingBlockedMsg) { closePricing(); manageBilling(); return; }');
      // Server-side refusal: keep the reason, then re-sync from /auth/me.
      expect(DASHBOARD_HTML).toContain('if (res.status === 409) {');
      expect(DASHBOARD_HTML).toContain("pricingBlockedMsg = (res.j && res.j.message) || 'You already have a Premium subscription.'");
      // A fresh open must not inherit a previous refusal.
      expect(DASHBOARD_HTML).toContain("pricingBlockedMsg = '';");
    });
  });

  it('keeps Billing Portal management independent from checkout readiness', () => {
    expect(DASHBOARD_HTML).toContain('function portalConfigured()');
    expect(DASHBOARD_HTML).toContain('function hasBillingAccount()');
    expect(DASHBOARD_HTML).toContain('function canManageSubscription()');
    expect(DASHBOARD_HTML).toContain("source === 'apple'");
    expect(DASHBOARD_HTML).toContain('if (!portalConfigured())');
    expect(DASHBOARD_HTML).toContain('Manage Subscription');
    expect(DASHBOARD_HTML).toContain("credentials: 'same-origin'");
    expect(DASHBOARD_HTML).toContain("billing === 'manage'");
    expect(DASHBOARD_HTML).toContain('window.__pendingManageBilling');
  });

  it('sends stable per-operation idempotency keys for Stripe writes', () => {
    expect(DASHBOARD_HTML).toContain('function newBillingRequestId()');
    expect(DASHBOARD_HTML).toContain("'Idempotency-Key': checkoutRequestId");
    expect(DASHBOARD_HTML).toContain("'Idempotency-Key': portalRequestId");
    expect(DASHBOARD_HTML.match(/checkoutRequestId = null/g)).toHaveLength(2); // declaration + plan change
    expect(DASHBOARD_HTML.match(/portalRequestId = null/g)).toHaveLength(1); // declaration only
  });

  it('keeps account sign-out discoverable from the account menu', () => {
    expect(DASHBOARD_HTML).toContain('id="acctMenuBtn"');
    expect(DASHBOARD_HTML).toContain('<span class="acct-label">Account</span>');
    expect(DASHBOARD_HTML).not.toContain('id="themeToggle"');
    expect(DASHBOARD_HTML).toContain('white-space:nowrap; overflow:hidden; text-overflow:ellipsis;');
    expect(DASHBOARD_HTML).toContain('Sign Out');
    expect(DASHBOARD_HTML).toContain('function logout()');
    expect(DASHBOARD_HTML).toContain('Delete Account');
    expect(DASHBOARD_HTML).toContain("function deleteAccount()");
    expect(DASHBOARD_HTML).toContain("/auth/account/delete");
  });

  it('offers Google and Apple sign-in without email magic-link', () => {
    expect(DASHBOARD_HTML).toContain('id="loginOverlay"');
    expect(DASHBOARD_HTML).toContain('Sign in with Google');
    expect(DASHBOARD_HTML).toContain('id="appleSignInBtn"');
    expect(DASHBOARD_HTML).toContain('Sign in with Apple');
    expect(DASHBOARD_HTML).toContain("window.location.href = '/auth/google/start'");
    expect(DASHBOARD_HTML).toContain("window.location.href = '/auth/apple/start'");
    expect(DASHBOARD_HTML).not.toContain('id="magicEmail"');
    expect(DASHBOARD_HTML).not.toContain('function sendMagicLink(');
    expect(DASHBOARD_HTML).not.toContain('/auth/magic/request');
    expect(DASHBOARD_HTML).not.toContain('Send Link');
    expect(DASHBOARD_HTML).not.toContain('Email me a one-click sign-in link');
  });

  it('never renders a sign-in provider whose start route would bounce to auth_error', () => {
    // Regression guard for the dead "Sign In with Apple" button (board
    // 68c2884d).  /auth/apple/start 302s to /?auth_error=apple_web_not_configured
    // whenever web SIWA has no Services ID / key, and production STILL reports
    // {"enabled":true,"web":false} — so the button is only safe because it
    // ships hidden and is revealed by a server capability flag.  Both halves
    // are load-bearing: delete the inline display:none and every visitor gets
    // the dead button back; delete the ME.auth gate and it never appears even
    // once Apple web is configured.
    expect(DASHBOARD_HTML).toContain(
      '<a class="auth-btn abtn" id="appleSignInBtn" href="/auth/apple/start" style="display:none">',
    );
    expect(DASHBOARD_HTML).toContain(
      '<a class="auth-btn xbtn" id="xSignInBtn" href="/auth/x/start" onclick="loginX()" style="display:none">',
    );
    // Revealed only by the capabilities /auth/me reports (auth.appleWeb / auth.xWeb).
    expect(DASHBOARD_HTML).toContain('function syncAppleSignInButton()');
    expect(DASHBOARD_HTML).toContain('if (ME.auth && ME.auth.appleWeb) {');
    expect(DASHBOARD_HTML).toContain('if (ME.auth && ME.auth.xWeb) {');
    // Fail closed: a /auth/me that never resolves must leave both hidden, so
    // the gate runs on the success path AND the catch path.
    expect(DASHBOARD_HTML).toContain("ME.auth = { appleWeb: false }");
    // Google is configured in production and must NOT be hidden by default —
    // otherwise this guard would silently take out the only working provider.
    expect(DASHBOARD_HTML).toContain(
      '<button class="auth-btn gbtn" id="googleSignInBtn" onclick="loginGoogle()">',
    );
  });

  it('owner follow-up batch #6: removes the "pols" abbreviation — bare numbers in Politicians-headed table columns, full word only in prose', () => {
    // The u-full/u-abbr responsive-word mechanism and its polWord/polCell
    // helpers are gone entirely — dead once nothing renders "pol(s)" anymore.
    expect(DASHBOARD_HTML).not.toContain('function polWord(n)');
    expect(DASHBOARD_HTML).not.toContain('function polCell(n)');
    expect(DASHBOARD_HTML).not.toContain('class="u-full"');
    expect(DASHBOARD_HTML).not.toContain('class="u-abbr"');
    expect(DASHBOARD_HTML).not.toContain("n === 1 ? 'pol' : 'pols'");
    expect(DASHBOARD_HTML).not.toContain('@container ccard (max-width: 280px)');
    expect(DASHBOARD_HTML).not.toContain('.u-full {');
    expect(DASHBOARD_HTML).not.toContain('.u-abbr {');
    // tableTrTickers' "Politicians" column and tableTrTrending's "Recent
    // Politicians" column now render a bare number — no word, no abbr.
    // Display uses fmtCount (thousand separators); storage stays bare.
    expect(DASHBOARD_HTML).toContain("'<td class=\"muted\">' + fmtCount(r.memberCount || 0) + '</td>' +");
    expect(DASHBOARD_HTML).toContain("'<td class=\"muted\">' + fmtCount(r.recentMembers || 0) + '</td></tr>';");
    // Consensus Moves cluster cards are a prose/sub-caption context — the
    // full word "politicians" always spells out, never abbreviates.
    expect(DASHBOARD_HTML).toContain("politician' + (c.memberCount === 1 ? '' : 's') + ' · '");
    // Spacious surfaces (KPI strip, flow chips, drawers) keep their own
    // always-spell-out helper untouched.
    expect(DASHBOARD_HTML).toContain("function polFull(n)");
  });

  it('defaults theme to light and offers Light/Dark/System controls', () => {
    expect(DASHBOARD_HTML).toContain("var pref = 'light'");
    expect(DASHBOARD_HTML).toContain("return 'light'");
    expect(DASHBOARD_HTML).toContain('function setThemePref(pref)');
    expect(DASHBOARD_HTML).toContain('function themeRowHtml(pref, hideLabel)');
    expect(DASHBOARD_HTML).toContain('function themeSegHtml(pref)');
    expect(DASHBOARD_HTML).toContain('class="theme-seg"');
    expect(DASHBOARD_HTML).toContain('data-theme-opt');
    expect(DASHBOARD_HTML).toContain("id: 'light', label: 'Light'");
    expect(DASHBOARD_HTML).toContain("id: 'system', label: 'System'");
    expect(DASHBOARD_HTML).toContain('theme-row-label');
    expect(DASHBOARD_HTML).toContain('prefers-color-scheme: dark');
    expect(DASHBOARD_HTML).toContain('brand-logo-light.png');
  });

  it('requests separate light and dark ticker logos and swaps them with theme', () => {
    expect(DASHBOARD_HTML).toContain('function tickerLogoSrc(sym)');
    expect(DASHBOARD_HTML).toContain("'&theme=' + currentLogoTheme()");
    expect(DASHBOARD_HTML).toContain('function syncTickerLogoThemes(theme)');
    expect(DASHBOARD_HTML).toContain('syncTickerLogoThemes(theme)');
    expect(DASHBOARD_HTML).toContain("u.searchParams.set('theme', theme)");
  });

  // Owner 2026-08-21: "just delete the option" — Sepia was half-implemented
  // (only Trades/Trends were properly themed) and looked ugly, not like
  // paper.  Assert the palette, the picker entry, and every
  // html[data-theme="sepia"] CSS rule stay gone so a future PR can't
  // silently reintroduce it. The only surviving mentions of 'sepia' must be
  // the one-time localStorage migration that rewrites a returning visitor's
  // stored 'sepia' value to 'light' instead of letting it fail validation
  // forever — assert that migration is present in both the pre-paint boot
  // script and the runtime readThemePref().
  it('has fully removed the Sepia theme and migrates any stored preference to Light', () => {
    expect(DASHBOARD_HTML).not.toContain("label: 'Sepia'");
    expect(DASHBOARD_HTML).not.toContain('html[data-theme="sepia"]');
    expect(DASHBOARD_HTML).not.toContain("id: 'sepia'");
    expect(DASHBOARD_HTML).not.toContain('#f3e6d0');
    const sepiaMigrations = DASHBOARD_HTML.match(/if \(s === 'sepia'\)/g) || [];
    // Boot script + readThemePref() each migrate a stored 'sepia' value.
    expect(sepiaMigrations.length).toBe(2);
    expect(DASHBOARD_HTML).toContain("localStorage.setItem('ui-theme', 'light')");
  });

  it('contains mobile-first feed and navigation hooks', () => {
    expect(DASHBOARD_HTML).toContain('data-mobile="Trades"');
    expect(DASHBOARD_HTML).toContain('id="tradesCards"');
    expect(DASHBOARD_HTML).toContain('function tradesCardHtml(');
    expect(DASHBOARD_HTML).toContain('function handleTradesOpenEvent(');
    expect(DASHBOARD_HTML).toContain('function handleEntityOpenEvent(');
    expect(DASHBOARD_HTML).toContain("document.addEventListener('click'");
    expect(DASHBOARD_HTML).toContain('@media (max-width: 768px)');
    expect(DASHBOARD_HTML).toContain('(orientation: landscape) and (max-width: 950px)');
    expect(DASHBOARD_HTML).toContain('env(safe-area-inset-bottom)');
    expect(DASHBOARD_HTML).toContain('grid-template-columns: minmax(0, 1fr)');
    expect(DASHBOARD_HTML).toContain('nav.tabs {');
    expect(DASHBOARD_HTML).toContain('backdrop-filter: blur(20px)');
  });

  it('renders a dedicated one-time subscription secret panel', () => {
    expect(DASHBOARD_HTML).toContain('class="secret-panel"');
    expect(DASHBOARD_HTML).toContain('Save this secret now');
    expect(DASHBOARD_HTML).toContain('function copyFromData(');
    expect(DASHBOARD_HTML).toContain('Copy SSE URL');
  });

  it('wires the detail drawer (trade / asset / politician)', () => {
    expect(DASHBOARD_HTML).toContain('id="detailDrawer"');
    expect(DASHBOARD_HTML).toContain('id="detailDrawerBody"');
    expect(DASHBOARD_HTML).toContain('class="drawer-topbar"');
    expect(DASHBOARD_HTML).toContain('function openDrawer(');
    expect(DASHBOARD_HTML).toContain('function openTrade(');
    expect(DASHBOARD_HTML).toContain('function openAsset(');
    expect(DASHBOARD_HTML).toContain('function openMember(');
    // politician drawer hits the per-politician analytics endpoint
    expect(DASHBOARD_HTML).toContain("aGet('member/");
    // the old centered ticker modal is fully replaced by the drawer
    expect(DASHBOARD_HTML).not.toContain('tickerModal');
    // WEBA11Y-07: the drawer announces itself as a dialog and gets its name
    // from the (aria-hidden but still referenceable) topbar title span.
    expect(DASHBOARD_HTML).toContain(
      '<div class="drawer-panel" role="dialog" aria-modal="true" aria-labelledby="drawerTopbarTitle">',
    );
  });

  it('keeps mobile overlay controls dismissible and tap-safe', () => {
    expect(DASHBOARD_HTML).toContain('<dialog class="search-panel"');
    expect(DASHBOARD_HTML).toContain('function closePanels(');
    expect(DASHBOARD_HTML).toContain('function setPanelOpen(');
    expect(DASHBOARD_HTML).toContain('font-size:16px');
    expect(DASHBOARD_HTML).toContain('width:44px; height:44px');
  });

  it('formats dates and does not default unknown party to Independent', () => {
    expect(DASHBOARD_HTML).toContain('function dateText(');
    expect(DASHBOARD_HTML).toContain('function dateTimeText(');
    expect(DASHBOARD_HTML).toContain('function filedDetailText(');
    expect(DASHBOARD_HTML).toContain('Official Filing Date Unavailable');
    expect(DASHBOARD_HTML).toContain('function partyLabel(');
    expect(DASHBOARD_HTML).toContain("PARTY_NAME = { D: 'Democrat', R: 'Republican', O: 'Independent / Other' }");
    expect(DASHBOARD_HTML).not.toContain("p.partyBucket || 'O'");
    expect(DASHBOARD_HTML).not.toContain("esc(b || 'O')");
  });

  it('wires the per-trade performance line (price vs S&P)', () => {
    expect(DASHBOARD_HTML).toContain('function perfLineHtml(');
    expect(DASHBOARD_HTML).toContain("aGet('performance/");
    expect(DASHBOARD_HTML).toContain('tradeDatePerformance');
    expect(DASHBOARD_HTML).toContain('filingDatePerformance');
    expect(DASHBOARD_HTML).toContain('id="tradePerf"');
    expect(DASHBOARD_HTML).toContain('function companySectionHtml(');
  });

  it('wires politician dual performance (trade-date skill + filing-date copy-trade)', () => {
    expect(DASHBOARD_HTML).toContain('function memberPerfHtml(');
    expect(DASHBOARD_HTML).toContain("aGet('member/'");
    expect(DASHBOARD_HTML).toContain("/performance?' + trParams()");
    expect(DASHBOARD_HTML).toContain('id="memberPerf"');
    expect(DASHBOARD_HTML).toContain('Their timing (approx.)');
    expect(DASHBOARD_HTML).toContain('If you bought at filing');
    expect(DASHBOARD_HTML).toContain('avgExcessReturn');
    // Must not hardcode the misleading API-key gate on the politician drawer.
    expect(DASHBOARD_HTML).not.toContain(
      "Performance vs S&amp;P 500</h3>' + PERF_GATE",
    );
  });

  it('renders plain-English filing notes and clickable drawer entities', () => {
    expect(DASHBOARD_HTML).toContain('function filingNotesHtml(');
    expect(DASHBOARD_HTML).toContain('function looksLikeRawExtractionPayload(');
    expect(DASHBOARD_HTML).toContain('function looksLikeRawTransactionLine(');
    expect(DASHBOARD_HTML).toContain('function isExtractionNoteKey(');
    expect(DASHBOARD_HTML).toContain('Historical source note:');
    expect(DASHBOARD_HTML).toContain("if (looksLikeRawExtractionPayload(text)) return '';");
    expect(DASHBOARD_HTML).toContain("if (looksLikeRawTransactionLine(text)) return '';");
    expect(DASHBOARD_HTML).toContain("e.target.closest('[data-member]')");
    expect(DASHBOARD_HTML).toContain("e.target.closest('[data-txid]')");
    // The company-drawer title is NOT clickable (it would just reopen the same drawer);
    // clickable entities are the politician/asset links inside the drawer body instead.
    expect(DASHBOARD_HTML).not.toContain('drawer-title-line clickable');
    expect(DASHBOARD_HTML).toContain('drawer-member-title');
    expect(DASHBOARD_HTML).toContain('color:var(--text)');
    expect(DASHBOARD_HTML).not.toContain('<pre class="raw-notes">');
  });

  it('uses published timing, tighter asset defaults, and source links in drawers', () => {
    expect(DASHBOARD_HTML).toContain("var sortKey = 'txdate'");
    expect(DASHBOARD_HTML).toContain("var COL_HIDDEN_KEY = 'feed-cols-hidden-v4'");
    expect(DASHBOARD_HTML).toContain("var COL_ORDER_KEY = 'feed-cols-order-v3'");
    expect(DASHBOARD_HTML).toContain('function colHiddenKey()');
    expect(DASHBOARD_HTML).toContain('function colIsDefault(c)');
    expect(DASHBOARD_HTML).toContain("id: 'country', label: 'Country', sort: 'refCountry', def: false, defAdmin: true");
    expect(DASHBOARD_HTML).toContain("id: 'conf', label: 'Confidence', sort: 'conf', def: false, defAdmin: true, tier: 'admin'");
    expect(DASHBOARD_HTML).toContain("id: 'latency', label: 'Latency', sort: null, def: true, cls: 'latency', tier: 'admin'");
    expect(DASHBOARD_HTML).toContain("id: 'source', label: 'Source', sort: 'source', def: false, defAdmin: false, tier: 'admin'");
    expect(DASHBOARD_HTML).toContain('hiddenCols = loadHiddenCols().filter(function (id)');
    // Owner follow-up batch #13: the old asset cap (40-54px) sat below
    // asset's own 140px floor, silently pinning it there regardless of
    // content — replaced with a genuinely content-responsive range.
    expect(DASHBOARD_HTML).toContain("asset: estimatedColWidth('asset', 240, 200, 300)");
    // After a user column drag, table width = sum of cols (max-content / px total),
    // not min-width:100% fill that redistributes leftover into flex columns.
    expect(DASHBOARD_HTML).toContain('width: max-content');
    expect(DASHBOARD_HTML).not.toContain('min-width: 100%');
    expect(DASHBOARD_HTML).not.toContain('feed-col-widths-v7');
    expect(DASHBOARD_HTML).not.toContain('feed-col-widths-v8');
    expect(DASHBOARD_HTML).not.toContain('feed-col-widths-v9');
    expect(DASHBOARD_HTML).not.toContain('feed-col-widths-v10');
    expect(DASHBOARD_HTML).not.toContain('feed-col-widths-v11');
    expect(DASHBOARD_HTML).toContain('function dateTimeCellHtml(');
    expect(DASHBOARD_HTML).toContain('date-time-cell');
    expect(DASHBOARD_HTML).toContain('#tradesTable.resizable th { text-align: center;');
    expect(DASHBOARD_HTML).toContain('minColWidth(key)');
    expect(DASHBOARD_HTML).toContain("p.set('sort', apiSort)");
    // Unified search maps the single query into memberName/ticker server params.
    expect(DASHBOARD_HTML).toContain('function applySearchToServerParams(');
    expect(DASHBOARD_HTML).toContain("p.set('memberName', nameBits.join(' '))");
    expect(DASHBOARD_HTML).toContain('function handleTradesTextFilter(');
    expect(DASHBOARD_HTML).toContain('tradesRequestSeq');
    expect(DASHBOARD_HTML).toContain("arr.textContent = '↕'");
    expect(DASHBOARD_HTML).toContain('function seenDetailText(');
    expect(DASHBOARD_HTML).toContain('function miniSourceLinkHtml(');
    expect(DASHBOARD_HTML).toContain('function analyticsTradeRow(');
    expect(DASHBOARD_HTML).toContain('TRADE_BY_ID');
    expect(DASHBOARD_HTML).toContain("e.target.closest('a[href]:not(.clickable)')");
    expect(DASHBOARD_HTML).toContain('Official Filed');
  });

  it('keeps the resizable feed table stable — sane header-fit min-widths, a clamp against degenerate persisted widths, and a decoupled Latency header/body wrap (layout-stability follow-up, 2026-08-09)', () => {
    // Owner report (two screenshots): the Trades table rendered correctly at
    // first, then "on its own" (an admin session's two extra columns —
    // Imported/Latency — arriving once /auth/me resolves after boot, or a
    // live window resize) collapsed fixed columns to unreadable ellipsis
    // stubs ("DA…", "T…") and wrapped Latency's header one letter per line
    // ("L/A/T/E/N/C/Y"). Root cause: minColWidth() floors were smaller than
    // the columns' own header labels need, and the Latency column's header
    // shared its white-space:normal/word-break:break-word wrap CSS with the
    // (legitimately two-line) body cell. Storage key bumped v9->v10 because
    // widths persisted under the old, too-small floor are now structurally
    // incompatible with the new one; v10->v11 for grow/shrink table width.
    expect(DASHBOARD_HTML).toContain("var COL_WIDTH_KEY = 'feed-col-widths-v12'");
    expect(DASHBOARD_HTML).toContain('function plainCleaningNote(');
    expect(DASHBOARD_HTML).toContain('asset name derived from ticker');
    expect(DASHBOARD_HTML).toContain('var colWidthsUserAdjusted = false');
    expect(DASHBOARD_HTML).toContain('if (!colWidthsUserAdjusted && avail > total)');
    expect(DASHBOARD_HTML).toContain("table.style.width = total + 'px'");
    expect(DASHBOARD_HTML).toContain('colWidthsUserAdjusted = true');
    expect(DASHBOARD_HTML).toContain('function clampSavedWidth(key, raw)');

    // Only the BODY cell wraps two lines of real latency content; the header
    // (7-letter "Latency" label) now falls through to the same
    // nowrap+ellipsis base rule every other column header gets — never
    // white-space:normal, never word-break:break-word.
    expect(DASHBOARD_HTML).toContain('#tradesTable.resizable td.latency { white-space: normal; word-break: break-word; }');
    expect(DASHBOARD_HTML).not.toContain('th.c-latency, #tradesTable.resizable td.latency');
    expect(DASHBOARD_HTML).not.toContain('width: 55px; min-width: 55px; max-width: 55px');

    // Extract and actually RUN the real minColWidth/clampSavedWidth functions
    // (not just string-match their source) so a future edit that quietly
    // shrinks a floor back below its label's needs fails this test.
    const [minColWidthSrc, clampSavedWidthSrc] = loadDashboardFunctions(['minColWidth', 'clampSavedWidth']);
    const { minColWidth, clampSavedWidth } = new Function(
      `${minColWidthSrc}\n${clampSavedWidthSrc}\nreturn { minColWidth, clampSavedWidth };`,
    )() as { minColWidth: (key: string) => number; clampSavedWidth: (key: string, raw: unknown) => number | null };

    // Every compact/fixed column's floor must comfortably fit its own header
    // label (text + sort arrow + the resizable header's padding) — these
    // thresholds are the measured on-screen requirement plus headroom (see
    // the minColWidth doc comment), not arbitrary round numbers.
    const requiredFloors: Record<string, number> = {
      traded: 80, type: 90, amount: 100, sector: 95, country: 105,
      imported: 110, latency: 90, conf: 120, published: 80, lag: 70,
      owner: 90, filed: 140, chamber: 105, notes: 75, source: 95,
    };
    for (const [key, minRequired] of Object.entries(requiredFloors)) {
      expect(minColWidth(key), `minColWidth('${key}')`).toBeGreaterThanOrEqual(minRequired);
    }
    // Politician/Asset intentionally stay outside this floor — they keep the
    // flexible majority via estimatedColWidth/DEFAULT_CAP instead.
    expect(minColWidth('asset')).toBe(140);
    expect(minColWidth('member')).toBe(62);
    // An unknown/future column id still gets a real floor, not 0.
    expect(minColWidth('__unknown__')).toBeGreaterThanOrEqual(60);

    // clampSavedWidth is the load-time guard: a degenerate stored value
    // (too small, zero, negative, non-numeric, missing) must never be
    // trusted verbatim — it either gets floored up to minColWidth or
    // rejected outright (null, meaning "fall back to the natural width").
    expect(clampSavedWidth('type', 5)).toBe(minColWidth('type'));
    expect(clampSavedWidth('latency', 1)).toBe(minColWidth('latency'));
    expect(clampSavedWidth('country', -20)).toBeNull();
    expect(clampSavedWidth('imported', 0)).toBeNull();
    expect(clampSavedWidth('amount', NaN)).toBeNull();
    expect(clampSavedWidth('', 200)).toBeNull();
    // A legitimately large, user-dragged value passes through unclamped.
    expect(clampSavedWidth('asset', 260)).toBe(260);

    // The DEFAULT_CAP soft-caps used when no saved width exists must stay
    // >= their own column's floor, or they'd be dead weight (silently
    // overridden back up by syncTradesTableWidth on the very next pass).
    expect(DASHBOARD_HTML).toContain('traded: 100,\n    type: 90,\n    amount: 100,\n    sector: 130,\n    country: 120,\n    imported: 112,\n    latency: 120,\n    notes: 200');
  });

  it('keeps the polished table, drawer, and trends layout hooks', () => {
    expect(DASHBOARD_HTML).toContain('#tradesHead th { position: sticky');
    expect(DASHBOARD_HTML).toContain('border-right: 1px solid color-mix');
    expect(DASHBOARD_HTML).toContain('#tradesTable .c-member');
    expect(DASHBOARD_HTML).toContain('#tradesTable .c-asset');
    expect(DASHBOARD_HTML).toContain('<colgroup id="tradesCols"></colgroup>');
    expect(DASHBOARD_HTML).toContain('function syncTradesTableWidth(');
    expect(DASHBOARD_HTML).toContain('.clip-text { display:block;');
    expect(DASHBOARD_HTML).toContain('drawer-company-title');
    expect(DASHBOARD_HTML).toContain('drawer-stack-grid');
    expect(DASHBOARD_HTML).toContain('trend-members-grid');
    expect(DASHBOARD_HTML).toContain('.trend-grid2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));');
    expect(DASHBOARD_HTML).toContain('.trend-members-grid { display:grid; grid-template-columns:minmax(0, 1.6fr) minmax(0, .85fr);');
    expect(DASHBOARD_HTML).not.toContain('minmax(260px, .72fr)');
    expect(DASHBOARD_HTML).toContain('buySellText(');
    expect(DASHBOARD_HTML).toContain('0% matched the benchmark');
    expect(DASHBOARD_HTML).toContain('isJunkAssetString');
  });

  it('makes review documents linkable without showing false confidence for empty reads', () => {
    expect(DASHBOARD_HTML).toContain('function safeDocUrl(');
    expect(DASHBOARD_HTML).toContain('function reviewDocHtml(');
    expect(DASHBOARD_HTML).toContain('View Document');
    expect(DASHBOARD_HTML).toContain('No readable transactions');
    expect(DASHBOARD_HTML).toContain('Vision-read filing held for review');
    expect(DASHBOARD_HTML).toContain('Automated read below publish threshold');
    expect(DASHBOARD_HTML).toContain('rel="noopener noreferrer"');
  });

  it('pre-fills editable review rows from queued payloads or selected model readings', () => {
    expect(DASHBOARD_HTML).toContain('var REVIEW_RUNS');
    expect(DASHBOARD_HTML).toContain('function openQueuedReviewEditor(');
    expect(DASHBOARD_HTML).toContain('function useModelRows(');
    expect(DASHBOARD_HTML).toContain('function openReviewEditor(');
    expect(DASHBOARD_HTML).toContain('Review / Confirm');
    expect(DASHBOARD_HTML).toContain('Resolved Reviews');
    expect(DASHBOARD_HTML).toContain('All Filing Decisions');
    expect(DASHBOARD_HTML).toContain("fetch('/api/admin/ingestion-decisions?limit=200'");
    expect(DASHBOARD_HTML).toContain('function canUseAdmin()');
    expect(DASHBOARD_HTML).toContain('function renderDecisionHistory(');
    expect(DASHBOARD_HTML).toContain('var DECISIONS');
    expect(DASHBOARD_HTML).toContain('Use This Model');
    expect(DASHBOARD_HTML).toContain('Bake-Off Runs (');
    expect(DASHBOARD_HTML).toContain('Queued Extracted Rows');
    expect(DASHBOARD_HTML).toContain('Prefilled Rows');
    expect(DASHBOARD_HTML).toContain('REVIEW_AMOUNT_BRACKETS');
    expect(DASHBOARD_HTML).toContain('class="me-bracket"');
    expect(DASHBOARD_HTML).toContain('class="me-asset-type"');
    expect(DASHBOARD_HTML).toContain('HOUSE_REVIEW_ASSET_TYPES');
    expect(DASHBOARD_HTML).toContain('SENATE_REVIEW_ASSET_TYPES');
    expect(DASHBOARD_HTML).toContain('function reviewAssetTypeDatalistId(');
    expect(DASHBOARD_HTML).toContain('function reviewNormalizeAssetTypeValue(');
    expect(DASHBOARD_HTML).toContain('list="');
    expect(DASHBOARD_HTML).toContain('5P');
    expect(DASHBOARD_HTML).toContain('Municipal Security');
    expect(DASHBOARD_HTML).toContain('Stock Option');
    expect(DASHBOARD_HTML).toContain("assetTypeName: reviewAssetTypeName(assetType) || (g.querySelector('.me-asset-type-name').value || '').trim() || null");
    expect(DASHBOARD_HTML).toContain("tr.setAttribute('data-chamber', chamber || '')");
    expect(DASHBOARD_HTML).toContain('class="me-option"');
    expect(DASHBOARD_HTML).toContain('Option Contract');
    expect(DASHBOARD_HTML).toContain('class="me-cap"');
    expect(DASHBOARD_HTML).toContain('class="me-filing-status"');
    expect(DASHBOARD_HTML).toContain('class="me-subholding"');
    expect(DASHBOARD_HTML).toContain('class="me-location"');
    expect(DASHBOARD_HTML).toContain('class="me-description"');
    expect(DASHBOARD_HTML).toContain('class="me-supplemental"');
    expect(DASHBOARD_HTML).toContain("filingStatus: (g.querySelector('.me-filing-status').value || '').trim() || null");
    expect(DASHBOARD_HTML).not.toContain('class="me-min"');
    expect(DASHBOARD_HTML).not.toContain('class="me-max"');
    expect(DASHBOARD_HTML).toContain("tr.setAttribute('data-review-revision'");
    expect(DASHBOARD_HTML).toContain("reviewRevision: Number(tr && tr.getAttribute('data-review-revision'))");
    expect(DASHBOARD_HTML).not.toContain('JSON.stringify({ decision: decision, edits: [] })');
  });

  it('names Review Queue chips and bake-off rows by model id, not the OpenRouter transport', () => {
    expect(DASHBOARD_HTML).toContain('function reviewModelDisplayName(');
    expect(DASHBOARD_HTML).toContain("if (!model || model.toLowerCase() === 'openrouter') return 'unknown model'");
    expect(DASHBOARD_HTML).toContain('esc(modelName) + \' \' + (m.ok ? esc(conf) : \'ERR\')');
    expect(DASHBOARD_HTML).not.toContain("esc(m.provider) + ' ' + (m.ok ? esc(conf) : 'ERR')");
    expect(DASHBOARD_HTML).not.toContain("esc(m.provider + ':' + m.model)");

    const sources = loadDashboardFunctions([
      'esc',
      'fmtDuration',
      'fmtMs',
      'reviewModelDisplayName',
      'modelsSummaryHtml',
      'modelsTableHtml',
    ]);
    const helpers = new Function(
      sources.join('\n\n') + '\nreturn { reviewModelDisplayName, modelsSummaryHtml, modelsTableHtml };',
    )() as {
      reviewModelDisplayName: (m: { provider?: string; model?: string }) => string;
      modelsSummaryHtml: (models: Array<Record<string, unknown>>) => string;
      modelsTableHtml: (models: Array<Record<string, unknown>>) => string;
    };

    expect(helpers.reviewModelDisplayName({ provider: 'openrouter', model: 'google/gemini-2.5-pro' }))
      .toBe('google/gemini-2.5-pro');
    expect(helpers.reviewModelDisplayName({ provider: 'openrouter', model: 'anthropic/claude-sonnet-4' }))
      .toBe('anthropic/claude-sonnet-4');
    expect(helpers.reviewModelDisplayName({ provider: 'openrouter', model: 'openrouter' }))
      .toBe('unknown model');
    expect(helpers.reviewModelDisplayName({ provider: 'openrouter', model: '' }))
      .toBe('unknown model');
    expect(helpers.reviewModelDisplayName({ provider: 'openrouter' }))
      .toBe('unknown model');

    const chip = helpers.modelsSummaryHtml([{
      provider: 'openrouter',
      model: 'google/gemini-2.5-pro',
      ok: true,
      rowCount: 3,
      avgConfidence: 0.87,
      latencyMs: 1200,
    }]);
    expect(chip).toContain('google/gemini-2.5-pro 87%');
    expect(chip).toContain('title="openrouter:google/gemini-2.5-pro · 3 rows, conf 87%, 1s"');
    expect(chip).not.toMatch(/>\s*openrouter\s+87%/);
    expect(chip).not.toContain('>openrouter 87%');

    const missing = helpers.modelsSummaryHtml([{
      provider: 'openrouter',
      ok: true,
      rowCount: 1,
      avgConfidence: 0.5,
    }]);
    expect(missing).toContain('unknown model 50%');
    expect(missing).toContain('title="openrouter:unknown model · 1 rows, conf 50%"');
    expect(missing).not.toContain('>openrouter 50%');

    const table = helpers.modelsTableHtml([{
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-4',
      kind: 'bakeoff',
      ok: true,
      rowCount: 2,
      avgConfidence: 0.91,
      latencyMs: 800,
    }]);
    expect(table).toContain('anthropic/claude-sonnet-4');
    expect(table).toContain('<div class="muted">openrouter</div>');
    expect(table).not.toContain('openrouter:anthropic/claude-sonnet-4');
  });

  it('uses review totals for queue KPIs and reloads them after review actions', () => {
    expect(DASHBOARD_HTML).toContain('var REVIEW_TOTALS = null;');
    expect(DASHBOARD_HTML).toContain('REVIEW_TOTALS = data.totals || null');
    expect(DASHBOARD_HTML).toContain('typeof REVIEW_TOTALS.unresolved === \'number\'');
    expect(DASHBOARD_HTML).toContain("else { loadReview(); }");
    expect(DASHBOARD_HTML).toContain('.then(function () { loadReview(); loadTrades(); })');
  });

  it('wires a per-doc "Re-read with model…" bake-off control with multi-select', () => {
    expect(DASHBOARD_HTML).toContain('var REREAD_MODELS = BENCHMARK_CATALOG');
    expect(DASHBOARD_HTML).toContain('function rereadModelOptionsHtml(');
    expect(DASHBOARD_HTML).toContain('function rereadControlHtml(');
    expect(DASHBOARD_HTML).toContain('function rereadWithModel(');
    expect(DASHBOARD_HTML).toContain('Re-read with model');
    // multi-select allows picking 2-3 models in one submit
    expect(DASHBOARD_HTML).toContain('id="reread-sel-\' + esc(docId) + \'" multiple');
    expect(DASHBOARD_HTML).toContain('id="reread-btn-\' + esc(docId) + \'"');
    expect(DASHBOARD_HTML).toContain('id="reread-msg-\' + esc(docId) + \'"');
    // grouped by provider via optgroup
    expect(DASHBOARD_HTML).toContain("'<optgroup label=\"' + esc(p) + '\">'");
    // posts the existing bake-off endpoint scoped to this doc, persisted
    expect(DASHBOARD_HTML).toContain("fetch('/api/admin/bakeoff'");
    expect(DASHBOARD_HTML).toContain('JSON.stringify({ docIds: [docId], models: chosen, persist: true })');
    // in-flight state + inline error handling reuses the file\'s existing patterns
    expect(DASHBOARD_HTML).toContain('btn.disabled = true; sel.disabled = true;');
    expect(DASHBOARD_HTML).toContain("msg.textContent = 'Select at least one model.'");
    expect(DASHBOARD_HTML).toContain("isAuthError(e) ? ADMIN_MOVED_MSG : ('Re-read failed: ' + e.message)");
    // refreshes this doc's runs display after a successful re-read
    expect(DASHBOARD_HTML).toContain('viewReadings(docId); // refresh this doc\'s runs display with the new reading(s)');
  });

  it('derives every model menu from the ONE server-injected benchmark catalog, offered-only (no unconfigured direct providers)', () => {
    // The catalog is serialized from benchmarkSelectableCatalog() at module
    // load — no hand-maintained duplicate lists remain in the template, and
    // direct-provider LEGACY_CANDIDATES entries (Jay holds no API key for any
    // of them) never reach the checkbox grid, re-read menu, or quick-run select.
    expect(DASHBOARD_HTML).toContain('var BENCHMARK_CATALOG = [');
    expect(DASHBOARD_HTML).toContain('var REREAD_MODELS = BENCHMARK_CATALOG;');
    expect(DASHBOARD_HTML).not.toContain("{ provider: 'gemini', model: 'gemini-3.5-flash' }");
    const match = DASHBOARD_HTML.match(/var BENCHMARK_CATALOG = (\[[\s\S]*?\]);/);
    expect(match).not.toBeNull();
    const catalog = JSON.parse(match![1]) as Array<{ provider: string; model: string }>;
    const keys = catalog.map((m) => `${m.provider}:${m.model}`);

    // No direct-provider entry (LEGACY_CANDIDATES) reaches the offered UI —
    // those exist only for decode/replay of historical extraction_runs.
    const directProviders = ['gemini', 'openai', 'anthropic', 'mistral', 'xai'];
    expect(catalog.filter((m) => directProviders.includes(m.provider))).toEqual([]);

    // openrouter/auto and the higher-tier GPT-5.6 models are catalog-valid
    // (NON_OFFERED_CANDIDATES) but intentionally not offered here.
    expect(keys).not.toContain('openrouter:openrouter/auto');
    expect(keys).not.toContain('openrouter:openai/gpt-5.6-terra-pro');
    expect(keys).not.toContain('openrouter:openai/gpt-5.6-sol');

    // The routine OpenRouter lineup, including the newly added Opus 4.8, is present.
    expect(keys).toContain('openrouter:mistral/mistral-ocr-latest');
    expect(keys).toContain('openrouter:openai/gpt-5.6-terra');
    expect(keys).toContain('openrouter:deepseek/deepseek-v4-pro');
    expect(keys).toContain('openrouter:deepseek/deepseek-v4-flash');
    expect(keys).toContain('openrouter:google/gemini-3.8-flash');
    expect(keys).toContain('openrouter:~google/gemini-flash-latest');
    expect(keys).toContain('openrouter:anthropic/claude-opus-5');
    expect(keys).toContain('llamaparse:fast');
    // Dead-on-OpenRouter slugs and the retired GPT-4o family never render.
    expect(DASHBOARD_HTML).not.toContain('gpt-4o');
    expect(DASHBOARD_HTML).not.toContain('google/gemini-pro-1.5');
    expect(DASHBOARD_HTML).not.toContain('deepseek/deepseek-chat');
    expect(DASHBOARD_HTML).not.toContain('deepseek/deepseek-coder');
    expect(DASHBOARD_HTML).not.toContain('qwen/qwen-2.5-vl-72b-instruct:free');
    expect(DASHBOARD_HTML).not.toContain('moonshotai/kimi-chat');
    expect(DASHBOARD_HTML).not.toContain('minimax/minimax-hep-lite');
    // The AG #462 custom-selection checkbox grid and quick-run menu read the
    // same derived list, so they reflect catalog corrections automatically.
    expect(DASHBOARD_HTML).toContain('id="benchmarkModelCheckboxes"');
    expect(DASHBOARD_HTML).toContain('Custom Model Selection (for new runs)');
    expect(DASHBOARD_HTML).toContain('function benchmarkModelCheckboxesHtml() {\n  return REREAD_MODELS.map(');
    expect(DASHBOARD_HTML).toContain("return '<option value=\"\">-- Choose Model --</option>' + REREAD_MODELS.map(");
    expect(DASHBOARD_HTML).toContain('customModels = REREAD_MODELS.map(');
  });

  it('benchmarkManualOptionHtml surfaces a slot pinned outside the offered catalog instead of silently reselecting', () => {
    const catalog = [
      { provider: 'openrouter', model: 'openai/gpt-5.6-terra', configured: true },
      { provider: 'openrouter', model: 'openai/gpt-5.6-luna', configured: true },
    ];
    const benchmarkManualOptionHtml = loadBenchmarkManualOptionHtml({ settings: { catalog } });

    // Saved value present in the offered catalog: no synthetic option, exactly
    // the one matching <option> is selected.
    const inCatalog = benchmarkManualOptionHtml('openrouter:openai/gpt-5.6-terra');
    expect(inCatalog).not.toContain('not in offered list');
    expect((inCatalog.match(/ selected/g) || []).length).toBe(1);

    // Saved value pinned OUTSIDE the offered catalog (e.g. a targeted Sol run,
    // or a since-demoted NON_OFFERED_CANDIDATES model): must surface as an
    // explicit selected synthetic option instead of silently falling through
    // to the browser's default first-option selection, which would let an
    // unrelated "Save all five slots" click quietly overwrite the live value.
    const outOfCatalog = benchmarkManualOptionHtml('openrouter:openai/gpt-5.6-sol');
    expect(outOfCatalog).toContain(
      '<option value="openrouter:openai/gpt-5.6-sol" selected>openrouter:openai/gpt-5.6-sol (current — not in offered list)</option>',
    );
    expect((outOfCatalog.match(/ selected/g) || []).length).toBe(1);
  });

  it('renders ONE unified per-chamber Model slots (A–E) panel with a single save flow', () => {
    expect(DASHBOARD_HTML).toContain('id="benchmarkModelSlots"');
    expect(DASHBOARD_HTML).toContain('<h4>Model slots (A–E)</h4>');
    // Five labeled slot selects, populated from the server catalog.
    expect(DASHBOARD_HTML).toContain("id: 'slotModelA', slot: 'A', label: 'A — Primary extractor (reads every new filing first)'");
    expect(DASHBOARD_HTML).toContain("id: 'slotModelB', slot: 'B', label: 'B — Failover extractor (used when A fails)'");
    expect(DASHBOARD_HTML).toContain("id: 'slotModelC', slot: 'C', label: 'C — Agreement voter 1 (tier-1 pair)'");
    expect(DASHBOARD_HTML).toContain("id: 'slotModelD', slot: 'D', label: 'D — Agreement voter 2 (tier-1 pair)'");
    expect(DASHBOARD_HTML).toContain("id: 'slotModelE', slot: 'E', label: 'E — Agreement voter 3 (tier-2/3 escalation)'");
    expect(DASHBOARD_HTML).toContain('benchmarkManualOptionHtml(selected)');
    // One save button; the handler GETs fresh versions then PUTs roles (A/B)
    // followed by settings (C/D/E), reporting each call separately.
    expect(DASHBOARD_HTML).toContain('onclick="saveBenchmarkModelSlots()"');
    const save = DASHBOARD_HTML.match(/async function saveBenchmarkModelSlots\(\) \{[\s\S]*?\n\}/);
    expect(save).not.toBeNull();
    const gets = save![0].indexOf("apiCall('/api/admin/benchmark/roles/' + encodeURIComponent(chamber), 'GET')");
    const putRoles = save![0].indexOf("apiCall('/api/admin/benchmark/roles/' + encodeURIComponent(chamber), 'PUT'");
    const putSettings = save![0].indexOf("apiCall('/api/admin/benchmark/settings/' + encodeURIComponent(chamber), 'PUT'");
    expect(gets).toBeGreaterThan(0);
    expect(putRoles).toBeGreaterThan(gets);
    expect(putSettings).toBeGreaterThan(putRoles);
    expect(save![0]).toContain('expectedVersion: freshRoles.version');
    expect(save![0]).toContain('expectedVersion: freshSettings.version');
    expect(save![0]).toContain("outcomes.push('A/B not saved: ' + rolesError.message)");
    expect(save![0]).toContain("outcomes.push('C/D/E not saved: ' + lineupError.message)");
    // Client-side pre-checks stay, phrased for the A–E panel.
    expect(DASHBOARD_HTML).toContain('Choose a model for every slot (A–E).');
    expect(DASHBOARD_HTML).toContain('A (primary) and B (failover) must be different models.');
    expect(DASHBOARD_HTML).toContain('C, D, and E must be three different models.');
    // Provider distinctness is no longer a hard client-side gate.
    // Non-blocking provider-overlap advisory (a warning line, not an error).
    expect(DASHBOARD_HTML).toContain('tier-1 agreement shares a provider with the primary extractor — votes are less independent');
    expect(DASHBOARD_HTML).toContain('function updateBenchmarkSlotWarnings(');
    // Preview deployments stay read-only.
    expect(DASHBOARD_HTML).toContain('Preview is read-only; save the live model slots in production after approval.');
    // The benchmark-backed (sourceRunId) save flow survives below the panel.
    expect(DASHBOARD_HTML).toContain('sourceRunId: run.id');
    // The two replaced panels are fully gone — no orphaned ids or handlers.
    for (const gone of [
      'manualModelA', 'manualModelB', 'manualModelC',
      'roleModelPrimary', 'roleModelFailover',
      'benchmarkManualLineup', 'id="benchmarkRoles"',
      'saveManualBenchmarkLineup', 'saveBenchmarkRoles',
      'manualBenchmarkLineupStatus', 'benchmarkRolesStatus',
      'loadAllModelSettings', 'renderModelSettingsForChamber',
      'modelSettingsHouse', 'modelSettingsSenate', 'modelSettingsExec',
      'chamberSettings', 'chamberRoles',
      'Manual autopublish lineup', 'Primary / Failover extraction',
    ]) {
      expect(DASHBOARD_HTML).not.toContain(gone);
    }
  });

  it('persists branch benchmarks and exposes measured cost, speed, history, simulation, and lineup save controls', () => {
    expect(DASHBOARD_HTML).toContain('id="benchmarkHistory"');
    expect(DASHBOARD_HTML).toContain("selectBenchmarkChamber('house')");
    expect(DASHBOARD_HTML).toContain("selectBenchmarkChamber('senate')");
    expect(DASHBOARD_HTML).toContain("selectBenchmarkChamber('executive')");
    expect(DASHBOARD_HTML).toContain("'/api/admin/benchmark/runs?chamber='");
    expect(DASHBOARD_HTML).toContain("'/api/admin/benchmark/runs/' + encodeURIComponent(run.id) + '/complete'");
    expect(DASHBOARD_HTML).toContain("'/simulate'");
    expect(DASHBOARD_HTML).toContain("'/api/admin/benchmark/settings/'");
    expect(DASHBOARD_HTML).toContain("'/api/admin/benchmark/runs?chamber=' + encodeURIComponent(chamber)");
    expect(DASHBOARD_HTML).toContain("onclick=\"clearBenchmarkHistory()\"");
    expect(DASHBOARD_HTML).toContain('Model slots (A–E)');
    expect(DASHBOARD_HTML).toContain('saveBenchmarkModelSlots');
    expect(DASHBOARD_HTML).toContain('runAllBenchmarks()');
    expect(DASHBOARD_HTML).toContain('result.reusedCells');
    expect(DASHBOARD_HTML).toContain('callsNeedingReservation');
    expect(DASHBOARD_HTML).toContain('confirmPaidRun: true');
    expect(DASHBOARD_HTML).toContain('resolvedOnly: false');
    expect(DASHBOARD_HTML).toContain('Measured usage-based cost');
    expect(DASHBOARD_HTML).toContain('Measured usage-based spend');
    expect(DASHBOARD_HTML).toContain('provider-reported charges where available, otherwise actual metered units × pinned list price');
    expect(DASHBOARD_HTML).toContain('This is not invoice reconciliation.');
    expect(DASHBOARD_HTML).toContain('Tier 1 executes A then B; disagreement adds a fresh A then B then C tier.');
    expect(DASHBOARD_HTML).toContain('An expired cell may already have been billed');
    expect(DASHBOARD_HTML).toContain('this confirmation authorizes a new-day reservation for each remaining cell');
    expect(DASHBOARD_HTML).toContain("error.details.code === 'benchmark_attempt_outcome_unknown'");
    expect(DASHBOARD_HTML).toContain('body.confirmRetryAfterUnknownOutcome = true');
    expect(DASHBOARD_HTML).toContain('result.auditPersisted === false');
    expect(DASHBOARD_HTML).toContain('Settings were saved and verified, but the benchmark receipt was not persisted.');
    expect(DASHBOARD_HTML).toContain('avg / p50 / p95');
    expect(DASHBOARD_HTML).toContain('Cost coverage');
    expect(DASHBOARD_HTML).toContain('Save as ');
    expect(DASHBOARD_HTML).toContain('three different models');
    expect(DASHBOARD_HTML).not.toContain('var MODEL_COSTS');
    expect(DASHBOARD_HTML).not.toContain('Based on model list pricing');
  });

  it('labels interrupted benchmark cells as pending instead of unavailable', () => {
    const { benchmarkRunCellProgress, benchmarkModelPresentation } = loadBenchmarkPresentationHelpers();
    const models = [
      ['gemini', 'gemini-3.5-flash'],
      ['openai', 'gpt-5.6-terra'],
      ['openai', 'gpt-5.6-luna'],
      ['openai', 'gpt-5.6-sol'],
      ['openai', 'gpt-4o'],
      ['anthropic', 'claude-sonnet-5'],
      ['anthropic', 'claude-sonnet-5'],
      ['mistral', 'mistral-ocr-latest'],
      ['xai', 'grok-4.3'],
      ['llamaparse', 'fast'],
      ['llamaparse', 'cost-effective'],
      ['llamaparse', 'agentic'],
    ].map(([provider, model]) => ({ provider, model }));
    const results: Array<Record<string, unknown>> = [];
    for (const ref of models.slice(0, 8)) {
      for (let index = 0; index < 25; index++) {
        const ok = ref.model === 'gpt-4o' || ref.provider === 'mistral';
        results.push({
          ...ref,
          docId: 'D-' + index,
          outcome: ok ? 'would_publish' : 'skipped',
          invoked: true,
          ok,
          autonomous: ok,
          latencyMs: 100,
          costUsd: ok ? 0.001 : null,
          perfectMatch: index < 23 ? false : null,
        });
      }
    }
    for (let index = 0; index < 15; index++) {
      results.push({
        provider: 'xai', model: 'grok-4.3', docId: 'D-' + index, outcome: 'would_publish',
        invoked: index < 13, ok: index < 13, autonomous: index < 13,
        latencyMs: index < 13 ? 200 : null, costUsd: index < 13 ? 0.001 : null,
        perfectMatch: index < 13 ? false : null,
        error: index < 13 ? null : 'document_load_failed',
      });
    }
    // A claimed-but-unfinished cell stays pending and must not become unavailable.
    results.push({
      provider: 'llamaparse', model: 'fast', docId: 'D-0', outcome: 'running',
      invoked: false, ok: false, autonomous: false, latencyMs: null, costUsd: null,
    });
    const run = { status: 'running', requestedDocCount: 25, models, results };

    expect(benchmarkRunCellProgress(run)).toMatchObject({
      planned: 300,
      completed: 215,
      invoked: 213,
      success: 63,
      failures: 150,
      unavailable: 2,
      claimed: 1,
      pending: 85,
    });
    expect(benchmarkModelPresentation(run, { provider: 'xai', model: 'grok-4.3' })).toMatchObject({
      plannedDocs: 25,
      docsMeasured: 15,
      providerCalls: 13,
      docsOk: 13,
      unavailableDocs: 2,
      pendingDocs: 10,
    });
    expect(benchmarkModelPresentation(run, { provider: 'llamaparse', model: 'fast' })).toMatchObject({
      plannedDocs: 25,
      docsMeasured: 0,
      providerCalls: 0,
      unavailableDocs: 0,
      claimedDocs: 1,
      pendingDocs: 25,
    });
    expect(benchmarkModelPresentation(run, { provider: 'llamaparse', model: 'agentic' })).toMatchObject({
      docsMeasured: 0,
      unavailableDocs: 0,
      claimedDocs: 0,
      pendingDocs: 25,
    });
  });

  it('separates success latency from failed-attempt latency and exposes saved diagnostics', () => {
    const { benchmarkModelPresentation } = loadBenchmarkPresentationHelpers();
    const model = { provider: 'openai', model: 'gpt-test' };
    const run = {
      status: 'running',
      requestedDocCount: 4,
      models: [model],
      results: [
        {
          ...model, docId: 'H-1', outcome: 'would_publish', invoked: true, ok: true,
          autonomous: true, latencyMs: 500, costUsd: 0.01, perfectMatch: true,
          truePositive: 1, falsePositive: 0, falseNegative: 0,
        },
        {
          ...model, docId: 'H-2', outcome: 'skipped', invoked: true, ok: false,
          autonomous: false, latencyMs: 20, costUsd: null, perfectMatch: false,
          truePositive: 0, falsePositive: 0, falseNegative: 1,
          costDetail: { unknownReason: 'usage_not_reported' },
          result: { failure: { code: 'model_not_found', scope: 'model', retryable: false, message: 'Model is unavailable' } },
        },
        {
          ...model, docId: 'H-3', outcome: 'skipped', invoked: false, ok: false,
          autonomous: false, latencyMs: null, costUsd: null, perfectMatch: null,
          error: 'document_load_failed',
        },
        {
          ...model, docId: 'H-4', outcome: 'running', invoked: false, ok: false,
          autonomous: false, latencyMs: null, costUsd: null,
        },
      ],
    };
    const presentation = benchmarkModelPresentation(run, model) as {
      f1: number;
      autonomyRate: number;
      unavailableDocs: number;
      pendingDocs: number;
      claimedDocs: number;
      successLatency: { count: number; avgLatencyMs: number };
      failureLatency: { count: number; avgLatencyMs: number };
      errorGroups: Array<{ key: string; count: number }>;
      unknownCostGroups: Array<{ key: string; count: number }>;
      errorSamples: Array<{ code: string; scope: string; retryable: boolean }>;
    };

    expect(presentation).toMatchObject({
      f1: 2 / 3,
      autonomyRate: 1,
      unavailableDocs: 1,
      pendingDocs: 1,
      claimedDocs: 1,
      successLatency: { count: 1, avgLatencyMs: 500 },
      failureLatency: { count: 1, avgLatencyMs: 20 },
    });
    expect(presentation.errorGroups).toEqual([
      { key: 'document_unavailable', count: 1 },
      { key: 'model_not_found', count: 1 },
    ]);
    expect(presentation.unknownCostGroups).toEqual([{ key: 'usage_not_reported', count: 1 }]);
    expect(presentation.errorSamples[0]).toMatchObject({
      code: 'model_not_found', scope: 'model', retryable: false,
    });
  });

  it('redacts legacy provider, project, request, account, key, token, and URL identifiers', () => {
    const { benchmarkModelPresentation } = loadBenchmarkPresentationHelpers();
    const model = { provider: 'openai', model: 'gpt-test' };
    const presentation = benchmarkModelPresentation({
      status: 'completed',
      requestedDocCount: 1,
      models: [model],
      results: [{
        ...model,
        docId: 'H-1',
        outcome: 'skipped',
        invoked: true,
        ok: false,
        autonomous: false,
        costUsd: null,
        error: 'project proj_secret request req_secret account acct_secret key sk-secret123456 token: token-secret Authorization: Bearer bearer-secret https://api.example.test/private',
      }],
    }, model) as { errorSamples: Array<{ message: string }> };
    const message = presentation.errorSamples[0].message;

    expect(message).toContain('[redacted-id]');
    expect(message).toContain('[redacted-key]');
    expect(message).toContain('Bearer [redacted]');
    expect(message).toContain('[redacted-url]');
    expect(message).not.toMatch(/proj_secret|req_secret|acct_secret|sk-secret|token-secret|bearer-secret|api\.example/);
  });

  it('classifies legacy model access errors before generic 403 authentication failures', () => {
    const { benchmarkModelPresentation } = loadBenchmarkPresentationHelpers();
    const model = { provider: 'openai', model: 'gpt-restricted' };
    const presentation = benchmarkModelPresentation({
      status: 'completed',
      requestedDocCount: 2,
      models: [model],
      results: [
        {
          ...model, docId: 'H-1', outcome: 'skipped', invoked: true, ok: false,
          error: '403 model_not_found: this project does not have access to the requested model',
        },
        {
          ...model, docId: 'H-2', outcome: 'skipped', invoked: true, ok: false,
          error: '403 Forbidden: invalid API key',
        },
      ],
    }, model) as { errorGroups: Array<{ key: string; count: number }> };

    expect(presentation.errorGroups).toEqual([
      { key: 'authentication_failed', count: 1 },
      { key: 'model_unavailable', count: 1 },
    ]);
  });

  it('only admits completed models with successful scored readings to simulation', () => {
    const { benchmarkModelEligibleForSimulation } = loadBenchmarkPresentationHelpers();
    expect(benchmarkModelEligibleForSimulation({
      pendingDocs: 0, plannedDocs: 25, providerCalls: 25, docsOk: 25,
      failures: 0, unavailableDocs: 0, successfulScoredDocs: 23,
    })).toBe(true);
    expect(benchmarkModelEligibleForSimulation({
      pendingDocs: 25, plannedDocs: 25, providerCalls: 0, docsOk: 0,
      failures: 0, unavailableDocs: 0, successfulScoredDocs: 0,
    })).toBe(false);
    expect(benchmarkModelEligibleForSimulation({
      pendingDocs: 0, plannedDocs: 25, providerCalls: 25, docsOk: 0,
      failures: 25, unavailableDocs: 0, successfulScoredDocs: 0,
    })).toBe(false);
    expect(benchmarkModelEligibleForSimulation({
      pendingDocs: 0, plannedDocs: 25, providerCalls: 25, docsOk: 25,
      failures: 0, unavailableDocs: 0, successfulScoredDocs: 0,
    })).toBe(false);
    expect(benchmarkModelEligibleForSimulation({
      pendingDocs: 0, plannedDocs: 25, providerCalls: 25, docsOk: 24,
      failures: 1, unavailableDocs: 0, successfulScoredDocs: 23,
    })).toBe(true);
    expect(DASHBOARD_HTML).toContain('Simulation is disabled for this ');
    expect(DASHBOARD_HTML).toContain('completed models with successful scored readings');
    expect(DASHBOARD_HTML).toContain('unavailable, failed-only, unscored, or incomplete');
  });

  it('runs benchmark document chunks breadth-first across all models', () => {
    const source = DASHBOARD_HTML.match(/async function runChamberBenchmark\(chamber, options\) \{[\s\S]*?\n\}/);
    if (!source) throw new Error('Benchmark runner was not found');
    const chunkLoop = source[0].indexOf('for (var start = 0; start < docs.length; start += concurrency)');
    const modelLoop = source[0].indexOf('for (var modelIndex = 0; modelIndex < models.length; modelIndex++)');
    expect(chunkLoop).toBeGreaterThan(0);
    expect(modelLoop).toBeGreaterThan(chunkLoop);
    expect(source[0]).toContain('var concurrency = 5');
    expect(source[0]).toContain('Completed cells remain cached and are reused on Resume.');
    expect(source[0]).toContain('models = run.models || models');
    expect(source[0]).toContain('Known-unavailable GPT-5.6 models');
  });

  it('lets an operator terminalize a paused run while keeping partial results', () => {
    expect(DASHBOARD_HTML).toContain('id="btnCancelBenchmark"');
    expect(DASHBOARD_HTML).toContain('Stop and keep partial results');
    expect(DASHBOARD_HTML).toContain("'/api/admin/benchmark/runs/' + encodeURIComponent(run.id) + '/cancel'");
    expect(DASHBOARD_HTML).toContain("run.error === 'cancelled_by_operator'");
    expect(DASHBOARD_HTML).toContain('stopped (partial results kept)');
    expect(DASHBOARD_HTML).toContain("? 'Start new ' : 'Run '");
    expect(DASHBOARD_HTML).toContain('This cannot be resumed; use Start New for a clean run.');
    expect(DASHBOARD_HTML).toContain('A cell already claimed or in flight may still finish and incur a provider charge.');
    expect(DASHBOARD_HTML).toContain("run.chamber === benchmarkState.chamber && run.status === 'running'");
    expect(DASHBOARD_HTML).toContain('Select the paused ');
    expect(DASHBOARD_HTML).toContain('before starting a clean run.');
  });

  it('warns after a saved run with provider failures instead of claiming an unqualified success', () => {
    const { benchmarkCompletionFeedback } = loadBenchmarkPresentationHelpers();
    const model = { provider: 'openai', model: 'gpt-test' };
    const failed = benchmarkCompletionFeedback('House', {
      status: 'completed', requestedDocCount: 1, models: [model],
      results: [{ ...model, outcome: 'skipped', invoked: true, ok: false, costUsd: null }],
    }, 0);
    expect(failed.warning).toBe(true);
    expect(failed.message).toContain('1 provider failure');
    expect(failed.message).toContain('Review diagnostics');

    const accessFiltered = benchmarkCompletionFeedback('House', {
      status: 'completed', requestedDocCount: 1, models: [model],
      results: [{ ...model, outcome: 'would_publish', invoked: true, ok: true, costUsd: 0.01 }],
    }, 0, 3);
    expect(accessFiltered.message).toContain('3 known-unavailable models excluded before paid calls');

    const successful = benchmarkCompletionFeedback('Senate', {
      status: 'completed', requestedDocCount: 1, models: [model],
      results: [{ ...model, outcome: 'would_publish', invoked: true, ok: true, costUsd: 0.01 }],
    }, 0);
    expect(successful).toEqual({ warning: false, message: 'Senate benchmark saved.' });
  });

  it('renders explicit progress, paused state, diagnostics, and split latency labels', () => {
    expect(DASHBOARD_HTML).toContain("return active ? 'running in this browser' : 'paused / resumable'");
    expect(DASHBOARD_HTML).toContain("(model.docsOk || 0) + ' success / ' + model.plannedDocs + ' planned'");
    expect(DASHBOARD_HTML).toContain("model.docsMeasured + ' measured · ' + model.providerCalls + ' invoked · '");
    expect(DASHBOARD_HTML).toContain("' unavailable · ' + model.pendingDocs + ' pending'");
    expect(DASHBOARD_HTML).toContain('Successful calls: ');
    expect(DASHBOARD_HTML).toContain('Failed attempts: ');
    expect(DASHBOARD_HTML).toContain('Failure classes:');
    expect(DASHBOARD_HTML).toContain('Unknown-cost reasons:');
    expect(DASHBOARD_HTML).toContain('they are not counted as unavailable');
    expect(DASHBOARD_HTML).toContain('progress loads on selection');
    expect(DASHBOARD_HTML).toContain('<th scope="col">Exact document match</th>');
    expect(DASHBOARD_HTML).toContain('<th scope="col">Row-detection F1</th>');
    expect(DASHBOARD_HTML).toContain('optional metadata is excluded from row identity');
    expect(DASHBOARD_HTML).toContain('function benchmarkModelAccessPreflightHtml(run)');
    expect(DASHBOARD_HTML).toContain('excluded before paid-call reservation and remain saved with this run');
  });

  it('never labels aggregate partial spend as per-document benchmark cost', () => {
    const usdSource = DASHBOARD_HTML.match(/function benchmarkUsd\(value\) \{[\s\S]*?\n\}/);
    const costSource = DASHBOARD_HTML.match(/function benchmarkCostText\(perDocument, covered, calls, knownCostUsd\) \{[\s\S]*?\n\}/);
    expect(usdSource).not.toBeNull();
    expect(costSource).not.toBeNull();
    const costText = new Function(
      usdSource![0] + '\n' + costSource![0] + '\nreturn benchmarkCostText;',
    )() as (perDocument: number | null, covered: number, calls: number, knownCostUsd?: number | null) => string;

    expect(costText(0.012, 2, 2)).toBe('$0.012');
    expect(costText(null, 1, 2, 0.1160589)).toBe('$0.116 known (partial)');
    expect(costText(null, 1, 2)).toBe('Unknown (partial)');
    expect(costText(null, 0, 2)).toBe('Unknown');
    expect(costText(null, 0, 0)).toBe('N/A');
    expect(DASHBOARD_HTML).not.toContain("benchmarkUsd(known) + '+ partial'");
  });

  it('requires one explicit confirmation before retrying an unknown paid benchmark outcome', async () => {
    const combined = DASHBOARD_HTML.match(
      /function confirmBenchmarkUnknownOutcomeRetry\(docId, model\) \{[\s\S]*?\n\}\n\nasync function runBenchmarkCell\(runId, docId, model\) \{[\s\S]*?\n\}\n\nasync function runChamberBenchmark/,
    );
    expect(combined).not.toBeNull();
    const source = combined![0].replace(/\n\nasync function runChamberBenchmark[\s\S]*$/, '');
    const model = { provider: 'openai', model: 'gpt-4o' };
    const state = { unknownOutcomeRetryDecision: null as boolean | null };
    const confirm = vi.fn(() => true);
    const bodies: Array<Record<string, unknown>> = [];
    let calls = 0;
    const apiCall = vi.fn(async (_path: string, _method: string, body: Record<string, unknown>) => {
      bodies.push({ ...body });
      calls++;
      if (calls === 1) {
        throw Object.assign(new Error('unknown provider outcome'), {
          status: 409,
          details: { code: 'benchmark_attempt_outcome_unknown' },
        });
      }
      return { pending: false, ok: true };
    });
    const runCell = new Function(
      'apiCall',
      'benchmarkState',
      'window',
      'benchmarkModelKey',
      source + '\nreturn runBenchmarkCell;',
    )(
      apiCall,
      state,
      { confirm },
      (value: { provider: string; model: string }) => value.provider + ':' + value.model,
    ) as (runId: string, docId: string, model: { provider: string; model: string }) => Promise<unknown>;

    await expect(runCell('run-1', 'H-1', model)).resolves.toMatchObject({ ok: true });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(bodies[0]).toMatchObject({ confirmPaidRun: true });
    expect(bodies[0]).not.toHaveProperty('confirmRetryAfterUnknownOutcome');
    expect(bodies[1]).toMatchObject({ confirmRetryAfterUnknownOutcome: true });

    const declinedApi = vi.fn(async () => {
      throw Object.assign(new Error('unknown provider outcome'), {
        status: 409,
        details: { code: 'benchmark_attempt_outcome_unknown' },
      });
    });
    const declinedConfirm = vi.fn(() => false);
    const declinedRunCell = new Function(
      'apiCall',
      'benchmarkState',
      'window',
      'benchmarkModelKey',
      source + '\nreturn runBenchmarkCell;',
    )(
      declinedApi,
      { unknownOutcomeRetryDecision: null },
      { confirm: declinedConfirm },
      (value: { provider: string; model: string }) => value.provider + ':' + value.model,
    ) as (runId: string, docId: string, model: { provider: string; model: string }) => Promise<unknown>;

    await expect(declinedRunCell('run-1', 'H-1', model)).rejects.toThrow(/Retry was not confirmed/);
    expect(declinedConfirm).toHaveBeenCalledTimes(1);
    expect(declinedApi).toHaveBeenCalledTimes(1);
  });

  it('keeps House history backfill bounded from the admin UI', () => {
    expect(DASHBOARD_HTML).toContain('id="hiMax"');
    expect(DASHBOARD_HTML).toContain('value="500"');
    expect(DASHBOARD_HTML).toContain('maxFilings: max');
    expect(DASHBOARD_HTML).toContain('Dry Run only counts');
  });

  it('surfaces admin diagnostics for connections and app errors', () => {
    expect(DASHBOARD_HTML).toContain('Connection Status');
    expect(DASHBOARD_HTML).toContain('Recent App Errors');
    expect(DASHBOARD_HTML).toContain('id="diagConnections"');
    expect(DASHBOARD_HTML).toContain('id="diagErrors"');
    expect(DASHBOARD_HTML).toContain("fetch('/api/admin/diagnostics'");
    expect(DASHBOARD_HTML).toContain('function loadDiagnostics(');
  });

  it('surfaces market-data coverage and bounded backfill controls in Admin', () => {
    expect(DASHBOARD_HTML).toContain('Market Data Coverage');
    expect(DASHBOARD_HTML).toContain('id="marketCoverage"');
    expect(DASHBOARD_HTML).toContain('function loadMarketCoverage(');
    expect(DASHBOARD_HTML).toContain("fetch('/api/admin/enrich-securities/status'");
    expect(DASHBOARD_HTML).toContain('function runMarketBackfill(');
    expect(DASHBOARD_HTML).toContain("fetch('/api/admin/backfill-market'");
    expect(DASHBOARD_HTML).toContain('Missing Asset Samples');
  });

  it('surfaces the Instrument Pricing capability pane and exact-time lookup in Admin', () => {
    expect(DASHBOARD_HTML).toContain('Instrument Pricing');
    expect(DASHBOARD_HTML).toContain('id="instrumentPricingCaps"');
    expect(DASHBOARD_HTML).toContain('function loadInstrumentPricing(');
    expect(DASHBOARD_HTML).toContain("fetch('/api/admin/instrument-pricing'");
    expect(DASHBOARD_HTML).toContain('function lookupExactPrice(');
    expect(DASHBOARD_HTML).toContain("fetch('/api/admin/instrument-pricing/at?");
    expect(DASHBOARD_HTML).toContain('Kalshi event contracts');
    expect(DASHBOARD_HTML).toContain('loadInstrumentPricing()');
  });

  it('keeps the dollar-estimate + educational framing without the removed Trends banner (owner punch list #3)', () => {
    expect(DASHBOARD_HTML.toLowerCase()).toContain('bracket');
    expect(DASHBOARD_HTML).toContain('from STOCK Act amount ranges');
    // The big "For Educational Use, Not Investment Advice" / "More Info"
    // expander banner is gone from the Trends view entirely.
    expect(DASHBOARD_HTML).not.toContain('id="trDisclaimer"');
    expect(DASHBOARD_HTML).not.toContain('For Educational Use, Not Investment Advice');
    expect(DASHBOARD_HTML).not.toContain('function toggleDisclaimer(');
    // Owner follow-up batch #2: the Primary Only / All Data source-mode note
    // and toggle are gone entirely — dedup is the only sensible view.
    expect(DASHBOARD_HTML).not.toContain('id="feedSourceNote"');
    expect(DASHBOARD_HTML).not.toContain('data-source-mode="primary"');
    expect(DASHBOARD_HTML).not.toContain('data-source-mode="all"');
    expect(DASHBOARD_HTML).not.toContain('<em>Live Only</em>');
    expect(DASHBOARD_HTML).toContain('function tradesSourceMode() {');
    expect(DASHBOARD_HTML).toContain('info-tip');
    // Educational / liability framing survives via the short footer line,
    // reused verbatim in the hamburger menu.
    expect(DASHBOARD_HTML).toContain('var FOOTER_DISCLAIMER_TEXT =');
    expect(DASHBOARD_HTML).toContain('educational tool for public STOCK Act (2012) disclosures');
    expect(DASHBOARD_HTML.toLowerCase()).toContain('not financial advice');
    expect(DASHBOARD_HTML.toLowerCase()).toContain('educational');
  });

  it('LEGALCOMPLIANCE-04: site footer is one combined disclaimer with two-space dots and no trailing period', () => {
    const footerLine =
      'Congress.Trade  ·  educational tool for public STOCK Act (2012) disclosures  ·  not financial advice  ·  $ estimated from brackets  ·  independent/private service not affiliated with or endorsed/sponsored by any government agency';
    expect(DASHBOARD_HTML).toContain(footerLine);
    expect(DASHBOARD_HTML).toContain("var FOOTER_DISCLAIMER_TEXT = '" + footerLine + "';");
    expect(footerLine).not.toMatch(/agency\./);
  });

  it('formats trade amount brackets compactly', () => {
    expect(DASHBOARD_HTML).toContain('function fmtBracketAmount(');
    expect(DASHBOARD_HTML).toContain("fmtBracketAmount(min) + ' - '");
  });

  it('rolls billions up to trillions instead of a 4+ digit "b" number (executed)', () => {
    // Pull the real shipped fmtBracketAmount source out of DASHBOARD_HTML and
    // run it directly, so this exercises the shipped logic rather than a
    // reimplementation. A market cap like $3,622,500,000,000 previously
    // rendered as "$3623b" (or, below the 10B rounding threshold, a stray
    // 4-digit "$3622.5b") because the function had no >= 1e12 branch.
    const marker = 'function fmtBracketAmount(';
    const start = DASHBOARD_HTML.indexOf(marker);
    expect(start).toBeGreaterThanOrEqual(0);
    const braceStart = DASHBOARD_HTML.indexOf('{', start);
    let depth = 0;
    let i = braceStart;
    for (; i < DASHBOARD_HTML.length; i++) {
      if (DASHBOARD_HTML[i] === '{') depth++;
      else if (DASHBOARD_HTML[i] === '}') {
        depth--;
        if (depth === 0) { i++; break; }
      }
    }
    const src = DASHBOARD_HTML.slice(start, i);
    // eslint-disable-next-line no-new-func -- executing the real shipped source
    const fmtBracketAmount = new Function(src + '\nreturn fmtBracketAmount;')() as (n: number) => string;

    expect(fmtBracketAmount(3622500000000)).toBe('$3.62t');
    expect(fmtBracketAmount(1000000000000)).toBe('$1.00t');
    expect(fmtBracketAmount(-2500000000000)).toBe('-$2.50t');
    // Existing billions/millions/thousands precision stays untouched.
    expect(fmtBracketAmount(3500000000)).toBe('$3.5b');
    expect(fmtBracketAmount(23000000000)).toBe('$23b');
  });

  it('formats district ordinals with superscript suffixes (display-only)', () => {
    expect(DASHBOARD_HTML).toContain('function ordinalSuffix(');
    expect(DASHBOARD_HTML).toContain('function fmtDistrictOrdinal(');
    expect(DASHBOARD_HTML).toContain('function fmtDistrictOrdinalHtml(');
    expect(DASHBOARD_HTML).toContain("return 'st'");
    expect(DASHBOARD_HTML).toContain("return 'nd'");
    expect(DASHBOARD_HTML).toContain("return 'rd'");
    expect(DASHBOARD_HTML).toContain("return 'th'");
    expect(DASHBOARD_HTML).toContain("'<sup class=\"ord\">' + ordinalSuffix(n) + '</sup>'");
    expect(DASHBOARD_HTML).toContain('fmtDistrictOrdinalHtml(m.district)');
    expect(DASHBOARD_HTML).toContain("fmtDistrictOrdinalHtml(p.district) + ' District'");
  });

  it('formats counts with thousand separators (display-only)', () => {
    expect(DASHBOARD_HTML).toContain('function fmtCount(');
    expect(DASHBOARD_HTML).toContain(".toLocaleString('en-US')");
    expect(DASHBOARD_HTML).toContain('fmtCount(m.txCount)');
    expect(DASHBOARD_HTML).toContain('fmtCount(a.txCount)');
    expect(DASHBOARD_HTML).toContain('fmtCount(a.memberCount)');
    expect(DASHBOARD_HTML).toContain("fmtCount(rows.length) + ' of ' + fmtCount((all || []).length) + ' politicians");
    expect(DASHBOARD_HTML).toContain("fmtCount(rows.length) + ' of ' + fmtCount((all || []).length) + ' assets");
    expect(DASHBOARD_HTML).toContain("typeof v === 'number' && Number.isFinite(v)) ? fmtCount(v) : v");
  });

  it('renders amount bracket categories above the compact amount text', () => {
    expect(DASHBOARD_HTML).toContain('function amountTier(');
    expect(DASHBOARD_HTML).toContain('function amountBarsHtml(');
    expect(DASHBOARD_HTML).toContain('function amountCellHtml(');
    expect(DASHBOARD_HTML).toContain("label: 'Up to $1k'");
    expect(DASHBOARD_HTML).toContain("label: 'Up to $15k'");
    expect(DASHBOARD_HTML).toContain('[0, 1000]');
    expect(DASHBOARD_HTML).toContain("label: 'Over $1M'");
    expect(DASHBOARD_HTML).toContain('class="amount-bars tier-');
    expect(DASHBOARD_HTML).toContain('class="amount-range fc-amt-val"');
    expect(DASHBOARD_HTML).toContain('cell: amountCellHtml');
    expect(DASHBOARD_HTML).toContain('bracket unavailable');
    expect(DASHBOARD_HTML).toContain('function optionFootnote(');
    expect(DASHBOARD_HTML).toContain("incl. ' + fmtCount(n) + ' option trade");
    expect(DASHBOARD_HTML).toContain('Option premiums are excluded');
    expect(DASHBOARD_HTML).not.toContain("label: 'Tier I'");
    expect(DASHBOARD_HTML).not.toContain('<span>\' + esc(tier.label)');
  });

  it('does not use imported/published time as disclosure lag', () => {
    expect(DASHBOARD_HTML).toContain("function lagBasisDate(r) { return (r && (r.filedDate || r.filed)) || ''; }");
    expect(DASHBOARD_HTML).not.toContain('r.filedDate || r.filed || publishedRaw(r)');
    expect(DASHBOARD_HTML).not.toContain('using congress.trade import date');
  });

  it('explains disclosure timeliness metrics and keeps slowest filers scrollable', () => {
    expect(DASHBOARD_HTML).toContain('class="trend-grid2 timeliness-grid"');
    expect(DASHBOARD_HTML).toContain('id="trLagDist" class="lag-dist"');
    expect(DASHBOARD_HTML).toContain('.timeliness-grid { margin-top: 8px; grid-template-columns: minmax(0, 1fr) minmax(0, .92fr);');
    expect(DASHBOARD_HTML).not.toContain('minmax(280px, .92fr)');
    expect(DASHBOARD_HTML).toContain('Disclosure lag is days between the transaction date and the official filing date.');
    expect(DASHBOARD_HTML).toContain('Avg: mean number of days between transaction date and official filing date.');
    expect(DASHBOARD_HTML).toContain('Max: longest single trade-to-filing delay');
    expect(DASHBOARD_HTML).toContain('Late: count of this filer\\\'s dated trade rows filed more than 45 days');
    expect(DASHBOARD_HTML).toContain('lf.slice(0, 50)');
  });

  it('uses responsive plain-English timeliness KPI labels', () => {
    expect(DASHBOARD_HTML).toContain("kpiLabel('90<sup>th</sup> Percentile', '90th Pctl', 'P90')");
    expect(DASHBOARD_HTML).toContain("kpiLabel('&gt;45 Day Lag', '>45d Lag', '>45d')");
    expect(DASHBOARD_HTML).toContain('#trLagKpis .k-label .k-mid');
    expect(DASHBOARD_HTML).not.toContain("kpi('90th Pct'");
    expect(DASHBOARD_HTML).not.toContain("kpi('Filed >45d'");
  });

  it('provides name/chamber/state/class display formatters', () => {
    for (const fn of ['function fmtName(', 'function chamberLabel(', 'function stateName(', 'function assetClassLabel(', 'function assetTypeLabel(', 'function assetTypeDetailHtml(']) {
      expect(DASHBOARD_HTML).toContain(fn);
    }
    // suffix + state maps present
    expect(DASHBOARD_HTML).toContain("'jr': 'Jr'");
    expect(DASHBOARD_HTML).toContain("CA: 'California'");
    expect(DASHBOARD_HTML).toContain("etf: 'ETF'");
    expect(DASHBOARD_HTML).toContain("['GS', 'Government Securities and Agency Debt', 'Government / Municipal Debt']");
    expect(DASHBOARD_HTML).toContain("['ST', 'Stocks (including ADRs)', 'Public Equity']");
    // Datalist option text must include the human label so typing "Stock" matches ST.
    expect(DASHBOARD_HTML).toContain("code + ' — ' + name");
    expect(DASHBOARD_HTML).toContain("kvRow('Asset Type', assetTypeDetailHtml(row))");
    expect(DASHBOARD_HTML).not.toContain("kvRow('Instrument', row.isOption ? 'Option' : 'Equity / Other')");
  });

  it('renames Members→Politicians and Tickers→Assets and softens Est.→Approx', () => {
    expect(DASHBOARD_HTML).toContain("kpi('Politicians'");
    expect(DASHBOARD_HTML).toContain("kpi('Assets'");
    expect(DASHBOARD_HTML).toContain("kpiInfo('Approx. Volume'");
    expect(DASHBOARD_HTML).toContain("kvRow('Distinct Assets'");
    expect(DASHBOARD_HTML).not.toContain("kpi('Members'");
    expect(DASHBOARD_HTML).not.toContain("kpi('Tickers'");
    expect(DASHBOARD_HTML).not.toContain('Most-traded tickers');
    expect(DASHBOARD_HTML).not.toContain('0B / ');
  });

  it('hides trade-row source provenance from the public feed', () => {
    expect(DASHBOARD_HTML).not.toContain('id="qSource"');
    expect(DASHBOARD_HTML).not.toContain("kvRow('Source', esc(sourceLabel(row.source)))");
    // the document link ("View source filing") is intentionally kept
    expect(DASHBOARD_HTML).toContain('View source filing');
  });

  it('uses a compact 2-row mobile feed card with an open-trade chevron', () => {
    for (const s of ['fc-main', 'fc-row1', 'fc-row2', 'fc-amt-val', 'fc-chevron']) {
      expect(DASHBOARD_HTML).toContain(s);
    }
    expect(DASHBOARD_HTML).not.toContain('trades-card-top');
  });

  it('differentiates the trade drawer from the company drawer', () => {
    expect(DASHBOARD_HTML).toContain('drawer-trade-head');
    expect(DASHBOARD_HTML).toContain('drawer-trade-identity');
    expect(DASHBOARD_HTML).toContain('drawer-trade-party');
    expect(DASHBOARD_HTML).toContain('drawer-kicker');
    expect(DASHBOARD_HTML).toContain('drawer-trade-headline');
    // Ticker/company in the trade drawer open the company drawer (app-wide entity clicks).
    expect(DASHBOARD_HTML).toContain('data-asset="\' + esc(displayTicker) + \'"');
  });

  it('compacts the company profile into a same-line label/value definition grid', () => {
    expect(DASHBOARD_HTML).toContain('def-grid');
    // Label/value pairs render on ONE line (label column ~35%, value 1fr) —
    // not label-above-value stacked, which the owner flagged as unreadable.
    // The label column is capped at 180px and the block at 560px so a wide
    // desktop drawer cannot re-open the void the 35% rule closes on phones.
    expect(DASHBOARD_HTML).toContain('.def-grid { display: grid; grid-template-columns: min(35%, 180px) 1fr;');
    expect(DASHBOARD_HTML).toContain('max-width: 560px; }');
    expect(DASHBOARD_HTML).toContain('.def-item { display: contents; }');
    expect(DASHBOARD_HTML).toContain("item('IPO', ref.ipoDate ? esc(dateText(ref.ipoDate)) : '')");
  });

  // ---- ledger rows: label and value read as ONE unit -----------------------
  // Owner, verbatim: "there are too many places where I see things like the
  // 'First Trade' and 'Last Trade' for Coca Cola having date on far right of
  // screen ... while there is 70+% of the screen width blank between them and
  // its hard to even tell if they are related". .drawer-kv already had the fix
  // (bounded label column, value LEFT-aligned in column 2 on one shared entry
  // guide); these lock it in everywhere else so nobody reintroduces an
  // edge-push. Measured on Trends at 1440x900 before this landed: 19 flow rows
  // with a 67-88% blank run; after: 6-24%, all 19 on one guide.
  describe('ledger rows (label + value on one shared entry guide)', () => {
    it('flow rows (owner 2026-09-08): label owns the row, "total volume" pins to the bar edge, stats line is justified', () => {
      // Supersedes the bounded-label-column contract for .flowrow ONLY: the
      // owner asked for the figure right-aligned to the bar's far edge, in the
      // label's weight (italic), so a long label ("Government / Municipal
      // Debt") never wraps under a 180px cap.  .drawer-kv / .def-grid / the
      // ledger .hbar rows keep the shared-entry-guide rule below.
      expect(DASHBOARD_HTML).toContain('.flowrow .ftop { display: flex; align-items: baseline; justify-content: space-between; column-gap: 14px; margin-bottom: 6px; }');
      expect(DASHBOARD_HTML).toContain('.flowrow .flabel { flex: 1 1 auto; font-size: 15px; font-weight: 600; min-width: 0; overflow-wrap: break-word; color: var(--text); }');
      expect(DASHBOARD_HTML).toContain('.flowrow .fval { flex: 0 0 auto; text-align: right; font-size: 13px; font-weight: 600; font-style: italic; color: var(--text); white-space: nowrap; }');
      expect(DASHBOARD_HTML).toContain('.flowrow .fval .est-money { font-family: var(--mono); font-weight: 600; font-style: italic; color: inherit; }');
      expect(DASHBOARD_HTML).not.toContain('.flowrow .ftop { display: grid; grid-template-columns: min(58%, 180px) 1fr;');
      // A label is shortened, never truncated — .flabel must not ellipsize.
      expect(DASHBOARD_HTML).not.toContain('.flowrow .flabel { flex: 1 1 auto; font-size: 15px; font-weight: 600; min-width: 0; overflow: hidden;');
      // Justified stats line: every stat is a flex item, free width is shared
      // evenly around the bullets, and a "N buys / N sells" pair never breaks.
      expect(DASHBOARD_HTML).toContain('.flowrow .fchip { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; column-gap: 2ch; row-gap: 2px; margin-top: 6px; font-size: 12px; color: var(--text-dim); line-height: 1.4; }');
      expect(DASHBOARD_HTML).toContain('.flowrow .fchip .fstat { white-space: nowrap; }');
      // Owner 2026-09-08: no bullet separators between the stats, so no
      // narrow-card fallback is needed either — the row wraps stat by stat.
      expect(DASHBOARD_HTML).toContain('.flowrow { margin: 12px 0; }');
      expect(DASHBOARD_HTML).not.toContain('class="fsep"');
      expect(DASHBOARD_HTML).not.toContain('@container (max-width');
      expect(DASHBOARD_HTML).not.toContain('container-type: inline-size; }\n  .flowrow:first-child');
      // Dense table stat lines: whole parts, a too-narrow cell wraps only at
      // the bullet instead of clipping the sells count.
      expect(DASHBOARD_HTML).toContain('.stack-under > span { white-space: normal; }');
      expect(DASHBOARD_HTML).toContain('.stack-under .nb { white-space: nowrap; }');
      expect(DASHBOARD_HTML).not.toContain('.stack-under > span { white-space: nowrap; }');
    });

    it('caps the drawer ledger so a wide desktop drawer cannot re-open the void', () => {
      expect(DASHBOARD_HTML).toContain(
        '.drawer-kv { display:grid; grid-template-columns:min(35%, 180px) 1fr;',
      );
      expect(DASHBOARD_HTML).toContain('align-items:center; max-width:560px; }');
    });

    it('converts trackless .hbar rows (Top Buyers / Top Sellers / Most-Traded) to the ledger contract', () => {
      expect(DASHBOARD_HTML).toContain('.hbar.ledger { display:grid; grid-template-columns:min(62%, 220px) 1fr;');
      // No right-aligned values: a ragged left edge makes the eye re-find the
      // start of every number.
      expect(DASHBOARD_HTML).toContain('.hbar.ledger .hval { width:auto; min-width:0; text-align:left; justify-self:start; }');
      // Every trackless render site opts in.
      expect(DASHBOARD_HTML).toContain('<div class="hbar ledger" style="margin:5px 0">');
      expect(DASHBOARD_HTML).toContain('<div class="hbar ledger hz" style="margin:6px 0">');
      // Rows that DO have a bar between label and value keep the chart layout.
      expect(DASHBOARD_HTML).toContain('.lag-dist .hbar .hlabel');
    });

    it('shares one label column across the chart tooltip rows', () => {
      expect(DASHBOARD_HTML).toContain('.chart-tooltip-row { display: contents; }');
      expect(DASHBOARD_HTML).toContain('.chart-tooltip-title { grid-column: 1 / -1;');
    });

    it('treats the admin connection card meta as a ledger, not two equal columns', () => {
      expect(DASHBOARD_HTML).toContain('.diag-meta { display:grid; grid-template-columns:auto 1fr;');
    });

    it('shortens the one drawer label that ellipsized at 375px instead of truncating it', () => {
      // "Avg. Disclosure Lag" needed 126px in a 107px label column on a 375px
      // phone. "Avg. Lag" fits, and matches the existing "Median Lag" KPI.
      expect(DASHBOARD_HTML).not.toContain('Avg. Disclosure Lag');
      expect(DASHBOARD_HTML).toContain("kvRow('Avg. Lag'");
    });

    it('does not introduce leader dots', () => {
      // Leaders are a table-of-contents device for values pinned to a page
      // edge; nothing here has that constraint, and the audit rejected them.
      expect(DASHBOARD_HTML).not.toContain('leader-dots');
      expect(DASHBOARD_HTML).not.toContain("content: '.'");
    });
  });

  it('drops the collapsible Trends disclaimer banner (owner punch list #3) but keeps tap-to-reveal tooltips', () => {
    expect(DASHBOARD_HTML).not.toContain('function toggleDisclaimer(');
    expect(DASHBOARD_HTML).not.toContain('id="trDisclaimer"');
    expect(DASHBOARD_HTML).not.toContain('_disclaimerAutoTimer');
    expect(DASHBOARD_HTML).not.toContain('For Educational Use, Not Investment Advice');
    expect(DASHBOARD_HTML).not.toContain('class="dt-more"');
    // The unrelated tap-to-reveal tooltip system (title / .info-tip / .est-money)
    // is a separate feature and stays fully intact.
    expect(DASHBOARD_HTML).toContain('tip-pop');
    expect(DASHBOARD_HTML).toContain('(hover: none)');
  });

  it('gives AAPL a themeable glyph logo and reconstructs House filing links', () => {
    expect(DASHBOARD_HTML).toContain('CUSTOM_GLYPH');
    expect(DASHBOARD_HTML).toContain('function reconstructFilingUrl(');
    // Filing PDFs are served by GET /api/documents/:docId/pdf (delivery/rest.ts);
    // /api/client/v1/documents/... does not exist and 404s.
    expect(DASHBOARD_HTML).toContain("'/api/documents/' + encodeURIComponent(s) + '/pdf'");
    expect(DASHBOARD_HTML).not.toContain('/api/client/v1/documents/');
  });

  it('labels every analytics section with its timeframe', () => {
    expect(DASHBOARD_HTML).toContain('function windowLabel(');
    expect(DASHBOARD_HTML).toContain('function stampWindowChips(');
    expect(DASHBOARD_HTML).toContain('stampWindowChips();'); // called in loadTrends
    expect(DASHBOARD_HTML).toContain('class="tf-h"');
// expect(DASHBOARD_HTML).toContain('id="trKpisCap"');
  });

  it('gives Net Flow a tooltip and de-underlines the info marker', () => {
    expect(DASHBOARD_HTML).toContain("kpiInfo('Net Flow'");
    expect(DASHBOARD_HTML).toContain('NET_FLOW_TIP');
    // info-tip marker: no dotted underline, raised toward the top
    expect(DASHBOARD_HTML).not.toContain('.info-tip { color: var(--text-dim); cursor: help; border-bottom: 1px dotted var(--text-dim); }');
    expect(DASHBOARD_HTML).toContain('.est-money::first-letter');
  });

  it('uses skeleton-shimmer loaders in the Trends view', () => {
    for (const fn of ['function skCards(', 'function skRows(', 'function skBars(', 'function skChart(']) {
      expect(DASHBOARD_HTML).toContain(fn);
    }
    expect(DASHBOARD_HTML).toContain('@keyframes tr-shimmer');
    expect(DASHBOARD_HTML).toContain('prefers-reduced-motion');
  });

  it('anchors the Buys vs Sells chart to the shared page window', () => {
    expect(DASHBOARD_HTML).toContain('function anchorChartRight(');
    expect(DASHBOARD_HTML).toContain('tc.scrollLeft = tc.scrollWidth');
    expect(DASHBOARD_HTML).toContain("aGet('volume-over-time?' + trParams())");
    expect(DASHBOARD_HTML).not.toContain('function setTrTimeWin(');
    expect(DASHBOARD_HTML).not.toContain('function trTimeParams(');
    expect(DASHBOARD_HTML).not.toContain('id="trTimeWin"');
    expect(DASHBOARD_HTML).not.toContain('Buys vs Sells Over Time');
  });

  it('toggles Buys vs Sells between trade counts and dollar volume', () => {
    expect(DASHBOARD_HTML).toContain('id="trTimeMetric"');
    expect(DASHBOARD_HTML).toContain('function setTrTimeMetric(');
    expect(DASHBOARD_HTML).toContain("onclick=\"setTrTimeMetric('count')\"");
    expect(DASHBOARD_HTML).toContain("onclick=\"setTrTimeMetric('dollars')\"");
    expect(DASHBOARD_HTML).toContain("timeChartHtml(s, null, trTimeMetric)");
    expect(DASHBOARD_HTML).toContain("metric === 'count'");
    expect(DASHBOARD_HTML).toContain("metric === 'dollars'");
  });

  it('places Top Performers beside What Is Being Traded and Rising Activity beside Most Active', () => {
    const tickers = DASHBOARD_HTML.indexOf('id="tableTrTickers"');
    const performers = DASHBOARD_HTML.indexOf('>Top Performers <');
    const buys = DASHBOARD_HTML.indexOf('>Buys vs Sells<');
    const consensus = DASHBOARD_HTML.indexOf('>Consensus Moves<');
    const rising = DASHBOARD_HTML.indexOf('>Rising Activity<');
    const members = DASHBOARD_HTML.indexOf('>Most Active Politicians<');
    expect(tickers).toBeGreaterThan(-1);
    expect(performers).toBeGreaterThan(tickers);
    expect(buys).toBeGreaterThan(performers);
    expect(consensus).toBeGreaterThan(buys);
    expect(rising).toBeGreaterThan(consensus);
    expect(members).toBeGreaterThan(rising);
  });

  it('hides Rising Activity on All Time and keeps net-flow / buy-pressure on one line', () => {
    expect(DASHBOARD_HTML).toContain('id="trRisingFold"');
    expect(DASHBOARD_HTML).toContain('id="trPerformersFold"');
    expect(DASHBOARD_HTML).toContain('#view-trends .trend-grid2:has(#trRisingFold[hidden]) { grid-template-columns: 1fr; }');
    expect(DASHBOARD_HTML).toContain("getTrWindow() === 'all'");
    expect(DASHBOARD_HTML).toContain('syncRisingActivityVisibility');
    expect(DASHBOARD_HTML).toContain('kpi-money');
    expect(DASHBOARD_HTML).toContain('class="bp"');
    expect(DASHBOARD_HTML).toContain('.card .v .bp-n { font-size: 28px;');
    expect(DASHBOARD_HTML).toContain('.card .v .bp-pct { font-size: 28px;');
    expect(DASHBOARD_HTML).toContain('.card .v .bp-w { font-size: 14px;');
    expect(DASHBOARD_HTML).toContain('--trends-gap: 24px');
    expect(DASHBOARD_HTML).toContain("n < 0 ? '\u2212' : ''");
    expect(DASHBOARD_HTML).toContain('.card .v .net, .card .v .kpi-money { white-space: nowrap; max-width: 100%; overflow: hidden; font-size: 28px;');
  });

  it('toggles What Is Being Traded between # trades and $ volume, with no rank numbers', () => {
    expect(DASHBOARD_HTML).toContain('id="trTickerMetric"');
    expect(DASHBOARD_HTML).toContain("onclick=\"setTickerSort('trades')\"");
    expect(DASHBOARD_HTML).toContain("onclick=\"setTickerSort('volume')\"");
    expect(DASHBOARD_HTML).not.toContain('id="trTickerSort"');
    expect(DASHBOARD_HTML).not.toContain("'<td class=\"rank\">' + (i + 1) + '</td>'");
  });

  it('sizes What Is Being Traded and Buys vs Sells #/$ toggles the same, in black', () => {
    expect(DASHBOARD_HTML).toContain('#trTickerMetric.seg button,\n#trTimeMetric.seg button {');
    expect(DASHBOARD_HTML).toContain('color: var(--text);\n  font: 700 14px var(--sans);\n  padding: 5px 10px;');
    expect(DASHBOARD_HTML).toContain('#trTickerMetric.seg button.on,\n#trTimeMetric.seg button.on {');
    expect(DASHBOARD_HTML).not.toContain('#view-trends #trTimeMetric.seg button { padding: 4px 5px; font-size: 10px; }');
  });

  it('centers Trends KPI figures under pinned headings with extras inside .v', () => {
    expect(DASHBOARD_HTML).toContain('#trKpis .card .v {\n    flex-direction: column;\n    align-items: center;\n    justify-content: center;');
    expect(DASHBOARD_HTML).toContain("return '<div' + attr + '><div class=\"k\">' + infoLabel(k, tip) + '</div><div class=\"v\">' + v + (extraHtml || '') + '</div></div>';");
    expect(DASHBOARD_HTML).toContain("return '<div class=\"kpi-spark\">'");
    expect(DASHBOARD_HTML).not.toContain("style=\"position:absolute; bottom:6px;");
  });

  it('does not put an explainer under Consensus Moves or Rising Activity', () => {
    expect(DASHBOARD_HTML).not.toContain('trConsensusPhrase');
    expect(DASHBOARD_HTML).not.toContain('Assets where several different politicians happened to trade the same direction');
    expect(DASHBOARD_HTML).not.toContain('Assets whose trade count rose most');
  });

  it('fits the buys/sells time chart to the card width without horizontal scroll', () => {
    expect(DASHBOARD_HTML).toContain('.tchart { display:flex; align-items:flex-end; gap:2px; height:180px; overflow-x:hidden;');
    expect(DASHBOARD_HTML).toContain('.tcol { display:flex; flex-direction:column; align-items:center; gap:4px; flex:1 1 0; min-width:0;');
    expect(DASHBOARD_HTML).toContain('width:max(2px, calc(50% - 1px))');
  });

  it('keeps Trends section headings flush with card padding (no orphaned accent indent)', () => {
    expect(DASHBOARD_HTML).not.toMatch(/\.section > h3[^}]*padding-left:\s*11px/);
    expect(DASHBOARD_HTML).toContain('#view-trends .section > h3');
    expect(DASHBOARD_HTML).toContain('padding-left: 0');
    // Nested timeliness captions only — not Net Flow / Market Cap section titles.
    expect(DASHBOARD_HTML).toContain('#view-trends .timeliness-panel > h3');
    expect(DASHBOARD_HTML).not.toContain('#view-trends .trend-grid2 > div > h3');
  });

  it('stacks buys/win and trades/buy-sell under politician names for mobile room', () => {
    expect(DASHBOARD_HTML).toContain('class="stack-under"');
    expect(DASHBOARD_HTML).toContain('class="member-meta"');
    expect(DASHBOARD_HTML).toContain('class="name-line"');
    expect(DASHBOARD_HTML).toContain('.stack-under {');
    expect(DASHBOARD_HTML).toContain('#view-trends .member-cell > .member-meta');
    // Top Performers / Most Active Politicians: single merged stat line
    // (no separate rank column, no split-bar visualization).
    expect(DASHBOARD_HTML).toContain("'<span class=\"nb\">' + fmtCount(r.tradeCount) + ' buys</span>' + SEP_DOT +\n        '<span class=\"nb\">' + Math.round(100 * (r.winRate || 0)) + '% win</span>'");
    expect(DASHBOARD_HTML).toContain("'<span class=\"nb\">' + fmtCount(r.tradeCount) + ' trades</span>' + SEP_DOT +\n        '<span class=\"nb\">' + fmtCount(r.buyCount || 0) + ' buys\\u00a0\\u00a0/\\u00a0\\u00a0' + fmtCount(r.sellCount || 0) + ' sells</span>'");
  });

  it('surfaces source error and stale status instead of showing only successful polls', () => {
    expect(DASHBOARD_HTML).toContain('<th>Status</th>');
    expect(DASHBOARD_HTML).toContain('s.lastError');
    expect(DASHBOARD_HTML).toContain('s.stale');
    expect(DASHBOARD_HTML).toContain("stateRow(9, 'No source check activity logged yet.')");
  });

  it('wires the consensus grid + "Use Consensus" prefill alongside the per-model bake-off panel', () => {
    expect(DASHBOARD_HTML).toContain('var REVIEW_CONSENSUS');
    expect(DASHBOARD_HTML).toContain('function consensusGridHtml(');
    expect(DASHBOARD_HTML).toContain('function useConsensusRows(');
    expect(DASHBOARD_HTML).toContain('function consensusFieldValueForEdit(');
    expect(DASHBOARD_HTML).toContain('function consensusApplyField(');
    expect(DASHBOARD_HTML).toContain('REVIEW_CONSENSUS[docId] = data.consensus || null;');
    expect(DASHBOARD_HTML).toContain('REVIEW_CONSENSUS_STATUS[docId] = data.consensusStatus || null;');
    expect(DASHBOARD_HTML).toContain("}).join('') + consensusGridHtml(docId, data.consensus, data.consensusStatus);");
    // reuses the existing .conf hi/mid/lo confidence-color classes — no new stylesheet
    expect(DASHBOARD_HTML).toContain('function consensusFieldClass(fc) {');
    expect(DASHBOARD_HTML).toContain("if (fc.unanimous) return 'hi';");
    expect(DASHBOARD_HTML).toContain('<div class="conf hi">');
    expect(DASHBOARD_HTML).toContain('<div class="conf mid"');
    expect(DASHBOARD_HTML).toContain('<div class="conf lo"');
    expect(DASHBOARD_HTML).toContain('Queue-first safety');
    expect(DASHBOARD_HTML).toContain('Missing row from:');
    expect(DASHBOARD_HTML).toContain('Contested ');
    expect(DASHBOARD_HTML).not.toContain('.consensus-cell');
    expect(DASHBOARD_HTML).not.toContain('.consensus-grid {');
    // "Use This Model" and the queued-payload prefill stay wired unchanged (consensus is opt-in)
    expect(DASHBOARD_HTML).toContain('function useModelRows(docId, idx) {');
    expect(DASHBOARD_HTML).toContain("openReviewEditor(docId, rows, 'confirm', 'queued extracted rows', item && item.chamber);");
  });

  it('footer Support mailto is support@congress.trade', () => {
    expect(DASHBOARD_HTML).toContain('mailto:support@congress.trade');
    expect(DASHBOARD_HTML).not.toContain('mailto:congress.trade@jays.services');
  });

  it('footer includes subtle Report a Problem trigger', () => {
    expect(DASHBOARD_HTML).toContain('Report a Problem</a>');
    expect(DASHBOARD_HTML).toContain('window.openSentryFeedback');
  });
});

/**
 * The consensus grid + "Use Consensus" prefill do real per-field branching
 * (majority vs. contested) that a plain `toContain` check on the template
 * literal can't exercise. These tests pull the actual function/var source
 * back out of DASHBOARD_HTML and compile it with `new Function`, so they run
 * the shipped logic itself rather than a re-implementation. DOM-touching
 * collaborators (openReviewEditor, reviewItemForDoc, reviewPayloadTransactions,
 * alert) are swapped for recording stubs since this suite runs outside a DOM.
 */
describe('consensus grid + Use Consensus prefill (executed)', () => {
  function extractFn(html: string, name: string): string {
    const marker = 'function ' + name + '(';
    const start = html.indexOf(marker);
    if (start < 0) throw new Error('function not found in DASHBOARD_HTML: ' + name);
    const braceStart = html.indexOf('{', start);
    let depth = 0;
    let i = braceStart;
    for (; i < html.length; i++) {
      if (html[i] === '{') depth++;
      else if (html[i] === '}') {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      }
    }
    return html.slice(start, i);
  }

  function extractVarDecl(html: string, name: string): string {
    const re = new RegExp('var ' + name + ' = [\\s\\S]*?;');
    const m = re.exec(html);
    if (!m) throw new Error('var not found in DASHBOARD_HTML: ' + name);
    return m[0];
  }

  interface ConsensusSandbox {
    consensusGridHtml: (docId: string, consensus: unknown, status?: unknown) => string;
    useConsensusRows: (docId: string) => void;
    setReviewItem: (item: unknown) => void;
    setQueued: (rows: unknown[]) => void;
    setConsensus: (docId: string, consensus: unknown) => void;
    getEditorCall: () => null | { docId: string; rows: any[]; decision: string; label: string; chamber: string };
    getAlerts: () => string[];
  }

  function loadConsensusSandbox(): ConsensusSandbox {
    const html = DASHBOARD_HTML;
    const src = [
      'var CAPTURED_EDITOR_CALL = null;',
      'var ALERTS = [];',
      'var REVIEW_ITEM_FOR_TEST = null;',
      'var QUEUED_FOR_TEST = [];',
      'function showToast(msg) { ALERTS.push(msg); }',
      'function openReviewEditor(docId, rows, decision, label, chamber) { CAPTURED_EDITOR_CALL = { docId: docId, rows: rows, decision: decision, label: label, chamber: chamber }; }',
      'function reviewItemForDoc(docId) { return REVIEW_ITEM_FOR_TEST; }',
      'function reviewPayloadTransactions(payload) { return QUEUED_FOR_TEST; }',
      'var REVIEW_CONSENSUS = {};',
      extractVarDecl(html, 'CONSENSUS_FIELD_ORDER'),
      extractVarDecl(html, 'CONSENSUS_FIELD_LABEL'),
      extractFn(html, 'esc'),
      extractFn(html, 'reviewMoney'),
      extractFn(html, 'reviewBracketLabel'),
      extractFn(html, 'consensusHasMajority'),
      extractFn(html, 'consensusHasPlurality'),
      extractFn(html, 'consensusFieldClass'),
      extractFn(html, 'consensusFieldDisplay'),
      extractFn(html, 'consensusModelFieldValue'),
      extractFn(html, 'consensusFieldCellHtml'),
      extractFn(html, 'consensusModelCellHtml'),
      extractFn(html, 'consensusStatusHtml'),
      extractFn(html, 'consensusGridHtml'),
      extractFn(html, 'consensusQueuedRowKey'),
      extractFn(html, 'consensusFieldValueForEdit'),
      extractFn(html, 'consensusApplyField'),
      extractFn(html, 'useConsensusRows'),
      'return { consensusGridHtml: consensusGridHtml, useConsensusRows: useConsensusRows, ' +
        'setReviewItem: function (item) { REVIEW_ITEM_FOR_TEST = item; }, ' +
        'setQueued: function (rows) { QUEUED_FOR_TEST = rows; }, ' +
        'setConsensus: function (docId, c) { REVIEW_CONSENSUS[docId] = c; }, ' +
        'getEditorCall: function () { return CAPTURED_EDITOR_CALL; }, ' +
        'getAlerts: function () { return ALERTS; } };',
    ].join('\n');
    // eslint-disable-next-line no-new-func -- executing the real shipped source, see comment above
    const factory = new Function(src);
    return factory() as ConsensusSandbox;
  }

  const MODELS = ['anthropic:claude-sonnet-5', 'gemini:gemini-3.5-flash', 'openai:gpt-4o'];

  function fieldConsensus(
    value: unknown,
    votes: number,
    total: number,
    dissenters: Array<{ model: string; value: unknown }>,
    unanimous: boolean,
  ) {
    return { value, votes, total, dissenters, unanimous };
  }

  // Every model agrees on every field.
  const unanimousRow = {
    rowKey: 'AAPL|2024-01-05|B',
    presentIn: MODELS,
    missingFrom: [],
    rowConsensus: 'unanimous',
    fields: {
      ticker: fieldConsensus('AAPL', 3, 3, [], true),
      txType: fieldConsensus('P', 3, 3, [], true),
      transactionDate: fieldConsensus('2024-01-05', 3, 3, [], true),
      owner: fieldConsensus('self', 3, 3, [], true),
      assetName: fieldConsensus('Apple Inc', 3, 3, [], true),
      amount: fieldConsensus({ amountMin: 1001, amountMax: 15000 }, 3, 3, [], true),
    },
  };

  // Every field has a strict majority, but "owner" has one dissenter (2-1).
  const majorityRow = {
    rowKey: 'MSFT|2024-02-01|S',
    presentIn: MODELS,
    missingFrom: [],
    rowConsensus: 'majority',
    fields: {
      ticker: fieldConsensus('MSFT', 3, 3, [], true),
      txType: fieldConsensus('S', 3, 3, [], true),
      transactionDate: fieldConsensus('2024-02-01', 3, 3, [], true),
      owner: fieldConsensus('joint', 2, 3, [{ model: 'openai:gpt-4o', value: 'spouse' }], false),
      assetName: fieldConsensus('Microsoft Corp', 3, 3, [], true),
      amount: fieldConsensus({ amountMin: 15001, amountMax: 50000 }, 3, 3, [], true),
    },
  };

  // "amount" is a 1-1 tie between the two present models -> no majority ->
  // contested (winner value null, every present value listed as a dissenter).
  const contestedRow = {
    rowKey: 'TSLA|2024-03-10|B',
    presentIn: ['anthropic:claude-sonnet-5', 'gemini:gemini-3.5-flash'],
    missingFrom: ['openai:gpt-4o'],
    rowConsensus: 'contested',
    fields: {
      ticker: fieldConsensus('TSLA', 2, 2, [], true),
      txType: fieldConsensus('P', 2, 2, [], true),
      transactionDate: fieldConsensus('2024-03-10', 2, 2, [], true),
      owner: fieldConsensus('self', 2, 2, [], true),
      assetName: fieldConsensus('Tesla Inc', 2, 2, [], true),
      amount: fieldConsensus(
        null,
        1,
        2,
        [
          { model: 'anthropic:claude-sonnet-5', value: { amountMin: 1001, amountMax: 15000 } },
          { model: 'gemini:gemini-3.5-flash', value: { amountMin: 15001, amountMax: 50000 } },
        ],
        false,
      ),
    },
  };

  it('colors a unanimous field green with no dissent', () => {
    const sandbox = loadConsensusSandbox();
    const consensus = {
      rows: [unanimousRow],
      summary: { models: MODELS, rowsUnanimous: 1, rowsMajority: 0, rowsContested: 0, perFieldAgreementPct: {} },
    };
    const html = sandbox.consensusGridHtml('doc-1', consensus);
    expect(html).toContain('<div class="conf hi"><strong>Symbol:</strong> AAPL');
    expect(html).toContain('<th>anthropic:claude-sonnet-5</th>');
    expect(html).toContain('<th>Consensus</th>');
    expect(html).toContain("useConsensusRows('doc-1')");
    expect(html).toContain('>Use Consensus<');
  });

  it('colors a majority-with-dissent field amber and shows the dissenting value', () => {
    const sandbox = loadConsensusSandbox();
    const consensus = {
      rows: [majorityRow],
      summary: { models: MODELS, rowsUnanimous: 0, rowsMajority: 1, rowsContested: 0, perFieldAgreementPct: {} },
    };
    const html = sandbox.consensusGridHtml('doc-1', consensus);
    expect(html).toContain('<div class="conf mid" title="openai:gpt-4o: spouse"><strong>Owner:</strong> joint');
    expect(html).toContain('Dissent: openai:gpt-4o: spouse');
  });

  it('colors a contested field red and shows every present model\'s value', () => {
    const sandbox = loadConsensusSandbox();
    const consensus = {
      rows: [contestedRow],
      summary: { models: MODELS, rowsUnanimous: 0, rowsMajority: 0, rowsContested: 1, perFieldAgreementPct: {} },
    };
    const html = sandbox.consensusGridHtml('doc-1', consensus);
    expect(html).toContain('conf lo');
    expect(html).toContain('anthropic:claude-sonnet-5: $1,001 - $15,000');
    expect(html).toContain('gemini:gemini-3.5-flash: $15,001 - $50,000');
    // the model missing from this row gets a muted placeholder, not a blank cell
    expect(html).toContain('Missing row');
    expect(html).toContain('Missing row from:');
  });

  // Seen by only ONE of the three models. Its row-level consensus is 'contested'
  // (minority presence), yet every field's local electorate is that single
  // model, so votes*2 > total is trivially true for each field.
  const minorityRow = {
    rowKey: 'NVDA|2024-04-01|B',
    presentIn: ['openai:gpt-4o'],
    missingFrom: ['anthropic:claude-sonnet-5', 'gemini:gemini-3.5-flash'],
    rowConsensus: 'contested',
    fields: {
      ticker: fieldConsensus('NVDA', 1, 1, [], true),
      txType: fieldConsensus('P', 1, 1, [], true),
      transactionDate: fieldConsensus('2024-04-01', 1, 1, [], true),
      owner: fieldConsensus('self', 1, 1, [], true),
      assetName: fieldConsensus('Nvidia Corp', 1, 1, [], true),
      amount: fieldConsensus({ amountMin: 1001, amountMax: 15000 }, 1, 1, [], true),
    },
  };

  it('renders nothing when there is no consensus block for the document', () => {
    const sandbox = loadConsensusSandbox();
    expect(sandbox.consensusGridHtml('doc-1', null)).toBe('');
    expect(
      sandbox.consensusGridHtml('doc-1', { rows: [], summary: { models: [], rowsUnanimous: 0, rowsMajority: 0, rowsContested: 0, perFieldAgreementPct: {} } }),
    ).toBe('');
  });

  it('"Use Consensus" updates complete majority rows but preserves contested rows wholesale', () => {
    const sandbox = loadConsensusSandbox();
    sandbox.setConsensus('doc-2', {
      rows: [majorityRow, contestedRow],
      summary: { models: MODELS, rowsUnanimous: 0, rowsMajority: 1, rowsContested: 1, perFieldAgreementPct: {} },
    });
    sandbox.setReviewItem({ docId: 'doc-2', chamber: 'house', payload: null });
    sandbox.setQueued([
      { ticker: 'MSFT', txType: 'S', txDate: '2024-02-01', owner: 'spouse', assetName: 'Microsoft (queued)', amountMin: 1, amountMax: 2 },
      { ticker: 'TSLA', txType: 'B', txDate: '2024-03-10', owner: 'spouse', assetName: 'Tesla Inc (queued)', amountMin: 999, amountMax: 1000 },
    ]);

    sandbox.useConsensusRows('doc-2');

    const call = sandbox.getEditorCall();
    expect(call).toBeTruthy();
    expect(call!.docId).toBe('doc-2');
    expect(call!.decision).toBe('confirm');
    expect(call!.label).toBe('model consensus');
    expect(call!.chamber).toBe('house');
    expect(call!.rows).toHaveLength(2);

    const [majority, contested] = call!.rows;
    // majority row: the vote winner is used for every field, including "owner"
    // (2-1 majority) — the dissenting model's "spouse" value must not leak in.
    expect(majority.ticker).toBe('MSFT');
    expect(majority.owner).toBe('joint');

    // Any contested field makes the row human-only: no fieldwise partial merge.
    expect(contested.ticker).toBe('TSLA');
    expect(contested.owner).toBe('spouse');
    expect(contested.assetName).toBe('Tesla Inc (queued)');
    expect(contested.amountMin).toBe(999);
    expect(contested.amountMax).toBe(1000);
  });

  it('"Use Consensus" falls a minority-presence row entirely back to the queued payload', () => {
    const sandbox = loadConsensusSandbox();
    sandbox.setConsensus('doc-4', {
      rows: [minorityRow],
      summary: { models: MODELS, rowsUnanimous: 0, rowsMajority: 0, rowsContested: 1, perFieldAgreementPct: {} },
    });
    sandbox.setReviewItem({ docId: 'doc-4', chamber: 'house', payload: null });
    // Queued payload for the same row key, with values that differ from the lone
    // model's reading so a leak would be visible.
    sandbox.setQueued([
      { ticker: 'NVDA', txType: 'B', txDate: '2024-04-01', owner: 'spouse', assetName: 'Nvidia (queued)', amountMin: 1, amountMax: 2 },
    ]);

    sandbox.useConsensusRows('doc-4');

    const call = sandbox.getEditorCall();
    expect(call).toBeTruthy();
    expect(call!.rows).toHaveLength(1);
    const [only] = call!.rows;
    // The row was seen by only 1 of 3 models → not authoritative → every field
    // uses the queued value, NOT the single model's unverified reading.
    expect(only.owner).toBe('spouse');
    expect(only.assetName).toBe('Nvidia (queued)');
    expect(only.amountMin).toBe(1);
    expect(only.amountMax).toBe(2);
  });

  it('preserves queued-only rows and every queued metadata/detail field', () => {
    const sandbox = loadConsensusSandbox();
    sandbox.setConsensus('doc-5', {
      // MSFT is consensus-only and must not be injected; AAPL matches queue.
      rows: [unanimousRow, majorityRow],
      summary: { models: MODELS, rowsUnanimous: 1, rowsMajority: 1, rowsContested: 0, perFieldAgreementPct: {} },
    });
    sandbox.setReviewItem({ docId: 'doc-5', chamber: 'house', payload: null });
    sandbox.setQueued([
      {
        ticker: 'AAPL', txType: 'B', txDate: '2024-01-05', owner: 'self',
        assetName: 'Apple queued', amountMin: 1001, amountMax: 15000,
        assetType: 'OP', assetTypeName: 'Stock Option', isOption: true,
        capGainsOver200: true, rawText: 'verbatim queued row', confidence: 0.42,
        filingStatus: 'N', subholding: 'Brokerage A', location: 'Delaware',
        description: 'Call option', supplementalText: 'Expires 2027-01-15',
      },
      {
        ticker: 'GOOG', txType: 'S', txDate: '2024-05-01', owner: 'spouse',
        assetName: 'Alphabet queued-only', amountMin: 50001, amountMax: 100000,
        assetType: 'ST', assetTypeName: 'Stock', isOption: false,
        capGainsOver200: false, rawText: 'queued-only raw', confidence: 0.81,
        filingStatus: 'A', subholding: 'Trust', location: 'California',
        description: 'Queued-only description', supplementalText: 'Queued-only note',
      },
    ]);

    sandbox.useConsensusRows('doc-5');

    const rows = sandbox.getEditorCall()!.rows;
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.ticker)).toEqual(['AAPL', 'GOOG']);
    expect(rows[0]).toMatchObject({
      assetType: 'OP', assetTypeName: 'Stock Option', isOption: true,
      capGainsOver200: true, rawText: 'verbatim queued row', confidence: 0.42,
      filingStatus: 'N', subholding: 'Brokerage A', location: 'Delaware',
      description: 'Call option', supplementalText: 'Expires 2027-01-15',
    });
    expect(rows[1]).toMatchObject({
      ticker: 'GOOG', assetName: 'Alphabet queued-only', rawText: 'queued-only raw',
      filingStatus: 'A', subholding: 'Trust', location: 'California',
      description: 'Queued-only description', supplementalText: 'Queued-only note',
    });
  });

  it('corrects a single unresolved-ticker row when key matching drifts unambiguously', () => {
    const sandbox = loadConsensusSandbox();
    sandbox.setConsensus('doc-key-drift', {
      rows: [unanimousRow],
      summary: { models: MODELS, rowsUnanimous: 1, rowsMajority: 0, rowsContested: 0, perFieldAgreementPct: {} },
    });
    sandbox.setReviewItem({ docId: 'doc-key-drift', chamber: 'house', payload: null });
    sandbox.setQueued([{
      ticker: null, assetName: 'Apple Inc.', txType: 'B', txDate: '2024-01-05',
      owner: 'self', amountMin: 1, amountMax: 2, rawText: 'queued unresolved ticker',
    }]);

    sandbox.useConsensusRows('doc-key-drift');

    const [row] = sandbox.getEditorCall()!.rows;
    expect(row.ticker).toBe('AAPL');
    expect(row.rawText).toBe('queued unresolved ticker');
  });

  it('leaves duplicate queued lots untouched because occurrence order is ambiguous', () => {
    const sandbox = loadConsensusSandbox();
    const lot1 = {
      ...unanimousRow,
      rowKey: 'AAPL|2024-01-05|B#1', baseRowKey: 'AAPL|2024-01-05|B', occurrence: 1,
      fields: { ...unanimousRow.fields, amount: fieldConsensus({ amountMin: 1001, amountMax: 15000 }, 3, 3, [], true) },
    };
    const lot2 = {
      ...unanimousRow,
      rowKey: 'AAPL|2024-01-05|B#2', baseRowKey: 'AAPL|2024-01-05|B', occurrence: 2,
      fields: { ...unanimousRow.fields, amount: fieldConsensus({ amountMin: 15001, amountMax: 50000 }, 3, 3, [], true) },
    };
    sandbox.setConsensus('doc-6', {
      rows: [lot1, lot2],
      summary: { models: MODELS, rowsUnanimous: 2, rowsMajority: 0, rowsContested: 0, perFieldAgreementPct: {} },
    });
    sandbox.setReviewItem({ docId: 'doc-6', chamber: 'house', payload: null });
    sandbox.setQueued([
      { ticker: 'AAPL', txType: 'B', txDate: '2024-01-05', assetName: 'Lot 1', amountMin: 1, amountMax: 2, rawText: 'lot one' },
      { ticker: 'AAPL', txType: 'B', txDate: '2024-01-05', assetName: 'Lot 2', amountMin: 3, amountMax: 4, rawText: 'lot two' },
    ]);

    sandbox.useConsensusRows('doc-6');

    const rows = sandbox.getEditorCall()!.rows;
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => [row.amountMin, row.amountMax])).toEqual([
      [1, 2],
      [3, 4],
    ]);
    expect(rows.map((row) => row.rawText)).toEqual(['lot one', 'lot two']);
  });

  it('shows a newer failed run set instead of hiding why consensus is unavailable', () => {
    const sandbox = loadConsensusSandbox();
    const html = sandbox.consensusGridHtml('doc-7', null, {
      batchId: 'new-revision', kind: 'bakeoff', createdAt: '2026-06-26T02:00:00.000Z',
      failedModels: [{ model: 'anthropic:claude-sonnet-5', error: 'timeout' }],
      blockedReason: 'Latest comparable run set has fewer than two successful model readings; older successes were not mixed in.',
    });
    expect(html).toContain('Run set: bakeoff · new-revision');
    expect(html).toContain('Failed models:');
    expect(html).toContain('anthropic:claude-sonnet-5 (timeout)');
    expect(html).toContain('older successes were not mixed in');
  });

  it('alerts instead of opening the editor when the document has no consensus rows', () => {
    const sandbox = loadConsensusSandbox();
    sandbox.setReviewItem({ docId: 'doc-3', chamber: 'senate', payload: null });
    sandbox.useConsensusRows('doc-3'); // no setConsensus() call for doc-3
    expect(sandbox.getEditorCall()).toBeNull();
    expect(sandbox.getAlerts()).toHaveLength(1);
  });
});

describe('dashboard truth + a11y fixes (app review backlog)', () => {
  // Small standalone-function extractor shared by the pure-function tests
  // below (pluralCount / canonSector have no DOM or outer-scope deps).
  function extractFn(html: string, name: string): string {
    const marker = 'function ' + name + '(';
    const start = html.indexOf(marker);
    if (start < 0) throw new Error('function not found in DASHBOARD_HTML: ' + name);
    const braceStart = html.indexOf('{', start);
    let depth = 0;
    let i = braceStart;
    for (; i < html.length; i++) {
      if (html[i] === '{') depth++;
      else if (html[i] === '}') {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      }
    }
    return html.slice(start, i);
  }

  // ---- 1. Consensus Moves "— · ~$40K" dangling fragment -------------------
  it('drops the leading date-range fragment on cluster cards when minDate is missing, instead of a dangling dash', () => {
    expect(DASHBOARD_HTML).toContain(
      "var range = c.minDate ? (compactDateText(c.minDate) + (c.minDate === c.maxDate ? '' : ' → ' + compactDateText(c.maxDate))) : '';",
    );
    expect(DASHBOARD_HTML).toContain(
      "'<div class=\"muted\" style=\"margin-top:2px\">' + (range ? esc(range) + ' · ' : '') + estUsd(c.estVolumeUsd) + '</div>'",
    );
  });

  // ---- 2. "1 Democrats" pluralization --------------------------------------
  it('pluralizes party counts correctly (1 Democrat, not 1 Democrats)', () => {
    const src = extractFn(DASHBOARD_HTML, 'fmtCount') + '\n' + extractFn(DASHBOARD_HTML, 'pluralCount') + '\nreturn pluralCount;';
    // eslint-disable-next-line no-new-func -- executing the real shipped source
    const pluralCount = new Function(src)() as (n: number, noun: string) => string;
    expect(pluralCount(1, 'Democrat')).toBe('1 Democrat');
    expect(pluralCount(2, 'Democrat')).toBe('2 Democrats');
    expect(pluralCount(0, 'Republican')).toBe('0 Republicans');
    expect(pluralCount(1, 'Other')).toBe('1 Other');
    expect(pluralCount(22293, 'trade')).toBe('22,293 trades');
  });

  it('builds cluster-card party breakdowns from partyCountHtml/pluralCount instead of hardcoded plurals', () => {
    // Owner follow-up batch #14: Democrat/Republican now render through the
    // responsive full/abbr helper (Dems/Reps on mobile — see its own test);
    // Other stays on the plain always-full pluralCount helper.
    expect(DASHBOARD_HTML).toContain(
      "var parties = partyCountHtml(c.parties.D, 'Democrat', 'Dem') + ', ' + partyCountHtml(c.parties.R, 'Republican', 'Rep') + (c.parties.O ? ', ' + pluralCount(c.parties.O, 'Other') : '');",
    );
    expect(DASHBOARD_HTML).not.toContain("c.parties.D + ' Democrats, ' + c.parties.R + ' Republicans'");
  });

  it('owner follow-up batch #14: Consensus Moves cards abbreviate Democrats/Republicans to Dems/Reps on mobile (2-up), full word on desktop', () => {
    expect(DASHBOARD_HTML).toContain('function partyCountHtml(n, full, abbr) {');
    expect(DASHBOARD_HTML).toContain(
      "return fmtCount(n) + ' <span class=\"party-full\">' + full + suf + '</span><span class=\"party-abbr\">' + abbr + suf + '</span>';",
    );
    // Desktop default: full word shown, abbreviation hidden.
    expect(DASHBOARD_HTML).toContain('.party-abbr { display: none; }');
    // Mobile (<=768px, same breakpoint as the 2-up grid change): swap.
    expect(DASHBOARD_HTML).toContain('.cluster-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }');
    expect(DASHBOARD_HTML).toContain('.party-full { display: none; }');
    expect(DASHBOARD_HTML).toContain('.party-abbr { display: inline; }');
  });

  // ---- 3. Timeframe label rendering -----
  it('renders the single time filter dropdown at top and does not stamp the window on headings', () => {
    expect(DASHBOARD_HTML).toContain('id="trGlobalWindow"');
    expect(DASHBOARD_HTML).toContain('function stampWindowChips() {');
    expect(DASHBOARD_HTML).not.toContain('<em class="tr-window-label"');
    // The filter row lives in header.top row 2 (owner 2026-09-09); the old
    // sticky 100vw strips are gone.
    expect(DASHBOARD_HTML).toContain('header.top #ctFilters {');
    expect(DASHBOARD_HTML).not.toContain('position: sticky; top: var(--ct-header-h, 52px); z-index: 9;');
    expect(DASHBOARD_HTML).not.toContain('margin-left: calc(50% - 50vw);');
    expect(DASHBOARD_HTML).toContain("if (savedW == null && !w) w = (k && DEFAULT_CAP[k]) || minColWidth(k);");
    expect(DASHBOARD_HTML).toContain('html, body { width:100%; max-width:100%; overflow-x:clip; }');
    expect(DASHBOARD_HTML).not.toContain('main { max-width: none; min-width:0; overflow-x:clip;');
  });

  it('spells Top Performers scope as 5+ buys and +/-200% cap per trade', () => {
    expect(DASHBOARD_HTML).toContain('5+ buys');
    expect(DASHBOARD_HTML).toContain('+/-200% cap per trade');
    expect(DASHBOARD_HTML).not.toContain('few scored trades');
    expect(DASHBOARD_HTML).not.toContain('each trade capped at');
  });

  it('does not say in this window under Disclosure Timeliness', () => {
    expect(DASHBOARD_HTML).toContain("'Middle disclosure lag. ' + lagBasis");
    expect(DASHBOARD_HTML).toContain("'Number of trade rows with both transaction and official filing dates.'");
    expect(DASHBOARD_HTML).not.toContain('Middle disclosure lag in this window');
    expect(DASHBOARD_HTML).not.toContain('official filing dates in this window');
    expect(DASHBOARD_HTML).toContain("'<div class=\"note\">No dated filings.</div>'");
    expect(DASHBOARD_HTML).not.toContain('No dated filings in this window');
  });

  // ---- 4. "Healthcare" vs "Health Care" sector canonicalization ------------
  it('canonicalizes sector-name aliases at the display layer', () => {
    const src = extractFn(DASHBOARD_HTML, 'canonSector');
    const varMatch = DASHBOARD_HTML.match(/var SECTOR_CANON = \{[^}]*\};/);
    if (!varMatch) throw new Error('SECTOR_CANON not found in DASHBOARD_HTML');
    // eslint-disable-next-line no-new-func -- executing the real shipped source
    const canonSector = new Function(varMatch[0] + '\n' + src + '\nreturn canonSector;')() as (s: string) => string;
    expect(canonSector('Health Care')).toBe('Healthcare');
    expect(canonSector('Healthcare')).toBe('Healthcare');
    expect(canonSector('Energy')).toBe('Energy'); // untouched passthrough
  });

  it('titles the web sector card By Sector because the large figure is total volume', () => {
    expect(DASHBOARD_HTML).toContain('<summary class="tf-h">By Sector<span class="fold-cue" aria-hidden="true"></span></summary>');
    expect(DASHBOARD_HTML).not.toContain('<summary class="tf-h">Net Flow by Sector');
    expect(DASHBOARD_HTML).toContain('.brand { font-size: 15px; margin-left: 1ch; }');
    expect(DASHBOARD_HTML).toContain('html.phone-chrome .brand { margin-left: 1ch; }');
  });

  it('merges canonicalized sector rows and sorts Net Flow by Sector by signed net flow', () => {
    expect(DASHBOARD_HTML).toContain('rank by signed net');
    expect(DASHBOARD_HTML).toContain('var key = canonSector(r.sector);');
    expect(DASHBOARD_HTML).toContain('rows.sort(function (a, b) { return Number(b.estNetFlowUsd || 0) - Number(a.estNetFlowUsd || 0); });');
    expect(DASHBOARD_HTML).toContain("rows.sort(function (a, b) { return CAP_ORDER.indexOf(a.bucket) - CAP_ORDER.indexOf(b.bucket); });");
  });

  // ---- 5. Live status pill removed per user instruction -------------------
  it('removes the livePill element from the header', () => {
    expect(DASHBOARD_HTML).not.toContain('id="livePill"');
    expect(DASHBOARD_HTML).toContain("function setLivePill(cls, text) { var p = el('livePill'); if (!p) return;");
  });

  // ---- 6. "ranked by estimated volume" label vs actual sort order ----------
  // (covered above alongside the sector canonicalization fix, since both land
  // in the same loadTrSectorFlow() change.)

  // ---- 7. Canonical Premium pricing = $5/mo · $50/yr · 2-week trial -------
  it('shows $9/mo and $80/yr consistently across the dashboard pricing surfaces (alerts gate note + pricing modal)', () => {
    expect(DASHBOARD_HTML).toContain('Premium unlocks Webhooks + SSE + Proprietary Enrichment Data + CSV &middot; $9/mo or $80/yr &middot; 1-week free trial');
    expect(DASHBOARD_HTML).toContain('Premium unlocks Webhooks + SSE + Proprietary Enrichment Data + CSV &middot; $9/mo or $80/yr &middot; 1-week free trial');
    expect(DASHBOARD_HTML).toContain('$9<span class="per">/mo</span>');
    expect(DASHBOARD_HTML).toContain('$80<span class="per">/yr</span>');
    expect(DASHBOARD_HTML).toContain('1-week free trial');
    expect(DASHBOARD_HTML).not.toContain('$5<span class="per">/mo</span>');
    expect(DASHBOARD_HTML).not.toContain('$50<span class="per">/yr</span>');
    expect(DASHBOARD_HTML).not.toContain('$15/mo');
    expect(DASHBOARD_HTML).not.toContain('$140/yr');
  });

  it('makes the Monthly/Annual plan picker a real keyboard/AT-operable radio group (WEBA11Y-03)', () => {
    // Native radio inputs give keyboard users arrow-key selection and a
    // programmatic checked state, instead of mouse-only onclick divs whose
    // selection was conveyed only by a border/tint colour change.
    expect(DASHBOARD_HTML).toContain('role="radiogroup" aria-label="Plan"');
    expect(DASHBOARD_HTML).toContain('<label class="plan sel" id="planMonthly" for="planMonthlyRadio">');
    expect(DASHBOARD_HTML).toContain(
      '<input type="radio" class="plan-radio-input" id="planMonthlyRadio" name="plan" value="monthly" checked onchange="selectPlan(\'monthly\')">',
    );
    expect(DASHBOARD_HTML).toContain('<label class="plan" id="planAnnual" for="planAnnualRadio">');
    expect(DASHBOARD_HTML).toContain(
      '<input type="radio" class="plan-radio-input" id="planAnnualRadio" name="plan" value="annual" onchange="selectPlan(\'annual\')">',
    );
    // Both radios share name="plan" so they behave as one native group.
    expect(DASHBOARD_HTML.match(/name="plan"/g)?.length).toBe(2);
    // selectPlan() keeps the native .checked state in sync with the visual
    // 'sel' class, not just the class.
    const fn = extractFn(DASHBOARD_HTML, 'selectPlan');
    expect(fn).toContain("mr.checked = selectedPlan === 'monthly'");
    expect(fn).toContain("ar.checked = selectedPlan === 'annual'");
    // Focus lands on the visually-hidden input, so the ring goes on the
    // visible label via :focus-within, not a raw outline around a 1px box.
    expect(DASHBOARD_HTML).toContain('.plan:focus-within { outline: 2px solid var(--accent); outline-offset: 2px; }');
  });

  it('supports editing existing deliveries (edit button + save path)', () => {
    expect(DASHBOARD_HTML).toContain('data-sub-edit');
    expect(DASHBOARD_HTML).toContain('function beginEditSubscription(');
    expect(DASHBOARD_HTML).toContain('function saveSubscriptionEdits(');
    expect(DASHBOARD_HTML).toContain("type: 'update_subscription'");
  });

  it('supports pause/resume/delete delivery controls end-to-end in the SPA', () => {
    expect(DASHBOARD_HTML).toContain('data-sub-toggle');
    expect(DASHBOARD_HTML).toContain('data-sub-delete');
    expect(DASHBOARD_HTML).toContain("type: 'delete_subscription'");
    expect(DASHBOARD_HTML).toContain("payload: { id: id, active: nextActive }");
    expect(DASHBOARD_HTML).toContain('Delivery paused.');
    expect(DASHBOARD_HTML).toContain('Delivery resumed.');
    expect(DASHBOARD_HTML).toContain('Delivery deleted.');
    expect(DASHBOARD_HTML).toContain("delBtn.textContent = 'Confirm?';");
    expect(DASHBOARD_HTML).toContain('Confirm delete this delivery permanently');
    expect(DASHBOARD_HTML).toContain('All deliveries are paused.');
  });

  // ---- 8a. Keyboard-focusable + Enter-activatable drill-down rows ----------
  it('makes Consensus Moves (cluster) cards keyboard-focusable and Enter-activatable', () => {
    expect(DASHBOARD_HTML).toContain(
      '<div class="ccard clickable" tabindex="0" role="button" aria-label="View company \' + esc(c.ticker) + \'" data-asset="\' + esc(c.ticker) + \'">',
    );
  });

  // ---- 8b. Keyboard-operable sort headers ----------------------------------
  it('puts a real named <button> inside the "What Is Being Traded" ticker leaderboard sort headers, with aria-sort on the <th> (WEBA11Y P2 follow-up)', () => {
    // A bare tabindex'd <th> (the pre-#2072-followup shape) was announced
    // only as a column header, with nothing indicating Enter/Space sorts.
    // The <th> keeps its native columnheader role + aria-sort; the actual
    // focusable, named control is a real <button> inside it.
    for (const sortKey of ['trades', 'members', 'volume', 'netflow']) {
      expect(DASHBOARD_HTML).toContain(`<button type="button" class="th-sort-btn" onclick="setTickerSort('${sortKey}')">`);
    }
    // No more hand-rolled onkeydown — a native <button> already fires click
    // on Enter/Space, so the old per-header keydown wiring is gone.
    expect(DASHBOARD_HTML).not.toMatch(/tabindex="0" onclick="setTickerSort/);
    expect(DASHBOARD_HTML).not.toMatch(/onkeydown="if\(event\.key===.Enter.\|\|event\.key===. .\)\{event\.preventDefault\(\);setTickerSort/);
    // aria-sort ships on the <th> (baked in for the default 'trades' sort,
    // and kept live afterward — see the loadTrTickers() test below), never
    // on the <th> that has no data-sort (the "Asset" column, which never
    // showed a visual arrow either — see assetCellHtml()'s "whole row" note).
    expect(DASHBOARD_HTML).toContain('<th class="sortable" style="min-width: 140px;"><button type="button" class="th-sort-btn" onclick="setTickerSort(\'trades\')">Asset</button></th>');
    expect(DASHBOARD_HTML).toContain('<th class="sortable" data-sort="trades" aria-sort="descending">');
    expect(DASHBOARD_HTML).toContain('<th class="sortable r" data-sort="members" aria-sort="none">');
    expect(DASHBOARD_HTML).toContain('<th class="sortable r est" data-sort="volume" aria-sort="none">');
    expect(DASHBOARD_HTML).toContain('<th class="sortable r" data-sort="netflow" aria-sort="none">');
  });

  it('keeps loadTrTickers() updating aria-sort alongside the visual .sort-icon on every leaderboard refresh', () => {
    const fn = extractFn(DASHBOARD_HTML, 'loadTrTickers');
    expect(fn).toContain("document.querySelectorAll('#tableTrTickers th[data-sort]')");
    expect(fn).toContain("sortThs[j].setAttribute('aria-sort', sortThs[j].getAttribute('data-sort') === sortVal ? 'descending' : 'none');");
  });

  it('makes the main Trades feed table sort headers keyboard-operable via a real <button>, with valid aria-sort on the <th> (WEBA11Y-01 + P2 follow-up)', () => {
    // No role="button" on sortAttrs: overriding a <th>'s native columnheader
    // role made aria-sort invalid ARIA and broke column-header association
    // for screen readers (finding WEBA11Y-01).
    expect(DASHBOARD_HTML).toContain("var sortAttrs = c.sort ? ' aria-sort=\"none\"' : '';");
    expect(DASHBOARD_HTML).not.toContain("var sortAttrs = c.sort ? ' tabindex=\"0\" aria-sort=\"none\"' : '';");
    expect(DASHBOARD_HTML).not.toContain("var sortAttrs = c.sort ? ' tabindex=\"0\" role=\"button\" aria-sort=\"none\"' : '';");
    // WEBA11Y P2 follow-up: a bare tabindex'd <th> gave no indication Enter/
    // Space did anything.  The header now wraps its label in a real, named
    // <button class="th-sort-btn">; native button semantics give Enter/Space
    // activation for free, so the old hand-rolled th.onkeydown is gone.
    expect(DASHBOARD_HTML).toContain(
      "var inner = c.sort\n      ? '<button type=\"button\" class=\"th-sort-btn\" data-sort=\"' + c.sort + '\">' + esc(c.label) + '<span class=\"arr\" aria-hidden=\"true\"></span></button>'\n      : esc(c.label);",
    );
    expect(DASHBOARD_HTML).not.toContain('th.onkeydown = function (e) {');
    expect(DASHBOARD_HTML).toContain('btn.onclick = function () { setSort(btn.dataset.sort); };');
    expect(DASHBOARD_HTML).toContain("th.setAttribute('aria-sort', sortDir > 0 ? 'ascending' : 'descending');");
    expect(DASHBOARD_HTML).toContain("th.setAttribute('aria-sort', 'none');");
    // Focus ring moved from the (no-longer-focusable) <th> to the button.
    expect(DASHBOARD_HTML).not.toContain('th.sortable:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }');
    expect(DASHBOARD_HTML).toContain('.th-sort-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }');
  });

  it('gives the main Trades feed table row a real, named control instead of relying on the bare <tr> for keyboard/AT users (WEBA11Y P2 follow-up)', () => {
    // assetCellHtml() explicitly documents "No data-asset on the feed cell —
    // whole row opens the trade", so before this fix the <tr> was the ONLY
    // thing carrying data-txid/clickable — after WEBA11Y-01 stopped putting
    // role="button" on it (correctly, to keep native row semantics), Tab
    // landed on a plain "row" with nothing indicating Enter/Space did
    // anything. rowOpenBtnHtml() drops a real <button> into the row's first
    // cell instead — invisible at rest, a visible focus-ringed pill on
    // keyboard focus (same clip technique as the existing .fc-hint utility).
    expect(DASHBOARD_HTML).toContain(
      "function rowOpenBtnHtml(attrName, attrValue, label) {\n  return '<button type=\"button\" class=\"row-open-btn\" ' + attrName + '=\"' + esc(attrValue) + '\">' + esc(label) + '</button>';\n}",
    );
    const fn = extractFn(DASHBOARD_HTML, 'renderTrades');
    expect(fn).toContain("if (i === 0) cell = rowOpenBtnHtml('data-txid', r.id, 'Open trade details') + cell;");
    expect(DASHBOARD_HTML).toContain('.row-open-btn { position: absolute; width: 1px; height: 1px;');
    expect(DASHBOARD_HTML).toContain('.row-open-btn:focus-visible {');
    // The drawer's own "Recent Trades" mini-trade tables (asset + member
    // drawers) get the identical control — see the entity-click-through
    // coverage tests for the exact rendered snippet.
    expect(DASHBOARD_HTML.match(/rowOpenBtnHtml\('data-txid', /g)?.length).toBeGreaterThanOrEqual(3);
  });

  it('keeps two literal spaces between sentences in this PR\'s new comments (owner convention)', () => {
    // A single space slipped into one newly-added comment and was flagged in
    // review; this locks in the fix and the sweep of the rest of this PR's
    // new prose comments for the same slip.
    expect(DASHBOARD_HTML).toContain('// date from screen-reader users.  Dropping it lets the card\'s own visible');
    expect(DASHBOARD_HTML).not.toContain('// date from screen-reader users. Dropping it lets the card\'s own visible');
    expect(DASHBOARD_HTML).toContain("// the '/?param=value' construction.  A genuine <a href>, left to navigate");
    expect(DASHBOARD_HTML).not.toContain("// the '/?param=value' construction. A genuine <a href>, left to navigate");
    expect(DASHBOARD_HTML).toContain('// actually copied to the clipboard.  aria-label spells out what gets');
    expect(DASHBOARD_HTML).not.toContain('// actually copied to the clipboard. aria-label spells out what gets');
  });

  // ---- 8c. Focus trap + Escape in drawer/modals ----------------------------
  it('implements a shared Tab focus trap + focus-restore for the drawer and the login/pricing modals', () => {
    expect(DASHBOARD_HTML).toContain('function focusableEls(container)');
    expect(DASHBOARD_HTML).toContain('function trapFocusIn(container)');
    expect(DASHBOARD_HTML).toContain('function releaseFocusTrap()');
    expect(DASHBOARD_HTML).toContain('function openOverlayContainer()');
    // Escape already closed these overlays; this asserts that behavior is intact.
    expect(DASHBOARD_HTML).toContain("if (e.key === 'Escape') { closePanels(); closeDrawer(); closeLogin(); closePricing(); }");
    // Each open*() captures the pre-open focus target so close*() can restore it.
    expect(DASHBOARD_HTML).toContain('focusTrapReturnEl = document.activeElement;');
    expect(DASHBOARD_HTML).toContain('if (wasOpen) releaseFocusTrap();');
  });

  // ---- 8d. prefers-reduced-motion ------------------------------------------
  it('honors prefers-reduced-motion for entrance/pop animations outside the already-covered Trends charts', () => {
    expect(DASHBOARD_HTML).toContain('@media (prefers-reduced-motion: reduce) {');
    expect(DASHBOARD_HTML).toContain('.drawer.open .drawer-panel,');
    expect(DASHBOARD_HTML).toContain('dialog.search-panel[open],');
    expect(DASHBOARD_HTML).toContain('.tick-animate .tick-num {');
    expect(DASHBOARD_HTML).toContain('animation: none !important;');
  });

  // ---- 8e. alt text on politician images ------------------------------------
  it('gives politician avatar photos a real alt (the name), not alt=""', () => {
    const src = [
      extractFn(DASHBOARD_HTML, 'esc'),
      extractFn(DASHBOARD_HTML, 'initials'),
      extractFn(DASHBOARD_HTML, 'partyBucketClass'),
      extractFn(DASHBOARD_HTML, 'memberAvatarHtml'),
      'return memberAvatarHtml;',
    ].join('\n');
    // eslint-disable-next-line no-new-func -- executing the real shipped source
    const memberAvatarHtml = new Function(src)() as (name: string, photoUrl: string) => string;
    const html = memberAvatarHtml('Nancy Pelosi', 'https://example.com/photo.jpg');
    expect(html).toContain('alt="Nancy Pelosi"');
    expect(html).not.toContain('alt=""');
    // No photo -> no <img> at all (initials chip only); nothing to assert on alt.
    expect(memberAvatarHtml('Nancy Pelosi', '')).not.toContain('<img');
  });

  it('does not inject spaces while formatting names from the inline template', () => {
    const src = [
      'var NAME_SUFFIX = { jr: \'Jr\', \'jr.\': \'Jr\', sr: \'Sr\', \'sr.\': \'Sr\', ii: \'II\', iii: \'III\', iv: \'IV\' };',
      extractFn(DASHBOARD_HTML, 'fmtName'),
      'return fmtName;',
    ].join('\n');
    // eslint-disable-next-line no-new-func -- executing the real shipped source
    const fmtName = new Function(src)() as (raw: string) => string;
    expect(fmtName('Jared Moskowitz')).toBe('Jared Moskowitz');
    expect(fmtName('Richard Dean Dr McCormick')).toBe('Richard Dean McCormick');
    expect(fmtName('Dunn, Neal Patrick MD, FACS')).toBe('Neal Patrick Dunn');
  });

  // ---- People directory: surname-order name sort --------------------------
  it('keys the People directory name sort on the LAST name token, not the full string', () => {
    const src = [
      'var NAME_SUFFIX = { jr: \'Jr\', \'jr.\': \'Jr\', sr: \'Sr\', \'sr.\': \'Sr\', ii: \'II\', iii: \'III\', iv: \'IV\' };',
      extractFn(DASHBOARD_HTML, 'surnameSortKey'),
      'return surnameSortKey;',
    ].join('\n');
    // eslint-disable-next-line no-new-func -- executing the real shipped source
    const surnameSortKey = new Function(src)() as (name: string) => string;

    // "Rob Portman" sorts under P (surname), not R (given name).
    const names = ['Rob Portman', 'Nancy Pelosi', 'Mitch McConnell', 'Marco Rubio'];
    const sorted = [...names].sort((a, b) => (surnameSortKey(a) < surnameSortKey(b) ? -1 : 1));
    expect(sorted).toEqual(['Mitch McConnell', 'Nancy Pelosi', 'Rob Portman', 'Marco Rubio']);

    // A trailing generational suffix (Jr/Sr/II/III/IV) is ignored — the
    // surname is the token BEFORE it, not the suffix itself.
    const suffixed = ['Robert Casey Jr', 'August Pfluger II', 'Al Green Sr'];
    const sortedSuffixed = [...suffixed].sort((a, b) => (surnameSortKey(a) < surnameSortKey(b) ? -1 : 1));
    expect(sortedSuffixed).toEqual(['Robert Casey Jr', 'Al Green Sr', 'August Pfluger II']);

    // Two members sharing a surname tie-break on the full display string.
    const sameSurname = ['John Delaney', 'April McClain Delaney'];
    const sortedSame = [...sameSurname].sort((a, b) => (surnameSortKey(a) < surnameSortKey(b) ? -1 : 1));
    expect(sortedSame).toEqual(['April McClain Delaney', 'John Delaney']);
  });

  it('makes the People directory column headers keyboard-operable via a real <button>, with aria-sort on the <th> (WEBA11Y-05 + P2 follow-up)', () => {
    // WEBA11Y P2 follow-up: a bare tabindex'd <th> was announced only as a
    // column header, with nothing indicating Enter/Space sorts.  The <th>
    // keeps native columnheader role + aria-sort; a real, named <button>
    // inside it is the actual focusable control (native button semantics
    // give Enter/Space activation for free, so the old onkeydown is gone).
    for (const key of ['name', 'chamber', 'trades']) {
      expect(DASHBOARD_HTML).toContain(`data-sort="${key}" aria-sort="none"`);
      expect(DASHBOARD_HTML).toContain(`<button type="button" class="th-sort-btn" onclick="sortPeopleDirectory('${key}')">`);
    }
    expect(DASHBOARD_HTML).not.toMatch(/data-sort="(?:name|chamber|trades)" tabindex="0" aria-sort="none" onclick="sortPeopleDirectory/);
    expect(DASHBOARD_HTML).not.toMatch(/onkeydown="if\(event\.key===.Enter.\|\|event\.key===. .\)\{event\.preventDefault\(\);sortPeopleDirectory/);
    // The people-table-specific focus rule is gone; the shared .th-sort-btn
    // rule (asserted for the Trades/Trends headers above) covers it now.
    expect(DASHBOARD_HTML).not.toContain('.people-table thead th[tabindex]:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }');
    const fn = extractFn(DASHBOARD_HTML, 'syncPeopleSortIndicators');
    expect(fn).toContain("th.setAttribute('aria-sort', PEOPLE_SORT.dir > 0 ? 'ascending' : 'descending');");
    expect(fn).toContain("th.setAttribute('aria-sort', 'none');");
  });
});

/**
 * Regression cover for CT-AUD-P0-4.
 *
 * `DASHBOARD_HTML` is one ~8,800-line TypeScript template literal, so every
 * backslash in the embedded browser JS is consumed by template-literal escape
 * processing before the browser ever sees it. A regex written `/\.{2}/g` in
 * this file ships as `/.{2}/g` — "MICROSOFT CORP" rendered as "......." in
 * production for as long as that line existed.
 *
 * `tsc` cannot see this (the literal is just a string) and neither can a test
 * that greps the SOURCE text — the bug only exists in the GENERATED script.
 * So there are two guards here:
 *   1. a lexical guard over the source file, which fails on any new
 *      single-backslash escape inside the literal, and
 *   2. behavioural tests that execute the emitted script.
 */
describe('embedded client script escaping (CT-AUD-P0-4)', () => {
  function extractFn(html: string, name: string): string {
    const marker = 'function ' + name + '(';
    const start = html.indexOf(marker);
    if (start < 0) throw new Error('function not found in DASHBOARD_HTML: ' + name);
    const braceStart = html.indexOf('{', start);
    let depth = 0;
    let i = braceStart;
    for (; i < html.length; i++) {
      if (html[i] === '{') depth++;
      else if (html[i] === '}') {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      }
    }
    return html.slice(start, i);
  }

  it('has no single-backslash escapes inside the template literal', () => {
    const source = readFileSync(new URL('../dashboardHtml.ts', import.meta.url) as any, 'utf8') as string;
    const open = source.indexOf('`', source.indexOf('DASHBOARD_HTML'));
    expect(open).toBeGreaterThan(0);

    // Inside a template literal only these survive intact: an escaped
    // backslash, an escaped backtick, an escaped `${`, and a \uXXXX code
    // point. Everything else silently loses its backslash — which is exactly
    // how the regexes in fmtCompany shipped broken.
    const offenders: string[] = [];
    for (let i = open + 1; i < source.length; i++) {
      const ch = source[i];
      if (ch === '`') break;
      if (ch !== '\\') continue;
      const next = source[i + 1];
      const isEscapedBackslash = next === '\\';
      const isEscapedBacktick = next === '`';
      const isEscapedInterp = next === '$';
      const isCodePoint = next === 'u' && /^[0-9a-fA-F]{4}$/.test(source.slice(i + 2, i + 6));
      if (!(isEscapedBackslash || isEscapedBacktick || isEscapedInterp || isCodePoint)) {
        const line = source.slice(0, i).split('\n').length;
        offenders.push(`line ${line}: \\${next} in ${source.split('\n')[line - 1].trim().slice(0, 100)}`);
      }
      i++; // consume the escaped character
    }

    expect(
      offenders,
      'Single-backslash escapes lose their backslash in the generated script. ' +
        'Double them (\\\\s, \\\\b, \\\\d, \\\\.) so the browser receives a real regex.',
    ).toEqual([]);
  });

  it('formats company names instead of collapsing them to dots', () => {
    const src = [
      extractFn(DASHBOARD_HTML, 'fmtCompany'),
      DASHBOARD_HTML.slice(
        DASHBOARD_HTML.indexOf('var COMPANY_BRAND_CASING = ['),
        DASHBOARD_HTML.indexOf('];', DASHBOARD_HTML.indexOf('var COMPANY_BRAND_CASING = [')) + 2,
      ),
      'return fmtCompany;',
    ].join('\n');
    // eslint-disable-next-line no-new-func -- executing the real shipped source
    const fmtCompany = new Function(src)() as (raw: string) => string;

    // The exact production symptom: every name became a run of periods.
    expect(fmtCompany('MICROSOFT CORP')).not.toMatch(/^\.+$/);

    expect(fmtCompany('MICROSOFT CORP')).toBe('Microsoft Corp.');
    expect(fmtCompany('APPLE INC')).toBe('Apple Inc.');
    expect(fmtCompany('AMAZON COM INC')).toBe('Amazon.com, Inc.');
    expect(fmtCompany('META PLATFORMS INC')).toBe('Meta Platforms, Inc.');
    // Interior articles lowercase; the first and last word never do.
    expect(fmtCompany('BANK OF AMERICA CORP')).toBe('Bank of America Corp.');
    expect(fmtCompany('THE WALT DISNEY CO')).toBe('The Walt Disney Co.');
    // Trailing single letters are share classes, not articles.
    expect(fmtCompany('ALPHABET INC CLASS A')).toBe('Alphabet Inc. Class A');
    // Internal punctuation survives title casing.
    expect(fmtCompany('SPDR S&P 500 ETF TRUST')).toBe('SPDR S&P 500 ETF Trust');
    expect(fmtCompany("O'REILLY AUTOMOTIVE INC")).toBe("O'Reilly Automotive Inc.");
    expect(fmtCompany('')).toBe('');
  });

  it('normalizes whitespace in vote keys rather than deleting the letter s', () => {
    // `/\s+/g` shipped as `/s+/g`, so "MISSISSIPPI POWER" keyed as
    // "MI I IPPI POWER" and identical rows failed to group.
    const match = DASHBOARD_HTML.match(/String\(val\)\.trim\(\)\.replace\((\/[^/]+\/g), ' '\)/);
    expect(match, 'vote-key whitespace normalizer not found').toBeTruthy();
    // eslint-disable-next-line no-new-func -- executing the real shipped source
    const normalize = new Function('v', `return String(v).trim().replace(${match![1]}, ' ').toUpperCase();`) as (
      v: string,
    ) => string;
    expect(normalize('  MISSISSIPPI   POWER  ')).toBe('MISSISSIPPI POWER');
    expect(normalize('Alphabet\tInc')).toBe('ALPHABET INC');
  });

  it('rebuilds House PTR links from an 8-digit doc id', () => {
    const src = extractFn(DASHBOARD_HTML, 'reconstructFilingUrl') + '\nreturn reconstructFilingUrl;';
    // eslint-disable-next-line no-new-func -- executing the real shipped source
    const reconstructFilingUrl = new Function(src)() as (docId: string) => string;
    // `/(\d{8})/` shipped as `/(d{8})/` — it matched eight literal "d"s, so
    // every House PTR link silently returned ''.
    expect(reconstructFilingUrl('20026543')).toBe(
      'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20026543.pdf',
    );
    expect(reconstructFilingUrl('H-2026-0001')).toBe('/api/documents/H-2026-0001/pdf');
    expect(reconstructFilingUrl('')).toBe('');
  });
});

/**
 * Guards CT-AUD-P1-15.
 *
 * The dashboard shipped a hardcoded Google Analytics tag while the CSP was
 * `script-src 'self' 'unsafe-inline'` / `connect-src 'self'`, so the browser
 * blocked it on every page load for every visitor. It never produced a data
 * point; it only produced CSP violations. The invariant worth keeping is not
 * "no analytics" but "no script the CSP will block" — reintroducing a
 * third-party tag must be a deliberate change that also widens the policy.
 */
describe('served HTML matches the Content-Security-Policy (CT-AUD-P1-15)', () => {
  it('loads no external script the policy forbids', async () => {
    const { buildUiRouter } = await import('../routes.ts');
    const res = await buildUiRouter().request('http://localhost/', {}, { } as never);
    const html = await res.text();

    const externalSrcs = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)]
      .map((m) => m[1])
      .filter((src) => /^https?:\/\//i.test(src));

    const policy = browserSecurityHeaders('https://congress.trade/').get('content-security-policy') ?? '';
    const scriptSrc = (policy.match(/script-src ([^;]*)/)?.[1] ?? '').trim();

    for (const src of externalSrcs) {
      const origin = new URL(src).origin;
      expect(
        scriptSrc.includes(origin),
        `<script src="${src}"> is blocked by script-src (${scriptSrc}). ` +
          'Either drop the script or widen the CSP deliberately.',
      ).toBe(true);
    }
  });

  it('leaves no unsubstituted template placeholder in the served HTML', async () => {
    const { buildUiRouter } = await import('../routes.ts');
    const res = await buildUiRouter().request('http://localhost/', {}, { } as never);
    const html = await res.text();
    expect(html).not.toContain('%GA_SCRIPT%');
    expect(html).not.toContain('%LOGO_DISPLAY%');
    expect(html).not.toContain('%OG_IMAGE%');
    expect(html).not.toContain('%OG_TITLE%');
    expect(html).not.toContain('%CANONICAL_URL%');
  });

  it('serves context OG cards for Trends / company / politician deep links', async () => {
    const { buildUiRouter } = await import('../routes.ts');
    const app = buildUiRouter();

    const { OG_IMAGE_VERSION: v } = await import('../assets.ts');

    // SEOSOCIAL-06: the company/politician cards now require a DB-resolved
    // match, so this fixture stands in for a filer + a traded ticker.
    const dbEnv = {
      DB: {
        prepare: (sql: string) => ({
          bind() {
            return this;
          },
          async first() {
            if (/FROM filers/i.test(sql)) {
              return { full_name: 'Nancy Pelosi', chamber: 'house', party: 'Democrat', state: 'CA', district: '11' };
            }
            if (/FROM transactions/i.test(sql)) return { 1: 1 };
            return null;
          },
        }),
      },
    } as never;

    const trends = await (await app.request('http://localhost/?view=trends', {}, dbEnv)).text();
    expect(trends).toContain(`og-image-trends.png?v=${v}`);
    expect(trends).toContain('content="Trends"');

    const company = await (await app.request('http://localhost/?ticker=AAPL', {}, dbEnv)).text();
    expect(company).toContain(`og-image-company.png?v=${v}`);
    expect(company).toContain('content="AAPL"');

    const pol = await (await app.request('http://localhost/?member=P000197', {}, dbEnv)).text();
    expect(pol).toContain(`og-image-politician.png?v=${v}`);
    expect(pol).toContain('content="Nancy Pelosi (D-CA-11)"');

    const home = await (await app.request('http://localhost/', {}, dbEnv)).text();
    expect(home).toContain(`og-image.png?v=${v}`);
    expect(home).not.toContain('og-image-trends.png');
  });

  it('SEOSOCIAL-06: falls back to the default card for an unresolved member/ticker instead of a 500 or an echoed card', async () => {
    const { buildUiRouter } = await import('../routes.ts');
    const app = buildUiRouter();
    const emptyDbEnv = {
      DB: {
        prepare: () => ({
          bind() {
            return this;
          },
          async first() {
            return null;
          },
        }),
      },
    } as never;

    const company = await app.request('http://localhost/?ticker=evil-tricker', {}, emptyDbEnv);
    expect(company.status).toBe(200);
    const companyHtml = await company.text();
    expect(companyHtml).toContain('content="Congress.Trade"');
    expect(companyHtml).not.toContain('EVIL-TRICKER');

    const pol = await app.request('http://localhost/?member=Claim free BTC', {}, emptyDbEnv);
    expect(pol.status).toBe(200);
    const polHtml = await pol.text();
    expect(polHtml).toContain('content="Congress.Trade"');
    expect(polHtml).not.toContain('Claim free BTC');
  });
});

describe('UX P0 review fixes (web)', () => {
  it('resolves trade deep links by id and maps client trade envelopes', () => {
    expect(DASHBOARD_HTML).toContain('function clientTradeToRow(');
    expect(DASHBOARD_HTML).toContain("fetch('/api/client/v1/trade/'");
    expect(DASHBOARD_HTML).toContain('function openTradeById(id)');
    // No longer stuck on "only loaded feed window" messaging as the only path.
    expect(DASHBOARD_HTML).not.toContain('Trades only resolve against loaded rows');
  });

  it('gates CSV export as Premium with memberName+from filters and export pricing intent', () => {
    // Unified search → memberName/ticker via applySearchToServerParams (not dual fields).
    expect(DASHBOARD_HTML).toContain('applySearchToServerParams(p, tradesSearchQuery())');
    expect(DASHBOARD_HTML).toContain("p.set('memberName', nameBits.join(' '))");
    expect(DASHBOARD_HTML).toContain("if (from) p.set('from', from)");
    expect(DASHBOARD_HTML).toContain("if (to) p.set('to', to)");
    expect(DASHBOARD_HTML).toContain("window.location.href = '/api/export/transactions.csv'");
    expect(DASHBOARD_HTML).toContain("openPricing('export')");
    expect(DASHBOARD_HTML).toContain("intent === 'export'");
    expect(DASHBOARD_HTML).toContain('Full-history CSV export');
    expect(DASHBOARD_HTML).toContain('Sign in to export CSV');
    expect(DASHBOARD_HTML).not.toContain('CSV export is free (full history)');
    expect(DASHBOARD_HTML).not.toContain('free CSV export');
    // CSV lives in the Options menu; freemium pitch stays in gate-note and
    // hides once premium (data-premium-cue). Export entry remains reachable.
    expect(DASHBOARD_HTML).toContain('<span class="gate-note" data-premium-cue="export">');
    expect(DASHBOARD_HTML).toContain('id="exportCsvBtn"');
    expect(DASHBOARD_HTML).toContain('toggleFeedOptions');
    expect(DASHBOARD_HTML).toContain('node.hidden = unlocked || !checkoutConfigured();');
  });

  it('lazy-loads asset drawer backtest instead of a hard PERF_GATE', () => {
    expect(DASHBOARD_HTML).toContain('function tickerBacktestHtml(');
    expect(DASHBOARD_HTML).toContain("aGet('ticker/' + encodeURIComponent(ticker) + '/backtest");
    expect(DASHBOARD_HTML).toContain('id="assetPerf"');
    expect(DASHBOARD_HTML).not.toContain(
      "'<div class=\"drawer-section\"><h3>Performance Since Trades</h3>' + PERF_GATE + '</div>'",
    );
  });

  it('exposes footer legal/RSS links and toast aria-live', () => {
    expect(DASHBOARD_HTML).toContain('href="/privacy-policy"');
    expect(DASHBOARD_HTML).toContain('href="/terms-of-service"');
    expect(DASHBOARD_HTML).toContain('href="/pricing"');
    expect(DASHBOARD_HTML).toContain('href="/api/feed.xml"');
    expect(DASHBOARD_HTML).toContain('id="toast" role="status" aria-live="polite"');
  });

  it('opens pricing from ?pricing= deep links', () => {
    expect(DASHBOARD_HTML).toContain("pricing === '1'");
    expect(DASHBOARD_HTML).toContain("openPricing(pricing === 'alerts' || pricing === 'export' ? pricing : 'default')");
  });
});

describe('UX wave2 web product (People / conflicts / delivery / mobile)', () => {
  it('implements People directory load + client filter + openMember', () => {
    expect(DASHBOARD_HTML).toContain('function loadPeopleDirectory(');
    expect(DASHBOARD_HTML).toContain('function filterPeopleDirectory(');
    expect(DASHBOARD_HTML).toContain("fetch('/api/members'");
    expect(DASHBOARD_HTML).toContain('id="peopleBody"');
    expect(DASHBOARD_HTML).toContain("b.dataset.view === 'people'");
    // People rows use data-member; app-wide handleEntityOpenEvent opens the drawer.
    expect(DASHBOARD_HTML).toContain('data-member=');
    expect(DASHBOARD_HTML).toContain('function openMember(');
    expect(DASHBOARD_HTML).toContain('function handleEntityOpenEvent(');
  });

  it('loads committee conflicts into #trConflicts on Trends refresh', () => {
    expect(DASHBOARD_HTML).toContain('function loadTrConflicts(');
    expect(DASHBOARD_HTML).toContain("aGet('conflicts?'");
    expect(DASHBOARD_HTML).toContain('id="trConflicts"');
    expect(DASHBOARD_HTML).toContain('loadTrConflicts();');
  });

  it('wires delivery create filters for members, sides, and minAmount', () => {
    expect(DASHBOARD_HTML).toContain("filters.members = membersRaw");
    expect(DASHBOARD_HTML).toContain('filters.sides = sidesRaw.split');
    expect(DASHBOARD_HTML).toContain('filters.minAmount = minAmt');
    expect(DASHBOARD_HTML).toContain('id="newMembers"');
    expect(DASHBOARD_HTML).toContain('id="newSides"');
    expect(DASHBOARD_HTML).toContain('id="newMinAmt"');
    expect(DASHBOARD_HTML).toContain('id="newTickers"');
    expect(DASHBOARD_HTML).toContain('id="newChambers"');
    // Create path posts real filters (not a hard-coded empty object literal alone).
    expect(DASHBOARD_HTML).toContain('payload: { delivery: delivery, targetUrl: targetUrl || null, filters: filters }');
    expect(DASHBOARD_HTML).toContain('<option value="E">Exchanges</option>');
    expect(DASHBOARD_HTML).toContain('<option value="B,S">Buys + Sells</option>');
  });

  it('renders a delivery members filter as names and calls out entries that can never match (a6058af2)', () => {
    const memberFilterText = new Function(
      loadDashboardFunctions(['memberFilterText']).join('\n\n') + '\nreturn memberFilterText;',
    )() as (s: Record<string, unknown>) => string;
    const sub = (over: Record<string, unknown>) => ({ filters: { members: [] }, ...over });
    expect(
      memberFilterText(sub({ filters: { members: ['P000197'] }, memberLabels: { P000197: 'Nancy Pelosi' } })),
    ).toBe('Nancy Pelosi');
    expect(
      memberFilterText(
        sub({
          filters: { members: ['A', 'B', 'C', 'D'] },
          memberLabels: { A: 'Ann', B: 'Bob', C: 'Cy', D: 'Di' },
        }),
      ),
    ).toBe('Ann, Bob +2 more');
    // An id with no label (a filer with no name on file) still shows.
    expect(memberFilterText(sub({ filters: { members: ['NOFILERROW1'] } }))).toBe('NOFILERROW1');
    // Free text saved before names were resolved to ids: flagged, not counted as a match.
    expect(
      memberFilterText(
        sub({
          filters: { members: ['Nancy Pelosi', 'S000510'] },
          memberLabels: { S000510: 'Adam Smith' },
          unresolvedMembers: ['Nancy Pelosi'],
        }),
      ),
    ).toBe('Adam Smith · not matched: Nancy Pelosi (Edit to fix)');
    expect(DASHBOARD_HTML).toContain('parts.push(memberFilterText(s))');
  });

  it('keeps the Delivery edit form open and says why when the update command failed (a6058af2)', () => {
    expect(DASHBOARD_HTML).toContain("if (j && j.command && j.command.status === 'failed') throw new Error(j.command.error || 'command failed');");
    // The edit form shows names where the server labelled them.
    expect(DASHBOARD_HTML).toContain('editLabels[id] || id');
  });

  it('gives every Delivery create-form control a programmatic label (WEBA11Y-04)', () => {
    // Visible-if-hidden <label for> siblings, not wrapping (wrapping would
    // stop the control being a direct .row-flex child and break the
    // existing responsive `.row-flex > select/input` sizing rules).
    expect(DASHBOARD_HTML).toContain('<label class="field-vh-label" for="newDelivery">Channel</label>');
    expect(DASHBOARD_HTML).toContain('<label class="field-vh-label" for="newTarget">Target URL</label>');
    expect(DASHBOARD_HTML).toContain('<label class="field-vh-label" for="newTickers">Tickers</label>');
    expect(DASHBOARD_HTML).toContain('<label class="field-vh-label" for="newMembers">Members</label>');
    expect(DASHBOARD_HTML).toContain('<label class="field-vh-label" for="newChambers">Branches</label>');
    expect(DASHBOARD_HTML).toContain('<label class="field-vh-label" for="newSides">Trade side</label>');
    expect(DASHBOARD_HTML).toContain('.field-vh-label { position: absolute;');
  });

  it('styles trends-fold summaries like section headers and keeps mobile bottom nav', () => {
    expect(DASHBOARD_HTML).toContain('details.trends-fold > summary');
    expect(DASHBOARD_HTML).toContain('class="section trends-fold"');
    // Fixed bottom tab bar with safe-area + body padding at the phone breakpoint.
    expect(DASHBOARD_HTML).toContain('position: fixed; left: 0; right: 0; bottom: 0;');
    expect(DASHBOARD_HTML).toContain('env(safe-area-inset-bottom');
    // Owner punch list #5: reduced from the old 86px overshoot to a ~10px
    // clearance over the ~60px tab bar (see "mobile bottom clearance" below
    // for the full main/footer safe-area regression coverage).
    expect(DASHBOARD_HTML).toContain('padding-bottom: calc(70px + env(safe-area-inset-bottom))');
    expect(DASHBOARD_HTML).toContain('data-view="people"');
    expect(DASHBOARD_HTML).toContain('data-mobile="Directory"');
  });
});

describe('web toolbar/filter/chrome work order (LANE A1)', () => {
  it('replaces the All Types select with an Exchange toggle merged into the buy/sell chips', () => {
    // <select id="qType"> is gone entirely — merged into the segmented
    // buy/sell/exchange toggle, exactly like the H/S/P chips behave.
    expect(DASHBOARD_HTML).not.toContain('id="qType"');
    expect(DASHBOARD_HTML).not.toContain('>All Types</option>');
    expect(DASHBOARD_HTML).not.toContain("el('qType')");
    // Exchange toggle: ⇄ symbol, dedicated aria-label, wired into the shared
    // side-chip group on BOTH the Trades and Trends shared filter rows.
    expect(DASHBOARD_HTML).toContain('data-side="E"');
    expect(DASHBOARD_HTML).toContain('<span class="side-ex" aria-hidden="true">⇄</span>');
    expect(DASHBOARD_HTML).toMatch(/id="qSideGroup"[\s\S]*?data-side="E"/);
    expect(DASHBOARD_HTML).toMatch(/id="trSideGroup"[\s\S]*?data-side="E"/);
    // Every pictographic toggle keeps an aria-label.
    expect(DASHBOARD_HTML).toContain('data-side="B"');
    expect(DASHBOARD_HTML).toContain('data-side="S"');
    expect(DASHBOARD_HTML).toContain('> Buys</button>');
    expect(DASHBOARD_HTML).toContain('> Sells</button>');
    // Client + query-param + URL-sync + CSV export + restore-from-URL paths
    // all read the toggle via selectedSideParam(), not a select value.
    expect(DASHBOARD_HTML).toContain("ty = selectedSideParam('qSideGroup')");
    expect(DASHBOARD_HTML).toContain("var ty = selectedSideParam('qSideGroup');");
    expect(DASHBOARD_HTML).toContain("['fty', selectedSideParam('qSideGroup')]");
    expect(DASHBOARD_HTML).toContain("['fpa', partyParam('qPartyGroup')]");
    expect(DASHBOARD_HTML).toContain('applySideSelection(sides)');
    expect(DASHBOARD_HTML).toContain('applyPartySelection(parties)');
    expect(DASHBOARD_HTML).not.toContain("b.getAttribute('data-side') === fty");
    expect(DASHBOARD_HTML).toContain("var ty = selectedSideParam('qSideGroup');");
    expect(DASHBOARD_HTML).toContain("if (ty) p.set('type', ty);");
  });

  it('forwards the Trends side chips as type= on every analytics request', () => {
    expect(DASHBOARD_HTML).toContain("var ty = selectedSideParam('trSideGroup');");
    expect(DASHBOARD_HTML).toContain("if (ty) p += '&type=' + encodeURIComponent(ty);");
  });

  it('opens ticker and politician drawers with the same shared filter params', () => {
    expect(DASHBOARD_HTML).toContain("'ticker/' + encodeURIComponent(ticker) + '?' + trParams()");
    expect(DASHBOARD_HTML).toContain("'/backtest?' + trParams()");
    expect(DASHBOARD_HTML).toContain("'member/' + encodeURIComponent(filerId) + '?' + trParams()");
    expect(DASHBOARD_HTML).toContain("'/performance?' + trParams()");
  });

  it('builds analytics URLs without percent-encoding the query into the path', () => {
    expect(DASHBOARD_HTML).toContain('function analyticsUrl(path)');
    expect(DASHBOARD_HTML).toContain("fetch(url)");
    expect(DASHBOARD_HTML).not.toContain("fetch('/api/analytics/' + path)");
  });

  it('joins the H/S/P, party, and buy/sell/exchange groups into one segmented cluster', () => {
    expect(DASHBOARD_HTML).toContain('class="filter-groups"');
    // Party + side chips now share the exact joined-segment treatment as the
    // H/S/P strip: one outer border/radius per group, no gaps between chips.
    expect(DASHBOARD_HTML).toContain('.branch-seg, .party-chips, .side-chips { display:inline-flex; align-items:center; border:1px solid var(--border); border-radius:9px; overflow:hidden; }');
    expect(DASHBOARD_HTML).toContain('.branch-toggle, .party-chip, .side-chip {');
    expect(DASHBOARD_HTML).toContain('.branch-toggle + .branch-toggle, .party-chip + .party-chip, .side-chip + .side-chip { border-left:1px solid var(--border); }');
  });

  it('collapses every per-group ⓘ into one combined popover per shared filter row', () => {
    expect(DASHBOARD_HTML).toContain('id="qChamber"');
    expect(DASHBOARD_HTML).toContain('id="trChamber"');
    expect(DASHBOARD_HTML).toContain('Democrats');
    expect(DASHBOARD_HTML).toContain('Republicans');
    expect(DASHBOARD_HTML).toContain('Other / No party');
    // Old per-group anchors are gone.
    expect(DASHBOARD_HTML).not.toContain('id="qChamberInfo"');
    expect(DASHBOARD_HTML).not.toContain('id="trChamberInfo"');
    expect(DASHBOARD_HTML).not.toContain('id="trPartyInfo"');
    // The combined popover explains every pictograph: branch, party, and type.
    expect(DASHBOARD_HTML).toContain('House</button>');
    expect(DASHBOARD_HTML).toContain('Senate</button>');
    expect(DASHBOARD_HTML).toContain('Executive</button>');
    for (const glyph of ['▲', '▼', '⇄']) {
      expect(DASHBOARD_HTML).toContain(glyph);
    }
    for (const party of ['D', 'R', 'O']) {
      expect(DASHBOARD_HTML).toContain('class="party-dot ' + party + '"');
    }
    expect(DASHBOARD_HTML).not.toMatch(/[\u{1FACF}\u{1F418}\u{1F985}]/u);
  });

  it('owner follow-up batch #21: deletes the $-threshold filter pill entirely (no $/size dropdown on any platform)', () => {
    expect(DASHBOARD_HTML).not.toContain('.min-amt-select');
    expect(DASHBOARD_HTML).not.toContain('id="qMinAmt"');
    expect(DASHBOARD_HTML).not.toContain('id="trMinAmt"');
    expect(DASHBOARD_HTML).not.toContain('pill-amt');
    expect(DASHBOARD_HTML).not.toContain('function onSharedMinAmtChange');
    expect(DASHBOARD_HTML).not.toContain('Any $');
    // The server-side query param can remain for direct API consumers — the
    // client just never sends it anymore since there's no UI control.
    expect(DASHBOARD_HTML).not.toContain("p.set('minAmount', amt)");
    expect(DASHBOARD_HTML).not.toContain("p.set('minAmount', minAmt)");
  });

  it('puts pagination top+bottom, rows selector + Options menu (Columns/Export), and keeps freemium pitch in gateRow', () => {
    // Toolbar no longer carries export/columns/page size.
    const extraFilters = DASHBOARD_HTML.match(/<div class="toolbar trades-only-filters" id="tradesExtraFilters">[\s\S]*?<\/div>/);
    expect(extraFilters).not.toBeNull();
    expect(extraFilters![0]).not.toContain('id="colsBtn"');
    expect(extraFilters![0]).not.toContain('id="pageSize"');
    expect(extraFilters![0]).not.toContain('id="exportCsvBtn"');
    expect(extraFilters![0]).toContain('id="qSearch"');
    expect(extraFilters![0]).not.toContain('id="searchToggle"');
    expect(extraFilters![0]).not.toContain('id="qAssetClass"');
    expect(extraFilters![0]).not.toContain('value="equities_funds"');
    expect(extraFilters![0]).not.toContain('All Assets');
    expect(extraFilters![0]).not.toContain('id="tradesStats"');
    expect(extraFilters![0]).not.toContain('kpiTotal');
    // Top + bottom pagers with shared data-* hooks.
    expect(DASHBOARD_HTML).toContain('class="row-flex pager pager-top"');
    expect(DASHBOARD_HTML).toContain('class="row-flex pager pager-bottom"');
    expect(DASHBOARD_HTML).toContain('data-pager="top"');
    expect(DASHBOARD_HTML).toContain('data-pager="bottom"');
    expect(DASHBOARD_HTML).toContain('data-trades-count');
    expect(DASHBOARD_HTML).toContain('data-page-size');
    expect(DASHBOARD_HTML).toContain('id="pageSize"');
    expect(DASHBOARD_HTML).toContain('<option value="25">25 rows</option>');
    expect(DASHBOARD_HTML).toContain('<option value="50" selected>50 rows</option>');
    expect(DASHBOARD_HTML).toContain('<option value="100">100 rows</option>');
    expect(DASHBOARD_HTML).toContain('<option value="250">250 rows</option>');
    // Export + Columns live under the Options (⋯) menu, not as a lone gate button.
    expect(DASHBOARD_HTML).toContain('toggleFeedOptions');
    expect(DASHBOARD_HTML).toContain('feed-options-item-cols');
    expect(DASHBOARD_HTML).toContain('id="exportCsvBtn"');
    expect(DASHBOARD_HTML).toContain('Export CSV');
    // Gate-note area: freemium pitch only (CSV moved to Options).
    const gateRow = DASHBOARD_HTML.match(/<div class="row-flex" id="gateRow"[\s\S]*?<\/div>/);
    expect(gateRow).not.toBeNull();
    expect(gateRow![0]).not.toContain('id="exportCsvBtn"');
    expect(gateRow![0]).toContain('Start Free Trial');
    expect(gateRow![0]).toContain('data-premium-cue="export"');
  });

  it('formats the bottom pagination string without the word "Showing" and with thousands separators', () => {
    expect(DASHBOARD_HTML).not.toContain('Showing <span');
    expect(DASHBOARD_HTML).not.toMatch(/>Showing</);
    // Range-of-total ("1-50 of 12,345") — compact so it fits beside << < > >>.
    expect(DASHBOARD_HTML).toContain(
      "countHtml = '<span class=\"tick-num\">' + start.toLocaleString() + '-' + end.toLocaleString() + '</span> of <span class=\"tick-num\">' + total.toLocaleString() + '</span>';",
    );
    expect(DASHBOARD_HTML).toContain("setAll('[data-trades-count]'");
    expect(DASHBOARD_HTML).toContain('class="row-flex pager pager-top"');
    expect(DASHBOARD_HTML).toContain('id="firstPageBtn"');
    expect(DASHBOARD_HTML).toContain('id="lastPageBtn"');
    expect(DASHBOARD_HTML).toContain('function firstTradesPage(');
    expect(DASHBOARD_HTML).toContain('function lastTradesPage(');
  });

  it('gives mobile (<=768px) a hamburger menu instead of the theme-toggle/Sign-In/Upgrade cluster', () => {
    expect(DASHBOARD_HTML).toContain('.acct-desktop { display: none; }');
    expect(DASHBOARD_HTML).toContain('.acct-mobile { display: inline-flex; }');
    expect(DASHBOARD_HTML).toContain('class="acct-desktop"');
    // "Account menu" (not "Menu") — a truer accessible name once the button
    // can render the signed-in user's avatar instead of the ☰ glyph.
    expect(DASHBOARD_HTML).toContain('class="acct-hamburger" id="acctHamburgerBtn" aria-expanded="false" aria-controls="acctMobileMenu" aria-label="Account menu"');
    expect(DASHBOARD_HTML).toContain('id="acctMobileMenu"');
    expect(DASHBOARD_HTML).toContain('function toggleAcctMobileMenu()');
    // Mobile dropdown reuses the exact same theme handlers (themeRowHtml()),
    // never duplicating the desktop menu's element ids.
    expect(DASHBOARD_HTML).toContain('mobileHtml = ');
    expect(DASHBOARD_HTML).toContain('themeRowHtml()');
  });

  it('gates /api/admin/poll-config behind an admin session/token instead of firing on every load', () => {
    expect(DASHBOARD_HTML).not.toMatch(/\n\s*loadPollConfig\(\);\s*\/\/ for the poll-mode KPI/);
    expect(DASHBOARD_HTML).toContain('if (canUseAdmin()) loadPollConfig();');
    expect(DASHBOARD_HTML).toContain('function adminHeaders(extra)');
  });

  it('skips the guaranteed-404 EventSource probe behind a PUBLIC_STREAM_ENABLED const', () => {
    expect(DASHBOARD_HTML).toContain('var PUBLIC_STREAM_ENABLED = false;');
    expect(DASHBOARD_HTML).toContain('if (!PUBLIC_STREAM_ENABLED || typeof EventSource === \'undefined\') { startPolling(); return; }');
  });

  it('always shows the de-duplicated Primary Only source mode — the All Data toggle is gone (owner follow-up batch #2)', () => {
    expect(DASHBOARD_HTML).toContain("function tradesSourceMode() {");
    expect(DASHBOARD_HTML).toContain("return 'primary';");
    expect(DASHBOARD_HTML).toContain("if (primaryOnly && r.source === 'seed_dataset') return false;");
    expect(DASHBOARD_HTML).not.toContain('FEED_SOURCE_MODE_KEY');
    expect(DASHBOARD_HTML).not.toContain('data-source-mode="primary"');
    expect(DASHBOARD_HTML).not.toContain('data-source-mode="all"');
    expect(DASHBOARD_HTML).not.toContain('function setFeedSourceMode(mode)');
    expect(DASHBOARD_HTML).not.toContain('function syncFeedSourceModeUI(');
    expect(DASHBOARD_HTML).not.toContain('.source-mode-btn');
  });

  it('accepts visible tab names as ?view= aliases and falls back to Trends (not last-viewed) on unknown values', () => {
    // Owner follow-up batch #25: "trades" is now the canonical id (the URL
    // writes ?view=trades); "feed" is kept as a silent legacy alias forever.
    expect(DASHBOARD_HTML).toContain("var VIEW_ALIASES = { feed: 'trades', delivery: 'subs', directory: 'people' };");
    expect(DASHBOARD_HTML).toContain('function resolveViewId(raw)');
    expect(DASHBOARD_HTML).toContain('var canonicalView = resolveViewId(fromUrl);');
    // Unknown/garbage values resolve straight to 'trends' inside the same
    // branch that handles ?view= — never falling through to localStorage's
    // last-viewed tab (issue #1458).
    expect(DASHBOARD_HTML).toContain(
      "initialView = document.querySelector('nav.tabs a[data-view=\"' + canonicalView + '\"]') ? canonicalView : 'trends';",
    );
    // The URL is rewritten to the canonical id, not the alias.
    expect(DASHBOARD_HTML).toContain("u0.searchParams.set('view', initialView);");
    // A stored last-viewed tab ("ct-active-tab") runs through the SAME alias
    // table — an old "feed" value still resolves to the Trades tab and gets
    // migrated to the canonical "trades" string in place, so links/last-tab
    // state made before the rename keep working.
    expect(DASHBOARD_HTML).toContain('var canonicalSaved = resolveViewId(saved);');
    expect(DASHBOARD_HTML).toContain("if (canonicalSaved !== saved) { try { localStorage.setItem('ct-active-tab', canonicalSaved); } catch (e2) {} }");
  });
});

describe('owner feedback: exchange toggle glyph + legend semantic colors', () => {
  it('renders the resting exchange glyph as a fat ink-colored mask arrow, not var(--exch)', () => {
    expect(DASHBOARD_HTML).toContain('.side-ex {\n    color: var(--text);');
    // The old amber-off-state rule is gone entirely.
    expect(DASHBOARD_HTML).not.toContain('.side-chip .side-ex { color:var(--exch); font-size:12px; }');
    // The pressed/"on" state keeps its existing white-on-amber treatment —
    // var(--exch) is untouched as the pill's pressed fill, only the resting
    // glyph color changed.
    expect(DASHBOARD_HTML).toContain('.side-chip.on[data-side="E"] { background: var(--exch); box-shadow: none; }');
    expect(DASHBOARD_HTML).toContain('.side-chip.on[data-side="E"] .side-ex { color:#fff; }');
  });

  it('gives the combined H/S/P + party + buy/sell/exchange legend real semantic colors instead of a blanket accent blue', () => {
    // The base rule is themed ink (matches the live, neutral-text H/S/P
    // chips) — not var(--accent) link-blue.
    expect(DASHBOARD_HTML).toContain('.branch-pop-row .branch-icon { color:var(--text); font-weight:700; }');
    expect(DASHBOARD_HTML).not.toContain('.branch-pop-row .branch-icon { color:var(--accent); font-weight:700; }');
    // Buy/sell/exchange rows carry the same fixed colors as their live
    // toolbar counterparts: green buy, red sell, themed-ink exchange (same
    // color the ⇄ toggle uses at rest, per the rule above).
    expect(DASHBOARD_HTML).toContain('.branch-pop-row .branch-icon.icon-buy { color:var(--buy); }');
    expect(DASHBOARD_HTML).toContain('.branch-pop-row .branch-icon.icon-sell { color:var(--sell); }');
    expect(DASHBOARD_HTML).toContain(
      '.branch-pop-row .branch-icon.icon-exch { color:var(--text); font-weight:900; -webkit-text-stroke:.4px var(--text); }',
    );
    // No rule anywhere still paints a branch-icon variant with the old
    // blanket accent-blue color.
    expect(DASHBOARD_HTML).not.toMatch(/branch-icon[^{]*\{[^}]*color:var\(--accent\)/);

    expect(DASHBOARD_HTML).toContain('class="side-up"');
    expect(DASHBOARD_HTML).toContain('class="side-dn"');
    expect(DASHBOARD_HTML).toContain('class="side-ex"');
    expect(DASHBOARD_HTML).toContain('Democrats');
    expect(DASHBOARD_HTML).toContain('Republicans');
    expect(DASHBOARD_HTML).toContain('Other / No party');
  });
});

/**
 * Issue #1529 — design convergence: filter-chrome restyle + per-surface feed
 * presentation + header/search convergence. Restyle-only pass on top of LANE
 * A1/A2: verifies the new capsule-pill chrome, icon search fields, mobile
 * trades-card layout, and header hamburger radius, while confirming every
 * DO-NOT-BREAK id/handler/attribute from the spec survives unchanged.
 */
describe('design convergence — filter chrome + card restyle (issue #1529)', () => {
  it('adds the capsule radius + shared control-height tokens without touching --radius', () => {
    expect(DASHBOARD_HTML).toContain('--radius-pill: 999px;');
    expect(DASHBOARD_HTML).toContain('--control-h:   34px;');
    expect(DASHBOARD_HTML).toContain('--radius:    12px;');
  });

  it('layers a capsule radius + bolder solid-fill "on" state on the chip clusters (CSS-only)', () => {
    // The original tinted/inset-ring rule stays untouched (source-order base)...
    expect(DASHBOARD_HTML).toContain(
      '.branch-seg, .party-chips, .side-chips { display:inline-flex; align-items:center; border:1px solid var(--border); border-radius:9px; overflow:hidden; }',
    );
    // ...and a later, more opinionated layer wins the cascade for the pill look.
    expect(DASHBOARD_HTML).toContain('.branch-seg, .party-chips, .side-chips { border-radius: var(--radius-pill); }');
    expect(DASHBOARD_HTML).toContain('.branch-toggle, .party-chip, .side-chip { height: var(--control-h); }');
    expect(DASHBOARD_HTML).toContain('.branch-toggle.on { background: var(--accent); color: #fff; box-shadow: none; }');
    expect(DASHBOARD_HTML).toContain('.party-chip.on[data-party="D"] { background: var(--buy); box-shadow: none; }');
    expect(DASHBOARD_HTML).toContain('.party-chip.on[data-party="R"] { background: var(--sell); box-shadow: none; }');
    expect(DASHBOARD_HTML).toContain('.party-chip.on[data-party="O"] { background: var(--accent); color:#fff; box-shadow: none; }');
    expect(DASHBOARD_HTML).toContain('.side-chip.on[data-side="B"] { background: var(--buy); box-shadow: none; }');
    expect(DASHBOARD_HTML).toContain('.side-chip.on[data-side="S"] { background: var(--sell); box-shadow: none; }');
    expect(DASHBOARD_HTML).toContain('.side-chip.on[data-side="E"] { background: var(--exch); box-shadow: none; }');
  });

  it('keeps every chip data-attribute, aria-pressed, and delegated group id exactly as-is under the restyle', () => {
    const document = parse(DASHBOARD_HTML);
    for (const groupId of ['qChamber', 'qPartyGroup', 'qSideGroup', 'trChamber', 'trPartyGroup', 'trSideGroup']) {
      const group = document.querySelector('#' + groupId);
      expect(group, groupId).not.toBeNull();
      const buttons = [...group!.querySelectorAll('button')].filter(
        (btn) => btn.hasAttribute('data-ch') || btn.hasAttribute('data-party') || btn.hasAttribute('data-side'),
      );
      expect(buttons.length, groupId).toBeGreaterThan(0);
      for (const btn of buttons) {
        expect(btn.getAttribute('aria-pressed'), groupId).toBe('false');
      }
    }
    // Delegated listener wiring (container ids, not per-chip handlers) is untouched.
    expect(DASHBOARD_HTML).toContain('function initChamberChips(');
    expect(DASHBOARD_HTML).toContain('function initPartyChips(');
    expect(DASHBOARD_HTML).toContain('function initSideChips(');
  });

  it('wraps the Timeframe select in an icon+chevron pill without touching id/onchange/options (owner follow-up batch #21 removed the $ Minimum pill entirely)', () => {
    const document = parse(DASHBOARD_HTML);
    for (const [selectId, wrapperClass] of [
      ['tradesGlobalWindow', 'pill-cal'],
      ['trGlobalWindow', 'pill-cal'],
    ] as const) {
      const select = document.querySelector('#' + selectId);
      expect(select, selectId).not.toBeNull();
      expect(select!.tagName.toLowerCase()).toBe('select');
      expect(select!.classList.contains('pill-select-el'), selectId).toBe(true);
      const wrapper = select!.parentNode;
      expect(wrapper?.tagName?.toLowerCase(), selectId).toBe('span');
      expect((wrapper as any).classList.contains('pill-select'), selectId).toBe(true);
      expect((wrapper as any).classList.contains(wrapperClass), selectId).toBe(true);
    }
    // onchange handler + id-based wiring is byte-for-byte unchanged.
    expect(DASHBOARD_HTML).toContain('onchange="onSharedWindowChange(this)"');
    // .tr-window-select / .shared-window stay on the <select> itself (still
    // queried directly by JS) — pill-select-el is additive.
    expect(DASHBOARD_HTML).toContain('class="tr-window-select shared-window pill-select-el"');
    // New pill CSS resolves through the shared tokens, with a dark-mode chevron swap.
    expect(DASHBOARD_HTML).toContain('.pill-select-el {');
    expect(DASHBOARD_HTML).toContain('border-radius:var(--radius-ctl); font:600 13px var(--sans);');
    expect(DASHBOARD_HTML).toContain('html[data-theme="dark"] .pill-select-el {');
  });

  it('uses a single unified trades search field (rounded, no leading icon) with multi-token placeholder', () => {
    const document = parse(DASHBOARD_HTML);
    const search = document.querySelector('#qSearch');
    expect(search).not.toBeNull();
    expect(search!.getAttribute('oninput')).toBe('handleTradesTextFilter()');
    expect(search!.getAttribute('aria-label')).toMatch(/search trades/i);
    expect(search!.classList.contains('icon-input')).toBe(true);
    expect(search!.parentNode?.tagName.toLowerCase()).toBe('span');
    expect((search!.parentNode as any).classList.contains('icon-field')).toBe(true);
    expect((search!.parentNode as any).id).toBe('qSearchField');
    expect(search!.getAttribute('placeholder')).toMatch(/name|ticker|state|party/i);
    // Legacy dual fields remain as hidden aliases for hydration/deep links.
    const legacyMember = document.querySelector('#qMember');
    const legacyTicker = document.querySelector('#qTicker');
    expect(legacyMember?.getAttribute('type')).toBe('hidden');
    expect(legacyTicker?.getAttribute('type')).toBe('hidden');
    // No leading icon glyph span on the field.
    expect(DASHBOARD_HTML).not.toContain('icon-field-ic');
    expect(DASHBOARD_HTML).not.toContain('👤</span>');
    expect(DASHBOARD_HTML).not.toContain('<span class="icon-field-ic"');
    // Header-control radius + room for the CSS magnifier (#qSearchField::before).
    expect(DASHBOARD_HTML).toContain('.icon-input { padding:0 12px 0 32px; border-radius:var(--radius-ctl); height:var(--control-h); box-sizing:border-box; width:100%; font-size:13px; }');
    expect(search!.getAttribute('type')).toBe('search');
  });

  it('enlarges + tile-backs the mobile trades-card logo without touching the desktop table logo size', () => {
    expect(DASHBOARD_HTML).toContain('.trades-card .tkr-logo { width:36px; height:36px; border-radius:9px; }');
    // Desktop/table-wide default logo size (22px) is untouched by this pass.
    expect(DASHBOARD_HTML).toContain('.tkr-logo { flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; overflow: hidden; }');
    expect(DASHBOARD_HTML).toContain(
      'html[data-theme="light"] .trades-card .tkr-logo.transparent,\n  html[data-theme="light"] .trades-card .tkr-logo.mono,\n  html[data-theme="light"] .trades-card .tkr-logo.glyph { background:#fff; }',
    );
  });

  it('restructures tradesCardHtml() into a trailing amount/date stack, dropping the duplicate "Traded" fragment from row 2', () => {
    const start = DASHBOARD_HTML.indexOf('function tradesCardHtml(');
    expect(start).toBeGreaterThan(-1);
    const end = DASHBOARD_HTML.indexOf('\nfunction lagBasisDate(');
    expect(end).toBeGreaterThan(start);
    const fn = DASHBOARD_HTML.slice(start, end);
    // New structure: fc-top (asset + badge + trailing amount/date), fc-trail, fc-date.
    expect(fn).toContain('<div class="fc-top">');
    expect(fn).toContain('<div class="fc-trail">');
    expect(fn).toContain('<div class="fc-date muted">');
    expect(fn).toContain("assetCellHtml(r) + actionBadge(r.type) +");
    expect(fn).toContain("amountCellHtml(r) + '<div class=\"fc-date muted\">' + esc(traded) + '</div></div>'");
    // Row 2 no longer duplicates the trade date as a "Traded <date>" fragment.
    expect(fn).not.toContain("bits.push('Traded '");
    expect(fn).not.toContain("'Traded ' + esc(traded)");
    // iOS politician line + Capitol Ledger owner / relative filed time.
    expect(fn).toContain("ident.push(esc(chamber) + ' · ' + esc(member))");
    expect(fn).toContain("bits.push('<span class=\"fc-owner\">' + esc(owner) + '</span>')");
    expect(fn).toContain('relativeTimeText(');
    expect(fn).toContain("r.stockActStatus === 'late' || r.stockActStatus === 'severely_late'");
    // Click-scoping: the trailing amount/date block carries no data-asset/
    // data-member/data-txid of its own — it falls through to the card's own
    // data-txid via handleTradesOpenEvent's delegation order (DO-NOT-BREAK #4).
    expect(fn).not.toMatch(/fc-trail[^"]*"[^>]*data-(asset|member|txid)/);
  });

  it('keeps .acct-hamburger a >=44x44 capsule tap target but with NO ring/circle at rest (owner punch list #1)', () => {
    // 44x44 (not 38x38) so the tap target stays a11y-sized even when the
    // button renders a smaller (28x28) avatar photo instead of the glyph.
    expect(DASHBOARD_HTML).toContain(
      '.acct-hamburger {\n    width:44px; height:44px; border:none; border-radius: var(--radius-pill);',
    );
    // No border color at all (was var(--border), a blue-tinted gray that read
    // as a stray blue circle) — background stays transparent until hover/open.
    // Owner 2026-09-21 punch list: color is now --icon-grey (medium grey,
    // ~30% lighter than --text), and font-size dropped from 18px → 15px
    // (15% smaller). The 3 bars inside are drawn by .acct-hamburger-bars.
    expect(DASHBOARD_HTML).toContain('background:transparent; color:var(--icon-grey); font-size:15px; line-height:1;');
    expect(DASHBOARD_HTML).toContain('.acct-hamburger-bars { display:inline-flex; flex-direction:column;');
    expect(DASHBOARD_HTML).toContain(
      '.acct-hamburger:hover, .acct-hamburger[aria-expanded="true"] { background:var(--panel-2); color:var(--accent); }',
    );
    // Sibling circular controls it used to match stay untouched.
    expect(DASHBOARD_HTML).toContain('.branch-info { width:24px; height:24px; border-radius:999px;');
    expect(DASHBOARD_HTML).toContain(
      'margin:-8px -8px -8px 0; border-radius:999px; border:1px solid transparent;\n    background:transparent; color:var(--text-dim); cursor:pointer; font-size:20px; line-height:1;',
    );
  });

  it('keeps the filtered trade count on the pager only (not next to search)', () => {
    expect(DASHBOARD_HTML).toContain('data-trades-count');
    expect(DASHBOARD_HTML).toContain('id="tradesCountMsgTop"');
    expect(DASHBOARD_HTML).not.toContain('id="tradesStats"');
    expect(DASHBOARD_HTML).not.toContain('id="kpiTotal"');
    expect(DASHBOARD_HTML).toContain('#tradesExtraFilters { display: grid;');

    // #1551 verifier fix-forwards: no reserved right gutter on table wraps,
    // and the slowest-filers table must not clip (sticky header pinning).
    expect(DASHBOARD_HTML).not.toMatch(/\.table-wrap \{[^}]*padding-right: 60px/);
    expect(DASHBOARD_HTML).toMatch(/\.late-filers-wrap table \{[^}]*overflow: visible/);
    const document = parse(DASHBOARD_HTML);
    expect(document.querySelector('#tradesStats')).toBeNull();
    expect(document.querySelector('#kpiTotal')).toBeNull();
    expect(document.querySelector('#tradesCountMsgTop')).not.toBeNull();
  });

  it('keeps the ≤768px hamburger-swap and ≤768px table/card-swap breakpoints distinct', () => {
    expect(DASHBOARD_HTML).toContain('@media (max-width: 768px), (hover: none) and (pointer: coarse)');
    expect(DASHBOARD_HTML).toContain('.acct-desktop { display: none; }');
    expect(DASHBOARD_HTML).toContain('.acct-mobile { display: inline-flex; }');
    expect(DASHBOARD_HTML).toContain('@media (max-width: 768px), (orientation: landscape) and (max-width: 950px) and (max-height: 520px), (hover: none) and (pointer: coarse)');
    expect(DASHBOARD_HTML).toContain('#view-trades .table-wrap { display: none; }');
    expect(DASHBOARD_HTML).toContain('#view-trades .trades-cards { display: grid; grid-template-columns: minmax(0, 1fr); }');
  });
});

/**
 * LANE A2 of the owner UX work order — continues LANE A1 on the same branch
 * (monet/web-ux-workorder). Covers:
 *   1. Filing Latency Comparison placement rules + the isLatencyAhead() gate.
 *   2. Entity click-through coverage (verifying PR #1517's delegation reaches
 *      every surface the owner named, incl. drill-in from inside drawers).
 *   3. The member-drawer "Performance vs S&P" horizon phrase (#1458 note).
 */
describe('owner UX work order (LANE A2 — latency placement + entity click-through)', () => {
  function extractFn(html: string, name: string): string {
    const marker = 'function ' + name + '(';
    const start = html.indexOf(marker);
    if (start < 0) throw new Error('function not found in DASHBOARD_HTML: ' + name);
    const braceStart = html.indexOf('{', start);
    let depth = 0;
    let i = braceStart;
    for (; i < html.length; i++) {
      if (html[i] === '{') depth++;
      else if (html[i] === '}') {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      }
    }
    return html.slice(start, i);
  }
  function extractVarDecl(html: string, name: string): string {
    const re = new RegExp('var ' + name + ' = [\\s\\S]*?;');
    const m = re.exec(html);
    if (!m) throw new Error('var not found in DASHBOARD_HTML: ' + name);
    return m[0];
  }

  type ProviderFixture = Record<string, unknown>;
  type LatencySummary = { providers: ProviderFixture[] } | null;

  function loadIsLatencyAhead(): (summary: LatencySummary) => boolean {
    const src = [
      extractVarDecl(DASHBOARD_HTML, 'SPEED_LANE_MIN_MATCHED'),
      extractFn(DASHBOARD_HTML, 'leadDirection'),
      extractFn(DASHBOARD_HTML, 'leadVerdict'),
      extractFn(DASHBOARD_HTML, 'isLatencyComparisonPublic'),
      extractFn(DASHBOARD_HTML, 'isLatencyAhead'),
      'return isLatencyAhead;',
    ].join('\n');
    // eslint-disable-next-line no-new-func -- executing the real shipped source
    return new Function(src)() as (summary: LatencySummary) => boolean;
  }

  function provider(overrides: ProviderFixture): ProviderFixture {
    return {
      label: 'Provider',
      matched: 10,
      usFirstCount: 0,
      providerFirstCount: 0,
      tieCount: 0,
      avgLeadSec: 120,
      medianLeadSec: 100,
      comparisonStatus: 'usable',
      operationalStatus: 'running',
      ...overrides,
    };
  }

  describe('isLatencyAhead() gating helper', () => {
    const isLatencyAhead = loadIsLatencyAhead();

    it('is true when one adequately-covered provider leads and none are behind', () => {
      const summary = {
        providers: [
          provider({ label: 'A', usFirstCount: 8, providerFirstCount: 2 }),
          provider({ label: 'B', comparisonStatus: 'preliminary', matched: 0, avgLeadSec: null, medianLeadSec: null }),
        ],
      };
      expect(isLatencyAhead(summary)).toBe(true);
    });

    it('is true when one adequate provider leads and another lags (not a majority behind)', () => {
      const summary = {
        providers: [
          provider({ label: 'A', usFirstCount: 8, providerFirstCount: 2 }),
          provider({
            label: 'B',
            usFirstCount: 1,
            providerFirstCount: 9,
            medianLeadSec: -3600,
            avgLeadSec: -1800,
          }),
        ],
      };
      expect(isLatencyAhead(summary)).toBe(true);
    });

    it('is false when we are behind on most adequately-covered providers', () => {
      const summary = {
        providers: [
          provider({ label: 'A', usFirstCount: 8, providerFirstCount: 2 }),
          provider({
            label: 'B',
            usFirstCount: 1,
            providerFirstCount: 9,
            medianLeadSec: -3600,
            avgLeadSec: -1800,
          }),
          provider({
            label: 'C',
            usFirstCount: 2,
            providerFirstCount: 8,
            medianLeadSec: -7200,
            avgLeadSec: -5400,
          }),
        ],
      };
      expect(isLatencyAhead(summary)).toBe(false);
    });

    it('does not claim ahead when median and average disagree', () => {
      const summary = {
        providers: [
          provider({
            label: 'UW',
            usFirstCount: 7,
            providerFirstCount: 1,
            medianLeadSec: 1466,
            avgLeadSec: -34,
          }),
        ],
      };
      expect(isLatencyAhead(summary)).toBe(false);
    });

    it('is false when every provider is still gathering data (too few matched races)', () => {
      const summary = {
        providers: [
          provider({ label: 'A', matched: 1, usFirstCount: 1, providerFirstCount: 0 }),
          provider({ label: 'B', matched: 0, avgLeadSec: null, medianLeadSec: null, usFirstCount: 0, providerFirstCount: 0 }),
        ],
      };
      expect(isLatencyAhead(summary)).toBe(false);
    });

    it('ignores preliminary/limited-coverage providers — they neither qualify nor block', () => {
      const summary = {
        providers: [
          provider({ label: 'A', usFirstCount: 8, providerFirstCount: 2 }),
          // Behind on raw counts, but comparisonStatus is only 'preliminary' —
          // not adequate coverage, so it must not veto the definitive lead.
          provider({ label: 'B', usFirstCount: 1, providerFirstCount: 9, comparisonStatus: 'preliminary' }),
        ],
      };
      expect(isLatencyAhead(summary)).toBe(true);
    });

    it('ignores intentionally-off providers entirely', () => {
      const summary = {
        providers: [
          provider({ label: 'A', usFirstCount: 8, providerFirstCount: 2 }),
          provider({ label: 'B', operationalStatus: 'off' }),
        ],
      };
      expect(isLatencyAhead(summary)).toBe(true);
    });

    it('ignores error and stopped providers so a dead probe cannot vote', () => {
      const summary = {
        providers: [
          provider({ label: 'A', usFirstCount: 8, providerFirstCount: 2 }),
          provider({
            label: 'Quiver',
            operationalStatus: 'error',
            usFirstCount: 1,
            providerFirstCount: 9,
            medianLeadSec: -3600,
            avgLeadSec: -1800,
          }),
          provider({
            label: 'UW',
            operationalStatus: 'stopped',
            usFirstCount: 2,
            providerFirstCount: 8,
            medianLeadSec: -7200,
            avgLeadSec: -5400,
          }),
        ],
      };
      expect(isLatencyAhead(summary)).toBe(true);
    });

    it('is false on a tie (no provider strictly ahead)', () => {
      const summary = {
        providers: [provider({
          label: 'A',
          usFirstCount: 5,
          providerFirstCount: 5,
          medianLeadSec: 0,
          avgLeadSec: 0,
        })],
      };
      expect(isLatencyAhead(summary)).toBe(false);
    });

    it('is false with no providers or a missing summary', () => {
      expect(isLatencyAhead({ providers: [] })).toBe(false);
      expect(isLatencyAhead(null)).toBe(false);
    });
  });

  describe('Filing Latency Comparison section placement', () => {
    it('never renders inside the Trades/feed tab', () => {
      const feedView = DASHBOARD_HTML.match(/<section class="view" id="view-trades"[\s\S]*?\n  <section class="view/);
      expect(feedView).not.toBeNull();
      expect(feedView![0]).not.toContain('trLatencySection');
      expect(feedView![0]).not.toContain('adminLatencySection');
    });

    it('renders a gated link at the BOTTOM of the Trends view', () => {
      const trendsView = DASHBOARD_HTML.match(/<section class="view active" id="view-trends"[\s\S]*?\n  <\/section>/);
      expect(trendsView).not.toBeNull();
      expect(trendsView![0]).toContain('id="trLatencyLink"');
      expect(trendsView![0]).not.toContain('id="trLatencySection"');
      expect(trendsView![0]).not.toContain('id="adminLatencySection"');
      const idx = trendsView![0].indexOf('id="trLatencyLink"');
      const rest = trendsView![0].slice(idx);
      expect(rest.trim().endsWith('</section>')).toBe(true);
    });

    it('renders the public scoreboard at the BOTTOM of the Delivery view', () => {
      const subsView = DASHBOARD_HTML.match(/<section class="view" id="view-subs"[\s\S]*?\n  <\/section>/);
      expect(subsView).not.toBeNull();
      expect(subsView![0]).toContain('id="trLatencySection"');
      expect(subsView![0]).not.toContain('id="adminLatencySection"');
      const idx = subsView![0].indexOf('id="trLatencySection"');
      const rest = subsView![0].slice(idx);
      expect(rest.trim().endsWith('</section>')).toBe(true);
    });

    it('renders one full copy (including BEHIND) at the TOP of the Admin view, unconditionally', () => {
      const adminView = DASHBOARD_HTML.match(/<section class="view" id="view-admin"[\s\S]*?\n  <\/section>/);
      expect(adminView).not.toBeNull();
      expect(adminView![0]).toContain('id="adminLatencySection"');
      expect(adminView![0]).not.toContain('id="trLatencySection"');
      // It's the first thing inside the view — appears before the "Admin
      // Access" panel that used to open the tab.
      const latencyIdx = adminView![0].indexOf('id="adminLatencySection"');
      const accessIdx = adminView![0].indexOf('Admin Access');
      expect(latencyIdx).toBeGreaterThan(-1);
      expect(accessIdx).toBeGreaterThan(-1);
      expect(latencyIdx).toBeLessThan(accessIdx);
    });

    it('paints the Admin copy unconditionally and gates Delivery + the Trends link on isLatencyAhead()', () => {
      expect(DASHBOARD_HTML).toContain('function renderSpeedProof() {');
      expect(DASHBOARD_HTML).toContain("var publicBox = el('trLatencySection');");
      expect(DASHBOARD_HTML).toContain("var publicLink = el('trLatencyLink');");
      expect(DASHBOARD_HTML).toContain("var adminBox = el('adminLatencySection');");
      expect(DASHBOARD_HTML).toContain('adminBox.hidden = !hasAdminData;');
      expect(DASHBOARD_HTML).toContain('var ahead = hasPublicData && isLatencyAhead({ providers: publicProvs });');
      expect(DASHBOARD_HTML).toContain('publicBox.hidden = !ahead;');
      expect(DASHBOARD_HTML).toContain('publicLink.hidden = !ahead;');
      // Admin kicks off the fetch/paint itself as soon as the tab opens (both
      // the click handler and the boot-time restore-saved-tab path) instead
      // of relying only on the Trends-tab intersection observer.
      expect(DASHBOARD_HTML).toContain(
        "if (b.dataset.view === 'admin') { loadAdminList(); loadLogoSetting(); loadPollConfig(); loadHealth(); loadInstrumentPricing(); loadMarketCoverage(); loadDiagnostics(); loadBenchmarkHistory(); renderSpeedProof(); loadLlmSpendPanel(); loadExtractionIncident(); }",
      );
      expect(DASHBOARD_HTML).toContain(
        "if (initialView === 'admin') { loadAdminList(); loadLogoSetting(); loadHealth(); loadInstrumentPricing(); loadMarketCoverage(); loadDiagnostics(); loadBenchmarkHistory(); renderSpeedProof(); loadLlmSpendPanel(); loadExtractionIncident(); }",
      );
    });
  });

    describe('owner web UX trades chrome (2026-08-10)', () => {
    it('groups Sign In + Upgrade in one acct-auth-group control', () => {
      expect(DASHBOARD_HTML).toContain('class="acct-auth-group"');
      expect(DASHBOARD_HTML).toContain('.acct-auth-group {');
      expect(DASHBOARD_HTML).toContain("var authGroup = '<span class=\"acct-auth-group\">'");
    });

    it('shows filtered matching trades count on the pager (not page size)', () => {
      expect(DASHBOARD_HTML).toContain('data-trades-count');
      expect(DASHBOARD_HTML).toContain("var total = typeof totalRows === 'number' ? totalRows : (shown || 0);");
      expect(DASHBOARD_HTML).not.toContain("el('kpiTotal').textContent = fmtCount(totalRows || TRADES.length);");
    });

    it('opens trade details from the whole feed row/card (no nested feed data-member/data-asset)', () => {
      expect(DASHBOARD_HTML).toContain("var feedHit = e.target.closest('#tradesBody tr[data-txid]");
      expect(DASHBOARD_HTML).toContain("openTradeById(feedHit.getAttribute('data-txid'));");
      // Feed cell helpers no longer emit nested entity targets.
      expect(DASHBOARD_HTML).toContain('/* Feed cells are NOT nested entity links');
      expect(DASHBOARD_HTML).toContain('return \'<div class="member-cell">\' + memberAvatarHtml(r.member, r.photoUrl, r.party || r.partyBucket, true) +');
      expect(DASHBOARD_HTML).toContain('// No data-asset on the feed cell');
      expect(DASHBOARD_HTML).toContain('Politician Details');
      expect(DASHBOARD_HTML).toContain('Company Details');
      expect(DASHBOARD_HTML).toContain('drawer-entity-actions');
    });
  });

describe('entity click-through coverage (verifying PR #1517 reaches every named surface)', () => {
    it('keeps the shared handleEntityOpenEvent delegation wired to member/asset/ticker/trade ids', () => {
      expect(DASHBOARD_HTML).toContain('function handleEntityOpenEvent(e)');
      expect(DASHBOARD_HTML).toContain("openMember(m.getAttribute('data-member'));");
      expect(DASHBOARD_HTML).toContain("openAsset(a.getAttribute('data-asset'));");
      expect(DASHBOARD_HTML).toContain("openTradeById(row.getAttribute('data-txid'));");
    });

    it('makes every Trends leaderboard/list row entity-clickable', () => {
      // What Is Being Traded (loadTrTickers -> #trTickers) and Rising
      // Activity (loadTrTrending -> #trTrending) share this row template.
      expect(DASHBOARD_HTML).toContain(
        'return \'<tr class="row clickable" data-asset="\' + esc(r.ticker) + \'" title="Open company">\' +',
      );
      // Top Performers (loadTrPerformers -> #trPerformers) and Most Active
      // Politicians / member-leaderboard (loadTrMembers -> #trMembers).
      expect(DASHBOARD_HTML).toContain(
        'var memberAttr = r.filerId ? \' class="member-cell clickable" data-member="\' + esc(r.filerId) + \'"\' : \' class="member-cell"\';',
      );
      expect(DASHBOARD_HTML).toContain("aGet('member-leaderboard?'");
      expect(DASHBOARD_HTML).toContain("aGet('member-performance?'");
      // Consensus Moves / cluster-buys (loadTrClusters -> #trClusters): card
      // opens the company drawer, member faces open the politician drawer.
      expect(DASHBOARD_HTML).toContain(
        '<div class="ccard clickable" tabindex="0" role="button" aria-label="View company \' + esc(c.ticker) + \'" data-asset="\' + esc(c.ticker) + \'">\'',
      );
      expect(DASHBOARD_HTML).toContain(
        'return \'<span class="clickable face-member" data-member="\' + esc(m.filerId) +',
      );
      // Committee Sector Conflicts (loadTrConflicts -> #trConflicts).
      expect(DASHBOARD_HTML).toContain("aGet('conflicts?'");
    });

    it('keeps the People directory rows entity-clickable via data-member', () => {
      expect(DASHBOARD_HTML).toContain('function renderPeopleDirectory(all)');
      expect(DASHBOARD_HTML).toContain(
        "return '<tr class=\"row\" ' + (m.filerId ? 'data-member=\"' + esc(m.filerId) + '\"' : '') + '>' +",
      );
      expect(DASHBOARD_HTML).toContain('data-member="' + "' + esc(m.filerId) + '" + '"');
    });

    it('keeps member-drawer rows (Most-Traded -> ticker drawer, Recent Trades -> trade view) entity-clickable', () => {
      expect(DASHBOARD_HTML).toContain('function openMember(filerId)');
      // Most-Traded rows open the ticker/asset drawer.
      expect(DASHBOARD_HTML).toContain(
        'return \'<div class="hbar ledger" style="margin:5px 0"><div class="hlabel clickable" data-asset="\' + esc(t.ticker) + \'">\' +',
      );
      // Recent Trades rows open the trade view; the ticker chip inside each
      // row is itself a second, nested entity link to the asset drawer.
      // rowOpenBtnHtml(...) (WEBA11Y P2 follow-up) supplies the real, named
      // control this row needs — see the dedicated "row-open-btn" describe
      // block below.
      expect(DASHBOARD_HTML).toContain(
        'return \'<tr class="row clickable" data-txid="\' + esc(tradeRow.id) + \'" title="Open trade details"><td class="muted">\' + rowOpenBtnHtml(\'data-txid\', tradeRow.id, \'Open trade details\') + miniTradeDateOnlyHtml(t) + \'</td>\' +',
      );
      expect(DASHBOARD_HTML).toContain(
        '? \'<span class="tkr clickable" data-asset="\' + esc(t.ticker) + \'">\' + esc(t.ticker) + \'</span>\'',
      );
    });

    it('keeps asset-drawer Recent Trades and Top Buyers/Sellers entity-clickable', () => {
      expect(DASHBOARD_HTML).toContain('function openAsset(ticker)');
      expect(DASHBOARD_HTML).toContain(
        'return \'<tr class="row clickable" data-txid="\' + esc(tradeRow.id) + \'" title="Open trade details"><td class="muted">\' + rowOpenBtnHtml(\'data-txid\', tradeRow.id, \'Open trade details\') + miniTradeDateHtml(t) + \'</td>\' +',
      );
      expect(DASHBOARD_HTML).toContain("var memberAttr = m.filerId ? ' data-member=\"' + esc(m.filerId) + '\"' : '';");
    });
  });

  describe('entity click-through: keyboard reachability (Tab + Enter/Space)', () => {
    // Many entity-open render sites (Trends leaderboards, member/asset
    // drawers, People directory rows) build .clickable[data-*] elements
    // without ever setting tabindex/role by hand, so they'd otherwise be
    // unreachable via Tab even though the click delegation works. A single
    // MutationObserver-backed pass (makeEntityTargetsFocusable) tags every
    // such element with tabindex="0" + role="button" as soon as it lands in
    // the DOM, instead of patching tabindex/role into every call site.
    type FakeNode = {
      tagName: string;
      nodeType: 1;
      _attrs: Record<string, string>;
      hasAttribute: (name: string) => boolean;
      setAttribute: (name: string, value: string) => void;
      getAttribute: (name: string) => string | undefined;
      querySelector: (sel: string) => unknown;
    };
    // innerMatches lists selectors this node's querySelector() should find a
    // (stub) descendant for — used by the "already has its own row-open-btn"
    // test below; every other call site leaves it empty (querySelector always
    // returns null, matching a real element with no such descendant).
    function fakeNode(tagName: string, attrs: Record<string, string> = {}, innerMatches: string[] = []): FakeNode {
      const a = { ...attrs };
      return {
        tagName,
        nodeType: 1,
        _attrs: a,
        hasAttribute: (name) => Object.prototype.hasOwnProperty.call(a, name),
        setAttribute: (name, value) => {
          a[name] = value;
        },
        getAttribute: (name) => a[name],
        querySelector: (sel) => (innerMatches.includes(sel) ? {} : null),
      };
    }
    function fakeRoot(children: FakeNode[], selfMatches = false) {
      return {
        nodeType: 1 as const,
        tagName: 'DIV',
        matches: () => selfMatches,
        querySelectorAll: () => children,
      };
    }

    function loadMakeEntityTargetsFocusable(): (root: unknown) => void {
      const src = [
        extractVarDecl(DASHBOARD_HTML, 'ENTITY_FOCUSABLE_SELECTOR'),
        extractFn(DASHBOARD_HTML, 'makeEntityTargetsFocusable'),
        'return makeEntityTargetsFocusable;',
      ].join('\n');
      // eslint-disable-next-line no-new-func -- executing the real shipped source
      return new Function(src)() as (root: unknown) => void;
    }

    it('wires the MutationObserver pass into the same IIFE as the click/keydown delegation', () => {
      expect(DASHBOARD_HTML).toContain(
        "var ENTITY_FOCUSABLE_SELECTOR = '.clickable[data-member], .clickable[data-asset], .clickable[data-ticker], .clickable[data-txid]';",
      );
      expect(DASHBOARD_HTML).toContain('function makeEntityTargetsFocusable(root)');
      expect(DASHBOARD_HTML).toContain('makeEntityTargetsFocusable(document.body);');
      expect(DASHBOARD_HTML).toContain("if ('MutationObserver' in window) {");
      expect(DASHBOARD_HTML).toContain('.observe(document.body, { childList: true, subtree: true });');
      // A generic focus-visible ring backs every element this pass tags,
      // since most call sites never had bespoke focus CSS to begin with.
      expect(DASHBOARD_HTML).toContain(
        '.clickable:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }',
      );
    });

    it('tags a member-cell div with tabindex=0 and role=button', () => {
      const makeEntityTargetsFocusable = loadMakeEntityTargetsFocusable();
      const node = fakeNode('DIV', { class: 'member-cell clickable', 'data-member': 'P000197' });
      makeEntityTargetsFocusable(fakeRoot([node]));
      expect(node.getAttribute('tabindex')).toBe('0');
      expect(node.getAttribute('role')).toBe('button');
    });

    it('does not clobber an existing tabindex/role (e.g. trades-card, ccard already ship their own)', () => {
      const makeEntityTargetsFocusable = loadMakeEntityTargetsFocusable();
      const node = fakeNode('ARTICLE', {
        class: 'trades-card clickable',
        'data-txid': 'abc',
        tabindex: '0',
        role: 'button',
      });
      makeEntityTargetsFocusable(fakeRoot([node]));
      expect(node.getAttribute('tabindex')).toBe('0');
      expect(node.getAttribute('role')).toBe('button');
    });

    it('leaves native <a>/<button> entity targets alone (already focusable, own semantics)', () => {
      const makeEntityTargetsFocusable = loadMakeEntityTargetsFocusable();
      const link = fakeNode('A', { class: 'clickable', 'data-asset': 'AAPL', href: '#' });
      makeEntityTargetsFocusable(fakeRoot([link]));
      expect(link.hasAttribute('tabindex')).toBe(false);
      expect(link.hasAttribute('role')).toBe(false);
    });

    it('keeps native row/columnheader/cell roles on TR/TH/TD entity targets (WEBA11Y-01)', () => {
      const makeEntityTargetsFocusable = loadMakeEntityTargetsFocusable();
      const row = fakeNode('TR', { class: 'row clickable', 'data-txid': 'abc' });
      const th = fakeNode('TH', { class: 'clickable', 'data-asset': 'AAPL' });
      const td = fakeNode('TD', { class: 'asset-cell clickable', 'data-asset': 'AAPL' });
      makeEntityTargetsFocusable(fakeRoot([row, th, td]));
      // Still Tab-focusable...
      expect(row.getAttribute('tabindex')).toBe('0');
      expect(th.getAttribute('tabindex')).toBe('0');
      expect(td.getAttribute('tabindex')).toBe('0');
      // ...but role="button" is never applied: overriding it would destroy
      // the native row/columnheader/cell semantics screen readers rely on
      // for table navigation and make aria-sort invalid ARIA.
      expect(row.hasAttribute('role')).toBe(false);
      expect(th.hasAttribute('role')).toBe(false);
      expect(td.hasAttribute('role')).toBe(false);
    });

    it('does not add a redundant tabindex to a <tr> that already carries its own row-open-btn control (WEBA11Y P2 follow-up)', () => {
      // Rows rendered by renderTrades() / the drawer mini-trade tables now
      // insert a real, named <button class="row-open-btn"> (rowOpenBtnHtml())
      // into their first cell.  That button is the thing that should be
      // Tab-focusable; the <tr> itself doesn't need a second, semantically-
      // empty tab stop for the identical "open this row" action.
      const makeEntityTargetsFocusable = loadMakeEntityTargetsFocusable();
      const rowWithControl = fakeNode('TR', { class: 'row clickable', 'data-txid': 'abc' }, ['.row-open-btn']);
      makeEntityTargetsFocusable(fakeRoot([rowWithControl]));
      expect(rowWithControl.hasAttribute('tabindex')).toBe(false);
      expect(rowWithControl.hasAttribute('role')).toBe(false);
      // A row with no such control (the ticker-leaderboard/trending shape,
      // whose inner .asset-cell.clickable[data-asset] div is the control
      // instead) keeps the old fallback tabindex behavior asserted above.
    });

    it('also tags the root node itself when it matches (MutationObserver addedNodes case)', () => {
      const makeEntityTargetsFocusable = loadMakeEntityTargetsFocusable();
      const node = fakeNode('DIV', { class: 'clickable', 'data-txid': 'xyz' });
      // A MutationObserver addedNodes entry IS the element itself, not a
      // container to search inside — exercise the root.matches() branch.
      const rootAsNode = { ...node, querySelectorAll: () => [], matches: () => true };
      makeEntityTargetsFocusable(rootAsNode);
      expect(rootAsNode.getAttribute('tabindex')).toBe('0');
      expect(rootAsNode.getAttribute('role')).toBe('button');
    });
  });

  describe('member-drawer "Performance vs S&P" horizon phrase (#1458 note)', () => {
    it('names the window instead of the vague "in window" once the endpoint has returned one', () => {
      expect(DASHBOARD_HTML).not.toContain('disclosed buys in window');
      expect(DASHBOARD_HTML).toContain("var horizonPhrase = d.window ? ' (' + esc(windowLabel(d.window)) + ')' : '';");
      expect(DASHBOARD_HTML).toContain("fmtCount(buyCount) + ' disclosed buys' + horizonPhrase");
    });

    it('labels each skill leg as a variable hold and splits excess from asset return (#1460)', () => {
      expect(DASHBOARD_HTML).toContain(
        'Variable hold — each buy from the trade date through the latest price.',
      );
      expect(DASHBOARD_HTML).toContain(
        'Variable hold — each buy from the public filing date through the latest price.',
      );
      expect(DASHBOARD_HTML).toContain('Avg excess is versus the index');
      expect(DASHBOARD_HTML).toContain('Avg asset return');
    });
  });

  describe('directory photos, filer owner, delivery delete (#1460 / #1429 leftovers)', () => {
    it('renders People directory names with the same avatar helper as the feed', () => {
      expect(DASHBOARD_HTML).toContain('function renderPeopleDirectory(all)');
      expect(DASHBOARD_HTML).toContain("memberAvatarHtml(name, m.photoUrl, m.party, true)");
    });

    it('shows the beneficial owner on feed rows and mobile cards', () => {
      expect(DASHBOARD_HTML).toContain('function ownerBadgeHtml(o)');
      expect(DASHBOARD_HTML).toContain('ownerBadgeHtml(r.owner)');
      expect(DASHBOARD_HTML).toContain("bits.push('<span class=\"fc-owner\">' + esc(owner) + '</span>')");
    });

    it('replaces the politician-drawer Not recorded committee fallback', () => {
      expect(DASHBOARD_HTML).not.toContain("? '<span class=\"muted\">Not recorded</span>'");
      expect(DASHBOARD_HTML).toContain('No current assignments on file.');
      expect(DASHBOARD_HTML).toContain('Executive filers do not sit on congressional committees.');
    });

    it('uses a second-click Confirm? for web delivery delete', () => {
      expect(DASHBOARD_HTML).toContain('var PENDING_SUB_DELETE');
      expect(DASHBOARD_HTML).toContain("delBtn.textContent = 'Confirm?';");
      expect(DASHBOARD_HTML).not.toContain("window.confirm('Delete this delivery permanently?");
    });
  });
});

/**
 * Issue #1040 — binary brand/icon/font assets live under app/public/ and are
 * served by ui/routes.ts. assets.ts must stay a thin loader (no multi-MB base64).
 */
describe('static UI assets (issue #1040)', () => {
  it('keeps assets.ts free of embedded base64 blobs', () => {
    const source = readFileSync(new URL('../assets.ts', import.meta.url) as any, 'utf8') as string;
    expect(source.length).toBeLessThan(8_000);
    expect(source).not.toMatch(/iVBORw0KGgo/); // PNG magic in base64
    expect(source).not.toMatch(/const\s+\w+_B64\s*=/);
    expect(source).toContain('readFileSync');
    expect(source).toContain('../../public');
  });

  it('loads binary files from app/public and serves them with cache headers', async () => {
    const {
      ICON_192_PNG,
      BRAND_LOGO_LIGHT_PNG,
      ZILLA_SLAB_WOFF2,
      INTER_400_WOFF2,
      FAVICON_PNG,
    } = await import('../assets.ts');

    expect(ICON_192_PNG.bytes.byteLength).toBeGreaterThan(1_000);
    expect(ICON_192_PNG.contentType).toBe('image/png');
    expect(BRAND_LOGO_LIGHT_PNG.bytes.byteLength).toBeGreaterThan(1_000);
    expect(ZILLA_SLAB_WOFF2.contentType).toBe('font/woff2');
    expect(ZILLA_SLAB_WOFF2.bytes.byteLength).toBeGreaterThan(1_000);
    expect(INTER_400_WOFF2.contentType).toBe('font/woff2');
    expect(INTER_400_WOFF2.bytes.byteLength).toBeGreaterThan(1_000);
    expect(FAVICON_PNG.bytes.byteLength).toBeGreaterThan(100);

    // PNG signature
    expect(Array.from(ICON_192_PNG.bytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    // wOFF magic
    expect(String.fromCharCode(...ZILLA_SLAB_WOFF2.bytes.slice(0, 4))).toBe('wOF2');
    expect(String.fromCharCode(...INTER_400_WOFF2.bytes.slice(0, 4))).toBe('wOF2');

    const { buildUiRouter } = await import('../routes.ts');
    const app = buildUiRouter();

    const cases: Array<{ path: string; typePrefix: string; minBytes: number; cache: string }> = [
      { path: '/icon-192.png', typePrefix: 'image/png', minBytes: 1_000, cache: 'public, max-age=86400' },
      { path: '/favicon.ico', typePrefix: 'image/png', minBytes: 100, cache: 'public, max-age=86400' },
      { path: '/swu-logo-wide.webp', typePrefix: 'image/webp', minBytes: 10_000, cache: 'public, max-age=86400' },
      { path: '/assets/brand-logo-light.png', typePrefix: 'image/png', minBytes: 1_000, cache: 'immutable' },
      { path: '/assets/zilla-slab-700.woff2', typePrefix: 'font/woff2', minBytes: 1_000, cache: 'immutable' },
      { path: '/assets/inter-400.woff2', typePrefix: 'font/woff2', minBytes: 1_000, cache: 'immutable' },
      { path: '/assets/inter-500.woff2', typePrefix: 'font/woff2', minBytes: 1_000, cache: 'immutable' },
      { path: '/assets/inter-600.woff2', typePrefix: 'font/woff2', minBytes: 1_000, cache: 'immutable' },
      { path: '/assets/inter-700.woff2', typePrefix: 'font/woff2', minBytes: 1_000, cache: 'immutable' },
      { path: '/assets/inter-800.woff2', typePrefix: 'font/woff2', minBytes: 1_000, cache: 'immutable' },
      { path: '/og-image.png', typePrefix: 'image/png', minBytes: 1_000, cache: 'public, max-age=86400' },
      { path: '/og-image-trends.png', typePrefix: 'image/png', minBytes: 1_000, cache: 'public, max-age=86400' },
      { path: '/og-image-company.png', typePrefix: 'image/png', minBytes: 1_000, cache: 'public, max-age=86400' },
      { path: '/og-image-politician.png', typePrefix: 'image/png', minBytes: 1_000, cache: 'public, max-age=86400' },
      { path: '/apple-touch-icon.png', typePrefix: 'image/png', minBytes: 1_000, cache: 'public, max-age=86400' },
    ];

    for (const c of cases) {
      const res = await app.request(`http://localhost${c.path}`, {}, { } as never);
      expect(res.status, c.path).toBe(200);
      expect(res.headers.get('content-type') ?? '', c.path).toContain(c.typePrefix);
      expect(res.headers.get('cache-control') ?? '', c.path).toContain(c.cache);
      const buf = new Uint8Array(await res.arrayBuffer());
      expect(buf.byteLength, c.path).toBeGreaterThan(c.minBytes);
    }
  });
});

/**
 * Owner punch list — LANE W1 (web chrome/header/menu/filters/search/footer/
 * cards). Numbered `it()` names below map 1:1 to the PR checklist items.
 */
describe('MONET web punch list 2 (LANE W1)', () => {
  it('#1 removes the hamburger ring entirely (no border at rest, soft hover/open background only)', () => {
    expect(DASHBOARD_HTML).not.toMatch(/\.acct-hamburger\s*\{[^}]*border:1px solid var\(--border\)/);
    expect(DASHBOARD_HTML).toContain('border:none; border-radius: var(--radius-pill);');
    expect(DASHBOARD_HTML).toContain('display:flex; align-items:center; justify-content:center; cursor:pointer; padding:0;');
  });

  it('#2 gives the hamburger popover row breathing room, drops the "Theme" label there, and spaces/de-rings the avatar', () => {
    // More vertical gap between rows (was 4px).
    expect(DASHBOARD_HTML).toContain('.acct-mobile-menu.open { display:grid; gap:10px; }');
    // themeRowHtml() gained an opt-in hideLabel param; only the two mobile
    // call sites pass true — the desktop menu-pop dropdown is untouched.
    expect(DASHBOARD_HTML).toContain(
      "function themeRowHtml(pref, hideLabel) {\n  // Owner punch list #2 (hamburger popover): the Light/Dark/System control\n  // stands alone there — no \"Theme\" caption. The desktop menu-pop dropdown\n  // keeps the label (unchanged), so hideLabel is opt-in per call site.\n  return '<div class=\"theme-row\">' + (hideLabel ? '' : '<span class=\"theme-row-label\">Theme</span>') + themeSegHtml(pref) + '</div>';\n}",
    );
    const mobileCalls = DASHBOARD_HTML.match(/themeRowHtml\(null, true\)/g) || [];
    expect(mobileCalls.length).toBe(2); // signed-out mobile + signed-in mobile
    // Desktop dropdown still calls the bare form (keeps its "Theme" label).
    expect(DASHBOARD_HTML).toContain('themeRowHtml() +');
    expect(DASHBOARD_HTML).toContain('function adminMenuHtml(closeCall)');
    // ~8px gap between the Google avatar photo and the email text (mobile
    // "who" row only — desktop .menu-pop .who is text-only and untouched).
    expect(DASHBOARD_HTML).toContain('.acct-mobile-menu .who { display:flex; align-items:center; gap:8px;');
    expect(DASHBOARD_HTML).not.toContain('.menu-pop .who { padding:6px 10px 8px; font-size:12px; color:var(--text-dim); border-bottom:0');
    // No ring around the avatar (var(--border) reads blue-tinted at 1px).
    expect(DASHBOARD_HTML).toContain('.acct .avatar.lg { width:28px; height:28px; cursor:pointer; border-color:transparent; }');
  });

  it('makes account menu section headings larger than item labels with inter-section spacing', () => {
    // Section headings are 15px uppercase bold with top margin between sections.
    expect(DASHBOARD_HTML).toContain('.menu-section-label { font-size:15px; font-weight:700; letter-spacing:.02em; text-transform:uppercase; color:var(--text); padding:4px 12px 6px; margin-top:16px; }');
    // First section label does not have large top margin.
    expect(DASHBOARD_HTML).toContain('.who + .menu-section-label,');
    expect(DASHBOARD_HTML).toContain('.acct-auth-group + .menu-section-label,');
    expect(DASHBOARD_HTML).toContain('.menu-section-label:first-child { margin-top:2px; }');
    // Menu items are 13.5px with comfortable padding.
    expect(DASHBOARD_HTML).toContain('.menu-pop button, .menu-pop a { display:block; width:100%; text-align:left; background:transparent; border:none; color:var(--text); padding:9px 12px; border-radius:9px; cursor:pointer; font-size:13.5px;');
    // Menu divider precedes Sign Out.
    expect(DASHBOARD_HTML).toContain('.menu-divider { border-top:1px solid var(--border); margin:12px 6px 6px; }');
    expect(DASHBOARD_HTML).toContain("'<div class=\"menu-divider\"></div>' +\n          '<button type=\"button\" onclick=\"logout()\">Sign Out</button>'");
    expect(DASHBOARD_HTML).toContain("'<div class=\"menu-divider\"></div>' +\n      '<button type=\"button\" onclick=\"closeAcctMobileMenu();logout()\">Sign Out</button>'");
    // Mobile media query scales up section labels to 17px.
    expect(DASHBOARD_HTML).toContain('.acct-mobile-menu .menu-section-label { font-size: 17px; margin-top: 14px; }');
  });

  it('#3 removes the top-of-page Trends disclaimer banner and relocates its short line into the hamburger menu', () => {
    // Banner + its JS are fully gone (see the "adds a collapsible disclaimer"
    // rewrite above for the full negative-assertion list).
    expect(DASHBOARD_HTML).not.toContain('id="trDisclaimer"');
    // The SHORT footer line (not the old long paragraph) is reused verbatim
    // inside the mobile menu, appended after Sign Out (signed in) and after
    // Upgrade (signed out) — i.e. always the last thing in the dropdown.
    const footerLine = 'Congress.Trade  ·  educational tool for public STOCK Act (2012) disclosures  ·  not financial advice  ·  $ estimated from brackets  ·  independent/private service not affiliated with or endorsed/sponsored by any government agency';
    expect(DASHBOARD_HTML).toContain("var FOOTER_DISCLAIMER_TEXT = '" + footerLine + "';");
    // Static <footer> markup carries the identical sentence (single source of truth).
    expect(DASHBOARD_HTML).toContain('<span>' + footerLine + '</span>');
    expect(DASHBOARD_HTML).toContain("closeAcctMobileMenu();logout()");
    expect(DASHBOARD_HTML).toContain('acctMobileDisclaimerHtml()');
    // Guest mobile menu: Sign In/Upgrade, then Appearance, then disclaimer.
    expect(DASHBOARD_HTML).toContain("desktopHtml = authGroup;");
    expect(DASHBOARD_HTML).not.toContain('class="theme-guest"');
    expect(DASHBOARD_HTML).toContain("href=\"/auth/apple/start\"");
    expect(DASHBOARD_HTML).toContain("function syncAppleSignInButton()");
    expect(DASHBOARD_HTML).toContain("if (path === '/admin') fromUrl = 'admin';");
    expect(DASHBOARD_HTML).toContain("if (path === '/review') fromUrl = 'review';");
    expect(DASHBOARD_HTML).toContain('class="acct-auth-group"');
    expect(DASHBOARD_HTML).toContain("function acctMobileDisclaimerHtml() {\n  return '<div class=\"footer-disclaimer\">' + esc(FOOTER_DISCLAIMER_TEXT) + '</div>';\n}");
  });

  it('#5 tightens the mobile bottom clearance and guarantees the footer clears the fixed tab bar', () => {
    // General <=768px clearance: 86px -> 70px (nav.tabs is ~60px tall).
    expect(DASHBOARD_HTML).toContain('padding-bottom: calc(70px + env(safe-area-inset-bottom)); }');
    // The <=768px block used a `padding:` SHORTHAND that silently reset
    // padding-bottom to 22px for nearly every phone (a real regression, not
    // just "overshoot") — it now re-asserts the same 70px explicitly.
    expect(DASHBOARD_HTML).toContain('main { padding: 0 14px; padding-bottom: calc(70px + env(safe-area-inset-bottom)); }');
    // Footer gets its OWN extra ~2 lines (~32px) of bottom padding on top of
    // its own base, independent of main's general buffer, at both mobile
    // breakpoints (base 30px -> 62px total; tighter 26px block -> 58px total).
    expect(DASHBOARD_HTML).toContain('footer, footer.site-footer { padding-bottom: calc(62px + env(safe-area-inset-bottom)); }');
    expect(DASHBOARD_HTML).toContain('footer { padding: 26px 18px calc(58px + env(safe-area-inset-bottom)); }');
  });

  it('#6 vertically centers the "Page 1 of 56" pagination text in its control box', () => {
    expect(DASHBOARD_HTML).toContain('.pager-controls .note { margin-top: 0; }');
  });

  it('#7 shrinks + centers the mobile feed card\'s amount pictograph / $-range / date cluster', () => {
    expect(DASHBOARD_HTML).toContain(
      '.fc-trail { flex:0 0 auto; display:flex; flex-direction:column; align-items:flex-end; justify-content:center; gap:2px; margin-left:4px; }',
    );
    // Half-height bars scoped to the mobile card only — the dense desktop
    // table's own .amount-bars (17px, tier-6 top bar) is untouched.
    expect(DASHBOARD_HTML).toContain('.fc-trail .amount-bars { height:10px; }');
    expect(DASHBOARD_HTML).toContain('.fc-trail .amount-bars i:nth-child(6) { height:10px; }');
    expect(DASHBOARD_HTML).toContain('.amount-bars i:nth-child(6) { height:17px; }'); // desktop table unchanged
  });

  it('#8 uses a single unified search field covering name/ticker/state/party (no dual Name + Asset fields)', () => {
    const document = parse(DASHBOARD_HTML);
    const search = document.querySelector('#qSearch')!;
    expect(search).not.toBeNull();
    expect(search.getAttribute('placeholder')).toMatch(/name|ticker|state|party/i);
    // Visible dual fields are gone; legacy hidden aliases may remain.
    expect(document.querySelector('#qMemberField')).toBeNull();
    expect(document.querySelector('#qTickerField')).toBeNull();
    expect(document.querySelector('#qSearchField')).not.toBeNull();
  });

  it('#9 merges the Trades feed toolbars onto one desktop row (>768px) via explicit flex order, without touching the <=768px ID-scoped grid', () => {
    // #tradesToolbars wraps BOTH toolbar divs, in DOM order.
    const wrapMatch = DASHBOARD_HTML.match(
      /<div class="trades-toolbars" id="tradesToolbars">[\s\S]*?<div class="toolbar shared-filters" id="tradesSharedFilters">[\s\S]*?<div class="toolbar trades-only-filters" id="tradesExtraFilters">[\s\S]*?<\/div>\s*<\/div>/,
    );
    expect(wrapMatch).not.toBeNull();
    expect(DASHBOARD_HTML).toContain('@media (min-width: 769px) {\n    .trades-toolbars { display:flex; flex-wrap:nowrap; align-items:center; gap:12px; margin:0; min-width:0; }');
    expect(DASHBOARD_HTML).toContain('.trades-toolbars #tradesSharedFilters,\n    .trades-toolbars #tradesExtraFilters { display:contents; }');
    // Desired order: timeframe, groups+ⓘ, unified search, stats.
    expect(DASHBOARD_HTML).toContain('.trades-toolbars .pill-select.pill-cal { order:1; }');
    expect(DASHBOARD_HTML).toContain('.trades-toolbars .filter-groups { order:2; }');
    expect(DASHBOARD_HTML).toContain('.trades-toolbars #qSearchField { order:3;');
    expect(DASHBOARD_HTML).not.toContain('.trades-toolbars #qAssetClassWrap');
    expect(DASHBOARD_HTML).not.toContain('.trades-toolbars #searchToggle');
    expect(DASHBOARD_HTML).not.toContain('.trades-toolbars #tradesStats { order:4; }');
    expect(DASHBOARD_HTML).not.toContain('pill-amt');
    // DO-NOT-BREAK: the <=768px ID-scoped #tradesExtraFilters grid —
    // display:contents only ever fires at >=769px, never overlapping it.
    expect(DASHBOARD_HTML).toContain('#tradesExtraFilters { display: grid;');
    expect(DASHBOARD_HTML).toContain('#tradesExtraFilters #qSearchField { grid-column: 1;');
    expect(DASHBOARD_HTML).not.toContain('#tradesExtraFilters #searchToggle');
    const document = parse(DASHBOARD_HTML);
    const extras = document.querySelectorAll('#tradesExtraFilters > *').map((n) => n.id).filter(Boolean);
    // Hidden legacy inputs have no visible layout role but may lack ids on wrappers.
    expect(extras).toContain('qSearchField');
    expect(extras).not.toContain('qAssetClassWrap');
    expect(extras).not.toContain('searchToggle');
    expect(extras).not.toContain('tradesStats');
    // Mobile pill-chip touch sizing nudged toward the app (owner punch list
    // #9's "tighten to match the app" mobile sub-clause).
    expect(DASHBOARD_HTML).toContain('.toolbar .branch-toggle, .toolbar .party-chip, .toolbar .side-chip { min-height: 40px; }');
  });

  it('#2071 keeps the connecting banner out of the header-to-filter gap', () => {
    expect(DASHBOARD_HTML).not.toContain('Connecting to the live feed');
    const document = parse(DASHBOARD_HTML);
    const main = document.querySelector('main');
    expect(main).not.toBeNull();
    const mainKids = [...(main?.childNodes ?? [])].filter((n) => n.nodeType === 1);
    expect(mainKids[0]?.tagName.toLowerCase()).toBe('section');
    expect(mainKids.some((n) => n.id === 'banner' || /\bbanner\b/.test(n.getAttribute('class') || ''))).toBe(false);

    // Owner 2026-09-09: #tradesToolbars now lives in header.top (#ctFilters),
    // so the Trades banner is the first thing inside #view-trades and the
    // Trends filter markup is a hidden state mirror followed by #banner.
    const tradesFilters = document.querySelector('#tradesToolbars');
    expect(tradesFilters?.closest('header.top')).not.toBeNull();
    expect(tradesFilters?.closest('#ctFilters')).not.toBeNull();
    const trendsFilters = document.querySelector('#trendsSharedFilters');
    expect(trendsFilters?.getAttribute('hidden')).not.toBeNull();
    expect(trendsFilters?.getAttribute('aria-hidden')).toBe('true');
    expect(trendsFilters?.hasAttribute('data-filter-mirror')).toBe(true);
    const tradesBanner = document.querySelector('#view-trades')?.childNodes.find((n) => n.nodeType === 1) as any;
    const trendsBanner = trendsFilters?.nextElementSibling;
    expect(tradesBanner?.classList.contains('feed-banner')).toBe(true);
    expect(tradesBanner?.getAttribute('hidden')).not.toBeNull();
    expect(tradesBanner?.textContent ?? '').toBe('');
    expect(trendsBanner?.id).toBe('banner');
    expect(trendsBanner?.classList.contains('feed-banner')).toBe(true);
    expect(trendsBanner?.getAttribute('hidden')).not.toBeNull();
    expect(trendsBanner?.textContent ?? '').toBe('');

    // DO-NOT-BREAK: moving the banner must not rewrite the mobile extras grid.
    expect(DASHBOARD_HTML).toContain('#tradesExtraFilters { display: grid;');
    expect(DASHBOARD_HTML).toContain('#tradesExtraFilters #qSearchField { grid-column: 1;');
  });

  it('#2071 setBanner still paints a real error on both feed-banner slots', () => {
    const match = DASHBOARD_HTML.match(/function setBanner\(text, isErr\) \{[\s\S]*?\n\}/);
    expect(match).not.toBeNull();
    const nodes = [
      { hidden: true, textContent: '', style: { display: 'none' }, className: 'banner feed-banner', id: 'banner' },
      { hidden: true, textContent: '', style: { display: 'none' }, className: 'banner feed-banner', id: '' },
    ];
    const setBanner = new Function(
      'document',
      `${match![0]}\nreturn setBanner;`,
    )({ querySelectorAll: () => nodes }) as (text: string, isErr?: boolean) => void;

    setBanner('');
    expect(nodes.every((n) => n.hidden && n.textContent === '' && n.style.display === 'none')).toBe(true);

    setBanner('Could not load the live feed: HTTP 500', true);
    expect(nodes[0].hidden).toBe(false);
    expect(nodes[0].style.display).toBe('block');
    expect(nodes[0].className).toBe('banner feed-banner err');
    expect(nodes[0].textContent).toBe('Could not load the live feed: HTTP 500');
    expect(nodes[1].textContent).toBe(nodes[0].textContent);
    expect(nodes[1].className).toBe('banner feed-banner err');
  });

  it('#10 keeps the timeframe pill as the first control on both the Trades and Trends shared filter rows', () => {
    const feedRow = DASHBOARD_HTML.match(/<div class="toolbar shared-filters" id="tradesSharedFilters">([\s\S]*?)<div class="filter-groups">/);
    const trendsRow = DASHBOARD_HTML.match(/<div class="toolbar shared-filters trends-filter-row" id="trendsSharedFilters"[^>]*>([\s\S]*?)<div class="filter-groups">/);
    expect(feedRow).not.toBeNull();
    expect(trendsRow).not.toBeNull();
    expect(feedRow![1]).toContain('pill-cal');
    expect(feedRow![1]).toContain('id="tradesGlobalWindow"');
    expect(trendsRow![1]).toContain('pill-cal');
    expect(trendsRow![1]).toContain('id="trGlobalWindow"');
  });

  it('#11 the amount pill (and its "$" prefix icon) is gone entirely — owner follow-up batch #21 removed the $ Minimum control altogether', () => {
    expect(DASHBOARD_HTML).not.toContain('.pill-select.pill-amt::before');
    expect(DASHBOARD_HTML).not.toMatch(/pill-amt[^{]*::before\s*\{\s*content:"\$"/);
    expect(DASHBOARD_HTML).not.toContain('pill-amt');
    // The calendar pill keeps its icon.
    expect(DASHBOARD_HTML).toContain('.pill-select.pill-cal::before { content:"📅"; }');
    expect(DASHBOARD_HTML).not.toContain('<option value="">Any $</option>');
  });

  it('#12 uses "  |  " (two spaces + pipe) for feed table separators; cards use the iOS middle-dot line', () => {
    // Desktop table cells keep the owner-approved pipe pairing.
    expect(DASHBOARD_HTML).toContain("(r.st ? '<span class=\"muted\">  |  ' + esc(r.st) + '</span>' : '')");
    expect(DASHBOARD_HTML).toContain("esc((r.ticker ? r.ticker + '  |  ' : '') + (nm || ''))");
    expect(DASHBOARD_HTML).toContain("esc(tier.title + '  |  ' + text)");
    // Mobile cards follow iOS TradeCard: "Chamber · Name · D-ST".
    expect(DASHBOARD_HTML).toContain("bits.join('<span class=\"fc-sep\">  ·  </span>')");
  });

  it('#14 uses "  |  " (two spaces + pipe) for drawer separators (ticker/company, stats row, Market Cap)', () => {
    // The old middle-dot is gone from every ticker/company pairing inside drawers.
    expect(DASHBOARD_HTML).not.toContain('<span class="dot-sep">·</span>');
    expect(DASHBOARD_HTML).toContain(".drawer-title-line .dot-sep { margin: 0 6px; opacity: .5; font-weight: 400; }");
    // drawerCompanyTitle (ticker drawer's own "TKR | Company" title).
    expect(DASHBOARD_HTML).toContain("(ticker && !sameAsTicker ? '<span class=\"dot-sep\">  |  </span>' : '')");
    // openTrade's identity card keeps the pairing in its hover title (the
    // duplicate "in TKR | Company" hero line is gone — see the identity test).
    expect(DASHBOARD_HTML).toContain("esc((displayTicker ? displayTicker + '  |  ' : '') + assetLabel)");
    // Ticker drawer stats row: "N trades  |  N politicians  |  ~$X approx. volume".
    expect(DASHBOARD_HTML).toContain("fmtCount(s.totalTrades || 0) + ' trades  |  ' + fmtCount(s.memberCount || 0) + ' politicians  |  ' + estUsd(s.estVolumeUsd) + ' approx. volume  |  '");
    // Market Cap: "Mega  |  ~$4.8t".
    expect(DASHBOARD_HTML).toContain("(ref.marketCap != null ? (ref.marketCapBucket ? '  |  ' : '') + estUsd(ref.marketCap) : '')");
  });
});

describe('MONET web punch list 2 (LANE W2 — drawers + delivery)', () => {
  it('#13(a)/(c) drops the POLITICIAN/ASSET eyebrow labels and moves Owner up beside the name', () => {
    expect(DASHBOARD_HTML).not.toContain('<span class="eyebrow">Politician</span>');
    expect(DASHBOARD_HTML).not.toContain('<span class="eyebrow">Asset</span>');
    expect(DASHBOARD_HTML).toContain(".drawer-trade-owner { display:inline-block; flex:0 0 auto;");
    expect(DASHBOARD_HTML).toContain("var ownerBadge = ownerText ? '<span class=\"drawer-trade-owner muted\">' + esc(ownerText) + '</span>' : '';");
    // Owner no longer has its own Trade Details row.
    expect(DASHBOARD_HTML).not.toContain("kvRow('Owner', esc(ownerLabel(row.owner) || '—'))");
  });

  it('owner follow-up batch #1 (P1 regression): the owner badge is a flex SIBLING after the ellipsized name div, not appended inside it — a long name must not hide it', () => {
    // The old shipped bug appended ownerBadge INSIDE the ellipsized <div>,
    // so any longish name (e.g. "David H. McCormick") clipped the badge
    // entirely. It must now sit as its own element after that div closes,
    // inside .member-cell (a flex row with gap — see the CSS rule below).
    expect(DASHBOARD_HTML).not.toContain(
      "memberAvatarHtml(fmtName(row.member), row.photoUrl) + '<div>' + memberVal + ownerBadge + '</div></div></div>';"
    );
    expect(DASHBOARD_HTML).toContain(
      "memberAvatarHtml(fmtName(row.member), row.photoUrl, row.party, true) + '<div>' + memberVal + '</div>' + ownerBadge + '</div></div>';"
    );
    // Structural check: inside the generated personCard markup, the name div
    // (which carries the ellipsis) must fully close with </div> BEFORE the
    // <span class="drawer-trade-owner ...> badge opens — i.e. the badge is
    // outside, not nested inside, the ellipsized div.
    const personCardMatch = DASHBOARD_HTML.match(
      /memberAvatarHtml\(fmtName\(row\.member\), row\.photoUrl, row\.party, true\) \+ '<div>' \+ memberVal \+ '<\/div>' \+ ownerBadge \+ '<\/div><\/div>';/
    );
    expect(personCardMatch).toBeTruthy();
    const nameDivCloseIdx = DASHBOARD_HTML.indexOf("memberVal + '</div>'");
    const ownerBadgeUseIdx = DASHBOARD_HTML.indexOf('+ ownerBadge +', nameDivCloseIdx);
    expect(nameDivCloseIdx).toBeGreaterThan(-1);
    expect(ownerBadgeUseIdx).toBeGreaterThan(nameDivCloseIdx);
    // .drawer-trade-owner must be flex:0 0 auto (never shrinks/wraps) so the
    // name div (flex:1 1 auto + ellipsis) is what shrinks instead.
    expect(DASHBOARD_HTML).toMatch(/\.drawer-trade-owner\s*\{[^}]*flex:0 0 auto;[^}]*\}/);
  });

  it('#13(b) renames the Trade Details "Politician" row to "Name" with a link chevron', () => {
    expect(DASHBOARD_HTML).not.toContain("kvRow('Politician', memberVal)");
    expect(DASHBOARD_HTML).toContain("var nameChevron = row.filerId ? ' <span class=\"kv-chevron\" aria-hidden=\"true\">›</span>' : '';");
    expect(DASHBOARD_HTML).toContain("kvRow('Name', memberVal + nameChevron)");
    expect(DASHBOARD_HTML).toContain('.kv-chevron { opacity:.55; margin-left:2px; }');
  });

  it('#13(d) drops the "est. bracket" caption next to the amount (the bracket is exact)', () => {
    expect(DASHBOARD_HTML).not.toContain('drawer-trade-bracket');
    expect(DASHBOARD_HTML).not.toContain('est. bracket');
    expect(DASHBOARD_HTML).toContain("'<h2 class=\"drawer-trade-headline\">' + esc(amountText(row.min, row.max)) + '</h2>' +");
  });

  it('#13(e) moves Performance above Trade Details, directly under the header block', () => {
    expect(DASHBOARD_HTML).toContain(
      "    ? '<div class=\"drawer-section first\"><h3>Performance Since ' + (row.type === 'S' ? 'Sell' : 'Trade') + '</h3><div id=\"tradePerf\">' + perfInit + '</div></div>'",
    );
    expect(DASHBOARD_HTML).toContain(
      "'<div class=\"drawer-section\"><h3>Trade Details</h3><dl class=\"drawer-kv\">' +",
    );
    expect(DASHBOARD_HTML).toContain('openDrawer(head + perf + summary + profile + notes + links, topbarTitle);');
  });

  it('#13(f) gives every drawer a useful sticky-header summary instead of an empty bar', () => {
    expect(DASHBOARD_HTML).toContain('<span class="drawer-topbar-title" id="drawerTopbarTitle" aria-hidden="true"></span>');
    expect(DASHBOARD_HTML).toContain('function openDrawer(html, topbarTitle) {');
    expect(DASHBOARD_HTML).toContain("if (titleEl) titleEl.innerHTML = topbarTitle || DRAWER_DEFAULT_TITLE;");
    expect(DASHBOARD_HTML).toContain('function bindDrawerHero(panel) {');
    expect(DASHBOARD_HTML).toContain('drawer-hero drawer-hero-live drawer-company-title');
    expect(DASHBOARD_HTML).toContain('drawer-hero drawer-hero-live drawer-member-title');
    expect(DASHBOARD_HTML).toContain('drawer-hero drawer-hero-swap drawer-trade-head');
    expect(DASHBOARD_HTML).toContain('.drawer-topbar.has-hero-live .drawer-topbar-title { opacity:0;');
    expect(DASHBOARD_HTML).toContain('.drawer-topbar.has-hero-swap.is-compact .drawer-topbar-title { opacity:.92;');
    expect(DASHBOARD_HTML).toContain('bindDrawerHero(p);');
    expect(DASHBOARD_HTML).toContain('.drawer-title-line .tkr { color:var(--text); }');
    expect(DASHBOARD_HTML).not.toContain('.drawer-title-line .tkr { color:var(--accent); }');
    // Trade drawer: "SOLD  $1k-$15k  of  ARCC  |  Ares Capital Corp." style summary.
    expect(DASHBOARD_HTML).toContain(
      "var topbarTitle = '<strong>' + esc(sideWord.toUpperCase()) + '</strong> ' + esc(amountText(row.min, row.max)) +\n    (topbarAsset ? ' <span class=\"muted\">of</span> ' + esc(topbarAsset) : '');",
    );
    // Ticker drawer: "TKR | Company".
    expect(DASHBOARD_HTML).toContain(
      "var topbarTitle = esc(d.ticker) + ((companyName && companyName !== d.ticker) ? '<span class=\"dot-sep\">  |  </span>' + esc(companyName) : '');",
    );
    // Member drawer: the politician's name.
    expect(DASHBOARD_HTML).toContain("// Owner punch list #13(f): sticky-header summary — the politician's name.\n      esc(name)\n    );");
  });

  it('gives the drawer dialog a real accessible name in every state, including loading and error (WEBA11Y P2 follow-up)', () => {
    // #drawerTopbarTitle is the dialog's aria-labelledby target (asserted
    // elsewhere as WEBA11Y-07).  Every openDrawer() call used to leave it
    // empty unless a caller happened to pass a topbarTitle — which every
    // loading/error caller did not — pointing the dialog's accessible name
    // at nothing.  DRAWER_DEFAULT_TITLE is a last-resort fallback; every
    // current call site instead passes its own real, state-specific title.
    expect(DASHBOARD_HTML).toContain("var DRAWER_DEFAULT_TITLE = 'Details';");
    expect(DASHBOARD_HTML).toContain("if (titleEl) titleEl.innerHTML = topbarTitle || DRAWER_DEFAULT_TITLE;");
    const loadingAndErrorTitles: Array<[string, string]> = [
      // Asset drawer.
      [
        "openDrawer('<div class=\"note\">Loading ' + esc(ticker) + '…</div>', 'Loading ' + esc(ticker) + '…');",
        'asset loading',
      ],
      [
        "openDrawer('<div class=\"note\">Could not load ' + esc(ticker) + ': ' + esc(e.message) + '</div>', 'Could not load ' + esc(ticker));",
        'asset error',
      ],
      // Member drawer.
      [
        "openDrawer('<div class=\"note\">Loading politician…</div>', 'Loading politician…');",
        'member loading',
      ],
      [
        "openDrawer('<div class=\"note\">Could not load politician: ' + esc(e.message) + '</div>', 'Could not load politician');",
        'member error',
      ],
      // Trade drawer (openTradeById deep-link resolution).
      [
        "openDrawer('<div class=\"note\">Loading trade…</div>', 'Loading trade…');",
        'trade loading',
      ],
      [
        "openDrawer('<div class=\"note\">That trade could not be loaded. It may have been retracted or the link is incomplete.</div>', 'Trade unavailable');",
        'trade retracted/incomplete',
      ],
      [
        "openDrawer('<div class=\"note\">That trade was not found. It may have been retracted or the share link is outdated.</div>', 'Trade not found');",
        'trade not found',
      ],
      [
        "openDrawer('<div class=\"note\">Could not load that trade' + (e && e.message && e.message !== 'not_found' ? ': ' + esc(e.message) : '') + '.</div>', 'Could not load trade');",
        'trade generic fetch error',
      ],
    ];
    for (const [snippet, label] of loadingAndErrorTitles) {
      expect(DASHBOARD_HTML, `${label} openDrawer() call should pass an explicit topbarTitle`).toContain(snippet);
    }
    // None of the loading/error paths call openDrawer() with a single
    // argument anymore (which is what silently produced the empty-name bug).
    expect(DASHBOARD_HTML).not.toMatch(/openDrawer\('<div class="note">Loading[^']*'\);/);
    expect(DASHBOARD_HTML).not.toMatch(/openDrawer\('<div class="note">Could not load[^']*'\);/);
  });

  it('#15 wires the trade drawer Company section to the same ticker analytics source as the ticker drawer', () => {
    expect(DASHBOARD_HTML).toContain('<div id="tradeCompany">');
    expect(DASHBOARD_HTML).toContain('var hasLocalRef = !!(rowRef.sector || rowRef.marketCap != null || rowRef.marketCapBucket || rowRef.country || rowRef.exchangeShort || rowRef.assetClass);');
    expect(DASHBOARD_HTML).toContain('if (hasTicker && !hasLocalRef) {');
    expect(DASHBOARD_HTML).toContain("aGet('ticker/' + encodeURIComponent(displayTicker)).then(function (d) {\n      var cEl = el('tradeCompany');\n      if (cEl && d && d.ref) cEl.innerHTML = companySectionHtml(d.ref);");
  });

  it('#16 swaps a bare "Securities" asset name for the parsed asset type when cheaply available', () => {
    expect(DASHBOARD_HTML).toContain('function assetNameFallback(nm, row) {');
    expect(DASHBOARD_HTML).toContain("if (!nm || String(nm).trim().toLowerCase() !== 'securities') return nm;");
    expect(DASHBOARD_HTML).toContain('nm = assetNameFallback(nm, r);'); // feed/table asset cell
    expect(DASHBOARD_HTML).toContain('var displayAsset = assetNameFallback(cleanAsset(row.asset || \'\'), row);'); // trade drawer
  });

  it('#17 renames "Published" to "Seen" and keeps it alongside "Imported"/"Official Filed"', () => {
    expect(DASHBOARD_HTML).toContain('function seenRaw(r) {');
    expect(DASHBOARD_HTML).toContain('if (tx && toISODate(s) && toISODate(s) < tx) continue;');
    expect(DASHBOARD_HTML).toContain('function seenDetailText(r) {');
    expect(DASHBOARD_HTML).toContain('function seenCellHtml(r) {');
    expect(DASHBOARD_HTML).not.toContain('function publishedRaw(');
    expect(DASHBOARD_HTML).not.toContain('function publishedDetailText(');
    expect(DASHBOARD_HTML).not.toContain('function publishedCellHtml(');
    // Admin feed column: id/sort key unchanged (persisted column order/visibility), label renamed.
    expect(DASHBOARD_HTML).toContain("{ id: 'published', label: 'Seen', sort: 'published',");
    expect(DASHBOARD_HTML).toContain('cell: seenCellHtml }');
    // Trade drawer shows Seen right alongside Imported and Official Filed.
    expect(DASHBOARD_HTML).toContain("kvRow('Seen', '<em>' + esc(seenDetailText(row)) + '</em>')");
    expect(DASHBOARD_HTML).toContain("kvRow('Official Filed', esc(filedDetailText(row)))");
    expect(DASHBOARD_HTML).toContain("kvRow('Imported', esc(dateTimeText(row.imported)))");
  });

  it('#18(a) centers the ticker-drawer stat card values and shrinks the card height', () => {
    expect(DASHBOARD_HTML).toContain('#detailDrawerBody .grid-cards .card { display:flex; flex-direction:column; padding:14px 16px; min-height:0; }');
    expect(DASHBOARD_HTML).toContain('#detailDrawerBody .grid-cards .card .v { flex:1 1 auto; flex-direction:column; align-items:center; justify-content:center; }');
  });

  it('#18(b) labels weekly chart buckets with the week-start date instead of the raw "YYYY-Wnn" bucket', () => {
    expect(DASHBOARD_HTML).toContain('var mw = /^(\\d{4})-W(\\d{1,2})$/.exec(p);');
    expect(DASHBOARD_HTML).toContain('var weekStart = wk <= 0 ? jan1 : new Date(firstMon.getTime() + (wk - 1) * 7 * 86400000);');
    expect(DASHBOARD_HTML).toContain("return MONTH_ABBR[weekStart.getUTCMonth()] + ' ' + weekStart.getUTCDate();");
    // "week of" axis caption, shown only when the series is actually weekly.
    expect(DASHBOARD_HTML).toContain("d.granularity === 'week'");
    expect(DASHBOARD_HTML).toContain('week-of date');
  });

  it('#18(c) lets the drawer Recent Trades table use the drawer\\u2019s full width', () => {
    expect(DASHBOARD_HTML).toContain('#detailDrawerBody .table-wrap { padding-right:0; }');
  });

  it('#18(d) drops the "M" manual badge from the ticker drawer\\u2019s Recent Trades table only', () => {
    expect(DASHBOARD_HTML).toContain('var actionCell = actionBadge(t.txType);'); // ticker drawer: bare, no manual badge
    // Trade drawer detail still notes manual entries explicitly.
    expect(DASHBOARD_HTML).toContain("(row.source === 'manual' ? kvRow('Source', 'Manual Entry') : '')");
  });

  it('#18(e) lowercases/abbreviates the mini trade-date subline and keeps the date on one line', () => {
    expect(DASHBOARD_HTML).toContain("var sub = pub ? 'filed ' + dateText(pub) : 'filed unavailable';");
    expect(DASHBOARD_HTML).toContain("sub = 'filed ' + Math.round(ms / 86400000) + 'd later';");
    expect(DASHBOARD_HTML).not.toContain("'Filed ' + Math.round(ms / 86400000) + ' days later'");
    expect(DASHBOARD_HTML).toContain('.mini-date > span:first-child { white-space:nowrap; }');
  });

  it('#19 trims the Delivery tab explainer copy to 1-2 short sentences per method, one security line', () => {
    // The verbose per-card asides (Slack/Zapier/Make/Pipedream, "leaving the
    // line open") and the doubled-up free-tier/security paragraph are gone.
    expect(DASHBOARD_HTML).not.toContain('Not running a server? Point it at Slack, Zapier, Make, or Pipedream');
    expect(DASHBOARD_HTML).not.toContain('If webhooks are us calling you, the stream is you leaving the line open.');
    expect(DASHBOARD_HTML).not.toContain('Past speed doesn&rsquo;t guarantee future speed.');
    // Exactly one short <p> per delivery-card now (title + one paragraph, no p.note aside).
    const gridStart = DASHBOARD_HTML.indexOf('<div class="delivery-grid">');
    const gridEnd = DASHBOARD_HTML.indexOf('<p class="note">Every request is HMAC-SHA256 signed', gridStart);
    expect(gridStart).toBeGreaterThan(-1);
    expect(gridEnd).toBeGreaterThan(gridStart);
    const grid = DASHBOARD_HTML.slice(gridStart, gridEnd);
    expect((grid.match(/<p>/g) || []).length).toBe(2);
    expect(grid).not.toContain('class="note"');
    // Per TRANSACTION, not per filing: delivery/webhook.ts sends one POST per
    // tx with its own X-Tx-Id, so "the full filing JSON" told integrators the
    // wrong granularity and invited dedupe on the shared docId.
    expect(grid).toContain('We POST one signed JSON request per transaction to your URL the instant it lands, retrying automatically on failure.');
    expect(grid).toContain('each with its own <code>X-Tx-Id</code>');
    expect(grid).not.toContain('We POST the full filing JSON');
    expect(grid).toContain('One open HTTPS connection streams each new transaction as an event &mdash; a few lines of <code>EventSource</code>, no polling.');
    // The one security line (HMAC + secrets-shown-once) survives, stated once.
    expect(DASHBOARD_HTML).toContain('Every request is HMAC-SHA256 signed, and secrets are shown once at creation.');
    expect(DASHBOARD_HTML).toContain('id="subsMarketing"');
    expect(DASHBOARD_HTML).toContain('Signed Webhooks');
    expect(DASHBOARD_HTML).toContain('HMAC-SHA256');
    expect(DASHBOARD_HTML).toContain('Live Stream (SSE)');
    expect(DASHBOARD_HTML).toContain('EventSource');
    // Create-flow + table are untouched.
    expect(DASHBOARD_HTML).toContain('id="subsManage"');
    expect(DASHBOARD_HTML).toContain('id="subsTable"');
  });
});

describe('Trades-tab count correctness (LANE: trades-count-fix)', () => {
  // Every test in this block stubs `el`/`fetch`/counter globals via
  // vi.stubGlobal so the extracted functions (which run as plain global
  // code, not module-scoped) see them — always restore afterward so nothing
  // leaks into a later test in this file.
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Builds a runnable `fetchUpdates` bound to the REAL chip/param-reading
   *  helpers it depends on (chipSel/chamberParam/selectedSideParam/partySel/
   *  partyParam/tradesFilterParams), so a test exercising it also proves the
   *  active party/chamber/ticker/politician filters actually reach the poll
   *  request — not just that the response-handling arithmetic is correct. */
  function loadFetchUpdates() {
    const chamberAll = DASHBOARD_HTML.match(/var CHAMBER_ALL = \[[^\]]*\];/);
    if (!chamberAll) throw new Error('CHAMBER_ALL was not found in DASHBOARD_HTML');
    const sources = loadDashboardFunctions([
      'chipSel',
      'chamberParam',
      'selectedSideParam',
      'selectedAssetClass',
      'partySel',
      'partyParam',
      'tradesSearchQuery',
      'applySearchToServerParams',
      'tradesFilterParams',
      'fetchUpdates',
    ]);
    const body = [chamberAll[0], ...sources].join('\n\n') + '\nreturn fetchUpdates;';
    return new Function(body)() as () => Promise<number>;
  }

  function fakeInput(value: string) {
    return { value };
  }
  /** Fake chip group: `.querySelectorAll('.<cls>.on')` returns one fake
   *  button per currently-"on" value, each answering `getAttribute(attr)`. */
  function fakeChipGroup(attr: string, onValues: string[]) {
    return {
      querySelectorAll(selector: string) {
        if (!selector.endsWith('.on')) return [];
        return onValues.map((v) => ({ getAttribute: (a: string) => (a === attr ? v : null) }));
      },
    };
  }

  /** Installs every global `fetchUpdates` (transitively) touches. Rendering
   *  (`renderTrades`) and row shaping (`txToRow`/`sortRows`/`rememberTradeRow`)
   *  are stubbed to identity/no-op — this test's subject is the counting
   *  contract (totalRows/filingsImportedToday/cursor/TRADES-merge), which is
   *  independent of DOM rendering and covered separately by the string-level
   *  Trades-table tests elsewhere in this file. */
  function installFetchUpdatesGlobals(opts: {
    partyOn?: string[];
    chamberOn?: string[];
    sideOn?: string[];
    ticker?: string;
    member?: string;
    cursor?: number;
    tradesPageSize?: number;
    totalRows?: number;
    filingsImportedToday?: number;
    tradesPage?: number;
    loadingPage?: boolean;
  }) {
    // Unified search: combine member/ticker stubs into qSearch; keep legacy
    // fields empty so tradesSearchQuery prefers #qSearch.
    const searchParts = [opts.member, opts.ticker].filter(Boolean);
    const dom: Record<string, unknown> = {
      qSearch: fakeInput(searchParts.join(' ')),
      qTicker: fakeInput(''),
      qMember: fakeInput(''),
      qSideGroup: fakeChipGroup('data-side', opts.sideOn ?? []),
      qChamber: fakeChipGroup('data-ch', opts.chamberOn ?? []),
      qPartyGroup: fakeChipGroup('data-party', opts.partyOn ?? []),
      qFrom: fakeInput(''),
      qTo: fakeInput(''),
      qAssetClass: fakeInput('all'),
      // No shared-window select stubbed => tradesFilterParams' window
      // fallback branches are skipped entirely (no unrequested `from`).
    };
    vi.stubGlobal('el', (id: string) => dom[id] ?? null);
    vi.stubGlobal('cursor', opts.cursor ?? 0);
    vi.stubGlobal('tradesPage', opts.tradesPage ?? 0);
    vi.stubGlobal('loadingPage', opts.loadingPage ?? false);
    vi.stubGlobal('tradesPageSize', opts.tradesPageSize ?? 50);
    vi.stubGlobal('TRADES', [] as unknown[]);
    vi.stubGlobal('totalRows', opts.totalRows ?? 0);
    vi.stubGlobal('filingsImportedToday', opts.filingsImportedToday ?? 0);
    vi.stubGlobal('sortKey', 'txdate');
    vi.stubGlobal('sortDir', -1);
    vi.stubGlobal('txToRow', (tx: unknown) => tx);
    vi.stubGlobal('rememberTradeRow', () => {});
    vi.stubGlobal('sortRows', (rows: unknown[]) => rows);
    vi.stubGlobal('setTradesKpis', () => {});
    vi.stubGlobal('renderTrades', () => {});
  }

  it('assigns totalRows from the server on every poll instead of accumulating it (owner report #1: 2535 -> 2635 -> 2735 drift)', async () => {
    installFetchUpdatesGlobals({ totalRows: 2535, cursor: 100 });
    const requestedUrls: string[] = [];
    const responses = [
      { transactions: [{ id: 'tx1' }, { id: 'tx2' }], cursor: 101, total: 2537, filingsImportedToday: 4 },
      { transactions: [{ id: 'tx3' }], cursor: 102, total: 2538, filingsImportedToday: 5 },
      // Zero-delta poll: server omits total/filingsImportedToday entirely.
      { transactions: [], cursor: 102 },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        requestedUrls.push(url);
        return Promise.resolve({ ok: true, json: async () => responses.shift() });
      }),
    );

    const fetchUpdates = loadFetchUpdates();
    await fetchUpdates();
    expect((globalThis as Record<string, unknown>).totalRows).toBe(2537);
    await fetchUpdates();
    // Must be exactly the server's fresh number (2538) — a client that instead
    // did `totalRows += txs.length` on top of the previous 2537 would also
    // land on 2538 here by coincidence, but would diverge from the truth the
    // moment the server's count and the poll's row count aren't in lockstep
    // (e.g. a de-duplicated or budget-limited delta) — which the next
    // assertion (zero-delta poll) exercises.
    expect((globalThis as Record<string, unknown>).totalRows).toBe(2538);
    await fetchUpdates();
    // No new rows + server omits `total` -> must hold at the last known-good
    // value, never reset to 0 and never keep incrementing on an empty delta.
    expect((globalThis as Record<string, unknown>).totalRows).toBe(2538);
    expect(requestedUrls).toHaveLength(3);
  });

  it('includes the active party/chamber filter in the poll request (owner report #2: filtering must reach the poll, not just the initial page load)', async () => {
    installFetchUpdatesGlobals({ partyOn: ['D'], chamberOn: ['house'], cursor: 50 });
    const requestedUrls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        requestedUrls.push(url);
        return Promise.resolve({ ok: true, json: async () => ({ transactions: [], cursor: 50 }) });
      }),
    );

    const fetchUpdates = loadFetchUpdates();
    await fetchUpdates();
    expect(requestedUrls).toHaveLength(1);
    const url = new URL(requestedUrls[0], 'https://example.test');
    expect(url.searchParams.get('party')).toBe('D');
    expect(url.searchParams.get('chamber')).toBe('house');
    expect(url.searchParams.get('since')).toBe('50');
  });

  it('an unfiltered poll omits party/chamber/ticker/memberName entirely (no accidental filter leakage)', async () => {
    installFetchUpdatesGlobals({ cursor: 0 });
    const requestedUrls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        requestedUrls.push(url);
        return Promise.resolve({ ok: true, json: async () => ({ transactions: [], cursor: 0 }) });
      }),
    );
    const fetchUpdates = loadFetchUpdates();
    await fetchUpdates();
    const url = new URL(requestedUrls[0], 'https://example.test');
    expect(url.searchParams.has('party')).toBe(false);
    expect(url.searchParams.has('chamber')).toBe(false);
    expect(url.searchParams.has('ticker')).toBe(false);
    expect(url.searchParams.has('memberName')).toBe(false);
  });

  it('a party chip selection reaches tradesQueryParams (the full-page fetch), matching the poll wiring', () => {
    const chamberAll = DASHBOARD_HTML.match(/var CHAMBER_ALL = \[[^\]]*\];/);
    if (!chamberAll) throw new Error('CHAMBER_ALL was not found in DASHBOARD_HTML');
    const sources = loadDashboardFunctions([
      'chipSel',
      'chamberParam',
      'selectedSideParam',
      'selectedAssetClass',
      'partySel',
      'partyParam',
      'tradesSearchQuery',
      'applySearchToServerParams',
      'tradesFilterParams',
      'tradesQueryParams',
    ]);
    const tradesQueryParams = new Function(
      [chamberAll[0], ...sources].join('\n\n') + '\nreturn tradesQueryParams;',
    )() as () => URLSearchParams;

    installFetchUpdatesGlobals({ partyOn: ['R', 'O'] });
    const params = tradesQueryParams();
    expect(params.get('party')).toBe('O,R'); // partyParam sorts before joining
    expect(params.get('since')).toBe('0');
  });

  it('Trends "Trades" KPI carries a scope tooltip so a residual difference from the Trades tab total is self-explanatory, not confusing (owner report #3)', () => {
    expect(DASHBOARD_HTML).toContain("kpi('Trades', d.totalTrades, TRENDS_TRADES_TIP)");
    expect(DASHBOARD_HTML).toMatch(/var TRENDS_TRADES_TIP = '[^']*Trades tab[^']*';/);
    expect(DASHBOARD_HTML).toContain('Trends tab');
  });

  it('never shows a stale corpus-wide total next to a page-local-filtered list (owner report #2)', () => {
    // Page-local Search/$ is gone (owner: no $/size on any platform), so the
    // pager count is always the server-filtered corpus total.
    expect(DASHBOARD_HTML).not.toContain('var pageFilterActive = !!qa ||');
    expect(DASHBOARD_HTML).not.toContain('loaded rows match this page filter');
  });
});

describe('owner feedback 2026-08-10: spelled-out buys/sells + Trends card layout + stored review docs', () => {
  it('splitBar spells out lowercase buys/sells instead of the number-like B/S suffixes', () => {
    // "21B / 0S" reads like magnitudes (21 billion); the label is now
    // pluralized words: "21 buys / 0 sells", "1 buy / 3 sells".
    expect(DASHBOARD_HTML).toContain("pluralCount(buys, 'buy') + ' / ' + pluralCount(sells, 'sell')");
    expect(DASHBOARD_HTML).not.toContain("buys + 'B / ' + sells + 'S'");
  });

  it('review-queue + decision-history Document links open stored copy only (never government sourceUrl)', () => {
    // Admin surfaces always use /api/admin/filings/:id/raw + openStoredFiling
    // (fetch with adminHeaders). Never safeDocUrl(sourceUrl) / Clerk / eFD.
    expect(DASHBOARD_HTML).toContain('function reviewDocUrl(r)');
    expect(DASHBOARD_HTML).toContain('function storedFilingHref(docId)');
    expect(DASHBOARD_HTML).toContain('function openStoredFiling(docId)');
    expect(DASHBOARD_HTML).toContain("return '/api/admin/filings/' + encodeURIComponent(id) + '/raw'");
    expect(DASHBOARD_HTML).toContain('// Always prefer stored admin path when we have a doc id. Never government sourceUrl.');
    expect(DASHBOARD_HTML).toContain('a.review-stored-doc');
    expect(DASHBOARD_HTML).toContain('function decisionDocHtml(d)');
    expect(DASHBOARD_HTML).toContain('var url = reviewDocUrl(d);');
    // Must not navigate decision/history docs via government sourceUrl.
    expect(DASHBOARD_HTML).not.toContain("var url = d.pdfUrl || safeDocUrl(d.sourceUrl);");
    expect(DASHBOARD_HTML).not.toContain('return safeDocUrl(r.sourceUrl);');
    expect(DASHBOARD_HTML).toContain('var url = reviewDocUrl(r);');
  });

  it('Trends table cards use the full column so names do not wrap in a half-width box', () => {
    expect(DASHBOARD_HTML).toContain('#view-trends .section:has(> .table-wrap) { width: 100%; min-width: 0; max-width: 100%; }');
    expect(DASHBOARD_HTML).toContain('#view-trends .section:has(> .table-wrap) > .table-wrap > table { width: 100%; min-width: 560px; }');
    expect(DASHBOARD_HTML).toContain('#view-trends .member-cell .name-line');
    expect(DASHBOARD_HTML).toContain('text-overflow: ellipsis');
  });

  it('Politicians+Party grid hugs the left card instead of leaving a dead middle column', () => {
    expect(DASHBOARD_HTML).toContain('#view-trends .trend-members-grid { grid-template-columns: fit-content(760px) minmax(360px, 1fr); }');
  });

  it('caps Review Queue + Filing Decisions at ~7 visible rows with sticky heads (empty stays content-sized)', () => {
    // max-height only — no min-height — so an empty "queue is clear" row is not stretched.
    expect(DASHBOARD_HTML).toContain('#view-review .review-table-wrap {');
    expect(DASHBOARD_HTML).toContain('max-height: calc(2.6rem + 7 * 4.85rem);');
    expect(DASHBOARD_HTML).not.toMatch(/#view-review \.review-table-wrap \{[^}]*min-height:/);
    expect(DASHBOARD_HTML).toContain('#view-review .review-table-wrap thead th {\n    position: sticky;');
    expect(DASHBOARD_HTML).toContain('id="reviewTableWrap"');
    expect(DASHBOARD_HTML).toContain('id="decisionTableWrap"');
    expect(DASHBOARD_HTML).toContain('id="reviewBody"');
    expect(DASHBOARD_HTML).toContain('id="decisionBody"');
  });

  it('does not expose admin token UI or Admin Sign-In chrome', () => {
    expect(DASHBOARD_HTML).not.toContain('function saveAdminToken(');
    expect(DASHBOARD_HTML).not.toContain('function openAdminTokenDialog()');
    expect(DASHBOARD_HTML).not.toContain('id="adminTokenDialog"');
    expect(DASHBOARD_HTML).not.toContain('id="adminToken"');
    expect(DASHBOARD_HTML).not.toContain('Admin Sign-In');
    expect(DASHBOARD_HTML).not.toContain('admin access token');
    expect(DASHBOARD_HTML).not.toContain('congresstrade.adminToken');
    expect(DASHBOARD_HTML).toContain('sign in with an account that has admin access');
    expect(DASHBOARD_HTML).not.toContain('placeholder="ADMIN_TOKEN"');
    expect(DASHBOARD_HTML).not.toContain('<code>ADMIN_TOKEN</code>');
    expect(DASHBOARD_HTML).not.toContain('getAdminToken');
    expect(DASHBOARD_HTML).not.toContain('localStorage.setItem(ADMIN_TOKEN_KEY');
  });

  it('renders an Admin Access Control section to grant/revoke admin emails, with ADMIN_EMAILS read-only', () => {
    expect(DASHBOARD_HTML).toContain('<h3>Admin Access Control</h3>');
    expect(DASHBOARD_HTML).toContain('id="adminGrantEmail"');
    expect(DASHBOARD_HTML).toContain('onclick="grantAdminEmail()"');
    expect(DASHBOARD_HTML).toContain('id="adminListBody"');
    expect(DASHBOARD_HTML).toContain('not editable here');
    expect(DASHBOARD_HTML).toContain('function loadAdminList()');
    expect(DASHBOARD_HTML).toContain('function grantAdminEmail()');
    expect(DASHBOARD_HTML).toContain('function revokeAdminEmail(email)');
    expect(DASHBOARD_HTML).toContain("fetch('/api/admin/admins/grant'");
    expect(DASHBOARD_HTML).toContain("fetch('/api/admin/admins/revoke'");
    expect(DASHBOARD_HTML).toContain("fetch('/api/admin/admins', { headers: adminHeaders() })");
  });


  it('Directory: wide People/Assets toggle, no H-scroll, Type hidden, Asset fill+ellipsis, no logo without ticker', () => {
    // Toggle nearly as wide as the search field
    expect(DASHBOARD_HTML).toContain('class="seg dir-mode-seg" id="dirMode"');
    expect(DASHBOARD_HTML).toContain('#view-people #dirMode.dir-mode-seg {');
    expect(DASHBOARD_HTML).toContain('flex: 1 1 50%;');
    expect(DASHBOARD_HTML).toContain('min-height: 42px;');
    // No horizontal scroll on directory tables
    expect(DASHBOARD_HTML).toContain('.people-table-wrap {');
    expect(DASHBOARD_HTML).toContain('overflow-x: hidden;');
    // ...which only works if the table shrink-wraps its own columns — see the
    // "directory columns are reachable" test below for why fixed layout broke it.
    expect(DASHBOARD_HTML).toContain('table-layout: auto;');
    // Type column removed from Assets table
    expect(DASHBOARD_HTML).not.toMatch(/id="assetsHead"[\s\S]*?data-sort="type"/);
    expect(DASHBOARD_HTML).toContain('id="assetsBody"><tr><td colspan="3"');
    // Fit + fill column layout
    expect(DASHBOARD_HTML).toContain('.people-table .col-fit');
    expect(DASHBOARD_HTML).toContain('.people-table .col-fill');
    expect(DASHBOARD_HTML).toContain('.people-table .col-num');
    expect(DASHBOARD_HTML).toContain('text-overflow: ellipsis;');
    // No-ticker assets: no logo, name leads
    expect(DASHBOARD_HTML).toContain('// Funds/assets without a ticker: no logo; name starts where the ticker would be.');
    expect(DASHBOARD_HTML).toContain("var logo = tkr ? tickerLogoHtml(tkr, nm) : '';");
    expect(DASHBOARD_HTML).toContain('dir-asset-cell');
  });
});

/*
 * LANE W2 — audited web blocking defects.
 * Each test below pins the FIX for a defect that was reproduced by driving the
 * real site, so a future refactor cannot quietly restore the broken behaviour.
 */
describe('web blocking defects (audited)', () => {
  it('directory columns are reachable: auto table layout, not the fixed-layout collapse', () => {
    // width:1% is an AUTO-layout shrink-to-fit idiom. Under table-layout:fixed
    // it resolves literally (~13px of a 1320px table), so Branch • Party • State,
    // Trades and Politicians collapsed and were clipped by overflow-x:hidden —
    // 2 of the 3 columns unreachable at every viewport width.
    expect(DASHBOARD_HTML).toMatch(
      /\.people-table \{[^}]*table-layout: auto;[^}]*\}/,
    );
    expect(DASHBOARD_HTML).not.toMatch(
      /\.people-table \{[^}]*table-layout: fixed;[^}]*\}/,
    );
    // The fill column soaks up the remainder and still ellipsizes.
    expect(DASHBOARD_HTML).toMatch(
      /\.people-table \.col-fill \{\s*width: 100%;[^}]*max-width: 0;/,
    );
    // Phone: the meta heading may wrap so it stops stealing the name's width.
    expect(DASHBOARD_HTML).toContain(
      '.people-table th.col-fit, .people-table td.col-fit { white-space: normal; }',
    );
  });

  it('Trends KPI values are sized off their own tile so they cannot overflow the card', () => {
    expect(DASHBOARD_HTML).toContain('#trKpis .card { container-type: inline-size; }');
    expect(DASHBOARD_HTML).toContain('#trKpis .card .v { font-size: min(24px, 19.5cqw); }');
  });

  it('mirrors TICKER_RESOLVED_SQL client-side and never promises performance without a ticker', () => {
    expect(DASHBOARD_HTML).toContain(
      "var TICKER_SENTINELS = { 'NONE': 1, '--': 1, 'N/A': 1, 'NA': 1, 'NULL': 1, '\u2014': 1 };",
    );
    expect(DASHBOARD_HTML).toContain('function tickerResolved(t) {');
    expect(DASHBOARD_HTML).toContain('var hasTicker = tickerResolved(row.ticker);');
    // Whole section gated, not just the fetch.
    expect(DASHBOARD_HTML).toContain('var perf = hasTicker');
    expect(DASHBOARD_HTML).toContain("if (row.id && hasTicker && !row.isOption) {");
    expect(DASHBOARD_HTML).toContain("var profile = hasTicker ? '<div class=\"drawer-section\"><h3>Company</h3>");
    // The options note is correct and stays.
    expect(DASHBOARD_HTML).toContain("var perfInit = row.isOption ? OPTION_PERF_NOTE : PERF_GATE;");
    expect(DASHBOARD_HTML).toContain("Performance isn\\'t shown for options");
    // "market data" wording survives only for the honest case (ticker, no price yet)
    // and no longer blames an unconfigured API key.
    expect(DASHBOARD_HTML).toContain(
      'Price &amp; performance appear here once market data for this asset is cached.',
    );
    expect(DASHBOARD_HTML).not.toContain(
      'Price &amp; performance vs the S&amp;P 500 will appear here once a market-data API key is configured.',
    );
  });

  it('states the trade drawer entity once, not four times', () => {
    // The duplicate "in TKR | Company" hero line is gone entirely.
    expect(DASHBOARD_HTML).not.toContain('class="drawer-trade-in"');
    expect(DASHBOARD_HTML).not.toContain('var inName =');
    // Identity card stays — that is the one statement of the entity.
    expect(DASHBOARD_HTML).toContain('drawer-trade-identity');
    // Sticky nav carries a single token, not "TKR | Company" again.
    expect(DASHBOARD_HTML).toContain("var topbarAsset = displayTicker || displayAsset || '';");
    expect(DASHBOARD_HTML).not.toContain('topbarAssetBits');
    // A "filing note" that only restates the asset name is suppressed.
    expect(DASHBOARD_HTML).toContain('function entityFingerprint(');
    expect(DASHBOARD_HTML).toContain(
      'if (fp && (fp === entityFingerprint(assetName) || fp === entityFingerprint(ticker))) return \'\';',
    );
    // The duplicate "View All Trades of X" links are gone; the header buttons
    // already opened the same drawers.
    expect(DASHBOARD_HTML).not.toContain("'View All Trades of '");
    expect(DASHBOARD_HTML).not.toContain("'View All Trades by '");
    expect(DASHBOARD_HTML).toContain('Company Details</button>');
    expect(DASHBOARD_HTML).toContain('Politician Details</button>');
  });

  it('labels what every trade count counts (this filter vs all time)', () => {
    expect(DASHBOARD_HTML).not.toContain('<span class="match-window">');
    expect(DASHBOARD_HTML).toContain("if (typeof stampWindowChips === 'function') stampWindowChips();");
    // Trends KPI strip has no Snapshot caption — window lives in the filter row.
    expect(DASHBOARD_HTML).not.toContain('<div class="tf-cap">Snapshot</div>');
    expect(DASHBOARD_HTML).not.toContain('# Trades');
    expect(DASHBOARD_HTML).toContain("onclick=\"setTrTimeMetric('count')\">#</button>");
    // Directory: whole-record scope on the counts, the sub copy and the headers.
    expect(DASHBOARD_HTML).toContain('trade counts are all time');
    expect(DASHBOARD_HTML).toContain('Trade counts cover the full record, not the timeframe set on Trades or Trends.');
    expect(DASHBOARD_HTML).toContain('title="Sort by trade count (all time)"');
    // Politician drawer follows the shared window/chamber/party/side chips.
    expect(DASHBOARD_HTML).toContain("'member/' + encodeURIComponent(filerId) + '?' + trParams()");
    // Asset drawer subtitle carries the same window as its KPI section.
    expect(DASHBOARD_HTML).toContain("' approx. volume  |  ' + esc(tickerWindowLabel)");
    // Company drawer + Trends card: executive is in the default corpus, so
    // "Congressional" / "Congress Is Trading" would mislabel the numbers.
    expect(DASHBOARD_HTML).toContain('<h3>Activity (\' + esc(tickerWindowLabel) + \')</h3>');
    expect(DASHBOARD_HTML).not.toContain('Congressional Activity');
    expect(DASHBOARD_HTML).toContain('What Is Being Traded');
    expect(DASHBOARD_HTML).not.toContain('What Congress Is Trading');
  });

  it('names the benchmark once per surface and never prints SPX/SPY', () => {
    const visible = DASHBOARD_HTML
      // drop JS/CSS/HTML comments — those may still mention S&P for context.
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const mentions = visible.match(/S&amp;P|S&P/g) || [];
    expect(mentions.length).toBeLessThanOrEqual(4);
    // Rows/chips say "excess" instead of restating the index.
    expect(visible).not.toContain("% vs S&amp;P");
    expect(visible).not.toContain('avg excess vs S&amp;P');
    // Ticker symbols for the index are never user-visible.
    expect(visible).not.toMatch(/>[^<]*\b(SPX|SPY)\b/);
  });
});

/* ------------------------------------------------------------------------
 * Owner feedback 2026-08-11 (Filing Latency Comparison + executive titles):
 *   1. "it has minus signs for time ahead and time behind, lets make it have
 *      + sign and stay in red when behind on time"
 *   2. "N of M matched" with a plain-English note saying what M counts
 *   3. "ensure executive branch individuals have their shortest professionally
 *      formatted title shown … and don't say 'exec -' before that"
 * ---------------------------------------------------------------------- */

/** Extracts single-line `var NAME = …` declarations (the function extractor
 *  above only handles `function` blocks). */
function loadDashboardVars(names: string[]): string[] {
  return names.map((name) => {
    const match = DASHBOARD_HTML.match(new RegExp(`^var ${name} = [^\\n]*$`, 'm'));
    if (!match) throw new Error(`var ${name} was not found in DASHBOARD_HTML`);
    return match[0];
  });
}

function loadLeadHelpers() {
  const sources = loadDashboardFunctions([
    'esc',
    'fmtLead',
    'leadDirection',
    'leadSignChar',
    'leadArrowChar',
    'leadWord',
    'fmtLeadSigned',
    'leadDescription',
    'leadFigureHtml',
  ]);
  return new Function(
    sources.join('\n\n') +
      '\nreturn { fmtLead: fmtLead, leadDirection: leadDirection, fmtLeadSigned: fmtLeadSigned,' +
      ' leadDescription: leadDescription, leadFigureHtml: leadFigureHtml };',
  )() as {
    fmtLead: (s: number) => string;
    leadDirection: (s: number | null) => string;
    fmtLeadSigned: (s: number) => string;
    leadDescription: (s: number) => string;
    leadFigureHtml: (s: number, opts?: Record<string, unknown>) => string;
  };
}

const MINUS = '−'; // U+2212 MINUS SIGN, not a hyphen
const UP = '▲';
const DOWN = '▼';

describe('earlier/later lead figures (owner: no +/−, later red, earlier green)', () => {
  it('fmtLead is magnitude-only, so no caller can accidentally emit a bare hyphen', () => {
    const { fmtLead } = loadLeadHelpers();
    expect(fmtLead(82)).toBe('82 sec');
    expect(fmtLead(-82)).toBe('82 sec');
    expect(fmtLead(-5560)).toBe('1.5 hr');
    expect(fmtLead(1466)).toBe('24 min');
    for (const secs of [-1, -60, -3600, -90000, -900000]) {
      expect(fmtLead(secs)).not.toContain('-');
      expect(fmtLead(secs)).not.toContain(MINUS);
    }
  });

  it('uses earlier/later wording and never prints + or −', () => {
    const { fmtLeadSigned } = loadLeadHelpers();
    expect(fmtLeadSigned(1466)).toBe('24 min earlier');
    expect(fmtLeadSigned(-1466)).toBe('24 min later');
    expect(fmtLeadSigned(-34)).toBe('34 sec later');
    expect(fmtLeadSigned(-1466)).not.toContain('-');
    expect(fmtLeadSigned(-1466)).not.toContain(MINUS);
    expect(fmtLeadSigned(-1466)).not.toContain('+');
    expect(fmtLeadSigned(1466)).not.toContain('+');
    expect(fmtLeadSigned(0)).toBe('even');
  });

  it('classifies direction from the sign (positive = Congress.Trade first / earlier)', () => {
    const { leadDirection } = loadLeadHelpers();
    expect(leadDirection(1466)).toBe('ahead');
    expect(leadDirection(-34)).toBe('behind');
    expect(leadDirection(0)).toBe('even');
    expect(leadDirection(0.4)).toBe('even'); // sub-second rounds to even, not "ahead"
    expect(leadDirection(null)).toBe('even');
    expect(leadDirection(Number.NaN)).toBe('even');
  });

  it('later renders red via --lag, earlier green via --good — and neither relies on colour alone', () => {
    const { leadFigureHtml } = loadLeadHelpers();
    const behind = leadFigureHtml(-1466);
    const ahead = leadFigureHtml(1466);

    // Colour channel
    expect(behind).toContain('lead-fig lead-behind');
    expect(ahead).toContain('lead-fig lead-ahead');
    // Non-colour channels: magnitude, arrow glyph, and the literal word
    expect(behind).toContain('24 min');
    expect(behind).toContain(DOWN);
    expect(behind).toContain('>later<');
    expect(behind).not.toContain(MINUS);
    expect(behind).not.toContain('+');
    expect(ahead).toContain('24 min');
    expect(ahead).toContain(UP);
    expect(ahead).toContain('>earlier<');
    expect(ahead).not.toContain('+');
    // Screen readers get the whole sentence
    expect(behind).toContain('aria-label="');
    expect(behind).toContain('the provider published first.');
    expect(ahead).toContain('Congress.Trade published first.');
    // Arrows are decorative next to the word, so they are not announced twice
    expect(behind).toContain('class="lead-arrow" aria-hidden="true"');
  });

  it('keeps the word on compact table cells so +/− are never the only cue', () => {
    const { leadFigureHtml } = loadLeadHelpers();
    const compact = leadFigureHtml(-1466, { word: false });
    expect(compact).toContain('>later<');
    expect(compact).toContain('24 min');
    expect(compact).not.toContain(MINUS);
    expect(compact).not.toContain('+');
    expect(compact).toContain(DOWN);
    expect(compact).toContain('aria-label="');
    expect(compact).toContain('later');
  });

  it('.lead-behind is wired to a RED variable, not the neutral provider gray', () => {
    expect(DASHBOARD_HTML).toContain('.lead-fig.lead-behind { color:var(--lag); }');
    expect(DASHBOARD_HTML).toContain('.lead-fig.lead-ahead { color:var(--good); }');
    expect(DASHBOARD_HTML).toContain('.lead-inline.lead-ahead { color:var(--good); }');
    expect(DASHBOARD_HTML).toContain('.lead-inline.lead-behind { color:var(--lag); }');
    expect(DASHBOARD_HTML).toContain('.lead-fig.lead-behind .lead-val');
    expect(DASHBOARD_HTML).toContain('.lead-fig.lead-ahead .lead-val');
    // --lag aliases --sell (theme-following red); it is deliberately not --rival.
    expect(DASHBOARD_HTML).toMatch(/--lag:\s*var\(--sell\);/);
    expect(DASHBOARD_HTML).not.toContain('.lead-fig.lead-behind { color:var(--rival)');
    // The old colour-only, sign-dropping card number is gone for good.
    expect(DASHBOARD_HTML).not.toContain("var sign = isPos ? '+' : '';");
    expect(DASHBOARD_HTML).not.toContain('sp-lead-num');
  });

  it('every lead/lag figure in the scorecard + raw data table goes through the signed formatter', () => {
    // Card headline, median/P90 sublines, all three table columns, alerts strip.
    expect(DASHBOARD_HTML).toContain("leadFigureHtml(headline, { cls: 'lead-big' })");
    expect(DASHBOARD_HTML).toContain('leadFigureHtml(p.medianLeadSec, { word: false })');
    expect(DASHBOARD_HTML).toContain('leadFigureHtml(p.avgLeadSec, { word: false })');
    expect(DASHBOARD_HTML).toContain('leadFigureHtml(p.p90LeadSec, { word: false })');
    expect(DASHBOARD_HTML).toContain('leadFigureHtml(best.medianLeadSec, { word: false })');
    // setPricingProof is the one documented exception: prose that states the
    // direction in words, reachable only for a positive median.
    expect(DASHBOARD_HTML).toContain("'Right now: filings land here a median ' + fmtLead(best.medianLeadSec) + ' before '");
  });
});

function loadSpCardHtml() {
  const sources = [
    ...loadDashboardVars(['SPEED_LANE_MIN_MATCHED', 'SPEED_SCOPE_NOTE_DEFAULT']),
    ...loadDashboardFunctions([
      'esc',
      'fmtCount',
      'fmtLead',
      'leadDirection',
      'leadSignChar',
      'leadArrowChar',
      'leadWord',
      'leadVerdict',
      'leadInlineHtml',
      'fmtLeadSigned',
      'leadDescription',
      'leadFigureHtml',
      'spScopeCounts',
      'spScopeCountHtml',
      'spScopeHtml',
      'spScopeNoteHtml',
      'isLatencyComparisonPublic',
      'spVisibilityBadgeHtml',
      'spCardHtml',
    ]),
  ];
  return new Function(
    sources.join('\n\n') + '\nreturn { spCardHtml: spCardHtml, spScopeNoteHtml: spScopeNoteHtml };',
  )() as {
    spCardHtml: (p: Record<string, unknown>, admin?: boolean) => string;
    spScopeNoteHtml: (totals: Record<string, unknown> | null) => string;
  };
}

/** Unusual Whales' real 2026-08-11 shape: 8 matched, median +1466s but a mean
 *  of -34s dragged negative by one large outlier — i.e. a card that must show a
 *  RED, minus-signed headline sitting above a positive median. */
const UW_LIVE = {
  provider: 'unusual_whales',
  label: 'Unusual Whales',
  operationalStatus: 'running',
  candidates: 85,
  matched: 8,
  strongMatched: 8,
  providerObserved: 101,
  maturedProviderObserved: 82,
  unmatchedProvider: 82,
  comparisonStatus: 'preliminary',
  usFirstCount: 7,
  providerFirstCount: 1,
  tieCount: 0,
  medianLeadSec: 1466,
  avgLeadSec: -34,
  p90LeadSec: 1796,
};

describe('provider scorecard card (live Unusual Whales shape)', () => {
  it('headlines the MEDIAN, so one outlier race cannot flip the card against its own badge', () => {
    const { spCardHtml } = loadSpCardHtml();
    const html = spCardHtml(UW_LIVE);
    // avg is later while the median is earlier: never claim Lead.
    expect(html).toContain('>Mixed<');
    expect(html).not.toContain('Preliminary');
    expect(html).not.toContain('>Lead<');
    expect(html).toContain('lead-fig lead-ahead lead-big');
    expect(html).toContain('24 min');
    expect(html).toContain('lead-inline lead-ahead');
    expect(html).toContain('>earlier<');
    expect(html).not.toContain('+24 min');
    expect(html).toContain('typically <span class="lead-inline lead-ahead">earlier</span> than their feed on live imports (median)');
  });

  it('demotes the mean to a subline and paints it red later when it disagrees', () => {
    const { spCardHtml } = loadSpCardHtml();
    const html = spCardHtml(UW_LIVE);
    expect(html).toContain('Average: <span class="lead-fig lead-behind"');
    expect(html).toContain('34 sec');
    expect(html).toContain('>later<');
    expect(html).not.toContain(MINUS);
    expect(html).toContain(DOWN);
    expect(html).toContain('P90: <span class="lead-fig lead-ahead"');
    expect(html).toContain('30 min');
    expect(html).toContain('>earlier<');
    // The disagreement is stated in words rather than left to be spotted.
    expect(html).toContain('The average disagrees with the median here');
  });

  it('stays silent about the mean/median split when they agree', () => {
    const { spCardHtml } = loadSpCardHtml();
    const html = spCardHtml({ ...UW_LIVE, avgLeadSec: 1500, comparisonStatus: 'usable' });
    expect(html).not.toContain('The average disagrees with the median');
    expect(html).toContain('>Lead<');
    expect(html).not.toContain('Preliminary');
    expect(html).toContain('typically <span class="lead-inline lead-ahead">earlier</span> than their feed on live imports (median)');
  });

  it('renders a red later headline when the median says we were behind', () => {
    const { spCardHtml } = loadSpCardHtml();
    const html = spCardHtml({
      ...UW_LIVE, medianLeadSec: -2400, avgLeadSec: -3600, p90LeadSec: -30,
      usFirstCount: 1, providerFirstCount: 7, comparisonStatus: 'usable',
    });
    expect(html).toContain('lead-fig lead-behind lead-big');
    expect(html).toContain('40 min');
    expect(html).toContain('>later<');
    expect(html).toContain(DOWN);
    expect(html).not.toContain(MINUS);
    expect(html).not.toContain('+');
    expect(html).toContain('>Lag<');
    expect(html).not.toContain('Preliminary');
    expect(html).toContain('typically <span class="lead-inline lead-behind">later</span> than their feed on live imports (median)');
    expect(html).not.toContain('lead-inline lead-ahead');
  });

  it('marks admin cards Shown Publicly or Hidden From Public and stays quiet on the public card', () => {
    const { spCardHtml } = loadSpCardHtml();
    expect(spCardHtml(UW_LIVE)).not.toContain('Shown Publicly');
    expect(spCardHtml(UW_LIVE)).not.toContain('Hidden From Public');
    expect(spCardHtml(UW_LIVE, true)).toContain('Shown Publicly');
    expect(spCardHtml({ ...UW_LIVE, operationalStatus: 'error' }, true)).toContain('Hidden From Public');
    expect(spCardHtml({ ...UW_LIVE, operationalStatus: 'error' }, true)).not.toContain('Shown Publicly');
  });
});

describe('"N of M matched" scope line (denominator the matcher lane exposes)', () => {
  it('renders nothing at all while the scope fields are absent — never a substituted denominator', () => {
    const { spCardHtml, spScopeNoteHtml } = loadSpCardHtml();
    expect(spScopeNoteHtml(null)).toBe('');
    expect(spScopeNoteHtml({ racedDisclosures: 421, matched: 109, maturedProviderObserved: 567 })).toBe('');
    expect(spCardHtml(UW_LIVE)).not.toContain('sp-scope');
  });

  it('renders "N of M matched" plus the plain-English note once the fields arrive', () => {
    const { spScopeNoteHtml } = loadSpCardHtml();
    const html = spScopeNoteHtml({ scopeMatched: 3412, scopeTotal: 4102 });
    expect(html).toContain('<strong>3,412</strong> of <strong>4,102</strong> matched');
    // What M counts, in words, with the owner's two-space sentence gaps.
    expect(html).toContain('every filer we track');
    expect(html).toContain('all House and Senate members');
    expect(html).toContain('the President and Vice President');
    expect(html).toContain('Cabinet secretaries and agency heads');
    expect(html).toContain('matched.&nbsp; ');
  });

  it('honours a server-supplied scopeLabel override, escaped', () => {
    const { spScopeNoteHtml } = loadSpCardHtml();
    const html = spScopeNoteHtml({ scopeMatched: 1, scopeTotal: 2, scopeLabel: 'House only <b>x</b>' });
    expect(html).toContain('House only &lt;b&gt;x&lt;/b&gt;');
    expect(html).not.toContain('every filer we track');
  });

  it('shows a per-provider scope line only when that provider carries its own pair', () => {
    const { spCardHtml } = loadSpCardHtml();
    const html = spCardHtml({ ...UW_LIVE, scopeMatched: 41, scopeTotal: 102 });
    expect(html).toContain('<div class="sp-scope"><strong>41</strong> of <strong>102</strong> matched</div>');
  });

  it('rejects a nonsense denominator rather than printing "N of 0"', () => {
    const { spScopeNoteHtml } = loadSpCardHtml();
    expect(spScopeNoteHtml({ scopeMatched: 5, scopeTotal: 0 })).toBe('');
    expect(spScopeNoteHtml({ scopeMatched: 5, scopeTotal: -1 })).toBe('');
    expect(spScopeNoteHtml({ scopeMatched: 'x', scopeTotal: 10 })).toBe('');
    expect(spScopeNoteHtml({ scopeTotal: 10 })).toBe('');
  });

  it('both placements own a scope-note element that starts hidden', () => {
    expect(DASHBOARD_HTML).toContain('<p class="note sp-scope-note" id="spScopeNote" hidden></p>');
    expect(DASHBOARD_HTML).toContain('<p class="note sp-scope-note" id="spScopeNoteAdmin" hidden></p>');
    expect(DASHBOARD_HTML).toContain("paintSpeedSection('spGrid', 'speedTableBody', 'spScopeNote', publicProvs, speedScopeFromSummary(d), d.priceEdge, false)");
    expect(DASHBOARD_HTML).toContain("paintSpeedSection('spGridAdmin', 'speedTableBodyAdmin', 'spScopeNoteAdmin', adminProvs, speedScopeFromSummary(d), d.priceEdge, true)");
  });
});

function loadExecTitleHelpers() {
  const sources = [
    ...loadDashboardVars([
      'EXEC_TITLE_FORMS',
      'EXEC_TITLES',
      'EXEC_TITLES_SHORT',
      'EXEC_TITLE_FALLBACK',
      'EXEC_TITLE_FULL',
      'EXEC_TITLE_TIGHT',
    ]),
    ...loadDashboardFunctions([
      'chamberLabel',
      'ordinalSuffix',
      'fmtDistrictOrdinal',
      'isExecutiveFiler',
      'execTitleFor',
      'execTitleFit',
      'execDisplayTitle',
      'memberBranchBits',
      'memberBranchLabel',
    ]),
  ];
  return new Function(
    sources.join('\n\n') +
      '\nreturn { isExecutiveFiler: isExecutiveFiler, execTitleFor: execTitleFor, execTitleFit: execTitleFit,' +
      ' execDisplayTitle: execDisplayTitle, memberBranchBits: memberBranchBits, memberBranchLabel: memberBranchLabel,' +
      ' EXEC_TITLE_TIGHT: EXEC_TITLE_TIGHT, EXEC_TITLE_FULL: EXEC_TITLE_FULL };',
  )() as {
    isExecutiveFiler: (chamber: unknown, filerId?: unknown) => boolean;
    execTitleFor: (filerId: unknown) => string | null;
    execTitleFit: (title: unknown, maxChars: number) => string;
    execDisplayTitle: (filerId: unknown, curated?: unknown, maxChars?: number) => string;
    memberBranchBits: (o: Record<string, unknown>, maxTitleChars?: number) => string[];
    memberBranchLabel: (o: Record<string, unknown>, maxTitleChars?: number) => string;
    EXEC_TITLE_TIGHT: number;
    EXEC_TITLE_FULL: number;
  };
}

describe('executive titles in the dashboard (owner: "don\'t say \'exec -\' before that")', () => {
  it('inlines the shared title map instead of keeping a hand-copied one', () => {
    const { execTitleFor } = loadExecTitleHelpers();
    expect(execTitleFor('EXEC-BESSENT')).toBe('Treasury Secretary');
    expect(execTitleFor('EXEC-DJT')).toBe('President');
    expect(execTitleFor('EXEC-FRANK-J-BISIGNANO')).toBe('Social Security Commissioner');
    // Uncurated EXEC-* falls back; congressional filers get no title at all.
    expect(execTitleFor('EXEC-SOMEONE-NEW')).toBe('Executive Branch');
    expect(execTitleFor('house-tx10-jane-smith')).toBeNull();
    expect(execTitleFor('')).toBeNull();
  });

  it('picks the longest form that fits the caller budget', () => {
    const { execTitleFit } = loadExecTitleHelpers();
    expect(execTitleFit('Treasury Secretary', 28)).toBe('Treasury Secretary');
    expect(execTitleFit('Treasury Secretary', 16)).toBe('Treasury Sec.');
    expect(execTitleFit('Social Security Commissioner', 28)).toBe('Social Security Commissioner');
    expect(execTitleFit('Social Security Commissioner', 16)).toBe('SSA Commissioner');
    expect(execTitleFit('Executive Branch', 16)).toBe('Executive Branch');
    expect(execTitleFit('Executive Branch', 12)).toBe('Executive');
    // Never chopped mid-word, even when the short form still overflows.
    expect(execTitleFit('MCC Chief Executive Officer', 4)).toBe('MCC CEO');
  });

  it('matches the server helper (shared/executiveTitles.ts) form for form', async () => {
    const { execTitleFit } = loadExecTitleHelpers();
    const { EXECUTIVE_TITLES, fitExecutiveTitle } = await import('../../shared/executiveTitles.ts');
    for (const title of Object.values(EXECUTIVE_TITLES)) {
      for (const budget of [8, 12, 14, 16, 20, 28]) {
        expect(execTitleFit(title, budget)).toBe(fitExecutiveTitle(title, budget));
      }
    }
  });

  it('renders the position ALONE — no branch word in front of it, no state, no district', () => {
    const { memberBranchBits, memberBranchLabel, EXEC_TITLE_TIGHT } = loadExecTitleHelpers();
    // EXEC-MCCORMICK really does carry a state in `filers`; it must not leak.
    const bits = memberBranchBits({
      chamber: 'executive', filerId: 'EXEC-BESSENT', state: 'SC', district: '3',
    });
    expect(bits).toEqual(['Treasury Secretary']);
    expect(bits.join(' · ')).not.toMatch(/exec/i);
    expect(memberBranchLabel({ chamber: 'executive', filerId: 'EXEC-BESSENT' }, EXEC_TITLE_TIGHT))
      .toBe('Treasury Sec.');
    expect(memberBranchLabel({ chamber: 'oge', filerId: 'EXEC-DJT' })).toBe('President');
  });

  it('prefers the server-supplied title field when the payload carries one', () => {
    const { execDisplayTitle, memberBranchBits } = loadExecTitleHelpers();
    expect(execDisplayTitle('EXEC-BRAND-NEW', 'Commerce Secretary')).toBe('Commerce Secretary');
    expect(memberBranchBits({ chamber: 'executive', filerId: 'EXEC-BRAND-NEW', title: 'Commerce Secretary' }))
      .toEqual(['Commerce Secretary']);
  });

  it('never emits the fallback as a PREFIX to a real title', () => {
    const { execDisplayTitle } = loadExecTitleHelpers();
    for (const id of ['EXEC-BESSENT', 'EXEC-DJT', 'EXEC-SEAN-DUFFY', 'EXEC-SARA-BAILEY']) {
      for (const budget of [10, 14, 20, 28]) {
        const label = execDisplayTitle(id, null, budget);
        expect(label.startsWith('Executive')).toBe(false);
        expect(label).not.toMatch(/^exec\b/i);
        expect(label).not.toMatch(/^(exec|executive)\s*[-–—]/i);
      }
    }
    // Uncurated filers may still say "Executive Branch" — but only on its own.
    expect(execDisplayTitle('EXEC-NOBODY', null, 28)).toBe('Executive Branch');
  });

  it('leaves congressional rows exactly as they were', () => {
    const { memberBranchBits, memberBranchLabel } = loadExecTitleHelpers();
    expect(memberBranchBits({ chamber: 'house', filerId: 'H001', state: 'CA', district: '17' }))
      .toEqual(['House', 'CA - 17th']);
    expect(memberBranchBits({ chamber: 'senate', filerId: 'S001', state: 'PA' }))
      .toEqual(['Senate', 'PA']);
    expect(memberBranchLabel({ chamber: 'house', filerId: 'H001' })).toBe('House');
  });

  it('treats an EXEC-* filer as executive even when the chamber column is blank', () => {
    const { isExecutiveFiler, memberBranchBits } = loadExecTitleHelpers();
    expect(isExecutiveFiler('', 'EXEC-DJT')).toBe(true);
    expect(isExecutiveFiler('house', 'H001')).toBe(false);
    expect(memberBranchBits({ chamber: '', filerId: 'EXEC-DJT' })).toEqual(['President']);
  });

  it('every render site of a filer descriptor goes through the shared helpers', () => {
    // Trades card row 2, Trends politician leaderboard, top-late-filers list,
    // People directory, politician drawer.
    expect(DASHBOARD_HTML).toContain('var chamber = memberBranchLabel(r, EXEC_TITLE_TIGHT);');
    expect(DASHBOARD_HTML).toContain('var metaBits = memberBranchBits(r, EXEC_TITLE_FULL).join');
    expect(DASHBOARD_HTML).toContain('var p = memberBranchBits({ chamber: m.chamber, filerId: m.filerId, title: m.title, state: m.state })');
    expect(DASHBOARD_HTML).toContain('if (isExecutiveFiler(m.chamber, m.filerId)) {');
    expect(DASHBOARD_HTML).toContain('var isExec = isExecutiveFiler(p.chamber, filerId);');
    expect(DASHBOARD_HTML).toContain('execDisplayTitle(filerId, p.title, EXEC_TITLE_FULL)');
    // The old hard-coded bare-word fallback is gone.
    expect(DASHBOARD_HTML).not.toContain("parts.push(esc(m.title ? String(m.title) : 'Executive'));");
    // And a district never tags along behind an executive position.
    expect(DASHBOARD_HTML).toContain("if (!isExec && p.district) subBits.push(");
  });
});

describe('desktop chrome 2026-08-16 (filters, CSV, Delivery, admin)', () => {
  it('paints a solid white header through the sticky filters', () => {
    expect(DASHBOARD_HTML).toContain('html[data-theme="light"] header.top {\n    background: #fff;');
    expect(DASHBOARD_HTML).not.toContain('html[data-theme="light"] header.top { background: rgba(255,255,255,.72); }');
    // Owner 2026-09-09: the filters sit INSIDE header.top (row 2 of its
    // grid), so the header's own white paints behind them — no separate
    // full-bleed strip to keep in sync.
    expect(DASHBOARD_HTML).not.toContain('html[data-theme="light"] .trades-toolbars');
    expect(DASHBOARD_HTML).not.toContain('width: 100vw;');
    expect(DASHBOARD_HTML).not.toContain('margin-left: calc(50% - 50vw);');
    expect(DASHBOARD_HTML).not.toContain('width: calc(100% + 2 * var(--ct-main-pad, 35px));');
    expect(DASHBOARD_HTML).toContain('#ctFilters .trades-toolbars {\n    position: static; width: auto; max-width: none; margin: 0; padding: 0;\n    background: transparent; flex: 1 1 auto; min-width: 0;');
    expect(DASHBOARD_HTML).toContain('border-bottom: none; background: var(--panel);');
    expect(DASHBOARD_HTML).toContain(':root { --ct-main-pad: 14px; }');
    expect(DASHBOARD_HTML).toContain('main { padding: 0 var(--ct-main-pad, 35px) var(--ct-main-pad, 35px);');
    expect(DASHBOARD_HTML).toContain('#view-people, #view-review, #view-subs, #view-admin {\n    padding-top: var(--ct-main-pad, 35px);');
    expect(DASHBOARD_HTML).toContain('function syncChromeMetrics()');
    expect(DASHBOARD_HTML).toContain("document.documentElement.style.setProperty('--ct-header-h'");
    expect(DASHBOARD_HTML).toContain("document.documentElement.style.setProperty('--ct-main-pad'");
    expect(DASHBOARD_HTML).toContain('getComputedStyle(mainEl).paddingLeft');
  });

  it('defines showView so account-menu Delivery / Admin / Review actually switch tabs', () => {
    expect(DASHBOARD_HTML).toContain('function showView(name, scrollId)');
    expect(DASHBOARD_HTML).toContain('showView(\\\'subs\\\')">Delivery');
    expect(DASHBOARD_HTML).not.toContain('Delivery & Alerts');
    expect(DASHBOARD_HTML).not.toContain('showView(\\\'subs\\\')">Push Notifications');
  });

  it('keeps the CSV dialog off the hidden Trades view so showModal works from Trends', () => {
    const tradesOpen = DASHBOARD_HTML.indexOf('id="view-trades"');
    const tradesClose = DASHBOARD_HTML.indexOf('id="view-trends"');
    const dialog = DASHBOARD_HTML.indexOf('id="exportCsvDialog"');
    expect(dialog).toBeGreaterThan(tradesClose);
    expect(dialog).toBeGreaterThan(tradesOpen);
    expect(DASHBOARD_HTML).toContain('if (d.parentElement && d.parentElement !== document.body) document.body.appendChild(d);');
  });

  it('lists Admin + Review in the account menu only when canUseAdmin() is true', () => {
    // Premium alone must never grant Admin / Review Queue (owner directive).
    expect(DASHBOARD_HTML).toContain('function adminMenuHtml(closeCall) {\n  // Premium alone never grants Admin / Review Queue');
    expect(DASHBOARD_HTML).toContain('if (!canUseAdmin()) return \'\'');
    expect(DASHBOARD_HTML).toContain('showView(\\\'admin\\\')">Admin');
    expect(DASHBOARD_HTML).toContain('showView(\\\'review\\\')">Review Queue');
    expect(DASHBOARD_HTML).not.toContain('Admin Sign-In');
    expect(DASHBOARD_HTML).not.toContain('openAdminTokenDialog');
  });

  it('never force-unhides an admin-gated tab for a non-admin caller of showView()', () => {
    expect(DASHBOARD_HTML).toContain(
      "if (btn.getAttribute('data-admin-tab') === 'true' && !canUseAdmin()) {\n    showToast('Admin access required.', true);\n    return;\n  }",
    );
  });

  it('blocks a signed-in non-admin from activating an admin-gated tab, not just a signed-out visitor', () => {
    expect(DASHBOARD_HTML).not.toContain(
      "if (b.getAttribute('data-admin-tab') === 'true' && !canUseAdmin() && !ME.user && !hasAdminToken())",
    );
    expect(DASHBOARD_HTML).toContain(
      "if (b.getAttribute('data-admin-tab') === 'true' && !canUseAdmin()) {\n      if (ME.user) { showToast('Admin access required.', true); } else { openLogin(); }\n      return;\n    }",
    );
  });

  it('falls back a direct ?view=admin/?view=review boot navigation to Trends for a non-admin', () => {
    expect(DASHBOARD_HTML).toContain(
      "if (initialViewBtn && initialViewBtn.getAttribute('data-admin-tab') === 'true' && !canUseAdmin()) {\n      initialView = 'trends';\n    }",
    );
  });

  it('links admins to the A/B/C/D ticker logo jury', () => {
    expect(DASHBOARD_HTML).toContain('href="/api/admin/logo-jury"');
  });

  it('uses fat mask arrows with green up and red down on the side filter', () => {
    expect(DASHBOARD_HTML).toContain('.side-up, .side-dn, .side-ex {');
    expect(DASHBOARD_HTML).toContain('.side-up {\n    color: var(--buy);');
    expect(DASHBOARD_HTML).toContain('.side-dn {\n    color: var(--sell);');
    expect(DASHBOARD_HTML).toContain('mask-image: url("data:image/svg+xml');
  });
});

describe('iOS filter menus stay usable (overflow + menu-row chrome)', () => {
  it('clears leftover chip overflow so Parties and Trade Type can open', () => {
    expect(DASHBOARD_HTML).toContain('.ios-filter.party-chips,\n  .ios-filter.side-chips,\n  .ios-filter.branch-filters {');
    expect(DASHBOARD_HTML).toContain('display: inline-flex; overflow: visible; border: none; border-radius: 0;');
    expect(DASHBOARD_HTML).toContain('function placeIosFilterPop(btn, pop)');
    expect(DASHBOARD_HTML).toContain("pop.style.position = 'fixed'");
  });

  it('paints Branches / Parties / Sides menu rows as a list, not leftover chips', () => {
    expect(DASHBOARD_HTML).toContain('.ios-filter .ios-filter-item.branch-toggle,\n  .ios-filter .ios-filter-item.party-chip,\n  .ios-filter .ios-filter-item.side-chip {');
    expect(DASHBOARD_HTML).toContain('min-width: 0; height: auto; min-height: 0; justify-content: flex-start;');
    expect(DASHBOARD_HTML).toContain('.ios-filter .ios-filter-item.branch-toggle + .ios-filter-item.branch-toggle');
  });

  it('does not fill dropdown rows or the closed pill with toggle-blue', () => {
    expect(DASHBOARD_HTML).toContain('.ios-filter-item.on { background: transparent; font-weight: 600; }');
    expect(DASHBOARD_HTML).toContain('.ios-filter-item.on::after { content: "✓";');
    // Active filter = accent ink + faint wash on the closed chip (owner
    // 2026-09-09), never the solid toggle-blue fill.
    expect(DASHBOARD_HTML).toContain('.ios-filter.has-sel .ios-filter-btn {\n    border-color: color-mix(in srgb, var(--accent) 55%, var(--border));\n    color: var(--accent);\n    background: color-mix(in srgb, var(--accent) 8%, var(--panel));');
    expect(DASHBOARD_HTML).not.toContain('.ios-filter-item.on { background: color-mix(in srgb, var(--accent) 18%, transparent); font-weight: 600; }');
    expect(DASHBOARD_HTML).not.toContain('.ios-filter.has-sel .ios-filter-btn { background: var(--accent); color: #fff; border-color: var(--accent); }');
  });
});

/**
 * Issues #1529 + #1459 — web adopts remaining iOS language.
 * Capitol Ledger (#1459 style option) was removed in #2016.
 */
describe('iOS language + Capitol Ledger harvest (issues #1529 / #1459)', () => {
  function extractFn(html: string, name: string): string {
    const marker = 'function ' + name + '(';
    const start = html.indexOf(marker);
    if (start < 0) throw new Error('function not found in DASHBOARD_HTML: ' + name);
    const braceStart = html.indexOf('{', start);
    let depth = 0;
    let i = braceStart;
    for (; i < html.length; i++) {
      if (html[i] === '{') depth++;
      else if (html[i] === '}') {
        depth--;
        if (depth === 0) return html.slice(start, i + 1);
      }
    }
    throw new Error('unbalanced braces for ' + name);
  }

  it('drops the Capitol Ledger style option and does not leave a Standard-only toggle', () => {
    expect(DASHBOARD_HTML).not.toContain("localStorage.getItem('ui-style')");
    expect(DASHBOARD_HTML).not.toContain('function styleRowHtml()');
    expect(DASHBOARD_HTML).not.toContain("id: 'ledger', label: 'Capitol Ledger'");
    expect(DASHBOARD_HTML).not.toContain('styleRowHtml() +');
    expect(DASHBOARD_HTML).not.toContain('html[data-style="ledger"]');
    expect(DASHBOARD_HTML).not.toContain('Capitol Ledger');
    expect(DASHBOARD_HTML).toContain('themeRowHtml() +');
  });

  it('restores Light/Dark/System as a labeled segmented control', () => {
    expect(DASHBOARD_HTML).toContain("themeIconSvg(o.id) + o.label + '</button>'");
    expect(DASHBOARD_HTML).not.toContain("themeIconSvg(o.id) + '</button>'");
    expect(DASHBOARD_HTML).toContain("aria-label=\"Set theme to ' + o.label + '\" title=\"' + o.label + '\"");
    expect(DASHBOARD_HTML).toContain('.ios-filter-btn::after {');
  });

  it('paints party-colored rings on politician avatars without touching the account photo', () => {
    // Inset ::after, not outer box-shadow — parent overflow:hidden was
    // slicing the 2px spread so the ring never closed the circle.
    expect(DASHBOARD_HTML).toContain('.avatar.party-D::after { border: 2px solid var(--party-d); }');
    expect(DASHBOARD_HTML).toContain('.avatar.party-R::after { border: 2px solid var(--party-r); }');
    expect(DASHBOARD_HTML).toContain('.avatar.party-O::after { border: 2px solid var(--party-o); }');
    expect(DASHBOARD_HTML).toContain('.avatar.party-D::after,');
    expect(DASHBOARD_HTML).not.toContain('.avatar.party-D { box-shadow: 0 0 0 2px var(--party-d);');
    expect(DASHBOARD_HTML).not.toContain('.avatar.party-R { box-shadow: 0 0 0 2px var(--party-r);');
    expect(DASHBOARD_HTML).not.toContain('.avatar.party-O { box-shadow: 0 0 0 2px var(--party-o);');
    expect(DASHBOARD_HTML).toContain('function partyBucketClass(raw)');
    expect(DASHBOARD_HTML).toContain('function memberAvatarHtml(name, photoUrl, party, decorative)');
    expect(DASHBOARD_HTML).toContain('.acct .avatar.lg { width:28px; height:28px; cursor:pointer; border-color:transparent; }');
    const src = [
      extractFn(DASHBOARD_HTML, 'esc'),
      extractFn(DASHBOARD_HTML, 'initials'),
      extractFn(DASHBOARD_HTML, 'partyBucketClass'),
      extractFn(DASHBOARD_HTML, 'memberAvatarHtml'),
      'return memberAvatarHtml;',
    ].join('\n');
    const memberAvatarHtml = new Function(src)() as (name: string, photoUrl: string, party?: string, decorative?: boolean) => string;
    expect(memberAvatarHtml('Nancy Pelosi', 'https://example.com/p.jpg', 'Democrat')).toContain('party-D');
    expect(memberAvatarHtml('Some Republican', '', 'R')).toContain('party-R');
    expect(memberAvatarHtml('Guest', '', '')).not.toMatch(/party-[DRO]/);
  });

  it('makes the avatar decorative when a call site already has its own adjacent visible name text (WEBA11Y P2: duplicate mobile trade-card name)', () => {
    // Removing tradesCardHtml()'s name-replacing aria-label (WEBA11Y-02) means
    // the card's accessible name is now built from its visible content —
    // which put memberAvatarHtml()'s own fallback initials text, and the
    // <img alt> when a photo loaded, RIGHT NEXT TO the sibling .fc-member
    // name text in that concatenated name: a screen reader heard the name
    // once for the avatar and again for the visible text. decorative=true
    // drops the avatar out of the accessible name entirely (alt="" +
    // aria-hidden) wherever a sibling already names it visibly.
    const src = [
      extractFn(DASHBOARD_HTML, 'esc'),
      extractFn(DASHBOARD_HTML, 'initials'),
      extractFn(DASHBOARD_HTML, 'partyBucketClass'),
      extractFn(DASHBOARD_HTML, 'memberAvatarHtml'),
      'return memberAvatarHtml;',
    ].join('\n');
    const memberAvatarHtml = new Function(src)() as (name: string, photoUrl: string, party?: string, decorative?: boolean) => string;
    const decorative = memberAvatarHtml('Nancy Pelosi', 'https://example.com/p.jpg', 'D', true);
    expect(decorative).toContain('aria-hidden="true"');
    expect(decorative).toContain('alt=""');
    expect(decorative).not.toContain('alt="Nancy Pelosi"');
    // Default (no 4th arg, or explicitly false) stays named — the cluster-
    // card face strip (loadTrClusters()) has no adjacent name text, so the
    // photo/initials remain the ONLY identifier there.
    const named = memberAvatarHtml('Nancy Pelosi', 'https://example.com/p.jpg', 'D');
    expect(named).not.toContain('aria-hidden="true"');
    expect(named).toContain('alt="Nancy Pelosi"');
    // Every render call site with an adjacent visible name passes true.
    const decorativeCallSites = [
      "memberAvatarHtml(r.member, r.photoUrl, r.party || r.partyBucket, true)", // memberCellHtml (desktop feed table)
      "memberAvatarHtml(member, r.photoUrl, r.party || r.partyBucket, true)", // tradesCardHtml (mobile card — the reported bug)
      "memberAvatarHtml(name, m.photoUrl, m.party, true) + '<span class=\"cell-clip\"", // People directory row
      "memberAvatarHtml(name, r.photoUrl, r.partyBucket, true)", // Trends member leaderboards (Top Performers / Most Active)
      "memberAvatarHtml(name, m.photoUrl, m.party, true) + '<div>'", // Disclosure-lag member table
      "memberAvatarHtml(name, m.photoUrl, m.partyBucket, true) + ' ' + pdot(m.partyBucket) + esc(name)", // asset-drawer Recent Trades member cell
      "memberAvatarHtml(name, p.photoUrl, p.partyBucket || p.party, true)", // member-drawer header (<h2> name alongside it)
      "memberAvatarHtml(fmtName(row.member), row.photoUrl, row.party, true)", // trade-drawer person card
    ];
    for (const snippet of decorativeCallSites) {
      expect(DASHBOARD_HTML, `expected decorative avatar call: ${snippet}`).toContain(snippet);
    }
    // The one call site that intentionally stays named: the cluster-card
    // face strip has no adjacent name text at all.
    expect(DASHBOARD_HTML).toContain('var av = memberAvatarHtml(m.fullName, m.photoUrl, m.partyBucket || m.party);');
  });

  it('does not mask mobile trade card content with a name-replacing aria-label (WEBA11Y-02)', () => {
    const fn = extractFn(DASHBOARD_HTML, 'tradesCardHtml');
    // No aria-label on the card: it used to collapse the accessible name down
    // to just "Open trade details for TICKER by NAME", hiding the visible
    // Buy/Sell badge, amount bracket and date from screen-reader users. The
    // card's own content (assetCellHtml + actionBadge + amountCellHtml +
    // date) now becomes the accessible name instead.
    expect(fn).not.toContain('aria-label="Open trade details for');
    expect(fn).toContain(
      String.raw`<article class="trades-card clickable" tabindex="0" role="button" data-txid="' + esc(r.id) + '" title="Open trade details">`,
    );
    // The action hint is appended as a visually-hidden suffix instead of
    // replacing the name.
    expect(fn).toContain('<span class="fc-hint">Open trade details</span>');
    expect(DASHBOARD_HTML).toContain('.fc-hint { position: absolute;');
  });

  it('surfaces owner, relative filed time, and the iOS politician line on mobile trade cards', () => {
    const fn = extractFn(DASHBOARD_HTML, 'tradesCardHtml');
    expect(fn).toContain("ident.push(esc(chamber) + ' · ' + esc(member))");
    expect(fn).toContain('fc-owner');
    expect(fn).toContain('relativeTimeText');
    expect(fn).toContain('memberAvatarHtml(member, r.photoUrl, r.party || r.partyBucket, true)');
    expect(DASHBOARD_HTML).toContain('party: tx.party || \'\'');
    const relSrc = [
      'function dateText(s) { return String(s || ""); }',
      extractFn(DASHBOARD_HTML, 'relativeTimeText'),
      'return relativeTimeText;',
    ].join('\n');
    const relativeTimeText = new Function(relSrc)() as (s: string) => string;
    expect(relativeTimeText(new Date().toISOString())).toMatch(/just now|m ago|h ago/);
    expect(relativeTimeText('1999-01-01')).toBe('1999-01-01');
  });

  it('keeps halt and review chrome off Trends and Trades', () => {
    expect(DASHBOARD_HTML).not.toContain('id="extractIncidentBanner"');
    expect(DASHBOARD_HTML).not.toContain('Extraction Review Backlog');
    expect(DASHBOARD_HTML).not.toContain('Extraction Halted');
    expect(DASHBOARD_HTML).not.toContain('Acknowledge Halt');
    expect(DASHBOARD_HTML).not.toContain('function acknowledgeExtractionHalt()');
    expect(DASHBOARD_HTML).not.toContain('/api/admin/autopilot/acknowledge');
    expect(DASHBOARD_HTML).not.toContain('id="extractIncidentAck"');
    const trendsStart = DASHBOARD_HTML.indexOf('id="view-trends"');
    const peopleStart = DASHBOARD_HTML.indexOf('id="view-people"');
    const tradesStart = DASHBOARD_HTML.indexOf('id="view-trades"');
    const adminStart = DASHBOARD_HTML.indexOf('id="view-admin"');
    expect(adminStart).toBeGreaterThan(tradesStart);
    expect(DASHBOARD_HTML.slice(trendsStart, peopleStart)).not.toContain('extractHaltDetail');
    expect(DASHBOARD_HTML.slice(tradesStart, trendsStart)).not.toContain('extractHaltDetail');
    expect(DASHBOARD_HTML).toContain('id="reviewTabBadge"');
    expect(DASHBOARD_HTML).toContain('id="adminTabBadge"');
  });

  it('shows Review and Admin nav badges without an Acknowledge Halt control', () => {
    function extractFn(html: string, name: string): string {
      const marker = 'function ' + name + '(';
      const start = html.indexOf(marker);
      if (start < 0) throw new Error('function not found: ' + name);
      const braceStart = html.indexOf('{', start);
      let depth = 0;
      let i = braceStart;
      for (; i < html.length; i++) {
        if (html[i] === '{') depth++;
        else if (html[i] === '}') {
          depth--;
          if (depth === 0) return html.slice(start, i + 1);
        }
      }
      throw new Error('unbalanced braces for ' + name);
    }
    type BadgeNode = {
      hidden: boolean;
      disabled: boolean;
      textContent: string;
      classList: {
        toggle: (name: string, on?: boolean) => void;
        add: (name: string) => void;
        remove: (name: string) => void;
        _on: Record<string, boolean>;
      };
      setAttribute: (k: string, v: string) => void;
      attrs: Record<string, string>;
    };
    const makeNodes = (): Record<string, BadgeNode> => {
      const node = (): BadgeNode => ({
        hidden: true,
        disabled: true,
        textContent: '',
        classList: {
          _on: {},
          toggle(name: string, on?: boolean) {
            this._on[name] = !!on;
          },
          add(name: string) {
            this._on[name] = true;
          },
          remove(name: string) {
            this._on[name] = false;
          },
        },
        attrs: {},
        setAttribute(k: string, v: string) {
          this.attrs[k] = v;
        },
      });
      return {
        reviewTabBadge: node(),
        adminTabBadge: node(),
      };
    };
    const factory = new Function(
      'nodes',
      'admin',
      [
        'function canUseAdmin() { return !!admin; }',
        'function el(id) { return nodes[id] || null; }',
        extractFn(DASHBOARD_HTML, 'setTabBadge'),
        extractFn(DASHBOARD_HTML, 'renderExtractionIncident'),
        'return renderExtractionIncident;',
      ].join('\n'),
    ) as (nodes: Record<string, BadgeNode>, admin: boolean) => (
      health: unknown,
      autopilot: unknown,
    ) => void;

    const backlogHealth = {
      pipeline: {
        checks: [
          { id: 'autopilot_halt', status: 'ok', detail: 'ok' },
          { id: 'extraction_backlog', status: 'error', value: 151, detail: '151 unresolved' },
        ],
        reviewQueue: { unresolved: 151, eligible: 24, suppressed: 76, terminal: 51 },
      },
    };
    const haltHealth = {
      pipeline: {
        checks: [
          { id: 'autopilot_halt', status: 'error', detail: 'Autopilot is halted on error_class:auth.' },
        ],
        reviewQueue: { unresolved: 12, eligible: 4, suppressed: 4, terminal: 4 },
      },
    };

    const publicNodes = makeNodes();
    factory(publicNodes, false)(backlogHealth, null);
    expect(publicNodes.reviewTabBadge.hidden).toBe(true);
    expect(publicNodes.adminTabBadge.hidden).toBe(true);

    const adminBacklog = makeNodes();
    factory(adminBacklog, true)(backlogHealth, null);
    expect(adminBacklog.reviewTabBadge.hidden).toBe(false);
    expect(adminBacklog.reviewTabBadge.textContent).toBe('99+');
    expect(adminBacklog.adminTabBadge.hidden).toBe(true);

    const stalledBacklogNodes = makeNodes();
    factory(stalledBacklogNodes, true)({
      pipeline: {
        checks: [
          { id: 'autopilot_halt', status: 'ok', detail: 'ok' },
          { id: 'extraction_provider', status: 'stalled', detail: 'No extraction attempts in 24h while review backlog is 151' },
          { id: 'extraction_backlog', status: 'error', value: 151, detail: '151 unresolved' },
        ],
        reviewQueue: { unresolved: 151, eligible: 24, suppressed: 76, terminal: 51 },
      },
    }, null);
    expect(stalledBacklogNodes.adminTabBadge.hidden).toBe(true);

    const stalledHalt = makeNodes();
    factory(stalledHalt, true)({
      pipeline: {
        checks: [
          { id: 'autopilot_halt', status: 'error', detail: 'Autopilot runs halted: stalled' },
        ],
        reviewQueue: { unresolved: 3, eligible: 1, suppressed: 1, terminal: 1 },
      },
    }, null);
    expect(stalledHalt.adminTabBadge.hidden).toBe(false);

    const adminHalt = makeNodes();
    factory(adminHalt, true)(haltHealth, null);
    expect(adminHalt.reviewTabBadge.textContent).toBe('12');
    expect(adminHalt.adminTabBadge.hidden).toBe(false);
    expect(adminHalt.adminTabBadge.textContent).toBe('1');
  });

  it('puts member photos on the People directory and does not add Largest Buys/Sells on Trends', () => {
    expect(DASHBOARD_HTML).toContain("memberAvatarHtml(name, m.photoUrl, m.party, true) + '<span class=\"cell-clip\"");
    expect(DASHBOARD_HTML).not.toContain('id="trLargestBuys"');
    expect(DASHBOARD_HTML).not.toContain('id="trLargestSells"');
    expect(DASHBOARD_HTML).not.toContain('id="trExtremes"');
    expect(DASHBOARD_HTML).not.toContain('Largest Buys');
    expect(DASHBOARD_HTML).not.toContain('Largest Sells');
    expect(DASHBOARD_HTML).not.toContain('function loadTrExtremes()');
    expect(DASHBOARD_HTML).toContain('loadTrSummary(); loadTrTickers();');
    expect(DASHBOARD_HTML).not.toContain('loadTrExtremes()');
  });
});

describe('mobile web chrome polish (issue #2016)', () => {
  it('keeps Trends and Trades filters on one nowrap row with a content-sized timeframe', () => {
    expect(DASHBOARD_HTML).toContain('#view-trends #trendsSharedFilters[data-filter-mirror] { display: none !important; }');
    expect(DASHBOARD_HTML).toContain('#ctFilters #tradesSharedFilters {\n      display: flex; flex-wrap: nowrap; align-items: center; gap: 6px;\n      overflow-x: auto; overflow-y: visible; scrollbar-width: none;');
    expect(DASHBOARD_HTML).toContain('field-sizing:content');
    expect(DASHBOARD_HTML).toContain('>3 Months</option>');
    expect(DASHBOARD_HTML).not.toContain('>Past 3 Months</option>');
    expect(DASHBOARD_HTML).not.toContain('#view-trends .toolbar .trends-filter-row { width: 100%; }');
    // Full-bleed filter bar must not be overridden back to shrink-to-fit.
    expect(DASHBOARD_HTML).not.toContain('align-items: center;\n    width: auto;\n    max-width: 100%;');
    // Sepia was removed (owner 2026-08-21) — only Light/Dark theme this row.
    expect(DASHBOARD_HTML).not.toContain('html[data-theme="sepia"] nav.tabs');
    expect(DASHBOARD_HTML).toContain('html[data-theme="dark"] nav.tabs');
  });

  it('removes Snapshot and the Largest Buys/Sells sections', () => {
    expect(DASHBOARD_HTML).not.toContain('>Snapshot<');
    expect(DASHBOARD_HTML).not.toContain('class="tf-cap"');
    expect(DASHBOARD_HTML).not.toContain('Largest Buys');
    expect(DASHBOARD_HTML).not.toContain('Largest Sells');
    expect(DASHBOARD_HTML).toContain('fold-cue');
    expect(DASHBOARD_HTML).not.toContain('Not an exact figure.');
    expect(DASHBOARD_HTML).toContain('id="trKpis"');
  });

  it('compacts Sort, right-aligns the pager, and parks Rows/Export in the top band', () => {
    expect(DASHBOARD_HTML).toContain('.trades-sort-mobile #mobileSortKey { flex: 0 0 auto; width: auto;');
    expect(DASHBOARD_HTML).toContain('.pager-controls { display:flex; flex:0 0 auto;');
    expect(DASHBOARD_HTML).toContain('margin-left:auto;');
    expect(DASHBOARD_HTML).toContain('.pager-bottom .pager-tools { display: none; }');
    expect(DASHBOARD_HTML).toContain('.pager-top .feed-options { display: none; }');
    const topPager = DASHBOARD_HTML.match(/<div class="row-flex pager pager-top"[\s\S]*?<div class="row-flex pager pager-bottom"/);
    expect(topPager).not.toBeNull();
    expect(topPager![0]).toContain('id="tradesSortMobile"');
    expect(topPager![0]).toContain('id="mobileSortKey"');
    expect(topPager![0]).toContain('data-page-size');
    expect(topPager![0]).toContain('Export CSV');
  });

  it('keeps a single Upgrade control and no Style row in the account menus', () => {
    expect(DASHBOARD_HTML).toContain("onclick=\"openPricing()\">Upgrade</button>");
    expect(DASHBOARD_HTML).not.toContain('Upgrade to Premium</button>');
    expect(DASHBOARD_HTML).not.toContain('style-row');
    expect(DASHBOARD_HTML).not.toContain('data-style-opt');
  });
});

describe('remove Largest Buys/Sells from Trends (issue #2019)', () => {
  it('drops the extremes sections and loader, and keeps metric cards plus side filters', () => {
    const trendsStart = DASHBOARD_HTML.indexOf('id="view-trends"');
    const peopleStart = DASHBOARD_HTML.indexOf('id="view-people"');
    const trends = DASHBOARD_HTML.slice(trendsStart, peopleStart);
    expect(trends).not.toContain('Largest Buys');
    expect(trends).not.toContain('Largest Sells');
    expect(trends).not.toContain('id="trExtremes"');
    expect(trends).toContain('id="trKpis"');
    expect(trends).toContain('id="trSideGroup"');
    expect(trends).toContain('data-side="B"');
    expect(trends).toContain('data-side="S"');
    expect(DASHBOARD_HTML).not.toContain('function loadTrExtremes()');
    expect(DASHBOARD_HTML).toContain('function loadTrends()');
    expect(DASHBOARD_HTML).toContain('loadTrSummary(); loadTrTickers();');
  });
});

/**
 * Regression cover for the LIVE mobile tab bar bug: PR #2075 swapped the
 * view tabs from <button> to <a href> for crawlability, which silently
 * dropped the UA button's auto-centered label (an <a> inherits
 * text-align:start), leaving every icon/label flush left in its fixed-dock
 * grid cell on mobile.  Also covers the two owner-requested chrome fixes
 * that shipped alongside the fix: the six-tab (signed-in admin) dock
 * shrinking to fit instead of assuming four tabs, and the mobile hamburger
 * button becoming the account avatar for signed-in users with a photo.
 */
describe('mobile tab bar centering (#2075 regression) + six-tab shrink + avatar hamburger', () => {
  it('gives nav.tabs a a real text-align:center in the base (all-widths) rule, not just the mobile media query', () => {
    expect(DASHBOARD_HTML).toContain(
      'A <button> centers its label via the UA stylesheet; an <a> inherits',
    );
    const navTabsA = DASHBOARD_HTML.slice(
      DASHBOARD_HTML.indexOf('nav.tabs a {'),
      DASHBOARD_HTML.indexOf('nav.tabs a:hover'),
    );
    expect(navTabsA).toContain('text-align: center;');
  });

  it('shrinks the six-tab (signed-in admin) mobile dock via the html.ct-admin gate rather than assuming four tabs', () => {
    // Owner 2026-09-09: admin tabs are gated on html.ct-admin (set by
    // applyAdminVisibility() from canUseAdmin()), so the six-tab shrink keys
    // off the same class — no [hidden] :has() probe, no extra JS.
    expect(DASHBOARD_HTML).toContain('html.ct-admin nav.tabs a {');
    expect(DASHBOARD_HTML).toContain('html.ct-admin nav.tabs a::before {');
    expect(DASHBOARD_HTML).toContain('html.ct-admin nav.tabs a::after {');
    expect(DASHBOARD_HTML).not.toContain('nav.tabs:has(a[data-admin-tab]:not([hidden]))');
    expect(DASHBOARD_HTML).toContain('font-size: clamp(8px, 2.3vw, 9px);');
    // The default badge offset (right: max(4px, calc(50% - 22px))) assumes
    // the four-tab ~97.5px cell and crowds the centered icon on six ~53-65px
    // cells, so the six-tab case pins it to a fixed corner inset instead.
    expect(DASHBOARD_HTML).toContain('html.ct-admin nav.tabs .tab-count-badge,');
    expect(DASHBOARD_HTML).toContain('right: 3px;');
    // Measured live at 390px and 320px (Chrome DevTools MCP, six tabs
    // visible, see .review-shots/tabbar/after-{390,320}-6tab.png): the
    // longest data-mobile label ("Directory", 9 chars) renders at ~40.6px
    // (390px viewport, 63px available) and ~36.7px (320px viewport, 51.3px
    // available) — comfortably one line at the clamp's own floor, so
    // text-overflow:ellipsis on nav.tabs a::after stays a last resort for
    // pathological cases, not the normal six-tab render path.
    expect(DASHBOARD_HTML).toContain(
      'nav.tabs a::after { content: attr(data-mobile) / ""; display: block; font-size: 10px; line-height: 1.1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
    );
  });

  function extractFn(html: string, name: string): string {
    const marker = 'function ' + name + '(';
    const start = html.indexOf(marker);
    if (start < 0) throw new Error('function not found in DASHBOARD_HTML: ' + name);
    const braceStart = html.indexOf('{', start);
    let depth = 0;
    let i = braceStart;
    for (; i < html.length; i++) {
      if (html[i] === '{') depth++;
      else if (html[i] === '}') {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      }
    }
    return html.slice(start, i);
  }

  function loadAccountSandbox(): (me: unknown) => string {
    const html = DASHBOARD_HTML;
    const src = [
      'var CAPTURED_HTML = "";',
      'function el(id) { if (id !== "acct") return null; return { set innerHTML(v) { CAPTURED_HTML = v; }, get innerHTML() { return CAPTURED_HTML; } }; }',
      'var ME = { user: null, entitlement: {} };',
      'function checkoutConfigured() { return false; }',
      'function themeRowHtml() { return ""; }',
      'function adminMenuHtml() { return ""; }',
      'function acctMobileDisclaimerHtml() { return ""; }',
      'function canManageSubscription() { return false; }',
      extractFn(html, 'esc'),
      extractFn(html, 'initials'),
      extractFn(html, 'renderAccount'),
      'return function (me) { ME.user = me; ME.entitlement = (me && me.entitlement) || {}; renderAccount(); return CAPTURED_HTML; };',
    ].join('\n');
    // eslint-disable-next-line no-new-func -- executing the real shipped source, see comment above
    const factory = new Function(src);
    return factory() as (me: unknown) => string;
  }

  // Isolate just the <button id="acctHamburgerBtn">...</button> markup so
  // assertions can't accidentally match the desktop avatar menu button,
  // which renders the same avatar markup elsewhere in the signed-in case.
  function hamburgerButtonHtml(fullHtml: string): string {
    const idIdx = fullHtml.indexOf('id="acctHamburgerBtn"');
    const btnStart = fullHtml.lastIndexOf('<button', idIdx);
    const btnEnd = fullHtml.indexOf('</button>', idIdx) + '</button>'.length;
    return fullHtml.slice(btnStart, btnEnd);
  }

  function loadAdminMenuSandbox(): (me: { email?: string; admin?: { allowed: boolean } } | null) => string {
    const html = DASHBOARD_HTML;
    const src = [
      'var ME = { user: null, admin: { allowed: false } };',
      extractFn(html, 'canUseAdmin'),
      extractFn(html, 'adminMenuHtml'),
      'return function (me) { ME.user = me; ME.admin = (me && me.admin) || { allowed: false }; return adminMenuHtml(""); };',
    ].join('\n');
    // eslint-disable-next-line no-new-func -- executing the real shipped source, see comment above
    const factory = new Function(src);
    return factory() as (me: { email?: string; admin?: { allowed: boolean } } | null) => string;
  }

  it('shows Admin + Review Queue only for a real admin — Premium alone never grants them', () => {
    const render = loadAdminMenuSandbox();

    const premiumNonAdmin = render({ email: 'premium@example.com', admin: { allowed: false } });
    expect(premiumNonAdmin).not.toContain('>Admin</button>');
    expect(premiumNonAdmin).not.toContain('>Review Queue</button>');
    expect(premiumNonAdmin).not.toContain('Admin Sign-In');

    const admin = render({ email: 'admin@example.com', admin: { allowed: true } });
    expect(admin).toContain('>Admin</button>');
    expect(admin).toContain('>Review Queue</button>');
    expect(admin).not.toContain('Admin Sign-In');

    expect(render(null)).toBe('');
  });

  it('renders the 3-bar hamburger glyph on the mobile hamburger button for signed-out visitors', () => {
    const render = loadAccountSandbox();
    const btn = hamburgerButtonHtml(render(null));
    // Owner 2026-09-21 punch list: replaced the unicode ☰ (whose non-centered
    // glyph metrics pushed the lines off-center inside the circle) with 3
    // custom-drawn span bars rendered by .acct-hamburger-bars.
    expect(btn).toContain('class="acct-hamburger-bars"');
    expect(btn).not.toContain('&#9776;');
    expect(btn).not.toContain('<img');
    expect(btn).toContain('aria-label="Account menu"');
    expect(btn).toContain('aria-expanded="false"');
    expect(btn).toContain('aria-controls="acctMobileMenu"');
  });

  it('renders the account avatar <img> on the hamburger button for a signed-in user with a picture', () => {
    const render = loadAccountSandbox();
    const btn = hamburgerButtonHtml(
      render({ name: 'Jay Wedgeworth', email: 'jay@example.com', picture: 'https://example.com/photo.jpg' }),
    );
    expect(btn).not.toContain('acct-hamburger-bars');
    expect(btn).not.toContain('&#9776;');
    expect(btn).toContain('<img src="https://example.com/photo.jpg" alt="" onerror="this.remove()"');
    // Initials render underneath the photo (same DOM as the desktop avatar),
    // so the existing onerror="this.remove()" degrades to initials, not an
    // empty circle, if the photo URL ever 404s.
    expect(btn).toContain('>JW<img');
    expect(btn).toContain('aria-label="Account menu"');
  });

  it('falls back to the initials avatar (not the glyph) on the hamburger button for a signed-in user with no picture', () => {
    // Chosen fallback for signed-in + no ME.user.picture: reuse the same
    // initials avatar as the photo case (not the ☰ glyph) for a consistent
    // "you are signed in" affordance on mobile.
    const render = loadAccountSandbox();
    const btn = hamburgerButtonHtml(render({ name: 'Jay Wedgeworth', email: 'jay@example.com' }));
    expect(btn).not.toContain('&#9776;');
    expect(btn).not.toContain('<img');
    expect(btn).toContain('class="avatar lg"');
    expect(btn).toContain('>JW</span>');
    expect(btn).toContain('aria-label="Account menu"');
  });

  it('keeps .acct-hamburger a real <button> with a >=44x44 tap target and stable aria wiring regardless of content', () => {
    expect(DASHBOARD_HTML).toContain(
      '<button type="button" class="acct-hamburger" id="acctHamburgerBtn" aria-expanded="false" aria-controls="acctMobileMenu" aria-label="Account menu" onclick="toggleAcctMobileMenu()">',
    );
    expect(DASHBOARD_HTML).toContain('.acct-hamburger {\n    width:44px; height:44px;');
  });
});

describe('web frontend bug fixes, accessibility enhancements, and mobile polish', () => {
  it('routes common politician names and mixed-case queries to memberName rather than ticker', () => {
    const chamberAll = DASHBOARD_HTML.match(/var CHAMBER_ALL = \[[^\]]*\];/);
    const polDict = DASHBOARD_HTML.match(/var COMMON_POLITICIAN_NAMES = \{[\s\S]*?\n\};/);
    if (!chamberAll || !polDict) throw new Error('Declarations not found in DASHBOARD_HTML');
    const [applySearchToServerParamsSrc] = loadDashboardFunctions(['applySearchToServerParams']);
    const factory = new Function(
      'US_STATE_ABBR',
      'US_STATE_NAME_TO_ABBR',
      [chamberAll[0], polDict[0], applySearchToServerParamsSrc].join('\n\n') + '\nreturn applySearchToServerParams;',
    );
    const applySearchToServerParams = factory({}, {}) as (p: URLSearchParams, q: string) => void;

    // Common politician names -> memberName, not ticker
    for (const name of ['Brown', 'brown', 'BROWN', 'Scott', 'scott', 'SCOTT', 'Young', 'young', 'YOUNG', 'Pelosi', 'Nancy Pelosi']) {
      const p = new URLSearchParams();
      applySearchToServerParams(p, name);
      expect(p.get('memberName'), `Expected "${name}" to set memberName`).toBe(name);
      expect(p.has('ticker'), `Expected "${name}" not to set ticker`).toBe(false);
    }

    // Explicit all-uppercase ticker symbols not in politician list -> ticker
    for (const tkr of ['AAPL', 'NVDA', 'TSLA', 'MSFT', 'GOOGL']) {
      const p = new URLSearchParams();
      applySearchToServerParams(p, tkr);
      expect(p.get('ticker'), `Expected "${tkr}" to set ticker`).toBe(tkr);
      expect(p.has('memberName'), `Expected "${tkr}" not to set memberName`).toBe(false);
    }

    // Multi-token: name + ticker
    const pMulti = new URLSearchParams();
    applySearchToServerParams(pMulti, 'Pelosi NVDA');
    expect(pMulti.get('memberName')).toBe('Pelosi');
    expect(pMulti.get('ticker')).toBe('NVDA');
  });

  it('includes viewport-fit=cover in the dashboard viewport meta tag', () => {
    expect(DASHBOARD_HTML).toContain('<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />');
  });

  it('keeps badge contrast per theme: Buy is white on light mode\'s deep green, dark ink on dark mode\'s bright green (owner 2026-09-09)', () => {
    expect(DASHBOARD_HTML).toMatch(/\.tag\.B,\s*\.tag\.P\s*\{[^}]*color:\s*#fff/);
    expect(DASHBOARD_HTML).toContain('html[data-theme="dark"] .tag.B, html[data-theme="dark"] .tag.P { color: #080c17; }');
    expect(DASHBOARD_HTML).toMatch(/\.tag\.E\s*\{[^}]*color:\s*#080c17/);
  });

  it('provides accessibility attributes (th scope="col", aria-sort, role="button", tabindex="0") on secondary and directory table headers', () => {
    expect(DASHBOARD_HTML).toContain('<tr id="peopleHead">');
    expect(DASHBOARD_HTML).toContain('<tr id="assetsHead">');
    expect(DASHBOARD_HTML).toMatch(/<th[^>]*scope="col"[^>]*data-sort="name"[^>]*aria-sort="none"[^>]*tabindex="0"[^>]*role="button"/);
    expect(DASHBOARD_HTML).toContain('syncAssetsSortIndicators');
    expect(DASHBOARD_HTML).toContain("th.setAttribute('aria-sort', ASSETS_SORT.dir > 0 ? 'ascending' : 'descending');");
    expect(DASHBOARD_HTML).toMatch(/<table id="tableTrTrending">[\s\S]*?<th scope="col"/);
  });

  it('formats usdC currency without negative zero', () => {
    const [usdCSrc] = loadDashboardFunctions(['usdC']);
    const usdC = new Function(usdCSrc + '\nreturn usdC;')() as (n: number) => string;

    expect(usdC(0)).toBe('$0');
    expect(usdC(-0)).toBe('$0');
    expect(usdC(-0.01)).toBe('$0');
    expect(usdC(-0.4)).toBe('$0');
    expect(usdC(-1000)).toBe('-$1.0k');
    expect(usdC(1500000)).toBe('$1.5m');
  });

  it('locks body scroll when drawers and modals are opened', () => {
    expect(DASHBOARD_HTML).toContain('body.drawer-open { overflow: hidden; }');
    expect(DASHBOARD_HTML).toContain('syncBodyScrollLock()');
  });

  it('debounces directory search by 150ms and syncs directory mode and query to URL', () => {
    expect(DASHBOARD_HTML).toContain('directorySearchTimer = setTimeout(');
    expect(DASHBOARD_HTML).toContain('150);');
    expect(DASHBOARD_HTML).toContain('syncDirectoryUrl()');
    expect(DASHBOARD_HTML).toContain("u.searchParams.set('dmode', DIRECTORY_MODE)");
  });
});

// ---- owner 2026-09-08: header/filter chrome on the content column + Trends
// flow-row polish (bigger labels, "total volume" on the bar edge, "net
// volume", wider bullet gaps, justified stats line). ------------------------
describe('web chrome column + Trends flow rows (owner 2026-09-08)', () => {
  it('binds header.top and the sticky filter chips to the active view content column', () => {
    expect(DASHBOARD_HTML).toContain(':root { --ct-header-h: 100px; --ct-main-pad: 35px; --trends-gap: 24px; --ct-col-max: 1730px; }');
    expect(DASHBOARD_HTML).toContain('html[data-view="trends"] { --ct-col-max: 1280px; }');
    expect(DASHBOARD_HTML).toContain('<html lang="en" data-view="trends">');
    // Owner 2026-09-21 punch list: top padding 5px, bottom padding 14px.
    expect(DASHBOARD_HTML).toContain('padding: 5px max(var(--ct-main-pad, 35px), calc(50% - var(--ct-col-max, 1730px) / 2)) 14px;');
    expect(DASHBOARD_HTML).not.toContain('padding: 14px 35px 4px;');
    // Owner 2026-09-09: the filter row is header.top grid row 2 (right of
    // the wordmark, under the tabs) — it inherits the header's column pads,
    // so the old 100vw breakout strip and its inverse pad are gone.
    expect(DASHBOARD_HTML).toContain('header.top #ctFilters {\n    grid-column: 2 / -1; grid-row: 2;');
    expect(DASHBOARD_HTML).not.toContain('margin-left: calc(50% - 50vw);');
    expect(DASHBOARD_HTML).not.toContain('padding: 4px calc(50vw - 50%) 10px;');
    expect(DASHBOARD_HTML).not.toContain('position: sticky; top: var(--ct-header-h, 100px); z-index: 9;');
    // Tab switch + boot-time restore keep html[data-view] in sync, and the
    // head bootstrap stamps a deep-linked / remembered view before first paint.
    expect(DASHBOARD_HTML).toContain("document.documentElement.setAttribute('data-view', b.dataset.view);");
    expect(DASHBOARD_HTML).toContain("document.documentElement.setAttribute('data-view', initialView);");
    expect(DASHBOARD_HTML).toContain("if (!v) { try { v = localStorage.getItem('ct-active-tab'); } catch (e2) {} }");
    expect(DASHBOARD_HTML).toContain("if (v === 'trades' || v === 'people' || v === 'subs' || v === 'review' || v === 'admin') {\n        document.documentElement.setAttribute('data-view', v);");
  });


  it('enlarges the wordmark on desktop and keeps the compact 40px lockup on phones', () => {
    // Owner 2026-09-21 punch list: 15% larger wordmark (400 → 460 on desktop,
    // 368 → 423 at >=1100px, 280 → 322 on phones).
    expect(DASHBOARD_HTML).toContain('.brand-logo { width:min(460px, 30vw); height:auto; max-width:100%; object-fit:contain;');
    // >=1100px: never narrower than the 423px default filter row.
    expect(DASHBOARD_HTML).toContain('@media (min-width: 1100px) { .brand-logo { width:clamp(423px, 30vw, 460px); } }');
    // Intrinsic size attributes so the 5:1 box is known before the PNG loads
    // (no header-height jump for the sticky filter offset).
    expect(DASHBOARD_HTML).toContain('alt="Congress.Trade" width="1670" height="334" decoding="async" />');
    // Both phone blocks carry the reset: the <=768px grid header and the
    // <=768px / coarse-pointer block (anchored on their neighbouring rules).
    // Phones: the wordmark fills the brand cell up to 322px; the <=768px
    // grid block, the <=768px / coarse block and phone-chrome all carry it.
    expect(DASHBOARD_HTML).toContain('    .brand-logo { width:322px; max-width:100%; height:auto; }');
    expect(DASHBOARD_HTML).toContain('html.phone-chrome .brand-logo { width:322px; max-width:100%; height:auto; }');
    expect(DASHBOARD_HTML).not.toContain('.brand-logo { width:auto; height:40px;');
    expect(DASHBOARD_HTML).toContain(':root { --ct-header-h: 62px; --ct-main-pad: 12px; }');
  });

  it('steps Trends card titles up to 18px, a step above the 15px flow-row labels', () => {
    expect(DASHBOARD_HTML).toMatch(/#view-trends details\.trends-fold > summary \{\n(?:  \/\*[\s\S]*?\*\/\n)?  font-size: 18px;\n  font-weight: 650;/);
    // Every card heading is the same size — the phone-only 14px shrink of the
    // What Is Being Traded / Buys vs Sells titles is gone (owner 2026-09-08).
    expect(DASHBOARD_HTML).not.toContain('.tchart-summary-title { font-size: 14px; }');
    // Nested Lag Distribution / Slowest Filers captions do not grow with them.
    expect(DASHBOARD_HTML).toContain('#view-trends .timeliness-panel > h3 {\n  font-size: 14px;');
    // Phones: labels/figures a notch smaller so a 375px card still fits.
    expect(DASHBOARD_HTML).toContain('    .flowrow .flabel { font-size: 14px; }');
  });

  it('labels flow-row figures "total volume" / "net volume" and widens every bullet gap', () => {
    // Three spaces each side; the one regular space (before the bullet) is
    // the only break opportunity, so a wrapped line starts with the bullet.
    expect(DASHBOARD_HTML).toContain("var SEP_DOT = '\\u00a0\\u00a0 •\\u00a0\\u00a0\\u00a0';");
    expect(DASHBOARD_HTML).toContain("function totalVolumeHtml(n) { return '<span class=\"fval-k\">total volume</span> ' + estUsd(n); }");
    expect(DASHBOARD_HTML).toContain("'net volume ' + netHtml(r.estNetFlowUsd)");
    expect(DASHBOARD_HTML).toContain("'net volume ' + netHtml(v.estNetFlowUsd)");
    expect(DASHBOARD_HTML).not.toContain("•\\u00a0\\u00a0net ' + netHtml(");
    // Each stat is its own flex item, joined by a plain space (no bullets).
    expect(DASHBOARD_HTML).toContain("'<span class=\"fstat\">' + h + '</span>'; }).join(' ') + '</div>'");
    expect(DASHBOARD_HTML).toContain("flowChipHtml([esc(buySellText(r.buyCount, r.sellCount)), esc(polFull(r.uniqueMembers)), esc(assetFull(r.uniqueTickers)),");
    expect(DASHBOARD_HTML).toContain("flowChipHtml([esc(buySellText(v.buys, v.sells)), esc(polFull(v.members)), 'net volume ' + netHtml(v.estNetFlowUsd)])");
    // The " / " inside a buys/sells pair keeps its two NBSPs each side.
    expect(DASHBOARD_HTML).toContain("'\\u00a0\\u00a0/\\u00a0\\u00a0' + fmtCount(sells) + ' sell'");
    expect(DASHBOARD_HTML).toContain('5+ buys&nbsp;&nbsp; &bull;&nbsp;&nbsp;&nbsp;stocks only&nbsp;&nbsp; &bull;&nbsp;&nbsp;&nbsp;+/-200% cap per trade');
  });
});

// ---- owner 2026-09-08: Committee Sector Conflicts — names + committees first,
// the rest on hover or via the row click into the politician's drawer. -------
describe('Committee Sector Conflicts table (owner 2026-09-08)', () => {
  it('uses a fixed-layout colgroup so the committee text cannot balloon the table', () => {
    expect(DASHBOARD_HTML).toContain('<table class="conflicts-table" id="tableTrConflicts">');
    expect(DASHBOARD_HTML).toContain('<colgroup><col class="c-pol"><col class="c-com"><col class="c-sec"><col class="c-ast"><col class="c-side"><col class="c-est"></colgroup>');
    expect(DASHBOARD_HTML).toContain('#view-trends .conflicts-table { table-layout: fixed; width: 100%; min-width: 768px; }');
    expect(DASHBOARD_HTML).toContain('#view-trends .conflicts-table .c-pol { width: 23%; }');
    expect(DASHBOARD_HTML).toContain('#view-trends .conflicts-table .c-com { width: 32%; }');
    expect(DASHBOARD_HTML).toContain('#view-trends .conflicts-table .c-sec { width: 17%; }');
    expect(DASHBOARD_HTML).toContain('@media (max-width: 768px) { #view-trends .conflicts-table th, #view-trends .conflicts-table td { padding-left: 8px; padding-right: 8px; } }');
    // The generic Trends "squeeze the name cell" rule is lifted for this table.
    expect(DASHBOARD_HTML).toContain('#view-trends .conflicts-table td:has(.member-cell) { width: auto; max-width: none; }');
    expect(DASHBOARD_HTML).toContain('#view-trends .conflicts-table td.est, #view-trends .conflicts-table th.est { text-align: right; }');
  });

  it('renders committees one per line, clamped to two, with the full list in the tooltip', () => {
    expect(DASHBOARD_HTML).toContain("function shortCommittee(name) {\n  return String(name || '').replace(/^(House|Senate) Committee on (?:the )?/i, '$1 ');");
    expect(DASHBOARD_HTML).toContain('function committeeCellHtml(list, extraAttrs) {');
    expect(DASHBOARD_HTML).toContain("if (all.length > 2) lines[1] += ' <span class=\"more\">+' + (all.length - 2) + ' more</span>';");
    expect(DASHBOARD_HTML).toContain("' title=\"' + esc(all.join('\\n')) + '\">'");
    expect(DASHBOARD_HTML).toContain('#view-trends .conflicts-table .committee-lines { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }');
    expect(DASHBOARD_HTML).toContain('#view-trends .conflicts-table td.committees { white-space: normal; line-height: 1.35; }');
    // The old comma-joined nowrap cell is gone.
    expect(DASHBOARD_HTML).not.toContain("var committees = Array.isArray(r.viaCommittees) ? r.viaCommittees.join(', ')");
  });

  it('opens the politician drawer from any cell except the ticker, which keeps its company link', () => {
    expect(DASHBOARD_HTML).toContain("var rowMember = r.filerId ? ' data-member=\"' + esc(r.filerId) + '\"' : '';");
    expect(DASHBOARD_HTML).toContain("return '<tr class=\"row conflict-row\">' +\n        '<td' + rowMember + '><div' + memberAttr + ' title=\"' + esc(name) + '\"><span class=\"name-line\">' + esc(name) + '</span></div></td>' +\n        committeeCellHtml(r.viaCommittees, rowMember) +");
    expect(DASHBOARD_HTML).toContain("'<td class=\"muted sector\"' + rowMember + ' title=\"' + esc(r.sector || '') + '\">' + esc(r.sector || '—') + '</td>' +");
    // Asset cell: no data-member, so [data-asset] resolves for the ticker.
    expect(DASHBOARD_HTML).toContain("'<td>' + (r.ticker\n          ? '<span class=\"clickable\" data-asset=\"' + esc(r.ticker) + '\">' + esc(asset) + '</span>'");
    expect(DASHBOARD_HTML).toContain("'<td class=\"est\"' + rowMember + '>' + estUsd(r.estAmountUsd) + '</td></tr>';");
    expect(DASHBOARD_HTML).toContain('#view-trends .conflicts-table tbody tr.conflict-row td[data-member] { cursor: pointer; }');
    expect(DASHBOARD_HTML).toContain('Hover a committee cell for the full list; click a row for the politician.');
  });
});

/**
 * Owner 2026-09-09: header chrome rework — filters right of the logo (one
 * row shared by Trades + Trends), one control radius across tabs / chips /
 * selects / search / account, admin tabs gated on html.ct-admin, ST-style
 * sign-in buttons, and a single-row phone pager band.
 */
describe('header chrome rework (owner 2026-09-09)', () => {
  it('moves the shared filter row into header.top beside the wordmark and mirrors state on Trends', () => {
    const document = parse(DASHBOARD_HTML);
    const header = document.querySelector('header.top');
    expect(header).not.toBeNull();
    const kids = header!.childNodes.filter((n) => n.nodeType === 1).map((n: any) => n.tagName.toLowerCase() + (n.id ? '#' + n.id : '') + (n.classList.contains('brand') ? '.brand' : '') + (n.classList.contains('tabs') ? '.tabs' : ''));
    expect(kids).toEqual(['a.brand', 'nav.tabs', 'div#acct', 'div#ctFilters']);
    // Brand is a real link home (Trends) — no more inert div.
    const brand = document.querySelector('header.top a.brand');
    expect(brand?.getAttribute('href')).toBe('/?view=trends');
    expect(brand?.getAttribute('onclick')).toContain("showView('trends')");
    // The whole #tradesToolbars block moved as-is: ids / handlers unchanged,
    // Reset chip is the last child of the group.
    const ctf = document.querySelector('#ctFilters');
    expect(ctf?.getAttribute('role')).toBe('group');
    const ctfKids = ctf!.childNodes.filter((n) => n.nodeType === 1).map((n: any) => n.id);
    expect(ctfKids).toEqual(['tradesToolbars', 'ctFilterReset']);
    expect(document.querySelector('#ctFilters #tradesSharedFilters #tradesGlobalWindow')).not.toBeNull();
    expect(document.querySelector('#ctFilters #tradesSharedFilters #qChamber .ios-filter-btn')).not.toBeNull();
    expect(document.querySelector('#ctFilters #tradesExtraFilters #qSearchField #qSearch')).not.toBeNull();
    expect(document.querySelector('#ctFilters #qMember')?.getAttribute('type')).toBe('hidden');
    expect(document.querySelector('#view-trades #tradesToolbars')).toBeNull();
    // Trends keeps its ids as a hidden mirror (trParams()/getTrWindow() read them).
    const mirror = document.querySelector('#view-trends #trendsSharedFilters');
    expect(mirror?.getAttribute('hidden')).not.toBeNull();
    expect(mirror?.getAttribute('aria-hidden')).toBe('true');
    expect(mirror?.hasAttribute('data-filter-mirror')).toBe(true);
    expect(document.querySelector('#trendsSharedFilters #trGlobalWindow')).not.toBeNull();
    expect(DASHBOARD_HTML).toContain("var ch = chamberParam('trChamber');");
    // Two-row header grid: brand spans both rows, tabs row 1, filters row 2;
    // hidden on views without filters; search hidden on Trends.
    expect(DASHBOARD_HTML).toContain('grid-template-columns: auto minmax(0, 1fr) auto;\n    grid-template-rows: var(--control-h, 34px) minmax(var(--control-h, 34px), auto);\n    row-gap: 12px; column-gap: 24px;');
    expect(DASHBOARD_HTML).toContain('header.top .brand { grid-column: 1; grid-row: 1 / 3; align-self: center;');
    expect(DASHBOARD_HTML).toContain('header.top #acct { grid-column: 3; grid-row: 1; justify-self: end; }');
    expect(DASHBOARD_HTML).toContain('nav.tabs { display: flex; gap: 4px; margin-left: 0; flex-wrap: nowrap; align-self: center; grid-column: 2; grid-row: 1; }');
    expect(DASHBOARD_HTML).toContain('html:not([data-view="trades"]):not([data-view="trends"]) #ctFilters { display: none; }');
    expect(DASHBOARD_HTML).toContain('html[data-view="trends"] #tradesExtraFilters { display: none; }');
    // Codex P2 on #2353: the phone-block `#ctFilters #tradesExtraFilters { display:flex }`
    // (2,0,0) outranked that hide (1,1,1) — the Trades search stayed visible on
    // Trends for phones / coarse tablets.  ID-ID hide keeps it off there too.
    expect(DASHBOARD_HTML).toContain('html[data-view="trends"] #ctFilters #tradesExtraFilters { display: none; }');
    expect(DASHBOARD_HTML).toContain('#view-trades, #view-trends { padding-top: 16px; }');
    // Header still sticky, and never gets a transform/filter (fixed popovers).
    expect(DASHBOARD_HTML).toContain('position: sticky; top: 0; z-index: 10;\n    width: 100%; box-sizing: border-box;');
    // Laptop + small-window fallbacks.
    expect(DASHBOARD_HTML).toContain('@media (max-width: 1332px) {\n    header.top { column-gap: 16px; }');
    expect(DASHBOARD_HTML).toContain('@media (min-width: 769px) and (max-width: 999px) and (hover: hover) {');
    expect(DASHBOARD_HTML).toContain('header.top #ctFilters { grid-column: 1 / -1; grid-row: 2; }');
  });

  it('shares one control radius across tabs, chips, selects, search, account and pager', () => {
    expect(DASHBOARD_HTML).toContain('--radius-ctl:  8px;');
    expect(DASHBOARD_HTML).toContain('height: var(--control-h, 34px); box-sizing: border-box; padding: 0 13px; border-radius: var(--radius-ctl);');
    expect(DASHBOARD_HTML).toContain('border: 1px solid var(--border); border-radius: var(--radius-ctl);\n    background: var(--panel); color: var(--text);');
    expect(DASHBOARD_HTML).not.toContain('border: 1px solid var(--border); border-radius: 999px;\n    background: var(--panel); color: var(--text);');
    expect(DASHBOARD_HTML).toContain('border-radius:var(--radius-ctl); overflow:hidden; background:var(--panel-2);');
    expect(DASHBOARD_HTML).toContain('border-radius:var(--radius-ctl); height:var(--control-h, 34px); box-sizing:border-box; padding:0 10px 0 3px;');
    expect(DASHBOARD_HTML).toContain('border-radius: var(--radius-ctl); overflow: hidden; width:auto; height: var(--control-h, 34px);');
    // Popovers / menus keep the larger card radius.
    expect(DASHBOARD_HTML).toContain('padding: 6px; border-radius: var(--radius);');
    expect(DASHBOARD_HTML).toContain('.ios-filter-btn[aria-expanded="true"] { border-color: var(--accent); background: var(--panel-2); }');
    // Desktop shortens the admin tab labels to their data-mobile text.
    // Short label is decorative (alt "") so the accessible name stays
    // "Review Queue" / "Admin · Cadence"; the full text is the tooltip.
    expect(DASHBOARD_HTML).toContain('@media (min-width: 769px) and (hover: hover) {\n    nav.tabs a[data-admin-tab] { font-size: 0; }\n    nav.tabs a[data-admin-tab]::before { content: attr(data-mobile) / ""; font-size: 13px; }');
    expect(DASHBOARD_HTML).toContain('data-admin-tab="true" title="Review Queue" hidden aria-label="Review Queue"><span aria-hidden="true">Review Queue');
    expect(DASHBOARD_HTML).toContain('data-admin-tab="true" title="Admin · Cadence" hidden aria-label="Admin · Cadence"><span aria-hidden="true">Admin · Cadence');
    // Laptop widths: the filter row may wrap instead of overflowing its track;
    // the search field has no inline min-width:0 so its 180px floor applies.
    expect(DASHBOARD_HTML).toContain('grid-template-rows: var(--control-h, 34px) minmax(var(--control-h, 34px), auto);');
    expect(DASHBOARD_HTML).toContain('@media (max-width: 1199px) {\n    #ctFilters .trades-toolbars { flex-wrap: wrap; row-gap: 8px; }');
    expect(DASHBOARD_HTML).toContain('<span class="icon-field" id="qSearchField">');
    expect(DASHBOARD_HTML).toContain('.ios-filter-lbl { display: inline-block; max-width: 120px; overflow: hidden; text-overflow: ellipsis;');
    expect(DASHBOARD_HTML).toContain('#qChamber .ios-filter-lbl, #trChamber .ios-filter-lbl { max-width: 176px; }');
    expect(DASHBOARD_HTML).toContain("if (lbl) { lbl.textContent = text || ''; lbl.title = text || ''; }");
  });

  it('gates Review / Admin chrome on html.ct-admin set from canUseAdmin()', () => {
    expect(DASHBOARD_HTML).toContain('html:not(.ct-admin) [data-admin-tab="true"], html:not(.ct-admin) [data-admin-only] { display: none !important; }');
    expect(DASHBOARD_HTML).toContain("document.documentElement.classList.toggle('ct-admin', allowed);");
    // showView() no longer force-unhides an admin tab; the boot path runs the
    // gate before /auth/me resolves so anon never sees admin chrome.
    expect(DASHBOARD_HTML).not.toContain("if (btn.getAttribute('data-admin-tab') === 'true') btn.hidden = false;");
    expect(DASHBOARD_HTML).toContain('applyAdminVisibility(); // anon default: html.ct-admin off until /auth/me says otherwise\nloadMe().then(function () {');
    const document = parse(DASHBOARD_HTML);
    for (const id of ['tab-review', 'tab-admin']) {
      const a = document.querySelector('#' + id);
      expect(a?.getAttribute('data-admin-tab')).toBe('true');
      expect(a?.getAttribute('hidden')).not.toBeNull();
    }
  });

  it('shapes the sign-in buttons like Socratic.Trade (full-width, left-aligned mark + 19px label)', () => {
    expect(DASHBOARD_HTML).toContain('.auth-btn, .auth-btn.gbtn, .gbtn, .auth-btn.abtn, .abtn, .auth-btn.xbtn, .xbtn {\n    display:inline-flex; align-items:center; justify-content:flex-start; text-align:left; gap:12px;\n    width:100%; height:44px; min-height:44px; padding:0 16px; box-sizing:border-box;\n    border:1px solid var(--border); border-radius:10px;\n    font-size:19px; font-weight:500; line-height:1;');
    expect(DASHBOARD_HTML).toContain('.auth-btn svg { width:20px; height:20px; flex:0 0 20px; }');
    expect(DASHBOARD_HTML).not.toContain('justify-content:center; gap:10px; width:100%; height:44px;');
    expect(DASHBOARD_HTML).toContain('Sign in with Google');
    expect(DASHBOARD_HTML).toContain('Sign in with Apple');
    expect(DASHBOARD_HTML).toContain('Sign in with X');
    expect(DASHBOARD_HTML).not.toContain('>Sign In with ');
    expect(DASHBOARD_HTML).not.toContain('Sign In with Google\n');
    // Phone account sheet stacks Sign In / Upgrade as full-width rows.
    expect(DASHBOARD_HTML).toContain('.acct-mobile-menu .acct-auth-group { display:flex; flex-direction:column; gap:8px;');
    expect(DASHBOARD_HTML).toContain('.acct-mobile-menu .acct-auth-group .btn { width:100%; height:44px; min-height:44px;');
  });

  it('phones: one-row header filters and a single 40px pager band (sort | page | rows)', () => {
    expect(DASHBOARD_HTML).toContain('header.top {\n      display: grid; grid-template-columns: minmax(0, 1fr) 44px; grid-template-rows: auto auto;');
    expect(DASHBOARD_HTML).toContain('header.top #ctFilters { grid-column: 1 / -1; grid-row: 2; display: block; padding: 4px 4px 8px; min-width: 0; }');
    expect(DASHBOARD_HTML).toContain('#ctFilters #tradesSharedFilters::-webkit-scrollbar { display: none; }');
    expect(DASHBOARD_HTML).toContain('#ctFilters .ios-filter-btn { height: 40px; padding: 0 8px; }');
    // The fixed dock resets the desktop inline-flex/height on nav.tabs a.
    expect(DASHBOARD_HTML).toContain('nav.tabs a {\n      display: block; height: auto; white-space: normal;\n      padding: 6px 2px; min-height: 44px; font-size: 0; min-width: 0;');
    // Account sheet anchors under the wordmark row, not the whole header.
    expect(DASHBOARD_HTML).toContain('top: calc(var(--ct-brand-h, 62px) + 8px);');
    expect(DASHBOARD_HTML).toContain("document.documentElement.style.setProperty('--ct-brand-h', Math.round(brand.getBoundingClientRect().bottom) + 'px');");
    // Pager band.
    expect(DASHBOARD_HTML).toContain('#view-trades .pager-top { display: flex; flex-wrap: nowrap; gap: 8px; align-items: center; justify-content: flex-start; margin: 0 0 12px; }');
    expect(DASHBOARD_HTML).toContain('#view-trades .pager-top #tradesCountMsgTop { display: none; }');
    expect(DASHBOARD_HTML).toContain('#tradesSortMobile {\n      display: inline-flex; align-items: center; gap: 0; flex: 0 0 auto; height: 40px;');
    expect(DASHBOARD_HTML).toContain('#view-trades .pager-top [data-pager-first], #view-trades .pager-top [data-pager-last] { display: none; }');
    // Long/short page text are sibling spans; the phone band swaps them so
    expect(DASHBOARD_HTML).toContain("var shortText = fmtCount(tradesPage + 1) + '/' + fmtCount(pageCount);");
    expect(DASHBOARD_HTML).toContain("pageMsg.setAttribute('data-page-text', longText);");
    expect(DASHBOARD_HTML).toContain("pageMsg.innerHTML = '<span class=\"pg-long\">' + longText + '</span><span class=\"pg-short\">' + shortText + '</span>';");
    expect(DASHBOARD_HTML).toContain('#view-trades .pager-top .trades-page-msg .pg-long { display: none; }');
    expect(DASHBOARD_HTML).toContain('#view-trades .pager-top .trades-page-msg .pg-short { display: inline; }');
    expect(DASHBOARD_HTML).toContain('.trades-page-msg .pg-short { display: none; }');
    expect(DASHBOARD_HTML).not.toContain('data-short');
    // Band never overflows 320px: page controls are the flexible member.
    expect(DASHBOARD_HTML).toContain('#view-trades .pager-top .pager-controls { flex: 1 1 0; min-width: 0;');
    expect(DASHBOARD_HTML).toContain('max-width: min(104px, 22vw);');
    // Search keeps a 6px gap under the chips and its own flex row on
    // coarse-pointer tablets (ID-ID beats the >=769 display:contents merge).
    expect(DASHBOARD_HTML).toContain('#ctFilters #tradesExtraFilters { display: flex; align-items: center; gap: 8px; margin-top: 6px; }');
    expect(DASHBOARD_HTML).toContain("o.textContent = short ? o.value + '/pg' : o.value + ' rows';");
    expect(DASHBOARD_HTML).toContain('initIosFilterMenus();\nsyncPageSizeLabels();\nsyncChromeMetrics();');
    expect(DASHBOARD_HTML).toContain('<select id="mobileSortKey" aria-label="Sort by" title="Sort by" onchange="handleMobileSortKeyChange()"></select>');
  });

  it('names the empty filter chips on wide desktops and keeps the short labels below 1200px', () => {
    expect(DASHBOARD_HTML).toContain("try { wide = !!(window.matchMedia && window.matchMedia('(min-width: 1200px)').matches); } catch (_e) {}");
    expect(DASHBOARD_HTML).toContain("setSummary(id, on.length ? on.join('+') : (wide ? 'Branches' : 'All'), on.length > 0);");
    expect(DASHBOARD_HTML).toContain("setSummary(id, on.length ? on.join('+') : (wide ? 'Parties' : 'All'), on.length > 0);");
    expect(DASHBOARD_HTML).toContain("setSummary(id, on.length ? on.join('+') : (wide ? 'Types' : ''), on.length > 0);");
    // Re-evaluated on resize alongside the rows-per-page labels.
    expect(DASHBOARD_HTML).toContain('    syncPageSizeLabels();\n    refreshIosFilterSummaries();\n  });');
  });

  it('uses guillemet pager arrows with the accessible names on the buttons', () => {
    const document = parse(DASHBOARD_HTML);
    for (const [attr, glyph, name] of [['data-pager-first', '\u00ab', 'First page'], ['data-pager-prev', '\u2039', 'Previous page'], ['data-pager-next', '\u203a', 'Next page'], ['data-pager-last', '\u00bb', 'Last page']] as const) {
      const btns = document.querySelectorAll('[' + attr + ']');
      expect(btns.length, attr).toBe(2);
      for (const b of btns) {
        expect(b.textContent.trim(), attr).toBe(glyph);
        expect(b.getAttribute('aria-label'), attr).toBe(name);
      }
    }
    expect(DASHBOARD_HTML).not.toContain('>&lt;&lt;</button>');
    expect(DASHBOARD_HTML).toContain('.pager-controls .btn.sm { font-size: 16px; line-height: 1; }');
  });

  it('drops the inert #trendsSharedFilters halves of the phone chip selectors (mirror is display:none)', () => {
    expect(DASHBOARD_HTML).not.toContain('#tradesSharedFilters, #trendsSharedFilters {');
    expect(DASHBOARD_HTML).not.toContain('#trendsSharedFilters > .pill-select.pill-cal');
    expect(DASHBOARD_HTML).not.toContain('#trendsSharedFilters .branch-toggle');
    expect(DASHBOARD_HTML).not.toContain('#trendsSharedFilters.toolbar');
    // The Trades halves and the mirror's own hide rules stay.
    expect(DASHBOARD_HTML).toContain('#tradesSharedFilters > .pill-select.pill-cal {\n      flex: 0 0 auto; width: max-content;');
    expect(DASHBOARD_HTML).toContain('#tradesSharedFilters .branch-toggle, #tradesSharedFilters .party-chip, #tradesSharedFilters .side-chip {\n      min-width: 30px; padding: 0 6px;');
    expect(DASHBOARD_HTML).toContain('#trendsSharedFilters[data-filter-mirror] { display: none !important; }');
  });

  it('adds the Reset chip, aria-current, active-tab re-tap and the "/" search shortcut', () => {
    expect(DASHBOARD_HTML).toContain('<button type="button" class="btn ghost sm ct-filter-reset" id="ctFilterReset" onclick="resetSharedFilters()" title="Reset filters to defaults" hidden>Reset</button>');
    expect(DASHBOARD_HTML).toContain('function resetSharedFilters() {');
    expect(DASHBOARD_HTML).toContain("var dirty = !!document.querySelector('#tradesSharedFilters .ios-filter.has-sel');");
    expect(DASHBOARD_HTML).toContain("if (win && win.value !== '90d') dirty = true;");
    expect(DASHBOARD_HTML).toContain('resetBtn.hidden = !dirty;');
    expect(DASHBOARD_HTML).toContain("b.setAttribute('aria-current', 'page');");
    expect(DASHBOARD_HTML).toContain("initialBtn.setAttribute('aria-current', 'page');");
    // Boot fallback to Trends restamps html[data-view] (the head script may
    // have stamped an admin-gated ?view= that then fell back).
    expect(DASHBOARD_HTML).toContain("document.documentElement.setAttribute('data-view', 'trends');\n    if (typeof refreshIosFilterSummaries === 'function') refreshIosFilterSummaries();\n    loadTrends(); // Trends is the default landing view");
    // "/" never steals focus from an open filter popover or menu.
    expect(DASHBOARD_HTML).toContain("var menuOpen = !!document.querySelector('.ios-filter-pop:not([hidden]), .menu-pop.open, .acct-mobile-menu.open');");
    // Reset issues one fetch (no debounced search fetch racing resetTradesPage).
    expect(DASHBOARD_HTML).toContain("if (typeof tradesSearchTimer !== 'undefined' && tradesSearchTimer) { clearTimeout(tradesSearchTimer); tradesSearchTimer = null; }");
    expect(DASHBOARD_HTML).toContain("if (b.classList.contains('active') && e && e.isTrusted) { window.scrollTo({ top: 0, behavior: 'smooth' }); return; }");
    expect(DASHBOARD_HTML).toContain("if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey) {");
    expect(DASHBOARD_HTML).toContain("if (!typing && !menuOpen && q && document.documentElement.getAttribute('data-view') === 'trades' && !openOverlayContainer()) {");
  });
});

// Board row 6c05e09b: nothing on Top Performers or the drawers said the prices
// were as of a date, while prod prices sat frozen for 46 days.
describe('Prices as of copy (6c05e09b)', () => {
  function fmtAsOfFn(): (iso: string | null) => string {
    const m = /function fmtAsOf\(iso\) \{[\s\S]*?\n\}/.exec(DASHBOARD_HTML);
    expect(m, 'fmtAsOf is embedded in the dashboard').not.toBeNull();
    return new Function(`${m![0]}\nreturn fmtAsOf;`)() as (iso: string | null) => string;
  }

  it('formats an ISO date without a timezone round-trip', () => {
    const fmt = fmtAsOfFn();
    expect(fmt('2026-08-03')).toBe('Aug 3, 2026');
    expect(fmt('2026-08-03T00:00:00.000Z')).toBe('Aug 3, 2026');
    expect(fmt('2026-12-31')).toBe('Dec 31, 2026');
    expect(fmt(null)).toBe('');
    expect(fmt('garbage')).toBe('');
  });

  it('prints "Prices as of" on Top Performers and on the politician drawer', () => {
    expect(DASHBOARD_HTML).toContain('id="trPerformersAsOf"');
    expect(DASHBOARD_HTML).toContain("'Prices as of ' + fmtAsOf(d.pricesAsOf)");
    expect(DASHBOARD_HTML).toContain("(d.pricesAsOf ? ' · Prices as of ' + esc(fmtAsOf(d.pricesAsOf)) : '')");
  });
});
