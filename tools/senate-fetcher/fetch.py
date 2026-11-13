#!/usr/bin/env python3
"""Senate eFD PTR fetcher for Congress.Trade (CT-2442).

Plain Playwright, installed Chrome, headed, dedicated profile.  Automation
hiding is off by default; the single exception is the config option
hide_automation (Jay's decision, 2026-10-30): when true, Chrome launches
with --disable-blink-features=AutomationControlled so navigator.webdriver
reads false.  No webdriver patch, no stealth plugins, no UA/fingerprint
spoofing either way.  If eFD blocks (403 / Access Denied), log one line and
exit 2 without retrying.

Exit codes: 0 ok, 1 unexpected error, 2 blocked, 3 another run in progress,
4 fetched ok but intake delivery failed (rows stay unseen and retry).

When intake_url is configured, each run's NEW rows are POSTed to the
Congress.Trade intake (POST /api/admin/senate-ptr-intake, CT-2442) with
the scoped token read from intake_token_file (never logged).  Rows are
marked seen only after the intake accepts them, so a failed delivery
retries on the next run; the out/ file is written either way.

Every completed run (ok, blocked, or error) also POSTs a small run
heartbeat to the app's /senate-fetcher-run endpoint (CT-2462), so the
review queue shows fetcher runs separately from deliveries.  The
report is best-effort and changes nothing about delivery or state.

This file is the single source for both Mac installs (it lives in the
Congress.Trade repo under tools/senate-fetcher/).  Role differences are
config, not code.  The standby install sets peer_state_path to the primary
install's state.json, which enables the standby gate and the variable
fallback offset; the primary leaves it unset.  browser_launch selects how
Chrome is started: "persistent_context" (Playwright launches the dedicated
profile) or "background_cdp" (Chrome is background-launched via
LaunchServices and driven over CDP, with a refocus guard).  Both installs
run the proxy gate: when Congress.Trade's health shows the
residential-proxy route live, the fetcher skips its eFD attempt entirely.
"""
import datetime, fcntl, html, json, os, random, re, sys, time
import urllib.request, urllib.error
from playwright.sync_api import sync_playwright, TimeoutError

HOME = os.path.expanduser("~/efd-fetcher")
CONFIG = os.path.join(HOME, "config.json")
PROF = os.path.join(HOME, "profile")
OUT = os.path.join(HOME, "out")
STATE = os.path.join(HOME, "state.json")
LOG = os.path.join(HOME, "fetch.log")
# Config defaults.  Deliberately no stealth, webdriver-patch or user-agent
# options; hide_automation is the only automation-signal control.  Unknown
# keys are refused with a logged warning.
DEFAULTS = {
    "enabled": True,
    "base_url": "https://efdsearch.senate.gov",
    "since_default": "10/01/2026",
    "page_size": 100,
    "max_pages": 10,
    "request_pause_seconds": 3,  # keep the rate modest
    "headless": False,
    "channel": "chrome",
    "hide_automation": False,
    "peer_state_path": None,
    "browser_launch": "persistent_context",
    "intake_url": "https://congress.trade/api/admin/senate-ptr-intake",
    "intake_token_file": "~/efd-fetcher/intake-token",
}
B = DEFAULTS["base_url"]
DEFAULT_SINCE = DEFAULTS["since_default"]
PAGE_LEN = DEFAULTS["page_size"]
MAX_PAGES = DEFAULTS["max_pages"]
PAUSE_S = DEFAULTS["request_pause_seconds"]
HEADLESS = DEFAULTS["headless"]
CHANNEL = DEFAULTS["channel"]
HIDE_AUTOMATION = DEFAULTS["hide_automation"]
PEER_STATE_PATH = DEFAULTS["peer_state_path"]
BROWSER_LAUNCH = DEFAULTS["browser_launch"]
INTAKE_URL = DEFAULTS["intake_url"]
INTAKE_TOKEN_FILE = DEFAULTS["intake_token_file"]


def load_config():
    cfg = dict(DEFAULTS)
    try:
        with open(CONFIG) as f:
            user = json.load(f)
    except FileNotFoundError:
        return cfg
    except Exception as e:
        log(f"WARN config.json unreadable ({type(e).__name__}); using defaults")
        return cfg
    if not isinstance(user, dict):
        log("WARN config.json is not an object; using defaults")
        return cfg
    for k, v in user.items():
        if k not in DEFAULTS:
            log(f"WARN config key refused (unknown): {k}")
            continue
        if k == "peer_state_path":
            if v is None or isinstance(v, str):
                cfg[k] = v
            else:
                log("WARN config key peer_state_path has wrong type; using default")
            continue
        want = type(DEFAULTS[k])
        ok = isinstance(v, bool) if want is bool else (
            isinstance(v, (int, float)) and not isinstance(v, bool) if want in (int, float) else isinstance(v, want))
        if not ok:
            log(f"WARN config key {k} has wrong type; using default")
            continue
        cfg[k] = v
    if not re.fullmatch(r"\d{2}/\d{2}/\d{4}", cfg["since_default"]):
        log("WARN since_default not MM/DD/YYYY; using default")
        cfg["since_default"] = DEFAULTS["since_default"]
    if not str(cfg["base_url"]).startswith("https://"):
        log("WARN base_url must be https://; using default")
        cfg["base_url"] = DEFAULTS["base_url"]
    if cfg["intake_url"] and not str(cfg["intake_url"]).startswith("https://"):
        log("WARN intake_url must be https:// or empty; using default")
        cfg["intake_url"] = DEFAULTS["intake_url"]
    cfg["base_url"] = cfg["base_url"].rstrip("/")
    cfg["page_size"] = max(1, min(int(cfg["page_size"]), 100))
    cfg["max_pages"] = max(1, min(int(cfg["max_pages"]), 50))
    cfg["request_pause_seconds"] = max(1.0, float(cfg["request_pause_seconds"]))
    if cfg["browser_launch"] not in ("persistent_context", "background_cdp"):
        log("WARN browser_launch unknown; using default")
        cfg["browser_launch"] = DEFAULTS["browser_launch"]
    if cfg["peer_state_path"] is not None:
        cfg["peer_state_path"] = os.path.expanduser(cfg["peer_state_path"])
    return cfg


def now():
    return datetime.datetime.now().astimezone()


def log(line):
    with open(LOG, "a") as f:
        f.write(f"{now().isoformat(timespec='seconds')} {line}\n")


def pause():
    # Timing jitter (Jay, 2026-11-01): draw each pause fresh from a
    # continuous range around the configured base instead of sleeping a
    # fixed, metronomic interval.  The floor keeps the request rate at or
    # below the configured pace on average; only the timing varies.
    time.sleep(max(1.5, PAUSE_S * random.uniform(0.75, 2.0)))


def akamai_ref(text):
    m = re.search(r"Reference\s*#\s*([0-9a-f.]+)", html.unescape(text or ""), re.I)
    return m.group(1) if m else "-"


class Blocked(Exception):
    def __init__(self, step, status, ref):
        super().__init__(f"BLOCKED step={step} status={status} akamai_ref={ref}")


def load_state():
    try:
        with open(STATE) as f:
            s = json.load(f)
    except FileNotFoundError:
        s = {}
    s.setdefault("since", DEFAULT_SINCE)  # set from config before load
    s.setdefault("seen", [])
    s.setdefault("first_seen", {})
    return s


def save_state(s):
    tmp = STATE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(s, f, indent=1)
    os.replace(tmp, STATE)


def stamp_first_seen(state, rows, ts):
    """Record first-seen stamps for newly accepted rows (2026-11-02).

    A stamp is the moment this fetcher first delivered the filing to the
    Congress.Trade intake — the run's fetched_at — never the filing's own
    date.  setdefault makes restamping impossible: a stamped URL keeps its
    original stamp forever, and rows reach this function only on the run
    that first marks them seen.
    """
    fs = state.setdefault("first_seen", {})
    stamp = ts.isoformat(timespec="seconds")
    for r in rows:
        url = r.get("report_url")
        if url:
            fs.setdefault(url, stamp)


def write_first_seen_report():
    """Regenerate first-seen-report.md from every readable fetcher state.

    Merges the first_seen ledgers of both fetcher copies (the agents
    primary and Jay's standby); the earliest stamp wins for a URL stamped
    by both.  Stamps are grouped by hour of day in America/New_York
    because Senate PTR releases appear to batch at particular ET hours.
    A filing's own received date is shown for context only — it is never
    a publication time.
    """
    from zoneinfo import ZoneInfo
    et = ZoneInfo("America/New_York")
    homes = ["/Users/agents/efd-fetcher", os.path.expanduser("~/efd-fetcher")]
    stamps = {}
    meta = {}
    for home in homes:
        try:
            with open(os.path.join(home, "state.json")) as f:
                s = json.load(f)
        except Exception:
            s = {}
        for url, ts in (s.get("first_seen") or {}).items():
            if url not in stamps or ts < stamps[url]:
                stamps[url] = ts
        try:
            names = sorted(os.listdir(os.path.join(home, "out")))
        except Exception:
            names = []
        for name in names:
            if not name.endswith(".json"):
                continue
            try:
                with open(os.path.join(home, "out", name)) as f:
                    payload = json.load(f)
            except Exception:
                continue
            for r in payload.get("rows", []):
                u = r.get("report_url")
                if u and u not in meta:
                    meta[u] = r
    parsed = []
    for url, ts in stamps.items():
        try:
            dt = datetime.datetime.fromisoformat(ts)
        except Exception:
            continue
        parsed.append((dt, url))
    parsed.sort(reverse=True)
    by_hour = {}
    for dt, _url in parsed:
        h = dt.astimezone(et).hour
        by_hour[h] = by_hour.get(h, 0) + 1
    lines = ["# Senate Publication Pattern Report", ""]
    lines.append(f"Generated {now().isoformat(timespec='seconds')} by the Senate eFD fetcher's first-seen logger.")
    lines.append("")
    lines.append("A first-seen stamp is the moment the fetcher first delivered a filing to the "
                 "Congress.Trade intake.  It is an upper bound on the true publication moment — "
                 "within one fetcher run of it (the fetcher runs every 15 minutes) — and it is "
                 "never the filing's own received date.  Stamps exist only for filings first "
                 "seen after the logger was installed on 2026-11-02; earlier filings carry no stamp.")
    lines.append("")
    lines.append(f"Stamped filings: {len(parsed)}")
    lines.append("")
    if parsed:
        lines.append("## Stamps by Hour of Day (ET)")
        lines.append("")
        for h in sorted(by_hour):
            lines.append(f"- {h:02d}:00-{h:02d}:59 ET: {by_hour[h]}")
        lines.append("")
        top = sorted(by_hour.items(), key=lambda kv: -kv[1])[:3]
        lines.append("Busiest ET hours so far: " + ", ".join(f"{h:02d}:00 ({n})" for h, n in top) + ".")
        lines.append("")
        lines.append("## All Stamps (Newest First)")
        lines.append("")
        for dt, url in parsed:
            r = meta.get(url, {})
            who = r.get("filer") or r.get("report_title") or url.rstrip("/").rsplit("/", 1)[-1]
            filed = r.get("date_received") or "?"
            lines.append(f"- {dt.astimezone(et).strftime('%Y-%m-%d %I:%M %p')} ET — {who} (received {filed})")
        lines.append("")
    else:
        lines.append("No filings have been stamped yet.  Stamps accumulate automatically as the "
                     "fetcher discovers new PTRs; check back after the next new filing.")
        lines.append("")
    text = "\n".join(lines)
    for home in homes:
        try:
            with open(os.path.join(home, "first-seen-report.md"), "w") as f:
                f.write(text)
        except Exception:
            pass


def parse_row(row):
    cells = [c if isinstance(c, str) else json.dumps(c) for c in row]
    link = title = None
    for c in cells:
        m = re.search(r'href="([^"]+)"[^>]*>(.*?)</a>', c, re.S)
        if m:
            link = m.group(1)
            title = html.unescape(re.sub(r"<[^>]+>", "", m.group(2))).strip()
            break
    if link and link.startswith("/"):
        link = B + link
    filed = next((c for c in reversed(cells) if re.fullmatch(r"\d{2}/\d{2}/\d{4}", c.strip())), None)
    return {
        "first_name": cells[0] if len(cells) > 0 else None,
        "last_name": cells[1] if len(cells) > 1 else None,
        "filer": cells[2] if len(cells) > 2 else None,
        "report_title": title,
        "report_url": link,
        "date_received": filed,
        "is_paper": bool(link and "/paper/" in link),
        "raw": row,
    }


def check_page_blocked(pg, step, status):
    try:
        pg.wait_for_load_state("domcontentloaded", timeout=15000)
        title, content = pg.title(), pg.content()
    except Exception:
        title, content = "", ""
    if status == 403 or "Access Denied" in title or "Access Denied" in content[:2000]:
        raise Blocked(step, status, akamai_ref(content))


FETCH_JS = """async ([start, len, since]) => {
  const t = document.cookie.match(/csrftoken=([^;]+)/);
  const body = new URLSearchParams({start: String(start), length: String(len),
    report_types: '[11]', filer_types: '[]',
    submitted_start_date: since + ' 00:00:00', submitted_end_date: '',
    candidate_state: '', senator_state: '', office_id: '', first_name: '', last_name: ''});
  const r = await fetch('/search/report/data/', {method: 'POST', body,
    headers: {'X-CSRFToken': t ? t[1] : ''}});
  return [r.status, r.headers.get('content-type') || '', await r.text()];
}"""


BG_DEBUG_PORT = 19312


import subprocess as _sp
import threading as _th


def _frontmost_app():
    try:
        r = _sp.run(["osascript", "-e",
                     'tell application "System Events" to get name of first '
                     'application process whose frontmost is true'],
                    capture_output=True, text=True, timeout=5)
        name = (r.stdout or "").strip()
        return name or None
    except Exception:
        return None


def _activate_app(name):
    try:
        _sp.run(["osascript", "-e", f'tell application "{name}" to activate'],
                capture_output=True, timeout=5)
    except Exception:
        pass


class _RefocusGuard:
    """Launch-then-refocus (Jay's pick, 2026-10-31): while the fetcher runs,
    whenever the background-launched Chrome takes the foreground, switch
    back to the app that was frontmost at launch.  Polls every 0.25s for
    the duration of the run only; logs how many times it had to correct.
    If the user was already in Chrome, the guard stays off (same bundle —
    app-level refocus cannot separate the two instances)."""

    def __init__(self):
        self.target = _frontmost_app()
        self.active = bool(self.target) and self.target != "Google Chrome"
        self.count = 0
        self._stop = _th.Event()
        self._thread = None

    def start(self):
        if not self.active:
            log(f"refocus guard off (frontmost at launch: {self.target})")
            return
        log(f"refocus guard on (protecting frontmost: {self.target})")
        self._thread = _th.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def _loop(self):
        while not self._stop.wait(0.25):
            if _frontmost_app() == "Google Chrome":
                _activate_app(self.target)
                self.count += 1

    def stop(self):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2)
        if self.active:
            log(f"refocus guard: corrected foreground {self.count} time(s)")


_GUARD = None


def _launch_bg_browser(p):
    """Background-launch variant (2026-10-31): start Chrome through
    LaunchServices with -n -g so its window opens behind the user's work
    and never takes focus, then connect over CDP.  The session otherwise
    matches the production fetcher: dedicated profile, headed, and the
    hide_automation flag when configured.  Returns (browser, context)."""
    import subprocess
    global _GUARD
    _GUARD = _RefocusGuard()
    _GUARD.start()
    # Clear any leftover instance of THIS profile so the debug port and
    # profile lock are free; the profile path is unique to this copy.
    subprocess.run(["pkill", "-f", "user-data-dir=" + PROF], capture_output=True)
    time.sleep(1)
    args = ["open", "-n", "-g", "-a", "Google Chrome", "--args",
            "--remote-debugging-port=" + str(BG_DEBUG_PORT),
            "--user-data-dir=" + PROF,
            "--no-first-run", "--no-default-browser-check"]
    if HIDE_AUTOMATION:
        args.append("--disable-blink-features=AutomationControlled")
    args.append(B + "/search/home/")
    subprocess.run(args, check=True)
    deadline = time.time() + 30
    while True:
        try:
            with urllib.request.urlopen(
                    "http://127.0.0.1:" + str(BG_DEBUG_PORT) + "/json/version",
                    timeout=2) as r:
                r.read()
            break
        except Exception:
            if time.time() > deadline:
                raise RuntimeError("background Chrome CDP endpoint did not come up")
            time.sleep(0.5)
    browser = p.chromium.connect_over_cdp(
        "http://127.0.0.1:" + str(BG_DEBUG_PORT))
    log("background launch: connected over CDP on port " + str(BG_DEBUG_PORT))
    return browser, browser.contexts[0]


def _close_bg_browser(ctx):
    import subprocess
    global _GUARD
    if _GUARD is not None:
        _GUARD.stop()
        _GUARD = None
    try:
        if ctx.pages:
            ctx.new_cdp_session(ctx.pages[0]).send("Browser.close")
    except Exception:
        pass
    time.sleep(1)
    subprocess.run(["pkill", "-f", "user-data-dir=" + PROF], capture_output=True)


def run(state):
    os.makedirs(PROF, exist_ok=True)
    rows = []
    with sync_playwright() as p:
        if BROWSER_LAUNCH == "background_cdp":
            browser, ctx = _launch_bg_browser(p)
        else:
            launch_args = ["--disable-blink-features=AutomationControlled"] if HIDE_AUTOMATION else []
            ctx = p.chromium.launch_persistent_context(PROF, channel=CHANNEL, headless=HEADLESS, args=launch_args)
        try:
            if BROWSER_LAUNCH == "background_cdp":
                pg = ctx.pages[0] if ctx.pages else ctx.new_page()
            else:
                pg = ctx.new_page()
            r = pg.goto(B + "/search/home/", timeout=30000)
            check_page_blocked(pg, "home", r.status if r else None)
            time.sleep(random.uniform(0.8, 2.0))  # pre-checkbox: human-scale pause (Jay, 2026-11-03)

            if pg.locator("#agree_statement").count():
                resp = None
                try:
                    with pg.expect_response(lambda x: x.request.method == "POST" and "/search/home" in x.url,
                                            timeout=20000) as ri:
                        pg.check("#agree_statement")
                    resp = ri.value
                except TimeoutError:
                    # A successful agreement POST redirects to /search/, so the
                    # final response may not match the predicate; the URL
                    # check below is the real success test.
                    log("agreement response not captured; checking URL")
                if resp is not None and resp.status == 403:
                    try:
                        body = resp.text()
                    except Exception:
                        body = ""
                    raise Blocked("agreement_post", 403, akamai_ref(body))
                # The agreement POST swaps the home page into the search page
                # in place (title becomes "eFD: Find Reports") and the URL
                # stays /search/home/, so there is no navigation to wait for.
                pg.wait_for_function(
                    "() => document.title.includes('Find Reports')", timeout=20000)
            elif "/search/home" in pg.url:
                pg.goto(B + "/search/", timeout=30000)
            try:
                pg.wait_for_load_state("networkidle", timeout=5000)
            except TimeoutError:
                # eFD keeps beacon connections open, so networkidle may never
                # settle; the report-data fetch below validates the page.
                log("networkidle wait timed out; continuing")
            check_page_blocked(pg, "search", 200)
            pause()

            start = 0
            for _ in range(MAX_PAGES):
                status, ctype, text = pg.evaluate(FETCH_JS, [start, PAGE_LEN, state["since"]])
                if status == 403 or "Access Denied" in text[:500]:
                    raise Blocked("report_data", status, akamai_ref(text))
                if status != 200 or "json" not in ctype:
                    raise RuntimeError(f"report_data unexpected status={status} ctype={ctype}")
                data = json.loads(text)
                batch = data.get("data", [])
                rows.extend(parse_row(x) for x in batch)
                start += len(batch)
                if not batch or start >= int(data.get("recordsFiltered", data.get("recordsTotal", 0)) or 0):
                    break
                pause()
        finally:
            if BROWSER_LAUNCH == "background_cdp":
                _close_bg_browser(ctx)
            else:
                ctx.close()
    return rows


# Browser UA for the intake call only: congress.trade's edge serves a managed
# challenge to bare HTTP clients, and the site's own admin callers (ship.sh,
# the Admin Maintenance workflow) present a browser UA the same way.  This is
# unrelated to the eFD browser above, which keeps its real fingerprint.
INTAKE_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
             "AppleWebKit/537.36 (KHTML, like Gecko) "
             "Chrome/131.0.0.0 Safari/537.36")


def post_intake(payload):
    """POST one run's new rows to the Congress.Trade intake.

    Returns the parsed response dict on success, None on any failure.
    The token is read from INTAKE_TOKEN_FILE at call time and never logged.
    """
    try:
        with open(os.path.expanduser(INTAKE_TOKEN_FILE)) as f:
            token = f.read().strip()
    except Exception:
        log("INTAKE FAIL token file unreadable")
        return None
    if not token:
        log("INTAKE FAIL token file empty")
        return None
    req = urllib.request.Request(
        INTAKE_URL,
        data=json.dumps(payload).encode(),
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "User-Agent": INTAKE_UA,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            body = json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        log(f"INTAKE FAIL http {e.code}")
        return None
    except Exception as e:
        log(f"INTAKE FAIL {type(e).__name__}: {str(e)[:120]}")
        return None
    if not body.get("ok"):
        log("INTAKE FAIL response not ok")
        return None
    return body


def report_run(status, rows, new_count):
    """POST one completed run's heartbeat to Congress.Trade (CT-2462).

    The intake only hears about runs that find NEW rows, so quiet runs
    were indistinguishable from a dead fetcher in the review queue.
    This report goes to the app (never the Senate) after every completed
    run attempt — ok, blocked, or error.  Best-effort: one log line on
    failure, no effect on exit code, delivery, or seen state.  A standby
    skip never reaches this: skips return before any run happens.
    """
    if not INTAKE_URL or "senate-ptr-intake" not in INTAKE_URL:
        return
    url = INTAKE_URL.replace("senate-ptr-intake", "senate-fetcher-run")
    role = "agents" if HOME.startswith("/Users/agents/") else "jay"
    payload = {"ranAt": now().isoformat(timespec="seconds"), "status": status,
               "rows": rows, "newCount": new_count, "role": role}
    try:
        with open(os.path.expanduser(INTAKE_TOKEN_FILE)) as f:
            token = f.read().strip()
    except Exception:
        log("RUN REPORT FAIL token file unreadable")
        return
    if not token:
        log("RUN REPORT FAIL token file empty")
        return
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "User-Agent": INTAKE_UA,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = json.loads(resp.read().decode())
        if not body.get("ok"):
            log("RUN REPORT FAIL response not ok")
    except urllib.error.HTTPError as e:
        log(f"RUN REPORT FAIL http {e.code}")
    except Exception as e:
        log(f"RUN REPORT FAIL {type(e).__name__}: {str(e)[:120]}")


def proxy_route_healthy():
    """True when Congress.Trade's own probes show the residential-proxy
    route to Senate eFD is live (senate_relay and senate_efd both ok).
    While that route works, this fetcher makes no eFD attempt at all, so
    the home IP is not exposed to eFD flagging twice over (Jay, 2026-11-13).
    Any error reading health returns False: fail open, so a Congress.Trade
    outage never silences this fallback."""
    try:
        req = urllib.request.Request(
            "https://congress.trade/api/health",
            headers={"User-Agent": "efd-fetcher-gate"})
        with urllib.request.urlopen(req, timeout=10) as r:
            d = json.load(r)
        checks = d.get("checks") or []
        if isinstance(checks, dict):
            checks = list(checks.values())
        st = {c.get("id"): c.get("status") for c in checks
              if isinstance(c, dict)}
        return st.get("senate_relay") == "ok" and st.get("senate_efd") == "ok"
    except Exception:
        return False


def main():
    global B, DEFAULT_SINCE, PAGE_LEN, MAX_PAGES, PAUSE_S, HEADLESS, CHANNEL, HIDE_AUTOMATION
    global INTAKE_URL, INTAKE_TOKEN_FILE, PEER_STATE_PATH, BROWSER_LAUNCH
    os.makedirs(OUT, exist_ok=True)
    cfg = load_config()
    if not cfg["enabled"]:
        log("DISABLED enabled=false in config.json; exiting")
        return 0
    B, DEFAULT_SINCE = cfg["base_url"], cfg["since_default"]
    PAGE_LEN, MAX_PAGES = cfg["page_size"], cfg["max_pages"]
    PAUSE_S, HEADLESS, CHANNEL = cfg["request_pause_seconds"], cfg["headless"], cfg["channel"]
    HIDE_AUTOMATION = cfg["hide_automation"]
    INTAKE_URL, INTAKE_TOKEN_FILE = cfg["intake_url"], cfg["intake_token_file"]
    PEER_STATE_PATH = cfg["peer_state_path"]
    BROWSER_LAUNCH = cfg["browser_launch"]
    if HIDE_AUTOMATION:
        log("hide_automation=on: Chrome will launch with --disable-blink-features=AutomationControlled")
    lockf = open(os.path.join(HOME, ".lock"), "w")
    try:
        fcntl.flock(lockf, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        log("SKIP another run in progress")
        return 3
    if PEER_STATE_PATH:
        primary_state = PEER_STATE_PATH
        primary_last_ok = None
        try:
            with open(primary_state) as f:
                primary_last_ok = json.load(f).get("last_ok")
        except Exception:
            pass
        if "--force" in sys.argv:
            log("forced run (--force): standby gate bypassed")
            primary_last_ok = None
        if primary_last_ok:
            try:
                age = (now() - datetime.datetime.fromisoformat(primary_last_ok)).total_seconds()
            except Exception:
                age = None
            if age is not None and age < 1200:
                log(f"STANDBY agents copy healthy (last_ok {primary_last_ok}, {age:.0f}s ago); skipping")
                return 0
            log(f"agents copy stale (last_ok {primary_last_ok}); running as fallback")
        elif "--force" not in sys.argv:
            log("agents copy state unreadable; running as fallback")
    if "--force" not in sys.argv and proxy_route_healthy():
        log("proxy gate: residential proxy route healthy (senate_relay + "
            "senate_efd ok); skipping eFD attempt")
        state = load_state()
        state["last_ok"] = now().isoformat(timespec="seconds")
        save_state(state)
        try:
            report_run("ok", 0, 0)
        except Exception:
            pass
        return 0
    if PEER_STATE_PATH and "--force" not in sys.argv:
        # Variable fallback offset (Jay, 2026-11-13): both copies launch on
        # the same quarter hours, so a fallback decision made in the same
        # minute as the primary's own run used to produce two fetches at
        # once.  Wait a random 1-3 minutes, then re-check: if the agents
        # copy has succeeded in the meantime, stand down.
        fb_delay = random.uniform(60, 180)
        log(f"fallback offset: waiting {fb_delay:.0f}s, then re-checking "
            "agents copy before fetching")
        time.sleep(fb_delay)
        try:
            with open(PEER_STATE_PATH) as f:
                recheck_ok = json.load(f).get("last_ok")
        except Exception:
            recheck_ok = None
        if recheck_ok:
            try:
                age = (now() - datetime.datetime.fromisoformat(
                    recheck_ok)).total_seconds()
            except Exception:
                age = None
            if age is not None and age < 1200:
                log(f"agents copy recovered during offset (last_ok "
                    f"{recheck_ok}); standing down")
                return 0
    # Start offset (Jay, 2026-11-06): launch times sit on exact quarter
    # hours, so push the actual fetch off the mark by a random amount --
    # 60-180s on regular runs, and up to a full hour on the 01:30 run so
    # the overnight fetch lands anywhere in 01:30-02:30.  Interactive
    # (--force) runs are not delayed.
    if "--force" in sys.argv:
        delay = 0.0
    elif now().hour == 1:
        delay = random.uniform(0, 3600)
    else:
        delay = random.uniform(60, 180)
    if delay > 1:
        log(f"start offset: waiting {delay:.0f}s before this run")
        time.sleep(delay)
    state = load_state()
    # Safety floor on the query window (Jay, 2026-11-01): always re-check at
    # least the trailing 30 days, so filings indexed late or runs missed for
    # a few days cannot fall behind the ratcheted `since`.  Dedup is by the
    # persistent `seen` URL set (and again server-side at the CT intake), so
    # the wider window only ever re-reads; it never double-posts.
    query_state = dict(state)
    floor_days = random.randint(21, 35)
    floor = (now() - datetime.timedelta(days=floor_days)).strftime("%m/%d/%Y")
    if datetime.datetime.strptime(state["since"], "%m/%d/%Y") > datetime.datetime.strptime(floor, "%m/%d/%Y"):
        query_state["since"] = floor
        log(f"window floor applied: query since={floor} ({floor_days}d floor; state since={state['since']})")
    try:
        rows = run(query_state)
    except Blocked as b:
        log(str(b))
        report_run("blocked", 0, 0)
        print(str(b), file=sys.stderr)
        return 2
    except Exception as e:
        log(f"ERROR {type(e).__name__}: {str(e)[:200]}")
        report_run("error", 0, 0)
        print(f"ERROR {e}", file=sys.stderr)
        return 1

    seen = set(state["seen"])
    new = [r for r in rows if r["report_url"] and r["report_url"] not in seen]
    intake_failed = False
    if new:
        ts = now()
        payload = {"source": B, "fetched_at": ts.isoformat(timespec="seconds"),
                   "since": state["since"], "rows": new}
        path = os.path.join(OUT, ts.strftime("%Y%m%d-%H%M") + ".json")
        with open(path, "w") as f:
            json.dump(payload, f, indent=1)
        if INTAKE_URL:
            result = post_intake(payload)
            if result is None:
                intake_failed = True
            else:
                log(f"INTAKE ok rows={result.get('received')} new={result.get('newCount')} "
                    f"rejected={result.get('rejected')}")
                seen.update(r["report_url"] for r in new)
                stamp_first_seen(state, new, ts)
        else:
            seen.update(r["report_url"] for r in new)
            stamp_first_seen(state, new, ts)
    dates = [datetime.datetime.strptime(r["date_received"], "%m/%d/%Y") for r in rows if r["date_received"]]
    if dates:
        # inclusive overlap of one day; dedup by report_url handles repeats
        state["since"] = max(max(dates) - datetime.timedelta(days=1),
                             datetime.datetime.strptime(state["since"], "%m/%d/%Y")).strftime("%m/%d/%Y")
    state["seen"] = sorted(seen)
    state["last_ok"] = now().isoformat(timespec="seconds")
    save_state(state)
    try:
        write_first_seen_report()
    except Exception as e:
        log(f"first-seen report failed: {type(e).__name__}: {str(e)[:120]}")
    log(f"OK rows={len(rows)} new={len(new)} since={state['since']}")
    report_run("ok", len(rows), len(new))
    return 4 if intake_failed else 0


if __name__ == "__main__":
    sys.exit(main())
