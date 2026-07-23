#!/usr/bin/env node
/**
 * scout/congress-scout.mjs — congressional-disclosure DETECTION-LATENCY scout.
 *
 * WHY THIS RUNS OUTSIDE CLOUDFLARE:
 *   Senate eFD (efdsearch.senate.gov) is behind Imperva, which blocks datacenter
 *   / cloud egress IPs (Cloudflare Workers, generic VPS). This must run on a
 *   RESIDENTIAL connection (your Mac / a Pi). No inbound ports needed — it only
 *   makes outbound requests and (optionally) POSTs detections to the app.
 *
 * WHAT IT DOES each cycle (default every 45s):
 *   - Detects new PTR filings straight from the primary gov sources, the instant
 *     they appear — House Clerk (intraday live search + PDF-URL frontier probe)
 *     and Senate eFD (the 3-step CSRF/agreement/DataTables flow) — and stamps
 *     `our_detected_at`. This is DETECTION ONLY (existence + link), not parsing.
 *   - Polls FMP (house-latest + senate-latest) and stamps `fmp_first_seen_at`
 *     the first time FMP surfaces each filing.
 *   - Joins the two by the filing's doc key and logs the lead:
 *       lead = fmp_first_seen_at − our_detected_at   (positive = we were first).
 *   - Only filings that FIRST APPEAR while the scout is running count as a real
 *     race ("live"); everything present at startup is flagged "baseline".
 *
 * RUN:
 *   FMP_API_KEY=xxx node scout/congress-scout.mjs            # loop
 *   FMP_API_KEY=xxx node scout/congress-scout.mjs --once     # one cycle (test)
 *   node scout/congress-scout.mjs --once                     # detection only (no FMP key)
 *
 * ENV (all optional except FMP_API_KEY for the race):
 *   FMP_API_KEY           FMP key; without it the FMP side is skipped.
 *   POLL_INTERVAL_SEC     default 45
 *   SOURCES               "house,senate" (default), or a subset
 *   HOUSE_FRONTIER        "1" (default) probe PDF frontier; "0" to disable
 *   HOUSE_PROBE_WINDOW    default 25   (docIds probed ahead of the known max)
 *   STATE_FILE            default ./scout-state.json
 *   LEADS_FILE            default ./scout-leads.jsonl
 *   CT_INGEST_URL         optional: POST each detection here
 *   CT_INGEST_TOKEN       bearer token for CT_INGEST_URL
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

// --- config -----------------------------------------------------------------
const ARGV = new Set(process.argv.slice(2));
const ONCE = ARGV.has('--once');
const FMP_KEY = process.env.FMP_API_KEY || '';
const INTERVAL_MS = (Number(process.env.POLL_INTERVAL_SEC) || 45) * 1000;
const SOURCES = new Set((process.env.SOURCES || 'house,senate').split(',').map((s) => s.trim()));
const FRONTIER = (process.env.HOUSE_FRONTIER ?? '1') !== '0';
const PROBE_WINDOW = Number(process.env.HOUSE_PROBE_WINDOW) || 25;
const PROBE_SPACING_MS = 300;
const STATE_FILE = process.env.STATE_FILE || './scout-state.json';
const LEADS_FILE = process.env.LEADS_FILE || './scout-leads.jsonl';
const CT_INGEST_URL = process.env.CT_INGEST_URL || '';
const CT_INGEST_TOKEN = process.env.CT_INGEST_TOKEN || '';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const SENATE = 'https://efdsearch.senate.gov';
const HOUSE_FD = 'https://disclosures-clerk.house.gov/FinancialDisclosure';
const HOUSE_PDF = 'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const _originalFetch = fetch;
const fetchWithRetry = async (url, options = {}, retries = 3) => {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await _originalFetch(url, options);
      if (res.status === 503 || res.status === 403 || res.status === 429) {
        if (i < retries - 1) {
          await sleep(2000 * (i + 1));
          continue;
        }
      }
      return res;
    } catch (err) {
      if (err.message && err.message.includes('fetch failed')) {
        if (i < retries - 1) {
          await sleep(5000 * (i + 1));
          continue;
        }
      }
      throw err;
    }
  }
};
globalThis.fetch = fetchWithRetry;

const nowIso = () => new Date().toISOString();
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const warn = (tag, e) => console.warn(new Date().toISOString().slice(11, 19), `! ${tag}:`, e?.message || e);

// --- tiny cookie jar (name=value; carried across the eFD redirect + POSTs) ---
function absorb(jar, res) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
  for (const c of list) {
    const kv = String(c).split(';', 1)[0];
    const i = kv.indexOf('=');
    if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
  }
}
const cookieHeader = (jar) => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
const stripTags = (s) => String(s || '').replace(/<[^>]*>/g, '').trim();

function keyFromLink(link) {
  let m = /\/ptr-pdfs\/(\d{4})\/(\d+)\.pdf/i.exec(link || '');
  if (m) return `H-${m[1]}-${m[2]}`;
  m = /\/search\/view\/ptr\/([^/?#]+)/i.exec(link || '');
  if (m) return `S-${m[1]}`;
  return null;
}

// --- Senate eFD (3-step CSRF/agreement/DataTables; residential IP required) --
function fmtSenate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}/${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}
async function detectSenate() {
  const jar = new Map();
  const H = { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9' };
  let res = await fetch(`${SENATE}/search/`, { headers: H, redirect: 'manual' });
  absorb(jar, res);
  for (let hop = 0; hop < 4 && [301, 302, 303, 307, 308].includes(res.status); hop++) {
    const loc = res.headers.get('location');
    if (!loc) break;
    res = await fetch(new URL(loc, `${SENATE}/search/`).href, { headers: { ...H, cookie: cookieHeader(jar) }, redirect: 'manual' });
    absorb(jar, res);
  }
  if (!res.ok) throw new Error(`GET /search/ HTTP ${res.status}`);
  const html = await res.text();
  // The hidden input's name/value attribute order isn't guaranteed by eFD's
  // template, so try both orders (mirrors app/src/ingestion/senateSource.ts
  // parseCsrfMiddlewareToken).
  const token = (
    /name=["']csrfmiddlewaretoken["']\s+value=["']([^"']+)["']/i.exec(html) ||
    /value=["']([^"']+)["']\s+name=["']csrfmiddlewaretoken["']/i.exec(html) ||
    []
  )[1];
  if (!token) throw new Error('csrfmiddlewaretoken not found (blocked?)');
  await fetch(`${SENATE}/search/home/`, {
    method: 'POST',
    headers: { ...H, 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader(jar), referer: `${SENATE}/search/`, origin: SENATE },
    body: `prohibition_agreement=1&csrfmiddlewaretoken=${encodeURIComponent(token)}`,
    redirect: 'manual',
  }).then((r) => absorb(jar, r));
  const now = new Date();
  const since = new Date(now.getTime() - 45 * 864e5);
  const body = new URLSearchParams({
    // eFD inserted an "office" display column ahead of the PTR link, shifting
    // the submitted-date column from index 4 to 5 (see the 6-column fixture in
    // app/src/ingestion/__tests__/senateSource.test.ts). Sorting by the old
    // index-4 no longer orders by date, which can omit the newest filings once
    // a 45-day window has more than `length` rows.
    draw: '1', start: '0', length: '100', 'search[value]': '', 'search[regex]': 'false',
    'order[0][column]': '5', 'order[0][dir]': 'desc', report_types: '[11]', filer_types: '[]',
    submitted_start_date: fmtSenate(since), submitted_end_date: fmtSenate(now), first_name: '', last_name: '',
  });
  const data = await fetch(`${SENATE}/search/report/data/`, {
    method: 'POST',
    headers: { ...H, 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', cookie: cookieHeader(jar), referer: `${SENATE}/search/`, origin: SENATE, 'x-csrftoken': jar.get('csrftoken') || token, 'x-requested-with': 'XMLHttpRequest', accept: 'application/json,text/javascript,*/*; q=0.01' },
    body: body.toString(),
  });
  if (!data.ok) throw new Error(`report/data/ HTTP ${data.status}`);
  const json = await data.json();
  const rows = Array.isArray(json.data) ? json.data : [];
  const out = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    // eFD's DataTables column order shifts (it recently inserted an "office"
    // display column, moving the anchor from index 2 to 3), so find each cell
    // by content rather than trusting a fixed index.
    const cells = (Array.isArray(r) ? r : []).map((c) => (typeof c === 'string' ? c : ''));
    const anchorCell = cells.find((c) => /\/search\/view\/ptr\//i.test(c));
    const href = anchorCell ? (/href=["']([^"']+)["']/i.exec(anchorCell) || [])[1] : null;
    const key = keyFromLink(href || '');
    if (!key) continue;
    const nameCell = cells.find((c) => /\(Senator\)/i.test(c) && !/</.test(c));
    const filedDate = (cells.find((c) => /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(c.trim())) ?? '').trim();
    out.push({
      source: 'senate',
      key,
      link: href.startsWith('http') ? href : `${SENATE}${href}`,
      name: stripTags(nameCell) || `${r[0]} ${r[1]}`.trim(),
      filedDate: filedDate || undefined,
    });
  }
  return out;
}

// --- House Clerk (intraday live search + PDF-URL frontier probe) -------------
async function detectHouseLiveSearch() {
  const jar = new Map();
  const land = await fetch(`${HOUSE_FD}/ViewSearch`, { headers: { 'user-agent': UA, accept: 'text/html,*/*' } });
  if (land.ok) absorb(jar, land);
  const body = new URLSearchParams({ LastName: '', FilingYear: String(new Date().getUTCFullYear()), State: '', District: '' });
  const res = await fetch(`${HOUSE_FD}/ViewMemberSearchResult`, {
    method: 'POST',
    headers: { 'user-agent': UA, 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html,*/*', referer: `${HOUSE_FD}/ViewSearch`, origin: 'https://disclosures-clerk.house.gov', 'x-requested-with': 'XMLHttpRequest', ...(cookieHeader(jar) ? { cookie: cookieHeader(jar) } : {}) },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`live search HTTP ${res.status}`);
  const html = await res.text();
  const out = [];
  const seen = new Set();
  const re = /href=["']([^"']*\/ptr-pdfs\/(\d{4})\/(\d+)\.pdf)["']/gi;
  let m;
  while ((m = re.exec(html))) {
    if (seen.has(m[3])) continue;
    seen.add(m[3]);
    // Rebuild the absolute URL from the captured year/docId via the known-good
    // HOUSE_PDF base instead of the raw matched href: the live-search markup
    // sometimes omits the leading slash (e.g. href="public_disc/ptr-pdfs/...")
    // which naive prefixing turns into an unusable
    // ".../house.govpublic_disc/..." URL.
    out.push({ source: 'house', key: `H-${m[2]}-${m[3]}`, link: `${HOUSE_PDF}/${m[2]}/${m[3]}.pdf` });
  }
  return out;
}
async function detectHouseFrontier(state) {
  if (!state.houseMaxDocId) return []; // need a baseline from the live search first
  const year = new Date().getUTCFullYear();
  const out = [];
  for (let i = 1; i <= PROBE_WINDOW; i++) {
    const id = state.houseMaxDocId + i;
    const url = `${HOUSE_PDF}/${year}/${id}.pdf`;
    try {
      const r = await fetch(url, { method: 'HEAD', headers: { 'user-agent': UA } });
      if (r.ok) out.push({ source: 'house', key: `H-${year}-${id}`, link: url });
    } catch { /* ignore a single probe failure */ }
    await sleep(PROBE_SPACING_MS); // gentle: the Clerk throttles bursts
  }
  return out;
}

// --- FMP (the competitor we're timing against) ------------------------------
async function pollFmp() {
  const out = [];
  for (const ch of ['house', 'senate']) {
    const url = `https://financialmodelingprep.com/stable/${ch}-latest?page=0&limit=100&apikey=${encodeURIComponent(FMP_KEY)}`;
    const r = await fetch(url, { headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error(`${ch}-latest HTTP ${r.status}`);
    const json = await r.json();
    // FMP sometimes wraps the array as {data: [...]} and Senate rows can carry
    // the source link under `url` instead of `link` (see the repo's own FMP
    // parser + fixtures: app/src/ingestion/__tests__/fmpDisclosureLatency.test.ts).
    const rows = Array.isArray(json) ? json : Array.isArray(json?.data) ? json.data : [];
    for (const row of rows) {
      const key = keyFromLink(row?.link || row?.url || '');
      if (key) out.push({ key });
    }
  }
  return out;
}

// --- optional: push detections to the Cloudflare app ------------------------
// Returns true on success (or when CT_INGEST_URL isn't configured, i.e.
// nothing to retry) and false on failure so the caller can retry on a later
// cycle instead of silently dropping the detection forever.
async function maybePost(d, ts) {
  if (!CT_INGEST_URL) return true;
  try {
    const res = await fetch(CT_INGEST_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(CT_INGEST_TOKEN ? { authorization: `Bearer ${CT_INGEST_TOKEN}` } : {}) },
      body: JSON.stringify({
        source: d.source,
        docKey: d.key,
        link: d.link,
        detectedAt: ts,
        filerName: d.name || undefined,
        filedDate: d.filedDate || undefined,
        // Default server-side is ingest-when-link-present; send explicitly so
        // pure latency runs can set CT_INGEST_LATENCY_ONLY=1 without code edits.
        ingest: process.env.CT_INGEST_LATENCY_ONLY === '1' ? false : true,
      }),
    });
    if (!res.ok) {
      warn('ct-post', new Error(`HTTP ${res.status}`));
      return false;
    }
    try {
      const body = await res.json();
      if (body && (body.insert || body.enqueued != null)) {
        log('POSTED', d.key, `insert=${body.insert ?? '?'}`, `enqueued=${body.enqueued ?? '?'}`);
      }
    } catch {
      /* response body optional */
    }
    return true;
  } catch (e) {
    warn('ct-post', e);
    return false;
  }
}

// --- state ------------------------------------------------------------------
function loadState() {
  const fresh = { startedAt: nowIso(), baselineEstablishedAt: null, ourSeen: {}, posted: {}, fmpSeen: {}, leadsLogged: {}, houseMaxDocId: 0 };
  if (existsSync(STATE_FILE)) {
    try {
      // Merge onto `fresh` so a state file saved before these fields existed
      // (baselineEstablishedAt, posted) doesn't crash on the new code paths.
      return { ...fresh, ...JSON.parse(readFileSync(STATE_FILE, 'utf8')) };
    } catch { /* reset */ }
  }
  return fresh;
}
const saveState = (s) => writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));

// --- one cycle --------------------------------------------------------------
async function cycle(state) {
  // The very first cycle (per persisted state, so a launchctl/process restart
  // does NOT re-trigger this) is a startup snapshot of whatever's already
  // public, not a real detection race — those entries would otherwise get
  // posted to the app and scored as us "winning" a race that never happened.
  const isBaselineCycle = !state.baselineEstablishedAt;

  // Poll FMP BEFORE running our own detection. Both happen within the same
  // cycle a few hundred ms apart; detecting first would always stamp
  // `ourSeen` ahead of `fmpSeen` for anything FMP already had by this cycle,
  // silently inflating our measured lead. Polling FMP first errs the other way
  // (conservative), which is the correct bias for an experiment measuring
  // whether we're actually ahead.
  if (FMP_KEY) {
    try { for (const f of await pollFmp()) if (!state.fmpSeen[f.key]) state.fmpSeen[f.key] = { at: nowIso() }; }
    catch (e) { warn('fmp', e); }
  }

  const detections = [];
  if (SOURCES.has('house')) {
    try { detections.push(...(await detectHouseLiveSearch())); } catch (e) { warn('house-live', e); }
    if (FRONTIER) { try { detections.push(...(await detectHouseFrontier(state))); } catch (e) { warn('house-frontier', e); } }
  }
  if (SOURCES.has('senate')) { try { detections.push(...(await detectSenate())); } catch (e) { warn('senate', e); } }

  for (const d of detections) {
    if (d.key.startsWith('H-')) { const n = Number(d.key.split('-').pop()); if (n > state.houseMaxDocId) state.houseMaxDocId = n; }
    if (!state.ourSeen[d.key]) {
      const at = nowIso();
      state.ourSeen[d.key] = { at, source: d.source, link: d.link, name: d.name || null, filedDate: d.filedDate || null };
      log('DETECT', d.source.padEnd(6), d.key, d.name || '');
    }
  }

  // Post (or retry a previously-failed post for) every detection, skipping the
  // baseline cycle entirely so pre-existing filings never reach the app as
  // "just detected". `state.posted` only flips to true on a successful POST,
  // so a detection whose post failed (bad token, app down, ...) keeps
  // retrying on later cycles instead of vanishing once the config is fixed.
  if (!isBaselineCycle) {
    for (const [key, entry] of Object.entries(state.ourSeen)) {
      if (state.posted[key]) continue;
      const ok = await maybePost({ source: entry.source, key, link: entry.link, name: entry.name, filedDate: entry.filedDate }, entry.at);
      if (ok) state.posted[key] = true;
    }
  }

  const startMs = state.baselineEstablishedAt ? Date.parse(state.baselineEstablishedAt) : Date.parse(state.startedAt);
  for (const key of Object.keys(state.ourSeen)) {
    if (state.leadsLogged[key]) continue;
    const our = state.ourSeen[key];
    const fmp = state.fmpSeen[key];
    if (!our || !fmp) continue;
    const leadSec = Math.round((Date.parse(fmp.at) - Date.parse(our.at)) / 1000);
    const live = Date.parse(our.at) > startMs && Date.parse(fmp.at) > startMs;
    const rec = { key, source: our.source, name: our.name, ourDetectedAt: our.at, fmpFirstSeenAt: fmp.at, leadSec, live, loggedAt: nowIso() };
    appendFileSync(LEADS_FILE, JSON.stringify(rec) + '\n');
    state.leadsLogged[key] = true;
    log('LEAD  ', `${leadSec >= 0 ? '+' : ''}${leadSec}s`, live ? '(live race)' : '(baseline)', key, our.name || '');
  }
  if (isBaselineCycle) {
    state.baselineEstablishedAt = nowIso();
    log(`baseline established: ${Object.keys(state.ourSeen).length} pre-existing filing(s) will not be posted or scored as races`);
  }
  saveState(state);
  summarize(state);
}

function summarize(state) {
  const leads = existsSync(LEADS_FILE) ? readFileSync(LEADS_FILE, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const live = leads.filter((l) => l.live);
  const ahead = live.filter((l) => l.leadSec > 0);
  const detected = Object.keys(state.ourSeen).length;
  const matched = leads.length;
  let median = null;
  if (live.length) { const s = live.map((l) => l.leadSec).sort((a, b) => a - b); median = s[Math.floor(s.length / 2)]; }
  log(`SUMMARY detected=${detected} matched-with-fmp=${matched} live-races=${live.length} we-were-first=${ahead.length}${median != null ? ` median-lead=${median}s` : ''}`);
}

// --- main -------------------------------------------------------------------
(async () => {
  const state = loadState();
  log(`scout start — sources=${[...SOURCES].join('+')} interval=${INTERVAL_MS / 1000}s frontier=${FRONTIER} fmp=${FMP_KEY ? 'on' : 'OFF (detection-only)'}`);
  if (ONCE) { await cycle(state); return; }
  for (;;) { await cycle(state).catch((e) => warn('cycle', e)); await sleep(INTERVAL_MS); }
})();
// Senate Scraper Hardening applied
