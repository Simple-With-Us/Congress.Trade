/**
 * Idempotent repair for competitor-minted MANUAL-* filers whose chamber was
 * guessed at ingest time (mostly `senate`).  Runs enrichment/identitySync.ts
 * against the configured Turso/SQLite database — the same planner production
 * uses on the daily filer lane.
 *
 * Usage (from app/):
 *   deno run -A scripts/fix-manual-chamber.ts [--dry-run]
 */
import { createClient } from "npm:@libsql/client/web";
import { load } from "https://deno.land/std@0.224.0/dotenv/mod.ts";
import { D1DatabaseShim } from "../src/deno/shims.ts";
import { resolveSecret } from "../src/secrets/infisical.ts";
import { runIdentitySync } from "../src/enrichment/identitySync.ts";
import type { Env } from "../src/shared/types.ts";

async function getEnv(): Promise<Env> {
  const envVars = await load({ envPath: ".dev.vars", export: true });
  for (const [k, v] of Object.entries(envVars)) {
    Deno.env.set(k, v);
  }
  const mockEnv = envVars as unknown as Env;
  const tursoUrl = (await resolveSecret(mockEnv, "TURSO_DATABASE_URL")).value;
  const tursoToken = (await resolveSecret(mockEnv, "TURSO_AUTH_TOKEN")).value;
  if (!tursoUrl) throw new Error("Could not resolve TURSO_DATABASE_URL");
  const libsqlClient = createClient({ url: tursoUrl, authToken: tursoToken });
  return { DB: new D1DatabaseShim(libsqlClient) } as unknown as Env;
}

const dryRun = Deno.args.includes("--dry-run");

const env = await getEnv();
const result = await runIdentitySync(env, { dryRun });

console.log(
  JSON.stringify(
    {
      dryRun,
      filersScanned: result.filersScanned,
      chambersCorrected: result.chambersCorrected,
      bioguideResolved: result.bioguideResolved,
      staleResolutionsFixed: result.staleResolutionsFixed,
      sample: result.sample ?? undefined,
    },
    null,
    2,
  ),
);
