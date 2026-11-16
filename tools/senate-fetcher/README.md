# Senate eFD Fetcher (Mac)

`fetch.py` is the single source of truth for the Senate eFD periodic transaction report (PTR) fetcher that runs on Jay's Mac.  It polls the Senate eFD site every 15 minutes from 6:00 AM onward, delivers new filings to the Congress.Trade intake (`POST /api/admin/senate-ptr-intake`), and posts a run heartbeat after every completed attempt so the admin panel can tell a quiet day from a dead fetcher.  This directory is the only place the code lives; the two Mac installs are deployments of it, not forks.

## The Two Installs

| Install | Home | Role | How it differs |
| --- | --- | --- | --- |
| agents | `/Users/agents/efd-fetcher` | primary | Fetches on schedule unless the proxy gate skips the run. |
| jay | `/Users/jay/efd-fetcher` | standby | Stands by while the primary is healthy; fetches only as fallback. |

The code is identical in both installs.  Every difference between the roles is a `config.json` value (see Role Configuration below).  Each run reports its role to the app as `agents` or `jay`, derived from the install's home path; the health panel renders those as "agents copy" and "Jay standby copy".

## Files

- `fetch.py` — the fetcher.  This is the only file that changes between releases.
- `config.example.json` — the primary install's config shape.  Copy it to the install home as `config.json` and set the per-install values.
- `com.jay.efd-fetcher.plist` — LaunchAgent template with a `__HOME__` placeholder where the install user's home path goes.
- `requirements.txt` — the one Python dependency.  The browser is the machine's installed Google Chrome; no Playwright browser download is used.

Never commit per-install state: `config.json`, `state.json`, `intake-token`, `profile/`, `out/`, `fetch.log`, and `first-seen-report.md` stay on the Mac.  The intake token is read from the file named by `intake_token_file` at call time and is never logged.

## Role Configuration

Two config keys carry the role behavior.  Unknown config keys are refused with a logged warning, so both keys are part of the code's known set.

- `peer_state_path` (standby only): absolute path to the primary install's `state.json`.  Setting it enables two behaviors.  The **standby gate** reads the primary's `last_ok` after acquiring the run lock; if the primary succeeded within 1200 seconds, this run exits 0 without fetching.  The **fallback offset** applies when this install does fetch as fallback: it first waits a random 60–180 seconds and re-reads the primary's `last_ok`, and stands down if the primary recovered in the meantime, so the two installs never fetch in the same minutes.  The primary leaves `peer_state_path` unset (or null).
- `browser_launch`: how Chrome is started.  `persistent_context` (the primary) lets Playwright launch the dedicated profile directly.  `background_cdp` (the standby) starts Chrome through LaunchServices behind the user's work, connects over CDP on port 19312, and runs a refocus guard that hands the foreground back to whatever app was frontmost at launch.

Both installs also run the **proxy gate**, which is not configurable.  Before any eFD attempt, the fetcher reads `https://congress.trade/api/health`; when the app's own probes show the residential-proxy route live (`senate_relay` and `senate_efd` both ok), the run stamps `last_ok`, reports ok, and exits without touching eFD, so the home IP is not exposed to eFD flagging twice over.  Any failure reading health fails open: a Congress.Trade outage never silences the fetcher.  Passing `--force` bypasses all three gates (standby, proxy, fallback offset) for interactive runs.

## Install

Run these steps once per install, as that install's user.  Replace `<user>` with `agents` or `jay`.

```sh
mkdir -p /Users/<user>/efd-fetcher
cd /Users/<user>/efd-fetcher
cp <repo>/tools/senate-fetcher/fetch.py .
cp <repo>/tools/senate-fetcher/config.example.json config.json
python3 -m venv venv
venv/bin/pip install -r <repo>/tools/senate-fetcher/requirements.txt
```

Edit `config.json`: set `intake_token_file` to this install's token path, and for the standby add `peer_state_path` and set `browser_launch` (see Role Configuration).  Create the `intake-token` file with the install's scoped intake token (mode 600).  Then install the schedule:

```sh
sed "s|__HOME__|/Users/<user>|g" <repo>/tools/senate-fetcher/com.jay.efd-fetcher.plist \
  > ~/Library/LaunchAgents/com.jay.efd-fetcher.plist
launchctl load ~/Library/LaunchAgents/com.jay.efd-fetcher.plist
```

The schedule fires every 15 minutes from 06:00 through the end of the day.  Do not change the schedule to change behavior; run timing inside the day (start offset, fallback offset, the 01:30 overnight spread) is the code's business, not launchd's.

## Update

An update is a file copy; launchd executes `fetch.py` fresh on every firing, so no reload or restart is needed.

```sh
cp fetch.py fetch.py.bak-$(date +%Y%m%d-%H%M)
cp <repo>/tools/senate-fetcher/fetch.py .
venv/bin/python -m py_compile fetch.py
```

Then watch the next scheduled run in `fetch.log` (see Runbook).  If it errors, restore the backup the same way.

## Runbook

- **Logs**: `fetch.log` in the install home is the run log (one timestamped line per event).  `launchd.out.log` and `launchd.err.log` beside it capture launchd-level output.  A healthy primary run ends with `OK rows=N new=M`; a healthy standby run logs `STANDBY agents copy healthy ...; skipping`; a proxy-gated run logs `proxy gate: residential proxy route healthy ...; skipping eFD attempt`.
- **Exit codes**: 0 ok (including gate skips), 1 unexpected error, 2 blocked by eFD (403 / Access Denied — log one line, wait for the next cycle; do not hammer retries), 3 another run holds the lock, 4 fetched ok but intake delivery failed (rows stay unseen and retry next run).
- **State**: `state.json` holds the `since` ratchet, the `seen` URL set, `last_ok`, and the `first_seen` ledger.  Never edit it by hand.  `first-seen-report.md` is regenerated after every successful run from both installs' ledgers and shows the ET hour-of-day publication pattern.
- **Manual run**: `venv/bin/python fetch.py --force` from the install home runs immediately with the gates bypassed.  Use it to smoke-test after an update.
- **The proxy is down and Senate matters now**: the fetcher is the fallback path, not the patient.  If the health panel shows the relay stalled, the fetcher's runs are what keep Senate data moving; check `fetch.log` on both installs before touching anything else.
- **Blocked (exit 2) repeatedly**: eFD is refusing the home IP or the profile session.  Stop the schedule (`launchctl unload`) and tell Jay; repeated blocked attempts are the flagging risk the proxy gate exists to avoid.
