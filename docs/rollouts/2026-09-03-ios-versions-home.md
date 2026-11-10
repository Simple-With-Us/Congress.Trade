# 2026-09-03 — AppUpdatePrompt reads ai-fleet-coordinator

Owner is deleting `jaywedgeworth22/ios-app-versions`.  Personal-Site does not
link it.  The public manifest is now `site/ios-versions.json` on
`jaywedgeworth22/ai-fleet-coordinator`.

Pin + `clients/ios/CongressTrade/AppUpdatePrompt.swift` stay byte-identical.
`publish-ios-versions.sh` PUTs `site/ios-versions.json` on that repo.
Vendored `ios-app-versions.json` stays the stale failing fixture.

## Verification

```bash
node --test scripts/ios-fleet/app-update-prompt-pin.test.mjs
node --test scripts/ios-fleet/publish-ios-versions.test.mjs
```
