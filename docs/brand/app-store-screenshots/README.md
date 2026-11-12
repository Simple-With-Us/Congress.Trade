# App Store Screenshots (Congress.Trade iOS)

Generated from the **live latest iOS UI** on iPhone 16 Pro Max simulator
(not the ancient SVG mock in `clients/ios/Design/ios-dashboard-sample.svg`).

## Sets uploaded to App Store Connect (en-US, version 1.0)

| Slot | Files |
|------|--------|
| APP_IPHONE_67 (1290×2796) | `iphone_67/iphone_67_0{1_feed,2_trends,3_settings}.png` |
| APP_IPHONE_61 (1179×2556) | `iphone_61/iphone_61_0{1_feed,2_trends,3_settings}.png` |
| Raw Pro Max (1320×2868) | `raw/*.png` + `iphone_69/` |

## Scenes

1. **Trades** — BrandTitle lockup, shared filters, live trade rows with `$15k`–`$5m` brackets
2. **Trends** — Market Snapshot KPIs + What Congress Is Trading leaderboard
3. **Settings** — Sign-in, pictographic theme, APNs, legal links

## Regenerate

```bash
# 1. Boot iPhone 16 Pro Max sim + status bar 9:41
# 2. Mock API (when prod is down) or point at production:
node /tmp/ct-mock-api.mjs   # optional
export SIMCTL_CHILD_CONGRESS_TRADE_API_BASE_URL=http://127.0.0.1:8791/api/client/v1
# 3. Build/install/launch, capture, sips resize, upload via ASC API
```

Replaced ASC mockups (2026-08-07 GROK) that were sparse placeholder lists
(~80KB each) with real simulator captures (~0.4–1.7MB each).
