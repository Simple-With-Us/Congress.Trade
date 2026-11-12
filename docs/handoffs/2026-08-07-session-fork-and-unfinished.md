# Handoff: forked session cleanup + unfinished CT work (2026-08-07)

**You are a NEW session.** Do not resume `019fda5e-4f61-74d2-b83e-987291c4b7e3` (title "iOS UI"). That session dual-turned and is untrustworthy as a single chat log.

**Owner model (binding):** Shellular and laptop Grok Terminal are the **same product surface** — one session, one transcript, line-for-line identical. A healthy new chat stays in sync on both. The broken session forked into **two concurrent agent turns inside one session id**; that is a product bug in that session only, not dual-client architecture.

Tag: **[GROK]**. Repo: `/Users/jay/Code/Congress.Trade`. Ag***-s**c: `#ag***-s**c` `C0BEZDJDNKV`. Effort board: `/Users/jay/apps/CONGRESS-TRADE-EFFORT-LOG.md` then mirror `docs/EFFORT-LOG.md`. Auto-commit + land when green. Ship: `bash app/scripts/ship.sh`. CI only on Coolify self-hosted runners (never local Mac).

---

## Immediate hazard: dirty tree on `main`

As of handoff, **`main` has uncommitted work** from the forked implement-turn. Do **not** discard without inventory. Move it to a feature branch first:

```bash
cd /Users/jay/Code/Congress.Trade
git status --short --branch
git checkout -b grok/or-budget-scorecard-caps   # or reuse if clean
# stage only the scorecard/OR files (not .worktrees/, not scout-state.json)
```

### Uncommitted files (implement fork ~01:41–01:44 CDT)

**New**
- `app/src/shared/openRouterBudgetCircuit.ts`
- `app/src/admin/coverageScorecard.ts`
- `app/migrations/0077_llm_spend_purpose_doc.sql`

**Modified**
- `app/src/shared/llmSpend.ts`
- `app/src/extraction/openRouterVision.ts`
- `app/src/extraction/orchestrator.ts`
- `app/src/extraction/bakeoff.ts`
- `app/src/extraction/providerHealth.ts`
- `app/src/extraction/providerFailure.ts`
- `app/src/admin/routes.ts`
- `app/src/admin/migrations.ts`
- `docs/EFFORT-LOG.md` (maybe)

**Status:** mid-implementation only. No commit, no PR, tests not proven, not shipped.

### Finish criteria for that slice
1. Branch off clean `main` (or commit dirty work onto branch)
2. Complete: OR budget circuit (2–3 immediate failures then hourly, no thrash retries); per-doc spend cap; skip re-LLM if rows exist unless explicit reprocess; purpose + doc_id on spend meter; admin coverage scorecard (universe vs us vs complete)
3. Mirror any SQL into `POST /api/admin/migrate` (`app/src/admin/routes.ts` / migrations list)
4. `cd app && npm run typecheck && npm test`
5. PR → green CI → merge → `bash app/scripts/ship.sh`
6. Effort board claim + closeout + Slack

**Policy:** never fix OpenRouter budget by adding credits. Cap is intentional; fix waste.

---

## Open PRs from this workstream (not merged)

| PR | Branch | Title |
|----|--------|--------|
| #1466 | grok/export-cap-honest | Premium CSV full match, no silent 50k |
| #1468 | grok/ios-theme-pictographic | Pictographic theme + fleet UI copy |
| #1469 | grok/ios-logo-amount-trends | Logos, $k/$m amounts, Trends toolbar |
| #1470 | grok/ios-trade-row-polish | Trade logos / amount / politicians label |
| #1471 | grok/web-pols-responsive | Web pols wording |
| #1472 | grok/ios-brand-title-larger | BrandTitle ~50% larger (CI was QUEUED/BLOCKED; temp runner ct-ci-temp) |

Land when CI green. Prefer coolify/oracle runners; local Mac CI banned.

---

## Ops already done (do not re-do / re-extract)

- Hetzner cutover emptied DB; mass “first_seen today” was empty DB re-ingest, **not** months of missed discovery.
- Multi-year history restored from **R2 litestream LTX** (`congress-trade-bucket` path `congress-trade/db.sqlite` ~4.5GB) → promoted to `/data/congress-trade/db.sqlite`.
- ~4138 filings / ~88.9k txs; first_seen span 2021→2026 after restore.
- App + scan-cpu brought back carefully; house bulk post-restore `new_count` 0 expected.
- Coolify env literal single quotes broke `APP_BASE_URL` / OAuth — strip quotes if regression.
- **Do not** re-extract years of PDFs to rebuild history. Restore path is R2/litestream (future: B2).

---

## Still unfinished (beyond scorecard)

1. **B2 durable backup**, leave R2 as historical — owner asked; not done
2. Litestream rewire to B2
3. BrandTitle + sibling iOS/export PRs merge + ship
4. Coolify managed stack vs manual containers consistency
5. CF ACME / certs if still broken
6. Shellular permission race / dual-turn (report only unless product fix is in scope)

---

## Broken session reference (forensics only)

- Session id: `019fda5e-4f61-74d2-b83e-987291c4b7e3`
- Title: **iOS UI** (auto-title once wrong “Django…”)
- Path: `~/.grok/sessions/%2FUsers%2Fjay%2FCode%2FCongress.Trade/019fda5e-…/`
- Fork started ~**01:33 CDT 2026-08-07**: concurrent turns (meta/Shellular answers vs implement OR/scorecard)
- Shellular “approve” was real tool unlocks for one of the two turns — not invented commands
- Prefer **do not continue** that session for new work

---

## First actions for this new session

1. Ag***-s**c poll + claim effort board for the slice you take
2. `git status` — protect dirty scorecard files onto a branch immediately
3. Pick primary: **(A)** finish OR/scorecard PR, or **(B)** land open iOS/export PRs / CI — do not dual-turn
4. One turn at a time; one chat log; Shellular will match Terminal line-for-line if you stay single-threaded

Prior messages stay in scope within *this* new session once work starts. Owner preference: finish or park explicitly; auto-commit + land finished units.
