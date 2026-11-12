# 2026-08-14 — iOS TestFlight auto-ship once per hour

## Summary

Owner: unbuilt iOS updates may ship as often as once per hour.  The standing
gate was `DEFAULT_MIN_INTERVAL_SEC=9000` (2.5 hours) in
`scripts/ios-fleet/ship-testflight.sh`, which is the script every fleet app
uses (Congress.Trade, Socratic.Trade, Usage Monitor, Usage Local).
`.github/workflows/ios-ship.yml` already fires on push and on a twice-an-hour
cron; the 2.5h gate was what dropped most of those runs.  The standing limit
is now **3600 seconds (1 hour)**.

The seq-before-gate ordering bug (a rate-limited run burned `1.0.N` anyway)
was already fixed in this script: `evaluate_ship_gate` runs before
`next_build_seq`.  This change keeps that order and adds a reproducible
boundary test so a future edit cannot restore 2.5h, or put the counter back
in front of the gate, without the suite going red.

## Files changed

- `scripts/ios-fleet/ship-testflight.sh` — `DEFAULT_MIN_INTERVAL_SEC=3600`
- `scripts/ios-fleet/test-ship-seq.sh` — 43 → 47 assertions; 3000s still
  skips and does not consume a number; 3700s proceeds and consumes one;
  `contains()` is now a literal substring (UTF-8 em-dash + `()` no longer
  break the matcher)
- `scripts/ios-fleet/README.md`, `scripts/ios-ship-testflight.sh`,
  `.github/workflows/ios-ship.yml` — documented 1h
- Runtime `/Users/jay/apps/ios-fleet/ship-testflight.sh` updated to the same
  3600s default (LaunchAgent / ST / UM path).  `ship-all.sh` now also ships
  `usage-local` (it was registered and on the "ship now" button, but "ship
  all" skipped it).
- Sibling comment/pin PRs: Socratic.Trade `ios-ship.yml` +
  `scripts/ios-fleet.sha256`; Usage-Monitor `ios-ship.yml`.

## Verification

```bash
bash scripts/ios-fleet/test-ship-seq.sh
# passed: 47   failed: 0
```

The suite covers all four app keys.  A gated run still exits 0 with the
sequence file untouched.  Same-HEAD still skips.  `--force-ship` still
bypasses.

## Follow-ups

- Socratic.Trade ships via the runtime copy and a sha256 pin.  Refresh the
  pin in the sibling PR after this runtime edit, or ST's next ship fails the
  pin check.
- Cron stays at `:07/:37` (CT), `*/30` (ST), `:13/:43` (UM).  No workflow
  schedule change; the 1h gate is the throttle.
- App Store Connect review submission of a specific build is still an owner
  action (Monet left 1.0.7 vs a stray 1.0.0; later ships are past that).
