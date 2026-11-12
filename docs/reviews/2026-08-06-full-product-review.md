# Full-product review — 2026-08-06 (MONET)

> Seat note: work began under the CLAUDE tag (Slack claim 14:33 CDT); the owner
> re-designated this seat MONET mid-session ("for ag*** s**c purposes going
> forward always"). Same seat, one review; issues #1452–#1460 filed pre-rename
> say CLAUDE.

Owner-requested review of Congress.Trade: live website, iOS spot-checks, Grok's
alternate-style mock (congresstrade.grok.me), cross-agent coordination health,
and an audit of the effort board + GitHub issue mirror. Findings filed as
hand-made issues **#1452–#1460**; board corrections landed in the same push.

Method note: the multi-agent review workflow hit the session usage cap, so the
deep-dive was done inline — live-site testing on all four tabs (desktop dark +
light, 375 px mobile), network/console inspection, targeted source verification
in `app/src`, and read-only `gh`/git audit of PRs, issues, and board rows.

## What's working well

- **Delivery tab copy** is excellent — plain-English webhook vs SSE explainer,
  Zapier/Slack no-server path, honest "Past speed doesn't guarantee future
  speed" hedging. The #1039 pause/resume/delete + filter-edit UI landed.
- **Dark mode** is properly designed (palette, logo variant, contrast), and the
  theme default is already **System** on both web (PR #1367) and iOS
  (`App.swift` `app_color_scheme = "system"`) — matches the owner directive.
- **Accessibility bones are good**: real tab roles, descriptive aria-labels on
  branch/party filter buttons, `role=status` live pill for feed updates.
- **Mobile bottom tab bar** feels native and is the right pattern.
- **Ticker/member drawers** are content-rich (company facts, activity stats,
  disclosure-lag stat, most-traded, backtests). Latency methodology copy is
  thorough and honest.
- **Deep links partially work** (`?view=people` etc.) and the OG/meta/favicon
  set from earlier waves is live.

## Defects found (filed)

| # | Severity | Finding |
|---|----------|---------|
| [#1452](https://github.com/jaywedgeworth22/Congress.Trade/issues/1452) | P2 | Duplicate member identities: "Michael T. McCaul" (4113 trades) and "Michael McCaul" (4095) both listed; per-member stats split/wrong. Party label inconsistent ("Republican" vs bare "R"). |
| [#1453](https://github.com/jaywedgeworth22/Congress.Trade/issues/1453) | P2 | Default feed shows primary+historic duplicates (Himes 7/20 HD/XOM/BAC ×3 with 3 name variants); asset names unnormalized ("UNH Stock", raw-uppercase, bare "Securities", ticker X nameless, suspect HONAV symbol). |
| [#1454](https://github.com/jaywedgeworth22/Congress.Trade/issues/1454) | P2 | `GET /api/members` ~6 s → People tab stuck on "Loading directory…" with no skeleton. |
| [#1456](https://github.com/jaywedgeworth22/Congress.Trade/issues/1456) | P2 | 375 px: brand logo hidden **behind** the 3-button theme toggle; disclaimer auto-expanded eats the first mobile screen. |
| [#1457](https://github.com/jaywedgeworth22/Congress.Trade/issues/1457) | P3 | Anonymous-load console noise: guaranteed `/api/stream` 404 probe, `/api/admin/poll-config` 401 for everyone, ticker-logo 404s, CSP-blocked Cloudflare Insights beacon (RUM analytics silently dead). |
| [#1458](https://github.com/jaywedgeworth22/Congress.Trade/issues/1458) | P3 | `?view=trades` → Trends, `?view=delivery` → last-viewed tab: view ids don't match visible tab names; unknown values silently rewritten. Drawer gaps: backtest stats lack a time horizon, Committees "Not recorded", empty avatar circles in drawer headers. |

## Owner decisions requested

- **[#1455](https://github.com/jaywedgeworth22/Congress.Trade/issues/1455) Latency-comparison widget placement.** It renders on every public
  tab and today reports *Quiver wins 92% of the time by ~4.9 days* — directly
  beneath the Delivery tab's "Get the Filing First" Premium pitch. Options:
  dedicated /latency page, reframed plain-English copy with consistent sign
  conventions, or gate until win rates are marketable. (GROK's latency week is
  attacking the underlying speed problem; this is only about presentation.)
- **Editorial restyle appetite** — see mock verdict below ([#1459](https://github.com/jaywedgeworth22/Congress.Trade/issues/1459)).

## Grok's mock (congresstrade.grok.me) — verdict

Distinctive "Capitol Ledger" editorial identity: warm paper background, serif
display headlines, monospace data accents, party-ringed member photos. Worth
harvesting regardless of restyle appetite (**#1459**): icon-only compact theme
toggle (fixes #1456), path routes incl. `/politician/:slug` (SEO + universal
links prep), feed cards surfacing filer owner + relative filed time + full
bracket text, radically simpler filters (All/Buys/Sells + D/R/I + one search
box vs cryptic H/S/P + party emoji), Largest buys/sells (7d) home modules,
member photos everywhere. **Do not copy blind:** its product claims are
fiction for prod (reconstructed $1M portfolios, spy_alpha leaderboard, 15-min
delay tier, invented "Desk Notes" stories) and the "who is beating the S&P"
fantasy-league framing cuts against the disclaimer's careful
not-investment-advice line.

## iOS spot-checks (limited pass)

Verified: theme default system; APNs `register_device` slice landed (PR #1446,
`push_devices` migrate applied) — HTTP/2 fan-out + .p8 credentials remain
(#1046); IAP still needs App Store Connect products (board row). The prior
comprehensive iOS backlog (#1048 universal links / ShareLink / Sign in with
Apple / magic link / widgets; WatchlistView absent; local-only search;
delete-all-reinsert refresh) remains the authoritative iOS work list — nothing
there was found to be stale. A deeper iOS re-review is worth a dedicated lane
once GROK's #1432 iOS polish wave lands, to avoid overlap.

## Coordination audit

- **Slack #ag***-s**c**: healthy cadence — GROK claim/closeout discipline is
  good; a parallel CLAUDE seat is running the same review for Socratic.Trade.
- **Effort board ↔ Issues mirror**: the sync (scripts/sync-effort-issues.py)
  keys state off the **section** a row sits in, not the row's own
  COMPLETED/IN-PROGRESS text. Found and fixed this push: 3 rows stranded
  above/outside any `##` section (invisible to the sync), 4 rows jammed into
  one line by literal `\n` sequences (mirrored as one issue — #1445's title),
  and 6 COMPLETED-text rows still sitting in Active keeping mirror issues
  #1449/#1435/#1413/#1412 open. After this push the sync will close/relabel
  them; the split latency-week row gets a fresh mirror issue (old #1445
  orphans) — flagged to GROK in the closeout.
- **Incident #1191** (502 on 7/30, pipeline degraded 8/4): live health check
  today is all-green (dead letter 0, data fresh) — closed with receipt.
- **Pricing truth**: $5/mo · $50/yr (owner decision 2026-08-05, PR #1345)
  supersedes the earlier $9/$90 — live site, wave4-auth-billing.md, and board
  agree. (Stale agent memory corrected.)
- **CI runners**: both `oracle-congress-ci{,-2}` restarted by GROK today after
  being found offline — worth a watchdog eventually, not filed as an issue
  since GROK's runner lane owns it.

## Priority take

1. Data correctness first — #1452/#1453 undermine trust in every number shown.
2. #1455 decision (it's live on the Premium sales page today).
3. #1456 mobile header (every phone visitor sees it) — coordinate with GROK #1432.
4. #1454 directory perf, then the polish pair #1457/#1458.
5. Harvest #1459/#1460 into the next UI wave.
