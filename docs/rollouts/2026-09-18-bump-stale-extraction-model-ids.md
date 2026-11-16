# 2026-09-18 — Bump stale extraction model ids to latest lines

## Context & Objective

Board `9b7b941b`.  Fleet-wide model-catalog cleanup (owner-driven, spanning Socratic.Trade and sibling apps) flagged that Congress.Trade's disclosure-extraction stack — the bake-off catalog, live-ingestion fallback defaults, the direct Gemini vision path, the local Mac vision-worker, and the OpenAI probe list — pinned model generations one cycle behind the fleet's current lines (`claude-opus-5`, `x-ai/grok-4.6`, `google/gemini-3.8-flash`), and carried three different, mutually inconsistent Grok defaults live in the same app (`grok-4.5` in two spots, `grok-4.3` in a third).  This PR is an ids-only bump: no schema change, no behavior change beyond which model a given fallback path calls.

## Changes Made

Every new slug was verified live against the fetched OpenRouter catalog (`openrouter-models.json`, 446 models, 2026-09-18) before use, and each bump was priced against the old slug — see Decisions & Trade-offs below.

- **`app/src/extraction/bakeoff.ts`** — `DEFAULT_CANDIDATES`: `anthropic/claude-opus-4.8` → `anthropic/claude-opus-5`, `x-ai/grok-4.5` → `x-ai/grok-4.6`, `google/gemini-3.7-flash` → `google/gemini-3.8-flash`.  Updated the verification-date comment and the Grok Files API doc comment (`grok-4.3` → `grok-4.6`, illustrative only — `runXai` takes `model` as a parameter).
- **`app/src/extraction/configuredVision.ts:75`** — per-chamber primary fallback default `openrouter:x-ai/grok-4.5` → `openrouter:x-ai/grok-4.6`.
- **`app/src/admin/routes.ts:6636`** — `/benchmark/runs` batch-endpoint default for `provider: 'xai'`: `'grok-4.3'` → `'grok-4.6'`.  This and `configuredVision.ts` are now the same value (previously two different stale Grok defaults in the same app).
- **`app/src/extraction/visionLlm.ts:64-67`** — direct-Gemini `DEFAULT_MODEL`: `gemini-3.7-flash` → `gemini-3.8-flash`; refreshed the "current as of" comment.
- **`app/src/shared/types.ts`** — two doc comments describing the values above (`VISION_PRIMARY_MODEL` default, `XAI_API_KEY` purpose) kept in sync.
- **`app/src/benchmark/providerAccess.ts:13-20`** — added `gpt-6-astra` to `OPENAI_BENCHMARK_ACCESS_MODELS` (verified live as `openai/gpt-6-astra`); nothing removed.
- **`services/vision-worker/worker.py:147,152`**, **`run-vision-worker.sh:41,43`**, **`README.md:37-38`** — same Grok/Gemini bump for the local Mac cascade worker and its docs, mirroring the Worker-side change.
- **Beyond the enumerated spec touchpoints** (see Deviations below): `app/src/extractors/types.ts` (arbitration-secondary `defaultModel: 'gemini-3.7-flash'` → `'gemini-3.8-flash'`) and `app/src/extraction/agreement.ts` (`DEFAULT_MODEL_C = 'openrouter:x-ai/grok-4.5'` → `'...grok-4.6'`) were also bumped — both are live fallback defaults in the same extraction subsystem, using the exact same stale slugs the spec named elsewhere, and leaving them unbumped would have reintroduced the same "inconsistent defaults in one app" problem this PR exists to fix.
- Tests updated to match: `app/src/extraction/__tests__/bakeoff.test.ts`, `app/src/extraction/__tests__/configuredVision.test.ts`, `services/vision-worker/test_worker.py` (all `x-ai/grok-4.5`/`google/gemini-3.7-flash` fixtures bumped; the ones that check `worker.DEFAULT_CASCADE_MODELS` directly would otherwise fail).

**Deliberately left alone:**
- `app/src/extraction/benchmarkMetrics.ts` (`STANDARD_BENCHMARK_RATE_CARD`) — explicit spec instruction; it's a dated historical rate card pricing past measured runs, not a live catalog.
- `app/src/benchmark/settings.ts` `LEGACY_CANDIDATES` (`{ provider: 'xai', model: 'grok-4.3' }`) — same category as the rate card: kept only for decode/replay of historical `extraction_runs`, explicitly documented as such in its own comment, not offered in any live default.
- `app/src/extraction/openRouterVision.ts` (`OPENROUTER_GEMINI_FLASH_BATCH`, `isOpenRouterGemini37Flash`, `gemini37FlashProviderPreference`) — this is version-pinned Vertex-provider-preference logic (`~google/gemini-flash-latest` currently resolves to 3.7 and gets a documented 75%-off Vertex routing preference specific to that generation), not a plain id swap.  Bumping it correctly requires confirming the same Vertex discount/behavior applies to 3.8, which is outside an "ids only" change.  Flagged as a follow-up, not fixed here.
- `app/src/extraction/__tests__/agreementReuseBudget.test.ts`, `benchmarkMetrics.test.ts`, `openRouterVision.test.ts`, `src/shared/__tests__/llmSpendByModel.test.ts` — these use `x-ai/grok-4.5` / `google/gemini-3.7-flash` as arbitrary literal fixture values passed directly into the function under test (cost-ordering, spend rollups, provider-preference matching), not as read-outs of a default constant this PR changed — confirmed by direct read of each call site.

## Decisions & Trade-offs

Live OpenRouter pricing (`openrouter-models.json`, 2026-09-18), USD per M tokens (in / out), all with `structured_outputs`:

| Old slug | New slug | Old $/M | New $/M | Old ctx | New ctx |
|---|---|---|---|---|---|
| `anthropic/claude-opus-4.8` | `anthropic/claude-opus-5` | $5.00 / $25.00 | $5.00 / $25.00 | 1.00M | 1.00M |
| `x-ai/grok-4.5` | `x-ai/grok-4.6` | $2.00 / $6.00 | $2.00 / $6.00 | 500K | 500K |
| `google/gemini-3.7-flash` | `google/gemini-3.8-flash` | $0.75 / $3.75 | $0.75 / $3.75 | 1.05M | 1.05M |
| `grok-4.3` (native, `configuredVision.ts`/`admin/routes.ts` reconciliation target) | `grok-4.6` | $1.25 / $2.50 | **$2.00 / $6.00** | 1.00M | 500K |
| — (addition) | `gpt-6-astra` | — | $10.00 / $50.00 | — | 1.05M |

**Price increase to report:** reconciling `admin/routes.ts`'s `grok-4.3` batch-endpoint default up to `grok-4.6` (the value the spec asked to make consistent with `configuredVision.ts`) raises that one fallback path's per-call price — input 1.25→2.00 (+60%), output 2.50→6.00 (+140%) — and cuts context from 1M to 500K tokens.  `configuredVision.ts`'s own default was already `grok-4.5` (identically priced to `4.6`), so its cost is unchanged; only the `admin/routes.ts` batch-endpoint default (used when an operator omits `model` in the `/benchmark/runs` POST body) sees the increase.  This is an operator-triggered manual endpoint, not the autonomous cascade, and a single House-PTR extraction read is a few thousand tokens — nowhere near the $0.50/call hold or the $2/day extraction budget (both left unchanged, per instruction).  Flagging per instruction rather than picking a cheaper reconciliation value, since the spec explicitly asked for "one current value" and the fleet-wide rule (SPEC.md rule 2) is "always the newest version" — `grok-4.3`, while cheaper, is not the current Grok generation and was not itself a bump target.

`gpt-6-astra` is a pure addition to the OpenAI access-probe list (not a default), so there is no "old" price to compare against.

No other slug changed price or context on this bump — every other row is a strict, free upgrade (newer generation, identical price/context).

Assumed native (non-OpenRouter) id naming continues to mirror the OpenRouter slug minus its provider prefix, consistent with existing code (`grok-4.3` native ↔ `x-ai/grok-4.3` on OpenRouter; `claude-sonnet-5` native ↔ `anthropic/claude-sonnet-5`) — so `grok-4.6` was used as the native xAI id in `admin/routes.ts`.  This could not be verified against xAI's own API directly (no network access to a live-key-gated endpoint from this task), only against the pattern already established in this codebase.

## Verification State

```
cd app
npm run typecheck   # deno check src/deno/main.ts
npm test            # vitest run
```

Python worker (`python3 -m py_compile` + full unit suite, run locally, no network):

```
cd services/vision-worker
python3 -m py_compile worker.py test_worker.py
python3 -m unittest test_worker.py -v   # 30/30 passed
```

<!-- TS gate result filled in after the background run completes -->

## Next Steps & Blockers

- `openRouterVision.ts`'s Vertex-preference/batch-slug logic (`~google/gemini-flash-latest` currently == 3.7) was deliberately not touched — a follow-up should confirm whether OpenRouter's Vertex 75%-off routing still applies once the live alias resolves to 3.8, and bump `OPENROUTER_GEMINI_FLASH_BATCH` / `isOpenRouterGemini37Flash` / `gemini37FlashProviderPreference` accordingly once confirmed.
- `admin/routes.ts`'s `grok-4.3` → `grok-4.6` batch-endpoint default is a real per-call price increase (see table above) on an operator-triggered path; flagged, not blocking, but worth a second look if that endpoint sees heavy manual use.
- Native xAI id naming (`grok-4.6`) was inferred from the existing codebase pattern, not verified against a live xAI endpoint — watch for 404s on first live use and confirm.

## Zero-Code Findings

None — this was a pure implementation pass against a pre-researched spec (`understand.json` maps.other-apps).
