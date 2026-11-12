import type { Env } from '../shared/types.ts';
import { fetchHouseIndex } from './houseSource.ts';
import { run, all } from '../shared/db.ts';
import { notifyAdmin } from '../alerts/notify.ts';
import { insertFilingIfNew } from './watcher.ts';

export async function runHouseReconciler(env: Env, now: Date): Promise<void> {
  const year = Number(
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric' }).format(now),
  );
  
  const bulkFilings = (await fetchHouseIndex(year, {
    relayUrl: env.HOUSE_RELAY_URL || env.INGEST_RELAY_URL,
  })).filter((f) => f.isPtr);
  const bulkByDocId = new Map(bulkFilings.map((f) => [f.pipelineDocId, f]));

  // Fetch all house filings from the DB for this year
  const dbFilings = (await all(
    env.DB,
    `SELECT doc_id, filed_date, source_url, ingest_status 
     FROM filings 
     WHERE chamber = 'house' AND doc_id LIKE 'H-' || ? || '-%'`,
    [year.toString()]
  )) as Array<{ doc_id: string; filed_date: string; source_url: string; ingest_status: string }>;

  const dbByDocId = new Map(dbFilings.map((f) => [f.doc_id, f]));

  const orphaned: string[] = [];
  const mutated: string[] = [];
  const missed: string[] = [];

  // Check for orphaned and mutated
  for (const dbFiling of dbFilings) {
    const bulkFiling = bulkByDocId.get(dbFiling.doc_id);
    if (!bulkFiling) {
      // It is in DB but missing from the bulk XML index
      orphaned.push(dbFiling.doc_id);
    } else {
      // Check for mutations
      if (dbFiling.filed_date !== bulkFiling.filingDate || dbFiling.source_url !== bulkFiling.sourceUrl) {
        mutated.push(`${dbFiling.doc_id} (DB filed_date: ${dbFiling.filed_date}, XML: ${bulkFiling.filingDate} | DB url: ${dbFiling.source_url}, XML: ${bulkFiling.sourceUrl})`);
      }
    }
  }

  // Check for missed filings (including un-ingested phantoms stuck in not_found)
  for (const bulkFiling of bulkFilings) {
    const existing = dbByDocId.get(bulkFiling.pipelineDocId);
    if (!existing || existing.ingest_status === 'not_found') {
      missed.push(bulkFiling.pipelineDocId);
      try {
        await insertFilingIfNew(env, {
          docId: bulkFiling.pipelineDocId,
          chamber: 'house',
          filerId: null,
          filerName: `${bulkFiling.first} ${bulkFiling.last}`.trim(),
          filingType: 'P',
          filedDate: bulkFiling.filingDate,
          sourceUrl: bulkFiling.sourceUrl,
          docKind: 'text_pdf',
        }, now.toISOString());
      } catch (err) {
        console.warn('houseReconciler: auto-recovery insert failed for', bulkFiling.pipelineDocId, err);
      }
    }
  }

  if (orphaned.length === 0 && mutated.length === 0 && missed.length === 0) {
    return;
  }

  // There are discrepancies! Log to dead_letter_events and notify admin.
  const issues: string[] = [];
  if (missed.length > 0) issues.push(`Missed: ${missed.length} filings (${missed.slice(0, 5).join(', ')}${missed.length > 5 ? ', ...' : ''})`);
  if (orphaned.length > 0) issues.push(`Orphaned: ${orphaned.length} filings (${orphaned.slice(0, 5).join(', ')}${orphaned.length > 5 ? ', ...' : ''})`);
  if (mutated.length > 0) issues.push(`Mutated: ${mutated.length} filings (${mutated.slice(0, 5).join(', ')}${mutated.length > 5 ? ', ...' : ''})`);

  const errorText = `House Reconciler found discrepancies:\n- ${issues.join('\n- ')}`;
  console.warn(errorText);

  try {
    await run(
      env.DB,
      `INSERT INTO dead_letter_events (queue, msg_type, doc_id, tx_id, attempts, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['house-reconciler', 'data-quality', null, null, 1, errorText.slice(0, 1000), new Date().toISOString()]
    );
  } catch (e) {
    console.warn('houseReconciler: D1 insert failed:', (e as Error).message);
  }

  try {
    await notifyAdmin(env, {
      subject: `Congress.Trade Data Quality: House Index Discrepancies`,
      text: `The nightly House Reconciler job found discrepancies between our database and the official bulk XML index for ${year}.\n\n${errorText}\n\nInvestigate whether these are live-search artifacts, true mutations, or ingestion failures.`,
      dedupeKey: `house-reconciler-${year}-${now.toISOString().slice(0, 10)}`,
      throttleSec: 86400, // Once a day
    });
  } catch (e) {
    console.warn('houseReconciler: alert failed:', (e as Error).message);
  }
}
