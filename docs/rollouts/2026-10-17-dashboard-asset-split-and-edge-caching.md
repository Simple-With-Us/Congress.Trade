# 2026-10-17 — Dashboard Asset Split And Edge Caching (CT-2418)

## Summary

The dashboard document dropped from about 820 KB to about 72 KB.  The stylesheet and the application script moved out of the server-rendered HTML into `dashboardStyles.ts` and `dashboardClient.ts`, and are served as real files at `/assets/dashboard.css` and `/assets/dashboard.js` with `public, max-age=31536000, immutable`.

Cache busting and skew control:

- Each asset URL carries `?v=<FNV-1a digest of the bytes>` (`assetVersion()` in `ui/assets.ts`).  A deploy therefore invalidates exactly the files whose bytes changed.
- `serveText` in `ui/routes.ts` enforces the pairing.  A request whose `?v=` does not match the current digest gets a `302` to the current digest URL, with no `immutable` on the redirect, so a client holding a document cached from an earlier deploy can never pin the new bytes under an old versioned URL.  A bare request (no `?v=`) serves the current bytes.
- The dashboard document gets `Cache-Control: public, s-maxage=300, stale-while-revalidate=600` on bare `/` and `/admin`, and no such header when `?member=`, `?ticker=` or `?trade=` is present (those render different Open Graph metadata from DB lookups, so an ungated header would let every crawler URL become its own edge object).
- `GET` responses with status `200` from `/api/analytics/*` get the same `s-maxage=300, stale-while-revalidate=600` unless the route already chose its own header (`/latency-summary` keeps `public, max-age=300`).

Also in this change:

- Migration `0105_filers_bioguide_lower_indexes.sql` adds expression indexes on `LOWER(bioguide_id)` and `LOWER(resolved_bioguide_id)` so the case-insensitive member lookups stop scanning `filers`.  The same statements are in `FILERS_BIOGUIDE_LOWER_SCHEMA_STATEMENTS` and the post-0024 list, so `POST /api/admin/migrate` applies them.
- Bug fix: `lookupTickerResolved` selected `FROM transactions` without the `t` alias that `TICKER_RESOLVED_SQL` needs, the error was swallowed, and the `?ticker=` company share card never rendered.

## Files changed

- `app/src/ui/dashboardHtml.ts`, `app/src/ui/dashboardClient.ts` (new), `app/src/ui/dashboardStyles.ts` (new)
- `app/src/ui/routes.ts`, `app/src/ui/assets.ts`
- `app/src/analytics/routes.ts`
- `app/migrations/0105_filers_bioguide_lower_indexes.sql` (new), `app/src/admin/migrations.ts`
- Tests: `app/src/ui/__tests__/dashboardHtml.test.ts`, `app/src/ui/__tests__/routes.test.ts`, `app/src/analytics/__tests__/routeCacheHeaders.test.ts` (new), `app/src/admin/__tests__/migrations.test.ts`

## Verification

```bash
cd app
npm run typecheck
npx vitest run src/ui src/analytics/__tests__/routeCacheHeaders.test.ts src/admin/__tests__/migrations.test.ts
```

After Coolify lands the SHA, run `bash app/scripts/ship.sh` so `POST /api/admin/migrate` creates the two indexes, then confirm:

- `curl -sI https://congress.trade/assets/dashboard.js?v=deadbeef` returns `302` with a `location` ending in the current `?v=` digest and no `immutable`.
- `curl -sI "https://congress.trade/assets/dashboard.js?v=<current>"` returns `200` with `cache-control: public, max-age=31536000, immutable`.
- `curl -sI https://congress.trade/` carries `s-maxage=300`, and `curl -sI "https://congress.trade/?member=X000000"` does not.

## Follow-ups

- **Cloudflare Cache Rule for `/api/analytics/*` (zone config, owner go-ahead).**  The `s-maxage` header added here is necessary but not sufficient: Cloudflare does not cache extensionless JSON by default, and the 2026-08 measurements (`docs/ux-findings-2026-08.md` § Directory, `docs/reviews/2026-08-19-full-app-expert-panel-review.md` item 185) saw `cf-cache-status: DYNAMIC` for headers of exactly this shape.  Until a Cache Rule (eligible for cache, respect origin TTL, cache key including the query string) covers `/api/analytics/*`, repeat analytics requests still reach the origin.  The same applies to the dashboard document at `/`.  Verify with `cf-cache-status: HIT` after the rule is applied; do not assume.  The `.css` and `.js` asset URLs are cached by Cloudflare's default extension rules, so the asset split does not depend on this.
- `serveAsset` in `ui/routes.ts` still types its Hono context as `any` (pre-existing, noted by Kody); `serveText` is typed.
