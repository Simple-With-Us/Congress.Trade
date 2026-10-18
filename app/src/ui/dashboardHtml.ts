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
 * Shared values are serialized into the client script at module load: benchmark
 * model choices, executive titles, public transaction limits, theme colors,
 * and the released App Store URL stay tied to their server-side definitions.
 * Since CT-2418 those values live with the code that consumes them
 * (dashboardClient.ts / dashboardStyles.ts), because the stylesheet and the
 * application script are no longer part of this document.
 */

import { APP_STORE_URL } from './appLinks.ts';
import { DASHBOARD_CSS_VERSION } from './dashboardStyles.ts';
import { DASHBOARD_APP_JS_VERSION } from './dashboardClient.ts';

/**
 * Filing Latency Comparison ("speed proof") section markup, shared between its
 * three placements:
 *   - Delivery tab: rendered at the BOTTOM, only when isLatencyAhead() says
 *     we are not behind on most adequately-covered providers (owner
 *     2026-08-17). Never shown on Trades.
 *   - Trends tab: the SAME public scoreboard, inline at the BOTTOM under the
 *     same gate (owner 2026-10-17: show the filing latency info itself at the
 *     bottom of Trends instead of a link to the Delivery copy).
 *   - Admin tab: rendered at the TOP, ALWAYS (full comparison incl. BEHIND),
 *     an operator diagnostic rather than a marketing module.
 * All copies are painted by the same renderSpeedProof() client function
 * against distinct element ids so they can render independently.
 */
function speedProofSectionHtml(placement: 'delivery' | 'trends' | 'admin'): string {
  const admin = placement === 'admin';
  const idSuffix = placement === 'admin' ? 'Admin' : placement === 'trends' ? 'Trends' : '';
  const sectionId = admin ? 'adminLatencySection' : placement === 'trends' ? 'trLatencySectionTrends' : 'trLatencySection';
  const gridId = `spGrid${idSuffix}`;
  const tableBodyId = `speedTableBody${idSuffix}`;
  const updatedId = `speedUpdated${idSuffix}`;
  // "N of M matched" + what M counts. Filled by paintSpeedSection(); stays
  // hidden until the matcher lane ships the scope counts (see the
  // SPEED_SCOPE_NOTE_DEFAULT contract block in the client script).
  const scopeNoteId = `spScopeNote${idSuffix}`;
  const infoTip = admin
    ? 'Full operator scorecard: every configured provider, including where we are behind. Each card is marked Shown Publicly or Hidden From Public. Lead and win stats use live new imports only (seed and historical backfills are excluded). We match each live trade to provider feeds even if the gap is minutes or up to about two weeks either way. Provider-only rows stay in the coverage denominator.'
    : 'Lead and win stats use live new imports only (seed and historical backfills are excluded). We match each live trade to provider feeds even if the gap is minutes or up to about two weeks either way. Provider-only rows stay in the coverage denominator, and no overall speed claim appears until coverage is adequate in both directions.';
  return `  <!-- Provider speed scorecard (filter-independent live latency proof). ${admin ? 'Admin: always full comparison, incl. BEHIND.' : "Delivery + Trends: only when we are not behind on most providers."} -->
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
<meta name="theme-color" content="#ffffff" />
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
  // Theme before first paint: default SYSTEM (follows prefers-color-scheme);
  // stored may be light|dark|system.  Sepia was removed (owner 2026-08-21:
  // "too dark of a color that doesn't look like old fashioned paper", only
  // half-themed) — any stored 'sepia' value is migrated to 'light' here so a
  // returning visitor never gets stuck failing validation.
  (function () {
    var pref = 'system';
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
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#1c1c1e' : '#ffffff');
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
<link rel="stylesheet" href="/assets/dashboard.css?v=${DASHBOARD_CSS_VERSION}">
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

</header>

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
      <span class="gate-note" data-premium-cue="export">Premium unlocks Webhooks + SSE + Proprietary Enrichment Data + CSV &middot; $8.99/mo or $79.99/yr &middot; 1-week free trial
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

${speedProofSectionHtml('trends')}
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
        <a href="${APP_STORE_URL}" class="btn sm" target="_blank" rel="noopener noreferrer" style="display:inline-flex;align-items:center;gap:6px;text-decoration:none;">
          <svg viewBox="0 0 170 170" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M150.37 130.25c-2.45 5.66-5.35 10.87-8.71 15.66-4.58 6.53-8.33 11.05-11.22 13.56-4.48 4.12-9.28 6.23-14.42 6.35-3.69 0-8.14-1.05-13.32-3.18-5.19-2.12-9.97-3.17-14.34-3.17-4.58 0-9.49 1.05-14.75 3.17-5.26 2.13-9.5 3.24-12.74 3.35-4.83.13-9.67-1.92-14.52-6.13-3.23-2.75-7.14-7.46-11.75-14.13-6.53-9.47-11.73-20.08-15.58-31.8-3.86-11.73-5.79-22.9-5.79-33.52 0-14.88 3.75-27.18 11.24-36.9 7.49-9.72 17.06-14.65 28.71-14.78 4.71 0 10.08 1.18 16.12 3.54 6.03 2.36 10.08 3.54 12.14 3.54 1.83 0 5.92-1.22 12.27-3.66 6.35-2.44 11.48-3.58 15.39-3.42 12.37.52 22.25 4.88 29.62 13.08-11.05 6.67-16.48 15.77-16.3 27.31.18 9.07 3.57 16.65 10.17 22.75 6.6 6.1 14.58 9.54 23.94 10.32-2.12 6.53-4.9 13.11-8.35 19.74zM119.22 31.78c0-7.07 2.53-13.67 7.59-19.8 5.06-6.13 11.46-9.75 19.2-10.86.36 1.44.54 2.76.54 3.96 0 7.07-2.61 13.79-7.83 20.16-5.22 6.37-11.66 9.87-19.32 10.51-.12-1.32-.18-2.65-.18-3.97z"/></svg>
          Get iOS app
        </a>
      </div>
    </div>
    <!-- Public marketing/education: how the two paid delivery methods work.
         Visible to everyone, including signed-out visitors; creating a delivery
         requires a signed-in Premium account. -->
    <div class="section" id="subsMarketing">
      <h3>Alerts</h3>
      <p class="sub">We ingest official House, Senate, and Executive Branch trades.&nbsp; Relaying a 3rd-party competitor API would ruin our minutes-to-hours edge that Congress.Trade was made for.</p>
      <p class="sub" style="margin-top: 8px;">Premium pushes a filing to you the moment we ingest it &mdash; two methods, both included:</p>
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
        <label class="minamt-label" style="display:flex;align-items:center;gap:6px">
          <input type="checkbox" id="newIncludeBackfill" disabled />
          Include historical backfill (older than 7 days)
        </label>
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
        <span class="gate-note">Premium unlocks Webhooks + SSE + Proprietary Enrichment Data + CSV &middot; $8.99/mo or $79.99/yr &middot; 1-week free trial
          <button class="btn sm" onclick="openPricing('alerts')">Start Free Trial</button></span>
      </div>
    </div>
${speedProofSectionHtml('delivery')}
  </section>

  <!-- ================= ADMIN · CADENCE ================= -->
  <section class="view" id="view-admin" role="tabpanel" aria-labelledby="tab-admin" aria-hidden="true">
${speedProofSectionHtml('admin')}
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
    <span>Congress.Trade  ·  educational tool for public STOCK Act (2012) disclosures  ·  not financial advice  ·  $ estimated from brackets  ·  independent/private service not affiliated with or endorsed/sponsored by any government agency</span>
    <span class="footer-links">
      <a href="/privacy-policy">Privacy</a>
      <a href="/terms-of-service">Terms</a>
      <a href="/pricing">Pricing</a>
      <a href="${APP_STORE_URL}" target="_blank" rel="noopener noreferrer">iOS app</a>
      <a href="/api/feed.xml" rel="alternate" type="application/rss+xml">RSS</a>
      <a href="mailto:support@congress.trade">Support</a>
      <a href="#" onclick="if(window.openSentryFeedback){window.openSentryFeedback();}else if(window.Sentry&amp;&amp;window.Sentry.getFeedback){try{window.Sentry.getFeedback().createForm().then(function(f){f.appendToDom();f.open();});}catch(e){}}return false;">Report a Problem</a>
    </span>
    <a class="swu-attribution" href="https://simplewithus.com/" aria-label="From Simple With Us"><span>From</span><img src="/assets/simple-with-us.webp" alt="Simple With Us by Jay Wedgeworth" width="1024" height="106"></a>
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
        <div class="price">$8.99<span class="per">/mo</span></div>
      </label>
      <label class="plan" id="planAnnual" for="planAnnualRadio">
        <input type="radio" class="plan-radio-input" id="planAnnualRadio" name="plan" value="annual" onchange="selectPlan('annual')">
        <span class="save">SAVE ~25%</span>
        <div class="cad">Annual</div>
        <div class="price">$79.99<span class="per">/yr</span></div>
      </label>
    </div>
    <p class="trial-note" id="pricingTrialNote">1-week free trial. No charge today.</p>
    <p class="note" id="pricingPremiumNote" style="text-align:center" hidden></p>
    <button class="btn" style="width:100%;padding:11px" id="subscribeBtn" onclick="startCheckout()">Start Free Trial</button>
    <p class="note" id="pricingMsg"></p>
  </div>
</div>

<div class="toast" id="toast" role="status" aria-live="polite" aria-atomic="true"></div>

<script src="/assets/dashboard.js?v=${DASHBOARD_APP_JS_VERSION}"></script>
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
