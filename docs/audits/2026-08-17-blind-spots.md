# Blind-spots audit — 2026-08-17 (CURSOR)

Read-only red-team panel.  Scope is the domains that sibling reviews already
leave on the table: product strategy, test architecture, civic-data ethics,
legal and disclosure-domain nuance, source licensing and retention,
accessibility, internationalization, vendor lock-in, cost efficiency,
documentation, observability, and adjacent second-order risks.

This is **not** an ingestion, backend, analytics, security, or UX redesign
review.  Those lanes already have live PRs and prior write-ups.  Findings
here are presentation, policy, measurement, and assumption failures that
those reviews systematically miss.

| Field | Value |
|---|---|
| Seat | CURSOR |
| HEAD | `be53b3e57109ef43812aec474cea6378dcf15887` (`main`) |
| Method | Source + docs + `gh` issues/PRs.  No production writes. |
| Severity | **Critical** / **High** / **Medium** / **Low** |
| Output | Report-only.  No product code. |

---

## 1. Scope, method, and keep-out

### What was read

- Legal and share surfaces: `app/src/ui/legalHtml.ts`, `ogMeta.ts`,
  `dashboardHtml.ts` (selected regions), `docs/FLEET-UI-COPY.md`.
- Disclosure and ethics: `app/src/shared/stockAct.ts`,
  `app/src/ingestion/ogeSource.ts`, `app/src/delivery/rows.ts`,
  `app/src/enrichment/memberPhotoPack.ts`, `app/src/jobs.ts`.
- Tests and CI: `app/vitest.config.ts`, `app/src/ui/__tests__/legalHtml.test.ts`,
  `app/src/ui/__tests__/dashboardHtml.test.ts`, `.github/workflows/ci.yml`,
  `.github/workflows/ios-build.yml`.
- Observability and cost: `app/src/index.ts`, `app/src/delivery/rest.ts`,
  `app/src/shared/d1Budget.ts`, `app/src/shared/llmSpend.ts`,
  `docs/rollouts/2026-08-17-latency-probes-silent.md`.
- Prior reviews (consulted so this panel does not re-do them):
  `docs/reviews/2026-08-10-web-ui-expert-review.md`,
  `docs/reviews/2026-08-06-full-product-review.md`,
  `docs/reviews/2026-07-28-full-app-review.md`.
- Live GitHub: open PRs, non-effort issues, effort-board mirror.

### What this panel will not re-argue

| Lane | Already covered | Leave it |
|---|---|---|
| UX / chrome | #1967, #1965, `docs/reviews/2026-08-10-web-ui-expert-review.md` | Interaction model, filter chrome, drawer density |
| Ingestion | #1969 / #1577, #1959 / #1575, #1962 | House ZIP, scanned-PDF OCR, filings hygiene |
| Backend / deploy | #1964 / #1537 | Coolify swap downtime |
| Analytics / latency math | #1966 / #1523 | Match counting, corpus coverage |
| Security | AGENTS.md Cloudflare / admin-token / Infisical notes | Token verification, auth bypass, scrape-guard internals |

### Current issues and PRs (snapshot 2026-08-17)

Open PRs at audit time:

| PR | Branch | Relevance to this panel |
|---|---|---|
| #1967 | `cursor/ux-polish-deeplink-feed-4a2c` | UX.  Out of scope. |
| #1966 | `cursor/latency-corpus-shared-3053` | Analytics coverage.  Out of scope except as a *presentation* risk if win-rate copy still sells Premium. |
| #1965 | `cursor/expansion-filter-leftovers-f7cf` | Directory leftovers.  Out of scope. |
| #1964 | `cursor/coolify-deploy-overlap-028c` | Deploy overlap.  Touches availability honesty (see §11). |
| #1959 | `cursor/scanned-pdf-ocr-1575` (draft) | Extraction.  Out of scope. |

Open product issues that are **not** effort-board rows and that this panel
treats as evidence, not as work to steal:

| Issue | Why it matters here |
|---|---|
| #1607 | House + Executive 2024–2025 coverage dip.  Default-feed honesty. |
| #1462 | Vendored `congress-trading-shared` at v2.0.0 vs shared repo v2.5.1.  Lock-in / drift. |
| #1453 | Primary + historic duplicates in the default feed.  Civic-trust risk. |
| #1457 | Anonymous-load 404/401 + CSP-blocked Cloudflare Insights beacon.  Privacy-copy vs reality. |
| #1523 | Latency methodology undercounts matches.  Sales-tool risk. |
| #1490 | Live Uptime Alert: `congress.trade` health HTTP 502 (opened today).  Observability honesty. |
| #1687 / #1048 | iOS App Store 1.0 still owner-blocked / incomplete.  Legal-copy ship risk. |
| #1808 | Member-photo licence check.  Attribution still not visible. |
| #1953 | Renew Quiver + replace UW token.  Dead paid spend. |

`docs/audits/` did not exist before this file.  Prior reviews live under
`docs/reviews/` and `docs/analysis/`.

---

## 2. Executive summary

The product is unusually honest in local comments and SQL (bracket midpoints
are estimates; R2 PDFs are not silently deleted; counsel-review is still
flagged on the legal templates).  The blind spots are **cross-surface
contracts**: ToS, OG, Privacy, default feed, Trends framing, health HTTP
codes, and CI all tell slightly different stories about what Congress.Trade
is.

The highest-leverage failures are not missing features.  They are
**misleading defaults** and **unreviewed legal assumptions**:

1. The public corpus is House + Senate + Executive.  The default feed, ToS,
   OG description, `package.json`, and chamber-column tooltip still speak as
   if it were Congress-only — or, worse, as if “All branches” included
   Executive when the API deliberately excludes it.
2. OGE 278-T republication is treated as “same as STOCK Act.”  EIGA §105(c)
   is acknowledged in a source comment and then waved through as educational
   framing.  That is a counsel question, not an engineering one.
3. Privacy copy is a June 22 template that omits Apple Sign-In, Sentry,
   OpenRouter, APNs, and Cloudflare RUM, and claims GDPR/CCPA rights with no
   delete-account path.
4. Test coverage on `dashboardHtml.ts` reports 100% because the 12,941-line
   template literal is not executable to V8.  iOS XCTest never runs in CI.
5. `/health` is always green.  `/api/health` can be HTTP 200 with
   `pipeline.status === 'stalled'`.  Paid Quiver/UW probes are dead spend
   while Delivery still sells “Get the Filing First.”

---

## 3. Findings

Each finding has evidence, severity, a second-order failure mode, and a
concrete improvement.  Line numbers are from `be53b3e5`.

### 3.1 Product strategy

#### BS-P1 — “All branches” is a lie on the default feed

**Severity:** Critical

Web chip logic treats an empty selection as all three chambers:

```12199:12214:app/src/ui/dashboardHtml.ts
/* ---- Branch chips: House / Senate / Executive multi-select ----
   Same mental model as party chips (D/R/O): nothing selected means ALL
   branches (no filter). ...
var CHAMBER_ALL = ['house', 'senate', 'executive'];
...
  // Omit param when the effective selection is all branches (no filter).
  return sel.join(',') === CHAMBER_ALL.slice().sort().join(',') ? '' : sel.join(',');
```

The public API, when `chamber` / `chambers` is omitted, **excludes**
executive on purpose:

```369:374:app/src/delivery/rows.ts
   * Multi-chamber selection (takes precedence over `chamber`). ABSENT means
   * the default congressional view: house + senate + unresolved-chamber rows,
   * with executive (OGE 278-T) rows excluded — they appear only on explicit
   * request so a single mega-filing can't swamp the feed.
```

Fleet copy forbids Congress-only framing:

```86:90:docs/FLEET-UI-COPY.md
The product corpus is **House, Senate, and Executive Branch** (OGE 278-T), not
Congress alone. ...
Do not write “Congressional trades” or “House and Senate” as if that were the whole feed
```

**Second-order failure:** A journalist, subscriber, or App Reviewer who
believes the default feed is the product corpus will under-count executive
activity and over-trust “All.”  Issue #1607 (House + Executive coverage dip)
is invisible to anyone who never toggles Executive.  The mega-filing
rationale is real; the label is not.

**Improvement:** Rename the empty state to “Congress (House + Senate)” on
web, iOS, and API docs.  Keep the row-cap rationale.  Add a one-line
“Executive hidden unless selected” note on Trades.  Do not change the
default inclusion rule in this report — that is a product decision.

#### BS-P2 — Premium sells speed; the free surface sells alpha

**Severity:** High

Decided policy (AGENTS.md): analytics stay public/free; only Delivery is
Premium.  Delivery copy is a speed pitch:

```3158:3159:app/src/ui/dashboardHtml.ts
      <h3>Alerts</h3>
      <p class="sub">Get the Filing First.&nbsp; Premium pushes a filing to you the moment we ingest it
```

The landing tab ranks “Top Performers” as politicians whose buys beat the
S&P 500:

```3015:3020:app/src/ui/dashboardHtml.ts
    <!-- Top performers: realizable excess vs the S&P 500, anchored at filing date -->
    ...
      <p class="sub">Politicians whose disclosed <strong>buys</strong> beat the S&amp;P 500 after the trade was <strong>disclosed</strong>, shown as an <strong>average excess return</strong>
```

Latency comparison is a Premium proof and is **hidden when behind**
(`dashboardHtml.ts` speed-card helper, admin-always / Delivery-only-when-ahead).
Issue #1523 already says the methodology undercounts matches.  PR #1966 is
repairing coverage math, not the sales placement.

**Second-order failure:** Free users get the fantasy-league surface.  Paying
users get a webhook.  When probes are down (Quiver 403, UW 401 — #1953 and
`docs/rollouts/2026-08-17-latency-probes-silent.md`), the scorecard
disappears instead of showing an honest loss.  That reads as moving
goalposts, not civic data.

**Improvement:** Keep analytics free if that remains the owner decision.
Rename “Top Performers” to disclosure-date excess-return language.  Show
latency on Delivery even when behind, with sample size and provider status.
Do not use a hidden scorecard as the Premium proof.

#### BS-P3 — Civic-data philosophy is implicit, so monetization will keep colliding with it

**Severity:** Medium

There is no public strategy note that says: *the feed is a public good; we
charge for push*.  Competitors (Quiver, Capitol Trades, Unusual Whales)
charge for the corpus itself.  Congress.Trade charges for Delivery and
leaves Trends, Directory, and `/api/analytics/*` unauthenticated.

**Second-order failure:** Power users and sibling apps can poll the public
analytics API.  Premium revenue never funds the expensive part (LLM
extraction, review, R2).  Agents will keep proposing paywalls or rate
limits because the strategy is only in AGENTS.md “Open Decisions,” not in
a user-facing or investor-facing sentence.

**Improvement:** One page, `/about` or `docs/strategy.md`, that states the
boundary in two sentences.  Until that exists, treat paywall PRs as
strategy changes, not polish.

#### BS-P4 — iOS 1.0 is a legal-and-copy ship, not a feature ship

**Severity:** High (if the binary in review is stale)

`STATUS.md` still carries overlapping handoffs: website SIWA needs Infisical
Apple keys; TestFlight 1.0.15 printed raw Markdown and `[REDACTED]` for
Support; #1881 is on `main` but “never shipped”; App Store version is 1.0.0
with a custom EULA; Guideline 2.1 Resolution Center was not touched.
Issues #1687 and #1048 remain open.

**Second-order failure:** App Review sees a different corpus, trial length,
and support address than the website.  That is how 2.1 and privacy
questionnaires fail.  It is also how a user in one of 175 territories gets
English-only USD copy that the listing implied was localized.

**Improvement:** Before the next submit, diff ASC fields, `legalHtml.ts`,
iOS `LegalFooterLinks`, and `docs/FLEET-UI-COPY.md` in one checklist.  Do
not submit a binary that predates the footer and Executive-corpus fixes.

---

### 3.2 Civic-data ethics and disclosure-domain nuance

#### BS-E1 — EIGA §105(c) is a comment, not a legal posture

**Severity:** Critical

```21:23:app/src/ingestion/ogeSource.ts
 *  - EIGA §105(c) restricts certain uses of these reports; congress.trade
 *    disseminates them to the general public in the site's existing
 *    educational framing, mirroring its House/Senate STOCK Act posture.
```

5 U.S.C. app. §105(c) restricts obtaining or using EIGA reports for
commercial purposes other than news-media dissemination to the general
public, and for credit, solicitation, and unlawful purposes.  The product
is a commercial service (Stripe + App Store Premium) that also offers a
paid push feed of those reports.  “Educational framing” is not the
statutory exception.  “News and communications media” might be — that is
for counsel.

Historical design still says the opposite of a careful reading:

```223:224:congress-trade-feed-design.md
- Data is public under the STOCK Act; redistribution is generally fine.
```

ToS §1 never mentions Executive or EIGA (`legalHtml.ts:66`).

**Second-order failure:** A complaint, a takedown, or an OGE inquiry hits a
solo operator with templates that claim counsel has not reviewed them
(`legalHtml.ts:5-8`).  Premium webhooks of 278-T rows are the sharp edge:
public website display and paid redistribution are different facts.

**Improvement:** Counsel memo before the next ASC or Stripe change.
Separate “public website display of official reports” from “paid
machine-readable feed of OGE 278-T.”  Put the outcome in ToS §1 and a
public methodology page.  Do not have agents invent the legal theory.

#### BS-E2 — One 45-day clock is applied to every chamber, including editorial “severely late”

**Severity:** High

```3:21:app/src/shared/stockAct.ts
 * STOCK Act 45-day disclosure-lag computation. The rule: members must disclose
 * a covered transaction within 45 days.
...
/** Lag beyond this is classified 'severely_late' (an editorial threshold — the
 *  statute only defines the 45-day deadline; 120 days ~ 4 months). */
```

Trends copy states the STOCK Act deadline as if it were the only rule
(`dashboardHtml.ts:3046`).  OGE 278-T is an EIGA analogue, not the STOCK
Act.  Negative lags (filed before trade — amendments, bad dates) classify
as `on_time` (`stockAct.ts:50-58`).

**Second-order failure:** A “severely late” badge is a reputational claim
about a named public official.  If the dates are wrong, or the statute is
the wrong statute, the product is not a feed — it is an accusation.  The
code already knows 120 days is editorial.  The UI does not.

**Improvement:** Chamber-specific lag copy.  Label `severely_late` as
“>120 days (site threshold).”  Surface negative lag as data quality, not
on-time compliance.

#### BS-E3 — Estimated dollars are honest in SQL and uneven in the product

**Severity:** High

Analytics SQL is explicit that every dollar figure is a midpoint estimate
(`app/src/analytics/sql.ts` header).  Web Trends prefixes `~` via `estUsd`.
The JSON API returns rounded integers with `estimatedAmounts: true` and no
tilde.  iOS formatters use USD with no estimate marker.  Per-row
`amountCellHtml` shows the bracket range (correct as a *range*) while the
drawer headline comment calls the bracket “exact”
(`dashboardHtml.ts:11442-11448`).  The chamber column tip still says
“House or Senate” (`dashboardHtml.ts:4576`).

**Second-order failure:** A CSV or API consumer publishes “$1,250,000
traded” as a fact.  A screen-reader user hears a dollar amount with no
“estimated.”  A competitor or journalist attributes a midpoint as a fill.

**Improvement:** Contract: any midpoint-derived number carries `~` / “Est.”
/ `estimatedAmounts` in every client.  VoiceOver reads “estimated.”
Bracket *text* may stay unprefixed; midpoint *math* may not.  Add a
negative test (see BS-T3).

#### BS-E4 — Family and staff trades are first-class data and second-class UI

**Severity:** Medium

Filings carry a beneficial-owner code.  The Owner column exists and is
**off by default** (`dashboardHtml.ts:4574`).  Cards can show an owner
pill.  Trends “Top Performers” and “Most Active Politicians” attribute
activity to the named filer.

**Second-order failure:** Spouse and dependent-child trades become the
politician’s alpha.  That is a common reading of STOCK Act data and also
a common way these products get the ethics wrong.  Minors can appear as
beneficial owners on a public commercial site.

**Improvement:** Default-on owner chip on trade rows.  Performer /
activity aggregations should split or footnote non-self owners.  Add a
one-line “includes spouse and dependent reports” on Trends.

#### BS-E5 — Late-filing and “beat the S&P” framing is political speech

**Severity:** Medium

`>45 Day Lag` KPIs, `severely_late`, and Top Performers are accountability
journalism built into a SaaS.  The disclaimer says not investment advice.
It does not say the site is not making a corruption or competence claim.

**Second-order failure:** A campaign, a filer, or a platform (App Store,
Cloudflare) treats the leaderboard as a political score.  The product has
no corrections policy, no “report an error” path beyond
`support@congress.trade`, and no public methodology for the 200% cap /
5-buy threshold.

**Improvement:** Public methodology page.  “Report a data error” link on
every drawer.  Neutral nouns (“Disclosure-date excess return,” “Filed
after 45 days”) instead of “Top Performers” / “severely late” in user
chrome.  Keep the editorial threshold in admin if needed.

---

### 3.3 Legal copy, privacy, and DSR

#### BS-L1 — ToS and share cards are still Congress-only

**Severity:** Critical

```65:66:app/src/ui/legalHtml.ts
<p>Congress.Trade aggregates and presents <strong>public financial-disclosure data</strong> filed by politicians serving in the U.S. Congress under the STOCK Act (2012)
```

```31:32:app/src/ui/ogMeta.ts
const DEFAULT_DESC =
  'We ingest and publish official House & Senate STOCK Act disclosures ourselves — a live congressional stock-trade feed, not a wrapper around one third-party API.';
```

```7:7:app/package.json
  "description": "Cloudflare Workers service ingesting US congressional STOCK Act stock-trade disclosures (House + Senate) ...
```

Dashboard meta description matches (`dashboardHtml.ts:103`).
`EFFECTIVE_DATE` is still `June 22, 2026` (`legalHtml.ts:11`).  Source
comment: templates, have counsel review (`legalHtml.ts:5-8`).

Legal tests only lock price, trial days, and support email
(`legalHtml.test.ts:11-36`).  They will not fail if Executive, EIGA, or
Apple Sign-In stay missing.

**Improvement:** Rewrite ToS §1 for House, Senate, and Executive.  Align
OG, RSS, `package.json`, and footer.  Add a CI string contract against
`docs/FLEET-UI-COPY.md` corpus language.  Bump `EFFECTIVE_DATE` in the
same change.  Counsel review is still outstanding — do not delete that
comment until it is done.

#### BS-L2 — Privacy Policy understates processors and cookies

**Severity:** High

Privacy §4 lists Stripe, Cloudflare, Google, Resend, FMP
(`legalHtml.ts:156-164`).  It does not list:

| Processor | Evidence it is live |
|---|---|
| Apple (Sign in with Apple, IAP, APNs) | `app/src/shared/types.ts` Apple / APNs fields; iOS StoreKit |
| OpenRouter (LLM extraction) | `types.ts` “unified transport for ALL live LLM extraction” |
| Sentry | `types.ts` DSN + `app/src/index.ts` SDK |
| Infisical | runtime secret source |
| Quiver / Unusual Whales | latency probes |
| LlamaParse | extraction credits |

Privacy §3 claims essential cookies only and no third-party tracking
(`legalHtml.ts:153-154`).  CSP explicitly allows Cloudflare Insights RUM,
which the zone injects into every HTML response:

```8:21:app/src/security/headers.ts
 * script-src also allows
 * https://static.cloudflareinsights.com for Cloudflare's auto-injected Web
 * Analytics beacon (RUM), which the zone injects into every HTML response.
...
  "script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com",
```

GA was removed on purpose (`app/src/ui/routes.ts` CT-AUD-P1-15).  Issue
#1457 still records the Insights beacon as CSP-blocked for some clients —
so the zone may inject a tracker the policy does not name and the CSP may
block, depending on the edge.

**Improvement:** Subprocessors table (purpose, categories, retention).
Name Cloudflare Web Analytics / RUM or turn the zone beacon off.  Name
`ct_session` and OAuth state cookies.  If EU traffic is material, decide
consent vs essential-only and write that decision down.

#### BS-L3 — GDPR/CCPA rights with no delete-account or DSR path

**Severity:** High

```170:171:app/src/ui/legalHtml.ts
<p>Depending on where you live (e.g., under GDPR or the CCPA/CPRA), you may have rights to access, correct, delete, or port your personal information...
To exercise these rights, email <a href="mailto:${CONTACT}">${CONTACT}</a>.
```

`app/src/client/commands.ts` has `delete_subscription`, not
`delete_account` / `export_data`.  Logout clears session KV only.

**Second-order failure:** A California or EEA user emails support.  There
is no runbook, SLA, identity check, or Stripe/Apple/Google deletion
order.  App Store privacy nutrition labels and Stripe Checkout both
point at this page.

**Improvement:** Written DSR runbook (30-day SLA, identity step, list of
systems).  Self-serve Delete Account on web Settings and iOS Account.
Export of account + subscription metadata.  Do not promise portability
the API cannot perform.

#### BS-L4 — Acceptable-use vs Apache 2.0 vs vendor ToS

**Severity:** Medium

Root `LICENSE` is Apache 2.0.  There is no root `NOTICE`.  ToS §6 forbids
scraping and redistributing “the data or feeds” (`legalHtml.ts:97-98`).
`/api/analytics/*` is public.  `/api/market/*` rebroadcasts FMP-derived
rows to sibling apps (`app/src/delivery/rest.ts` comment near the market
routes).  Cross-app audit already flagged vendor ToS for public
`/market/*` (`docs/handoffs/2026-08-01-monet-cross-app-audit/HANDOFF.md`).

**Second-order failure:** A researcher follows Apache 2.0 and republishes
the repo *and* a scraped feed.  A vendor (FMP, Quiver, UW) treats the
latency scorecard or `/market/*` as unlicensed display.  The ToS and the
LICENSE describe two different products.

**Improvement:** `NOTICE` for OFL fonts and vendored packages.  ToS
sentence: Apache 2.0 covers source; the hosted compilation and vendor
enrichment are licensed separately.  Per-vendor register (display,
benchmark, rebroadcast).  Attribute FMP/Quiver/UW where their data
shapes a public widget.

---

### 3.4 Source licensing and retention

#### BS-S1 — Photo licences are recorded and not shown

**Severity:** High

```23:40:app/src/enrichment/memberPhotoPack.ts
 * The licence is a RECORD, not a gate (owner decision, 2026-08): public domain is preferred but no longer required to ship...
 * **There is no visible caption anywhere in the web UI or the SwiftUI clients yet**
```

`attributionDisplayEnabled` defaults OFF.  Even ON, only an
`x-photo-attribution` header is sent — no UI caption.  `sources.json`
includes CC BY-SA faces (e.g. Gage Skidmore).  Issue #1808 is the
in-progress licence-check row.

**Second-order failure:** CC BY-SA requires visible credit.  Shipping the
face without the caption is a licence break, not a polish miss.  Executive
filers have no bioguide; those faces are the ones most likely to come from
non-PD press photos.

**Improvement:** Do not ship non-PD faces without a visible credit.  Or
restrict the pack to PD / official portraits until a caption UI exists.
`/about/sources` for the pack.  Keep the header flag, but do not treat it
as compliance.

#### BS-S2 — Filing PDFs are kept; DB rows are not; users are not told

**Severity:** Medium

Five-year sweep deletes filing/transaction rows and **keeps** R2 objects
unless `RETENTION_DELETE_RAW_OBJECTS` is on (`jobs.ts:240-247`,
`267-295`).  That is the correct engineering default (the PDF is the only
recoverable source).  Privacy §5 says account records are kept while the
account is active.  It says nothing about how long official PDFs of named
officials live on R2, or that parsed rows disappear at five years while
the scan remains.

**Improvement:** Public retention schedule: parsed rows N years; raw PDFs
until opt-in delete; backups on B2.  Do not enable
`RETENTION_DELETE_RAW_OBJECTS` without an export receipt.

#### BS-S3 — Official-source republishing is assumed, not recorded

**Severity:** Medium

House Clerk FD, Senate eFD, and OGE indexes are ingested and the PDFs are
stored.  There is no in-repo licence register for those three sources, no
user-facing “source document” attribution beyond a filing link, and no
counsel note except the EIGA comment.

**Improvement:** `docs/legal/sources.md`: source, terms URL, what we store,
what we may display, what we may sell.  Link it from `/about`.

---

### 3.5 Accessibility

Prior UX reviews already praise tab roles, focus traps, and reduced
motion.  This panel only lists gaps those reviews treated as bones.

#### BS-A1 — Legal pages are dark-only; product default is light

**Severity:** Medium

`legalHtml.ts` shell hard-codes a dark gradient (`:root --bg:#0b1120`).
The app default is light (owner 2026-08-10).  Stripe Checkout and App
Store link here.  No `prefers-color-scheme`, no theme toggle.

**Improvement:** Share the dashboard theme tokens or honor
`prefers-color-scheme`.  Verify contrast on both.

#### BS-A2 — No automated a11y gate

**Severity:** High

`dashboardHtml.test.ts` greps for `aria-*` strings and fakes a DOM for
keyboard tests.  There is no `axe-core`, jsdom/happy-dom, or Playwright
a11y job.  Coverage on `dashboardHtml.ts` is eight instrumented lines at
100% because the browser script is a template string.

**Improvement:** One Playwright (or happy-dom + axe) smoke on the
dashboard shell: tablist, drawers, legal pages, estimate dollars
announced.  Fail CI on serious/critical.

#### BS-A3 — Color and emoji still carry meaning

**Severity:** Medium

Party dots and avatar rings are color-first.  Mobile tab bar uses emoji
as the visible label (`data-icon="📈"` / `☰` / `👥`, text hidden at the
phone breakpoint).  Estimate dollars that lack `~` have no non-visual
cue.

**Improvement:** Party initial or word wherever a dot appears alone.
Visible text labels on the phone tab bar (or confirm VoiceOver already
reads the full `aria-label` — do not assume).  “Est.” in the accessible
name for midpoint money.

#### BS-A4 — iOS VoiceOver on money and legal is untested in CI

**Severity:** Medium

Trends has some VoiceOver labels.  XCTest never runs in CI
(`ios-build.yml:72-79` is `xcodebuild build` only).  The single test file
is 1,593 lines and has no estimate/disclaimer cases.

**Improvement:** Run `xcodebuild test` on the Mac runner.  Add two tests:
disclaimer string present; midpoint currency is announced as estimated.

---

### 3.6 Internationalization

#### BS-I1 — English-only product listed in 175 App Store territories

**Severity:** High (given current ASC posture)

`lang="en"` is hardcoded (`legalHtml.ts:18`, `dashboardHtml.ts:94`).
Dates and money use `en-US` / `USD` on web and iOS.  There are no string
catalogs beyond default English.  Premium IAP is sold in 175 territories
at Apple-equalized prices (effort log 2026-08-15).

**Second-order failure:** A user in DE or JP gets a US-statute product,
US dates, and USD, with a privacy policy that claims GDPR rights.  That
is both an i18n gap and a consumer-law gap.

**Improvement:** ASC listing: English (U.S.) only, or a one-line
“U.S. disclosures, English only.”  Do not imply localization.  If
territories stay at 175, add a locale plan (String Catalog +
`Intl` wrappers) before the next marketing push.  Until then, document
en-US as a product constraint in `docs/FLEET-UI-COPY.md`.

---

### 3.7 Test architecture and code-quality measurement

#### BS-T1 — Dashboard coverage is theater

**Severity:** Critical (as a quality signal)

`dashboardHtml.ts` is 12,941 lines.  `dashboardHtml.test.ts` is 5,134
lines and ~286 `it()` blocks, mostly `toContain` on the static template.
Vitest coverage includes `src/**/*.ts` (`vitest.config.ts:17-22`).  The
embedded browser JS does not execute, so V8 reports ~8 lines / 100%.
Global floors are 55/45/60/55 (`vitest.config.ts:27-32`), well below the
live totals, so the misleading 100% never fails the gate.

`npm run typecheck` is `deno check src/deno/main.ts` only
(`package.json:11`).  `deno lint` exists and is not in CI.

**Improvement:** Extract money, filter, and disclaimer helpers out of the
template and unit-test them by calling them (the `fmtBracketAmount`
pattern already works).  Exclude the raw template from coverage or mark
it uncovered.  Ratchet floors.  Add `deno lint` or delete the script.

#### BS-T2 — iOS tests do not run on merge

**Severity:** High

`.github/workflows/ios-build.yml` builds unsigned and stops.  Issue
#1549 already records a flaky XCTest on main.  A red test that never
runs is not a gate.

**Improvement:** `xcodebuild test` on the Coolify/Mac iOS runner for PRs
that touch `clients/ios`.  Quarantine #1549 explicitly rather than
skipping the whole suite.

#### BS-T3 — No cross-surface copy or ethics contract

**Severity:** High

CI will catch `$5` / `$50` / `14 days` / `support@congress.trade` drift
between ToS and (partially) the dashboard.  It will not catch:

- Executive missing from ToS / OG / `package.json`
- “All branches” vs API default
- midpoint dollars without `~`
- fleet Title Case / two-space rules
- `STRIPE_TRIAL_DAYS` vs ToS text (comment only in `legalHtml.test.ts:15-16`)

**Improvement:** One `copyContract.test.ts` that imports ToS, dashboard
needles, iOS strings, and `STRIPE_TRIAL_DAYS`.  Assert Executive +
OGE, estimate language, and trial days from the same constants.

#### BS-T4 — Shared package tests are not the app’s CI

**Severity:** Medium

`vitest.config.ts:10` excludes `vendor/**`.  Issue #1462: vendored pin
is v2.0.0, shared repo is v2.5.1.  Fleet lock-in plus silent API drift.

**Improvement:** Either run the vendor suite in CI or stop claiming the
shared package is covered.  Resolve #1462 on a dedicated branch; do not
bundle it with this report.

---

### 3.8 Observability

#### BS-O1 — Liveness endpoints can be green while the product is stalled

**Severity:** Critical

```76:76:app/src/index.ts
app.get('/health', (c) => c.json({ ok: true }));
```

`GET /api/health` returns HTTP 200 when schema readiness is ok, and puts
pipeline status in the JSON body:

```499:525:app/src/delivery/rest.ts
        status: readiness.ok ? pipeline.status : 'down',
        pipeline,
...
      readiness.ok ? 200 : 503,
```

`GET /api/health/deep` *does* 503 on `stalled` (`rest.ts:543`).
`STATUS.md` records live `pipeline.status: stalled` with HTTP 200.
Issue #1490 (health 502) opened today — a different failure mode
(edge/deploy), which is why a forever-green `/health` is dangerous:
monitors that hit the wrong URL never see #1490 *or* a stalled
pipeline.

Latency probes were silent 95 hours while agents read
`operationalStatus=running` as healthy
(`docs/rollouts/2026-08-17-latency-probes-silent.md`).  Partial fix
landed in #1903.  The pattern remains: a key present, a stale
scorecard, and a 200 on `/api/health`.

**Improvement:** Document four URLs for humans and monitors.  Retire
`GET /health` for UptimeRobot, or make it delegate to pipeline
readiness.  Return 503 from `/api/health` when `pipeline.status ===
'stalled'`, *or* rename it `/api/live` and keep `/api/health/deep` as
ready.  Do not let agents quote `ok: true` as “the site is fine.”

#### BS-O2 — No public status page and no written SLOs

**Severity:** High

Thresholds live in `pipelineHealth.ts`.  There is no `docs/ops/slo.md`,
no `status.congress.trade`, and no user-visible “updates may be delayed”
when extraction is halted.  UptimeRobot is at 9/10 monitors; senate-relay
is on an hourly Pushover sweep instead
(`docs/rollouts/2026-08-17-senate-relay-host-dependency.md`).

Pushover liveness covers a short check-id list, not `autopilot_halt` or
extraction backlog.

**Improvement:** Static `/status` (or a Cloudflare status page) fed by
`/api/health/polling` + `/api/health/latency` + extraction halt.
Write SLOs as operator targets, not customer promises, in
`docs/ops/slo.md`.  Add halt/backlog to the alarm set.

#### BS-O3 — Sentry and D1-budget comments over-claim

**Severity:** Medium

`d1Budget.ts:13-15` says flush “sends a Sentry message.”  The
implementation path is `console.warn` / `console.error` unless a later
call site captures it.  D1 row budgets (5B read / 500M write) are
Cloudflare-era numbers on a self-hosted SQLite file.  Enforce is off
by default.

`usage_telemetry` is intentionally Sentry-free (anti-amplification) —
keep that.  Most extraction failures are console-only.

**Improvement:** Fix the comment or wire `captureMessage` with a stable
fingerprint.  Replace D1 row ceilings with SQLite file-size + WAL
alerts on `/api/health`.  Page on autopilot halt, not only on HTTP 500.

#### BS-O4 — Unbounded operational tables vs 1.88 GB SQLite

**Severity:** Medium

`extraction_runs` has no retention delete in `jobs.ts` (7–90 day
prunes exist for other tables).  Health exposes Litestream age, not
`dbSizeBytes`.  AGENTS.md last measured the file at 1.88 GB
(2026-08-11).

**Improvement:** 90-day `extraction_runs` retention + rollup.
`checks.storage.dbSizeBytes` with a warn threshold.  VACUUM runbook.

---

### 3.9 Cost efficiency and vendor lock-in

#### BS-C1 — Paying for dead latency vendors while selling “first”

**Severity:** High

From `docs/rollouts/2026-08-17-latency-probes-silent.md` and issue
#1953:

| Vendor | State | Product effect |
|---|---|---|
| Quiver | 403 upgrade-plan | Scorecard / health noise; paid plan unused |
| Unusual Whales | 401 invalid token since 2026-08-13 | Same |
| FMP slot-2 | 429 bandwidth | Rotation burned the working slot |

**Improvement:** Disable Quiver and UW in Infisical until renewed, or
renew them.  Stop drawing the public scorecard with two dead legs.
One paid latency benchmark is enough for a civic site.

#### BS-C2 — Cost guardrails are real for LLM and advisory for everything else

**Severity:** Medium

OpenRouter daily ceiling, LlamaParse credit cap, and per-doc $0.25 are
real and fail-closed (`llmSpend.ts`).  Usage Monitor budget gate is
advisory and fail-open without `USAGE_MONITOR_READ_TOKEN`.  D1 enforce
is off.  Hetzner, Stripe, Resend, Sentry, and Infisical have no
in-app spend view.  There is no `$ / new live tx` metric.

**Improvement:** Require the Usage Monitor read token in prod.  Weekly
`spend_7d / new_live_tx_7d` on the admin strip.  Inventory paid keys
that are not the active `PRICE_PROVIDER` / latency provider and turn
them off.

#### BS-C3 — Single-host, single-Mac, single-operator concentration

**Severity:** High

| Dependency | Why it is a lock-in, not just infra |
|---|---|
| Deno + SQLite on one Coolify host | 1.88 GB file; Litestream/B2 is the HA story; no hot standby of the app DB |
| Senate eFD via residential Mac tunnel | Fallback exists (#1604 / PR #1961); preferred path is still one laptop |
| Infisical | ~600 s cache; a project-id miss once silently served a stale `ADMIN_TOKEN` (AGENTS.md 2026-07-30) |
| OpenRouter | All live LLM extraction |
| Cloudflare DNS + R2 | Edge and PDF store |
| Vendored shared package | #1462 drift; fleet contract pin |
| Owner as on-call, counsel, and App Store | Bus factor 1 |

PR #1964 (Coolify deploy overlap, #1537) is the availability slice.
This panel only notes the product consequence: a compose swap or a
sleeping Mac becomes a **corpus gap**, which users cannot distinguish
from “Congress did not trade.”

**Improvement:** User-visible degraded banner when Senate is on direct
egress or extraction is halted.  Written exit notes: how to restore
SQLite from B2, how to run without OpenRouter (deterministic only),
how to run without the Mac (already partially documented).  Do not
pretend the stack is multi-cloud.

---

### 3.10 Documentation

#### BS-D1 — Operator truth is scattered; user truth is thin

**Severity:** Medium

Agent docs are rich (`AGENTS.md`, rollouts, effort log).  User-facing
docs are ToS, Privacy, footer disclaimer, and in-tab tooltips.
There is no `/about`, `/methodology`, `/sources`, or public status
page.  `STATUS.md` has two `# Current Handoff` headers and mixed
agent diaries.  `docs/ops/` contains one OpenRouter classifier note.

**Second-order failure:** Every new agent re-derives “what is the
product?” from ToS (wrong), OG (wrong), and Trends (alpha).
Journalists have no methodology to cite.  App Review has no single
URL that matches the listing.

**Improvement:** Four short public pages: About, Methodology
(brackets, lag, executive default, latency sample), Sources, Status.
Keep `STATUS.md` as a dated handoff, not a second product spec.
Add `docs/audits/README.md` as an index (this file is the first
row).

#### BS-D2 — Effort-board issues outnumber product issues

**Severity:** Medium (coordination, not code)

`gh issue list` is dominated by `effort-board` rows, many
COMPLETED/MERGED and still `state:in-progress`.  Real product
defects (#1453 duplicates, #1607 coverage, #1462 pin drift, #1490
502) are easy to miss.  A 2026-08-17 GROK hygiene pass is in
progress; the shape remains.

**Improvement:** Continue the hygiene lane.  Do not file this audit
as twenty effort-board issues.  If the owner wants trackers, file
a small set from §4 only.

---

### 3.11 Adjacent domains the other reviews also skip

#### BS-X1 — SEO and social cards advertise the wrong corpus

**Severity:** Medium

OG default description is House & Senate only (`ogMeta.ts:31-32`).
That is the card Slack, iMessage, and journalists see.  Combined
with BS-P1, inbound traffic is pre-loaded with the wrong scope.

**Improvement:** Same copy contract as BS-L1.  Re-generate OG images
if they say “Congressional” as the whole product.

#### BS-X2 — Research and scrape policy fights the public API

**Severity:** Low

ToS forbids scrape/bulk extract except through provided interfaces.
The provided interfaces include a public analytics API and a public
transaction feed.  Academic users will scrape anyway; journalists
will cite us.  There is no “research access” or citation format.

**Improvement:** A robots/citation paragraph: what is allowed, what
rate, how to attribute, how to get a Delivery key.  Align ToS §6
with that paragraph.

#### BS-X3 — Deploy 502s look like “no trades today”

**Severity:** Medium

#1537 / PR #1964: Coolify swap drops the origin.  #1490: health 502
today.  Mac Trends already showed a sticky “Request failed” with no
retry (effort log 2026-08-14).  Users cannot tell deploy, stall, and
empty-corpus apart.

**Improvement:** Standby page already 503s (good).  Client retry on
5xx for Trends (web + iOS).  Status sentence on the empty state:
“Source unreachable” vs “No filings in this window.”

#### BS-X4 — Single-operator legal and App Store risk

**Severity:** Medium

Entity is `Jay Wedgeworth, LLC d/b/a Congress.Trade` (`legalHtml.ts:12`).
Counsel has not signed the templates.  App Store, Stripe MoR, EIGA,
CC BY-SA photos, and GDPR emails all land on one inbox.  Agents
cannot fix this with a PR.

**Improvement:** Owner action: counsel hour, DSR mailbox rules,
App Store legal contact, and a written “if I am unavailable”
restore path.  Agents should stop marking legal templates as done.

---

## 4. Priority matrix

| ID | Severity | Domain | First concrete step |
|---|---|---|---|
| BS-P1 | Critical | Product / ethics | Rename default chamber state; stop saying “All branches” |
| BS-E1 | Critical | Legal | Counsel on EIGA §105(c) vs paid 278-T feed |
| BS-L1 | Critical | Legal / docs | ToS + OG + `package.json` include Executive |
| BS-O1 | Critical | Observability | Stop monitoring `GET /health`; fix `/api/health` semantics |
| BS-T1 | Critical | Tests | Stop treating dashboard 100% coverage as real |
| BS-P2 | High | Strategy | Honest latency + rename Top Performers |
| BS-P4 | High | Strategy | ASC/binary/legal checklist before next submit |
| BS-E2 | High | Ethics | Chamber-specific lag; label editorial 120-day |
| BS-E3 | High | Ethics | Estimate contract on API + iOS |
| BS-L2 | High | Privacy | Subprocessors + RUM |
| BS-L3 | High | Privacy | DSR runbook + delete-account |
| BS-S1 | High | Licensing | Visible credit or PD-only faces |
| BS-A2 | High | A11y | axe smoke in CI |
| BS-I1 | High | i18n | English-only disclosure on ASC |
| BS-T2 | High | Tests | Run iOS XCTest in CI |
| BS-T3 | High | Tests | Cross-surface copy contract |
| BS-O2 | High | Observability | `/status` + `docs/ops/slo.md` |
| BS-C1 | High | Cost | Disable or renew Quiver/UW |
| BS-C3 | High | Lock-in | Degraded-mode banner + exit notes |
| BS-E4 | Medium | Ethics | Owner chip default-on; split non-self aggregates |
| BS-E5 | Medium | Ethics | Methodology + corrections link |
| BS-L4 | Medium | Legal | NOTICE + vendor register |
| BS-S2 | Medium | Retention | Public retention schedule |
| BS-S3 | Medium | Licensing | `docs/legal/sources.md` |
| BS-A1 | Medium | A11y | Legal pages honor color scheme |
| BS-A3 | Medium | A11y | Party text + tab text |
| BS-A4 | Medium | A11y | iOS estimate VoiceOver tests |
| BS-T4 | Medium | Tests | Vendor suite or drop the claim |
| BS-O3 | Medium | Observability | Honest Sentry/D1 comments |
| BS-O4 | Medium | Cost / obs | `extraction_runs` retention + db size |
| BS-C2 | Medium | Cost | UM read token + $/tx |
| BS-D1 | Medium | Docs | About / Methodology / Sources / Status |
| BS-D2 | Medium | Docs | Effort-board hygiene (already owned) |
| BS-X1 | Medium | SEO | OG corpus copy |
| BS-X3 | Medium | Ops/UX edge | Empty-state vs 502 copy |
| BS-X4 | Medium | Legal ops | Owner counsel + mailbox |
| BS-P3 | Medium | Strategy | Two-sentence monetization note |
| BS-X2 | Low | Docs | Research/citation paragraph |

---

## 5. What is already strong (do not regress)

- Bracket-midpoint honesty in analytics SQL and many web tooltips.
- GA removed with a written privacy rationale.
- R2 PDF default-keep after the silent-delete incident.
- Counsel-review warning still on the legal templates.
- Focus trap, Escape, `prefers-reduced-motion` on the main shell.
- LLM spend governor fail-closed; LlamaParse credit ceiling.
- Senate relay fallback when the Mac origin 502s (documented 2026-08-17).
- ASC listing copy was corrected to House/Senate/Executive and 2-week
  trial (`docs/rollouts/2026-08-14-asc-listing-copy.md`) — web/ToS/OG
  have not caught up.
- Scoped health URLs (`/api/health/polling`, `/latency`, `/senate-relay`)
  are the right shape; the mistake is which URL monitors hit.

---

## 6. Suggested follow-ups (not filed)

This PR is report-only.  If the owner wants GitHub issues, file these
five and stop — the rest are implementation notes on those tickets:

1. **Legal/privacy alignment** — BS-L1, BS-L2, BS-L3, BS-E1 (counsel).
2. **Default-feed honesty** — BS-P1, BS-E2, BS-E3, BS-E4.
3. **Copy/ethics CI contract** — BS-T3, BS-L1, BS-X1.
4. **Health semantics + status page** — BS-O1, BS-O2, BS-X3.
5. **Photo attribution** — BS-S1 (coordinate with #1808, do not fork).

Do not start those slices on this branch.  Do not overlap #1967–#1966
#1965, #1964, #1959, #1969, or #1808.

---

## 7. Verification (this report)

```text
git rev-parse HEAD
# be53b3e57109ef43812aec474cea6378dcf15887

gh pr list --state open
# 1967 1966 1965 1964 1959 (at audit time)

test -f docs/audits/2026-08-17-blind-spots.md
```

No `npm` gates: documentation only.  No production commands.
