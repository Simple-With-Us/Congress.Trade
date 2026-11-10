import { parse } from "https://deno.land/std/datetime/mod.ts";
import { createClient } from "npm:@libsql/client/web";
import { D1DatabaseShim } from "../src/deno/shims.ts";
import { generateTradeHash } from "../src/ingestion/tradeLatency.ts";
import { persistTransactions } from "../src/extraction/normalizer.ts";
import type { Env, Transaction } from "../src/shared/types.ts";
import { load } from "https://deno.land/std@0.224.0/dotenv/mod.ts";
import { resolveSecret } from "../src/secrets/infisical.ts";
import {
  assetNameFromCompetitorPayload,
  resolveExecutiveFilerIdFromName,
} from "../src/shared/executiveIdentity.ts";
import {
  chamberFromMemberType,
  competitorHouseFilerId,
  competitorQualifiedManualFilerId,
  competitorReporterNames,
  parseCompetitorReporter,
} from "../src/shared/competitorAttribution.ts";
import {
  findExistingFilerForCompetitorReporter,
  type ExistingFilerCandidate,
} from "../src/shared/competitorFilerMatch.ts";

const dataDir = new URL("../../data/hoarded", import.meta.url).pathname;

async function getEnv(): Promise<Env> {
  const envVars = await load({ envPath: ".dev.vars", export: true });
  
  // Set env vars so resolveSecret can find Infisical creds
  for (const [k, v] of Object.entries(envVars)) {
    Deno.env.set(k, v);
  }

  // resolve secrets
  const mockEnv = envVars as unknown as Env;
  const tursoUrl = (await resolveSecret(mockEnv, "TURSO_DATABASE_URL")).value;
  const tursoToken = (await resolveSecret(mockEnv, "TURSO_AUTH_TOKEN")).value;

  if (!tursoUrl) throw new Error("Could not resolve TURSO_DATABASE_URL");

  const libsqlClient = createClient({
    url: tursoUrl,
    authToken: tursoToken,
  });
  const db = new D1DatabaseShim(libsqlClient);
  return { DB: db } as unknown as Env;
}

function extractLastName(name: string) {
  if (!name) return '';
  const parts = name.split(',')[0].split(' ');
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i].toLowerCase().replace(/[^a-z]/g, '');
    if (p && !['jr', 'sr', 'md', 'ii', 'iii', 'iv'].includes(p)) {
      return p;
    }
  }
  return '';
}

async function loadHoardedData() {
  const uwTrades = JSON.parse(await Deno.readTextFile(`${dataDir}/uw_recent_trades.json`));
  const qqTrades = JSON.parse(await Deno.readTextFile(`${dataDir}/qq_bulk_congresstrading.json`));
  const fmpHouse = JSON.parse(await Deno.readTextFile(`${dataDir}/fmp_house.json`));
  const fmpSenate = JSON.parse(await Deno.readTextFile(`${dataDir}/fmp_senate.json`));
  
  let trumpTrades: any[] = [];
  try {
    const raw = await Deno.readTextFile(`${dataDir}/trump_trades.json`);
    try {
      trumpTrades = JSON.parse(raw);
    } catch {
      // Try stream of objects
      trumpTrades = JSON.parse("[" + raw.replace(/\}\s*\{/g, "},{") + "]");
    }
  } catch (e) {
    console.warn("Could not load trump_trades.json");
  }

  return { uwTrades, qqTrades, fmpHouse, fmpSenate, trumpTrades };
}

async function run() {
  const env = await getEnv();
  
  // 1. Get all official trades from DB to compare against
  console.log("Fetching existing trades from DB...");
  const dbRows = await env.DB.prepare("SELECT f.full_name as filer_name, t.ticker, t.tx_date, t.tx_type FROM transactions t JOIN filers f ON t.filer_id = f.bioguide_id").all<{
    filer_name: string; ticker: string; tx_date: string; tx_type: string;
  }>();
  
  const officialMap = new Set<string>();
  for (const t of dbRows.results) {
    const lastName = extractLastName(t.filer_name);
    const ticker = (t.ticker || '').toUpperCase();
    const date = t.tx_date;
    const typeStr = (t.tx_type || '');
    const tStr = (typeStr || '').toLowerCase();
    const type = tStr.includes('buy') || tStr.includes('purchase') ? 'buy' :
                 tStr.includes('sell') || tStr.includes('sale') ? 'sell' : 'exchange';
                 
    officialMap.add(`${lastName}_${ticker}_${date}_${type}`);
  }
  console.log(`Loaded ${officialMap.size} existing trades into lookup map.`);

  // 2. Load competitor data
  const { uwTrades, qqTrades, fmpHouse, fmpSenate, trumpTrades } = await loadHoardedData();
  
  const fiveYearsAgo = new Date();
  fiveYearsAgo.setFullYear(fiveYearsAgo.getFullYear() - 5);
  const cutoffDate = fiveYearsAgo.toISOString().split('T')[0];

  const novelTrades: Transaction[] = [];
  const novelSet = new Set<string>();
  
  const nowStr = new Date().toISOString();

  function processTrade(provider: string, rawName: string, chamber: 'house' | 'senate' | 'executive', ticker: string, date: string, typeStr: string, rawObj: any, filerId: string) {
    if (!date || date < cutoffDate) return;

    const tk = (ticker || '').toUpperCase();
    if (!tk) return; // Need ticker

    const lastName = extractLastName(rawName);
    const tStr = (typeStr || '').toLowerCase();
    const type = tStr.includes('buy') || tStr.includes('purchase') ? 'buy' :
                 tStr.includes('sell') || tStr.includes('sale') ? 'sell' : 'exchange';
                 
    const exactKey = `${lastName}_${tk}_${date}_${type}`;
    if (officialMap.has(exactKey)) return; 
    
    // Fuzzy search: check +- 2 days
    let found = false;
    const d = new Date(date);
    for (let offset = -2; offset <= 2; offset++) {
      const fd = new Date(d);
      fd.setDate(fd.getDate() + offset);
      const fdStr = fd.toISOString().split('T')[0];
      const offsetKey = `${lastName}_${tk}_${fdStr}_${type}`;
      if (officialMap.has(offsetKey)) {
        found = true;
        break;
      }
    }
    
    if (found) return;

    if (novelSet.has(exactKey)) return; // Don't duplicate inside this run

    const tradeHash = generateTradeHash(rawName, tk, date, type);
    const docId = `COMPETITOR-${tradeHash}`;

    // filerId is resolved once by the caller (resolveFilerId) — never
    // recomputed here, so this insert can never disagree with the filers
    // row processTradeWithFiler already registered under filersToAdd.
    const assetName = assetNameFromCompetitorPayload(rawObj, tk);
    novelTrades.push({
      id: `${docId}-${tradeHash}`,
      docId,
      filerId,
      txDate: date,
      owner: null,
      assetName,
      ticker: tk,
      assetType: 'stock', // Fallback
      txType: type === 'buy' ? 'B' : type === 'sell' ? 'S' : 'E',
      amountMin: null,
      amountMax: null,
      isOption: false,
      capGainsOver200: false,
      rawText: JSON.stringify(rawObj),
      assetTypeName: 'Stock',
      filingStatus: 'New',
      subholding: null,
      location: null,
      description: `Injected from ${provider}`,
      supplementalText: null,
      rowKey: tradeHash,
      confidence: 0,
      source: 'competitor_backfill',
      createdAt: nowStr,
      // cursor_seq is assigned by the DB trigger; persistTransactions() binds NULL.
      cursorSeq: 0,
      firstSeenAt: nowStr,
      filedDate: null,
    });
    novelSet.add(exactKey);
  }

  // Before looping over competitors, create a set of seen filers to add if missing
  const filersToAdd = new Map<string, { id: string, name: string, chamber: string }>();

  // Live, non-tombstoned filers: the identities a competitor row must attach to
  // instead of minting a second one (board rows 2c0b428c / 591011b9).
  const existingFilers: ExistingFilerCandidate[] = (
    await env.DB.prepare(
      "SELECT bioguide_id, full_name, display_name, chamber, state, resolved_bioguide_id FROM filers WHERE merged_into IS NULL",
    ).all<{
      bioguide_id: string; full_name: string | null; display_name: string | null;
      chamber: string | null; state: string | null; resolved_bioguide_id: string | null;
    }>()
  ).results.map((f) => ({
    filerId: f.bioguide_id,
    fullName: f.full_name,
    displayName: f.display_name,
    chamber: f.chamber,
    state: f.state,
    resolvedBioguideId: f.resolved_bioguide_id,
  }));
  let refusedBareName = 0;

  /**
   * Ingest identity guard.  History: the original injector resolved filers by
   * LAST NAME ONLY (`MANUAL-${lastName}`), which collided Rep. Mike Collins
   * GA-10 with Sen. Susan M. Collins ME, fused two different "Delaney"s into
   * one MANUAL-DELANEY, and left MANUAL-ELVIRA / MANUAL-BURGUM / MANUAL-WRIGHT
   * beside the real Salazar and EXEC-* filers.  Order now:
   *   1. a curated EXEC-* alias (full-name match only);
   *   2. an EXISTING real filer the payload's reporter names — first+last name
   *      (diminutive-aware), payload bioguide id, with a known state/chamber
   *      conflict a hard miss and an ambiguous match a miss
   *      (shared/competitorFilerMatch.ts);
   *   3. a real `house-<state><district>-<slug>` id when the payload carries
   *      office metadata;
   *   4. a first-name-qualified `MANUAL-<FIRST>-<LAST>` id;
   *   5. otherwise REFUSE (null): a bare surname never mints a filer.
   * See admin/competitorAttributionRepair.ts for the repair of rows already
   * poisoned by the old behavior.
   */
  function resolveFilerId(
    rawName: string,
    chamber: 'house' | 'senate' | 'executive',
    rawObj: any,
  ): { filerId: string; resolvedChamber: 'house' | 'senate' | 'executive' } | null {
    const execId = resolveExecutiveFilerIdFromName(rawName);
    if (execId) return { filerId: execId, resolvedChamber: 'executive' };

    const parsed = parseCompetitorReporter(rawObj);
    const existing = findExistingFilerForCompetitorReporter({
      names: [...competitorReporterNames(rawObj), rawName],
      chamber: parsed.chamber,
      state: parsed.state,
      bioguideId: parsed.bioguideId,
      candidates: existingFilers,
    });
    if (existing) {
      const existingChamber = (existing.chamber ?? '').toLowerCase();
      const resolvedChamber = existingChamber === 'house' || existingChamber === 'senate' || existingChamber === 'executive'
        ? existingChamber
        : (parsed.chamber ?? chamber);
      return { filerId: existing.filerId, resolvedChamber };
    }

    if (parsed.state && parsed.district) {
      const houseId = competitorHouseFilerId(rawName, parsed.state, parsed.district);
      if (houseId) return { filerId: houseId, resolvedChamber: 'house' };
    }

    // Only a payload-declared chamber is trusted here; the provider default is
    // NOT — that is how executives ended up labelled 'senate'.
    const resolvedChamber = parsed.chamber ?? chamber;
    const qualified = competitorQualifiedManualFilerId(rawName);
    if (!qualified) return null;
    return { filerId: qualified, resolvedChamber };
  }

  function processTradeWithFiler(provider: string, rawName: string, chamber: 'house' | 'senate' | 'executive', ticker: string, date: string, typeStr: string, rawObj: any) {
    const resolved = resolveFilerId(rawName, chamber, rawObj);
    if (!resolved) {
      refusedBareName += 1;
      return;
    }
    const { filerId, resolvedChamber } = resolved;
    filersToAdd.set(filerId, { id: filerId, name: rawName, chamber: resolvedChamber });
    processTrade(provider, rawName, resolvedChamber, ticker, date, typeStr, rawObj, filerId);
  }

  // unusual whales
  for (const t of uwTrades) {
    const name = t.name || t.reporter || t.politician_name;
    if (name) {
      processTradeWithFiler('uw', name, t.member_type || 'house', t.ticker, t.transaction_date, t.txn_type || t.type || t.transaction_type || 'buy', t);
    }
  }

  // quiver
  for (const t of qqTrades) {
    if (t.Representative) {
      // Quiver's `House` field reads 'Representatives' | 'Senate'; the old `=== 'House'`
      // test never matched, so every Representative defaulted to 'senate'.
      processTradeWithFiler('quiver', t.Representative, chamberFromMemberType(t.House) === 'senate' ? 'senate' : 'house', t.Ticker, t.TransactionDate, t.Transaction, t);
    }
  }

  // FMP
  for (const t of fmpHouse) processTradeWithFiler('fmp', `${t.firstName} ${t.lastName}`, 'house', t.symbol, t.transactionDate, t.type, t);
  for (const t of fmpSenate) processTradeWithFiler('fmp', `${t.firstName} ${t.lastName}`, 'senate', t.symbol, t.transactionDate, t.type, t);
  
  // Trump trades
  for (const t of trumpTrades) {
    const name = t.Representative || t.politician || 'Donald Trump';
    const ticker = t.Ticker || t.ticker;
    const date = t.TransactionDate || (t.traded ? t.traded.split(' ')[0] : null);
    const typeStr = t.Transaction || t.transaction;
    if (date && ticker) {
      processTradeWithFiler('quiver_trump', name, 'executive', ticker, date, typeStr, t);
    }
  }
  
  console.log(`Found ${novelTrades.length} novel trades across all competitor datasets.`);
  if (refusedBareName > 0) {
    console.warn(`Refused ${refusedBareName} rows whose reporter is a bare surname (no filer minted from a last name alone).`);
  }

  console.log("Inserting required filers...");
  for (const f of filersToAdd.values()) {
    await env.DB.prepare(
      `INSERT INTO filers (bioguide_id, full_name, chamber) 
       VALUES (?, ?, ?)
       ON CONFLICT (bioguide_id) DO NOTHING`
    ).bind(f.id, f.name, f.chamber).run();
  }

  // Batch insert
  const CHUNK_SIZE = 100;
  for (let i = 0; i < novelTrades.length; i += CHUNK_SIZE) {
    const chunk = novelTrades.slice(i, i + CHUNK_SIZE);
    console.log(`Inserting chunk ${Math.floor(i / CHUNK_SIZE) + 1} of ${Math.ceil(novelTrades.length / CHUNK_SIZE)}...`);
    const insertedIds = await persistTransactions(env, chunk);
    console.log(`Inserted ${insertedIds.length} rows.`);
  }

  console.log("Backfill complete!");
}

run().catch(console.error);
