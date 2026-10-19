# App Store Connect read-only checks

Four small scripts that answer "what does App Store Connect actually say right now",
so a release claim can be verified instead of assumed.

All of them are **read-only** — they issue GET requests only and never mutate a
version, submission, build, price, or subscription.

## Running them

They need `PyJWT` and `cryptography`:

```bash
python3 -m venv /tmp/ascvenv && /tmp/ascvenv/bin/pip install PyJWT cryptography
/tmp/ascvenv/bin/python scripts/asc/asc_status.py
```

| Script | Answers |
|---|---|
| `asc_status.py [all\|builds\|version\|iap\|submissions]` | Version state, which build is attached, subscription states, recent review submissions |
| `asc_testflight.py` | Whether the newest builds are actually installable in TestFlight (`internalBuildState`) |
| `asc_subs.py` | Subscription period, state, price points, and introductory offers |
| `asc_price_map.py` | What a **US** customer actually pays, by mapping each price row to its territory |

## Two traps these exist to avoid

1. **Price points are per-territory.**  The raw `subscriptions/{id}/prices` response lists
   many price points; reading the first one reports the wrong number.  `asc_price_map.py`
   resolves the `territory` relationship, which is why it reports $5.00 / $50.00 for the US
   rather than the $19.99 / $199.99 rows that belong to other territories.
2. **A merged PR is not a shipped build, and a shipped build is not an attached build.**
   `asc_status.py version` prints the binary actually attached to the App Store version, which
   has silently been a stale one before.

## Credentials

Each script gets `ASC_KEY_ID`, `ASC_ISSUER_ID` and the key from `asc_creds.py`:  process env
first (`ASC_KEY_PATH` or `ASC_KEY_P8`), then Infisical `/asc` through `fleet-secrets get`
(`ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8`).  It signs a short-lived JWT and never prints them.
Nothing reads `~/.secrets` (AFC-359).  Offline tests:  `python3 scripts/asc/test_asc_creds.py`.  No key material is stored in this repo.
