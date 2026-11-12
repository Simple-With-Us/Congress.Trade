# 2026-08-20 — Cross-app coordination follow-ups (CT slice)

## Context & Objective

Socratic.Trade audit #2802 (`docs/audits/2026-08-17-cross-app-coordination.md`
§7) listed peer-repo fixes.  This branch implements the Congress.Trade items:
CI runner policy, vendor provenance SHA, and Massive last-resort when
`PRICE_PROVIDER=peer`.

## Changes Made

- Rewrote AGENTS.md CI runner policy so agents stop reviving retired
  Coolify/Oracle self-hosted runners.  Verify JS/Deno is `ubuntu-latest`.
  Mac `mac-xcode26-congress` stays for iOS only.
- Added the CTS `v2.5.2` lock SHA to `VENDOR-PROVENANCE.md` so
  `scripts/check-shared-package-pin.mjs` can parse `- Commit: \`<40-hex>\``.
  Did not delete vendored `dist/` or `node_modules/` (audit item 8 hygiene;
  Deno-only not proven here).
- Peer-primary prices (`PRICE_PROVIDER=peer`) still fail closed on 401/402/403.
  Direct Massive is last-resort fallback when a key is already configured, not
  a parallel primary.  No second Massive key.

Touched:

- `AGENTS.md`
- `app/vendor/congress-trading-shared/VENDOR-PROVENANCE.md`
- `app/src/prices/service.ts`
- `app/src/prices/fallback.ts`
- `app/src/prices/peer.ts`
- `app/src/prices/__tests__/fallback.test.ts`
- `app/src/prices/__tests__/pricesRefresh.test.ts`
- `STATUS.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-08-20-cross-app-coordination-followups.md` (this file)

## Decisions & Trade-offs

- Last-resort Massive runs only after an empty peer series or a non-auth
  peer failure (5xx/network).  Auth/plan failures still throw so a broken
  `APP_B_INGEST_TOKEN` cannot burn the shared Massive 100/min budget.
- `peerOnly` stays true when Massive is last-resort so the per-run cap stays
  at `PEER_DAILY_CAP` (peer is unmetered; Massive is not the steady path).
- Workflow `runs-on` expressions were not rewritten in this PR.  AGENTS.md
  was the P1 that sent sessions down the retired-runner path.  Existing
  `CT_CI_RUNNER` fallback already lands on `ubuntu-latest` when the variable
  is unset.
- Did not mint `MASSIVE_API_KEY_ALT`.

## Verification State

```bash
node scripts/check-shared-package-pin.mjs
# Provenance: v2.5.2 @ b2847eb9… matches ST + UM lock refs

cd app && npm test
# 262 files / 3209 tests passed
```

`npm run typecheck` is `deno check` and was skipped: Deno is not installed in this cloud VM.  Pin-check and vitest ran on Node 22.

## Next Steps & Blockers

1. Leave vendored `dist/` + `node_modules/` until Deno-only is proven.
2. Promote ST's rewritten pin-check to required only after ST+CT+UM match.
3. Workflow `runs-on` still includes retired self-hosted expressions behind
   `CT_CI_RUNNER`.  Follow-up: pin verify jobs to `ubuntu-latest` literally
   once the owner confirms the variable can stay unset.

## Zero-Code Findings

Production already sets `PRICE_PROVIDER=peer`.  The old peer-only path never
called Massive at all; this change adds last-resort Massive without making it
a co-primary.
