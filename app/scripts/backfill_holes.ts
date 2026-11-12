import { load } from "https://deno.land/std@0.224.0/dotenv/mod.ts";
import { createClient } from "npm:@libsql/client";
import { assetNameFromCompetitorPayload } from "../src/shared/executiveIdentity.ts";
import { assignCompetitorFilerId, type ExistingFilerCandidate } from "../src/shared/competitorFilerMatch.ts";

function mapTxType(raw: string | undefined): "P" | "S" | "E" {
  const t = (raw ?? "").toLowerCase();
  if (t.includes("exchange")) return "E";
  if (t.includes("sale") || t.includes("sell")) return "S";
  return "P";
}

function filerIdForHole(
  h: { lastName?: string; name?: string; fullName?: string; raw?: { name?: string } },
  candidates: readonly ExistingFilerCandidate[],
): string | null {
  const full =
    h.fullName ||
    h.name ||
    (h.raw && typeof h.raw === "object" ? (h.raw as { name?: string }).name : "") ||
    "";
  // A bare last name never mints MANUAL-<LAST>. Attach to an existing filer
  // or a first+last id, or skip the row.
  const name = full || h.lastName || "";
  return assignCompetitorFilerId({ rawName: name, candidates })?.filerId ?? null;
}

async function main() {
  const env = await load({ envPath: "/Users/jay/Code/Congress.Trade/app/.prod.vars" });
  const client = createClient({
    url: env.TURSO_DATABASE_URL || env.TURSO_URL || "",
    authToken: env.TURSO_AUTH_TOKEN || "",
  });

  const holesJson = await Deno.readTextFile(
    "/Users/jay/.gemini/antigravity/brain/46787371-bd2d-4703-a05d-cf01380534f5/data_holes.json",
  );
  const holes = JSON.parse(holesJson);

  console.log(`Loaded ${holes.length} missing trades.`);

  const filerRows = await client.execute(
    "SELECT bioguide_id, full_name, chamber, state, resolved_bioguide_id FROM filers WHERE merged_into IS NULL",
  );
  const candidates: ExistingFilerCandidate[] = filerRows.rows.map((row) => {
    const r = row as Record<string, unknown>;
    return {
      filerId: String(r.bioguide_id ?? ""),
      fullName: typeof r.full_name === "string" ? r.full_name : null,
      chamber: typeof r.chamber === "string" ? r.chamber : null,
      state: typeof r.state === "string" ? r.state : null,
      resolvedBioguideId: typeof r.resolved_bioguide_id === "string" ? r.resolved_bioguide_id : null,
    };
  }).filter((c) => c.filerId);

  const txBatch = [];
  let skippedBareName = 0;

  for (const h of holes) {
    const filerId = filerIdForHole(h, candidates);
    if (!filerId) {
      skippedBareName += 1;
      continue;
    }
    const txType = mapTxType(h.type);
    const assetName = assetNameFromCompetitorPayload(h.raw ?? h, h.ticker);
    const ticker = h.ticker && String(h.ticker).toUpperCase() !== "UNKNOWN" ? h.ticker : null;

    const docId = `COMPETITOR-${h.provider}-${crypto.randomUUID()}`;
    const id = crypto.randomUUID();

    txBatch.push({
      sql: `INSERT OR IGNORE INTO transactions (
        id, doc_id, filer_id, tx_date, owner, asset_name, ticker, asset_type, tx_type, amount_min, amount_max, is_option, cap_gains_over_200, raw_text, source, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        docId,
        filerId,
        h.date,
        "unknown",
        assetName,
        ticker,
        "stock",
        txType,
        1001,
        15000,
        0,
        0,
        JSON.stringify(h.raw ?? h),
        "competitor_backfill",
        new Date().toISOString(),
      ],
    });
  }

  if (skippedBareName > 0) {
    console.warn(`Skipped ${skippedBareName} rows whose reporter is a bare surname.`);
  }
  console.log(`Executing ${txBatch.length} insertions...`);

  let successCount = 0;
  for (let i = 0; i < txBatch.length; i += 100) {
    const chunk = txBatch.slice(i, i + 100);
    await client.batch(chunk, "write");
    successCount += chunk.length;
    console.log(`Inserted ${successCount} / ${txBatch.length}`);
  }

  console.log("Backfill complete.");
}

main().catch(console.error);
