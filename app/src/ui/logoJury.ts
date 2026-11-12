/**
 * src/ui/logoJury.ts
 * OWNER: dashboard agent
 *
 * Admin keyboard jury for ticker logos. Same A/B/C/D plates as the owner
 * review: GitHub on light, GitHub on dark, logo.dev light, logo.dev dark.
 * Verdicts land in CONFIG_KV overlay (wins over the seeded top-30 map).
 */

import { all } from '../shared/db.ts';
import type { Env } from '../shared/types.ts';
import { buildTickerLeaderboardQuery } from '../analytics/builders.ts';
import {
  SEEDED_LOGO_POLICY,
  type SymbolLogoPolicy,
  canonicalLogoPolicySymbol,
  parseSymbolLogoPolicy,
  parseTickerLogoPolicyMap,
  policyFromLetters,
  readLogoPolicyOverlay,
  sourceOrderFor,
  upsertLogoPolicySymbol,
  writeLogoPolicyOverlay,
} from './tickerLogoPolicy.ts';

export async function logoJuryQueue(env: Env, limit = 200): Promise<{
  items: Array<{
    rank: number;
    ticker: string;
    name: string;
    tradeCount: number;
    light: string[];
    dark: string[];
    notes?: string;
    seeded: boolean;
    overlay: boolean;
  }>;
}> {
  const built = buildTickerLeaderboardQuery({ window: '90d', sort: 'trades', limit });
  const rows = await all<Record<string, unknown>>(env.DB, built.sql, built.params);
  const overlay = await readLogoPolicyOverlay(env);
  const items = rows.map((row, i) => {
    const ticker = canonicalLogoPolicySymbol(String(row.ticker ?? ''));
    const overlayRow = overlay[ticker];
    return {
      rank: i + 1,
      ticker,
      name: String(row.name ?? ticker),
      tradeCount: Number(row.trade_count) || 0,
      light: sourceOrderFor(ticker, 'light', overlay),
      dark: sourceOrderFor(ticker, 'dark', overlay),
      notes: overlayRow?.notes ?? SEEDED_LOGO_POLICY[ticker]?.notes,
      seeded: ticker in SEEDED_LOGO_POLICY,
      overlay: ticker in overlay,
    };
  });
  return { items };
}

export async function applyLogoJuryVerdict(
  env: Env,
  body: Record<string, unknown>,
): Promise<{ ok: true; ticker: string; policy: SymbolLogoPolicy } | { ok: false; error: string }> {
  const ticker = canonicalLogoPolicySymbol(String(body.ticker ?? ''));
  if (!/^[A-Z0-9._-]{1,20}$/.test(ticker)) return { ok: false, error: 'ticker is required' };

  let policy = parseSymbolLogoPolicy(body.policy);
  const letters = typeof body.letters === 'string' ? body.letters : '';
  if (!policy && letters) policy = policyFromLetters(letters);
  if (!policy) return { ok: false, error: 'provide policy {light,dark} or letters like CD' };
  if (typeof body.notes === 'string' && body.notes.trim()) {
    policy = { ...policy, notes: body.notes.trim() };
  }
  if (body.needsUpload === true) {
    const prependLocal = (order: SymbolLogoPolicy['light']) =>
      order[0] === 'local' ? order : (['local', ...order.filter((s) => s !== 'local')] as typeof order);
    policy = { ...policy, light: prependLocal(policy.light), dark: prependLocal(policy.dark) };
  }
  await upsertLogoPolicySymbol(env, ticker, policy);
  return { ok: true, ticker, policy };
}

export async function importLogoJuryMap(
  env: Env,
  body: unknown,
): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
  const parsed = parseTickerLogoPolicyMap(body);
  if (!parsed) return { ok: false, error: 'invalid policy map' };
  const current = await readLogoPolicyOverlay(env);
  await writeLogoPolicyOverlay(env, { ...current, ...parsed });
  return { ok: true, count: Object.keys(parsed).length };
}

export function logoJuryHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Ticker logo jury</title>
<style>
  :root { color-scheme: dark; --bg:#0e1520; --fg:#e8eef6; --muted:#8b9bb0; --line:#243044; --ok:#3dd68c; }
  * { box-sizing: border-box; }
  body { margin:0; font: 14px/1.45 ui-sans-serif, system-ui, sans-serif; background:var(--bg); color:var(--fg); }
  header { padding:16px 20px 8px; border-bottom:1px solid var(--line); }
  h1 { font-size:18px; margin:0 0 6px; font-weight:650; }
  .sub { color:var(--muted); max-width:760px; }
  kbd { font: 12px ui-monospace, monospace; border:1px solid var(--line); padding:1px 5px; border-radius:4px; }
  main { padding:20px; display:grid; gap:16px; }
  .meta { display:flex; gap:16px; flex-wrap:wrap; align-items:baseline; }
  .ticker { font-size:28px; font-weight:700; letter-spacing:.02em; }
  .plates { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:12px; }
  .plate { border:2px solid var(--line); border-radius:12px; padding:12px; cursor:pointer; }
  .plate.on { border-color:var(--ok); }
  .plate h2 { margin:0 0 8px; font-size:13px; font-weight:650; }
  .swatch { height:120px; display:flex; align-items:center; justify-content:center; border-radius:8px; }
  .swatch.light { background:#f4f6f8; }
  .swatch.dark { background:#0b1018; }
  .swatch img { width:64px; height:64px; object-fit:contain; }
  input { width:100%; background:#121a26; color:var(--fg); border:1px solid var(--line); border-radius:8px; padding:8px 10px; font: inherit; }
  .row { display:flex; gap:8px; flex-wrap:wrap; }
  button { font: inherit; padding:8px 12px; border-radius:8px; border:1px solid var(--line); background:#1a2433; color:var(--fg); cursor:pointer; }
  button.primary { background:#1f6feb; border-color:#1f6feb; }
  .status { color:var(--muted); min-height:1.4em; }
  @media (max-width: 900px) { .plates { grid-template-columns: 1fr 1fr; } }
</style>
</head>
<body>
<header>
  <h1>Ticker logo jury</h1>
  <p class="sub">Same four plates as chat. Toggle with <kbd>A</kbd> <kbd>B</kbd> <kbd>C</kbd> <kbd>D</kbd> (GitHub light / GitHub dark / logo.dev light / logo.dev dark). <kbd>Enter</kbd> saves and advances. <kbd>N</kbd> skips. <kbd>U</kbd> pins a local upload first. Overlay is live in CONFIG_KV; copy JSON when you want it in git.</p>
</header>
<main>
  <div class="meta">
    <div class="ticker" id="sym">…</div>
    <div id="who"></div>
    <div class="status" id="pos"></div>
  </div>
  <div class="plates">
    <div class="plate" data-k="A"><h2>A GitHub · light</h2><div class="swatch light"><img id="imgA" alt=""/></div></div>
    <div class="plate" data-k="B"><h2>B GitHub · dark</h2><div class="swatch dark"><img id="imgB" alt=""/></div></div>
    <div class="plate" data-k="C"><h2>C logo.dev · light</h2><div class="swatch light"><img id="imgC" alt=""/></div></div>
    <div class="plate" data-k="D"><h2>D logo.dev · dark</h2><div class="swatch dark"><img id="imgD" alt=""/></div></div>
  </div>
  <label>Notes<br/><input id="notes" placeholder="Upload light-mode mark, etc."/></label>
  <div class="row">
    <button class="primary" id="save" type="button">Save + next</button>
    <button type="button" id="skip">Skip</button>
    <button type="button" id="upload">Needs upload</button>
    <button type="button" id="dump">Copy overlay JSON</button>
  </div>
  <div class="status" id="msg"></div>
</main>
<script>
const state = { items: [], i: 0, letters: new Set(), needsUpload: false };
function el(id) { return document.getElementById(id); }
function current() { return state.items[state.i]; }
function lettersOf(item) {
  const s = [];
  if ((item.light || []).includes('github')) s.push('A');
  if ((item.dark || []).includes('github')) s.push('B');
  if ((item.light || []).includes('logodev')) s.push('C');
  if ((item.dark || []).includes('logodev')) s.push('D');
  return s;
}
function paint() {
  const item = current();
  if (!item) { el('sym').textContent = 'Done'; return; }
  el('sym').textContent = item.ticker;
  el('who').textContent = item.name + ' · ' + item.tradeCount + ' trades / 90d';
  el('pos').textContent = (state.i + 1) + ' / ' + state.items.length + (item.overlay ? ' · overlay' : item.seeded ? ' · seeded' : ' · default');
  el('notes').value = item.notes || '';
  const t = encodeURIComponent(item.ticker);
  el('imgA').src = '/api/logos/ticker?symbol=' + t + '&source=github&theme=light';
  el('imgB').src = '/api/logos/ticker?symbol=' + t + '&source=github&theme=dark';
  el('imgC').src = '/api/logos/ticker?symbol=' + t + '&source=logodev&theme=light';
  el('imgD').src = '/api/logos/ticker?symbol=' + t + '&source=logodev&theme=dark';
  document.querySelectorAll('.plate').forEach(function (p) {
    p.classList.toggle('on', state.letters.has(p.getAttribute('data-k')));
  });
}
function toggle(k) {
  if (state.letters.has(k)) state.letters.delete(k); else state.letters.add(k);
  paint();
}
async function load() {
  const res = await fetch('/api/admin/logo-jury/queue?limit=200', { credentials: 'same-origin' });
  if (!res.ok) { el('msg').textContent = 'Auth failed (' + res.status + '). Open this from an admin session.'; return; }
  const data = await res.json();
  state.items = data.items || [];
  const item = current();
  state.letters = new Set(item ? lettersOf(item) : []);
  paint();
}
async function save() {
  const item = current();
  if (!item) return;
  const letters = Array.from(state.letters).sort().join('');
  const res = await fetch('/api/admin/logo-jury/verdict', {
    method: 'PUT',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ticker: item.ticker, letters: letters, notes: el('notes').value, needsUpload: state.needsUpload }),
  });
  const j = await res.json();
  el('msg').textContent = res.ok ? 'Saved ' + item.ticker + ' as ' + letters : (j.error || 'save failed');
  state.needsUpload = false;
  state.i = Math.min(state.i + 1, state.items.length);
  const next = current();
  state.letters = new Set(next ? lettersOf(next) : []);
  paint();
}
document.querySelectorAll('.plate').forEach(function (p) {
  p.addEventListener('click', function () { toggle(p.getAttribute('data-k')); });
});
el('save').onclick = save;
el('skip').onclick = function () { state.i++; state.needsUpload = false; const n = current(); state.letters = new Set(n ? lettersOf(n) : []); paint(); };
el('upload').onclick = function () { state.needsUpload = true; el('msg').textContent = 'Next save will pin local first.'; };
el('dump').onclick = async function () {
  const res = await fetch('/api/admin/logo-jury/overlay', { credentials: 'same-origin' });
  const j = await res.json();
  await navigator.clipboard.writeText(JSON.stringify(j.overlay || j, null, 2));
  el('msg').textContent = 'Overlay JSON copied.';
};
document.addEventListener('keydown', function (e) {
  if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
  const k = e.key.toUpperCase();
  if ('ABCD'.indexOf(k) >= 0) { e.preventDefault(); toggle(k); }
  else if (e.key === 'Enter') { e.preventDefault(); save(); }
  else if (k === 'N') { e.preventDefault(); el('skip').click(); }
  else if (k === 'U') { e.preventDefault(); el('upload').click(); }
});
load();
</script>
</body>
</html>`;
}
