/**
 * src/ui/dashboardStyles.ts
 * OWNER: dashboard agent
 *
 * The dashboard stylesheet, served as /assets/dashboard.css.
 *
 * CT-2418: this used to be a ~203 KB <style> block inlined in the dashboard
 * document. That made every page load a ~820 KB HTML response that no shared
 * cache could reuse and no deploy could partially invalidate. Extracted
 * verbatim so the CSS is downloaded once and then held by the browser and the
 * edge for a year (routes.ts serves it `public, max-age=31536000, immutable`).
 *
 * The dark/light semantic tokens are still interpolated at module load, so the
 * CSS stays tied to its server-side definition in semanticThemeTokens.ts rather
 * than being frozen as text. Every url() here is already an absolute
 * /assets/*.woff2 or a data: URI, so the file resolves the same from its new
 * path.
 *
 * Editing rule: this is a template literal. Do not add a backtick inside it.
 */

import { SEMANTIC_DARK, SEMANTIC_DARK_NEG, SEMANTIC_LIGHT } from './semanticThemeTokens.ts';
import { assetVersion } from './assets.ts';

export const DASHBOARD_CSS = /* css */ `

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
    --buy:       ${SEMANTIC_DARK.buy};
    --sell:      ${SEMANTIC_DARK.sell};
    --exch:      ${SEMANTIC_DARK.exch};
    --warn:      ${SEMANTIC_DARK.warn};
    --good:      ${SEMANTIC_DARK.good};
    --pos:       var(--good);
    --neg:       ${SEMANTIC_DARK_NEG};
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
    --buy:       ${SEMANTIC_LIGHT.buy};
    --sell:      ${SEMANTIC_LIGHT.sell};
    --exch:      ${SEMANTIC_LIGHT.exch};
    --warn:      ${SEMANTIC_LIGHT.warn};
    --good:      ${SEMANTIC_LIGHT.good};
    --pos:       var(--good);
    --neg:       var(--sell);
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
  #ctFilters {
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
  html[data-theme="light"] .tag.E { color: #fff; }
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
  /* Skeleton shimmer loaders.
   *  CT-2418: this used to animate background-position, which the browser
   *  cannot composite — Chrome reported UNSUPPORTED_CSS_PROPERTY on
   *  background-position-x/y for every skeleton and kept the whole animation on
   *  the main thread, which is what turned load into two full-document layout
   *  updates (350 ms / 318 nodes and 96 ms / 326 nodes). Sliding a ::after
   *  overlay with transform is a compositor-only property, so the animation
   *  now runs off the main thread and can never trigger layout. */
  .sk { position: relative; overflow: hidden; display: inline-block; border-radius: 6px; background: var(--panel-2); }
  .sk::after {
    content: ''; position: absolute; inset: 0; pointer-events: none;
    background: linear-gradient(90deg, transparent 25%, color-mix(in srgb, var(--text-dim) 18%, transparent) 37%, transparent 63%);
    background-size: 200% 100%;
    transform: translateX(100%);
    animation: tr-shimmer 1.25s ease-in-out infinite;
  }
  @keyframes tr-shimmer { from { transform: translateX(100%); } to { transform: translateX(-100%); } }
  .sk-line { height: 12px; width: 100%; margin: 7px 0; }
  @media (prefers-reduced-motion: reduce) { .sk::after { animation: none; display: none; } }
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

  /* CT-2418 — reserve the Trends grid row before its data arrives.
   *
   * Both halves of .trend-grid-split paint a 6-row skeleton, then swap in real
   * rows when their fetch resolves. Because the grid row height is the tallest
   * of the two, both growing at once re-flowed the whole section and everything
   * below it, which scored 0.2202 of CLS on its own (page total 0.26, "bad").
   *
   * Reserved heights are the measured filled heights at the default timeframe,
   * taken from production on 2026-10-16 at 1400px and re-checked at 500px — the
   * rows are a fixed 45px (tickers) / 57px (performers) at both widths, so one
   * reservation is correct across breakpoints:
   *
   *   #trTickers    15 rows -> 712px wrap   (this is what sets the grid row)
   *   #trPerformers 10 rows -> 571px wrap
   *
   * A different timeframe can return up to the 15-row limit, in which case the
   * section still grows past the reservation; that is a smaller shift than the
   * skeleton swap was, and reserving the limit instead would leave a several-
   * hundred-pixel hole on the landing view. Tune these two numbers together if
   * the row height ever changes. */
  #trTickers { min-height: 675px; }
  #trPerformersFold .table-wrap { min-height: 571px; }
  @media (max-width: 760px) {
    #trTickers { min-height: 600px; }
    #trPerformersFold .table-wrap { min-height: 571px; }
  }
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
  .drawer-see-all { margin:10px 0 0; }
  .drawer-see-all-link { font-weight:600; text-decoration:none; color:var(--accent); }
  .drawer-see-all-link:hover { text-decoration:underline; }
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
    #ctFilters { grid-column: 1 / -1; grid-row: 2; }
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
    #ctFilters { grid-column: 1 / -1; grid-row: 2; display: block; padding: 4px 4px 8px; min-width: 0; }
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

  /* Keep filters on the content ground, separate from the white masthead.
     The flexible track stays on the nav column (brand and account are
     auto), so a narrow signed-out window squeezes the tabs, never the
     wordmark; the tabs right-align inside that track. */
  header.top {
    grid-template-columns: auto minmax(0, 1fr) auto;
    grid-template-rows: auto; row-gap: 0;
    padding-bottom: 16px;
  }
  header.top .brand { grid-row: 1; }
  header.top nav.tabs { justify-self: end; align-self: center; }
  #ctFilters {
    box-sizing: border-box; width: 100%; max-width: var(--ct-col-max, 1730px);
    margin: 0 auto; padding: 16px var(--ct-main-pad, 35px) 0;
    display: flex; align-items: center; gap: 12px; min-width: 0;
  }
  @media (min-width: 769px) and (hover: hover) and (pointer: fine) {
    #ctFilters { max-width: calc(var(--ct-col-max, 1730px) + 2 * var(--ct-main-pad, 35px)); }
  }
  .speed-mini-copy { display: flex; align-items: flex-start; gap: 7px; flex: 1 1 340px; min-width: 0; }
  .speed-mini-bolt { flex: 0 0 auto; }
  .speed-mini > button { margin-left: auto; flex: 0 0 auto; }
  @media (max-width: 768px), (hover: none) and (pointer: coarse) {
    html[data-theme="light"] { background: #fff; }
    html[data-theme="dark"] { background: #1c1c1e; }
    html[data-theme="dark"] header.top { background: #1c1c1e; }
    header.top { grid-template-columns: minmax(0, 1fr) 44px; grid-template-rows: auto; padding-bottom: 12px; }
    #ctFilters { display: block; padding: 14px var(--ct-main-pad, 14px) 0; }
    header.top nav.tabs { justify-self: stretch; width: 100%; }
    nav.tabs { padding-top: 6px; padding-bottom: env(safe-area-inset-bottom, 0px); }
    html[data-theme="light"] nav.tabs { background: #fff; }
    html[data-theme="dark"] nav.tabs { background: #1c1c1e; }
    .acct-mobile-menu > a.btn { display: flex; align-items: center; min-height: 48px; font-size: 16px; box-sizing: border-box; }
  }
`;

/** `?v=` cache-busting fingerprint; see assetVersion(). */
export const DASHBOARD_CSS_VERSION = assetVersion(DASHBOARD_CSS);
