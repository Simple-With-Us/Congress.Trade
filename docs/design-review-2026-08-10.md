# Congress.Trade — UX Design Review

**Date:** 2026-08-10 · **Author:** design lead (CLAUDE seat) · **Branch:** `claude/ios-settings-ux`
**Surfaces audited:** desktop web (1440×900/1080, light + dark), mobile web (375×812, touch emulation), native iOS
**Status:** review only.  No code was edited to produce this document.

---

## 0. The brief, and what it actually says

The owner's words:

> "…there are too many places where I see things like the 'First Trade' and 'Last Trade' for Coca Cola having date on
> far right of screen with 3 digit name of month for some reason too, lol, while there is 70+% of the screen width
> blank between them and its hard to even tell if they are related… this is just a little example, many things like
> this so UI experts should use the actual iOS app and mobile site and desktop site for all features"

He is not asking for a colon.  He is reporting that **a label and its value can sit at opposite edges of the screen
with a void between them, and that this keeps happening**.  He is right, and he is under-reporting it.  The KO row he
saw has a 52% gap.  The flagship Trends page on desktop ships the identical failure at **82%**, thirty-three times, on
the first screen a new visitor sees.

So the deliverable is not a bug list.  It is the answer to "why does this keep happening", plus the small number of
changes that stop it happening again.

---

## 1. THE ROOT CAUSE

**104 raw observations across three surfaces collapse to 81 distinct defects.  Nine root causes account for 76 of
them.  Six of those nine are a single shared component or helper that does not exist yet.**

That is the finding.  The product does not have a broken screen; it has **nine missing abstractions**, and every
screen re-invents them locally.  Every "little example" the owner names is one call site improvising something that
should have been decided once.

### The governing fact

**The web app already solved the owner's complaint.  iOS never got the fix, and the web fix was never applied
outside the drawer.**

`app/src/ui/dashboardHtml.ts:943` — `.drawer-kv`:

```css
grid-template-columns: 35% 1fr;   /* label col, value col */
```

with the value **left-aligned in column 2** and this comment in the source at `:530`:

> label/value on the SAME line (owner: stacked label-above-value "is impossible to look at without getting a headache")

and the mobile block at `:1626` explicitly refusing to collapse it.  Measured live at 375px: label at x=16, value at
x=133 on every row, one shared entry guide, gap = 9% of the container.  **That is the correct component and it is
already shipping.**

`clients/ios/CongressTrade/Views/Components/Components.swift:256-276` — `DetailRow`:

```swift
HStack(alignment: .top) {
    Text(label).foregroundStyle(.secondary)
    Spacer(minLength: 18)                      // ← this is the entire KO bug
    Text(value).multilineTextAlignment(.trailing)
}
```

`Spacer()` is the defect.  It is used by every `DetailRow` call site on iOS, plus four hand-rolled copies.  **One
component, ~30 rows, the owner's #1 complaint.**  Verified still present on the in-flight branch as of this review.

### The nine causes

| # | Root cause | Distinct defects | Fix shape |
|---|---|---|---|
| **RC1** | **No row primitive.**  Key/value layout is improvised per call site with `Spacer()` (iOS) or `justify-content: space-between` (web), so nothing constrains the gap. | 9 | 2 component edits |
| **RC2** | **No display-labeler layer.**  Database enums reach the screen raw or bare-capitalized; the label tables that exist are duplicated per client and incomplete. | 10 | 1 server field set + 1 client table |
| **RC3** | **One data-integrity defect is rendered as product truth.**  `securities_ref.sector` holds three provider vocabularies; the UI prints the collision instead of resolving it. | 3 | 1 display rule + 1 upstream ticket |
| **RC4** | **No formatting contract.**  Dates, signs, estimate marks, decimals, separators and numeric alignment were each decided at the call site.  Six date formats, five separators, three meanings for `~`. | 16 | 4 shared helpers |
| **RC5** | **Identity chrome is authored per layer.**  Nav title, hero, chip row, ledger and footer each restate the entity independently, so nothing dedupes. | 10 | 1 header builder |
| **RC6** | **No token scale, no control inventory.**  3,644 off-scale spacing values on one page; 34 controls resolving to 10 distinct (height\|radius) pairs. | 6 | mechanical migration + 3 sizes / 2 radii |
| **RC7** | **No container discipline.**  No page grid, no column budget, no responsive-table policy — so a table can be 4,027px wide inside a 1,320px box. | 9 | 1 grid + 1 table policy |
| **RC8** | **Touch is a second-class surface.**  Meaning is carried by `title`/`:hover` (1,183 title attributes, 32 hover rules, exactly 1 hover guard) and tap targets sit below 44pt. | 7 | 1 media-query pass + tap-toggle popover |
| **RC9** | **Voice is unowned.**  Internal/operator state is shipped as user copy; empty and error states were never designed. | 6 | copy pass + empty-state vocabulary |
| — | Genuine one-offs (no shared cause) | 5 | individual |

Read that table as the answer to the owner's question.  **He is not seeing 81 mistakes.  He is seeing nine missing
decisions, made 81 times.**

---

## 2. RANKED WORK QUEUE — by user impact

Ranked by how many users hit it, how badly it distorts the product's meaning, and how many instances one change
kills.  ★ marks **one shared change that resolves many instances at once**.  Those are the top of the list and must
be done first — doing them last means re-touching every call site twice.

| Rank | ★ | Item | Surfaces | Sev | Instances fixed |
|---|---|---|---|---|---|
| 1 | ★ | **[D01] Ledger row primitive — kill `Spacer()`** | iOS | Blocking | ~30 rows, every detail sheet |
| 2 | ★ | **[D02] Trends flow rows — kill `space-between`** | web ×2 | Blocking | 33 rows on the flagship page |
| 3 | ★ | **[D10-D14] Display-labeler layer** | all 3 | Blocking | 5 enums × ~12 call sites |
| 4 | ★ | **[D20] Sector/Industry collision display rule** | all 3 | Blocking | KO + every enriched ticker |
| 5 | ★ | **[D64] Hover/`title`-only meaning on touch** | mobile web | Blocking | 1,183 tooltips, all filter chips |
| 6 |  | **[D55] Assets table: 67% unreachable** | desktop | Blocking | whole Directory › Assets tab |
| 7 |  | **[D60] KPI tile value overflows its own card** | mobile web | Blocking | Trends first screen |
| 8 | ★ | **[D71] Operator state shipped as product copy** | all 3 | Blocking | 2 strings, every no-price trade |
| 9 |  | **[D40] Trade drawer: asset name 4× on one screen** | mobile web | Blocking | every trade drawer |
| 10 | ★ | **[D28/D29] Signed + estimate-marked money** | all 3 | Major | every net-flow figure |
| 11 | ★ | **[D23/D24] Date format + date-kind vocabulary** | all 3 | Major | ~14 rows across 3 drawers |
| 12 | ★ | **[D81] One separator** | all 3 | Major | ~180 occurrences, 5 systems |
| 13 | ★ | **[D39] Entity-header builder (nav = class, hero = identity)** | all 3 | Major | 3 drawers × 2 platforms |
| 14 | ★ | **[D34/D35] Tabular figures + numeric right-align** | all 3 | Major | every number in the product |
| 15 | ★ | **[D58/D59/D57] One responsive-table policy** | web ×2 | Major | 5 tables |
| 16 |  | **[D56] Trends page grid** | desktop | Major | 12 panels |
| 17 | ★ | **[D65/D51] Control inventory + 44pt touch floor** | mobile web, iOS | Major | 23 component classes |
| 18 |  | **[D21] "Net Flow by Sector" ranks industries against sectors** | web ×2 | Major | flagship ranking is wrong |
| 19 |  | **[D77] Counts have no scope label (988 vs 22,832)** | web ×2 | Major | 3 surfaces disagree |
| 20 |  | **[D66] Chart x-axis invisible at 375px** | mobile web | Major | Buys vs Sells chart |

Everything below rank 20 is in the per-cause sections.  The **order of operations** matters more than the ranking:

1. **Primitives first** — D01, D02, D03 (row), then D10-D14 (labeler), then D23/D28/D81 (format helpers).
2. **Then the containers** — D55, D56, D58, grid and table policy.
3. **Then the copy pass** — D71, D24, D44, empty states.
4. **Polish last** — spacing migration, control inventory, type floor.

Doing 3 before 1 means writing copy into rows that are about to be rebuilt.

---

## 3. THE STANDARD — Congress.Trade Layout Contract v1

This is the contract all future work builds against.  It is normative.  Every rule below is derived from something
this product already ships and the owner already blessed, or from a defect the owner named.

### 3.1 Key/value rows

**Decision procedure.**  Given facts to render, apply in order; first match wins.

| # | Test | Form |
|---|---|---|
| 1 | ≤ 3 short self-labeling atoms identifying one entity (ticker, exchange, party, state) | **Inline run** (§3.4) |
| 2 | ≥ 3 sibling rows, **same measure and unit**, whose job is vertical comparison | **Comparison list** (§3.3) |
| 3 | A single free-text blob > 60 characters | **Stacked block** (§3.5) |
| 4 | Everything else | **Ledger row — THE DEFAULT** (§3.2) |

KO's Security and Congressional Trading sections fall to rule 4 in every row (a date, a count, a string, a dollar
figure — heterogeneous).  They are rendered today as if rule 2 applied.  That is the error.

### 3.2 The default: ledger row — `Spacer()` is banned

Two-column grid.  Label in column 1 left-aligned; value in column 2 **left-aligned**, starting at a fixed x-offset
shared by every row in the section.  No elastic space.

| Token | Web | iOS |
|---|---|---|
| Label column | `min(35%, 180px)` | `min(38%, 160pt)` |
| Gutter | `14px` | `14pt` |
| Row rhythm | `8px` (`6px` ≤ 720px) | `8pt` |
| Ledger max measure | `560px` | n/a |
| Value alignment | `text-align: left` | `.frame(maxWidth:.infinity, alignment:.leading)` |
| Vertical alignment | `align-self: center` | `.firstTextBaseline` |

Web ships all of this except the `180px` / `560px` caps — add them so a wide drawer does not re-open the void.

iOS target geometry:

```
HStack(alignment: .firstTextBaseline, spacing: 14) {
    label  .frame(width: labelW, alignment: .leading)   // labelW = min(0.38 * innerW, 160)
    value  .frame(maxWidth: .infinity, alignment: .leading)
}
```

**Label type** (both platforms, already shipping on web at `:944`): 10.5px/`.caption2`, weight 700/`.semibold`,
uppercase, letter-spacing `0.4px`, `--text-dim`/`.secondary`.
**Value type:** 13px/`.subheadline`, weight 600/`.medium`, `--text`/`.primary`, tabular figures.

**Label copy ≤ 18 characters.  Ellipsis on a label is banned** — shorten the copy, never truncate it.

**No colons.**  The uppercase-dim label against the sentence-weight value already encodes "key, value".  The owner
said he does not need one; he is right, and adding one would be redundant ink.

**No leader dots.**  They are a table-of-contents device for values pinned to a page trim.  Nothing here has that
constraint; dots are ink whose only job is to repair a gap that should not exist.

### 3.3 The one exception — comparison lists

Justified (label left / value right) is permitted **only** when all three hold: (1) ≥ 3 consecutive sibling rows share
the right column, (2) every value is the same measure and unit, (3) values are tabular and right-aligned to a **single
shared guide**.  Under those conditions the right edge *is* the comparison instrument.

This is `.hbar / .hlabel / .hval` (Top Buyers, Top Sellers, Most-Traded) and it is correct as shipped **on desktop**.
At 375px it fails clause 3 — six different right edges, four of them outside the container — see D03.

### 3.4 Inline run

One line, max **4 atoms**, joined by the house separator, facts self-labeling.  A 5th atom means the set wants a
ledger.

**House separator:** `|` at `opacity: .5`, `margin: 0 6px` — i.e. `<span class="dot-sep">|</span>` on web,
`"  |  "` with literal spaces on iOS.  Raw `'  |  '` inside HTML collapses to one space and must not be used.

Note for the owner: his documented preference is wide `  •  ` / `  /  `; the code's most-correct existing
implementation is `.dot-sep` with `|`.  **Both are "wide separator with real space around it", which is the actual
preference.**  Recommendation: keep `|` between *identity atoms* (`KO | Coca-Cola | NYSE`) and `  •  ` / `  /  `
between *fact atoms* (`76 buys  /  91 sells  •  28 politicians`) — which is what Net Flow by Sector already does
correctly.  Two roles, two glyphs, both wide.  Everything else collapses into these two.

### 3.5 Stacked block

Label on its own line, value beneath at full width, 8pt between.  **Only** for free text > 60 characters.  Never for
a date, number, code or enum.

### 3.6 Why this is right (the typography, so nobody re-litigates it)

Two Gestalt principles are in conflict in the KO row and the wrong one is winning.

**Proximity.**  The vertical gap between "First Trade" and "Last Trade" is ~8pt.  The horizontal gap between "First
Trade" and its own value is ~170pt — **21:1**.  The eye therefore groups labels with labels and values with values,
producing two unrelated lists.  The owner's "it's hard to even tell if they are related" is a literal, correct
description of that.  A 66pt intra-pair gap against an 8pt row rhythm is 8:1, and the uppercase-dim vs solid type
contrast breaks the remaining tie by making the two columns typographically dissimilar.

**Common region.**  The section panel already supplies the grouping boundary, which is why the fix needs **no
per-row rule** — per-row hairlines would over-segment.

### 3.7 Dates

Abbreviation must always be a **response to a width constraint**.  That is the governing rule, and it is exactly the
owner's objection: `Mar 13, 2014` is not wrong, but abbreviating with 70% free width is unmotivated.

| Context | Format | Example |
|---|---|---|
| Detail-sheet ledger row (unconstrained) | `MMMM d, yyyy` | `March 13, 2014` |
| Dense table cell, column ≥ 96px | `MMM d, yyyy` | `Mar 13, 2014` |
| Dense table cell, column < 96px | `M/d/yy` | `3/13/14` (slashes — hyphens read as a range) |
| Timestamp | date + `·` + time | `March 13, 2014  ·  4:07pm` |
| Chart axis, span ≤ 18 months | `MMM d` | `Mar 13` |
| Chart axis, span > 18 months | `MMM ’yy` | `Mar ’14` |
| Freshness / telemetry only | relative | `Updated 3 minutes ago` |

**Relative time** is permitted only for data freshness and only within 14 days.  **Never relative-only for a fact of
record** — a trade or filing date is evidence about a Member of Congress; "50d later" is not citable.  Pair them,
absolute first: `Filed June 2, 2026  ·  2 days ago`.

**Date-kind vocabulary** (this product carries six confusable dates — fix the words once):

| Concept | Canonical label | Never |
|---|---|---|
| When the Member transacted | **Traded** | "Date", "Transaction" |
| Official date on the disclosure | **Filed** | "Reported", "Official Filed" |
| When we first observed it | **Detected** | "Seen", "First Seen" |
| When the row entered our DB | **Imported** | "Created" |
| Traded → Filed elapsed | **Filing Lag** | "Disclosure Lag", "Lag" |

**Any bare date whose kind is not established by a column header or ledger label must carry a lowercase kind word** —
`filed Jun 2, 2026`.  `miniTradeDateHtml` (`:10084`) already does this correctly; copy it.

### 3.8 Numbers

- **Signed money always shows its sign in text.**  Positive → `+`.  Exact zero → `$0` / `0.0%`, unsigned.  **Colour
  may never be the sole carrier of sign** (WCAG 1.4.1; also ~8% of male users).
- **Estimates carry `~`.**  Anything derived from STOCK Act bracket midpoints — including Net Flow.  The bracket
  itself is exact and must **not** carry `~`.  `~` has exactly one meaning; do not use it for "approximately" in
  marketing copy or for period labels.
- **Compact vs full:** ledger rows and hero figures full and grouped (`$238,412`); tiles, cells and chips compact
  (`$238k`).  Suffixes lowercase `k m b t`.  Decimals key off the **mantissa**, not the suffix: ≥10 units → 0
  decimals, <10 → 1 decimal, trailing `.0` stripped.
- **Percentages:** signed contexts `+5.3%`; unsigned contexts `62%`.  Never `+62%` for a win rate.
- **Absent ≠ zero.**  Measured zero is `$0`.  Not disclosed → `Not disclosed`.  Not enriched → `Not yet enriched`.
  Structurally unavailable → `—`.  Below threshold → `n < 5`.  **Banned:** `N/A`, Title Case values
  (`Not Enriched Yet`), capital-U `Unavailable`.
- **Tabular figures are mandatory** on every rendered number, both platforms.  Numeric table columns right-align with
  matching decimals and shared right padding; label/entity columns stay left; dates and badges unchanged.

### 3.9 Raw-value ban

> **No view may render a string from the database or API without passing it through a named display labeler.
> `.capitalized` / `charAt(0).toUpperCase()` is not a labeler.**

**Enforceable check:** grep both clients for `.capitalized`, `charAt(0).toUpperCase`, and direct interpolation of a
model enum into `Text(...)` or a template.  Every hit is a bug.  Current hits (verified 2026-08-10):
`Components.swift:37`, `TickerDetailView.swift:63,72`, `TradeDetailView.swift:87,123`,
`PoliticianDetailView.swift:57`, `TrendsView.swift:491`, `dashboardHtml.ts:3107,10061`.

**Where the layer lives.**  The backend is the source of truth (CLAUDE.md, AGENTS.md) and clients share one
`/api/client/v1/*` contract.  Two independent label tables is exactly the drift that produced three renderings of
`mega`.  **Ruling:** the server emits the label beside the code —

```
"marketCapBucket": "mega",   "marketCapBucketLabel": "Mega Cap"
"assetClass":      "equity", "assetClassLabel":      "Common Stock"
"chamber":         "house",  "chamberLabel":         "House"
"txType":          "P",      "txTypeLabel":          "Buy"
"owner":           "joint",  "ownerLabel":           "Joint"
```

Clients render `*Label` and never the code; the code stays for filtering, sorting and colour.  Until that ships,
**`dashboardHtml.ts` is canonical** and iOS mirrors it verbatim with a comment citing the line.  If `*Label` ships,
`app/docs/client-mobile-api.md` must be updated in the same PR.

### 3.10 Redundancy

> **One screen may not display the same value twice.**  A repetition is either noise to delete, or evidence that two
> fields collided — and then the UI shows the **more specific** field once and suppresses the other.

Two carve-outs only: nav chrome that is a truncation of content for scroll context, and table header vs cell.

**Entity-header contract** (ticker, member, trade):

1. **Nav bar carries the entity *class*** — `Ticker`, `Politician`, `Trade Details`.  (`TradeDetailView.swift:132`
   already does this correctly; `TickerDetailView.swift:124` and `PoliticianDetailView.swift:122` do not.)
2. **Hero line 1:** logo + `KO  |  The Coca-Cola Company` — exactly what web's `drawerCompanyTitle` (`:10068`) does.
3. **Hero line 2:** meta run, ≤ 4 atoms, **deduplicated case-insensitively, with anything already in line 1
   removed.**  For KO that leaves `NYSE  |  Beverages`.
4. **Hero line 3:** price.

**Screenshot-checkable form:** extract all visible text, normalize, count.  Any token ≥ 3 characters appearing twice
outside the two carve-outs is a finding.

### 3.11 Spacing, controls, containers

**Scale — normalize to this, do not invent another:** `2 · 4 · 8 · 12 · 16 · 24 · 32 · 48`.
Mechanical migration for the web strays:
`3→4 · 5→4 · 6→8 · 7→8 · 9→8 · 10→12 · 11→12 · 13→12 · 14→16 · 18→16 · 19→16 · 21→24 · 22→24 · 26→24 · 29→32 · 30→32 · 35→32`.
Two exceptions: separator glyph margins (6px, §3.4) and 1px borders.

**Controls:** three sizes (sm 28 / md 32 / lg 40) and two radii (`r-control` 8px, `r-pill` 999px).  On touch, every
interactive element gets a 44×44 minimum hit area (a pseudo-element expander is fine where visual density matters).
Adjacent controls need ≥ 8px separation or a divider — **two bare adjacent controls with no gap read as one segmented
control**, and a segmented control means one mutually-exclusive choice.  `Share` + `Done` is not that.  Neither is
`Sign In` + `Upgrade`.

**Panels:** `r-card` 12px web / 16pt iOS; nested radius = outer − 4 (nested-larger is a bug); one hairline;
nesting depth ≤ 2; section padding 24 desktop / 16 mobile; gap between sections 24.

**Section headers:** 11px/`.caption`, weight 700/`.bold`, uppercase, letter-spacing 0.6px, dim, 12 below.  Source
string stays Title Case (screen readers).  **No subtitle unless it states a constraint the reader cannot infer** —
"Trade Summary" needs nothing; "Performance vs S&P 500" needs its methodology note.

**Containers:** every view sits on a declared grid with declared column widths.  A table may not exceed its scroll
container's width without a visible edge affordance, and below 720px a table either degrades to cards or reflows its
overflow columns into a second line — **one policy, not two**.  Nested scrollers inside a scrolling page are banned
on touch.

**Type floor:** 10px for any non-decorative text; 11px for chart axis labels.

### 3.12 Copy

Owner conventions, binding: Title Case for controls and labels; sentence case for values and secondary status; two
spaces after every sentence in prose; wide separators; "Trades", never "feed"; no subtitles that restate the obvious;
`Congress`/`Congressional` always capital C.  Compact money suffixes lowercase.  iOS nav titles always inline.

**Never ship operator state as product copy.**  "once a market-data API key is configured", "as the price cache
backfills", "HTTP 502" are engineering facts.  The user gets availability, not cause.

### 3.13 Conformance checklist — grade a screenshot against these

1. No row places label and value at opposite edges with gap G where `G > 0.25 × W` or `G > 96` units, unless it is a
   ≥3-row same-unit comparison list.
2. Every ledger value in a section starts at the same x.
3. No leader dots.  4. No ellipsized label.
5. Separators are wide (≥6 units each side) and do not collapse.
6. Detail-sheet dates use the full month; tables abbreviate only under a real width constraint.
7. No bare date lacks a kind word or column header.
8. Every sign-bearing number shows `+`/`-` **in text**.
9. Estimate money carries `~`; bracket money does not.
10. All numbers tabular; numeric columns right-aligned with matching decimals.
11. Measured zero and unknown are visually distinct; no `N/A`; no Title Case values.
12. No lowercase DB enum and no `.capitalized` output reaches the screen.
13. `Sector` and `Industry` never show the same value.
14. No token ≥ 3 chars appears twice on one screen outside the two carve-outs.
15. Nav title names the entity **class**; the entity name appears once, in the hero.
16. Every spacing value is on the scale.  17. Nested radius < outer; nesting depth ≤ 2.
18. Every touch target ≥ 44×44 with ≥ 8 units of separation.
19. Nothing is explained only by `title` or `:hover`.
20. No internal/infrastructure state in user-visible copy.

---

## 4. FINDINGS, GROUPED BY ROOT CAUSE

Each item: **surfaces · severity · fix · anchor**.  ★ = shared-component change.  A defect on two surfaces is **one
item**, not two.

### RC1 — No row primitive

**★ D01 — iOS ledger rows use elastic space.**  *iOS, all detail sheets.  **Blocking.***
This is the owner's KO report verbatim, and it is one component.
Fix: rewrite `DetailRow` to §3.2 geometry; delete the four hand-rolled `HStack { Text; Spacer(); Text }` copies and
route them through it.
`Components.swift:256-276` (primary) · call sites `TickerDetailView.swift:54-98`, `TradeDetailView.swift:86-123`,
hand-rolled at `TradeDetailView.swift:59-84` (`Spacer()` at `:62`, `:78`) and `:106-118` (`Spacer()` at `:108`).

**★ D02 — Trends flow rows are justified with no measure cap.**  *desktop + mobile web.  **Blocking.***
Measured at 1440px: `Technology … ~$3.8m` gap = **518px on a 634px row = 82%**; Industrials 83%.  Thirty-three rows.
Does **not** qualify for the §3.3 exception — a magnitude bar directly beneath each row is already the comparison
instrument.
Fix: replace `justify-content: space-between` with `grid-template-columns: min(35%,180px) 1fr; gap:14px`, value left
in column 2 — i.e. make it `.drawer-kv`.
`dashboardHtml.ts:877` (`.flowrow .ftop`) · emitted from `flowRowHtml` `:9502-9503`.

**D03 — `.hbar` rows have no shared right guide and overflow at 375px.**  *mobile web.  **Blocking.***
Row width 309px; children end at 333/337/342/295/342/307 — six right edges, four outside the container.  Two labels
ellipsize (`Government / Municipal Debt`, `Corporate Debt`).  This block claims the §3.3 exception and fails clause 3,
so on mobile it is not a comparison list — it is a broken ledger.
Fix: 3-column grid `minmax(0,1fr) 1fr max-content` with a fixed right value column and tabular figures; shorten
labels rather than ellipsizing.  If a shared guide cannot be held, convert to §3.2.
`dashboardHtml.ts:10160-10165`, `:10267-10271`.

**D04 — iOS Trends sector and market-cap rows use `Spacer()`.**  *iOS.  **Major.  REGRESSION RISK — this is new code
on the in-flight branch.***
The Wave 1 sector work (correctly) adds "Other"/"Unknown" rows, but the row itself is
`HStack { Text; Spacer(); Text(CompactFormat.usd(...)) }` — a new instance of D01 *and* of D28 (no `+`).
Fix: route both lists through the rebuilt `DetailRow`/comparison component before merge.
`TrendsView.swift:452-510` (branch state).

**D05 — `.drawer-kv` label column is a percentage, not content-sized.**  *web ×2.  **Minor.***
Short labels (`NAME`, `SEEN`) open a 120-124px gap = 30% of a 399px block, which still trips §3.13.1.
Fix: `min(35%, 180px)` label column, `max-width: 560px` on the ledger block; size the column to the longest label in
the section.  `dashboardHtml.ts:943` and `:534` (`.def-grid`).

**D06 — `Avg. Disclosure Lag` ellipsizes to `AVG. DISCLOSUR…`.**  *mobile web.  **Major.***
19 characters in a 107px column (clientWidth 107 / scrollWidth 126).
Fix: rename to **`Filing Lag`** — fixes the truncation and the §3.7 vocabulary defect in one edit.
`dashboardHtml.ts:10287`.

**D07 — Delivery create form has one label, and it is the only colon in the product.**  *desktop web.  **Major.***
Five of six controls communicate via placeholder or current value; two 1,830px full-bleed inputs sit beside a 140px
select; the disabled primary button's blocking reason is 430px away.
Fix: real eyebrow labels above each control, no colon, consistent widths on the grid, blocking reason as the button's
own helper text.  Delivery form region, `dashboardHtml.ts` ~`:2700`.

**D08 — Trades search field is 178px for a 34-character placeholder, and its Search button is 550px away.**
*desktop.  **Minor.***  `dashboardHtml.ts:2301`.

**D09 — Orphaned controls in both modals.**  *desktop.  **Major.***  Columns `Reset` floats at x=1279, level with the
"Sector" row, ~500px from the list it resets; Filter's "Search this page" label sits ~620px from its field.
`dashboardHtml.ts:2333`, `:2338`.

### RC2 — No display-labeler layer

**★ D10 — `assetClass` raw.**  *iOS (owner defect #3) + web ×2.  **Blocking on iOS.***
iOS prints `equity`; web prints `Equity` because `assetClassLabel` has no `equity` entry.  Meanwhile Trends calls the
same concept "Public Equity" and the trade drawer calls it "Stocks (including ADRs)" — three names, two on one screen.
Fix: add `equity: 'Common Stock'` at `dashboardHtml.ts:3229`; route iOS through the mirrored table; reconcile the
three names.  `TickerDetailView.swift:71-72`.

**★ D11 — `marketCapBucket` renders three ways.**  *all 3.  **Major.***
`Mega Cap` (Trends, via `CAP_NAMES`), `Mega` (drawer, via `ownerLabel`), `Mega` (iOS, via `.capitalized`).
**`CAP_NAMES` is canonical.**
`dashboardHtml.ts:9549` (canonical), `:10055`/`:10061` (offender), `:3107` (`ownerLabel`) · `TickerDetailView.swift:63`,
`TradeDetailView.swift:123`, `TrendsView.swift:491`.

**★ D12 — `chamber` renders five ways.**  *all 3.  **Major.***
`P` (chip), `Executive branch` (that chip's aria-label), `President` (Directory), `Exec` (Trends), `Executive`
(Delivery).  Also called "Branch" in one header, "Branches" in its select, "Chamber" in the Columns modal.
Fix: `chamberLabel` returns **`Executive`**; every call site routes through it; pick one of Branch/Chamber.
`dashboardHtml.ts:3214`, `:3913` (uses `ownerLabel` instead) · `Components.swift:32-37`,
`PoliticianDetailView.swift:57`.

**★ D13 — `party` leaks raw `D`/`R`, and elsewhere is colour-only.**  *all 3.  **Major.***
Directory shows `House • D • CA - 17ᵗʰ` while the drawer 200px away shows `● Democrat · House · California`.  The
dot-only renderings fail §3.8's colour rule.
Fix: `PARTY_NAME` (`:3086`) everywhere; short form `Dem`/`Rep`/`Ind` when width forces it, never a bare letter;
always pair the dot with text.  `PoliticianDetailView.swift:57`.

**D14 — `owner` is a bare capitalize.**  *web ×2 + iOS.  **Minor.***  Breaks on `dc`/multi-token; the trade drawer
shows `DEPENDENT` in a chip and `Child` in the filing notes on one screen.  `dashboardHtml.ts:3107` ·
`TradeDetailView.swift:87`.

**D15 — Display label and raw code printed together.**  *web ×2.  **Major.***
`Corporate Bond [CORPORATE BOND]`, `Stocks (including ADRs) [ST]` — a raw-value leak *and* a redundancy in one cell.
Fix: drop the `[code]` suffix; move it to `title`/`aria-label` if support needs it.
`dashboardHtml.ts:3384` · call site `:10429`.

**D16 — `MUNICIPAL-SECURITY` is rendered as a ticker.**  *web ×2.  **Major.***
Bold mono, all caps, an "MU" logo tile — which collides with Micron's real MU — ranked 5th above META and GOOGL.  Its
own TYPE cell correctly shows `—`, so the app already knows it is not a security.
Fix: add synthetic sentinels to the labeler register (`Municipal bonds (grouped)`), no ticker-shaped chip, pin below a
divider or exclude from ranked lists.  File the symbol collision against ingest separately.
`dashboardHtml.ts:2638`, `:9213`; label exists at `:3288`.

**D17 — Raw provider company names.**  *all 3 (same API).  **Major.***
`BAC BANK OF AMERICA CORP /DE/`, `STARBUCKS CORP.CMN 6`, `Amazon.Com, Inc.`, `Bank of America Corp. /De/` (Title Case
mangling the state code), `Alphabet Inc. - Class A` vs `Meta Platforms, Inc. Class A`.
Fix: one server-side display-name normalizer (strip `/DE/`-style suffixes, `CMN`, trailing digits; acronym allow-list;
exceptions map) emitted as `nameLabel`.  **Overlaps Wave 2 D1/D2 — see §5.**

**D18 — Filing notes are a raw dump.**  *web ×2.  **Major.***
`2 07/24/2026 Child -- Hasbro Inc Note Rate/Coupon: 3.55% Matures: 2026-11-19 Corporate Bond Sale (Full) $1,001 -
$15,000 --` — leaks a row index, `--` sentinels, the owner code, and a bracket that visibly contradicts the `$1k -
$15k` in the hero 400px above.  Also collides with the asset name (mobile: identical string, different casing,
presented as two facts).
Fix: parse into labelled rows or strip index/sentinels/duplicates; suppress the block when `norm(note) ==
norm(assetName)`.

**D19 — `stockActStatus` and `source` are inline strings, not labelers.**  *web.  **Polish.***
`dashboardHtml.ts:3843-3845`, `:10431`.

### RC3 — Sector taxonomy collision

**★ D20 — `Sector` and `Industry` render the same value as two rows.**  *iOS (owner defect #2) + desktop + mobile.
**Blocking.***
Not a display accident.  `app/src/enrichment/providers.ts:98`:

```ts
sector: str(j.finnhubIndustry), // Finnhub has no true sector; its industry label is the best it offers
```

Finnhub writes an industry into `sector`; FMP writes a GICS sector; the SEC fallback derives one from SIC
(`enrichment/compute.ts:22`).  Three vocabularies, one column.  The UI is displaying a data-integrity defect as if it
were two facts.  Confirmed live on KO (Beverages/Beverages) and MSFT (Technology/Technology).

**Display rule — implement now, independent of the upstream fix:**

```
norm(sector) == norm(industry)      → one row, labeled "Industry", value = industry
sector is a known GICS sector       → both rows
sector is NOT a GICS sector         → one row, labeled "Industry", value = sector
                                      (suppress "Sector" — we do not have one)
```

Ship the 11-member GICS list as a constant; it is closed and stable.  **Never synthesize a sector to fill the row** —
suppressing a row we cannot honestly fill is correct; inventing one is not.
`dashboardHtml.ts:10047-10066` (`companySectionHtml`) · `TickerDetailView.swift:55-61`.
**Upstream ticket (must be filed):** stop writing `finnhubIndustry` into `sector`; write it to `industry` and leave
`sector` null when the provider has no GICS sector.  `providers.ts:98`.

**D21 — "Net Flow by Sector" ranks industries against their own parent sectors.**  *web ×2.  **Major.***
The list is `Technology, Semiconductors, Financial Services, Industrials, Healthcare, Consumer Cyclical, Retail,
Media, Electrical Equipment`.  Semiconductors ⊂ Technology; Retail ⊂ Consumer Cyclical; Media ⊂ Communication
Services.  A reader comparing `Technology ~$3.8m` against `Semiconductors ~$3.5m` is comparing a set with its own
subset, and the dollars are double-counted.
Fix: gate the ranking to the GICS constant and title it "by Sector"; put everything else in a separate "by Industry"
block, or retitle to "by Category" and stop implying a taxonomy the data does not have.

**D22 — Two sector vocabularies on one page.**  *desktop.  **Major.***
Net Flow by Sector says `Healthcare`; Committee Sector Conflicts says `Health Care`.  The codebase already knows —
the comment at `dashboardHtml.ts:9509-9512` names this exact split.  The normalizer exists; it is not shared.

### RC4 — No formatting contract

**★ D23 — Detail sheets abbreviate the month with unconstrained width.**  *all 3.  **Major.  This is the owner's
literal example.***
iOS `TickerDetailView.swift:96-97` calls `.shortDate` when `.longDate` already exists at `Components.swift:350`.  Web
has no `dateTextLong()` at all, so every `.drawer-kv` date abbreviates with ~140px of unused value column.
Fix: add `dateTextLong()` on web; switch iOS to `.longDate`; keep `dateText()` (`:3398`) for dense cells only.
`TradeDetailView.swift:97-99` already uses `.longDate` — correct, leave it.

**★ D24 — Wrong date-kind names, six ways.**  *web ×2.  **Major.***
`Seen` → **Detected**, `Official Filed` → **Filed**, `Disclosure Lag` → **Filing Lag**.  Also `Median Lag` /
`90ᵗʰ Percentile` / `>45 Day Lag` / `AVG`/`MAX`/`LATE` / `Lag` / `Lag 7d` for one measure, and `22 days` / `0-7d` /
`45d` / `filed 14d later` for its unit.
`dashboardHtml.ts:3909`, `:3912`, `:10287`, `:10426-10428`.

**D25 — Bare dates with no kind word on trade cards.**  *mobile web.  **Major.***
`… | Buy | $100k – $250k | Jul 27, 2026` with `Lag 7d` beneath — proving two dates exist and differ, while the card
never says which one is shown.  Fix: `traded Jul 27, 2026`, per the correct pattern at `:10084`.

**D26 — Relative-only filing dates.**  *mobile web.  **Major.***
KO Recent Trades: `filed 14d later`, `filed 50d later` — the absolute filing date never appears, so the user cannot
cite it, and 50d is well past §3.7's 14-day cap.  Fix: `filed August 4, 2026  ·  14 days later`.

**D27 — `compactDateText` emits hyphens, and the constraint is self-inflicted.**  *desktop.  **Major.***
The DATE column is 88px — just under the app's own 96px breakpoint — so the correct `Jul 27, 2026` is in the DOM at
`display:none` and `7-27-26` shows instead.  POLITICIAN holds 444px for ~200px of ink; COUNTRY holds 112px of em
dashes.  Hyphens also read as a range or a negative number.
Fix: rebalance so DATE ≥ 96px (the existing rule at `:448-455` then does the right thing automatically), and change
`:3405-3410` to `M/D/YY`.

**★ D28 — Positive money has no `+` on iOS.**  *iOS (owner defect #4).  **Major.***
`CompactFormat.usd` emits `-` for negatives and nothing for positives; `TickerDetailView.swift:91` uses it for Net
Flow.  Colour is the sole carrier — an accessibility failure as well as a clarity one.
Fix: add `CompactFormat.signedUsd()` and route Net Flow and every future delta through it.  `Components.swift:168-183`.

**★ D29 — Estimate `~` is missing on Net Flow, on all three surfaces.**  *all 3.  **Major.***
`Approx. Volume ~$125.5m` sits beside `Net Flow +$27.0m` — both computed from the same bracket midpoints, only one
marked.  Target: `~+$27m`.  Also drop the redundant word "Approx." where `~` is present (one marker, not two).
`dashboardHtml.ts:8614` (`estUsd`) + `:8617` (`netHtml`) composed · iOS `Components.swift:168`.

**D30 — `~` currently means three different things.**  *web ×2.  **Minor.***
Estimate (`~$238k`), "approximately" (`SAVE ~17%` — an exact 16.67%), and period rounding (`~1 mo`).  Also applied to
a real market cap (`~$3.6t`) and to an estimated zero (`~$0`).  Fix: reserve `~` for §3.8 estimates only.
`dashboardHtml.ts:2995`.

**D31 — `+0.0%` on exact zero, coloured green.**  *web ×2.  **Minor.***  `pctSigned` `:9564`.

**D32 — Decimal policy keys off the suffix, not the mantissa.**  *web ×2.  **Major.***
One column reads `~$10.0m, ~$22.1m, ~$1.2m, ~$816k, ~$155k, ~$56k, ~$8.0k` — two precision policies in a column whose
only purpose is vertical comparison, and trailing `.0` is never stripped.

**D33 — `63 % buys` vs `53% buys`.**  *web ×2.  **Minor.***  `:9599` emits `<small>% buys</small>` (the `<small>`
picks up a leading margin); `:10148` emits `'% buys'` with none.

**★ D34 — `th, td { text-align: center }` globally; numeric columns are centred.**  *web ×2.  **Major.***
`$1.2m` and `$938k` do not line up at any place value.  In one table EST. VOLUME is right-aligned and NET FLOW is
centred.  Centred headers sit over right-aligned data, so no header is over its own column.
Fix: keep the global as fallback; add `td.num, th.num { text-align: right }` and tag money/count/percent columns.
`dashboardHtml.ts:349`.

**★ D35 — iOS declares tabular figures nowhere.**  *iOS.  **Major.***
Every `MetricTile`, `TrendKPI` and `DetailRow` numeric value needs `.monospacedDigit()`; without it KPI tiles jitter
on refresh.  Web's hand-maintained selector list (`:350`) already misses classes — replace with
`font-variant-numeric: tabular-nums` on `body`, opting out for prose.
`Components.swift:42` (`MetricTile`) · `TrendsView.swift:610` (`TrendKPI`).

**D36 — Two numeric type families at the same size.**  *desktop.  **Major.***
`~$125.5m` renders in Inter and `+$27.0m` in ui-monospace, both 28px, side by side.  `.est-money` is Inter inside
`.v` and monospace at 12px in the sector panel — same class, two families.
Rules split across `dashboardHtml.ts:350, 727-732, 747, 879, 1692-1698, 1905-1910, 2166`.

**★ D81 — Five separator systems, two of them inside one row.**  *all 3.  **Major.***
Trends uses tight `·` (87×) for entity meta and wide `&nbsp;•&nbsp;` (90×) for fact runs, so `Ro Khanna · House · CA`
sits directly above `988 trades  •  857 buys  /  131 sells`.  Trades and drawers use `|`.  Delivery uses ` + `.
Directory uses `•` and ` - ` in one cell.  iOS uses `" · "` at six call sites.
Fix per §3.4: `|` between identity atoms, `  •  ` / `  /  ` between fact atoms, one helper, nothing tight.
`.fc-sep` `:486` (margin 1px → 6px) · `.dot-sep` `:548` · `.join(' · ')` `:9731`, `:10250` ·
iOS `TickerDetailView.swift:158`, `PoliticianDetailView.swift:57`, `PeopleDirectoryView.swift:211,213`,
`TrendsView.swift:479`, `FeedDashboardView.swift:1089`.

**D37 — Buy/sell vocabulary, five renderings.**  *web ×2.  **Polish.***  `Buy`/`Sell` pills, `BOUGHT`/`SOLD` badges,
`BUYS`/`SELLS` legend, `Buys`/`Sells` legend, `21 buys / 0 sells`, `▲/▼/⇄` chips, `Buys + Sells + Exchanges`.
`typeName` `:3105` is already canonical.

**D38 — `TYPE` means two different things in two tables.**  *web ×2.  **Polish.***  Transaction side in Trades, asset
class in Assets; a third table calls side `SIDE`.  Fix: `SIDE` and `CLASS`.

### RC5 — Redundancy and identity chrome

**★ D39 — Entity headers repeat the entity.**  *all 3 (owner defect #5).  **Major.***
KO on iOS: nav `KO` → logo → `Coca-Cola Company` → `KO · NYSE · Beverages · Beverages`.  Ticker twice, Beverages
twice, four lines for two facts.  The meta-run builder does `.compactMap{}.filter{}.joined()` with **no dedupe and no
removal of what line 1 already showed** — that is the whole defect in four lines of code.  Web drawers do the same
thing differently: the top bar prints the full sentence `SOLD $1k - $15k of ARCC | Ares Capital Corporation` and the
hero re-prints every token.
Fix: one shared header builder implementing §3.10.  `drawerCompanyTitle` (`:10068`) is the correct model — propagate
it, do not replace it.
`TickerDetailView.swift:124` (nav), `:149-159` (meta run) · `PoliticianDetailView.swift:122` ·
`openTrade :10354`, `openAsset :10135`, `openMember :10243`.

**D40 — Trade drawer prints the asset name four times.**  *mobile web.  **Blocking.***
Chrome title (ellipsized), hero, standalone chip, and FILING NOTES — the last differing only in capitalisation, i.e.
two normalisations of one string presented as two facts.  Plus `BOUGHT` ×2, `$100k - $250k` ×2, the member ×2, and
two separate controls to the same member.

**D41 — Hero meta run repeats the KPI tiles.**  *web ×2.  **Major.***
`19 trades | 7 politicians | ~$2.5m approx. volume`, then the same three values as tiles 400px below.  The tiles also
use sentence-case 13px labels while the ledger 200px above uses the uppercase eyebrow — three label typographies for
one kind of element.  `.dsub` `:10190`.

**D42 — Performance block renders twice when filing lag is 0.**  *desktop.  **Major.***
`▲ 4.5% since sold` and `▲ 4.5% since reported` with identical three-line bodies, because traded-date and filed-date
resolve to the same price date.  Fix: collapse to one block labelled "since traded and filed (same day)".
`dashboardHtml.ts:9944`, `:9958`.

**D43 — `Past 3 Months` stamped on 12 panels under a global filter that already says it.**  *desktop.  **Minor.***
Keep it only where a panel's window differs from the global one (Buys vs Sells 1Y/3Y/5Y genuinely needs it).

**D44 — "this page" ×5 in a 260px modal, plus the banned word "feed".**  *desktop.  **Major.***
Title, body, "Search this page", "Min $ (this page)", "Max $ (this page)"; body says "query the full feed"; the
Premium modal says "the filtered trade feed".  Also single-spaced sentences where neighbouring copy is correctly
double-spaced.
Fix: "Narrows the rows already loaded here.  Use the search field above to query all trades."  `:2337`.

**D45 — Four affordances to the same politician in one drawer.**  *web ×2.  **Minor.***  Chip, `Politician Details`
button, ledger row chevron, footer link.  Chips also truncate (`Pete Ses…`) inside a 556px drawer with room to wrap.
`:10402`.

**D46 — Duplicated legal disclaimer and duplicated Delivery sentence.**  *mobile web.  **Minor.***
The 100+ character disclaimer appears in both the footer and the account menu; "Secrets are shown once at creation"
appears in two stacked cards ~500px apart.  Also: inline code chips use horizontal margin, detaching the following
punctuation (`EventSource , no polling.`).

**D47 — Delivery signed-out prompt shown twice plus a dead table header.**  *web ×2.  **Minor.***  `:2710`, `:6098`.

**D48 — Two performance blocks with identical sub-statistics.**  *mobile web.  **Minor.***
`Median excess -15.7% · Avg return +44.7% · 123 of 178 buys` printed under both "Their timing" and "If you bought at
filing", differing only in win rate (37% vs 36%) — reads as a copy-paste bug.  Fix: shared stats once, above both.

### RC6 — No token scale, no control inventory

**D49 — 3,644 off-scale spacing values on one page.**  *web ×2.  **Minor (mechanical).***
13px ×1,298, 11px ×987, 7px ×480, 9px ×438, plus 5/6/10/14/18/19/20/21/22/26/29/30/35.  This is why adjacent sections
never line up.  Apply the §3.11 migration table.

**D50 — 34 controls resolve to 10 distinct (height|radius) pairs.**  *desktop.  **Major.***
Six heights, four radii, including a 7px-vs-8px near-miss.  The primary conversion CTA ("Start Free Trial", 24px) is
the **shortest** control on the page; Sign In/Upgrade have square corners beside 8px-rounded nav tabs.

**★ D51 — Two adjacent bare controls fuse into one.**  *iOS (owner defect #6) + mobile web.  **Major.***
iOS: `Share` and `Done` are both `.topBarTrailing` with no separation and read as one segmented control.
Web: `.acct-auth-group` is a single 999px pill containing `Sign In` (l=118→r=224) and `Upgrade` (l=224→r=331) — zero
gap, child radii zeroed, no divider — on the app's primary conversion control.  Directly beneath it the theme
control is a second fused triple in the identical language, so a settings toggle and a paid conversion look like the
same kind of control.
Fix (iOS): **one trailing toolbar item maximum on a sheet.**  `Done` stays trailing; drop the Share toolbar item and
add a `Copy Link To KO` row at the sheet's foot — which is exactly what web already does (`copyLinkHtml :10199`).
Fix (web): separate by 8px or add a 1px divider; caption the theme segment.
`TickerDetailView.swift:126-141`, `PoliticianDetailView.swift:124-137`.

**D52 — Three modal header styles and three close buttons.**  *desktop.  **Major.***
`COLUMNS` / `FILTER THIS PAGE` are 11px uppercase dim — smaller and weaker than the body beneath them, inverting
their own hierarchy — while Sign In and Premium use a large bold Title Case heading.

**D53 — Three label typographies for the same tile element.**  *web ×2.  **Major.***  See D41.

**D54 — Codify nested radius and boundary depth.**  *web ×2.  **Polish.***  Per §3.11.

### RC7 — No container discipline

**D55 — Directory › Assets: 67% of the table is unreachable.**  *desktop.  **Blocking.***
Table is 4,027px inside a 1,320px box.  ASSET alone gets 3,729px for ~340px of ink, pushing TYPE / TRADES ▼ /
POLITICIANS to x=3790-4085.  The user sees a one-column list with ~1,000px of blank to its right, no scroll
affordance, the **active sort indicator off-screen**, and panel copy that says "Click a column heading to sort" while
pointing at headings that cannot be seen.  This is the owner's complaint in its most extreme form.
Fix: `table-layout: fixed` with explicit widths (ASSET 1fr, TYPE 120px, TRADES 100px, POLITICIANS 120px); scope
`.people-table-wrap` to `overflow-y:auto; overflow-x:hidden` for this table.
`dashboardHtml.ts:622`, `:2638`.

**D56 — Trends has no page grid.**  *desktop.  **Major.***
At 1440px the two-column rows use three different splits (788/560, 676/676, 602/739), and two panels are single cards
with the other half of the row empty: Top Performers 602px wide with 768px blank; Committee Sector Conflicts 735px
wide with 670px blank beside a 2,381px-tall table.
Fix: one 12-column grid with fixed 6/6 and 8/4 spans; a single-card row spans full width.

**D57 — Rising Activity is clipped 42px while 768px sits empty 900px below.**  *desktop.  **Major.***
POLITICIANS is cut mid-word inside a 518px box (scrollWidth 560), behind an undiscoverable horizontal scroll.

**D58 — Two responsive-table answers in one app.**  *mobile web.  **Major.***
Trades degrades to cards; "What Congress Is Trading" becomes a horizontal scroller with 2 of 4 columns off-screen —
and those columns **are the sort controls**, so half the sorts are unreachable until the user discovers the sideways
scroll.  Pick one policy (§3.11): cards below 720px, or reflow overflow columns into a second line, with an edge fade
if a scroller survives.

**D59 — Nested scroller with 168,093px of content inside a scrolling page.**  *mobile web.  **Major.***
Directory › Assets: `.people-table-wrap` clientHeight 568 / scrollHeight 168,093 (296× its own viewport),
`max-height: 633.36px`, inside a page that also scrolls.  On touch that is a scroll trap and the footer is
unreachable while the finger is over the list.  Five of the table's six declared columns are collapsed to zero width
rather than reflowed.  Fix: give Directory the Trades pager; single scroll axis.

**D60 — KPI tile value breaks out of both card borders.**  *mobile web.  **Blocking.***
"Approx. Volume" card is 108px wide (106px content); its `~$125.5m` value renders l=10 → r=126 at 24px — out into the
page gutter on the left and into the next card's gutter on the right (scrollWidth 111 vs clientWidth 106).  In "Buy
Pressure" the `% buys` text (y 393-407) is drawn on top of the sparkline bars (y 401-412).
Fix: clamp `.card .v` below 720px, or drop the 3-up grid to 2-up below 400px; give the tile an explicit grid so the
unit text and the bars do not share a row.

**D61 — Silent overflow and clipping.**  *mobile web.  **Minor.***
`.cluster-grid` 309/338, `.ccard` 147/161, `.chead` 119/147 (the `SPCX BOUGHT` header spills 28px);
`DETAILS.section.trends-fold` 345/356 with `overflow-x:hidden` — 11px clipped and **unrecoverable**.  Usual cause:
missing `min-width: 0` on flex/grid children.

**D62 — Committee Sector Conflicts: column starvation plus no rollup.**  *desktop.  **Minor.***
POLITICIAN ~130px (three-line wraps) vs COMMITTEE 415px, in a half-width card with 670px of page empty beside it.
`Industrials` appears 34× on the page, one committee 14×, and `~$8.0k` 40× — it is the constant midpoint of the
$1k-$15k bracket, so the column conveys nothing.

**D63 — "By Asset Type" bars have six different origins.**  *desktop.  **Major.***
Bar left edges at x≈1013, 1032, 1073, 1078, 1100, 1218 — each bar starts where its label ends, so lengths cannot be
compared and the largest category visually overstates its lead.  Every sibling panel uses a full-width track with a
common origin, so this panel is also structurally the odd one out.  Fix: rebuild on `.flowrow`.

### RC8 — Touch is a second-class surface

**★ D64 — Meaning carried only by `title` and `:hover`.**  *mobile web.  **Blocking.***
1,183 `title` attributes, 32 `:hover` rules, and exactly **one** hover guard in the whole stylesheet
(`@media (min-width: 721px) and (hover: hover)`).  On touch, `title` never fires.  Consequences: the H/S/P, emoji and
arrow filter chips are unlabeled glyphs whose only explanation is a dead tooltip; and the `ⓘ` estimate-methodology
disclosure ("closed ranges use the midpoint; the open $50M+ range uses its $50,000,001 floor") — which is attached to
every dollar figure the product publishes — is **unreachable on mobile**.
Fix: visible chip labels (or a persistent legend) below 720px; convert `.info-tip` to a tap-toggled popover with
`aria-expanded`; audit the 32 unguarded hover rules.

**D65 — Tap targets below 44×44 across 23 component classes.**  *mobile web.  **Major.***
Pagination `<< < > >>` 36×24 and mutually adjacent; sort `▼` 34×26; theme segments 65×25/63×25/77×25 with **2px**
gaps; account hamburger (the only header nav control) 38×38; footer links 42×13; `.face-member` avatars 17×24 across
54 instances; ticker chips 26×16 across 40; chart controls 25×20; `.info-tip` 12×15; chart hit areas `.tcol` 4×143.

**D66 — Chart x-axis is invisible at 375px.**  *mobile web.  **Major.***
All twelve labels render into 4px columns (clientWidth 4 / scrollWidth 39) and clip, so the chart shows a shape with
no time reference.  Those same 4px columns are the tooltip hit areas, so the data is unreachable on touch too.
Fix: 3-4 thinned labels in the `MMM ’yy` long-span form, wider hit areas or a tap-to-pin caption.

**D67 — Filter chips: same look, three unrelated semantics.**  *web ×2.  **Major.***
`H S P` (letters), `🫏 🐘 🦅` (emoji), `▲ ▼ ⇄` (glyphs) — identical treatment, encoding chamber, party and side.  The
adjacent `ⓘ` explains none of them.  In dark mode the donkey and eagle nearly vanish.
Fix: label them (`House / Senate / Exec`, `Dem / Rep / Ind`, `Buys / Sells / Exchanges`) or ship a persistent legend.
Screen-reader users are currently better served than sighted ones — the `aria-label`s are all correct.

**D68 — Trends panels collapse on click with zero affordance.**  *desktop.  **Major.***
Twelve `<summary>` elements with `cursor: default`, no marker, and the HIDE control rendered only at mobile widths.
Users will collapse a panel by accident with no way to know they can, or how to undo it.

**D69 — Two of six identical KPI tiles are buttons.**  *desktop.  **Minor.***
No visual difference, no `role="button"`, no `tabindex` — undiscoverable by sight and unreachable by keyboard.

**D70 — Type below a legible floor.**  *desktop.  **Polish.***  Chart axis labels 9px, info icon 9.02px, ordinal
superscript 7.48px, badges and avatar initials 10px, table headers 10.5px.

### RC9 — Voice: internal state as product copy; empty and error states unowned

**★ D71 — Operator state shipped as product copy.**  *all 3.  **Blocking.***
`📈 Price & performance vs the S&P 500 will appear here once a market-data API key is configured.` and
`No priced equity buys to score yet — this fills in as the price cache backfills.`  A public visitor has no API key
and no price cache; this reads as broken infrastructure and discloses operational state.  Worse, for a trade with no
resolvable ticker the promise is **false** — it never will appear.
Fix: state availability, not cause ("Performance vs the S&P 500 is not available for this trade.") and hide the card
entirely when there is no resolved ticker.  Log the missing-key condition server-side.
`dashboardHtml.ts:9936` (`PERF_GATE`), `:9937` (`PROFILE_GATE`) · iOS `TradeDetailView.swift:267`.
**This is Wave 2 item A7 — see §5.  Do not duplicate the work; A7 already scopes the ticker predicate.**

**D72 — `Could not load directory: HTTP 502` shown to users.**  *mobile web.  **Minor.***
Rendered as a single cell under headers promising data, with the only recovery button above the table, not adjacent
to the error.  Fix: "Could not load the directory.  [Try again]" with an inline retry; status code to console/`title`.

**D73 — Empty state names a fourth entity noun and offers no recovery.**  *desktop.  **Minor.***
"No transactions match these filters." after the user typed a **search**, while the stat line 900px away says "0
matching trades".  Both pagination blocks stay fully rendered — 7 dead controls, duplicated above and below.
Fix: "No trades match your search." + Clear; hide pagination when `total === 0`; render one pager on a single page.
`:4230-4231`.

**D74 — Contradictory absent-tokens.**  *web ×2.  **Minor.***
`n<5 · n=0` side by side ("fewer than 5" and "exactly 0"); `~$0` — a tilde-marked estimate of zero — with an empty bar,
styled identically to rows with data; `Cohort: 8 buy events.` repeating the `n=8` one line below.

**D75 — Banned absent-tokens on iOS.**  *iOS.  **Minor.***
`N/A` at `PoliticianDetailView.swift:76-78, 157-165`; `Unavailable` at `TradeDetailView.swift:87` and
`Components.swift:370, 375`; `Not Enriched Yet` (Title Case value) at `TradeDetailView.swift:122-123`.
Fix per §3.8: `—`, `Not disclosed`, `Not yet enriched`.

**D76 — The origin-down page is an unbranded monospace line.**  *infrastructure.  **Minor.***
`no available server` / Cloudflare 502, hit 3× during the audit.  No logo, no explanation, no retry.  Separate
ticket, but it is a user-facing surface.

**D77 — Counts have no scope label.**  *web ×2.  **Major.***
One politician's trade count is 988 (Trends), 22,832 (Directory) and 22,832 (member drawer), with a scope label only
on Trends.  The product knows — a hover tooltip says so — and a tooltip is invisible on touch.
Fix: stamp every count with its window in visible text; add "All time" to the global window select so the filter can
express the state the other surfaces are already in.

**D78 — Two time vocabularies and a missing window.**  *desktop.  **Minor.***
Global select offers nine options with no "All time"; the chart has its own `1Y / 3Y / 5Y` (no global 3-year, and
"1Y" ≠ "Past Year"); the member drawer prints `(All)`, a window the global control cannot express.  The chart's other
toggle is `# Trades` vs `$` — a word with a symbol prefix beside a bare symbol.

**D79 — Directory panes narrate the UI in desktop verbs.**  *mobile web.  **Minor.***
"Click a column heading to sort; click a name for their profile" — four of the first eight lines above the fold, on a
touch screen with nothing to click and (on Assets) one visible heading.  Keep only the clause the reader cannot
infer.  The copy's two-space sentence spacing is correct — preserve it.

**D80 — Lag buckets are all green, including past the statutory line.**  *desktop.  **Polish.***
`31-45d` and `46-60d` render in the same green as `0-7d` in a panel whose stated purpose is an accountability lens —
and green is the buy colour elsewhere.  `90ᵗʰ PERCENTILE` omits its measure.  `>45 DAY LAG  0 %` sits beside tiles
measured in days.

---

## 5. REGRESSION RISK — what is already in flight

**Do not redo, and do not overwrite.**  Branch `claude/ios-settings-ux` currently carries 2,044 insertions across 8
files (`Components.swift` +1,029, `CongressTradeStore.swift` +582, `SettingsView.swift`, `DeliveryView.swift`,
`TrendsView.swift`, `PeopleDirectoryView.swift`, `analytics/builders.ts` + its tests).

### 5.1 Wave 1 — in flight, already resolves or touches these findings

| In-flight work | Resolves / touches | Instruction |
|---|---|---|
| **Settings/sign-in rebuild** — `SignInPanel`, `GoogleSignInButton`, `GoogleGMark`, `SignInControlMetrics` (shared height + radius) | iOS analogue of **D51** (two controls that must look like one system) | **Do not restyle the iOS sign-in buttons.**  `SignInControlMetrics` is the new single source for their geometry; feed it into the §3.11 control inventory rather than replacing it. |
| **Header quick menu** (`AccountQuickMenu`) + `LegalFooterLinks` on Trends and Directory | **D45** (duplicate affordances), and the mobile-web analogue of **D46** (menu lacks footer destinations) | iOS side is handled.  The **web** account menu still duplicates the disclaimer and omits Pricing/Support — that half of D46 is still open. |
| **Grey toolbar icons / toolbar item styling** (`Components.swift` ~`:736-760`) | Directly adjacent to **D51** (Share + Done fusion) | **Coordinate.**  The §3.11 "one trailing item" ruling must be applied *through* the new toolbar styling, not around it.  Applying D51 blind will conflict. |
| **Trades count truthfulness** (`countFilterKey`, `tradeTotalFilterKey`, `isCountTrustworthy`) | iOS half of **D77** | The **web** scope-labelling half (988 vs 22,832, no "All time" window) is still open.  Do not re-solve the iOS half. |
| **Sort + pagination unification** (`isServerSort`, feed-only refresh path) | Wave 3 "2 sort keys vs 12"; adjacent to **D73** | D73 (dead pagination on an empty result) is **web only** and still open. |
| **Filter activity indicator** (`FilterActivityIndicator`, `isFeedFilterPending` / `isTrendsFilterPending`) | The "no loading state" coverage gap on iOS | Web has no equivalent — see §7. |
| **Sector "Other"/"Unknown" rows + disclosure caption** (`sectorDisplayRows`, `marketCapDisplayRows`, `marketCapOrder`) | Partially **D21**; fully resolves the Wave 3 "undisclosed ticker-resolution gating" item | **Partial only.**  It stops silent truncation and discloses the gating.  It does **not** stop industries being ranked against their parent sectors — D21 remains open, and the fix belongs in `analytics/builders.ts` canonicalization, not the view. |
| **`analytics/builders.ts` +153** (canonical sector SQL) | Groundwork for **D20/D21/D22** | Check this before writing a new normalizer — the shared canonicalizer may already be half-built here. |

### 5.2 New instances of the root causes introduced by the in-flight branch

Flagging these now so they are fixed before merge rather than becoming two more findings:

- **`TrendsView.swift:452-510`** — the new sector and market-cap rows are `HStack { Text; Spacer(); Text }`, i.e. new
  instances of **D01/D02**, and use `CompactFormat.usd` with no `+`, i.e. a new instance of **D28**.
- **Brand lockup parity** is listed as in flight in the task brief but appears as **Wave 2 item B3** in
  `docs/ios-web-parity-backlog.md:69-72`.  **Confirm which is true before anyone touches nav chrome.**

### 5.3 Wave 2 (queued) — overlaps with this review

Read `docs/ios-web-parity-backlog.md` before scheduling.  Direct overlaps:

| Wave 2 | This review | Note |
|---|---|---|
| **A6** Net Flow sign (`+` everywhere, not colour alone) | **D28**, **D29** | Same item.  Do them together and add `~` in the same pass — the backlog does not mention the estimate marker. |
| **A7** Non-tickered trades must not promise pending data; web has the identical bug at `:9936`, `:10434-10472` | **D71** | Same item, and A7 already carries the correct ticker predicate (`TICKER_RESOLVED_SQL`, `analytics/sql.ts:166`).  **Use A7's predicate; do not re-derive it.** |
| **A3** Filing-lag summary decodes fields the API never returns (`Avg Delay: 0 days` forever) | **D24**, **D37** | A3 is a *correctness* bug; D24 is the *vocabulary*.  Fix both in one pass so the new tiles ship with the canonical names (Median / P90 / >45-day, under "Filing Lag"). |
| **A4** Drop per-row `vs SPX` | **D37**-adjacent | Note FLEET-UI-COPY grants `vs SPY` an explicit exception; `vs SPX` has none.  A4 is right. |
| **B1** By Market Cap column spacing | **D01/D02** | **Do not hand-tune columns.**  B1 dissolves once the row primitive lands. |
| **B3** Brand lockup on every tab | **D39** | Overlaps the entity-header contract.  Sequence B3 after D39 or they will fight over the nav bar. |
| **C1** Asset Directory as a segmented toggle | **D55/D59** | Building the iOS asset directory before fixing the web table policy means porting the defect. |
| **C3** District in three places | **D39** | Meta-run atom — must go through the dedup'd builder, not a fourth ad-hoc join. |
| **D1/D2/D3** Asset-name parser + backfill (bracketed tokens, rate/maturity → Notes, exchanges) | **D17**, **D18**, and the mobile "trade card truncation" finding | **Same root cause.**  The backlog's dry-run-before-write requirement stands.  D17's display normalizer and D1/D2's parser should be one project — the parser fixes the stored value, the normalizer fixes everything already stored. |
| **A1/A2** Top Performers renders the annualized field while the API sorts by the honest one | — | Not a layout finding, but it is the single most *misleading* thing in this product: rows arrive sorted by one field and are painted with another.  **Rank it with the blockers.** |

---

## 6. DO NOT BREAK

Verified live during the audit.  These are the parts that are right, and several are the model for the fixes above.

1. **`.drawer-kv` is the correct ledger and is the reference implementation for the iOS fix.**  Measured at 375px:
   label x=16, value x=133 on every row, one shared entry guide, gap 9% of container, `dt` uppercase/700/dim, `dd`
   600 solid, no colons, no leader dots.  Touch it only to add the `180px`/`560px` caps (D05).
2. **`.dsub` separators do not collapse.**  The DOM genuinely reads `19 trades  |  7 politicians  |  ~$2.5m`.  The
   whitespace-collapse bug predicted for this call site is **not present** — whatever separator helper lands, do not
   "fix" this one.
3. **`drawerCompanyTitle` (`:10068`) is the best entity header in the product** — logo + accent ticker + `|` + company
   name on one line, with the ticker suppressed when it equals the name.  Propagate it; do not replace it.
4. **`.hbar / .hlabel / .hval` on desktop is a legitimate §3.3 comparison list** — ≥3 sibling rows, one unit,
   right-aligned to a shared guide, tabular figures.  This is the one place a justified right column is correct.
   Keep it; fix only its 375px behaviour (D03).
5. **Signed money and estimate marking are already correct in web tables and KPI tiles** — `+$193k`, `-$65k`,
   `+$27.0m` carry the sign in text, measured zero renders as an unstyled `$0`, and STOCK Act brackets correctly omit
   the `~` while derived figures carry it.  The gaps are Net Flow and iOS, not the whole system.
6. **Tabular figures are correctly applied to every web `td` sampled.**
7. **Trades rows are properly interactive** — `role="button"`, `tabindex="0"`, `cursor:pointer` on the row and every
   descendant.  Keyboard-operable and correctly affordanced.
8. **The `aria-label`s are genuinely good.**  The unlabeled filter chips all carry correct labels, and the info tips
   carry real methodology text.  Screen-reader users are currently better served than sighted ones — **do not strip
   the labels while adding the visible ones.**
9. **Dark mode is a complete, deliberately balanced theme, not an inversion.**  Every surface transposes cleanly; the
   only casualties are the emoji party chips and the raster logo.
10. **The methodology captions are the template for the whole product.**  "Weekly buckets — each label is the week-of
    date (week starts Monday).", "Observational — not evidence of impropriety.", "Buys only · observational, not a
    forecast".  Honest about limits without hedging into uselessness.  Any new caption should sound like these.
11. **The two-space sentence rule is already honored** in the Directory, Disclosure Timeliness, Committee Sector
    Conflicts and Delivery copy.  The violations are localized to the Filter panel and the Premium modal.
12. **The codebase already recognizes the sector-vocabulary problem** and canonicalizes for the flow rows — the
    comment at `:9509-9512` names the FMP/SEC split explicitly.  The normalizer exists; it just is not applied
    everywhere.  Extend it, do not write a second one.
13. **iOS `TradeDetailView.swift:132` already sets the nav title to the entity class** (`"Trade Details"`), and
    `:97-99` already uses `.longDate`.  Those two lines are the pattern the other sheets must copy.

---

## 7. COVERAGE — stated plainly

**What was not exercised.  This review does not cover these, and no claim in it should be read as covering them.**

- **No signed-in surface on any platform.**  Sign-in is Google OAuth or emailed magic link, both requiring the
  owner's credentials.  Never rendered: the account menu in its signed-in state, a populated Delivery subscription
  list, the real Export CSV dialog, the one-time webhook-secret panel, and every Premium-gated view.  Clicking Export
  CSV only produced the Sign In modal.  **Roughly the entire paid product is unaudited.**
- **The iOS findings in this document come from the owner's own report plus direct code inspection of the worktree,
  not from a simulator session in this review.**  Every iOS anchor cited here was verified by reading the file at the
  line given, on branch `claude/ios-settings-ux`, on 2026-08-10.  Dynamic Type, VoiceOver, dark mode, iPad, and
  landscape were **not** exercised on iOS.
- **Admin and Review Queue were excluded by instruction**, but their markup is in the same document — ~40 admin `th`
  labels are visible in the header dump and several show the same vocabulary drift found in the public surfaces.  An
  admin pass would likely add findings.
- **The "Filing Latency Comparison" panel exists in the DOM twice and computes `offsetParent: null` for signed-out
  users** — never rendered, never assessed.
- **No loading or skeleton state was ever observed** on web; the app is server-rendered and every view painted
  complete on first frame.  Loading and partial-data states are unassessed.  (iOS now has `FilterActivityIndicator`
  from Wave 1; web has no equivalent.)
- **No in-app API-error state was observed** — the only failure surface hit was a whole-origin outage.
- **Production returned 502 / a bare `no available server` page three times during the audit** (confirmed by curl).
  Beyond costing coverage, that page is itself a finding (D76).
- **Not exercised:** Columns modal drag-to-reorder, multi-column sort cycling, pagination beyond page 1, footer
  destinations (Privacy / Terms / Pricing / RSS / Support).
- **Sector/industry collision prevalence is unknown.**  Sampled on KO and MSFT plus the aggregate Trends evidence; a
  per-ticker sweep across the 369 assets needs DB or API access, and `/api/assets/<ticker>` returned 404/503 for
  every ticker tried.
- **Item counts in §1 are a judgement call**, not a machine count.  Cross-surface dedupe was done by hand; a defect
  in `dashboardHtml.ts` visible at both 1440px and 375px is counted **once**.

---

## 8. THE KO SHEET, REBUILT — calibration target

What "done" looks like for the sheet the owner named.  Every line cites the rule it satisfies.

```
[nav]  Ticker                                                        Done     ← §3.10.1, one trailing item
──────────────────────────────────────────────────────────────────────────────
                                 [ KO logo ]
                   KO  |  The Coca-Cola Company                      ← §3.10.2
                          NYSE  |  Beverages                         ← §3.10.3, dedup'd
                                  $62.41

SECURITY
INDUSTRY          Beverages                                          ← §3.9, Sector suppressed
CLASS             Common Stock                                       ← assetClassLabel
MARKET CAP        Mega Cap  |  $268,400,000,000                      ← CAP_NAMES, full in a ledger
CURRENCY          USD                                                ← EXCHANGE dropped, already in the meta run

CONGRESSIONAL TRADING
[ Trades 142 ] [ Buys 96 ] [ Sells 46 ]                              ← tiles, compact, tabular
[ Politicians 38 ] [ Est. Volume ~$4.1m ] [ Net Flow ~+$238k ]       ← explicit +, explicit ~
ACTIVITY          March 13, 2014 → June 2, 2026  ·  12 yrs           ← was two justified rows
EXCHANGES         3

                         Copy Link To KO                             ← Share leaves the toolbar (web parity)
```

Two rows became one.  Two identical rows became one honest one.  A raw enum became a label.  A positive number says
so.  A full month name appears because nothing was constraining the width.  And the ticker appears exactly once.

That single screen exercises RC1, RC2, RC3, RC4, RC5 and RC6 — which is the point.  **Ship it as the reference, then
grade every other screen against it with the §3.13 checklist.**
