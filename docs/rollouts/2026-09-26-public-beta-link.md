# Public beta aliases

`/beta`, `/testflight`, `/ios` and `/app` previously defaulted to a TestFlight URL containing the bundle identifier rather than an invitation code.  The default now uses the public Congress.Trade invite `VNUEU6Ge`, which returned HTTP 200 with the Congress.Trade beta title on 2026-09-26.  Reachability does not establish beta enrollment or installation.

`IOS_TESTFLIGHT_URL` accepts HTTPS Apple TestFlight invite or App Store product URLs.  Generic Apple landing pages, HTTP URLs, credentials, ports and unrelated domains fall through to a configured App Store id or the known invite.  Existing valid override and App Store fallback behavior remain covered by the route tests.

Validation: `vitest run src/ui/__tests__/routes.test.ts src/ui/__tests__/appLinks.test.ts --maxWorkers=1` passed 43 tests using the existing dependency installation.  CI and production verification are pending.  After deployment, follow each alias and check the final destination and product name.  Roll back this commit if needed; no data migration or native release is involved.
