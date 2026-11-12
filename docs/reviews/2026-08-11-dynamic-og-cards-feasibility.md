# Dynamic per-person OG cards (Satori + resvg-wasm) — feasibility note

Lane 6 (roster persistence + OG follow-ups), 2026-08-11. Assessment only — not built.

## The ask

Render `/og/politician/:id.png` on demand so a shared politician link reads
"Diana Harshbarger · TN-1 · 47 disclosed trades" instead of the current generic
"Politician profile" card, using Satori (JSX → SVG layout) + `@resvg/resvg-wasm`
(SVG → PNG) in-process, edge-cached.

## First finding: the brief's biggest risk doesn't bind production

**congress.trade does not run on Cloudflare's Workers platform in production.**
`app/Dockerfile` runs `deno run … src/deno/main.ts` in a container that Coolify
builds and redeploys on push to `main` (`package.json`'s `"deploy"` script is
literally `echo 'Production deployment is handled by Coolify on push to main'`;
`scripts/ship.sh` says the same). Cloudflare sits in front only as DNS/CDN
(hence the `server: cloudflare` / `cf-ray` response headers) — the actual Hono
app executes as a single long-running Deno process on a Hetzner box, not as
V8-isolate Workers distributed across Cloudflare's edge.

`src/index.ts` (the genuine `fetch`/`scheduled`/`queue` Worker entrypoint) and
`wrangler.preview.example.toml` are still live and used for preview
environments (`scripts/deploy-preview.sh`), sharing the same Hono router code
as production. So the feature has to work under **both** runtimes if preview
parity matters, but only the Deno-on-Hetzner constraints govern what users
actually see.

This flips the framing of every question below:

- **Bundle-size cost.** `@resvg/resvg-wasm` is ~2.5 MB unpacked (npm package;
  the compiled `.wasm` binary itself is in the task's estimated 1.5–2 MB
  range); Satori is a few hundred KB of JS. Against Cloudflare's real Workers
  ceiling (3 MB free / 10 MB paid, **compressed**) that's a meaningful bite,
  especially stacked on an already-substantial existing bundle (D1/R2
  bindings, the full extraction pipeline, admin routes, embedded dashboard
  HTML). Against a Docker image built by Coolify, it's just a few more
  megabytes on disk — not a hard platform ceiling. It only matters for the
  `src/index.ts` preview path, and only as a "does it still fit" check, not a
  launch blocker.
- **Worker CPU per cold render.** Cloudflare's Workers CPU-time limits (30s
  default / up to 5 min paid, separately billed) simply don't apply to the
  production path — it's a normal Deno process with no CPU-ms metering.
  What *does* still matter: production is **one shared, non-autoscaling
  process**. Genuine Workers auto-scale per request across isolates; a burst
  of crawler hits on many different politician links at once (Slack/iMessage
  unfurl the same link from several regions near-simultaneously) would
  serialize CPU work on this one box, competing with ingestion, extraction,
  and every other request the app is already serving. Community benchmarks
  for this exact stack (Satori layout + resvg-wasm rasterize at ~1200×630)
  land in the tens-to-~150ms range per render depending on font shaping and
  graphic complexity — cheap in isolation, but "cheap on a shared box under
  load" is a different claim than "cheap on auto-scaled edge isolates," and
  is the thing that would actually need measuring before shipping.
- **Startup-time risk.** Cloudflare Workers enforce a strict 1-second startup
  window that WASM instantiation counts against — a documented real pitfall
  for this exact stack elsewhere. That constraint doesn't exist for a Deno
  process that starts once and stays warm; the Dockerfile already gives the
  container a 120s health-check grace period.

## What's still a real cost, regardless of runtime

- **Embedded serif font subset.** Satori needs fonts supplied as raw
  ArrayBuffers (TTF/OTF) — no system fonts, no `@font-face` auto-loading, and
  historically no WOFF2 (the site's only branded font today,
  `assets/zilla-slab-700.woff2`, is WOFF2 and would need a TTF/OTF re-export).
  More importantly, the font has to cover every character that shows up
  in a full congressional roster's names — accented Latin (e.g. "María Elvira
  Salazar," "Yadira Caraveo") at minimum; the roster hasn't been audited for
  anything beyond that. Missing glyphs render as tofu/boxes in a share card,
  which is worse than the current generic art.
- **Satori's documented rough edges** (well-trodden by prior art, not
  hypothetical): image fetching inside Satori silently fails in
  Workers-shaped `fetch` environments (must pre-fetch and inline as base64);
  WOFF2 support has historically been unreliable; only PNG/JPEG output, no
  WebP. All solvable, all add real implementation time.
- **Data freshness at render time.** "47 disclosed trades" has to be computed
  from the same `memberSummarySql`-shaped aggregate the member profile
  endpoint already uses — cheap, but it's a live DB read on every cache miss,
  not a static asset.

## Cache strategy

The existing pattern already proves out and needs no new infrastructure:
`/og-image-politician.png` is served with `Cache-Control: public,
max-age=86400` and Cloudflare's default edge caching (by file extension, no
bespoke Cache Rule) already returns `cf-cache-status: HIT` on repeat requests
— confirmed live against production during this review. A dynamic route can
reuse exactly this: long `Cache-Control`, plus a version/freshness token in
the path or query (mirroring `OG_IMAGE_VERSION`, or a hash of member id +
trade-count bucket) so the cache key naturally rolls over when the underlying
data meaningfully changes, with no explicit purge step. Because production is
single-origin (not edge-distributed), the first request from any given
Cloudflare PoP after a miss pays full render cost and every subsequent request
from that PoP is free — normal and acceptable for a social-preview workload
(crawlers tolerate low-single-digit-second fetches), just worth setting
expectations that it isn't "edge-compute-cheap" the way it would be on
genuine Workers.

## Recommendation: qualified go, as its own follow-up lane

The feature is worth building — it's a differentiated, on-brand upgrade
("Trades tab" specificity extended to share cards) and the implementation
pattern is well-trodden (multiple public writeups of this exact Satori +
resvg-wasm stack, pitfalls and all). The scariest risk in the original framing
— Workers bundle-size headroom — turns out to not gate production at all,
since production isn't on the Workers platform. The real remaining unknowns
are narrower and cheaper to retire than the brief assumed:

1. Source/subset a TTF/OTF serif with full roster name coverage.
2. Measure actual render latency **on the shared Hetzner process under
   concurrent load**, not just in isolation — this is the one number that
   could still kill it if it's high enough to visibly compete with ingestion.
3. Design the cache-key/versioning scheme (per-member freshness token) before
   writing the route, not after.
4. Decide whether the `src/index.ts` preview/Workers path needs to support
   this too, and if so, budget its real bundle-size cost there separately
   (Cloudflare's 10MB paid ceiling is the one place the wasm size genuinely
   still matters).

None of these are large enough to justify blocking on a "no," but all four
should be explicit line items in whatever lane picks this up next, not
discovered mid-implementation.
