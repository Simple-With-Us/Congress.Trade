# 2026-08-11 — Committee / photo / price enrichment reliability

## Summary

Committee memberships looked sparse/missing because:
1. `runCommitteeSync` was admin-only (`POST /api/admin/committees/sync`) and not on the daily filer cron after a one-shot prod run.
2. Photos were hard-coded to small `225x275` unitedstates CDN size.
3. `securities_ref.current_price` could stay NULL even when `price_eod` history existed (bulk load / partial import), starving performance UI.

Fixes:
- Daily filer lane: **identity sync → photo enrichment → committee sync → ticker backfill**.
- Photos upgraded to **450x550**; re-runs upgrade legacy URLs; photo path uses `resolved_bioguide_id` when name match fails.
- Committee sync adds **House Clerk MemberData.xml** as secondary bioguide-keyed source (unioned with congress-legislators).
- Daily market lane backfills `current_price` / `latest_price_date` from local EOD before peer refresh (does not re-select solely on null `current_price`, which would break price-refresh termination); peer client sorts closes descending.

## Sources

| Domain | Primary | Secondary |
|--------|---------|-----------|
| Committees | unitedstates/congress-legislators JSON | Clerk of the House MemberData.xml |
| Photos | unitedstates/images/congress/450x550 | resolved bioguide path |
| Prices / SPX | Socratic.Trade peer (`PRICE_PROVIDER=peer`) | local EOD anchor backfill |
| Securities refs | SEC EDGAR + keyed providers; ST share import | — |

## Verification

```bash
cd app && npm run typecheck
npx vitest run src/enrichment/__tests__/committeeSync.test.ts src/__tests__/jobs.test.ts
# After deploy:
POST /api/admin/identity/sync
POST /api/admin/enrich-photos
POST /api/admin/committees/sync
# Spot-check: GET /api/analytics/member/<filerId> committees[] + photoUrl 450x550
```

## Follow-ups

- ST lane: enable dormant `CONGRESS_SHARE_ENABLED` push for price-needs redundancy.
- Former members (left mid-Congress) correctly have empty *current* committees.
- Executive filers have no committees by design.
