# Handoff: CLAUDE → MONET — 2026-07-15

Owner: Jay. Source branch (mine): `claude/antigravity-latency-security-x6lkvb`.
This note hands you everything still open from a long CLAUDE cloud session.
`AGENTS.md` is policy; `STATUS.md` is the live snapshot; `docs/EFFORT-LOG.md`
has the per-effort receipts. Coordinate on Slack `#ag***-s**c` (`C0BEZDJDNKV`),
tag `[Congress.Trade] MONET`.

---

## 1. Open PRs you are inheriting (act on these first)

### PR #446 — app follow-ups batch (READY, not merged)
Branch `claude/antigravity-latency-security-x6lkvb`. Gated green
(typecheck + **128 files / 1287 tests**). Five things in one PR:
brand archive (`docs/brand/`), self-hosted Zilla Slab wordmark,
executive-filer party+portraits, `runner-workerd-diagnostics.yml`,
and the `ship.sh` served-script parse smoke.
- **To land:** confirm CI green → merge → dispatch `deploy.yml`
  (`confirm=deploy-production`) → verify. Jay's standing default is
  **merge to production by default** for reviewed/green work.
- **Post-deploy gotcha:** the enriched executive filer rows (party/photo)
  only refresh on the **next OGE poll (6 h)** or an explicit
  `POST /api/admin/oge-backfill`. If you want Trump/Vance headshots live
  immediately after deploy, fire the backfill (idempotent).

### PR #190 — congress-trading-shared: `executive` chamber, v1.8.0 (DRAFT)
Branch `claude/chamber-executive`. Adds `"executive"` to `ChamberSchema`
(single source of truth; all chamber-typed fields inherit). `npm ci` /
typecheck / build / test (393) / publint all green pre-push.
- **Before merge (AGENTS.md):** run the tokenless
  `npm install github:jaywedgeworth22/congress-trading-shared#<headSha>`
  scratch-dir smoke — I could not (branch was unpushed at build time).
- **After merge:** push a `v1.8.0` tag.

### Follow-on PR — app pin bump (NOT YET CREATED; blocked on #190)
Once #190 merges: bump the app's exact-commit pin of
`@jaywedgeworth22/congress-trading-shared` in **both** root `package.json`
and `app/package.json` (and the `allowScripts` approval keys — CODEX's
convention, see the v1.7.1 pin they set), then **drop the app-local
`Chamber` widening** in `app/src/shared/types.ts`
(`export type Chamber = SharedChamber | 'executive'` → just re-export the
shared `Chamber`) and the accompanying `ClientTrade` omit-pattern if it's no
longer needed. Re-run typecheck + full suite. This is the cleanup that
retires the "app-local widening" tech-debt noted all over the executive work.

---

## 2. Pipeline / operational items still open

> Numbers below are **as of my last D1 check earlier today**; the agreement
> auto-publish gate runs continuously so re-verify live before acting. The
> Cloudflare D1 MCP tool flaps in/out — if it's down, query via the Worker
> admin API or ask Jay.

- **~578 house + 17 executive filings in `needs_review`.** These are the
  drained H-2015 backfill + rescued 2026-06-21 vision-outage casualties, plus
  all 17 Trump OGE 278-Ts. The autonomous agreement gate promotes what clears
  the confidence bar but is **budget-capped** (`AGREEMENT_DAILY_LLM_BUDGET`,
  ~300 reads/day in Infisical) so it's multi-day at that pace. **Until they
  promote, `chamber=executive` on the live site is empty** — end-to-end "Trump
  trades visible publicly" is still UNVERIFIED. To accelerate: raise the
  budget knob in Infisical, or run the operator-triggered
  `POST /api/admin/agreement-reprocess` (uncapped).
- **21 hard extraction failures (house).** Deterministic — both vision models
  reject these PDFs. They sit in `ingestion_outbox` as `failed`. NOT outage
  residue; they need a model/config change or manual review, not a re-run.
- **4 oversized executive mega-filings** (`extractor='oversized-executive'`) —
  the 113-page / 13 MB May-2026 equity reports (~3,711 trades: the marquee
  Trump data). My 6 MB `OGE_MAX_VISION_BYTES` guard parks them BEFORE
  extraction. **Key update:** the #355 integration already added **15-page
  chunking** to `visionLlm.ts`, so page-chunked extraction is *substantially
  already built* — the guard is now the only thing holding these back.
  Raising `OGE_MAX_VISION_BYTES` to ~16 MB (Infisical) would let them flow
  through the chunker with no code change. **Untested caveats:** nobody has
  proven the chunker on a 113-page scan (8-chunk run; Worker memory during the
  pdf-lib split of a 13 MB doc is untested), and it's ~8 vision calls per
  filing per model. Recommend: bump the knob, reprocess the **smallest**
  oversized filing first as a probe, watch for OOM/timeout, then decide.
- **workerd diagnostics not yet run.** PR #446 adds the workflow but does not
  dispatch it. After #446 merges, dispatch `Runner workerd diagnostics` and
  read the probe output (ldd/strace/miniflare) to finally root-cause why the
  Hetzner `congress-deploy` runner dies with `write EPIPE` — that's what forces
  `reviewResolutionD1.test.ts` to probe-skip there.

---

## 3. Owner-decision items (don't do these unasked — surface them)

- **Logo mark not chosen.** Font is decided (F3 Zilla Slab, now shipping).
  The *symbol* is open — see `docs/brand/2026-07-13-logo-and-domains.md`; my
  recommendation is the Candlestick Colonnade primary + Disclosure Stopwatch
  as the latency sub-brand. Needs Jay's pick, then a final vector pass +
  favicon/header swap.
- **Domain portfolio.** DNS-probed `.trade` family (insider/form4/whales/
  judges/lobby/contracts/docket/filings/firstprint) all looked registrable —
  table in the same brand doc. Registration is Jay's call.

---

## 4. Standing context / traps learned this session

- **`ADMIN_MAINTENANCE_TOKEN`** (scoped, INGEST_TOKEN-pattern) is live in prod
  and set in this cloud env. It unlocks ONLY `POST /ingest-requeue-failed` and
  `POST /ingest-retry-errored` — 401 everywhere else. Full `ADMIN_TOKEN` stays
  in GitHub secrets + Infisical only.
- **Admin curls must run from the self-hosted runner**, not GitHub-hosted:
  Cloudflare bot-challenges Azure IPs (403 "Just a moment…"). The
  `admin-maintenance.yml` workflow (confirm=`run-production-maintenance`) is
  the sanctioned path; it and the self-hosted runner's older curl (no
  `--fail-with-body`) are already handled there.
- **`dashboardHtml.ts` is ONE giant template literal.** Never introduce a
  backtick or `${` — the served JS silently breaks and the site goes blank
  (that was the 2026-07-12 outage). The new `ship.sh` parse smoke now catches
  it at deploy; the test suite pins parseability.
- **Cross-repo:** the shared package is installed by **exact git commit**, not
  semver. Follow CODEX's `allowScripts`-by-commit convention for any pin bump.
- **Deploy path:** `deploy.yml` `workflow_dispatch` → self-hosted Hetzner
  runner → `ship.sh`. Never `wrangler d1 … --remote` migrations by hand.

---

## 5. Suggested order of operations for you

1. Merge PR #190 (after the tokenless install smoke) → tag `v1.8.0`.
2. Merge + deploy PR #446 → run `oge-backfill` if you want headshots live now.
3. Open the app pin-bump PR (#190 consumer + drop app-local widening) → merge/deploy.
4. Probe the oversized-executive path: bump `OGE_MAX_VISION_BYTES`, reprocess
   the smallest mega-filing, observe.
5. Accelerate the review backlog (budget bump or `agreement-reprocess`) and
   **verify `chamber=executive` renders real Trump rows** on the live site.
6. Dispatch + analyze the workerd diagnostics workflow.
7. Surface the logo-mark pick and domain registrations to Jay.

I'm subscribed to #446 and #190; say the word and I'll unsubscribe so you own
them cleanly. Everything I built is green and pushed — nothing is half-landed.
