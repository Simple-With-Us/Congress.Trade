# Handoff: CLAUDE → ANTIGRAVITY — 2026-07-19

Owner: Jay. Source branch (mine, **no commits yet**):
`claude/model-benchmarking-api-filtering-cc0536`.
Worktree: `.claude/worktrees/model-benchmarking-api-filtering-cc0536`.

This note hands you **everything** from a CLAUDE session that finished the
investigation but wrote **zero code**. All findings below are verified against
the tree at `cae2821`; file:line references are accurate as of that commit.
`AGENTS.md` is policy; `docs/EFFORT-LOG.md` gets the receipts. Coordinate on
Slack `#ag***-s**c` (`C0BEZDJDNKV`), tag `[Congress.Trade] AG`.

---

## 0. The ask (owner, verbatim intent)

From the admin **Model Benchmarking** panel, Jay reported four things:

1. **Models he has no API key for must not appear anywhere** — not in the
   "Custom Model Selection" checkbox grid, not in the A–E slot dropdowns.
2. **`openrouter/auto`** — wants to trial it *someday*, but **not alongside
   benchmarking**. Remove it from the benchmark offering for now, keep it easy
   to bring back.
3. **Asked my opinion:** are `gpt-5.6-terra-pro` and `gpt-5.6-sol` "overkill and
   wasteful?" → **This is still an open decision. See §4.**
4. **Add an OpenRouter Anthropic Opus model** to the list ("probably").

Plus a hard constraint: **a benchmark was running** ("13/275 cells", paused/
resumable, run `5b97aff0-52c0-4bad-825b-dd439914eb20`) — *no production-impacting
change until it finishes.* See §6.

---

## 1. Root cause (already diagnosed — do not re-derive)

There are **two** independent surfaces that render models, and they fail
differently:

| Surface | Source | Current behaviour |
|---|---|---|
| Checkbox grid, "Re-read with model…", per-row quick-run | **Build-time** `BENCHMARK_CATALOG` at `app/src/ui/dashboardHtml.ts:3652` = `JSON.stringify(benchmarkModelCatalog())` | Renders the **full** catalog **including `LEGACY_CANDIDATES`** — these are the direct-provider `openai:` / `gemini:` / `anthropic:` / `xai:` / `mistral:` rows Jay has no key for. All rendered **checked by default**. |
| A–E slot dropdowns | **Live** `benchmarkState.settings.catalog` → `benchmarkManualOptionHtml()` at `dashboardHtml.ts:5262` | Renders un-configured entries as **`disabled` + "(not configured)"** — visible instead of hidden. |

`LEGACY_CANDIDATES` (`app/src/benchmark/settings.ts:86-95`) exists on purpose:
direct-provider entries are kept **decode/replay-valid** for historical
`extraction_runs` and prior live config. **They must stay in the validation
catalog — only stop *offering* them.** That distinction is the whole design.

`benchmarkModelCatalog()` (`settings.ts:97-103`) = `DEFAULT_CANDIDATES` +
`LLAMAPARSE_CANDIDATES` + `LEGACY_CANDIDATES`, deduped by `provider:model`.
It is consumed by `validateBenchmarkModel()` (`settings.ts:239-253`), which
gates every save/run submission.

### The trap that makes this more than a UI filter

`app/src/admin/routes.ts:4290` — `POST /bake-off` defaults to
`let candidates: BakeoffCandidate[] = DEFAULT_CANDIDATES;` when no `body.models`
is supplied. **So `DEFAULT_CANDIDATES` is a real run set, not just a menu.**
Consequences:
- Leaving `openrouter/auto` in `DEFAULT_CANDIDATES` and only hiding it in the UI
  would **still auto-run it**. It must be physically removed from that array.
- Adding Opus to `DEFAULT_CANDIDATES` adds it to the default bake-off lineup
  (real spend, up to `n=50` docs). That is intended/acceptable — just know it.

`app/src/admin/routes.ts:5585` — `GET /benchmark/model-access/openai` filters
`DEFAULT_CANDIDATES` for `provider === 'openai'`. That set is **already empty**
(all entries are `openrouter:*`), so it falls back to
`OPENAI_BENCHMARK_ACCESS_MODELS`. **Unaffected by this work.**

---

## 2. Verified external fact — the Opus slug

**Use exactly `anthropic/claude-opus-4.8`.**

Verified LIVE against the OpenRouter models API on **2026-07-19** via the
`openrouter-congress` MCP:
- `id`: `anthropic/claude-opus-4.8` (canonical `anthropic/claude-4.8-opus-20260528`)
- modality `text+image+file->text` — **`file` input confirmed**, required for the
  PDF path in `openRouterVision.ts`
- 1M context, 128k max completion
- pricing **$5/M prompt, $25/M completion**

Do **not** use `~anthropic/claude-opus-latest` — the codebase pins exact verified
slugs on purpose (see the `DEFAULT_CANDIDATES` doc comment,
`bakeoff.ts:63-92`, which lists dead slugs that must never reappear because
"every benchmark cell for a dead slug can only fail"). Note Anthropic slugs use
a **dot** (`claude-haiku-4.5`, `claude-opus-4.8`), unlike `claude-sonnet-5`.

---

## 3. Task list

### T1 — `app/src/extraction/bakeoff.ts`
- Add a new exported list next to `DEFAULT_CANDIDATES`:

  ```ts
  /** Known-good routes kept catalog-valid (decode/replay + one-line re-enable)
   *  but intentionally NOT offered in the benchmark UI and NOT part of the
   *  default bake-off lineup. */
  export const NON_OFFERED_CANDIDATES: BakeoffCandidate[] = [
    // Routing is unpredictable; owner will trial it separately, not alongside
    // fixed-model benchmarking. Already rejected for live A–E slots by
    // isOpenRouterAuto() and by CODEX PR #556's dry-run guard.
    { provider: 'openrouter', model: 'openrouter/auto' },
  ];
  ```
- **Remove** `{ provider: 'openrouter', model: 'openrouter/auto' }` from
  `DEFAULT_CANDIDATES` (currently `bakeoff.ts:114`).
- **Add** `{ provider: 'openrouter', model: 'anthropic/claude-opus-4.8' }` to
  `DEFAULT_CANDIDATES`.
- Update the big `DEFAULT_CANDIDATES` doc comment (`bakeoff.ts:63-92`): record
  that opus-4.8 was verified live 2026-07-19, and that `auto` moved to
  `NON_OFFERED_CANDIDATES`.

### T2 — `app/src/benchmark/settings.ts`
- Import `NON_OFFERED_CANDIDATES`.
- `benchmarkModelCatalog()` must now include it, so nothing loses validity:
  `[...DEFAULT_CANDIDATES, ...LLAMAPARSE_CANDIDATES, ...LEGACY_CANDIDATES, ...NON_OFFERED_CANDIDATES]`.
- **New export** — the offered set, which is what every UI surface uses:

  ```ts
  /** Models OFFERED in the benchmark UI: the default bake-off lineup plus the
   *  LlamaParse tiers. Excludes direct-provider LEGACY entries (decode-only —
   *  no API key) and NON_OFFERED routes. Validation still uses the full
   *  benchmarkModelCatalog(). */
  export function benchmarkSelectableCatalog(): BakeoffCandidate[] { … }
  ```
  = `DEFAULT_CANDIDATES` + `LLAMAPARSE_CANDIDATES`, deduped the same way.
- In **both** `readSettingsWithDependencies()` (`settings.ts:384`) **and**
  `readRoleSettingsWithDependencies()` (`settings.ts:598`), build the returned
  `catalog` from `benchmarkSelectableCatalog()` instead of
  `benchmarkModelCatalog()`. **Keep the `configured` flag** — it still gates the
  A–E dropdown's disabled state for a future missing key.
- Leave `validateBenchmarkModel()` alone. Save-time validation intentionally
  still accepts the full catalog (historical config + explicit API use).

### T3 — `app/src/ui/dashboardHtml.ts`
- Line 28: import `benchmarkSelectableCatalog` (keep or drop
  `benchmarkModelCatalog` depending on remaining use).
- Line 3652: `var BENCHMARK_CATALOG = ${JSON.stringify(benchmarkSelectableCatalog())};`
  — this single change fixes the checkbox grid (3669), the re-read multi-select
  (3655/3754) and the quick-run select (3808) at once.
- Update the explanatory comment at 3647-3651 (it currently claims the catalog is
  "DEFAULT_CANDIDATES + LlamaParse", which only becomes true after this change).

### T4 — A–E dropdown safeguard (`dashboardHtml.ts:5262-5269`, `5310-5335`)
Once the server catalog is filtered, a slot whose **saved** value is not in the
offered set would render as `— not set —`, and an admin could silently overwrite
it. Add: if the saved value for a slot is absent from the option list, prepend it
as a selected option labelled `(current)`.

*Not currently triggered* — live House slots are
A `openrouter:google/gemini-3.5-flash`, B `openrouter:openai/gpt-5.6-luna`,
C `llamaparse:cost-effective`, D `openrouter:google/gemini-3.5-flash`,
E `openrouter:openai/gpt-5.6-luna` — all inside the offered set. Do it anyway;
it's an admin write path.

### T5 — Tests
`cd app && npm run typecheck && npm test` is the gate. These files assert on the
catalog / `DEFAULT_CANDIDATES` / `openrouter/auto` and will very likely need
updating:
- `src/extraction/__tests__/bakeoff.test.ts`
- `src/benchmark/__tests__/settings.test.ts`
- `src/admin/__tests__/benchmarkRoutes.test.ts`
- `src/ui/__tests__/dashboardHtml.test.ts`
- `src/extraction/__tests__/benchmarkMetrics.test.ts`
- `src/extraction/__tests__/batchExtract.test.ts`
- `src/benchmark/__tests__/providerAccess.test.ts` (check only — likely untouched)

**Add** regression coverage for the actual bug: assert that
`benchmarkSelectableCatalog()` contains **no** entry whose provider is a
direct-provider (`openai`/`gemini`/`anthropic`/`xai`/`mistral`) and no
`openrouter/auto`, while `benchmarkModelCatalog()` still contains all of them.

### T6 — Verify in the real UI
Don't ship on green tests alone. Drive the admin Model Benchmarking panel and
confirm: the six direct-provider rows and `openrouter/auto` are gone from the
checkbox grid, gone from A–E dropdowns, `anthropic/claude-opus-4.8` is present,
and saving the five House slots still round-trips.

---

## 4. ⚠️ OPEN DECISION — Terra Pro / Sol (owner never answered)

I was mid-question when the session pivoted. **Get Jay's answer before
implementing this part.** My analysis, for you to re-present:

This workload is OCR/vision extraction of scanned PTR transaction tables. The
bottleneck is careful table reading, **not** frontier reasoning, so premium
reasoning tiers buy very little:
- **`gpt-5.6-terra-pro`** — a higher-effort/higher-cost twin of `terra` on the
  same base. For this task it typically buys ~nothing over `terra` at materially
  higher cost; as a benchmark candidate it mostly teaches you "≈ terra, pricier."
  **Clear cut.**
- **`gpt-5.6-sol`** — high-effort, and it has a genuine niche as the
  *difficult-scan adjudicator* (`openAiDisclosureReasoningEffort()` maps it to
  `'high'`, `bakeoff.ts:138-142`). More defensible. But running it across every
  benchmark doc is expensive, and with Sonnet-5, DeepSeek-V4-Pro, Grok-4.3 and
  now Opus-4.8 covering the strong end, I'd still pull it from the *routine*
  offered list while keeping it catalog-valid so it can be pinned to the
  E/adjudicator slot or run in a targeted benchmark.

**My recommendation: remove both from the offered set** (move to
`NON_OFFERED_CANDIDATES`), Terra Pro being clear-cut and Sol the softer call.
Options to put to Jay: *remove both* (recommended) / *remove Terra Pro only* /
*keep both*.

**Whichever way it goes, they must remain in `benchmarkModelCatalog()`** —
`benchmarkMetrics.ts:271` prices `gpt-5.6-sol` and `:391` prices
`openai/gpt-5.6-terra-pro`, and historical runs reference them.

---

## 5. Coordination / overlap (checked 2026-07-19)

- **PR #620** `claude/resource-governors` (OPEN) touches
  `app/src/admin/routes.ts` **and** `app/src/extraction/bakeoff.ts` — the same
  two files. I diffed the hunks: **disjoint from this work.** #620 is in
  bakeoff `~1097-1365` (provider-call spend governors) and routes `~3876-3937`;
  this work is bakeoff `~63-115` and routes `4290`/`5585`. Only real friction is
  the **import list** at the top of each file. Whoever merges second rebases.
- #620 contains a test asserting
  `candidateSpendUsd('openrouter','openrouter/auto',…)` is `null` — that is a
  **pricing** lookup and is unaffected by removing `auto` from
  `DEFAULT_CANDIDATES` (it stays catalog-valid via `NON_OFFERED_CANDIDATES`).
- **CODEX PR #556** already made the dry-run agreement lineup reject both
  catalog-form and legacy `openrouter/auto`. This work is **aligned** with that
  direction, not in conflict.
- No other open PRs. Many stale worktrees exist (`codex/openai-disclosure-model-options`,
  `codex/remove-gpt4o-disclosures`) with **no open PRs** — ignore unless Jay says
  otherwise.

---

## 6. Constraints — read before you touch production

- **A benchmark was running** when Jay wrote (paused/resumable, 13/275 cells).
  He said explicitly: *wait to do massive changes or production-impacting changes
  until that finishes.* Editing source, committing, and opening a PR are **fine**.
  **Merging, deploying, and saving live A–E model slots are not**, until he
  confirms the run is done.
- Repo policy: no deploy / no remote D1 / no production backfills without
  explicit intent. Jay's standing auto-deploy directive is **overridden here** by
  his explicit "wait" in this session. Ask before deploying.
- Push branch + open PR automatically once gates are green (standing owner
  preference); merge/deploy still needs an explicit ask.

---

## 7. Definition of done

1. Jay's Terra Pro / Sol answer applied (§4).
2. Direct-provider rows + `openrouter/auto` absent from **all** selection
   surfaces; `anthropic/claude-opus-4.8` present.
3. `benchmarkModelCatalog()` still validates every legacy/non-offered model
   (decode/replay unbroken) — covered by a new test.
4. `cd app && npm run typecheck && npm test` green.
5. UI driven and confirmed (§T6).
6. PR opened, body noting the #620 file overlap and the migration-free nature of
   the change (no `app/migrations/` work needed).
7. `docs/EFFORT-LOG.md` updated in the same push (claim + closeout), per
   `CLAUDE.md` / `EFFORT-LOG-PROTOCOL.md`.

## 8. Optional follow-up (not requested, don't scope-creep)

`OPENAI_BENCHMARK_ACCESS_MODELS` (`app/src/benchmark/providerAccess.ts:13-20`)
still enumerates `gpt-5.6-terra/-pro/-luna/-sol/5.5/5.4` for direct-OpenAI
catalog probing. Jay has no direct OpenAI key, so
`GET /benchmark/model-access/openai` reports `not_configured` regardless. Leave
it; flag to Jay only if he wants the whole direct-OpenAI access panel retired.
