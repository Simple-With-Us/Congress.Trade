/**
 * src/ui/dashboardHtml.ts
 * OWNER: dashboard agent
 *
 * The full dashboard document as a single exported template string, ported from
 * ../../dashboard-design.html. The look/theme/tabs/CSS-variables are preserved
 * verbatim; the mock SAMPLE_* arrays are replaced with live calls to the API
 * built by the delivery/admin agents:
 *
 *   Feed          GET /api/transactions?since=<cursor>
 *                 EventSource('/api/stream?subscription=<id>')
 *   Review        GET /api/admin/review-queue
 *                 POST /api/admin/review/:docId  {decision}
 *   Delivery      GET /api/client/v1/subscriptions
 *                 POST /api/client/v1/commands {type:'create_subscription'}
 *   Admin cadence GET/PUT /api/admin/poll-config
 *   Source health GET /api/admin/sources/health
 *   Instrument pricing GET /api/admin/instrument-pricing
 *                 GET /api/admin/instrument-pricing/at?ticker=&at=
 *
 * Dependency-free vanilla JS. Loading / empty / error states are handled for
 * every panel; the "illustrative sample data" banner is removed the moment real
 * feed data loads.
 *
 * The benchmark model catalog and the executive-branch title map are the ONLY
 * exceptions to "no imports": both are serialized into the template at module
 * load (from benchmarkSelectableCatalog() and executiveTitleForms()) so the
 * re-read menus / quick-run select / custom benchmark checkboxes, and every
 * place the dashboard names a Cabinet official, can never drift from their
 * server-side sources of truth.
 */

import { benchmarkSelectableCatalog } from '../benchmark/settings.ts';
import { executiveTitleForms } from '../shared/executiveTitles.ts';
import { MAX_PUBLIC_TX_OFFSET } from '../security/botDefense.ts';

/**
 * Filing Latency Comparison ("speed proof") section markup, shared between its
 * two placements (owner 2026-08-17):
 *   - Delivery tab: rendered at the BOTTOM, only when isLatencyAhead() says
 *     we are not behind on most adequately-covered providers. Trends keeps a
 *     link to this section under the same gate. Never shown on Trades.
 *   - Admin tab: rendered at the TOP, ALWAYS (full comparison incl. BEHIND),
 *     an operator diagnostic rather than a marketing module.
 * Both copies are painted by the same renderSpeedProof() client function
 * against distinct element ids so they can render independently.
 */
function speedProofSectionHtml(admin: boolean): string {
  const sectionId = admin ? 'adminLatencySection' : 'trLatencySection';
  const gridId = admin ? 'spGridAdmin' : 'spGrid';
  const tableBodyId = admin ? 'speedTableBodyAdmin' : 'speedTableBody';
  const updatedId = admin ? 'speedUpdatedAdmin' : 'speedUpdated';
  // "N of M matched" + what M counts. Filled by paintSpeedSection(); stays
  // hidden until the matcher lane ships the scope counts (see the
  // SPEED_SCOPE_NOTE_DEFAULT contract block in the client script).
  const scopeNoteId = admin ? 'spScopeNoteAdmin' : 'spScopeNote';
  const infoTip = admin
    ? 'Full operator scorecard: every configured provider, including where we are behind. Each card is marked Shown Publicly or Hidden From Public. Lead and win stats use live new imports only (seed and historical backfills are excluded). We match each live trade to provider feeds even if the gap is minutes or up to about two weeks either way. Provider-only rows stay in the coverage denominator.'
    : 'Lead and win stats use live new imports only (seed and historical backfills are excluded). We match each live trade to provider feeds even if the gap is minutes or up to about two weeks either way. Provider-only rows stay in the coverage denominator, and no overall speed claim appears until coverage is adequate in both directions.';
  return `  <!-- Provider speed scorecard (filter-independent live latency proof). ${admin ? 'Admin: always full comparison, incl. BEHIND.' : "Delivery: only when we are not behind on most providers."} -->
  <div class="section speed-proof" id="${sectionId}"${admin ? '' : ' hidden'} style="margin-top:24px; padding:24px 20px;">
    <div class="speed-head">
      <div>
        <h3 style="margin:0 0 16px 0">Filing Latency Comparison <span class="info-tip" tabindex="0" aria-label="${infoTip}" title="${infoTip}">ⓘ</span></h3>
      </div>
      <span class="note" id="${updatedId}" style="white-space:nowrap"></span>
    </div>
    <!-- Scorecard cards injected here by renderSpeedProof() -->
    <div class="sp-grid" id="${gridId}">
      <div class="sp-card" aria-hidden="true" style="min-height:160px">
        <div class="sk sk-line" style="width:55%;height:14px"></div>
        <div class="sk sk-line" style="width:100%;height:8px;margin-top:8px"></div>
        <div class="sk sk-line" style="width:40%;height:32px;margin-top:4px"></div>
      </div>
      <div class="sp-card" aria-hidden="true" style="min-height:160px">
        <div class="sk sk-line" style="width:55%;height:14px"></div>
        <div class="sk sk-line" style="width:100%;height:8px;margin-top:8px"></div>
        <div class="sk sk-line" style="width:40%;height:32px;margin-top:4px"></div>
      </div>
    </div>
    <p class="note sp-scope-note" id="${scopeNoteId}" hidden></p>
    <p class="note" style="margin-top:14px">Every few minutes our production probes ask each provider&rsquo;s public API for its latest Congressional trades. <strong>Lead and win rates use live new imports only</strong> &mdash; seed datasets and historical house/senate backfills are excluded. We still count a match if they listed the trade minutes or up to about two weeks before or after we did. Provider-observed rows that remain unmatched after a 24-hour grace period stay in the denominator instead of counting as Congress.Trade wins. Coverage must be adequate in both directions before an overall speed badge or marketing claim appears. A live measurement, not a promise.</p>
    <details class="speed-table" style="margin-top:8px">
      <summary>Raw data table</summary>
      <div class="table-wrap"><table>
        <thead><tr><th>Provider</th>${admin ? '<th>Public</th>' : ''}<th>Concurrent /<br>strong / CT</th><th>Mature overlap /<br>rows</th><th>CT /<br>provider coverage</th><th>Unmatched<br>provider rows</th><th>Status</th><th>We first</th><th>They first</th><th>Ties</th><th>Typical lead</th><th>Avg</th><th>P90</th></tr></thead>
        <tbody id="${tableBodyId}"></tbody>
      </table></div>
    </details>
    <p class="note speed-fineprint">Provider names are trademarks of their respective owners. Measurements are our own and are not endorsed by the providers named.</p>
  </div>
`;
}

export const DASHBOARD_HTML = /* html */ `<!DOCTYPE html>
<html lang="en" data-view="trends">
<head>
%GA_SCRIPT%
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>%TITLE%</title>
<meta name="description" content="%META_DESCRIPTION%" />
<link rel="canonical" href="%CANONICAL_URL%" />
<meta name="theme-color" content="#eff3f8" />
<!-- Open Graph — placeholders filled server-side from deep-link query
     (?view=trends / ?ticker= / ?member=) so crawlers get the right card. -->
<meta property="og:type" content="website" />
<meta property="og:site_name" content="Congress.Trade" />
<meta property="og:title" content="%OG_TITLE%" />
<meta property="og:description" content="%OG_DESCRIPTION%" />
<meta property="og:url" content="%OG_URL%" />
<meta property="og:image" content="%OG_IMAGE%" />
<meta property="og:image:type" content="image/png" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta property="og:image:alt" content="%OG_IMAGE_ALT%" />
<!-- Twitter / X -->
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="%TWITTER_TITLE%" />
<meta name="twitter:description" content="%TWITTER_DESCRIPTION%" />
<meta name="twitter:image" content="%TWITTER_IMAGE%" />
<!-- Icons / PWA -->
<link rel="icon" href="/favicon.ico?v=10" sizes="32x32" />
<link rel="icon" type="image/png" href="/icon-192.png?v=10" sizes="192x192" />
<link rel="icon" type="image/png" href="/icon-512.png?v=10" sizes="512x512" />
<link rel="apple-touch-icon" href="/apple-touch-icon.png?v=10" />
<link rel="manifest" href="/site.webmanifest" />
<script>
  // Admin-controlled, site-wide logo style (injected at serve time).
  window.__LOGO_DISPLAY__ = "%LOGO_DISPLAY%";
  // Theme before first paint: default LIGHT (owner 2026-08-10); stored may be
  // light|dark|system.  Sepia was removed (owner 2026-08-21: "too dark of a
  // color that doesn't look like old fashioned paper", only half-themed) —
  // any stored 'sepia' value is migrated to 'light' here so a returning
  // visitor never gets stuck failing validation.
  (function () {
    var pref = 'light';
    try {
      var s = localStorage.getItem('ui-theme');
      if (s === 'sepia') {
        try { localStorage.setItem('ui-theme', 'light'); } catch (e2) {}
        s = 'light';
      }
      if (s === 'light' || s === 'dark' || s === 'system') pref = s;
    } catch (e) {}
    var effective = pref;
    if (pref === 'system') {
      effective = (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
    }
    var theme = effective === 'dark' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.setAttribute('data-theme-pref', pref);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#08111f' : '#eff3f8');
  })();
  // Header column before first paint: header.top pads out to the active
  // view's content column (--ct-col-max via html[data-view]).  The static
  // markup says "trends"; a deep link (?view=trades) or a remembered tab
  // would otherwise paint on the 1280px Trends column and jump once the app
  // script restores the view.  Same aliases / precedence as that restore.
  (function () {
    try {
      var aliases = { feed: 'trades', delivery: 'subs', alerts: 'subs', push: 'subs' };
      var v = new URL(window.location.href).searchParams.get('view');
      if (!v) { try { v = localStorage.getItem('ct-active-tab'); } catch (e2) {} }
      v = aliases[v] || v;
      if (v === 'trades' || v === 'people' || v === 'subs' || v === 'review' || v === 'admin') {
        document.documentElement.setAttribute('data-view', v);
      }
    } catch (e) {}
  })();
</script>
<style>
  :root {
    /* ---- THEME ---- */
    --bg:        #080c17;
    --bg-2:      #0e1626;
    --panel:     #121b30;
    --panel-2:   #172440;
    --border:    #2e3e65;
    --text:      #ffffff;
    --text-dim:  #b8c7dd;
    --icon-grey: #9ca3af; /* medium grey for header hamburger + info glyphs (dark theme) */
    --accent:    #4f8cff;
    --buy:       #22c55e;
    --sell:      #ef4444;
    --exch:      #eab308;
    --warn:      #f59e0b;
    --good:      #34d399;
    /* Party dots (replaces the old donkey/elephant/eagle glyphs everywhere a
       member's party is shown — filter chips, drawers, Trends): red for
       Republican, blue for Democrat, purple for Independent/Other. Same
       values the .pdot table/member-row dots already used; centralized here
       so every party-color surface shares one source of truth. */
    --party-d:   #3b82f6;
    --party-r:   #ef4444;
    --party-o:   #a78bfa;
    /* "Rival" gray for the speed-vs-providers race lanes: providers are one
       de-emphasized neutral (never buy/sell green/red — those mean trades). */
    --rival:     #7b8dab;
    /* Behind-on-time RED, for signed lead/lag figures only (owner 2026-08-11:
       "stay in red when behind on time"). Deliberately NOT --rival: the neutral
       gray is the PROVIDER's chrome, whereas this is our own losing number and
       has to read as a loss. Aliases --sell so it follows the active theme. */
    --lag:       var(--sell);
    --radius:    12px;
    /* Capsule chrome radius + shared control height for the filter-pill row
       (chip clusters, pill-selects, icon search fields, header icon buttons).
       Distinct from --radius (card/section/modal corner radius) — don't
       conflate the two. */
    --radius-pill: 999px;
    /* Header control radius: nav tabs, filter chips, time select, search
       field, account cluster and pager buttons share ONE corner radius so the
       header row reads as a single grammar (owner 2026-09-09: "filter bubble
       shape equally rounded with equal radius as the site section tab
       shapes").  Popovers/menus use --radius; --radius-pill stays for
       badges / status pills / toggles that are not header controls. */
    --radius-ctl:  8px;
    --control-h:   34px;
    /* Bottom edge of the wordmark block (phones: header row 1) measured by
       syncChromeMetrics(); the account sheet anchors under it. */
    --ct-brand-h:  80px;
    --mono:      ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    --sans:      "Inter", system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
  }
  /* ---- light theme (toggled via html[data-theme="light"]) ---- */
  html[data-theme="light"] {
    --bg:        #eff3f8;
    --bg-2:      #e4ebf4;
    --panel:     #ffffff;
    --panel-2:   #e8eff8;
    --border:    #c1cde2;
    --text:      #09101c;
    --icon-grey: #6b7280; /* medium grey for header hamburger + info glyphs */
    --text-dim:  #34435b;
    --accent:    #2563eb;
    --buy:       #15803d;
    --sell:      #dc2626;
    --exch:      #b45309;
    --warn:      #b45309;
    --good:      #15803d;
    --rival:     #64748b;
  }
  html[data-theme="light"] header.top {
    background: #fff;
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
  }
  /* The hidden attribute must always win, even over class display rules
     (e.g. .row-flex/.plan-grid set display and would otherwise override the
     UA's [hidden]{display:none} — the entitlement cues rely on it). */
  [hidden] { display: none !important; }
  /* Admin-only chrome (Review / Admin tabs, [data-admin-only] blocks) is
     gated on html.ct-admin, which applyAdminVisibility() sets from
     canUseAdmin() — nothing admin-ish is reachable by CSS alone before
     /auth/me resolves, and no [hidden] toggle can leak it back. */
  html:not(.ct-admin) [data-admin-tab="true"], html:not(.ct-admin) [data-admin-only] { display: none !important; }
  /* ---- theme toggle ---- */
  /* ---- resizable feed columns ---- */
  /* No reserved right gutter: when a table genuinely overflows, the scrollbar
     renders inside the wrap; a static 60px reservation is pure dead space at
     wide windows (#1551 verifier measured it on the Trades table at 1920px). */
  .table-wrap { overflow-x: auto; max-height: min(78vh, 920px); scrollbar-width: thin; scrollbar-color: var(--border) var(--panel-2); padding-right: 0; box-sizing: border-box; }
  .table-wrap::-webkit-scrollbar { width: 10px; height: 10px; }
  .table-wrap::-webkit-scrollbar-track { background: var(--panel-2); border-radius: 4px; }
  .table-wrap::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; border: 2px solid var(--panel-2); }
  .table-wrap::-webkit-scrollbar-thumb:hover { background: var(--text-dim); }
  /* Owner follow-up batch #5: Trends tables show their content in full — no
     vertical scroll/clipping. The shared .table-wrap max-height (built for
     the paginated Trades feed table, out of scope here) forces a vertical
     scrollbar once content exceeds it (overflow-x:auto pairs with an implicit
     overflow-y:auto per spec), which clipped every Trends table using this
     wrapper. #view-trends's own ID-scoped rule outranks the shared class rule
     regardless of source order. Slowest Filers is exempt — it uses the
     separate .late-filers-wrap class (see above), not .table-wrap, and keeps
     its own scroll + sticky header.
     Owner follow-up batch #8: same root cause as the drawer's own
     #detailDrawerBody .table-wrap fix below — the 60px padding-right exists
     to clear the big feed table's custom scrollbar gutter, which is pure
     waste on simple Trends tables (Most Active Politicians, Top Performers,
     etc.) and reads as an oddly narrow table, worst on mobile where 60px is a
     big fraction of the viewport. */
  #view-trends .table-wrap { max-height: none; padding-right: 0; }
  /* Owner follow-up batch #15: at wide desktop widths (verified ~1600px and
     ~1920px) the small Trends table cards (What Is Being Traded, Rising
     Activity, Top Performers, Most Active Politicians, …) used to stretch to
     fill their full grid column, showing a right-side drop shadow and a wall
     of empty space after the table's last column. The main feed table
     absorbs its own leftover width instead (syncTradesTableWidth, #13); these
     small cards just shrink to their content and stay left-aligned. Scoped
     to sections that directly wrap a .table-wrap so chart/cluster-grid/
     flow-chip sections are unaffected, and only above a wide-desktop
     threshold so mobile/tablet keep the full-bleed card look. */
  @media (min-width: 1300px) {
    /* Owner 2026-08-10 regression fix: after #1613 wrapped these sections in
       <details>, bare width:fit-content broke BOTH ways at once — the global
       table width:100% rule makes fit-content circular, so standalone cards
       (Top Performers) resolved to full-bleed rows with an orphaned % pinned
       at the far right, while grid-child cards (Most Active Politicians)
       collapsed to min-content (~300px) through their ellipsis-shrinkable
       cells, crushing rows into overlap and leaving a giant empty column.
       Fix: give the INNER table an intrinsic width (max-content) so the
       card's fit-content has a real answer, plus a floor so no card can
       crush. .table-wrap keeps overflow-x for the (wide-desktop-unlikely)
       case where max-content exceeds the column. */
    #view-trends .section:has(> .table-wrap) { width: 100%; min-width: 0; max-width: 100%; }
    #view-trends .section:has(> .table-wrap) > .table-wrap { width: 100%; }
    #view-trends .section:has(> .table-wrap) > .table-wrap > table { width: 100%; min-width: 560px; }
    /* Top Performers sits in the 0.75fr slot of .trend-grid-split.  The 560px
       floor would overflow that column the way Rising Activity used to. */
    #view-trends .trend-grid-split .section:has(> .table-wrap) > .table-wrap > table { min-width: 0; }
    /* A long one-line subtitle (Top Performers) must wrap at a readable
       measure instead of inflating the card's fit-content width past its
       own table. 68ch ≈ ideal reading measure. */
    #view-trends .section:has(> .table-wrap) > .sub { max-width: 68ch; }
    /* The Politicians+Party grid: hug the left card's real content width
       (capped) and let the By Party / By Asset Type stack absorb the rest —
       kills the dead middle column the fixed 1.6fr/.85fr split left behind
       once the left card stopped filling its column. */
    #view-trends .trend-members-grid { grid-template-columns: fit-content(760px) minmax(360px, 1fr); }
  }
  /* Width is driven by the sum of <col>/th widths (syncTradesTableWidth).
     After the user resizes a column, the table grows/shrinks instead of
     redistributing leftover space into Politician/Asset. */
  #tradesTable.resizable { table-layout: fixed; width: max-content; min-width: 0; }
  #tradesTable.resizable th, #tradesTable.resizable td { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  /* Owner report (2026-08-09, layout-stability follow-up): this used to also
     match th.c-latency, which forced the HEADER label ("Latency") into
     white-space:normal + word-break:break-word too. In table-layout:fixed the
     width/min-width/max-width this rule declared never actually constrained
     the rendered column (the <col> width JS keeps in sync always wins), so
     whenever that column got squeezed toward its old, too-small minColWidth
     floor the word-break kicked in with nothing to stop it, wrapping the
     7-letter label one letter per line. Only the BODY cell renders two lines
     of real content ("detected …" / "imported … later") and needs to wrap;
     the header stays nowrap+ellipsis like every other column (base rule
     above), backed by a minColWidth('latency') sized for the one-word label. */
  #tradesTable.resizable td.latency { white-space: normal; word-break: break-word; }
  #tradesTable.resizable th { text-align: center; padding-right: 18px; }
  #tradesTable.resizable td > * { max-width: 100%; min-width: 0; }
  #tradesTable.resizable .asset-cell,
  #tradesTable.resizable .member-cell { overflow: hidden; max-width: 100%; }
  #tradesTable.resizable .asset-cell > div,
  #tradesTable.resizable .member-cell > div { flex: 1 1 auto; }
  #tradesHead th { position: sticky; top: 0; z-index: 4; background: var(--panel); text-align: center; }
  #tradesTable th:first-child, #tradesTable td:first-child { position: sticky; left: 0; z-index: 5; background: var(--panel); }
  #tradesTable th:first-child { z-index: 6; }
  #tradesHead th .arr { display: inline-block; width: 1em; margin-left: 4px; text-align: center; color: var(--text-dim); }
  .col-resizer { position: absolute; top: 0; right: 0; width: 7px; height: 100%; cursor: col-resize; user-select: none; touch-action: none; }
  .col-resizer:hover { background: color-mix(in srgb, var(--accent) 45%, transparent); }
  /* ---- monogram backup logo (shown when a ticker's real logo is missing) ---- */
  .tkr-logo.mono img { display: none; }
  .tkr-logo.mono { font-family: var(--mono); font-size: 9px; font-weight: 700; color: var(--text-dim); background: var(--panel-2); border: 1px solid var(--border); border-radius: 6px; }
  .tkr-logo.mono::after { content: attr(data-mono); }
  * { box-sizing: border-box; }
  body, header.top, nav.tabs, .card, .section, .drawer-panel, .ccard { transition: background-color 0.25s ease, background 0.25s ease, color 0.25s ease, border-color 0.25s ease; }
  body {
    margin: 0; background: radial-gradient(1200px 600px at 70% -10%, var(--bg-2), var(--bg));
    color: var(--text); font-family: var(--sans); font-size: 14px; min-height: 100vh;
  }
  body.drawer-open { overflow: hidden; }
  a { color: var(--accent); text-decoration: none; }
  /* --ct-col-max is the content column the header chrome (tabs, account,
     filter row) aligns to (owner 2026-09-08: "bound by the same max width as
     the middle cards").  Trends caps its cards at 1280px; every other view
     fills main's 1800px cap minus its 35px side pads.  --ct-header-h is the
     pre-JS guess for the full header band (80px logo beside two 34px control
     rows + 10px pads at >=1333px; the filters now live INSIDE header.top, so
     nothing is sticky under it) — syncChromeMetrics() overwrites it with the
     measured height; phones/popovers/account sheet read it. */
  :root { --ct-header-h: 100px; --ct-main-pad: 35px; --trends-gap: 24px; --ct-col-max: 1730px; }
  html[data-view="trends"] { --ct-col-max: 1280px; }
  html { overflow-x: clip; }
  header.top {
    /* Owner 2026-09-09: two-row header grid.  The wordmark spans both rows
       on the left; row 1 = section tabs + account cluster, row 2 = the
       shared Trades/Trends filter row (#ctFilters, moved out of the views
       so it carries over between tabs and sits beside the logo instead of
       under it).  Rows are the shared control height so the logo's 80px
       centre lines up with the two 34px rows + 12px gap.  Side pads reach
       the content column: max() keeps the plain 35px inset until the
       column cap engages.
       NEVER add transform / filter / overflow:hidden here: the filter
       popovers are position:fixed children of this sticky header and any
       of those would re-root them (clipped popovers). */
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    grid-template-rows: var(--control-h, 34px) minmax(var(--control-h, 34px), auto);
    row-gap: 12px; column-gap: 24px;
    align-items: center;
    padding: 5px max(var(--ct-main-pad, 35px), calc(50% - var(--ct-col-max, 1730px) / 2)) 14px;
    /* Owner 2026-09-21 punch list: top padding halved (10 → 5px) so the
       wordmark sits half the distance from the eagle's wingtip to the
       dynamic island / browser chrome.  Bottom padding barely expanded
       (10 → 14px) to keep the space below the bag-of-money roughly
       equidistant with the new top space after the 15% wordmark growth. */
    border-bottom: none; background: var(--panel);
    -webkit-backdrop-filter: none; backdrop-filter: none;
    position: sticky; top: 0; z-index: 10;
    width: 100%; box-sizing: border-box;
  }
  header.top .brand { grid-column: 1; grid-row: 1 / 3; align-self: center; display: block; line-height: 0; }
  header.top #acct { grid-column: 3; grid-row: 1; justify-self: end; }
  /* Shared filter row (Trades + Trends): right of the logo, under the tabs.
     Hidden on views that have no filters; #tradesExtraFilters (search) is
     Trades-only.  html[data-view] is stamped pre-paint and on every tab
     switch, so this never flashes. */
  header.top #ctFilters {
    grid-column: 2 / -1; grid-row: 2;
    display: flex; align-items: center; gap: 12px; min-width: 0; min-height: var(--control-h, 34px);
  }
  html:not([data-view="trades"]):not([data-view="trends"]) #ctFilters { display: none; }
  html[data-view="trends"] #tradesExtraFilters { display: none; }
  /* Same hide at ID-ID specificity: the phone block's
     #ctFilters #tradesExtraFilters display:flex rule (2,0,0) would
     otherwise outrank the rule above (1,1,1) and leave the Trades search
     visible on the Trends tab on phones / coarse-pointer tablets. */
  html[data-view="trends"] #ctFilters #tradesExtraFilters { display: none; }
  #ctFilters .trades-toolbars {
    position: static; width: auto; max-width: none; margin: 0; padding: 0;
    background: transparent; flex: 1 1 auto; min-width: 0;
  }
  #ctFilters .toolbar { margin: 0; flex-wrap: nowrap; }
  /* Reset chip: only rendered once a filter departs from the defaults
     (refreshIosFilterSummaries() toggles [hidden]). */
  .ct-filter-reset { flex: 0 0 auto; height: var(--control-h, 34px); min-height: 0; padding: 0 10px; border-radius: var(--radius-ctl); font-size: 12px; }
  /* Content column starts below the header row; the old sticky strips
     carried their own bottom margin. */
  #view-trades, #view-trends { padding-top: 16px; }
  /* Zilla Slab (Typotheque/Mozilla), SIL OFL 1.1 — latin 700 subset via @fontsource, embedded so no external font request. */
  @font-face { font-family:'Zilla Slab'; font-style:normal; font-weight:700; font-display:swap; src:url(/assets/zilla-slab-700.woff2) format('woff2'); }
  /* Inter (Rasmus Andersson), SIL OFL 1.1 — self-hosted latin subset, the
     weights the CSS below actually uses (QABUGHUNT-01 / WEBPERF-01): the
     Google Fonts <link> this replaced had an invalid axis tuple for the
     Source Serif 4 family, so the whole combined stylesheet 400'd and Inter
     never loaded on production. IBM Plex Mono and Source Serif 4 were also
     requested but never referenced by any rule here, so both are dropped
     rather than fixed. Self-hosting removes the third-party render-blocking
     Google Fonts request (and the CSP exceptions it required) the same way
     Zilla Slab is handled above. */
  @font-face { font-family:'Inter'; font-style:normal; font-weight:400; font-display:swap; src:url(/assets/inter-400.woff2) format('woff2'); }
  @font-face { font-family:'Inter'; font-style:normal; font-weight:500; font-display:swap; src:url(/assets/inter-500.woff2) format('woff2'); }
  @font-face { font-family:'Inter'; font-style:normal; font-weight:600; font-display:swap; src:url(/assets/inter-600.woff2) format('woff2'); }
  @font-face { font-family:'Inter'; font-style:normal; font-weight:700; font-display:swap; src:url(/assets/inter-700.woff2) format('woff2'); }
  @font-face { font-family:'Inter'; font-style:normal; font-weight:800; font-display:swap; src:url(/assets/inter-800.woff2) format('woff2'); }
  /* Wordmark face (owner-chosen typewriter slab), self-hosted Zilla Slab first
     with a local typewriter-slab fallback stack. */
  .brand { display:inline-flex; align-items:center; gap:0; min-width:0; flex:0 1 auto; }
  /* Owner 2026-09-08: the wordmark is at least as wide as the Trends/Trades
     filter row (~370px at the default "3 Months / All / All / sides" state),
     so it is sized by WIDTH and the 5:1 PNG sets the height (80px at 400px).
     The 30vw cap keeps it from crowding nav.tabs on 900-1300px laptops; the
     phone / coarse-pointer block below restores the compact 40px lockup. */
  .brand-logo { width:min(460px, 30vw); height:auto; max-width:100%; object-fit:contain; flex:0 0 auto; display:block; background:transparent; border-radius:0; box-shadow:none; }
  /* From 1100px the wordmark also floors at the default filter row's 423px
     (30vw alone only crosses 423px at 1410px).  1100px is where a signed-in
     account cluster (~270px) still fits beside a 423px logo + 319px nav
     without wrapping nav.tabs onto a second line. Owner 2026-09-21 punch
     list: 460px / 423px = 15% larger than the prior 400 / 368px wordmark;
     height follows the 5:1 PNG so the eagle and wordmark grow together. */
  @media (min-width: 1100px) { .brand-logo { width:clamp(423px, 30vw, 460px); } }
  .brand-text { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .brand .dot { color: var(--accent); }
  .pill { font-size: 11px; padding: 3px 9px; border-radius: 999px; border: 1px solid var(--border); color: var(--text-dim); }
  .pill.live { color: var(--good); border-color: color-mix(in srgb, var(--good) 40%, transparent); }
  .pill.live::before { content:"●"; margin-right:5px; }
  .pill.warn { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 40%, transparent); }
  .pill.warn::before { content:"●"; margin-right:5px; }
  .pill.off { color: var(--text-dim); }
  .pill.off::before { content:"●"; margin-right:5px; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.3} }
  /* Header row 1, column 2.  Never justify-self:center/end here: the tabs
     sit flush against the logo so the eye travels logo → sections →
     filters on one left edge. */
  nav.tabs { display: flex; gap: 4px; margin-left: 0; flex-wrap: nowrap; align-self: center; grid-column: 2; grid-row: 1; }
  nav.tabs a {
    position: relative;
    background: transparent; color: var(--text-dim); border: 1px solid transparent;
    height: var(--control-h, 34px); box-sizing: border-box; padding: 0 13px; border-radius: var(--radius-ctl); cursor: pointer; font-size: 13px; font-weight: 500; font-family: var(--sans);
    text-decoration: none; display: inline-flex; align-items: center; white-space: nowrap;
    /* PR #2075 swapped these from <button> to <a href> for crawlability.
       A <button> centers its label via the UA stylesheet; an <a> inherits
       text-align:start, so without this the fixed mobile dock (grid cells,
       see the 768px query below) renders every icon/label flush left in
       its cell instead of centered.  Keep this explicit or the next pass
       over nav.tabs will re-break mobile alignment. */
    text-align: center;
  }
  nav.tabs a:hover { color: var(--text); background: var(--panel); }
  nav.tabs a.active { color: var(--text); background: var(--panel-2); border-color: var(--border); font-weight: 600; }
  nav.tabs a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  /* Admin-only tabs (Review Queue / Admin · Cadence) are long labels that
     crowd row 1 at laptop widths; desktop shows their short data-mobile
     label and keeps the full text in the tooltip.  Phones already render
     data-mobile under the icon. */
  @media (min-width: 769px) and (hover: hover) {
    nav.tabs a[data-admin-tab] { font-size: 0; }
    nav.tabs a[data-admin-tab]::before { content: attr(data-mobile) / ""; font-size: 13px; }
  }
  .tab-count-badge {
    display: none;
    min-width: 18px;
    height: 18px;
    margin-left: 6px;
    padding: 0 5px;
    border-radius: 999px;
    background: #ff3b30;
    color: #fff;
    font-size: 11px;
    font-weight: 700;
    line-height: 18px;
    text-align: center;
    vertical-align: middle;
  }
  .tab-count-badge.is-on { display: inline-block; }
  /* Top pad is 0 so Trends/Trades filter chrome sits in the white header
     band. Directory / Delivery / Admin / Review restore their own top pad. */
  main { padding: 0 var(--ct-main-pad, 35px) var(--ct-main-pad, 35px); max-width: 1800px; margin: 0 auto; }
  #view-people, #view-review, #view-subs, #view-admin {
    padding-top: var(--ct-main-pad, 35px);
  }
  .banner {
    font-size: 12px; color: var(--warn); border: 1px dashed color-mix(in srgb, var(--warn) 45%, transparent);
    background: color-mix(in srgb, var(--warn) 8%, transparent); padding: 8px 12px; border-radius: 8px; margin-bottom: 29px;
  }
  /* #2071: empty / hidden banners are not chrome. They must take no space so
     the sticky filter row can sit flush under header.top. */
  .banner[hidden],
  .banner:empty { display: none; margin: 0; padding: 0; border: 0; }
  .banner.err { color: var(--sell); border-color: color-mix(in srgb, var(--sell) 45%, transparent); background: color-mix(in srgb, var(--sell) 8%, transparent); }
  .view { display: none; }
  .view.active { display: block; }
  .toolbar { display: flex; gap: 16px; flex-wrap: wrap; align-items: center; margin-bottom: 22px; }
  input, select {
    background: var(--panel); color: var(--text); border: 1px solid var(--border);
    padding: 8px 11px; border-radius: 8px; font-size: 13px; font-family: var(--sans);
  }
  input::placeholder { color: var(--text-dim); }
  .grid-cards { display: grid; grid-template-columns: repeat(auto-fit,minmax(180px,1fr)); gap: 19px; margin-bottom: 32px; }
  #view-trends #trKpis.grid-cards {
    margin-top: var(--trends-gap);
    margin-bottom: var(--trends-gap);
  }
  /* Owner follow-up batch #4 (+ #12, which shares this class): .v already
     declared flex:1 but .card was never a flex container, so it silently did
     nothing — grid row-stretch (the default align-items:stretch on
     .grid-cards) left the value hugging the title with dead space below it
     (where the absolutely-positioned sparkline sits, unaffected by this).
     display:flex;flex-direction:column makes flex:1 actually apply, and
     align-content:center on .v centers the (possibly-wrapping) value line
     within whatever height the row stretches it to. */
  .card { position: relative; text-align: center; background: color-mix(in srgb, var(--panel) 75%, transparent); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px); border: 1px solid color-mix(in srgb, var(--border) 70%, transparent); border-top-color: color-mix(in srgb, var(--border) 100%, transparent); border-radius: var(--radius); padding: 22px 26px; box-shadow: inset 0 1px 0 hsla(0, 0%, 100%, 0.1), 0 8px 32px rgba(0, 0, 0, 0.2); display: flex; flex-direction: column; container-type: inline-size; }
  .card .k { color: var(--text-dim); font-size: 12px; }
  .card .v { font-size: 28px; font-weight: 700; margin-top: 4px; flex: 1; display: flex; flex-direction: row; align-items: baseline; justify-content: center; align-content: center; gap: 0; flex-wrap: nowrap; text-align: center; line-height: 1.2; min-width: 0; overflow: hidden; }
  .card .v small { font-size: 13px; font-weight: 500; color: var(--text-dim); margin-left: 0; }
  .card .v .net, .card .v .kpi-money { white-space: nowrap; max-width: 100%; overflow: hidden; font-size: 28px; font-weight: 700; }
  .card .v .bp { display: inline-flex; align-items: baseline; justify-content: center; white-space: nowrap; line-height: 1; }
  .card .v .bp-n { font-size: 28px; font-weight: 700; }
  .card .v .bp-pct { font-size: 28px; font-weight: 700; margin: 0; letter-spacing: 0; }
  .card .v .bp-w { font-size: 14px; font-weight: 500; margin-left: 0.25em; color: var(--text-dim); }
  .kpi-note { font-size: 10px; font-weight: 500; line-height: 1.2; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; margin-top: 6px; color: var(--text-dim); }
  /* Trends snapshot: extras (option footnote, sparkline) live inside .v so
     the figure + extra center as one group under a top-pinned heading. */
  #trKpis .card .v {
    flex-direction: column;
    align-items: center;
    justify-content: center;
    overflow: hidden;
  }
  #trLagKpis.grid-cards { margin-bottom: 20px; }
  #trLagKpis .card { min-height: 96px; padding: 16px 14px; }
  #trLagKpis .card .v { flex: 1; display: flex; flex-direction: row; align-items: center; justify-content: center; margin: auto 0; text-align: center; font-size: 26px; }
  #trLagKpis .card .v small { font-size: 13px; font-weight: 500; color: var(--text-dim); margin-left: 4px; }
  .kpi-spark {
    display: flex;
    align-items: flex-end;
    justify-content: center;
    gap: 1.5px;
    width: 100%;
    height: 14px;
    margin-top: 8px;
    opacity: 0.8;
    pointer-events: none;
    flex: 0 0 auto;
  }
  .info-tip { color: var(--text-dim); cursor: help; border-bottom: 0; text-decoration: none; font-size: .82em; line-height: 1; vertical-align: .35em; margin-left: 1px; }
  .info-tip:hover, .info-tip:focus-visible { color: var(--accent); outline: none; }
  table { width: 100%; border-collapse: collapse; background: color-mix(in srgb, var(--panel) 75%, transparent); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px); border: 1px solid color-mix(in srgb, var(--border) 70%, transparent); border-radius: var(--radius); overflow: hidden; box-shadow: inset 0 1px 0 hsla(0, 0%, 100%, 0.1), 0 8px 32px rgba(0, 0, 0, 0.2); }
  th, td { text-align: center; padding: 11px 13px; border-bottom: 1px solid var(--border); border-right: 1px solid color-mix(in srgb, var(--border) 42%, transparent); font-size: 13px; vertical-align: middle; }
  th, .v, .fval, .hval, .latency, .est-money, .amount-range, .amount-tier-line, .fc-amt-val, .def-v { font-variant-numeric: tabular-nums; }
  th:last-child, td:last-child { border-right: none; }
  th { color: var(--text-dim); font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: .5px; }
  tr:last-child td { border-bottom: none; }
  tr.row:hover td { background: var(--panel-2); }
  th.sortable { user-select: none; white-space: nowrap; }
  th.sortable:hover { color: var(--text); }
  th.sortable .arr { display: none; font-size: 10px; margin-left: 4px; color:var(--text-dim); }
  th.sortable.active { color: var(--text); }
  th.sortable:hover .arr { display: inline; opacity: .18; }
  th.sortable.active .arr { display: inline; opacity: 1; color: var(--accent); }
  /* Real, named control inside every sortable <th> (WEBA11Y P2 findings on
     PR #2072): a bare tabindex+aria-sort <th> is announced only as a column
     header, with no indication Enter/Space does anything. The <th> itself
     keeps its native columnheader role and carries aria-sort (WEBA11Y-01);
     .th-sort-btn is the actual focusable, named control, reset to look like
     the plain-text label it replaces so the table doesn't shift size.  Shared by the
     Trades feed, Trends leaderboard, and People directory headers. */
  .th-sort-btn {
    display: inline-block; background: none; border: 0; margin: -6px -4px; padding: 6px 4px;
    font: inherit; color: inherit; text-transform: inherit; letter-spacing: inherit;
    text-align: inherit; white-space: inherit; cursor: pointer;
  }
  .th-sort-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  #benchmarkResults { display: block; }
  .bench-table { min-width: 800px; margin-top: 16px; table-layout: fixed; }
  .bench-table th { font-size: 10px; padding: 10px 8px; line-height: 1.3; white-space: normal; }
  .bench-table td { font-size: 13px; padding: 10px 8px; white-space: normal; word-break: break-word; }
  .bench-table th:first-child, .bench-table td:first-child { width: 130px; }
  .bench-table th:last-child, .bench-table td:last-child { width: 220px; }
  #benchmarkResults { display:block; min-width:0; width:100%; margin:10px 0 14px; }
  .benchmark-toolbar { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin:10px 0; }
  .benchmark-toolbar select { min-width:min(100%, 280px); }
  .benchmark-meta { display:flex; gap:8px; flex-wrap:wrap; margin:10px 0; }
  .benchmark-chip { display:inline-flex; align-items:center; gap:4px; padding:4px 8px; border:1px solid var(--border); border-radius:999px; color:var(--text-dim); font-size:11px; }
  .benchmark-panel { border:1px solid var(--border); border-radius:12px; padding:22px; margin-top:22px; min-width:0; background:color-mix(in srgb,var(--panel-2) 44%,transparent); }
  .benchmark-panel h4 { margin:0 0 8px; }
  .benchmark-table-wrap { overflow-x:auto; width:100%; border-radius:10px; }
  .benchmark-table-wrap .bench-table { min-width:1040px; table-layout:auto; margin-top:0; }
  .benchmark-table-wrap .bench-table th:first-child,
  .benchmark-table-wrap .bench-table td:first-child { width:auto; min-width:180px; }
  .benchmark-table-wrap .bench-table th:last-child,
  .benchmark-table-wrap .bench-table td:last-child { width:auto; }
  .benchmark-model-state { margin-top:4px; font-size:11px; color:var(--text-dim); }
  .benchmark-model-state.partial { color:var(--warn); font-weight:700; }
  .benchmark-outcome-counts { margin-top:4px; font-size:11px; color:var(--text-dim); line-height:1.45; }
  .benchmark-latency-line { display:block; white-space:nowrap; }
  .benchmark-latency-line.failed { margin-top:4px; color:var(--warn); }
  .benchmark-diag-row td { padding-top:0; background:color-mix(in srgb,var(--panel-2) 34%,transparent); }
  .benchmark-diagnostics { margin:0; font-size:11px; color:var(--text-dim); }
  .benchmark-diagnostics summary { cursor:pointer; color:var(--warn); font-weight:700; }
  .benchmark-diagnostics-body { display:grid; gap:5px; margin-top:7px; line-height:1.45; overflow-wrap:anywhere; }
  .benchmark-diagnostics code { white-space:normal; word-break:break-word; }
  .benchmark-lineup { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:10px; align-items:end; }
  .benchmark-lineup label { display:block; min-width:0; }
  .benchmark-lineup select { display:block; width:100%; margin-top:4px; }
  @media (max-width:768px) {
    .benchmark-lineup { grid-template-columns:1fr; }
    .benchmark-toolbar > * { flex:1 1 150px; }
  }
  /* fold-out advanced search */
  .search-panel {
    display: none; gap: 16px; flex-wrap: wrap; align-items: center;
    margin: -4px 0 22px; padding: 19px 22px; background: var(--panel);
    border: 1px solid var(--border); border-radius: var(--radius);
  }
  .search-panel.open, dialog.search-panel[open] { display: flex; position:relative; z-index:44; }
  .search-panel .lbl { font-size: 12px; color: var(--text-dim); margin-right: 2px; }
  dialog.search-panel {
    position: fixed; top: 120px; left: 50%; transform: translateX(-50%); margin: 0;
    z-index: 100; max-width: 90vw; border: 1px solid var(--border);
    background: color-mix(in srgb, var(--panel) 90%, transparent);
    backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
  }
  dialog.search-panel::backdrop { background: rgba(2,6,18,.6); backdrop-filter: blur(4px); }
  .panel-head { display:flex; align-items:center; justify-content:space-between; gap:10px; width:100%; }
  .panel-title { color:var(--text-dim); font-size:12px; font-weight:700; text-transform:uppercase; letter-spacing:.5px; }
  .panel-close {
    display:inline-flex; align-items:center; justify-content:center; width:38px; height:38px;
    margin:-8px -8px -8px 0; border-radius:999px; border:1px solid transparent;
    background:transparent; color:var(--text-dim); cursor:pointer; font-size:20px; line-height:1;
  }
  .panel-close:hover { color:var(--text); background:var(--panel-2); border-color:var(--border); }
  .btn.ghost.sm.on { color: var(--accent); border-color: var(--accent); }
  td.state { text-align: center; color: var(--text-dim); padding: 22px 13px; }
  .tkr { font-family: var(--mono); font-weight: 700; }
  /* ---- ticker logos (ported from socratictrade.com) ---- */
  .asset-cell { display: flex; align-items: center; gap: 9px; min-width: 0; }
  /* let the text shrink inside the (resizable, fixed-layout) cell and clip with
     an ellipsis instead of wrapping or hard-clipping mid-word */
  .asset-cell > div { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .clip-text { display:block; min-width:0; max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .tkr-logo { flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; overflow: hidden; }
  .tkr-logo img { width: 100%; height: 100%; object-fit: contain; display: block; }
  /* "tile" = frosted-glass box; "transparent" = bare logo on the row surface. */
  .tkr-logo.tile { border: none; background: linear-gradient(135deg, var(--accent), #6366f1); border-radius: 8px; padding: 2px; color: #fff; box-shadow: inset 0 2px 4px rgba(255,255,255,0.2), 0 4px 10px rgba(0,0,0,0.15); }
  .tkr-logo.transparent { border-radius: 4px; }
  /* ---- politician headshots (mirrors the ticker-logo image+fallback pattern) ---- */
  .member-cell { display: flex; align-items: center; gap: 9px; min-width:0; }
  .member-cell > div { min-width:0; line-height:1.25; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .member-cell .fit-sm { font-size:12px; }
  .member-cell .fit-xs { font-size:11px; }
  #tradesTable .c-member,
  #tradesTable .c-asset { text-align: left; }
  #tradesTable.resizable .c-member > *,
  #tradesTable.resizable .c-asset > * { min-width: 0; }
  .date-short { display:none; }
  .date-time-cell { display:inline-flex; flex-direction:column; align-items:center; justify-content:center; max-width:100%; line-height:1.08; vertical-align:middle; }
  .date-time-cell .date-main { display:block; max-width:100%; overflow:hidden; text-overflow:ellipsis; font-weight:650; color:var(--text); }
  .date-time-cell .date-sub { display:block; max-width:100%; overflow:hidden; text-overflow:ellipsis; margin-top:3px; font-size:11px; color:var(--text-dim); font-family:var(--mono); }
  #tradesTable.narrow-published .c-published .date-full,
  #tradesTable.narrow-traded .c-traded .date-full,
  #tradesTable.narrow-filed .c-filed .date-full,
  #tradesTable.narrow-imported .c-imported .date-full { display:none; }
  #tradesTable.narrow-published .c-published .date-short,
  #tradesTable.narrow-traded .c-traded .date-short,
  #tradesTable.narrow-filed .c-filed .date-short,
  #tradesTable.narrow-imported .c-imported .date-short { display:inline; }
  #tradesTable.tiny-published .c-published,
  #tradesTable.tiny-traded .c-traded,
  #tradesTable.tiny-filed .c-filed,
  #tradesTable.tiny-imported .c-imported { font-size:12px; }
  #tradesTable .c-traded { font-weight: 600; color: var(--text); }
  /* The avatar shows initials by default; a successful headshot <img> overlays
     them, and onerror="this.remove()" drops the <img> to reveal initials. */
  .avatar { position: relative; flex: 0 0 auto; width: 24px; height: 24px; border-radius: 50%; overflow: hidden; display: inline-flex; align-items: center; justify-content: center; background: var(--panel-2); border: 1px solid var(--border); font-size: 10px; font-weight: 700; color: var(--text-dim); text-transform: uppercase; }
  .avatar img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; background: var(--panel-2); }
  /* iOS-parity: party-colored rings on politician photos (not account avatars).
     The ring is an inset overlay, not an outer box-shadow.  Outer shadows sit
     outside the 24px layout box and get sliced by overflow:hidden on this chip
     and on .member-cell / table td / .fc-row2 / .trades-card parents, so the
     color stopped at the cell edge instead of closing the circle. */
  .avatar.party-D,
  .avatar.party-R,
  .avatar.party-O { border-color: transparent; }
  .avatar.party-D::after,
  .avatar.party-R::after,
  .avatar.party-O::after {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: 50%;
    pointer-events: none;
    z-index: 1;
  }
  .avatar.party-D::after { border: 2px solid var(--party-d); }
  .avatar.party-R::after { border: 2px solid var(--party-r); }
  .avatar.party-O::after { border: 2px solid var(--party-o); }  .tag { font-size: 11px; padding: 4px 10px; border-radius: 999px; font-weight: 700; display:inline-block; letter-spacing: 0.4px; color: #fff; border: none; }
  /* Owner 2026-09-09: "Buy" reads white on the green pill, like "Sell" on
     the red one — near-black ink was unreadable on light mode's #15803d.
     Dark mode keeps the dark ink: its --buy is the bright #22c55e, where
     white would fail contrast (the dark-mode badge-contrast test below). */
  .tag.B, .tag.P { background: linear-gradient(135deg, var(--buy), color-mix(in srgb, var(--buy) 70%, #000)); box-shadow: 0 4px 12px color-mix(in srgb, var(--buy) 30%, transparent); color: #fff; }
  html[data-theme="dark"] .tag.B, html[data-theme="dark"] .tag.P { color: #080c17; }
  .tag.S { background: linear-gradient(135deg, var(--sell), color-mix(in srgb, var(--sell) 70%, #000)); box-shadow: 0 4px 12px color-mix(in srgb, var(--sell) 30%, transparent); }
  .tag.E { background: linear-gradient(135deg, var(--exch), color-mix(in srgb, var(--exch) 70%, #000)); box-shadow: 0 4px 12px color-mix(in srgb, var(--exch) 30%, transparent); color: #080c17; }
  .conf { font-family: var(--mono); font-size: 12px; }
  .conf.hi { color: var(--good); } .conf.mid { color: var(--warn); } .conf.lo { color: var(--sell); }
  .muted { color: var(--text-dim); }
  /* District ordinals: 17<sup class="ord">th</sup> */
  sup.ord { font-size: 0.65em; line-height: 0; vertical-align: super; font-weight: 600; letter-spacing: 0.01em; }
  .mobile-only { display: none; }
  .trades-cards { display: none; gap: 16px; min-width: 0; max-width: 100%; }
  /* Compact 2-row trade card: row1 = asset + side/amount, row2 = one muted meta line. */
  .trades-card { position: relative; display: grid; grid-template-columns: 1fr 16px; align-items: center; gap: 13px; background: var(--panel); border: 1px solid var(--border); border-radius: 14px; padding: 14px 16px; cursor: pointer; min-width: 0; max-width: 100%; overflow: hidden; box-shadow: 0 4px 14px rgba(0,0,0,.08); }
  .trades-card:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
  .trades-card:active { background: var(--panel-2); }
  .fc-main { grid-column: 1; min-width: 0; display: flex; flex-direction: column; gap: 5px; }
  .fc-row1 { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .fc-row1 .asset-cell { flex: 1 1 auto; min-width: 0; }
  .fc-amt { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 8px; white-space: nowrap; }
  .fc-amt-val { font-family: var(--mono); font-size: 13px; font-weight: 700; color: var(--text); }
  .fc-row2 { font-size: 12px; line-height: 1.4; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: flex; align-items: center; gap: 6px; }
  .fc-row2 .avatar { width: 22px; height: 22px; font-size: 8px; }
  .fc-sep { opacity: .5; margin: 0 1px; }
  .fc-member { color: var(--text); }
  .fc-owner { display: inline-block; flex: 0 0 auto; padding: 1px 6px; border-radius: 999px; border: 1px solid var(--border); background: var(--panel-2); font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: .3px; color: var(--text); }
  .fc-member.clickable:active { text-decoration: underline; }
  .fc-chevron { grid-column: 2; justify-self: end; color: var(--text-dim); font-size: 22px; line-height: 1; opacity: .55; pointer-events: none; }
  /* Visually hidden but still readable by AT — folded into the card's
     accessible name after the visible content (WEBA11Y-02). */
  .fc-hint { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
  /* Real, named control for a whole-row-click table row (WEBA11Y P2 follow-up
     to WEBA11Y-01): a <tr> that keeps its native row role (correctly, per
     WEBA11Y-01) but exposes no link/button of its own is announced only as
     "row", with no indication Enter/Space does anything. rowOpenBtnHtml()
     below renders a real <button data-txid>/<button data-asset> into the
     row's first cell. It stays visually hidden (same clip technique as
     .fc-hint above) so it adds zero footprint to the table's layout at
     rest — column widths and the resizable colgroup are unaffected — but
     :focus-visible pops it into a real, visible, focus-ringed control the
     moment a keyboard user tabs onto it (the standard "skip link" pattern).
     Mouse clicks anywhere in the row keep working via the existing
     delegated click handler; this button only adds the missing keyboard/AT
     affordance. */
  .row-open-btn { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; background: none; cursor: pointer; }
  .row-open-btn:focus-visible {
    position: relative; width: auto; height: auto; margin: 0 6px 0 0; padding: 2px 8px; overflow: visible; clip: auto;
    display: inline-block; font: inherit; font-size: 11px; color: var(--accent); background: var(--panel-2);
    border: 1px solid var(--accent); border-radius: 6px; outline: 2px solid var(--accent); outline-offset: 2px;
  }
  /* Issue #1529: iOS-parity mobile-card layout — asset+logo/badge leading,
     bold trailing amount+date stack, tighter identity-first meta line.
     Replaces .fc-row1 (kept above, unused, harmless) as tradesCardHtml()'s
     top row wrapper; card-scoped only, does not touch the dense desktop
     table's 22px .tkr-logo. */
  .fc-top { display:flex; align-items:center; gap:10px; min-width:0; }
  .fc-top .asset-cell { flex:1 1 auto; min-width:0; }
  .fc-top .tag { flex:0 0 auto; }
  /* Owner punch list #7: justify-content:center is belt-and-suspenders with
     .fc-top's own align-items:center — keeps the $-range + date cluster
     centered even if a future row grows taller than this stack. */
  .fc-trail { flex:0 0 auto; display:flex; flex-direction:column; align-items:flex-end; justify-content:center; gap:2px; margin-left:4px; }
  .fc-trail .amount-cell { align-items:flex-end; text-align:right; }
  .fc-trail .amount-range { color:var(--text); font-weight:700; font-size:13px; }
  /* Owner punch list #7: the amount pictograph's default 17px bars (sized for
     the dense desktop table) made this 3-line stack the tallest thing in the
     card's top row, inflating every mobile card. Half-height bars here only —
     the desktop table's .amount-cell / .amount-bars are untouched. */
  .fc-trail .amount-tier-line { height:10px; }
  .fc-trail .amount-bars { height:10px; }
  .fc-trail .amount-bars i:nth-child(1) { height:2px; }
  .fc-trail .amount-bars i:nth-child(2) { height:4px; }
  .fc-trail .amount-bars i:nth-child(3) { height:6px; }
  .fc-trail .amount-bars i:nth-child(4) { height:7px; }
  .fc-trail .amount-bars i:nth-child(5) { height:9px; }
  .fc-trail .amount-bars i:nth-child(6) { height:10px; }
  .fc-date { font-size:11px; white-space:nowrap; }
  .trades-card .tkr-logo { width:36px; height:36px; border-radius:9px; }
  .trades-card .tkr-logo.transparent,
  .trades-card .tkr-logo.mono,
  .trades-card .tkr-logo.glyph { background: var(--panel-2); border:1px solid var(--border); padding:5px; }
  html[data-theme="light"] .trades-card .tkr-logo.transparent,
  html[data-theme="light"] .trades-card .tkr-logo.mono,
  html[data-theme="light"] .trades-card .tkr-logo.glyph { background:#fff; }
  /* Asset-cell ticker→name spacing (the user asked for a clear gap). */
  .tkr-gap { display: inline-block; width: .65em; }
  /* Glyph-based ticker logo (e.g. AAPL ) — themes via currentColor. */
  .tkr-logo.glyph { display: inline-flex; align-items: center; justify-content: center; color: var(--text); font-size: 1.05em; }
  .tkr-logo.glyph.tile { background: var(--panel-2); border: 1px solid var(--border); border-radius: 6px; }
  /* Compact company definition grid: label/value on the SAME line (owner:
     stacked label-above-value "is impossible to look at without getting a
     headache"). .def-item uses display:contents so its .def-k/.def-v children
     become direct grid children and line up in the shared two-column grid —
     no markup change needed in companySectionHtml().  Same two caps as
     .drawer-kv: the label column stops at 180px and the block at 560px, so a
     wide drawer cannot stretch the value away from its label. */
  .def-grid { display: grid; grid-template-columns: min(35%, 180px) 1fr; gap: 7px 14px; margin: 0; max-width: 560px; }
  .def-item { display: contents; }
  .def-k { min-width: 0; color: var(--text-dim); font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; align-self: center; }
  .def-v { min-width: 0; color: var(--text); font-weight: 600; font-size: 13px; line-height: 1.35; overflow-wrap: anywhere; align-self: center; }
  /* Trade-drawer header — makes a tapped trade read as a TRANSACTION, not a company. */
  .drawer-trade-head { padding: 2px 0 6px; }
  .drawer-kicker { display: inline-block; margin-bottom: 8px; font-size: 11px; font-weight: 700; letter-spacing: .5px; text-transform: uppercase; }
  .drawer-trade-headline { margin: 0 0 4px; font-size: 22px; font-weight: 700; color: var(--text); font-family: var(--mono); }
  /* Owner punch list #14: "  |  " (two literal spaces each side, same
     convention as .fc-sep on the feed) replaces the old "·" between ticker
     and company name inside drawers. (.drawer-trade-in went with the trade
     drawer's duplicate "in TKR | Company" line — the identity card states the
     entity now.) */
  .drawer-title-line .dot-sep { margin: 0 6px; opacity: .5; font-weight: 400; }
  .drawer-trade-identity { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px; margin-top:12px; }
  .drawer-trade-party { min-width:0; border:1px solid var(--border); border-radius:10px; padding:9px 10px; background:color-mix(in srgb,var(--panel-2) 62%,transparent); }
  .drawer-trade-party .asset-cell,
  .drawer-trade-party .member-cell { max-width:100%; overflow:hidden; }
  .drawer-trade-party .asset-cell > div,
  .drawer-trade-party .member-cell > div { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .drawer-trade-party .tkr-logo,
  .drawer-trade-party .avatar { width:30px; height:30px; }
  /* Owner punch list #13(c): Owner (Self/Spouse/Joint) rides beside the
     politician's name at the top of the trade drawer instead of its own row
     further down in Trade Details. */
  .drawer-trade-owner { display:inline-block; flex:0 0 auto; padding:1px 6px; border-radius:999px; border:1px solid var(--border); background:var(--panel-2); font-size:9px; font-weight:700; text-transform:uppercase; letter-spacing:.3px; vertical-align:middle; }
  .owner-badge { display:inline-block; flex:0 0 auto; padding:1px 6px; border-radius:999px; border:1px solid var(--border); background:var(--panel-2); font-size:9px; font-weight:700; text-transform:uppercase; letter-spacing:.3px; vertical-align:middle; }
  .member-cell .owner-badge { margin-left: 2px; }
  /* Owner punch list #13(b): a small link chevron on the "Name" row in Trade
     Details signals it opens the politician drawer (the click already worked). */
  .kv-chevron { opacity:.55; margin-left:2px; }
  @media (max-width: 560px) { .drawer-trade-identity { grid-template-columns:1fr; } }
  .drawer-company-title { display:flex; align-items:center; gap:12px; min-width:0; }
  .drawer-company-title .tkr-logo { width:34px; height:34px; }
  .drawer-company-title .tkr-logo.glyph { font-size:26px; }
  .drawer-company-title .drawer-title-line { margin:0; }
  .drawer-company-title > div { min-width:0; }
  .drawer-stack-grid { display:grid; grid-template-columns:1fr; gap:19px; }
  .drawer-stack-grid .drawer-section { border:1px solid var(--border); border-radius:10px; padding:19px; min-width:0; }
  .drawer-stack-grid .hbar { min-width:0; overflow:hidden; }
  .drawer-stack-grid .hlabel { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  /* Tap-to-reveal tooltip popover (phones/tablets can't hover). */
  .tip-pop { position: fixed; z-index: 80; max-width: min(78vw, 320px); background: var(--panel-2); color: var(--text); border: 1px solid var(--border); border-radius: 10px; padding: 9px 11px; font-size: 12.5px; line-height: 1.4; box-shadow: 0 10px 30px rgba(0,0,0,.32); }
  /* Timeframe chips on section headers + the KPI-strip caption. */
  .tf-chip { font-weight: 400; font-size: .8em; color: var(--text-dim); white-space: nowrap; }
  /* Skeleton shimmer loaders (GPU-composited background animation, no layout shift). */
  @keyframes tr-shimmer { 100% { background-position: -200% 0; } }
  .sk { display: inline-block; border-radius: 6px; background: linear-gradient(90deg, var(--panel-2) 25%, color-mix(in srgb, var(--text-dim) 18%, var(--panel-2)) 37%, var(--panel-2) 63%); background-size: 200% 100%; animation: tr-shimmer 1.25s ease-in-out infinite; }
  .sk-line { height: 12px; width: 100%; margin: 7px 0; }
  @media (prefers-reduced-motion: reduce) { .sk { animation: none; } }
  /* Segmented time-range control for the buys/sells chart. */
  .seg { display: inline-flex; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
  .seg button { background: transparent; border: 0; border-left: 1px solid var(--border); color: var(--text-dim); font: 600 12px var(--sans); padding: 5px 10px; cursor: pointer; }
  .seg button:first-child { border-left: 0; }
  .seg button.on { background: color-mix(in srgb, var(--accent) 18%, transparent); color: var(--accent); }
  .seg button:hover:not(.on) { color: var(--text); }
  .trades-card-meta { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 8px 10px; min-width: 0; }
  .trades-card-meta > div { min-width: 0; }
  .trades-card-meta .mkey { display: block; color: var(--text-dim); font-size: 10px; text-transform: uppercase; letter-spacing: .4px; margin-bottom: 2px; }
  .trades-card-meta .mval { display: block; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
  .latency { font-family: var(--mono); font-size: 12px; color: var(--text-dim); }
  .amount-cell { display:flex; flex-direction:column; gap:2px; align-items:center; min-width:0; line-height:1.15; text-align:center; }
  .amount-tier-line { display:inline-flex; align-items:center; justify-content:center; color:var(--text); white-space:nowrap; }
  .amount-range { color:var(--text-dim); font-family:var(--mono); font-size:11px; font-weight:500; white-space:nowrap; }
  .amount-bars { display:inline-flex; align-items:flex-end; gap:2px; height:17px; width:40px; }
  .amount-bars i { display:block; width:4px; border-radius:2px 2px 0 0; background:color-mix(in srgb, var(--text-dim) 24%, transparent); }
  .amount-bars i:nth-child(1) { height:4px; }
  .amount-bars i:nth-child(2) { height:7px; }
  .amount-bars i:nth-child(3) { height:10px; }
  .amount-bars i:nth-child(4) { height:13px; }
  .amount-bars i:nth-child(5) { height:15px; }
  .amount-bars i:nth-child(6) { height:17px; }
  .amount-bars.tier-1 i:nth-child(-n+1),
  .amount-bars.tier-2 i:nth-child(-n+2),
  .amount-bars.tier-3 i:nth-child(-n+3),
  .amount-bars.tier-4 i:nth-child(-n+4),
  .amount-bars.tier-5 i:nth-child(-n+5),
  .amount-bars.tier-6 i:nth-child(-n+6) { background:var(--accent); }
  .fc-amt .amount-cell { align-items:flex-end; text-align:right; }
  .btn { background: var(--accent); color: #fff; border: none; padding: 8px 14px; border-radius: 8px; cursor: pointer; font-size: 13px; font-weight: 600; }
  .btn.ghost { background: transparent; border: 1px solid var(--border); color: var(--text); }
  .btn.sm { padding: 5px 10px; font-size: 12px; }
  .btn:disabled { opacity: .5; cursor: not-allowed; pointer-events: none; }
  .section { background: color-mix(in srgb, var(--panel) 75%, transparent); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px); border: 1px solid color-mix(in srgb, var(--border) 70%, transparent); border-top-color: color-mix(in srgb, var(--border) 100%, transparent); border-radius: var(--radius); padding: 24px; margin-bottom: 29px; box-shadow: inset 0 1px 0 hsla(0, 0%, 100%, 0.1), 0 8px 32px rgba(0, 0, 0, 0.2); }
  .section h3 { margin: 0 0 4px; font-size: 15px; }
  .section p.sub { margin: 0 0 16px; color: var(--text-dim); font-size: 13px; }
  .row-flex { display: flex; gap: 14px; align-items: center; flex-wrap: wrap; }
  /* Directory table: sticky sortable headers inside scroll box.
     No horizontal scroll: shrink-wrapped numeric/meta cols + fill name/asset.
     table-layout MUST stay auto: the "width:1%" shrink-to-fit idiom below is
     an auto-layout idiom. Under table-layout:fixed a percentage is taken
     literally, so col-fit/col-num collapsed to 1% of the table (~13px) and
     their content — Branch • Party • State, Trades, Politicians — spilled out
     of a wrap that clips overflow-x, leaving 2 of the 3 columns unreachable at
     every width. */
  .people-table-wrap {
    max-height: min(70vh, 720px);
    overflow-x: hidden;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    max-width: 100%;
  }
  .people-table {
    width: 100%;
    max-width: 100%;
    table-layout: auto;
    border-collapse: separate;
    border-spacing: 0;
  }
  .people-table thead th {
    position: sticky; top: 0; z-index: 3; background: var(--panel);
    cursor: pointer; user-select: none; white-space: nowrap;
    box-shadow: 0 1px 0 var(--border);
  }
  /* People/Assets mode toggle: nearly full search-field width */
  #view-people #dirMode.dir-mode-seg {
    display: flex;
    width: auto;
    max-width: 28rem;
    margin-bottom: 12px;
    border-radius: var(--radius-pill);
  }
  #view-people #dirMode.dir-mode-seg button {
    flex: 1 1 50%;
    min-height: 42px;
    padding: 10px 16px;
    font-size: 14px;
    font-weight: 600;
  }
  /* Shrink-wrap meta/numeric columns; fill column takes remainder + ellipsis */
  .people-table .col-fit {
    width: 1%;
    white-space: nowrap;
  }
  /* On a phone the meta column's own nowrap heading ("Branch • Party • State")
     is wider than any value under it, and it was taking that width out of the
     politician's name — "Ro Kha…". Let it wrap below 560px: two heading lines
     buy the name back ~85px and every column still fits without scroll. */
  @media (max-width: 560px) {
    .people-table th.col-fit, .people-table td.col-fit { white-space: normal; }
  }
  .people-table .col-num {
    width: 1%;
    white-space: nowrap;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .people-table .col-fill {
    width: 100%;  /* soaks up whatever the shrink-wrapped columns leave */
    max-width: 0; /* caps its max-content contribution so the ellipsis engages */
  }
  .people-table .col-fill .cell-clip,
  .people-table .col-fill .member-cell,
  .people-table .col-fill .dir-asset-cell,
  .people-table .col-fill .dir-asset-text {
    min-width: 0;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .people-table .col-fill .member-cell {
    display: flex;
    align-items: center;
    gap: 9px;
    text-overflow: unset;
  }
  .people-table .col-fill .member-cell .cell-clip {
    flex: 1 1 auto;
  }
  .people-table .dir-asset-cell {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    max-width: 100%;
  }
  .people-table .dir-asset-cell .tkr-logo {
    flex: 0 0 auto;
  }
  .people-table .dir-asset-text {
    flex: 1 1 auto;
    min-width: 0;
    text-align: left;
  }
  .people-table .dir-asset-text .tkr { margin-right: 6px; }
  .people-table th.col-fill, .people-table td.col-fill { text-align: left; }
  .people-table th.col-num, .people-table td.col-num { padding-right: 14px; }
  /* Review Queue + All Filing Decisions: show at most ~7 body rows, then
     scroll inside the wrap with sticky column headings. max-height only —
     empty / single "queue is clear" state stays content-sized (no min-height). */
  #view-review .review-table-wrap {
    max-height: calc(2.6rem + 7 * 4.85rem);
    overflow: auto;
    -webkit-overflow-scrolling: touch;
    border: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
    border-radius: var(--radius);
    background: color-mix(in srgb, var(--panel) 75%, transparent);
    box-shadow: inset 0 1px 0 hsla(0, 0%, 100%, 0.1);
  }
  #view-review .review-table-wrap > table {
    margin: 0;
    border: none;
    border-radius: 0;
    box-shadow: none;
    /* overflow:hidden on the global table rule clips sticky thead; clear it. */
    overflow: visible;
    background: transparent;
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
  }
  #view-review .review-table-wrap thead th {
    position: sticky;
    top: 0;
    z-index: 3;
    background: var(--panel);
    box-shadow: 0 1px 0 var(--border);
  }
  .people-table thead th:hover { color: var(--accent); }
  .people-table thead th .sort-ind { font-size: 10px; opacity: .55; margin-left: 2px; }
  .people-table thead th.sort-asc .sort-ind::after { content: '▲'; opacity: 1; }
  .people-table thead th.sort-desc .sort-ind::after { content: '▼'; opacity: 1; }
  .people-table tbody tr[data-member], .people-table tbody tr[data-asset] { cursor: pointer; }
  .people-table tbody tr[data-member]:hover td, .people-table tbody tr[data-asset]:hover td { background: color-mix(in srgb, var(--accent) 8%, transparent); }
  .people-table th:first-child, .people-table td:first-child { text-align: left; }
  .people-table td { vertical-align: middle; }
  .pager { margin-top:14px; justify-content:space-between; gap:12px; }
  .pager.pager-top { margin-top:0; margin-bottom:12px; }
  .pager.pager-bottom { margin-top:14px; }
  .pager-controls { display:flex; flex:0 0 auto; gap:0px; align-items:center; flex-wrap:nowrap; margin-left:auto; background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius-ctl); overflow: hidden; width:auto; height: var(--control-h, 34px); box-sizing: border-box; }
  .pager-controls button { border: none !important; border-radius: 0 !important; min-width: 2.25rem; height: 100%; min-height: 0; font-size: 13px; }
  .pager-controls .trades-page-msg { font-size: 13px; }
  /* Guillemet arrows (« ‹ › ») read small at the control size; one step up. */
  .pager-controls .btn.sm { font-size: 16px; line-height: 1; }
  .trades-page-msg .pg-short { display: none; }
  /* The generic .pager-controls span padding/borders belong to the counter
     box, not to its inner long/short text spans. */
  .pager-controls .pg-long, .pager-controls .pg-short { padding: 0; border: 0; }
  .pager-tools select, .pager-tools .feed-options-btn { height: var(--control-h, 34px); box-sizing: border-box; border-radius: var(--radius-ctl); font-size: 13px; }
  .pager-controls button + button { border-left: 1px solid var(--border) !important; }
  .pager-controls span { padding: 0 10px; border-left: 1px solid var(--border); border-right: 1px solid var(--border); }
  /* Owner punch list #6: .note's global margin-top:8px throws "Page 1 of 56"
     off-center inside the pager control box (align-items:center centers the
     margin box, not the text) — zero it out here so the text itself centers. */
  .pager-controls .note { margin-top: 0; }
  .pager select { padding:0 9px; font-size:13px; width:auto; }
  /* Rows + Export live in the top control band.  Bottom pager is range +
     page buttons only — do not park tools at the end of the list. */
  .pager-tools { display:flex; align-items:center; gap:8px; flex:0 0 auto; }
  .pager-bottom .pager-tools { display: none; }
  .pager .trades-count-msg { flex:0 0 auto; }
  .pager-top .trades-sort-mobile { margin: 0; }
  .feed-options { position:relative; }
  .feed-options .menu-pop { min-width:200px; top:36px; }
  .feed-options .menu-pop .prem-hint { font-size:11px; color:var(--text-dim); margin-left:6px; }
  /* Guest Sign In + Upgrade as one joined control (matches segmented filters). */
  .acct-auth-group {
    display:inline-flex; align-items:center; border:1px solid var(--border);
    border-radius:var(--radius-ctl); overflow:hidden; background:var(--panel-2);
    height:var(--control-h, 34px); box-sizing:border-box;
  }
  .acct-auth-group .btn {
    border:none !important; border-radius:0 !important; box-shadow:none !important;
    height:100%; min-height:0; padding:0 14px; font-size:13px; font-weight:600;
    display:inline-flex; align-items:center;
  }
  .acct-auth-group .btn + .btn { border-left:1px solid var(--border) !important; }
  .acct-auth-group .btn.ghost { background:transparent; }
  .acct-auth-group .btn:not(.ghost) { background:var(--accent); color:#fff; }
  .acct-auth-group .btn:hover { filter:brightness(1.06); }
  /* Trade drawer: explicit politician / company paths (whole list row opens trade). */
  .drawer-entity-actions { display:flex; flex-wrap:wrap; gap:8px; margin-top:10px; }
  .drawer-entity-actions .btn { font-size:12px; }
  .switch { position: relative; width: 46px; height: 26px; }
  .switch input { display: none; }
  .switch span { position:absolute; inset:0; background: var(--panel-2); border:1px solid var(--border); border-radius:999px; cursor:pointer; transition:.2s; }
  .switch span::after { content:""; position:absolute; width:18px; height:18px; left:3px; top:3px; background: var(--text-dim); border-radius:50%; transition:.2s; }
  .switch input:checked + span { background: color-mix(in srgb, var(--accent) 35%, transparent); border-color: var(--accent); }
  .switch input:checked + span::after { left:24px; background: var(--accent); }
  .sched-row { display:grid; grid-template-columns: 1.3fr 1fr 1fr .6fr; gap:16px; align-items:center; margin-bottom:8px; }
  .sched-row .lbl { font-size:12px; color: var(--text-dim); }
  .note { font-size:12px; color: var(--text-dim); margin-top:8px; line-height:1.5; }
  code { font-family: var(--mono); background: var(--bg); padding:1px 6px; border-radius:5px; font-size:12px; color: var(--accent); }
  /* ================= TRENDS / ANALYTICS ================= */
  .trend-grid2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 29px; }
  .trend-grid-split { display: grid; grid-template-columns: 1.25fr 0.75fr; gap: var(--trends-gap, 24px); }
  .trend-grid-split > *, .trend-grid2 > *, .trend-members-grid > *, .trend-side-stack > *, .timeliness-grid > * { min-width: 0; }
  /* All Time hides Rising Activity; let Most Active use the full row. */
  #view-trends .trend-grid2:has(#trRisingFold[hidden]) { grid-template-columns: 1fr; }
  @media (max-width: 760px) {
    .trend-grid2 { grid-template-columns: 1fr; }
    .trend-grid-split { grid-template-columns: 1fr; }
  }
  .trend-members-grid { display:grid; grid-template-columns:minmax(0, 1.6fr) minmax(0, .85fr); gap:29px; align-items:start; }
  .trend-side-stack { display:grid; grid-template-columns:1fr; gap:29px; }
  @media (max-width: 920px) { .trend-members-grid { grid-template-columns:1fr; } }
  /* Roomier side drawer on tablets (mobile bottom-sheet still kicks in at 600px). */
  @media (min-width: 601px) and (max-width: 980px) { .drawer-panel { width: 560px; } }
  /* Let the feed toolbar wrap instead of overflowing on tablet widths. */
  @media (min-width: 769px) and (max-width: 900px) { .toolbar { flex-wrap: wrap; } .toolbar input, .toolbar select { flex: 1 1 160px; } }
  @media (min-width: 1080px) { #trKpis { grid-template-columns: repeat(6,minmax(0,1fr)); } }
  .est, .est-money { color: var(--text-dim); }
  .est-money::first-letter { font-size: .82em; vertical-align: .3em; margin-right: .5px; }
  .pdot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:5px; vertical-align:middle; background: var(--text-dim); }
  .pdot.D { background:var(--party-d); } .pdot.R { background:var(--party-r); } .pdot.O { background:var(--party-o); }
  /* Standalone party dot for the filter-chip toggles and the pictograph
     legend popover — same colors as .pdot but no trailing margin, since
     those spots have no adjacent label text to space away from. */
  .party-dot { display:inline-block; width:10px; height:10px; border-radius:50%; vertical-align:middle; background: var(--text-dim); }
  .party-dot.D { background:var(--party-d); } .party-dot.R { background:var(--party-r); } .party-dot.O { background:var(--party-o); }
  .rank { color: var(--text-dim); font-family: var(--mono); font-size:12px; width:22px; text-align:right; }
  .net.pos { color: var(--buy); } .net.neg { color: var(--sell); }
  /* buy/sell split bar */
  .split { display:inline-flex; width:120px; height:9px; border-radius:5px; overflow:hidden; background: var(--panel-2); border:1px solid var(--border); vertical-align:middle; }
  .split .seg { height:100%; } .split .seg.buy { background: var(--buy); } .split .seg.sell { background: var(--sell); }
  .split-wrap { display:flex; align-items:center; gap:8px; }
  .split-wrap small { color: var(--text-dim); font-family: var(--mono); font-size:11px; white-space:nowrap; }
  tr.clickable { cursor: pointer; }
  /* horizontal proportion bar (sectors / lag / party) */
  .hbar { display:flex; align-items:center; gap:10px; margin:7px 0; }
  .hbar .hlabel { width:130px; font-size:13px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  /* track + fill are shared by .hbar (inline row) and .flowrow (stacked) */
  .htrack { flex:1; height:14px; background: var(--panel-2); border:1px solid var(--border); border-radius:7px; overflow:hidden; }
  .hfill { height:100%; background: color-mix(in srgb, var(--accent) 70%, transparent); }
  .hfill.buy { background: var(--buy); } .hfill.warn { background: var(--warn); } .hfill.sell { background: var(--sell); }
  .hbar .hval { width:120px; text-align:right; font-family: var(--mono); font-size:12px; color: var(--text-dim); }
  .hbar .hval .est-money { font-family: var(--mono); }
  /* ---- Trackless .hbar rows are LEDGER rows, not charts (Top Buyers / Top
     Sellers / Most-Traded / the return-horizon rows in the drawers). With no
     bar between them the default flex:1 label pushed the value to the far
     right edge: measured 46–58% of the row blank between the name and the
     dollar figure, with the value right-aligned inside a fixed 120px box so
     no two rows started their number in the same place. Same contract as
     .drawer-kv: bounded label column, value LEFT-aligned on one shared entry
     guide, no leader dots. 220px clears the longest real politician name
     (~209px incl. avatar + party dot) before the inherited ellipsis can
     engage; the 62% floor keeps it usable in a phone-width drawer. ---- */
  .hbar.ledger { display:grid; grid-template-columns:min(62%, 220px) 1fr; align-items:center; gap:0 12px; max-width:560px; }
  .hbar.ledger .hlabel { width:auto; min-width:0; }
  .hbar.ledger .hval { width:auto; min-width:0; text-align:left; justify-self:start; }
  .hbar.ledger .mini-trade-stat { justify-content:start; }
  /* Return-horizon rows label with "~1 mo" / "~1 yr", so the entity-name cap
     would strand the value 150px out. Same contract, label-sized column. */
  .hbar.ledger.hz { grid-template-columns:min(30%, 82px) 1fr; align-items:baseline; }
  .hbar.ledger.hz .hval { white-space:normal; }
  /* By Asset Type uses the same .flowrow layout as By Market Cap / By Party
     (label+value on top, full-width bar, stats chip). Do not use the inline
     .hbar fixed-label layout here — long labels like "Government / Municipal
     Bonds" crush the bar track and look broken. */
  .timeliness-grid { margin-top: 8px; grid-template-columns: minmax(0, 1fr) minmax(0, .92fr); align-items: stretch; gap: 29px; }
  .timeliness-panel { min-width: 0; display: flex; flex-direction: column; height: 100%; }
  .timeliness-panel h3 { font-size: 13px; letter-spacing: 0; cursor: help; margin-bottom: 4px; }
  
  .lag-dist-header { display: flex; justify-content: space-between; font-size: 11px; text-transform: uppercase; color: var(--text-dim); margin-top: 4px; padding: 0 4px; border-bottom: 1px solid var(--border); padding-bottom: 4px; }
  .lag-dist-header .day-col { width: 150px; text-align: center; }
  .lag-dist-header .count-col { width: 120px; text-align: center; }

  .lag-dist { flex: 1; padding-top: 8px; padding-bottom: 8px; box-sizing: border-box; display: flex; flex-direction: column; justify-content: center; gap: 14px; }
  .lag-dist .hbar { margin: 0; cursor: help; }
  .lag-dist .hbar .hlabel { width: 150px; font-size: 15px; font-weight: 500; text-align: center; }
  .lag-dist .htrack { height: 18px; border-radius: 9px; }
  .lag-dist .hbar .hval { font-size: 14px; font-weight: 600; width: 120px; text-align: center; }
  
  .late-filers-wrap { max-height: 242px; overflow: auto; border: 1px solid var(--border); border-radius: 8px; margin-top: 4px; }
  /* The base table overflow:hidden rule (rounded-corner clip) would make the
     table itself the sticky containing block, so the sticky header scrolls
     away with the rows (#1551 verifier measured it). The WRAP owns the radius
     + clipping here; the table must stay overflow-visible for sticky to pin
     against the scrolling wrap. */
  .late-filers-wrap table { margin: 0; overflow: visible; border-radius: 0; }
  .late-filers-wrap td { padding-top: 7px; padding-bottom: 7px; vertical-align: middle; }
  .late-filers-wrap td[data-tip] { cursor: help; }
  #view-trends .late-filers-wrap .member-cell { align-items: center; }
  /* Owner follow-up batch #5: Slowest Filers is the one Trends table that
     stays genuinely scrollable (it can run to 50 rows) — give it a sticky
     column-header row, same idiom as the Trades feed's own #tradesHead th. */
  .late-filers-wrap thead th { position: sticky; top: 0; z-index: 2; background: var(--panel); }
  @media (max-width: 760px) {
    .timeliness-grid { grid-template-columns: 1fr; gap: 48px; }
    .lag-dist { min-height: auto; }
    .late-filers-wrap { max-height: 242px; }
  }
  .mini-trade-stat { display:inline-grid; grid-template-columns:3ch 1ch minmax(5.5ch, auto); gap:6px; align-items:center; justify-content:end; }
  .mini-trade-stat .dot { text-align:center; opacity:.65; }
  /* time chart (CSS columns, no chart lib)
     Columns always flex to the container width so the chart fits the card
     (including phone screens) without horizontal scrolling. */
  .tchart { display:flex; align-items:flex-end; gap:2px; height:180px; overflow-x:hidden; padding-top:6px; width:100%; max-width:100%; box-sizing:border-box; }
  .tcol { display:flex; flex-direction:column; align-items:center; gap:4px; flex:1 1 0; min-width:0; transition: opacity 0.15s; outline: none; cursor: pointer; }
  .tcol:hover, .tcol:focus-visible { opacity: 0.8; }
  .tbars { display:flex; align-items:flex-end; justify-content:center; gap:2px; height:150px; width:100%; }
  .tbars i { display:block; width:max(2px, calc(50% - 1px)); max-width:9px; border-radius:2px 2px 0 0; min-height:0; }
  .tchart-head { display:flex; justify-content:space-between; align-items:flex-end; gap:10px; flex-wrap:wrap; }
  .tchart-controls { display:flex; gap:18px; flex-wrap:wrap; align-items:center; }
  @media (max-width: 600px) { .tchart-controls { gap: 8px; } }
  /* Stacked metrics under the politician name — frees the side column so
     names are not ellipsized on phones. .member-meta overrides the default
     nowrap/ellipsis on .member-cell > div so the stack can actually wrap. */
  #view-trends .member-cell { align-items: flex-start; }
  #view-trends .member-cell > .member-meta {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    min-width: 0;
    flex: 1 1 auto;
    white-space: normal;
    overflow: visible;
    text-overflow: unset;
  }
  #view-trends .member-cell .name-line {
    display: block;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .stack-under {
    display: flex;
    flex-direction: row;
    align-items: center;
    flex-wrap: nowrap;
    gap: 1px;
    font-size: 11px;
    color: var(--text-dim);
    line-height: 1.35;
  }
  /* Each .nb part ("1,234 trades", "1,000 buys / 234 sells") stays whole; the
     line itself may break, and SEP_DOT's regular space before the bullet is
     the only place it can, so a too-narrow cell wraps to "•   1,000 buys /
     234 sells" instead of clipping the sells count (seen at 375px and 900px
     with 4-digit counts). */
  .stack-under > span { white-space: normal; }
  .stack-under .nb { white-space: nowrap; }
  .stack-under .split-wrap { display: inline-flex; }
  .stack-under .split { display: none; }
  /* Top Performers / Most Active Politicians: larger, vertically centered
     photos beside the two-line name/stat stack. */
  #trPerformers .avatar, #trMembers .avatar { width: 34px; height: 34px; font-size: 12px; }
  #trPerformers .member-cell, #trMembers .member-cell { align-items: center; }

  .chart-tooltip {
    position: absolute; pointer-events: none; z-index: 100;
    background: var(--panel); border: 1px solid var(--border); border-radius: 8px;
    padding: 8px 12px; font-size: 13px; color: var(--text);
    box-shadow: 0 10px 30px rgba(0,0,0,0.5);
    /* Ledger contract, shared across the rows: the tooltip itself is the grid
       so "Buys" and "Sells" share one label column and both values start on
       one guide. The rows used to be individual space-between flex boxes, so
       the two numbers started 9px apart from each other — a ragged left edge
       in a 155px box. */
    display: grid; grid-template-columns: auto 1fr; align-items: baseline; gap: 4px 14px;
    transform: translate(-50%, -100%); margin-top: -10px;
    opacity: 0; transition: opacity 0.1s;
  }
  .chart-tooltip.visible { opacity: 1; }
  .chart-tooltip-title { grid-column: 1 / -1; font-weight: 700; color: var(--accent); font-size: 12px; margin-bottom: 2px; }
  .chart-tooltip-row { display: contents; }
  .chart-tooltip-lbl { color: var(--text-dim); display: flex; align-items: center; gap: 6px; }
  .chart-tooltip-val { font-variant-numeric: tabular-nums; font-weight: 500; }
  .tbars i.buy { background: var(--buy); } .tbars i.sell { background: var(--sell); }
  /* Every column reserves the SAME fixed-height label row, even when its own
     label text is empty (unlabeled columns between tick marks) — otherwise
     .tchart's align-items:flex-end bottom-aligns the shorter (label-less)
     column's whole box, which pushes that column's .tbars (and its bars)
     down past the baseline shared by labeled columns, covering the row of
     labels beneath them. A reserved height keeps every column the same
     total height regardless of label content, so all bars share one baseline
     above the label row and never dip below it. */
  .tlbl { display:block; height:12px; line-height:12px; font-size:9px; color: var(--text-dim); font-family: var(--mono); white-space:nowrap; }
  .legend { display:flex; gap:14px; font-size:12px; color: var(--text-dim); margin-bottom:6px; }
  .legend .sw { display:inline-block; width:10px; height:10px; border-radius:2px; margin-right:5px; vertical-align:middle; }
  .legend .sw.buy { background: var(--buy); } .legend .sw.sell { background: var(--sell); }
  /* ---- Trends tables: keep numeric cells on one line, let the name column
     absorb the slack and ellipsis instead of the numbers wrapping ("3 / pols").
     The name/politician cell is forced narrow (max-width:0 + width:99%) so its
     inner ellipsis engages; every other cell sizes to its content. ---- */
  #view-trends td { white-space: nowrap; }
  #view-trends td:has(.asset-cell), #view-trends td:has(.member-cell) {
    white-space: nowrap;
    width: 99%;
    max-width: 0;
  }
  #view-trends .member-cell,
  #view-trends .member-cell .name-line,
  #view-trends .member-cell > div {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  /* ---- Committee Sector Conflicts (owner 2026-09-08): the politician's
     name and as much committee text as fits come first; the rest of the
     committee list is one hover (title) or one click (any non-asset cell
     opens the politician's drawer) away.  Fixed layout + colgroup so the
     nowrap committee string can no longer balloon the table into horizontal
     scroll (measured: 995px committee cell in a 1238px card, names squeezed
     to 97px).  Committees render one per line, clamped to two, with a
     "+N more" tail. ---- */
  /* 768px floor: phones scroll the card horizontally (the table used to be
     1442px there) while ticker, side pill and dollar figure stay whole. */
  #view-trends .conflicts-table { table-layout: fixed; width: 100%; min-width: 768px; }
  #view-trends .conflicts-table .c-pol { width: 23%; }
  #view-trends .conflicts-table .c-com { width: 32%; }
  #view-trends .conflicts-table .c-sec { width: 17%; }
  #view-trends .conflicts-table .c-ast { width: 9%; }
  #view-trends .conflicts-table .c-side { width: 9%; }
  #view-trends .conflicts-table .c-est { width: 10%; }
  #view-trends .conflicts-table td:has(.member-cell) { width: auto; max-width: none; }
  #view-trends .conflicts-table td { overflow: hidden; text-overflow: ellipsis; }
  #view-trends .conflicts-table td.committees { white-space: normal; line-height: 1.35; }
  #view-trends .conflicts-table .committee-lines { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
  #view-trends .conflicts-table .committee-line { display: block; }
  #view-trends .conflicts-table .committee-line .more { color: var(--text-dim); font-size: 11px; white-space: nowrap; }
  #view-trends .conflicts-table td.est, #view-trends .conflicts-table th.est { text-align: right; }
  #view-trends .conflicts-table tbody tr.conflict-row td[data-member] { cursor: pointer; }
  #view-trends .conflicts-table tbody tr.conflict-row:hover td { background: color-mix(in srgb, var(--accent) 8%, transparent); }
  @media (max-width: 768px) { #view-trends .conflicts-table th, #view-trends .conflicts-table td { padding-left: 8px; padding-right: 8px; } }
  /* ---- Flow rows (sector / market-cap / asset-type / party): label + value
     on a top line, a full-width bar, then the stats line beneath — no
     hard-coded indent, so it stays aligned at every width.

     History: the top line used to follow the .drawer-kv / .def-grid ledger
     contract (bounded 180px label column, value LEFT-aligned on one shared
     entry guide) after the owner flagged a bare space-between figure with a
     67–88% blank gap as unreadable.  On 2026-09-08 the owner asked for the
     opposite here, with the figure LABELLED ("total volume ~$X"), set in the
     category's weight and italic, and pinned to the bar's far edge — the
     label text now ties the two ends together, and the 180px cap wrapped
     "Government / Municipal Debt" onto two lines.  .drawer-kv / .def-grid /
     .hbar.ledger keep the ledger contract; only .flowrow changed.  .flabel
     still wraps rather than ellipsizes so a label is never truncated. ---- */
  .flowrow { margin: 12px 0; }
  .flowrow:first-child { margin-top: 2px; }
  /* Owner 2026-09-08 (supersedes the bounded-label column above for these
     rows): the label owns the row and "total volume ~$X" pins to the bar's
     right edge in the label's weight (italic), so a long label such as
     "Government / Municipal Debt" never wraps under a 180px cap. */
  .flowrow .ftop { display: flex; align-items: baseline; justify-content: space-between; column-gap: 14px; margin-bottom: 6px; }
  .flowrow .flabel { flex: 1 1 auto; font-size: 15px; font-weight: 600; min-width: 0; overflow-wrap: break-word; color: var(--text); }
  .flowrow .fval { flex: 0 0 auto; text-align: right; font-size: 13px; font-weight: 600; font-style: italic; color: var(--text); white-space: nowrap; }
  .flowrow .fval .est-money { font-family: var(--mono); font-weight: 600; font-style: italic; color: inherit; }
  /* The stats line reads like a justified sentence: every stat is a flex item
     and the free width is shared evenly between them (space-between), so the
     line stretches from the bar's left edge to its right edge while each
     "N buys / N sells" pair stays tight.  No bullet separators (owner
     2026-09-08: the spacing alone separates the items; the dots looked odd).
     On phones the line wraps stat by stat; 2ch is the floor between
     neighbours on a full line. */
  .flowrow .fchip { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; column-gap: 2ch; row-gap: 2px; margin-top: 6px; font-size: 12px; color: var(--text-dim); line-height: 1.4; }
  .flowrow .fchip .fstat { white-space: nowrap; }
  /* cluster cards */
  .cluster-grid { display:grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap:19px; }
  /* Owner follow-up batch #14: desktop keeps the full party name; mobile
     (<=768px, see the .cluster-grid override below) swaps to the abbreviated
     span instead so two cards fit per row. CSS-only, not JS branching. */
  .party-abbr { display: none; }
  .ccard {
    background: var(--panel-2); border:1px solid var(--border); border-radius:10px; padding:21px 22px;
  }
  .ccard .chead { display:flex; align-items:center; gap:8px; margin-bottom:6px; }
  .ccard .big { font-size:18px; font-weight:700; }
  .ccard .faces { display:flex; margin-top:9px; }
  .ccard .faces .avatar { margin-right:-7px; box-shadow:0 0 0 2px var(--panel-2); }
  .dirpill { font-size:10px; font-weight:700; padding:2px 7px; border-radius:6px; letter-spacing:.4px; }
  .dirpill.B, .dirpill.P { color: var(--buy); background: color-mix(in srgb, var(--buy) 16%, transparent); }
  .dirpill.S { color: var(--sell); background: color-mix(in srgb, var(--sell) 16%, transparent); }
  .chip { font-size:11px; color: var(--text-dim); }
  /* modal */
  /* ---- detail drawer (trade / asset / politician) ---- */
  .drawer { position:fixed; inset:0; z-index:60; display:none; }
  .drawer.open { display:block; }
  .drawer-backdrop { position:absolute; inset:0; background:rgba(2,6,18,.55); }
  .drawer-panel { position:absolute; top:0; right:0; height:100%; width:480px; max-width:92vw; background:var(--panel); border-left:1px solid var(--border); box-shadow:-12px 0 40px rgba(0,0,0,.4); overflow-y:auto; padding:0 22px 20px; transform: translateX(100%); transition: transform 0.32s cubic-bezier(0.22, 1, 0.36, 1), background-color 0.25s; will-change: transform; }
  .drawer.open .drawer-panel { transform: translateX(0); }
  .drawer-topbar {
    position:sticky; top:0; z-index:4; display:flex; align-items:center; justify-content:space-between; gap:10px;
    min-height:60px; margin:0 -10px; padding:8px 0 6px 20px;
    pointer-events:none; background:linear-gradient(var(--panel) 80%, transparent);
  }
  /* Owner punch list #13(f): the sticky bar over every drawer used to be an
     empty strip holding only the close button — give it a one-line summary
     of what's inside instead (or leave it empty when a drawer type has
     nothing meaningful to summarize there). */
  .drawer-topbar-title {
    flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
    font-size:13px; font-weight:600; color:var(--text); opacity:.92;
    transition: opacity .22s ease, transform .22s ease;
  }
  .drawer-topbar-title .muted { font-weight:400; }
  /* Live heroes (company / politician) occupy the topbar once stuck, so the
     duplicate text next to ✕ stays invisible.  Swap heroes (trade) fade that
     summary in only after the heading would have scrolled away. */
  .drawer-topbar.has-hero-live .drawer-topbar-title { opacity:0; transform:translateY(6px); }
  .drawer-topbar.has-hero-swap .drawer-topbar-title { opacity:0; transform:translateY(6px); }
  .drawer-topbar.has-hero-swap.is-compact .drawer-topbar-title { opacity:.92; transform:none; }
  .drawer-hero {
    position:sticky; top:8px; z-index:3;
    background:var(--panel); padding:2px 52px 8px 0; margin:0;
    transition: padding .22s ease, gap .22s ease, min-height .22s ease;
  }
  .drawer-hero.drawer-company-title .tkr-logo,
  .drawer-hero.drawer-member-title .avatar {
    transition: width .22s ease, height .22s ease, font-size .22s ease;
  }
  .drawer-hero .drawer-title-line,
  .drawer-hero .drawer-member-name,
  .drawer-hero .drawer-trade-headline { transition: font-size .22s ease; }
  .drawer-hero.drawer-member-title .avatar { width:34px; height:34px; font-size:12px; }
  .drawer-hero.is-compact { padding-top:10px; padding-bottom:10px; min-height:44px; gap:8px; }
  .drawer-hero.is-compact.drawer-company-title .tkr-logo { width:22px; height:22px; }
  .drawer-hero.is-compact.drawer-company-title .tkr-logo.glyph { font-size:16px; }
  .drawer-hero.is-compact .drawer-title-line { font-size:14px; flex-wrap:nowrap; white-space:nowrap; }
  .drawer-hero.is-compact .drawer-title-line .company-name { overflow:hidden; text-overflow:ellipsis; }
  .drawer-hero.is-compact.drawer-member-title .avatar { width:22px; height:22px; font-size:9px; }
  .drawer-hero.is-compact .drawer-member-name { font-size:14px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .drawer-hero.is-compact .dsub { display:none; }
  .drawer-hero-swap { position:static; padding-right:0; background:transparent; }
  @media (prefers-reduced-motion: reduce) {
    .drawer-topbar-title,
    .drawer-hero,
    .drawer-hero.drawer-company-title .tkr-logo,
    .drawer-hero.drawer-member-title .avatar,
    .drawer-hero .drawer-title-line,
    .drawer-hero .drawer-member-name,
    .drawer-hero .drawer-trade-headline { transition: none; }
  }
  .drawer-close {
    pointer-events:auto; display:inline-flex; align-items:center; justify-content:center;
    width:48px; height:48px; margin:0; cursor:pointer; color:var(--text);
    font-size:20px; border:1px solid transparent; border-radius:999px;
    background:color-mix(in srgb, var(--panel) 92%, transparent); line-height:1; touch-action:manipulation;
  }
  .drawer-close:hover { color:var(--text); background:var(--panel-2); border-color:var(--border); }
  #detailDrawerBody { margin-top:0; padding-top:8px; padding-right:36px; }
  .drawer-title-line { display:flex; align-items:baseline; gap:8px; flex-wrap:wrap; padding-right:4px; }
  .drawer-title-line .tkr { color:var(--text); }
  .drawer .tkr { color:var(--text); }
  .drawer-title-line .company-name { min-width:0; overflow-wrap:anywhere; color:var(--text); }
  .drawer h2 { margin:0 0 2px; font-size:19px; color:var(--text); }
  .drawer-member-title { display:flex; align-items:center; gap:11px; min-width:0; }
  .drawer-member-title > div:last-child { min-width:0; }
  .drawer-member-name { margin:0; color:var(--text); overflow-wrap:anywhere; }
  .drawer .dsub { color:var(--text-dim); font-size:13px; margin:0 0 6px; }
  .drawer-section { border-top:1px solid var(--border); padding:14px 0; }
  .drawer-section.first { border-top:none; padding-top:6px; }
  .drawer-section h3 { margin:0 0 10px; font-size:11px; color:var(--text-dim); text-transform:uppercase; letter-spacing:.6px; }
  /* Two-column definition grid: label + value stay on the SAME line (owner:
     the old stacked "Name" / value-on-next-line layout "is impossible to
     look at without getting a headache"). Labels are a dim small-caps-style
     eyebrow; values read in normal strong text right next to them, e.g.
     "Filed:  Nov 7, 2024". ~35% label column holds on phones down to 375px.

     Two caps keep the contract honest as the block gets wider: the label
     column stops growing at 180px (a bare 35% of a 1600px-wide block would be
     a 560px label column, re-opening the exact void this rule closes on
     phones), and the ledger block itself stops at 560px so a wide drawer does
     not stretch values away from their labels. */
  .drawer-kv { display:grid; grid-template-columns:min(35%, 180px) 1fr; gap:8px 14px; margin:0; font-size:13px; align-items:center; max-width:560px; }
  .drawer-kv dt { color:var(--text-dim); font-size:10.5px; font-weight:700; text-transform:uppercase; letter-spacing:.4px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .drawer-kv dd { margin:0; text-align:left; word-break:break-word; font-weight:600; color:var(--text); }
  .tier-gate-note { font-size:12px; color:var(--text-dim); background:var(--panel-2); border:1px dashed var(--border); border-radius:8px; padding:9px 11px; line-height:1.5; }
  /* Owner punch list #18(a): the ticker drawer's 5 stat cards (grid-cards
     reused from the Trends KPI cards) left a big dead zone below each value —
     ID-scope so it wins over the plain ".grid-cards .card" mobile rule
     regardless of source order (see CSS-cascade note in AGENTS.md), without
     touching #view-trends' own dedicated card styling. */
  #detailDrawerBody .grid-cards .card { display:flex; flex-direction:column; padding:14px 16px; min-height:0; }
  #detailDrawerBody .grid-cards .card .v { flex:1 1 auto; flex-direction:column; align-items:center; justify-content:center; }
  /* Owner punch list #18(c): .table-wrap's padding-right:60px exists to clear
     the big Trades table's custom scrollbar gutter — pure waste in a ~440px-wide
     drawer's mini table, so the Recent Trades table reads narrower than the
     drawer for no reason. ID-scoped so it always wins. */
  #detailDrawerBody .table-wrap { padding-right:0; }
  .committee-tag { display:inline-block; font-size:11px; background:var(--panel-2); border:1px solid var(--border); border-radius:6px; padding:2px 8px; margin:0 5px 5px 0; }
  /* copyLinkHtml() splits the old single "Copy link" element into a real <a>
     (navigates, SEOSOCIAL-02) and a real <button> (copies, WEBA11Y-08) placed
     side by side; drawer-link-row carries the row layout + spacing that used
     to live on drawer-all-link alone so both controls still read as one
     compact affordance, just two of them now. */
  .drawer-link-row { display:flex; align-items:center; gap:14px; flex-wrap:wrap; margin-top:9px; }
  .drawer-all-link, .drawer-copy-link-btn { display:inline-block; margin:0; font-size:13px; background:none; border:0; padding:0; color:var(--accent); text-decoration:none; cursor:pointer; text-align:left; font-family:inherit; }
  .source-link { display:inline-block; margin-top:9px; font-size:13px; }
  .review-doc-link { display:block; margin-top:5px; font-size:12px; font-family:var(--sans); font-weight:600; white-space:nowrap; }
  .review-doc-link.inline { display:inline-block; margin:0 0 0 10px; }
  .review-edit-panel { background: color-mix(in srgb, var(--panel-2) 70%, transparent); padding: 10px 12px; border: 1px solid var(--border); border-radius: 10px; }
  .review-edit-head { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; flex-wrap:wrap; margin-bottom:8px; }
  .review-edit-head strong { display:block; margin-bottom:2px; }
  .me-row { margin: 8px 0; display:grid; grid-template-columns:minmax(80px,.6fr) 130px 165px 150px 125px 155px minmax(220px,1.8fr) minmax(210px,.9fr); gap:8px; align-items:center; }
  .me-row input, .me-row select { min-height:34px; width:100%; min-width:0; }
  .me-row .me-asset { width:100%; }
  .me-asset-type-wrap { min-width:0; }
  .me-asset-type-category { display:block; margin-top:2px; color:var(--text-dim); font-size:11px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .me-flags { display:flex; align-items:center; gap:6px 10px; flex-wrap:wrap; min-width:0; }
  .me-check { display:inline-flex; align-items:center; gap:4px; color:var(--text-dim); font-size:12px; white-space:nowrap; }
  .me-check input { min-height:0; width:auto; }
  .me-row.me-row-low-conf { background: color-mix(in srgb, var(--warn) 6%, transparent); border: 1px dashed var(--warn); border-radius: 8px; padding: 4px 6px; }
  .me-conf-badge { display:inline-block; font-size:11px; padding:2px 6px; border-radius:4px; font-weight:700; font-family:var(--mono); text-align:center; }
  .me-conf-badge.hi { color:var(--good); background:color-mix(in srgb,var(--good) 12%,transparent); }
  .me-conf-badge.mid { color:var(--warn); background:color-mix(in srgb,var(--warn) 12%,transparent); }
  .me-conf-badge.lo { color:var(--sell); background:color-mix(in srgb,var(--sell) 12%,transparent); }
  @media (max-width: 1100px) {
    .me-row { grid-template-columns:repeat(2,minmax(0,1fr)); }
    .me-row .me-asset, .me-row .me-flags { grid-column:1/-1; }
  }
  .filing-note { background:var(--panel-2); border:1px solid var(--border); border-radius:8px; padding:9px 11px; font-size:12px; line-height:1.5; color:var(--text-dim); margin:0; }
  .filing-note-kv { background:var(--panel-2); border:1px solid var(--border); border-radius:8px; padding:9px 11px; font-size:12px; }
  .filing-note-kv dd { text-align:left; }
  .perf-line { font-size:15px; font-weight:700; }
  .mini-tbl td { padding:7px 6px; }
  .mini-date { display:flex; flex-direction:column; gap:2px; line-height:1.25; }
  /* Owner punch list #18(e): give the trade date its own line so it never
     wraps mid-date now that the table has the drawer's full width (#18c). */
  .mini-date > span:first-child { white-space:nowrap; }
  .mini-date .subline { color:var(--text-dim); font-size:11px; }
  .mini-source-link { display:block; margin-top:2px; font-size:11px; font-weight:600; }
  .colopts { display:flex; flex-direction:column; gap:6px; flex:1; overflow-y:auto; overflow-x:hidden; }
  .colopt { font-size:14px; color:var(--text); display:flex; align-items:center; gap:10px; margin:0; padding:6px 4px; border-radius:6px; cursor:pointer; min-width:0; transition:background-color 0.15s ease; }
  .colopt:hover { background:color-mix(in srgb,var(--text) 4%,transparent); }
  button.colopt { font-family:var(--sans); border:1px dashed var(--border); background:color-mix(in srgb,var(--panel-2) 65%,transparent); }
  .colopt.dragging { opacity:.45; border:1px solid var(--accent); }
  .col-drag { color:var(--text-dim); cursor:grab; font-size:16px; font-weight:700; line-height:1; padding:0 4px; }
  .colopt input { flex:0 0 auto; }
  .colopt-name { overflow:hidden; text-overflow:ellipsis; }
  .premium-mark { display:inline-flex; align-items:center; justify-content:center; border:1px solid color-mix(in srgb,var(--accent) 42%,var(--border)); background:color-mix(in srgb,var(--accent) 9%,transparent); color:var(--accent); border-radius:999px; padding:1px 6px; font-size:10px; font-weight:800; line-height:1.4; }
  .panel-note { flex-basis:100%; width:100%; color:var(--text-dim); font-size:12px; line-height:1.45; margin-bottom:4px; }
  .premium-count-note { margin-left:8px; color:var(--text-dim); }
  .feature-list { margin:0 0 16px; padding-left:18px; color:var(--text-dim); font-size:13px; line-height:1.55; }
  /* text-decoration/color resets only matter for the entity cells that are
     real <a href> now (SEOSOCIAL-02) — no-op on the (still more numerous)
     non-anchor .clickable elements. */
  .clickable { cursor: pointer; text-decoration: none; color: inherit; }
  /* Generic focus-visible ring for every keyboard-focusable entity target
     (member/asset/ticker/trade). More specific selectors elsewhere (e.g.
     #view-trends tr.clickable:focus-visible) intentionally win over this via
     specificity where a richer, row-level focus treatment already exists. */
  .clickable:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
  .asset-cell.clickable:hover .tkr, .hlabel.clickable:hover .tkr, .drawer-title-line.clickable:hover .tkr, .tkr.clickable:hover,
  .company-name.clickable:hover { text-decoration: underline; }
  .member-cell.clickable:hover, .fc-member.clickable:hover, .drawer-trade-party.clickable:hover { text-decoration: underline; }
  .face-member { display: inline-flex; border-radius: 999px; }
  .face-member:hover { outline: 2px solid var(--accent); outline-offset: 1px; }
  .drawer-trade-party.clickable { transition: border-color 0.15s ease, background 0.15s ease; }
  .drawer-trade-party.clickable:hover { border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); background: color-mix(in srgb, var(--accent) 8%, var(--panel-2)); }
  .subs-msg { flex-basis: 100%; margin-top: 10px; }
  /* Programmatic labels for the Delivery create-form controls (WEBA11Y-04):
     absolutely positioned so they never occupy layout space or participate
     in flex sizing, and stay a sibling (not a wrapper) so the existing
     .row-flex > select/input responsive rules keep matching. */
  .field-vh-label { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
  .secret-panel { display:grid; gap:16px; align-items:start; background:var(--panel-2); border:1px solid var(--border); border-radius:10px; padding:19px; color:var(--text); max-width:100%; }
  .secret-panel strong { font-size:13px; }
  .secret-panel code { display:block; overflow:auto; white-space:nowrap; padding:8px; }
  .secret-actions { display:flex; gap:8px; flex-wrap:wrap; }
  .diag-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(210px,1fr)); gap:16px; margin:16px 0 22px; }
  .diag-card { border:1px solid var(--border); border-radius:10px; background:var(--panel-2); padding:18px 19px; min-width:0; }
  .diag-head { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:7px; }
  .diag-title { font-weight:700; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .diag-status { font-size:10px; font-weight:800; text-transform:uppercase; border-radius:999px; padding:2px 7px; border:1px solid var(--border); }
  .diag-status.ok { color:var(--buy); background:color-mix(in srgb,var(--buy) 13%,transparent); }
  .diag-status.warn, .diag-status.unknown { color:var(--warn); background:color-mix(in srgb,var(--warn) 13%,transparent); }
  .diag-status.error { color:var(--sell); background:color-mix(in srgb,var(--sell) 13%,transparent); }
  /* Intentional disable — grey OFF (not red stopped, not green running). */
  .diag-status.off { color:var(--text-dim); background:color-mix(in srgb,var(--text-dim) 12%,transparent); border-color:color-mix(in srgb,var(--text-dim) 35%,transparent); }
  /* Label/value ledger, not two equal columns: 1fr 1fr parked every value at
     the 50% mark whatever the label was. "auto" sizes the label column to the
     longest label in the card, which is the same shared-entry-guide contract
     the ≤560px override below already used. */
  .diag-meta { display:grid; grid-template-columns:auto 1fr; gap:5px 10px; color:var(--text-dim); font-size:11px; }
  .diag-note { margin-top:8px; color:var(--text-dim); font-size:11px; line-height:1.35; overflow-wrap:anywhere; }
  .diag-error { color:var(--sell); font-weight:700; }
  .diag-warning { color:var(--warn); font-weight:700; }
  @media (max-width: 560px) {
    .diag-grid { grid-template-columns: 1fr; gap: 16px; margin: 16px 0; }
    .diag-card { padding: 12px 14px; display: flex; flex-direction: row; flex-wrap: wrap; align-items: center; justify-content: space-between; }
    .diag-head { margin-bottom: 0; width: 100%; border-bottom: 1px solid var(--border-light); padding-bottom: 4px; margin-bottom: 4px; }
    .diag-meta { grid-template-columns: repeat(2, auto 1fr); gap: 2px 8px; width: 100%; margin-bottom: 0; }
    .diag-meta span { font-size: 10px; }
    .diag-note { width: 100%; padding-top: 4px; margin-top: 4px; font-size: 10px; }
    .drawer-panel { width:100%; max-width:100%; bottom:0; top:auto; height:90vh; border-radius:12px 12px 0 0; transform: translateY(100%); }
    .drawer.open .drawer-panel { animation: slideUpIn 0.34s cubic-bezier(0.22, 1, 0.36, 1) forwards; }
  }
  @media (max-width:600px){ .drawer-panel { width:100%; max-width:100%; } }
  footer, footer.site-footer { text-align:center; color: var(--text-dim); font-size:11px; padding:30px 35px; display:flex; flex-direction:column; gap:10px; align-items:center; }
  footer .footer-links { display:inline-flex; flex-wrap:wrap; gap:12px 16px; justify-content:center; }
  footer .footer-links a { color: var(--text-dim); text-decoration:none; }
  footer .footer-links a:hover { color: var(--accent); }
  footer .swu-attribution { display:inline-flex; align-items:center; gap:5px; color:var(--text-dim); text-decoration:none; font-size:10px; }
  footer .swu-attribution:hover { color:var(--accent); }
  footer .swu-attribution:focus-visible { outline:2px solid var(--accent); outline-offset:3px; }
  footer .swu-attribution img { display:block; width:min(288px, calc(100vw - 105px)); height:auto; border-radius:2px; background:#fff; }
  /* ---- account control + auth/billing modals ---- */
  .acct { display:flex; align-items:center; gap:8px; }
  .acct-desktop { display:flex; align-items:center; gap:10px; }
  .acct .email { font-size:12px; color:var(--text-dim); max-width:150px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .badge { font-size:10px; font-weight:700; letter-spacing:.4px; text-transform:uppercase; padding:2px 7px; border-radius:999px; border:1px solid var(--border); color:var(--text-dim); }
  .badge.premium { color:var(--good); border-color:color-mix(in srgb,var(--good) 45%,transparent); background:color-mix(in srgb,var(--good) 12%,transparent); }
  /* Owner punch list #2: no ring around the Google profile photo — var(--border)
     is a blue-tinted gray, which on a 1px circular border reads as a stray
     blue ring around the headshot. */
  .acct .avatar.lg { width:28px; height:28px; cursor:pointer; border-color:transparent; }
  .acct-menu-btn { display:flex; align-items:center; gap:7px; border:1px solid var(--border); background:transparent; color:var(--text); border-radius:var(--radius-ctl); height:var(--control-h, 34px); box-sizing:border-box; padding:0 10px 0 3px; cursor:pointer; font-family:var(--sans); font-size:13px; max-width:230px; }
  .acct-desktop > .btn.sm { height:var(--control-h, 34px); box-sizing:border-box; display:inline-flex; align-items:center; border-radius:var(--radius-ctl); font-size:13px; padding:0 12px; }
  .acct-menu-btn:hover { background:var(--panel-2); }
  .acct-menu-btn .acct-caret { color:var(--text-dim); font-size:11px; }
  .menu { position:relative; }
  .menu-pop { position:absolute; right:0; top:40px; background:var(--panel); border:1px solid var(--border); border-radius:var(--radius); padding:12px; min-width:min(420px, calc(100vw - 24px)); max-width:min(440px, calc(100vw - 16px)); box-shadow:0 18px 44px rgba(0,0,0,.28); display:none; z-index:30; }
  .menu-pop.open { display:block; }
  .menu-pop button, .menu-pop a { display:block; width:100%; text-align:left; background:transparent; border:none; color:var(--text); padding:9px 12px; border-radius:9px; cursor:pointer; font-size:13.5px; font-family:var(--sans); text-decoration:none; box-sizing:border-box; }
  .menu-section-label { font-size:15px; font-weight:700; letter-spacing:.02em; text-transform:uppercase; color:var(--text); padding:4px 12px 6px; margin-top:16px; }
  .who + .menu-section-label,
  .acct-auth-group + .menu-section-label,
  .menu-section-label:first-child { margin-top:2px; }
  .menu-divider { border-top:1px solid var(--border); margin:12px 6px 6px; }
  .menu-pop button:hover, .menu-pop a:hover { background:var(--panel-2); }
  .menu-pop .who { padding:4px 12px 10px; font-size:13px; color:var(--text-dim); border-bottom:1px solid var(--border); margin-bottom:8px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .menu-pop .theme-row {
    display:flex; align-items:center; justify-content:space-between; gap:10px;
    margin:2px 0 4px; padding:6px 12px; border:none; border-radius:0;
  }
  .menu-pop .theme-row-label { font-size:13.5px; color:var(--text-dim); flex:0 0 auto; }
  .theme-seg {
    display:inline-flex; align-items:center; gap:2px; padding:2px;
    border:1px solid var(--border); border-radius:9px; background:var(--bg);
  }
  .theme-seg-btn {
    display:inline-flex !important; align-items:center; justify-content:center; gap:5px; width:auto !important;
    border:1px solid transparent !important; background:transparent !important;
    color:var(--text-dim) !important; padding:5px 9px !important; border-radius:7px !important;
    cursor:pointer; font-size:11px !important; font-family:var(--sans); font-weight:500;
    line-height:1.1; white-space:nowrap;
  }
  .theme-seg-btn:hover { color:var(--text) !important; background:transparent !important; }
  .theme-seg-btn.active {
    color:var(--text) !important; font-weight:600;
    border-color:var(--border) !important; background:var(--panel) !important;
    box-shadow:0 1px 2px rgba(0,0,0,.12);
  }
  .theme-seg-btn svg { width:13px; height:13px; flex:0 0 auto; }
  .acct-mobile-menu .theme-row {
    display:block; margin:0; padding:0; border:none;
  }
  .acct-mobile-menu .theme-seg { display:flex; width:100%; background:var(--bg-2); }
  .acct-mobile-menu .theme-seg-btn { flex:1 1 0; min-width:0; }
  /* Guest header theme control (signed-out) */
  .theme-guest { display:inline-flex; align-items:center; }
  .theme-guest .theme-seg { background:var(--panel-2); }
  /* ---- Mobile header menu (<=720px) ----
     Desktop keeps the full theme-toggle / Sign In / Upgrade cluster
     (.acct-desktop). At <=720px that cluster is replaced by a single
     hamburger button (.acct-hamburger) opening a dropdown with the same
     controls, so the brand lockup never overlaps the header chrome
     (issue #1456). .acct-mobile is hidden by default and only shown under
     the mobile breakpoint (see the 720px media query near the bottom nav). */
  .acct-mobile { display:none; position:relative; }
  /* Owner punch list #1: the hamburger glyph sits on its own — no ring/circle
     at rest. A soft hover/open background is still fine as an affordance.
     Signed-in users with a Google/Apple profile photo get that photo here
     instead of the glyph (renderAccount()); the button stays >=44x44 as a
     tap target even though the avatar drawn inside it is only 28x28. */
  .acct-hamburger {
    width:44px; height:44px; border:none; border-radius: var(--radius-pill);
    background:transparent; color:var(--icon-grey); font-size:15px; line-height:1;
    display:flex; align-items:center; justify-content:center; cursor:pointer; padding:0;
  }
  .acct-hamburger:hover, .acct-hamburger[aria-expanded="true"] { background:var(--panel-2); color:var(--accent); }
  /* Owner 2026-09-21 punch list: 3 custom-drawn bars (replaces the unicode
     ☰ whose non-centered glyph metrics pushed the lines off-center inside
     the circle). 15% smaller than the previous 18px font; medium-grey
     (--icon-grey) instead of the dark --text. Bars are 12px wide (matches
     the visual weight of the old glyph without crowding the 44px tap
     target), 2px tall, 4px gap. */
  .acct-hamburger-bars { display:inline-flex; flex-direction:column; gap:4px; width:14px; height:12px; align-items:center; justify-content:center; }
  .acct-hamburger-bars > span { display:block; height:2px; width:100%; background:currentColor; border-radius:1px; }
  .acct-hamburger .avatar.lg { cursor:pointer; pointer-events:none; }
  .acct-mobile-menu {
    position:absolute; right:0; top:46px; z-index:60; min-width:220px;
    max-width:min(300px, calc(100vw - 24px)); background:var(--panel);
    border:1px solid var(--border); border-radius:12px; padding:12px;
    box-shadow:0 14px 34px rgba(0,0,0,.4); display:none;
  }
  /* Owner punch list #2: more vertical breathing room between rows. */
  .acct-mobile-menu.open { display:grid; gap:10px; }
  .acct-mobile-menu .btn { width:100%; justify-content:center; }
  .acct-mobile-menu .badge { justify-self:start; margin:0 2px 2px; }
  .acct-mobile-menu .menu { width:100%; }
  .acct-mobile-menu .acct-menu-btn { width:100%; max-width:none; justify-content:space-between; }
  /* Phone sheet: Sign In / Upgrade become stacked full-width rows (same
     shape as the login modal's provider buttons), not the joined desktop pair. */
  .acct-mobile-menu .acct-auth-group { display:flex; flex-direction:column; gap:8px; border:0; background:transparent; border-radius:0; overflow:visible; height:auto; }
  .acct-mobile-menu .acct-auth-group .btn { width:100%; height:44px; min-height:44px; border:1px solid var(--border) !important; border-radius:var(--radius-ctl) !important; justify-content:flex-start; padding:0 16px; font-size:16px; font-weight:500; }
  .acct-mobile-menu .acct-auth-group .btn + .btn { border-left:1px solid var(--border) !important; }
  .acct-mobile-menu .menu-pop { position:static; box-shadow:none; border:none; padding:4px 0 0; min-width:0; max-width:none; }
  /* Owner punch list #2: ~8px gap between the avatar photo and the email text
     (the mobile "who" row combines both — the desktop .menu-pop .who row is
     text-only and untouched). */
  .acct-mobile-menu .who { display:flex; align-items:center; gap:8px; padding:2px 2px 4px; }
  .acct-mobile-menu .footer-disclaimer { font-size:11px; line-height:1.45; color:var(--text-dim); padding:8px 2px 2px; border-top:1px solid var(--border); margin-top:2px; }
  html[data-theme="dark"] { color-scheme: dark; }
  html[data-theme="light"] { color-scheme: light; }
  .overlay { position:fixed; inset:0; background:rgba(4,8,16,.62); backdrop-filter:blur(3px); display:none; align-items:center; justify-content:center; z-index:80; padding:18px; }
  .overlay.open { display:flex; }
  .modal { background:var(--panel); border:1px solid var(--border); border-radius:16px; padding:26px; width:100%; max-width:520px; box-shadow:0 24px 60px rgba(0,0,0,.45); }
  #loginOverlay .modal { max-width: 400px; padding: 26px 24px; }
  .auth-btn-stack { display:flex; flex-direction:column; gap:10px; margin-top:14px; width:100%; }
  /* Sign-in providers: one base rule shaped like Socratic.Trade's login
     buttons (owner 2026-09-09) — full-width 44px rows, 10px corners,
     mark + label left-aligned, 19px/500 label.  Provider colours below. */
  .auth-btn, .auth-btn.gbtn, .gbtn, .auth-btn.abtn, .abtn, .auth-btn.xbtn, .xbtn {
    display:inline-flex; align-items:center; justify-content:flex-start; text-align:left; gap:12px;
    width:100%; height:44px; min-height:44px; padding:0 16px; box-sizing:border-box;
    border:1px solid var(--border); border-radius:10px;
    font-size:19px; font-weight:500; line-height:1; font-family:inherit;
    cursor:pointer; text-decoration:none; color:var(--text);
    transition:border-color .15s, background .15s; -webkit-tap-highlight-color:transparent;
  }
  .auth-btn svg { width:20px; height:20px; flex:0 0 20px; }
  .auth-btn.gbtn, .gbtn { background:var(--panel-2); color:var(--text); }
  .auth-btn.gbtn:hover, .gbtn:hover { border-color:var(--accent); }
  .auth-btn.abtn, .abtn, .auth-btn.xbtn, .xbtn { border-color:#333; background:#000; color:#fff; }
  .auth-btn.abtn:hover, .abtn:hover, .auth-btn.xbtn:hover, .xbtn:hover { border-color:#666; }
  .modal h2 { margin:0 0 6px; font-size:19px; }
  .modal p.sub { margin:0 0 18px; color:var(--text-dim); font-size:13px; }
  .modal .close { float:right; display:inline-flex; align-items:center; justify-content:center; width:40px; height:40px; margin:-10px -10px 0 6px; background:transparent; border:1px solid transparent; border-radius:999px; color:var(--text-dim); font-size:20px; cursor:pointer; line-height:1; }
  .modal .close:hover { color:var(--text); background:var(--panel-2); border-color:var(--border); }
  .divider { display:flex; align-items:center; gap:10px; color:var(--text-dim); font-size:12px; margin:16px 0; }
  .divider::before, .divider::after { content:""; flex:1; height:1px; background:var(--border); }
  .field { display:flex; gap:8px; margin-top:6px; }
  .field input { flex:1; }
  .plan-grid { display:grid; grid-template-columns:1fr 1fr; gap:12px; margin:8px 0; }
  .plan { display:block; border:1px solid var(--border); border-radius:12px; padding:16px 14px; cursor:pointer; position:relative; transition:border-color .15s; }
  .plan:hover, .plan.sel { border-color:var(--accent); background:color-mix(in srgb,var(--accent) 7%,transparent); }
  .plan:focus-within { outline: 2px solid var(--accent); outline-offset: 2px; }
  .plan .price { font-size:23px; font-weight:800; }
  .plan .per { font-size:12px; color:var(--text-dim); }
  .plan .cad { font-size:13px; font-weight:600; margin-bottom:6px; }
  .plan .save { position:absolute; top:-9px; right:10px; font-size:10px; font-weight:800; color:#ffffff; background:#15803d; padding:2px 7px; border-radius:999px; box-shadow:0 1px 3px rgba(0,0,0,0.25); }
  .plan-radio-input { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0; }
  .trial-note { font-size:12px; color:var(--text-dim); text-align:center; margin:8px 0 2px; }
  .toast { position:fixed; left:50%; bottom:24px; transform:translateX(-50%); background:var(--panel-2); border:1px solid var(--border); color:var(--text); padding:11px 16px; border-radius:10px; font-size:13px; z-index:60; box-shadow:0 8px 24px rgba(0,0,0,.35); display:none; max-width:90vw; }
  .toast.show { display:block; }
  .toast.err { border-color:color-mix(in srgb,var(--sell) 55%,transparent); color:var(--sell); }
  .gate-note { font-size:12px; color:var(--text-dim); display:flex; align-items:center; gap:10px; flex-wrap:wrap; justify-content:center; }
  
  .bare-select {
    border: 1px solid transparent;
    background: color-mix(in srgb, var(--accent) 8%, transparent);
    color: var(--accent);
    font-family: inherit;
    font-size: inherit;
    font-weight: inherit;
    padding: 2px 20px 2px 6px;
    margin: 0 0 0 4px;
    cursor: pointer;
    outline: none;
    appearance: none;
    -webkit-appearance: none;
    background-image: url('data:image/svg+xml;utf8,<svg fill="%23005fb8" height="16" viewBox="0 0 24 24" width="16" xmlns="http://www.w3.org/2000/svg"><path d="M7 10l5 5 5-5z"/></svg>');
    background-repeat: no-repeat;
    background-position: right 2px center;
    border-radius: 6px;
    transition: all .15s;
  }
  [data-theme="dark"] .bare-select {
    color: var(--accent);
    background-image: url('data:image/svg+xml;utf8,<svg fill="%234da3ff" height="16" viewBox="0 0 24 24" width="16" xmlns="http://www.w3.org/2000/svg"><path d="M7 10l5 5 5-5z"/></svg>');
  }
  .bare-select:hover {
    background-color: color-mix(in srgb, var(--accent) 15%, transparent);
    border-color: color-mix(in srgb, var(--accent) 30%, transparent);
  }

  /* ---- Branch / Party / Type chip multi-select ---- */
  /* Three segmented strips sit adjacent on the shared filter row: H·S·P
     (branch), party dots (red/blue/purple), ▲▼⇄ (buy/sell/exchange). All three share the
     exact same joined-segment treatment (single outer border, no internal
     gaps, divider between buttons) so the row reads as one filter cluster.
     One combined ⓘ (.filters-info-wrap) sits after them explaining every
     pictograph — see qFiltersInfo / trFiltersInfo below. */
  .branch-filters { position:relative; display:flex; align-items:center; gap:6px; margin:0 4px; }
  .branch-seg, .party-chips, .side-chips { display:inline-flex; align-items:center; border:1px solid var(--border); border-radius:9px; overflow:hidden; }
  .branch-toggle, .party-chip, .side-chip {
    min-width:34px; height:30px; border:none; background:transparent; color:var(--text-dim);
    font-weight:700; font-size:12px; cursor:pointer; display:flex; align-items:center;
    justify-content:center; transition:background .15s, color .15s; line-height:1; padding:0 10px;
  }
  .branch-toggle + .branch-toggle, .party-chip + .party-chip, .side-chip + .side-chip { border-left:1px solid var(--border); }
  .branch-toggle:hover, .party-chip:hover, .side-chip:hover { background:var(--panel-2); color:var(--text); }
  .branch-toggle.on, .party-chip.on, .side-chip.on { background:color-mix(in srgb, var(--accent) 16%, transparent); color:var(--text); box-shadow:inset 0 0 0 1px var(--accent); }
  .branch-toggle:focus-visible, .party-chip:focus-visible, .side-chip:focus-visible { outline:2px solid var(--accent); outline-offset:-2px; }
  .party-chip { font-size:14px; }
  .party-chip.on[data-party="D"] { background:color-mix(in srgb, var(--buy) 14%, transparent); box-shadow:inset 0 0 0 1px var(--buy); }
  .party-chip.on[data-party="R"] { background:color-mix(in srgb, var(--sell) 14%, transparent); box-shadow:inset 0 0 0 1px var(--sell); }
  /* Fat iOS-like arrows (mask, not thin unicode). Compact filter icon
     and dropdown rows share these so color always shows — the old
     .side-chip-only rules left the toolbar trio uncolored. Buy = green
     up, sell = red down, exchange = ink left-right. */
  .side-up, .side-dn, .side-ex {
    display: inline-block; width: 12px; height: 12px; vertical-align: -1px;
    font-size: 0 !important; line-height: 0; overflow: hidden;
    background-color: currentColor;
    -webkit-mask: no-repeat center / contain;
    mask: no-repeat center / contain;
  }
  .side-up {
    color: var(--buy);
    -webkit-mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath fill='none' stroke='black' stroke-width='2.6' stroke-linecap='round' stroke-linejoin='round' d='M8 13.2V2.8M3.4 7.4 8 2.8l4.6 4.6'/%3E%3C/svg%3E");
    mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath fill='none' stroke='black' stroke-width='2.6' stroke-linecap='round' stroke-linejoin='round' d='M8 13.2V2.8M3.4 7.4 8 2.8l4.6 4.6'/%3E%3C/svg%3E");
  }
  .side-dn {
    color: var(--sell);
    -webkit-mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath fill='none' stroke='black' stroke-width='2.6' stroke-linecap='round' stroke-linejoin='round' d='M8 2.8v10.4M3.4 8.6 8 13.2l4.6-4.6'/%3E%3C/svg%3E");
    mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath fill='none' stroke='black' stroke-width='2.6' stroke-linecap='round' stroke-linejoin='round' d='M8 2.8v10.4M3.4 8.6 8 13.2l4.6-4.6'/%3E%3C/svg%3E");
  }
  .side-ex {
    color: var(--text);
    -webkit-mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath fill='none' stroke='black' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round' d='M2.2 8h11.6M5.2 5 2.2 8l3 3M10.8 5l3 3-3 3'/%3E%3C/svg%3E");
    mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath fill='none' stroke='black' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round' d='M2.2 8h11.6M5.2 5 2.2 8l3 3M10.8 5l3 3-3 3'/%3E%3C/svg%3E");
  }
  .ios-filter.has-sel .ios-filter-ico.sides .side-up { color: var(--buy); }
  .ios-filter.has-sel .ios-filter-ico.sides .side-dn { color: var(--sell); }
  .ios-filter.has-sel .ios-filter-ico.sides .side-ex { color: var(--text); }
  .side-chip.on[data-side="B"] { background:color-mix(in srgb, var(--buy) 14%, transparent); box-shadow:inset 0 0 0 1px var(--buy); }
  .side-chip.on[data-side="S"] { background:color-mix(in srgb, var(--sell) 14%, transparent); box-shadow:inset 0 0 0 1px var(--sell); }
  .side-chip.on[data-side="E"] { background:color-mix(in srgb, var(--exch) 14%, transparent); box-shadow:inset 0 0 0 1px var(--exch); }
  /* Issue #1529: capsule chrome pass — true pill radius + shared control
     height, plus a bolder solid-fill "on" state (reuses .tag's proven
     buy/sell/accent + white-text contrast pairs). These layer on top of the
     tinted/inset-ring rules above via source order (same specificity),
     restyle-only — data-ch/data-party/data-side, .on, aria-pressed and the
     delegated qChamber/qPartyGroup/qSideGroup listeners are untouched. */
  .branch-seg, .party-chips, .side-chips { border-radius: var(--radius-pill); }
  .branch-toggle, .party-chip, .side-chip { height: var(--control-h); }
  .branch-toggle.on { background: var(--accent); color: #fff; box-shadow: none; }
  .party-chip.on[data-party="D"] { background: var(--buy); box-shadow: none; }
  .party-chip.on[data-party="R"] { background: var(--sell); box-shadow: none; }
  .party-chip.on[data-party="O"] { background: var(--accent); color:#fff; box-shadow: none; }

  /* iOS-style filter dropdowns (Trades + Trends). The old H/S/P chip strip
     is now a Menu + check-style list, same as FeedControlBar. */
  .ios-filter { position: relative; flex: 0 0 auto; display: inline-flex; }
  .ios-filter-btn {
    display: inline-flex; align-items: center; gap: 6px;
    height: var(--control-h, 34px); box-sizing: border-box; padding: 0 10px;
    border: 1px solid var(--border); border-radius: var(--radius-ctl);
    background: var(--panel); color: var(--text);
    font: inherit; font-size: 13px; font-weight: 600; cursor: pointer;
    white-space: nowrap;
  }
  .ios-filter-btn:hover { border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); }
  .ios-filter-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .ios-filter-btn[aria-expanded="true"] { border-color: var(--accent); background: var(--panel-2); }
  .ios-filter-btn::after {
    content: ""; width: 0; height: 0; margin-left: 2px;
    border-left: 3.5px solid transparent; border-right: 3.5px solid transparent;
    border-top: 4px solid currentColor; opacity: .55;
  }
  /* An active filter tints its closed chip (accent ink + faint accent
     wash) so a narrowed feed is visible at a glance without opening the
     menu; the label still spells it out (House / D / Buys). */
  .ios-filter.has-sel .ios-filter-btn {
    border-color: color-mix(in srgb, var(--accent) 55%, var(--border));
    color: var(--accent);
    background: color-mix(in srgb, var(--accent) 8%, var(--panel));
  }
  .ios-filter-ico { font-size: 13px; line-height: 1; }
  .ios-filter-ico.sides { display: inline-flex; align-items: center; gap: 3px; }
  /* Multi-selects ("House+Senate", "Buys+Sells+Exch") stay one chip width
     so the row keeps its search box at laptop widths; the branch chip gets
     room for "House+Senate+Executive" (170px) and every summary carries its
     full text as a tooltip (setSummary()). */
  .ios-filter-lbl { display: inline-block; max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: middle; }
  #qChamber .ios-filter-lbl, #trChamber .ios-filter-lbl { max-width: 176px; }
  .ios-filter-lbl:empty { display: none; }
  .ios-filter-pop {
    position: absolute; z-index: 60; top: calc(100% + 6px); left: 0; min-width: 196px;
    padding: 6px; border-radius: var(--radius);
    background: var(--panel);
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
    border: 1px solid var(--border);
    box-shadow: 0 12px 40px rgba(0,0,0,.12);
    display: flex; flex-direction: column; gap: 2px;
  }
  .ios-filter-pop[hidden] { display: none; }
  .ios-filter-item, .ios-filter-clear {
    display: flex; align-items: center; gap: 8px;
    width: 100%; text-align: left; border: 0; background: transparent;
    color: var(--text); font: inherit; font-size: 14px; padding: 9px 10px;
    border-radius: var(--radius-ctl); cursor: pointer;
  }
  .ios-filter-item:hover, .ios-filter-clear:hover { background: var(--panel-2); }
  .ios-filter-item.on { background: transparent; font-weight: 600; }
  .ios-filter-item.on::after { content: "✓"; margin-left: auto; font-weight: 700; color: var(--text); }
  .ios-filter-clear { color: var(--text-dim); font-size: 13px; }
  /* The outer wrappers reuse .party-chips / .side-chips / .branch-filters
     so the existing delegated listeners keep working.  Those class names
     still carry the old joined-segment chrome (overflow:hidden, pill
     border, chip height) which clipped Parties/Sides menus and painted
     House/Senate/Executive as leftover chips inside Branches. */
  .ios-filter.party-chips,
  .ios-filter.side-chips,
  .ios-filter.branch-filters {
    display: inline-flex; overflow: visible; border: none; border-radius: 0;
    background: transparent; margin: 0; gap: 0;
  }
  .ios-filter .ios-filter-item.branch-toggle,
  .ios-filter .ios-filter-item.party-chip,
  .ios-filter .ios-filter-item.side-chip {
    min-width: 0; height: auto; min-height: 0; justify-content: flex-start;
    border: 0; border-left: 0; border-radius: 10px; padding: 9px 10px;
    background: transparent; box-shadow: none; color: var(--text);
    font-weight: 500; font-size: 14px;
  }
  .ios-filter .ios-filter-item.branch-toggle + .ios-filter-item.branch-toggle,
  .ios-filter .ios-filter-item.party-chip + .ios-filter-item.party-chip,
  .ios-filter .ios-filter-item.side-chip + .ios-filter-item.side-chip {
    border-left: 0;
  }
  .ios-filter .ios-filter-item.branch-toggle.on,
  .ios-filter .ios-filter-item.party-chip.on,
  .ios-filter .ios-filter-item.party-chip.on[data-party="D"],
  .ios-filter .ios-filter-item.party-chip.on[data-party="R"],
  .ios-filter .ios-filter-item.party-chip.on[data-party="O"],
  .ios-filter .ios-filter-item.side-chip.on,
  .ios-filter .ios-filter-item.side-chip.on[data-side="B"],
  .ios-filter .ios-filter-item.side-chip.on[data-side="S"],
  .ios-filter .ios-filter-item.side-chip.on[data-side="E"] {
    background: transparent;
    color: var(--text); box-shadow: none;
  }
  .ios-filter .ios-filter-item.side-chip.on[data-side="B"] .side-up { color: var(--buy); }
  .ios-filter .ios-filter-item.side-chip.on[data-side="S"] .side-dn { color: var(--sell); }
  .ios-filter .ios-filter-item.side-chip.on[data-side="E"] .side-ex { color: var(--text); }
  .side-chip.on[data-side="B"] { background: var(--buy); box-shadow: none; }
  .side-chip.on[data-side="B"] .side-up { color:#fff; }
  .side-chip.on[data-side="S"] { background: var(--sell); box-shadow: none; }
  .side-chip.on[data-side="S"] .side-dn { color:#fff; }
  .side-chip.on[data-side="E"] { background: var(--exch); box-shadow: none; }
  .side-chip.on[data-side="E"] .side-ex { color:#fff; }
  .filter-groups { display:inline-flex; align-items:center; gap:6px; flex-wrap:wrap; }
  /* Single combined info popover replacing the old per-group ⓘs — a little
     larger than a plain .branch-info since it now carries every pictograph. */
  .filters-info-wrap { position:relative; display:inline-flex; align-items:center; }
  .filters-info-wrap .branch-info { width:28px; height:28px; font-size:14px; color:var(--icon-grey); }
  .filters-info-wrap .branch-pop { min-width:250px; }
  /* Owner 2026-09-21 punch list: info ⓘ matches the new hamburger treatment —
     medium grey (--icon-grey, ~30% lighter than --text) and 15% smaller (14px
     here vs 17px previously) so the two header glyphs sit at the same visual
     weight. Stays centered inside the same-size 28px circle. */
  .branch-info { width:24px; height:24px; border-radius:999px; border:none; background:transparent; color:var(--icon-grey); font-size:13px; line-height:1; cursor:pointer; padding:0; display:flex; align-items:center; justify-content:center; }
  .branch-info:hover, .branch-info:focus-visible, .branch-info[aria-expanded="true"] { color:var(--accent); outline:none; }
  .branch-pop { position:absolute; top:calc(100% + 8px); left:0; z-index:60; min-width:270px; max-width:min(340px, 92vw); background:var(--panel); border:1px solid var(--border); border-radius:10px; padding:10px 12px; display:grid; gap:6px; font-size:12px; color:var(--text); box-shadow:0 10px 30px rgba(0,0,0,.35); }
  .branch-pop-row { display:grid; grid-template-columns:16px 1fr; gap:8px; align-items:baseline; }
  /* Owner feedback: this legend previously painted every glyph (H/S/P, the
     party emoji, and the ▲▼⇄ trio) in var(--accent) link-blue, which doesn't
     match any of those symbols' live colors on the toolbar. H/S/P now use
     the themed ink color (matches the live H/S/P chips, which are neutral
     text, not blue), and the trade-type row below restores each glyph's
     real semantic color: green buy, red sell, and the same ink color the
     ⇄ toggle uses at rest (see .side-chip .side-ex above). */
  .branch-pop-row .branch-icon { color:var(--text); font-weight:700; }
  .branch-pop-row .branch-icon.icon-buy { color:var(--buy); }
  .branch-pop-row .branch-icon.icon-sell { color:var(--sell); }
  .branch-pop-row .branch-icon.icon-exch { color:var(--text); font-weight:900; -webkit-text-stroke:.4px var(--text); }
  .branch-pop-note { color:var(--text-dim); font-size:11px; margin-top:2px; }
  /* Must stay display:flex (NOT inline-flex): this class lands on the same
     element as .toolbar, and an inline-flex override makes the Trends row
     shrink-to-fit at desktop widths, breaking the shared-row parity with the
     Trades tab. */
  .trends-filter-row { display:flex; align-items:center; gap:16px; flex-wrap:wrap; }
  /* Issue #1529: Timeframe becomes an icon+value+chevron pill that still
     opens the native <select> option list — CSS-only wrapper around the
     existing element, id/onchange/<option>s untouched. (Owner follow-up
     batch #21: the $ Minimum pill/select was removed entirely — no $/size
     dropdown on any platform. The server-side minAmount query param still
     exists for direct API consumers.) */
  .pill-select { position:relative; display:inline-flex; align-items:center; height:var(--control-h); width:max-content; max-width:100%; flex:0 0 auto; }
  .pill-select::before { position:absolute; left:12px; font-size:11px; color:var(--text-dim); pointer-events:none; line-height:1; }
  .pill-select.pill-cal::before { content:"📅"; }
  .pill-select-el {
    appearance:none; -webkit-appearance:none; -moz-appearance:none;
    width:auto; field-sizing:content; max-width:100%; height:100%; border:1px solid var(--border); background:var(--panel);
    color:var(--text); border-radius:var(--radius-ctl); font:600 13px var(--sans);
    padding:0 26px 0 30px; cursor:pointer;
    background-repeat:no-repeat; background-position:right 8px center;
    background-image:url('data:image/svg+xml;utf8,<svg fill="%2334435b" height="14" viewBox="0 0 24 24" width="14" xmlns="http://www.w3.org/2000/svg"><path d="M7 10l5 5 5-5z"/></svg>');
  }
  html[data-theme="dark"] .pill-select-el {
    background-image:url('data:image/svg+xml;utf8,<svg fill="%23b8c7dd" height="14" viewBox="0 0 24 24" width="14" xmlns="http://www.w3.org/2000/svg"><path d="M7 10l5 5 5-5z"/></svg>');
  }
  .pill-select-el:hover { border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); }
  .pill-select-el:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
  /* Owner punch list #8: #qMember / #qTicker are plain rounded fields now —
     no leading icon glyph on desktop or mobile (id/oninput/aria-label on the
     <input> untouched). */
  .icon-field { position:relative; display:inline-flex; align-items:center; min-width:0; }
  .icon-input { padding:0 12px 0 32px; border-radius:var(--radius-ctl); height:var(--control-h); box-sizing:border-box; width:100%; font-size:13px; }
  /* Leading magnifier so the search field reads as search, not a free text box. */
  #qSearchField::before {
    content: ""; position: absolute; left: 11px; top: 50%; width: 14px; height: 14px; margin-top: -7px;
    pointer-events: none; opacity: .6;
    background: currentColor;
    -webkit-mask: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2.4" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>') center / contain no-repeat;
    mask: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2.4" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>') center / contain no-repeat;
  }
  #qSearch::-webkit-search-cancel-button { -webkit-appearance: none; appearance: none; }
  .shared-filters, .trades-only-filters { margin-bottom:0; }
  /* Filter chrome lives in header.top row 2 (#ctFilters) — see the header
     grid rules.  The Trends copy (#trendsSharedFilters) is a hidden state
     mirror: trParams()/getTrWindow() still read it and the chip sync keeps
     it in step with the header controls. */
  .trades-toolbars .toolbar { margin-bottom: 0; }
  #trendsSharedFilters[data-filter-mirror] { display: none !important; }
  /* Owner punch list #9: desktop (>768px) merges the Trades feed's two
     toolbars onto one row — timeframe pill, segmented groups + ⓘ, then the
     search fields + Search button. display:contents on both toolbar divs
     flattens their EXISTING direct children into this flex row (no DOM nodes
     move, no wrapper added around them), so the <=768px ID-scoped
     #tradesExtraFilters grid (DO-NOT-BREAK) is completely unaffected — this
     whole block simply doesn't apply there. (Owner follow-up batch #21/#23:
     the $ pill that used to close this row is gone — no orphaned auto-margin
     or trailing gap left behind; search is now the last item.) */
  @media (min-width: 769px) {
    .trades-toolbars { display:flex; flex-wrap:nowrap; align-items:center; gap:12px; margin:0; min-width:0; }
    .trades-toolbars #tradesSharedFilters,
    .trades-toolbars #tradesExtraFilters { display:contents; }
    .trades-toolbars .pill-select.pill-cal { order:1; }
    .trades-toolbars .filter-groups { order:2; }
    .trades-toolbars #qSearchField { order:3; flex: 1 1 220px; min-width: 180px; max-width: 420px; }
    .pager-top .trades-sort-mobile { display: none; }
  }
  /* Laptop: tighter header gutters; a signed-in admin's row 1 (six tabs +
     badge + Account) drops the badge/label so the tabs never wrap. */
  @media (max-width: 1332px) {
    header.top { column-gap: 16px; }
    nav.tabs a { padding: 0 12px; }
    html.ct-admin .acct-desktop > .badge, html.ct-admin .acct-label, html.ct-admin .acct-caret { display: none; }
    html.ct-admin .acct-menu-btn { padding-right: 3px; }
  }
  /* Below 1200px the filter row may not fit beside the logo once several
     chips are multi-selected: let it wrap onto a second line (the header
     row grows; the search keeps its 180px floor instead of collapsing). */
  @media (max-width: 1199px) {
    #ctFilters .trades-toolbars { flex-wrap: wrap; row-gap: 8px; }
  }
  @media (max-width: 1099px) {
    .acct-desktop > .badge, .acct-menu-btn .acct-label, .acct-menu-btn .acct-caret { display: none; }
    .acct-menu-btn { padding-right: 3px; }
    /* Six admin tabs + two lit badges beside a 300px wordmark. */
    html.ct-admin nav.tabs { gap: 2px; }
    html.ct-admin nav.tabs a { padding: 0 9px; }
  }
  /* Small desktop window (769-999px, mouse): the wordmark stays on row 1
     beside the tabs and the filter row takes the full column underneath
     (there is no room right of the logo for five controls + search). */
  @media (min-width: 769px) and (max-width: 999px) and (hover: hover) {
    header.top { grid-template-rows: auto var(--control-h, 34px); row-gap: 10px; column-gap: 12px; }
    header.top .brand { grid-row: 1; }
    nav.tabs { flex-wrap: wrap; }
    nav.tabs a { padding: 0 9px; }
    header.top #ctFilters { grid-column: 1 / -1; grid-row: 2; }
    html:not([data-view="trades"]):not([data-view="trends"]) header.top { grid-template-rows: auto; row-gap: 0; }
    .trades-toolbars #qSearchField { max-width: none; }
    /* Row 1 has to hold logo + four tabs + account at 769px: a slightly
       narrower wordmark (~230px at 769px) keeps the tabs on one line.
       Owner 2026-09-21 punch list: 423px = 15% larger than the prior 368px. */
    .brand-logo { width: min(423px, 26vw); }
  }
  #exportCsvDialog { max-width:min(420px, 92vw); padding:16px; border:1px solid var(--border); border-radius:12px; background:var(--panel); color:var(--text); }
  #exportCsvDialog::backdrop { background:rgba(0,0,0,.45); }
  #exportCsvDialog .lbl { display:inline-block; margin:8px 8px 4px 0; }
  #exportCsvDialog input[type=date] { margin-right:10px; }
  
  @keyframes slideUpFade {
    from { opacity: 0; transform: translateY(10px); }
    to { opacity: 1; transform: translateY(0); }
  }
  @keyframes dialogPopSpring {
    from { opacity: 0; transform: translate(-50%, 10px) scale(0.95); }
    to { opacity: 1; transform: translate(-50%, 0) scale(1); }
  }
  @keyframes slideUpIn {
    from { opacity: 1; transform: translateY(100%); }
    to { opacity: 1; transform: translateY(0); }
  }
  @keyframes slideUpSpring {
    from { opacity: 1; transform: translateY(100%); }
    to { opacity: 1; transform: translateY(0); }
  }
  @keyframes tickPop {
    0% { transform: scale(1); }
    50% { transform: scale(1.15); color: var(--accent); }
    100% { transform: scale(1); }
  }
  .tick-animate .tick-num { display: inline-block; animation: tickPop 0.3s cubic-bezier(0.34, 1.56, 0.64, 1); }
  dialog.search-panel[open] { animation: dialogPopSpring 0.4s cubic-bezier(0.34, 1.56, 0.64, 1) forwards; }
  tr.row, .trades-card { animation: slideUpFade 0.4s cubic-bezier(0.34, 1.56, 0.64, 1) backwards; }
  tr.row:nth-child(1), .trades-card:nth-child(1) { animation-delay: 0.05s; }
  tr.row:nth-child(2), .trades-card:nth-child(2) { animation-delay: 0.10s; }
  tr.row:nth-child(3), .trades-card:nth-child(3) { animation-delay: 0.15s; }
  tr.row:nth-child(4), .trades-card:nth-child(4) { animation-delay: 0.20s; }
  tr.row:nth-child(5), .trades-card:nth-child(5) { animation-delay: 0.25s; }
  tr.row:nth-child(6), .trades-card:nth-child(6) { animation-delay: 0.30s; }
  tr.row:nth-child(7), .trades-card:nth-child(7) { animation-delay: 0.35s; }
  tr.row:nth-child(8), .trades-card:nth-child(8) { animation-delay: 0.40s; }
  tr.row:nth-child(9), .trades-card:nth-child(9) { animation-delay: 0.45s; }
  tr.row:nth-child(10), .trades-card:nth-child(10) { animation-delay: 0.50s; }
  /* These entrance/pop animations (row stagger, drawer slide-up, dialog pop,
     ticking-number bump) are purely decorative flourish, not functional
     feedback — honor the OS-level motion opt-out and skip them outright
     rather than just shortening them. !important because the drawer-slide
     rule is re-declared inside later mobile breakpoints (same selector, same
     specificity) — without it, source order would let those re-enable the
     animation for reduced-motion users on narrow viewports. */
  @media (prefers-reduced-motion: reduce) {
    tr.row, .trades-card,
    .drawer.open .drawer-panel,
    dialog.search-panel[open],
    .tick-animate .tick-num {
      animation: none !important;
    }
  }

  /* ---- Speed vs data providers (provider scorecard grid) ---- */
  .speed-head { display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap; }
  .speed-head h3 { margin:0; }
  .speed-kicker { font-size:11px; font-weight:700; letter-spacing:1.2px; text-transform:uppercase; color:var(--accent); margin-bottom:4px; opacity:0.85; }
  /* Scorecard grid — one card per provider, side by side */
  .sp-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(280px, 1fr)); gap:16px; margin-top:14px; }
  .sp-card {
    background: color-mix(in srgb, var(--panel-2) 55%, transparent);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 18px 18px 14px;
    display: flex;
    flex-direction: column;
    gap: 14px;
    transition: border-color 0.2s, box-shadow 0.2s;
  }
  .sp-card:hover { border-color:color-mix(in srgb, var(--accent) 55%, var(--border)); box-shadow: 0 6px 28px rgba(0,0,0,.22); }
  .sp-card.sp-ahead { border-color: color-mix(in srgb, var(--good) 35%, var(--border)); }
  .sp-card.sp-tied { border-color: color-mix(in srgb, var(--warn) 30%, var(--border)); }
  .sp-card.sp-behind { border-color: color-mix(in srgb, var(--rival) 30%, var(--border)); }
  .sp-card.sp-tied { border-color: color-mix(in srgb, var(--text-dim) 25%, var(--border)); }
  /* Card header row */
  .sp-header { display:flex; align-items:flex-start; justify-content:space-between; gap:8px; }
  .sp-name { font-size:13px; font-weight:700; color:var(--text); letter-spacing:0.1px; }
  .sp-badge {
    display:inline-block; font-size:10px; font-weight:700; padding:2px 7px;
    border-radius:99px; text-transform:uppercase; letter-spacing:.5px; white-space:nowrap;
  }
  .sp-badge.ahead { background:color-mix(in srgb,var(--good) 18%,transparent); color:var(--good); border:1px solid color-mix(in srgb,var(--good) 40%,transparent); }
  .sp-badge.behind { background:color-mix(in srgb,var(--rival) 15%,transparent); color:var(--rival); border:1px solid color-mix(in srgb,var(--rival) 35%,transparent); }
  .sp-badge.gathering { background:color-mix(in srgb,var(--text-dim) 12%,transparent); color:var(--text-dim); border:1px solid color-mix(in srgb,var(--border) 80%,transparent); }
  .sp-badge.tied { background:color-mix(in srgb,var(--text-dim) 18%,transparent); color:var(--text); border:1px solid color-mix(in srgb,var(--border) 60%,transparent); }
  .sp-badge.off { background:color-mix(in srgb,var(--text-dim) 10%,transparent); color:var(--text-dim); border:1px solid color-mix(in srgb,var(--text-dim) 30%,transparent); }
  .sp-badge.shown, .sp-badge.hidden-public { text-transform:none; letter-spacing:0.2px; }
  .sp-badge.shown { background:color-mix(in srgb,var(--good) 14%,transparent); color:var(--good); border:1px solid color-mix(in srgb,var(--good) 35%,transparent); }
  .sp-badge.hidden-public { background:color-mix(in srgb,var(--text-dim) 10%,transparent); color:var(--text-dim); border:1px solid color-mix(in srgb,var(--text-dim) 30%,transparent); }
  .sp-header-end { display:flex; flex-wrap:wrap; gap:6px; justify-content:flex-end; align-items:center; }
  .sp-card.sp-off { opacity: 0.72; border-color: color-mix(in srgb, var(--text-dim) 25%, var(--border)); }
  /* Win-rate bar */
  .sp-bar-wrap { display:flex; flex-direction:column; gap:5px; }
  .sp-bar-labels { display:flex; justify-content:space-between; font-size:11px; color:var(--text-dim); font-family:var(--mono); }
  .sp-bar-track { position:relative; height:8px; border-radius:999px; background:color-mix(in srgb,var(--border) 55%,transparent); overflow:hidden; }
  .sp-bar-fill { position:absolute; inset:0 auto 0 0; border-radius:999px; background: linear-gradient(90deg, var(--good) 0%, color-mix(in srgb,var(--good) 70%,var(--accent)) 100%); transition: width 0.6s cubic-bezier(0.4,0,0.2,1); }
  .sp-bar-fill.behind { background: linear-gradient(90deg, var(--rival) 0%, color-mix(in srgb,var(--rival) 65%,var(--text-dim)) 100%); }
  .sp-bar-fill.tied { background: linear-gradient(90deg, var(--warn) 0%, color-mix(in srgb,var(--warn) 65%,var(--text-dim)) 100%); }
  /* Lead stat */
  .sp-lead { display:flex; flex-direction:column; align-items:flex-start; gap:4px; }
  .sp-lead-label { font-size:11px; color:var(--text-dim); line-height:1.3; text-wrap:pretty; overflow-wrap:break-word; word-break:break-word; }
  .sp-lead-sub { font-size:11px; color:var(--text-dim); margin-top:3px; }
  /* Dim subtitle color must not wash out earlier/later on the median/average line. */
  .sp-lead-label .lead-fig.lead-ahead, .sp-lead-sub .lead-fig.lead-ahead { color:var(--good); }
  .sp-lead-label .lead-fig.lead-behind, .sp-lead-sub .lead-fig.lead-behind { color:var(--lag); }
  .lead-inline { font-weight:700; }
  .lead-inline.lead-ahead { color:var(--good); }
  .lead-inline.lead-behind { color:var(--lag); }
  /* ---- Signed lead/lag figure (every latency number on the page) ----
     Owner 2026-08-11: "it has minus signs for time ahead and time behind, lets
     make it have + sign and stay in red when behind on time". So: AHEAD always
     carries an explicit "+", BEHIND is red, and the sign is the true minus
     U+2212 rather than a hyphen that reads like a typo or a stray dash.
     Colour is never the only channel — .lead-arrow (▲/▼/↔) and .lead-word
     ("ahead"/"behind"/"even") carry the same fact for colour-blind, high
     contrast, and printed readers, and the whole figure has an aria-label
     spelling it out for screen readers. */
  .lead-fig { display:inline-flex; align-items:baseline; gap:4px; white-space:nowrap; font-variant-numeric:tabular-nums; }
  .lead-fig .lead-arrow { font-size:0.78em; line-height:1; }
  .lead-fig .lead-word { font-size:0.7em; font-weight:700; text-transform:uppercase; letter-spacing:0.6px; }
  .lead-fig.lead-ahead { color:var(--good); }
  .lead-fig.lead-behind { color:var(--lag); }
  .lead-fig.lead-even { color:var(--text-dim); }
  /* Number + word both take the direction colour.  Parent .sp-lead-sub is dim
     and used to wash the average "#h later" back to gray. */
  .lead-fig.lead-ahead .lead-val,
  .lead-fig.lead-ahead .lead-word,
  .lead-fig.lead-ahead .lead-arrow { color:var(--good); opacity:1; }
  .lead-fig.lead-behind .lead-val,
  .lead-fig.lead-behind .lead-word,
  .lead-fig.lead-behind .lead-arrow { color:var(--lag); opacity:1; }
  .lead-fig.lead-big { font-size:30px; font-weight:800; letter-spacing:-0.5px; line-height:1; }
  .lead-fig.lead-big .lead-word { font-size:0.34em; letter-spacing:1px; }
  .lead-fig.lead-big.lead-even { font-size:20px; }
  /* "N of M matched" scope line + its plain-English denominator note. */
  .sp-scope { font-size:11.5px; color:var(--text-dim); font-variant-numeric:tabular-nums; }
  .sp-scope strong { color:var(--text); font-weight:700; }
  .sp-scope-note { margin-top:10px; }
  .sp-scope-note strong { color:var(--text); font-variant-numeric:tabular-nums; }
  /* W/L/T stat row */
  .sp-wlt { display:flex; gap:0; border-top:1px solid color-mix(in srgb,var(--border) 60%,transparent); padding-top:10px; font-size:12px; }
  .sp-wlt-item { flex:1; display:flex; flex-direction:column; align-items:center; gap:2px; }
  .sp-wlt-item + .sp-wlt-item { border-left:1px solid color-mix(in srgb,var(--border) 50%,transparent); }
  .sp-wlt-val { font-size:17px; font-weight:700; font-variant-numeric:tabular-nums; }
  .sp-wlt-val.w { color:var(--good); }
  .sp-wlt-val.l { color:var(--rival); }
  .sp-wlt-val.t { color:var(--text-dim); }
  .sp-wlt-key { font-size:9.5px; text-transform:uppercase; letter-spacing:0.8px; color:var(--text-dim); opacity:0.7; }
  /* n= sample chip */
  .sp-sample { font-size:10.5px; color:var(--text-dim); line-height:1.3; }
  /* Empty / gathering state */
  .sp-gathering { font-size:12px; color:var(--text-dim); line-height:1.5; padding:4px 0; text-wrap:pretty; overflow-wrap:break-word; word-break:break-word; }
  /* Old race-lane kept for compat with table view */
  .speed-fineprint { font-size:10.5px; }
  .speed-table summary { cursor:pointer; font-size:12px; color:var(--text-dim); padding:6px 0; }
  .speed-table table td, .speed-table table th { font-variant-numeric:tabular-nums; }
  .speed-mini { display:none; border:1px solid var(--border); border-radius:10px; padding:10px 12px; font-size:12.5px; margin:12px 0; gap:8px; flex-wrap:wrap; align-items:center; justify-content:space-between; }
  .speed-mini.show { display:flex; }
  .speed-mini .lead { font-weight:600; font-variant-numeric:tabular-nums; }
  /* ---- Alert delivery education cards ---- */
  .delivery-grid { display:grid; grid-template-columns:1fr 1fr; gap:12px; margin:12px 0 4px; }
  .delivery-card { border:1px solid var(--border); border-radius:12px; padding:16px 14px; background:color-mix(in srgb, var(--panel-2) 55%, transparent); }
  .delivery-card h4 { margin:0 0 8px; font-size:14px; }
  .delivery-card p { margin:0 0 8px; font-size:12.5px; line-height:1.5; color:var(--text); }
  .delivery-card p.note { margin-bottom:0; }
  /* Issue #1529: right-align the "N trades" count on desktop (iOS-parity). */
  .trades-stats { font-size: 11.5px; white-space: nowrap; margin-left: auto; }
  .trades-stats .match-count { font-variant-numeric: tabular-nums; font-weight: 700; color: var(--text); }
  .trades-stats .match-label { color: var(--text-dim); font-weight: 500; }
  /* Mobile sort lives in the top pager band; hidden on desktop (table headers). */
  .trades-sort-mobile { display: none; align-items: center; gap: 8px; margin: 0; flex: 0 0 auto; }
  .trades-sort-mobile #mobileSortKey { flex: 0 0 auto; width: auto; min-width: 0; }
  @media (max-width: 768px), (orientation: landscape) and (max-width: 950px) and (max-height: 520px), (hover: none) and (pointer: coarse) {
    /* clip (not hidden): hidden on one axis makes the other compute to auto
       and turns html/body/main into a scrollport, which kills position:sticky
       on the Trades/Trends filter bars. */
    html, body { width:100%; max-width:100%; overflow-x:clip; }
    body { background: var(--bg); font-size: 13px; }
    :root { --ct-header-h: 62px; --ct-main-pad: 12px; }
    /* Phone header: row 1 = wordmark + account button, row 2 = the shared
       filter row (chips scroll sideways in one row; search stacks under on
       Trades).  nav.tabs is the fixed bottom dock (below) so it takes no
       grid cell here. */
    header.top {
      display: grid; grid-template-columns: minmax(0, 1fr) 44px; grid-template-rows: auto auto;
      column-gap: 8px; row-gap: 0;
      padding: 6px 10px 0; align-items: center; backdrop-filter: none;
    }
    header.top .brand { grid-column: 1; grid-row: 1; }
    header.top #acct { grid-column: 2; grid-row: 1; justify-self: end; }
    header.top #ctFilters { grid-column: 1 / -1; grid-row: 2; display: block; padding: 4px 4px 8px; min-width: 0; }
    #ctFilters .trades-toolbars { display: block; position: static; margin: 0; padding: 0; width: auto; }
    #ctFilters #tradesSharedFilters {
      display: flex; flex-wrap: nowrap; align-items: center; gap: 6px;
      overflow-x: auto; overflow-y: visible; scrollbar-width: none;
      /* 4px inner pad (offset by margin) keeps the 2px+2px focus-visible
         ring inside the scroll box instead of clipped top and bottom. */
      padding: 4px 2px; margin: -4px -2px;
    }
    #ctFilters #tradesSharedFilters::-webkit-scrollbar { display: none; }
    #ctFilters .ct-filter-reset { display: none; }
    #ctFilters .ios-filter-btn { height: 40px; padding: 0 8px; }
    /* Search sits 6px under the chip row (the base #ctFilters .toolbar
       margin:0 rule would zero it) and stays its own flex row on
       coarse-pointer tablets >=769px, where the desktop display:contents
       merge would otherwise flatten it into the block wrapper. */
    #ctFilters #tradesExtraFilters { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
    /* The generic mobile .toolbar input shorthand resets padding; keep room
       for the magnifier on the search field. */
    #ctFilters .icon-input { padding-left: 32px; }
    #ctFilters .pill-select { height: 40px; }
    #ctFilters .pill-select-el { padding: 8px 24px 8px 28px; font-size: 12px; }
    .ios-filter-pop { border-radius: 12px; }
    #view-trades, #view-trends { padding-top: 14px; }
    .brand { font-size: 15px; margin-left: 1ch; }
    /* Owner 2026-09-08: larger on phones too.  The wordmark fills the 1fr
       brand cell up to 322px (64px tall at the 5:1 ratio); the account
       control keeps its own column, so it never gets squeezed off.
       Owner 2026-09-21 punch list: 322px = 15% larger than the prior 280px. */
    .brand-logo { width:322px; max-width:100%; height:auto; }
    .pill { padding: 3px 7px; }
    /* Full-bleed dock like Socratic.Trade console — not a floating glass pill.
       bottom:0 with safe-area padding INSIDE the painted bar so it sits
       against Safari's URL chrome without a gap or a dead grey band. */
    nav.tabs {
      position: fixed; left: 0; right: 0; bottom: 0; margin: 0;
      width: auto; max-width: none;
      display: grid; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr);
      gap: 0; padding: 9px 0 4px; padding-bottom: calc(4px + env(safe-area-inset-bottom, 0px));
      background: color-mix(in srgb, var(--panel) 94%, transparent);
      -webkit-backdrop-filter: blur(20px);
      backdrop-filter: blur(20px);
      border: 0; border-top: 1px solid var(--border);
      border-radius: 0; z-index: 45;
      box-shadow: none;
      transform: translateZ(0);
      overflow: visible;
    }
    nav.tabs::after { content: none; }
    html[data-theme="light"] nav.tabs {
      background: color-mix(in srgb, #fff 94%, transparent);
      border-top-color: rgba(23, 32, 46, 0.2);
    }
    html[data-theme="dark"] nav.tabs {
      background: color-mix(in srgb, #1c1c1e 94%, transparent);
    }
    @supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
      nav.tabs { background: var(--panel); }
      html[data-theme="light"] nav.tabs { background: #fff; }
    }
    nav.tabs a {
      display: block; height: auto; white-space: normal;
      padding: 6px 2px; min-height: 44px; font-size: 0; min-width: 0;
      border-radius: 0; border: 0; background: transparent;
    }
    nav.tabs a[data-admin-tab] { font-size: 0; }
    nav.tabs a.active {
      background: transparent;
      box-shadow: none;
    }
    html[data-theme="dark"] nav.tabs a.active {
      background: transparent;
    }
    nav.tabs a::before { content: attr(data-icon) / ""; display: block; font-size: 16px; line-height: 1; margin-bottom: 3px; }
    nav.tabs a::after { content: attr(data-mobile) / ""; display: block; font-size: 10px; line-height: 1.1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .tab-count-badge,
    .tab-count-badge.is-on {
      position: absolute;
      top: 2px;
      right: max(4px, calc(50% - 22px));
      margin: 0;
      min-width: 16px;
      height: 16px;
      line-height: 16px;
      font-size: 10px;
      z-index: 1;
    }
    /* Signed-in admins unhide two extra tabs (Review, Admin) alongside the
       default four (renderAdminTabs() toggles [hidden] on data-admin-tab
       anchors), so the dock goes from four ~97.5px columns at 390px to six
       ~65px columns (~53px at 320px).  The sizes above were tuned for four;
       :has() reacts to that same [hidden] toggle to shrink icon/label and
       tighten padding for six, with no extra class or JS needed.  The
       label clamp keeps "Directory" / "Delivery" on one line down to
       320px so ellipsis stays a last resort, not the normal render. */
    html.ct-admin nav.tabs a {
      padding-left: 1px;
      padding-right: 1px;
    }
    html.ct-admin nav.tabs a::before {
      font-size: 14px;
      margin-bottom: 2px;
    }
    html.ct-admin nav.tabs a::after {
      font-size: clamp(8px, 2.3vw, 9px);
    }
    /* right:max(4px, calc(50% - 22px)) on .tab-count-badge above assumes the
       ~97.5px four-tab cell; on ~53-65px six-tab cells that offset crowds
       the centered icon, so pin the badge to the corner instead. */
    html.ct-admin nav.tabs .tab-count-badge,
    html.ct-admin nav.tabs .tab-count-badge.is-on {
      right: 3px;
      min-width: 14px;
      height: 14px;
      line-height: 14px;
      font-size: 9px;
    }
    .acct { justify-content: flex-end; }
    .acct .email, .acct .badge { display: none; }
    /* Owner punch list #5: nav.tabs is ~56px tall before safe-area.  70px
       content padding still clears the dock without a floating-pill gap. */
    /* Do not clip overflow on main: clip on one axis computes the other
       to clip as well, which ate the filter strip's white paint and left
       chips sitting on --bg.  html/body still clip horizontal overflow. */
    main { max-width: none; min-width:0; padding: 0 12px; padding-bottom: calc(70px + env(safe-area-inset-bottom)); }
    .view, .section, .toolbar, .row-flex, .sched-row { min-width:0; max-width:100%; }
    .section { overflow:hidden; }
    .section p.sub { font-size:12px; line-height:1.45; }
    .note, code { overflow-wrap:anywhere; }
    .section p.sub { overflow-wrap:normal; }
    .section > table { display:block; max-width:100%; overflow-x:auto; }
    .banner { margin-bottom: 12px; }
    /* Owner punch list #5: the footer (disclaimer + Privacy/Terms/... links)
       is the last thing in the document — give its own bottom padding ~2
       extra lines (~32px) on top of the base 30px so its last row is never
       hidden behind the fixed tab bar, independent of main's own buffer. */
    footer, footer.site-footer { padding-bottom: calc(62px + env(safe-area-inset-bottom)); }
    input, select, .btn { font-size:16px; }
    .grid-cards { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:9px; overflow:visible; margin:0 0 14px; padding:0; }
    #trKpis { grid-template-columns:repeat(3,minmax(0,1fr)); }
    .grid-cards .card { min-width:0; padding:11px 12px; border-radius:10px; display: flex; flex-direction: column; min-height: 96px; }
    .card .k { font-size:11px; line-height:1.25; }
    .card .v { font-size:24px; }
    /* Trends snapshot strip is 3-up on phones, so a tile is ~108px wide at
       375px — a fixed 24px figure spilled a compact money value ("~$126.2m",
       the widest usdC() can produce at 8 characters) clean outside its own
       card, over the tile beside it. Size the figure off the tile itself:
       19.5cqw of the card's content box keeps the widest value inside at any
       phone width, and min() restores the full 24px as soon as the tile is
       wide enough to hold it. */
    #trKpis .card { container-type: inline-size; }
    #trKpis .card .v { font-size: min(24px, 19.5cqw); }
    #trKpis .card .v .net, #trKpis .card .v .kpi-money, #trKpis .card .v .bp-n { font-size: inherit; }
    #trKpis .card .v .bp-pct { font-size: inherit; }
    #trKpis .card .v .bp-w { font-size: min(13px, 11cqw); }
    .section { border-radius: 10px; padding: 14px; margin-bottom: 12px; }
    .toolbar { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 8px; align-items: stretch; }
    .toolbar input, .toolbar select, .toolbar .btn { width: 100%; min-width:0; min-height: 40px; padding:8px 9px; }
    /* Owner punch list #9: nudge the mobile filter chips to the same 40px
       touch height as every other mobile toolbar control (was the desktop
       34px --control-h at every width) — tightens mobile-site filter chrome
       toward the app's pill sizing. */
    .toolbar .branch-toggle, .toolbar .party-chip, .toolbar .side-chip { min-height: 40px; }
    .toolbar .ios-filter-item.branch-toggle,
    .toolbar .ios-filter-item.party-chip,
    .toolbar .ios-filter-item.side-chip { min-height: 0; }
    /* .pill-select-el keeps an asymmetric left inset for its calendar icon —
       restore it after the generic mobile shorthand above (higher specificity
       than the desktop .pill-select-el rule so it wins, but scoped so it
       doesn't touch the desktop padding). #qMember/#qTicker carry no icon
       (owner punch list #8) so .icon-input needs no such override — the
       generic .toolbar input/select/.btn shorthand above already fits it. */
    .toolbar .icon-field { width: 100%; }
    .toolbar .pill-select-el { padding: 8px 26px 8px 30px; }
    /* Issue #1529: search-this-page button left, filtered match count right
       ("N matching trades" from the server total for active filters — never
       the current page size). */
    /* display:grid must live on the ID selector: the ≤720px block later in
       the sheet re-flexes .toolbar (equal class specificity, later source
       order wins), which silently killed this row's grid placement on real
       phone widths — found by the #1533 design-QA verifier via computed
       layout. The ID rule outranks any .toolbar class rule at every width. */
    #tradesExtraFilters { display: grid; grid-template-columns: minmax(0, 1fr); align-items: center; gap: 8px; }
    #tradesExtraFilters #qSearchField { grid-column: 1; min-width: 0; flex: 1 1 auto; }
    .trades-stats .stat-today { display: none; }
    /* Pagers stay usable on phones: don't force every child full-width.
       Controls stay intrinsic and right-aligned — no stretched empty bar. */
    .pager.row-flex { align-items: center; flex-wrap: wrap; gap: 10px 12px; justify-content: space-between; }
    .pager.row-flex > * { width: auto; min-height: 0; }
    .pager .pager-controls { flex: 0 0 auto; width: auto; margin-left: auto; }
    .pager .pager-tools { flex: 0 0 auto; }
    .pager-top .pager-tools { display: flex; }
    .pager-top .feed-options { display: none; }
    .pager .pager-tools select, .pager .pager-tools .btn { width: auto; min-height: 36px; }
    .pager .trades-sort-mobile, .pager .trades-count-msg { flex: 0 0 auto; }
    /* Owner 2026-09-09: the top band is ONE 40px row — [Sort ▾|↕] [‹ 3/12 ›] [50/pg].
       The sort select + direction button are a joined segment; page
       controls drop first/last and show a short "page / count" (.pg-short
       span from the pager writer) so the row fits 320px; the rows select
       reads "N/pg" (syncPageSizeLabels()).  The count message moves to the
       bottom pager only. */
    #view-trades .pager-top { display: flex; flex-wrap: nowrap; gap: 8px; align-items: center; justify-content: flex-start; margin: 0 0 12px; }
    #view-trades .pager-top #tradesCountMsgTop { display: none; }
    #tradesSortMobile {
      display: inline-flex; align-items: center; gap: 0; flex: 0 0 auto; height: 40px; box-sizing: border-box;
      border: 1px solid var(--border); border-radius: var(--radius-ctl); overflow: hidden; background: var(--panel);
    }
    #tradesSortMobile .lbl { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
    #tradesSortMobile #mobileSortKey {
      border: 0; border-radius: 0; height: 100%; min-height: 0; width: auto; field-sizing: content; max-width: min(104px, 22vw);
      padding: 0 18px 0 6px; font: 600 12px var(--sans); background-color: transparent; color: var(--text);
      text-overflow: ellipsis;
    }
    #tradesSortMobile #mobileSortDirBtn {
      flex: 0 0 32px; width: 32px; height: 100%; min-height: 0; border: 0 !important; border-left: 1px solid var(--border) !important;
      border-radius: 0 !important; padding: 0; font-size: 13px; display: inline-flex; align-items: center; justify-content: center;
    }
    /* Page controls take whatever is left (flex-basis 0 + min-width 0 so the
       band never overflows at 320px); the counter is the only thing that
       gives way, and it never falls below the width of "9 / 99". */
    #view-trades .pager-top .pager-controls { flex: 1 1 0; min-width: 0; margin: 0; height: 40px; box-sizing: border-box; border-radius: var(--radius-ctl); }
    #view-trades .pager-top [data-pager-first], #view-trades .pager-top [data-pager-last] { display: none; }
    #view-trades .pager-top [data-pager-prev], #view-trades .pager-top [data-pager-next] { flex: 0 0 34px; width: 34px; min-width: 34px; height: 38px; min-height: 0; padding: 0; font-size: 17px; line-height: 1; }
    #view-trades .pager-top .trades-page-msg { flex: 1 1 0; min-width: 0; text-align: center; padding: 0 2px; font-size: 12px; font-weight: 600; color: var(--text); font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; }
    #view-trades .pager-top .trades-page-msg .pg-long { display: none; }
    #view-trades .pager-top .trades-page-msg .pg-short { display: inline; }
    #view-trades .pager-top .pager-tools { flex: 0 0 auto; }
    #view-trades .pager-top .pager-tools select {
      height: 40px; min-height: 40px; width: auto; field-sizing: content; padding: 0 18px 0 6px; font: 600 12px var(--sans); border-radius: var(--radius-ctl);
      /* Own chevron (same glyph as the time select) instead of the native
         arrow box: ~18px narrower, which is the page counter's breathing room at 320px. */
      appearance: none; -webkit-appearance: none; background-color: var(--panel); background-repeat: no-repeat; background-position: right 4px center;
      background-image: url('data:image/svg+xml;utf8,<svg fill="%2334435b" height="14" viewBox="0 0 24 24" width="14" xmlns="http://www.w3.org/2000/svg"><path d="M7 10l5 5 5-5z"/></svg>');
    }
    html[data-theme="dark"] #view-trades .pager-top .pager-tools select {
      background-image: url('data:image/svg+xml;utf8,<svg fill="%23b8c7dd" height="14" viewBox="0 0 24 24" width="14" xmlns="http://www.w3.org/2000/svg"><path d="M7 10l5 5 5-5z"/></svg>');
    }
    /* Shared filter row: timeframe + chamber/party/type stay on ONE row.
       Timeframe is content-sized (not flex-grown).  ID selectors beat the
       later 720px toolbar flex-wrap re-flex. */
    #tradesSharedFilters {
      display: flex; flex-wrap: nowrap; align-items: center; gap: 6px;
      overflow: visible;
    }
    #tradesSharedFilters > .pill-select.pill-cal {
      flex: 0 0 auto; width: max-content;
    }
    #tradesSharedFilters > .pill-select-el,
    #tradesSharedFilters .pill-select-el {
      width: auto; field-sizing: content;
    }
    #tradesSharedFilters > .filter-groups {
      flex: 0 0 auto; width: auto; display: flex; flex-wrap: nowrap; justify-content: flex-start; gap: 6px;
    }
    #tradesExtraFilters {
      display: flex; align-items: center; gap: 8px; margin-top: 6px;
    }
    #tradesExtraFilters .icon-field { flex: 1 1 auto; min-width: 0; }
    #tradesSharedFilters .branch-filters { margin: 0; }
    #tradesSharedFilters .branch-toggle, #tradesSharedFilters .party-chip, #tradesSharedFilters .side-chip {
      min-width: 30px; padding: 0 6px;
    }
    #tradesSharedFilters .ios-filter-item.branch-toggle,
    #tradesSharedFilters .ios-filter-item.party-chip,
    #tradesSharedFilters .ios-filter-item.side-chip {
      min-width: 0; padding: 9px 10px;
    }
    #tradesSharedFilters .filters-info-wrap .branch-info {
      width: 26px; height: 26px; font-size: 15px;
    }
    .search-panel.open {
      position: fixed; left: 10px; right: 10px; bottom: calc(70px + env(safe-area-inset-bottom));
      display: grid; grid-template-columns: 1fr; z-index: 44; max-height: 58vh; overflow:auto;
      box-shadow: 0 18px 44px rgba(0,0,0,.45);
    }
    .panel-close { width:44px; height:44px; margin:-10px -10px -10px 0; }
    #view-trades .table-wrap { display: none; }
    #view-trades .trades-cards { display: grid; grid-template-columns: minmax(0, 1fr); }
    #view-trades .pager-top .trades-sort-mobile { display: flex; }
    /* The Columns chooser only affects the (hidden) table's field set — tradesCardHtml()
       renders a fixed field set, so hide Columns inside the Options menu on phones.
       Export CSV stays available. */
    .feed-options-item-cols { display: none !important; }
    .col-resizer { display: none; }
    .row-flex { align-items: stretch; gap: 9px; }
    .row-flex > input, .row-flex > select, .row-flex > button { width: 100%; min-height: 40px; }
    /* Rank By: label + dropdown stay side by side on one line (owner). */
    .rankby-row { align-items: center; flex-wrap: nowrap; }
    .rankby-row > select { width: auto; flex: 0 1 auto; min-width: 0; }
    .sched-row { grid-template-columns: 1fr 1fr; }
    .trend-grid2, .trend-grid-split { gap: 12px; }
    /* Narrow the fixed label/value gutters so the proportion bar keeps room. */
    .hbar .hlabel { width: 92px; font-size: 12px; }
    .hbar .hval { width: auto; min-width: 56px; }
    .flowrow .flabel { font-size: 14px; }
    .flowrow .fval { font-size: 12px; }
    .flowrow .fchip { font-size: 11.5px; }
    /* Trends tables are dense; on phones drop the 120px buy/sell bar (the
       "3 buys / 3 sells" text stays) and the long company name so the ticker +
       numeric columns all fit without horizontal scroll. */
    #view-trends .split { display: none; }
    #view-trends .split-wrap { gap: 0; }
    /* Buys vs Sells chart: tighter bars/labels on phones. */
    #view-trends .tchart { gap: 1px; height: 160px; }
    #view-trends .tcol { gap: 2px; }
    #view-trends .tbars { gap: 1px; height: 130px; }
    #view-trends .tbars i { max-width: 5px; }
    #view-trends .tlbl { display: block; height: 11px; line-height: 11px; font-size: 8px; max-width: 100%; overflow: hidden; }
    /* #/$ metric toggles stay on the SAME line as the heading.  What Is
       Being Traded and Buys vs Sells share one size — do not shrink the
       Buys vs Sells pair below the ticker-rank pair. */
    /* Keep title + both toggle groups + HIDE cue on one summary line on phones
       with tighter gaps only — owner 2026-09-08: every card heading is the
       same size, so the title is NOT shrunk here. */
    #view-trends summary.tchart-summary { gap: 5px; }
    #view-trends summary.tchart-summary .tchart-controls { gap: 5px; }
    #view-trends .stack-under { font-size: 11px; }
    #view-trends .asset-cell .muted { display: none; }
    #view-trends td:has(.asset-cell) { width: auto; max-width: none; }
    /* "What Is Being Traded" is the densest row; on phones drop the gross
       Approx-Volume column (it's in the KPI strip + the tap-through drawer) so the
       signed net-flow column isn't clipped. Other tables keep their volume. */
    #trTickers td.est, #tableTrTickers th.est { display: none; }
    /* Owner follow-up batch #14: 2-up (not 1fr) so two Consensus Moves cards
       fit side-by-side on mobile — paired with the party-name abbreviation
       swap below (Democrats->Dems, Republicans->Reps) that frees the width. */
    .cluster-grid { grid-template-columns: 1fr; }
    @media (min-width: 421px) {
      .cluster-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
    .party-full { display: none; }
    .party-abbr { display: inline; }
    .filters-info-wrap .branch-pop { left: auto; right: 0; }
    .drawer-panel { top: auto; bottom: 0; height: 88vh; width: 100%; max-width: 100%; border-left: none; border-top: 1px solid var(--border); border-radius: 16px 16px 0 0; padding: 0 16px calc(18px + env(safe-area-inset-bottom)); }
    .drawer.open .drawer-panel { animation: slideUpIn 0.34s cubic-bezier(0.22, 1, 0.36, 1) forwards; }
    /* Keep the label/value pair on one line at phone widths too — this used to
       collapse to a single column (1fr), which is exactly the stacked layout
       the owner flagged as unreadable. .def-grid and .flowrow .ftop inherit
       the same bounded-label-column contract from their base rules, so they
       need no mobile override here. */
    .drawer-kv { gap: 6px 10px; }
    .plan-grid { grid-template-columns: 1fr; }
    .toolbar .chamber-chips { grid-column: 1 / -1; }
    .sp-grid { grid-template-columns: 1fr; gap: 12px; }
    .lead-fig.lead-big { font-size:26px; }
    .lead-fig.lead-big.lead-even { font-size:19px; }
    .delivery-grid { grid-template-columns: 1fr; }
    .toast { bottom: calc(78px + env(safe-area-inset-bottom)); width: calc(100vw - 24px); max-width: 420px; }
  }
  @media (max-width: 460px) {
    .trades-card-meta { grid-template-columns: 1fr; }
  }
  @media (max-width: 420px) {
    .toolbar { grid-template-columns: repeat(2,minmax(0,1fr)); }
    .toolbar #qMember { grid-column:1 / -1; }
    nav.tabs a::after { font-size: 9px; }
    th, td { padding: 9px 10px; }
    /* Rising Activity: tighter cells so all four headings fit on phones. */
    #tableTrTrending th, #tableTrTrending td { padding: 9px 6px; }
    #tableTrTrending th { font-size: 11px; }
    /* Directory: tighter cells so Politician / Branch • Party • State / Trades all fit on phones. */
    .people-table-wrap th, .people-table-wrap td { padding: 9px 6px; }
    .people-table-wrap th { font-size: 11px; letter-spacing: 0; }
    .people-table-wrap td { font-size: 12px; }
    #view-people .section { padding-left: 10px; padding-right: 10px; }
  }
  @media (orientation: landscape) and (max-width: 950px) and (max-height: 520px) {
    header.top { padding:8px 10px; }
    :root { --ct-main-pad: 8px; }
    main { padding:8px 10px; padding-bottom:calc(72px + env(safe-area-inset-bottom)); }
    .disclaimer { font-size:10px; line-height:1.35; max-height:78px; overflow:auto; padding:8px 10px; }
    .section p.sub { font-size:11px; line-height:1.35; }
    .toolbar { grid-template-columns: 1.45fr .65fr 1fr 1fr; }
    .toolbar #qMember { grid-column:auto; }
    .trades-card-meta { grid-template-columns:repeat(3,minmax(0,1fr)); }
    .drawer-panel { height:92vh; }
    nav.tabs { padding-top:6px; padding-bottom:calc(6px + env(safe-area-inset-bottom)); }
  }

/* =====================================================================
   TRENDS — POLISH OVERRIDE BLOCK  (append-only polish layer)
   Synthesis of four design lenses into one voice. Tokens only
   (var(--…) / color-mix). Sits BEFORE the existing mobile media
   queries (720px / 460px / 420px), so those still win on phones; every
   rule that could re-widen or re-pad a row is guarded with
   @media (min-width: 721px) or neutralized in the mobile block at the end.
   ===================================================================== */

/* ---- 0. Local material + motion contract -----------------------------
   One token-derived surface recipe + one easing/duration vocabulary,
   inherited by descendants. These custom props never paint on their own. */
#view-trends {
  /* Cards stay 1280px.  Sticky filters break out to 100vw (see
     .trades-toolbars / #trendsSharedFilters) so they match header.top. */
  max-width: 1280px;
  margin: 0 auto;
  --tr-ease: cubic-bezier(.2, .6, .25, 1);
  --tr-fast: 130ms;
  --tr-med: 170ms;
  --surf-hi:   color-mix(in srgb, var(--text) 5%, transparent);
  --surf-edge: color-mix(in srgb, var(--border) 72%, transparent);
}

/* ---- 1. Shared numeric rhythm ----------------------------------------
   Every figure rides the same tabular baseline so columns line up
   digit-for-digit and never jitter as values change. */
#view-trends .card .v,
#view-trends .rank,
#view-trends .net,
#view-trends .est,
#view-trends .est-money,
#view-trends .muted,
#view-trends td,
#view-trends .split-wrap small,
#view-trends .fval,
#view-trends .fchip,
#view-trends .hval,
#view-trends .tlbl,
#view-trends .ccard .big,
#view-trends .conf {
  font-variant-numeric: tabular-nums;
  font-feature-settings: "tnum" 1, "lnum" 1;
}

/* ---- 2. Section headers + sub text -----------------------------------
   Crisper header, calmer sub capped to a readable measure on wide cards,
   and a 3px accent tick that marks every section start. */
#view-trends .section h3,
#view-trends h3.tf-h,
#view-trends details.trends-fold > summary.tf-h,
#view-trends details.trends-fold > summary {
  /* Owner 2026-09-08: 18px so card titles stay a step above the 15px
     By Party / By Asset Type / By Market Cap / By Sector row labels. */
  font-size: 18px;
  font-weight: 650;
  letter-spacing: -0.01em;
  line-height: 1.25;
  margin-top: 0;
  margin-bottom: 10px;
}
/* Collapsible Trends sections: summary matches section h3. Every fold card
   (mobile-only show/hide) carries a right-aligned "SHOW ↓" / "HIDE ↑" text
   cue instead of a caret glyph — see .fold-cue below. */
#view-trends details.trends-fold > summary {
  cursor: pointer;
  list-style: none;
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 0 10px;
  color: var(--text);
}
#view-trends details.trends-fold > summary::-webkit-details-marker { display: none; }
#view-trends details.trends-fold > summary::marker { content: ''; }
/* Right-aligned text cue, mobile-only affordance (desktop hides it below and
   forces every fold open via JS, since a plain "always expanded" card has no
   need for a show/hide control at all). */
#view-trends details.trends-fold > summary .fold-cue {
  margin-left: auto;
  flex: 0 0 auto;
  font-family: var(--mono);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: .04em;
  color: var(--text-dim);
  opacity: .75;
  white-space: nowrap;
}
#view-trends details.trends-fold > summary .fold-cue::after { content: 'SHOW ↓'; }
#view-trends details.trends-fold[open] > summary .fold-cue::after { content: 'HIDE ↑'; }
/* Buys vs Sells: heading + toggle controls share the summary row; the fold
   cue still pins to the far right (see .tchart-controls margin-left:auto
   below, which pushes the controls+cue group as a unit). */
#view-trends details.trends-fold > summary.tchart-summary .tchart-controls {
  margin-left: auto;
}
/* Desktop (above this file's 768px mobile breakpoint): no show/hide — every
   fold card stays expanded (forced via the matchMedia listener near
   stampWindowChips), so the cue is hidden and the summary row stops acting
   like a toggle control. */
@media (min-width: 769px) {
  #view-trends details.trends-fold > summary .fold-cue { display: none; }
  #view-trends details.trends-fold > summary { cursor: default; pointer-events: none; }
  #view-trends details.trends-fold > summary * { pointer-events: auto; }
}
/* Mobile: the whole summary line is the tap target, with comfortable padding
   so the disclosure toggle is easy to hit with a thumb. */
@media (max-width: 768px) {
  #view-trends details.trends-fold > summary {
    padding: 10px 2px;
    margin: 0 -2px 10px;
    border-radius: 8px;
  }
  #view-trends details.trends-fold > summary:active { background: var(--surf-hi); }
}
#view-trends h3.tf-h .chip,
#view-trends h3.tf-h .tf-chip,
#view-trends h3.tf-h .info-tip,
#view-trends details.trends-fold > summary .info-tip,
#view-trends .section h3 .info-tip { letter-spacing: 0; font-weight: 400; }
#view-trends .section p.sub {
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--text-dim);
}
@media (min-width: 721px) {
  #view-trends .section p.sub { max-width: none; }
}
/* Section-starting headings (direct child, plus the chart header row). */
#view-trends .section > h3,
#view-trends .section > .tchart-head > h3,
#view-trends .section > .row-flex > h3 {
  position: relative;
}
/* Nested "Lag Distribution" / "Slowest Filers" sub-headers are NOT section
   starters: dim small-caps cadence so they read as captions. */
#view-trends .timeliness-panel > h3 {
  font-size: 14px;
  padding-left: 0;
  color: var(--text-dim);
  letter-spacing: .03em;
}
/* KPI strip sits tight under the filter row — no Snapshot caption. */
#view-trends #trKpis { margin-top: 0; }

/* ---- 3. Surfaces: one calm material for sections, cards, clusters ------
   Token top-light gradient + 1px inner highlight via ::before (inset:0,
   pointer-events:none, radius inherited so it never blocks clicks or
   bleeds past corners). No resting elevation — depth arrives on hover. */
#view-trends .section,
#view-trends .grid-cards .card {
  position: relative;
  background:
    linear-gradient(180deg,
      color-mix(in srgb, var(--text) 2%, transparent),
      transparent 44%),
    var(--panel);
  border-color: var(--surf-edge);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--text) 5%, transparent);
}
#view-trends .section::before,
#view-trends .grid-cards .card::before {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: inherit;
  pointer-events: none;
  box-shadow: inset 0 1px 0 0 var(--surf-hi);
}
#view-trends .section {
  transition: border-color var(--tr-med) var(--tr-ease),
              box-shadow var(--tr-med) var(--tr-ease);
}
#view-trends .ccard {
  position: relative;
  background:
    linear-gradient(180deg,
      color-mix(in srgb, var(--text) 2.5%, transparent),
      transparent 46%),
    var(--panel-2);
  border-color: var(--surf-edge);
  transition: border-color var(--tr-med) var(--tr-ease),
              background var(--tr-med) var(--tr-ease),
              box-shadow var(--tr-med) var(--tr-ease),
              transform var(--tr-med) var(--tr-ease);
}

/* ---- 4. KPI cards: quieter label, confident value --------------------- */
#view-trends .grid-cards .card {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-start;
  transition: border-color var(--tr-fast) var(--tr-ease),
              background var(--tr-fast) var(--tr-ease);
}
#view-trends .grid-cards .card .k {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: .045em;
  text-transform: uppercase;
  line-height: 1.3;
}
#view-trends .grid-cards .card .k sup {
  font-size: .68em;
  position: relative;
  top: -.35em;
  text-transform: none;
}
#trLagKpis .k-label .k-mid,
#trLagKpis .k-label .k-short { display: none; }
@media (max-width: 1080px) {
  #trLagKpis .k-label .k-full { display: none; }
  #trLagKpis .k-label .k-mid { display: inline; }
}
@media (max-width: 560px) {
  #trLagKpis .k-label .k-mid { display: none; }
  #trLagKpis .k-label .k-short { display: inline; }
}
#view-trends .grid-cards .card .v {
  letter-spacing: -.018em;
  line-height: 1.08;
}
#view-trends .grid-cards .card .v small {
  letter-spacing: 0;
  font-weight: 500;
  color: var(--text-dim);
}

/* ---- 5. Tables: header casing, calmer dividers, aligned numerics ------- */
#view-trends th {
  font-size: 10.5px;
  letter-spacing: .07em;
  font-weight: 650;
}
#view-trends tbody tr:not(:last-child) td {
  border-bottom-color: color-mix(in srgb, var(--border) 64%, transparent);
}
#view-trends .rank { font-size: 11.5px; }
#view-trends .net {
  font-family: var(--mono);
  font-weight: 600;
}
#view-trends .net.pos { color: color-mix(in srgb, var(--buy) 92%, var(--text)); }
#view-trends .net.neg { color: color-mix(in srgb, var(--sell) 92%, var(--text)); }
#view-trends .split-wrap small {
  color: color-mix(in srgb, var(--text-dim) 88%, var(--text));
}

/* ---- 6. Proportion bars (sector / cap / party / asset-type) -----------
   Recessed token track + token-sheen fill so a partial bar sits IN the
   channel; width animates on load with the shared easing. */
#view-trends .htrack {
  background: color-mix(in srgb, var(--bg) 50%, var(--panel-2));
  border-color: color-mix(in srgb, var(--border) 80%, transparent);
  border-radius: 8px;
  box-shadow: inset 0 1px 2px color-mix(in srgb, var(--bg) 55%, transparent);
}
#view-trends .hfill {
  border-radius: 6px;
  background-image: linear-gradient(180deg,
    color-mix(in srgb, var(--accent) 86%, var(--text)),
    color-mix(in srgb, var(--accent) 78%, transparent));
  background-color: color-mix(in srgb, var(--accent) 78%, transparent);
}
#view-trends .hfill.buy {
  background-image: linear-gradient(180deg, color-mix(in srgb, var(--buy) 92%, var(--text)), var(--buy));
  background-color: var(--buy);
}
#view-trends .hfill.sell {
  background-image: linear-gradient(180deg, color-mix(in srgb, var(--sell) 92%, var(--text)), var(--sell));
  background-color: var(--sell);
}
#view-trends .hfill.warn {
  background-image: linear-gradient(180deg, color-mix(in srgb, var(--warn) 92%, var(--text)), var(--warn));
  background-color: var(--warn);
}

/* ---- 7. Split buy/sell mini-bar: matching inset + crisp seam ----------- */
#view-trends .split {
  box-shadow: inset 0 1px 2px color-mix(in srgb, var(--bg) 45%, transparent);
}
#view-trends .split .seg.buy {
  background-image: linear-gradient(180deg, color-mix(in srgb, var(--buy) 90%, var(--text)), var(--buy));
  box-shadow: inset -1px 0 0 color-mix(in srgb, var(--bg) 50%, transparent);
}
#view-trends .split .seg.sell {
  background-image: linear-gradient(180deg, color-mix(in srgb, var(--sell) 90%, var(--text)), var(--sell));
}

/* ---- 8. Flow rows: tidy stack, quiet chip caption --------------------- */
#view-trends .flowrow .flabel,
#view-trends .flowrow .fval { letter-spacing: -.005em; color: var(--text); }
#view-trends .flowrow .fchip {
  margin-top: 6px;
  line-height: 1.5;
  color: color-mix(in srgb, var(--text-dim) 88%, var(--text));
}

/* ---- 9. Time chart "Buys vs Sells" -------------------------- */
#view-trends .tchart {
  border-bottom: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
}
#view-trends .tbars i { border-radius: 3px 3px 1px 1px; }
#view-trends .tbars i.buy {
  background-image: linear-gradient(180deg, color-mix(in srgb, var(--buy) 92%, var(--text)), color-mix(in srgb, var(--buy) 96%, transparent));
}
#view-trends .tbars i.sell {
  background-image: linear-gradient(180deg, color-mix(in srgb, var(--sell) 92%, var(--text)), color-mix(in srgb, var(--sell) 96%, transparent));
}
#view-trends .legend {
  align-items: center;
  letter-spacing: .04em;
  text-transform: uppercase;
  font-size: 11px;
  font-weight: 600;
}
#view-trends .legend .sw {
  border-radius: 3px;
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--border) 55%, transparent);
}

/* ---- 10. Segmented control (scoped to chart segs so .split .seg is safe)
   What Is Being Traded (#trTickerMetric) and Buys vs Sells (#trTimeMetric)
   share one size and ink: a little larger than the default 12px dim
   segment, and black (var(--text)) in both selected and idle states. */
#trTickerMetric.seg,
#trTimeMetric.seg { background: color-mix(in srgb, var(--panel-2) 60%, transparent); }
#trTickerMetric.seg button,
#trTimeMetric.seg button {
  color: var(--text);
  font: 700 14px var(--sans);
  padding: 5px 10px;
  letter-spacing: .02em;
  transition: color var(--tr-fast) var(--tr-ease), background-color var(--tr-fast) var(--tr-ease);
}
#trTickerMetric.seg button.on,
#trTimeMetric.seg button.on {
  color: var(--text);
  background: color-mix(in srgb, var(--accent) 18%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 34%, transparent);
}
#trTickerMetric.seg button:hover:not(.on),
#trTimeMetric.seg button:hover:not(.on) { color: var(--text); }
#trTickerMetric.seg button:focus-visible,
#trTimeMetric.seg button:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--accent) 45%, transparent);
}

/* ---- 11. Cluster cards: marquee component, tidy headline -------------- */
#view-trends .ccard .big { letter-spacing: -.01em; }
#view-trends .ccard .dirpill { letter-spacing: .05em; }
/* Real tag chips inside cluster cards / heading hints become faint pills;
   the cluster-grid loading/empty .chip (a block div) is handled in §12. */
#view-trends .ccard .chip,
#view-trends h3 .chip {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--text-dim) 12%, transparent);
  color: color-mix(in srgb, var(--text-dim) 90%, var(--text));
  line-height: 1.5;
}

/* ---- 12. Empty / error / loading states: calm token frames ------------ */
#view-trends .note {
  line-height: 1.55;
  border: 1px dashed color-mix(in srgb, var(--border) 80%, transparent);
  background: color-mix(in srgb, var(--panel-2) 55%, transparent);
  border-radius: 8px;
  padding: 11px 13px;
}
#view-trends .cluster-grid > .chip {
  display: block;
  grid-column: 1 / -1;
  padding: 12px 13px;
  border: 1px dashed color-mix(in srgb, var(--border) 80%, transparent);
  background: color-mix(in srgb, var(--panel-2) 55%, transparent);
  border-radius: 8px;
  line-height: 1.5;
}

/* ---- 13. Desktop/tablet micro-interactions (hover, no touch) ---------- */
@media (min-width: 721px) and (hover: hover) {
  /* Sections lift with a calm accent-tinted edge + short-throw shadow. */
  #view-trends .section:hover {
    border-color: color-mix(in srgb, var(--border) 55%, var(--accent));
    box-shadow: 0 10px 30px -20px color-mix(in srgb, var(--accent) 45%, transparent);
  }
  /* KPI cards get a whisper of accent on hover. */
  #view-trends .grid-cards .card:hover {
    border-color: color-mix(in srgb, var(--border) 55%, var(--accent));
    background: color-mix(in srgb, var(--accent) 4%, var(--panel));
  }
  /* Clickable rows: accent wash + 2px accent rail on the first cell. */
  #view-trends tr.clickable td { transition: background var(--tr-fast) var(--tr-ease); }
  #view-trends tr.clickable:hover td {
    background: color-mix(in srgb, var(--accent) 7%, var(--panel-2));
  }
  #view-trends tr.clickable td:first-child {
    box-shadow: inset 2px 0 0 -1px transparent;
    transition: box-shadow var(--tr-fast) var(--tr-ease);
  }
  #view-trends tr.clickable:hover td:first-child {
    box-shadow: inset 2px 0 0 0 color-mix(in srgb, var(--accent) 65%, transparent);
  }
  /* Ticker reads as the live link as its row lights up (rows are the click
     target; .asset-cell here has no .clickable, so key off tr.clickable). */
  #view-trends tr.clickable .tkr { transition: color var(--tr-fast) var(--tr-ease); }
  #view-trends tr.clickable:hover .tkr { color: var(--accent); }
  #view-trends tr.clickable:hover .tkr-logo.tile { border-color: color-mix(in srgb, var(--accent) 40%, var(--border)); }
  /* Politician identity cell (genuinely .clickable) takes accent on hover. */
  #view-trends .member-cell.clickable { transition: color var(--tr-fast) var(--tr-ease); }
  #view-trends .member-cell.clickable:hover { color: var(--accent); text-decoration: none; }
  /* Flow / hbar fills gently saturate when their row is hovered. */
  #view-trends .flowrow:hover .hfill,
  #view-trends .hbar:hover .hfill { filter: saturate(1.1) brightness(1.04); }
  /* Time chart: hovered column focuses, its siblings recede. */
  #view-trends .tcol { transition: opacity var(--tr-fast) var(--tr-ease); }
  #view-trends .tchart:hover .tcol:not(:hover) { opacity: .6; }
  #view-trends .tcol:hover .tbars i { filter: brightness(1.08) saturate(1.08); }
  /* Cluster cards lift 1px with an accent-tinted border + short shadow. */
  #view-trends .ccard.clickable:hover {
    border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
    background: color-mix(in srgb, var(--accent) 5%, var(--panel-2));
    transform: translateY(-1px);
    box-shadow: 0 12px 30px -20px color-mix(in srgb, var(--accent) 50%, transparent);
  }
  #view-trends .ccard.clickable:active { transform: translateY(0); }
  /* Toolbar selects + ghost buttons share the accent affordance. */
  #view-trends .toolbar select:hover,
  #view-trends .toolbar .btn.ghost:hover {
    border-color: color-mix(in srgb, var(--accent) 40%, var(--border));
  }
}

/* ---- 14. Animated fills + bars (motion, reduced-motion respected) ------ */
@media (prefers-reduced-motion: no-preference) {
  #view-trends .hfill,
  #view-trends .split .seg {
    transition: width .5s var(--tr-ease), filter var(--tr-fast) var(--tr-ease);
  }
  #view-trends .tbars i { transition: filter var(--tr-fast) var(--tr-ease); }
}

/* ---- 15. Keyboard focus parity (token rings, no layout shift) ---------- */
#view-trends tr.clickable:focus-visible { outline: none; }
#view-trends tr.clickable:focus-visible td {
  background: color-mix(in srgb, var(--accent) 8%, var(--panel-2));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 45%, transparent);
}
#view-trends .ccard.clickable:focus-visible {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent);
}
#view-trends .toolbar select:focus-visible,
#view-trends .btn:focus-visible,
#view-trends .info-tip:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 24%, transparent);
}

/* ---- 16. Desktop/tablet spacing + numeric edge alignment -------------- */
@media (min-width: 721px) {
  #view-trends .section { padding: 19px 20px; }
  #view-trends .trend-grid2, #view-trends .trend-grid-split { gap: var(--trends-gap, 24px); }
  /* Hang the standalone Est-Volume figures on a shared right edge. Identity
     and split-mix cells keep their left flow. (#trTickers td.est is hidden
     on phones by the base 720px query — this guard never undoes that.) */
  #view-trends #trTickers td.est,
  #view-trends #trMembers td.est { text-align: right; }
}

/* ---- 17. Reduced-motion: honor opt-out everywhere --------------------- */
@media (prefers-reduced-motion: reduce) {
  #view-trends .section,
  #view-trends .grid-cards .card,
  #view-trends .ccard,
  #view-trends tr.clickable td,
  #view-trends tr.clickable td:first-child,
  #view-trends tr.clickable .tkr,
  #view-trends .member-cell.clickable,
  #view-trends .hfill,
  #view-trends .split .seg,
  #view-trends .tcol,
  #view-trends .tbars i,
  #view-trends #trTimeMetric.seg button {
    transition: none;
  }
  #view-trends .ccard.clickable:hover { transform: none; }
}

/* ---- 18. Mobile guard (<=720px): keep enhancements from re-widening ----
   The base 720px query (which hides .split, #trTickers td.est, .asset-cell
   .muted and abbreviates to "pol(s)") runs AFTER this block. Re-assert only the
   safe, width-neutral pieces; drop chrome that only makes sense with hover. */
@media (max-width: 768px), (orientation: landscape) and (max-width: 950px) and (max-height: 520px) {
  #view-trends .section::before,
  #view-trends .grid-cards .card::before { box-shadow: none; }
  #view-trends .ccard .chip,
  #view-trends h3 .chip { padding: 1px 6px; }
  /* Headings stay flush with card padding (accent-tick indent was removed). */
  #view-trends .section > h3,
  #view-trends .section > .tchart-head > h3,
  #view-trends .section > .row-flex > h3 { padding-left: 0; }
}

  #view-trends .card .v .est-money,
  #view-trends .card .v small { color: inherit !important; }

  @media (max-width: 768px), (hover: none) and (pointer: coarse) {
    /* Keep the compact 52px header.  The old 14px 22px padding here made
       --ct-header-h (52px) lie, so sticky filters slid through the logo. */
    header.top { padding: 6px 10px 0; background: var(--panel); -webkit-backdrop-filter: none; backdrop-filter: none; }
    html[data-theme="light"] header.top { background: #fff; }
    .brand-logo { width:322px; max-width:100%; height:auto; }
    /* Owner 2026-09-21 punch list: 15% larger than the prior 280px (now 322px). */
    /* Replace the theme-toggle / Sign In / Upgrade cluster with a single
       hamburger button so the brand lockup is never squeezed off-screen
       (issue #1456 — brand hidden behind a 3-button theme toggle at 375px).
       Coarse pointer also matches iPhone "desktop site" (wide viewport). */
    .acct-desktop { display: none; }
    .acct-mobile { display: inline-flex; }
  }
  html.phone-chrome .acct-desktop { display: none !important; }
  html.phone-chrome .acct-mobile { display: inline-flex !important; }
  html.phone-chrome .brand { margin-left: 1ch; }
  html.phone-chrome .brand-logo { width:322px; max-width:100%; height:auto; }
    /* Owner 2026-09-21 punch list: 15% larger than the prior 280px (now 322px). */
  @media (max-width: 768px), (hover: none) and (pointer: coarse) {
    .acct-desktop { display: none; }
    .acct-mobile { display: inline-flex; }
    .acct-mobile-menu {
      /* Anchored under the wordmark row (--ct-brand-h), not the whole
         header: the filter row is header row 2 and the sheet covers it. */
      position: fixed; left: 12px; right: 12px; top: calc(var(--ct-brand-h, 62px) + 8px);
      min-width: 0; max-width: none;
      max-height: min(82vh, calc(100dvh - var(--ct-brand-h, 62px) - 20px));
      overflow: auto; padding: 18px 16px; border-radius: 18px; z-index: 70;
    }
    .acct-mobile-menu .btn, .acct-mobile-menu button { min-height: 48px; font-size: 16px; }
    .acct-mobile-menu .menu-section-label { font-size: 17px; margin-top: 14px; }
    .overlay { align-items: flex-end; padding: 0; }
    .overlay .modal {
      max-width: none; width: 100%;
      border-radius: 20px 20px 0 0;
      padding: 28px 22px calc(28px + env(safe-area-inset-bottom, 0px));
      max-height: 92dvh; overflow: auto;
    }
    /* Owner punch list #5: this shorthand used to reset ALL four sides,
       silently clobbering the wider block's safe-area-aware padding-bottom
       for every phone <=720px (the width nearly all phones report in
       portrait) — footer/last content ended up hidden behind the fixed tab
       bar. Re-assert padding-bottom explicitly so it survives here too.
       Horizontal pad is the --ct-main-pad token (filter full-bleed).  Top
       pad stays 0 so the white filter strip sits under the title. */
    :root { --ct-main-pad: 14px; }
    main { padding: 0 14px; padding-bottom: calc(70px + env(safe-area-inset-bottom)); }
    .toolbar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-bottom: 14px; }
    .toolbar .time-filter-wrap { flex: 0 1 auto; }
    .toolbar .trends-filter-row { flex: 0 1 auto; }
    .grid-cards { gap: 12px; margin-bottom: 20px; }
    .card { padding: 14px 16px; }
    .section { padding: 18px; margin-bottom: 18px; }
    .banner { margin-bottom: 18px; }
    .trend-grid2, .trend-grid-split, .trend-members-grid, .trend-side-stack { gap: 18px; }
    .timeliness-grid { gap: 24px; }
    .cluster-grid { gap: 12px; }
    .ccard { padding: 13px 14px; }
    .trades-cards { gap: 10px; }
    .trades-card { padding: 11px 12px; gap: 8px; }
    .drawer-stack-grid { gap: 12px; }
    .drawer-stack-grid .drawer-section { padding: 12px; }
    .benchmark-panel { padding: 14px; margin-top: 14px; }
    .search-panel { margin: -4px 0 14px; padding: 12px 14px; }
    .diag-grid { gap: 10px; margin: 10px 0 14px; }
    .diag-card { padding: 11px 12px; }
    /* Owner punch list #5: same ~2-line extra bottom clearance as the wider
       breakpoint's footer rule, scaled to this block's tighter 26px base. */
    footer { padding: 26px 18px calc(58px + env(safe-area-inset-bottom)); }
  }
  /* The Trends filter markup is a hidden state mirror (see #ctFilters). */
  #view-trends #trendsSharedFilters[data-filter-mirror] { display: none !important; }
  #ctFilters #tradesSharedFilters > .pill-select.pill-cal { flex: 0 0 auto; width: max-content; }

  /* 2026-09-21 owner ask: big red banner for filing_skips / fmp_latency /
     price_freshness. Renders at the top of <main> so every view shows it
     when active. Two-tier coloring: red for the "almost always an app
     error" class (filing_skips), orange for the "stale data" classes
     (price_freshness, fmp_latency). */
  .owner-alerts { display: block; padding: 0; margin: 0; border-bottom: 1px solid var(--border, #e5e7eb); }
  .owner-alerts[hidden] { display: none; }
  .owner-alert-row { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 12px 18px; font-size: 14px; line-height: 1.4; border-top: 1px solid currentColor; }
  .owner-alert-row:first-child { border-top: 0; }
  .owner-alert-red { color: #b91c1c; background: #fef2f2; }
  .owner-alert-red .owner-alert-icon { color: #b91c1c; }
  .owner-alert-orange { color: #92400e; background: #fffbeb; }
  .owner-alert-orange .owner-alert-icon { color: #92400e; }
  .owner-alert-icon { font-size: 22px; line-height: 1; flex: 0 0 auto; }
  .owner-alert-title { font-weight: 700; flex: 0 0 auto; }
  .owner-alert-detail { flex: 1 1 320px; color: #374151; }





</style>
</head>
<body>

<header class="top">
  <a class="brand" href="/?view=trends" aria-label="Congress.Trade - home" onclick="event.preventDefault(); showView('trends'); window.scrollTo({ top: 0 });">
    <img class="brand-logo" id="brandLogo" src="/assets/brand-logo-light.png?v=20" data-src-dark="/assets/brand-logo-dark.png?v=20" data-src-light="/assets/brand-logo-light.png?v=20" alt="Congress.Trade" width="1670" height="334" decoding="async" /></a>
  <nav class="tabs" role="tablist" aria-label="Primary views">
    <a href="/?view=trends" data-view="trends" data-mobile="Trends" data-icon="📈" class="active" id="tab-trends" role="tab" aria-selected="true" aria-current="page" aria-controls="view-trends" aria-label="Trends"><span aria-hidden="true">Trends</span></a>
    <a href="/?view=trades" data-view="trades" data-mobile="Trades" data-icon="☰" id="tab-trades" role="tab" aria-selected="false" aria-controls="view-trades" aria-label="Trades"><span aria-hidden="true">Trades</span></a>
    <a href="/?view=people" data-view="people" data-mobile="Directory" data-icon="👥" id="tab-people" role="tab" aria-selected="false" aria-controls="view-people" aria-label="Directory"><span aria-hidden="true">Directory</span></a>
    <a href="/?view=review" data-view="review" data-mobile="Review" data-icon="✓" id="tab-review" role="tab" aria-selected="false" aria-controls="view-review" data-admin-tab="true" title="Review Queue" hidden aria-label="Review Queue"><span aria-hidden="true">Review Queue <span class="tab-count-badge" id="reviewTabBadge" hidden></span></span></a>
    <a href="/?view=subs" data-view="subs" data-mobile="Delivery" data-icon="🔔" id="tab-subs" role="tab" aria-selected="false" aria-controls="view-subs" aria-label="Delivery"><span aria-hidden="true">Delivery</span></a>
    <a href="/?view=admin" data-view="admin" data-mobile="Admin" data-icon="⚙" id="tab-admin" role="tab" aria-selected="false" aria-controls="view-admin" data-admin-tab="true" title="Admin · Cadence" hidden aria-label="Admin · Cadence"><span aria-hidden="true">Admin · Cadence <span class="tab-count-badge" id="adminTabBadge" hidden></span></span></a>
  </nav>
  <div id="acct" class="acct"></div>
  <!-- Shared filter row (Trades + Trends).  Owner punch list #9 merged the
       Trades feed's two toolbars onto one row via #tradesToolbars
       (display:contents on both children + flex order, see CSS); owner
       2026-09-09 moved that whole block up here so the filters sit right of
       the logo and carry over between Trades and Trends.  Ids/handlers are
       unchanged; #tradesExtraFilters (search) hides on Trends via
       html[data-view].  The <=768px ID-scoped grid on #tradesExtraFilters
       (DO-NOT-BREAK) is untouched. -->
  <div id="ctFilters" class="ct-filters" role="group" aria-label="Filters - apply to Trends and Trades">
    <div class="trades-toolbars" id="tradesToolbars">
    <!-- Shared filter row (mirrored on Trends) -->
    <div class="toolbar shared-filters" id="tradesSharedFilters">
      <span class="pill-select pill-cal">
        <select id="tradesGlobalWindow" class="tr-window-select shared-window pill-select-el" title="Time window" aria-label="Time window" onchange="onSharedWindowChange(this)">
          <option value="90d" selected>3 Months</option>
          <option value="180d">6 Months</option>
          <option value="365d">1 Year</option>
          <option value="1825d">5 Years</option>
          <option value="this_cy">This Year</option>
          <option value="last_cy">Last Year</option>
          <!-- Owner 2026-09-21 ask: remove "1 Month" (less than 10% as many
               rows as 3 Months; the 45-day STOCK Act reporting window makes
               it actively misleading) and remove "All Time" (5-year
               retention cap is now the longest available window; "All Time"
               timed out on iOS even when it eventually returned the same
               count as 5 Years). -->
        </select>
      </span>
      <div class="filter-groups">
        <div class="ios-filter branch-filters" id="qChamber">
          <button type="button" class="ios-filter-btn" aria-haspopup="true" aria-expanded="false" aria-label="Filter by branch">
            <span class="ios-filter-ico" aria-hidden="true">🏛</span>
            <span class="ios-filter-lbl" data-ios-summary>All</span>
          </button>
          <div class="ios-filter-pop" hidden>
            <button type="button" class="ios-filter-clear" data-ios-clear="chamber">All Branches</button>
            <button type="button" class="branch-toggle ios-filter-item" data-ch="house" aria-pressed="false">House</button>
            <button type="button" class="branch-toggle ios-filter-item" data-ch="senate" aria-pressed="false">Senate</button>
            <button type="button" class="branch-toggle ios-filter-item" data-ch="executive" aria-pressed="false">Executive</button>
          </div>
        </div>
        <div class="ios-filter party-chips" id="qPartyGroup">
          <button type="button" class="ios-filter-btn" aria-haspopup="true" aria-expanded="false" aria-label="Filter by party">
            <span class="ios-filter-ico" aria-hidden="true">👥</span>
            <span class="ios-filter-lbl" data-ios-summary>All</span>
          </button>
          <div class="ios-filter-pop" hidden>
            <button type="button" class="ios-filter-clear" data-ios-clear="party">All Parties</button>
            <button type="button" class="party-chip ios-filter-item" data-party="D" aria-pressed="false"><span class="party-dot D" aria-hidden="true"></span> Democrats</button>
            <button type="button" class="party-chip ios-filter-item" data-party="R" aria-pressed="false"><span class="party-dot R" aria-hidden="true"></span> Republicans</button>
            <button type="button" class="party-chip ios-filter-item" data-party="O" aria-pressed="false"><span class="party-dot O" aria-hidden="true"></span> Other / No party</button>
          </div>
        </div>
        <div class="ios-filter side-chips" id="qSideGroup">
          <button type="button" class="ios-filter-btn" aria-haspopup="true" aria-expanded="false" aria-label="Filter by trade type">
            <span class="ios-filter-ico sides" aria-hidden="true"><span class="side-up">▲</span><span class="side-dn">▼</span><span class="side-ex">⇄</span></span>
            <span class="ios-filter-lbl" data-ios-summary></span>
          </button>
          <div class="ios-filter-pop" hidden>
            <button type="button" class="ios-filter-clear" data-ios-clear="side">All Sides</button>
            <button type="button" class="side-chip ios-filter-item" data-side="B" aria-pressed="false"><span class="side-up" aria-hidden="true">▲</span> Buys</button>
            <button type="button" class="side-chip ios-filter-item" data-side="S" aria-pressed="false"><span class="side-dn" aria-hidden="true">▼</span> Sells</button>
            <button type="button" class="side-chip ios-filter-item" data-side="E" aria-pressed="false"><span class="side-ex" aria-hidden="true">⇄</span> Exchanges</button>
          </div>
        </div>
      </div>
    </div>
    <!-- Trades-only extras -->
    <div class="toolbar trades-only-filters" id="tradesExtraFilters">
      <span class="icon-field" id="qSearchField">
        <input id="qSearch" type="search" class="icon-input" placeholder="Search name, ticker, state, party…" aria-label="Search trades by politician, asset, state, or party" oninput="handleTradesTextFilter()" />
      </span>
      <!-- Legacy aliases kept hidden so old deep links / tests migrating can still hydrate -->
      <input type="hidden" id="qMember" value="" />
      <input type="hidden" id="qTicker" value="" />
    </div>
    </div>
    <button type="button" class="btn ghost sm ct-filter-reset" id="ctFilterReset" onclick="resetSharedFilters()" title="Reset filters to defaults" hidden>Reset</button>
  </div>
</header>

<main>
  <!-- #2071: do not put #banner here. A first-child status strip sits
       between header.top and the sticky filter rows. Feed status lives
       inside each filtered view, after that view's filter row, and stays
       hidden until setBanner() has a real error. -->

  <!-- 2026-09-21 owner ask: big red banner for filing_skips / fmp_latency /
       price_freshness critical. Lives at the top of <main> so every view
       (Trades / Trends / Admin / Review) sees it. Hidden by default;
       renderOwnerHealthBanner() fills it from /api/health on first load
       and after every health poll. CSS lives in owner-alert-* class set.
       Element is a <section> so dashboardHtml.test.ts's
       "main's first child is a section" invariant stays true. Class
       name is "owner-alerts" (not "banner") so the legacy "no .banner
       in <main>" invariant in #2071 holds for the connecting-banner
       concept while this alert container co-exists. -->
  <section id="ownerHealthBanner" class="owner-alerts" hidden aria-label="Owner health alerts"></section>

  <!-- ================= TRADES (LIVE FEED) ================= -->
  <section class="view" id="view-trades" role="tabpanel" aria-labelledby="tab-trades" aria-hidden="true">
    <!-- The Trades/Trends filter row (#tradesToolbars) lives in header.top
         (#ctFilters) so it carries over between the two tabs. -->
    <div class="banner feed-banner" hidden></div>
    <dialog class="search-panel" id="colChooser" onclick="if(event.target === this) closePanels()">
      <div class="panel-head"><span class="panel-title">Columns</span><button class="panel-close" onclick="closePanels()" aria-label="Close columns">×</button></div>
      <div id="colChooserBody" class="colopts"></div>
      <button class="btn ghost sm" onclick="resetCols()">Reset</button>
    </dialog>
    <!-- Pagination top + bottom: same controls, synced in updateTradesCountMsg / setPageSize. -->
    <div class="row-flex pager pager-top" data-pager="top">
      <div class="trades-sort-mobile" id="tradesSortMobile">
        <label class="lbl" for="mobileSortKey">Sort</label>
        <select id="mobileSortKey" aria-label="Sort by" title="Sort by" onchange="handleMobileSortKeyChange()"></select>
        <button type="button" class="btn ghost sm" id="mobileSortDirBtn" onclick="toggleMobileSortDir()" aria-label="Toggle sort direction"></button>
      </div>
      <span class="note trades-count-msg" id="tradesCountMsgTop" data-trades-count></span>
      <div class="pager-controls" role="navigation" aria-label="Trades pagination top">
        <button class="btn ghost sm" data-pager-first onclick="firstTradesPage()" title="First page" aria-label="First page">&laquo;</button>
        <button class="btn ghost sm" data-pager-prev onclick="prevTradesPage()" title="Previous page" aria-label="Previous page">&lsaquo;</button>
        <span class="note trades-page-msg" data-trades-page></span>
        <button class="btn ghost sm" data-pager-next onclick="nextTradesPage()" title="Next page" aria-label="Next page">&rsaquo;</button>
        <button class="btn ghost sm" data-pager-last onclick="lastTradesPage()" title="Last page" aria-label="Last page">&raquo;</button>
      </div>
      <div class="pager-tools">
        <select data-page-size onchange="setPageSize(this.value)" title="Rows shown per page" aria-label="Rows per page">
          <option value="25">25 rows</option><option value="50" selected>50 rows</option><option value="100">100 rows</option><option value="250">250 rows</option>
        </select>
        <div class="menu feed-options">
          <button type="button" class="btn ghost sm feed-options-btn" data-feed-options-btn onclick="toggleFeedOptions(this)" title="List options" aria-label="List options" aria-haspopup="true" aria-expanded="false">⋯</button>
          <div class="menu-pop feed-options-menu" data-feed-options-menu role="menu">
            <button type="button" class="feed-options-item-cols" role="menuitem" onclick="closeFeedOptions();toggleColChooser()">Columns</button>
            <button type="button" id="exportCsvBtn" role="menuitem" onclick="closeFeedOptions();openExportCsvDialog()">Export CSV <span class="premium-mark" title="Premium">Pro</span></button>
          </div>
        </div>
      </div>
    </div>
    <div class="table-wrap">
    <table id="tradesTable">
      <colgroup id="tradesCols"></colgroup>
      <thead><tr id="tradesHead"></tr></thead>
      <tbody id="tradesBody"></tbody>
    </table>
    </div>
    <div id="tradesCards" class="trades-cards mobile-only" aria-live="polite"></div>
    <div class="row-flex pager pager-bottom" data-pager="bottom">
      <span class="note trades-count-msg" id="tradesCountMsg" data-trades-count></span>
      <div class="pager-controls" role="navigation" aria-label="Trades pagination">
        <button class="btn ghost sm" id="firstPageBtn" data-pager-first onclick="firstTradesPage()" title="First page" aria-label="First page">&laquo;</button>
        <button class="btn ghost sm" id="prevPageBtn" data-pager-prev onclick="prevTradesPage()" title="Previous page" aria-label="Previous page">&lsaquo;</button>
        <span class="note trades-page-msg" id="tradesPageMsg" data-trades-page></span>
        <button class="btn ghost sm" id="nextPageBtn" data-pager-next onclick="nextTradesPage()" title="Next page" aria-label="Next page">&rsaquo;</button>
        <button class="btn ghost sm" id="lastPageBtn" data-pager-last onclick="lastTradesPage()" title="Last page" aria-label="Last page">&raquo;</button>
      </div>
      <div class="pager-tools">
        <select id="pageSize" data-page-size onchange="setPageSize(this.value)" title="Rows shown per page" aria-label="Rows per page">
          <option value="25">25 rows</option><option value="50" selected>50 rows</option><option value="100">100 rows</option><option value="250">250 rows</option>
        </select>
        <div class="menu feed-options">
          <button type="button" class="btn ghost sm feed-options-btn" data-feed-options-btn onclick="toggleFeedOptions(this)" title="List options" aria-label="List options" aria-haspopup="true" aria-expanded="false">⋯</button>
          <div class="menu-pop feed-options-menu" data-feed-options-menu role="menu">
            <button type="button" class="feed-options-item-cols" role="menuitem" onclick="closeFeedOptions();toggleColChooser()">Columns</button>
            <button type="button" role="menuitem" onclick="closeFeedOptions();openExportCsvDialog()">Export CSV <span class="premium-mark" title="Premium">Pro</span></button>
          </div>
        </div>
      </div>
    </div>
    <div class="row-flex" id="gateRow" style="margin-top:10px;justify-content:center">
      <span class="gate-note" data-premium-cue="export">Premium unlocks Webhooks + SSE + Proprietary Enrichment Data + CSV &middot; $9/mo or $80/yr &middot; 1-week free trial
        <button class="btn sm" onclick="openPricing('export')">Start Free Trial</button></span>
    </div>

  </section>

  <!-- ================= TRENDS / ANALYTICS ================= -->
  <section class="view active" id="view-trends" role="tabpanel" aria-labelledby="tab-trends" aria-hidden="false">
    <!-- State mirror only (hidden): trParams()/getTrWindow() and the chip
         sync read these ids; the visible controls are #ctFilters in
         header.top. -->
    <div class="toolbar shared-filters trends-filter-row" id="trendsSharedFilters" hidden aria-hidden="true" data-filter-mirror>
      <span class="pill-select pill-cal">
        <select id="trGlobalWindow" class="tr-window-select shared-window pill-select-el" title="Time window" aria-label="Time window" onchange="onSharedWindowChange(this)">
          <option value="30d">Month</option>
          <option value="90d" selected>3 Months</option>
          <option value="180d">6 Months</option>
          <option value="365d">Year</option>
          <option value="1825d">5 Years</option>
          <option value="this_cy">This Year</option>
          <option value="last_cy">Last Year</option>
          <option value="all">All Time</option>
        </select>
      </span>
      <div class="filter-groups">
        <div class="ios-filter branch-filters" id="trChamber">
          <button type="button" class="ios-filter-btn" aria-haspopup="true" aria-expanded="false" aria-label="Filter by branch">
            <span class="ios-filter-ico" aria-hidden="true">🏛</span>
            <span class="ios-filter-lbl" data-ios-summary>All</span>
          </button>
          <div class="ios-filter-pop" hidden>
            <button type="button" class="ios-filter-clear" data-ios-clear="chamber">All Branches</button>
            <button type="button" class="branch-toggle ios-filter-item" data-ch="house" aria-pressed="false">House</button>
            <button type="button" class="branch-toggle ios-filter-item" data-ch="senate" aria-pressed="false">Senate</button>
            <button type="button" class="branch-toggle ios-filter-item" data-ch="executive" aria-pressed="false">Executive</button>
          </div>
        </div>
        <div class="ios-filter party-chips" id="trPartyGroup">
          <button type="button" class="ios-filter-btn" aria-haspopup="true" aria-expanded="false" aria-label="Filter by party">
            <span class="ios-filter-ico" aria-hidden="true">👥</span>
            <span class="ios-filter-lbl" data-ios-summary>All</span>
          </button>
          <div class="ios-filter-pop" hidden>
            <button type="button" class="ios-filter-clear" data-ios-clear="party">All Parties</button>
            <button type="button" class="party-chip ios-filter-item" data-party="D" aria-pressed="false"><span class="party-dot D" aria-hidden="true"></span> Democrats</button>
            <button type="button" class="party-chip ios-filter-item" data-party="R" aria-pressed="false"><span class="party-dot R" aria-hidden="true"></span> Republicans</button>
            <button type="button" class="party-chip ios-filter-item" data-party="O" aria-pressed="false"><span class="party-dot O" aria-hidden="true"></span> Other / No party</button>
          </div>
        </div>
        <div class="ios-filter side-chips" id="trSideGroup">
          <button type="button" class="ios-filter-btn" aria-haspopup="true" aria-expanded="false" aria-label="Filter by trade type">
            <span class="ios-filter-ico sides" aria-hidden="true"><span class="side-up">▲</span><span class="side-dn">▼</span><span class="side-ex">⇄</span></span>
            <span class="ios-filter-lbl" data-ios-summary></span>
          </button>
          <div class="ios-filter-pop" hidden>
            <button type="button" class="ios-filter-clear" data-ios-clear="side">All Sides</button>
            <button type="button" class="side-chip ios-filter-item" data-side="B" aria-pressed="false"><span class="side-up" aria-hidden="true">▲</span> Buys</button>
            <button type="button" class="side-chip ios-filter-item" data-side="S" aria-pressed="false"><span class="side-dn" aria-hidden="true">▼</span> Sells</button>
            <button type="button" class="side-chip ios-filter-item" data-side="E" aria-pressed="false"><span class="side-ex" aria-hidden="true">⇄</span> Exchanges</button>
          </div>
        </div>
      </div>
    </div>
    <div class="banner feed-banner" id="banner" hidden></div>
    <!-- KPI strip. Timeframe lives in the sticky filter row, not after headings. -->
    <div class="grid-cards" id="trKpis">
      <div class="card"><div class="k">Loading…</div><div class="v">—</div></div>
    </div>

    <!-- What is being traded + Top Performers (owner 2026-09-04: Rising
         Activity moved to the later equal-width pair so its four columns
         are not cramped in this 0.75fr slot). -->
    <div class="trend-grid-split">
      <details class="section trends-fold" open>
        <summary class="tf-h tchart-summary">
          <span class="tchart-summary-title">What Is Being Traded</span>
          <div class="tchart-controls" onclick="event.preventDefault();event.stopPropagation();">
            <div class="seg" id="trTickerMetric" role="group" aria-label="Rank by trade count or volume">
              <button type="button" data-m="trades" class="on" onclick="setTickerSort('trades')">#</button>
              <button type="button" data-m="volume" onclick="setTickerSort('volume')">$</button>
            </div>
          </div>
          <span class="fold-cue" aria-hidden="true"></span>
        </summary>
        <div class="table-wrap">
          <table id="tableTrTickers">
            <thead>
              <tr>
                <th class="sortable" style="min-width: 140px;"><button type="button" class="th-sort-btn" onclick="setTickerSort('trades')">Asset</button></th>
                <th class="sortable" data-sort="trades" aria-sort="descending"><button type="button" class="th-sort-btn" onclick="setTickerSort('trades')">Trades <span class="sort-icon" data-sort="trades" aria-hidden="true"></span></button></th>
                <th class="sortable r" data-sort="members" aria-sort="none"><button type="button" class="th-sort-btn" onclick="setTickerSort('members')">Politicians <span class="sort-icon" data-sort="members" aria-hidden="true"></span></button></th>
                <th class="sortable r est" data-sort="volume" aria-sort="none"><button type="button" class="th-sort-btn" onclick="setTickerSort('volume')">Est. Volume <span class="sort-icon" data-sort="volume" aria-hidden="true"></span></button></th>
                <th class="sortable r" data-sort="netflow" aria-sort="none"><button type="button" class="th-sort-btn" onclick="setTickerSort('netflow')">Net Flow <span class="sort-icon" data-sort="netflow" aria-hidden="true"></span></button></th>
              </tr>
            </thead>
            <tbody id="trTickers"></tbody>
          </table>
        </div>
      </details>
      <details class="section trends-fold" id="trPerformersFold" open>
        <summary class="tf-h">Top Performers <span class="info-tip" tabindex="0" aria-label="Measured from each trade's public filing date to now.  5+ buys, stocks only, +/-200% cap per trade." title="Measured from each trade's public filing date to now.  5+ buys, stocks only, +/-200% cap per trade.">ⓘ</span><span class="fold-cue" aria-hidden="true"></span></summary>
        <p class="sub">Politicians whose disclosed <strong>buys</strong> beat the S&amp;P 500 after the trade was <strong>disclosed</strong>, shown as an <strong>average excess return</strong> (matching the benchmark = 0%).</p>
        <p class="sub">5+ buys&nbsp;&nbsp; &bull;&nbsp;&nbsp;&nbsp;stocks only&nbsp;&nbsp; &bull;&nbsp;&nbsp;&nbsp;+/-200% cap per trade</p>
        <p class="sub" id="trPerformersAsOf" aria-live="polite"></p>
        <div class="table-wrap"><table><tbody id="trPerformers"></tbody></table></div>
      </details>
    </div>

    <!-- Buys vs sells: full-width chart after the first Trends pair. -->
    <details class="section trends-fold" open>
      <summary class="tf-h tchart-summary">
        <span class="tchart-summary-title">Buys vs Sells</span>
        <div class="tchart-controls" onclick="event.preventDefault();event.stopPropagation();">
          <div class="seg" id="trTimeMetric" role="group" aria-label="Chart metric">
            <button type="button" data-m="count" class="on" onclick="setTrTimeMetric('count')">#</button>
            <button type="button" data-m="dollars" onclick="setTrTimeMetric('dollars')">$</button>
          </div>
        </div>
        <span class="fold-cue" aria-hidden="true"></span>
      </summary>
      <div class="tchart-head" style="margin-bottom:6px;">
        <div class="legend"><span><span class="sw buy"></span>Buys</span><span><span class="sw sell"></span>Sells</span></div>
      </div>
      <div id="trTime"></div>
    </details>

    <!-- Consensus / cluster buys -->
    <details class="section trends-fold" open>
      <summary class="tf-h">Consensus Moves<span class="fold-cue" aria-hidden="true"></span></summary>
      <div class="cluster-grid" id="trClusters"></div>
    </details>

    <!-- Real GICS sector flow + market-cap size tilt (securities_ref-backed) -->
    <div class="trend-grid2">
      <details class="section trends-fold" open>
        <summary class="tf-h">By Sector<span class="fold-cue" aria-hidden="true"></span></summary>
        <div id="trSectorFlow"></div>
      </details>
      <details class="section trends-fold" open>
        <summary class="tf-h">By Market Cap<span class="fold-cue" aria-hidden="true"></span></summary>
        <div id="trCapFlow"></div>
      </details>
    </div>

    <!-- Politicians: Rising Activity (four columns, needs the equal pair) + Most Active -->
    <div class="trend-grid2">
      <details class="section trends-fold" id="trRisingFold" open>
        <summary class="tf-h">Rising Activity<span class="fold-cue" aria-hidden="true"></span></summary>
        <div class="table-wrap">
          <table id="tableTrTrending">
            <thead>
              <tr>
                <th scope="col" style="min-width: 90px;">Asset</th>
                <th scope="col">Trades</th>
                <th scope="col">Change</th>
                <th scope="col">Politicians</th>
              </tr>
            </thead>
            <tbody id="trTrending"></tbody>
          </table>
        </div>
      </details>
      <details class="section trends-fold" open>
        <summary class="tf-h">Most Active Politicians<span class="fold-cue" aria-hidden="true"></span></summary>
        <div class="table-wrap"><table><tbody id="trMembers"></tbody></table></div>
      </details>
    </div>

    <!-- Category Breakdowns: By Party + By Asset Type -->
    <div class="trend-grid2">
      <details class="section trends-fold" open>
        <summary class="tf-h">By Party<span class="fold-cue" aria-hidden="true"></span></summary>
        <div id="trParties"></div>
      </details>
      <details class="section trends-fold" open>
        <summary class="tf-h">By Asset Type<span class="fold-cue" aria-hidden="true"></span></summary>
        <div id="trSectors"></div>
      </details>
    </div>

    <!-- Disclosure timeliness -->
    <details class="section trends-fold" open>
      <summary class="tf-h">Disclosure Timeliness<span class="fold-cue" aria-hidden="true"></span></summary>
      <p class="sub">Days from trade to filing.&nbsp; The STOCK Act sets a 45-day deadline; this is a data-quality + accountability lens.</p>
      <div class="grid-cards" id="trLagKpis"></div>
      <div class="trend-grid2 timeliness-grid">
        <div class="timeliness-panel">
          <h3 title="Counts trade rows by disclosure lag: the number of days between transaction date and official filing date.">Lag Distribution</h3>
          <div class="lag-dist-header"><span class="day-col">Days</span><span class="count-col">Count</span></div>
          <div id="trLagDist" class="lag-dist"></div>
        </div>
        <div class="timeliness-panel">
          <h3 title="Filers with the highest average trade-to-filing delay in the selected time window.">Slowest Filers (Average Lag)</h3>
          <div class="late-filers-wrap"><table>
            <thead><tr><th scope="col">Politician</th><th scope="col">Avg</th><th scope="col">Max</th><th scope="col">Late</th></tr></thead>
            <tbody id="trLateFilers"></tbody>
          </table></div>
        </div>
      </div>
    </details>

    <!-- Committee conflicts (journalistic accountability lens) -->
    <details class="section trends-fold" open>
      <summary class="tf-h">Committee Sector Conflicts<span class="fold-cue" aria-hidden="true"></span></summary>
      <p class="sub">Disclosed trades in sectors that a politician&rsquo;s committees oversee (curated committee→sector map).&nbsp; Observational — not evidence of impropriety.&nbsp; Hover a committee cell for the full list; click a row for the politician.</p>
      <div class="table-wrap"><table class="conflicts-table" id="tableTrConflicts">
        <colgroup><col class="c-pol"><col class="c-com"><col class="c-sec"><col class="c-ast"><col class="c-side"><col class="c-est"></colgroup>
        <thead><tr><th scope="col">Politician</th><th scope="col">Committee</th><th scope="col">Sector</th><th scope="col">Asset</th><th scope="col">Side</th><th scope="col" class="est">Est. $</th></tr></thead>
        <tbody id="trConflicts"><tr><td colspan="6" class="state">Loading…</td></tr></tbody>
      </table></div>
    </details>

    <div class="section" id="trLatencyLink" hidden>
      <p class="sub" style="margin:0"><a href="#trLatencySection" onclick="openSpeedProof();return false;">Filing latency comparison</a> lives at the end of Delivery.</p>
    </div>
  </section>

  <!-- ================= DIRECTORY (politician directory) ================= -->
  <section class="view" id="view-people" role="tabpanel" aria-labelledby="tab-people" aria-hidden="true">
    <div class="section">
      <h3>Directory</h3>
      <p class="sub" id="dirSub">Look up members of Congress and executive filers.&nbsp; Search by name, state (full or abbrev), or party.&nbsp; Click a column heading to sort; click a name for their profile and trades.&nbsp; Trade counts cover the full record, not the timeframe set on Trades or Trends.</p>
      <div class="seg dir-mode-seg" id="dirMode" role="group" aria-label="Directory mode">
        <button type="button" data-mode="people" class="on" onclick="setDirectoryMode('people')">People</button>
        <button type="button" data-mode="assets" onclick="setDirectoryMode('assets')">Assets</button>
      </div>
      <div class="toolbar" style="margin-bottom:12px">
        <input id="peopleQ" placeholder="Search name, state, party… any order" aria-label="Search directory" style="min-width:0;flex:1" oninput="filterDirectory()" />
        <select id="peopleChamber" onchange="filterPeopleDirectory()" aria-label="Chamber filter">
          <option value="">All Branches</option>
          <option value="house">House</option>
          <option value="senate">Senate</option>
          <option value="executive">Executive</option>
        </select>
        <button class="btn ghost sm" onclick="refreshDirectory()">Refresh</button>
      </div>
      <div class="table-wrap people-table-wrap" id="peopleTableWrap"><table id="peopleTable" class="people-table">
        <thead><tr id="peopleHead">
          <th scope="col" class="col-fill" data-sort="name" aria-sort="none" title="Sort by name"><button type="button" class="th-sort-btn" onclick="sortPeopleDirectory('name')">Politician <span class="sort-ind" aria-hidden="true"></span></button></th>
          <th scope="col" class="col-fit" data-sort="chamber" aria-sort="none" title="Sort by branch, party, state"><button type="button" class="th-sort-btn" onclick="sortPeopleDirectory('chamber')">Branch • Party • State <span class="sort-ind" aria-hidden="true"></span></button></th>
          <th scope="col" class="col-num" data-sort="trades" aria-sort="none" title="Sort by trade count (all time)"><button type="button" class="th-sort-btn" onclick="sortPeopleDirectory('trades')">Trades <span class="sort-ind" aria-hidden="true"></span></button></th>
        </tr></thead>
        <tbody id="peopleBody"><tr><td colspan="3" class="state">Loading directory…</td></tr></tbody>
      </table></div>
      <p class="note" id="peopleCount"></p>
      <div class="table-wrap people-table-wrap" id="assetsTableWrap" style="display:none"><table id="assetsTable" class="people-table">
        <thead><tr id="assetsHead">
          <th scope="col" class="col-fill" data-sort="name" aria-sort="none" tabindex="0" role="button" onclick="sortAssetsDirectory('name')" title="Sort by asset">Asset <span class="sort-ind" aria-hidden="true"></span></th>
          <th scope="col" class="col-num" data-sort="trades" aria-sort="none" tabindex="0" role="button" onclick="sortAssetsDirectory('trades')" title="Sort by trade count (all time)">Trades <span class="sort-ind" aria-hidden="true"></span></th>
          <th scope="col" class="col-num" data-sort="members" aria-sort="none" tabindex="0" role="button" onclick="sortAssetsDirectory('members')" title="Sort by politician count (all time)">Politicians <span class="sort-ind" aria-hidden="true"></span></th>
        </tr></thead>
        <tbody id="assetsBody"><tr><td colspan="3" class="state">Loading directory…</td></tr></tbody>
      </table></div>
      <p class="note" id="assetsCount" style="display:none"></p>
    </div>
  </section>

  <!-- ================= REVIEW QUEUE ================= -->
  <section class="view" id="view-review" role="tabpanel" aria-labelledby="tab-review" aria-hidden="true">
    <div class="section">
      <h3>Document Review &amp; Model Comparison</h3>
      <p class="sub">Scanned / handwritten filings below the confidence threshold are held here until a human acts.&nbsp; Switch to <strong>Resolved Reviews</strong> to see what was published / rejected / modified.&nbsp; The <strong>All Filing Decisions</strong> table below includes auto-published filings too.&nbsp; If extraction is halted, the Admin tab shows a red badge.</p>
      <div style="display:flex;gap:6px;margin:8px 0">
        <button class="btn sm" id="revTabPending" onclick="setReviewTab(0)">Pending</button>
        <button class="btn ghost sm" id="revTabReviewed" onclick="setReviewTab(1)">Resolved Reviews</button>
      </div>
      <div class="review-table-wrap" id="reviewTableWrap" role="region" aria-label="Review queue table">
        <table>
          <thead><tr><th>Filed</th><th>Doc</th><th>Status</th><th>Reason</th><th>Payload</th><th></th></tr></thead>
          <tbody id="reviewBody"></tbody>
        </table>
      </div>
      <p class="note">Confirm promotes the read to the Trades tab; Manual lets you hand-key the rows (recorded as <code>source=manual</code>) when the automated read is wrong or too low-confidence; Reject discards it.&nbsp; Models / readings come from <code>extraction_runs</code> (populated by <code>POST /api/admin/bakeoff</code>).&nbsp; <code>POST /api/admin/review/:docId {decision}</code></p>
      <div style="margin-top:14px">
        <h3>All Filing Decisions</h3>
        <p class="sub">Append-only filing decisions, including clean auto-published filings that never entered the review queue.</p>
        <div class="review-table-wrap" id="decisionTableWrap" role="region" aria-label="Filing decisions history">
          <table>
            <thead><tr><th>Time</th><th>Doc</th><th>Action</th><th>Source</th><th>Reason</th><th>Rows</th></tr></thead>
            <tbody id="decisionBody"></tbody>
          </table>
        </div>
      </div>
    </div>
  </section>

  <!-- ================= DELIVERY (public education + account-owned management) ================= -->
  <section class="view" id="view-subs" role="tabpanel" aria-labelledby="tab-subs" aria-hidden="true">
    <div class="section" id="subsPush">
      <h3>Push Notifications</h3>
      <p class="sub">Phone push alerts are set in the iOS app: Off, one digest per new filing (name, position, and trade counts), or a ticker watchlist with a minimum amount and buys or sells.&nbsp; On the web, create a webhook or live stream below.</p>
      <div style="margin-top:12px;">
        <a href="/beta" class="btn sm" target="_blank" rel="noopener noreferrer" style="display:inline-flex;align-items:center;gap:6px;text-decoration:none;">
          <svg viewBox="0 0 170 170" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M150.37 130.25c-2.45 5.66-5.35 10.87-8.71 15.66-4.58 6.53-8.33 11.05-11.22 13.56-4.48 4.12-9.28 6.23-14.42 6.35-3.69 0-8.14-1.05-13.32-3.18-5.19-2.12-9.97-3.17-14.34-3.17-4.58 0-9.49 1.05-14.75 3.17-5.26 2.13-9.5 3.24-12.74 3.35-4.83.13-9.67-1.92-14.52-6.13-3.23-2.75-7.14-7.46-11.75-14.13-6.53-9.47-11.73-20.08-15.58-31.8-3.86-11.73-5.79-22.9-5.79-33.52 0-14.88 3.75-27.18 11.24-36.9 7.49-9.72 17.06-14.65 28.71-14.78 4.71 0 10.08 1.18 16.12 3.54 6.03 2.36 10.08 3.54 12.14 3.54 1.83 0 5.92-1.22 12.27-3.66 6.35-2.44 11.48-3.58 15.39-3.42 12.37.52 22.25 4.88 29.62 13.08-11.05 6.67-16.48 15.77-16.3 27.31.18 9.07 3.57 16.65 10.17 22.75 6.6 6.1 14.58 9.54 23.94 10.32-2.12 6.53-4.9 13.11-8.35 19.74zM119.22 31.78c0-7.07 2.53-13.67 7.59-19.8 5.06-6.13 11.46-9.75 19.2-10.86.36 1.44.54 2.76.54 3.96 0 7.07-2.61 13.79-7.83 20.16-5.22 6.37-11.66 9.87-19.32 10.51-.12-1.32-.18-2.65-.18-3.97z"/></svg>
          Get iOS Beta (TestFlight)
        </a>
      </div>
    </div>
    <!-- Public marketing/education: how the two paid delivery methods work.
         Visible to everyone, including signed-out visitors; creating a delivery
         requires a signed-in Premium account. -->
    <div class="section" id="subsMarketing">
      <h3>Alerts</h3>
      <p class="sub">We ingest official House, Senate, and Executive Branch trades.&nbsp; Relaying a 3rd-party competitor API would ruin our minutes-to-hours edge that Congress.Trade was made for.</p>
      <p class="sub" style="margin-top: 8px;">Get the Filing First.&nbsp; Premium pushes a filing to you the moment we ingest it &mdash; two methods, both included:</p>
      <div class="speed-mini" id="alertsSpeedMini"></div>
      <div class="delivery-grid">
        <div class="delivery-card">
          <h4>&rarr; Signed Webhooks &mdash; we call you</h4>
          <p>We POST one signed JSON request per transaction to your URL the instant it lands, retrying automatically on failure.&nbsp; A filing that discloses several trades sends several requests, each with its own <code>X-Tx-Id</code>.</p>
        </div>
        <div class="delivery-card">
          <h4>&#8674; Live Stream (SSE) &mdash; you stay on the line</h4>
          <p>One open HTTPS connection streams each new transaction as an event &mdash; a few lines of <code>EventSource</code>, no polling.</p>
        </div>
      </div>
      <p class="note">Every request is HMAC-SHA256 signed, and secrets are shown once at creation.&nbsp; Trends, trades, and analytics stay free.</p>
    </div>
    <div class="section" id="subsManage">
      <h3>Delivery</h3>
      <p class="sub" id="subsManageSub">Create signed webhook or SSE deliveries for your account.&nbsp; Secrets are shown once at creation; webhook consumers dedupe on <code>X-Subscription-Id</code> + <code>X-Tx-Id</code>.&nbsp; Pause stops events without removing the delivery; Delete removes it permanently.&nbsp; Edit filters anytime (Premium).</p>
      <div id="subsGate" class="note" role="status" aria-live="polite" style="margin:12px 0;padding:12px;border:1px solid var(--border, #ddd);border-radius:8px">
        Sign in with Google to manage Delivery. Creating a delivery also requires Premium.
      </div>
      <table id="subsTable">
        <thead><tr><th>Channel</th><th>Target</th><th>Filters</th><th>Progress</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody id="subsBody">
          <tr class="row"><td colspan="6" class="state">Sign in to see your deliveries.</td></tr>
        </tbody>
      </table>
      <div class="row-flex" id="subsCreateRow" style="margin-top:14px;flex-wrap:wrap">
        <label class="field-vh-label" for="newDelivery">Channel</label>
        <select id="newDelivery" disabled onchange="updateNewTargetVisibility()">
          <option value="sse">SSE</option><option value="webhook">webhook</option>
        </select>
        <label class="field-vh-label" for="newTarget">Target URL</label>
        <input id="newTarget" placeholder="target URL (webhook only)" style="flex:1 1 100%;min-width:0" disabled />
        <label class="field-vh-label" for="newTickers">Tickers</label>
        <input id="newTickers" placeholder="tickers (CSV, optional)" style="flex:1 1 100%;min-width:0" disabled />
        <label class="field-vh-label" for="newMembers">Members</label>
        <input id="newMembers" placeholder="members (names/ids, optional)" style="flex:1 1 100%;min-width:0" disabled title="Comma-separated member names or filer ids.  A name must match exactly one member." />
        <label class="field-vh-label" for="newChambers">Branches</label>
        <select id="newChambers" disabled>
          <option value="">House + Senate + Executive</option>
          <option value="house">House</option>
          <option value="senate">Senate</option>
          <option value="house,senate">House + Senate</option>
          <option value="executive">Executive</option>
        </select>
        <label class="field-vh-label" for="newSides">Trade side</label>
        <select id="newSides" disabled title="Trade side filter (B buy / S sell / E exchange)">
          <option value="">Buys + Sells + Exchanges</option>
          <option value="B">Buys</option>
          <option value="S">Sells</option>
          <option value="E">Exchanges</option>
          <option value="B,S">Buys + Sells</option>
        </select>
        <label class="minamt-label" style="display:flex;align-items:center;gap:6px">Minimum Trade Size:
          <select id="newMinAmt" disabled title="Minimum amount bracket floor">
            <option value="">Any</option>
            <option value="1001">$1k+</option>
            <option value="15001">$15k+</option>
            <option value="50001">$50k+</option>
            <option value="100001">$100k+</option>
            <option value="250001">$250k+</option>
            <option value="500001">$500k+</option>
            <option value="1000001">$1m+</option>
            <option value="5000001">$5m+</option>
            <option value="25000001">$25m+</option>
            <option value="50000001">$50m+</option>
          </select>
        </label>
        <button class="btn sm" id="subsCreateBtn" onclick="createSubscription()" disabled>Add New Delivery</button>
        <button class="btn ghost sm" id="subsEditCancel" type="button" hidden onclick="clearDeliveryForm(); if(el('newDelivery')) el('newDelivery').disabled=false; updateDeliveryGate();">Cancel edit</button>
        <div id="subsMsg" class="note subs-msg" aria-live="polite"></div>
      </div>
      <div class="row-flex" style="margin-top:20px;justify-content:center" data-premium-cue="alerts">
        <span class="gate-note">Premium unlocks Webhooks + SSE + Proprietary Enrichment Data + CSV &middot; $9/mo or $80/yr &middot; 1-week free trial
          <button class="btn sm" onclick="openPricing('alerts')">Start Free Trial</button></span>
      </div>
    </div>
${speedProofSectionHtml(false)}
  </section>

  <!-- ================= ADMIN · CADENCE ================= -->
  <section class="view" id="view-admin" role="tabpanel" aria-labelledby="tab-admin" aria-hidden="true">
${speedProofSectionHtml(true)}
    <div class="section">
      <h3>Admin Access</h3>
      <p class="sub">Admin tools (poll cadence, review queue, backfill) are available when you are signed in with an email that has admin access.&nbsp; Premium does not grant admin access.</p>
    </div>
    <div class="section">
      <h3>Admin Access Control</h3>
      <p class="sub">Grant or revoke admin access for a specific email.&nbsp; Premium never grants Admin or Review Queue by itself — only an email listed below, or one configured via <code>ADMIN_EMAILS</code> in the environment, can see them.</p>
      <div class="row-flex">
        <input id="adminGrantEmail" type="email" autocomplete="off" placeholder="name@example.com" style="flex:1;min-width:240px" />
        <button class="btn" onclick="grantAdminEmail()">Grant Admin</button>
        <span id="adminGrantMsg" class="note" role="status" aria-live="polite"></span>
      </div>
      <table style="margin-top:14px">
        <thead><tr><th>Email</th><th>Granted By</th><th>Granted At</th><th style="text-align:right">Action</th></tr></thead>
        <tbody id="adminListBody"><tr><td class="state" colspan="4">Loading…</td></tr></tbody>
      </table>
      <p class="note">API HOOK: <code>GET /api/admin/admins</code>, <code>POST /api/admin/admins/grant</code>, <code>POST /api/admin/admins/revoke</code>.&nbsp; <code>ADMIN_EMAILS</code> is configured in the environment — not editable here; it's the lockout escape hatch.</p>
    </div>
    <div class="section">
      <h3>Logos</h3>
      <p class="sub">Company-logo style shown on the live feed for <strong>all visitors</strong>. "Plain" shows bare logos; "Tile" frames them; "Off" hides them. When a logo is on but an asset symbol's image isn't available, a monogram (the symbol's first letters) is shown as a backup.</p>
      <div class="row-flex">
        <label class="lbl">Logo Style</label>
        <select id="adminLogo">
          <option value="transparent">Logos: Plain</option>
          <option value="tile">Logos: Tile</option>
          <option value="off">Logos: Off</option>
        </select>
        <button class="btn" onclick="saveLogoDisplay()">Save for Everyone</button>
        <span id="logoMsg" class="note"></span>
        <a class="btn ghost" href="/api/admin/logo-jury">Logo jury (A/B/C/D)</a>
      </div>
    </div>
    <div class="section">
      <h3>Poll Cadence</h3>
      <p class="sub">Filings land almost entirely during US-Eastern business hours on weekdays. Adaptive windows keep latency low when it matters and stay polite to gov servers overnight.</p>
      <div class="row-flex" style="margin-bottom:16px">
        <label class="switch"><input type="checkbox" id="aggToggle" onchange="toggleAggressive()"><span></span></label>
        <div><strong>Aggressive Mode</strong><div class="note" style="margin-top:2px">Drops business-hours interval for front-running edge vs higher-latency trackers.</div></div>
      </div>
      <div class="sched-row"><div class="lbl">Days (0=Sun…6=Sat)</div><div class="lbl">Start ET</div><div class="lbl">End ET</div><div class="lbl">Interval (s)</div></div>
      <div id="schedRows"></div>
      <div class="row-flex" style="margin-top:14px">
        <button class="btn" onclick="saveSchedule()">Save Cadence</button>
        <button class="btn ghost" onclick="loadPollConfig()">Reload</button>
        <span id="saveMsg" class="note"></span>
      </div>
      <p class="note">API HOOK: <code>GET/PUT /api/admin/poll-config</code>. The Worker cron fires every minute and consults this schedule via <code>shouldPollNow()</code> — so changes take effect within ~60s, no redeploy.</p>
    </div>
    <div class="section">
      <h3>Historic Backfill</h3>
      <p class="sub">Bulk-import pre-aggregated public datasets as <code>seed_dataset</code> rows to bootstrap back-history. Idempotent (safe to re-run); these rows are reference-only and never dispatched to subscribers.</p>
      <div class="row-flex">
        <label class="lbl">Since Year</label>
        <input id="bfSince" type="number" placeholder="e.g. 2020" style="width:120px" />
        <label class="lbl">Row Limit</label>
        <input id="bfLimit" type="number" placeholder="(none)" style="width:120px" />
        <select id="bfChambers">
          <option value="">Both Chambers</option><option value="house">House Only</option><option value="senate">Senate Only</option>
        </select>
        <button class="btn ghost sm" onclick="runBackfill(true)">Dry Run</button>
        <button class="btn" onclick="runBackfill(false)">Run Seed Backfill</button>
        <span id="bfMsg" class="note"></span>
      </div>
      <p class="note">API HOOK: <code>POST /api/admin/backfill</code>. Senate defaults to the GitHub mirror (works out of the box). The House community bucket is gated (HTTP 403) — set <code>SEED_HOUSE_URL</code>, or use the official House index backfill below.</p>
      <div class="row-flex" style="margin-top:14px">
        <label class="lbl">House History (Official Index)</label>
        <input id="hiFrom" type="number" placeholder="from year" style="width:120px" />
        <input id="hiTo" type="number" placeholder="to year" style="width:120px" />
        <input id="hiMax" type="number" min="1" max="5000" value="500" title="Maximum filings to enqueue in this run" style="width:120px" />
        <button class="btn ghost sm" onclick="runHouseIndex(true)">Dry Run</button>
        <button class="btn" onclick="runHouseIndex(false)">Backfill House Index</button>
        <span id="hiMsg" class="note"></span>
      </div>
      <p class="note">API HOOK: <code>POST /api/admin/house-backfill</code>. Pulls past-year House bulk ZIPs (official, always reachable) and runs each PTR through the live pipeline — high-fidelity, but heavier than the seed import. Dry Run only counts; Backfill is capped by Max filings.</p>
      <div class="row-flex" style="margin-top:14px">
        <label class="lbl">Executive Branch (OGE) Backfill</label>
        <button class="btn" onclick="runOgeBackfill()">Run OGE Backfill</button>
        <span id="ogeMsg" class="note"></span>
      </div>
      <p class="note">API HOOK: <code>POST /api/admin/oge-backfill</code>. Force-polls the OGE President and Vice President Index and enqueues any new or missing 278-T filings for previous and current executives.</p>
    </div>
    <div class="section">
      <h3>Review Queue Maintenance</h3>
      <p class="sub">Manually trigger the background reprocess routine for items in the review queue. This is normally handled by the cron auto-publish, but can be forced here.</p>
      <div class="row-flex">
        <select id="reprocChamber">
          <option value="house">House</option>
          <option value="senate">Senate</option>
        </select>
        <input id="reprocLimit" type="number" min="1" max="2000" value="500" title="Maximum filings to reprocess" style="width:120px" />
        <button class="btn" onclick="runQueueReprocess()">Reprocess Queue</button>
        <span id="reprocMsg" class="note"></span>
      </div>
      <p class="note">API HOOK: <code>POST /api/admin/reprocess</code>.</p>
    </div>
    <div class="section">
      <h3>Model Benchmarking</h3>
      <p class="sub">Run measured tests against saved filings. Every run is saved by branch with resolved ground-truth coverage, measured usage-based cost coverage, and latency.</p>
      <div class="benchmark-toolbar" role="tablist" aria-label="Benchmark branch">
        <button class="btn sm" id="btnBenchHouse" role="tab" aria-selected="true" onclick="selectBenchmarkChamber('house')" aria-label="House benchmark"><span aria-hidden="true">House</span></button>
        <button class="btn ghost sm" id="btnBenchSenate" role="tab" aria-selected="false" onclick="selectBenchmarkChamber('senate')" aria-label="Senate benchmark"><span aria-hidden="true">Senate</span></button>
        <button class="btn ghost sm" id="btnBenchExec" role="tab" aria-selected="false" onclick="selectBenchmarkChamber('executive')" aria-label="Executive branch benchmark"><span aria-hidden="true">Executive</span></button>
        <label class="lbl" for="benchmarkHistory">Saved run</label>
        <select id="benchmarkHistory" onchange="loadBenchmarkRun(this.value)" aria-label="Saved benchmark run"><option value="">No saved runs</option></select>
        <button class="btn ghost sm" onclick="loadBenchmarkHistory()">Reload</button>
        <button class="btn ghost sm" id="btnClearBenchmarkHistory" onclick="clearBenchmarkHistory()">Clear History</button>
        <button class="btn sm" id="btnRunBenchmark" onclick="runChamberBenchmark()">Run House benchmark</button>
        <button class="btn ghost sm" id="btnRunAllBenchmarks" onclick="runAllBenchmarks()">Run all 3 branches</button>
        <button class="btn ghost sm" id="btnCancelBenchmark" onclick="cancelBenchmarkRun()" hidden>Stop and keep partial results</button>
      </div>
      <details id="benchmarkModelSelection" style="margin-top: 10px; margin-bottom: 10px; font-size: 13px;">
        <summary style="cursor: pointer; font-weight: 600;">Custom Model Selection (for new runs)</summary>
        <div id="benchmarkModelCheckboxes" style="padding: 10px; border: 1px solid var(--border); border-radius: 4px; margin-top: 5px; display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 5px;">
          <!-- Populated by JS -->
        </div>
      </details>
      <div id="benchmarkSettingsSummary" class="note">Loading saved House model slots…</div>
      <div id="benchmarkModelSlots"></div>
      <div id="benchmarkMsg" class="note" role="status" aria-live="polite"></div>
      <div id="benchmarkResults" aria-live="polite"><div class="state">Loading saved House benchmarks…</div></div>
    </div>
    <div class="section">
      <h3>Source Health</h3>
      <p class="sub">First-seen timestamps are logged per filing so real refresh cadence is measured, not assumed.</p>
      <div class="row-flex" style="margin-bottom:10px">
        <button class="btn ghost sm" onclick="resetLatencyMetrics()">Reset Latency</button>
        <span id="latencyResetMsg" class="note"></span>
      </div>
      <table>
        <thead><tr><th>Source</th><th>Status</th><th>Last Check</th><th>Last New Filing</th><th title="Watcher checks recorded in ingest_log, not filing count.">Checks</th><th title="Discovered filings summed from ingest_log.new_count.">New Filings</th><th title="Average seconds between the most recent 50 watcher checks for this source.">Avg Refresh (Observed)</th><th title="When we first saw the filing → when we wrote its parsed rows. Precise (both are our timestamps). Reset Latency starts this average from the reset timestamp forward.">Seen→Imported</th></tr></thead>
        <tbody id="healthBody"></tbody>
      </table>
      <div id="sourceTimelineSection" style="margin-top:20px;padding-top:16px;border-top:1px solid var(--border)">
        <h4 style="margin-bottom:6px;font-size:14px;font-weight:600">Source Ingestion & Error Timeline (Past 24 Hours)</h4>
        <p class="sub" style="margin-bottom:14px">Live timeline graphic and numbers tracking poll attempts, error rates, and failure frequencies by source site.</p>
        <div id="sourceStatsGrid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin-bottom:16px"></div>
        <div id="sourceTimelineGraphic" style="margin-bottom:16px;background:var(--bg-card);padding:14px;border:1px solid var(--border);border-radius:6px"></div>
        <div id="sourceRecentErrors"></div>
      </div>
    </div>
    <div class="section">
      <h3>Instrument Pricing</h3>
      <p class="sub">Capability boundary for exact-time (minute-level) prints.&nbsp; Equities (long) and crypto use Socratic.Trade 1-minute bars.&nbsp; Options and Kalshi event contracts are not priced from equity bars.&nbsp; Committee assignments stay cross-referenced to GICS sectors on Trends conflicts.</p>
      <div id="instrumentPricingCaps" aria-live="polite"></div>
      <h4 style="margin:14px 0 8px">Exact-time lookup</h4>
      <div class="row-flex">
        <label class="lbl" for="ipTicker">Ticker</label>
        <input id="ipTicker" type="text" maxlength="8" placeholder="AAPL" style="width:100px" title="Equity or crypto ticker" />
        <label class="lbl" for="ipAt">At (UTC)</label>
        <input id="ipAt" type="text" placeholder="2026-08-16T15:00:00.000Z" style="width:220px" title="ISO-8601 instant" />
        <label class="me-check" title="Marks this lookup as an options contract rather than a plain equity."><input id="ipOption" type="checkbox" /> Option</label>
        <button class="btn" type="button" onclick="lookupExactPrice()">Look up</button>
        <button class="btn ghost sm" type="button" onclick="loadInstrumentPricing()">Reload</button>
        <span id="ipLookupMsg" class="note"></span>
      </div>
      <div id="ipLookupResult" class="note" style="margin-top:8px"></div>
    </div>
    <div class="section">
      <h3>Market Data Coverage</h3>
      <p class="sub">Ticker enrichment coverage for company name, sector, country, and market-cap fields. This is the data behind company drawers, Sector, Country, and Market Cap columns.</p>
      <div class="row-flex">
        <label class="lbl">Max Rows</label>
        <input id="mdMax" type="number" min="1" max="200" value="40" style="width:90px" title="Maximum ticker rows to process in this run" />
        <label class="lbl">Max Calls / Min</label>
        <input id="mdPerMin" type="number" min="1" max="1000" value="250" style="width:100px" title="API throttle limit" />
        <button class="btn ghost sm" onclick="runMarketBackfill(true)">Dry Run</button>
        <button class="btn" onclick="runMarketBackfill(false)">Run One Pass</button>
        <button class="btn ghost sm" onclick="loadMarketCoverage()">Reload</button>
        <span id="mdMsg" class="note"></span>
      </div>
      <div id="marketCoverage" aria-live="polite"></div>
    </div>
    <div class="section">
      <h3>Connection Status</h3>
      <p class="sub">Provider and integration status from production data. Secret values are never shown.</p>
      <div class="row-flex" style="margin-bottom:10px">
        <button class="btn ghost sm" onclick="refreshInfisicalSecrets()">Refresh Runtime Secrets</button>
        <span id="secretRefreshMsg" class="note"></span>
      </div>
      <div id="diagConnections" class="diag-grid" aria-live="polite"></div>
      <h3 style="margin-top:14px">Settings / Runtime Secrets</h3>
      <table>
        <thead><tr><th>Category</th><th>Key</th><th>Source</th><th style="text-align:right">Action</th></tr></thead>
        <tbody id="diagSettings"></tbody>
      </table>
      <h3 style="margin-top:14px">Recent App Errors</h3>
      <table>
        <thead><tr><th>When</th><th>Area</th><th>Subject</th><th>Message</th></tr></thead>
        <tbody id="diagErrors"></tbody>
      </table>
      <h3 style="margin-top:14px">Users &amp; Recent Logins</h3>
      <div id="diagUsers" class="diag-grid" aria-live="polite"></div>
      <table>
        <thead><tr><th>Last Login</th><th>Email</th><th>Name</th><th>Plan</th></tr></thead>
        <tbody id="diagLogins"></tbody>
      </table>
      <h3 style="margin-top:14px">Premium Members</h3>
      <p class="sub">Everyone currently on Premium.&nbsp; Trial and Paid are listed separately.&nbsp; Stripe and Apple show as the billing source, with Sandbox or Production.</p>
      <div id="diagPremiumCards" class="diag-grid" aria-live="polite"></div>
      <table>
        <thead><tr><th>Email</th><th>Plan</th><th>Billing</th><th>Source</th><th>Environment</th><th>Period End</th><th>Stripe</th></tr></thead>
        <tbody id="diagPremiumRoster"></tbody>
      </table>
    </div>
    <div class="section">
      <h3>LLM Spend &amp; Extraction Metrics (30 Days)</h3>
      <p class="sub">Past 30-day extraction method breakdown (deterministic vs paid LLMs, average/P90/highest cost per doc), per-model spend, and live LlamaParse credit balances. API HOOK: GET /api/admin/llm-spend-report</p>
      <h4 style="margin:12px 0 8px">30-Day Document Extraction Summary</h4>
      <div id="extraction30dGrid" class="diag-grid" aria-live="polite"></div>
      <div class="row-flex" style="margin-top:16px;margin-bottom:10px">
        <button class="btn ghost sm on" id="llmSpendPeriodWeek" onclick="setLlmSpendPeriod('week')">Past 7 Days</button>
        <button class="btn ghost sm" id="llmSpendPeriodMonth" onclick="setLlmSpendPeriod('month')">Past 30 Days</button>
        <button class="btn ghost sm" onclick="loadLlmSpendPanel(true)">Refresh Credits</button>
        <span id="llmSpendMsg" class="note"></span>
      </div>
      <h4 style="margin:0 0 8px">LlamaParse Free Credits (live, per account)</h4>
      <div id="llamaParseCreditsGrid" class="diag-grid" aria-live="polite"></div>
      <h4 style="margin:18px 0 8px">Spend By Model <span id="llmSpendRangeLabel" class="note"></span></h4>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Provider</th><th>Model</th><th>Docs</th><th>Calls</th><th>Total Cost</th></tr></thead>
          <tbody id="llmSpendByModelTable"></tbody>
        </table>
      </div>
    </div>
  </section>

  <footer class="site-footer">
    <a href="https://simplewithus.com" target="_blank" rel="noopener noreferrer">
      <img src="/assets/simple-with-us.webp" alt="Simple With Us - Jay Wedgeworth" style="height: 18px; margin-bottom: 6px; opacity: 0.9;" />
    </a>
    <span>Congress.Trade  ·  educational tool for public STOCK Act (2012) disclosures  ·  not financial advice  ·  $ estimated from brackets  ·  independent/private service not affiliated with or endorsed/sponsored by any government agency</span>
    <span class="footer-links">
      <a href="/privacy-policy">Privacy</a>
      <a href="/terms-of-service">Terms</a>
      <a href="/pricing">Pricing</a>
      <a href="/beta" target="_blank" rel="noopener noreferrer">iOS Beta</a>
      <a href="/api/feed.xml" rel="alternate" type="application/rss+xml">RSS</a>
      <a href="mailto:support@congress.trade">Support</a>
      <a href="#" onclick="if(window.openSentryFeedback){window.openSentryFeedback();}else if(window.Sentry&amp;&amp;window.Sentry.getFeedback){try{window.Sentry.getFeedback().createForm().then(function(f){f.appendToDom();f.open();});}catch(e){}}return false;">Report a Problem</a>
    </span>
    <a class="swu-attribution" href="https://simplewithus.com/" aria-label="From Simple With Us"><span>From</span><img src="/swu-logo-wide.webp" alt="Simple With Us by Jay Wedgeworth" width="288" height="30"></a>
  </footer>
</main>

<div class="drawer" id="detailDrawer">
  <div class="drawer-backdrop" onclick="closeDrawer()"></div>
  <div class="drawer-panel" role="dialog" aria-modal="true" aria-labelledby="drawerTopbarTitle"><div class="drawer-topbar"><span class="drawer-topbar-title" id="drawerTopbarTitle" aria-hidden="true"></span><button class="drawer-close" onclick="closeDrawer()" aria-label="Close">✕</button></div><div id="detailDrawerBody"></div></div>
</div>

<!-- ================= LOGIN MODAL ================= -->
<div class="overlay" id="loginOverlay" onclick="if(event.target===this)closeLogin()">
  <div class="modal" role="dialog" aria-modal="true" aria-label="Sign In">
    <button class="close" onclick="closeLogin()" aria-label="Close">×</button>
    <h2>Sign In to Congress.Trade</h2>
    <p class="sub">Sign in to manage your account and use Premium research tools.</p>
    <div class="auth-btn-stack">
      <button class="auth-btn gbtn" id="googleSignInBtn" onclick="loginGoogle()">
        <svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.7 2.4 30.2 0 24 0 14.6 0 6.5 5.4 2.5 13.2l7.9 6.1C12.3 13.2 17.6 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.5 3-2.2 5.5-4.7 7.2l7.3 5.7c4.3-3.9 6.8-9.7 6.8-17.4z"/><path fill="#FBBC05" d="M10.4 28.7c-.5-1.5-.8-3-.8-4.7s.3-3.2.8-4.7l-7.9-6.1C.9 16.5 0 20.1 0 24s.9 7.5 2.5 10.8l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.3-5.7c-2 1.4-4.6 2.3-8.6 2.3-6.4 0-11.7-3.7-13.6-9.8l-7.9 6.1C6.5 42.6 14.6 48 24 48z"/></svg>
        Sign in with Google
      </button>
      <a class="auth-btn abtn" id="appleSignInBtn" href="/auth/apple/start" style="display:none">
        <svg viewBox="0 0 170 170" width="20" height="20" fill="currentColor" aria-hidden="true">
          <path d="M150.37 130.25c-2.45 5.66-5.35 10.87-8.71 15.66-4.58 6.53-8.33 11.05-11.22 13.56-4.48 4.12-9.28 6.23-14.42 6.35-3.69 0-8.14-1.05-13.32-3.18-5.19-2.12-9.97-3.17-14.34-3.17-4.58 0-9.49 1.05-14.75 3.17-5.26 2.13-9.5 3.24-12.74 3.35-4.83.13-9.67-1.92-14.52-6.13-3.23-2.75-7.14-7.46-11.75-14.13-6.53-9.47-11.73-20.08-15.58-31.8-3.86-11.73-5.79-22.9-5.79-33.52 0-14.88 3.75-27.18 11.24-36.9 7.49-9.72 17.06-14.65 28.71-14.78 4.71 0 10.08 1.18 16.12 3.54 6.03 2.36 10.08 3.54 12.14 3.54 1.83 0 5.92-1.22 12.27-3.66 6.35-2.44 11.48-3.58 15.39-3.42 12.37.52 22.25 4.88 29.62 13.08-11.05 6.67-16.48 15.77-16.3 27.31.18 9.07 3.57 16.65 10.17 22.75 6.6 6.1 14.58 9.54 23.94 10.32-2.12 6.53-4.9 13.11-8.35 19.74zM119.22 31.78c0-7.07 2.53-13.67 7.59-19.8 5.06-6.13 11.46-9.75 19.2-10.86.36 1.44.54 2.76.54 3.96 0 7.07-2.61 13.79-7.83 20.16-5.22 6.37-11.66 9.87-19.32 10.51-.12-1.32-.18-2.65-.18-3.97z"/>
        </svg>
        Sign in with Apple
      </a>
      <a class="auth-btn xbtn" id="xSignInBtn" href="/auth/x/start" onclick="loginX()" style="display:none">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
          <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
        </svg>
        Sign in with X
      </a>
    </div>
    <p class="note" id="loginMsg"></p>
  </div>
</div>

<!-- ================= PRICING MODAL ================= -->
<div class="overlay" id="pricingOverlay" onclick="if(event.target===this)closePricing()">
  <div class="modal" role="dialog" aria-modal="true" aria-label="Premium">
    <button class="close" onclick="closePricing()" aria-label="Close">×</button>
    <h2 id="pricingTitle">Premium</h2>
    <p class="sub" id="pricingSub">The public dashboard stays free. Premium gets you the filing the moment we see it.</p>
    <p class="note" id="pricingProof" style="text-align:center"></p>
    <ul class="feature-list" id="pricingFeatures">
      <li>Instant filing alerts — signed webhooks (HMAC-verified) to any URL</li>
      <li>Live SSE stream of every new filing — no polling</li>
      <li>Mobile push notifications and full database CSV exports</li>
      <li>Direct access to source PDF files from Congress</li>
      <li style="opacity:0.8; font-size:0.9em; margin-top:0.5rem">Note: Users can add up to 2 delivery methods (webhooks or SSE streams).</li>
    </ul>

    <div class="plan-grid" id="pricingPlans" role="radiogroup" aria-label="Plan">
      <label class="plan sel" id="planMonthly" for="planMonthlyRadio">
        <input type="radio" class="plan-radio-input" id="planMonthlyRadio" name="plan" value="monthly" checked onchange="selectPlan('monthly')">
        <div class="cad">Monthly</div>
        <div class="price">$9<span class="per">/mo</span></div>
      </label>
      <label class="plan" id="planAnnual" for="planAnnualRadio">
        <input type="radio" class="plan-radio-input" id="planAnnualRadio" name="plan" value="annual" onchange="selectPlan('annual')">
        <span class="save">SAVE ~25%</span>
        <div class="cad">Annual</div>
        <div class="price">$80<span class="per">/yr</span></div>
      </label>
    </div>
    <p class="trial-note" id="pricingTrialNote">1-week free trial. No charge today.</p>
    <p class="note" id="pricingPremiumNote" style="text-align:center" hidden></p>
    <button class="btn" style="width:100%;padding:11px" id="subscribeBtn" onclick="startCheckout()">Start Free Trial</button>
    <p class="note" id="pricingMsg"></p>
  </div>
</div>

<div class="toast" id="toast" role="status" aria-live="polite" aria-atomic="true"></div>

<script>
/* ============================ STATE ============================ */
var TRADES = [];          // live transactions (newest first)
var TRADE_BY_ID = {};     // trade id -> row, including mini-list rows cached from drawers
var REVIEW = [];          // review-queue items
var REVIEW_TOTALS = null; // aggregate queue counts returned with the current page
var DECISIONS = [];       // ingestion decision audit rows
var REVIEW_RUNS = {};     // docId -> full extraction runs loaded on demand
var REVIEW_CONSENSUS = {}; // docId -> { rows, summary } | null, loaded alongside REVIEW_RUNS
var REVIEW_CONSENSUS_STATUS = {}; // docId -> coherent run-set provenance/failure status
var SCHEDULE = [];        // PollWindow[]
var aggressive = false;
var cursor = 0;           // max cursor_seq seen
var totalRows = 0;        // server-reported total matching rows (for "X of N")
var filingsImportedToday = 0;
var tradesPage = 0;         // zero-based page in newest-first snapshot mode
var tradesPageSize = Number(localStorage.getItem('feed-page-size') || 50);
var loadingPage = false;  // guards against overlapping page fetches
var tradesRequestSeq = 0;
var tradesAbort = null;
var tradesSearchTimer = null;
var realDataLoaded = false;
var tradesGated = false;     // server says this visitor sees the limited free window
/* Trades source mode — owner follow-up batch #2: the "Primary Only" / "All
   Data" toggle and its disclaimer note were removed (dedup is the only
   sensible view). tradesSourceMode() is kept so existing fetch call sites
   stay untouched, but it now always returns the de-duplicated default. */
function tradesSourceMode() {
  return 'primary';
}
var es = null;            // EventSource handle
var pollTimer = null;     // setInterval handle for the polling fallback
var POLL_INTERVAL_MS = 30000;  // graceful polling cadence when SSE is unavailable
// /api/stream?subscription=dashboard is not served on the public site yet
// (webhooks/SSE are a future paid feature) — probing it is a guaranteed 404
// on every anonymous load (issue #1457 console noise). Flip this to true
// once a public stream ships; startStream() re-checks it every call.
var PUBLIC_STREAM_ENABLED = false;
var sortKey = 'txdate'; // active feed sort column
var sortDir = -1;         // 1 = ascending, -1 = descending (default: newest first)
var NUMERIC_SORT = { min: 1, conf: 1, refMarketCap: 1 };   // columns compared numerically

/* ============================ HELPERS ============================ */
var fmt = function (n) { return n == null ? '—' : '$' + Number(n).toLocaleString(); };
/* Display-only integer grouping (22,293). Storage/API stay bare numbers. */
function fmtCount(n) {
  if (n == null || n === '') return '—';
  var v = Number(n);
  if (!Number.isFinite(v)) return String(n);
  return Math.round(v).toLocaleString('en-US');
}
/* Ordinal suffix for district numbers: 1→st, 2→nd, 3→rd, 11→th, 21→st, … */
function ordinalSuffix(n) {
  var v = Math.abs(Math.floor(Number(n))) % 100;
  if (v >= 11 && v <= 13) return 'th';
  switch (v % 10) {
    case 1: return 'st';
    case 2: return 'nd';
    case 3: return 'rd';
    default: return 'th';
  }
}
/* Plain-text district ordinal for titles/search ("17th"). Non-numeric left as-is. */
function fmtDistrictOrdinal(raw) {
  if (raw == null || raw === '') return '';
  var s = String(raw).trim();
  if (!s) return '';
  var m = s.match(/^(\\d+)(?:st|nd|rd|th)?$/i);
  if (!m) return s;
  var n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return s;
  return Math.floor(n) + ordinalSuffix(n);
}
/* HTML district ordinal with superscript suffix: 17<sup>th</sup>. Escapes the digits. */
function fmtDistrictOrdinalHtml(raw) {
  if (raw == null || raw === '') return '';
  var s = String(raw).trim();
  if (!s) return '';
  var m = s.match(/^(\\d+)(?:st|nd|rd|th)?$/i);
  if (!m) return esc(s);
  var n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return esc(s);
  return esc(String(Math.floor(n))) + '<sup class="ord">' + ordinalSuffix(n) + '</sup>';
}
function fmtBracketAmount(n) {
  if (n == null) return '—';
  n = Number(n);
  if (!Number.isFinite(n)) return '—';
  var abs = Math.abs(n), sign = n < 0 ? '-' : '';
  function clean(v) { return String(v).replace(/\\.0$/, ''); }
  // Trillion+ always shows 2 decimal places ("$3.62t") so a mega-cap market
  // cap never falls back to a 4+ digit billions number ("$3622b") the way
  // the plain 1e9 branch below would render it.
  if (abs >= 1e12) return sign + '$' + (abs / 1e12).toFixed(2) + 't';
  if (abs >= 1e9) return sign + '$' + clean((abs / 1e9).toFixed(abs >= 10e9 ? 0 : 1)).toLowerCase() + 'b';
  if (abs >= 1e6) return sign + '$' + clean((abs / 1e6).toFixed(abs >= 10e6 ? 0 : 1)).toLowerCase() + 'm';
  if (abs >= 1e3) return sign + '$' + clean((abs / 1e3).toFixed(abs >= 10e3 ? 0 : 1)).toLowerCase() + 'k';
  return sign + '$' + Math.round(abs);
}
var confClass = function (c) { return c >= 0.9 ? 'hi' : c >= 0.7 ? 'mid' : 'lo'; };
/* Product labels: Buy / Sell / Exchange. Storage/API codes stay P|S|E (B accepted as buy alias on input). */
var typeName = { B: 'Buy', P: 'Buy', S: 'Sell', E: 'Exchange' };
/* Capitalize a beneficial-owner code for display (self -> Self, joint -> Joint). */
function ownerLabel(o) { var s = String(o == null ? '' : o); return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }
function ownerBadgeHtml(o) {
  var text = ownerLabel(o);
  return text
    ? '<span class="owner-badge muted" title="Beneficial owner reported on the filing">' + esc(text) + '</span>'
    : '';
}
/* Format a politician name so a generational suffix sits after a single comma
   with no space on its left, e.g. "Sonny Perdue Jr" -> "Sonny Perdue, Jr". */
var NAME_SUFFIX = { 'jr': 'Jr', 'jr.': 'Jr', 'sr': 'Sr', 'sr.': 'Sr', 'ii': 'II', 'iii': 'III', 'iv': 'IV' };
function fmtName(raw) {
  var s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  if (s.toUpperCase().startsWith('MANUAL-')) {
    s = s.substring(7);
    if (s === s.toUpperCase()) {
      s = s.split(' ').map(function(w) { return w.charAt(0) + w.slice(1).toLowerCase(); }).join(' ');
    }
  }
  s = s.replace(/\\s*\\(\\s*Senator\\s*\\)\\s*/gi, ' ');
  s = s.replace(/\\s*\\(\\s*\\)\\s*/g, ' ');
  while (s.indexOf('  ') >= 0) s = s.split('  ').join(' ');
  s = s.split(' , ').join(', ');

  // Clean academic/medical titles safely without mangling
  s = s.replace(/(?:,\\s*)?\\b(?:DR|HON|MR|MRS|MS|REP|SEN|MD|FACS|PH\\.?D\\.?)\\b(?:,\\s*)?/gi, ' ');
  while (s.indexOf('  ') >= 0) s = s.split('  ').join(' ');
  s = s.replace(/[,\\s.]+$/, '');

  // Flip "Last, First" to "First Last"
  if (s.indexOf(',') >= 0) {
    var splitParts = s.split(',');
    if (splitParts.length === 2) {
      // Don't flip when the part after the comma is a generational suffix
      // (e.g. "David A Perdue, Jr" is NOT "Last, First" format).
      if (!NAME_SUFFIX[splitParts[1].trim().toLowerCase()]) {
        s = splitParts[1].trim() + ' ' + splitParts[0].trim();
      }
    }
  }

  var parts = s.split(' ');
  var suf = NAME_SUFFIX[parts[parts.length - 1].toLowerCase()];
  if (!suf) return s;
  var head = parts.slice(0, -1).join(' ');
  while (head.charAt(head.length - 1) === ',' || head.charAt(head.length - 1) === ' ') head = head.slice(0, -1);
  return head ? head + ', ' + suf : suf;
}

/* Format a company name for display, converting ALL CAPS to Title Case
   and normalizing common suffixes (INC, LLC, ETF, etc). */
function fmtCompany(raw) {
  var s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  s = s.replace(/\\s*\\([^)]+\\)\\s*$/g, '').trim();
  if (s === s.toUpperCase() || s === s.toLowerCase()) {
    // Title-case each run of letters independently so internal punctuation is
    // preserved: "S&P" stays "S&P" rather than collapsing to "S&p".
    s = s.replace(/[A-Za-z]+/g, function(txt) {
      return txt.charAt(0).toUpperCase() + txt.slice(1).toLowerCase();
    });
  }
  if (s.includes('Amazon') || s.includes('AMAZON')) {
    s = s.replace(/\\bAmazon\\s+Com\\s+Inc\\.?\\b/gi, 'Amazon.com, Inc.');
    s = s.replace(/\\bAmazon\\.com\\s+Inc\\.?\\b/gi, 'Amazon.com, Inc.');
  }
  if (s.includes('Meta') || s.includes('META')) {
    s = s.replace(/\\bMeta\\s+Platforms\\s+Inc\\.?\\b/gi, 'Meta Platforms, Inc.');
  }
  s = s.replace(/\\b(Llc|Etf|Lp|Plc|Us|Usa|Sa|Ag|Nv|Bv)\\b/gi, function(match) {
    return match.toUpperCase();
  });
  s = s.replace(/\\b(Inc|Corp|Ltd|Co)\\b/gi, function(match) {
    var c = match.toLowerCase();
    if (c === 'inc') return 'Inc.';
    if (c === 'corp') return 'Corp.';
    if (c === 'ltd') return 'Ltd.';
    if (c === 'co') return 'Co.';
    return match.charAt(0).toUpperCase() + match.slice(1).toLowerCase();
  });
  // Standard title case: articles/prepositions stay lowercase only when they
  // are interior. Never lowercase the first or last word — the trailing token
  // is usually a share class ("Alphabet Inc. Class A"), not an article.
  s = s.replace(/\\b(And|Of|The|In|For|A|An|To|On)\\b/gi, function(match, _g1, offset, whole) {
    if (offset === 0) return match;
    if (offset + match.length >= whole.length) return match;
    return match.toLowerCase();
  });
  // deduplicate periods
  s = s.replace(/\\.{2,}/g, '.');
  s = s.charAt(0).toUpperCase() + s.slice(1);
  // Brands whose real casing a generic title-caser cannot infer. Frequently
  // traded names only — this is a display nicety, not a normalization source.
  for (var bi = 0; bi < COMPANY_BRAND_CASING.length; bi++) {
    s = s.replace(COMPANY_BRAND_CASING[bi][0], COMPANY_BRAND_CASING[bi][1]);
  }
  return s;
}
var COMPANY_BRAND_CASING = [
  [/\\bAt&t\\b/gi, 'AT&T'],
  [/\\bJpmorgan\\b/gi, 'JPMorgan'],
  [/\\bIshares\\b/gi, 'iShares'],
  [/\\bSpdr\\b/gi, 'SPDR'],
  [/\\bEbay\\b/gi, 'eBay'],
  [/\\bPaypal\\b/gi, 'PayPal'],
  [/\\bYoutube\\b/gi, 'YouTube'],
  [/\\bTsmc\\b/gi, 'TSMC'],
  [/\\bIbm\\b/gi, 'IBM'],
  [/\\bAmd\\b/gi, 'AMD'],
  [/\\bNvidia\\b/gi, 'NVIDIA'],
  [/\\b3m\\b/gi, '3M'],
];
/* "House"/"Senate" are proper nouns here — always capitalize the chamber.
   NOTE: the 'Exec' branch word is a LAST resort for a row with no filer id to
   resolve. Never render it in front of a real position — use
   memberBranchLabel()/memberBranchBits() below, which return the title alone. */
function chamberLabel(c) {
  var s = String(c == null ? '' : c).trim().toLowerCase();
  if (s === 'house' || s === 'h') return 'House';
  if (s === 'senate' || s === 's') return 'Senate';
  if (s === 'executive' || s === 'oge' || s === 'exec') return 'Exec';
  return c ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}
/* ---- Executive-branch positions ----------------------------------------
   Server-injected from shared/executiveTitles.ts executiveTitleForms(), the
   same way BENCHMARK_CATALOG is injected, so the web copy of the title list
   cannot drift from the one delivery/rest.ts and client/utils.ts serve.

   Owner 2026-08-11: "ensure executive branch individuals have their shortest
   professionally formatted title shown like 'Treasury Secretary' or 'Treasury
   Sec.' if not room for whole thing and don't say 'exec -' before that at
   least when displaying them." So an executive filer renders its POSITION and
   nothing else: no 'Exec' branch word in front of it, and no state/district
   (they hold an office, not a seat). EXEC_TITLE_FALLBACK stands alone for an
   uncurated filer — it is never a prefix. */
var EXEC_TITLE_FORMS = ${JSON.stringify(executiveTitleForms())};
var EXEC_TITLES = EXEC_TITLE_FORMS.titles;
var EXEC_TITLES_SHORT = EXEC_TITLE_FORMS.short;
var EXEC_TITLE_FALLBACK = EXEC_TITLE_FORMS.fallback;
/* Character budgets by surface, so each caller states its room in one place.
   FULL fits the longest curated title ('Social Security Commissioner', 28). */
var EXEC_TITLE_FULL = 28;
var EXEC_TITLE_TIGHT = 16;
function isExecutiveFiler(chamber, filerId) {
  var s = String(chamber == null ? '' : chamber).trim().toLowerCase();
  if (s === 'executive' || s === 'oge' || s === 'exec' || s.indexOf('exec') !== -1) return true;
  return String(filerId == null ? '' : filerId).indexOf('EXEC-') === 0;
}
/* Mirror of shared/executiveTitles.ts executiveTitleFor(). */
function execTitleFor(filerId) {
  var id = String(filerId == null ? '' : filerId).trim();
  if (!id || id.indexOf('EXEC-') !== 0) return null;
  return EXEC_TITLES[id] || EXEC_TITLE_FALLBACK;
}
/* Mirror of shared/executiveTitles.ts fitExecutiveTitle(): longest form that
   fits. Falls back to the complete short form rather than a chopped string —
   a real title the layout may ellipsize beats one this code cut in half. */
function execTitleFit(title, maxChars) {
  var t = String(title == null ? '' : title).trim();
  if (!t) return '';
  var budget = Number(maxChars);
  if (!isFinite(budget) || budget <= 0 || t.length <= budget) return t;
  return EXEC_TITLES_SHORT[t] || t;
}
/* Position label for an executive filer. "curated" is the server-supplied
   title field when the payload carries one (roster / member drawer); the id
   map covers the payloads that don't. */
function execDisplayTitle(filerId, curated, maxChars) {
  var t = String(curated == null ? '' : curated).trim() || execTitleFor(filerId) || EXEC_TITLE_FALLBACK;
  return execTitleFit(t, maxChars == null ? EXEC_TITLE_FULL : maxChars);
}
/* The branch/seat descriptor bits for ANY filer row, in render order.
   Executive filers get exactly one bit — their position. Congressional filers
   keep "House"/"Senate" plus, when a state is supplied, the state (and
   district when present). Callers escape the strings they use. */
function memberBranchBits(o, maxTitleChars) {
  var r = o || {};
  if (isExecutiveFiler(r.chamber, r.filerId)) {
    return [execDisplayTitle(r.filerId, r.title, maxTitleChars)];
  }
  var bits = [];
  var chLabel = chamberLabel(r.chamber);
  if (chLabel) bits.push(chLabel);
  if (r.state) bits.push(String(r.state) + (r.district ? ' - ' + fmtDistrictOrdinal(r.district) : ''));
  return bits;
}
/* Single-bit variant for rows that only have room for one word. */
function memberBranchLabel(o, maxTitleChars) {
  var r = o || {};
  if (isExecutiveFiler(r.chamber, r.filerId)) return execDisplayTitle(r.filerId, r.title, maxTitleChars);
  return chamberLabel(r.chamber);
}
/* Spell out a US state/territory from its 2-letter code for the politician drawer. */
var US_STATES = { AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', DC: 'District of Columbia', PR: 'Puerto Rico', GU: 'Guam', VI: 'U.S. Virgin Islands', AS: 'American Samoa', MP: 'Northern Mariana Islands' };
function stateName(abbr) {
  var s = String(abbr == null ? '' : abbr).trim().toUpperCase();
  return US_STATES[s] || (abbr || '');
}
/* Title-case an instrument/asset class but keep common acronyms upper (ETF, REIT…). */
var ASSET_CLASS_UP = { etf: 'ETF', reit: 'REIT', adr: 'ADR', etn: 'ETN', spac: 'SPAC' };
function assetClassLabel(c) {
  var s = String(c == null ? '' : c).trim();
  if (!s) return '';
  return ASSET_CLASS_UP[s.toLowerCase()] || (s.charAt(0).toUpperCase() + s.slice(1));
}
/* Friendlier labels for raw STOCK Act asset-type codes / Senate eFD labels. */
var HOUSE_REVIEW_ASSET_TYPES = [
  ['4K', '401K and Other Non-Federal Retirement Accounts', 'Retirement / 529 Accounts'],
  ['5C', '529 College Savings Plan', 'Retirement / 529 Accounts'],
  ['5F', '529 Portfolio', 'Retirement / 529 Accounts'],
  ['5P', '529 Prepaid Tuition Plan', 'Retirement / 529 Accounts'],
  ['AB', 'Asset-Backed Securities', 'Asset-Backed Securities'],
  ['BA', 'Bank Accounts, Money Market Accounts and CDs', 'Cash / Bank Accounts'],
  ['BK', 'Brokerage Accounts', 'Cash / Bank Accounts'],
  ['CO', 'Collectibles', 'Commodities / Collectibles'],
  ['CS', 'Corporate Securities (Bonds and Notes)', 'Corporate Debt'],
  ['CT', 'Cryptocurrency', 'Crypto'],
  ['DB', 'Defined Benefit Pension', 'Retirement / 529 Accounts'],
  ['DO', 'Debts Owed to the Filer', 'Receivables'],
  ['DS', 'Delaware Statutory Trust', 'Trusts'],
  ['EF', 'Exchange Traded Funds (ETF)', 'Funds / ETFs / REITs'],
  ['EQ', 'Excepted/Qualified Blind Trust', 'Trusts'],
  ['ET', 'Exchange Traded Notes', 'Funds / ETFs / REITs'],
  ['FA', 'Farms', 'Commodities / Collectibles'],
  ['FE', 'Foreign Exchange Position (Currency)', 'Derivatives / Rights'],
  ['FN', 'Fixed Annuity', 'Insurance / Annuities'],
  ['FU', 'Futures', 'Derivatives / Rights'],
  ['GS', 'Government Securities and Agency Debt', 'Government / Municipal Debt'],
  ['HE', 'Hedge Funds & Private Equity Funds (EIF)', 'Private Funds'],
  ['HN', 'Hedge Funds & Private Equity Funds (non-EIF)', 'Private Funds'],
  ['IC', 'Investment Club', 'Business Interests'],
  ['IH', 'IRA (Held in Cash)', 'Retirement / 529 Accounts'],
  ['IP', 'Intellectual Property & Royalties', 'Intellectual Property'],
  ['IR', 'IRA', 'Retirement / 529 Accounts'],
  ['MA', 'Managed Accounts (e.g., SMA and UMA)', 'Funds / ETFs / REITs'],
  ['MF', 'Mutual Funds', 'Funds / ETFs / REITs'],
  ['MO', 'Mineral/Oil/Solar Energy Rights', 'Commodities / Collectibles'],
  ['OI', 'Ownership Interest (Holding Investments)', 'Business Interests'],
  ['OL', 'Ownership Interest (Engaged in a Trade or Business)', 'Business Interests'],
  ['OP', 'Options', 'Options'],
  ['OT', 'Other', 'Other'],
  ['PE', 'Pensions', 'Retirement / 529 Accounts'],
  ['PM', 'Precious Metals', 'Commodities / Collectibles'],
  ['PS', 'Stock (Not Publicly Traded)', 'Private Equity'],
  ['RE', 'Real Estate Invest. Trust (REIT)', 'Real Estate'],
  ['RF', 'REIT (EIF)', 'Real Estate'],
  ['RN', 'REIT (non-EIF)', 'Real Estate'],
  ['RP', 'Real Property', 'Real Estate'],
  ['RS', 'Restricted Stock Units (RSUs)', 'Derivatives / Rights'],
  ['SA', 'Stock Appreciation Right', 'Derivatives / Rights'],
  ['ST', 'Stocks (including ADRs)', 'Public Equity'],
  ['TR', 'Trust', 'Trusts'],
  ['VA', 'Variable Annuity', 'Insurance / Annuities'],
  ['VI', 'Variable Insurance', 'Insurance / Annuities'],
  ['WU', 'Whole/Universal Insurance', 'Insurance / Annuities']
];
var SENATE_REVIEW_ASSET_TYPES = [
  ['Stock', 'Stock', 'Public Equity'],
  ['Stock Option', 'Stock Option', 'Options'],
  ['Municipal Security', 'Municipal Security', 'Government / Municipal Debt'],
  ['Corporate Bond', 'Corporate Bond', 'Corporate Debt'],
  ['Other Securities', 'Other Securities', 'Other Securities'],
  ['Non-Public Stock', 'Non-Public Stock', 'Private Equity']
];
var REVIEW_UNKNOWN_ASSET_TYPES = [['Unknown', 'Unclassified', 'Unknown']];
var REVIEW_ASSET_TYPES = HOUSE_REVIEW_ASSET_TYPES.concat(SENATE_REVIEW_ASSET_TYPES).concat(REVIEW_UNKNOWN_ASSET_TYPES);
var ASSET_TYPE_LABEL = {};
var ASSET_TYPE_CATEGORY_LABEL = {};
REVIEW_ASSET_TYPES.forEach(function (pair) {
  ASSET_TYPE_LABEL[pair[0]] = pair[1];
  ASSET_TYPE_LABEL[String(pair[0]).toUpperCase()] = pair[1];
  ASSET_TYPE_CATEGORY_LABEL[pair[0]] = pair[2];
  ASSET_TYPE_CATEGORY_LABEL[String(pair[0]).toUpperCase()] = pair[2];
});
function assetTypeLabel(t) {
  var s = String(t == null ? '' : t).trim();
  if (!s) return 'Unclassified';
  return ASSET_TYPE_LABEL[s] || ASSET_TYPE_LABEL[s.toUpperCase()] || s;
}
function reviewAssetTypeName(t) {
  var s = String(t == null ? '' : t).trim();
  if (!s || s.toLowerCase() === 'unknown') return '';
  return ASSET_TYPE_LABEL[s] || ASSET_TYPE_LABEL[s.toUpperCase()] || '';
}
function reviewNormalizeAssetTypeValue(t) {
  var s = String(t == null ? '' : t).trim();
  if (!s) return '';
  var upper = s.toUpperCase();
  for (var i = 0; i < HOUSE_REVIEW_ASSET_TYPES.length; i++) {
    if (HOUSE_REVIEW_ASSET_TYPES[i][0] === upper) return upper;
  }
  var lower = s.toLowerCase();
  for (var j = 0; j < SENATE_REVIEW_ASSET_TYPES.length; j++) {
    if (String(SENATE_REVIEW_ASSET_TYPES[j][0]).toLowerCase() === lower) return SENATE_REVIEW_ASSET_TYPES[j][0];
  }
  if (lower === 'unknown' || lower === 'unclassified') return 'Unknown';
  return s;
}
function reviewAssetTypeCategoryLabel(t) {
  var s = String(t == null ? '' : t).trim();
  if (!s) return '';
  return ASSET_TYPE_CATEGORY_LABEL[s] || ASSET_TYPE_CATEGORY_LABEL[s.toUpperCase()] || '';
}
function reviewAssetPairsForChamber(chamber) {
  var c = String(chamber == null ? '' : chamber).toLowerCase();
  if (c === 'house') return HOUSE_REVIEW_ASSET_TYPES.concat(REVIEW_UNKNOWN_ASSET_TYPES);
  if (c === 'senate') return SENATE_REVIEW_ASSET_TYPES.concat(REVIEW_UNKNOWN_ASSET_TYPES);
  var seen = {};
  return REVIEW_ASSET_TYPES.filter(function (pair) {
    var key = String(pair[0]).toLowerCase();
    if (seen[key]) return false;
    seen[key] = true;
    return true;
  });
}
function reviewAssetTypeDatalistId(chamber) {
  var c = String(chamber == null ? '' : chamber).toLowerCase();
  return c === 'house' ? 'review-asset-types-house' : c === 'senate' ? 'review-asset-types-senate' : 'review-asset-types-all';
}
function ensureReviewAssetTypeDatalists() {
  if (document.getElementById('review-asset-types-all')) return;
  ['house', 'senate', 'all'].forEach(function (chamber) {
    var dl = document.createElement('datalist');
    dl.id = reviewAssetTypeDatalistId(chamber);
    // Put the human label in option *text* (not only the label= attr). Browsers
    // filter datalist suggestions on visible text; with only value="ST" and a
    // label= attribute, typing "Stock" often shows no match even though House
    // PTRs mark public equity as [ST] / "Stocks (including ADRs)".
    dl.innerHTML = reviewAssetPairsForChamber(chamber).map(function (pair) {
      var code = String(pair[0] || '');
      var name = String(pair[1] || '');
      var category = String(pair[2] || '');
      var text = code === name
        ? name + (category ? ' — ' + category : '')
        : code + ' — ' + name + (category ? ' (' + category + ')' : '');
      return '<option value="' + esc(code) + '">' + esc(text) + '</option>';
    }).join('');
    document.body.appendChild(dl);
  });
}
function assetTypeCode(row) {
  var direct = String(row && row.assetType || '').trim().toUpperCase();
  if (direct && ASSET_TYPE_LABEL[direct]) return direct;
  var m = /\\[([A-Z0-9]{2,3})\\]/.exec(String(row && row.rawText || ''));
  return m ? m[1].toUpperCase() : '';
}
function assetTypeDetailHtml(row) {
  var code = assetTypeCode(row);
  var explicitName = cleanNoteValue(row && row.assetTypeName);
  var label = explicitName || assetTypeLabel(code || (row && row.assetType));
  if (row && row.isOption && (!code || code === 'OP')) {
    label = label && label !== 'Unclassified' ? label : 'Options';
    code = code || 'OP';
  }
  if (!code && (!label || label === 'Unclassified')) return '<span class="muted">Unclassified</span>';
  return esc(label) + (code ? ' <span class="muted">[' + esc(code) + ']</span>' : '');
}
/* Normalize a date string to YYYY-MM-DD without timezone drift. Accepts ISO
   ("2026-06-15...") and US ("6/15/2026") forms (Senate filings use the latter). */
function toISODate(s) {
  if (!s) return '';
  s = String(s).trim();
  var iso = /^(\\d{4})-(\\d{2})-(\\d{2})/.exec(s);
  if (iso) return iso[1] + '-' + iso[2] + '-' + iso[3];
  var us = /^(\\d{1,2})\\/(\\d{1,2})\\/(\\d{4})/.exec(s);
  if (us) return us[3] + '-' + ('0' + us[1]).slice(-2) + '-' + ('0' + us[2]).slice(-2);
  return s.slice(0, 10);
}
var MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function dateText(s) {
  var iso = toISODate(s);
  var m = /^(\\d{4})-(\\d{2})-(\\d{2})/.exec(iso);
  if (!m) return s ? String(s) : '—';
  var mon = MONTH_ABBR[Number(m[2]) - 1];
  return mon ? mon + ' ' + Number(m[3]) + ', ' + m[1] : String(s || '—');
}
function compactDateText(s) {
  var iso = toISODate(s);
  var m = /^(\\d{4})-(\\d{2})-(\\d{2})/.exec(iso);
  if (!m) return s ? String(s) : '—';
  return Number(m[2]) + '-' + Number(m[3]) + '-' + m[1].slice(2);
}
function timeText(s) {
  if (!s) return '';
  var str = String(s).trim();
  if (!/(?:T|\\s|\\d{2}:)/.test(str)) return '';
  var dt = new Date(str);
  if (isNaN(dt.getTime())) {
    var t = /(?:T|\\s)(\\d{2}):(\\d{2})/.exec(str);
    if (!t) return '';
    var h0 = Number(t[1]);
    var ampm0 = h0 >= 12 ? 'pm' : 'am';
    h0 = h0 % 12 || 12;
    return h0 + (t[2] === '00' ? '' : ':' + t[2]) + ampm0;
  }
  var h = dt.getHours();
  var m = dt.getMinutes();
  var ampm = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  var minStr = m < 10 ? '0' + m : String(m);
  return h + (minStr === '00' ? '' : ':' + minStr) + ampm;
}
function dateTimeText(s) {
  if (!s) return '—';
  var base = dateText(s);
  var time = timeText(s);
  return time ? base + ' · ' + time : base;
}
function dateCellHtml(s, title) {
  if (!s) return '<span class="muted">Unavailable</span>';
  var attr = ' title="' + esc(title || dateText(s)) + '"';
  return '<span' + attr + '><span class="date-full">' + esc(dateText(s)) + '</span><span class="date-short">' + esc(compactDateText(s)) + '</span></span>';
}
function dateTimeCellHtml(s, title) {
  if (!s) return '<span class="muted">Unavailable</span>';
  var attr = ' title="' + esc(title || dateTimeText(s)) + '"';
  var t = timeText(s);
  var timeLine = t ? '<span class="date-sub">' + esc(t) + '</span>' : '';
  return '<span class="date-time-cell"' + attr + '>' +
    '<span class="date-full"><span class="date-main">' + esc(dateText(s)) + '</span>' + timeLine + '</span>' +
    '<span class="date-short"><span class="date-main">' + esc(compactDateText(s)) + '</span>' + timeLine + '</span>' +
  '</span>';
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
  });
}
/* SEOSOCIAL-02: crawlable deep-link href for an entity cell — a real
   "/?member=…"/"/?ticker=…" URL, not just a data-* attribute a JS click
   handler reads. Callers still render data-member/data-asset for the
   existing delegated click handling (handleEntityOpenEvent), which already
   preventDefault()s before opening the drawer, so navigation never fires. */
function entityHref(param, value) {
  return '/?' + param + '=' + encodeURIComponent(value);
}
/* SEOSOCIAL-04: server-side OgMeta only covers the FIRST paint's <title> —
   this keeps it honest through client-side navigation (tab switches, drawer
   opens) that never re-request the document. Mirrors resolveOgMeta's
   pageTitle convention (ogMeta.ts): every non-default label gets a
   " — Congress.Trade" suffix; the bare default is just the site name. */
function setDocumentTitle(label) {
  try { document.title = label ? (label + ' — Congress.Trade') : 'Congress.Trade'; } catch (e) {}
}
/* Mirrors resolveOgMeta's trades/people/subs titles (ogMeta.ts) — kept in
   sync by ogMeta.test.ts's SEOSOCIAL-04 cases. Review/Admin are gated
   internal tools, not public entities, so they're left off (falls back to
   whatever title was already showing). */
var TAB_PAGE_TITLES = { trends: 'Trends', trades: 'Trades', people: 'Directory', subs: 'Delivery' };
function el(id) { return document.getElementById(id); }
function clipTextHtml(value, fallback, title) {
  var text = String(value == null || value === '' ? (fallback || '—') : value);
  var cls = text === '—' ? 'clip-text muted' : 'clip-text';
  return '<span class="' + cls + '" title="' + esc(title || text) + '">' + esc(text) + '</span>';
}
/* Concise plain-English cleaning notes (incomplete sentences, no forced
   capitals). Mirrors app/src/shared/cleaningNote.ts so the table stays readable
   even if an older API payload still carries a technical string. */
function plainCleaningNote(raw) {
  var s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  if (s === 'Populated official company name from securities_ref' || s === 'asset name derived from ticker') {
    return 'asset name derived from ticker';
  }
  if (/^Cleaned OCR dot leader noise/i.test(s)) return 'cleaned OCR noise from asset name';
  if (/^Stripped OCR dot leader suffix/i.test(s)) return 'removed OCR noise from asset name';
  if (/^Cleaned junk OCR text/i.test(s)) return 'removed junk OCR from asset name';
  if (s === 'cleaned OCR noise from asset name' || s === 'removed OCR noise from asset name' ||
      s === 'removed junk OCR from asset name') return s;
  return s;
}

/* Strip stray HTML/entities some upstream datasets embed in asset descriptions
   (e.g. "<div class=text-muted><em>Rate/Coupon:</em> 3.875%<br>…</div>"). */
function isJunkAssetString(s) {
  if (!s) return true;
  var str = String(s).trim();
  if (!str) return true;
  var lower = str.toLowerCase();
  if (
    lower.indexOf('unparsed historical filing') >= 0 ||
    lower.indexOf('this filing was disclosed via scanned pdf') >= 0 ||
    lower.indexOf('use link in ptr_link column to view the pdf') >= 0 ||
    lower.indexOf('pdf disclosed filing') >= 0
  ) {
    return true;
  }
  var stripped = str.replace(/[\\.\\s\\-\\_\\:\\;\\,\\?\\!]/g, '');
  if (stripped.length === 0) return true;
  if (/[\\.\\_\\-]{2,}/.test(str) && stripped.length <= 2) return true;
  return false;
}
function isScannedPdfPlaceholder(s) {
  return isJunkAssetString(s);
}
function cleanAsset(s) {
  if (s == null) return '';
  var t = String(s).replace(/<[^>]*>/g, ' ');
  t = t.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
       .replace(/&gt;/gi, '>').replace(/&#0*39;|&apos;/gi, "'").replace(/&quot;/gi, '"');
  t = t.replace(/\\s+/g, ' ').trim();

  if (isJunkAssetString(t)) return '';

  t = t.replace(/[\\/\\-\\s]+$/, '');
  t = t.replace(/\\s*\\(\\s*(?:NASDAQ|NYSE|AMEX|OTC|BATS|ARCA|ASX|LSE|TSX)[^)]*\\)\\s*$/i, '');

  if (t === t.toUpperCase() && /[A-Z]{4,}/.test(t)) {
    t = t.toLowerCase().replace(/\\b\\w/g, function(l) { return l.toUpperCase(); });
  }

  t = t.replace(/\\b(Inc|Corp|Ltd|Co)\\b\\.?/gi, function(match) {
    var c = match.toLowerCase();
    if (c.startsWith('inc')) return 'Inc.';
    if (c.startsWith('corp')) return 'Corp.';
    if (c.startsWith('ltd')) return 'Ltd.';
    if (c.startsWith('co')) return 'Co.';
    return match;
  });
  t = t.replace(/\\b(LLC|L\\.L\\.C\\.|L\\.P\\.|LP)\\b\\.?/gi, function(match) {
    var c = match.toLowerCase().replace(/\\./g, '');
    if (c === 'llc') return 'LLC';
    if (c === 'lp') return 'LP';
    return match;
  });
  t = t.replace(/\\s*,\\s*(Inc\\.|LLC|Corp\\.|Ltd\\.|LP|Co\\.)/g, ' $1');

  return t;
}

/* Human duration: 45s, 3m 12s, 2h 5m, 1d 4h. */
function fmtDuration(sec) {
  if (sec == null) return '—';
  sec = Math.round(sec);
  if (sec < 60) return sec + 's';
  var m = Math.floor(sec / 60), s = sec % 60;
  if (m < 60) return m + 'm ' + s + 's';
  var h = Math.floor(m / 60); m = m % 60;
  if (h < 24) return h + 'h ' + m + 'm';
  var d = Math.floor(h / 24); h = h % 24;
  return d + 'd ' + h + 'h';
}

/* Human latency from milliseconds: 850ms, 4s, 2m 30s, 1h 5m. */
function fmtMs(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return ms + 'ms';
  return fmtDuration(Math.round(ms / 1000));
}

/* ---- light / dark / system theme (per-visitor preference; default LIGHT) ---- */
/* Mirrors Socratic.Trade console: Light | Dark | System segmented control. */
function readThemePref() {
  try {
    var s = localStorage.getItem('ui-theme');
    if (s === 'sepia') {
      /* Sepia was removed (owner 2026-08-21) — migrate a returning visitor's
         stored Sepia preference to Light so it stops failing validation on
         every load. */
      try { localStorage.setItem('ui-theme', 'light'); } catch (e2) {}
      return 'light';
    }
    if (s === 'light' || s === 'dark' || s === 'system') return s;
  } catch (e) {}
  return 'light';
}
function resolveTheme(pref) {
  if (pref === 'dark' || pref === 'light') return pref;
  try {
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
  } catch (e) {}
  return 'light';
}
function themeIconSvg(kind) {
  /* Inline 13px lucide-style icons: sun / moon / monitor */
  if (kind === 'dark') {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>';
  }
  if (kind === 'system') {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/></svg>';
  }
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>';
}
function themeSegHtml(pref) {
  pref = pref || readThemePref();
  var opts = [
    { id: 'light', label: 'Light' },
    { id: 'dark', label: 'Dark' },
    { id: 'system', label: 'System' }
  ];
  var btns = opts.map(function (o) {
    var active = pref === o.id ? ' active' : '';
    return '<button type="button" class="theme-seg-btn' + active + '" data-theme-opt="' + o.id + '" aria-label="Set theme to ' + o.label + '" title="' + o.label + '" aria-pressed="' + (pref === o.id ? 'true' : 'false') + '">' +
      themeIconSvg(o.id) + o.label + '</button>';
  }).join('');
  return '<div class="theme-seg" role="group" aria-label="Theme">' + btns + '</div>';
}
function themeRowHtml(pref, hideLabel) {
  // Owner punch list #2 (hamburger popover): the Light/Dark/System control
  // stands alone there — no "Theme" caption. The desktop menu-pop dropdown
  // keeps the label (unchanged), so hideLabel is opt-in per call site.
  return '<div class="theme-row">' + (hideLabel ? '' : '<span class="theme-row-label">Theme</span>') + themeSegHtml(pref) + '</div>';
}
function currentLogoTheme() {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}
function tickerLogoSrc(sym) {
  return '/api/logos/ticker?symbol=' + encodeURIComponent(sym) + '&theme=' + currentLogoTheme();
}
function syncTickerLogoThemes(theme) {
  document.querySelectorAll('.tkr-logo img[src*="/api/logos/ticker"]').forEach(function (img) {
    var raw = img.getAttribute('src');
    if (!raw) return;
    try {
      var u = new URL(raw, location.origin);
      if (u.searchParams.get('theme') === theme) return;
      u.searchParams.set('theme', theme);
      img.setAttribute('src', u.pathname + u.search);
    } catch (e) {}
  });
}
function applyTheme(effective) {
  var theme = effective === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', theme);
  var logo = document.getElementById('brandLogo');
  if (logo) {
    var next = theme === 'dark' ? logo.getAttribute('data-src-dark') : logo.getAttribute('data-src-light');
    if (next && logo.getAttribute('src') !== next) logo.setAttribute('src', next);
  }
  syncTickerLogoThemes(theme);
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'dark' ? '#08111f' : '#eff3f8');
  syncThemeSegUI();
}
function syncThemeSegUI() {
  var pref = readThemePref();
  document.querySelectorAll('.theme-seg-btn[data-theme-opt]').forEach(function (btn) {
    var on = btn.getAttribute('data-theme-opt') === pref;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}
function setThemePref(pref) {
  if (pref !== 'light' && pref !== 'dark' && pref !== 'system') pref = 'light';
  try {
    localStorage.setItem('ui-theme', pref);
  } catch (e) {}
  document.documentElement.setAttribute('data-theme-pref', pref);
  applyTheme(resolveTheme(pref));
}
/* Keep applyTheme(t) usable for callers that pass effective light|dark. */
function toggleTheme() {
  /* legacy: cycle light → dark → system → light */
  var pref = readThemePref();
  var next = pref === 'light' ? 'dark' : pref === 'dark' ? 'system' : 'light';
  setThemePref(next);
}
(function bindSystemThemeListener() {
  try {
    if (!window.matchMedia) return;
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    var onChange = function () {
      if (readThemePref() === 'system') applyTheme(resolveTheme('system'));
    };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
  } catch (e) {}
})();
document.addEventListener('click', function (e) {
  var t = e.target;
  var btn = t && t.closest ? t.closest('.theme-seg-btn[data-theme-opt]') : null;
  if (!btn) return;
  var pref = btn.getAttribute('data-theme-opt');
  if (pref) setThemePref(pref);
});

/* ---- ticker logos (ported from socratictrade.com) ---- */
/* logoDisplay is a SITE-WIDE setting the admin controls; the value is injected
   server-side as window.__LOGO_DISPLAY__ so every visitor gets the same style. */
var LOGO_DISPLAYS = ['tile', 'transparent', 'off'];
var SYMBOL_PATTERN = /^[A-Z0-9._-]{1,20}$/;
function normalizeLogoDisplay(v) { return LOGO_DISPLAYS.indexOf(v) >= 0 ? v : 'transparent'; }
var logoDisplay = normalizeLogoDisplay(window.__LOGO_DISPLAY__);
function normalizeLogoSymbol(v) {
  var s = (v == null ? '' : String(v)).trim().replace(/^\\$/, '').toUpperCase();
  return s && SYMBOL_PATTERN.test(s) ? s : null;
}
/* Backup logo: when a real logo image 404s, swap the frame to a monogram of the
   ticker's first letters instead of dropping it (CSS hides the <img>). */
function logoFallback(img, mono) {
  var span = img.parentNode; if (!span) return;
  span.classList.add('mono');
  span.setAttribute('data-mono', mono);
}
/* Build the logo <span><img></span>. Framing follows the site-wide display mode;
   the company name rides along as a hover title; a missing logo falls back to a
   monogram via logoFallback(). */
/* A few well-known tickers get a crisp glyph instead of a fetched image so they
   look right on both dark and light themes (the Apple  glyph scales with text). */
var CUSTOM_GLYPH = { AAPL: '' };
function tickerLogoHtml(ticker, company) {
  var sym = normalizeLogoSymbol(ticker);
  if (!sym || logoDisplay === 'off') return '';
  var title = company ? ' title="' + esc(company) + '"' : '';
  if (CUSTOM_GLYPH[sym]) {
    return '<span class="tkr-logo glyph ' + logoDisplay + '"' + title + '>' + CUSTOM_GLYPH[sym] + '</span>';
  }
  var mono = esc(sym.slice(0, 2));
  return '<span class="tkr-logo ' + logoDisplay + '"' + title + '>' +
    '<img src="' + tickerLogoSrc(sym) + '" alt="" ' +
    'loading="lazy" decoding="async" ' +
    // Empty 200 PNGs (cached blank provider bodies) never fire onerror — treat
    // zero naturalWidth as a miss so monogram fallback still runs.
    'onload="if(!this.naturalWidth)logoFallback(this,\\'' + mono + '\\')" ' +
    'onerror="logoFallback(this,\\'' + mono + '\\')" />' +
  '</span>';
}
/* Two-letter initials from a politician name, for the avatar fallback. */
function initials(name) {
  var parts = String(name || '').trim().split(' ').filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2);
  return parts[0].charAt(0) + parts[parts.length - 1].charAt(0);
}
/* Build the politician avatar: an initials chip with the headshot overlaid when a
   photoUrl is present. A broken/missing image removes itself (this.remove()),
   revealing the initials underneath — mirrors the ticker-logo onerror pattern.
   Unlike the ticker logo (decorative next to a visible ticker string), this
   photo is sometimes the ONLY identifier on screen (e.g. the cluster-card face
   strip has no adjacent name text), so by default it gets a real alt with the
   politician's name rather than alt="".
   WEBA11Y P2 (mobile trade cards, tradesCardHtml()): most call sites DO have
   an adjacent name — memberAvatarHtml() is immediately followed by a sibling
   name element. When the whole thing sits inside one accessible-name-bearing
   container (a role="button" row/card/link with no aria-label of its own),
   the avatar's own text — fallback initials, plus the <img alt> when a photo
   loaded — gets concatenated into that name RIGHT ALONGSIDE the sibling name
   text, so AT users hear e.g. "JS John Smith John Smith" once for the
   initials/alt and again for the visible name. Pass decorative=true from any
   call site that already has its own adjacent, visible name text so the
   avatar contributes nothing to the accessible name and the name reads once. */
function partyBucketClass(raw) {
  var s = String(raw || '').trim();
  if (!s) return '';
  if (/^d/i.test(s) || /^dem/i.test(s)) return 'D';
  if (/^r/i.test(s) || /^rep/i.test(s)) return 'R';
  return 'O';
}
function memberAvatarHtml(name, photoUrl, party, decorative) {
  var altText = decorative ? '' : esc(name || '');
  var img = photoUrl
    ? '<img src="' + esc(photoUrl) + '" alt="' + altText + '" loading="lazy" decoding="async" onerror="this.remove()" />'
    : '';
  var bucket = partyBucketClass(party);
  var ring = bucket ? ' party-' + bucket : '';
  var hidden = decorative ? ' aria-hidden="true"' : '';
  return '<span class="avatar' + ring + '"' + hidden + '>' + esc(initials(name)) + img + '</span>';
}
function setBanner(text, isErr) {
  var nodes = document.querySelectorAll('#banner, .feed-banner');
  for (var i = 0; i < nodes.length; i++) {
    var b = nodes[i];
    if (!text) {
      b.hidden = true;
      b.textContent = '';
      b.style.display = 'none';
      b.className = 'banner feed-banner';
      continue;
    }
    b.hidden = false;
    b.style.display = 'block';
    b.className = 'banner feed-banner' + (isErr ? ' err' : '');
    b.textContent = text;
  }
}
function stateRow(cols, text) {
  return '<tr><td class="state" colspan="' + cols + '">' + esc(text) + '</td></tr>';
}
function stateCards(text) {
  return '<div class="trades-card state">' + esc(text) + '</div>';
}
/* Skeleton-shimmer loading placeholders (shape-matched, no layout shift). */
function skCards(n) {
  var out = ''; for (var i = 0; i < (n || 6); i++)
    out += '<div class="card"><div class="sk sk-line" style="width:55%"></div><div class="sk sk-line" style="height:20px;width:70%"></div></div>';
  return out;
}
function skRows(cols, n) {
  var out = ''; for (var i = 0; i < (n || 5); i++)
    out += '<tr><td colspan="' + cols + '"><div class="sk sk-line"></div></td></tr>';
  return out;
}
function skBars(n) {
  var out = ''; for (var i = 0; i < (n || 4); i++)
    out += '<div class="hbar"><div class="hlabel"><div class="sk sk-line" style="width:80px;margin:0"></div></div>' +
      '<div class="htrack"><div class="sk" style="height:14px;width:' + (40 + (i * 13) % 50) + '%"></div></div></div>';
  return out;
}
function skChart() {
  var bars = ''; for (var i = 0; i < 24; i++) {
    var h = 30 + ((i * 37) % 70);
    bars += '<div class="tcol"><div class="tbars"><i class="sk" style="display:block;width:7px;height:' + h + '%"></i></div></div>';
  }
  return '<div class="tchart">' + bars + '</div>';
}

/* Admin surfaces (Review Queue / Developer Delivery / Admin · Cadence) call
   /api/admin/* which returns 401 on the public site. Detect that cleanly and
   show a friendly notice instead of a scary "HTTP 401". */
var ADMIN_MOVED_MSG = 'Admin tools have moved to admin.congress.trade (sign-in required).';
/* Throw a tagged error when a response is an auth failure so callers can
   distinguish it from generic network/HTTP errors. */
function okOrThrow(r) {
  if (r.status === 401 || r.status === 403) { var e = new Error(ADMIN_MOVED_MSG); e.isAuth = true; throw e; }
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
function isAuthError(e) { return !!(e && e.isAuth); }

/* ============================ TRADES ============================ */
/* Column registry — single source of truth for the header, body cells, sorting,
   and the column chooser. def:true columns are visible by default; lock:true
   columns can't be hidden. Each cell(r) returns the inner HTML for that td. */
/* Feed cells are NOT nested entity links — the whole row opens trade details.
   Politician / company navigation lives in the trade drawer (owner UX: no
   magic "click here for X, there for Y" on the list surface). */
function memberCellHtml(r) {
  var nameClass = (r.member || '').length > 28 ? 'fit-xs' : (r.member || '').length > 22 ? 'fit-sm' : '';
  return '<div class="member-cell">' + memberAvatarHtml(r.member, r.photoUrl, r.party || r.partyBucket, true) +
    '<div class="' + nameClass + '" title="' + esc(r.member) + '">' + esc(fmtName(r.member)) + (r.st ? '<span class="muted">  |  ' + esc(r.st) + '</span>' : '') + '</div>' +
    ownerBadgeHtml(r.owner) + '</div>';
}
/* Owner punch list #16: a minority of filings report the bare, unhelpful
   placeholder "Securities" with no further detail (e.g. Max Miller's private
   holdings). When the row already carries a parsed asset type — never an
   extra fetch, never invented — swap in that friendlier label instead. */
function assetNameFallback(nm, row) {
  if (!nm || String(nm).trim().toLowerCase() !== 'securities') return nm;
  var code = assetTypeCode(row);
  var explicitName = cleanNoteValue(row && row.assetTypeName);
  var categoryLabel = code ? reviewAssetTypeCategoryLabel(code) : '';
  var fallback = explicitName || categoryLabel || (code ? assetTypeLabel(code) : '');
  return fallback || nm;
}
function assetCellHtml(r) {
  // Prefer a real company name when the reported asset text is missing or is just
  // the ticker again (e.g. "FB" with no name) — uses the enriched ref company name.
  var nm = r.asset;
  if (isJunkAssetString(nm)) nm = '';
  if ((!nm || nm === r.ticker) && r.refCompanyName) nm = r.refCompanyName;
  nm = fmtCompany(nm);
  nm = assetNameFallback(nm, r);
  if (!r.ticker && !nm) {
    return '<div class="asset-cell"><span class="muted">—</span></div>';
  }
  var inner = '<div title="' + esc((r.ticker ? r.ticker + '  |  ' : '') + (nm || '')) + '">' +
    (r.ticker ? '<span class="tkr">' + esc(r.ticker) + '</span><span class="tkr-gap"></span>' : '') +
    '<span class="muted">' + esc(nm || '') + '</span></div>';
  // No data-asset on the feed cell — whole row opens the trade; company lives in the drawer.
  return r.ticker
    ? '<div class="asset-cell">' + tickerLogoHtml(r.ticker, nm) + inner + '</div>'
    : '<div class="asset-cell">' + inner + '</div>';
}
function amountTier(min, max) {
  if (min == null && max == null) return null;
  var basis = max == null ? Number(min) : Number(max);
  if (!Number.isFinite(basis)) return null;
  if (basis <= 1000) return { tier: 1, label: 'Up to $1k', title: 'Trade size bracket: up to $1k' };
  if (basis <= 15000) return { tier: 2, label: 'Up to $15k', title: 'Trade size bracket: up to $15k' };
  if (basis <= 50000) return { tier: 3, label: '$15k-$50k', title: 'Trade size bracket: $15k-$50k' };
  if (basis <= 250000) return { tier: 4, label: '$50k-$250k', title: 'Trade size bracket: $50k-$250k' };
  if (basis <= 1000000) return { tier: 5, label: '$250k-$1M', title: 'Trade size bracket: $250k-$1M' };
  return { tier: 6, label: 'Over $1M', title: 'Trade size bracket: over $1M' };
}
function amountBarsHtml(tier) {
  var bars = '';
  // Six visual bars so the $0–$1k product tier gets its own first step.
  for (var i = 0; i < 6; i++) bars += '<i></i>';
  return '<span class="amount-bars tier-' + tier + '" aria-hidden="true">' + bars + '</span>';
}
function amountCellHtml(r) {
  if (!r || (r.min == null && r.max == null)) return '<span class="muted">bracket unavailable</span>';
  var tier = amountTier(r.min, r.max);
  var text = amountText(r.min, r.max);
  if (!tier) return '<span class="amount-range fc-amt-val">' + esc(text) + '</span>';
  return '<div class="amount-cell" title="' + esc(tier.title + '  |  ' + text) + '">' +
    '<div class="amount-tier-line">' + amountBarsHtml(tier.tier) + '</div>' +
    '<div class="amount-range fc-amt-val">' + esc(text) + '</div>' +
  '</div>';
}
function relativeTimeText(s) {
  if (!s) return '';
  var raw = String(s);
  var t = Date.parse(raw);
  if (!isFinite(t)) return '';
  var sec = Math.round((Date.now() - t) / 1000);
  if (sec < 0) sec = 0;
  var dateOnly = raw.length <= 10 && /^\\d{4}-\\d{2}-\\d{2}$/.test(raw.slice(0, 10));
  if (dateOnly) {
    var days = Math.floor(sec / 86400);
    if (days <= 0) return 'today';
    if (days < 14) return days + 'd ago';
    return dateText(raw);
  }
  if (sec < 45) return 'just now';
  if (sec < 3600) return Math.floor(sec / 60) + 'm ago';
  if (sec < 86400) return Math.floor(sec / 3600) + 'h ago';
  if (sec < 86400 * 14) return Math.floor(sec / 86400) + 'd ago';
  return dateText(raw);
}
function tradesCardHtml(r) {
  var traded = dateText(r.txdate);
  // Executive filers show their position ("Treasury Sec.") instead of the
  // "Exec" branch word — row 2 is tight, so it asks for the tight budget.
  var chamber = memberBranchLabel(r, EXEC_TITLE_TIGHT);
  var member = fmtName(r.member);
  // iOS TradeCard politician line: "Chamber · Name · D-ST"
  var partyL = dirPartyLetter(r.party || r.partyBucket);
  var st = r.st ? String(r.st).toUpperCase() : '';
  var partyState = partyL && st ? partyL + '-' + st : (partyL || st);
  var ident = [];
  if (chamber && member) ident.push(esc(chamber) + ' · ' + esc(member));
  else if (member) ident.push(esc(member));
  else if (chamber) ident.push(esc(chamber));
  if (partyState) ident.push(esc(partyState));
  var owner = ownerLabel(r.owner);
  var filedRel = relativeTimeText(r.filed || r.filedDate || r.firstSeenAt);
  var bits = [];
  bits.push(memberAvatarHtml(member, r.photoUrl, r.party || r.partyBucket, true) +
    '<span class="fc-member">' + ident.join(' · ') + '</span>');
  if (owner) bits.push('<span class="fc-owner">' + esc(owner) + '</span>');
  if (filedRel) bits.push('<span class="fc-filed" title="Official filed time">' + esc(filedRel) + '</span>');
  if (r.stockActStatus === 'late' || r.stockActStatus === 'severely_late') {
    bits.push('<span style="color:var(--sell)" title="Disclosed after the STOCK Act 45-day deadline">' +
      (r.stockActStatus === 'severely_late' ? 'Severely late filing' : 'Late filing') + '</span>');
  }
  // No aria-label here (WEBA11Y-02): it used to replace the accessible name
  // with just "TICKER by NAME", hiding Buy/Sell, the amount bracket and the
  // date from screen-reader users.  Dropping it lets the card's own visible
  // content (ticker, Buy/Sell badge, amount, date, member line) become the
  // name, matching what a sighted user sees; the action hint is appended as
  // a visually-hidden suffix instead of replacing the name.
  return '<article class="trades-card clickable" tabindex="0" role="button" data-txid="' + esc(r.id) + '" title="Open trade details">' +
    '<div class="fc-main">' +
      '<div class="fc-top">' + assetCellHtml(r) + actionBadge(r.type) +
        '<div class="fc-trail">' + amountCellHtml(r) + '<div class="fc-date muted">' + esc(traded) + '</div></div>' +
      '</div>' +
      '<div class="fc-row2 muted">' + bits.join('<span class="fc-sep">  ·  </span>') + '</div>' +
    '</div>' +
    '<span class="fc-chevron" aria-hidden="true">›</span>' +
    '<span class="fc-hint">Open trade details</span>' +
  '</article>';
}
function lagBasisDate(r) { return (r && (r.filedDate || r.filed)) || ''; }
function lagDays(r) { return daysBetween(r.txdate, lagBasisDate(r)); }
function missingFiledReason(r) {
  if (r && r.source === 'seed_dataset') return 'Historical seed rows do not include the original official filing date yet. Run the official historical backfill to replace these with primary filing records.';
  if (r && r.source === 'competitor_backfill') return 'Filing date was not supplied by the provider.';
  return 'Official filing date is not available for this row.';
}
/* Owner punch list #17 — timestamp semantics: this was labeled "Published"
   in the UI, which read like an editorial publish date. Public firstSeenAt
   is when we learned about THIS trade (filing-index first-seen only when
   that stamp is on/after the trade date; otherwise persist time).  Fall
   back to imported / official filed for older rows, but never show a
   calendar day before the trade — House live search can list a DocID
   before later trades in the same PDF exist. */
function seenRaw(r) {
  if (!r) return '';
  var tx = toISODate(r.txdate);
  var candidates = [r.firstSeenAt, r.imported, r.filed, r.filedDate];
  for (var i = 0; i < candidates.length; i++) {
    var s = candidates[i];
    if (!s) continue;
    if (tx && toISODate(s) && toISODate(s) < tx) continue;
    return s;
  }
  return '';
}
function seenText(r) { var s = seenRaw(r); return s ? dateText(s) : 'Unavailable'; }
function seenDetailText(r) { var s = seenRaw(r); return s ? dateTimeText(s) : 'Unavailable'; }
function filedDetailText(r) { return r && r.filed ? dateText(r.filed) : 'Official Filing Date Unavailable'; }
function shortLagText(r) { return lagDays(r) == null ? 'Unavailable' : lagDays(r) + 'd'; }
function lagDetailText(r) {
  var d = lagDays(r);
  if (d == null) return 'Unavailable until official filing date is collected';
  return d + ' day' + (d === 1 ? '' : 's');
}
function seenCellHtml(r) {
  var s = seenRaw(r);
  if (!s) return '<span class="muted">Unavailable</span>';
  var title = r.filed ? 'Official filing date is available in the details drawer.' : missingFiledReason(r);
  return dateCellHtml(s, title);
}
function filedCellHtml(r) {
  if (r.filed) return dateCellHtml(r.filed);
  return '<span class="muted" title="' + esc(missingFiledReason(r)) + '">Unavailable</span>';
}
function lagCellHtml(r) {
  var d = lagDays(r);
  if (d == null) return '<span class="muted" title="' + esc(missingFiledReason(r)) + '">Unavailable</span>';
  var over = d > 45 ? ' style="color:var(--sell)"' : '';
  return '<span' + over + ' title="Days from trade to official filing date (STOCK Act limit: 45)">' + d + '</span>';
}
var TRADES_COLS = [
  { id: 'traded', label: 'Date', sort: 'txdate', def: true, cls: 'muted', tip: 'Date the trade was executed.', cell: function (r) { return dateCellHtml(r.txdate); } },
  { id: 'type', label: 'Type', sort: null, def: true, tip: 'Reported transaction type.', cell: function (r) { return actionBadge(r.type); } },
  { id: 'member', label: 'Politician', sort: null, def: true, tip: 'Politician who filed the disclosure.', cell: memberCellHtml },
  { id: 'asset', label: 'Asset', sort: null, def: true, tip: 'Asset name as reported; hover truncated names to see the full text.', cell: assetCellHtml },
  { id: 'amount', label: 'Amount', sort: null, def: true, tip: 'STOCK Act bracket - an estimate, not an exact figure.', cell: amountCellHtml },
  { id: 'sector', label: 'Sector', sort: null, def: false, cls: 'muted', tip: 'Cross-referenced sector (FMP / SEC EDGAR). Blank until the asset is enriched.', cell: function (r) { return clipTextHtml(r.refSector); } },
  { id: 'country', label: 'Country', sort: 'refCountry', def: false, defAdmin: true, cls: 'muted', tip: 'Country of issue from enriched reference data.', cell: function (r) { return clipTextHtml(r.refCountry); } },
  { id: 'imported', label: 'Imported', sort: 'imported', def: true, cls: 'muted', tier: 'admin', tip: 'When Congress.Trade imported each filing.', cell: function (r) { return dateTimeCellHtml(r.imported, 'When Congress.Trade imported each filing'); } },
  { id: 'latency', label: 'Latency', sort: null, def: true, cls: 'latency', tier: 'admin', tip: 'First detected time and extraction latency for primary rows.', cell: function (r) { return rowLatencyHtml(r); } },
  { id: 'conf', label: 'Confidence', sort: 'conf', def: false, defAdmin: true, tier: 'admin', tip: 'Parser confidence after validation penalties.', cell: function (r) { return '<span class="conf ' + confClass(r.conf) + '">~' + (r.conf * 100).toFixed(0) + '%</span>'; } },
  { id: 'published', label: 'Seen', sort: 'published', def: false, cls: 'muted', tip: 'When Congress.Trade first learned about this trade. See "Imported" for when we finished storing it, and "Official Filed" for the source\\u2019s own disclosure date.', cell: seenCellHtml },
  { id: 'lag', label: 'Lag', sort: null, def: false, tip: 'Days between the trade and the filing (STOCK Act limit: 45).', cell: lagCellHtml },
  { id: 'owner', label: 'Owner', sort: null, def: false, cls: 'muted', tip: 'Beneficial owner code reported on the filing.', cell: function (r) { return clipTextHtml(ownerLabel(r.owner)); } },
  { id: 'filed', label: 'Official Filed', sort: null, def: false, cls: 'muted', tip: 'Official disclosure/report date. Historical rows may not include it yet.', cell: filedCellHtml },
  { id: 'chamber', label: 'Chamber', sort: null, def: false, cls: 'muted', tip: 'House or Senate source chamber.', cell: function (r) { return clipTextHtml(ownerLabel(r.chamber)); } },
  { id: 'notes', label: 'Notes', sort: null, def: false, cls: 'muted', tip: 'How we cleaned or filled the asset name (concise plain English).', cell: function (r) {
    var n = plainCleaningNote(r.cleaningNote || '');
    return clipTextHtml(n, '—', n);
  } },
  { id: 'source', label: 'Source', sort: 'source', def: false, defAdmin: false, tier: 'admin', tip: 'Row provenance: primary official pipeline or historical seed import.', cell: function (r) { return clipTextHtml(sourceLabel(r.source), '—', sourceTitle(r.source)); } }
];
var COL_HIDDEN_KEY = 'feed-cols-hidden-v4';
var COL_ORDER_KEY = 'feed-cols-order-v3';
function colHiddenKey() {
  return isAdminView() ? COL_HIDDEN_KEY + '-admin' : COL_HIDDEN_KEY;
}
function colIsDefault(c) {
  if (isAdminView() && Object.prototype.hasOwnProperty.call(c, 'defAdmin')) return !!c.defAdmin;
  return !!c.def;
}
function isAdminView() {
  return typeof ME !== 'undefined' && !!(ME.admin && ME.admin.allowed);
}
function canUseColumn(c) {
  if (c.tier === 'admin') return isAdminView();
  return true;
}
function loadColOrder() { try { var v = JSON.parse(localStorage.getItem(COL_ORDER_KEY)); return Array.isArray(v) ? v : []; } catch (e) { return []; } }
function saveColOrder(v) { try { localStorage.setItem(COL_ORDER_KEY, JSON.stringify(v)); } catch (e) {} }
var colOrder = loadColOrder();
function orderedCols(cols) {
  var pos = {};
  colOrder.forEach(function (id, i) { pos[id] = i; });
  return cols.slice().sort(function (a, b) {
    var ai = pos[a.id], bi = pos[b.id];
    if (ai == null && bi == null) return TRADES_COLS.indexOf(a) - TRADES_COLS.indexOf(b);
    if (ai == null) return 1;
    if (bi == null) return -1;
    return ai - bi;
  });
}
function chooserCols() {
  return orderedCols(TRADES_COLS.filter(function (c) {
    if (c.lock) return false;
    if (c.tier === 'admin' && !isAdminView()) return false;
    return true;
  }));
}
function availableCols() { return orderedCols(TRADES_COLS.filter(canUseColumn)); }
function defaultHidden() { return availableCols().filter(function (c) { return !colIsDefault(c); }).map(function (c) { return c.id; }); }
function loadHiddenCols() { try { var v = JSON.parse(localStorage.getItem(colHiddenKey())); return v && v.length !== undefined ? v : defaultHidden(); } catch (e) { return defaultHidden(); } }
function saveHiddenCols(h) { try { localStorage.setItem(colHiddenKey(), JSON.stringify(h)); } catch (e) {} }
var hiddenCols = loadHiddenCols();
function isColVisible(id) { return hiddenCols.indexOf(id) < 0; }
function visibleCols() { return availableCols().filter(function (c) { return isColVisible(c.id); }); }
function renderTradesColGroup() {
  var cg = el('tradesCols'); if (!cg) return;
  cg.innerHTML = visibleCols().map(function (c) { return '<col data-col="' + esc(c.id) + '">'; }).join('');
}
function parsePx(v) {
  var n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}
/* Columns that absorb leftover viewport width only while the user has not
   manually resized any column (initial defaults / window resize). Once the
   user drags a resizer, the table width tracks the sum of column widths so
   expanding/shrinking a column makes the whole table wider/narrower instead
   of redistributing space into Politician/Asset (owner 2026-08-09). */
var TRADES_FLEX_COLS = ['member', 'asset'];
var colWidthsUserAdjusted = false;
function syncTradesTableWidth() {
  var table = el('tradesTable'); if (!table) return;
  var ths = Array.prototype.slice.call(document.querySelectorAll('#tradesHead th'));
  var cols = Array.prototype.slice.call(document.querySelectorAll('#tradesCols col'));
  if (!ths.length) return;
  var total = 0;
  for (var i = 0; i < ths.length; i++) {
    var w = parsePx(ths[i].style.width) || ths[i].offsetWidth || minColWidth(ths[i].dataset.col);
    w = Math.max(minColWidth(ths[i].dataset.col), Math.round(w));
    ths[i].style.width = w + 'px';
    total += w;
  }
  var wrap = table.closest ? table.closest('.table-wrap') : null;
  // .table-wrap padding-right is 0; clientWidth is the true content box.
  var avail = wrap ? Math.max(0, wrap.clientWidth) : 0;
  // Only fill leftover viewport while defaults are still in effect. After a
  // manual column drag, leave total alone so the table grows/shrinks with
  // the sum of column widths (horizontal scroll when wider than the wrap).
  if (!colWidthsUserAdjusted && avail > total) {
    var extra = avail - total;
    var flexThs = ths.filter(function (th) { return TRADES_FLEX_COLS.indexOf(th.dataset.col) >= 0; });
    if (flexThs.length) {
      var each = Math.floor(extra / flexThs.length);
      var remainder = extra - each * flexThs.length;
      for (var j = 0; j < flexThs.length; j++) {
        var add = each + (j === 0 ? remainder : 0);
        var nw = parsePx(flexThs[j].style.width) + add;
        flexThs[j].style.width = nw + 'px';
      }
      total = avail;
    }
  }
  for (var k = 0; k < ths.length; k++) {
    if (cols[k]) cols[k].style.width = ths[k].style.width;
  }
  table.style.width = total + 'px';
}

/* Render the header from the registry, (re)attach sort handlers, and reset the
   resize state so widths re-freeze for the now-visible columns. */
function renderTradesHeader() {
  var head = el('tradesHead'); if (!head) return;
  renderTradesColGroup();
  head.innerHTML = visibleCols().map(function (c) {
    var cls = (c.sort ? 'sortable ' : '') + 'c-' + c.id;
    var ds = c.sort ? ' data-sort="' + c.sort + '"' : '';
    var tip = c.tip ? ' title="' + esc(c.tip) + '"' : '';
    // No role="button" here: a <th> keeps its native columnheader role so
    // aria-sort (set by updateSortIndicators()) stays valid ARIA (WEBA11Y-01).
    // The actual interactive control is the real named <button> inside —
    // native <button> semantics give Enter/Space activation for free, so no
    // custom keydown handler is needed here anymore (WEBA11Y P2 follow-up:
    // a bare tabindex'd <th> was announced only as a column header, with no
    // indication that Enter/Space did anything).
    var sortAttrs = c.sort ? ' aria-sort="none"' : '';
    var inner = c.sort
      ? '<button type="button" class="th-sort-btn" data-sort="' + c.sort + '">' + esc(c.label) + '<span class="arr" aria-hidden="true"></span></button>'
      : esc(c.label);
    return '<th class="' + cls + '" data-col="' + c.id + '"' + ds + tip + sortAttrs + '>' + inner + '</th>';
  }).join('');
  var btns = head.querySelectorAll('.th-sort-btn');
  for (var i = 0; i < btns.length; i++) {
    (function (btn) {
      btn.onclick = function () { setSort(btn.dataset.sort); };
    })(btns[i]);
  }
  // Re-init the resizable columns for the new header.
  var table = el('tradesTable'); if (table) { table.classList.remove('resizable'); table.style.width = ''; }
  colResizeInit = false;
  updateSortIndicators();
}

/* Column chooser (the ⚙ Columns panel). */
function panelIds() { return ['colChooser']; }
function anyPanelOpen() {
  return panelIds().some(function (id) { var p = el(id); return !!(p && p.classList.contains('open')); });
}
function closePanels() {
  panelIds().forEach(function (id) {
    var p = el(id);
    if (p) {
      p.classList.remove('open');
      if (typeof p.close === 'function') p.close();
    }
  });
}
function setPanelOpen(id, open) {
  panelIds().forEach(function (pid) {
    var p = el(pid);
    if (p) {
      if (pid === id && open) {
        p.classList.add('open');
        if (typeof p.showModal === 'function' && !p.open) p.showModal();
      } else {
        p.classList.remove('open');
        if (typeof p.close === 'function') p.close();
      }
    }
  });
  if (id === 'colChooser' && open) renderColChooser();
}
function renderColChooser() {
  var box = el('colChooserBody'); if (!box) return;
  var note = '<div class="panel-note" style="margin-bottom:12px">Drag columns here to reorder the Trades table.</div>';
  box.innerHTML = note + chooserCols().map(function (c) {
    var tip = c.tip ? ' title="' + esc(c.tip) + '"' : '';
    return '<label class="colopt" draggable="true" data-colid="' + esc(c.id) + '"' + tip + '><span class="col-drag" aria-hidden="true">≡</span><input type="checkbox" data-colid="' + c.id + '"' + (isColVisible(c.id) ? ' checked' : '') + ' /> <span class="colopt-name">' + esc(c.label) + '</span></label>';
  }).join('');
}
function toggleColChooser() {
  var p = el('colChooser');
  setPanelOpen('colChooser', !(p && p.classList.contains('open')));
}
function onColToggle(id, visible) {
  var i = hiddenCols.indexOf(id);
  if (visible && i >= 0) hiddenCols.splice(i, 1);
  else if (!visible && i < 0) hiddenCols.push(id);
  saveHiddenCols(hiddenCols);
  renderTradesHeader(); renderTrades();
}
function moveColumn(dragId, targetId) {
  if (!dragId || !targetId || dragId === targetId) return;
  var ids = chooserCols().map(function (c) { return c.id; });
  ids = ids.filter(function (id) { return id !== dragId; });
  var idx = ids.indexOf(targetId);
  if (idx < 0) return;
  ids.splice(idx, 0, dragId);
  colOrder = ids;
  saveColOrder(colOrder);
  renderColChooser(); renderTradesHeader(); renderTrades();
}
function resetCols() {
  hiddenCols = defaultHidden();
  colOrder = [];
  saveHiddenCols(hiddenCols);
  saveColOrder(colOrder);
  renderColChooser(); renderTradesHeader(); renderTrades();
}

/* Builds a predicate for "does this row match the CURRENTLY ACTIVE
   member/ticker/side/chamber filters" — snapshotting the filter values once
   so filtering many rows doesn't re-read the DOM per row. Shared by
   renderTrades() below and the SSE congress.trade handler, which must apply
   the SAME check before letting a pushed row affect this view's rows/total —
   a live broadcast carries every new trade, not just ones matching what THIS
   visitor is currently filtered to. */
/** Multi-token AND trade search: any order; each token matches politician
 *  name, ticker, asset name, state (abbr or full), or party synonyms. */
function tradeRowMatchesSearch(r, q) {
  var raw = String(q || '').trim().toLowerCase();
  if (!raw) return true;
  var tokens = raw.split(/\\s+/).filter(Boolean);
  var name = String(r.member || '').toLowerCase();
  var nameParts = name.split(/[\\s,.\\-']+/).filter(Boolean);
  var ticker = String(r.ticker || '').toLowerCase();
  var asset = String(r.asset || r.company || '').toLowerCase();
  var state = String(r.st || r.state || '').toLowerCase();
  var party = String(r.party || r.partyBucket || '');
  return tokens.every(function (tok) {
    if (name.indexOf(tok) >= 0) return true;
    for (var i = 0; i < nameParts.length; i++) {
      if (nameParts[i].indexOf(tok) === 0 || nameParts[i].indexOf(tok) >= 0) return true;
    }
    if (ticker && ticker.indexOf(tok) >= 0) return true;
    if (asset && asset.indexOf(tok) >= 0) return true;
    if (typeof peopleStateMatches === 'function' && peopleStateMatches(tok, state)) return true;
    if (typeof peoplePartyMatches === 'function' && peoplePartyMatches(tok, party)) return true;
    if (state && state.indexOf(tok) >= 0) return true;
    return false;
  });
}
function tradesSearchQuery() {
  var s = el('qSearch');
  if (s) return String(s.value || '').trim();
  // Fallback if only legacy fields exist
  var m = el('qMember') ? String(el('qMember').value || '').trim() : '';
  var t = el('qTicker') ? String(el('qTicker').value || '').trim() : '';
  return [m, t].filter(Boolean).join(' ');
}
var COMMON_POLITICIAN_NAMES = {
  adams: 1, alexander: 1, allen: 1, apple: 1, bacon: 1, bailey: 1, baker: 1, banks: 1,
  barnes: 1, bell: 1, bennett: 1, brooks: 1, brown: 1, bryant: 1, butler: 1, campbell: 1,
  carter: 1, coleman: 1, collins: 1, cook: 1, cooper: 1, cox: 1, crane: 1, diaz: 1,
  edwards: 1, evans: 1, flores: 1, foster: 1, gonzales: 1, gonzalez: 1, gray: 1, green: 1,
  griffin: 1, hall: 1, hayes: 1, henderson: 1, hill: 1, howard: 1, hughes: 1, james: 1,
  jenkins: 1, kelly: 1, king: 1, lee: 1, long: 1, luna: 1, mace: 1, mitchell: 1,
  moore: 1, morgan: 1, morris: 1, murphy: 1, nehls: 1, nelson: 1, omar: 1, parker: 1,
  patterson: 1, perez: 1, perry: 1, peterson: 1, phillips: 1, powell: 1, price: 1, ramirez: 1,
  reed: 1, richardson: 1, rivera: 1, roberts: 1, rogers: 1, ross: 1, ruiz: 1, russell: 1,
  sanchez: 1, sanders: 1, scott: 1, simmons: 1, smith: 1, stewart: 1, taylor: 1, torres: 1,
  turner: 1, vance: 1, walsh: 1, ward: 1, washington: 1, watson: 1, welch: 1, white: 1,
  wood: 1, wright: 1, young: 1
};
/** Heuristic server params from unified query (OR-ish fetch; client re-filters). */
function applySearchToServerParams(p, q) {
  var raw = String(q || '').trim();
  if (!raw) return;
  var tokens = raw.split(/\\s+/).filter(Boolean);
  var nameBits = [];
  var tickerHint = '';
  var polDict = (typeof COMMON_POLITICIAN_NAMES !== 'undefined') ? COMMON_POLITICIAN_NAMES : {};
  for (var i = 0; i < tokens.length; i++) {
    var tok = tokens[i];
    var up = tok.toUpperCase();
    var tokL = tok.toLowerCase();
    var isState = (typeof US_STATE_ABBR !== 'undefined' && US_STATE_ABBR[tokL]) ||
      (typeof US_STATE_NAME_TO_ABBR !== 'undefined' && US_STATE_NAME_TO_ABBR[tokL]);
    var isParty = /^(dem|rep|ind|gop|other|democrat|republican|independent)s?$/i.test(tok);
    var isPolitician = !!polDict[tokL];
    var isAllUpper = tok === up && /^[A-Z0-9]{1,5}$/.test(tok);
    if (isAllUpper && !isState && !isParty && !isPolitician) {
      if (!tickerHint) tickerHint = up;
      else nameBits.push(tok);
    } else if (isState) {
      // state — client filter only (server has no state= on public feed)
    } else if (isParty) {
      // party — client filter
    } else {
      nameBits.push(tok);
    }
  }
  if (tickerHint) p.set('ticker', tickerHint);
  if (nameBits.length) p.set('memberName', nameBits.join(' '));
  // If nothing classified, send whole string as memberName so server still narrows
  if (!tickerHint && !nameBits.length) p.set('memberName', raw);
}
// See the .row-open-btn CSS comment above for why this exists: a real,
// named control dropped into a clickable table row's first cell, invisible
// at rest and popped into view on keyboard focus.
function rowOpenBtnHtml(attrName, attrValue, label) {
  return '<button type="button" class="row-open-btn" ' + attrName + '="' + esc(attrValue) + '">' + esc(label) + '</button>';
}
function renderTrades() {
  
  var body = el('tradesBody');
  var cards = el('tradesCards');
  var cols = visibleCols();
  if (!cols.length) {
    body.innerHTML = stateRow(1, 'No columns are visible. Open Columns and enable at least one column.');
    if (cards) cards.innerHTML = stateCards('No columns are visible. Open Columns and enable at least one column.');
    updateTradesCountMsg(0); return;
  }
  if (!realDataLoaded) {
    body.innerHTML = stateRow(cols.length, 'Loading live feed…');
    if (cards) cards.innerHTML = stateCards('Loading live feed…');
    return;
  }
  var primaryOnly = tradesSourceMode() === 'primary';
  var rows = TRADES.filter(function (r) {
    // De-duplicated default (#1453): primary + historic seed rows can double
    // count the same real-world trade — Primary Only hides the seed copies.
    if (primaryOnly && r.source === 'seed_dataset') return false;
    return true;
  });
  rows = sortRows(rows);
  if (rows.length === 0) {
    body.innerHTML = stateRow(cols.length, 'No transactions match these filters.');
    if (cards) cards.innerHTML = stateCards('No transactions match these filters.');
    updateTradesCountMsg(0); maybeInitResize(); syncTradesTableWidth(); return;
  }
  body.innerHTML = rows.map(function (r) {
    var tds = cols.map(function (c, i) {
      var cell = c.cell(r);
      if (i === 0) cell = rowOpenBtnHtml('data-txid', r.id, 'Open trade details') + cell;
      return '<td class="c-' + c.id + (c.cls ? ' ' + c.cls : '') + '">' + cell + '</td>';
    }).join('');
    return '<tr class="row clickable" data-txid="' + esc(r.id) + '" title="Open trade details">' + tds + '</tr>';
  }).join('');
  if (cards) cards.innerHTML = rows.map(tradesCardHtml).join('');
  updateTradesCountMsg(rows.length);
  maybeInitResize();
  syncTradesTableWidth();
}

/* "1-N of total" + first/prev/next/last controls for the bounded table page.
   Top and bottom pagers share data-* hooks so both stay in sync. */
function maxReachableTradesPage(total) {
  var byTotal = Math.max(0, Math.ceil((total || 0) / tradesPageSize) - 1);
  var byCap = Math.floor(MAX_PUBLIC_TRADES_OFFSET / tradesPageSize);
  return Math.min(byTotal, byCap);
}
function setAll(sel, fn) {
  var nodes = document.querySelectorAll(sel);
  for (var i = 0; i < nodes.length; i++) fn(nodes[i], i);
}
function updateTradesCountMsg(shown) {
  // Keep the timeframe stamp beside "matching trades" in step with the shared
  // window select even when the visitor never opens Trends (deep link, refresh
  // on the Trades tab) — an unlabelled or stale scope is what made the same
  // politician's 988 and 22,832 look like contradictory numbers.
  if (typeof stampWindowChips === 'function') stampWindowChips();
  if (!realDataLoaded) {
    setAll('[data-trades-count]', function (n) { n.textContent = ''; });
    setAll('[data-trades-page]', function (n) { n.textContent = ''; n.title = ''; n.removeAttribute('data-page-text'); });
    setAll('[data-pager-first],[data-pager-prev],[data-pager-next],[data-pager-last]', function (n) { n.disabled = true; });
    return;
  }
  // Server-filtered corpus total — never the page size (owner: upper-right
  // "matching trades" and pager "of N" must track active filters).
  var total = typeof totalRows === 'number' ? totalRows : (shown || 0);
  var start = total === 0 ? 0 : tradesPage * tradesPageSize + 1;
  var end = Math.min(tradesPage * tradesPageSize + shown, total);
  var pageCount = Math.max(1, Math.ceil(total / tradesPageSize));
  var maxPage = maxReachableTradesPage(total);
  var countHtml = '<span class="tick-num">' + start.toLocaleString() + '-' + end.toLocaleString() + '</span> of <span class="tick-num">' + total.toLocaleString() + '</span>';
  setAll('[data-trades-count]', function (msg) {
    msg.innerHTML = countHtml;
    msg.classList.remove('tick-animate');
    void msg.offsetWidth;
    msg.classList.add('tick-animate');
  });
  setAll('[data-trades-page]', function (pageMsg) {
    var longText = 'Page ' + fmtCount(tradesPage + 1) + ' of ' + fmtCount(pageCount);
    var shortText = fmtCount(tradesPage + 1) + '/' + fmtCount(pageCount);
    // Two spans: desktop shows the long form, the phone top band swaps to the
    // short one (CSS, <=768px pager rules) — one visible node, read once.
    pageMsg.innerHTML = '<span class="pg-long">' + longText + '</span><span class="pg-short">' + shortText + '</span>';
    pageMsg.title = longText;
    pageMsg.setAttribute('data-page-text', longText); // clean copy: textContent is now both spans
  });
  var disFirst = tradesPage <= 0 || loadingPage;
  var disLast = tradesPage >= maxPage || end >= total || loadingPage;
  setAll('[data-pager-first],[data-pager-prev]', function (n) { n.disabled = disFirst; });
  setAll('[data-pager-next],[data-pager-last]', function (n) { n.disabled = disLast; });
}

/* ---- resizable feed columns (drag the right edge of a header) ---- */
/* Owner follow-up batch #13: version-bumped v8->v9 so the rebalanced desktop
   column defaults (Politician/Asset flexible, Date/Type/Amount/Country
   compact, Size column removed — #22/#24) actually take effect for every
   visitor who never intentionally dragged a column; the resizable feature
   itself (drag-to-resize, per-column persistence) is otherwise unchanged.
   Layout-stability follow-up (2026-08-09, v9->v10): the compact-column
   minColWidth() floors below were smaller than the columns' own header
   labels need (e.g. "Type"/"Country" need ~85-100px to not truncate; the
   floor let them get pinned as low as 44-54px), so whenever a column got
   clamped to its floor — first paint on a merely-average viewport, an admin
   session's two extra columns (Imported/Latency) arriving after /auth/me
   resolves, a live window resize — headers collapsed to unreadable ellipsis
   stubs ("DA…", "T…"), and Latency's header (which shared its wrap CSS with
   the two-line body cell) could word-break into one letter per line. Fixed
   by raising every compact column's floor to fit its own label (see
   minColWidth below) and by clamping (never trusting) any already-persisted
   width against that floor at load time (clampSavedWidth). Widths saved
   under v9 could be as low as the OLD (too-small) floor, which is now
   structurally incompatible, hence the key bump — v10 starts every visitor
   clean, same as the v8->v9 bump above.
   Grow/shrink follow-up (2026-08-09, v10->v11): after the user drags any
   column, the table width is the sum of column widths (grows/shrinks with
   the drag) instead of always filling the wrap and redistributing leftover
   into Politician/Asset. Default (pre-drag) still fills the viewport via
   flex columns. Bump clears persisted fill-inflated widths.
   Default-balance follow-up (2026-08-09, v11->v12): tighter compact caps for
   Date/Type/Amount/Imported/Latency matching the owner-approved default
   layout (screenshot), with Politician/Asset still taking the flex remainder
   until the user drags. */
var COL_WIDTH_KEY = 'feed-col-widths-v12';
var colResizeInit = false;
function loadColWidths() { try { return JSON.parse(localStorage.getItem(COL_WIDTH_KEY) || '{}') || {}; } catch (e) { return {}; } }
function saveColWidths(w) { try { localStorage.setItem(COL_WIDTH_KEY, JSON.stringify(w)); } catch (e) {} }
function maybeInitResize() { if (!colResizeInit && realDataLoaded) { colResizeInit = true; initColumnResize(); } }
/* If the user has any persisted column widths, treat as user-adjusted so we
   don't re-inflate flex columns and undo their custom table width. */
function hasPersistedColWidths() {
  var w = loadColWidths();
  if (!w || typeof w !== 'object') return false;
  for (var k in w) { if (Object.prototype.hasOwnProperty.call(w, k)) return true; }
  return false;
}
/* Defense-in-depth guard (layout-stability follow-up): a persisted width can
   be stale (saved before a minColWidth floor was raised), corrupted, or just
   absent/non-numeric — never trust it verbatim. Returns null (use the
   natural/auto width instead) when nothing usable was stored, otherwise the
   stored value clamped up to at least the column's current floor. This runs
   BEFORE the column is ever painted as 'resizable', so a degenerate stored
   value never gets a single frame on screen (syncTradesTableWidth applies
   the same minColWidth floor again on every later pass — resize, drag,
   re-render — so the floor holds for the lifetime of the page, not just at
   init). */
function clampSavedWidth(key, raw) {
  var n = Number(raw);
  if (!key || !Number.isFinite(n) || n <= 0) return null;
  return Math.max(minColWidth(key), Math.round(n));
}
function clampNum(n, min, max) { return Math.max(min, Math.min(max, n)); }
function estimatedColWidth(key, fallback, min, max) {
  var selector = key === 'asset'
    ? '#tradesBody .c-asset .asset-cell > div'
    : key === 'member'
      ? '#tradesBody .c-member .member-cell > div'
      : '';
  if (!selector) return fallback;
  var nodes = Array.prototype.slice.call(document.querySelectorAll(selector), 0, 80);
  var lens = nodes.map(function (n) { return (n.textContent || '').trim().length; }).filter(function (n) { return n > 0; }).sort(function (a, b) { return a - b; });
  if (!lens.length) return fallback;
  var med = lens[Math.floor(lens.length / 2)];
  var px = key === 'asset' ? 42 + Math.ceil(med * 6.4) : 54 + Math.ceil(med * 7.4);
  return clampNum(px, min, max);
}
/* Content-fit floors for the compact/fixed columns (Politician/Asset are
   excluded — they keep the flexible majority via estimatedColWidth/
   DEFAULT_CAP in initColumnResize, not this floor). Every value here is
   measured against the column's own header label (text + sort arrow, where
   the column is sortable) rendered with the production th padding, rounded
   up with headroom for cross-platform font-metric variance — never trim
   these below what the label itself needs, or the truncation/word-break
   this floor exists to prevent (owner report, layout-stability follow-up)
   comes back. */
function minColWidth(key) {
  var map = {
    asset: 140,
    member: 62,
    amount: 108,
    imported: 118,
    published: 88,
    traded: 88,
    filed: 148,
    type: 96,
    lag: 80,
    owner: 100,
    chamber: 114,
    sector: 104,
    country: 112,
    conf: 132,
    latency: 96,
    notes: 82,
    source: 106
  };
  return map[key] || 80;
}
function applyColumnWidthClasses() {
  var table = el('tradesTable'); if (!table) return;
  var keys = ['published', 'traded', 'filed', 'imported'];
  for (var i = 0; i < keys.length; i++) {
    table.classList.remove('narrow-' + keys[i], 'tiny-' + keys[i]);
  }
  var ths = document.querySelectorAll('#tradesHead th');
  for (var j = 0; j < ths.length; j++) {
    var key = ths[j].dataset.col, w = ths[j].offsetWidth;
    if (keys.indexOf(key) < 0) continue;
    if (w < 132) table.classList.add('narrow-' + key);
    if (w < 92) table.classList.add('tiny-' + key);
  }
}
function initColumnResize() {
  var table = el('tradesTable'); if (!table) return;
  var ths = document.querySelectorAll('#tradesHead th');
  var saved = loadColWidths();
  colWidthsUserAdjusted = hasPersistedColWidths();
  // Freeze current auto widths (or restore saved ones) so switching the table to
  // fixed layout doesn't visually jump. Defaults cap compact columns; Politician
  // / Asset get content-responsive ranges. Any column stays draggable.
  // Soft caps when no saved width: compact columns stay tight (owner screenshot
  // 2026-08-09); Politician/Asset get content-responsive ranges and then absorb
  // leftover wrap width via TRADES_FLEX_COLS until the user resizes.
  var DEFAULT_CAP = {
    asset: estimatedColWidth('asset', 240, 200, 300),
    member: estimatedColWidth('member', 200, 170, 260),
    traded: 100,
    type: 90,
    amount: 100,
    sector: 130,
    country: 120,
    imported: 112,
    latency: 120,
    notes: 200
  };
  for (var i = 0; i < ths.length; i++) {
    var k = ths[i].dataset.col;
    var savedW = clampSavedWidth(k, saved[k]);
    var w = savedW != null ? savedW : ths[i].offsetWidth;
    // Trends is the default tab, so this often runs while #view-trades is
    // display:none and every offsetWidth is 0. Fall back to the default cap
    // (or the label floor) instead of painting 62px "PO…" columns.
    if (savedW == null && !w) w = (k && DEFAULT_CAP[k]) || minColWidth(k);
    if (savedW == null && k && DEFAULT_CAP[k] && w > DEFAULT_CAP[k]) w = DEFAULT_CAP[k];
    ths[i].style.width = w + 'px';
  }
  table.classList.add('resizable');
  for (var j = 0; j < ths.length; j++) addColResizer(ths[j]);
  syncTradesTableWidth();
  applyColumnWidthClasses();
}
function addColResizer(th) {
  var grip = document.createElement('span');
  grip.className = 'col-resizer';
  grip.addEventListener('click', function (e) { e.stopPropagation(); }); // don't sort
  grip.addEventListener('mousedown', function (e) {
    e.preventDefault(); e.stopPropagation();
    var startX = e.pageX, startW = th.offsetWidth;
    // First drag permanently opts out of "fill viewport with flex columns".
    colWidthsUserAdjusted = true;
    function move(ev) {
      th.style.width = Math.max(minColWidth(th.dataset.col), startW + (ev.pageX - startX)) + 'px';
      syncTradesTableWidth();
      applyColumnWidthClasses();
    }
    function up() {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      document.body.style.userSelect = '';
      var w = loadColWidths(); w[th.dataset.col] = parsePx(th.style.width) || th.offsetWidth; saveColWidths(w);
      syncTradesTableWidth();
      applyColumnWidthClasses();
    }
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
    document.body.style.userSelect = 'none';
  });
  th.appendChild(grip);
}

/* ---- sorting ---- */
function sortVal(r, key) {
  if (key === 'asset') return (r.ticker || r.asset || '');
  if (key === 'lag') { var d = lagDays(r); return d == null ? -Infinity : d; }
  var v = key === 'published' ? seenRaw(r) : r[key];
  if (NUMERIC_SORT[key]) return (v == null ? -Infinity : Number(v));
  if (key === 'txdate' || key === 'traded' || key === 'filed' || key === 'imported' || key === 'published') {
    if (!v) return sortDir > 0 ? '\uFFFF' : '';
    var today = new Date().toISOString().slice(0, 10);
    var dateValue = String(v).toLowerCase();
    return dateValue.slice(0, 10) > today ? today + dateValue.slice(10) : dateValue;
  }
  return (v == null ? '' : String(v)).toLowerCase();
}
function sortRows(rows) {
  var copy = rows.slice();
  copy.sort(function (a, b) {
    var av = sortVal(a, sortKey), bv = sortVal(b, sortKey);
    if (av < bv) return -1 * sortDir;
    if (av > bv) return 1 * sortDir;
    return 0;
  });
  return copy;
}
function setSort(key) {
  if (sortKey === key) { sortDir = -sortDir; }   // same column -> flip direction
  else { sortKey = key; sortDir = (key === 'published' || key === 'filed' || key === 'txdate' || key === 'imported' || key === 'lag' || NUMERIC_SORT[key]) ? -1 : 1; }
  updateSortIndicators();
  
  var isBackendSort = (key === 'published' || key === 'imported' || key === 'txdate' || key === 'traded');
  if (isBackendSort) {
    tradesPage = 0;
    cursor = 0;
    fetchPage();
  } else {
    renderTrades();
  }
}
function updateSortIndicators() {
  var ths = document.querySelectorAll('#tradesHead th.sortable');
  for (var i = 0; i < ths.length; i++) {
    var th = ths[i], arr = th.querySelector('.arr');
    if (th.dataset.sort === sortKey) {
      th.classList.add('active'); arr.textContent = sortDir > 0 ? '▲' : '▼';
      th.setAttribute('aria-sort', sortDir > 0 ? 'ascending' : 'descending');
    } else {
      th.classList.remove('active'); arr.textContent = '↕';
      th.setAttribute('aria-sort', 'none');
    }
  }
  syncMobileSortControl();
}

/* ---- mobile sort control (below 768px, in place of the hidden table header) ----
   Options mirror the same sortable columns exposed by the desktop th.sortable
   headers (visibleCols() already applies tier/hidden-column rules), so this stays
   in sync whenever columns change and never offers a column the user can't see.
   Selecting a key or flipping direction both go through setSort(), the same
   sortKey/sortDir state + tradesQueryParams()/fetchPage() refetch path the desktop
   headers use. */
function mobileSortableCols() {
  return visibleCols().filter(function (c) { return !!c.sort; });
}
function syncMobileSortControl() {
  var sel = el('mobileSortKey'); if (!sel) return;
  sel.innerHTML = mobileSortableCols().map(function (c) {
    return '<option value="' + esc(c.sort) + '"' + (c.sort === sortKey ? ' selected' : '') + '>' + esc(c.label) + '</option>';
  }).join('');
  sel.value = sortKey;
  var btn = el('mobileSortDirBtn');
  if (btn) {
    btn.textContent = sortDir > 0 ? '▲' : '▼';
    btn.title = sortDir > 0 ? 'Ascending — tap for descending' : 'Descending — tap for ascending';
  }
}
function handleMobileSortKeyChange() {
  var sel = el('mobileSortKey'); if (!sel || !sel.value || sel.value === sortKey) return;
  setSort(sel.value);
}
function toggleMobileSortDir() {
  setSort(sortKey); // same key -> setSort() flips sortDir
}

/* Friendly, human-readable label for a transaction's provenance. The raw value
   ('seed_dataset' | 'primary') rides along as a tooltip via sourceTitle. */
var sourceLabelMap = { seed_dataset: 'Historical', primary: 'Primary', manual: 'Manual' };
function sourceLabel(src) { return sourceLabelMap[src] || (src || ''); }
function sourceTitle(src) {
  if (src === 'primary') return 'Parsed from an official filing by the Congress.Trade ingestion pipeline.';
  if (src === 'seed_dataset') return 'Imported from a historical seed dataset.';
  if (src === 'manual') return 'Hand-keyed by an admin during manual review.';
  return src || 'Unknown source';
}

/* Map an API transaction (shared/types Transaction) to a feed row. Politician name
   prefers filers.full_name (memberName from the API); falls back to the raw
   filer id when the name is missing. */
function txToRow(tx) {
  return {
    // "Filed" = the official disclosure/report date. Historic seed rows often
    // do not carry it; keep that missing state visible instead of using import
    // time as a stand-in.
    filed: toISODate(tx.filedDate) || '',
    member: tx.fullName || tx.memberName || tx.filerId || 'Unknown',
    photoUrl: tx.photoUrl || '',
    st: tx.state || '',
    chamber: tx.chamber || '',
    party: tx.party || '',
    asset: cleanAsset(tx.assetName || ''),
    ticker: tx.ticker || '',
    assetType: tx.assetType || '',
    assetTypeName: tx.assetTypeName || '',
    type: (tx.txType === 'P' ? 'B' : tx.txType) || 'B',
    min: tx.amountMin, max: tx.amountMax,
    txdate: toISODate(tx.txDate) || '',
    owner: tx.owner || '',
    conf: typeof tx.confidence === 'number' ? tx.confidence : 1,
    source: tx.source || 'primary',
    filedDate: tx.filedDate || '',
    firstSeenAt: tx.firstSeenAt || '',
    imported: tx.createdAt || '',
    cursorSeq: tx.cursorSeq || 0,
    disclosureLagDays: typeof tx.disclosureLagDays === 'number' ? tx.disclosureLagDays : null,
    stockActStatus: tx.stockActStatus || '',
    // identifiers for the detail drawers (trade / asset / politician)
    id: tx.id || '',
    docId: tx.docId || '',
    filerId: tx.filerId || '',
    isOption: !!tx.isOption,
    rawText: tx.rawText || '',
    // cross-referenced asset reference data (null until the ticker is enriched)
    refSector: tx.refSector || '',
    refMarketCap: tx.refMarketCap != null ? tx.refMarketCap : null,
    refMarketCapBucket: tx.refMarketCapBucket || '',
    refCountry: tx.refCountry || '',
    refExchangeShort: tx.refExchangeShort || '',
    refAssetClass: tx.refAssetClass || '',
    refCompanyName: tx.refCompanyName || '',
    cleaningNote: tx.cleaningNote || ''
  };
}
function rememberTradeRow(row) {
  if (row && row.id) TRADE_BY_ID[row.id] = row;
  return row;
}

/* Per-row ingestion latency: Detection time and extraction latency.
   Only meaningful for live-pipeline (primary) rows. */
function diffSec(aIso, bIso) {
  var a = Date.parse(aIso), b = Date.parse(bIso);
  if (!isFinite(a) || !isFinite(b)) return null;
  return (a - b) / 1000;
}
function rowLatencyHtml(r) {
  if (r.source !== 'primary') return '<span class="muted">—</span>';
  var sti = null, d;
  if (r.firstSeenAt && r.imported) { d = diffSec(r.imported, r.firstSeenAt); if (d != null && d >= 0) sti = d; }
  var parts = [];
  if (r.firstSeenAt) {
    var dt = new Date(Date.parse(r.firstSeenAt));
    if (!isNaN(dt)) {
      var h = dt.getHours(), m = dt.getMinutes();
      var ampm = h >= 12 ? 'pm' : 'am';
      h = h % 12; if (h === 0) h = 12;
      var hm = h + ':' + (m < 10 ? '0' + m : m) + ampm;
      parts.push('detected ' + hm);
    }
  }
  if (sti != null) parts.push('imported ' + fmtDuration(sti) + ' later');
  if (!parts.length) return '<span class="muted" title="Latency unavailable for this primary row">Unavailable</span>';
  return '<span class="muted" style="display:block; line-height:1.4;" title="First detected time and extraction latency for primary rows.">' + parts.map(function(p) { return esc(p); }).join('<br>') + '</span>';
}

function currentPageSize() {
  var n = Number(tradesPageSize);
  return [25, 50, 100, 250].indexOf(n) >= 0 ? n : 50;
}
function syncPageSizeControl() {
  tradesPageSize = currentPageSize();
  setAll('[data-page-size]', function (s) { s.value = String(tradesPageSize); });
}
/* Shared ticker/member/type/chamber/party/date filters, independent of
   paging/since/sort — used by both the bounded page fetch (tradesQueryParams,
   below) and the incremental poll (fetchUpdates) so a poll's "new" rows and
   its total/today counters always match the SAME query the user is currently
   looking at. Before this, fetchUpdates fetched/counted against the whole
   unfiltered corpus regardless of the active Trades filters — a filter chip
   (chamber/party/side) or the ticker/politician fields would visibly narrow
   the page on the next full reload, then silently widen back out on the next
   30s poll (owner report #2: filtering doesn't change the count). */
function tradesFilterParams() {
  var p = new URLSearchParams();
  applySearchToServerParams(p, tradesSearchQuery());
  // Buy/sell/exchange toggle: only filters when exactly one of the three is
  // pressed (multi-select, like the H/S/P chips — nothing on = all types).
  var ty = selectedSideParam('qSideGroup');
  if (ty) p.set('type', ty);
  var ch = chamberParam('qChamber'); if (ch) p.set('chamber', ch);
  var pa = partyParam('qPartyGroup'); if (pa) p.set('party', pa);
  var ac = selectedAssetClass(); if (ac) p.set('assetClass', ac);
  // Owner follow-up batch #21: the $ threshold UI pill is gone (no $/size
  // dropdown on any platform) — minAmount is no longer sent from here. The
  // server still accepts ?minAmount= for direct API consumers.
  var fromEl = el('qFrom'); var from = fromEl && fromEl.value; if (from) p.set('from', from);
  // Shared timeframe → from/to when calendar year (export dialog dates win if set)
  var winEl = el('tradesGlobalWindow') || el('trGlobalWindow');
  var win = winEl && winEl.value;
  if (!from && win === 'this_cy') p.set('from', new Date().getUTCFullYear() + '-01-01');
  if (!from && win === 'last_cy') {
    var y0 = new Date().getUTCFullYear() - 1;
    p.set('from', y0 + '-01-01');
    var toEl2 = el('qTo');
    if (!(toEl2 && toEl2.value)) p.set('to', y0 + '-12-31');
  }
  // Rolling windows: approximate via from for feed (tx_date)
  if (!from && win && /^\\d+d$/.test(win)) {
    var days = parseInt(win, 10);
    if (days > 0 && days < 40000) {
      var d = new Date();
      d.setUTCDate(d.getUTCDate() - days);
      p.set('from', d.toISOString().slice(0, 10));
    }
  }
  var toEl = el('qTo'); var to = toEl && toEl.value; if (to) p.set('to', to);
  return p;
}
function tradesQueryParams() {
  var p = tradesFilterParams();
  p.set('since', '0');
  var apiSort = 'tx_date';
  var apiOrder = 'desc';
  if (sortKey === 'published' || sortKey === 'imported') {
    apiSort = 'published';
    apiOrder = sortDir === -1 ? 'desc' : 'asc';
  } else if (sortKey === 'txdate' || sortKey === 'traded') {
    apiSort = 'tx_date';
    apiOrder = sortDir === -1 ? 'desc' : 'asc';
  }
  p.set('sort', apiSort);
  p.set('order', apiOrder);
  p.set('limit', String(tradesPageSize));
  p.set('offset', String(tradesPage * tradesPageSize));
  return p;
}
function setTradesKpis() {
  // Upper-right match count: always the server total for the active filter
  // set. Never fall back to the current page length (which is often 50/100
  // and was misread as "100 trades" when filters narrowed the corpus).
  var totalEl = el('kpiTotal');
  var todayEl = el('kpiToday');
  if (totalEl) {
    totalEl.textContent = realDataLoaded ? fmtCount(typeof totalRows === 'number' ? totalRows : 0) : '—';
  }
  if (todayEl) {
    todayEl.textContent = realDataLoaded ? fmtCount(filingsImportedToday) : '—';
  }
}
/* Fetch one bounded newest-first feed page. */
function fetchPage() {
  if (loadingPage && tradesAbort) tradesAbort.abort();
  loadingPage = true;
  var seq = ++tradesRequestSeq;
  tradesAbort = typeof AbortController !== 'undefined' ? new AbortController() : null;
  updateTradesCountMsg(TRADES.length);
  // API HOOK: GET /api/transactions?order=desc&limit=<pageSize>&offset=<pageOffset>
  return fetch('/api/transactions?' + tradesQueryParams().toString(), tradesAbort ? { signal: tradesAbort.signal } : undefined)
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function (data) {
      if (seq !== tradesRequestSeq) return 0;
      var txs = (data.transactions || []).map(txToRow);
      txs.forEach(rememberTradeRow);
      TRADES = txs;
      if (typeof data.cursor === 'number' && data.cursor > cursor) cursor = data.cursor;
      if (typeof data.total === 'number') totalRows = data.total;
      if (typeof data.filingsImportedToday === 'number') filingsImportedToday = data.filingsImportedToday;
      tradesGated = !!data.gated;             // freemium: limited recent window
      updateGateRow();
      realDataLoaded = true;
      setBanner('');                       // hide feed-status until a real error
      setTradesKpis();
      renderTrades();
      return txs.length;
    })
    .catch(function (e) {
      if (e && e.name === 'AbortError') return 0;
      if (!realDataLoaded) setBanner('Could not load the live feed: ' + e.message, true);
      return 0;
    })
    .then(function (n) {
      if (seq === tradesRequestSeq) {
        loadingPage = false;
        tradesAbort = null;
        updateTradesCountMsg(TRADES.length);
      }
      return n;
    });
}

/* Initial / full reload: fetches the first page from the current cursor. */
function loadTrades() { syncPageSizeControl(); return fetchPage(); }

function setPageSize(value) {
  var n = Number(value);
  tradesPageSize = [25, 50, 100, 250].indexOf(n) >= 0 ? n : 50;
  try { localStorage.setItem('feed-page-size', String(tradesPageSize)); } catch (e) {}
  tradesPage = 0;
  return fetchPage();
}


function getTrWindow() {
  var sel = document.querySelector('.tr-window-select');
  return sel ? sel.value : '90d';
}
document.addEventListener('change', function(e) {
  if (e.target && e.target.classList && e.target.classList.contains('tr-window-select')) {
    var val = e.target.value;
    document.querySelectorAll('.tr-window-select').forEach(function(s) {
      if (s !== e.target) s.value = val;
    });
    syncFilterUrl();
    loadTrends();
  }
});

function handleTradesTextFilter() {
  tradesPage = 0;
  if (typeof refreshIosFilterSummaries === 'function') refreshIosFilterSummaries();
  renderTrades();
  if (tradesSearchTimer) clearTimeout(tradesSearchTimer);
  tradesSearchTimer = setTimeout(function () { fetchPage(); syncFilterUrl(); }, 250);
}

/* Mirror the feed filters + Trends window into the URL so a refresh or a
   shared link restores them. These params (fq/fty/fpa/fch/fw) are deliberately
   distinct from the deep-link params (?ticker=/?member=/?trade=), which open
   drawers instead of setting filters. */
function syncFilterUrl() {
  try {
    var u = new URL(window.location.href);
    var pairs = [
      ['fq', tradesSearchQuery()],
      // Legacy deep-link keys still cleared when empty
      ['ft', ''],
      ['fm', ''],
      ['fty', selectedSideParam('qSideGroup')],
      ['fpa', partyParam('qPartyGroup')],
      ['fch', chamberParam('qChamber')],
      ['fw', getTrWindow()],
    ];
    pairs.forEach(function (kv) {
      if (kv[1] && !(kv[0] === 'fw' && kv[1] === '90d')) u.searchParams.set(kv[0], kv[1]);
      else u.searchParams.delete(kv[0]);
    });
    window.history.pushState({ view: b.dataset.view }, '', u.pathname + u.search + u.hash);
  } catch (e) {}
}
function restoreFiltersFromUrl() {
  try {
    var sp = new URLSearchParams(window.location.search);
    var fq = sp.get('fq') || [sp.get('fm'), sp.get('ft')].filter(Boolean).join(' ');
    if (fq && el('qSearch')) el('qSearch').value = fq;
    else if (fq && el('qMember')) el('qMember').value = fq;
    var fty = sp.get('fty');
    if (fty) {
      var sides = fty.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      applySideSelection(sides);
      try { localStorage.setItem('shared-sides-v1', JSON.stringify(sides)); } catch (_e) {}
    }
    var fpa = sp.get('fpa');
    if (fpa) {
      var parties = fpa.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      applyPartySelection(parties);
      try { localStorage.setItem('shared-parties-v1', JSON.stringify(parties)); } catch (_e2) {}
    }
    var fch = sp.get('fch');
    if (fch) {
      var sel = fch.split(',');
      ['qChamber', 'trChamber'].forEach(function (gid) {
        var g = el(gid); if (!g) return;
        g.querySelectorAll('.branch-toggle').forEach(function (b) {
          var on = sel.indexOf(b.getAttribute('data-ch')) >= 0;
          b.classList.toggle('on', on);
          b.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
      });
    }
    var fw = sp.get('fw');
    if (fw) {
      document.querySelectorAll('.tr-window-select').forEach(function (s) {
        for (var i = 0; i < s.options.length; i++) {
          if (s.options[i].value === fw) { s.value = fw; break; }
        }
      });
    }
    var dmode = sp.get('dmode') || sp.get('mode');
    if (dmode === 'assets' || dmode === 'people') {
      if (typeof setDirectoryMode === 'function') setDirectoryMode(dmode);
    }
    var dq = sp.get('dq') || sp.get('peopleQ');
    if (dq && el('peopleQ')) {
      el('peopleQ').value = dq;
      if (typeof filterDirectory === 'function') filterDirectory();
    }
  } catch (e) {}
}

function resetTradesPage() { tradesPage = 0; syncFilterUrl(); return fetchPage(); }
function firstTradesPage() {
  if (tradesPage <= 0 || loadingPage) return;
  tradesPage = 0;
  fetchPage();
}
function prevTradesPage() { if (tradesPage <= 0 || loadingPage) return; tradesPage -= 1; fetchPage(); }
/* The server rejects public offsets beyond this depth (see
   MAX_PUBLIC_TX_OFFSET in src/security/botDefense.ts, enforced
   unconditionally in delivery/rest.ts). Interpolated, not hand-copied, so
   the pager can never 400. Deeper history is the Premium CSV export. */
var MAX_PUBLIC_TRADES_OFFSET = ${MAX_PUBLIC_TX_OFFSET};
function nextTradesPage() {
  if (loadingPage) return;
  if ((tradesPage + 1) * tradesPageSize >= totalRows) return;
  if ((tradesPage + 1) * tradesPageSize > MAX_PUBLIC_TRADES_OFFSET) {
    showToast('Deeper history is available with Premium CSV export — use ⤓ Export CSV.');
    return;
  }
  tradesPage += 1;
  fetchPage();
}
function lastTradesPage() {
  if (loadingPage) return;
  var total = totalRows || 0;
  if (total <= 0) return;
  var target = maxReachableTradesPage(total);
  if (target <= tradesPage) {
    if ((target + 1) * tradesPageSize < total) {
      showToast('Deeper history is available with Premium CSV export — use ⤓ Export CSV.');
    }
    return;
  }
  tradesPage = target;
  fetchPage();
}

/* Incremental poll path: fetch only rows newer than the latest cursor and fold
   them into page 1 without changing the user's current page. */
function fetchUpdates() {
  if (loadingPage || tradesPage !== 0) return Promise.resolve(0);
  // API HOOK: GET /api/transactions?since=<cursor>&limit=<pageSize>[&ticker=&memberName=&type=&chamber=&party=&from=&to=]
  // Filtered by the SAME active filters as the main page fetch (fetchPage /
  // tradesQueryParams) — a poll must never surface, or count, rows outside
  // the user's current query. The server recomputes total (and
  // filingsImportedToday) fresh with these same filters on every response
  // that carries new rows (see delivery/rest.ts — omitted, not zero, on a
  // zero-delta poll); we assign them directly rather than incrementing
  // locally so a burst of polls can never drift the displayed total upward
  // (owner report #1: 2535 -> 2635 -> 2735, +page-size on every poll).
  var qp = tradesFilterParams();
  qp.set('since', String(cursor));
  qp.set('limit', String(tradesPageSize));
  return fetch('/api/transactions?' + qp.toString())
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function (data) {
      var txs = (data.transactions || []).map(txToRow);
      if (typeof data.cursor === 'number' && data.cursor > cursor) cursor = data.cursor;
      if (typeof data.total === 'number') totalRows = data.total;
      if (typeof data.filingsImportedToday === 'number') filingsImportedToday = data.filingsImportedToday;
      if (!txs.length) { setTradesKpis(); return 0; }
      txs.forEach(rememberTradeRow);
      txs.reverse();
      TRADES = sortRows(txs.concat(TRADES)).slice(0, tradesPageSize);
      setTradesKpis();
      renderTrades();
      return txs.length;
    })
    .catch(function () { return 0; });
}

/* Live updates. We try SSE first, but the public dashboard does NOT hard-depend
   on it: the /api/stream?subscription=dashboard endpoint isn't available on the
   public site (webhooks/SSE are a future paid feature). If the EventSource
   errors or closes we tear it down (no infinite "reconnecting…") and fall back
   to a calm 30s poll of /api/transactions using the cursor.
   The #livePill text is a genuine status value (not its own label) so it
   never sits inert: "Connecting…" until the stream/poll first starts, "Live"
   once it's actively watching for updates, and a brief "Updated" flash when
   new rows arrive. role=status + aria-live announce those transitions. */
function setLivePill(cls, text) { var p = el('livePill'); if (!p) return; p.className = 'pill ' + cls; p.textContent = text || 'Live'; }

/* Periodic polling fallback. API HOOK: GET /api/transactions?since=<cursor>. */
function startPolling() {
  if (pollTimer) return;          // already polling
  setLivePill('live', 'Live');  // calm state
  pollTimer = setInterval(function () {
    fetchUpdates().then(function (n) {
      if (n > 0) {
        setLivePill('live', 'Updated');
        setTimeout(function () { if (pollTimer) setLivePill('live', 'Live'); }, 1800);
      }
    });
  }, POLL_INTERVAL_MS);
}

function stopStream() {
  if (es) { try { es.close(); } catch (e) {} es = null; }
}

function startStream() {
  // The public site has no live stream yet — go straight to calm polling
  // instead of opening an EventSource that's guaranteed to 404 (see
  // PUBLIC_STREAM_ENABLED above). EventSource is also optional generally;
  // if unavailable, poll immediately.
  if (!PUBLIC_STREAM_ENABLED || typeof EventSource === 'undefined') { startPolling(); return; }
  try {
    es = new EventSource('/api/stream?subscription=dashboard');
    es.onopen = function () { setLivePill('live', 'Live'); };
    // Canonical cross-app event is congress.trade carrying { trades: [...] }
    // (see congress-trading-shared and src/delivery/sse.ts formatTradeEvent).
    es.addEventListener('congress.trade', function (e) {
      try {
        var payload = JSON.parse(e.data);
        var trades = (payload && payload.trades) || [];
        var changed = false;
        // The stream is a shared broadcast — it carries every new trade
        // regardless of which chamber/party/side/ticker/politician THIS
        // visitor is filtered to, so each pushed row must pass the same
        // active-filter check the page's own rows do before it's allowed to
        // touch TRADES or the displayed total (owner report #1/#2: a push
        // used to unshift + increment totalRows unconditionally, both leaking
        // out-of-filter rows into a filtered view and inflating the count).
        var matchesActiveFilters = tradesPage === 0 ? makeTradesFilterMatcher() : null;
        var today = new Date().toISOString().slice(0, 10);
        for (var ti = 0; ti < trades.length; ti++) {
          var tx = trades[ti];
          if (!tx || !tx.id) continue;
          if (tx.cursorSeq && tx.cursorSeq > cursor) cursor = tx.cursorSeq;
          if (tradesPage !== 0) continue;
          var row = txToRow(tx);
          var isNewId = !TRADE_BY_ID[row.id];
          rememberTradeRow(row);
          if (!matchesActiveFilters(row)) continue; // out-of-filter push: doesn't belong in this view
          var alreadyDoc = TRADES.some(function (r) { return r.docId && r.docId === row.docId; });
          TRADES.unshift(row);
          TRADES = sortRows(TRADES).slice(0, tradesPageSize);
          if (isNewId) {
            // De-duped: a redelivered event for a row we already knew about
            // must not bump the total again. A future poll/reload still
            // reconciles against the server's authoritative filtered count.
            if (typeof totalRows === 'number') totalRows += 1;
            if ((row.imported || '').slice(0, 10) === today && row.docId && !alreadyDoc) filingsImportedToday += 1;
          }
          changed = true;
        }
        if (changed) {
          setTradesKpis();
          renderTrades();
          setLivePill('live', 'Updated');
          setTimeout(function () { if (es && es.readyState === 1) setLivePill('live', 'Live'); }, 1800);
        }
      } catch (err) { /* ignore malformed frame */ }
    });
    es.addEventListener('reconnect', function (e) {
      try {
        var msg = JSON.parse(e.data || '{}');
        if (typeof msg.since === 'number' && msg.since > cursor) cursor = msg.since;
      } catch (err) { /* ignore malformed frame */ }
      stopStream();
      startPolling();
    });
    es.onerror = function () {
      // SSE is unavailable (e.g. 404 on the public site). Stop reconnecting and
      // fall back to gentle polling rather than sticking on "reconnecting…".
      stopStream();
      startPolling();
    };
  } catch (err) {
    startPolling();
  }
}

/* Background tabs keep neither the SSE socket nor the 30s poll alive: suspend
   on hidden, resume (with an immediate catch-up fetch) on visible. */
var liveSuspended = false;
document.addEventListener('visibilitychange', function () {
  if (document.hidden) {
    liveSuspended = !!(es || pollTimer);
    stopStream();
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  } else if (liveSuspended) {
    liveSuspended = false;
    fetchUpdates();
    startStream();
  }
});

/* ============================ REVIEW ============================ */
var REVIEW_RESOLVED = 0; // 0 = pending tab, 1 = reviewed/history tab
function setTabBadge(id, value) {
  var node = el(id);
  if (!node) return;
  var n = Number(value) || 0;
  if (n <= 0) {
    node.hidden = true;
    node.textContent = '';
    node.classList.remove('is-on');
    return;
  }
  node.hidden = false;
  node.classList.add('is-on');
  node.textContent = n > 99 ? '99+' : String(n);
}
function renderExtractionIncident(health, autopilot) {
  var admin = canUseAdmin();
  var checks = (health && health.pipeline && health.pipeline.checks) || [];
  var halt = checks.filter(function (c) { return c.id === 'autopilot_halt'; })[0];
  var backlog = checks.filter(function (c) { return c.id === 'extraction_backlog'; })[0];
  var provider = checks.filter(function (c) { return c.id === 'extraction_provider'; })[0];
  var halted = !!(halt && halt.status && halt.status !== 'ok');
  var stalledExtract = !!(provider && provider.status === 'stalled' && halted);
  var review = (health && health.pipeline && health.pipeline.reviewQueue)
    || (autopilot && autopilot.reviewQueue)
    || null;
  var unresolved = review ? Number(review.unresolved || 0) : (backlog && backlog.value) || 0;
  // 2026-09-21 owner ask: surface filing_skips / fmp_latency / price_freshness
  // prominently. These three checks are the ones that page the operator via
  // Pushover — they MUST also be visible in the dashboard so the admin tab
  // badge isn't the only signal. Use the existing pipeline.signals payload
  // (added in this branch) for the structured detail. Guarded with
  // typeof so unit tests that extract only renderExtractionIncident don't
  // ReferenceError.
  if (typeof renderOwnerHealthBanner === 'function') {
    try { renderOwnerHealthBanner(health && health.pipeline, admin); }
    catch (err) { console.warn('ownerHealthBanner render failed', err); }
  }
  setTabBadge('reviewTabBadge', admin ? unresolved : 0);
  // admin tab badge fires for the same classes the liveness-alarm sweep
  // pages on — filing_skips / fmp_latency / price_freshness critical +
  // the existing autopilot_halt. extraction_provider stalled alone is
  // not badge-worthy (its banner already shows in the owner banner); the
  // OWNER's pre-existing semantics (board a888f403 #2527) keeps it quiet
  // unless the autopilot is also halted.
  var crit = checks.filter(function (c) {
    if (!(c.status === 'critical' || c.status === 'stalled')) return false;
    if (c.id === 'extraction_provider') return false; // not badge-worthy alone
    return true;
  });
  setTabBadge('adminTabBadge', admin && (halted || crit.length > 0) ? 1 : 0);
}

/**
 * Owner 2026-09-21 ask: a big, unmissable red banner whenever a filing is
 * skipped/empty/blank/unreadable ("almost always an app error"), or when
 * FMP latency is silent for >3h, or when the S&P price cache is past the
 * critical threshold. The banner is visible on the dashboard home view
 * for all signed-in admins, NOT only inside the Admin tab. Tapping it
 * navigates to the Admin tab + jumps to the relevant row in the source
 * health card.
 *
 * The banner uses the new pipeline.signals payload (added in this branch)
 * so the operator sees the exact dates and counts without a second query.
 */
function renderOwnerHealthBanner(pipeline, admin) {
  var banner = el('ownerHealthBanner');
  if (!banner) return;
  if (!admin || !pipeline) { banner.innerHTML = ''; banner.style.display = 'none'; banner.setAttribute('hidden', ''); return; }
  var checks = pipeline.checks || [];
  var signals = pipeline.signals || {};
  var rows = [];
  // filing_skips — almost always app error
  var fs = checks.filter(function (c) { return c.id === 'filing_skips'; })[0];
  if (fs && (fs.status === 'critical' || fs.status === 'stalled')) {
    var fsV = (fs.value && fs.value.byAction) || {};
    var fsBreakdown = Object.keys(fsV).filter(function (k) { return fsV[k] > 0; })
      .map(function (k) { return k.replace(/_/g, ' ') + ': ' + fsV[k]; }).join(' · ');
    rows.push('<div class="owner-alert-row owner-alert-red">' +
      '<span class="owner-alert-icon">⚠</span>' +
      '<span class="owner-alert-title">FILING SKIPS — almost always app error</span>' +
      '<span class="owner-alert-detail">' + esc(fs.detail || '') +
        (fsBreakdown ? ' · ' + esc(fsBreakdown) : '') + '</span>' +
    '</div>');
  }
  // price_freshness — EOD / S&P perf delay
  var pf = checks.filter(function (c) { return c.id === 'price_freshness'; })[0];
  if (pf && (pf.status === 'critical' || pf.status === 'stalled')) {
    var legs = (pf.value && pf.value.legs) || {};
    var legsStr = Object.keys(legs).map(function (k) {
      return k + ' = ' + (legs[k].date || '?') + ' (' + (legs[k].behind || 0) + 'd behind)';
    }).join(' · ');
    rows.push('<div class="owner-alert-row owner-alert-orange">' +
      '<span class="owner-alert-icon">⏱</span>' +
      '<span class="owner-alert-title">PRICE / INDEX FRESHNESS — current price and excess numbers are stale</span>' +
      '<span class="owner-alert-detail">' + esc(pf.detail || '') +
        (legsStr ? ' · ' + esc(legsStr) : '') +
        ' · recover via POST /admin/recover-pipeline' + '</span>' +
    '</div>');
  }
  // fmp_latency — silent probe or high 429 rate
  var fp = checks.filter(function (c) { return c.id === 'fmp_latency'; })[0];
  if (fp && (fp.status === 'critical' || fp.status === 'stalled' || fp.status === 'degraded')) {
    var f429 = (fp.value && fp.value.http429s24h != null) ? fp.value.http429s24h + ' HTTP 429s in 24h' : '';
    var obs = (fp.value && fp.value.observationCount24h != null) ? fp.value.observationCount24h + ' obs/24h' : '';
    rows.push('<div class="owner-alert-row owner-alert-orange">' +
      '<span class="owner-alert-icon">⏱</span>' +
      '<span class="owner-alert-title">FMP LATENCY PROBE — key rotation / network outage?</span>' +
      '<span class="owner-alert-detail">' + esc(fp.detail || '') +
        (f429 ? ' · ' + esc(f429) : '') +
        (obs ? ' · ' + esc(obs) : '') +
      '</span></div>');
  }
  if (rows.length === 0) {
    banner.innerHTML = '';
    banner.style.display = 'none';
    banner.setAttribute('hidden', '');
    return;
  }
  banner.innerHTML = rows.join('');
  banner.style.display = 'block';
  banner.removeAttribute('hidden');
}
function loadExtractionIncident() {
  if (!canUseAdmin()) {
    renderExtractionIncident(null, null);
    return Promise.resolve();
  }
  return fetch('/api/health')
    .then(function (r) { return r.json(); })
    .then(function (health) {
      return fetch('/api/admin/autopilot/status', { headers: adminHeaders() })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (autopilot) {
          renderExtractionIncident(health, autopilot);
          return health;
        })
        .catch(function () {
          renderExtractionIncident(health, null);
          return health;
        });
    })
    .catch(function () { /* health read is best-effort */ });
}
function setReviewTab(resolved) {
  REVIEW_RESOLVED = resolved ? 1 : 0;
  var p = el('revTabPending'), rv = el('revTabReviewed');
  if (p) p.className = 'btn sm' + (REVIEW_RESOLVED ? ' ghost' : '');
  if (rv) rv.className = 'btn sm' + (REVIEW_RESOLVED ? '' : ' ghost');
  loadReview();
}
function loadReview() {
  if (!canUseAdmin()) {
    REVIEW = [];
    REVIEW_TOTALS = null;
    if (el('reviewTabBadge')) { el('reviewTabBadge').hidden = true; el('reviewTabBadge').textContent = ''; el('reviewTabBadge').classList.remove('is-on'); }
    if (el('kpiReview')) el('kpiReview').textContent = '—';
    return Promise.resolve();
  }
  // API HOOK: GET /api/admin/review-queue?resolved=
  return fetch('/api/admin/review-queue?resolved=' + REVIEW_RESOLVED, { headers: adminHeaders() })
    .then(okOrThrow)
    .then(function (data) { REVIEW = data.items || []; REVIEW_TOTALS = data.totals || null; renderReview(); loadDecisionHistory(); })
    .catch(function (e) {
      el('reviewBody').innerHTML = stateRow(6, isAuthError(e) ? ADMIN_MOVED_MSG : ('Could not load review queue: ' + e.message));
    });
}
function loadDecisionHistory() {
  // API HOOK: GET /api/admin/ingestion-decisions
  return fetch('/api/admin/ingestion-decisions?limit=200', { headers: adminHeaders() })
    .then(okOrThrow)
    .then(function (data) {
      DECISIONS = data.items || [];
      renderDecisionHistory(data.available !== false);
    })
    .catch(function (e) {
      var body = el('decisionBody');
      if (body) body.innerHTML = stateRow(6, isAuthError(e) ? ADMIN_MOVED_MSG : ('Could not load decision history: ' + e.message));
    });
}
function decisionActionLabel(action) {
  return String(action || '').replace(/_/g, ' ');
}
function decisionRowsText(d) {
  var ids = d && Array.isArray(d.transactionIds) ? d.transactionIds : [];
  if (!ids.length) return '—';
  return ids.length + ' row' + (ids.length === 1 ? '' : 's');
}
function decisionReasonText(d) {
  var reason = d && d.reason ? String(d.reason) : '';
  var payload = d && d.payload && typeof d.payload === 'object' ? d.payload : null;
  var bits = [];
  if (reason) bits.push(reason.replace(/_/g, ' '));
  if (payload && typeof payload.minConfidence === 'number') bits.push('conf ' + Math.round(payload.minConfidence * 100) + '%');
  if (payload && typeof payload.inserted === 'number') bits.push('inserted ' + payload.inserted);
  if (payload && typeof payload.deprecatedPredecessors === 'number' && payload.deprecatedPredecessors > 0) {
    bits.push('superseded ' + payload.deprecatedPredecessors + ' original');
  }
  if (payload && typeof payload.deprecatedTransactions === 'number') bits.push('retracted ' + payload.deprecatedTransactions);
  return bits.join(' · ') || '—';
}
function decisionDocHtml(d) {
  var docId = d.docId || '';
  var url = reviewDocUrl(d);
  if (!url) return '<span class="tkr">' + esc(docId) + '</span>';
  // Same stored-copy path as the Review Queue — never government sourceUrl.
  return '<a class="tkr review-stored-doc" href="' + esc(url) + '" data-doc-id="' + esc(docId) + '" target="_blank" rel="noopener noreferrer" title="Open stored filing document">' + esc(docId) + '</a>';
}
function renderDecisionHistory(available) {
  var body = el('decisionBody');
  if (!body) return;
  if (!available) {
    body.innerHTML = stateRow(6, 'Decision history is not migrated yet.');
    return;
  }
  if (!DECISIONS.length) {
    body.innerHTML = stateRow(6, 'No decisions recorded yet.');
    return;
  }
  body.innerHTML = DECISIONS.map(function (d) {
    return '<tr class="row">' +
      '<td class="muted">' + esc(dateTimeText(d.createdAt)) + '</td>' +
      '<td>' + decisionDocHtml(d) + '</td>' +
      '<td>' + statusBadge(decisionActionLabel(d.action)) + '</td>' +
      '<td class="muted">' + esc([d.source || '', d.actor || ''].filter(Boolean).join(' · ')) + '</td>' +
      '<td class="muted" style="max-width:320px">' + esc(decisionReasonText(d)) + '</td>' +
      '<td class="muted">' + esc(decisionRowsText(d)) + '</td>' +
    '</tr>';
  }).join('');
}
/* Translate review reason codes + payload into plain English for non-engineers. */
var REASON_LABELS = {
  low_confidence: 'Automated read below publish threshold',
  no_transactions_extracted: 'No transactions could be read from the document',
  unresolved_ticker: 'Asset symbol could not be matched to a known company',
  invalid_bracket: 'Dollar amount didn’t match a standard disclosure range',
  no_amount: 'No dollar amount could be read',
  invalid_amount: 'Dollar amount looked malformed (couldn’t be read as a range)',
  future_tx_date: 'Trade date is in the future',
  tx_after_filed_date: 'Trade date is after the filing stamp',
  bad_tx_type: 'Transaction type was unclear (not buy / sell / exchange)'
};
function parseReviewPayload(payload) {
  if (payload == null) return null;
  try {
    var p = typeof payload === 'string' ? JSON.parse(payload) : payload;
    return p && typeof p === 'object' ? p : null;
  } catch (e) {
    return null;
  }
}
function reasonText(reason, payload) {
  if (!reason) return 'Needs a human check';
  var codes = String(reason).split(',').map(function (c) { return c.trim(); }).filter(Boolean);
  var p = parseReviewPayload(payload);
  var extractor = p && p.extractor ? String(p.extractor) : '';
  if (codes.length === 1 && codes[0] === 'low_confidence' && /vision/i.test(extractor)) {
    return 'Vision-read filing held for review';
  }
  return codes.map(function (c) {
    c = c.trim(); return REASON_LABELS[c] || c.replace(/_/g, ' ');
  }).filter(Boolean).join('; ');
}
function payloadText(payload) {
  var p = parseReviewPayload(payload);
  if (p == null) return payload == null ? '' : String(payload);
  if (typeof p !== 'object') return String(payload);
  var bits = [];
  var txs = p.transactions || [];
  if (!txs.length) {
    bits.push('No readable transactions');
  } else if (typeof p.minConfidence === 'number') {
    bits.push('Confidence ' + Math.round(p.minConfidence * 100) + '%');
  }
  if (txs.length) {
    bits.push(txs.length + ' transaction' + (txs.length === 1 ? '' : 's'));
    var t0 = txs[0] || {};
    var label = cleanAsset(t0.ticker || t0.assetName || '');
    if (label) bits.push('e.g. ' + label + (typeName[t0.txType] ? ' (' + typeName[t0.txType] + ')' : ''));
  }
  return bits.join(' · ');
}
function reviewPayloadTransactions(payload) {
  var p = parseReviewPayload(payload);
  var txs = p && Array.isArray(p.transactions) ? p.transactions : [];
  return txs.map(function (t) { return normalizeReviewEdit(t, 'queued review payload'); });
}
function normalizeReviewEdit(t, sourceLabel) {
  t = t || {};
  var ticker = cleanAsset(t.ticker || '').toUpperCase();
  var asset = cleanAsset(t.assetName || t.asset || '');
  var type = String(t.txType || t.type || '').toUpperCase();
  if (type === 'P') type = 'B'; // legacy Purchase letter → storage B
  if (type !== 'B' && type !== 'S' && type !== 'E') type = null;
  var owner = String(t.owner || '').toLowerCase();
  if (['self', 'spouse', 'joint', 'dependent'].indexOf(owner) < 0) owner = null;
  function n(v) {
    if (v == null || v === '') return null;
    var x = Number(v);
    return Number.isFinite(x) ? x : null;
  }
  return {
    ticker: ticker || null,
    assetName: asset || ticker || '',
    txType: type,
    amountMin: n(t.amountMin),
    amountMax: n(t.amountMax),
    txDate: String(t.txDate || '').slice(0, 10) || null,
    owner: owner,
    assetType: cleanAsset(t.assetType || ''),
    assetTypeName: cleanAsset(t.assetTypeName || ''),
    isOption: Boolean(t.isOption),
    capGainsOver200: Boolean(t.capGainsOver200),
    filingStatus: t.filingStatus == null ? null : String(t.filingStatus),
    subholding: t.subholding == null ? null : String(t.subholding),
    location: t.location == null ? null : String(t.location),
    description: t.description == null ? null : String(t.description),
    supplementalText: t.supplementalText == null ? null : String(t.supplementalText),
    confidence: t.confidence == null ? null : n(t.confidence),
    rawText: String(t.rawText || sourceLabel || 'review editor')
  };
}
function txPublishLabel(t) {
  t = normalizeReviewEdit(t, 'review row');
  var asset = cleanAsset(t.assetName || '');
  var ticker = cleanAsset(t.ticker || '');
  var primary = ticker && asset && asset !== ticker ? ticker + ' · ' + asset : (ticker || asset || 'Unnamed asset');
  var meta = [];
  if (t.txType) meta.push(typeName[t.txType] || t.txType);
  if (t.txDate) meta.push(t.txDate);
  if (t.amountMin != null || t.amountMax != null) meta.push(amountText(t.amountMin, t.amountMax));
  if (t.owner) meta.push('owner ' + t.owner);
  if (t.assetType) meta.push(assetTypeLabel(t.assetType));
  if (t.isOption) meta.push('option');
  if (t.capGainsOver200) meta.push('cap gains > $200');
  return primary + (meta.length ? ' - ' + meta.join(' · ') : '');
}
function publishRowsHtml(rows, opts) {
  rows = (rows || []).map(function (t) { return normalizeReviewEdit(t, 'review row'); }).filter(function (t) { return t.ticker || t.assetName; });
  var max = opts && opts.max ? opts.max : 3;
  var title = (opts && opts.title) || 'Rows Ready To Review';
  if (!rows.length) {
    return '<div class="filing-note" style="margin-top:6px"><strong>' + esc(title) + '</strong><br />No rows. Use Manual or Reject.</div>';
  }
  var html = rows.slice(0, max).map(function (t, i) {
    return '<div>Row ' + (i + 1) + ': ' + esc(txPublishLabel(t)) + '</div>';
  }).join('');
  if (rows.length > max) html += '<div>+' + (rows.length - max) + ' more row' + (rows.length - max === 1 ? '' : 's') + '</div>';
  return '<div class="filing-note" style="margin-top:6px"><strong>' + esc(title) + '</strong><br />' + html + '</div>';
}
function safeDocUrl(url) {
  if (!url) return '';
  try {
    var u = new URL(String(url), window.location.origin);
    return (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : '';
  } catch (e) {
    return '';
  }
}
/* Owner 2026-08-10 (+ follow-up): Review Queue + Filing Decisions must open
   OUR stored R2 copy — never House Clerk / Senate eFD / OGE source URLs.
   Use the admin stored-raw route (auth via session allowlist OR ADMIN_TOKEN).
   Plain <a href> cannot send the bearer from localStorage, so clicks are
   handled by openStoredFiling() which fetches with adminHeaders() and opens
   a blob URL. href stays set for accessibility / middle-click fallbacks. */
function storedFilingHref(docId) {
  var id = String(docId || '').trim();
  if (!id) return '';
  return '/api/admin/filings/' + encodeURIComponent(id) + '/raw';
}
function reviewDocUrl(r) {
  // Always prefer stored admin path when we have a doc id. Never government sourceUrl.
  return storedFilingHref(r && (r.docId || r.doc_id));
}
function reviewStoredDocAttrs(docId, url) {
  return 'class="review-stored-doc" href="' + esc(url) + '" data-doc-id="' + esc(docId) +
    '" target="_blank" rel="noopener noreferrer" title="Open stored filing document"';
}
function reviewDocHtml(r) {
  var docId = r.docId || '';
  var url = reviewDocUrl(r);
  var idHtml = '<span class="tkr">' + esc(docId) + '</span>';
  if (!url) return idHtml;
  return '<a class="tkr" ' + reviewStoredDocAttrs(docId, url) + '>' + esc(docId) + '</a>' +
    '<a class="review-doc-link" ' + reviewStoredDocAttrs(docId, url) + '>View Document</a>';
}
function openStoredFiling(docId) {
  var id = String(docId || '').trim();
  if (!id) return;
  var url = storedFilingHref(id);
  // credentials:include so Google session cookies reach admin auth for allowlisted emails.
  fetch(url, { headers: adminHeaders(), credentials: 'include' })
    .then(function (r) {
      if (r.status === 401 || r.status === 403) {
        throw new Error('Admin access required — sign in with an account that has admin access.');
      }
      if (r.status === 404) {
        throw new Error('Stored copy not available for ' + id + ' (not fetched into R2 yet).');
      }
      if (!r.ok) throw new Error('Could not open stored filing (HTTP ' + r.status + ')');
      var ct = r.headers.get('content-type') || 'application/pdf';
      return r.blob().then(function (blob) {
        return { blob: blob, ct: ct };
      });
    })
    .then(function (o) {
      var typed = o.blob && o.blob.type ? o.blob : new Blob([o.blob], { type: o.ct });
      var objUrl = URL.createObjectURL(typed);
      var w = window.open(objUrl, '_blank', 'noopener');
      if (!w) {
        // Popup blocked — navigate this tab as last resort (still our origin blob).
        window.location.href = objUrl;
      }
      setTimeout(function () { try { URL.revokeObjectURL(objUrl); } catch (e) {} }, 120000);
    })
    .catch(function (e) {
      showToast(e && e.message ? e.message : 'Could not open stored filing', true);
    });
}
document.addEventListener('click', function (e) {
  if (!e || !e.target || !e.target.closest) return;
  var a = e.target.closest('a.review-stored-doc');
  if (!a) return;
  var docId = a.getAttribute('data-doc-id') || '';
  if (!docId) return;
  // Let modified clicks (new tab with modifier) still go through default only
  // if the href is same-origin admin raw — but bearer won't attach. Always
  // intercept primary click so the admin token path works.
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button === 1) return;
  e.preventDefault();
  openStoredFiling(docId);
});
/* Coloured status pill for a review document. */
var STATUS_COLORS = { pending: '#b08900', published: '#1a7f37', rejected: '#c0362c', modified: '#6f42c1', resolved: '#57606a', verified_empty: '#0969da', unverified_empty: '#c0362c', orphan_deleted: '#57606a' };
function statusBadge(status) {
  var s = status || 'pending';
  var c = STATUS_COLORS[s] || '#57606a';
  return '<span style="display:inline-block;padding:1px 7px;border-radius:10px;font-size:11px;font-weight:600;color:#fff;background:' + c + '">' + esc(s) + '</span>';
}
/* Server-injected model catalog: serialized from benchmarkSelectableCatalog()
   (DEFAULT_CANDIDATES + LlamaParse — excludes decode-only LEGACY_CANDIDATES and
   NON_OFFERED_CANDIDATES) when this module is built, so every model menu in the
   dashboard — the "Re-read with model…" multi-select, the per-row quick-run
   select, and the Custom Model Selection checkbox grid — only ever offers
   models Jay actually holds a key for, and derives from the ONE backend source
   of truth instead of a hand-maintained copy. */
var BENCHMARK_CATALOG = ${JSON.stringify(benchmarkSelectableCatalog())};
var REREAD_MODELS = BENCHMARK_CATALOG;
/* <optgroup> per provider for the "Re-read with model…" multi-select. */
function rereadModelOptionsHtml() {
  var byProvider = {};
  var order = [];
  REREAD_MODELS.forEach(function (m) {
    if (!byProvider[m.provider]) { byProvider[m.provider] = []; order.push(m.provider); }
    byProvider[m.provider].push(m);
  });
  return order.map(function (p) {
    var opts = byProvider[p].map(function (m) {
      return '<option value="' + esc(p + '|' + m.model) + '">' + esc(m.model) + '</option>';
    }).join('');
    return '<optgroup label="' + esc(p) + '">' + opts + '</optgroup>';
  }).join('');
}
function benchmarkModelCheckboxesHtml() {
  return REREAD_MODELS.map(function(m) {
    var id = 'chk_' + m.provider + '_' + m.model.replace(/[^a-zA-Z0-9_-]/g, '_');
    var val = esc(m.provider + '|' + m.model);
    return '<label style="display:flex; align-items:center; gap:4px; font-size:12px; cursor:pointer;" title="' + esc(m.model) + '">' +
           '<input type="checkbox" name="benchmark_model" value="' + val + '" checked> ' +
           '<span style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">' + esc(m.provider) + ': ' + esc(m.model) + '</span></label>';
  }).join('');
}
/* Visible model id for Review Queue chips/table. Provider (e.g. openrouter)
   is a transport, not a model — never render it as the chip label. */
function reviewModelDisplayName(m) {
  var model = m && typeof m.model === 'string' ? String(m.model).trim() : '';
  if (!model || model.toLowerCase() === 'openrouter') return 'unknown model';
  return model;
}
/* One-line per-model confidence chips for the row (full readings load on demand). */
function modelsSummaryHtml(models) {
  if (!models || !models.length) return '<span class="muted">—</span>';
  return models.map(function (m) {
    var conf = (typeof m.avgConfidence === 'number') ? Math.round(m.avgConfidence * 100) + '%' : '—';
    var modelName = reviewModelDisplayName(m);
    var provider = m && m.provider ? String(m.provider) : '';
    var label = provider ? provider + ':' + modelName : modelName;
    var color = m.ok ? '#1a7f37' : '#c0362c';
    var title = label + ' · ' + (m.ok ? (m.rowCount + ' rows, conf ' + conf + (m.latencyMs ? ', ' + fmtMs(m.latencyMs) : '')) : ('ERROR: ' + (m.error || 'failed')));
    return '<span title="' + esc(title) + '" style="display:inline-block;margin:1px 3px 1px 0;padding:0 5px;border-radius:8px;font-size:11px;border:1px solid ' + color + ';color:' + color + '">' +
      esc(modelName) + ' ' + (m.ok ? esc(conf) : 'ERR') + '</span>';
  }).join('');
}
function renderReview() {
  var body = el('reviewBody');
  var unresolvedTotal = REVIEW_TOTALS && typeof REVIEW_TOTALS.unresolved === 'number' ? REVIEW_TOTALS.unresolved : REVIEW.length;
  if (canUseAdmin()) setTabBadge('reviewTabBadge', unresolvedTotal);
  if (el('kpiReview') && REVIEW_RESOLVED === 0) el('kpiReview').textContent = fmtCount(unresolvedTotal);
  if (REVIEW.length === 0) {
    body.innerHTML = stateRow(6, REVIEW_RESOLVED ? 'No reviewed documents yet.' : 'Nothing awaiting review — queue is clear.');
    return;
  }
  body.innerHTML = REVIEW.map(function (r) {
    var payload = payloadText(r.payload);
    var queuedRows = reviewPayloadTransactions(r.payload);
    var url = reviewDocUrl(r);
    var docAction = url
      ? '<a class="review-doc-link inline" ' + reviewStoredDocAttrs(r.docId, url) + '>Document</a>'
      : '';
    var nModels = (r.models && r.models.length) || 0;
    var modelsBtn = '<button class="btn ghost sm" onclick="toggleModels(\\'' + esc(r.docId) + '\\')">Bake-Off Runs (' + nModels + ')</button>';
    var retryAutoBtn = r.agreementSuppressedAt
      ? '<button class="btn ghost sm" onclick="retryReviewAuto(\\'' + esc(r.docId) + '\\')">Retry Auto</button> '
      : '';
    var reopenable = r.status === 'published' || r.status === 'modified'
      || r.status === 'verified_empty' || r.status === 'unverified_empty';
    var reopenLabel = r.status === 'verified_empty' || r.status === 'unverified_empty' ? 'Reopen' : 'Unpublish';
    var actions = REVIEW_RESOLVED
      ? (reopenable
          ? '<button class="btn ghost sm" onclick="resolveReview(\\'' + esc(r.docId) + '\\',\\'unpublish\\')">' + reopenLabel + '</button> ' : '') + modelsBtn
      : '<button class="btn sm" onclick="openQueuedReviewEditor(\\'' + esc(r.docId) + '\\')">Review / Confirm</button> ' +
        '<button class="btn ghost sm" onclick="manualEntry(\\'' + esc(r.docId) + '\\')">Manual</button> ' +
        '<button class="btn ghost sm" onclick="resolveReview(\\'' + esc(r.docId) + '\\',\\'reject\\')">Reject</button> ' + retryAutoBtn + modelsBtn +
        '<div style="margin-top: 8px; display: flex; align-items: center; gap: 4px;">' +
          '<select id="quick-run-' + esc(r.docId) + '" style="max-width: 130px; font-size: 11px;">' + quickRunModelOptionsHtml() + '</select>' +
          '<button class="btn ghost sm" id="quick-btn-' + esc(r.docId) + '" onclick="quickRunModel(\\'' + esc(r.docId) + '\\')">Run Model</button>' +
        '</div>' +
        '<div id="quick-msg-' + esc(r.docId) + '" class="note" style="margin-top: 2px;"></div>';
    return '<tr class="row" id="rv-' + esc(r.docId) + '">' +
      '<td class="muted">' + esc(dateTimeText(r.createdAt)) + '</td>' +
      '<td>' + reviewDocHtml(r) + '</td>' +
      '<td>' + statusBadge(r.status) + '</td>' +
      '<td class="muted">' + esc(reasonText(r.reason, r.payload)) + '<div style="margin-top:3px">' + modelsSummaryHtml(r.models) + '</div></td>' +
      '<td class="muted" style="max-width:360px">' + esc(payload) + publishRowsHtml(queuedRows, { max: 2, title: 'Queued Extracted Rows' }) + docAction + '</td>' +
      '<td>' + actions + '</td>' +
    '</tr>';
  }).join('');
}
/* Expand/collapse a per-document model-comparison panel beneath its row. */
function toggleModels(docId) {
  var existing = el('mdl-' + docId);
  if (existing) { existing.parentNode.removeChild(existing); return; }
  var rowEl = el('rv-' + docId);
  if (!rowEl) return;
  var item = null;
  for (var i = 0; i < REVIEW.length; i++) { if (REVIEW[i].docId === docId) { item = REVIEW[i]; break; } }
  var models = (item && item.models) || [];
  var head = '<tr id="mdl-' + esc(docId) + '"><td colspan="6" style="background:rgba(127,127,127,.06)">' +
    '<div style="padding:6px 4px"><strong>Per-model bake-off readings</strong> ' +
    '<button class="btn ghost sm" onclick="viewReadings(\\'' + esc(docId) + '\\')">Load Full Readings</button>' +
    '<div class="note">Queued extracted rows come from the primary extraction pipeline. Bake-off runs are optional stored model comparisons; load one here only if you want to use that model\\'s rows instead.</div>' +
    rereadControlHtml(docId) +
    '<div id="mdlBody-' + esc(docId) + '" style="margin-top:6px">' + modelsTableHtml(models) + '</div></div>' +
    '</td></tr>';
  rowEl.insertAdjacentHTML('afterend', head);
}
/* "Re-read with model…" control: pick 1-3 provider/model pairs and re-run the
   bake-off for just this doc (persisted), then refresh its runs display. */
function rereadControlHtml(docId) {
  return '<div class="row-flex" style="margin-top:6px">' +
    '<label class="lbl">Re-read with model&hellip;</label>' +
    '<select id="reread-sel-' + esc(docId) + '" multiple size="4" style="min-width:220px">' + rereadModelOptionsHtml() + '</select>' +
    '<button class="btn ghost sm" id="reread-btn-' + esc(docId) + '" onclick="rereadWithModel(\\'' + esc(docId) + '\\')">Run</button>' +
    '<span id="reread-msg-' + esc(docId) + '" class="note"></span>' +
    '</div>';
}
function rereadWithModel(docId) {
  var sel = el('reread-sel-' + docId);
  var msg = el('reread-msg-' + docId);
  var btn = el('reread-btn-' + docId);
  if (!sel || !btn) return;
  var chosen = [];
  for (var i = 0; i < sel.options.length; i++) {
    if (sel.options[i].selected) {
      var parts = sel.options[i].value.split('|');
      chosen.push({ provider: parts[0], model: parts[1] });
    }
  }
  if (chosen.length === 0) { if (msg) msg.textContent = 'Select at least one model.'; return; }
  btn.disabled = true; sel.disabled = true;
  if (msg) msg.textContent = 'Running ' + chosen.length + ' model' + (chosen.length === 1 ? '' : 's') + '…';
  fetch('/api/admin/bakeoff', {
    method: 'POST', headers: adminHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ docIds: [docId], models: chosen, persist: true })
  })
    .then(function (r) {
      if (r.status === 401 || r.status === 403) { var ae = new Error(ADMIN_MOVED_MSG); ae.isAuth = true; throw ae; }
      return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; });
    })
    .then(function (data) {
      btn.disabled = false; sel.disabled = false;
      var tested = (typeof data.docsTested === 'number') ? data.docsTested : 1;
      if (msg) msg.textContent = tested > 0 ? 'Re-read complete.' : ('No documents were re-read' + ((data.skipped || []).length ? (': ' + data.skipped[0]) : '.'));
      viewReadings(docId); // refresh this doc's runs display with the new reading(s)
    })
    .catch(function (e) {
      btn.disabled = false; sel.disabled = false;
      if (msg) msg.textContent = isAuthError(e) ? ADMIN_MOVED_MSG : ('Re-read failed: ' + e.message);
    });
}
function modelsTableHtml(models) {
  if (!models || !models.length) return '<span class="muted">No bake-off model runs stored for this document. The prefilled rows can still come from the queued extraction payload.</span>';
  var rows = models.map(function (m) {
    var conf = (typeof m.avgConfidence === 'number') ? Math.round(m.avgConfidence * 100) + '%' : '—';
    var modelName = reviewModelDisplayName(m);
    var provider = m && m.provider ? String(m.provider) : '';
    var modelCell = esc(modelName) + (provider ? '<div class="muted">' + esc(provider) + '</div>' : '');
    return '<tr><td>' + modelCell + '</td><td>' + esc(m.kind || '') + '</td>' +
      '<td>' + (m.ok ? 'ok' : '<span style="color:#c0362c">ERR</span>') + '</td>' +
      '<td style="text-align:right">' + (m.ok ? m.rowCount : '—') + '</td>' +
      '<td style="text-align:right">' + (m.ok ? esc(conf) : '—') + '</td>' +
      '<td style="text-align:right">' + fmtMs(m.latencyMs) + '</td>' +
      (m.error ? '<td class="muted">' + esc(String(m.error).slice(0, 80)) + '</td>' : '<td></td>') + '</tr>';
  }).join('');
  return '<table style="font-size:12px;width:100%"><thead><tr><th>Model</th><th>Kind</th><th>OK</th><th style="text-align:right">Rows</th><th style="text-align:right">Conf</th><th style="text-align:right">Latency</th><th>Error</th></tr></thead><tbody>' + rows + '</tbody></table>';
}

function quickRunModelOptionsHtml() {
  return '<option value="">-- Choose Model --</option>' + REREAD_MODELS.map(function (m) {
    return '<option value="' + esc(m.provider + '|' + m.model) + '">' + esc(m.model) + '</option>';
  }).join('');
}

function quickRunModel(docId) {
  var sel = el('quick-run-' + docId);
  var msg = el('quick-msg-' + docId);
  var btn = el('quick-btn-' + docId);
  if (!sel || !btn) return;
  var val = sel.value;
  if (!val) { if (msg) msg.textContent = 'Select a model first.'; return; }
  var parts = val.split('|');
  var chosen = [{ provider: parts[0], model: parts[1] }];
  
  btn.disabled = true; sel.disabled = true;
  if (msg) msg.textContent = 'Running ' + parts[1] + '...';
  
  fetch('/api/admin/bakeoff', {
    method: 'POST', headers: adminHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ docIds: [docId], models: chosen, persist: true })
  })
    .then(function (r) {
      if (r.status === 401 || r.status === 403) { var ae = new Error(ADMIN_MOVED_MSG); ae.isAuth = true; throw ae; }
      return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; });
    })
    .then(function (data) {
      if (msg) msg.textContent = 'Complete. Reloading queue...';
      setTimeout(loadReview, 500); // Reload queue to show the new run
    })
    .catch(function (e) {
      btn.disabled = false; sel.disabled = false;
      if (msg) msg.textContent = isAuthError(e) ? ADMIN_MOVED_MSG : ('Run failed: ' + e.message);
    });
}

/* Field order + labels mirror ConsensusFieldName in extraction/consensus.ts.
   Structured filing details stay visible because ignoring them can make two
   materially different rows appear unanimous. */
var CONSENSUS_FIELD_ORDER = [
  'ticker', 'txType', 'transactionDate', 'amount', 'owner', 'assetName',
  'assetType', 'assetTypeName', 'isOption', 'capGainsOver200',
  'filingStatus', 'subholding', 'location', 'description', 'supplementalText'
];
var CONSENSUS_FIELD_LABEL = {
  ticker: 'Symbol', txType: 'Type', transactionDate: 'Date', amount: 'Amount',
  owner: 'Owner', assetName: 'Asset', assetType: 'Asset type',
  assetTypeName: 'Asset type name', isOption: 'Option',
  capGainsOver200: 'Cap gains >$200', filingStatus: 'Filing status',
  subholding: 'Subholding', location: 'Location', description: 'Description',
  supplementalText: 'Supplemental text'
};
/* Display text for one field's raw value: a string, an amount bracket
   ({amountMin, amountMax}), or null (no reading / no majority). */
function consensusFieldDisplay(value) {
  if (value == null || value === '') return 'Missing';
  if (typeof value === 'object') return reviewBracketLabel(value.amountMin, value.amountMax);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}
/* True iff a field's vote reached a strict majority (unanimous counts). */
function consensusHasMajority(fc) { return Boolean(fc && fc.total > 0 && fc.votes * 2 > fc.total); }
function consensusHasPlurality(fc) { return Boolean(fc && fc.value != null && fc.votes >= 2); }
/* Green (every present model agreed), amber (a majority agreed, some
   dissent), or red (no majority — contested) — reuses the file's existing
   .conf hi/mid/lo confidence-color classes rather than new ones. */
function consensusFieldClass(fc) {
  if (!fc) return 'lo';
  if (fc.unanimous) return 'hi';
  return consensusHasMajority(fc) ? 'mid' : 'lo';
}
/* One model's own raw value for a field on a consensus row: the model backs
   the field winner unless it is listed in that field's dissenters (present
   but different) — which, per buildConsensusRows, also covers the fully
   contested case where every present model appears as a dissenter. */
function consensusModelFieldValue(row, field, model) {
  var fc = row.fields[field];
  if (!fc) return null;
  for (var i = 0; i < fc.dissenters.length; i++) {
    if (fc.dissenters[i].model === model) return fc.dissenters[i].value;
  }
  return fc.value;
}
/* Self-label every field and keep dissent visible (not hover-only), including
   on touch devices. */
function consensusFieldCellHtml(field, fc) {
  var label = CONSENSUS_FIELD_LABEL[field] || field;
  if (!fc) return '<div class="conf lo"><strong>' + esc(label) + ':</strong> unavailable</div>';
  var cls = consensusFieldClass(fc);
  var dissentTitle = fc.dissenters.map(function (d) { return d.model + ': ' + consensusFieldDisplay(d.value); }).join('; ');
  if (cls === 'hi') {
    return '<div class="conf hi"><strong>' + esc(label) + ':</strong> ' + esc(consensusFieldDisplay(fc.value)) + ' <span class="muted">(' + fc.votes + '/' + fc.total + ')</span></div>';
  }
  if (cls === 'mid') {
    return '<div class="conf mid" title="' + esc(dissentTitle) + '"><strong>' + esc(label) + ':</strong> ' + esc(consensusFieldDisplay(fc.value)) + ' <span class="muted">(' + fc.votes + '/' + fc.total + ')</span>' +
      (dissentTitle ? '<div class="muted">Dissent: ' + esc(dissentTitle) + '</div>' : '') + '</div>';
  }
  var allValues = fc.dissenters.map(function (d) { return esc(d.model) + ': ' + esc(consensusFieldDisplay(d.value)); }).join('<br />');
  return '<div class="conf lo" title="' + esc(dissentTitle) + '"><strong>Contested ' + esc(label) + ':</strong><br />' + (allValues || 'No usable readings') + '</div>';
}
/* A model's own column cell for this row: its per-field readings, or a
   muted placeholder when this model never produced the row at all. */
function consensusModelCellHtml(row, model) {
  if ((row.missingFrom || []).indexOf(model) >= 0) return '<span class="conf lo">Missing row</span>';
  return CONSENSUS_FIELD_ORDER.map(function (f) {
    return '<span class="chip" style="margin-right:6px">' + esc(CONSENSUS_FIELD_LABEL[f]) + ' ' + esc(consensusFieldDisplay(consensusModelFieldValue(row, f, model))) + '</span>';
  }).join('');
}
function consensusStatusHtml(status) {
  if (!status) return '';
  var failed = (status.failedModels || []).map(function (f) {
    return f.model + (f.error ? ' (' + f.error + ')' : '');
  });
  var cls = status.blockedReason || failed.length ? 'lo' : 'hi';
  var html = '<div class="conf ' + cls + '" style="margin:6px 0">Run set: ' +
    esc(status.kind || 'unknown') + ' · ' + esc(status.batchId || 'unknown batch') +
    ' · ' + esc(status.createdAt || 'time unavailable');
  if (failed.length) html += '<div><strong>Failed models:</strong> ' + esc(failed.join('; ')) + '</div>';
  if (status.blockedReason) html += '<div><strong>Consensus unavailable:</strong> ' + esc(status.blockedReason) + '</div>';
  return html + '</div>';
}
/* Full consensus grid: one row per reconciled transaction, one column per
   participating model plus a reconciled "Consensus" column. Opt-in only —
   rendered alongside (not instead of) the per-model readings table. */
function consensusGridHtml(docId, consensus, status) {
  var statusHtml = consensusStatusHtml(status);
  if (!consensus || !consensus.rows || !consensus.rows.length) return statusHtml;
  var models = consensus.summary.models;
  var s = consensus.summary;
  var head = '<div style="margin:10px 0 4px"><strong>Consensus</strong> ' +
    '<span class="chip">' + s.rowsUnanimous + ' unanimous &middot; ' + s.rowsMajority + ' majority &middot; ' + s.rowsContested + ' contested</span> ' +
    '<button class="btn ghost sm" onclick="useConsensusRows(\\'' + esc(docId) + '\\')">Use Consensus</button></div>';
  head += '<div class="note">Queue-first safety: queued-only rows and metadata stay intact; contested, minority, and consensus-only rows are not substituted automatically.</div>';
  var thead = '<tr><th>Row</th>' + models.map(function (m) { return '<th>' + esc(m) + '</th>'; }).join('') + '<th>Consensus</th></tr>';
  var rowsHtml = consensus.rows.map(function (row) {
    var modelCells = models.map(function (m) { return '<td>' + consensusModelCellHtml(row, m) + '</td>'; }).join('');
    var consensusCell = '<td>' + CONSENSUS_FIELD_ORDER.map(function (f) { return consensusFieldCellHtml(f, row.fields[f]); }).join('') + '</td>';
    var missing = (row.missingFrom || []).length ? '<div class="conf lo"><strong>Missing row from:</strong> ' + esc(row.missingFrom.join(', ')) + '</div>' : '';
    var rowCls = row.rowConsensus === 'contested' ? 'lo' : (row.rowConsensus === 'majority' ? 'mid' : 'hi');
    return '<tr><td><span class="conf ' + rowCls + '">' + esc(row.rowConsensus) + '</span><div class="muted">' + esc(row.rowKey) + '</div>' + missing + '</td>' + modelCells + consensusCell + '</tr>';
  }).join('');
  return statusHtml + head + '<div style="overflow-x:auto"><table style="font-size:12px;width:100%"><thead>' + thead + '</thead><tbody>' + rowsHtml + '</tbody></table></div>';
}
/* Fetch + render the full stored readings (extracted rows) for each model. */
function viewReadings(docId) {
  var target = el('mdlBody-' + docId);
  if (target) target.innerHTML = '<span class="muted">Loading readings…</span>';
  fetch('/api/admin/review/' + encodeURIComponent(docId) + '/extractions', { headers: adminHeaders() })
    .then(okOrThrow)
    .then(function (data) {
      var runs = data.runs || [];
      REVIEW_RUNS[docId] = runs;
      REVIEW_CONSENSUS[docId] = data.consensus || null;
      REVIEW_CONSENSUS_STATUS[docId] = data.consensusStatus || null;
      if (!runs.length) { if (target) target.innerHTML = '<span class="muted">No stored readings.</span>'; return; }
      if (target) target.innerHTML = runs.map(function (run, idx) {
        var conf = (typeof run.avgConfidence === 'number') ? Math.round(run.avgConfidence * 100) + '%' : '—';
        var canUse = run.ok && run.rows && run.rows.length;
        var header = '<div style="margin:8px 0 2px"><strong>' + esc(run.provider + ':' + run.model) + '</strong> ' +
          '<span class="muted">· ' + (run.ok ? (run.rowCount + ' rows · conf ' + conf + (run.latencyMs ? ' · ' + fmtMs(run.latencyMs) : '')) : ('ERROR: ' + esc(String(run.error || 'failed')))) + '</span> ' +
          (canUse ? '<button class="btn ghost sm" onclick="useModelRows(\\'' + esc(docId) + '\\',' + idx + ')">Use This Model</button>' : '') + '</div>';
        var rowsHtml = (run.rows && run.rows.length)
          ? '<table style="font-size:12px;width:100%"><thead><tr><th>Symbol</th><th>Asset</th><th>Type</th><th>Date</th><th style="text-align:right">Amt min</th><th style="text-align:right">Amt max</th></tr></thead><tbody>' +
            run.rows.map(function (t) {
              return '<tr><td>' + esc(t.ticker || '—') + '</td><td>' + esc(String(t.assetName || '').slice(0, 50)) + '</td><td>' + esc(t.txType || '') + '</td><td>' + esc(t.txDate || '') + '</td>' +
                '<td style="text-align:right">' + esc(t.amountMin == null ? '—' : t.amountMin) + '</td><td style="text-align:right">' + esc(t.amountMax == null ? '—' : t.amountMax) + '</td></tr>';
            }).join('') + '</tbody></table>'
          : '<span class="muted">No rows.</span>';
        return header + rowsHtml;
      }).join('') + consensusGridHtml(docId, data.consensus, data.consensusStatus);
    })
    .catch(function (e) { if (target) target.innerHTML = '<span class="muted">' + (isAuthError(e) ? 'Admin auth required' : ('Could not load readings: ' + esc(e.message))) + '</span>'; });
}
function resolveReview(docId, decision) {
  // API HOOK: POST /api/admin/review/:docId {decision}  (unpublish uses /review/:docId/unpublish)
  if (decision === 'confirm') { openQueuedReviewEditor(docId); return; }
  var rowEl = el('rv-' + docId);
  if (rowEl) rowEl.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
  var isUnpublish = decision === 'unpublish';
  var item = reviewItemForDoc(docId);
  var url = '/api/admin/review/' + encodeURIComponent(docId) + (isUnpublish ? '/unpublish' : '');
  fetch(url, {
    method: 'POST', headers: adminHeaders({ 'content-type': 'application/json' }),
    body: isUnpublish
      ? JSON.stringify({
          reason: 'admin unpublish from dashboard',
          reviewRevision: item && item.reviewRevision
        })
      : JSON.stringify({ decision: decision, reviewRevision: item && item.reviewRevision })
  })
    .then(okOrThrow)
    .then(function () {
      if (isUnpublish) { loadReview(); } // item returns to pending; reload current tab
      else { loadReview(); }
      loadTrades();
    })
    .catch(function (e) {
      if (rowEl) rowEl.querySelectorAll('button').forEach(function (b) { b.disabled = false; });
      showToast(isAuthError(e) ? ADMIN_MOVED_MSG : ('Review action failed: ' + e.message), true);
    });
}
function retryReviewAuto(docId) {
  var rowEl = el('rv-' + docId);
  var item = reviewItemForDoc(docId);
  if (rowEl) rowEl.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
  fetch('/api/admin/review/' + encodeURIComponent(docId) + '/retry-auto', {
    method: 'POST', headers: adminHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ reviewRevision: item && item.reviewRevision })
  })
    .then(okOrThrow)
    .then(function () { loadReview(); loadDecisionHistory(); })
    .catch(function (e) {
      if (rowEl) rowEl.querySelectorAll('button').forEach(function (b) { b.disabled = false; });
      showToast(isAuthError(e) ? ADMIN_MOVED_MSG : ('Auto retry failed: ' + e.message), true);
    });
}
function selectedOption(v, current) { return String(v) === String(current) ? ' selected' : ''; }
function checkedAttr(v) { return v ? ' checked' : ''; }
function valueAttr(v) { return esc(v == null ? '' : v); }
/* Mirror src/shared/brackets.ts for the browser-only admin editor. These are
   the canonical STOCK Act disclosure ranges used by both House and Senate PTRs,
   plus the product $0–$1,000 tier for exact sub-$1,001 dollar amounts. */
var REVIEW_AMOUNT_BRACKETS = [
  [0, 1000], [1001, 15000], [15001, 50000], [50001, 100000], [100001, 250000], [250001, 500000],
  [500001, 1000000], [1000001, 5000000], [5000001, 25000000], [25000001, 50000000], [50000001, null]
];
function reviewMoney(n) {
  return '$' + Number(n).toLocaleString();
}
function bracketKey(min, max) {
  if (min == null && max == null) return '';
  return String(min == null ? '' : min) + ':' + String(max == null ? '' : max);
}
function reviewBracketLabel(min, max) {
  if (min == null && max == null) return 'Amount Range';
  return reviewMoney(min) + (max == null ? '+' : ' - ' + reviewMoney(max));
}
function amountBracketSelectHtml(tx) {
  var current = bracketKey(tx.amountMin, tx.amountMax);
  var opts = '<option value="">Amount Range</option>';
  REVIEW_AMOUNT_BRACKETS.forEach(function (b) {
    var key = bracketKey(b[0], b[1]);
    opts += '<option value="' + esc(key) + '"' + selectedOption(key, current) + '>' + esc(reviewBracketLabel(b[0], b[1])) + '</option>';
  });
  return '<select class="me-bracket" title="Canonical STOCK Act amount bracket">' + opts + '</select>';
}
function assetTypeInputHtml(tx, chamber) {
  ensureReviewAssetTypeDatalists();
  var current = String(tx.assetType || '').trim();
  var category = reviewAssetTypeCategoryLabel(current);
  return '<span class="me-asset-type-wrap">' +
    '<input class="me-asset-type" list="' + esc(reviewAssetTypeDatalistId(chamber)) + '" placeholder="Asset type" value="' + valueAttr(current) + '" title="Start typing to pick a suggested type; custom values are allowed." oninput="syncReviewAssetTypeInput(this)" onchange="syncReviewAssetTypeInput(this)" />' +
    '<span class="me-asset-type-category">' + esc(category) + '</span>' +
    '</span>';
}
function parseBracketValue(v) {
  var s = String(v || '');
  if (!s) return { min: null, max: null };
  var p = s.split(':');
  return { min: p[0] === '' ? null : Number(p[0]), max: p[1] === '' ? null : Number(p[1]) };
}
function syncReviewAssetTypeInput(inputEl) {
  var row = inputEl && inputEl.closest ? inputEl.closest('.me-row') : null;
  var cb = row && row.querySelector ? row.querySelector('.me-option') : null;
  var value = inputEl ? String(inputEl.value || '').trim() : '';
  var category = reviewAssetTypeCategoryLabel(value);
  if (cb && (value.toUpperCase() === 'OP' || category === 'Options')) cb.checked = true;
  var label = row && row.querySelector ? row.querySelector('.me-asset-type-category') : null;
  if (label) label.textContent = category || '';
}
/* Shared review editor. It can start blank for manual entry, from the queued
   review payload, or from any selected model run. Submit stays explicit. */
function meRowHtml(tx, chamber) {
  tx = normalizeReviewEdit(tx || {}, 'review editor');
  var isLow = tx.confidence != null && tx.confidence < 0.95;
  var confClass = tx.confidence == null ? '' : (tx.confidence >= 0.95 ? 'hi' : (tx.confidence >= 0.85 ? 'mid' : 'lo'));
  var confBadge = '';
  if (tx.confidence != null) {
    var pct = (tx.confidence * 100).toFixed(0) + '%';
    var title = 'Extraction confidence: ' + pct + (isLow ? ' (Below 95% threshold)' : '');
    confBadge = '<span class="me-conf-badge ' + confClass + '" title="' + esc(title) + '">' + pct + '</span>';
  }
  return '<div class="me-row' + (isLow ? ' me-row-low-conf' : '') + '">' +
    '<input class="me-ticker" placeholder="Symbol" maxlength="12" value="' + valueAttr(tx.ticker || '') + '" /> ' +
    '<select class="me-type"><option value=""' + selectedOption('', tx.txType || '') + '>Transaction type</option><option value="B"' + selectedOption('B', (tx.txType === 'P' ? 'B' : tx.txType)) + '>Buy</option><option value="S"' + selectedOption('S', tx.txType) + '>Sell</option><option value="E"' + selectedOption('E', tx.txType) + '>Exchange</option></select> ' +
    amountBracketSelectHtml(tx) +
    '<input class="me-date" type="date" value="' + valueAttr(tx.txDate || '') + '" /> ' +
    '<select class="me-owner"><option value=""' + selectedOption('', tx.owner || '') + '>Owner unknown</option><option value="self"' + selectedOption('self', tx.owner) + '>self</option><option value="spouse"' + selectedOption('spouse', tx.owner) + '>spouse</option><option value="joint"' + selectedOption('joint', tx.owner) + '>joint</option><option value="dependent"' + selectedOption('dependent', tx.owner) + '>dependent</option></select> ' +
    assetTypeInputHtml(tx, chamber) +
    '<input class="me-asset" placeholder="Asset name" value="' + valueAttr(tx.assetName || '') + '" />' +
    '<span class="me-flags">' +
      '<label class="me-check" title="Marks this row as an options contract rather than a plain equity/security transaction."><input class="me-option" type="checkbox"' + checkedAttr(tx.isOption || tx.assetType === 'OP') + ' /> Option Contract</label>' +
      '<label class="me-check" title="Filer marked capital gains greater than $200 for this transaction."><input class="me-cap" type="checkbox"' + checkedAttr(tx.capGainsOver200) + ' /> Cap Gains &gt;$200</label>' +
      confBadge +
    '</span>' +
    '<input class="me-asset-type-name" type="hidden" value="' + valueAttr(tx.assetTypeName || '') + '" />' +
    '<input class="me-filing-status" type="hidden" value="' + valueAttr(tx.filingStatus || '') + '" />' +
    '<input class="me-subholding" type="hidden" value="' + valueAttr(tx.subholding || '') + '" />' +
    '<input class="me-location" type="hidden" value="' + valueAttr(tx.location || '') + '" />' +
    '<input class="me-description" type="hidden" value="' + valueAttr(tx.description || '') + '" />' +
    '<input class="me-supplemental" type="hidden" value="' + valueAttr(tx.supplementalText || '') + '" />' +
    '<input class="me-raw" type="hidden" value="' + valueAttr(tx.rawText || '') + '" />' +
    '<input class="me-conf" type="hidden" value="' + valueAttr(tx.confidence == null ? '' : tx.confidence) + '" />' +
    '</div>';
}
function meAddRow(docId, tx) {
  var c = el('me-rows-' + docId);
  var tr = el('me-' + docId);
  var chamber = tr ? tr.getAttribute('data-chamber') : '';
  if (c) c.insertAdjacentHTML('beforeend', meRowHtml(tx, chamber));
}
function meCancel(docId) { var tr = el('me-' + docId); if (tr) tr.parentNode.removeChild(tr); }
function reviewItemForDoc(docId) {
  for (var i = 0; i < REVIEW.length; i++) { if (REVIEW[i].docId === docId) return REVIEW[i]; }
  return null;
}
function openQueuedReviewEditor(docId) {
  var item = reviewItemForDoc(docId);
  var rows = reviewPayloadTransactions(item && item.payload);
  openReviewEditor(docId, rows, 'confirm', 'queued extracted rows', item && item.chamber);
}
function useModelRows(docId, idx) {
  var run = REVIEW_RUNS[docId] && REVIEW_RUNS[docId][idx];
  if (!run || !run.rows || !run.rows.length) { showToast('That model run has no rows to use.', true); return; }
  var item = reviewItemForDoc(docId);
  openReviewEditor(docId, run.rows, 'confirm', run.provider + ':' + run.model, item && item.chamber);
}
/* Row key matching arbitrationRowKey in src/extractors/types.ts, so a queued
   payload transaction can be paired with its consensus row below. */
function consensusQueuedRowKey(t) {
  var sym = String((t && (t.ticker || t.assetName)) || '').trim().toUpperCase();
  return sym + '|' + String((t && t.txDate) || '') + '|' + String((t && t.txType) || '');
}
/* Missing/null consensus values never erase a queued value. Contested rows are
   handled as a whole below and do not call this helper. */
function consensusFieldValueForEdit(fc, queuedValue, rowAuthoritative) {
  var usable = consensusHasMajority(fc) || consensusHasPlurality(fc);
  return (rowAuthoritative && usable && fc.value != null && fc.value !== '') ? fc.value : queuedValue;
}
function consensusApplyField(target, row, consensusField, editField, rowAuthoritative) {
  var fc = row.fields && row.fields[consensusField];
  target[editField] = consensusFieldValueForEdit(fc, target[editField], rowAuthoritative);
}
/* "Use Consensus" is a queue-first merge, never a consensus-row replacement:
   - clone every queued row (including queued-only duplicate lots + metadata),
   - update only a matching occurrence with a complete majority/unanimous row,
   - leave contested/minority rows untouched,
   - never inject a consensus-only partial row without queued audit metadata. */
function useConsensusRows(docId) {
  var consensus = REVIEW_CONSENSUS[docId];
  if (!consensus || !consensus.rows || !consensus.rows.length) { showToast('No consensus rows available for this document.', true); return; }
  var item = reviewItemForDoc(docId);
  var models = (consensus.summary && consensus.summary.models) || [];
  var rows = reviewPayloadTransactions(item && item.payload).map(function (t) { return Object.assign({}, t); });
  if (!rows.length) { showToast('Consensus cannot be applied safely because the queued review payload has no rows.', true); return; }
  var queuedByKey = {};
  rows.forEach(function (t, index) {
    var key = consensusQueuedRowKey(t);
    if (!queuedByKey[key]) queuedByKey[key] = [];
    queuedByKey[key].push({ index: index, row: t });
  });
  var consensusCountByKey = {};
  consensus.rows.forEach(function (row) {
    var baseKey = row.baseRowKey || row.rowKey;
    consensusCountByKey[baseKey] = (consensusCountByKey[baseKey] || 0) + 1;
  });
  var reservedQueueIndexes = {};
  var safeMatches = [];
  var unmatchedConsensus = [];
  consensus.rows.forEach(function (row) {
    var baseKey = row.baseRowKey || row.rowKey;
    var rowAuthoritative = (row.rowConsensus === 'unanimous' || row.rowConsensus === 'majority') &&
      row.presentIn.length * 2 > models.length;
    // Duplicate groups have no trustworthy cross-model occurrence identity;
    // buildConsensusRows marks them contested, and the UI also refuses an
    // occurrence match here as defense in depth.
    if (consensusCountByKey[baseKey] > 1 || (queuedByKey[baseKey] || []).length > 1) return;
    var exact = queuedByKey[baseKey] && queuedByKey[baseKey][0];
    if (exact && !reservedQueueIndexes[exact.index]) {
      reservedQueueIndexes[exact.index] = true;
      if (rowAuthoritative) safeMatches.push({ row: row, index: exact.index });
      return;
    }
    unmatchedConsensus.push({ row: row, authoritative: rowAuthoritative });
  });

  // Ticker/date/type are precisely the fields review may need to correct, so
  // key matching alone cannot handle an unresolved-ticker row. Fall back only
  // when elimination is unambiguous: exactly one unmatched consensus row and
  // one unmatched non-duplicate queued row in the whole document.
  var unmatchedQueue = [];
  rows.forEach(function (t, index) {
    var key = consensusQueuedRowKey(t);
    if (!reservedQueueIndexes[index] && (queuedByKey[key] || []).length === 1) unmatchedQueue.push(index);
  });
  if (
    rows.length === 1 && consensus.rows.length === 1
    && unmatchedConsensus.length === 1 && unmatchedConsensus[0].authoritative
    && unmatchedQueue.length === 1
  ) {
    safeMatches.push({ row: unmatchedConsensus[0].row, index: unmatchedQueue[0] });
  }

  safeMatches.forEach(function (match) {
    var row = match.row;
    var target = rows[match.index];

    consensusApplyField(target, row, 'ticker', 'ticker', true);
    consensusApplyField(target, row, 'txType', 'txType', true);
    consensusApplyField(target, row, 'transactionDate', 'txDate', true);
    consensusApplyField(target, row, 'owner', 'owner', true);
    consensusApplyField(target, row, 'assetName', 'assetName', true);
    consensusApplyField(target, row, 'assetType', 'assetType', true);
    consensusApplyField(target, row, 'assetTypeName', 'assetTypeName', true);
    consensusApplyField(target, row, 'isOption', 'isOption', true);
    consensusApplyField(target, row, 'capGainsOver200', 'capGainsOver200', true);
    consensusApplyField(target, row, 'filingStatus', 'filingStatus', true);
    consensusApplyField(target, row, 'subholding', 'subholding', true);
    consensusApplyField(target, row, 'location', 'location', true);
    consensusApplyField(target, row, 'description', 'description', true);
    consensusApplyField(target, row, 'supplementalText', 'supplementalText', true);
    var amountFc = row.fields && row.fields.amount;
    if (consensusHasMajority(amountFc) && amountFc.value && typeof amountFc.value === 'object' &&
        (amountFc.value.amountMin != null || amountFc.value.amountMax != null)) {
      target.amountMin = amountFc.value.amountMin;
      target.amountMax = amountFc.value.amountMax;
    }
  });
  openReviewEditor(docId, rows, 'confirm', 'model consensus', item && item.chamber);
}
function manualEntry(docId) {
  var item = reviewItemForDoc(docId);
  openReviewEditor(docId, [], 'manual', 'manual entry', item && item.chamber);
}
function openReviewEditor(docId, rows, decision, label, chamber) {
  var old = el('me-' + docId);
  if (old && old.parentNode) old.parentNode.removeChild(old);
  var row = el('rv-' + docId);
  if (!row) return;
  var tr = document.createElement('tr');
  tr.id = 'me-' + docId;
  tr.setAttribute('data-decision', decision);
  tr.setAttribute('data-chamber', chamber || '');
  var item = reviewItemForDoc(docId);
  tr.setAttribute('data-review-revision', String((item && item.reviewRevision) || 1));
  var safeLabel = label || (decision === 'manual' ? 'manual entry' : 'selected rows');
  var title = decision === 'manual' ? 'Manual Entry' : 'Edit Rows To Confirm';
  var submit = decision === 'manual' ? 'Submit Manual Entry' : 'Confirm Edited Rows';
  var note = decision === 'manual'
    ? 'Recorded as <code>source=manual</code> because these rows were hand-entered by an admin.'
    : 'These rows will be promoted as <code>source=primary</code>. Edit anything that is wrong before confirming.';
  tr.innerHTML = '<td colspan="6" class="manual-entry">' +
    '<div class="review-edit-panel">' +
    '<div class="review-edit-head"><div><strong>' + esc(title) + '</strong><div class="muted">Prefilled from ' + esc(safeLabel) + '.</div></div>' +
    '<button class="btn ghost sm" onclick="meCancel(\\'' + esc(docId) + '\\')">Cancel</button></div>' +
    publishRowsHtml(rows, { max: 5, title: 'Prefilled Rows' }) +
    '<div class="me-rows" id="me-rows-' + esc(docId) + '"></div>' +
    '<button class="btn ghost sm" onclick="meAddRow(\\'' + esc(docId) + '\\')">+ Add row</button> ' +
    '<button class="btn sm" onclick="meSubmit(\\'' + esc(docId) + '\\')">' + esc(submit) + '</button> ' +
    '<p class="note">' + note + '</p></div></td>';
  row.parentNode.insertBefore(tr, row.nextSibling);
  var seed = rows && rows.length ? rows : [{}];
  seed.forEach(function (tx) { meAddRow(docId, tx); });
}
function meSubmit(docId) {
  var c = el('me-rows-' + docId);
  if (!c) return;
  var tr = el('me-' + docId);
  var decision = (tr && tr.getAttribute('data-decision')) || 'manual';
  var edits = [];
  c.querySelectorAll('.me-row').forEach(function (g) {
    var t = (g.querySelector('.me-ticker').value || '').trim().toUpperCase();
    var asset = (g.querySelector('.me-asset').value || '').trim();
    if (!t && !asset) return; // skip blank rows
    var bracket = parseBracketValue(g.querySelector('.me-bracket').value);
    var conf = g.querySelector('.me-conf').value;
    var assetType = reviewNormalizeAssetTypeValue(g.querySelector('.me-asset-type').value || '');
    edits.push({
      ticker: t || null,
      assetName: asset || t || '(review entry)',
      txType: g.querySelector('.me-type').value,
      amountMin: bracket.min,
      amountMax: bracket.max,
      txDate: g.querySelector('.me-date').value || null,
      owner: g.querySelector('.me-owner').value || null,
      assetType: assetType || null,
      assetTypeName: reviewAssetTypeName(assetType) || (g.querySelector('.me-asset-type-name').value || '').trim() || null,
      isOption: g.querySelector('.me-option').checked || assetType === 'OP' || reviewAssetTypeCategoryLabel(assetType) === 'Options',
      capGainsOver200: g.querySelector('.me-cap').checked,
      filingStatus: (g.querySelector('.me-filing-status').value || '').trim() || null,
      subholding: (g.querySelector('.me-subholding').value || '').trim() || null,
      location: (g.querySelector('.me-location').value || '').trim() || null,
      description: (g.querySelector('.me-description').value || '').trim() || null,
      supplementalText: (g.querySelector('.me-supplemental').value || '').trim() || null,
      rawText: (g.querySelector('.me-raw').value || '').trim() || (decision === 'manual' ? 'manual entry' : 'review editor'),
      confidence: conf === '' ? (decision === 'manual' ? 1 : null) : Number(conf)
    });
  });
  if (edits.length === 0) { showToast('Add at least one row (a symbol or asset name).', true); return; }
  var incomplete = edits.findIndex(function (e) { return !e.txType || !e.txDate; });
  if (incomplete >= 0) { showToast('Row ' + (incomplete + 1) + ' needs an explicit transaction type and date.', true); return; }
  if (tr) tr.querySelectorAll('button,input,select').forEach(function (b) { b.disabled = true; });
  fetch('/api/admin/review/' + encodeURIComponent(docId), {
    method: 'POST', headers: adminHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({
      decision: decision,
      reviewRevision: Number(tr && tr.getAttribute('data-review-revision')),
      edits: edits
    })
  })
    .then(okOrThrow)
    .then(function () { loadReview(); loadTrades(); })
    .catch(function (e) {
      if (tr) tr.querySelectorAll('button,input,select').forEach(function (b) { b.disabled = false; });
      showToast(isAuthError(e) ? ADMIN_MOVED_MSG : ('Review submit failed: ' + e.message), true);
    });
}

/* ============================ SUBSCRIPTIONS / DELIVERY ============================ */
/* Target URL only applies to webhook delivery — hide the row for SSE. */
function updateNewTargetVisibility() {
  var deliverySel = el('newDelivery');
  var target = el('newTarget');
  if (!target) return;
  target.style.display = deliverySel && deliverySel.value === 'webhook' ? '' : 'none';
}
function updateDeliveryGate() {
  var gate = el('subsGate');
  var createBtn = el('subsCreateBtn');
  var deliverySel = el('newDelivery');
  var target = el('newTarget');
  var tickersIn = el('newTickers');
  var membersIn = el('newMembers');
  var chambersSel = el('newChambers');
  var sidesSel = el('newSides');
  var minAmtIn = el('newMinAmt');
  var body = el('subsBody');
  var signedIn = !!(ME.user && ME.user.id);
  var premium = isPremium();
  var canCreate = signedIn && premium;
  if (deliverySel) deliverySel.disabled = !canCreate;
  if (target) target.disabled = !canCreate;
  if (tickersIn) tickersIn.disabled = !canCreate;
  if (membersIn) membersIn.disabled = !canCreate;
  if (chambersSel) chambersSel.disabled = !canCreate;
  if (sidesSel) sidesSel.disabled = !canCreate;
  if (minAmtIn) minAmtIn.disabled = !canCreate;
  if (createBtn) createBtn.disabled = !canCreate;
  updateNewTargetVisibility();
  if (!gate) return;
  if (!signedIn) {
    gate.style.display = '';
    gate.innerHTML = 'Sign in with Google to use Delivery.&nbsp; Creating a webhook or SSE target requires a signed-in Premium account. '
      + '<button class="btn sm" onclick="openLogin()">Sign In</button>';
    if (body) body.innerHTML = stateRow(5, 'Sign in to see your deliveries.');
    return;
  }
  if (!premium) {
    gate.style.display = '';
    gate.innerHTML = 'You are signed in.&nbsp; Premium is required to create or edit Delivery targets (1-week free trial · $9/mo or $80/yr).&nbsp; Existing deliveries still appear below. '
      + (checkoutConfigured()
        ? '<button class="btn sm" onclick="openPricing(&quot;alerts&quot;)">Start Free Trial</button>'
        : '<span class="muted">Billing is not configured yet.</span>');
    return;
  }
  gate.style.display = 'none';
  gate.textContent = '';
}

/** In-memory list of the signed-in user's deliveries (for edit form prefill). */
var USER_SUBS = [];
var EDITING_SUB_ID = null;

function loadSubs() {
  updateDeliveryGate();
  if (!(ME.user && ME.user.id)) return Promise.resolve();
  // Always list account deliveries when signed in (Premium gates create/edit only).
  return fetch('/api/client/v1/subscriptions', { headers: { accept: 'application/json' }, credentials: 'same-origin' })
    .then(function (r) {
      if (r.status === 401) throw new Error('Sign in required.');
      if (!r.ok) return r.json().then(function (j) { throw new Error((j && j.error) || ('HTTP ' + r.status)); });
      return r.json();
    })
    .then(function (data) {
      USER_SUBS = data.subscriptions || [];
      renderSubs(USER_SUBS);
    })
    .catch(function (e) {
      el('subsBody').innerHTML = stateRow(6, 'Could not load deliveries: ' + e.message);
    });
}
/* Humanize a subscription's raw delivery cursor (an internal row-sequence
   position, e.g. "Cursor 0" / "100,508") into what the owner actually wants
   to know: how far delivery has progressed. Webhooks always have a real
   position once anything has been delivered. SSE clients pick their own
   resume position on connect (Last-Event-ID) rather than trusting a stored
   cursor, so a 0/unset SSE cursor means "nothing delivered yet, connect to
   pick a position" — showing "Cursor 0" there is meaningless internals, not
   information, so it's hidden entirely rather than translated. */
function subCursorText(s) {
  var c = Number(s.cursor || 0);
  if (!c || c <= 0) return '—';
  return 'Delivered through event #' + fmtCount(c);
}
/* A delivery's members filter as names.  The server sends memberLabels (filer id ->
   name); entries it could not resolve (free text saved before names were resolved to
   filer ids) can never match a trade, so they are called out instead of counted. */
function memberFilterText(s) {
  var ids = (s.filters && s.filters.members) || [];
  var labels = s.memberLabels || {};
  var dead = s.unresolvedMembers || [];
  var names = ids.filter(function (id) { return dead.indexOf(id) === -1; })
    .map(function (id) { return labels[id] || id; });
  var text = names.slice(0, 2).join(', ') + (names.length > 2 ? ' +' + (names.length - 2) + ' more' : '');
  if (dead.length) text += (text ? ' · ' : '') + 'not matched: ' + dead.join(', ') + ' (Edit to fix)';
  return text;
}
function renderSubs(subs) {
  var body = el('subsBody');
  if (!body) return;
  if (subs.length === 0) {
    body.innerHTML = stateRow(6, isPremium()
      ? 'No deliveries yet. Create one below — optional filters (tickers, members, chambers, sides) narrow what you receive.'
      : 'No deliveries on this account yet. Upgrade to Premium to create webhook/SSE deliveries.');
    return;
  }
  var pausedCount = 0;
  var rows = subs.map(function (s) {
    if (!s.active) pausedCount += 1;
    var f = s.filters || {};
    var parts = [];
    if (f.chambers && f.chambers.length) parts.push(f.chambers.join('+')); else parts.push('all chambers');
    if (f.sides && f.sides.length) parts.push(f.sides.map(function (x) { return typeName[x] || x; }).join('/'));
    if (f.minAmount) parts.push('≥ ' + fmt(f.minAmount));
    if (f.tickers && f.tickers.length) parts.push(f.tickers.join(','));
    if (f.members && f.members.length) parts.push(memberFilterText(s));
    if (parts.length === 1 && parts[0] === 'all chambers') parts.push('all events');
    var canEdit = isPremium();
    var statusLabel = s.active ? 'active' : 'paused';
    var statusHint = s.active
      ? 'Receiving matching filings'
      : 'Paused — no events until you Resume (or Delete to remove)';
    return '<tr class="row" data-sub-id="' + esc(s.id) + '">' +
      '<td>' + esc(s.delivery) + '</td>' +
      '<td class="muted">' + esc(s.targetUrl || (s.delivery === 'sse' ? '/api/stream' : '—')) + '</td>' +
      '<td class="muted">' + esc(parts.join(' · ')) + '</td>' +
      '<td class="muted">' + esc(subCursorText(s)) + '</td>' +
      '<td title="' + esc(statusHint) + '"><span class="conf ' + (s.active ? 'hi' : 'mid') + '">' + statusLabel + '</span></td>' +
      '<td class="row-flex" style="gap:6px;flex-wrap:wrap">' +
        (canEdit ? '<button class="btn ghost sm" data-sub-edit="' + esc(s.id) + '">Edit</button>' : '') +
        '<button class="btn ghost sm" data-sub-toggle="' + esc(s.id) + '" data-sub-active="' + (s.active ? '1' : '0') + '">' + (s.active ? 'Pause' : 'Resume') + '</button>' +
        '<button class="btn ghost sm" data-sub-delete="' + esc(s.id) + '" title="Permanently remove this delivery">Delete</button>' +
      '</td>' +
    '</tr>';
  }).join('');
  if (pausedCount > 0 && pausedCount === subs.length) {
    rows += '<tr class="row"><td colspan="6" class="note">All deliveries are paused. Resume one to receive events again, or Delete to free a slot.</td></tr>';
  } else if (pausedCount > 0) {
    rows += '<tr class="row"><td colspan="6" class="note">' + pausedCount + ' paused — those targets receive nothing until Resume.</td></tr>';
  }
  body.innerHTML = rows;
}
function clearDeliveryForm() {
  EDITING_SUB_ID = null;
  if (el('newDelivery')) el('newDelivery').value = 'sse';
  if (el('newTarget')) el('newTarget').value = '';
  if (el('newTickers')) el('newTickers').value = '';
  if (el('newMembers')) el('newMembers').value = '';
  if (el('newChambers')) el('newChambers').value = '';
  if (el('newSides')) el('newSides').value = '';
  if (el('newMinAmt')) el('newMinAmt').value = '';
  if (el('subsCreateBtn')) el('subsCreateBtn').textContent = 'Add New Delivery';
  if (el('subsMsg')) el('subsMsg').textContent = '';
  updateNewTargetVisibility();
  var cancel = el('subsEditCancel');
  if (cancel) cancel.hidden = true;
}
function beginEditSubscription(id) {
  var s = USER_SUBS.find(function (x) { return x.id === id; });
  if (!s) { showToast('Delivery not found.', true); return; }
  if (!isPremium()) { openPricing('alerts'); return; }
  EDITING_SUB_ID = id;
  var f = s.filters || {};
  if (el('newDelivery')) {
    el('newDelivery').value = s.delivery === 'webhook' ? 'webhook' : 'sse';
    el('newDelivery').disabled = true; // delivery mode is immutable after create
  }
  if (el('newTarget')) el('newTarget').value = s.targetUrl || '';
  updateNewTargetVisibility();
  if (el('newTickers')) el('newTickers').value = (f.tickers || []).join(', ');
  if (el('newMembers')) {
    // Names round-trip through the server's resolver (a name that is not unique is
    // rejected, never guessed), so show names where we have them and ids otherwise.
    var editLabels = s.memberLabels || {};
    el('newMembers').value = (f.members || []).map(function (id) { return editLabels[id] || id; }).join(', ');
  }
  if (el('newChambers')) el('newChambers').value = (f.chambers || []).join(',');
  if (el('newSides')) {
    var sidesJoined = (f.sides || []).join(',');
    var sidesSel = el('newSides');
    // Prefer an exact option match (incl. multi-side presets); fall back to first side.
    var hasExact = false;
    for (var i = 0; i < sidesSel.options.length; i++) {
      if (sidesSel.options[i].value === sidesJoined) { hasExact = true; break; }
    }
    sidesSel.value = hasExact ? sidesJoined : ((f.sides && f.sides[0]) || '');
  }
  if (el('newMinAmt')) {
    var minAmtSel = el('newMinAmt');
    var minAmtStr = f.minAmount != null ? String(f.minAmount) : '';
    // Fall back to "Any" when the stored minAmount doesn't match a bracket-floor option.
    var hasMinAmtExact = false;
    for (var mi = 0; mi < minAmtSel.options.length; mi++) {
      if (minAmtSel.options[mi].value === minAmtStr) { hasMinAmtExact = true; break; }
    }
    minAmtSel.value = hasMinAmtExact ? minAmtStr : '';
  }
  if (el('subsCreateBtn')) el('subsCreateBtn').textContent = 'Save changes';
  var cancel = el('subsEditCancel');
  if (cancel) cancel.hidden = false;
  if (el('subsMsg')) el('subsMsg').textContent = 'Editing ' + id + ' — update filters/target and save.';
  try { el('subsCreateRow').scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) {}
}
function saveSubscriptionEdits() {
  if (!EDITING_SUB_ID) return createSubscription();
  if (!isPremium()) { el('subsMsg').textContent = 'Premium required to edit Delivery.'; openPricing('alerts'); return; }
  var delivery = el('newDelivery').value;
  var targetUrl = el('newTarget').value.trim();
  if (delivery === 'webhook' && !targetUrl) { el('subsMsg').textContent = 'webhook needs a target URL.'; return; }
  var filters = {};
  var tickersRaw = (el('newTickers') && el('newTickers').value || '').split(',').map(function (t) { return t.trim().toUpperCase(); }).filter(Boolean);
  if (tickersRaw.length) filters.tickers = tickersRaw;
  var membersRaw = (el('newMembers') && el('newMembers').value || '').split(',').map(function (t) { return t.trim(); }).filter(Boolean);
  if (membersRaw.length) filters.members = membersRaw;
  var chambersRaw = el('newChambers') ? el('newChambers').value : '';
  if (chambersRaw) filters.chambers = chambersRaw.split(',').filter(Boolean);
  var sidesRaw = el('newSides') ? el('newSides').value : '';
  if (sidesRaw) filters.sides = sidesRaw.split(',').filter(Boolean);
  var minAmtRaw = el('newMinAmt') ? el('newMinAmt').value : '';
  var minAmt = minAmtRaw === '' || minAmtRaw == null ? NaN : Number(minAmtRaw);
  if (Number.isFinite(minAmt) && minAmt > 0) filters.minAmount = minAmt;
  el('subsMsg').textContent = 'Saving…';
  var idem = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('sub-edit-' + Date.now());
  var payload = { id: EDITING_SUB_ID, filters: filters };
  if (delivery === 'webhook') payload.targetUrl = targetUrl;
  fetch('/api/client/v1/commands', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', accept: 'application/json', 'Idempotency-Key': idem },
    body: JSON.stringify({ type: 'update_subscription', idempotencyKey: idem, payload: payload })
  })
    .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error((j && j.error) || ('HTTP ' + r.status)); return j; }); })
    .then(function (j) {
      /* Validation failures (e.g. a member name that matches no one) come back as a
         failed command on a 200, not an HTTP error: keep the form and say why. */
      if (j && j.command && j.command.status === 'failed') throw new Error(j.command.error || 'command failed');
      showToast('Delivery updated.');
      clearDeliveryForm();
      if (el('newDelivery')) el('newDelivery').disabled = false;
      updateDeliveryGate();
      loadSubs();
    })
    .catch(function (err) { el('subsMsg').textContent = 'Save failed: ' + err.message; });
}
/* Pause/Resume via update_subscription (active flag). Delete via delete_subscription
   (hard-removes the row; distinct from pause, which only frees the active slot).
   First tap arms Confirm? for 4s (iOS Delivery parity); second tap deletes. */
var PENDING_SUB_DELETE = { id: null, timer: null };
function resetPendingSubDelete(btn) {
  if (PENDING_SUB_DELETE.timer) { clearTimeout(PENDING_SUB_DELETE.timer); PENDING_SUB_DELETE.timer = null; }
  if (btn && btn.dataset && btn.dataset.origLabel) btn.textContent = btn.dataset.origLabel;
  PENDING_SUB_DELETE.id = null;
}
document.addEventListener('click', function (e) {
  var editBtn = e.target && e.target.closest ? e.target.closest('[data-sub-edit]') : null;
  if (editBtn) {
    beginEditSubscription(editBtn.getAttribute('data-sub-edit'));
    return;
  }
  var delBtn = e.target && e.target.closest ? e.target.closest('[data-sub-delete]') : null;
  if (delBtn) {
    var delId = delBtn.getAttribute('data-sub-delete');
    if (!delId) return;
    if (PENDING_SUB_DELETE.id !== delId) {
      var prev = document.querySelector('[data-sub-delete][data-confirming="1"]');
      if (prev && prev !== delBtn) resetPendingSubDelete(prev);
      delBtn.dataset.origLabel = delBtn.textContent || 'Delete';
      delBtn.dataset.confirming = '1';
      delBtn.textContent = 'Confirm?';
      delBtn.setAttribute('aria-label', 'Confirm delete this delivery permanently');
      PENDING_SUB_DELETE.id = delId;
      if (PENDING_SUB_DELETE.timer) clearTimeout(PENDING_SUB_DELETE.timer);
      PENDING_SUB_DELETE.timer = setTimeout(function () {
        if (PENDING_SUB_DELETE.id === delId) {
          delBtn.removeAttribute('data-confirming');
          resetPendingSubDelete(delBtn);
        }
      }, 4000);
      return;
    }
    resetPendingSubDelete(delBtn);
    delBtn.removeAttribute('data-confirming');
    delBtn.disabled = true;
    var delIdem = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('sub-del-' + Date.now());
    fetch('/api/client/v1/commands', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'Idempotency-Key': delIdem },
      body: JSON.stringify({
        type: 'delete_subscription',
        idempotencyKey: delIdem,
        payload: { id: delId }
      })
    })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error((j && j.error) || ('HTTP ' + r.status)); return j; }); })
      .then(function () {
        showToast('Delivery deleted.');
        if (EDITING_SUB_ID === delId) {
          clearDeliveryForm();
          if (el('newDelivery')) el('newDelivery').disabled = false;
          updateDeliveryGate();
        }
        loadSubs();
      })
      .catch(function (err) { delBtn.disabled = false; showToast('Delete failed: ' + err.message, true); });
    return;
  }
  var b = e.target && e.target.closest ? e.target.closest('[data-sub-toggle]') : null;
  if (!b) return;
  var id = b.getAttribute('data-sub-toggle');
  var nextActive = b.getAttribute('data-sub-active') !== '1';
  if (nextActive && !isPremium()) {
    showToast('Premium required to resume a delivery.', true);
    openPricing('alerts');
    return;
  }
  b.disabled = true;
  var idem = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('sub-upd-' + Date.now());
  fetch('/api/client/v1/commands', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', accept: 'application/json', 'Idempotency-Key': idem },
    body: JSON.stringify({
      type: 'update_subscription',
      idempotencyKey: idem,
      payload: { id: id, active: nextActive }
    })
  })
    .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error((j && j.error) || ('HTTP ' + r.status)); return j; }); })
    .then(function () { showToast(nextActive ? 'Delivery resumed.' : 'Delivery paused.'); loadSubs(); })
    .catch(function (err) { b.disabled = false; showToast('Update failed: ' + err.message, true); });
});
function createSubscription() {
  if (EDITING_SUB_ID) { saveSubscriptionEdits(); return; }
  updateDeliveryGate();
  if (!(ME.user && ME.user.id)) { el('subsMsg').textContent = 'Sign in required.'; return; }
  if (!isPremium()) { el('subsMsg').textContent = 'Premium required to create Delivery.'; openPricing('alerts'); return; }
  var delivery = el('newDelivery').value;
  var targetUrl = el('newTarget').value.trim();
  if (delivery === 'webhook' && !targetUrl) { el('subsMsg').textContent = 'webhook needs a target URL.'; return; }
  var filters = {};
  var tickersRaw = (el('newTickers') && el('newTickers').value || '').split(',').map(function (t) { return t.trim().toUpperCase(); }).filter(Boolean);
  if (tickersRaw.length) filters.tickers = tickersRaw;
  var membersRaw = (el('newMembers') && el('newMembers').value || '').split(',').map(function (t) { return t.trim(); }).filter(Boolean);
  if (membersRaw.length) filters.members = membersRaw;
  var chambersRaw = el('newChambers') ? el('newChambers').value : '';
  if (chambersRaw) filters.chambers = chambersRaw.split(',');
  var sidesRaw = el('newSides') ? el('newSides').value : '';
  if (sidesRaw) filters.sides = sidesRaw.split(',').filter(Boolean);
  var minAmtRaw = el('newMinAmt') ? el('newMinAmt').value : '';
  var minAmt = minAmtRaw === '' || minAmtRaw == null ? NaN : Number(minAmtRaw);
  if (Number.isFinite(minAmt) && minAmt > 0) filters.minAmount = minAmt;
  el('subsMsg').textContent = 'Creating…';
  var idem = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('sub-' + Date.now());
  fetch('/api/client/v1/commands', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', accept: 'application/json', 'Idempotency-Key': idem },
    body: JSON.stringify({
      type: 'create_subscription',
      idempotencyKey: idem,
      payload: { delivery: delivery, targetUrl: targetUrl || null, filters: filters }
    })
  })
    .then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) {
          var err = new Error((j && j.error) || ('HTTP ' + r.status));
          err.status = r.status;
          throw err;
        }
        return j;
      });
    })
    .then(function (data) {
      function renderResult(dataObj) {
        var result = (dataObj && dataObj.command && dataObj.command.result) || dataObj.result || dataObj;
        var sub = (result && result.subscription) || (dataObj && dataObj.subscription) || null;
        var secretHtml = '';
        if (sub && sub.secret) {
          var stream = sub.streamUrl || '';
          secretHtml =
            '<div class="secret-panel">' +
              '<strong>Created. Save this secret now; it will not be shown again.</strong>' +
              '<div><span class="muted">Secret</span><code class="secret-value">' + esc(sub.secret) + '</code></div>' +
              (stream ? '<div><span class="muted">SSE URL</span><code class="secret-value">' + esc(stream) + '</code></div>' : '') +
              '<div class="secret-actions">' +
                '<button class="btn ghost sm" data-copy="' + esc(sub.secret) + '" onclick="copyFromData(this)">Copy secret</button>' +
                (stream ? '<button class="btn ghost sm" data-copy="' + esc(stream) + '" onclick="copyFromData(this)">Copy SSE URL</button>' : '') +
              '</div>' +
            '</div>';
          el('subsMsg').innerHTML = secretHtml;
        } else if (dataObj && dataObj.command && dataObj.command.status === 'failed') {
          el('subsMsg').textContent = 'Failed: ' + ((dataObj.command.error) || 'command failed');
        } else {
          el('subsMsg').textContent = 'Created.';
        }
        // Reset filter form for the next create, but keep the one-time secret panel visible.
        if (!(dataObj && dataObj.command && dataObj.command.status === 'failed')) {
          if (el('newTarget')) el('newTarget').value = '';
          if (el('newTickers')) el('newTickers').value = '';
          if (el('newMembers')) el('newMembers').value = '';
          if (el('newChambers')) el('newChambers').value = '';
          if (el('newSides')) el('newSides').value = '';
          if (el('newMinAmt')) el('newMinAmt').value = '';
          if (el('newDelivery')) el('newDelivery').value = 'sse';
          updateNewTargetVisibility();
        }
        loadSubs();
      }

      if (data && data.command && (data.command.status === 'queued' || data.command.status === 'running')) {
        var cmdId = data.command.id;
        var attempts = 0;
        var maxAttempts = 15;
        function pollCmd() {
          attempts++;
          fetch('/api/client/v1/commands/' + cmdId, { credentials: 'same-origin' })
            .then(function (res) { return res.json(); })
            .then(function (polled) {
              var status = polled && polled.command && polled.command.status;
              if (status === 'succeeded' || status === 'failed' || attempts >= maxAttempts) {
                renderResult(polled);
              } else {
                setTimeout(pollCmd, 750);
              }
            })
            .catch(function () {
              renderResult(data);
            });
        }
        setTimeout(pollCmd, 500);
      } else {
        renderResult(data);
      }
    })
    .catch(function (e) {
      if (e && e.status === 402) {
        el('subsMsg').textContent = 'Premium required.';
        openPricing('alerts');
        return;
      }
      el('subsMsg').textContent = 'Failed: ' + e.message;
    });
}

/* ============================ ADMIN REQUESTS ============================ */
// Session cookies carry admin identity for allowlisted emails.
function adminHeaders(extra) {
  return extra || {};
}
function adminOk(r) {
  if (r.status === 401) throw new Error('Admin access required — sign in with an account that has admin access.');
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r;
}
function admin401(r) {
  if (r.status === 401) throw new Error('Admin access required — sign in with an account that has admin access.');
  return r;
}

/* ============================ ADMIN · ACCESS CONTROL ============================
   Grant/revoke admin access for a user's email — in addition to ADMIN_EMAILS,
   which stays the env-configured root bootstrap and is read-only here.
   API HOOK: GET/POST /api/admin/admins, /api/admin/admins/grant|revoke. */
function setAdminGrantMsg(text, kind) {
  var msg = el('adminGrantMsg');
  if (!msg) return;
  msg.textContent = text || '';
  msg.style.color = kind === 'ok' ? 'var(--good)' : (kind === 'err' ? 'var(--sell)' : '');
}
// Like okOrThrow, but parses the JSON body on non-2xx too so a validation
// message from the server ("already an admin via ADMIN_EMAILS…", "cannot
// revoke the last remaining admin") reaches the UI instead of a bare "HTTP 400".
function adminMutationOk(r) {
  if (r.status === 401 || r.status === 403) { var e = new Error(ADMIN_MOVED_MSG); e.isAuth = true; throw e; }
  return r.json().catch(function () { return {}; }).then(function (data) {
    if (!r.ok) throw new Error((data && data.error) || ('HTTP ' + r.status));
    return data;
  });
}
function adminListRowHtml(email, grantedBy, grantedAt, revocable) {
  var emailAttr = esc(email);
  return '<tr>' +
    '<td>' + emailAttr + '</td>' +
    '<td class="muted">' + (revocable ? esc(grantedBy || '—') : 'ADMIN_EMAILS (environment)') + '</td>' +
    '<td class="muted">' + (revocable ? esc(dateTimeText(grantedAt)) : '—') + '</td>' +
    '<td style="text-align:right">' + (revocable
      ? '<button class="btn ghost sm" type="button" data-revoke-admin-email="' + emailAttr + '" onclick="revokeAdminEmail(this.getAttribute(\\'data-revoke-admin-email\\'))">Revoke</button>'
      : '<span class="note">not editable here</span>') +
    '</td>' +
  '</tr>';
}
function loadAdminList() {
  var body = el('adminListBody');
  if (!body) return Promise.resolve();
  body.innerHTML = '<tr><td class="state" colspan="4">Loading…</td></tr>';
  return fetch('/api/admin/admins', { headers: adminHeaders() })
    .then(okOrThrow)
    .then(function (data) {
      var rows = (data.adminEmails || []).map(function (email) { return adminListRowHtml(email, null, null, false); })
        .concat((data.granted || []).map(function (g) { return adminListRowHtml(g.email, g.grantedBy, g.grantedAt, true); }));
      body.innerHTML = rows.length ? rows.join('') : '<tr><td class="state" colspan="4">No admins configured.</td></tr>';
    })
    .catch(function (e) {
      body.innerHTML = '<tr><td class="state" colspan="4">' + esc(isAuthError(e) ? ADMIN_MOVED_MSG : ('Failed to load: ' + e.message)) + '</td></tr>';
    });
}
function grantAdminEmail() {
  var input = el('adminGrantEmail');
  var email = input ? input.value.trim() : '';
  if (!email) { setAdminGrantMsg('Enter an email first.', 'err'); return; }
  setAdminGrantMsg('Granting…', '');
  fetch('/api/admin/admins/grant', {
    method: 'POST',
    headers: adminHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ email: email }),
  })
    .then(adminMutationOk)
    .then(function () {
      setAdminGrantMsg('Granted admin access to ' + email + '.', 'ok');
      setTimeout(function () { setAdminGrantMsg('', ''); }, 4000);
      if (input) input.value = '';
      loadAdminList();
    })
    .catch(function (e) {
      setAdminGrantMsg(isAuthError(e) ? ADMIN_MOVED_MSG : e.message, 'err');
    });
}
function revokeAdminEmail(email) {
  if (!email) return;
  if (!window.confirm('Revoke admin access for ' + email + '?')) return;
  setAdminGrantMsg('Revoking…', '');
  fetch('/api/admin/admins/revoke', {
    method: 'POST',
    headers: adminHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ email: email }),
  })
    .then(adminMutationOk)
    .then(function () {
      setAdminGrantMsg('Revoked admin access for ' + email + '.', 'ok');
      setTimeout(function () { setAdminGrantMsg('', ''); }, 4000);
      loadAdminList();
    })
    .catch(function (e) {
      setAdminGrantMsg(isAuthError(e) ? ADMIN_MOVED_MSG : e.message, 'err');
    });
}

/* ============================ ADMIN · LOGOS (site-wide) ============================ */
function loadLogoSetting() {
  // API HOOK: GET /api/admin/ui-settings
  return fetch('/api/admin/ui-settings', { headers: adminHeaders() })
    .then(adminOk).then(function (r) { return r.json(); })
    .then(function (j) {
      logoDisplay = normalizeLogoDisplay(j.logoDisplay);
      if (el('adminLogo')) el('adminLogo').value = logoDisplay;
      renderTrades();
    })
    .catch(function (e) { if (el('logoMsg')) el('logoMsg').textContent = 'Could not load: ' + e.message; });
}
function saveLogoDisplay() {
  // API HOOK: PUT /api/admin/ui-settings
  var v = el('adminLogo').value;
  el('logoMsg').textContent = 'Saving…';
  fetch('/api/admin/ui-settings', {
    method: 'PUT', headers: adminHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ logoDisplay: v })
  })
    .then(admin401).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; }); })
    .then(function (j) {
      logoDisplay = normalizeLogoDisplay(j.logoDisplay);
      renderTrades();
      el('logoMsg').textContent = 'Saved — applies to all visitors.';
      setTimeout(function () { el('logoMsg').textContent = ''; }, 3000);
    })
    .catch(function (e) { el('logoMsg').textContent = 'Failed: ' + e.message; });
}

/* ============================ ADMIN · CADENCE ============================ */
function loadPollConfig() {
  // API HOOK: GET /api/admin/poll-config
  return fetch('/api/admin/poll-config', { headers: adminHeaders() })
    .then(okOrThrow)
    .then(function (cfg) {
      SCHEDULE = Array.isArray(cfg.schedule) ? cfg.schedule : [];
      aggressive = !!cfg.aggressiveMode;
      el('aggToggle').checked = aggressive;
      renderSchedule();
    })
    .catch(function (e) {
      el('schedRows').innerHTML = '<div class="note">' + esc(isAuthError(e) ? ADMIN_MOVED_MSG : ('Could not load poll config: ' + e.message)) + '</div>';
    });
}
function renderSchedule() {
  el('schedRows').innerHTML = SCHEDULE.map(function (w, i) {
    return '<div class="sched-row">' +
      '<input value="' + esc((w.daysOfWeek || []).join(',')) + '" onchange="SCHEDULE[' + i + '].daysOfWeek=this.value.split(\\',\\').map(Number).filter(function(n){return !isNaN(n)})" />' +
      '<input type="number" value="' + esc(w.startHourET) + '" onchange="SCHEDULE[' + i + '].startHourET=+this.value" />' +
      '<input type="number" value="' + esc(w.endHourET) + '" onchange="SCHEDULE[' + i + '].endHourET=+this.value" />' +
      '<input type="number" value="' + esc(w.intervalSec) + '" onchange="SCHEDULE[' + i + '].intervalSec=+this.value" />' +
    '</div>';
  }).join('');
    if (el('kpiMode')) el('kpiMode').innerHTML = aggressive ? 'Aggressive<small> · Fast</small>' : 'Standard';
}
function toggleAggressive() { aggressive = el('aggToggle').checked; renderSchedule(); }
function saveSchedule() {
  // API HOOK: PUT /api/admin/poll-config
  el('saveMsg').textContent = 'Saving…';
  fetch('/api/admin/poll-config', {
    method: 'PUT', headers: adminHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ schedule: SCHEDULE, aggressiveMode: aggressive })
  })
    .then(okOrThrow)
    .then(function () { el('saveMsg').textContent = 'Saved — effective within ~60s.'; setTimeout(function () { el('saveMsg').textContent = ''; }, 2500); })
    .catch(function (e) { el('saveMsg').textContent = isAuthError(e) ? ADMIN_MOVED_MSG : ('Failed: ' + e.message); });
}

/* ============================ HISTORIC BACKFILL ============================ */
function runBackfill(dryRun) {
  // API HOOK: POST /api/admin/backfill
  var payload = { dryRun: !!dryRun };
  var since = parseInt(el('bfSince').value, 10);
  if (!isNaN(since)) payload.sinceYear = since;
  var limit = parseInt(el('bfLimit').value, 10);
  if (!isNaN(limit) && limit > 0) payload.limit = limit;
  var ch = el('bfChambers').value;
  if (ch) payload.chambers = [ch];
  el('bfMsg').textContent = dryRun ? 'Counting…' : 'Running backfill…';
  fetch('/api/admin/backfill', {
    method: 'POST', headers: adminHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify(payload)
  })
    .then(function (r) {
      if (r.status === 401 || r.status === 403) { var ae = new Error(ADMIN_MOVED_MSG); ae.isAuth = true; throw ae; }
      return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; });
    })
    .then(function (j) {
      var verb = dryRun ? 'Would import' : 'Imported';
      var msg = verb + ' ' + j.inserted + ', skipped ' + j.skipped + '.';
      if (j.errors && j.errors.length) msg += ' Errors: ' + j.errors.join('; ');
      el('bfMsg').textContent = msg;
      if (!dryRun && j.inserted > 0) { cursor = 0; TRADES = []; totalRows = 0; realDataLoaded = false; loadTrades(); }
    })
    .catch(function (e) { el('bfMsg').textContent = isAuthError(e) ? ADMIN_MOVED_MSG : ('Failed: ' + e.message); });
}

function runHouseIndex(dryRun) {
  // API HOOK: POST /api/admin/house-backfill
  var from = parseInt(el('hiFrom').value, 10);
  var to = parseInt(el('hiTo').value, 10);
  var max = parseInt(el('hiMax').value, 10);
  if (isNaN(from) || isNaN(to)) { el('hiMsg').textContent = 'Enter a from/to year.'; return; }
  if (isNaN(max) || max < 1) max = 500;
  el('hiMsg').textContent = dryRun ? 'Counting…' : 'Enqueuing (this can take a while)…';
  fetch('/api/admin/house-backfill', {
    method: 'POST', headers: adminHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ fromYear: from, toYear: to, maxFilings: max, dryRun: !!dryRun })
  })
    .then(function (r) {
      if (r.status === 401 || r.status === 403) { var ae = new Error(ADMIN_MOVED_MSG); ae.isAuth = true; throw ae; }
      return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; });
    })
    .then(function (j) {
      var years = Object.keys(j.byYear || {}).length;
      el('hiMsg').textContent = dryRun
        ? ('Found ' + (j.discovered || 0) + ' PTRs across ' + years + ' year(s).')
        : ('Enqueued ' + (j.enqueued || 0) + ' new filing(s) from ' + (j.discovered || 0) + ' PTRs.' + (j.errors && j.errors.length ? ' Errors: ' + j.errors.join('; ') : ''));
    })
    .catch(function (e) { el('hiMsg').textContent = isAuthError(e) ? ADMIN_MOVED_MSG : ('Failed: ' + e.message); });
}

function runQueueReprocess() {
  // API HOOK: POST /api/admin/reprocess
  var chamber = el('reprocChamber').value;
  var limit = parseInt(el('reprocLimit').value, 10);
  if (isNaN(limit) || limit < 1) limit = 500;
  
  el('reprocMsg').textContent = 'Reprocessing...';
  fetch('/api/admin/reprocess', {
    method: 'POST', headers: adminHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ chamber: chamber, limit: limit })
  })
    .then(function (r) {
      if (r.status === 401 || r.status === 403) { var ae = new Error(ADMIN_MOVED_MSG); ae.isAuth = true; throw ae; }
      return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; });
    })
    .then(function (j) {
      el('reprocMsg').textContent = 'Success! Reprocessed ' + (j.processed || 0) + ' items.';
      loadReview();
    })
    .catch(function (e) { el('reprocMsg').textContent = isAuthError(e) ? ADMIN_MOVED_MSG : ('Failed: ' + e.message); });
}

function runOgeBackfill() {
  // API HOOK: POST /api/admin/oge-backfill
  el('ogeMsg').textContent = 'Polling OGE index…';
  fetch('/api/admin/oge-backfill', {
    method: 'POST', headers: adminHeaders({ 'content-type': 'application/json' })
  })
    .then(function (r) {
      if (r.status === 401 || r.status === 403) { var ae = new Error(ADMIN_MOVED_MSG); ae.isAuth = true; throw ae; }
      return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; });
    })
    .then(function (j) {
      el('ogeMsg').textContent = 'Done. Found ' + (j.newFilings || 0) + ' new filing(s).';
    })
    .catch(function (e) { el('ogeMsg').textContent = isAuthError(e) ? ADMIN_MOVED_MSG : ('Failed: ' + e.message); });
}

/* ============================ SOURCE HEALTH ============================ */
function loadHealth() {
  // API HOOK: GET /api/admin/sources/health
  return fetch('/api/admin/sources/health', { headers: adminHeaders() })
    .then(okOrThrow)
    .then(function (data) {
      var sources = data.sources || [];
      var timeline = data.timeline || [];
      var recentFailures = data.recentFailures || [];
      var body = el('healthBody');
      var resetMsg = el('latencyResetMsg');
      if (resetMsg) resetMsg.textContent = data.latencyResetAt ? ('Latency reset: ' + dateTimeText(data.latencyResetAt)) : '';
      if (sources.length === 0) { body.innerHTML = stateRow(9, 'No source check activity logged yet.'); return; }
      body.innerHTML = sources.map(function (s) {
        var avg = s.avgIntervalSec == null ? '—' : '~' + fmtDuration(s.avgIntervalSec);
        var rts = s.avgReleasedToSeenSec == null ? '—' : '~' + fmtDuration(s.avgReleasedToSeenSec);
        var sti = s.avgSeenToImportedSec == null ? '—' : fmtDuration(s.avgSeenToImportedSec);
        var status = s.status || 'unknown';
        if (status === 'unknown') status = 'unknown (TBD)';
        if (s.stale && status === 'error') status += ' · stale';
        var statusTitle = s.lastError || (s.stale ? ('No successful check within ' + fmtDuration(s.staleAfterSec || 0)) : '');
        return '<tr class="row">' +
          '<td>' + esc(chamberLabel(s.source)) + '</td>' +
          '<td title="' + esc(statusTitle) + '">' + esc(status) + '</td>' +
          '<td class="muted">' + esc(dateTimeText(s.lastPolledAt)) + '</td>' +
          '<td class="muted">' + esc(dateTimeText(s.lastNewFilingAt)) + '</td>' +
          '<td class="muted">' + esc(s.pollCount != null ? s.pollCount : '—') + '</td>' +
          '<td class="muted">' + esc(s.totalNew != null ? s.totalNew : '—') + '</td>' +
          '<td class="latency">' + esc(avg) + '</td>' +
          '<td class="latency">' + esc(sti) + '</td>' +
        '</tr>';
      }).join('');

      renderSourceHealthTimeline(sources, timeline, recentFailures);
    })
    .catch(function (e) {
      el('healthBody').innerHTML = stateRow(9, isAuthError(e) ? ADMIN_MOVED_MSG : ('Could not load source health: ' + e.message));
    });
}

function renderSourceHealthTimeline(sources, timeline, recentFailures) {
  var grid = el('sourceStatsGrid');
  var graphic = el('sourceTimelineGraphic');
  var errorsEl = el('sourceRecentErrors');
  if (!grid || !graphic) return;

  // 1. Group 24-hour statistics per source
  var statsBySource = {};
  var knownSources = ['house', 'senate', 'executive'];
  knownSources.forEach(function (src) {
    statsBySource[src] = { total: 0, failures: 0, successes: 0, newFilings: 0 };
  });

  timeline.forEach(function (row) {
    var src = row.source;
    if (!statsBySource[src]) statsBySource[src] = { total: 0, failures: 0, successes: 0, newFilings: 0 };
    statsBySource[src].total += (row.total || 0);
    statsBySource[src].failures += (row.failures || 0);
    statsBySource[src].successes += (row.successes || 0);
    statsBySource[src].newFilings += (row.new_filings || 0);
  });

  grid.innerHTML = Object.keys(statsBySource).map(function (src) {
    var st = statsBySource[src];
    var errRate = st.total > 0 ? ((st.failures / st.total) * 100).toFixed(1) : '0.0';
    var color = st.failures > 0 ? (Number(errRate) > 10 ? 'var(--sell)' : '#f59e0b') : 'var(--buy)';
    return '<div style="background:var(--bg-card);border:1px solid var(--border);border-radius:6px;padding:12px 14px">' +
      '<div style="font-size:12px;font-weight:600;text-transform:uppercase;color:var(--text-muted);margin-bottom:4px">' + esc(chamberLabel(src)) + ' (24h)</div>' +
      '<div style="font-size:18px;font-weight:700;color:' + color + '">' + st.failures + ' <span style="font-size:13px;font-weight:400;color:var(--text-muted)">errors / ' + st.total + ' polls (' + errRate + '%)</span></div>' +
      '<div style="font-size:12px;color:var(--text-muted);margin-top:4px">Successes: ' + st.successes + ' · Filings Discovered: ' + st.newFilings + '</div>' +
    '</div>';
  }).join('');

  // 2. Build 24-Hour Timeline Bar Chart
  var now = new Date();
  var hours = [];
  for (var i = 23; i >= 0; i--) {
    var d = new Date(now.getTime() - i * 3600_000);
    var hourKey = d.toISOString().slice(0, 13) + ':00:00.000Z';
    var hourLabel = d.getHours() + ':00';
    hours.push({ key: hourKey, label: hourLabel });
  }

  var hourlyMap = {};
  hours.forEach(function (h) { hourlyMap[h.key] = { total: 0, failures: 0, houseFail: 0, senateFail: 0, ogeFail: 0 }; });

  timeline.forEach(function (row) {
    var hk = row.hour;
    if (hourlyMap[hk]) {
      hourlyMap[hk].total += (row.total || 0);
      hourlyMap[hk].failures += (row.failures || 0);
      if (row.source === 'house') hourlyMap[hk].houseFail += (row.failures || 0);
      if (row.source === 'senate') hourlyMap[hk].senateFail += (row.failures || 0);
      if (row.source === 'executive' || row.source === 'oge') hourlyMap[hk].ogeFail += (row.failures || 0);
    }
  });

  var barHtml = hours.map(function (h) {
    var hm = hourlyMap[h.key] || { total: 0, failures: 0 };
    var hasFail = hm.failures > 0;
    var barColor = hasFail ? 'var(--sell)' : (hm.total > 0 ? 'var(--buy)' : 'var(--border)');
    var barHeight = Math.min(Math.max(hm.total * 3, 12), 48);
    var tip = h.label + ' UTC: ' + hm.total + ' polls (' + hm.failures + ' errors)';

    return '<div style="flex:1;display:flex;flex-direction:column;align-items:center" title="' + esc(tip) + '">' +
      '<div style="font-size:10px;color:var(--text-muted);margin-bottom:4px">' + (hasFail ? '⚠️' : '') + '</div>' +
      '<div style="width:100%;max-width:14px;height:' + barHeight + 'px;background:' + barColor + ';border-radius:2px"></div>' +
      '<div style="font-size:9px;color:var(--text-muted);margin-top:4px;white-space:nowrap">' + h.label + '</div>' +
    '</div>';
  }).join('');

  graphic.innerHTML = '<div style="font-size:12px;font-weight:600;margin-bottom:10px">Hourly Ingestion Health & Error Timeline (24 Hours)</div>' +
    '<div style="display:flex;align-items:flex-end;gap:4px;height:70px;padding-top:10px;border-bottom:1px solid var(--border)">' + barHtml + '</div>' +
    '<div style="display:flex;gap:16px;margin-top:8px;font-size:11px;color:var(--text-muted)">' +
      '<span><span style="display:inline-block;width:10px;height:10px;background:var(--buy);border-radius:2px;margin-right:4px"></span> 100% Successful Polls</span>' +
      '<span><span style="display:inline-block;width:10px;height:10px;background:var(--sell);border-radius:2px;margin-right:4px"></span> Failed Poll Attempts</span>' +
    '</div>';

  // 3. Render Recent Failures Log
  if (recentFailures.length > 0) {
    errorsEl.innerHTML = '<div style="font-size:13px;font-weight:600;margin-bottom:8px;color:var(--sell)">Recent Ingestion Failures & Errors</div>' +
      '<table style="width:100%;font-size:12px;border-collapse:collapse">' +
        '<thead><tr style="text-align:left;color:var(--text-muted)"><th>Timestamp</th><th>Source</th><th>Error Message</th></tr></thead>' +
        '<tbody>' + recentFailures.slice(0, 5).map(function (rf) {
          return '<tr style="border-top:1px solid var(--border)">' +
            '<td style="padding:6px 0" class="muted">' + esc(dateTimeText(rf.attempted_at)) + '</td>' +
            '<td style="padding:6px 0"><strong>' + esc(chamberLabel(rf.source)) + '</strong></td>' +
            '<td style="padding:6px 0;color:var(--sell)">' + esc(rf.error || 'Unknown error') + '</td>' +
          '</tr>';
        }).join('') + '</tbody>' +
      '</table>';
  } else {
    errorsEl.innerHTML = '<div style="font-size:12px;color:var(--buy)">✓ No ingestion failures recorded in the recent log window.</div>';
  }
}

function resetLatencyMetrics() {
  var msg = el('latencyResetMsg');
  if (msg) msg.textContent = 'Resetting…';
  return fetch('/api/admin/sources/health/latency-reset', {
    method: 'POST',
    headers: adminHeaders({ 'content-type': 'application/json' }),
    body: '{}'
  })
    .then(okOrThrow)
    .then(function (data) {
      if (msg) msg.textContent = 'Latency reset: ' + dateTimeText(data.latencyResetAt);
      return loadHealth();
    })
    .catch(function (e) {
      if (msg) msg.textContent = isAuthError(e) ? ADMIN_MOVED_MSG : ('Reset failed: ' + e.message);
    });
}

function loadDiagnostics() {
  // API HOOK: GET /api/admin/diagnostics
  var cards = el('diagConnections');
  var errors = el('diagErrors');
  var users = el('diagUsers');
  var logins = el('diagLogins');
  var settingsTable = el('diagSettings');
  if (cards) cards.innerHTML = '<div class="state">Loading connection status…</div>';
  if (errors) errors.innerHTML = stateRow(4, 'Loading recent errors…');
  if (users) users.innerHTML = '<div class="state">Loading users…</div>';
  if (logins) logins.innerHTML = stateRow(4, 'Loading recent logins…');
  if (settingsTable) settingsTable.innerHTML = stateRow(4, 'Loading settings…');
  loadPremiumRoster();
  return fetch('/api/admin/diagnostics', { headers: adminHeaders() })
    .then(okOrThrow)
    .then(function (data) {
      var connections = data.connections || [];
      if (cards) {
        if (connections.length === 0) {
          cards.innerHTML = '<div class="state">No connection status available yet.</div>';
        } else {
          cards.innerHTML = connections.map(function (c) {
            var st = c.status || 'unknown';
            if (st === 'unknown') st = 'unknown (TBD)';
            var configured = c.configured == null ? '—' : (c.configured ? 'Yes' : 'No');
            return '<div class="diag-card">' +
              '<div class="diag-head"><div class="diag-title">' + esc(c.label || c.id || 'Connection') + '</div>' +
                '<span class="diag-status ' + esc(st.split(' ')[0]) + '">' + esc(st) + '</span></div>' +
              '<div class="diag-meta">' +
                '<span>Configured</span><strong>' + esc(configured) + '</strong>' +
                '<span>Last Used</span><strong>' + esc(dateTimeText(c.lastUsedAt)) + '</strong>' +
                '<span>Total</span><strong>' + esc(c.callsTotal != null ? c.callsTotal : 0) + '</strong>' +
                '<span>24h / Today</span><strong>' + esc((c.callsLast24h || 0) + ' / ' + (c.callsToday || 0)) + '</strong>' +
                '<span>Errors 24h</span><strong class="' + (c.errorsLast24h ? 'diag-error' : '') + '">' + esc(c.errorsLast24h || 0) + '</strong>' +
              '</div>' +
              (c.note ? '<div class="diag-note">' + esc(c.note) + '</div>' : '') +
            '</div>';
          }).join('');
        }
      }
      // Load config-sources (separate endpoint) for the Settings / Runtime Secrets table
      if (settingsTable) {
        fetch('/api/admin/config-sources', { headers: adminHeaders() })
          .then(okOrThrow)
          .then(function (cs) {
            var items = cs.items || [];
            if (items.length === 0) {
              settingsTable.innerHTML = stateRow(4, 'No settings available.');
            } else {
              settingsTable.innerHTML = items.map(function(item) {
                return '<tr class="row">' +
                  '<td class="muted">' + esc(item.category) + '</td>' +
                  '<td><code>' + esc(item.key) + '</code></td>' +
                  '<td class="muted">' + esc(item.source) + '</td>' +
                  '<td style="text-align:right" id="secret-action-' + esc(item.key) + '"><button class="btn ghost sm" data-source="' + esc(item.source) + '" data-key="' + esc(item.key) + '" onclick="editInfisicalSecret(this)">Edit</button></td>' +
                '</tr>';
              }).join('');
            }
          })
          .catch(function () {
            settingsTable.innerHTML = stateRow(4, 'Failed to load settings.');
          });
      }
      var stats = data.userStats || {};
      if (users) {
        users.innerHTML =
          diagMetricCard('Users', stats.totalUsers) +
          diagMetricCard('Premium', stats.premiumUsers != null ? stats.premiumUsers : stats.subscribedUsers) +
          diagMetricCard('Trial', stats.trialUsers) +
          diagMetricCard('Paid', stats.paidUsers) +
          diagMetricCard('Stripe', stats.stripeUsers) +
          diagMetricCard('Apple', stats.appleUsers) +
          diagMetricCard('Delivery Subs', (stats.activeDeliverySubscriptions || 0) + ' / ' + (stats.deliverySubscriptions || 0)) +
          diagMetricCard('Admins', stats.adminUsers) +
          diagMetricCard('Logins 24h', stats.loginsLast24h);
      }
      if (logins) {
        var loginRows = stats.recentLogins || [];
        if (loginRows.length === 0) {
          logins.innerHTML = stateRow(4, 'No recent logins found.');
        } else {
          logins.innerHTML = loginRows.map(function (u) {
            var plan = loginPlanLabel(u.plan, u.subscriptionStatus);
            return '<tr class="row">' +
              '<td class="muted">' + esc(dateTimeText(u.lastLoginAt)) + '</td>' +
              '<td>' + esc(u.email || '—') + '</td>' +
              '<td class="muted">' + esc(u.name || '—') + '</td>' +
              '<td class="muted">' + esc(plan) + '</td>' +
            '</tr>';
          }).join('');
        }
      }
      var rows = data.errors || [];
      if (errors) {
        if (rows.length === 0) {
          errors.innerHTML = stateRow(4, 'No recent app errors found.');
        } else {
          errors.innerHTML = rows.map(function (e) {
            var sev = e.severity === 'warning' ? 'diag-warning' : 'diag-error';
            return '<tr class="row">' +
              '<td class="muted">' + esc(dateTimeText(e.at)) + '</td>' +
              '<td class="' + sev + '">' + esc(e.area || 'App') + '</td>' +
              '<td class="muted">' + ((e.subject && e.subject.match(/^[HS]-/)) ? '<a href="' + esc(reconstructFilingUrl(e.subject)) + '" target="_blank" style="color:inherit;text-decoration:underline">' + esc(e.subject) + '</a>' : esc(e.subject || '—')) + '</td>' +
              '<td>' + esc(e.message || '—') + '</td>' +
            '</tr>';
          }).join('');
        }
      }
    })
    .catch(function (e) {
      if (cards) cards.innerHTML = '<div class="state">' + esc(isAuthError(e) ? ADMIN_MOVED_MSG : ('Could not load diagnostics: ' + e.message)) + '</div>';
      if (errors) errors.innerHTML = stateRow(4, isAuthError(e) ? ADMIN_MOVED_MSG : ('Could not load diagnostics: ' + e.message));
      if (users) users.innerHTML = '<div class="state">' + esc(isAuthError(e) ? ADMIN_MOVED_MSG : ('Could not load diagnostics: ' + e.message)) + '</div>';
      if (logins) logins.innerHTML = stateRow(4, isAuthError(e) ? ADMIN_MOVED_MSG : ('Could not load diagnostics: ' + e.message));
    });
}

function diagMetricCard(label, value) {
  return '<div class="diag-card">' +
    '<div class="diag-head"><div class="diag-title">' + esc(label) + '</div></div>' +
    '<div class="v">' + esc(value == null ? 0 : value) + '</div>' +
  '</div>';
}

function loginPlanLabel(plan, status) {
  var planText = plan === 'annual' ? 'Annual' : (plan === 'monthly' ? 'Monthly' : '');
  var billing = status === 'trialing' ? 'Trial' : (status === 'active' ? 'Paid' : (status || ''));
  var parts = [planText, billing].filter(Boolean);
  return parts.length ? parts.join('  ·  ') : '—';
}

function loadPremiumRoster() {
  var cards = el('diagPremiumCards');
  var body = el('diagPremiumRoster');
  if (cards) cards.innerHTML = '<div class="state">Loading Premium members…</div>';
  if (body) body.innerHTML = stateRow(7, 'Loading Premium members…');
  return fetch('/api/admin/premium-roster', { headers: adminHeaders() })
    .then(okOrThrow)
    .then(function (data) {
      var summary = data.summary || {};
      if (cards) {
        cards.innerHTML =
          diagMetricCard('Premium', summary.total) +
          diagMetricCard('Trial', summary.trial) +
          diagMetricCard('Paid', summary.paid) +
          diagMetricCard('Stripe', summary.stripe) +
          diagMetricCard('Apple', summary.apple) +
          diagMetricCard('Sandbox', summary.sandbox) +
          diagMetricCard('Production', summary.production);
      }
      var rows = data.members || [];
      if (body) {
        if (rows.length === 0) {
          body.innerHTML = stateRow(7, 'No Premium members yet.');
        } else {
          body.innerHTML = rows.map(function (m) {
            return '<tr class="row">' +
              '<td>' + esc(m.email || '—') + '</td>' +
              '<td class="muted">' + esc(m.plan || '—') + '</td>' +
              '<td>' + esc(m.billing || '—') + '</td>' +
              '<td class="muted">' + esc(m.source || '—') + '</td>' +
              '<td class="muted">' + esc(m.environment || '—') + '</td>' +
              '<td class="muted">' + esc(dateTimeText(m.periodEnd)) + '</td>' +
              '<td class="muted">' + esc(m.stripeMatch || '—') + '</td>' +
            '</tr>';
          }).join('');
        }
      }
    })
    .catch(function (e) {
      var msg = isAuthError(e) ? ADMIN_MOVED_MSG : ('Could not load Premium members: ' + e.message);
      if (cards) cards.innerHTML = '<div class="state">' + esc(msg) + '</div>';
      if (body) body.innerHTML = stateRow(7, msg);
    });
}

function refreshInfisicalSecrets() {
  var msg = el('secretRefreshMsg');
  if (msg) msg.textContent = 'Refreshing…';
  return fetch('/api/admin/diagnostics/secrets/refresh', {
    method: 'POST',
    headers: adminHeaders({ 'content-type': 'application/json' }),
    body: '{}'
  })
    .then(okOrThrow)
    .then(function () {
      if (msg) msg.textContent = 'Refreshed.';
      setTimeout(function () { if (msg) msg.textContent = ''; }, 2500);
      return loadDiagnostics();
    })
    .catch(function (e) {
      if (msg) msg.textContent = isAuthError(e) ? ADMIN_MOVED_MSG : ('Refresh failed: ' + e.message);
    });
}

function editInfisicalSecret(btn) {
  var source = btn.getAttribute('data-source');
  var key = btn.getAttribute('data-key');
  var td = el('secret-action-' + key);
  if (!td) return;
  // Normalize display source (infisical/env/missing) to writable scope (app/shared).
  // When we cannot determine the project scope, default to 'app'.
  var scope = (source === 'app' || source === 'shared') ? source : 'app';
  td.innerHTML = '<div class="row-flex" style="justify-content:flex-end; align-items:center; gap:8px;">' +
    '<select id="secret-src-' + key + '" class="input sm" style="max-width:80px; margin:0;">' +
    '<option value="app"' + (scope === 'app' ? ' selected' : '') + '>app</option>' +
    '<option value="shared"' + (scope === 'shared' ? ' selected' : '') + '>shared</option>' +
    '</select>' +
    '<form style="display:contents" onsubmit="event.preventDefault(); updateInfisicalSecret(&quot;' + key + '&quot;);">' +
    '<input type="password" id="secret-val-' + key + '" class="input sm" placeholder="New Value" style="max-width:140px; margin:0;" />' +
    '<button class="btn sm" type="submit">Save</button>' +
    '</form>' +
    '<button class="btn ghost sm" onclick="loadDiagnostics()">Cancel</button>' +
  '</div>';
  var input = el('secret-val-' + key);
  if (input) input.focus();
}

function updateInfisicalSecret(key) {
  var msg = el('secretRefreshMsg'); // Re-use the refresh msg span for status updates
  var srcEl = el('secret-src-' + key);
  var source = srcEl ? srcEl.value : 'app';
  var input = el('secret-val-' + key);
  // Do NOT trim the value: empty string is a documented "off" state for some
  // config flags, and trimming would strip significant whitespace from a secret.
  var value = input ? input.value : '';

  if (msg) msg.textContent = 'Updating ' + key + '…';

  if (input) input.disabled = true;
  var btns = el('secret-action-' + key).querySelectorAll('button');
  btns.forEach(function(b) { b.disabled = true; });

  return fetch('/api/admin/diagnostics/secrets/update', {
    method: 'POST',
    headers: adminHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ source: source, key: key, value: value })
  })
    .then(okOrThrow)
    .then(function () {
      if (msg) {
        msg.textContent = 'Updated ' + key;
        setTimeout(function () { if (msg.textContent.indexOf('Updated') === 0) msg.textContent = ''; }, 3000);
      }
      return loadDiagnostics();
    })
    .catch(function (e) {
      if (msg) msg.textContent = isAuthError(e) ? ADMIN_MOVED_MSG : ('Update failed: ' + e.message);
      if (input) input.disabled = false;
      btns.forEach(function(b) { b.disabled = false; });
    });
}

function pctText(v) {
  return v == null ? '—' : Math.round(Number(v) * 100) + '%';
}
function coverageCard(title, count, total, pct, note) {
  return '<div class="diag-card">' +
    '<div class="diag-head"><div class="diag-title">' + esc(title) + '</div><span class="diag-status ' + (pct != null && pct >= 0.8 ? 'ok' : 'warn') + '">' + esc(pctText(pct)) + '</span></div>' +
    '<div class="diag-meta"><span>Covered</span><strong>' + esc(count || 0) + '</strong><span>Total</span><strong>' + esc(total || 0) + '</strong></div>' +
    (note ? '<div class="diag-note">' + esc(note) + '</div>' : '') +
  '</div>';
}
/* ---- LLM spend + LlamaParse credits panel ---- */
var llmSpendReportCache = null;
var llmSpendPeriod = 'week';

function fmtUsdPrecise(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  var v = Number(n);
  if (v === 0) return '$0';
  // Sub-cent amounts are common per-call; show enough precision to be non-zero.
  var decimals = v < 0.01 ? 4 : 2;
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}
function fmtShortDate(iso) {
  if (!iso) return '—';
  var d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
function setLlmSpendPeriod(period) {
  llmSpendPeriod = period;
  var wk = el('llmSpendPeriodWeek'), mo = el('llmSpendPeriodMonth');
  if (wk) wk.classList.toggle('on', period === 'week');
  if (mo) mo.classList.toggle('on', period === 'month');
  renderLlmSpendByModel();
}
function llamaParseCreditCard(account) {
  var title = account.orgName || ('Key ' + account.keyIndex);
  var status = account.error ? 'unknown' : (account.exhausted ? 'error' : 'ok');
  var statusText = account.error ? 'Error' : (account.exhausted ? 'Exhausted' : 'OK');
  var body;
  if (account.error) {
    body = '<div class="diag-note">' + esc(account.error) + '</div>';
  } else {
    body =
      '<div class="v">' + esc(fmtCount(account.remaining)) + ' <span style="font-size:12px;color:var(--text-dim)">/ ' + esc(fmtCount(account.total)) + '</span></div>' +
      '<div class="diag-meta"><span>Resets</span><strong>' + esc(fmtShortDate(account.resetsAt)) + '</strong></div>';
  }
  return '<div class="diag-card">' +
    '<div class="diag-head"><div class="diag-title" title="' + esc(title) + '">' + esc(title) + '</div><span class="diag-status ' + status + '">' + esc(statusText) + '</span></div>' +
    body +
  '</div>';
}
function renderLlamaParseCredits(credits) {
  var grid = el('llamaParseCreditsGrid');
  if (!grid) return;
  if (!credits) { grid.innerHTML = '<div class="state">No LlamaParse key configured.</div>'; return; }
  var cards = [
    '<div class="diag-card" style="border-color:var(--accent)">' +
      '<div class="diag-head"><div class="diag-title">All Accounts (Total)</div></div>' +
      '<div class="v">' + esc(fmtCount(credits.totals.remaining)) + ' <span style="font-size:12px;color:var(--text-dim)">/ ' + esc(fmtCount(credits.totals.total)) + '</span></div>' +
      '<div class="diag-meta"><span>Checked</span><strong>' + esc(credits.totals.accountsChecked) + '</strong><span>Errored</span><strong>' + esc(credits.totals.accountsErrored) + '</strong></div>' +
    '</div>'
  ].concat(credits.accounts.map(llamaParseCreditCard));
  grid.innerHTML = cards.join('');
}
function renderLlmSpendByModel() {
  var tbody = el('llmSpendByModelTable');
  var label = el('llmSpendRangeLabel');
  if (!tbody) return;
  var report = llmSpendReportCache && llmSpendReportCache.spend && llmSpendReportCache.spend[llmSpendPeriod];
  if (!report) {
    tbody.innerHTML = '<tr><td colspan="5" class="state">No spend data for this period.</td></tr>';
    if (label) label.textContent = '';
    return;
  }
  if (label) label.textContent = '(' + report.rangeStart + ' to ' + report.rangeEnd + ' — ' + fmtCount(report.totalDocs) + ' docs, ' + fmtCount(report.totalCalls) + ' calls, ' + fmtUsdPrecise(report.totalUsd) + ' total)';
  if (!report.byModel.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="state">No paid LLM calls in this period.</td></tr>';
    return;
  }
  tbody.innerHTML = report.byModel.map(function (r) {
    var spendCell = r.provider === 'llamaparse'
      ? esc(fmtCount(Math.round(r.totalUsd * 800))) + ' credits <span style="font-size:11px;color:var(--text-dim)">(' + esc(fmtUsdPrecise(r.totalUsd)) + ')</span>'
      : esc(fmtUsdPrecise(r.totalUsd));
    return '<tr class="row"><td>' + esc(r.provider) + '</td><td>' + esc(r.model) + '</td><td>' + esc(fmtCount(r.docCount)) + '</td><td>' + esc(fmtCount(r.callCount)) + '</td><td>' + spendCell + '</td></tr>';
  }).join('');
}
function renderExtraction30d(m) {
  var grid = el('extraction30dGrid');
  if (!grid) return;
  if (!m) { grid.innerHTML = '<div class="state">No 30-day extraction metrics available.</div>'; return; }
  var detMethods = Object.keys(m.deterministic.byMethod || {}).map(function (k) {
    return esc(k) + ': ' + esc(fmtCount(m.deterministic.byMethod[k]));
  }).join(' · ') || 'None';
  var paid = m.paidLlm || {};
  var maxDocStr = paid.highestCostDocId ? (' (Doc: ' + esc(paid.highestCostDocId) + ')') : '';
  grid.innerHTML =
    '<div class="diag-card">' +
      '<div class="diag-head"><div class="diag-title">Total Identified Docs</div></div>' +
      '<div class="v">' + esc(fmtCount(m.totalIdentifiedDocs)) + '</div>' +
      '<div class="diag-meta"><span>30-Day Window</span><strong>' + esc(m.sinceDay) + ' to ' + esc(m.throughDay) + '</strong></div>' +
    '</div>' +
    '<div class="diag-card">' +
      '<div class="diag-head"><div class="diag-title">Deterministic Method Docs</div></div>' +
      '<div class="v">' + esc(fmtCount(m.deterministic.totalDocs)) + '</div>' +
      '<div class="diag-meta"><span>By Method</span><strong>' + detMethods + '</strong></div>' +
    '</div>' +
    '<div class="diag-card" style="border-color:var(--accent)">' +
      '<div class="diag-head"><div class="diag-title">Paid LLM Method Docs</div></div>' +
      '<div class="v">' + esc(fmtCount(paid.totalDocs)) + '</div>' +
      '<div class="diag-meta"><span>Average Cost</span><strong>' + esc(fmtUsdPrecise(paid.avgCostUsd)) + '</strong>' +
      '<span>P90 Cost</span><strong>' + esc(fmtUsdPrecise(paid.p90CostUsd)) + '</strong>' +
      '<span>Highest Cost</span><strong>' + esc(fmtUsdPrecise(paid.maxCostUsd)) + maxDocStr + '</strong></div>' +
    '</div>';
}

function loadLlmSpendPanel(forceRefresh) {
  var msg = el('llmSpendMsg');
  if (msg) msg.textContent = 'Loading…';
  var grid = el('llamaParseCreditsGrid');
  if (grid && !llmSpendReportCache) grid.innerHTML = '<div class="state">Loading LlamaParse credit balances…</div>';
  return fetch('/api/admin/llm-spend-report' + (forceRefresh ? '?refreshCredits=1' : ''), { headers: adminHeaders() })
    .then(okOrThrow)
    .then(function (data) {
      llmSpendReportCache = data;
      renderExtraction30d(data.extraction30d);
      renderLlamaParseCredits(data.llamaParseCredits);
      renderLlmSpendByModel();
      if (msg) msg.textContent = 'Updated ' + new Date().toLocaleTimeString();
    })
    .catch(function (e) {
      var m = isAuthError(e) ? ADMIN_MOVED_MSG : ('Could not load spend report: ' + e.message);
      if (msg) msg.textContent = m;
      if (grid && !llmSpendReportCache) grid.innerHTML = '<div class="state">' + esc(m) + '</div>';
    });
}

function loadInstrumentPricing() {
  var box = el('instrumentPricingCaps');
  if (box) box.innerHTML = '<div class="state">Loading instrument pricing…</div>';
  return fetch('/api/admin/instrument-pricing', { headers: adminHeaders() })
    .then(okOrThrow)
    .then(function (data) {
      var caps = data.capabilities || [];
      var rows = caps.map(function (c) {
        var minute = c.minutePricing === 'minute' ? 'Yes (1-minute PIT)' : 'No';
        var eod = c.eodPricing ? 'Yes' : 'No';
        return '<tr class="row"><td>' + esc(c.label || c.class) + '</td>' +
          '<td>' + esc(minute) + '</td>' +
          '<td>' + esc(eod) + '</td>' +
          '<td class="muted">' + esc(c.sessions || '—') + '</td>' +
          '<td class="muted">' + esc(c.note || '') + '</td></tr>';
      }).join('');
      var ci = data.committeeIndustry || {};
      var prov = data.snapshotProvenance || [];
      var provLine = prov.length
        ? prov.map(function (p) { return esc(p.timeProvenance) + ': ' + esc(p.n); }).join(' · ')
        : 'no snapshot rows yet';
      if (box) box.innerHTML =
        '<div class="table-wrap"><table><thead><tr><th>Class</th><th>Minute PIT</th><th>EOD</th><th>Session</th><th>Notes</th></tr></thead><tbody>' +
        (rows || '<tr><td class="state" colspan="5">No capability rows.</td></tr>') +
        '</tbody></table></div>' +
        '<p class="note" style="margin-top:10px">Committee→industry map <strong>' + esc(ci.version || '—') + '</strong> · ' +
        esc(ci.ruleCount || 0) + ' rules.&nbsp; ' + esc(ci.note || '') + '</p>' +
        '<p class="note">Snapshot timestamp provenance — ' + provLine + '.</p>';
    })
    .catch(function (e) {
      if (box) box.innerHTML = '<div class="state">Could not load instrument pricing. ' + esc((e && e.message) || 'error') + '</div>';
    });
}

function lookupExactPrice() {
  var ticker = (el('ipTicker') && el('ipTicker').value || '').trim();
  var at = (el('ipAt') && el('ipAt').value || '').trim();
  var isOption = !!(el('ipOption') && el('ipOption').checked);
  var msg = el('ipLookupMsg');
  var out = el('ipLookupResult');
  if (msg) msg.textContent = 'Looking up…';
  if (out) out.textContent = '';
  var qs = 'ticker=' + encodeURIComponent(ticker) + '&at=' + encodeURIComponent(at) + (isOption ? '&isOption=1' : '');
  return fetch('/api/admin/instrument-pricing/at?' + qs, { headers: adminHeaders() })
    .then(okOrThrow)
    .then(function (data) {
      if (msg) msg.textContent = '';
      if (!out) return;
      if (data.ok) {
        out.textContent = data.ticker + ' at ' + data.barAt + ' → $' + data.price + ' (' + (data.source || 'peer') + ', ' + (data.instrumentClass || '') + ')';
      } else {
        out.textContent = (data.message || 'No price') + (data.instrumentClass ? ' [' + data.instrumentClass + ']' : '');
      }
    })
    .catch(function (e) {
      if (msg) msg.textContent = '';
      if (out) out.textContent = (e && e.message) || 'Lookup failed.';
    });
}

function loadMarketCoverage() {
  var box = el('marketCoverage');
  var msg = el('mdMsg');
  if (box) box.innerHTML = '<div class="state">Loading market-data coverage…</div>';
  if (msg) msg.textContent = '';
  return fetch('/api/admin/enrich-securities/status', { headers: adminHeaders() })
    .then(okOrThrow)
    .then(function (data) {
      var c = data.coverage || {};
      var t = c.trades || {}, a = c.assets || {};
      var pending = data.pendingTickers == null ? '—' : data.pendingTickers;
      var prices = data.pricePendingTickers == null ? '—' : data.pricePendingTickers;
      var samples = c.missingSamples || [];
      var cards = '<div class="diag-grid">' +
        coverageCard('Trade Sectors', t.sector, t.tickered, t.sectorPctOfTickered, 'Tickered trades with enriched sector.') +
        coverageCard('Trade Countries', t.country, t.tickered, t.countryPctOfTickered, 'Tickered trades with issuer country.') +
        coverageCard('Trade Market Caps', t.marketCap, t.tickered, t.marketCapPctOfTickered, 'Tickered trades with cap or cap bucket.') +
        coverageCard('Asset Coverage', a.marketCap, a.total, a.marketCapPct, 'Distinct traded assets with cap coverage.') +
      '</div>';
      var summary = '<p class="note">Pending enrichment assets: <strong>' + esc(pending) + '</strong> · Pending price assets: <strong>' + esc(prices) + '</strong> · Socratic.Trade configured: <strong>' + esc(data.hasKeyedEnrichmentProvider ? 'Yes' : 'No') + '</strong></p>';
      var rows = samples.length
        ? samples.map(function (s) {
            return '<tr class="row"><td><span class="tkr">' + esc(s.ticker) + '</span></td>' +
              '<td>' + esc(s.name || '—') + '</td>' +
              '<td class="est">' + esc(s.trades || 0) + '</td>' +
              '<td class="muted">' + esc((s.missing || []).join(', ') || '—') + '</td>' +
              '<td class="muted">' + esc(s.source || '—') + '</td>' +
              '<td class="muted">' + esc(s.enrichmentError || '—') + '</td></tr>';
          }).join('')
        : '<tr><td class="state" colspan="6">No missing tickered assets in the current coverage sample.</td></tr>';
      if (box) box.innerHTML = summary + cards +
        '<h3 style="margin-top:14px">Missing Asset Samples</h3>' +
        '<div class="table-wrap"><table><thead><tr><th>Asset</th><th>Name</th><th>Trades</th><th>Missing</th><th>Source</th><th>Error</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
    })
    .catch(function (e) {
      if (box) box.innerHTML = '<div class="state">' + esc(isAuthError(e) ? ADMIN_MOVED_MSG : ('Could not load market coverage: ' + e.message)) + '</div>';
    });
}

async function apiCall(path, method, body) {
  const res = await fetch(path, {
    method,
    headers: adminHeaders(body === undefined ? {} : { 'content-type': 'application/json' }),
    body: body ? JSON.stringify(body) : undefined
  });
  var text = await res.text();
  var data = {};
  if (text) {
    try { data = JSON.parse(text); }
    catch (e) { data = { error: text.slice(0, 240) }; }
  }
  if (!res.ok) {
    var error = new Error((data && data.error) || ('API error: ' + res.status));
    error.status = res.status;
    error.details = data;
    throw error;
  }
  return data;
}

var benchmarkState = {
  chamber: 'house',
  runs: [],
  current: null,
  settings: null,
  roles: null,
  running: false,
  simulationRequest: 0,
  unknownOutcomeRetryDecision: null
};

function benchmarkChamberLabel(chamber) {
  if (chamber === 'senate') return 'Senate';
  if (chamber === 'executive') return 'Executive';
  return 'House';
}

function benchmarkModelKey(model) {
  return model && model.provider && model.model ? model.provider + ':' + model.model : '';
}

function benchmarkModelRef(value) {
  var index = String(value || '').indexOf(':');
  if (index < 1) return null;
  return { provider: value.slice(0, index), model: value.slice(index + 1) };
}

function benchmarkPct(value) {
  return typeof value === 'number' && isFinite(value) ? (value * 100).toFixed(1) + '%' : 'N/A';
}

function benchmarkUsd(value) {
  if (typeof value !== 'number' || !isFinite(value)) return 'Unknown';
  return '$' + value.toFixed(value < 0.01 ? 5 : 3);
}

function benchmarkCostText(perDocument, covered, calls, knownCostUsd) {
  if (typeof perDocument === 'number') return benchmarkUsd(perDocument);
  if (!(calls > 0)) return 'N/A';
  if (covered > 0) {
    if (typeof knownCostUsd === 'number' && isFinite(knownCostUsd) && knownCostUsd >= 0) {
      return benchmarkUsd(knownCostUsd) + ' known (partial)';
    }
    return 'Unknown (partial)';
  }
  return 'Unknown';
}

function benchmarkDate(value) {
  if (!value) return 'Unknown time';
  var parsed = new Date(value);
  return isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleString();
}

function benchmarkResultIsComplete(result) {
  return Boolean(result) && result.outcome !== 'running';
}

function benchmarkLatencySummary(results) {
  var values = (results || []).map(function(result) { return result.latencyMs; })
    .filter(function(value) { return typeof value === 'number' && isFinite(value) && value >= 0; })
    .sort(function(a, b) { return a - b; });
  function percentile(q) {
    return values.length ? values[Math.max(0, Math.ceil(q * values.length) - 1)] : null;
  }
  return {
    count: values.length,
    avgLatencyMs: values.length ? values.reduce(function(sum, value) { return sum + value; }, 0) / values.length : null,
    p50LatencyMs: percentile(0.5),
    p95LatencyMs: percentile(0.95)
  };
}

function benchmarkSanitizeDiagnosticMessage(value) {
  return String(value || 'Provider call failed')
    .replace(/https?:[/][/][^ )},;]+/gi, '[redacted-url]')
    .replace(/(proj|org|acct|req)_[A-Za-z0-9_-]+/gi, '[redacted-id]')
    .replace(/(sk|rk|pk)-[A-Za-z0-9_-]{8,}/gi, '[redacted-key]')
    .replace(/Authorization[ ]*:[ ]*Bearer[ ]+[^ ,;]+/gi, 'Authorization: Bearer [redacted]')
    .replace(/Bearer[ ]+[^ ,;]+/gi, 'Bearer [redacted]')
    .replace(/((api[ _-]?key|token|account[ _-]?id|project[ _-]?id|request[ _-]?id)["' ]*[:=]?["' ]+)[^ ,;]+/gi, '$1[redacted]')
    .slice(0, 300);
}

function benchmarkFailureDetail(result) {
  var nested = result && result.result && typeof result.result === 'object' ? result.result : {};
  var failure = result && result.failure && typeof result.failure === 'object'
    ? result.failure
    : (nested.failure && typeof nested.failure === 'object' ? nested.failure : null);
  var blockedBy = result && result.blockedBy && typeof result.blockedBy === 'object'
    ? result.blockedBy
    : (nested.blockedBy && typeof nested.blockedBy === 'object' ? nested.blockedBy : null);
  if (failure) {
    return {
      code: String(failure.code || 'provider_failure').slice(0, 80),
      message: benchmarkSanitizeDiagnosticMessage(failure.message || result.error),
      scope: failure.scope ? String(failure.scope).slice(0, 40) : null,
      retryable: typeof failure.retryable === 'boolean' ? failure.retryable : null,
      blockedBy: blockedBy
    };
  }
  var error = String((result && result.error) || '').trim();
  var lower = error.toLowerCase();
  var code = result && (result.errorClass || result.failureClass || result.errorCode);
  if (!code) {
    if (!result) code = 'not_invoked';
    else if (/not configured|missing.*key|no keys provided/.test(lower)) code = 'configuration_missing';
    else if (/404|model[_ -]?not[_ -]?found|model.*not found|unknown model|unsupported.*model|does not exist|does not have access to.*model|access denied.*model/.test(lower)) code = 'model_unavailable';
    else if (/401|403|unauthorized|forbidden|invalid api key|authentication/.test(lower)) code = 'authentication_failed';
    else if (/429|rate.?limit|quota|capacity/.test(lower)) code = 'rate_or_quota';
    else if (/timeout|timed out/.test(lower)) code = 'timeout';
    else if (/parse|json|schema|markdown|empty.*result/.test(lower)) code = 'parse_or_schema';
    else if (/filing|document|raw.object|load.failed/.test(lower)) code = 'document_unavailable';
    else if (!result.invoked) code = 'not_invoked';
    else code = 'provider_failure';
  }
  return {
    code: String(code).slice(0, 80),
    message: benchmarkSanitizeDiagnosticMessage(error || String((result && result.outcome) || 'Provider call failed')),
    scope: null,
    retryable: null,
    blockedBy: blockedBy
  };
}

function benchmarkGroupedCounts(values) {
  var counts = {};
  (values || []).filter(Boolean).forEach(function(value) {
    var key = String(value);
    counts[key] = (counts[key] || 0) + 1;
  });
  return Object.keys(counts).sort(function(a, b) {
    return counts[b] - counts[a] || a.localeCompare(b);
  }).map(function(key) { return { key: key, count: counts[key] }; });
}

function benchmarkRunCellProgress(run) {
  run = run || {};
  var models = run.models || [];
  var documentCount = Number(run.requestedDocCount || ((run.documents || []).length) || 0);
  var planned = documentCount * models.length;
  var hasDetails = Array.isArray(run.results);
  var completedResults = hasDetails ? run.results.filter(benchmarkResultIsComplete) : [];
  var claimed = hasDetails ? run.results.filter(function(result) { return result && result.outcome === 'running'; }).length : 0;
  var invoked = completedResults.filter(function(result) { return result.invoked; });
  var failures = invoked.filter(function(result) { return !result.ok; });
  var unavailable = completedResults.filter(function(result) { return !result.invoked; });
  var covered = invoked.filter(function(result) { return typeof result.costUsd === 'number' && isFinite(result.costUsd); });
  var knownCostUsd = covered.reduce(function(sum, result) { return sum + result.costUsd; }, 0);
  var completed = completedResults.length;
  var success = invoked.length - failures.length;
  if (!hasDetails && run.status === 'completed') {
    completed = planned;
    invoked = new Array(Number((run.summary && run.summary.invokedCalls) || run.invokedCalls || 0));
    failures = new Array((run.summary && run.summary.models || []).reduce(function(sum, model) { return sum + Number(model.failures || 0); }, 0));
    unavailable = new Array((run.summary && run.summary.models || []).reduce(function(sum, model) { return sum + Number(model.unavailableDocs || 0); }, 0));
    covered = new Array(Number((run.summary && run.summary.coveredInvocations) || run.costCoveredCalls || 0));
    knownCostUsd = Number((run.summary && run.summary.knownCostUsd) || run.knownCostUsd || 0);
    success = Math.max(0, invoked.length - failures.length);
  }
  return {
    planned: planned,
    completed: completed,
    measured: completed,
    invoked: invoked.length,
    success: success,
    failures: failures.length,
    unavailable: unavailable.length,
    claimed: claimed,
    pending: hasDetails || run.status === 'completed' ? Math.max(0, planned - completed) : null,
    costCovered: covered.length,
    knownCostUsd: knownCostUsd,
    hasDetails: hasDetails
  };
}

function benchmarkModelPresentation(run, model, persisted) {
  run = run || {};
  persisted = persisted || {};
  var plannedDocs = Number(run.requestedDocCount || ((run.documents || []).length) || persisted.docsMeasured || 0);
  var all = (run.results || []).filter(function(result) {
    return result.provider === model.provider && result.model === model.model;
  });
  var completed = all.filter(benchmarkResultIsComplete);
  var claimed = all.filter(function(result) { return result.outcome === 'running'; });
  var invoked = completed.filter(function(result) { return result.invoked; });
  var successful = invoked.filter(function(result) { return result.ok; });
  var failed = invoked.filter(function(result) { return !result.ok; });
  var unavailable = completed.filter(function(result) { return !result.invoked; });
  var resolved = completed.filter(function(result) { return result.perfectMatch !== null && result.perfectMatch !== undefined; });
  var covered = invoked.filter(function(result) { return typeof result.costUsd === 'number' && isFinite(result.costUsd); });
  var knownCostUsd = covered.reduce(function(sum, result) { return sum + result.costUsd; }, 0);
  var pendingDocs = Math.max(0, plannedDocs - completed.length);
  var tp = resolved.reduce(function(sum, result) { return sum + Number(result.truePositive || 0); }, 0);
  var fp = resolved.reduce(function(sum, result) { return sum + Number(result.falsePositive || 0); }, 0);
  var fn = resolved.reduce(function(sum, result) { return sum + Number(result.falseNegative || 0); }, 0);
  var precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  var recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  var derivedF1 = resolved.length ? (precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0) : null;
  var failureDetails = failed.concat(unavailable).map(benchmarkFailureDetail);
  var unknownCostReasons = invoked.filter(function(result) { return typeof result.costUsd !== 'number'; }).map(function(result) {
    var detail = result.costDetail && typeof result.costDetail === 'object' ? result.costDetail : {};
    return detail.unknownReason || 'unpriced_without_reason';
  });
  var samples = failed.concat(unavailable).map(function(result) {
    var detail = benchmarkFailureDetail(result);
    return {
      docId: result.docId || 'unknown document',
      code: detail.code,
      message: detail.message,
      scope: detail.scope,
      retryable: detail.retryable,
      blockedBy: detail.blockedBy
    };
  }).slice(0, 5);
  var hasDetailedResults = Array.isArray(run.results);
  if (!hasDetailedResults) {
    return {
      provider: model.provider,
      model: model.model,
      plannedDocs: plannedDocs,
      docsMeasured: Number(persisted.docsMeasured || 0),
      pendingDocs: run.status === 'completed' ? 0 : null,
      claimedDocs: 0,
      providerCalls: Number(persisted.providerCalls || 0),
      docsOk: Number(persisted.docsOk || 0),
      failures: Number(persisted.failures || 0),
      unavailableDocs: Number(persisted.unavailableDocs || 0),
      autonomousDocs: Number(persisted.autonomousDocs || 0),
      autonomyRate: persisted.autonomyRate == null ? null : persisted.autonomyRate,
      successfulScoredDocs: Number(persisted.successfulScoredDocs || Math.min(Number(persisted.docsOk || 0), Number(persisted.resolvedDocs || 0))),
      resolvedDocs: Number(persisted.resolvedDocs || 0),
      perfectMatches: Number(persisted.perfectMatches || 0),
      perfectMatchRate: persisted.perfectMatchRate == null ? null : persisted.perfectMatchRate,
      f1: persisted.f1 == null ? null : persisted.f1,
      successLatency: { count: 0, avgLatencyMs: persisted.avgLatencyMs, p50LatencyMs: persisted.p50LatencyMs, p95LatencyMs: persisted.p95LatencyMs },
      failureLatency: { count: 0, avgLatencyMs: null, p50LatencyMs: null, p95LatencyMs: null },
      knownCostUsd: Number(persisted.knownCostUsd || 0),
      coveredInvocations: Number(persisted.coveredInvocations || 0),
      actualCostPerDocumentUsd: persisted.actualCostPerDocumentUsd == null ? null : persisted.actualCostPerDocumentUsd,
      errorGroups: [],
      unknownCostGroups: [],
      errorSamples: []
    };
  }
  return {
    provider: model.provider,
    model: model.model,
    plannedDocs: plannedDocs,
    docsMeasured: completed.length,
    pendingDocs: pendingDocs,
    claimedDocs: claimed.length,
    providerCalls: invoked.length,
    docsOk: successful.length,
    failures: failed.length,
    unavailableDocs: unavailable.length,
    autonomousDocs: successful.filter(function(result) { return result.autonomous; }).length,
    autonomyRate: successful.length
      ? successful.filter(function(result) { return result.autonomous; }).length / successful.length
      : null,
    successfulScoredDocs: successful.filter(function(result) { return result.perfectMatch !== null && result.perfectMatch !== undefined; }).length,
    resolvedDocs: resolved.length,
    perfectMatches: resolved.filter(function(result) { return result.perfectMatch; }).length,
    perfectMatchRate: resolved.length ? resolved.filter(function(result) { return result.perfectMatch; }).length / resolved.length : null,
    f1: derivedF1,
    successLatency: benchmarkLatencySummary(successful),
    failureLatency: benchmarkLatencySummary(failed),
    knownCostUsd: knownCostUsd,
    coveredInvocations: covered.length,
    actualCostPerDocumentUsd: invoked.length && invoked.length === covered.length && completed.length
      ? knownCostUsd / completed.length
      : null,
    errorGroups: benchmarkGroupedCounts(failureDetails.map(function(detail) { return detail.code; })),
    unknownCostGroups: benchmarkGroupedCounts(unknownCostReasons),
    errorSamples: samples
  };
}

function benchmarkModelEligibleForSimulation(model) {
  return Boolean(model)
    && model.pendingDocs === 0
    && model.successfulScoredDocs > 0;
}

function benchmarkRunDisplayStatus(run) {
  if (run && run.status === 'failed' && run.error === 'cancelled_by_operator') return 'stopped (partial results kept)';
  if (!run || run.status !== 'running') return (run && run.status) || 'unknown';
  var active = benchmarkState.running && benchmarkState.current && benchmarkState.current.id === run.id;
  return active ? 'running in this browser' : 'paused / resumable';
}

function benchmarkCompletionFeedback(label, run, browserFailureCount, skippedModelCount) {
  var progress = benchmarkRunCellProgress(run);
  var issues = [];
  if (skippedModelCount) issues.push(skippedModelCount + ' known-unavailable model' + (skippedModelCount === 1 ? '' : 's') + ' excluded before paid calls');
  if (progress.failures) issues.push(progress.failures + ' provider failure' + (progress.failures === 1 ? '' : 's'));
  if (progress.unavailable) issues.push(progress.unavailable + ' unavailable reading' + (progress.unavailable === 1 ? '' : 's'));
  if (progress.pending) issues.push(progress.pending + ' pending reading' + (progress.pending === 1 ? '' : 's'));
  if (browserFailureCount) issues.push(browserFailureCount + ' browser delivery error' + (browserFailureCount === 1 ? '' : 's'));
  return {
    warning: issues.length > 0,
    message: label + ' benchmark saved' + (issues.length ? ' with ' + issues.join(', ') + '. Review diagnostics before comparing models.' : '.')
  };
}

function normalizedBenchmarkLineup(settings) {
  var source = settings && settings.lineup ? settings.lineup : {};
  function normalize(value) {
    if (!value) return null;
    if (value.provider && value.model) return { provider: value.provider, model: value.model };
    if (value.id) return benchmarkModelRef(value.id);
    if (typeof value === 'string') return benchmarkModelRef(value);
    return null;
  }
  return { a: normalize(source.a), b: normalize(source.b), c: normalize(source.c) };
}

function normalizedBenchmarkRoles(roles) {
  var source = roles && roles.roles ? roles.roles : {};
  function normalize(value) {
    if (!value) return null;
    if (value.provider && value.model) return { provider: value.provider, model: value.model };
    return null;
  }
  return { primary: normalize(source.primary), failover: normalize(source.failover) };
}

function benchmarkCatalogModels() {
  return ((benchmarkState.settings && benchmarkState.settings.catalog) || []).filter(function(model) {
    return model && model.provider && model.model;
  });
}

function benchmarkManualOptionHtml(selected) {
  var options = benchmarkCatalogModels();
  // A live slot may be pinned to a model that isn't in the routine offered
  // list (e.g. a targeted Sol/Terra Pro run, or a since-removed candidate).
  // Surface it as an explicit selected option instead of silently falling
  // through to the browser's default (first-option) selection, which would
  // let an unrelated "Save all five slots" click quietly overwrite it.
  var matchesSelected = options.some(function(model) { return benchmarkModelKey(model) === selected; });
  var current = (selected && !matchesSelected)
    ? '<option value="' + esc(selected) + '" selected>' + esc(selected + ' (current — not in offered list)') + '</option>'
    : '';
  return current + options.map(function(model) {
    var value = benchmarkModelKey(model);
    var suffix = model.configured ? '' : ' (not configured)';
    return '<option value="' + esc(value) + '"' + (value === selected ? ' selected' : '') +
      (model.configured ? '' : ' disabled') + '>' + esc(value + suffix) + '</option>';
  }).join('');
}

/* ------------------------------------------------------------------------
   Unified per-chamber model slots (A–E). One panel replaces the former split
   manual-trio and primary/failover panels. Slots map to the server exactly
   as the AGREEMENT_*_MODEL_A..E env keys do:
     A/B -> PUT /api/admin/benchmark/roles/:chamber    {primary, failover}
     C/D/E -> PUT /api/admin/benchmark/settings/:chamber {a, b, c}
   ------------------------------------------------------------------------ */

var BENCHMARK_SLOT_DEFS = [
  { id: 'slotModelA', slot: 'A', label: 'A — Primary extractor (reads every new filing first)' },
  { id: 'slotModelB', slot: 'B', label: 'B — Failover extractor (used when A fails)' },
  { id: 'slotModelC', slot: 'C', label: 'C — Agreement voter 1 (tier-1 pair)' },
  { id: 'slotModelD', slot: 'D', label: 'D — Agreement voter 2 (tier-1 pair)' },
  { id: 'slotModelE', slot: 'E', label: 'E — Agreement voter 3 (tier-2/3 escalation)' }
];

/* Saved model per slot, from the loaded roles (A/B) + lineup (C/D/E). */
function benchmarkSavedSlotValues() {
  var lineup = normalizedBenchmarkLineup(benchmarkState.settings);
  var roles = normalizedBenchmarkRoles(benchmarkState.roles);
  return { A: roles.primary, B: roles.failover, C: lineup.a, D: lineup.b, E: lineup.c };
}

function renderBenchmarkSettingsSummary() {
  var summary = el('benchmarkSettingsSummary');
  if (summary) {
    var label = benchmarkChamberLabel(benchmarkState.chamber);
    if (!benchmarkState.settings) {
      summary.textContent = 'Saved ' + label + ' model slots are unavailable.';
    } else {
      var saved = benchmarkSavedSlotValues();
      summary.textContent = 'Live ' + label + ' slots — ' + ['A', 'B', 'C', 'D', 'E'].map(function(slot) {
        return slot + ' ' + (benchmarkModelKey(saved[slot]) || 'not set');
      }).join(' · ');
    }
  }
  renderBenchmarkModelSlots();
}

function renderBenchmarkModelSlots() {
  var container = el('benchmarkModelSlots');
  if (!container) return;
  var settings = benchmarkState.settings;
  if (!settings || settings.writeProtected) {
    container.innerHTML = settings && settings.writeProtected
      ? '<div class="benchmark-panel"><h4>Model slots (A–E)</h4><div class="state">Preview is read-only; save the live model slots in production after approval.</div></div>'
      : '';
    return;
  }
  var saved = benchmarkSavedSlotValues();
  container.innerHTML = '<div class="benchmark-panel"><h4>Model slots (A–E)</h4>' +
    '<p class="sub">One place to set all five live ' + esc(benchmarkChamberLabel(benchmarkState.chamber)) + ' models. A/B are the live-ingestion primary/failover extractors; C/D/E are the agreement trio that votes on autopublish. Saving writes A/B (roles) first, then C/D/E (lineup), each verified by readback. Benchmark-backed saves remain available below when a completed run has enough evidence.</p>' +
    '<div class="benchmark-lineup">' +
    BENCHMARK_SLOT_DEFS.map(function(def) {
      var selected = benchmarkModelKey(saved[def.slot]);
      var placeholder = selected ? '' : '<option value="" selected disabled>— not set —</option>';
      return '<label class="lbl">' + esc(def.label) + '<select id="' + def.id + '" onchange="updateBenchmarkSlotWarnings()">' +
        placeholder + benchmarkManualOptionHtml(selected) + '</select></label>';
    }).join('') +
    '</div>' +
    '<div id="benchmarkSlotWarnings" class="note" role="status" aria-live="polite"></div>' +
    '<div class="row-flex"><button class="btn sm" id="saveBenchmarkModelSlots" onclick="saveBenchmarkModelSlots()">Save all five ' + esc(benchmarkChamberLabel(benchmarkState.chamber)) + ' slots</button>' +
    '<span id="benchmarkModelSlotsStatus" class="note" role="status" aria-live="polite"></span></div></div>';
  updateBenchmarkSlotWarnings();
}

/* Current select values as model refs keyed by slot letter. */
function selectedBenchmarkSlots() {
  var slots = {};
  BENCHMARK_SLOT_DEFS.forEach(function(def) {
    var select = el(def.id);
    slots[def.slot] = benchmarkModelRef(select && select.value);
  });
  return slots;
}

/* Resolve the effective API provider behind an OpenRouter proxy model, mirroring
   the server-side getUnderlyingProvider in benchmark/settings.ts. */
function getUnderlyingProvider(model) {
  if (model && model.provider === 'openrouter' && model.model) {
    var parts = model.model.split('/');
    if (parts.length > 1) {
      var sub = parts[0].toLowerCase();
      if (sub === 'google') return 'gemini';
      if (sub === 'x-ai') return 'xai';
      return sub;
    }
  }
  return model ? model.provider : '';
}

/* Blocking pre-checks mirroring the server rules, phrased for the A–E panel. */
function validateBenchmarkSlots(slots) {
  if (!slots.A || !slots.B || !slots.C || !slots.D || !slots.E) return 'Choose a model for every slot (A–E).';
  if (slots.A.provider === 'openrouter' && slots.A.model === 'auto') return 'openrouter/auto cannot be the primary extractor because its routing is unpredictable.';
  if (slots.B.provider === 'openrouter' && slots.B.model === 'auto') return 'openrouter/auto cannot be the failover extractor because its routing is unpredictable.';
  if (benchmarkModelKey(slots.A) === benchmarkModelKey(slots.B)) return 'A (primary) and B (failover) must be different models.';
  var trioKeys = [benchmarkModelKey(slots.C), benchmarkModelKey(slots.D), benchmarkModelKey(slots.E)];
  if (new Set(trioKeys).size !== 3) return 'C, D, and E must be three different models.';
  return '';
}

/* Non-blocking advisory shown as the selects change (never blocks saving). */
function updateBenchmarkSlotWarnings() {
  var note = el('benchmarkSlotWarnings');
  if (!note) return;
  var slots = selectedBenchmarkSlots();
  var warning = slots.A && ((slots.C && getUnderlyingProvider(slots.A) === getUnderlyingProvider(slots.C)) || (slots.D && getUnderlyingProvider(slots.A) === getUnderlyingProvider(slots.D)))
    ? 'Note: tier-1 agreement shares a provider with the primary extractor — votes are less independent.'
    : '';
  note.style.color = warning ? 'var(--warn)' : '';
  note.textContent = warning;
}

async function saveBenchmarkModelSlots() {
  if (benchmarkState.settings && benchmarkState.settings.writeProtected) return;
  var chamber = benchmarkState.chamber;
  var label = benchmarkChamberLabel(chamber);
  var slots = selectedBenchmarkSlots();
  var status = el('benchmarkModelSlotsStatus');
  var invalid = validateBenchmarkSlots(slots);
  if (invalid) { if (status) { status.style.color = 'var(--neg)'; status.textContent = invalid; } return; }
  var saved = benchmarkSavedSlotValues();
  var currentText = ['A', 'B', 'C', 'D', 'E'].map(function(slot) {
    return slot + ' ' + (benchmarkModelKey(saved[slot]) || 'not set');
  }).join('\\n');
  var nextText = ['A', 'B', 'C', 'D', 'E'].map(function(slot) {
    return slot + ' ' + benchmarkModelKey(slots[slot]);
  }).join('\\n');
  if (!window.confirm('Save all five live ' + label + ' model slots?\\n\\nCurrent:\\n' + currentText + '\\n\\nNew:\\n' + nextText)) return;
  var button = el('saveBenchmarkModelSlots');
  if (button) button.disabled = true;
  var outcomes = [];
  var failed = false;
  try {
    // (a) Fetch fresh versions so each PUT carries the server's current
    // expectedVersion instead of a possibly stale page-load snapshot.
    if (status) { status.style.color = ''; status.textContent = 'Reading current slot versions…'; }
    var freshRoles = await apiCall('/api/admin/benchmark/roles/' + encodeURIComponent(chamber), 'GET');
    var freshSettings = await apiCall('/api/admin/benchmark/settings/' + encodeURIComponent(chamber), 'GET');
    benchmarkState.roles = freshRoles;
    benchmarkState.settings = freshSettings;
    // (b) Save A/B roles, then C/D/E lineup — each reported separately so a
    // server rejection of one write never silently hides the other's result.
    if (status) status.textContent = 'Saving A/B (primary/failover extractors)…';
    try {
      var rolesResult = await apiCall('/api/admin/benchmark/roles/' + encodeURIComponent(chamber), 'PUT', {
        primary: slots.A,
        failover: slots.B,
        expectedVersion: freshRoles.version
      });
      benchmarkState.roles = rolesResult.settings;
      outcomes.push('A/B saved.');
    } catch (rolesError) {
      failed = true;
      outcomes.push('A/B not saved: ' + rolesError.message);
    }
    if (status) status.textContent = 'Saving C/D/E (agreement trio)…';
    try {
      var lineupResult = await apiCall('/api/admin/benchmark/settings/' + encodeURIComponent(chamber), 'PUT', {
        a: slots.C,
        b: slots.D,
        c: slots.E,
        expectedVersion: freshSettings.version
      });
      benchmarkState.settings = lineupResult.settings;
      outcomes.push('C/D/E saved.');
    } catch (lineupError) {
      failed = true;
      outcomes.push('C/D/E not saved: ' + lineupError.message);
    }
    // (d) Re-fetch the effective runtime slots and re-render so the panel
    // always shows what production will actually use.
    try {
      benchmarkState.roles = await apiCall('/api/admin/benchmark/roles/' + encodeURIComponent(chamber), 'GET');
      benchmarkState.settings = await apiCall('/api/admin/benchmark/settings/' + encodeURIComponent(chamber), 'GET');
    } catch (refreshError) {
      failed = true;
      outcomes.push('Reload of the effective slots failed: ' + refreshError.message);
    }
    renderBenchmarkSettingsSummary();
    status = el('benchmarkModelSlotsStatus'); // re-render replaced the node
    if (status) {
      status.style.color = failed ? 'var(--neg)' : 'var(--pos)';
      status.textContent = (failed ? outcomes.join(' ') : 'All five slots saved and verified. ' + outcomes.join(' '));
    }
  } catch (error) {
    status = el('benchmarkModelSlotsStatus') || status;
    if (status) { status.style.color = 'var(--neg)'; status.textContent = 'Save failed before any write: ' + error.message; }
  } finally {
    var saveButton = el('saveBenchmarkModelSlots');
    if (saveButton) saveButton.disabled = false;
  }
}

function setBenchmarkButtons() {
  var map = { house: 'btnBenchHouse', senate: 'btnBenchSenate', executive: 'btnBenchExec' };
  Object.keys(map).forEach(function(chamber) {
    var button = el(map[chamber]);
    if (!button) return;
    var active = chamber === benchmarkState.chamber;
    button.className = 'btn sm' + (active ? '' : ' ghost');
    button.setAttribute('aria-selected', active ? 'true' : 'false');
    button.disabled = benchmarkState.running;
  });
  var runButton = el('btnRunBenchmark');
  if (runButton) {
    var chamberPausedRun = (benchmarkState.runs || []).find(function(run) {
      return run.chamber === benchmarkState.chamber && run.status === 'running';
    });
    var resumable = benchmarkState.current && benchmarkState.current.status === 'running' && benchmarkState.current.chamber === benchmarkState.chamber;
    var blockedByOtherPausedRun = chamberPausedRun && !resumable;
    runButton.disabled = benchmarkState.running || Boolean(blockedByOtherPausedRun);
    var startLabel = benchmarkState.current && benchmarkState.current.status !== 'running' ? 'Start new ' : 'Run ';
    if (benchmarkState.running) runButton.textContent = 'Benchmark running…';
    else if (blockedByOtherPausedRun) runButton.textContent = 'Select paused ' + benchmarkChamberLabel(benchmarkState.chamber) + ' run';
    else runButton.textContent = (resumable ? 'Resume ' : startLabel) + benchmarkChamberLabel(benchmarkState.chamber) + ' benchmark';
  }
  var cancelButton = el('btnCancelBenchmark');
  if (cancelButton) {
    var pausedRun = benchmarkState.current && benchmarkState.current.status === 'running' && !benchmarkState.running;
    cancelButton.hidden = !pausedRun;
    cancelButton.disabled = !pausedRun;
  }
  var runAllButton = el('btnRunAllBenchmarks');
  if (runAllButton) {
    runAllButton.disabled = benchmarkState.running;
    runAllButton.textContent = benchmarkState.running ? 'Benchmarks running...' : 'Run all 3 branches';
  }
}

function selectBenchmarkChamber(chamber) {
  if (benchmarkState.running) return;
  if (chamber !== 'house' && chamber !== 'senate' && chamber !== 'executive') return;
  benchmarkState.chamber = chamber;
  benchmarkState.current = null;
  benchmarkState.settings = null;
  benchmarkState.roles = null;
  setBenchmarkButtons();
  if (el('benchmarkResults')) el('benchmarkResults').innerHTML = '<div class="state">Loading saved ' + esc(benchmarkChamberLabel(chamber)) + ' benchmarks…</div>';
  loadBenchmarkHistory();
}

function renderBenchmarkHistoryOptions(selectedId) {
  var select = el('benchmarkHistory');
  if (!select) return;
  if (!benchmarkState.runs.length) {
    select.innerHTML = '<option value="">No saved runs</option>';
    return;
  }
  select.innerHTML = benchmarkState.runs.map(function(run) {
    var progress = benchmarkRunCellProgress(run);
    var status = benchmarkRunDisplayStatus(run);
    var cells = progress.hasDetails || run.status === 'completed'
      ? progress.completed + '/' + progress.planned + ' cells'
      : 'progress loads on selection';
    var label = benchmarkDate(run.startedAt) + ' · ' + status + ' · ' + cells + ' · ' + run.requestedDocCount + ' docs';
    return '<option value="' + esc(run.id) + '"' + (run.id === selectedId ? ' selected' : '') + '>' + esc(label) + '</option>';
  }).join('');
}

async function loadBenchmarkHistory(chamber, selectedId) {
  if (chamber) benchmarkState.chamber = chamber;
  var requestedChamber = benchmarkState.chamber;
  var msg = el('benchmarkMsg');
  if (msg) { msg.style.color = ''; msg.textContent = 'Loading saved ' + benchmarkChamberLabel(requestedChamber) + ' runs…'; }
  setBenchmarkButtons();
  try {
    var runsData = await apiCall('/api/admin/benchmark/runs?chamber=' + encodeURIComponent(requestedChamber) + '&limit=50', 'GET');
    if (requestedChamber !== benchmarkState.chamber) return;
    benchmarkState.runs = runsData.runs || [];
    try {
      benchmarkState.settings = await apiCall('/api/admin/benchmark/settings/' + encodeURIComponent(requestedChamber), 'GET');
    } catch (settingsError) {
      benchmarkState.settings = null;
      if (msg) msg.textContent = 'Runs loaded; saved lineup unavailable: ' + settingsError.message;
    }
    try {
      benchmarkState.roles = await apiCall('/api/admin/benchmark/roles/' + encodeURIComponent(requestedChamber), 'GET');
    } catch (rolesError) {
      benchmarkState.roles = null;
    }
    renderBenchmarkSettingsSummary();
    var id = selectedId || (benchmarkState.runs[0] && benchmarkState.runs[0].id) || '';
    renderBenchmarkHistoryOptions(id);
    if (id) await loadBenchmarkRun(id);
    else {
      benchmarkState.current = null;
      if (el('benchmarkResults')) el('benchmarkResults').innerHTML = '<div class="state">No saved ' + esc(benchmarkChamberLabel(requestedChamber)) + ' benchmark runs yet.</div>';
      if (msg && benchmarkState.settings) msg.textContent = 'No saved runs. Starting a benchmark will preserve its results here.';
    }
  } catch (error) {
    if (msg) { msg.style.color = 'var(--neg)'; msg.textContent = 'Could not load benchmark history: ' + error.message; }
    if (el('benchmarkResults')) el('benchmarkResults').innerHTML = '<div class="state">Saved benchmark history is unavailable.</div>';
  }
}

async function loadBenchmarkRun(runId) {
  if (!runId) return;
  var expectedChamber = benchmarkState.chamber;
  try {
    var data = await apiCall('/api/admin/benchmark/runs/' + encodeURIComponent(runId), 'GET');
    if (expectedChamber !== benchmarkState.chamber) return;
    benchmarkState.current = data.run;
    benchmarkState.runs = benchmarkState.runs.map(function(run) { return run.id === runId ? data.run : run; });
    setBenchmarkButtons();
    renderBenchmarkHistoryOptions(runId);
    renderBenchmarkRun(data.run);
    var msg = el('benchmarkMsg');
    if (msg && !benchmarkState.running) msg.textContent = 'Viewing saved ' + benchmarkChamberLabel(expectedChamber) + ' run ' + runId + '.';
  } catch (error) {
    if (el('benchmarkMsg')) el('benchmarkMsg').textContent = 'Could not load saved run: ' + error.message;
  }
}

async function cancelBenchmarkRun() {
  var run = benchmarkState.current;
  if (!run || run.status !== 'running' || benchmarkState.running) return;
  var label = benchmarkChamberLabel(run.chamber);
  if (!window.confirm(
    'Stop this saved ' + label + ' benchmark?\\n\\nNo additional cells can be claimed after the stop. A cell already claimed or in flight may still finish and incur a provider charge. Completed readings and their measured costs remain in history. This cannot be resumed; use Start New for a clean run.'
  )) return;
  var button = el('btnCancelBenchmark');
  var msg = el('benchmarkMsg');
  if (button) button.disabled = true;
  if (msg) { msg.style.color = ''; msg.textContent = 'Stopping the saved run and keeping partial results…'; }
  try {
    var data = await apiCall('/api/admin/benchmark/runs/' + encodeURIComponent(run.id) + '/cancel', 'POST', {});
    benchmarkState.current = data.run;
    await loadBenchmarkHistory(run.chamber, run.id);
    if (msg) {
      msg.style.color = 'var(--warn)';
      msg.textContent = label + ' benchmark stopped. Partial results remain saved; Start New is now enabled.';
    }
  } catch (error) {
    if (msg) { msg.style.color = 'var(--neg)'; msg.textContent = 'Could not stop the saved benchmark: ' + error.message; }
    if (button) button.disabled = false;
  } finally {
    setBenchmarkButtons();
  }
}

async function clearBenchmarkHistory() {
  if (benchmarkState.running) return;
  var chamber = benchmarkState.chamber;
  var label = benchmarkChamberLabel(chamber);
  if (!window.confirm('Clear saved ' + label + ' benchmark history?\\n\\nThis deletes saved runs, documents, and model results for this branch. It does not change the saved A/B/C autopublish lineup.')) return;
  var msg = el('benchmarkMsg');
  if (msg) { msg.style.color = ''; msg.textContent = 'Clearing saved ' + label + ' benchmark history…'; }
  try {
    var result = await apiCall('/api/admin/benchmark/runs?chamber=' + encodeURIComponent(chamber), 'DELETE');
    benchmarkState.current = null;
    benchmarkState.runs = [];
    await loadBenchmarkHistory(chamber);
    if (msg) {
      msg.style.color = 'var(--warn)';
      msg.textContent = 'Cleared ' + result.runsDeleted + ' saved ' + label + ' benchmark run' + (result.runsDeleted === 1 ? '' : 's') + '.';
    }
  } catch (error) {
    if (msg) { msg.style.color = 'var(--neg)'; msg.textContent = 'Could not clear benchmark history: ' + error.message; }
  }
}

function fallbackBenchmarkSummaries(run) {
  var persisted = run && run.summary && run.summary.models || [];
  return (run.models || persisted).map(function(model) {
    var saved = persisted.find(function(summary) {
      return summary.provider === model.provider && summary.model === model.model;
    });
    return benchmarkModelPresentation(run, model, saved);
  });
}

function benchmarkLatencyText(summary) {
  return [summary.avgLatencyMs, summary.p50LatencyMs, summary.p95LatencyMs].map(function(value) {
    return typeof value === 'number' ? fmtMs(value) : 'N/A';
  }).join(' / ');
}

function benchmarkGroupText(groups) {
  return (groups || []).map(function(group) {
    return String(group.key).replace(/_/g, ' ') + ' ×' + group.count;
  }).join(' · ');
}

function benchmarkDiagnosticRowHtml(model) {
  var hasDiagnostics = model.errorGroups.length || model.unknownCostGroups.length || model.errorSamples.length || model.claimedDocs;
  if (!hasDiagnostics) return '';
  var headline = [];
  if (model.errorGroups.length) headline.push(model.failures + model.unavailableDocs + ' failed/unavailable');
  if (model.unknownCostGroups.length) headline.push(model.unknownCostGroups.reduce(function(sum, group) { return sum + group.count; }, 0) + ' unpriced');
  if (model.claimedDocs) headline.push(model.claimedDocs + ' claimed/pending');
  var body = '';
  if (model.errorGroups.length) {
    body += '<div><strong>Failure classes:</strong> ' + esc(benchmarkGroupText(model.errorGroups)) + '</div>';
  }
  if (model.unknownCostGroups.length) {
    body += '<div><strong>Unknown-cost reasons:</strong> ' + esc(benchmarkGroupText(model.unknownCostGroups)) + '</div>';
  }
  if (model.claimedDocs) {
    body += '<div><strong>Claimed cells:</strong> ' + esc(model.claimedDocs) + ' remain pending; they are not counted as unavailable.</div>';
  }
  if (model.errorSamples.length) {
    body += '<div><strong>Saved examples:</strong></div>' + model.errorSamples.map(function(sample) {
      var qualifiers = [];
      if (sample.scope) qualifiers.push(sample.scope);
      if (sample.retryable !== null) qualifiers.push(sample.retryable ? 'retryable' : 'not retryable');
      if (sample.blockedBy) {
        qualifiers.push('blocked by ' + [sample.blockedBy.provider, sample.blockedBy.model, sample.blockedBy.docId].filter(Boolean).join(':'));
      }
      return '<div><code>' + esc(sample.docId) + '</code> · ' + esc(String(sample.code).replace(/_/g, ' ')) +
        (qualifiers.length ? ' [' + esc(qualifiers.join(', ')) + ']' : '') + ': ' + esc(sample.message) + '</div>';
    }).join('');
  }
  return '<tr class="benchmark-diag-row"><td colspan="7"><details class="benchmark-diagnostics"><summary>Diagnostics · ' +
    esc(headline.join(' · ')) + '</summary><div class="benchmark-diagnostics-body">' + body + '</div></details></td></tr>';
}

function benchmarkModelAccessPreflightHtml(run) {
  var profile = run && run.requestProfile && typeof run.requestProfile === 'object' ? run.requestProfile : {};
  var access = profile.modelAccess && typeof profile.modelAccess === 'object' ? profile.modelAccess : null;
  var entries = access && Array.isArray(access.models) ? access.models : [];
  var excluded = entries.filter(function(entry) { return entry && entry.availability === 'unavailable'; });
  if (!excluded.length) return '';
  var rows = excluded.map(function(entry) {
    var failure = entry.failure && typeof entry.failure === 'object' ? entry.failure : {};
    var code = String(failure.code || 'known_unavailable').replace(/_/g, ' ');
    var message = benchmarkSanitizeDiagnosticMessage(failure.message || 'Unavailable to the configured project.');
    return '<li><strong>' + esc(entry.provider + ':' + entry.model) + '</strong> · ' + esc(code) + ': ' + esc(message) + '</li>';
  }).join('');
  return '<div class="benchmark-panel benchmark-access-preflight"><h4>Model access preflight</h4>' +
    '<p class="sub">These models were excluded before paid-call reservation and remain saved with this run for audit history.</p>' +
    '<ul>' + rows + '</ul><div class="note">Checked ' + esc(benchmarkDate(access.checkedAt)) +
    (access.cached ? ' · cached project catalog' : ' · project catalog') + '</div></div>';
}

function renderBenchmarkRun(run) {
  var container = el('benchmarkResults');
  if (!container || !run) return;
  var summary = run.summary || {};
  var documents = run.documents || [];
  var resolvedDocs = documents.length
    ? documents.filter(function(document) { return document.resolved; }).length
    : (summary.models && summary.models[0] ? summary.models[0].resolvedDocs : 0);
  var modelSummaries = fallbackBenchmarkSummaries(run);
  var progress = benchmarkRunCellProgress(run);
  var totalCalls = progress.invoked;
  var coveredCalls = progress.costCovered;
  var knownSpend = totalCalls === 0
    ? 'N/A'
    : coveredCalls === 0
      ? 'Unknown'
      : benchmarkUsd(progress.knownCostUsd) + (coveredCalls < totalCalls ? ' (partial)' : '');
  var status = benchmarkRunDisplayStatus(run);
  var duration = typeof run.durationMs === 'number' ? fmtMs(run.durationMs) : (status === 'paused / resumable' ? 'Paused' : 'In progress');
  var meta = '<div class="benchmark-meta">' +
    '<span class="benchmark-chip">Status <strong>' + esc(status) + '</strong></span>' +
    '<span class="benchmark-chip">Run <strong>' + esc(run.id) + '</strong></span>' +
    '<span class="benchmark-chip">Documents <strong>' + esc(run.requestedDocCount) + '</strong></span>' +
    '<span class="benchmark-chip">Cells <strong>' + esc(progress.completed + '/' + progress.planned) + '</strong>' + (progress.pending ? ' · ' + esc(progress.pending) + ' pending' : '') + '</span>' +
    (progress.claimed ? '<span class="benchmark-chip">Claimed / pending <strong>' + esc(progress.claimed) + '</strong></span>' : '') +
    '<span class="benchmark-chip">Resolved ground truth <strong>' + esc(resolvedDocs + '/' + run.requestedDocCount) + '</strong></span>' +
    '<span class="benchmark-chip">Outcomes <strong>' + esc(progress.success + ' success · ' + progress.failures + ' failed · ' + progress.unavailable + ' unavailable') + '</strong></span>' +
    '<span class="benchmark-chip">Provider calls <strong>' + esc(totalCalls) + '</strong></span>' +
    '<span class="benchmark-chip">Cost coverage <strong>' + esc(coveredCalls + '/' + totalCalls) + '</strong></span>' +
    '<span class="benchmark-chip">Measured usage-based spend <strong>' + esc(knownSpend) + '</strong></span>' +
    '<span class="benchmark-chip">Duration <strong>' + esc(duration) + '</strong></span>' +
    '</div>';
  var rows = modelSummaries.map(function(model) {
    var partial = typeof model.pendingDocs === 'number' && model.pendingDocs > 0;
    var rowState = partial
      ? (status === 'paused / resumable' ? 'Paused' : 'Partial') + ' · ' + model.docsMeasured + '/' + model.plannedDocs + ' measured · ' + model.pendingDocs + ' pending'
      : 'Complete · ' + model.docsMeasured + '/' + model.plannedDocs + ' measured';
    var cost = benchmarkCostText(
      model.actualCostPerDocumentUsd,
      model.coveredInvocations,
      model.providerCalls,
      model.knownCostUsd
    );
    if (partial && typeof model.actualCostPerDocumentUsd === 'number') cost += ' (partial)';
    var failedLatency = model.failureLatency.count
      ? '<span class="benchmark-latency-line failed">Failed attempts: ' + esc(benchmarkLatencyText(model.failureLatency)) + ' · ' + esc(model.failureLatency.count) + '</span>'
      : '';
    return '<tr>' +
      '<td><strong>' + esc(model.provider + ':' + model.model) + '</strong><div class="benchmark-model-state' + (partial ? ' partial' : '') + '">' + esc(rowState) + (model.claimedDocs ? ' · ' + esc(model.claimedDocs) + ' claimed' : '') + '</div></td>' +
      '<td>' + esc(benchmarkPct(model.perfectMatchRate)) + '<div class="note">' + esc((model.perfectMatches || 0) + '/' + (model.resolvedDocs || 0) + ' exact matches on scored truth') + '</div></td>' +
      '<td>' + esc(benchmarkPct(model.autonomyRate)) + '<div class="note">' + esc((model.autonomousDocs || 0) + '/' + (model.docsOk || 0) + ' successful reads structurally publishable') + '</div></td>' +
      '<td>' + esc(benchmarkPct(model.f1)) + '</td>' +
      '<td><strong>' + esc((model.docsOk || 0) + ' success / ' + model.plannedDocs + ' planned') + '</strong><div class="benchmark-outcome-counts">' +
        esc(model.docsMeasured + ' measured · ' + model.providerCalls + ' invoked · ' + model.failures + ' failed · ' + model.unavailableDocs + ' unavailable · ' + model.pendingDocs + ' pending') + '</div></td>' +
      '<td><span class="benchmark-latency-line">Successful calls: ' + esc(benchmarkLatencyText(model.successLatency)) + ' · ' + esc(model.successLatency.count) + '</span>' +
        '<div class="note">avg / p50 / p95</div>' + failedLatency + '</td>' +
      '<td>' + esc(cost) + '<div class="note">' + esc((model.coveredInvocations || 0) + '/' + (model.providerCalls || 0) + ' invoked calls priced') + (partial ? ' · partial ' + esc(model.docsMeasured + '/' + model.plannedDocs) : '') + '</div></td>' +
      '</tr>' + benchmarkDiagnosticRowHtml(model);
  }).join('');
  if (!rows) rows = '<tr><td colspan="7" class="state">This run has no model measurements yet.</td></tr>';
  container.innerHTML = meta + benchmarkModelAccessPreflightHtml(run) +
    '<div class="benchmark-panel"><h4>Individual model performance</h4>' +
    '<p class="sub">Exact document match compares the full normalized output. Row-detection F1 compares trade rows; optional metadata is excluded from row identity. Cost uses provider-reported charges where available, otherwise actual metered units × pinned list price. This is not invoice reconciliation.</p>' +
    '<div class="benchmark-table-wrap" tabindex="0" aria-label="Scrollable benchmark results"><table class="bench-table">' +
    '<caption class="sr-only">Saved model benchmark performance</caption><thead><tr>' +
    '<th scope="col">Model</th><th scope="col">Exact document match</th><th scope="col">Autonomy</th><th scope="col">Row-detection F1</th><th scope="col">Provider outcomes</th><th scope="col">Latency</th><th scope="col">Measured usage-based cost</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table></div></div>' +
    '<div id="cascadeSimulationContainer"></div>';
  renderCascadeSimulation();
}

function benchmarkOptionHtml(models, selected) {
  return models.map(function(model) {
    var value = benchmarkModelKey(model);
    return '<option value="' + esc(value) + '"' + (value === selected ? ' selected' : '') + '>' + esc(value) + '</option>';
  }).join('');
}

function benchmarkDefaultLineup(models) {
  var available = {};
  models.forEach(function(model) { available[benchmarkModelKey(model)] = true; });
  var saved = normalizedBenchmarkLineup(benchmarkState.settings);
  var chosen = [];
  ['a', 'b', 'c'].forEach(function(slot) {
    var key = benchmarkModelKey(saved[slot]);
    if (key && available[key] && chosen.indexOf(key) < 0) chosen.push(key);
  });
  models.forEach(function(model) {
    var key = benchmarkModelKey(model);
    var provider = model.provider;
    var usedProvider = chosen.some(function(current) { var ref = benchmarkModelRef(current); return ref && ref.provider === provider; });
    if (chosen.length < 3 && chosen.indexOf(key) < 0 && !usedProvider) chosen.push(key);
  });
  return { a: chosen[0] || '', b: chosen[1] || '', c: chosen[2] || '' };
}

function renderCascadeSimulation() {
  var container = el('cascadeSimulationContainer');
  var run = benchmarkState.current;
  if (!container || !run) return;
  var progress = benchmarkRunCellProgress(run);
  if (run.status !== 'completed' || progress.pending) {
    var status = benchmarkRunDisplayStatus(run);
    var nextStep = status === 'stopped (partial results kept)'
      ? 'The partial results are retained for diagnostics; use Start New for a clean run.'
      : 'Resume it or stop and keep the partial results before starting a clean run.';
    container.innerHTML = '<div class="benchmark-panel"><h4>Consensus cascade simulation</h4><div class="state">Simulation is disabled for this ' +
      esc(status) + ' run. ' + esc(progress.completed + '/' + progress.planned) +
      ' cells are measured' + (progress.pending ? '; ' + esc(progress.pending) + ' remain pending' : '') +
      '. ' + esc(nextStep) + '</div></div>';
    return;
  }
  var allModels = fallbackBenchmarkSummaries(run);
  var models = allModels.filter(benchmarkModelEligibleForSimulation);
  var excludedCount = allModels.length - models.length;
  if (models.length < 3) {
    container.innerHTML = '<div class="benchmark-panel"><h4>Consensus cascade simulation</h4><div class="state">At least three completed models with successful scored readings are required. ' +
      esc(models.length) + ' eligible; ' + esc(excludedCount) + ' unavailable, failed-only, unscored, or incomplete.</div></div>';
    return;
  }
  var defaults = benchmarkDefaultLineup(models);
  container.innerHTML = '<div class="benchmark-panel"><h4>Consensus cascade simulation</h4>' +
    '<p class="sub">Uses only completed models with successful scored readings from this saved run. Simulation makes no provider calls.' +
      (excludedCount ? ' ' + esc(excludedCount) + ' ineligible model' + (excludedCount === 1 ? ' is' : 's are') + ' excluded.' : '') + '</p>' +
    '<div class="benchmark-lineup">' +
    '<label class="lbl">Trio C<select id="simModelA" onchange="updateSimResults()">' + benchmarkOptionHtml(models, defaults.a) + '</select></label>' +
    '<label class="lbl">Trio D<select id="simModelB" onchange="updateSimResults()">' + benchmarkOptionHtml(models, defaults.b) + '</select></label>' +
    '<label class="lbl">Trio E<select id="simModelC" onchange="updateSimResults()">' + benchmarkOptionHtml(models, defaults.c) + '</select></label>' +
    '</div>' +
    '<div id="simValidation" class="note" role="status"></div>' +
    '<div id="simStatsGrid" class="grid-cards" style="grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin:14px 0"></div>' +
    '<div class="row-flex"><button class="btn sm" id="saveBenchmarkLineup" onclick="saveBenchmarkLineup()"' + (run.status === 'completed' && !(benchmarkState.settings && benchmarkState.settings.writeProtected) ? '' : ' disabled') + '>Save as ' + esc(benchmarkChamberLabel(run.chamber)) + ' autopublish lineup</button></div>' +
    '<div id="simDetailPanel" class="note"></div></div>';
  updateSimResults();
}

function selectedBenchmarkLineup() {
  return {
    a: benchmarkModelRef(el('simModelA') && el('simModelA').value),
    b: benchmarkModelRef(el('simModelB') && el('simModelB').value),
    c: benchmarkModelRef(el('simModelC') && el('simModelC').value)
  };
}

function validateBenchmarkLineup(lineup) {
  if (!lineup.a || !lineup.b || !lineup.c) return 'Choose all three agreement models (C, D, and E).';
  var keys = [benchmarkModelKey(lineup.a), benchmarkModelKey(lineup.b), benchmarkModelKey(lineup.c)];
  if (new Set(keys).size !== 3) return 'C, D, and E must be three different models.';
  return '';
}

async function updateSimResults() {
  var run = benchmarkState.current;
  var validation = el('simValidation');
  if (!run || !el('simModelA')) return;
  var lineup = selectedBenchmarkLineup();
  var invalid = validateBenchmarkLineup(lineup);
  var saveButton = el('saveBenchmarkLineup');
  if (invalid) {
    if (validation) { validation.style.color = 'var(--neg)'; validation.textContent = invalid; }
    if (saveButton) saveButton.disabled = true;
    if (el('simStatsGrid')) el('simStatsGrid').innerHTML = '';
    return;
  }
  if (saveButton) saveButton.disabled = run.status !== 'completed' || Boolean(benchmarkState.settings && benchmarkState.settings.writeProtected);
  if (validation) { validation.style.color = ''; validation.textContent = 'Calculating from persisted readings…'; }
  var requestNumber = ++benchmarkState.simulationRequest;
  try {
    var data = await apiCall('/api/admin/benchmark/runs/' + encodeURIComponent(run.id) + '/simulate', 'POST', lineup);
    if (requestNumber !== benchmarkState.simulationRequest) return;
    renderBenchmarkSimulation(data);
    if (validation) validation.textContent = data.incompleteDocuments
      ? data.incompleteDocuments + ' documents lacked the required readings and were excluded.'
      : 'All saved documents had the required readings.';
  } catch (error) {
    if (requestNumber !== benchmarkState.simulationRequest) return;
    if (validation) { validation.style.color = 'var(--neg)'; validation.textContent = 'Simulation unavailable: ' + error.message; }
  }
}

function renderBenchmarkSimulation(data) {
  var grid = el('simStatsGrid');
  if (!grid) return;
  var cost = benchmarkCostText(
    data.actualCostPerDocumentUsd,
    data.costCoveredCalls,
    data.requiredCalls,
    data.knownCostUsd
  );
  grid.innerHTML =
    '<div class="card"><div class="v" style="color:var(--accent)">' + esc(benchmarkPct(data.cascadeAutonomyRate)) + '</div><div class="k">Cascade autonomy</div></div>' +
    '<div class="card"><div class="v" style="color:var(--pos)">' + esc(benchmarkPct(data.accuracyRate)) + '</div><div class="k">Autopublished accuracy</div></div>' +
    '<div class="card"><div class="v">' + esc(benchmarkPct(data.tier1AutonomyRate)) + '</div><div class="k">Tier 1 autonomy</div></div>' +
    '<div class="card"><div class="v" style="color:var(--neg)">' + esc(benchmarkPct(data.humanReviewRate)) + '</div><div class="k">Human review</div></div>' +
    '<div class="card"><div class="v">' + esc(cost) + '</div><div class="k">Measured usage-based cost</div><div class="note">' + esc(data.costCoveredCalls + '/' + data.requiredCalls + ' required calls priced · ' + data.invokedCalls + ' invoked') + '</div></div>' +
    '<div class="card"><div class="v">' + esc(typeof data.p50WallClockMs === 'number' ? fmtMs(data.p50WallClockMs) : 'N/A') + '</div><div class="k">Simulated p50 speed</div><div class="note">p95 ' + esc(typeof data.p95WallClockMs === 'number' ? fmtMs(data.p95WallClockMs) : 'N/A') + '</div></div>';
  var detail = el('simDetailPanel');
  if (detail) detail.textContent = 'Based on ' + data.documentsSimulated + '/' + data.documentsTotal + ' documents; ' + data.resolvedDocuments + ' resolved ground-truth documents. Tier 1 executes A then B; disagreement adds a fresh A then B then C tier. Cost uses provider-reported charges where available, otherwise actual metered units × pinned list price; unpriced meters remain partial. This is not invoice reconciliation.';
}

async function saveBenchmarkLineup() {
  var run = benchmarkState.current;
  if (!run || run.status !== 'completed') return;
  if (benchmarkState.settings && benchmarkState.settings.writeProtected) return;
  var lineup = selectedBenchmarkLineup();
  var invalid = validateBenchmarkLineup(lineup);
  var status = el('simValidation');
  if (invalid) { if (status) status.textContent = invalid; return; }
  var previous = normalizedBenchmarkLineup(benchmarkState.settings);
  var currentText = 'C ' + (benchmarkModelKey(previous.a) || 'not set') + '\\nD ' + (benchmarkModelKey(previous.b) || 'not set') + '\\nE ' + (benchmarkModelKey(previous.c) || 'not set');
  var nextText = 'C ' + benchmarkModelKey(lineup.a) + '\\nD ' + benchmarkModelKey(lineup.b) + '\\nE ' + benchmarkModelKey(lineup.c);
  if (!window.confirm('Save this as the live ' + benchmarkChamberLabel(run.chamber) + ' autopublish lineup?\\n\\nCurrent:\\n' + currentText + '\\n\\nNew:\\n' + nextText)) return;
  var button = el('saveBenchmarkLineup');
  if (button) button.disabled = true;
  if (status) status.textContent = 'Saving and reading back the live settings…';
  try {
    var result = await apiCall('/api/admin/benchmark/settings/' + encodeURIComponent(run.chamber), 'PUT', {
      a: lineup.a,
      b: lineup.b,
      c: lineup.c,
      expectedVersion: benchmarkState.settings && benchmarkState.settings.version,
      sourceRunId: run.id
    });
    benchmarkState.settings = result.settings;
    renderBenchmarkSettingsSummary();
    if (status) {
      status.style.color = result.auditPersisted === false ? 'var(--warn)' : 'var(--pos)';
      status.textContent = result.auditPersisted === false
        ? (result.warning || 'Settings were saved and verified, but the benchmark receipt was not persisted.')
        : 'Saved and verified from the effective runtime settings.';
    }
  } catch (error) {
    if (status) { status.style.color = 'var(--neg)'; status.textContent = 'Settings were not saved: ' + error.message; }
    if (button) button.disabled = false;
  }
}

function confirmBenchmarkUnknownOutcomeRetry(docId, model) {
  if (benchmarkState.unknownOutcomeRetryDecision !== null) {
    return benchmarkState.unknownOutcomeRetryDecision;
  }
  var approved = window.confirm(
    'A prior paid benchmark attempt ended without a recorded provider outcome. It may already have been billed.\\n\\n' +
    'First affected cell: ' + benchmarkModelKey(model) + ' / ' + docId + '.\\n\\n' +
    'Retry affected cells? Retrying can create additional paid calls. Because prior charges cannot be reconciled, saved cost will remain Unknown (partial).'
  );
  benchmarkState.unknownOutcomeRetryDecision = approved;
  return approved;
}

async function runBenchmarkCell(runId, docId, model) {
  // runChamberBenchmark has already obtained the user's paid-run confirmation.
  // Carry it on every cell so a long or resumed run can reserve a new UTC day
  // without becoming stranded at the day boundary.
  var body = { runId: runId, models: { a: model }, confirmPaidRun: true };
  var lastError = null;
  for (var attempt = 0; attempt < 300; attempt++) {
    try {
      var result = await apiCall('/api/admin/benchmark/dry-run/' + encodeURIComponent(docId), 'POST', body);
      if (!result.pending) return result;
      lastError = null;
      await new Promise(function(resolve) { setTimeout(resolve, Math.max(500, Math.min(result.retryAfterMs || 2000, 5000))); });
    } catch (error) {
      if (error.status === 409 && error.details && error.details.code === 'benchmark_attempt_outcome_unknown') {
        if (body.confirmRetryAfterUnknownOutcome === true) {
          throw new Error('The paid-attempt outcome remained unknown after a confirmed retry; no automatic retry was made.');
        }
        if (!confirmBenchmarkUnknownOutcomeRetry(docId, model)) {
          var declined = new Error('Retry was not confirmed after an unknown paid-attempt outcome; this saved run remains resumable and may include prior billing.');
          declined.code = 'benchmark_unknown_outcome_retry_declined';
          throw declined;
        }
        body.confirmRetryAfterUnknownOutcome = true;
        lastError = null;
        continue;
      }
      if (error.status && error.status < 500) throw error;
      lastError = error;
      await new Promise(function(resolve) { setTimeout(resolve, 2000); });
    }
  }
  throw lastError || new Error('Benchmark cell is still running; resume the saved run later.');
}

async function runChamberBenchmark(chamber, options) {
  options = options || {};
  if (benchmarkState.running) return { status: 'busy' };
  if (chamber) benchmarkState.chamber = chamber;
  var selectedChamber = benchmarkState.chamber;
  var label = benchmarkChamberLabel(selectedChamber);
  var limit = 25;
  var otherPausedRun = (benchmarkState.runs || []).find(function(run) {
    return run.chamber === selectedChamber && run.status === 'running';
  });
  var resumable = benchmarkState.current && benchmarkState.current.status === 'running' && benchmarkState.current.chamber === selectedChamber
    ? benchmarkState.current
    : null;
  if (!resumable && otherPausedRun) {
    var blockedMsg = el('benchmarkMsg');
    if (blockedMsg) {
      blockedMsg.style.color = 'var(--warn)';
      blockedMsg.textContent = 'Select the paused ' + label + ' run and either Resume it or stop it before starting a clean run.';
    }
    return { status: 'blocked', message: 'paused run must be selected first' };
  }
  var customModels = [];
  var checks = document.querySelectorAll('input[name="benchmark_model"]:checked');
  if (checks && checks.length > 0) {
    checks.forEach(function(c) {
      var parts = c.value.split('|');
      if (parts.length === 2) customModels.push({ provider: parts[0], model: parts[1] });
    });
  } else {
    customModels = REREAD_MODELS.map(function(model) { return { provider: model.provider, model: model.model }; });
  }
  var models = resumable
    ? (resumable.models || [])
    : customModels;
  var maxCalls = limit * models.length;
  var confirmText = resumable
    ? 'Resume the saved ' + label + ' benchmark?\\n\\nCompleted cells will be reused. Remaining untouched cells may make paid provider calls; if the original reservation was on a prior UTC day, this confirmation authorizes a new-day reservation for each remaining cell. An expired cell may already have been billed even though no provider outcome was saved. If one is found, you will be asked once before any retry; unreconciled prior billing keeps measured cost partial.'
    : 'Run the ' + label + ' benchmark now?\\n\\nThis will use up to ' + limit + ' filings and make up to ' + maxCalls + ' paid provider calls. Known-unavailable GPT-5.6 models will be excluded by a project-access readiness check before call reservation. Resolved ground-truth coverage is shown separately. Each completed call, latency, usage, and measurable cost will be saved.';
  if (!options.skipConfirm && !window.confirm(confirmText)) return { status: 'cancelled' };
  benchmarkState.unknownOutcomeRetryDecision = null;
  benchmarkState.running = true;
  setBenchmarkButtons();
  var msg = el('benchmarkMsg');
    if (msg) { msg.style.color = ''; msg.textContent = (resumable ? 'Resuming' : 'Creating') + ' the saved ' + label + ' run…'; }
  try {
    var started = resumable
      ? { run: resumable, docs: resumable.documents || [] }
      : await apiCall('/api/admin/benchmark/runs', 'POST', {
          chamber: selectedChamber,
          limit: limit,
          models: models,
          resolvedOnly: false,
          confirmPaidRun: true
        });
    var run = started.run;
    var docs = started.docs || [];
    var skippedModels = started.skippedModels || [];
    var reusedCells = Number(started.reusedCells || 0);
    var callsNeedingReservation = Number(started.callsNeedingReservation == null ? started.plannedCalls || 0 : started.callsNeedingReservation);
    if (!resumable && msg && reusedCells > 0) {
      msg.textContent = 'Created ' + label + ' run: reused ' + reusedCells + ' prior successful cells; ' + callsNeedingReservation + ' cells may call providers.';
    }
    // The server may remove models that its access diagnostic proves this
    // project cannot invoke. Drive cells from the persisted run, never the
    // preflight request, so excluded models cannot leak into paid execution.
    models = run.models || models;
    var planned = docs.length * models.length;
    if (!docs.length) throw new Error('No ' + label + ' filings with stored documents are available for benchmarking.');
    benchmarkState.current = run;
    var completed = 0;
    var browserFailures = [];
    var concurrency = 5;
    // Breadth-first rounds keep every provider represented when a long browser
    // session is interrupted: five documents across all models, then the next
    // five. Completed cells remain cached and are reused on Resume.
    for (var start = 0; start < docs.length; start += concurrency) {
      var chunk = docs.slice(start, start + concurrency);
      for (var modelIndex = 0; modelIndex < models.length; modelIndex++) {
        var model = models[modelIndex];
        if (msg) msg.textContent = 'Running ' + benchmarkModelKey(model) + ' · ' + completed + '/' + planned + ' saved calls…';
        await Promise.all(chunk.map(async function(document) {
          try {
            await runBenchmarkCell(run.id, document.docId, model);
          } catch (error) {
            browserFailures.push(benchmarkModelKey(model) + ' / ' + document.docId + ': ' + error.message);
            if (error.code === 'benchmark_unknown_outcome_retry_declined') throw error;
          } finally {
            completed++;
          }
        }));
      }
    }
    var completedRun = await apiCall('/api/admin/benchmark/runs/' + encodeURIComponent(run.id) + '/complete', 'POST', {});
    benchmarkState.current = completedRun.run;
    var feedback = benchmarkCompletionFeedback(label, completedRun.run, browserFailures.length, skippedModels.length);
    await loadBenchmarkHistory(selectedChamber, run.id);
    if (msg) {
      msg.style.color = feedback.warning ? 'var(--warn)' : 'var(--pos)';
      msg.textContent = feedback.message;
    }
    return { status: 'completed', runId: completedRun.run && completedRun.run.id, reusedCells: reusedCells, reusedBillableCells: Number(started.reusedBillableCells || 0), callsNeedingReservation: callsNeedingReservation };
  } catch (error) {
    var stoppedMessage = label + ' benchmark paused: ' + error.message + '. Completed readings remain saved; select this run and Resume to continue.';
    await loadBenchmarkHistory(selectedChamber).catch(function() {});
    if (msg) { msg.style.color = 'var(--neg)'; msg.textContent = stoppedMessage; }
    return { status: 'stopped', message: error.message };
  } finally {
    benchmarkState.running = false;
    setBenchmarkButtons();
  }
}

async function runAllBenchmarks() {
  if (benchmarkState.running) return;
  var originalChamber = benchmarkState.chamber;
  var chambers = ['house', 'senate', 'executive'];
  if (!window.confirm(
    'Run House, Senate, and Executive benchmarks now?\\n\\nEach branch saves its own history. Prior successful same-doc/model readings are reused, and only missing configured cells may make paid provider calls.'
  )) return;
  var msg = el('benchmarkMsg');
  var summaries = [];
  for (var i = 0; i < chambers.length; i++) {
    var chamber = chambers[i];
    benchmarkState.chamber = chamber;
    if (msg) {
      msg.style.color = '';
      msg.textContent = 'Running ' + benchmarkChamberLabel(chamber) + ' benchmark (' + (i + 1) + '/3)…';
    }
    try {
      await loadBenchmarkHistory(chamber);
      var result = await runChamberBenchmark(chamber, { skipConfirm: true });
      if (result && result.status === 'completed') {
        summaries.push(benchmarkChamberLabel(chamber) + ': saved' + (result.reusedCells ? ' (' + result.reusedCells + ' reused)' : ''));
      } else if (result && result.status === 'cancelled') {
        summaries.push(benchmarkChamberLabel(chamber) + ': cancelled');
        break;
      } else {
        summaries.push(benchmarkChamberLabel(chamber) + ': ' + ((result && result.message) || 'not completed'));
        break;
      }
    } catch (error) {
      summaries.push(benchmarkChamberLabel(chamber) + ': ' + error.message);
      break;
    }
  }
  benchmarkState.chamber = originalChamber;
  await loadBenchmarkHistory(originalChamber).catch(function() {});
  if (msg) {
    msg.style.color = summaries.length === 3 ? 'var(--pos)' : 'var(--warn)';
    msg.textContent = 'Run-all complete: ' + summaries.join(' · ');
  }
}

function clientArbitrationRowKey(tx) {
  var sym = ((tx.ticker || tx.assetName || '') + '').trim().toUpperCase();
  return sym + '|' + (tx.txDate || '') + '|' + tx.txType;
}

function clientBuildMajorityRows(reads) {
  var fields = [
    'ticker', 'assetName', 'txDate', 'txType', 'amountMin', 'amountMax', 'owner', 'assetType',
    'assetTypeName', 'isOption', 'capGainsOver200', 'filingStatus', 'subholding',
    'location', 'description', 'supplementalText'
  ];
  
  var valueFor = function(tx, field) {
    return tx[field];
  };
  
  var voteKey = function(tx, field) {
    if (field === 'isOption' || field === 'capGainsOver200') return tx[field] ? '1' : '0';
    if (field === 'txDate') return tx.txDate || '';
    var val = valueFor(tx, field);
    return (val === null || val === undefined) ? '' : String(val).trim().replace(/\\s+/g, ' ').toUpperCase();
  };

  var groups = reads.map(function(read) {
    var grouped = {};
    var rows = read.rows || [];
    for (var i = 0; i < rows.length; i++) {
      var tx = rows[i];
      var key = clientArbitrationRowKey(tx);
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(tx);
    }
    var hasAmbiguous = false;
    for (var key in grouped) {
      if (grouped[key].length > 1) hasAmbiguous = true;
    }
    return { grouped: grouped, hasAmbiguous: hasAmbiguous };
  });

  for (var i = 0; i < groups.length; i++) {
    if (groups[i].hasAmbiguous) return { ok: false, reason: 'ambiguous_multi_lot' };
  }

  var allKeys = {};
  groups.forEach(function(g) {
    Object.keys(g.grouped).forEach(function(k) { allKeys[k] = true; });
  });

  var keysSorted = Object.keys(allKeys).sort();
  if (keysSorted.length === 0) return { ok: false, reason: 'no_majority_rows' };

  var built = [];
  for (var idx = 0; idx < keysSorted.length; idx++) {
    var rowKey = keysSorted[idx];
    var present = [];
    groups.forEach(function(g) {
      var tx = g.grouped[rowKey] ? g.grouped[rowKey][0] : null;
      if (tx) present.push(tx);
    });

    if (present.length * 2 <= reads.length) {
      return { ok: false, reason: 'minority_extra_row' };
    }

    var base = present[0];
    var resolvedRow = {};
    Object.keys(base).forEach(function(f) { resolvedRow[f] = base[f]; });

    var failField = null;
    for (var fi = 0; fi < fields.length; fi++) {
      var field = fields[fi];
      var blocs = {};
      present.forEach(function(tx) {
        var key = voteKey(tx, field);
        if (!blocs[key]) blocs[key] = { count: 0, value: valueFor(tx, field) };
        blocs[key].count++;
      });

      var blocsList = Object.keys(blocs).map(function(k) { return blocs[k]; });
      var sortedBlocs = blocsList.sort(function(a, b) {
        return b.count - a.count;
      });

      var winner = sortedBlocs[0];
      if (!winner || winner.count * 2 <= reads.length) {
        failField = field;
      } else {
        resolvedRow[field] = winner.value;
      }
    }

    if (failField) return { ok: false, reason: 'field_disagreement' };
    built.push(resolvedRow);
  }

  return { ok: true, rows: built };
}

function computeMatchStats(candRows, gtRows) {
  var getFingerprint = function(tx) {
    return JSON.stringify([
      ((tx.ticker || tx.assetName || '') + '').trim().replace(/\\s+/g, ' ').toUpperCase(),
      tx.txDate || '',
      ((tx.txType || '') + '').trim().replace(/\\s+/g, ' ').toUpperCase(),
      tx.amountMin ?? null,
      tx.amountMax ?? null,
      ((tx.owner || '') + '').trim().replace(/\\s+/g, ' ').toUpperCase(),
      ((tx.assetType || '') + '').trim().replace(/\\s+/g, ' ').toUpperCase(),
      tx.isOption === true || tx.isOption === 1 || tx.isOption === '1',
      tx.capGainsOver200 === true || tx.capGainsOver200 === 1 || tx.capGainsOver200 === '1',
    ]);
  };

  var candFingerprints = (candRows || []).map(getFingerprint);
  var gtFingerprints = (gtRows || []).map(getFingerprint);

  var gtCounts = {};
  gtFingerprints.forEach(function(f) { gtCounts[f] = (gtCounts[f] || 0) + 1; });

  var candCounts = {};
  candFingerprints.forEach(function(f) { candCounts[f] = (candCounts[f] || 0) + 1; });

  var tp = 0;
  var fp = 0;
  var fn = 0;

  var allFingerprints = new Set(Object.keys(gtCounts).concat(Object.keys(candCounts)));
  allFingerprints.forEach(function(f) {
    var gtVal = gtCounts[f] || 0;
    var candVal = candCounts[f] || 0;
    var match = Math.min(gtVal, candVal);
    tp += match;
    fp += Math.max(0, candVal - match);
    fn += Math.max(0, gtVal - match);
  });

  return {
    perfectMatch: fp === 0 && fn === 0,
    tp: tp,
    fp: fp,
    fn: fn,
    gtCount: gtRows.length,
    candCount: candRows.length
  };
}

function sameRowSet(rowsA, rowsB) {
  if (!rowsA || !rowsB) return false;
  if (rowsA.length !== rowsB.length) return false;
  
  var getFingerprint = function(tx) {
    return JSON.stringify([
      ((tx.ticker || tx.assetName || '') + '').trim().replace(/\\s+/g, ' ').toUpperCase(),
      tx.txDate || '',
      ((tx.txType || '') + '').trim().replace(/\\s+/g, ' ').toUpperCase(),
      tx.amountMin ?? null,
      tx.amountMax ?? null,
      ((tx.owner || '') + '').trim().replace(/\\s+/g, ' ').toUpperCase(),
      ((tx.assetType || '') + '').trim().replace(/\\s+/g, ' ').toUpperCase(),
      tx.isOption === true || tx.isOption === 1 || tx.isOption === '1',
      tx.capGainsOver200 === true || tx.capGainsOver200 === 1 || tx.capGainsOver200 === '1',
    ]);
  };
  
  var ka = rowsA.map(getFingerprint).sort();
  var kb = rowsB.map(getFingerprint).sort();
  return ka.every(function (val, idx) { return val === kb[idx]; });
}
function runMarketBackfill(dryRun) {
  var msg = el('mdMsg');
  var max = Number(el('mdMax') && el('mdMax').value) || 40;
  var perMin = Number(el('mdPerMin') && el('mdPerMin').value) || 250;
  if (msg) msg.textContent = dryRun ? 'Checking…' : 'Running one bounded pass…';
  return fetch('/api/admin/backfill-market', {
    method: 'POST',
    headers: adminHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ max: max, maxPerMinute: perMin, dryRun: !!dryRun })
  })
    .then(okOrThrow)
    .then(function (data) {
      if (msg) msg.textContent = (dryRun ? 'Dry run' : 'Pass complete') + ': ' +
        'enriched ' + ((data.enrich && data.enrich.enriched) || 0) +
        ', priced ' + ((data.prices && data.prices.tickersPriced) || 0) +
        ', pending ' + ((data.pending && data.pending.enrich) || 0) + ' enrichment / ' +
        ((data.pending && data.pending.prices) || 0) + ' prices.';
      return loadMarketCoverage();
    })
    .catch(function (e) {
      if (msg) msg.textContent = isAuthError(e) ? ADMIN_MOVED_MSG : ('Market backfill failed: ' + e.message);
    });
}

/* ============================ TRENDS / ANALYTICS ============================ */
/* All views read /api/analytics/* — read-only aggregates over the corpus. Dollar
	   values are ESTIMATES from STOCK Act bracket midpoints (labelled with ~). */
	var EST_VOLUME_TIP = 'Approximate stock volume from STOCK Act amount ranges.  Option premiums are excluded.  Closed ranges use the midpoint; the open $50M+ range uses its $50,000,001 floor.  Treat as a rough order of magnitude, not an exact figure.';
	var BUY_PRESSURE_TIP = 'Share of buys among buy+sell trades in the window (buy count / (buys + sells)).  A simple trade-count tilt, not dollar-weighted.';
	var NET_FLOW_TIP = 'Buy dollars minus sell dollars in the selected window, using STOCK Act bracket midpoints on common stock only ($50M+ uses its floor).  Option premiums are excluded.  A very rough estimate of net direction, not an exact figure.';
	var NET_FLOW_TIP_ALLTIME = 'Buy dollars minus sell dollars across this asset\u2019s disclosed common-stock trades, using STOCK Act bracket midpoints.  Option premiums are excluded.  A very rough estimate of net direction, not exact.';
	// Trends "Trades" answers a different question than the Trades tab's own
	// "N total": this counts trades in the Trends TIME WINDOW + chamber/party/side
	// chips above (default: past 90 days, all parties, all sides), while the Trades tab
	// counts whatever its own ticker/politician/date/chamber/party/side filters
	// currently say, over its own separately paginated total. Both count the
	// same underlying "real, disclosed trade" universe (synthetic/placeholder
	// rows are excluded from both — see delivery/rows.ts + analytics/sql.ts),
	// so a residual difference here is a scope difference, not a bug — this
	// tip exists so that's obvious at a glance rather than a support question.
	var TRENDS_TRADES_TIP = 'Trades matching the time window + chamber/party/side filters above — a different query than the Trades tab list, which has its own filters and total.';
function trParams() {
  var p = 'window=' + encodeURIComponent(getTrWindow());
  var ch = chamberParam('trChamber'); if (ch) p += '&chamber=' + encodeURIComponent(ch);
  
  var paGroup = el('trPartyGroup');
  if (paGroup) {
    var parties = [];
    paGroup.querySelectorAll('.party-chip.on').forEach(function(b) { parties.push(b.getAttribute('data-party')); });
    if (parties.length > 0) p += '&party=' + parties.join(',');
  }
  var ty = selectedSideParam('trSideGroup');
  if (ty) p += '&type=' + encodeURIComponent(ty);
  return p;
}
var TR_WINDOW_LABELS = { '30d': 'Month', '90d': '3 Months', '180d': '6 Months', '365d': 'Year', '1825d': '5 Years', 'this_cy': 'This Year', 'last_cy': 'Last Year', 'all': 'All Time' };
function windowLabel(v) { return TR_WINDOW_LABELS[v] || v; }
/* The single top-level dropdown box (#trGlobalWindow / .tr-window-select) is
   the single control for timeframe filtering. Headings no longer stamp the
   window; this still updates any leftover .tr-window-label nodes and the
   Consensus Moves phrase. */
function stampWindowChips() {
  var val = getTrWindow();
  var lblText = windowLabel(val);
  document.querySelectorAll('.tr-window-label').forEach(function(el) {
    el.textContent = lblText;
  });
}
/* Small TTL memo cache over the analytics endpoints (same TTL+dedupe idiom as
   fetchLatencySummary below): a Trends window change fires ~12 parallel aGet
   calls and re-opening a drawer used to refetch everything. 60 s is well
   inside the feed's own cadence, so nothing here goes visibly stale. */
var AGET_CACHE = {};
var AGET_TTL_MS = 60000;
/* APICONTRACT-01: never let a query marker ride inside a path segment. If a
   caller percent-encoded member/id?window= into the path, peel it back out. */
function analyticsUrl(path) {
  var decoded = path;
  try { decoded = decodeURIComponent(path); } catch (e) { /* keep raw */ }
  var q = decoded.indexOf('?');
  var pathname = q >= 0 ? decoded.slice(0, q) : decoded;
  var search = q >= 0 ? decoded.slice(q + 1) : '';
  var url = '/api/analytics/' + pathname;
  if (search) url += '?' + search;
  return url;
}
function aGet(path) {
  var now = Date.now();
  var url = analyticsUrl(path);
  var hit = AGET_CACHE[url];
  if (hit && hit.data !== undefined && now - hit.at < AGET_TTL_MS) return Promise.resolve(hit.data);
  if (hit && hit.promise) return hit.promise;
  var entry = AGET_CACHE[url] = { data: undefined, at: 0, promise: null };
  entry.promise = fetch(url)
    .then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status); return r.json();
    })
    .then(function (d) { entry.data = d; entry.at = Date.now(); entry.promise = null; return d; })
    .catch(function (e) { delete AGET_CACHE[url]; throw e; });
  return entry.promise;
}
/* Compact USD: 1234567 -> $1.2M, 3.2e12 -> $3.2T. */
function usdC(n) {
  n = Number(n || 0);
  if (!isFinite(n) || Object.is(n, -0)) n = 0;
  var isNeg = n < 0;
  n = Math.abs(n);
  var o;
  if (n >= 1e12) o = (n / 1e12).toFixed(1) + 't';
  else if (n >= 1e9) o = (n / 1e9).toFixed(1) + 'b';
  else if (n >= 1e6) o = (n / 1e6).toFixed(1) + 'm';
  else if (n >= 1e3) o = (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k';
  else o = String(Math.round(n));
  if (parseFloat(o) === 0 || o === '0' || o === '0.0k' || o === '0k' || o === '0.0m' || o === '0.0b' || o === '0.0t') {
    return '$0';
  }
  return (isNeg ? '-' : '') + '$' + o;
}
	function estUsd(n) {
	  return '<span class="est-money" title="' + esc(EST_VOLUME_TIP) + '">~' + usdC(n) + '</span>';
	}
function netHtml(n) {
  n = Number(n || 0);
  var cls = n > 0 ? 'pos' : n < 0 ? 'neg' : '';
  var sign = n > 0 ? '+' : n < 0 ? '\u2212' : '';
  return '<span class="net kpi-money ' + cls + '">' + sign + usdC(Math.abs(n)) + '</span>';
}
function splitBar(buys, sells) {
  buys = Number(buys || 0); sells = Number(sells || 0);
  var tot = buys + sells, bp = tot ? Math.round(100 * buys / tot) : 0, sp = tot ? 100 - bp : 0;
  // Owner 2026-08-10: "21B / 0S" reads like magnitudes (21 billion) — spell
  // the words out in lowercase instead, pluralized ("1 buy / 3 sells").
  return '<span class="split-wrap"><span class="split">' +
    '<span class="seg buy" style="width:' + bp + '%"></span>' +
    '<span class="seg sell" style="width:' + sp + '%"></span></span>' +
    '<small>' + pluralCount(buys, 'buy') + ' / ' + pluralCount(sells, 'sell') + '</small></span>';
}
/* "1 Democrat" / "2 Democrats" — pluralize a count + noun for party breakdowns. */
function pluralCount(n, noun) { n = Number(n || 0); return fmtCount(n) + ' ' + noun + (n === 1 ? '' : 's'); }
/* Owner follow-up batch #14: Consensus Moves cards abbreviate "Democrats"/
   "Republicans" to "Dems"/"Reps" on mobile (so two cards fit per row) while
   desktop keeps the full word — a responsive full/abbr span pair (CSS-only
   toggle, see .party-full/.party-abbr), never JS branching, so it stays
   correct across a live resize. full/abbr are static strings we control, so
   this is safe to inline without esc(). */
function partyCountHtml(n, full, abbr) {
  n = Number(n || 0);
  var suf = n === 1 ? '' : 's';
  return fmtCount(n) + ' <span class="party-full">' + full + suf + '</span><span class="party-abbr">' + abbr + suf + '</span>';
}
/* Colored party dot (red/blue/purple) with an accessible name — the dot is
   often the only party signal in a row (e.g. next to a member's name), so it
   needs its own aria-label/title, not just a hidden decorative color swatch. */
function pdot(b) {
  if (!b) return '';
  var name = (typeof PARTY_NAME !== 'undefined' && PARTY_NAME[b]) || b;
  return '<span class="pdot ' + esc(b) + '" role="img" aria-label="' + esc(name) + '" title="' + esc(name) + '"></span>';
}
function attrTip(tip) { return tip ? ' title="' + esc(tip) + '" data-tip="' + esc(tip) + '"' : ''; }
/* Spacious surfaces (KPI strip, flow chips, drawers): always spell out. */
function polFull(n) { n = Number(n || 0); return fmtCount(n) + ' politician' + (n === 1 ? '' : 's'); }
function assetFull(n) { n = Number(n || 0); return fmtCount(n) + ' asset' + (n === 1 ? '' : 's'); }
function buySellText(buys, sells) {
  buys = Number(buys || 0); sells = Number(sells || 0);
  return fmtCount(buys) + ' buy' + (buys === 1 ? '' : 's') + '\\u00a0\\u00a0/\\u00a0\\u00a0' + fmtCount(sells) + ' sell' + (sells === 1 ? '' : 's');
}

	function kpi(k, v, tip) {
	  var display = (typeof v === 'number' && Number.isFinite(v)) ? fmtCount(v) : v;
	  return '<div class="card"' + attrTip(tip) + '><div class="k">' + esc(k) + '</div><div class="v">' + display + '</div></div>';
	}
	function kpiRaw(kHtml, v, tip) { return '<div class="card"' + attrTip(tip) + '><div class="k">' + kHtml + '</div><div class="v">' + v + '</div></div>'; }
	function kpiLabel(fullHtml, mid, short) {
	  return '<span class="k-label"><span class="k-full">' + fullHtml + '</span><span class="k-mid">' + esc(mid) + '</span><span class="k-short">' + esc(short) + '</span></span>';
	}
	function infoLabel(text, tip) {
	  return esc(text) + ' <span class="info-tip" tabindex="0" aria-label="' + esc(tip) + '" title="' + esc(tip) + '">ⓘ</span>';
	}
	function kpiInfo(k, v, tip, onClickStr, extraHtml) {
	  var attr = onClickStr ? ' class="card clickable" onclick="' + esc(onClickStr) + '"' : ' class="card"';
	  return '<div' + attr + '><div class="k">' + infoLabel(k, tip) + '</div><div class="v">' + v + (extraHtml || '') + '</div></div>';
	}
var trTickerSortVal = 'trades';
function setTickerSort(val) {
  trTickerSortVal = val === 'volume' || val === 'members' || val === 'netflow' ? val : 'trades';
  var metric = el('trTickerMetric');
  if (metric) {
    var btns = metric.querySelectorAll('button[data-m]');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('on', btns[i].getAttribute('data-m') === trTickerSortVal);
    }
  }
  loadTrTickers();
}
function sparklineHtml(series, metric) {
  if (!series || !series.length) return '';
  var vals = series.map(function(p) {
    if (metric === 'netflow') return (p.estBuyVolUsd || 0) - (p.estSellVolUsd || 0);
    if (metric === 'buypressure') return (p.buys + p.sells) > 0 ? (p.buys / (p.buys + p.sells)) : 0.5;
    return 0;
  });
  var max = 0.001, min = 0;
  if (metric === 'netflow') {
    vals.forEach(function(v) { max = Math.max(max, Math.abs(v)); });
  } else {
    max = 1; min = 0;
  }
  return '<div class="kpi-spark">' +
    vals.map(function(v, i) {
      var h, color;
      if (metric === 'netflow') {
        h = Math.max(1, Math.round(100 * Math.abs(v) / max));
        color = v >= 0 ? 'var(--buy)' : 'var(--sell)';
      } else {
        h = Math.max(1, Math.round(100 * v));
        color = 'var(--accent)';
      }
      return '<div style="flex:1; background:' + color + '; height:' + h + '%; border-radius:1px" title="' + esc(series[i].period) + '"></div>';
    }).join('') + '</div>';
}
function scrollToChart(id) {
  var chart = el(id);
  if (chart) {
    chart.scrollIntoView({ behavior: 'smooth', block: 'center' });
    var oldTransition = chart.style.transition;
    var oldOutline = chart.style.outline;
    var oldOffset = chart.style.outlineOffset;
    var oldRadius = chart.style.borderRadius;
    chart.style.transition = 'outline 0.3s';
    chart.style.outline = '2px solid var(--accent)';
    chart.style.outlineOffset = '4px';
    chart.style.borderRadius = '8px';
    setTimeout(function() {
      chart.style.outline = 'transparent';
      setTimeout(function() {
        chart.style.transition = oldTransition;
        chart.style.outline = oldOutline;
        chart.style.outlineOffset = oldOffset;
        chart.style.borderRadius = oldRadius;
      }, 300);
    }, 1500);
  }
}
/* Owner punch list #18(b): the analytics API buckets weekly series as
   strftime('%Y-W%W', ...) — literally "2026-W19" — which this function used
   to fall through unrecognized and print verbatim ("gibberish" x-axis
   labels). %W counts Monday-start weeks with week 00 = the partial run of
   days before the year's first Monday, so we rebuild that same week's
   Monday and label the bar with its start date instead of the raw bucket. */
function fmtPeriod(p) {
  if (!p) return '';
  var mw = /^(\\d{4})-W(\\d{1,2})$/.exec(p);
  if (mw) {
    var wyr = parseInt(mw[1], 10), wk = parseInt(mw[2], 10);
    var jan1 = new Date(Date.UTC(wyr, 0, 1));
    var daysToFirstMon = (8 - jan1.getUTCDay()) % 7;
    var firstMon = new Date(jan1.getTime() + daysToFirstMon * 86400000);
    var weekStart = wk <= 0 ? jan1 : new Date(firstMon.getTime() + (wk - 1) * 7 * 86400000);
    return MONTH_ABBR[weekStart.getUTCMonth()] + ' ' + weekStart.getUTCDate();
  }
  var m = /^(\\d{4})-(\\d{1,2})$/.exec(p);
  if (m) {
    var yr = parseInt(m[1], 10), num = parseInt(m[2], 10);
    return MONTH_ABBR[num - 1] + ' ' + yr;
  }
  var m2 = /^(\\d{4})-(\\d{2})-(\\d{2})$/.exec(p);
  if (m2) {
    return MONTH_ABBR[parseInt(m2[2],10)-1] + ' ' + parseInt(m2[3],10);
  }
  return p;
}
/* Mini CSS-column time chart of buys vs sells (no chart library).
   metric: 'count' | 'dollars' | omitted (auto: dollars when volume exists). */
function timeChartHtml(series, labelStep, metric) {
  var useVol;
  if (metric === 'count') useVol = false;
  else if (metric === 'dollars') useVol = true;
  else {
    var volMax = 1;
    series.forEach(function (p) { volMax = Math.max(volMax, p.estBuyVolUsd || 0, p.estSellVolUsd || 0); });
    useVol = volMax > 1;
  }
  var max = 1;
  series.forEach(function (p) {
    max = Math.max(max, useVol ? (p.estBuyVolUsd || 0) : (p.buys || 0), useVol ? (p.estSellVolUsd || 0) : (p.sells || 0));
  });

  var step = labelStep || Math.max(1, Math.ceil(series.length / 14));
  return '<div class="tchart" data-metric="' + (useVol ? 'dollars' : 'count') + '">' + series.map(function (p, i) {
    var vB = useVol ? (p.estBuyVolUsd || 0) : (p.buys || 0);
    var vS = useVol ? (p.estSellVolUsd || 0) : (p.sells || 0);
    var bh = vB > 0 ? Math.max(3, Math.round(100 * vB / max)) : 0;
    var sh = vS > 0 ? Math.max(3, Math.round(100 * vS / max)) : 0;
    var lbl = (i % step === 0) ? esc(fmtPeriod(p.period || '')) : '';

    return '<div class="tcol" tabindex="0" data-period="'+esc(p.period||'')+'" ' +
      'data-b="'+(p.buys||0)+'" data-s="'+(p.sells||0)+'" ' +
      'data-bv="'+(p.estBuyVolUsd||0)+'" data-sv="'+(p.estSellVolUsd||0)+'">' +
      '<div class="tbars">' +
      '<i class="buy" style="height:' + bh + '%"></i><i class="sell" style="height:' + sh + '%"></i>' +
      '</div><span class="tlbl">' + lbl + '</span></div>';
  }).join('') + '</div>';
}

function loadTrends() {
  stampWindowChips();
  syncRisingActivityVisibility();
  loadTrSummary(); loadTrTickers(); loadTrTrending(); loadTrClusters();
  loadTrTime(); loadTrSectorFlow(); loadTrCapFlow(); loadTrPerformers();
  loadTrMembers(); loadTrParties(); loadTrSectors(); loadTrLag();
  loadTrConflicts();
}
function syncRisingActivityVisibility() {
  var fold = el('trRisingFold');
  if (!fold) return;
  var hide = getTrWindow() === 'all';
  fold.hidden = hide;
}

/* "House Committee on Financial Services" -> "House Financial Services": the
   chamber + "Committee on" boilerplate repeats on every row, so the part that
   differs gets the column width.  Select / Joint / Subcommittee names pass
   through untouched; the cell's tooltip always carries the full names. */
function shortCommittee(name) {
  return String(name || '').replace(/^(House|Senate) Committee on (?:the )?/i, '$1 ');
}
/* Committee cell: one committee per line, clamped to two lines by CSS
   (.committee-lines), "+N more" on the second line when the list is longer,
   full list in the title.  extraAttrs carries the row's data-member so the
   cell opens the politician's drawer like the rest of the row. */
function committeeCellHtml(list, extraAttrs) {
  var all = Array.isArray(list) ? list.filter(Boolean) : (list ? [String(list)] : []);
  if (!all.length) return '<td class="muted committees"' + (extraAttrs || '') + '>—</td>';
  var lines = all.slice(0, 2).map(function (c) { return esc(shortCommittee(c)); });
  if (all.length > 2) lines[1] += ' <span class="more">+' + (all.length - 2) + ' more</span>';
  return '<td class="muted committees"' + (extraAttrs || '') + ' title="' + esc(all.join('\\n')) + '">' +
    '<div class="committee-lines">' + lines.map(function (l) { return '<span class="committee-line">' + l + '</span>'; }).join('') + '</div></td>';
}
/* Committee sector conflicts for the current Trends window. */
function loadTrConflicts() {
  var body = el('trConflicts');
  if (!body) return;
  body.innerHTML = stateRow(6, 'Loading…');
  aGet('conflicts?' + trParams() + '&limit=40').then(function (d) {
    var rows = d.conflicts || [];
    if (!rows.length) {
      body.innerHTML = stateRow(6, 'No committee-sector conflicts in this window.');
      return;
    }
    body.innerHTML = rows.map(function (r) {
      var name = fmtName(r.memberName || r.filerId || 'Unknown');
      var memberAttr = r.filerId
        ? ' class="member-cell clickable" data-member="' + esc(r.filerId) + '"'
        : ' class="member-cell"';
      // Every cell except Asset opens the politician's drawer (the click
      // delegation resolves [data-member] before [data-asset], so the ticker
      // keeps its own company link only if its cell carries no data-member).
      var rowMember = r.filerId ? ' data-member="' + esc(r.filerId) + '"' : '';
      var side = typeName[r.txType] || r.txType || '—';
      var asset = r.ticker || '—';
      return '<tr class="row conflict-row">' +
        '<td' + rowMember + '><div' + memberAttr + ' title="' + esc(name) + '"><span class="name-line">' + esc(name) + '</span></div></td>' +
        committeeCellHtml(r.viaCommittees, rowMember) +
        '<td class="muted sector"' + rowMember + ' title="' + esc(r.sector || '') + '">' + esc(r.sector || '—') + '</td>' +
        '<td>' + (r.ticker
          ? '<span class="clickable" data-asset="' + esc(r.ticker) + '">' + esc(asset) + '</span>'
          : esc(asset)) + '</td>' +
        '<td' + rowMember + ' title="' + esc(side) + '"><span class="dirpill ' + esc(r.txType || '') + '">' + esc(side) + '</span></td>' +
        '<td class="est"' + rowMember + '>' + estUsd(r.estAmountUsd) + '</td></tr>';
    }).join('');
  }).catch(function (e) {
    body.innerHTML = stateRow(6, 'Could not load: ' + e.message);
  });
}

/* ---- Directory (GET /api/members; multi-token name/state/party search + sort) ---- */
var PEOPLE_CACHE = null; // full roster once loaded
var PEOPLE_CACHE_AT = 0;
var PEOPLE_TTL_MS = 5 * 60 * 1000;
var PEOPLE_SORT = { key: 'trades', dir: -1 }; // default most-active first
/* abbr → full name (lowercase) for state search */
var US_STATE_ABBR = {
  al:'alabama', ak:'alaska', az:'arizona', ar:'arkansas', ca:'california', co:'colorado',
  ct:'connecticut', de:'delaware', fl:'florida', ga:'georgia', hi:'hawaii', id:'idaho',
  il:'illinois', in:'indiana', ia:'iowa', ks:'kansas', ky:'kentucky', la:'louisiana',
  me:'maine', md:'maryland', ma:'massachusetts', mi:'michigan', mn:'minnesota',
  ms:'mississippi', mo:'missouri', mt:'montana', ne:'nebraska', nv:'nevada',
  nh:'new hampshire', nj:'new jersey', nm:'new mexico', ny:'new york', nc:'north carolina',
  nd:'north dakota', oh:'ohio', ok:'oklahoma', or:'oregon', pa:'pennsylvania',
  ri:'rhode island', sc:'south carolina', sd:'south dakota', tn:'tennessee', tx:'texas',
  ut:'utah', vt:'vermont', va:'virginia', wa:'washington', wv:'west virginia',
  wi:'wisconsin', wy:'wyoming', dc:'district of columbia', pr:'puerto rico', vi:'virgin islands',
  gu:'guam', as:'american samoa', mp:'northern mariana islands'
};
var US_STATE_NAME_TO_ABBR = (function () {
  var m = {};
  Object.keys(US_STATE_ABBR).forEach(function (abbr) { m[US_STATE_ABBR[abbr]] = abbr; });
  return m;
})();
function peoplePartySearchBlob(party) {
  var p = String(party || '').toLowerCase().trim();
  var blob = p;
  if (!p) return 'other independent independents';
  if (p === 'd' || p.indexOf('dem') === 0) blob += ' democrat democrats d';
  else if (p === 'r' || p.indexOf('rep') === 0) blob += ' republican republicans r gop';
  else if (p === 'i' || p === 'id' || p.indexOf('ind') === 0 || p.indexOf('other') === 0)
    blob += ' independent independents other i';
  else blob += ' other independent independents';
  return blob;
}
function peopleStateMatches(token, stateAbbr) {
  var st = String(stateAbbr || '').toLowerCase().trim();
  if (!st) return false;
  if (token === st) return true;
  var full = US_STATE_ABBR[st] || '';
  if (full && (full === token || full.indexOf(token) === 0 || full.indexOf(token) >= 0)) return true;
  // token is a full state name (or prefix)
  var abbrFromName = US_STATE_NAME_TO_ABBR[token];
  if (abbrFromName && abbrFromName === st) return true;
  // multi-word state: match if token is a word in the full name
  if (full) {
    var words = full.split(/\\s+/);
    for (var i = 0; i < words.length; i++) {
      if (words[i] === token || words[i].indexOf(token) === 0) return true;
    }
  }
  return false;
}
function peoplePartyMatches(token, party) {
  var blob = peoplePartySearchBlob(party);
  if (blob.indexOf(token) >= 0) return true;
  // partial of democrat/republican/independent/other
  var labels = ['democrat', 'democrats', 'republican', 'republicans', 'independent', 'independents', 'other'];
  for (var i = 0; i < labels.length; i++) {
    if (labels[i].indexOf(token) === 0 || token.indexOf(labels[i]) === 0) {
      // token is a prefix of a party word — still need party to match that family
      if (labels[i].charAt(0) === 'd' && blob.indexOf('democrat') >= 0) return true;
      if (labels[i].charAt(0) === 'r' && blob.indexOf('republican') >= 0) return true;
      if ((labels[i].charAt(0) === 'i' || labels[i].charAt(0) === 'o') &&
          (blob.indexOf('independent') >= 0 || blob.indexOf('other') >= 0)) return true;
    }
  }
  return false;
}
/** Multi-token AND search: "CA Ro" matches California + Ro Khanna. */
function memberMatchesPeopleQuery(m, q) {
  var raw = String(q || '').trim().toLowerCase();
  if (!raw) return true;
  var tokens = raw.split(/\\s+/).filter(Boolean);
  var name = String(m.fullName || '').toLowerCase();
  var nameParts = name.split(/[\\s,.\\-']+/).filter(Boolean);
  var filer = String(m.filerId || '').toLowerCase();
  var state = String(m.state || '').toLowerCase();
  var chamber = String(m.chamber || '').toLowerCase();
  var district = String(m.district || '').toLowerCase();
  var party = String(m.party || '');
  return tokens.every(function (tok) {
    if (peopleStateMatches(tok, state)) return true;
    if (peoplePartyMatches(tok, party)) return true;
    if (name.indexOf(tok) >= 0) return true;
    if (filer.indexOf(tok) >= 0) return true;
    if (chamber.indexOf(tok) >= 0) return true;
    if (district && district.indexOf(tok) >= 0) return true;
    for (var i = 0; i < nameParts.length; i++) {
      if (nameParts[i].indexOf(tok) === 0 || nameParts[i].indexOf(tok) >= 0) return true;
    }
    return false;
  });
}
function loadPeopleDirectory() {
  var body = el('peopleBody');
  var countEl = el('peopleCount');
  if (!body) return Promise.resolve();
  body.innerHTML = stateRow(3, 'Loading directory…');
  if (countEl) countEl.textContent = '';
  var now = Date.now();
  var useCache = PEOPLE_CACHE && (now - PEOPLE_CACHE_AT) < PEOPLE_TTL_MS;
  var fetchRoster = useCache
    ? Promise.resolve(PEOPLE_CACHE)
    : fetch('/api/members', { headers: { accept: 'application/json' } })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function (d) {
          PEOPLE_CACHE = d;
          PEOPLE_CACHE_AT = Date.now();
          return d;
        });
  return fetchRoster
    .then(function (d) { renderPeopleDirectory(d && d.members ? d.members : []); })
    .catch(function (e) {
      body.innerHTML = stateRow(3, 'Could not load directory: ' + e.message);
    });
}
function sortPeopleDirectory(key) {
  if (PEOPLE_SORT.key === key) PEOPLE_SORT.dir = -PEOPLE_SORT.dir;
  else {
    PEOPLE_SORT.key = key;
    PEOPLE_SORT.dir = key === 'trades' ? -1 : 1;
  }
  if (PEOPLE_CACHE && PEOPLE_CACHE.members) renderPeopleDirectory(PEOPLE_CACHE.members);
  else loadPeopleDirectory();
}
/* Sort key for the People directory 'name' column: keys on the LAST name
 * token (ignoring a trailing generational suffix like Jr/Sr/II/III/IV) so
 * "Rob Portman" sorts under P, not R — the owner's expectation for a member
 * directory. Ties (two members sharing a surname) fall back to the full
 * display string via a low-codepoint separator so lexicographic comparison
 * of the composite key alone (av < bv / av > bv) does the tie-break, without
 * needing special-case comparator logic at the call site. */
function surnameSortKey(name) {
  var SORT_SEP = String.fromCharCode(1);
  var display = String(name || '');
  var tokens = display.split(/\\s+/).filter(Boolean);
  if (!tokens.length) return '~' + SORT_SEP + display.toLowerCase();
  var last = tokens[tokens.length - 1];
  var lastBare = last.toLowerCase().replace(/[.,]/g, '');
  if (tokens.length > 1 && NAME_SUFFIX[lastBare]) {
    last = tokens[tokens.length - 2];
  }
  return last.toLowerCase() + SORT_SEP + display.toLowerCase();
}
function peopleSortValue(m, key) {
  if (key === 'trades') return Number(m.txCount) || 0;
  if (key === 'name') return surnameSortKey(fmtName(m.fullName || m.filerId || ''));
  if (key === 'chamber') return String(m.chamber || '').toLowerCase();
  if (key === 'party') return String(m.party || '').toLowerCase();
  if (key === 'state') return String(m.state || '').toLowerCase();
  return '';
}
function syncPeopleSortIndicators() {
  var head = el('peopleHead');
  if (!head) return;
  var ths = head.querySelectorAll('th[data-sort]');
  for (var i = 0; i < ths.length; i++) {
    var th = ths[i];
    th.classList.remove('sort-asc', 'sort-desc');
    if (th.getAttribute('data-sort') === PEOPLE_SORT.key) {
      th.classList.add(PEOPLE_SORT.dir > 0 ? 'sort-asc' : 'sort-desc');
      th.setAttribute('aria-sort', PEOPLE_SORT.dir > 0 ? 'ascending' : 'descending');
    } else {
      th.setAttribute('aria-sort', 'none');
    }
  }
}
function renderPeopleDirectory(all) {
  var body = el('peopleBody');
  var countEl = el('peopleCount');
  if (!body) return;
  var chamberSel = el('peopleChamber');
  var chamber = chamberSel ? String(chamberSel.value || '').toLowerCase() : '';
  var qEl = el('peopleQ');
  var q = qEl ? String(qEl.value || '').trim() : '';
  var rows = (all || []).filter(function (m) {
    if (chamber) {
      var ch = String(m.chamber || '').toLowerCase();
      if (chamber === 'house' && ch !== 'house' && ch !== 'h' && ch.indexOf('house') === -1) return false;
      if (chamber === 'senate' && ch !== 'senate' && ch !== 's' && ch.indexOf('senate') === -1) return false;
      if (chamber === 'executive' && ch !== 'executive' && ch !== 'oge' && ch !== 'exec' && ch.indexOf('exec') === -1) return false;
    }
    return memberMatchesPeopleQuery(m, q);
  });
  var sk = PEOPLE_SORT.key;
  var sd = PEOPLE_SORT.dir;
  rows.sort(function (a, b) {
    var av = peopleSortValue(a, sk);
    var bv = peopleSortValue(b, sk);
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * sd;
    if (av < bv) return -1 * sd;
    if (av > bv) return 1 * sd;
    // stable secondary: name then trades
    var an = String(a.fullName || a.filerId || '').toLowerCase();
    var bn = String(b.fullName || b.filerId || '').toLowerCase();
    if (an < bn) return -1;
    if (an > bn) return 1;
    return (Number(b.txCount) || 0) - (Number(a.txCount) || 0);
  });
  syncPeopleSortIndicators();
  if (!rows.length) {
    body.innerHTML = stateRow(3, q || chamber ? 'No politicians match this filter.' : 'No politicians in the directory yet.');
    if (countEl) countEl.textContent = '0 politicians shown';
    return;
  }
  body.innerHTML = rows.map(function (m) {
    var name = fmtName(m.fullName || m.filerId || 'Unknown');
    // Real <a href> (SEOSOCIAL-02) when the row resolves to a filer id, so
    // the Directory table is a page of genuine, crawlable politician links —
    // not just click targets a script has to intercept to be useful at all.
    var memberTag = m.filerId ? 'a' : 'div';
    var memberAttr = m.filerId
      ? ' class="member-cell clickable" href="' + esc(entityHref('member', m.filerId)) + '" data-member="' + esc(m.filerId) + '" title="Open ' + esc(name) + '"'
      : ' class="member-cell"';
    var parts = [];
    if (isExecutiveFiler(m.chamber, m.filerId)) {
      // Title (e.g. "Treasury Secretary") REPLACES the generic "Exec" branch
      // word (see shared/executiveTitles.ts); no state/district for executive
      // filers — they don't represent one. An uncurated filer gets the bare
      // 'Executive Branch' fallback, which stands alone and never prefixes a
      // real title.
      parts.push(esc(execDisplayTitle(m.filerId, m.title, EXEC_TITLE_FULL)));
      if (m.party) parts.push(esc(dirPartyLetter(m.party)));
    } else {
      var chLabel = chamberLabel(m.chamber);
      if (chLabel) parts.push(esc(chLabel));
      if (m.party) parts.push(esc(dirPartyLetter(m.party)));
      if (m.state) {
        parts.push(esc(String(m.state)) + (m.district ? ' - ' + fmtDistrictOrdinalHtml(m.district) : ''));
      }
    }
    var branchPartyState = parts.length ? parts.join(' • ') : '—';
    return '<tr class="row" ' + (m.filerId ? 'data-member="' + esc(m.filerId) + '"' : '') + '>' +
      '<td class="col-fill"><' + memberTag + memberAttr + '>' + memberAvatarHtml(name, m.photoUrl, m.party, true) + '<span class="cell-clip" title="' + esc(name) + '">' + esc(name) + '</span></' + memberTag + '></td>' +
      '<td class="col-fit muted" title="' + esc(branchPartyState.replace(/<[^>]+>/g, '')) + '">' + branchPartyState + '</td>' +
      '<td class="col-num muted">' + (m.txCount != null ? fmtCount(m.txCount) : '—') + '</td></tr>';
  }).join('');
  // Say what the Trades column counts. It is the politician's FULL record, so
  // it deliberately disagrees with the Trades tab, whose count is scoped to the
  // active time window (Ro Khanna: 22,832 here, 988 in a 3-month window).
  if (countEl) countEl.textContent = fmtCount(rows.length) + ' of ' + fmtCount((all || []).length) + ' politicians\u00a0\u00a0\u2022\u00a0\u00a0trade counts are all time';
}
/* Single-letter party for the compact Branch • Party • State cell. */
function dirPartyLetter(p) {
  var s = String(p || '').trim();
  if (/^dem/i.test(s)) return 'D';
  if (/^rep/i.test(s)) return 'R';
  if (/^ind/i.test(s)) return 'I';
  return s ? s.charAt(0).toUpperCase() : '';
}
function filterPeopleDirectory() {
  if (!PEOPLE_CACHE || !PEOPLE_CACHE.members) {
    loadPeopleDirectory();
    return;
  }
  renderPeopleDirectory(PEOPLE_CACHE.members);
}

/* ---- Directory People|Assets toggle ---- */
var DIRECTORY_MODE = 'people';
var DIR_SUB_PEOPLE = 'Look up members of Congress and executive filers.\\u00a0 Search by name, state (full or abbrev), or party.\\u00a0 Click a column heading to sort; click a name for their profile and trades.\\u00a0 Trade counts cover the full record, not the timeframe set on Trades or Trends.';
var DIR_SUB_ASSETS = 'Every ticker Congress has disclosed a trade in.\\u00a0 Search by ticker or company name.\\u00a0 Click a column heading to sort; click a row to open its profile.\\u00a0 Trade counts cover the full record, not the timeframe set on Trades or Trends.';
var directorySearchTimer = null;
function syncDirectoryUrl() {
  try {
    var u = new URL(window.location.href);
    var qEl = el('peopleQ');
    var q = qEl ? String(qEl.value || '').trim() : '';
    if (DIRECTORY_MODE && DIRECTORY_MODE !== 'people') u.searchParams.set('dmode', DIRECTORY_MODE);
    else u.searchParams.delete('dmode');
    if (q) u.searchParams.set('dq', q);
    else u.searchParams.delete('dq');
    window.history.replaceState({}, '', u.pathname + u.search + u.hash);
  } catch (e) {}
}
function setDirectoryMode(mode) {
  if (mode !== 'people' && mode !== 'assets') return;
  DIRECTORY_MODE = mode;
  var seg = el('dirMode');
  if (seg) {
    var btns = seg.querySelectorAll('button[data-mode]');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('on', btns[i].getAttribute('data-mode') === mode);
    }
  }
  var peopleWrap = el('peopleTableWrap');
  var assetsWrap = el('assetsTableWrap');
  var peopleCount = el('peopleCount');
  var assetsCount = el('assetsCount');
  var chamberSel = el('peopleChamber');
  var qEl = el('peopleQ');
  var subEl = el('dirSub');
  var isAssets = mode === 'assets';
  if (peopleWrap) peopleWrap.style.display = isAssets ? 'none' : '';
  if (assetsWrap) assetsWrap.style.display = isAssets ? '' : 'none';
  if (peopleCount) peopleCount.style.display = isAssets ? 'none' : '';
  if (assetsCount) assetsCount.style.display = isAssets ? '' : 'none';
  // Chamber filter only makes sense for People — hidden for Assets.
  if (chamberSel) chamberSel.style.display = isAssets ? 'none' : '';
  if (qEl) qEl.placeholder = isAssets ? 'Search ticker or company…' : 'Search name, state, party… any order';
  if (subEl) subEl.textContent = isAssets ? DIR_SUB_ASSETS : DIR_SUB_PEOPLE;
  syncDirectoryUrl();
  if (isAssets) loadAssetsDirectory();
  else filterPeopleDirectory();
}
function filterDirectory() {
  if (directorySearchTimer) clearTimeout(directorySearchTimer);
  directorySearchTimer = setTimeout(function () {
    if (DIRECTORY_MODE === 'assets') filterAssetsDirectory();
    else filterPeopleDirectory();
    syncDirectoryUrl();
  }, 150);
}
function refreshDirectory() {
  if (DIRECTORY_MODE === 'assets') loadAssetsDirectory();
  else loadPeopleDirectory();
}
/* Directory uses data-member; global handleEntityOpenEvent covers clicks. */

/* ---- Assets directory (GET /api/assets; ticker/company search + sort) ---- */
var ASSETS_CACHE = null;
var ASSETS_CACHE_AT = 0;
var ASSETS_TTL_MS = 5 * 60 * 1000;
var ASSETS_SORT = { key: 'trades', dir: -1 }; // default most-active first
function assetMatchesQuery(a, q) {
  var raw = String(q || '').trim().toLowerCase();
  if (!raw) return true;
  var tokens = raw.split(/\\s+/).filter(Boolean);
  var ticker = String(a.ticker || '').toLowerCase();
  var name = String(a.name || '').toLowerCase();
  return tokens.every(function (tok) { return ticker.indexOf(tok) >= 0 || name.indexOf(tok) >= 0; });
}
function loadAssetsDirectory() {
  var body = el('assetsBody');
  var countEl = el('assetsCount');
  if (!body) return Promise.resolve();
  body.innerHTML = stateRow(3, 'Loading directory…');
  if (countEl) countEl.textContent = '';
  var now = Date.now();
  var useCache = ASSETS_CACHE && (now - ASSETS_CACHE_AT) < ASSETS_TTL_MS;
  var fetchRoster = useCache
    ? Promise.resolve(ASSETS_CACHE)
    : fetch('/api/assets', { headers: { accept: 'application/json' } })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function (d) {
          ASSETS_CACHE = d;
          ASSETS_CACHE_AT = Date.now();
          return d;
        });
  return fetchRoster
    .then(function (d) { renderAssetsDirectory(d && d.assets ? d.assets : []); })
    .catch(function (e) {
      body.innerHTML = stateRow(3, 'Could not load directory: ' + e.message);
    });
}
function sortAssetsDirectory(key) {
  if (ASSETS_SORT.key === key) ASSETS_SORT.dir = -ASSETS_SORT.dir;
  else {
    ASSETS_SORT.key = key;
    ASSETS_SORT.dir = (key === 'trades' || key === 'members') ? -1 : 1;
  }
  if (ASSETS_CACHE && ASSETS_CACHE.assets) renderAssetsDirectory(ASSETS_CACHE.assets);
  else loadAssetsDirectory();
}
function assetsSortValue(a, key) {
  if (key === 'trades') return Number(a.txCount) || 0;
  if (key === 'members') return Number(a.memberCount) || 0;
  if (key === 'name') return String(a.name || a.ticker || '').toLowerCase();
  if (key === 'type') return String(a.assetClass || '').toLowerCase();
  return '';
}
function syncAssetsSortIndicators() {
  var head = el('assetsHead');
  if (!head) return;
  var ths = head.querySelectorAll('th[data-sort]');
  for (var i = 0; i < ths.length; i++) {
    var th = ths[i];
    th.classList.remove('sort-asc', 'sort-desc');
    if (th.getAttribute('data-sort') === ASSETS_SORT.key) {
      th.classList.add(ASSETS_SORT.dir > 0 ? 'sort-asc' : 'sort-desc');
      th.setAttribute('aria-sort', ASSETS_SORT.dir > 0 ? 'ascending' : 'descending');
    } else {
      th.setAttribute('aria-sort', 'none');
    }
  }
}
function renderAssetsDirectory(all) {
  var body = el('assetsBody');
  var countEl = el('assetsCount');
  if (!body) return;
  var qEl = el('peopleQ');
  var q = (DIRECTORY_MODE === 'assets' && qEl) ? String(qEl.value || '').trim() : '';
  var rows = (all || []).filter(function (a) { return assetMatchesQuery(a, q); });
  var sk = ASSETS_SORT.key;
  var sd = ASSETS_SORT.dir;
  rows.sort(function (x, y) {
    var xv = assetsSortValue(x, sk);
    var yv = assetsSortValue(y, sk);
    if (typeof xv === 'number' && typeof yv === 'number') return (xv - yv) * sd;
    if (xv < yv) return -1 * sd;
    if (xv > yv) return 1 * sd;
    return (Number(y.txCount) || 0) - (Number(x.txCount) || 0);
  });
  syncAssetsSortIndicators();
  if (!rows.length) {
    body.innerHTML = stateRow(3, q ? 'No assets match this filter.' : 'No assets in the directory yet.');
    if (countEl) countEl.textContent = '0 assets shown';
    return;
  }
  body.innerHTML = rows.map(function (a) {
    var nm = fmtCompany(a.name);
    var tkr = String(a.ticker || '').trim();
    // Funds/assets without a ticker: no logo; name starts where the ticker would be.
    var logo = tkr ? tickerLogoHtml(tkr, nm) : '';
    var labelHtml = tkr
      ? ('<span class="tkr">' + esc(tkr) + '</span>' + (nm ? '<span class="muted">' + esc(nm) + '</span>' : ''))
      : ('<span class="dir-asset-name">' + esc(nm || '—') + '</span>');
    var title = tkr ? (tkr + (nm ? '  |  ' + nm : '')) : (nm || 'Asset');
    var openAttr = tkr
      ? (' data-asset="' + esc(tkr) + '" title="Open ' + esc(tkr) + '"')
      : (' title="' + esc(title) + '"');
    var cellClass = tkr ? 'dir-asset-cell clickable' : 'dir-asset-cell';
    var dataAttr = tkr ? (' data-asset="' + esc(tkr) + '"') : '';
    // Real <a href> (SEOSOCIAL-02) only when there's an actual ticker to link
    // to — a fund/asset with no symbol has nowhere crawlable to point.
    var assetTag = tkr ? 'a' : 'div';
    var hrefAttr = tkr ? (' href="' + esc(entityHref('ticker', tkr)) + '"') : '';
    return '<tr class="row"' + openAttr + '>' +
      '<td class="col-fill"><' + assetTag + ' class="' + cellClass + '"' + hrefAttr + dataAttr + '>' + logo +
        '<div class="dir-asset-text cell-clip" title="' + esc(title) + '">' + labelHtml + '</div></' + assetTag + '></td>' +
      '<td class="col-num muted">' + (a.txCount != null ? fmtCount(a.txCount) : '—') + '</td>' +
      '<td class="col-num muted">' + (a.memberCount != null ? fmtCount(a.memberCount) : '—') + '</td></tr>';
  }).join('');
  // Same scope note as the People table: these are whole-record totals, not the
  // Trends/Trades time window.
  if (countEl) countEl.textContent = fmtCount(rows.length) + ' of ' + fmtCount((all || []).length) + ' assets\u00a0\u00a0\u2022\u00a0\u00a0trade counts are all time';
}
function filterAssetsDirectory() {
  if (!ASSETS_CACHE || !ASSETS_CACHE.assets) {
    loadAssetsDirectory();
    return;
  }
  renderAssetsDirectory(ASSETS_CACHE.assets);
}
/* Assets directory uses data-asset; global handleEntityOpenEvent covers clicks. */

/* ================= SPEED VS DATA PROVIDERS (provider scorecard) ================= */
/* Public aggregate scoreboard from GET /api/analytics/latency-summary.
   Deliberately NOT part of loadTrends(): the data is filter-independent and
   memoized to the server's ~5-minute cache.
   Honesty rules: lead/win uses live new imports only (no seed/historical
   backfills). Match gaps may be minutes or up to ~14 days either way.
   Provider-only rows stay in the denominator; no "Ahead" until coverage OK. */
var LATENCY = { data: null, at: 0, promise: null };
var SPEED_LANE_MIN_MATCHED = 2;   /* full scorecard stats (timed live races) */
var SPEED_BOAST_MIN_MATCHED = 5;  /* compact strip + pricing proof line */
var SPEED_MIN_COVERAGE_PCT = 80;

function fetchLatencySummary() {
  var now = Date.now();
  if (LATENCY.data && now - LATENCY.at < 5 * 60 * 1000) return Promise.resolve(LATENCY.data);
  if (LATENCY.promise) return LATENCY.promise;
  LATENCY.promise = fetch('/api/analytics/latency-summary')
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function (d) { LATENCY.data = d; LATENCY.at = Date.now(); LATENCY.promise = null; return d; })
    .catch(function (e) { LATENCY.promise = null; throw e; });
  return LATENCY.promise;
}
/* 5560 -> "1.5 hr", 82 -> "82 sec"; one unit, one decimal max. MAGNITUDE ONLY —
   direction belongs to fmtLeadSigned()/leadFigureHtml() so that every lead
   figure on the site uses the same earlier/later wording instead of +/−. */
function fmtLead(secs) {
  var s = Math.abs(Number(secs) || 0);
  function one(x) { var t = x.toFixed(1); return t.slice(-2) === '.0' ? t.slice(0, -2) : t; }
  if (s < 90) return Math.round(s) + ' sec';
  if (s < 5400) return Math.round(s / 60) + ' min';
  if (s < 172800) return one(s / 3600) + ' hr';
  return one(s / 86400) + ' days';
}
/* ---- Earlier / later: ONE convention for every latency figure on the page ----
   Positive seconds = Congress.Trade published FIRST (we were earlier).
     ahead  -> green,  ▲, "earlier"
     behind -> red,    ▼, "later"
     even   -> dim,    ↔, "even"
   Owner 2026-08-16: drop + and −.  Colour + wording only.  Later is red,
   earlier is green.  A negative medianLeadSec is later, not a green lead. */
function leadDirection(secs) {
  var n = Number(secs);
  if (!isFinite(n) || Math.round(n) === 0) return 'even';
  return n > 0 ? 'ahead' : 'behind';
}
function leadSignChar(dir) { return ''; }
function leadArrowChar(dir) { return dir === 'ahead' ? '\\u25b2' : dir === 'behind' ? '\\u25bc' : '\\u2194'; }
function leadWord(dir) { return dir === 'ahead' ? 'earlier' : dir === 'behind' ? 'later' : 'even'; }
/* Lead only when median AND average agree we were first; Lag only when both
   say we were later.  Mixed (or one missing) never claims a lead. */
function leadVerdict(medianSec, avgSec) {
  var med = leadDirection(medianSec);
  var avg = avgSec == null || avgSec === '' ? med : leadDirection(avgSec);
  if (med !== avg) return 'mixed';
  if (med === 'ahead') return 'lead';
  if (med === 'behind') return 'lag';
  return 'even';
}
function leadInlineHtml(dir) {
  return '<span class="lead-inline lead-' + dir + '">' + esc(leadWord(dir)) + '</span>';
}
/* Plain text with no markup: "24 min earlier" / "24 min later" / "even". */
function fmtLeadSigned(secs) {
  var dir = leadDirection(secs);
  if (dir === 'even') return 'even';
  return fmtLead(secs) + ' ' + leadWord(dir);
}
/* Spelled-out sentence used as the title/aria-label of every figure. */
function leadDescription(secs) {
  var dir = leadDirection(secs);
  if (dir === 'even') return 'Even \\u2014 no measurable difference either way.';
  return fmtLeadSigned(secs) + ' \\u2014 ' +
    (dir === 'ahead' ? 'Congress.Trade published first.' : 'the provider published first.');
}
/* Accessible lead figure. Colour is never the only channel: arrow + word.
   opts: { word: false } is ignored for the visible word — owner 2026-08-16
   wants wording on every figure, including table cells; { cls: 'lead-big' }
   promotes it to the card headline size. */
function leadFigureHtml(secs, opts) {
  var o = opts || {};
  var dir = leadDirection(secs);
  var desc = leadDescription(secs);
  return '<span class="lead-fig lead-' + dir + (o.cls ? ' ' + o.cls : '') +
    '" title="' + esc(desc) + '" aria-label="' + esc(desc) + '">' +
    '<span class="lead-arrow" aria-hidden="true">' + leadArrowChar(dir) + '</span>' +
    '<span class="lead-val">' + esc(fmtLead(secs)) + '</span>' +
    '<span class="lead-word">' + esc(leadWord(dir)) + '</span>' +
    '</span>';
}
/* Public lanes only: probe running and coverage join not known-broken. */
function isLatencyComparisonPublic(p) {
  if (!p) return false;
  if (p.publiclyShown === true) return true;
  if (p.publiclyShown === false) return false;
  if ((p.operationalStatus || 'unknown') !== 'running') return false;
  if (p.coverageIntegrity === 'contradiction') return false;
  return true;
}
/* Best-covered provider that boast copy may cite (well-sampled AND favorable). */
function speedBoastProvider(d) {
  var best = null;
  (d.providers || []).filter(function (p) {
    return isLatencyComparisonPublic(p) &&
      p.matched >= SPEED_LANE_MIN_MATCHED && p.comparisonStatus === 'usable' &&
      Number(p.ctCoveragePct) >= SPEED_MIN_COVERAGE_PCT && Number(p.providerCoveragePct) >= SPEED_MIN_COVERAGE_PCT;
  })
    .forEach(function (p) { if (!best || p.matched > best.matched) best = p; });
  return best && best.matched >= SPEED_BOAST_MIN_MATCHED && (best.medianLeadSec || 0) > 0 ? best : null;
}
/* Public placement gate for Filing Latency Comparison (owner 2026-08-17):
   the Delivery section and the Trends link render only when we are NOT
   behind on most adequately-covered providers. Each usable provider
   votes Lead or Lag only when median AND average agree (same rule as the
   card badge). Gathering / preliminary / limited-coverage providers
   neither qualify nor block. Hide when there is no usable vote, or when
   lag votes are a strict majority. Admin ignores this gate. */
function isLatencyAhead(summary) {
  if (!summary || !summary.providers) return false;
  var ahead = 0, behind = 0;
  (summary.providers || []).forEach(function (p) {
    if (!isLatencyComparisonPublic(p)) return;
    var wins = p.usFirstCount || 0, losses = p.providerFirstCount || 0, ties = p.tieCount || 0;
    var deltaSample = wins + losses + ties;
    var hasLead = p.avgLeadSec != null || p.medianLeadSec != null;
    var hasTiming = p.matched >= SPEED_LANE_MIN_MATCHED && deltaSample > 0 && hasLead;
    var adequate = hasTiming && p.comparisonStatus === 'usable';
    if (!adequate) return;
    var headline = p.medianLeadSec != null ? p.medianLeadSec : p.avgLeadSec;
    var verdict = leadVerdict(headline, p.avgLeadSec);
    if (verdict === 'lead') ahead += 1;
    else if (verdict === 'lag') behind += 1;
  });
  var voted = ahead + behind;
  return voted > 0 && behind <= ahead;
}
function speedUpdatedText() {
  var d = LATENCY.data; if (!d || !d.generatedAt) return '';
  var t = Date.parse(d.generatedAt); if (!isFinite(t)) return '';
  var mins = Math.max(0, Math.round((Date.now() - t) / 60000));
  var txt = 'LIVE updated ' + (mins < 1 ? 'just now' : mins + ' min ago');
  if (mins > 30) txt += ' · data may be stale';
  return txt;
}
function refreshSpeedUpdated() {
  if (!LATENCY.data) return;
  var txt = speedUpdatedText();
  ['speedUpdated', 'speedUpdatedAdmin'].forEach(function (id) {
    var n = el(id); if (n) n.textContent = txt;
  });
}
/* ---- "N of M matched" scope counts -------------------------------------
   Owner asked for the DENOMINATOR next to the matched count: "N of M matched",
   plus one plain-English line saying what M counts.

   CONTRACT with the latency-matching lane (app/src/ingestion/tradeLatency.ts).
   These fields do not exist on GET /api/analytics/latency-summary yet — the
   matcher lane is landing them — so the UI here is written against the names
   below and renders NOTHING until they arrive. It never substitutes a
   different denominator (maturedProviderObserved, candidates, …) to make the
   line appear: a wrong M is worse than no M.

     summary.totals.scopeMatched : number  -> N, disclosures matched on both sides
     summary.totals.scopeTotal   : number  -> M, disclosures from every filer in scope
     summary.totals.scopeLabel   : string? -> optional override of the plain-English note
     provider.scopeMatched / provider.scopeTotal : the same pair, per provider
                                            (rendered on that provider's card only)

   M's scope in words (the default note): every filer we track — all House and
   Senate members, the President and Vice President, and Cabinet secretaries
   and agency heads. */
var SPEED_SCOPE_NOTE_DEFAULT = 'That total covers every filer we track&nbsp; \\u2014&nbsp; all House and Senate members, the President and Vice President, and Cabinet secretaries and agency heads.&nbsp; "Matched" means we and the provider both saw the same disclosure.';
function spScopeCounts(src) {
  var o = src || {};
  if (o.scopeMatched == null || o.scopeTotal == null) return null;
  var matched = Number(o.scopeMatched), total = Number(o.scopeTotal);
  if (!isFinite(matched) || !isFinite(total) || total <= 0 || matched < 0) return null;
  return { matched: matched, total: total };
}
function spScopeCountHtml(c) {
  return '<strong>' + fmtCount(c.matched) + '</strong> of <strong>' + fmtCount(c.total) + '</strong> matched';
}
/* Per-card line — only when the PROVIDER carries its own scope pair. Falling
   back to the site-wide totals here would print the same "N of M" on every
   card as if each provider had earned it. */
function spScopeHtml(p) {
  var c = spScopeCounts(p);
  return c ? '<div class="sp-scope">' + spScopeCountHtml(c) + '</div>' : '';
}
/* Section-level line: the one shared scope statement under the card grid. */
function spScopeNoteHtml(totals) {
  var c = spScopeCounts(totals);
  if (!c) return '';
  var note = (totals && totals.scopeLabel) ? esc(String(totals.scopeLabel)) : SPEED_SCOPE_NOTE_DEFAULT;
  return spScopeCountHtml(c) + '.&nbsp; ' + note;
}
function spVisibilityBadgeHtml(p) {
  return isLatencyComparisonPublic(p)
    ? '<span class="sp-badge shown">Shown Publicly</span>'
    : '<span class="sp-badge hidden-public">Hidden From Public</span>';
}
/* Build a single provider scorecard card. admin=true adds Shown/Hidden chips. */
function spCardHtml(p, admin) {
  var vis = admin ? spVisibilityBadgeHtml(p) : '';
  /* Intentional OFF (grey) — FMP family default until operator enables probes. */
  if (p.operationalStatus === 'off') {
    return '<div class="sp-card sp-off">' +
      '<div class="sp-header"><span class="sp-name">' + esc(p.label) + '</span>' +
      '<span class="sp-header-end">' + vis + '<span class="sp-badge off">OFF</span></span></div>' +
      '<div class="sp-gathering">Intentionally disabled (no API spend). Enable with <code>FMP_LATENCY_PROBE_ENABLED=true</code>.</div>' +
      '</div>';
  }
  var wins = p.usFirstCount || 0, losses = p.providerFirstCount || 0, ties = p.tieCount || 0;
  /* Real timing sample: matched races AND non-null average lead (empty W/L/T is not a tie). */
  var deltaSample = wins + losses + ties;
  var hasLead = p.avgLeadSec != null || p.medianLeadSec != null;
  var hasTiming = p.matched >= SPEED_LANE_MIN_MATCHED && deltaSample > 0 && hasLead;
  var usable = p.comparisonStatus === 'usable';
  var preliminary = p.comparisonStatus === 'preliminary';
  /* Show timing for usable OR preliminary only when a real delta sample exists. */
  var hasStats = hasTiming && (usable || preliminary);
  /* Colour and badge follow the MEDIAN sign (earlier/later), not win-count.
     Win-count green + a later average is what made a negative delta look good. */
  var headlineSec = hasLead ? (p.medianLeadSec != null ? p.medianLeadSec : p.avgLeadSec) : null;
  var headlineDir = leadDirection(headlineSec);
  var verdict = hasStats ? leadVerdict(headlineSec, p.avgLeadSec) : null;
  var ahead = verdict === 'lead';
  var tied = verdict === 'even';
  var cardCls = 'sp-card' + (hasStats ? (ahead ? ' sp-ahead' : (verdict === 'lag' ? ' sp-behind' : ' sp-tied')) : '');

  /* Header: provider name + outcome badge.
     Owner 2026-08-16: Lead or Lag only when median AND average agree.
     Never "preliminary lead" when one of them is behind. */
  var badgeCls, badgeTxt;
  if (!hasStats && !hasTiming) {
    badgeCls = 'sp-badge gathering'; badgeTxt = 'Gathering data';
  } else if (!hasStats && !usable) {
    badgeCls = 'sp-badge gathering'; badgeTxt = p.comparisonStatus === 'limited' ? 'Coverage limited' : 'Insufficient coverage';
  } else if (verdict === 'lead') {
    badgeCls = 'sp-badge ahead'; badgeTxt = 'Lead';
  } else if (verdict === 'lag') {
    badgeCls = 'sp-badge behind'; badgeTxt = 'Lag';
  } else if (verdict === 'even') {
    badgeCls = 'sp-badge tied'; badgeTxt = 'Even';
  } else if (hasStats) {
    badgeCls = 'sp-badge gathering'; badgeTxt = 'Mixed';
  } else {
    badgeCls = 'sp-badge gathering'; badgeTxt = 'Gathering data';
  }
  var header = '<div class="sp-header"><span class="sp-name">' + esc(p.label) + '</span>' +
    '<span class="sp-header-end">' + vis + '<span class="' + badgeCls + '">' + badgeTxt + '</span></span></div>';

  /* Win-rate bar */
  var barHtml = '';
  if (hasStats && p.matched > 0) {
    var winPct = Math.round(100 * wins / p.matched);
    var fillCls = ahead ? 'sp-bar-fill' : tied ? 'sp-bar-fill tied' : 'sp-bar-fill behind';
    barHtml = '<div class="sp-bar-wrap">' +
      '<div class="sp-bar-labels"><span>Win rate</span><span>' + winPct + '%  (' + fmtCount(wins) + '/' + fmtCount(p.matched) + ')</span></div>' +
      '<div class="sp-bar-track"><div class="' + fillCls + '" style="width:' + winPct + '%"></div></div>' +
      '</div>';
  }

  /* Lead stat — prefer average (matches human mean lead/lag), show median secondary. */
  var leadHtml = '';
  if (!hasTiming) {
    var need = Math.max(0, SPEED_LANE_MIN_MATCHED - (p.matched || 0));
    leadHtml = '<div class="sp-gathering">' +
      (p.matched > 0 && !hasLead
        ? "We've matched <strong>" + p.matched + "</strong> live races but have no usable first-seen timestamps yet for lead/lag."
        : p.matched > 0
          ? "We've timed <strong>" + p.matched + "</strong> live matched races so far — " + need + " more needed for timing estimates."
          : "Probes haven't matched live new imports yet (seed/historical backfills are excluded). Sample builds as filings land.") +
      (p.unmatchedProvider > 0 ? " <strong>" + p.unmatchedProvider + "</strong> provider-observed rows are not matched to our feed yet." : '') +
      '</div>';
  } else if (!hasStats && !usable) {
    leadHtml = '<div class="sp-gathering">' +
      "We've timed <strong>" + p.matched + "</strong> live matched races, but coverage is too limited for a reliable speed claim. " +
      (p.unmatchedProvider > 0 ? "<strong>" + p.unmatchedProvider + "</strong> provider-observed rows remain unmatched." : '') +
      '</div>';
  } else {
    /* HEADLINE = MEDIAN, not the mean. At these sample sizes (n is single
       digits per provider) one freak race flips the mean's SIGN while the
       median doesn't move: Unusual Whales on 2026-08-11 read avg -34 sec
       against a median of +1,466 sec, because a single -3.1 h row outweighed
       seven 24 min-earlier ones. The mean then contradicted this same card's
       own earlier/later badge. The median agrees with the badge, survives an
       outlier, and is the figure
       speedBoastProvider()/setPricingProof() already quote — so it is the one
       that gets to be the big number. The mean is still shown, just demoted. */
    var headline = headlineSec != null ? headlineSec : (p.avgLeadSec || 0);
    var avgTxt = p.avgLeadSec != null && p.avgLeadSec !== p.medianLeadSec
      ? '<div class="sp-lead-sub">Average: ' + leadFigureHtml(p.avgLeadSec) + '</div>'
      : (p.avgLeadSec != null && p.medianLeadSec == null
        ? ''
        : '');
    /* Always show the average when it exists and is not the same number as the
       median.  The split note below fires only when they disagree on direction. */
    var p90Txt = p.p90LeadSec != null ? '<div class="sp-lead-sub">P90: ' + leadFigureHtml(p.p90LeadSec) + '</div>' : '';
    /* Say it out loud when the mean and the median disagree on WHO WON, rather
       than leaving a reader to spot two opposite words two lines apart. */
    var splitTxt = (p.avgLeadSec != null && p.medianLeadSec != null &&
      leadDirection(p.avgLeadSec) !== headlineDir && leadDirection(p.avgLeadSec) !== 'even' && headlineDir !== 'even')
      ? '<div class="sp-lead-sub">The average disagrees with the median here \\u2014 a few outlier races pull it the other way, so the median is the fair summary.</div>'
      : '';
    var dirWord = leadInlineHtml(headlineDir);
    var basisNote = headlineDir === 'even'
      ? 'no measurable typical difference vs. their feed on live imports'
      : 'typically ' + dirWord + ' than their feed on live imports (median)';
    var labelNote = (preliminary && verdict === 'mixed')
      ? basisNote + ' (coverage still building)'
      : basisNote;
    leadHtml = '<div class="sp-lead">' +
      leadFigureHtml(headline, { cls: 'lead-big' }) +
      '<div class="sp-lead-label">' + labelNote + avgTxt + p90Txt + splitTxt + '</div>' +
      '</div>';
  }

  /* W / L / T stat row */
  var wlt = '';
  if (hasStats) {
    wlt = '<div class="sp-wlt">' +
      '<div class="sp-wlt-item"><span class="sp-wlt-val w">' + fmtCount(wins) + '</span><span class="sp-wlt-key">Wins</span></div>' +
      '<div class="sp-wlt-item"><span class="sp-wlt-val l">' + fmtCount(losses) + '</span><span class="sp-wlt-key">Losses</span></div>' +
      '<div class="sp-wlt-item"><span class="sp-wlt-val t">' + fmtCount(ties) + '</span><span class="sp-wlt-key">Ties</span></div>' +
      '</div>';
  } else if (p.matched > 0 || p.strongMatched > 0 || p.providerObserved > 0) {
    wlt = '<div class="sp-sample">n = ' + fmtCount(p.matched) + ' live matched · ' +
      fmtCount(p.maturedProviderObserved || 0) + ' provider rows · ' + fmtCount(p.unmatchedProvider || 0) + ' unmatched</div>';
  }

  return '<div class="' + cardCls + '">' + header + spScopeHtml(p) + barHtml + leadHtml + wlt + '</div>';
}
/* Raw data table rows shared by both placements (inside their <details>). */
function speedTableRowsHtml(provs, admin) {
  return provs.map(function (p) {
    function td(v) { return '<td>' + v + '</td>'; }
    var strong = p.strongMatched != null ? p.strongMatched : p.matched;
    var publicCell = admin ? td(isLatencyComparisonPublic(p) ? 'Shown' : 'Hidden') : '';
    return '<tr>' + td(esc(p.label)) + publicCell + td(fmtCount(p.matched) + ' / ' + fmtCount(strong) + ' / ' + fmtCount(p.candidates)) +
      td(fmtCount(p.maturedMatched || 0) + ' / ' + fmtCount(p.maturedProviderObserved || 0)) +
      td((p.ctCoveragePct == null ? '—' : p.ctCoveragePct + '%') + ' / ' + (p.providerCoveragePct == null ? '—' : p.providerCoveragePct + '%')) +
      td(fmtCount(p.unmatchedProvider || 0)) + td(p.comparisonStatus || 'insufficient') +
      td(fmtCount(p.usFirstCount || 0)) + td(fmtCount(p.providerFirstCount || 0)) + td(fmtCount(p.tieCount || 0)) +
      /* Signed + arrowed like every other lead figure; the word is dropped here
         only because the cells are narrow — the title/aria-label still says it. */
      td(p.medianLeadSec != null ? leadFigureHtml(p.medianLeadSec, { word: false }) : '—') +
      td(p.avgLeadSec != null ? leadFigureHtml(p.avgLeadSec, { word: false }) : '—') +
      td(p.p90LeadSec != null ? leadFigureHtml(p.p90LeadSec, { word: false }) : '—') + '</tr>';
  }).join('');
}
function priceEdgeHtml(edge) {
  if (!edge || !edge.length) return '';
  var bits = [];
  for (var i = 0; i < edge.length; i++) {
    var b = edge[i];
    if (!b || !b.n || b.medianBps == null) continue;
    var label = b.event === 'provider_plus_5m' ? '5 min' : b.event === 'provider_plus_15m' ? '15 min' : b.event === 'provider_plus_30m' ? '30 min' : '60 min';
    var dir = b.medianBps > 0 ? 'up' : (b.medianBps < 0 ? 'down' : 'flat');
    bits.push(label + ' ' + dir + ' ' + Math.abs(Number(b.medianBps)).toFixed(1) + ' bps (n=' + b.n + ')');
  }
  if (!bits.length) return '';
  return '<div class="sp-price-edge">Median move after they publish: ' + bits.join(' · ') + '.</div>';
}
function speedScopeFromSummary(d) {
  var t = (d && d.totals) || {};
  var s = (d && d.scope) || {};
  return {
    scopeMatched: t.scopeMatched != null ? t.scopeMatched : s.matched,
    scopeTotal: t.scopeTotal != null ? t.scopeTotal : s.total,
    scopeLabel: t.scopeLabel || s.label || null,
  };
}
function paintSpeedSection(gridId, tableBodyId, noteId, provs, totals, priceEdge, admin) {
  var grid = el(gridId);
  if (grid) grid.innerHTML = provs.map(function (p) { return spCardHtml(p, admin); }).join('');
  var tb = el(tableBodyId);
  if (tb) tb.innerHTML = speedTableRowsHtml(provs, admin);
  var note = el(noteId);
  if (note) {
    var html = (spScopeNoteHtml(totals) || '') + priceEdgeHtml(priceEdge);
    note.innerHTML = html;
    note.hidden = !html;
  }
}
/* Filing Latency Comparison placement (owner 2026-08-17): paints BOTH
   copies from a single fetch —
     - Delivery (#trLatencySection, bottom of the tab): only when
       isLatencyAhead() says we are not behind on most providers.
     - Trends (#trLatencyLink): same gate; a link to the Delivery section.
     - Admin (#adminLatencySection, top of the tab): always the full
       comparison (incl. BEHIND) whenever there's any raced data.
   Never rendered on the Trades tab. */
function renderSpeedProof() {
  var publicBox = el('trLatencySection');
  var publicLink = el('trLatencyLink');
  var adminBox = el('adminLatencySection');
  if (!publicBox && !adminBox && !publicLink) return;
  fetchLatencySummary().then(function (d) {
    function byMatched(a, b) { return b.matched - a.matched; }
    var adminProvs = (d.adminProviders && d.adminProviders.length ? d.adminProviders : (d.providers || [])).slice().sort(byMatched);
    var publicProvs = (d.providers || []).filter(isLatencyComparisonPublic).slice().sort(byMatched);
    var hasAdminData = !!(d.totals && d.totals.racedDisclosures && adminProvs.length);
    var hasPublicData = !!(d.totals && d.totals.racedDisclosures && publicProvs.length);

    if (adminBox) {
      adminBox.hidden = !hasAdminData;
      if (hasAdminData) paintSpeedSection('spGridAdmin', 'speedTableBodyAdmin', 'spScopeNoteAdmin', adminProvs, speedScopeFromSummary(d), d.priceEdge, true);
    }
    var ahead = hasPublicData && isLatencyAhead({ providers: publicProvs });
    if (publicBox) {
      publicBox.hidden = !ahead;
      if (ahead) paintSpeedSection('spGrid', 'speedTableBody', 'spScopeNote', publicProvs, speedScopeFromSummary(d), d.priceEdge, false);
    }
    if (publicLink) publicLink.hidden = !ahead;

    refreshSpeedUpdated();
    renderAlertsMini();
  }).catch(function () {
    if (publicBox) publicBox.hidden = true;
    if (publicLink) publicLink.hidden = true;
    if (adminBox) adminBox.hidden = true;
  });
}
/* Compact strip on the Alerts tab; renders only when clearly favorable —
   a one-liner has no room for honest hedging, so below threshold it stays silent. */
function renderAlertsMini() {
  var box = el('alertsSpeedMini'); if (!box) return;
  var d = LATENCY.data;
  var best = d && isLatencyAhead(d) ? speedBoastProvider(d) : null;
  if (!best) { box.className = 'speed-mini'; box.innerHTML = ''; return; }
  box.className = 'speed-mini show';
  box.innerHTML = '<span>⚡ Ahead of ' + esc(best.label) + ' on <span class="lead">' + fmtCount(best.usFirstCount) + ' of ' + fmtCount(best.matched) +
    '</span> matched filings · typical lead ' + leadFigureHtml(best.medianLeadSec, { word: false }) + '</span>' +
    '<button class="btn ghost sm" onclick="openSpeedProof()">See the scoreboard →</button>';
}
function openSpeedProof() {
  showView('subs', 'trLatencySection');
}
/* The one place a lead deliberately renders UNSIGNED: this is a prose sentence
   whose own words carry the direction ("land here … BEFORE <provider>"), and a
   "+" wedged mid-sentence would read as a typo rather than as a sign. It is
   also only ever reached via speedBoastProvider(), which requires a positive
   median, so an unsigned magnitude here can never hide a loss. */
function setPricingProof() {
  var n = el('pricingProof'); if (!n) return;
  var best = LATENCY.data ? speedBoastProvider(LATENCY.data) : null;
  n.textContent = best
    ? 'Right now: filings land here a median ' + fmtLead(best.medianLeadSec) + ' before ' + best.label +
      ' — measured live over the last ' + fmtCount(best.matched) + ' live matched races.'
    : '';
}

/* Stat-line separator: three spaces each side of the bullet (owner
   2026-09-08: "an extra space on either side of every •").  Exactly ONE of
   them, the regular space just before the bullet, is a line-break
   opportunity; the rest are NBSPs.  So wherever a stat line has to wrap
   (narrow table cells) it breaks BEFORE a bullet and the
   continuation line starts "•   stat" — never a bullet stranded at the end
   of the previous line.  The " / " inside a buys/sells pair keeps its two
   NBSPs, so the pair reads tighter than the gaps between stats. */
var SEP_DOT = '\\u00a0\\u00a0 •\\u00a0\\u00a0\\u00a0';
/* "total volume ~$X" for the top-right of a flow row (items are HTML). */
function totalVolumeHtml(n) { return '<span class="fval-k">total volume</span> ' + estUsd(n); }
/* Stats line under a flow bar: each stat is its own flex item and the free
   width is shared between them (see .flowrow .fchip).  No separators — owner
   2026-09-08: the spacing alone separates the items.  Items are HTML; the
   single space between spans is ignored by the flex container. */
function flowChipHtml(items) {
  return '<div class="fchip">' + items.map(function (h) { return '<span class="fstat">' + h + '</span>'; }).join(' ') + '</div>';
}
/* Volume bar + buy/sell/breadth/net chip — shared by the sector & cap views. */
function flowRowHtml(label, r, maxVol, title) {
  var w = Math.round(100 * Number(r.estVolumeUsd || 0) / (maxVol || 1));
  return '<div class="flowrow">' +
    '<div class="ftop"><span class="flabel" title="' + esc(title || label) + '">' + esc(label) + '</span>' +
      '<span class="fval">' + totalVolumeHtml(r.estVolumeUsd) + '</span></div>' +
    '<div class="htrack"><div class="hfill" style="width:' + w + '%"></div></div>' +
    flowChipHtml([esc(buySellText(r.buyCount, r.sellCount)), esc(polFull(r.uniqueMembers)), esc(assetFull(r.uniqueTickers)),
      'net volume ' + netHtml(r.estNetFlowUsd)]) + '</div>';
}

/* Some sector strings vary by provider/vintage for the same real GICS sector
   (e.g. FMP's "Healthcare" vs. an older SEC-EDGAR-derived "Health Care").
   Canonicalize at this display layer so they merge into one bar instead of
   showing as two separate, smaller "sectors". */
var SECTOR_CANON = { 'Health Care': 'Healthcare' };
function canonSector(s) { return SECTOR_CANON[s] || s; }
function loadTrSectorFlow() {
  var box = el('trSectorFlow');
  box.innerHTML = skBars(5);
  aGet('sector-flow?' + trParams() + '&limit=12').then(function (d) {
    var rows = (d.sectors || []).filter(function (r) { return r.sector && r.sector !== 'Unknown'; });
    if (!rows.length) { box.innerHTML = '<div class="note">No sector-classified trades in this window yet (security reference data fills in as enrichment runs).</div>'; return; }
    var merged = {}, order = [];
    rows.forEach(function (r) {
      var key = canonSector(r.sector);
      if (!merged[key]) {
        merged[key] = { sector: key, estVolumeUsd: 0, estNetFlowUsd: 0, buyCount: 0, sellCount: 0, uniqueMembers: 0, uniqueTickers: 0 };
        order.push(key);
      }
      var m = merged[key];
      m.estVolumeUsd += Number(r.estVolumeUsd || 0);
      m.estNetFlowUsd += Number(r.estNetFlowUsd || 0);
      m.buyCount += Number(r.buyCount || 0);
      m.sellCount += Number(r.sellCount || 0);
      // uniqueMembers/uniqueTickers are already deduped counts from the API;
      // take the max across merged aliases as a conservative (not double-
      // counted) estimate rather than summing possibly-overlapping sets.
      m.uniqueMembers = Math.max(m.uniqueMembers, Number(r.uniqueMembers || 0));
      m.uniqueTickers = Math.max(m.uniqueTickers, Number(r.uniqueTickers || 0));
    });
    rows = order.map(function (k) { return merged[k]; });
    // Web title is By Sector (the large figure is total volume, not net).
    // rank by signed net (biggest buy first, biggest sell last).
    // Market-cap next door keeps CAP_ORDER.
    rows.sort(function (a, b) { return Number(b.estNetFlowUsd || 0) - Number(a.estNetFlowUsd || 0); });
    var max = 1; rows.forEach(function (r) { max = Math.max(max, r.estVolumeUsd); });
    box.innerHTML = rows.map(function (r) { return flowRowHtml(r.sector, r, max); }).join('');
  }).catch(function (e) { box.innerHTML = '<div class="note">Could not load: ' + esc(e.message) + '</div>'; });
}

var CAP_NAMES = { mega: 'Mega Cap', large: 'Large Cap', mid: 'Mid Cap', small: 'Small Cap', micro: 'Micro Cap', nano: 'Nano Cap', unknown: 'Unclassified' };
var CAP_ORDER = ['mega', 'large', 'mid', 'small', 'micro', 'nano', 'unknown'];
function loadTrCapFlow() {
  var box = el('trCapFlow');
  box.innerHTML = skBars(5);
  aGet('market-cap-breakdown?' + trParams()).then(function (d) {
    var rows = (d.buckets || []).filter(function (r) { return (r.buyCount + r.sellCount) > 0; });
    if (!rows.length) { box.innerHTML = '<div class="note">No market-cap-classified trades in this window yet.</div>'; return; }
    rows.sort(function (a, b) { return CAP_ORDER.indexOf(a.bucket) - CAP_ORDER.indexOf(b.bucket); });
    var max = 1; rows.forEach(function (r) { max = Math.max(max, r.estVolumeUsd); });
    box.innerHTML = rows.map(function (r) { return flowRowHtml(CAP_NAMES[r.bucket] || r.bucket, r, max); }).join('');
  }).catch(function (e) { box.innerHTML = '<div class="note">Could not load: ' + esc(e.message) + '</div>'; });
}

/* Signed percent: 0.0532 -> +5.3%, -0.12 -> -12.0%. */
function pctSigned(n) {
  if (n == null || isNaN(n)) return '—';
  var v = Number(n) * 100, cls = v > 0 ? 'pos' : v < 0 ? 'neg' : '';
  return '<span class="net ' + cls + '">' + (v > 0 ? '+' : '') + v.toFixed(1) + '%</span>';
}
/* "Aug 3, 2026" from an ISO YYYY-MM-DD date, without a timezone round-trip. */
function fmtAsOf(iso) {
  var m = /^(\\d{4})-(\\d{2})-(\\d{2})/.exec(String(iso || ''));
  if (!m) return '';
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return MONTHS[Number(m[2]) - 1] + ' ' + Number(m[3]) + ', ' + m[1];
}
function loadTrPerformers() {
  var body = el('trPerformers');
  body.innerHTML = skRows(2, 6);
  aGet('member-performance?' + trParams() + '&limit=15').then(function (d) {
    var asOf = el('trPerformersAsOf');
    if (asOf) asOf.textContent = d && d.pricesAsOf ? 'Prices as of ' + fmtAsOf(d.pricesAsOf) + '.  Excess return is measured to that date.' : '';
    var rows = d.members || [];
    if (!rows.length) { body.innerHTML = stateRow(2, 'Not enough priced, filing-anchored buys to rank yet — this fills in as the price cache backfills.'); return; }
    body.innerHTML = rows.map(function (r, i) {
      var name = fmtName(r.fullName || r.filerId || 'Unknown');
      var memberAttr = r.filerId ? ' class="member-cell clickable" data-member="' + esc(r.filerId) + '"' : ' class="member-cell"';
      var statLine = '<span class="nb">' + fmtCount(r.tradeCount) + ' buys</span>' + SEP_DOT +
        '<span class="nb">' + Math.round(100 * (r.winRate || 0)) + '% win</span>';
      return '<tr class="row">' +
        '<td><div' + memberAttr + '>' + memberAvatarHtml(name, r.photoUrl, r.partyBucket, true) +
          '<div class="member-meta"><span class="name-line">' + pdot(r.partyBucket) + esc(name) + '</span>' +
          '<div class="stack-under"><span>' + statLine + '</span></div>' +
          '</div></div></td>' +
        '<td title="Average excess return since the filing date; 0% matched the benchmark, +3% beat it by 3%.">' + pctSigned(r.avgExcessReturn) + '</td></tr>';
    }).join('');
  }).catch(function (e) { body.innerHTML = stateRow(2, 'Could not load: ' + e.message); });
}

function loadTrSummary() {
  var box = el('trKpis');
  if (!box) return;
  box.innerHTML = skCards(6);
  Promise.all([
    aGet('summary?' + trParams()),
    aGet('volume-over-time?' + trParams()) // Using trParams() so it matches the global window length
  ]).then(function (res) {
    var d = res[0];
    var s = res[1].series || [];
    var sent = d.netSentiment == null ? '—' : '<span class="bp"><span class="bp-n">' + Math.round(d.netSentiment * 100) + '</span><span class="bp-pct">%</span><span class="bp-w">buys</span></span>';
    var sparkNetFlow = sparklineHtml(s, 'netflow');
    var sparkBuyPressure = sparklineHtml(s, 'buypressure');
    box.innerHTML =
      kpi('Trades', d.totalTrades, TRENDS_TRADES_TIP) + kpi('Politicians', d.uniqueMembers) + kpi('Assets', d.uniqueTickers) +
	      kpiInfo('Approx. Volume', estUsd(d.estimatedVolumeUsd), EST_VOLUME_TIP, null, optionFootnote(d.optionCount)) + 
      kpiInfo('Net Flow', netHtml(d.estimatedNetFlowUsd), NET_FLOW_TIP, "scrollToChart('trTime')", sparkNetFlow) +
      kpiInfo('Buy Pressure', sent, BUY_PRESSURE_TIP, "scrollToChart('trTime')", sparkBuyPressure);
  }).catch(function (e) { box.innerHTML = kpi('Summary', '<span style="font-size:13px">' + esc(e.message) + '</span>'); });
}

function loadTrTickers() {
  var body = el('trTickers');
  body.innerHTML = skRows(5, 6);
  var sortVal = trTickerSortVal || 'trades';
  var queryParams = trParams() + '&sort=' + sortVal + '&limit=15';

  // Update header sort icons + aria-sort together (WEBA11Y P2: this table
  // never exposed aria-sort before — only the visual .sort-icon updated —
  // so a screen-reader user got no indication which column, or direction,
  // the leaderboard was sorted by).  Always descending: there is no asc/desc
  // toggle for this table, only a choice of metric.
  var icons = document.querySelectorAll('#tableTrTickers .sort-icon');
  for (var i = 0; i < icons.length; i++) {
    icons[i].innerHTML = icons[i].getAttribute('data-sort') === sortVal ? ' ▼' : '';
  }
  var sortThs = document.querySelectorAll('#tableTrTickers th[data-sort]');
  for (var j = 0; j < sortThs.length; j++) {
    sortThs[j].setAttribute('aria-sort', sortThs[j].getAttribute('data-sort') === sortVal ? 'descending' : 'none');
  }

  aGet('ticker-leaderboard?' + queryParams).then(function (d) {
    var rows = d.tickers || [];
    if (!rows.length) { body.innerHTML = stateRow(5, 'No trades in this window.'); return; }
    body.innerHTML = rows.map(function (r) {
      return '<tr class="row clickable" data-asset="' + esc(r.ticker) + '" title="Open company">' +
        '<td><div class="asset-cell clickable" data-asset="' + esc(r.ticker) + '">' + tickerLogoHtml(r.ticker, fmtCompany(r.name)) + '<div><span class="tkr">' +
          esc(r.ticker) + '</span>' + (r.name ? ' <span class="muted">' + esc(fmtCompany(r.name)) + '</span>' : '') + '</div></div></td>' +
        '<td>' + splitBar(r.buyCount, r.sellCount) + '</td>' +
        '<td class="muted">' + fmtCount(r.memberCount || 0) + '</td>' +
        '<td class="est">' + estUsd(r.estVolumeUsd) + '</td>' +
        '<td>' + netHtml(r.estNetFlowUsd) + '</td></tr>';
    }).join('');
  }).catch(function (e) { body.innerHTML = stateRow(5, 'Could not load: ' + e.message); });
}

function loadTrTrending() {
  syncRisingActivityVisibility();
  if (getTrWindow() === 'all') {
    var empty = el('trTrending');
    if (empty) empty.innerHTML = '';
    return;
  }
  var body = el('trTrending');
  body.innerHTML = skRows(4, 6);
  var queryParams = trParams() + '&limit=12';
  aGet('trending?' + queryParams).then(function (d) {
    var rows = (d.trending || []).filter(function (r) { return r.deltaCount > 0; });
    if (!rows.length) { body.innerHTML = stateRow(4, 'Not enough history to rank momentum.'); return; }
    body.innerHTML = rows.map(function (r) {
      return '<tr class="row clickable" data-asset="' + esc(r.ticker) + '" title="Open company">' +
        '<td><div class="asset-cell clickable" data-asset="' + esc(r.ticker) + '">' + tickerLogoHtml(r.ticker, fmtCompany(r.name)) + '<div><span class="tkr">' + esc(r.ticker) + '</span>' + (r.name ? ' <span class="muted">' + esc(fmtCompany(r.name)) + '</span>' : '') + '</div></div></td>' +
        '<td class="muted">' + fmtCount(r.priorCount) + ' → ' + fmtCount(r.recentCount) + '</td>' +
        '<td class="net pos">▲ ' + fmtCount(r.deltaCount) + '</td>' +
        '<td class="muted">' + fmtCount(r.recentMembers || 0) + '</td></tr>';
    }).join('');
  }).catch(function (e) { body.innerHTML = stateRow(4, 'Could not load: ' + e.message); });
}

function loadTrClusters() {
  var box = el('trClusters');
  box.innerHTML = '<div class="chip">Loading…</div>';
  aGet('cluster-buys?' + trParams() + '&limit=12&minMembers=2').then(function (d) {
    var cs = d.clusters || [];
    if (!cs.length) { box.innerHTML = '<div class="chip">No multi-politician consensus in this window — try a longer window or “All Data”.</div>'; return; }
    box.innerHTML = cs.map(function (c) {
      var faces = (c.topMembers || []).slice(0, 5).map(function (m) {
        var av = memberAvatarHtml(m.fullName, m.photoUrl, m.partyBucket || m.party);
        if (!m.filerId) return av;
        return '<span class="clickable face-member" data-member="' + esc(m.filerId) +
          '" title="Open ' + esc(fmtName(m.fullName || m.filerId)) + '">' + av + '</span>';
      }).join('');
      var dir = c.txType === 'B' || c.txType === 'P' ? 'BOUGHT' : 'SOLD';
      var parties = partyCountHtml(c.parties.D, 'Democrat', 'Dem') + ', ' + partyCountHtml(c.parties.R, 'Republican', 'Rep') + (c.parties.O ? ', ' + pluralCount(c.parties.O, 'Other') : '');
      var bip = c.isBipartisan ? ' <span class="muted">· bipartisan</span>' : '';
      // minDate can be absent on malformed/partial rows; drop the leading
      // "— · " fragment rather than rendering a dangling dash next to the $ estimate.
      var range = c.minDate ? (compactDateText(c.minDate) + (c.minDate === c.maxDate ? '' : ' → ' + compactDateText(c.maxDate))) : '';
      return '<div class="ccard clickable" tabindex="0" role="button" aria-label="View company ' + esc(c.ticker) + '" data-asset="' + esc(c.ticker) + '">' +
        '<div class="chead">' + tickerLogoHtml(c.ticker, fmtCompany(c.name)) + '<span class="big">' + esc(c.ticker) +
          '</span><span class="dirpill ' + esc(c.txType) + '">' + dir + '</span></div>' +
        '<div><strong>' + fmtCount(c.memberCount) + '</strong> politician' + (c.memberCount === 1 ? '' : 's') + ' · ' + fmtCount(c.tradeCount) + ' trades' + bip + '</div>' +
        '<div class="muted" style="margin-top:2px">' + parties + '</div>' +
        '<div class="muted" style="margin-top:2px">' + (range ? esc(range) + ' · ' : '') + estUsd(c.estVolumeUsd) + '</div>' +
        '<div class="faces">' + faces + '</div></div>';
    }).join('');
  }).catch(function (e) { box.innerHTML = '<div class="chip">Could not load: ' + esc(e.message) + '</div>'; });
}

var trTimeMetric = 'count';
function setTrTimeMetric(m) {
  trTimeMetric = (m === 'dollars') ? 'dollars' : 'count';
  var group = el('trTimeMetric');
  if (group) {
    var btns = group.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) btns[i].className = (btns[i].getAttribute('data-m') === trTimeMetric) ? 'on' : '';
  }
  loadTrTime();
}
/* If the series overflows, pin the scroll to the right so the MOST RECENT dates
   show first; the oldest sit off-screen left until the user scrolls. */
function anchorChartRight(box) {
  var tc = box.querySelector('.tchart');
  if (tc && tc.scrollWidth > tc.clientWidth) tc.scrollLeft = tc.scrollWidth;
}
function loadTrTime() {
  var box = el('trTime');
  box.innerHTML = skChart();
  aGet('volume-over-time?' + trParams()).then(function (d) {
    var s = d.series || [];
    if (!s.length) { box.innerHTML = '<div class="note">No dated trades in this range.</div>'; return; }
    box.innerHTML = timeChartHtml(s, null, trTimeMetric);
    anchorChartRight(box);
  }).catch(function (e) { box.innerHTML = '<div class="note">Could not load: ' + esc(e.message) + '</div>'; });
}

function loadTrMembers() {
  var body = el('trMembers');
  body.innerHTML = skRows(2, 6);
  aGet('member-leaderboard?' + trParams() + '&limit=15').then(function (d) {
    var rows = d.members || [];
    if (!rows.length) { body.innerHTML = stateRow(2, 'No politician activity in this window.'); return; }
    body.innerHTML = rows.map(function (r, i) {
      var name = fmtName(r.fullName || r.filerId || 'Unknown');
      // Executive filers: position only — no "Exec" prefix, and no state or
      // district, which they do not hold (EXEC-MCCORMICK does carry a state).
      var metaBits = memberBranchBits(r, EXEC_TITLE_FULL).join(' · ');
      var memberAttr = r.filerId ? ' class="member-cell clickable" data-member="' + esc(r.filerId) + '"' : ' class="member-cell"';
      var statLine = '<span class="nb">' + fmtCount(r.tradeCount) + ' trades</span>' + SEP_DOT +
        '<span class="nb">' + fmtCount(r.buyCount || 0) + ' buys\\u00a0\\u00a0/\\u00a0\\u00a0' + fmtCount(r.sellCount || 0) + ' sells</span>';
      return '<tr class="row">' +
        '<td><div' + memberAttr + '>' + memberAvatarHtml(name, r.photoUrl, r.partyBucket, true) +
          '<div class="member-meta"><span class="name-line">' + pdot(r.partyBucket) +
          esc(name) + (metaBits ? ' <span class="muted">· ' + esc(metaBits) + '</span>' : '') + '</span>' +
          '<div class="stack-under"><span>' + statLine + '</span></div>' +
          '</div></div></td>' +
        '<td class="est">' + estUsd(r.estVolumeUsd) + '</td></tr>';
    }).join('');
  }).catch(function (e) { body.innerHTML = stateRow(2, 'Could not load: ' + e.message); });
}

function loadTrParties() {
  var box = el('trParties');
  box.innerHTML = skBars(4);
  aGet('party-split?' + trParams()).then(function (d) {
    var o = d.overall || {}, names = { D: 'Democrat', R: 'Republican', O: 'Other / No party' }, keys = ['D', 'R', 'O'];
    var maxVol = 1, any = false;
    keys.forEach(function (k) { if (o[k]) { maxVol = Math.max(maxVol, o[k].estVolumeUsd); if (o[k].buys + o[k].sells > 0) any = true; } });
    if (!any) { box.innerHTML = '<div class="note">No trades in this window.</div>'; return; }
    box.innerHTML = keys.map(function (k) {
      var v = o[k] || { buys: 0, sells: 0, estVolumeUsd: 0, estNetFlowUsd: 0, members: 0 };
      var w = Math.round(100 * v.estVolumeUsd / maxVol);
      return '<div class="flowrow">' +
        '<div class="ftop"><span class="flabel">' + pdot(k) + esc(names[k]) + '</span>' +
          '<span class="fval">' + totalVolumeHtml(v.estVolumeUsd) + '</span></div>' +
        '<div class="htrack"><div class="hfill" style="width:' + w + '%"></div></div>' +
        flowChipHtml([esc(buySellText(v.buys, v.sells)), esc(polFull(v.members)), 'net volume ' + netHtml(v.estNetFlowUsd)]) + '</div>';
    }).join('');
  }).catch(function (e) { box.innerHTML = '<div class="note">Could not load: ' + esc(e.message) + '</div>'; });
}

function loadTrSectors() {
  var box = el('trSectors');
  box.innerHTML = skBars(4);
  aGet('sector-breakdown?' + trParams() + '&limit=8').then(function (d) {
    var rows = d.sectors || [];
    if (!rows.length) { box.innerHTML = '<div class="note">No data in this window.</div>'; return; }
    // Same visual language as By Market Cap / By Party: stacked flowrow
    // (label + $ on top, full-width proportion bar, buy/sell/breadth/net chip).
    // Rank by estimated volume so the longest bar is always first.
    rows.sort(function (a, b) { return Number(b.estVolumeUsd || 0) - Number(a.estVolumeUsd || 0); });
    var max = 1; rows.forEach(function (r) { max = Math.max(max, Number(r.estVolumeUsd || 0)); });
    box.innerHTML = rows.map(function (r) {
      var label = r.assetType || 'Unknown';
      var tip = (r.rawAssetTypes && r.rawAssetTypes.length)
        ? (label + ' — ' + r.rawAssetTypes.join(', '))
        : label;
      return flowRowHtml(label, {
        estVolumeUsd: r.estVolumeUsd,
        estNetFlowUsd: r.estNetFlowUsd,
        buyCount: r.buyCount,
        sellCount: r.sellCount,
        uniqueMembers: r.uniqueMembers,
        uniqueTickers: r.uniqueTickers,
      }, max, tip);
    }).join('');
  }).catch(function (e) { box.innerHTML = '<div class="note">Could not load: ' + esc(e.message) + '</div>'; });
}

function loadTrLag() {
  var kbox = el('trLagKpis'), dbox = el('trLagDist'), lbox = el('trLateFilers');
  kbox.innerHTML = ''; dbox.innerHTML = skBars(3); lbox.innerHTML = skRows(4, 4);
  aGet('filing-lag?' + trParams()).then(function (d) {
    var s = d.summary || {};
    var lagBasis = 'Disclosure lag is days between the transaction date and the official filing date.';
    kbox.innerHTML =
      kpi('Median Lag', (s.medianLagDays == null ? '—' : s.medianLagDays + '<small> days</small>'), 'Middle disclosure lag. ' + lagBasis) +
      kpiRaw(kpiLabel('90<sup>th</sup> Percentile', '90th Pctl', 'P90'), (s.p90LagDays == null ? '—' : s.p90LagDays + '<small> days</small>'), '90% of dated trade rows were filed within this many days. ' + lagBasis) +
      kpiRaw(kpiLabel('&gt;45 Day Lag', '>45d Lag', '>45d'), (s.overFortyFivePct == null ? '—' : Math.round(s.overFortyFivePct * 100) + '<small>%</small>'), 'Share of dated trade rows filed after the 45-day STOCK Act window. ' + lagBasis) +
      kpi('Disclosures', s.count || 0, 'Number of trade rows with both transaction and official filing dates.');
    var dist = s.distribution || [], max = 1; dist.forEach(function (b) { max = Math.max(max, b.count); });
    if (!dist.length || !s.count) { dbox.innerHTML = '<div class="note">No dated filings.</div>'; }
    else dbox.innerHTML = dist.map(function (b) {
      var w = Math.round(100 * b.count / max);
      var cls = (b.bucket === '46–60d' || b.bucket === '60d+') ? ' warn' : ' buy';
      var tip = b.count + ' dated trade row' + (b.count === 1 ? '' : 's') + ' had disclosure lag in the ' + b.bucket + ' bucket. Bars are scaled against the largest bucket in this chart.';
      return '<div class="hbar"' + attrTip(tip) + '><div class="hlabel">' + esc(b.bucket) + '</div>' +
        '<div class="htrack"><div class="hfill' + cls + '" style="width:' + w + '%"></div></div>' +
        '<div class="hval">' + b.count + '</div></div>';
    }).join('');
    var lf = d.topLateFilers || [];
    if (!lf.length) { lbox.innerHTML = stateRow(4, 'Not enough dated filings.'); }
    else lbox.innerHTML = lf.slice(0, 50).map(function (m) {
      var name = fmtName(m.fullName || m.filerId || 'Unknown');
      var metaStr = '';
      if (m.chamber || m.state || m.filerId) {
        // Executive filers collapse to their position alone (no "Exec ·", no
        // state); congressional filers keep chamber + state as before.
        var p = memberBranchBits({ chamber: m.chamber, filerId: m.filerId, title: m.title, state: m.state })
          .map(esc);
        if (p.length) metaStr = ' <span class="muted">· ' + p.join(' · ') + '</span>';
      }
      var tradeCount = Number(m.tradeCount || 0);
      var avg = Math.round(m.avgLagDays);
      var maxLag = Math.round(m.maxLagDays || 0);
      var late = Number(m.lateCount || 0);
      var basis = name + ' has ' + fmtCount(tradeCount) + ' dated trade row' + (tradeCount === 1 ? '' : 's') + '.';
      var memberTitle = m.filerId ? 'Open ' + name + ' details.' : name;
      var memberAttr = m.filerId ? ' class="member-cell clickable" data-member="' + esc(m.filerId) + '" title="' + esc(memberTitle) + '"' : ' class="member-cell" title="' + esc(memberTitle) + '"';
      var avgTip = 'Avg: mean number of days between transaction date and official filing date. ' + basis;
      var maxTip = 'Max: longest single trade-to-filing delay for this filer in the selected window. ' + basis;
      var lateTip = 'Late: count of this filer\\'s dated trade rows filed more than 45 days after the transaction date. ' + basis;
      return '<tr class="row"><td><div' + memberAttr + '>' + memberAvatarHtml(name, m.photoUrl, m.party, true) + '<div>' +
        pdot(m.party) + esc(name) + metaStr + '</div></div></td>' +
        '<td class="muted"' + attrTip(avgTip) + '>' + avg + 'd</td>' +
        '<td class="muted"' + attrTip(maxTip) + '>' + maxLag + 'd</td>' +
        '<td class="muted"' + attrTip(lateTip) + '>' + fmtCount(late) + '</td></tr>';
    }).join('');
  }).catch(function (e) {
    dbox.innerHTML = '<div class="note">Could not load: ' + esc(e.message) + '</div>';
    lbox.innerHTML = stateRow(4, 'Could not load.');
  });
}

/* ============================ FOCUS TRAP ============================ */
/* Shared keyboard focus trap for the drawer + the login/pricing modals: while
   one is open, Tab/Shift+Tab cycle only through its own focusable elements
   (never escaping to the dimmed page behind it), and closing restores focus
   to whatever triggered the open — the standard modal-dialog pattern (WCAG
   2.4.3). Escape already closes these overlays (see the document keydown
   handler near the bottom of this script); this only adds the Tab cycling
   and focus restore half of the pattern. */
var focusTrapReturnEl = null;
function focusableEls(container) {
  if (!container) return [];
  var sel = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  return Array.prototype.slice.call(container.querySelectorAll(sel)).filter(function (n) {
    return !!(n.offsetWidth || n.offsetHeight || n.getClientRects().length);
  });
}
function trapFocusIn(container) {
  focusTrapReturnEl = document.activeElement;
  var els = focusableEls(container);
  if (els.length) els[0].focus(); else if (container) container.focus();
}
function releaseFocusTrap() {
  var toRestore = focusTrapReturnEl;
  focusTrapReturnEl = null;
  if (toRestore && typeof toRestore.focus === 'function' && document.contains(toRestore)) {
    try { toRestore.focus(); } catch (e) {}
  }
}
/* The currently open drawer/modal's content container, or null if none is open. */
function openOverlayContainer() {
  var drawer = el('detailDrawer');
  if (drawer && drawer.classList.contains('open')) return document.querySelector('#detailDrawer .drawer-panel');
  var openModal = document.querySelector('.overlay.open .modal');
  return openModal || null;
}
function syncBodyScrollLock() {
  var isOpen = !!openOverlayContainer();
  document.body.classList.toggle('drawer-open', isOpen);
}
document.addEventListener('keydown', function (e) {
  if (e.key !== 'Tab') return;
  var container = openOverlayContainer();
  if (!container) return;
  var els = focusableEls(container);
  if (!els.length) { e.preventDefault(); return; }
  var first = els[0], last = els[els.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  else if (!container.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
});

/* ============================ DETAIL DRAWERS ============================ */
/* One reusable right-side drawer, filled per type: trade / asset / politician.
   Tier-1/2 (company profile, price, performance) are KEY-GATED and shown as a
   quiet note until a market-data key is configured. */
// Last-resort accessible name for the drawer dialog (see openDrawer() below) —
// every current call site passes its own state-specific title instead.
var DRAWER_DEFAULT_TITLE = 'Details';
var drawerHeroCleanup = null;
var drawerHeroRaf = 0;
function bindDrawerHero(panel) {
  if (drawerHeroCleanup) { drawerHeroCleanup(); drawerHeroCleanup = null; }
  var topbar = panel ? panel.querySelector('.drawer-topbar') : null;
  var body = el('detailDrawerBody');
  var hero = body ? body.querySelector('.drawer-hero') : null;
  if (topbar) {
    topbar.classList.toggle('has-hero-live', !!(hero && hero.classList.contains('drawer-hero-live')));
    topbar.classList.toggle('has-hero-swap', !!(hero && hero.classList.contains('drawer-hero-swap')));
    topbar.classList.remove('is-compact');
  }
  if (hero) hero.classList.remove('is-compact');
  if (!panel || !hero || !topbar) return;
  function measure() {
    var live = hero.classList.contains('drawer-hero-live');
    var compact;
    if (live) {
      var pin = parseFloat(getComputedStyle(hero).top) || 8;
      compact = hero.getBoundingClientRect().top <= panel.getBoundingClientRect().top + pin + 0.5;
    } else {
      compact = hero.getBoundingClientRect().bottom <= topbar.getBoundingClientRect().bottom + 0.5;
    }
    hero.classList.toggle('is-compact', compact);
    topbar.classList.toggle('is-compact', compact);
  }
  function onScroll() {
    if (drawerHeroRaf) return;
    drawerHeroRaf = requestAnimationFrame(function () {
      drawerHeroRaf = 0;
      measure();
    });
  }
  panel.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);
  measure();
  drawerHeroCleanup = function () {
    panel.removeEventListener('scroll', onScroll);
    window.removeEventListener('resize', onScroll);
    if (drawerHeroRaf) { cancelAnimationFrame(drawerHeroRaf); drawerHeroRaf = 0; }
    hero.classList.remove('is-compact');
    topbar.classList.remove('is-compact', 'has-hero-live', 'has-hero-swap');
  };
}
function openDrawer(html, topbarTitle) {
  closePanels();
  // Drill-in navigation (trade -> asset -> member, etc.) calls openDrawer()
  // again while it's already open; only capture the pre-drawer focus target
  // on the FIRST open of a session, so closing after several drill-ins
  // restores focus to the original trigger, not a since-replaced inner link.
  var drawer = el('detailDrawer');
  var wasOpen = drawer.classList.contains('open');
  el('detailDrawerBody').innerHTML = html;
  // Owner punch list #13(f): the sticky topbar reads like "SOLD $1k-$15k of
  // ARCC | Ares Capital Corporation" instead of a stale title held over from
  // whatever was open before.
  // WEBA11Y P2: #drawerTopbarTitle is also the dialog's aria-labelledby
  // target (see the .drawer-panel markup below), so leaving it empty here —
  // as every loading/error caller used to, by simply not passing a second
  // argument — pointed the dialog's accessible name at nothing: a screen
  // reader landing in the dialog while a trade/asset/politician was loading,
  // or after a fetch failed, heard an unnamed dialog.  Every call site now
  // passes a real, state-specific title (e.g. "Loading trade…", "Trade not
  // found"); DRAWER_DEFAULT_TITLE is only a last-resort safety net for a
  // caller that forgets to, so the name is never blank in ANY state.
  var titleEl = el('drawerTopbarTitle');
  if (titleEl) titleEl.innerHTML = topbarTitle || DRAWER_DEFAULT_TITLE;
  var p = document.querySelector('#detailDrawer .drawer-panel');
  // Start off-screen, then open on the next frame so CSS transitions/animations
  // actually run (display:none → block alone does not interpolate transform).
  if (p) {
    p.scrollTop = 0;
    p.style.transition = 'none';
    p.style.animation = 'none';
    p.style.transform = '';
  }
  drawer.classList.add('open');
  syncBodyScrollLock();
  if (p) {
    void p.offsetWidth;
    p.style.transition = '';
    p.style.animation = '';
  }
  if (wasOpen) { var els = focusableEls(p); if (els.length) els[0].focus(); }
  else trapFocusIn(p);
  bindDrawerHero(p);
}
function closeDrawer() {
  if (drawerHeroCleanup) { drawerHeroCleanup(); drawerHeroCleanup = null; }
  var wasOpen = el('detailDrawer').classList.contains('open');
  el('detailDrawer').classList.remove('open');
  syncBodyScrollLock();
  if (wasOpen) releaseFocusTrap();
  // SEOSOCIAL-04: undo the drawer-open title change back to whatever the
  // active tab's title is (or the bare site name for Trends/no tab active).
  if (wasOpen) {
    var activeTab = document.querySelector('nav.tabs a.active');
    var activeView = activeTab ? activeTab.getAttribute('data-view') : null;
    setDocumentTitle(activeView ? TAB_PAGE_TITLES[activeView] : null);
  }
}
/* Deep links: every drawer gets a shareable URL (?ticker= / ?member= / ?trade=)
   as TWO separate controls — a real navigable link and a copy-to-clipboard
   button; openDeepLink() below restores the drawer on boot.
   SEOSOCIAL-02 (crawlable permalink) and WEBA11Y-08 (a real, focusable copy
   control) both landed as changes to this ONE "Copy link" element, which
   made them mutually exclusive: a href-less <a> is a real link with no
   working navigation (fails SEOSOCIAL-02), while a <button> alone has no
   href for crawlers, right-click "open in new tab", or middle-click (fails
   WEBA11Y-08's intent — a control shouldn't lie about what it is). Splitting
   into an <a href> that only navigates and a <button> that only copies keeps
   both properties true at once, each on the control that actually has it. */
function copyLinkHtml(param, value, entityLabel) {
  // SEOSOCIAL-02: reuses the same entityHref() the Directory member/ticker
  // cells and drawer-open links use — one URL builder, not a second copy of
  // the '/?param=value' construction.  A genuine <a href>, left to navigate
  // normally (no click-time preventDefault/SPA takeover): landing back on
  // '/' with this same query re-opens this exact drawer on boot via
  // openDeepLink(), so a full navigation still ends up in the right place,
  // and open-in-new-tab / middle-click / crawler-follow all just work.
  var href = entityHref(param, value);
  // WEBA11Y-08: copying is a SEPARATE real <button>, not the href-less <a>
  // that used to double as both — that was unfocusable via Tab and announced
  // to assistive tech as a link that goes nowhere, when activating it
  // actually copied to the clipboard.  aria-label spells out what gets
  // copied; the visible text is a prefix of it (WCAG 2.5.3 Label in Name).
  // A successful copy announces through the existing polite toast live
  // region (#toast, role="status" aria-live="polite") with "Link copied."
  return '<span class="drawer-link-row">' +
    '<a class="drawer-all-link clickable" href="' + esc(href) + '">🔗 ' + esc(entityLabel) + '</a>' +
    '<button type="button" class="drawer-copy-link-btn clickable" data-copy-param="' + esc(param) + '" data-copy-value="' + esc(value) + '" aria-label="Copy Link to ' + esc(entityLabel) + '’s page">📋 Copy Link</button>' +
    '</span>';
}
document.addEventListener('click', function (e) {
  var b = e.target && e.target.closest ? e.target.closest('[data-copy-param]') : null;
  if (!b) return;
  var u = new URL(window.location.origin + '/');
  u.searchParams.set(b.getAttribute('data-copy-param'), b.getAttribute('data-copy-value') || '');
  copyText(u.toString(), 'Link copied.');
});
/* Client-side mirror of TICKER_RESOLVED_SQL (src/analytics/sql.ts): the server
   only treats a ticker as resolved when it is non-empty and not one of the
   sentinel strings a filing uses for "this has no symbol". Trade rows are a raw
   passthrough of row.ticker with no sentinel filtering, so anything in the UI
   that promises symbol-dependent data (price, performance, company profile)
   has to apply the same test first. */
var TICKER_SENTINELS = { 'NONE': 1, '--': 1, 'N/A': 1, 'NA': 1, 'NULL': 1, '—': 1 };
function tickerResolved(t) {
  var s = String(t == null ? '' : t).trim();
  if (!s) return false;
  if (isScannedPdfPlaceholder(s)) return false;
  return !TICKER_SENTINELS[s.toUpperCase()];
}
/* Shown ONLY when the row has a resolved ticker but no cached price for it yet
   — the one case where performance genuinely is coming. Callers must gate on
   tickerResolved() first: for a muni, a private stake, or any other row with no
   symbol there is nothing to price, ever, and promising otherwise is a lie. */
var PERF_GATE = '<div class="tier-gate-note">📈 Price &amp; performance appear here once market data for this asset is cached.</div>';
var PROFILE_GATE = '<div class="tier-gate-note">🏢 Company details (sector, market cap, country, exchange) will appear here once a market-data API key is configured.</div>';
var OPTION_PERF_NOTE = '<div class="tier-gate-note">Performance isn\\'t shown for options — the return depends on strike, expiry, and exercise, which the filing doesn\\'t disclose.</div>';
/* Render the performance line from /api/analytics/performance. Frames a sale as
   "since sold" (a price observation, not profit/loss). */
function perfPct(x) { return x == null ? '—' : (x > 0 ? '▲ ' : x < 0 ? '▼ ' : '') + (x * 100).toFixed(1) + '%'; }
function perfLineHtml(d, txType) {
  if (!d || !d.available) return (d && d.isOption) ? OPTION_PERF_NOTE : PERF_GATE;
  var verb = txType === 'S' ? 'since sold' : 'since traded';
  function perfBlock(label, perf, anchorPrice) {
    if (!perf) return '';
    var cls = perf.assetReturn > 0 ? 'pos' : perf.assetReturn < 0 ? 'neg' : '';
    // The benchmark is named once, by the chip's own leading label — the excess
    // figure sits right beside it and does not restate it.
    var excess = perf.excessReturn == null ? '—' : (perf.excessReturn > 0 ? '+' : '') + (perf.excessReturn * 100).toFixed(1) + '% excess';
    var prices = (anchorPrice != null && d.currentPrice != null)
      ? '<div class="chip muted">$' + Number(anchorPrice).toFixed(2) + ' → $' + Number(d.currentPrice).toFixed(2) + (d.currentPriceDate ? ' (' + esc(d.currentPriceDate) + ')' : '') + '</div>'
      : '';
    return '<div class="perf-line net ' + cls + '">' + perfPct(perf.assetReturn) + ' ' + label + '</div>' +
      '<div class="chip">S&amp;P 500 ' + perfPct(perf.spxReturn) + ' · ' + excess + '</div>' + prices;
  }
  var tradePerf = d.tradeDatePerformance || d;
  var tradeHtml = perfBlock(verb, tradePerf, d.priceAtTrade);
  var filingHtml = d.filingDatePerformance
    ? '<div style="height:10px"></div>' + perfBlock(txType === 'S' ? 'since reported' : 'since filing', d.filingDatePerformance, d.filingDatePerformance.priceAt)
    : '';
  return tradeHtml + filingHtml;
}
function kvRow(k, v) { return '<dt>' + esc(k) + '</dt><dd>' + v + '</dd>'; }
function actionBadge(type) {
  var label = typeName[type] || type || 'Unknown';
  return '<span class="tag ' + esc(type || '') + '" title="' + esc(label) + '">' + esc(label) + '</span>';
}
function amountText(min, max) {
  if (min == null && max == null) return 'bracket unavailable';
  return fmtBracketAmount(min) + ' - ' + (max == null ? '+' : fmtBracketAmount(max));
}
function optionFootnote(n) {
  n = Number(n || 0);
  if (n <= 0) return '';
  return '<div class="kpi-note muted">incl. ' + fmtCount(n) + ' option trade' + (n === 1 ? '' : 's') + '</div>';
}
function daysBetween(aIso, bIso) {
  var a = Date.parse(aIso), b = Date.parse(bIso);
  if (!isFinite(a) || !isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}
var PARTY_NAME = { D: 'Democrat', R: 'Republican', O: 'Independent / Other' };
function partyLabel(b) { return PARTY_NAME[b] || ''; }
function friendlyKey(k) {
  return String(k || '')
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\\b\\w/g, function (ch) { return ch.toUpperCase(); });
}
function cleanNoteValue(v) {
  if (v == null || v === '') return '';
  return String(v).replace(/\\s+/g, ' ').trim();
}
function isExtractionNoteKey(k) {
  var s = String(k || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return [
    'txdate', 'owner', 'assetname', 'ticker', 'assettype', 'txtype',
    'amountrange', 'amountmin', 'amountmax', 'isoption', 'confidence',
    'member', 'membername', 'fullname', 'filerid', 'state', 'chamber'
  ].indexOf(s) >= 0;
}
function looksLikeRawExtractionPayload(text) {
  var t = String(text || '').toLowerCase();
  if (!/^\\s*[\\[{]/.test(t)) return false;
  var hits = 0;
  ['txdate', 'owner', 'ticker', 'txtype', 'amountrange'].forEach(function (k) { if (t.indexOf(k) >= 0) hits++; });
  if (t.indexOf('assetname') >= 0 || t.indexOf('a etname') >= 0 || t.indexOf('asset name') >= 0) hits++;
  if (t.indexOf('assettype') >= 0 || t.indexOf('a ettype') >= 0 || t.indexOf('asset type') >= 0) hits++;
  if (t.indexOf('isoption') >= 0 || t.indexOf('i option') >= 0) hits++;
  return hits >= 4;
}
function looksLikeRawTransactionLine(text) {
  var t = String(text || '');
  return /\\[[A-Z0-9]{2,3}\\]/.test(t) &&
    /\\b(P|S|E|purchase|sale|exchange)\\b/i.test(t) &&
    /\\$[\\d,]+/.test(t);
}
/* Collapse a string to letters+digits so "Energy Northwest WA Elec Sr A RV BE/R"
   and "Energy Northwest Wa Elec Sr A RV Be/R" compare equal. */
function entityFingerprint(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
}
/* filingNotesHtml(raw, assetName, ticker): assetName/ticker are optional and
   only used to suppress a "note" that is nothing but the entity restated — the
   drawer already states the asset once, in its identity card. */
function filingNotesHtml(raw, assetName, ticker) {
  if (!raw) return '';
  var text = cleanNoteValue(raw);
  var fp = entityFingerprint(text);
  if (fp && (fp === entityFingerprint(assetName) || fp === entityFingerprint(ticker))) return '';
  if (isScannedPdfPlaceholder(text)) {
    return '<p class="filing-note">Historical source note: this row came from an unparsed scanned filing. It needs official source backfill before asset-level details are reliable.</p>';
  }
  var parsed = null;
  if (text && (text[0] === '{' || text[0] === '[')) {
    try { parsed = JSON.parse(text); } catch (e) { parsed = null; }
  }
  if (parsed && !Array.isArray(parsed) && typeof parsed === 'object') {
    var member = cleanNoteValue(parsed.member);
    var type = cleanNoteValue(parsed.type);
    var amount = cleanNoteValue(parsed.amount);
    if (member || type || amount) {
      var who = member ? member + ' reported ' : 'Reported ';
      var what = type || 'a transaction';
      var amt = amount ? ' in the ' + amount + ' amount bracket' : '';
      return '<p class="filing-note">Historical source note: ' + esc(who + what + amt + '.') + '</p>';
    }
    var rows = Object.keys(parsed).filter(function (k) {
      return !isExtractionNoteKey(k) && cleanNoteValue(parsed[k]);
    }).map(function (k) {
      return kvRow(friendlyKey(k), esc(cleanNoteValue(parsed[k])));
    }).join('');
    if (rows) return '<dl class="drawer-kv filing-note-kv">' + rows + '</dl>';
    return '';
  }
  if (looksLikeRawExtractionPayload(text)) return '';
  if (looksLikeRawTransactionLine(text)) return '';
  return '<p class="filing-note">' + esc(text) + '</p>';
}

/* Company section for a drawer: real cross-referenced data when present, else the
   key-gated placeholder. Accepts a ref object with any subset of the fields. */
function companySectionHtml(ref) {
  if (!ref || (!ref.sector && ref.marketCap == null && !ref.marketCapBucket && !ref.country && !ref.exchangeShort && !ref.assetClass)) {
    return PROFILE_GATE;
  }
  function item(label, val) {
    if (!val && val !== 0) return '';
    return '<div class="def-item"><span class="def-k">' + esc(label) + '</span><span class="def-v">' + val + '</span></div>';
  }
  var mcap = (ref.marketCapBucket ? esc(ownerLabel(ref.marketCapBucket)) : '') +
    (ref.marketCap != null ? (ref.marketCapBucket ? '  |  ' : '') + estUsd(ref.marketCap) : '');
  var html =
    item('Sector', ref.sector ? esc(ref.sector) : '') +
    item('Industry', ref.industry ? esc(ref.industry) : '') +
    item('Class', ref.assetClass ? esc(assetClassLabel(ref.assetClass)) : '') +
    item('Market Cap', mcap) +
    item('Exchange', ref.exchangeShort ? esc(ref.exchangeShort) : '') +
    item('Country', ref.country ? esc(ref.country) : '') +
    item('Currency', ref.currency ? esc(ref.currency) : '') +
    item('IPO', ref.ipoDate ? esc(dateText(ref.ipoDate)) : '');
  return '<div class="def-grid">' + html + '</div>';
}
function drawerCompanyTitle(ticker, name) {
  // This is the drawer FOR this ticker — the title is not clickable (it would
  // just reopen the same drawer). Owner punch list #14: ticker and name are
  // separated by "  |  ", not a dot.
  var label = fmtCompany(name || ticker || 'Company');
  var sameAsTicker = label === ticker;
  return '<div class="drawer-hero drawer-hero-live drawer-company-title">' + tickerLogoHtml(ticker, label) + '<div><h2 class="drawer-title-line">' +
    (ticker ? '<span class="tkr">' + esc(ticker) + '</span>' : '') +
    (ticker && !sameAsTicker ? '<span class="dot-sep">  |  </span>' : '') +
    (sameAsTicker ? '' : '<span class="company-name">' + esc(label) + '</span>') + '</h2></div></div>';
}
function miniTradeDateHtml(t) {
  var traded = dateText(t.txDate);
  var pub = t.filedDate || t.firstSeenAt || t.createdAt || '';
  // Owner punch list #18(e): lowercase "filed", abbreviated "Nd later" so the
  // subline stays one line now that the table has the drawer's full width.
  var sub = pub ? 'filed ' + dateText(pub) : 'filed unavailable';
  if (t.txDate && pub) {
    var ms = new Date(pub).getTime() - new Date(t.txDate).getTime();
    if (!isNaN(ms) && ms >= 0) {
      sub = 'filed ' + Math.round(ms / 86400000) + 'd later';
    }
  }
  return '<div class="mini-date"><span>' + esc(traded) + '</span><span class="subline">' + esc(sub) + '</span></div>';
}
function miniTradeDateOnlyHtml(t) {
  return '<div class="mini-date"><span>' + esc(dateText(t.txDate)) + '</span></div>';
}
function miniSourceLinkHtml(url) {
  var safe = safeDocUrl(url);
  return safe ? '<a class="mini-source-link" href="' + esc(safe) + '" target="_blank" rel="noopener noreferrer">Source</a>' : '';
}
function analyticsTradeRow(t, ctx) {
  ctx = ctx || {};
  return rememberTradeRow({
    filed: toISODate(t.filedDate) || '',
    member: fmtName(ctx.memberName || t.fullName || t.filerId || 'Unknown'),
    photoUrl: ctx.photoUrl || t.photoUrl || '',
    st: ctx.state || t.state || '',
    chamber: ctx.chamber || t.chamber || '',
    asset: cleanAsset(t.assetName || t.name || ''),
    ticker: t.ticker || ctx.ticker || '',
    assetType: t.assetType || '',
    assetTypeName: t.assetTypeName || '',
    type: (t.txType === 'P' ? 'B' : t.txType) || 'B',
    min: t.amountMin == null ? null : t.amountMin,
    max: t.amountMax == null ? null : t.amountMax,
    txdate: toISODate(t.txDate) || '',
    owner: t.owner || '',
    conf: 1,
    source: t.source || 'primary',
    filedDate: t.filedDate || '',
    firstSeenAt: t.firstSeenAt || '',
    imported: t.createdAt || '',
    disclosureLagDays: typeof t.disclosureLagDays === 'number' ? t.disclosureLagDays : null,
    stockActStatus: t.stockActStatus || '',
    id: t.id || '',
    docId: t.docId || '',
    filerId: ctx.filerId || t.filerId || '',
    isOption: !!t.isOption,
    rawText: t.rawText || '',
    pdfUrl: t.pdfUrl || '',
    sourceUrl: t.sourceUrl || ''
  });
}

/* ---- asset drawer (reuses /api/analytics/ticker/:ticker) ---- */
function openAsset(ticker) {
  if (!ticker) return;
  openDrawer('<div class="note">Loading ' + esc(ticker) + '…</div>', 'Loading ' + esc(ticker) + '…');
  // Follow the Trends window if it's on the page; fall back to all-time when the
  // drawer is opened from a context without the window selector (feed, search).
  var tickerWindow = document.querySelector('.tr-window-select') ? getTrWindow() : 'all';
  var tickerWindowLabel = tickerWindow === 'all' ? 'All' : windowLabel(tickerWindow);
  var netFlowTip = tickerWindow === 'all'
    ? NET_FLOW_TIP_ALLTIME
    : 'Buy dollars minus sell dollars across this asset\\u2019s disclosed trades in the selected window (' + tickerWindowLabel + '), using STOCK Act bracket midpoints. A very rough estimate of net direction, not exact.';
  aGet('ticker/' + encodeURIComponent(ticker) + '?' + trParams()).then(function (d) {
    var s = d.summary || {};
    var companyName = (d.ref && d.ref.companyName) || d.name || '';
    var sent = s.netSentiment == null ? '—' : '<span class="bp"><span class="bp-n">' + Math.round(s.netSentiment * 100) + '</span><span class="bp-pct">%</span><span class="bp-w">buys</span></span>';
    var ser = d.series || [];
    var chart = ser.length ? timeChartHtml(ser) : '<div class="note">No dated trades.</div>';
    // Owner punch list #18(b): bars are one bucket wide — say so once when the
    // buckets are weekly, since the x-axis label is now a week-start date
    // (fmtPeriod), not the raw "2026-W19" bucket key.
    var chartCaption = (ser.length && d.granularity === 'week')
      ? '<p class="note" style="margin:6px 0 0">Weekly buckets — each label is the week-of date (week starts Monday).</p>'
      : '';
    function traderList(arr, label) {
      if (!arr || !arr.length) return '<div class="note">No ' + label + '.</div>';
      return arr.map(function (m) {
        var name = fmtName(m.fullName || m.filerId || 'Unknown');
        var memberAttr = m.filerId ? ' data-member="' + esc(m.filerId) + '"' : '';
        var labelCls = m.filerId ? 'hlabel clickable' : 'hlabel';
        return '<div class="hbar ledger" style="margin:5px 0"><div class="' + labelCls + '"' + memberAttr + '>' +
          memberAvatarHtml(name, m.photoUrl, m.partyBucket, true) + ' ' + pdot(m.partyBucket) + esc(name) + '</div>' +
          '<div class="hval">' + estUsd(m.estVolumeUsd) + '</div></div>';
      }).join('');
    }
    var recent = (d.recentTrades || []).map(function (t) {
      var tradeRow = analyticsTradeRow(t, { ticker: d.ticker, memberName: t.fullName, photoUrl: t.photoUrl });
      var name = fmtName(t.fullName || 'Unknown');
      var member = t.filerId
        ? '<span class="member-cell clickable" data-member="' + esc(t.filerId) + '">' + pdot(t.partyBucket) + esc(name) + '</span>'
        : pdot(t.partyBucket) + esc(name);
      // Owner punch list #18(d): the "M" manual-entry badge is dropped from
      // this table — the note stays put inside the trade drawer's own details.
      var actionCell = actionBadge(t.txType);
      return '<tr class="row clickable" data-txid="' + esc(tradeRow.id) + '" title="Open trade details"><td class="muted">' + rowOpenBtnHtml('data-txid', tradeRow.id, 'Open trade details') + miniTradeDateHtml(t) + '</td>' +
        '<td>' + actionCell + '</td>' +
        '<td>' + member + '</td>' +
        '<td class="est">' + estUsd(t.estValueUsd) + miniSourceLinkHtml(t.pdfUrl || t.sourceUrl) + '</td></tr>';
    }).join('');
    // Owner punch list #13(f): sticky-header summary for the ticker drawer.
    var topbarTitle = esc(d.ticker) + ((companyName && companyName !== d.ticker) ? '<span class="dot-sep">  |  </span>' + esc(companyName) : '');
    setDocumentTitle(d.ticker); // SEOSOCIAL-04: drawer-open path
    openDrawer(
      drawerCompanyTitle(d.ticker, companyName || d.ticker) +
	      // These come from the windowed stats block, same as the KPI strip below —
	      // name the window here too so the subtitle is not read as an all-time total.
	      '<p class="dsub">' + fmtCount(s.totalTrades || 0) + ' trades  |  ' + fmtCount(s.memberCount || 0) + ' politicians  |  ' + estUsd(s.estVolumeUsd) + ' approx. volume  |  ' + esc(tickerWindowLabel) + '</p>' +
      '<div class="drawer-section first"><h3>Company</h3>' + companySectionHtml(d.ref) + '</div>' +
      '<div class="drawer-section"><h3>Activity (' + esc(tickerWindowLabel) + ')</h3><div class="grid-cards">' +
	        kpi('Trades', s.totalTrades || 0) + kpi('Politicians', s.memberCount || 0) + kpiInfo('Approx. Volume', estUsd(s.estVolumeUsd), EST_VOLUME_TIP, null, optionFootnote(s.optionCount)) +
        kpiInfo('Net Flow', netHtml(s.estNetFlowUsd), netFlowTip) + kpiInfo('Buy Pressure', sent, BUY_PRESSURE_TIP) + '</div>' +
        '<div class="legend" style="margin-top:8px"><span><span class="sw buy"></span>Buys</span><span><span class="sw sell"></span>Sells</span></div>' + chart + chartCaption + '</div>' +
      '<div class="drawer-section"><h3>Performance After Buys</h3><div id="assetPerf"><div class="note">Loading performance…</div></div></div>' +
      '<div class="drawer-stack-grid"><div class="drawer-section"><h3>Top Buyers</h3>' + traderList(d.topBuyers, 'buyers') + '</div>' +
        '<div class="drawer-section"><h3>Top Sellers</h3>' + traderList(d.topSellers, 'sellers') + '</div></div>' +
      '<div class="drawer-section"><h3>Recent Trades</h3><div class="table-wrap"><table class="mini-tbl"><tbody>' +
        (recent || '<tr><td class="state" colspan="4">No recent trades.</td></tr>') + '</tbody></table></div></div>' +
      '<div class="drawer-section">' + copyLinkHtml('ticker', d.ticker, d.ticker) + '</div>',
      topbarTitle
    );
    // Lazy-load purchase-cohort backtest (forward returns vs S&P after Congress buys).
    aGet('ticker/' + encodeURIComponent(ticker) + '/backtest?' + trParams()).then(function (bt) {
      var pEl = el('assetPerf'); if (pEl) pEl.innerHTML = tickerBacktestHtml(bt);
    }).catch(function () {
      var pEl = el('assetPerf');
      if (pEl) pEl.innerHTML = '<div class="note">Performance unavailable right now.</div>';
    });
  }).catch(function (e) { openDrawer('<div class="note">Could not load ' + esc(ticker) + ': ' + esc(e.message) + '</div>', 'Could not load ' + esc(ticker)); });
}

/* Buy-cohort backtest summary for the asset drawer. */
function tickerBacktestHtml(d) {
  if (!d) return '<div class="note">Performance unavailable.</div>';
  var horizons = d.horizons || [];
  var total = d.totalBuyEvents != null ? d.totalBuyEvents : 0;
  if (!horizons.length || !total) {
    return '<div class="note">No priced equity buys to score yet — this fills in as the price cache backfills. Options are excluded.</div>';
  }
  function hzLabel(days) {
    if (days === 21) return '~1 mo';
    if (days === 63) return '~3 mo';
    if (days === 126) return '~6 mo';
    if (days === 252) return '~1 yr';
    return days + 'd';
  }
  var rows = horizons.map(function (h) {
    var n = h.n != null ? h.n : 0;
    var excess = h.avgExcess;
    var ret = h.avgReturn;
    var cell = excess == null
      ? '<span class="muted">n&lt;' + (h.minN || 5) + '</span>'
      : '<span class="net ' + (excess > 0 ? 'pos' : excess < 0 ? 'neg' : '') + '">' +
          (excess > 0 ? '+' : '') + (excess * 100).toFixed(1) + '% excess</span>' +
          (ret != null ? ' <span class="muted">(' + (ret > 0 ? '+' : '') + (ret * 100).toFixed(1) + '% asset)</span>' : '');
    return '<div class="hbar ledger hz" style="margin:6px 0"><div class="hlabel">' + esc(hzLabel(h.horizonDays || h.days || h.horizon)) +
      '</div><div class="hval">' + cell +
      ' <span class="muted">· n=' + n + '</span></div></div>';
  }).join('');
  // Names the benchmark once for this section; the rows above just say "excess".
  return '<p class="note" style="margin:0 0 8px">After disclosed <strong>buys</strong> (not sells), equal-weighted forward return in excess of the S&amp;P 500.&nbsp; Observational — not a forecast.&nbsp; Cohort: ' +
    fmtCount(total) + ' buy event' + (total === 1 ? '' : 's') + '.</p>' + rows;
}

/* ---- politician drawer (/api/analytics/member/:filerId) ---- */
function openMember(filerId) {
  if (!filerId) return;
  openDrawer('<div class="note">Loading politician…</div>', 'Loading politician…');
  aGet('member/' + encodeURIComponent(filerId) + '?' + trParams()).then(function (d) {
    var p = d.profile || {}, st = d.stats || {};
    var name = fmtName(p.fullName || filerId);
    var partyName = partyLabel(p.partyBucket);
    // Executive filers: the drawer headline is their POSITION alone — never
    // "Exec · Pennsylvania", never a district. The endpoint already serves the
    // curated title field (analytics/routes.ts), so prefer it over the id map.
    var isExec = isExecutiveFiler(p.chamber, filerId);
    var meta = isExec
      ? execDisplayTitle(filerId, p.title, EXEC_TITLE_FULL)
      : [chamberLabel(p.chamber), stateName(p.state)].filter(Boolean).join(' · ');
    var subBits = [];
    if (meta) subBits.push(esc(meta));
    if (!isExec && p.district) subBits.push(fmtDistrictOrdinalHtml(p.district) + ' District');
    var partyHtml = partyName ? pdot(p.partyBucket) + esc(partyName) : '';
    var subline = partyHtml + (subBits.length ? (partyHtml ? ' · ' : '') + subBits.join(' · ') : '');
    var committees = p.committees || [];
    var commHtml = committees.length
      ? committees.map(function (c) { return '<span class="committee-tag">' + esc(c) + '</span>'; }).join('')
      : '<span class="muted">' + (isExec
        ? 'Executive filers do not sit on congressional committees.'
        : 'No current assignments on file.') + '</span>';
    var top = (d.topTickers || []).map(function (t) {
      return '<div class="hbar ledger" style="margin:5px 0"><div class="hlabel clickable" data-asset="' + esc(t.ticker) + '">' +
        '<span class="tkr">' + esc(t.ticker) + '</span>' + (t.name ? ' <span class="muted">' + esc(t.name) + '</span>' : '') +
        '</div><div class="hval"><span class="mini-trade-stat"><span>' + fmtCount(t.tradeCount) + '</span><span class="dot">•</span><span>' + estUsd(t.estVolumeUsd) + '</span></span></div></div>';
    }).join('') || '<div class="note">—</div>';
    var recent = (d.recentTrades || []).map(function (t) {
      var tradeRow = analyticsTradeRow(t, {
        filerId: filerId,
        memberName: name,
        photoUrl: p.photoUrl,
        state: p.state,
        chamber: p.chamber
      });
      var assetCell = t.ticker
        ? '<span class="tkr clickable" data-asset="' + esc(t.ticker) + '">' + esc(t.ticker) + '</span>'
        : '<span class="muted">' + esc((t.assetName || '').slice(0, 30)) + '</span>';
      var actionCell = actionBadge(t.txType) + (t.source === 'manual' ? '<span class="badge sm ghost" style="margin-left:4px" title="Manual Entry">M</span>' : '');
      return '<tr class="row clickable" data-txid="' + esc(tradeRow.id) + '" title="Open trade details"><td class="muted">' + rowOpenBtnHtml('data-txid', tradeRow.id, 'Open trade details') + miniTradeDateOnlyHtml(t) + '</td>' +
        '<td>' + actionCell + '</td><td>' + assetCell + '</td>' +
        '<td class="est">' + estUsd(t.estValueUsd) + miniSourceLinkHtml(t.pdfUrl || t.sourceUrl) + '</td></tr>';
    }).join('');
    setDocumentTitle(name); // SEOSOCIAL-04: drawer-open path
    openDrawer(
      '<div class="drawer-hero drawer-hero-live drawer-member-title">' + memberAvatarHtml(name, p.photoUrl, p.partyBucket || p.party, true) +
        '<div><h2 class="drawer-member-name">' + esc(name) + '</h2><p class="dsub" style="margin:0">' + subline + '</p></div></div>' +
      // Same shared chips as Trends (window/chamber/party/side) via trParams().
      '<div class="drawer-section"><h3>Trade Stats (' + esc(windowLabel(getTrWindow())) + ')</h3><dl class="drawer-kv">' +
        kvRow('Total Trades', fmtCount(st.totalTrades || 0)) + kvRow('Buys / Sells', fmtCount(st.buyCount || 0) + ' / ' + fmtCount(st.sellCount || 0)) +
	        kvRow('Distinct Assets', fmtCount(st.uniqueAssets || st.uniqueTickers || 0)) + kvRow('Approx. Volume', estUsd(st.estVolumeUsd)) +
        kvRow('Avg. Lag', st.avgLagDays == null ? '—' : (Math.round(st.avgLagDays) + ' days')) + '</dl></div>' +
      '<div class="drawer-section"><h3>Committees</h3>' + commHtml + '</div>' +
      '<div class="drawer-section"><h3>Performance vs S&amp;P 500</h3><div id="memberPerf"><div class="note">Loading performance…</div></div></div>' +
      '<div class="drawer-section"><h3>Most-Traded</h3>' + top + '</div>' +
      '<div class="drawer-section"><h3>Recent Trades</h3><div class="table-wrap"><table class="mini-tbl"><tbody>' +
        (recent || '<tr><td class="state" colspan="4">No trades.</td></tr>') + '</tbody></table></div></div>' +
      '<div class="drawer-section">' + copyLinkHtml('member', filerId, name) + '</div>',
      // Owner punch list #13(f): sticky-header summary — the politician's name.
      esc(name)
    );
    // Lazy-load dual-anchor buy skill (trade-date approx + filing-date copy-trade).
    aGet('member/' + encodeURIComponent(filerId) + '/performance?' + trParams()).then(function (perf) {
      var pEl = el('memberPerf'); if (pEl) pEl.innerHTML = memberPerfHtml(perf);
    }).catch(function () {
      var pEl = el('memberPerf');
      if (pEl) pEl.innerHTML = '<div class="note">Performance unavailable right now.</div>';
    });
  }).catch(function (e) { openDrawer('<div class="note">Could not load politician: ' + esc(e.message) + '</div>', 'Could not load politician'); });
}

/* Dual-anchor politician skill: trade-date (their timing) + filing-date (copy-trade). Buys only. */
function memberPerfHtml(d) {
  if (!d) return '<div class="note">Performance unavailable.</div>';
  var trade = d.tradeDate || d.performance || null;
  var filing = d.filingDate || null;
  var buyCount = d.buyCount != null ? d.buyCount : (trade && trade.tradeCount);
  if ((!trade || !trade.scoredCount) && (!filing || !filing.scoredCount)) {
    return '<div class="note">No priced equity buys to score yet — this fills in as the price cache backfills. Sells are not scored as skill (no cost basis).</div>';
  }
  function legBlock(title, tip, horizon, leg, isDeemphasized) {
    if (!leg || !leg.scoredCount) {
      return '<div style="margin-bottom:12px' + (isDeemphasized ? '; opacity: 0.7; transform: scale(0.95); transform-origin: left top;' : '') + '"><div class="eyebrow" title="' + esc(tip) + '">' + esc(title) + '</div>' +
        '<div class="note">Not enough priced buys for this anchor.</div></div>';
    }
    var win = leg.winRate == null ? '—' : Math.round(leg.winRate * 100) + '% win';
    var n = fmtCount(leg.scoredCount) + ' of ' + fmtCount(leg.tradeCount) + ' buys';
    var sizeStyles = isDeemphasized ? 'font-size: 14px; opacity: 0.8;' : '';
    return '<div style="margin-bottom:12px' + (isDeemphasized ? '; opacity: 0.85;' : '') + '">' +
      '<div class="eyebrow" title="' + esc(tip) + '">' + esc(title) + '</div>' +
      '<div class="note" style="margin:2px 0 6px">' + esc(horizon) + '</div>' +
      '<div class="perf-line net" style="' + sizeStyles + '">' + pctSigned(leg.avgExcess) + ' <span class="muted" style="font-weight:400; font-size: ' + (isDeemphasized ? '13px' : 'inherit') + '">avg excess</span></div>' +
      '<div class="chip">Median excess ' + pctSigned(leg.medianExcess) +
        ' · Avg asset return ' + pctSigned(leg.avgReturn) +
        ' · ' + esc(win) + ' · ' + esc(n) + '</div>' +
      '</div>';
  }
  // Explicit horizon phrase (#1458 note) — the endpoint already returns the
  // requested window (d.window, e.g. "all"); name it instead of the vague
  // "in window" so the stat line reads "12 disclosed buys (All)".
  var horizonPhrase = d.window ? ' (' + esc(windowLabel(d.window)) + ')' : '';
  return legBlock(
      'Their timing (approx.)',
      'Size-weighted average excess return of disclosed equity buys from the trade date to now.  Not portfolio P&L — amounts are brackets and we do not know when (if) they sold.',
      'Variable hold — each buy from the trade date through the latest price.  Avg excess is versus the index; avg asset return is the stock alone.',
      trade,
      true
    ) +
    legBlock(
      'If you bought at filing',
      'Copy-trade: size-weighted excess from the public disclosure date (when a follower could have traded). Matches Top Performers.',
      'Variable hold — each buy from the public filing date through the latest price.  Same end date, later start.',
      filing,
      false
    ) +
    '<div class="note" style="margin-top:4px">Buys only · observational, not a forecast' +
      (buyCount != null ? ' · ' + fmtCount(buyCount) + ' disclosed buys' + horizonPhrase : '') +
      (d.pricesAsOf ? ' · Prices as of ' + esc(fmtAsOf(d.pricesAsOf)) : '') +
      '</div>';
}

/* ---- trade drawer (from the in-memory feed row + lazy source link) ---- */
function openTrade(row) {
  if (!row) return;
  var memberVal = row.filerId
    ? '<span class="clickable" data-member="' + esc(row.filerId) + '" title="Open politician">' + esc(fmtName(row.member)) + '</span>'
    : esc(fmtName(row.member));
  var sideWord = row.type === 'B' || row.type === 'P' ? 'Bought' : row.type === 'S' ? 'Sold' : 'Exchanged';
  var hasTicker = tickerResolved(row.ticker);
  var displayTicker = hasTicker ? String(row.ticker).trim() : '';
  var displayAsset = assetNameFallback(cleanAsset(row.asset || ''), row);
  // Trade drawer leads with the TRANSACTION (kicker + amount); the entity is
  // stated ONCE, as the identity card below. The old "in TKR | Company" line
  // that sat here repeated, verbatim, the card two rows down — with the sticky
  // topbar and the filing note that made four copies of the same asset name on
  // one phone screen. Identity belongs to the card; the topbar keeps only a
  // short breadcrumb token for when the hero has scrolled away.
  // Owner punch list #13(a)/(c): the "POLITICIAN"/"ASSET" eyebrow labels were
  // dropped (self-evident from the avatar+name / logo+ticker below them), and
  // Owner (Self/Spouse/Joint) moved up beside the politician's name instead
  // of sitting in its own row further down in Trade Details.
  var ownerText = ownerLabel(row.owner);
  var ownerBadge = ownerText ? '<span class="drawer-trade-owner muted">' + esc(ownerText) + '</span>' : '';
  // Owner follow-up batch #1 (P1 regression): the badge must be a flex SIBLING
  // after the ellipsized name div, not appended inside it — otherwise a long
  // name (e.g. "David H. McCormick") ellipsizes and swallows the badge.
  var personCard = '<div class="drawer-trade-party' + (row.filerId ? ' clickable' : '') + '"' +
    (row.filerId ? ' data-member="' + esc(row.filerId) + '" title="Open politician"' : '') +
    '><div class="member-cell">' +
    memberAvatarHtml(fmtName(row.member), row.photoUrl, row.party, true) + '<div>' + memberVal + '</div>' + ownerBadge + '</div></div>';
  var assetLabel = displayAsset || displayTicker || '—';
  var assetCard = '<div class="drawer-trade-party' + (displayTicker ? ' clickable' : '') + '"' +
    (displayTicker ? ' data-asset="' + esc(displayTicker) + '" title="Open company"' : '') +
    '><div class="asset-cell">' +
    tickerLogoHtml(displayTicker, assetLabel) + '<div title="' + esc((displayTicker ? displayTicker + '  |  ' : '') + assetLabel) + '">' +
    (displayTicker ? '<span class="tkr">' + esc(displayTicker) + '</span><span class="tkr-gap"></span>' : '') +
    '<span class="muted">' + esc(assetLabel) + '</span></div></div></div>';
  // Explicit CTAs so politician/company paths are obvious (feed rows no longer
  // nest those targets — whole card opens this drawer first).
  var entityActions = '';
  if (row.filerId || displayTicker) {
    entityActions = '<div class="drawer-entity-actions">' +
      (row.filerId
        ? '<button type="button" class="btn ghost sm" onclick="openMember(' + JSON.stringify(String(row.filerId)) + ')">Politician Details</button>'
        : '') +
      (displayTicker
        ? '<button type="button" class="btn ghost sm" onclick="openAsset(' + JSON.stringify(String(displayTicker)) + ')">Company Details</button>'
        : '') +
      '</div>';
  }
  // Owner punch list #13(d): the STOCK Act bracket shown here is exact — only
  // the midpoint used elsewhere is an estimate — so the old "estimated
  // bracket" caption was misleading and is gone.
  var head =
    '<div class="drawer-hero drawer-hero-swap drawer-trade-head">' +
      '<span class="drawer-kicker tag ' + esc(row.type) + '">' + sideWord + '</span>' +
      '<h2 class="drawer-trade-headline">' + esc(amountText(row.min, row.max)) + '</h2>' +
      '<div class="drawer-trade-identity">' + personCard + assetCard + '</div>' +
      entityActions +
    '</div>';
  // Owner punch list #13(b): "Politician" -> "Name", plus a chevron affordance
  // showing the row links out (the click already worked).
  var nameChevron = row.filerId ? ' <span class="kv-chevron" aria-hidden="true">›</span>' : '';
  var summary =
    '<div class="drawer-section"><h3>Trade Details</h3><dl class="drawer-kv">' +
      kvRow('Name', memberVal + nameChevron) +
      kvRow('Traded', esc(dateText(row.txdate))) +
      kvRow('Seen', '<em>' + esc(seenDetailText(row)) + '</em>') +
      kvRow('Official Filed', esc(filedDetailText(row))) +
      kvRow('Disclosure Lag', esc(lagDetailText(row))) +
      kvRow('Asset Type', assetTypeDetailHtml(row)) +
      kvRow('Imported', esc(dateTimeText(row.imported))) +
      (row.source === 'manual' ? kvRow('Source', 'Manual Entry') : '') +
      (row.cleaningNote ? kvRow('Notes', esc(plainCleaningNote(row.cleaningNote))) : '') +
      '</dl><div id="tradeSource"></div></div>';
  // Performance needs a symbol to price against. A muni, a private stake, a
  // rental property or anything else filed without a ticker can NEVER be
  // scored, so the whole section is dropped rather than left showing a promise
  // that will never come true. Options keep their own honest note: the symbol
  // is known, the return simply isn't derivable from the filing.
  var perfInit = row.isOption ? OPTION_PERF_NOTE : PERF_GATE;
  // Owner punch list #13(e): Performance now leads, directly under the
  // name+asset header block, ahead of Trade Details.
  var perf = hasTicker
    ? '<div class="drawer-section first"><h3>Performance Since ' + (row.type === 'S' ? 'Sell' : 'Trade') + '</h3><div id="tradePerf">' + perfInit + '</div></div>'
    : '';
  var rowRef = { sector: row.refSector, marketCap: row.refMarketCap, marketCapBucket: row.refMarketCapBucket, country: row.refCountry, exchangeShort: row.refExchangeShort, assetClass: row.refAssetClass };
  var hasLocalRef = !!(rowRef.sector || rowRef.marketCap != null || rowRef.marketCapBucket || rowRef.country || rowRef.exchangeShort || rowRef.assetClass);
  var profile = hasTicker ? '<div class="drawer-section"><h3>Company</h3><div id="tradeCompany">' + companySectionHtml(rowRef) + '</div></div>' : '';
  // Filing notes that only echo the asset name are a third copy of the entity,
  // not a note — drop them (see the identity comment at the top of openTrade).
  var notesBody = row.rawText ? filingNotesHtml(row.rawText, displayAsset, displayTicker) : '';
  var notes = notesBody ? '<div class="drawer-section"><h3>Filing Notes</h3>' + notesBody + '</div>' : '';
  // "View All Trades of X" / "by Y" opened exactly the same company/politician
  // drawer as the Company Details / Politician Details buttons in the header —
  // one destination, two controls, and another restatement of both names. The
  // header buttons win; only the share link stays here.
  var links = row.id ? '<div class="drawer-section">' + copyLinkHtml('trade', row.id, 'this trade') + '</div>' : '';
  // Owner punch list #13(f): sticky-header one-liner instead of an empty bar,
  // e.g. "SOLD  $1k - $15k  of  ARCC". One entity token only: the ticker when
  // there is one, the asset name when there isn't — the hero identity card
  // carries the full "TKR  |  Company" pairing.
  var topbarAsset = displayTicker || displayAsset || '';
  var topbarTitle = '<strong>' + esc(sideWord.toUpperCase()) + '</strong> ' + esc(amountText(row.min, row.max)) +
    (topbarAsset ? ' <span class="muted">of</span> ' + esc(topbarAsset) : '');
  openDrawer(head + perf + summary + profile + notes + links, topbarTitle);
  // Owner punch list #15: the ticker drawer already resolves full company
  // facts via /api/analytics/ticker/:t (ref); reuse that same source instead
  // of leaving the placeholder up when this row's own ref fields are empty
  // (enrichment lag, or a row that predates it) even though the SAME
  // company's own ticker drawer has the data.
  if (hasTicker && !hasLocalRef) {
    aGet('ticker/' + encodeURIComponent(displayTicker)).then(function (d) {
      var cEl = el('tradeCompany');
      if (cEl && d && d.ref) cEl.innerHTML = companySectionHtml(d.ref);
    }).catch(function () {});
  }
  // Lazy-load the performance line (FMP-gated; "—"/note when unavailable).
  // No resolved ticker means no Performance section was rendered at all, so
  // there is nothing to ask the server for either.
  if (row.id && hasTicker && !row.isOption) {
    aGet('performance/' + encodeURIComponent(row.id)).then(function (d) {
      var pEl = el('tradePerf'); if (pEl) pEl.innerHTML = perfLineHtml(d, row.type);
    }).catch(function () {});
  }
  // Load the source-filing link (checks direct URLs, reconstructed docId, API detail, or official portal fallback).
  var sEl = el('tradeSource');
  if (sEl) {
    var initialUrl = row.pdfUrl || safeDocUrl(row.sourceUrl) || reconstructFilingUrl(row.docId) || fallbackDocPortalUrl(row);
    if (initialUrl) {
      sEl.innerHTML = '<a class="source-link" href="' + esc(initialUrl) + '" target="_blank" rel="noopener">🔗 View source filing</a>';
    }
    if (row.docId) {
      fetch('/api/filings/' + encodeURIComponent(row.docId))
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
          var elNow = el('tradeSource'); if (!elNow) return;
          var url = (d && d.filing && (d.filing.pdfUrl || d.filing.sourceUrl)) || initialUrl || fallbackDocPortalUrl(row);
          if (url) {
            elNow.innerHTML = '<a class="source-link" href="' + esc(url) + '" target="_blank" rel="noopener">🔗 View source filing</a>';
          }
        })
        .catch(function () {});
    }
  }
}
/* Rebuild a document link from its docId (H-YYYY-NNNN, S-NNNN, or numeric PTR ID) */
function reconstructFilingUrl(docId) {
  var s = String(docId || '');
  if (s.slice(0, 2) === 'S-' || s.slice(0, 2) === 'H-') {
    return '/api/documents/' + encodeURIComponent(s) + '/pdf';
  }
  var m = /(\\d{8})/.exec(s);
  if (m) {
    return 'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/' + m[1] + '.pdf';
  }
  return '';
}
function fallbackDocPortalUrl(row) {
  var ch = String((row && (row.chamber || row.memberType)) || '').toLowerCase();
  if (ch.indexOf('senate') !== -1) {
    return 'https://efdsearch.senate.gov/search/';
  }
  return 'https://disclosures-clerk.house.gov/FinancialDisclosure';
}

/* ============================ ACCOUNT (auth + billing) ============================ */
var ME = {
  user: null,
  entitlement: { premium: false, status: null, plan: null, trialing: false },
  admin: { allowed: false },
  billing: { checkoutConfigured: false, portalConfigured: false, hasCustomer: false },
  billingReady: false,
  auth: { appleWeb: false },
};
var selectedPlan = 'monthly';
var checkoutRequestId = null;
var portalRequestId = null;
/* Sticky refusal from POST /billing/checkout's duplicate-subscription guard
   (409 already_subscribed).  Held across the loadMe() repaint that follows, so
   the reason survives; cleared when the modal is opened afresh. */
var pricingBlockedMsg = '';

function isPremium() { return !!(ME.entitlement && ME.entitlement.premium); }
function checkoutConfigured() { return !!(ME.billing && ME.billing.checkoutConfigured); }
function portalConfigured() { return !!(ME.billing && ME.billing.portalConfigured); }
function hasBillingAccount() {
  return !!(ME.billing && ME.billing.hasCustomer) || !!(ME.entitlement && ME.entitlement.status);
}
function canUseAdmin() { return !!(ME.admin && ME.admin.allowed); }
function updatePremiumCues() {
  var unlocked = isPremium() || isAdminView();
  document.querySelectorAll('[data-premium-cue]').forEach(function (node) { node.hidden = unlocked || !checkoutConfigured(); });
}
function applyAdminVisibility() {
  var allowed = canUseAdmin();
  // CSS gate: html:not(.ct-admin) hides every [data-admin-tab] / [data-admin-only]
  // node, so admin chrome never paints before /auth/me resolves.
  document.documentElement.classList.toggle('ct-admin', allowed);
  document.querySelectorAll('[data-admin-tab="true"]').forEach(function (b) { b.hidden = !allowed; });
  // Admin-only blocks inside public views (e.g. the delivery management
  // section on the Alerts tab). Default hidden in markup so anon never
  // flashes them before /auth/me resolves.
  document.querySelectorAll('[data-admin-only]').forEach(function (n) { n.hidden = !allowed; });
  var active = document.querySelector('nav.tabs a.active');
  if (!allowed && active && active.getAttribute('data-admin-tab') === 'true') {
    var trends = document.querySelector('nav.tabs a[data-view="trends"]');
    if (trends) trends.click();
  }
  if (!allowed) {
    if (el('reviewTabBadge')) { el('reviewTabBadge').hidden = true; el('reviewTabBadge').textContent = ''; el('reviewTabBadge').classList.remove('is-on'); }
    setTabBadge('adminTabBadge', 0);
    if (el('kpiReview')) el('kpiReview').textContent = '—';
  }
}

/* Bootstrap identity + entitlement in one call (GET /auth/me). */
function loadMe() {
  return fetch('/auth/me', { headers: { accept: 'application/json' } })
    .then(function (r) { return r.ok ? r.json() : { user: null, entitlement: { premium: false }, admin: { allowed: false }, billing: { checkoutConfigured: false, portalConfigured: false, hasCustomer: false } }; })
    .then(function (d) {
      ME.user = d.user || null;
      ME.entitlement = d.entitlement || { premium: false };
      ME.admin = d.admin || { allowed: false };
      ME.billing = d.billing || { checkoutConfigured: false, portalConfigured: false, hasCustomer: false };
      ME.billingReady = true;
      ME.auth = d.auth || { appleWeb: false };
      renderAccount();
      applyAdminVisibility();
      syncAppleSignInButton();
      updatePremiumCues();
      updateGateRow();
      updateDeliveryGate();
      applyPricingAvailability();
      hiddenCols = loadHiddenCols().filter(function (id) {
        return availableCols().some(function (c) { return c.id === id; });
      });
      renderTradesHeader();
      renderColChooser();
      renderTrades();
    })
    .catch(function () { ME.admin = { allowed: false }; ME.billing = { checkoutConfigured: false, portalConfigured: false, hasCustomer: false }; ME.billingReady = true; ME.auth = { appleWeb: false }; renderAccount(); applyAdminVisibility(); syncAppleSignInButton(); updatePremiumCues(); updateGateRow(); updateDeliveryGate(); applyPricingAvailability(); });
}

/* Header account control: .acct-desktop is the full theme-toggle / Sign In /
   Upgrade (or avatar menu) cluster shown on desktop, unchanged. .acct-mobile
   is a single hamburger button (<=720px, see CSS) whose dropdown carries the
   same Sign In / account entry, theme choices, and Upgrade — flattened (no
   nested menu-in-menu) so it never duplicates the desktop menu's element ids
   (issue #1456: the old 3-button theme toggle overlapped the brand at 375px). */
/* Owner punch list #3: the short footer disclaimer line, reused verbatim
   inside the hamburger menu (below Sign Out / below Upgrade). Keep this in
   sync with the <footer> markup's own copy of the same sentence. */
var FOOTER_DISCLAIMER_TEXT = 'Congress.Trade  ·  educational tool for public STOCK Act (2012) disclosures  ·  not financial advice  ·  $ estimated from brackets  ·  independent/private service not affiliated with or endorsed/sponsored by any government agency';
function acctMobileDisclaimerHtml() {
  return '<div class="footer-disclaimer">' + esc(FOOTER_DISCLAIMER_TEXT) + '</div>';
}
function adminMenuHtml(closeCall) {
  // Premium alone never grants Admin / Review Queue — only a real admin email does.
  if (!canUseAdmin()) return '';
  return '<div class="menu-section-label">Admin</div>' +
    '<button type="button" onclick="' + closeCall + 'showView(\\'admin\\')">Admin</button>' +
    '<button type="button" onclick="' + closeCall + 'showView(\\'review\\')">Review Queue</button>';
}
function canManageSubscription() {
  return !!(ME.user && (hasBillingAccount() || isPremium() || (ME.entitlement && ME.entitlement.source)));
}
function renderAccount() {
  var box = el('acct'); if (!box) return;
  var desktopHtml, mobileHtml;
  // Mobile hamburger button content: the ☰ glyph for signed-out visitors,
  // swapped below for the account avatar (photo, or initials fallback when
  // there is no ME.user.picture) once we know the visitor is signed in.
  var hamburgerHtml = '<span class="acct-hamburger-bars" aria-hidden="true"><span></span><span></span><span></span></span>';
  if (!ME.user) {
    // Sign In + Upgrade as one joined control so they read as a pair, not two orphans.
    // Theme stays out of the signed-out top bar (owner: it dumped Light/Dark/System
    // into the header).  Default is light; theme lives in the hamburger.
    var authGroup = '<span class="acct-auth-group">' +
      '<a class="btn ghost sm" href="/beta" target="_blank" rel="noopener noreferrer" style="text-decoration:none;display:inline-flex;align-items:center;">iOS Beta</a>' +
      '<button class="btn ghost sm" type="button" onclick="openLogin()">Sign In</button>' +
      (checkoutConfigured() ? '<button class="btn sm" type="button" onclick="openPricing()">Upgrade</button>' : '') +
      '</span>';
    desktopHtml = authGroup;
    mobileHtml = '<span class="acct-auth-group">' +
      '<button class="btn ghost sm" type="button" onclick="closeAcctMobileMenu();openLogin()">Sign In</button>' +
      (checkoutConfigured() ? '<button class="btn sm" type="button" onclick="closeAcctMobileMenu();openPricing()">Upgrade</button>' : '') +
      '</span>' +
      '<div class="menu-section-label">Mobile App</div>' +
      '<a class="btn ghost sm" href="/beta" target="_blank" rel="noopener noreferrer" style="width:100%;justify-content:center;text-decoration:none;">iOS Beta (TestFlight)</a>' +
      '<div class="menu-section-label">Appearance</div>' +
      themeRowHtml(null, true) +
      adminMenuHtml('closeAcctMobileMenu();') +
      acctMobileDisclaimerHtml();
  } else {
    var ent = ME.entitlement || {};
    var badge = ent.premium
      ? '<span class="badge premium">' + (ent.trialing ? 'Trial' : 'Premium') + '</span>'
      : '';
    var upgrade = ent.premium || !checkoutConfigured() ? '' : '<button class="btn sm" onclick="openPricing()">Upgrade</button>';
    var label = ME.user.name || ME.user.email || 'Account';
    var avatarHtml = '<span class="avatar lg" title="' + esc(label) + '">' + esc(initials(label)) +
      (ME.user.picture ? '<img src="' + esc(ME.user.picture) + '" alt="" onerror="this.remove()"/>' : '') +
      '</span>';
    // Signed-in mobile visitors get their account avatar on the hamburger
    // button instead of the glyph — the same markup as the desktop avatar,
    // so a dead photo URL degrades to initials via the existing onerror.
    hamburgerHtml = avatarHtml;
    desktopHtml = badge + upgrade +
      '<div class="menu">' +
        '<button class="acct-menu-btn" id="acctMenuBtn" title="Account menu" onclick="toggleAcctMenu()">' +
          avatarHtml +
          '<span class="acct-label">Account</span><span class="acct-caret">▾</span>' +
        '</button>' +
        '<div class="menu-pop" id="acctMenu">' +
          '<div class="who">' + esc(ME.user.email || '') + '</div>' +
          '<div class="menu-section-label">Appearance</div>' +
          themeRowHtml() +
          '<div class="menu-section-label">Account</div>' +
          '<button type="button" onclick="closeAcctMenu();openExportCsvDialog()">Export CSV</button>' +
          '<button type="button" onclick="closeAcctMenu();showView(\\'subs\\')">Delivery</button>' +
          '<a href="/beta" target="_blank" rel="noopener noreferrer" onclick="closeAcctMenu()">iOS Beta (TestFlight)</a>' +
          (canManageSubscription()
            ? '<button type="button" onclick="manageBilling()">Manage Subscription</button>'
            : '') +
          adminMenuHtml('closeAcctMenu();') +
          '<div class="menu-divider"></div>' +
          '<button type="button" onclick="openBugReport()">Report a Bug</button>' +
          '<div class="menu-divider"></div>' +
          '<button type="button" onclick="logout()">Sign Out</button>' +
          '<button type="button" onclick="closeAcctMenu();deleteAccount()">Delete Account</button>' +
        '</div>' +
      '</div>';
    mobileHtml = badge +
      '<div class="who">' + avatarHtml + '<span>' + esc(ME.user.email || label) + '</span></div>' +
      '<div class="menu-section-label">Appearance</div>' +
      themeRowHtml(null, true) +
      '<div class="menu-section-label">Account</div>' +
      '<button type="button" onclick="closeAcctMobileMenu();openExportCsvDialog()">Export CSV</button>' +
      '<button type="button" onclick="closeAcctMobileMenu();showView(\\'subs\\')">Delivery</button>' +
      '<a href="/beta" target="_blank" rel="noopener noreferrer" onclick="closeAcctMobileMenu()">iOS Beta (TestFlight)</a>' +
      upgrade +
      (canManageSubscription()
        ? '<button type="button" onclick="closeAcctMobileMenu();manageBilling()">Manage Subscription</button>'
        : '') +
      adminMenuHtml('closeAcctMobileMenu();') +
      '<div class="menu-divider"></div>' +
      '<button type="button" onclick="closeAcctMobileMenu();openBugReport()">Report a Bug</button>' +
      '<div class="menu-divider"></div>' +
      '<button type="button" onclick="closeAcctMobileMenu();logout()">Sign Out</button>' +
      '<button type="button" onclick="closeAcctMobileMenu();deleteAccount()">Delete Account</button>' +
      acctMobileDisclaimerHtml();
  }
  box.innerHTML =
    '<div class="acct-desktop">' + desktopHtml + '</div>' +
    '<div class="acct-mobile">' +
      '<button type="button" class="acct-hamburger" id="acctHamburgerBtn" aria-expanded="false" aria-controls="acctMobileMenu" aria-label="Account menu" onclick="toggleAcctMobileMenu()">' + hamburgerHtml + '</button>' +
      '<div class="acct-mobile-menu" id="acctMobileMenu">' + mobileHtml + '</div>' +
    '</div>';
}
function toggleAcctMenu() { var m = el('acctMenu'); if (m) m.classList.toggle('open'); }
function closeAcctMenu() { var m = el('acctMenu'); if (m) m.classList.remove('open'); }
function toggleAcctMobileMenu() {
  var m = el('acctMobileMenu'); var btn = el('acctHamburgerBtn');
  if (!m) return;
  var open = !m.classList.contains('open');
  m.classList.toggle('open', open);
  if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
}
function closeAcctMobileMenu() {
  var m = el('acctMobileMenu'); var btn = el('acctHamburgerBtn');
  if (m) m.classList.remove('open');
  if (btn) btn.setAttribute('aria-expanded', 'false');
}
document.addEventListener('click', function (e) {
  var menu = el('acctMenu'), btn = el('acctMenuBtn');
  if (menu && menu.classList.contains('open') && !menu.contains(e.target) && !(btn && btn.contains(e.target))) {
    menu.classList.remove('open');
  }
  var mmenu = el('acctMobileMenu'), mbtn = el('acctHamburgerBtn');
  if (mmenu && mmenu.classList.contains('open') && !mmenu.contains(e.target) && !(mbtn && mbtn.contains(e.target))) {
    closeAcctMobileMenu();
  }
});

/* ---- login modal ---- */
function openLogin() {
  syncAppleSignInButton();
  focusTrapReturnEl = document.activeElement;
  el('loginOverlay').classList.add('open');
  syncBodyScrollLock();
  el('loginMsg').textContent = '';
  var g = document.querySelector('#loginOverlay .gbtn');
  if (g) setTimeout(function () { g.focus(); }, 50);
}
function closeLogin() {
  var wasOpen = el('loginOverlay').classList.contains('open');
  el('loginOverlay').classList.remove('open');
  syncBodyScrollLock();
  if (wasOpen) releaseFocusTrap();
}
function loginGoogle() {
  var msg = el('loginMsg');
  if (msg) msg.textContent = 'Connecting to Google…';
  window.location.href = '/auth/google/start';
}
function loginApple() {
  var msg = el('loginMsg');
  if (msg) msg.textContent = 'Connecting to Apple…';
  window.location.href = '/auth/apple/start';
}
function loginX() {
  var msg = el('loginMsg');
  if (msg) msg.textContent = 'Connecting to X…';
}
function syncAppleSignInButton() {
  var appleBtn = el('appleSignInBtn');
  if (appleBtn) {
    if (ME.auth && ME.auth.appleWeb) {
      appleBtn.style.display = 'flex';
      appleBtn.hidden = false;
      appleBtn.onclick = null;
    } else {
      appleBtn.style.display = 'none';
      appleBtn.hidden = true;
    }
  }
  var xBtn = el('xSignInBtn');
  if (xBtn) {
    if (ME.auth && ME.auth.xWeb) {
      xBtn.style.display = 'flex';
      xBtn.hidden = false;
    } else {
      xBtn.style.display = 'none';
      xBtn.hidden = true;
    }
  }
}
(function markPhoneChrome() {
  try {
    var noHover = window.matchMedia && window.matchMedia('(hover: none)').matches;
    var coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    if (noHover || coarse) document.documentElement.classList.add('phone-chrome');
  } catch (e) {}
})();
function logout() {
  fetch('/auth/logout', { method: 'POST' })
    .then(function () { window.location.reload(); })
    .catch(function () { window.location.reload(); });
}
/**
 * Owner 2026-09-21 ask: bug-report link in the account menu (above Sign Out),
 * going to Sentry's User Feedback widget when configured, falling back to
 * mailto with prefilled context otherwise. Wired for both desktop and mobile
 * hamburger so the surface is consistent. Tapping the button captures the
 * last 30 console messages + current URL + user agent + viewport so the
 * Sentry issue has enough to triage without a back-and-forth.
 */
function openBugReport() {
  var sentry = window.Sentry;
  if (sentry && typeof sentry.showReportDialog === 'function') {
    try {
      sentry.showReportDialog({
        title: 'Report a bug — Congress.Trade',
        subtitle: 'Tell us what broke. The last 30 console messages, the current page, and your account email (if signed in) are attached automatically so we can reproduce.',
        labelName: 'Name',
        labelEmail: 'Your email (optional)',
        labelComments: 'What happened?',
        labelClose: 'Close',
        labelSubmit: 'Send Report',
      });
      return;
    } catch (err) {
      console.warn('Sentry.showReportDialog failed; falling back to mailto', err);
    }
  }
  // Fallback when SENTRY_DSN is unset (CSP tight, no init ran) — same
  // UX intent, owner email + page context pre-filled.
  var ctx = [
    'URL: ' + location.href,
    'UA: ' + navigator.userAgent,
    'Viewport: ' + (window.innerWidth || 0) + 'x' + (window.innerHeight || 0),
    'Account: ' + ((ME && ME.user && ME.user.email) || 'guest'),
  ].join('\\n');
  window.location.href = 'mailto:support@congress.trade?subject=' +
    encodeURIComponent('[Bug] Congress.Trade ' + new Date().toISOString().slice(0, 10)) +
    '&body=' + encodeURIComponent(ctx + '\\n\\n— describe what happened —\\n');
}
function deleteAccount() {
  if (!window.confirm('Delete Account? This permanently deletes your account, delivery subscriptions, and personal information.  Apple subscriptions must also be cancelled in the App Store.  This cannot be undone.')) {
    return;
  }
  fetch('/auth/account/delete', { method: 'POST' })
    .then(function (res) {
      if (!res.ok) throw new Error('delete failed');
      window.location.reload();
    })
    .catch(function () {
      window.alert('Could not delete the account.  Try again or email support@congress.trade.');
    });
}

/* ---- pricing / checkout ---- */
var pricingIntent = 'default';
function newBillingRequestId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  var bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.prototype.map.call(bytes, function (b) { return b.toString(16).padStart(2, '0'); }).join('');
}
function pricingCopy(intent) {
  if (intent === 'alerts') return {
    title: 'Get the Filing First',
    sub: 'Free users see filings when they check the site.  Premium pushes them to you the moment our scout ingests — via signed webhooks or a live SSE stream.',
    features: [
      'Instant filing alerts — signed webhooks (HMAC-verified) to any URL',
      'Live SSE stream of every new filing — no polling',
    ],
  };
  if (intent === 'export') return {
    title: 'Export Full History',
    sub: 'Premium unlocks full-history CSV downloads of every disclosed trade, plus instant delivery via webhook or SSE.',
    features: [
      'Full-history CSV export with ticker, member, type, chamber, and date filters',
      'Instant filing alerts — signed webhooks (HMAC-verified) to any URL',
      'Live SSE stream of every new filing — no polling',
    ],
  };
  return {
    title: 'Premium',
    sub: 'The public dashboard stays free.  Premium gets full-history CSV export and the filing the moment we see it.',
    features: [
      'Full-history CSV export of the filtered trade feed',
      'Instant filing alerts — signed webhooks (HMAC-verified) to any URL',
      'Live SSE stream of every new filing — no polling',
      'Proprietary enrichment data in every payload',
    ],
  };
}
/* Copy for the already-Premium state of the pricing modal.  Sentence gaps are
   NBSP entities, not two ASCII spaces, because this is rendered HTML. */
function pricingPremiumCopy() {
  return (ME.entitlement && ME.entitlement.source === 'apple')
    ? 'You have Premium through the App Store.&nbsp; Manage it in your Apple subscriptions.'
    : 'You have Premium.&nbsp; Manage your plan in the billing portal.';
}
function applyPricingAvailability() {
  var ready = !!ME.billingReady;
  var premium = ready && isPremium();
  /* Never offer a second purchase to someone who already pays.  A Stripe
     Checkout Session on an existing customer opens a SECOND subscription, and
     an Apple IAP subscriber buying here would be billed by Apple and Stripe at
     once.  POST /billing/checkout returns 409 already_subscribed for the same
     reason; pricingBlocked carries that refusal (which also covers past_due,
     where a live subscription exists but the entitlement has lapsed). */
  var blocked = !!pricingBlockedMsg;
  var manage = premium || blocked;
  var available = ready && checkoutConfigured() && !manage;
  if (el('pricingPlans')) el('pricingPlans').hidden = !available;
  if (el('pricingTrialNote')) el('pricingTrialNote').hidden = !available;
  if (el('pricingPremiumNote')) {
    el('pricingPremiumNote').hidden = !premium;
    if (premium) el('pricingPremiumNote').innerHTML = pricingPremiumCopy();
  }
  if (el('subscribeBtn')) {
    el('subscribeBtn').disabled = !available && !manage;
    el('subscribeBtn').textContent = manage
      ? 'Manage Subscription'
      : (!ready ? 'Checking Checkout…' : (available ? 'Start Free Trial' : 'Billing Unavailable'));
  }
  if (el('pricingMsg')) {
    el('pricingMsg').textContent = pricingBlockedMsg || (!ready
      ? 'Checking whether Premium checkout is ready…'
      : (manage || available ? '' : 'Premium checkout is not available yet.'));
  }
}
function openPricing(intent) {
  focusTrapReturnEl = document.activeElement;
  closeAcctMenu();
  pricingBlockedMsg = '';
  pricingIntent = intent || 'default';
  var copy = pricingCopy(pricingIntent);
  if (el('pricingTitle')) el('pricingTitle').textContent = copy.title;
  if (el('pricingSub')) el('pricingSub').textContent = copy.sub;
  if (el('pricingFeatures')) el('pricingFeatures').innerHTML = copy.features.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('');
  // Live, guard-railed proof line (empty unless the measured lead is favorable
  // and well-sampled — a marketed number must never be frozen or forced).
  setPricingProof();
  fetchLatencySummary().then(function () {
    if (el('pricingOverlay').classList.contains('open')) setPricingProof();
  }).catch(function () {});
  selectPlan(selectedPlan);
  /* /pricing redirects to ?pricing=1, which opens this modal from openDeepLink
     after the trades fetch — often BEFORE /auth/me.  Default ME.billing is
     false, so the first paint used to say Billing Unavailable even when
     Stripe was live.  Wait for loadMe, then paint the real state. */
  applyPricingAvailability();
  if (!ME.billingReady) loadMe();
  el('pricingOverlay').classList.add('open');
  syncBodyScrollLock();
  var pricingModal = document.querySelector('#pricingOverlay .modal');
  var pricingFocusable = focusableEls(pricingModal);
  if (pricingFocusable.length) pricingFocusable[0].focus();
}
function closePricing() {
  var wasOpen = el('pricingOverlay').classList.contains('open');
  el('pricingOverlay').classList.remove('open');
  syncBodyScrollLock();
  if (wasOpen) releaseFocusTrap();
}
function selectPlan(p) {
  if (selectedPlan !== ((p === 'annual') ? 'annual' : 'monthly')) checkoutRequestId = null;
  selectedPlan = (p === 'annual') ? 'annual' : 'monthly';
  var m = el('planMonthly'), a = el('planAnnual');
  if (m) m.classList.toggle('sel', selectedPlan === 'monthly');
  if (a) a.classList.toggle('sel', selectedPlan === 'annual');
  var mr = el('planMonthlyRadio'), ar = el('planAnnualRadio');
  if (mr) mr.checked = selectedPlan === 'monthly';
  if (ar) ar.checked = selectedPlan === 'annual';
}
function startCheckout() {
  /* Already paying (or a live subscription the server refused to duplicate) —
     send them to management instead of opening a second subscription.  Apple
     subscribers land on the App Store, Stripe ones on the billing portal. */
  if (isPremium() || pricingBlockedMsg) { closePricing(); manageBilling(); return; }
  if (!checkoutConfigured()) {
    el('pricingMsg').textContent = 'Premium checkout is not available yet.';
    return;
  }
  if (!ME.user) {
    try { sessionStorage.setItem('ct-checkout-intent', selectedPlan); } catch (e) {}
    closePricing(); openLogin(); el('loginMsg').textContent = 'Sign in to start your Premium trial.';
    return;
  }
  var btn = el('subscribeBtn'); if (btn) btn.disabled = true;
  if (!checkoutRequestId) checkoutRequestId = newBillingRequestId();
  el('pricingMsg').textContent = 'Starting secure checkout…';
  fetch('/billing/checkout', { method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': checkoutRequestId }, body: JSON.stringify({ plan: selectedPlan }) })
    .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, status: r.status, j: j }; }); })
    .then(function (res) {
      if (res.ok && res.j && res.j.url) { window.location.href = res.j.url; return; }
      // Preserve the key across ambiguous failures so retry cannot create a
      // second Stripe write. Selecting a different plan starts a new operation.
      if (res.status === 401) { closePricing(); openLogin(); return; }
      if (res.status === 409) {
        /* Duplicate-subscription guard: our ME snapshot was stale (another tab,
           an iOS purchase, or a webhook that landed since sign-in).  Repaint
           from the server rather than trusting the local copy. */
        pricingBlockedMsg = (res.j && res.j.message) || 'You already have a Premium subscription.';
        applyPricingAvailability();
        loadMe();
        return;
      }
      el('pricingMsg').textContent = (res.j && res.j.error) || 'Could not start checkout.';
      if (btn) btn.disabled = false;
    })
    .catch(function () { el('pricingMsg').textContent = 'Network error — try again.'; if (btn) btn.disabled = false; });
}
function manageBilling() {
  closeAcctMenu();
  closeAcctMobileMenu();
  if (!ME.user) { openLogin(); return; }
  var source = ME.entitlement && ME.entitlement.source;
  if (source === 'apple') {
    window.location.href = 'https://apps.apple.com/account/subscriptions';
    return;
  }
  if (!portalConfigured()) { showToast('Billing management is unavailable right now.', true); return; }
  if (!hasBillingAccount() && !isPremium()) { showToast('No billing account found yet.  If you subscribed on iPhone, manage it in the App Store.', true); return; }
  showToast('Opening billing portal…');
  if (!portalRequestId) portalRequestId = newBillingRequestId();
  fetch('/billing/portal', { method: 'POST', credentials: 'same-origin', headers: { 'Idempotency-Key': portalRequestId } })
    .then(function (r) {
      return r.text().then(function (t) {
        var j = {};
        try { j = t ? JSON.parse(t) : {}; } catch (e) { j = { error: 'Could not open billing portal.' }; }
        return { ok: r.ok, status: r.status, j: j };
      });
    })
    .then(function (res) {
      if (res.ok && res.j && res.j.url) { window.location.href = res.j.url; return; }
      if (res.status === 401) { openLogin(); return; }
      if (res.status === 400 && source !== 'apple') {
        showToast((res.j && res.j.error) || 'No billing account found yet.  Contact support if this seems wrong.', true);
        return;
      }
      showToast((res.j && res.j.error) || 'Could not open billing portal.', true);
    })
    .catch(function () { showToast('Network error — try again.', true); });
}

/* ---- Shared filter sync (Trades ↔ Trends) ---- */
function onSharedWindowChange(src) {
  var v = src && src.value ? src.value : '90d';
  document.querySelectorAll('select.shared-window').forEach(function (sel) {
    if (sel !== src && sel.value !== v) sel.value = v;
  });
  if (typeof updateTrWindowLabels === 'function') updateTrWindowLabels();
  if (typeof loadTrends === 'function') loadTrends();
  if (typeof resetTradesPage === 'function') resetTradesPage();
  if (typeof refreshIosFilterSummaries === 'function') refreshIosFilterSummaries();
}
function openExportCsvDialog() {
  if (!ME.user) {
    openLogin();
    showToast('Sign in to export CSV — Premium required for full-history downloads.');
    return;
  }
  if (!isPremium()) {
    openPricing('export');
    return;
  }
  var d = el('exportCsvDialog');
  if (!d) { exportCsv(); return; }
  if (d.parentElement && d.parentElement !== document.body) document.body.appendChild(d);
  try {
    if (d.showModal) d.showModal();
    else exportCsv();
  } catch (e) {
    try { document.body.appendChild(d); if (d.showModal) d.showModal(); else exportCsv(); }
    catch (e2) { exportCsv(); }
  }
}

/* ---- CSV export (Premium; same filters as the live feed toolbar) ---- */
function exportCsv() {
  if (!ME.user) {
    openLogin();
    showToast('Sign in to export CSV — Premium required for full-history downloads.');
    return;
  }
  if (!isPremium()) {
    openPricing('export');
    return;
  }
  var p = tradesFilterParams();
  var qs = p.toString();
  var dlg = el('exportCsvDialog');
  if (dlg && dlg.open) dlg.close();
  // Cookie session is sent automatically with same-origin navigation.
  window.location.href = '/api/export/transactions.csv' + (qs ? ('?' + qs) : '');
}

/* ---- Premium CSV / delivery CTA under the feed pager ----
   Export CSV lives in the Options (⋯) menu on each pager. #gateRow only
   carries the freemium pitch + Start Free Trial (data-premium-cue="export"),
   which hide once premium via updatePremiumCues(). */
function updateGateRow() {
  var g = el('gateRow');
  if (!g) return;
  g.style.display = '';
}

/* Options menu (Columns + Export CSV) on top/bottom pagers. */
function closeFeedOptions() {
  setAll('[data-feed-options-menu]', function (m) { m.classList.remove('open'); });
  setAll('[data-feed-options-btn]', function (b) { b.setAttribute('aria-expanded', 'false'); });
}
function toggleFeedOptions(btn) {
  var wrap = btn && btn.closest ? btn.closest('.feed-options') : null;
  var menu = wrap ? wrap.querySelector('[data-feed-options-menu]') : null;
  if (!menu) return;
  var open = !menu.classList.contains('open');
  closeFeedOptions();
  if (open) {
    menu.classList.add('open');
    if (btn) btn.setAttribute('aria-expanded', 'true');
  }
}
document.addEventListener('click', function (e) {
  if (!e.target || !e.target.closest) return;
  if (e.target.closest('.feed-options')) return;
  closeFeedOptions();
});
var TOAST_TIMER = null;
function showToast(text, isErr) {
  var t = el('toast'); if (!t) return;
  t.textContent = text; t.className = 'toast show' + (isErr ? ' err' : '');
  if (TOAST_TIMER) clearTimeout(TOAST_TIMER);
  TOAST_TIMER = setTimeout(function () { t.className = 'toast'; }, 4200);
}
function copyText(text, successMsg) {
  if (!text) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(function () {
      showToast(successMsg || 'Copied.');
    }).catch(function () {
      showToast('Copy failed. Select and copy the value manually.', true);
    });
  } else {
    showToast('Clipboard unavailable. Select and copy the value manually.', true);
  }
}
function copyFromData(btn) {
  copyText(btn && btn.getAttribute ? (btn.getAttribute('data-copy') || '') : '');
}
/* Surface ?login= / ?checkout= / ?billing= outcomes after a hosted redirect,
   then scrub them from the URL so a refresh doesn't re-toast.
   ?billing=manage is the iOS fallback for website/Stripe Premium: wait
   for /auth/me, then run manageBilling() (portal or Sign In).  Do not treat
   ?billing=portal (Stripe return URL) as a manage request. */
function handleAuthQueryParams() {
  var p = new URLSearchParams(window.location.search);
  var login = p.get('login'), checkout = p.get('checkout');
  var billing = p.get('billing');
  if (login === 'ok') {
    showToast('Signed in.');
    try {
      var intent = sessionStorage.getItem('ct-checkout-intent');
      if (intent === 'monthly' || intent === 'annual') {
        sessionStorage.removeItem('ct-checkout-intent');
        window.__pendingCheckoutIntent = intent;
      }
    } catch (e) {}
  }
  else if (login === 'error') showToast('Sign-in failed — please try again.', true);
  else if (login === 'expired') showToast('That sign-in session expired.  Try Google or Apple again.', true);
  else if (login === 'unverified') showToast('Sign-in failed.  Verify your email with Google first.', true);
  if (checkout === 'success') showToast('🎉 You’re in! Your premium trial is active.');
  else if (checkout === 'cancel') showToast('Checkout canceled — no charge was made.');
  if (billing === 'manage') window.__pendingManageBilling = true;
  if (login || checkout || billing) {
    p.delete('login'); p.delete('checkout'); p.delete('billing');
    var qs = p.toString();
    window.history.replaceState({}, '', window.location.pathname + (qs ? ('?' + qs) : ''));
  }
}

/* Tap-to-reveal tooltips: phones/tablets can't hover, so tapping any element that
   carries an info tooltip (title or .info-tip / .est-money etc.) pops the same text. */
(function () {
  var pop = null;
  function closeTip() { if (pop) { pop.remove(); pop = null; } }
  function tipTextFor(t) {
    var node = t.closest('[data-tip],[title],.info-tip,.est-money');
    if (!node) return null;
    return node.getAttribute('data-tip') || node.getAttribute('title') || (node.getAttribute('aria-label') || '');
  }
  document.addEventListener('click', function (e) {
    // Only act as a tap-tooltip on coarse pointers (touch); desktop keeps native hover.
    if (window.matchMedia && !window.matchMedia('(hover: none)').matches) return;
    if (!e.target || !e.target.closest) return;
    if (pop && pop.contains(e.target)) { closeTip(); return; }
    var node = e.target.closest('[data-tip],.info-tip,.est-money');
    if (!node) { closeTip(); return; }
    var text = node.getAttribute('data-tip') || node.getAttribute('title') || node.getAttribute('aria-label') || '';
    if (!text) return;
    e.preventDefault(); e.stopPropagation();
    closeTip();
    pop = document.createElement('div');
    pop.className = 'tip-pop';
    pop.textContent = text;
    document.body.appendChild(pop);
    var r = node.getBoundingClientRect();
    var pw = Math.min(pop.offsetWidth, window.innerWidth * 0.78);
    var left = Math.max(8, Math.min(r.left, window.innerWidth - pw - 8));
    var top = r.bottom + 8;
    if (top + pop.offsetHeight > window.innerHeight - 8) top = Math.max(8, r.top - pop.offsetHeight - 8);
    pop.style.left = left + 'px'; pop.style.top = top + 'px';
  }, true);
  window.addEventListener('scroll', closeTip, true);
}());


window.addEventListener('popstate', function (e) {
  var urlParams = new URLSearchParams(window.location.search);
  var view = urlParams.get('view') || 'trends';
  var btn = document.querySelector('nav.tabs a[data-view="' + view + '"]');
  if (btn) {
    document.querySelectorAll('nav.tabs a').forEach(function (x) { x.classList.remove('active'); x.setAttribute('aria-selected', 'false'); x.removeAttribute('aria-current'); });
    document.querySelectorAll('.view').forEach(function (v) { v.classList.remove('active'); v.setAttribute('aria-hidden', 'true'); });
    btn.classList.add('active');
    btn.setAttribute('aria-selected', 'true');
    btn.setAttribute('aria-current', 'page');
    if (TAB_PAGE_TITLES[view]) setDocumentTitle(TAB_PAGE_TITLES[view]);
    try { localStorage.setItem('ct-active-tab', view); } catch (e) {}
    document.documentElement.setAttribute('data-view', view);
    var viewEl = el('view-' + view);
    if (viewEl) { viewEl.classList.add('active'); viewEl.setAttribute('aria-hidden', 'false'); }
    if (view === 'trades') {
      requestAnimationFrame(function () {
        syncTradesTableWidth();
      });
    }
  }
  
  if (typeof restoreFiltersFromUrl === 'function') {
    restoreFiltersFromUrl();
  }
  
  if (view === 'trades' && typeof fetchPage === 'function') {
    fetchPage();
  }
});

/* ============================ TABS + BOOT ============================ */
function showView(name, scrollId) {
  var aliases = { feed: 'trades', delivery: 'subs', alerts: 'subs', push: 'subs' };
  var view = aliases.hasOwnProperty(name) ? aliases[name] : name;
  var btn = document.querySelector('nav.tabs a[data-view="' + view + '"]');
  if (!btn) return;
  // Premium alone never grants Admin / Review Queue — this is the same
  // canUseAdmin() gate applyAdminVisibility() uses.  Never force-unhide an
  // admin-only tab for a caller that isn't one (defense in depth: every
  // caller of showView('admin'/'review') already checks canUseAdmin() first
  // via adminMenuHtml, but a hidden <a> in the DOM is still a click away).
  if (btn.getAttribute('data-admin-tab') === 'true' && !canUseAdmin()) {
    showToast('Admin access required.', true);
    return;
  }
  if (typeof btn.click === 'function') btn.click();
  if (scrollId) {
    var node = el(scrollId);
    if (node && node.scrollIntoView) {
      setTimeout(function () { node.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 40);
    }
  }
}
document.querySelectorAll('nav.tabs a').forEach(function (b) {
  b.onclick = function (e) {
    // Tabs are real <a href="/?view=..."> now (SEOSOCIAL-02) so crawlers and
    // ctrl/cmd-click "open in new tab" work; preventDefault keeps the SPA
    // click-to-switch behaviour instead of a full navigation.
    if (e && e.preventDefault) e.preventDefault();
    // Premium alone never grants Admin / Review Queue.  This used to only
    // block a SIGNED-OUT visitor (the "&& !ME.user" clause) — a signed-in Premium
    // non-admin fell through and the tab activated anyway.
    if (b.getAttribute('data-admin-tab') === 'true' && !canUseAdmin()) {
      if (ME.user) { showToast('Admin access required.', true); } else { openLogin(); }
      return;
    }
    // Re-tapping the active tab scrolls back to the top instead of
    // re-running the view's loaders.
    if (b.classList.contains('active') && e && e.isTrusted) { window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    document.querySelectorAll('nav.tabs a').forEach(function (x) { x.classList.remove('active'); x.setAttribute('aria-selected', 'false'); x.removeAttribute('aria-current'); });
    document.querySelectorAll('.view').forEach(function (v) { v.classList.remove('active'); v.setAttribute('aria-hidden', 'true'); });
    b.classList.add('active');
    b.setAttribute('aria-selected', 'true');
    b.setAttribute('aria-current', 'page');
    if (TAB_PAGE_TITLES[b.dataset.view]) setDocumentTitle(TAB_PAGE_TITLES[b.dataset.view]);
    try { localStorage.setItem('ct-active-tab', b.dataset.view); } catch (e) {}
    /* header.top pads out to the active view's content column (--ct-col-max). */
    document.documentElement.setAttribute('data-view', b.dataset.view);
    // Reset chip re-evaluates per view (search text only counts on Trades).
    if (typeof refreshIosFilterSummaries === 'function') refreshIosFilterSummaries();
    try {
      var u = new URL(window.location.href);
      u.searchParams.set('view', b.dataset.view);
      window.history.replaceState({}, '', u.pathname + u.search + u.hash);
    } catch (e) {}
    var view = el('view-' + b.dataset.view);
    if (view) { view.classList.add('active'); view.setAttribute('aria-hidden', 'false'); }
    if (b.dataset.view === 'trades') {
      window.scrollTo({ top: 0, behavior: 'auto' });
      requestAnimationFrame(function () {
        syncTradesTableWidth();
        applyColumnWidthClasses();
      });
    }
    if (b.dataset.view === 'trends') loadTrends();
    if (b.dataset.view === 'people') loadPeopleDirectory();
    if (b.dataset.view === 'review') { loadReview(); loadExtractionIncident(); }
    if (b.dataset.view === 'subs') {
      updateDeliveryGate();
      loadSubs();
      renderSpeedProof();
    }
    if (b.dataset.view === 'admin') { loadAdminList(); loadLogoSetting(); loadPollConfig(); loadHealth(); loadInstrumentPricing(); loadMarketCoverage(); loadDiagnostics(); loadBenchmarkHistory(); renderSpeedProof(); loadLlmSpendPanel(); loadExtractionIncident(); }
  };
});

/* Speed-proof section: fetch just before the Trends copy scrolls into view
   (it now sits at the BOTTOM of the Trends tab — owner UX work order item 1
   — so this defers the fetch rather than firing it during first paint).
   observe() is safe to call even while #trLatencySection's ancestor .view
   isn't the active tab yet (e.g. a returning visitor lands on a different
   tab): the element still has no box until its tab becomes active, and
   IntersectionObserver naturally starts evaluating intersection once it
   does. Browsers without IntersectionObserver render it right away. The
   Admin copy is independent: it renders immediately (not lazily) as soon as
   the Admin tab opens, from the two call sites near the tab-switch handlers. */
(function () {
  var s = el('trLatencySection'); if (!s) return;
  if (!('IntersectionObserver' in window)) { renderSpeedProof(); return; }
  var io = new IntersectionObserver(function (entries) {
    if (entries[0] && entries[0].isIntersecting) { io.disconnect(); renderSpeedProof(); }
  }, { rootMargin: '300px' });
  io.observe(s);
})();
setInterval(refreshSpeedUpdated, 60000);

/* Trends controls: re-run on change; ticker rows/cards open the asset drawer. */
/* no longer binding trWindow/trSource here */ [].forEach(function (id) {
  var e = el(id); if (e) e.addEventListener('change', loadTrends);
});

/* ---- Branch chips: House / Senate / Executive multi-select ----
   Same mental model as party chips (D/R/O): nothing selected means ALL
   branches (no filter). Selecting one or more chips filters to that set.
   Selections persist per view (v2 storage keys). */
var CHAMBER_ALL = ['house', 'senate', 'executive'];
var CHAMBER_DEFAULT = CHAMBER_ALL; // alias for older tests / call sites
function chipSel(groupId) {
  var g = el(groupId); if (!g) return CHAMBER_ALL.slice();
  var on = [];
  g.querySelectorAll('.branch-toggle.on').forEach(function (b) { on.push(b.getAttribute('data-ch')); });
  return on.length ? on : CHAMBER_ALL.slice();
}
function chamberParam(groupId) {
  var sel = chipSel(groupId).slice().sort();
  // Omit param when the effective selection is all branches (no filter).
  return sel.join(',') === CHAMBER_ALL.slice().sort().join(',') ? '' : sel.join(',');
}
function syncChamberChips(sourceId, targetId) {
  var src = el(sourceId); var tgt = el(targetId);
  if (!src || !tgt) return;
  src.querySelectorAll('.branch-toggle').forEach(function(b) {
    var val = b.getAttribute('data-ch');
    var on = b.classList.contains('on');
    var tgtBtn = tgt.querySelector('.branch-toggle[data-ch="' + val + '"]');
    if (tgtBtn) {
      tgtBtn.classList.toggle('on', on);
      tgtBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  });
}

function initChamberChips(groupId, storageKey, onChange, syncTarget) {
  var g = el(groupId); if (!g) return;
  try {
    var saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
    if (Array.isArray(saved) && saved.length) {
      g.querySelectorAll('.branch-toggle').forEach(function (b) {
        var on = saved.indexOf(b.getAttribute('data-ch')) >= 0;
        b.classList.toggle('on', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    }
  } catch (e) {}
  g.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('.branch-toggle') : null;
    if (!b) return;
    var willBeOn = !b.classList.contains('on');
    b.classList.toggle('on', willBeOn);
    b.setAttribute('aria-pressed', willBeOn ? 'true' : 'false');
    // Persist only the ON chips; empty array = all branches (no filter).
    try {
      var on = [];
      g.querySelectorAll('.branch-toggle.on').forEach(function (c) { on.push(c.getAttribute('data-ch')); });
      localStorage.setItem(storageKey, JSON.stringify(on));
    } catch (err) {}
    
    // Sync other chamber filter group
    if (syncTarget) {
      syncChamberChips(groupId, syncTarget);
      var targetStorageKey = 'shared-chambers-v1';
      try {
        var onT = [];
        el(syncTarget).querySelectorAll('.branch-toggle.on').forEach(function (c) { onT.push(c.getAttribute('data-ch')); });
        localStorage.setItem(targetStorageKey, JSON.stringify(onT));
      } catch (err) {}
    }
    
    onChange();
  });
}
initChamberChips('qChamber', 'shared-chambers-v1', function () { refreshIosFilterSummaries(); resetTradesPage(); loadTrends(); }, 'trChamber');
initChamberChips('trChamber', 'shared-chambers-v1', function () { refreshIosFilterSummaries(); resetTradesPage(); loadTrends(); }, 'qChamber');
restoreFiltersFromUrl(); // URL-mirrored filters (ft/fm/fty/fch/fw) win over localStorage

/* One grouped explainer per branch strip: hover opens it on pointer devices,
   tap/click toggles it everywhere (title attrs never show on touch). */
function initBranchInfo(groupId) {
  var g = el(groupId); if (!g) return;
  var btn = g.querySelector('.branch-info');
  var pop = g.querySelector('.branch-pop');
  if (!btn || !pop) return;
  function setOpen(open) {
    pop.hidden = !open;
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  btn.addEventListener('click', function (e) { e.stopPropagation(); setOpen(pop.hidden); });
  var canHover = window.matchMedia && window.matchMedia('(hover: hover)').matches;
  if (canHover) {
    btn.addEventListener('mouseenter', function () { setOpen(true); });
    g.addEventListener('mouseleave', function () { setOpen(false); });
  }
  document.addEventListener('click', function (e) {
    if (!pop.hidden && !g.contains(e.target)) setOpen(false);
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') setOpen(false); });
}
initBranchInfo('qFiltersInfo');
initBranchInfo('trFiltersInfo');

function selectedAssetClass() {
  // Owner 2026-08-14: the All Assets / equities-funds dropdown is gone.
  // Never send assetClass= from the public UI.
  return '';
}
function selectedSideParam(groupId) {
  var g = el(groupId); if (!g) return '';
  var on = [];
  g.querySelectorAll('.side-chip.on').forEach(function (b) { on.push(b.getAttribute('data-side')); });
  return on.length ? on.slice().sort().join(',') : '';
}
/* Multi-select party chips (D/R/O), same mental model as chamber chips: no
   selection = all parties (no filter). Returns the CSV ?party= value the
   feed + Trends analytics both accept (see delivery/rows.ts TxQueryParams
   .partyBuckets and analytics/sql.ts CommonFilters.party). Previously the
   party chips visible on the Trades toolbar only reached loadTrends() —
   selecting one had zero effect on the Trades list or its "N total" (owner
   report #2) because tradesQueryParams() never read them. */
function partySel(groupId) {
  var g = el(groupId); if (!g) return [];
  var on = [];
  g.querySelectorAll('.party-chip.on').forEach(function (b) { on.push(b.getAttribute('data-party')); });
  return on;
}
function partyParam(groupId) {
  var sel = partySel(groupId);
  return sel.length ? sel.slice().sort().join(',') : '';
}
function applyPartySelection(parties) {
  ['qPartyGroup', 'trPartyGroup'].forEach(function (id) {
    var g = el(id); if (!g) return;
    g.querySelectorAll('.party-chip').forEach(function (b) {
      var on = parties.indexOf(b.getAttribute('data-party')) !== -1;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  });
}
function applySideSelection(sides) {
  ['qSideGroup', 'trSideGroup'].forEach(function (id) {
    var g = el(id); if (!g) return;
    g.querySelectorAll('.side-chip').forEach(function (b) {
      var on = sides.indexOf(b.getAttribute('data-side')) !== -1;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  });
}
function initPartyChips() {
  var KEY = 'shared-parties-v1';
  try {
    var saved = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (Array.isArray(saved)) applyPartySelection(saved);
  } catch (_e) { /* ignore */ }
  function onPartyClick(e) {
    var b = e.target.closest ? e.target.closest('.party-chip') : null;
    if (!b) return;
    b.classList.toggle('on');
    b.setAttribute('aria-pressed', b.classList.contains('on') ? 'true' : 'false');
    var on = [];
    (b.parentElement || b).querySelectorAll('.party-chip.on').forEach(function (c) {
      on.push(c.getAttribute('data-party'));
    });
    // Prefer reading from the group that was clicked
    var g = b.closest('.party-chips');
    if (g) {
      on = [];
      g.querySelectorAll('.party-chip.on').forEach(function (c) { on.push(c.getAttribute('data-party')); });
    }
    applyPartySelection(on);
    try { localStorage.setItem(KEY, JSON.stringify(on)); } catch (_e2) { /* */ }
    if (typeof refreshIosFilterSummaries === 'function') refreshIosFilterSummaries();
    if (typeof loadTrends === 'function') loadTrends();
    if (typeof resetTradesPage === 'function') resetTradesPage();
  }
  ['qPartyGroup', 'trPartyGroup'].forEach(function (id) {
    var g = el(id); if (g) g.addEventListener('click', onPartyClick);
  });
}
function initSideChips() {
  var KEY = 'shared-sides-v1';
  try {
    var saved = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (Array.isArray(saved)) applySideSelection(saved);
  } catch (_e) { /* */ }
  function onSideClick(e) {
    var b = e.target.closest ? e.target.closest('.side-chip') : null;
    if (!b) return;
    b.classList.toggle('on');
    b.setAttribute('aria-pressed', b.classList.contains('on') ? 'true' : 'false');
    var g = b.closest('.side-chips');
    var on = [];
    if (g) g.querySelectorAll('.side-chip.on').forEach(function (c) { on.push(c.getAttribute('data-side')); });
    applySideSelection(on);
    try { localStorage.setItem(KEY, JSON.stringify(on)); } catch (_e2) { /* */ }
    if (typeof refreshIosFilterSummaries === 'function') refreshIosFilterSummaries();
    if (typeof loadTrends === 'function') loadTrends();
    if (typeof resetTradesPage === 'function') resetTradesPage();
  }
  ['qSideGroup', 'trSideGroup'].forEach(function (id) {
    var g = el(id); if (g) g.addEventListener('click', onSideClick);
  });
}
initPartyChips();
initSideChips();
// URL wins over localStorage for party/side (chamber/window already restored above).
restoreFiltersFromUrl();
function closeIosFilterMenus(except) {
  document.querySelectorAll('.ios-filter').forEach(function (f) {
    if (except && f === except) return;
    var pop = f.querySelector('.ios-filter-pop');
    var btn = f.querySelector('.ios-filter-btn');
    if (pop) pop.hidden = true;
    if (btn) btn.setAttribute('aria-expanded', 'false');
  });
}
function placeIosFilterPop(btn, pop) {
  if (!btn || !pop) return;
  pop.style.position = 'fixed';
  pop.style.visibility = 'hidden';
  pop.hidden = false;
  var r = btn.getBoundingClientRect();
  var w = pop.offsetWidth || 196;
  var left = r.left;
  if (left + w > window.innerWidth - 8) left = Math.max(8, window.innerWidth - w - 8);
  pop.style.top = Math.round(r.bottom + 6) + 'px';
  pop.style.left = Math.round(left) + 'px';
  pop.style.zIndex = '80';
  pop.style.visibility = '';
}
function repositionOpenIosFilters() {
  document.querySelectorAll('.ios-filter').forEach(function (f) {
    var pop = f.querySelector('.ios-filter-pop');
    var btn = f.querySelector('.ios-filter-btn');
    if (pop && btn && !pop.hidden) placeIosFilterPop(btn, pop);
  });
}
function syncChromeMetrics() {
  var header = document.querySelector('header.top');
  var mainEl = document.querySelector('main');
  if (header) {
    document.documentElement.style.setProperty('--ct-header-h', header.getBoundingClientRect().height + 'px');
    var brand = header.querySelector('.brand');
    if (brand) document.documentElement.style.setProperty('--ct-brand-h', Math.round(brand.getBoundingClientRect().bottom) + 'px');
  }
  if (mainEl) {
    /* Horizontal inset, not padding-top (that is 0 so the filter strip
       can sit in the white header). */
    document.documentElement.style.setProperty('--ct-main-pad', getComputedStyle(mainEl).paddingLeft);
  }
}
function refreshIosFilterSummaries() {
  // Empty-state chip text: on wide desktops the chip names its dimension
  // ("Branches" / "Parties" / "Types") so the row reads as three filters at a
  // glance; below 1200px the shorter "All" (sides: icons only) keeps the row
  // beside the wordmark on one line.  Re-run on resize (initIosFilterMenus).
  var wide = false;
  try { wide = !!(window.matchMedia && window.matchMedia('(min-width: 1200px)').matches); } catch (_e) {}
  function setSummary(id, text, has) {
    var f = el(id); if (!f) return;
    var lbl = f.querySelector('[data-ios-summary]');
    if (lbl) { lbl.textContent = text || ''; lbl.title = text || ''; }
    f.classList.toggle('has-sel', !!has);
  }
  function chamberSummary(id) {
    var g = el(id); if (!g) return;
    var on = [];
    g.querySelectorAll('.branch-toggle.on').forEach(function (b) { on.push(b.textContent.trim()); });
    setSummary(id, on.length ? on.join('+') : (wide ? 'Branches' : 'All'), on.length > 0);
  }
  function partySummary(id) {
    var g = el(id); if (!g) return;
    var on = [];
    g.querySelectorAll('.party-chip.on').forEach(function (b) { on.push(b.getAttribute('data-party')); });
    setSummary(id, on.length ? on.join('+') : (wide ? 'Parties' : 'All'), on.length > 0);
  }
  function sideSummary(id) {
    var g = el(id); if (!g) return;
    var on = [];
    g.querySelectorAll('.side-chip.on').forEach(function (b) {
      var s = b.getAttribute('data-side');
      on.push(s === 'B' ? 'Buys' : s === 'S' ? 'Sells' : 'Exch');
    });
    setSummary(id, on.length ? on.join('+') : (wide ? 'Types' : ''), on.length > 0);
  }
  chamberSummary('qChamber'); chamberSummary('trChamber');
  partySummary('qPartyGroup'); partySummary('trPartyGroup');
  sideSummary('qSideGroup'); sideSummary('trSideGroup');
  // Reset chip: visible only once something departs from the defaults
  // (any chip on, a non-90d window, or search text on Trades).
  var resetBtn = el('ctFilterReset');
  if (resetBtn) {
    var dirty = !!document.querySelector('#tradesSharedFilters .ios-filter.has-sel');
    var win = el('tradesGlobalWindow');
    if (win && win.value !== '90d') dirty = true;
    var q = el('qSearch');
    if (q && q.value && document.documentElement.getAttribute('data-view') === 'trades') dirty = true;
    resetBtn.hidden = !dirty;
  }
}
/* Header "Reset" chip: back to the defaults (all branches / parties /
   sides, 3-month window, empty search) in one tap. */
function resetSharedFilters() {
  document.querySelectorAll('.branch-toggle').forEach(function (b) {
    b.classList.remove('on'); b.setAttribute('aria-pressed', 'false');
  });
  try { localStorage.setItem('shared-chambers-v2', JSON.stringify([])); localStorage.setItem('shared-chambers-v1', JSON.stringify([])); } catch (_e) {}
  if (typeof applyPartySelection === 'function') applyPartySelection([]);
  try { localStorage.setItem('shared-parties-v1', JSON.stringify([])); } catch (_e) {}
  if (typeof applySideSelection === 'function') applySideSelection([]);
  try { localStorage.setItem('shared-sides-v1', JSON.stringify([])); } catch (_e) {}
  var win = el('tradesGlobalWindow');
  document.querySelectorAll('select.shared-window').forEach(function (sel) { sel.value = '90d'; });
  var q = el('qSearch');
  if (q) q.value = '';
  // One fetch: onSharedWindowChange → resetTradesPage() refetches with the
  // cleared search; cancel any pending debounced search fetch first.
  if (typeof tradesSearchTimer !== 'undefined' && tradesSearchTimer) { clearTimeout(tradesSearchTimer); tradesSearchTimer = null; }
  if (typeof onSharedWindowChange === 'function') onSharedWindowChange(win || { value: '90d' });
  refreshIosFilterSummaries();
  if (typeof syncFilterUrl === 'function') syncFilterUrl();
}
/* Phone top band reads "50/pg"; desktop keeps "50 rows". */
function syncPageSizeLabels() {
  var short = false;
  try { short = document.documentElement.classList.contains('phone-chrome') || (window.matchMedia && window.matchMedia('(max-width: 768px)').matches); } catch (_e) {}
  document.querySelectorAll('[data-page-size] option').forEach(function (o) {
    o.textContent = short ? o.value + '/pg' : o.value + ' rows';
  });
}
function initIosFilterMenus() {
  document.addEventListener('click', function (e) {
    var clear = e.target.closest ? e.target.closest('[data-ios-clear]') : null;
    if (clear) {
      var kind = clear.getAttribute('data-ios-clear');
      if (kind === 'chamber') {
        document.querySelectorAll('.branch-toggle').forEach(function (b) {
          b.classList.remove('on'); b.setAttribute('aria-pressed', 'false');
        });
        try { localStorage.setItem('shared-chambers-v2', JSON.stringify([])); } catch (_e) {}
      } else if (kind === 'party') {
        applyPartySelection([]);
        try { localStorage.setItem('shared-parties-v1', JSON.stringify([])); } catch (_e) {}
      } else if (kind === 'side') {
        applySideSelection([]);
        try { localStorage.setItem('shared-sides-v1', JSON.stringify([])); } catch (_e) {}
      }
      refreshIosFilterSummaries();
      if (typeof loadTrends === 'function') loadTrends();
      if (typeof resetTradesPage === 'function') resetTradesPage();
      return;
    }
    var btn = e.target.closest ? e.target.closest('.ios-filter-btn') : null;
    if (btn) {
      var wrap = btn.closest('.ios-filter');
      var pop = wrap && wrap.querySelector('.ios-filter-pop');
      var open = pop && pop.hidden;
      closeIosFilterMenus(open ? wrap : null);
      if (pop) {
        if (open) placeIosFilterPop(btn, pop);
        else pop.hidden = true;
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      }
      e.preventDefault();
      return;
    }
    if (!e.target.closest || !e.target.closest('.ios-filter-pop')) closeIosFilterMenus(null);
  });
  window.addEventListener('scroll', repositionOpenIosFilters, true);
  window.addEventListener('resize', function () {
    syncChromeMetrics();
    repositionOpenIosFilters();
    syncPageSizeLabels();
    refreshIosFilterSummaries();
  });
  refreshIosFilterSummaries();
}
initIosFilterMenus();
syncPageSizeLabels();
syncChromeMetrics();
if (typeof ResizeObserver !== 'undefined') {
  var chromeRo = new ResizeObserver(syncChromeMetrics);
  var chromeHeader = document.querySelector('header.top');
  var chromeMain = document.querySelector('main');
  if (chromeHeader) chromeRo.observe(chromeHeader);
  if (chromeMain) chromeRo.observe(chromeMain);
}
(function () { var ts = el('trTickerSort'); if (ts) ts.addEventListener('change', loadTrTickers); })();
/* Trends fold cards (mobile-only show/hide): CSS alone can't force a
   <details> open, so on desktop widths (above this file's 768px mobile
   breakpoint) JS keeps every details.trends-fold expanded — including after
   a resize/rotation crosses the breakpoint while a card was collapsed. */
function forceTrendsFoldOpenAtDesktop() {
  if (!window.matchMedia || !window.matchMedia('(min-width: 769px)').matches) return;
  document.querySelectorAll('#view-trends details.trends-fold').forEach(function (d) {
    if (!d.open) d.open = true;
  });
}
forceTrendsFoldOpenAtDesktop();
window.addEventListener('resize', forceTrendsFoldOpenAtDesktop);
/* Map a /api/client/v1 trade envelope item into the trades-row shape openTrade expects. */
function clientTradeToRow(item) {
  if (!item) return null;
  var m = item.member || {};
  var a = item.asset || {};
  var t = item.transaction || {};
  var f = item.filing || {};
  return {
    filed: toISODate(f.filedDate) || '',
    member: m.name || m.id || 'Unknown',
    photoUrl: m.photoUrl || '',
    st: m.state || '',
    chamber: m.chamber || '',
    asset: cleanAsset(a.name || ''),
    ticker: a.ticker || '',
    assetType: a.type || '',
    assetTypeName: '',
    type: (t.type === 'P' ? 'B' : t.type) || 'B',
    min: t.amountMin, max: t.amountMax,
    txdate: toISODate(t.date) || '',
    owner: t.owner || '',
    conf: typeof item.confidence === 'number' ? item.confidence : 1,
    source: item.source || 'primary',
    filedDate: f.filedDate || '',
    firstSeenAt: f.firstSeenAt || '',
    imported: '',
    cursorSeq: item.cursor || 0,
    disclosureLagDays: null,
    stockActStatus: '',
    id: item.id || '',
    docId: item.docId || '',
    filerId: m.id || '',
    isOption: !!t.isOption,
    rawText: '',
    refSector: a.sector || '',
    refMarketCap: null,
    refMarketCapBucket: a.marketCapBucket || '',
    refCountry: '',
    refExchangeShort: '',
    refAssetClass: '',
    refCompanyName: a.name || '',
    cleaningNote: '',
    pdfUrl: '',
    sourceUrl: f.sourceUrl || ''
  };
}
function openTradeById(id) {
  if (!id) return;
  if (TRADE_BY_ID[id]) { openTrade(TRADE_BY_ID[id]); return; }
  for (var i = 0; i < TRADES.length; i++) {
    if (TRADES[i].id === id) { openTrade(TRADES[i]); return; }
  }
  // Deep links and drawer rows outside the current feed page: resolve by id.
  openDrawer('<div class="note">Loading trade…</div>', 'Loading trade…');
  fetch('/api/client/v1/trade/' + encodeURIComponent(id), { headers: { accept: 'application/json' } })
    .then(function (r) {
      if (r.status === 404) throw new Error('not_found');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function (d) {
      var item = (d && d.item) || (d && d.items && d.items[0]) || null;
      var row = clientTradeToRow(item);
      if (!row || !row.id) {
        openDrawer('<div class="note">That trade could not be loaded. It may have been retracted or the link is incomplete.</div>', 'Trade unavailable');
        return;
      }
      rememberTradeRow(row);
      openTrade(row);
    })
    .catch(function (e) {
      if (e && e.message === 'not_found') {
        openDrawer('<div class="note">That trade was not found. It may have been retracted or the share link is outdated.</div>', 'Trade not found');
      } else {
        openDrawer('<div class="note">Could not load that trade' + (e && e.message && e.message !== 'not_found' ? ': ' + esc(e.message) : '') + '.</div>', 'Could not load trade');
      }
    });
}
/* Restore a shared deep link (?ticker= / ?member= / ?trade=). Trade ids resolve
   via GET /api/client/v1/trade/:id when they are not already in the loaded feed. */
function openDeepLink() {
  try {
    var sp = new URLSearchParams(window.location.search);
    var ticker = sp.get('ticker');
    var member = sp.get('member');
    var trade = sp.get('trade');
    var authError = sp.get('auth_error');
    var pricing = sp.get('pricing');
    if (authError === 'google_not_configured') {
      openLogin();
      var msg = el('loginMsg');
      if (msg) msg.textContent = 'Google Sign-In is not configured on this server.  Use Sign In with Apple.';
      return;
    }
    if (authError === 'apple_not_configured' || authError === 'apple_web_not_configured') {
      openLogin();
      var amsg = el('loginMsg');
      if (amsg) amsg.textContent = 'Sign In with Apple is not configured for this site yet.  Use Google.';
      return;
    }
    if (pricing === '1' || pricing === 'true' || pricing === 'alerts' || pricing === 'export') {
      openPricing(pricing === 'alerts' || pricing === 'export' ? pricing : 'default');
      return;
    }
    if (ticker) { openAsset(ticker); return; }
    if (member) { openMember(member); return; }
    if (trade) openTradeById(trade);
  } catch (e) {}
}
/* App-wide entity open: politician / company / trade from any surface
   (feed, Trends, People, drawers, consensus cards). Priority:
   member → asset/ticker → trade id so nested names win over the row. */
function handleTradesOpenEvent(e) {
  return handleEntityOpenEvent(e);
}
function handleEntityOpenEvent(e) {
  if (!e || !e.target || !e.target.closest) return false;
  // Real navigation / form controls keep default behavior.
  if (e.target.closest('a[href]:not(.clickable)')) return false;
  if (e.target.closest('button, input, select, textarea, label, option')) return false;
  if (e.target.closest('.drawer-close, .drawer-backdrop, .panel-close')) return false;
  // Trades feed (table rows + mobile cards): entire surface opens trade details.
  // Nested politician/company targets were removed from feed cells; those live
  // in the trade drawer as explicit buttons + clickable identity cards.
  var feedHit = e.target.closest('#tradesBody tr[data-txid], #tradesCards article.trades-card[data-txid], article.trades-card[data-txid]');
  if (feedHit && feedHit.getAttribute('data-txid')) {
    if (e.preventDefault) e.preventDefault();
    openTradeById(feedHit.getAttribute('data-txid'));
    return true;
  }
  var m = e.target.closest('[data-member]');
  if (m && m.getAttribute('data-member')) {
    if (e.preventDefault) e.preventDefault();
    openMember(m.getAttribute('data-member'));
    return true;
  }
  var a = e.target.closest('[data-asset]');
  if (a && a.getAttribute('data-asset')) {
    if (e.preventDefault) e.preventDefault();
    openAsset(a.getAttribute('data-asset'));
    return true;
  }
  // Legacy data-ticker (same as data-asset) used by older Trends markup.
  var t = e.target.closest('[data-ticker]');
  if (t && t.getAttribute('data-ticker')) {
    if (e.preventDefault) e.preventDefault();
    openAsset(t.getAttribute('data-ticker'));
    return true;
  }
  var row = e.target.closest('[data-txid]');
  if (row && row.getAttribute('data-txid')) {
    if (e.preventDefault) e.preventDefault();
    openTradeById(row.getAttribute('data-txid'));
    return true;
  }
  return false;
}
(function () {
  document.addEventListener('click', function (e) {
    handleEntityOpenEvent(e);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var hit = e.target && e.target.closest
      ? e.target.closest('[data-member],[data-asset],[data-ticker],[data-txid].clickable, .clickable[data-txid], article.trades-card[data-txid], .ccard[data-asset], .ccard[data-ticker]')
      : null;
    if (!hit) return;
    // Only trap keyboard on explicit interactive targets (not every table cell).
    if (!hit.classList.contains('clickable') && hit.tagName !== 'ARTICLE' && !hit.classList.contains('ccard') && !hit.classList.contains('trades-card')) return;
    e.preventDefault();
    handleEntityOpenEvent(e);
  });
})();

/* Universal keyboard reachability for entity-open targets (owner UX work
   order item 2): every .clickable element carrying a data-member/data-asset/
   data-ticker/data-txid attribute — built dynamically across dozens of
   render functions (Trends leaderboards, cluster cards, People directory,
   drawers, the feed table) — becomes Tab-focusable with button semantics
   the moment it lands in the DOM. The delegated keydown handler just above
   already fires Enter/Space on any focused .clickable[data-*] target; this
   makes sure there IS something to focus, instead of hand-adding
   tabindex/role at every call site (and risking missing one). Native <a>/
   <button> targets are left alone — they're already focusable and carry
   their own semantics. Scoped to entity-open targets only: other .clickable
   UI (copy-link, etc.) is untouched. */
var ENTITY_FOCUSABLE_SELECTOR = '.clickable[data-member], .clickable[data-asset], .clickable[data-ticker], .clickable[data-txid]';
function makeEntityTargetsFocusable(root) {
  if (!root || root.nodeType !== 1) return;
  var nodes = root.querySelectorAll ? Array.prototype.slice.call(root.querySelectorAll(ENTITY_FOCUSABLE_SELECTOR)) : [];
  if (root.matches && root.matches(ENTITY_FOCUSABLE_SELECTOR)) nodes.push(root);
  nodes.forEach(function (n) {
    if (n.tagName === 'A' || n.tagName === 'BUTTON') return;
    // A row that already carries its own real, named open-control (added at
    // its render site — see rowOpenBtnHtml()) does not need the <tr> itself
    // to be a second, semantically-empty tab stop for the same action.
    if (n.tagName === 'TR' && n.querySelector('.row-open-btn')) return;
    if (!n.hasAttribute('tabindex')) n.setAttribute('tabindex', '0');
    // TR/TH/TD keep their native row/columnheader/cell roles (WEBA11Y-01):
    // role="button" on a table row destroys table semantics for screen
    // readers (no column-header association, aria-sort becomes invalid).
    // These stay keyboard-activatable via tabindex + the delegated
    // Enter/Space handler above, which keys off the .clickable class, not role.
    if (n.tagName === 'TR' || n.tagName === 'TH' || n.tagName === 'TD') return;
    if (!n.hasAttribute('role')) n.setAttribute('role', 'button');
  });
}
makeEntityTargetsFocusable(document.body);
if ('MutationObserver' in window) {
  new MutationObserver(function (mutations) {
    for (var i = 0; i < mutations.length; i++) {
      var added = mutations[i].addedNodes;
      for (var j = 0; j < added.length; j++) {
        if (added[j].nodeType === 1) makeEntityTargetsFocusable(added[j]);
      }
    }
  }).observe(document.body, { childList: true, subtree: true });
}

/* Escape closes transient overlays. */
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') { closePanels(); closeDrawer(); closeLogin(); closePricing(); }
  // "/" focuses the header search on Trades (not while typing, no modifiers).
  if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    var t = e.target;
    var typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    var q = el('qSearch');
    var menuOpen = !!document.querySelector('.ios-filter-pop:not([hidden]), .menu-pop.open, .acct-mobile-menu.open');
    if (!typing && !menuOpen && q && document.documentElement.getAttribute('data-view') === 'trades' && !openOverlayContainer()) {
      e.preventDefault(); q.focus(); q.select();
    }
  }
});

// Build the feed header from the column registry (also attaches sort handlers).
renderTradesHeader();

// Column chooser: toggle a column's visibility when its checkbox changes.
(function () {
  var box = el('colChooserBody');
  var draggingCol = null;
  if (box) box.addEventListener('change', function (e) {
    var cb = e.target;
    if (cb && cb.getAttribute && cb.getAttribute('data-colid')) {
      onColToggle(cb.getAttribute('data-colid'), cb.checked);
    }
  });
  if (box) box.addEventListener('dragstart', function (e) {
    var item = e.target && e.target.closest ? e.target.closest('.colopt[data-colid]') : null;
    if (!item) return;
    draggingCol = item.getAttribute('data-colid');
    item.classList.add('dragging');
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', draggingCol);
    }
  });
  if (box) box.addEventListener('dragover', function (e) {
    var item = e.target && e.target.closest ? e.target.closest('.colopt[data-colid]') : null;
    if (!draggingCol || !item || item.getAttribute('data-colid') === draggingCol) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  });
  if (box) box.addEventListener('drop', function (e) {
    var item = e.target && e.target.closest ? e.target.closest('.colopt[data-colid]') : null;
    var target = item && item.getAttribute('data-colid');
    var drag = draggingCol || (e.dataTransfer && e.dataTransfer.getData('text/plain'));
    if (!drag || !target || drag === target) return;
    e.preventDefault();
    moveColumn(drag, target);
  });
  if (box) box.addEventListener('dragend', function () {
    draggingCol = null;
    box.querySelectorAll('.colopt.dragging').forEach(function (n) { n.classList.remove('dragging'); });
  });
})();

window.addEventListener('resize', function () { syncTradesTableWidth(); applyColumnWidthClasses(); });

// Apply resolved theme (default light; respects light|dark|system pref).
applyTheme(resolveTheme(readThemePref()));

// Initial loading states + boot.
el('tradesBody').innerHTML = stateRow(visibleCols().length, 'Loading live feed…');
el('reviewBody').innerHTML = stateRow(5, 'Loading…');
el('subsBody').innerHTML = stateRow(6, 'Loading…');
el('healthBody').innerHTML = stateRow(9, 'Loading…');
el('marketCoverage').innerHTML = '<div class="state">Loading market-data coverage…</div>';
el('diagConnections').innerHTML = '<div class="state">Loading connection status…</div>';
el('diagSettings').innerHTML = stateRow(4, 'Loading…');
el('diagErrors').innerHTML = stateRow(4, 'Loading…');
el('diagUsers').innerHTML = '<div class="state">Loading users…</div>';
el('diagLogins').innerHTML = stateRow(4, 'Loading…');
if (el('diagPremiumCards')) el('diagPremiumCards').innerHTML = '<div class="state">Loading Premium members…</div>';
if (el('diagPremiumRoster')) el('diagPremiumRoster').innerHTML = stateRow(7, 'Loading…');
if (el('benchmarkModelCheckboxes')) el('benchmarkModelCheckboxes').innerHTML = benchmarkModelCheckboxesHtml();

// ?view= aliases must accept the visible tab names (#1458): Directory is
// people, Delivery is subs. "feed" is the Trades tab's PRE-RENAME id (batch
// #25 — "trades" is now canonical in the URL and in localStorage; "feed"
// stays a silent legacy alias so old bookmarked/shared links never break).
var VIEW_ALIASES = { feed: 'trades', delivery: 'subs', directory: 'people' };
function resolveViewId(raw) {
  var key = String(raw || '').trim().toLowerCase();
  if (!key) return '';
  return Object.prototype.hasOwnProperty.call(VIEW_ALIASES, key) ? VIEW_ALIASES[key] : key;
}

// Load user identity/permissions, then restore the saved tab so admin-gated tabs fallback properly if needed
applyAdminVisibility(); // anon default: html.ct-admin off until /auth/me says otherwise
loadMe().then(function () {
  if (window.__pendingCheckoutIntent && ME.user) {
    selectedPlan = window.__pendingCheckoutIntent;
    startCheckout();
  }
  if (canUseAdmin()) loadReview(); // account state + admin tab visibility
  if (canUseAdmin()) loadPollConfig(); // poll-mode KPI — session-based admin resolved after boot
  loadExtractionIncident();
  var initialView = 'trends';
  try {
    var fromUrl = new URLSearchParams(window.location.search).get('view');
    if (!fromUrl) {
      var path = window.location.pathname || '/';
      while (path.length > 1 && path.charAt(path.length - 1) === '/') path = path.slice(0, -1);
      if (path === '/admin') fromUrl = 'admin';
      if (path === '/review') fromUrl = 'review';
    }
    if (fromUrl) {
      // Visible names + legacy ids (#1458): directory→people, delivery→subs,
      // feed→trades. Case-insensitive. Unknown values fall back to Trends,
      // not the last-viewed tab — a typo'd or stale ?view= should never
      // silently resurrect an old session. Tabs are <a>, not <button>
      // (web-mobile chrome on main).
      var canonicalView = resolveViewId(fromUrl);
      initialView = document.querySelector('nav.tabs a[data-view="' + canonicalView + '"]') ? canonicalView : 'trends';
    } else {
      var saved = localStorage.getItem('ct-active-tab');
      // Same alias table for a stored last-viewed tab — old "feed" still
      // lands on Trades and is migrated to the canonical id in place.
      var canonicalSaved = resolveViewId(saved);
      if (canonicalSaved && document.querySelector('nav.tabs a[data-view="' + canonicalSaved + '"]')) {
        initialView = canonicalSaved;
        if (canonicalSaved !== saved) { try { localStorage.setItem('ct-active-tab', canonicalSaved); } catch (e2) {} }
      }
    }
  } catch (e) {}
  // Admin-gated views (data-admin-tab) must never activate for a non-admin,
  // even via direct ?view=admin/?view=review navigation or the /admin,
  // /review paths above — the tab bar hides the button, but until this
  // check the CONTENT PANE still went active underneath it regardless.
  // Falls back to Trends, matching the "unknown ?view=" behavior below.
  if (initialView !== 'trends') {
    var initialViewBtn = document.querySelector('nav.tabs a[data-view="' + initialView + '"]');
    if (initialViewBtn && initialViewBtn.getAttribute('data-admin-tab') === 'true' && !canUseAdmin()) {
      initialView = 'trends';
    }
  }
  try {
    var u0 = new URL(window.location.href);
    if (u0.searchParams.get('view') !== initialView) {
      u0.searchParams.set('view', initialView);
      window.history.replaceState({}, '', u0.pathname + u0.search + u0.hash);
    }
  } catch (e) {}

  var initialBtn = document.querySelector('nav.tabs a[data-view="' + initialView + '"]');
  if (initialBtn && initialView !== 'trends') {
    document.querySelectorAll('nav.tabs a').forEach(function (x) { x.classList.remove('active'); x.setAttribute('aria-selected', 'false'); x.removeAttribute('aria-current'); });
    document.querySelectorAll('.view').forEach(function (v) { v.classList.remove('active'); v.setAttribute('aria-hidden', 'true'); });
    initialBtn.classList.add('active');
    initialBtn.setAttribute('aria-selected', 'true');
    initialBtn.setAttribute('aria-current', 'page');
    document.documentElement.setAttribute('data-view', initialView);
    if (typeof refreshIosFilterSummaries === 'function') refreshIosFilterSummaries();
    // Restoring a non-Trends tab that wasn't in the request URL (e.g. from
    // localStorage) — the server-rendered <title> only knows about ?view=,
    // so it's still the plain default here and needs the same fix-up the
    // click handler applies (SEOSOCIAL-04).
    if (TAB_PAGE_TITLES[initialView]) setDocumentTitle(TAB_PAGE_TITLES[initialView]);
    var view = el('view-' + initialView);
    if (view) { view.classList.add('active'); view.setAttribute('aria-hidden', 'false'); }
    if (initialView === 'trades') window.scrollTo({ top: 0, behavior: 'auto' });
    if (initialView === 'people') loadPeopleDirectory();
    if (initialView === 'review' && canUseAdmin()) loadReview();
    if (initialView === 'subs') {
      updateDeliveryGate();
      loadSubs();
      fetchLatencySummary().then(renderAlertsMini).catch(function () {});
    }
    if (initialView === 'admin') { loadAdminList(); loadLogoSetting(); loadHealth(); loadInstrumentPricing(); loadMarketCoverage(); loadDiagnostics(); loadBenchmarkHistory(); renderSpeedProof(); loadLlmSpendPanel(); loadExtractionIncident(); }
  } else {
    // The head script may have stamped html[data-view] from a ?view= /
    // remembered tab that then fell back here (admin-gated, unknown) —
    // restamp so the header filter row shows for Trends.
    document.documentElement.setAttribute('data-view', 'trends');
    if (typeof refreshIosFilterSummaries === 'function') refreshIosFilterSummaries();
    loadTrends(); // Trends is the default landing view
  }
  if (window.__pendingManageBilling) {
    window.__pendingManageBilling = false;
    manageBilling();
  }
});

handleAuthQueryParams(); // toast + scrub ?login= / ?checkout= / ?billing= after redirects
loadTrades().then(function () { startStream(); openDeepLink(); }); // warm the Trades feed + live SSE pill
// /api/admin/poll-config 401s for every anonymous visitor (console noise —
// issue #1457). It now only loads from inside loadMe().then() above, gated
// on canUseAdmin() (session admin email allowlist) — never fired
// unconditionally at boot.

/* Global interactive chart tooltip */
var chartTt = document.createElement('div');
chartTt.className = 'chart-tooltip';
document.body.appendChild(chartTt);
document.addEventListener('mouseover', function(e) {
  var tcol = e.target.closest && e.target.closest('.tcol');
  if (!tcol) { chartTt.classList.remove('visible'); return; }
  var r = tcol.getBoundingClientRect();
  var p = tcol.getAttribute('data-period');
  var b = Number(tcol.getAttribute('data-b') || 0);
  var s = Number(tcol.getAttribute('data-s') || 0);
  var bv = Number(tcol.getAttribute('data-bv') || 0);
  var sv = Number(tcol.getAttribute('data-sv') || 0);
  var chart = tcol.closest('.tchart');
  var dollars = chart && chart.getAttribute('data-metric') === 'dollars';
  var buyVal = dollars
    ? (estUsd(bv) + (b ? ' <span class="muted" style="font-size:11px">(' + b + ')</span>' : ''))
    : (b + (bv ? ' <span class="muted" style="font-size:11px">(' + estUsd(bv) + ')</span>' : ''));
  var sellVal = dollars
    ? (estUsd(sv) + (s ? ' <span class="muted" style="font-size:11px">(' + s + ')</span>' : ''))
    : (s + (sv ? ' <span class="muted" style="font-size:11px">(' + estUsd(sv) + ')</span>' : ''));

  chartTt.innerHTML =
    '<div class="chart-tooltip-title">' + esc(p || '') + '</div>' +
    '<div class="chart-tooltip-row"><span class="chart-tooltip-lbl"><span class="sw buy"></span>Buys</span><span class="chart-tooltip-val">' + buyVal + '</span></div>' +
    '<div class="chart-tooltip-row"><span class="chart-tooltip-lbl"><span class="sw sell"></span>Sells</span><span class="chart-tooltip-val">' + sellVal + '</span></div>';

  chartTt.style.left = (r.left + r.width / 2) + 'px';
  chartTt.style.top = (window.scrollY + r.top) + 'px';
  chartTt.classList.add('visible');
});


</script>
<dialog class="search-panel" id="exportCsvDialog" onclick="if(event.target === this) this.close()">
  <div class="panel-head"><span class="panel-title">Export CSV</span><button class="panel-close" onclick="el('exportCsvDialog').close()" aria-label="Close">×</button></div>
  <p class="note" style="margin:0 0 10px">Optional date range (trade date).&nbsp; Full-history export is Premium.</p>
  <label class="lbl" for="qFrom">From</label>
  <input id="qFrom" type="date" aria-label="Trade date from" />
  <label class="lbl" for="qTo">To</label>
  <input id="qTo" type="date" aria-label="Trade date to" />
  <button class="btn sm" type="button" onclick="exportCsv()">Download CSV</button>
</dialog>
</body>
</html>`;
