# Congress.Trade Local Vision Worker (macOS)

Runs `worker.py` on the Mac under `pm2` (`~/vision-worker`, started by
`~/Code/AI-Fleet-Coordinator/scripts/pm2-ecosystem.config.cjs`). It polls
`/api/admin/pending-local-vision`, transcribes scanned PDF filings locally via
`grok -p` (plus optional OpenRouter vision cascade), and uploads extracted
transactions to `/api/admin/ingest-local-vision`.

## Secrets (Infisical sole source of truth)

`run-vision-worker.sh` invokes `launch_with_infisical.py`, which strips any
ambient secret / `INFISICAL_*` env vars, discovers the project ID from the
scoped service token's own Infisical metadata, and fetches secrets directly from
Infisical (`congress-trade`, environment `prod`, path `/`, imports expanded).
There is no `fleet-secrets` dependency and no environment fallback.

Token custody order:

1. Explicit `--token-file <path>` (or `VISION_WORKER_INFISICAL_TOKEN_FILE`
   pointing to a `0600` file owned by your user in a `0700` directory).
2. macOS Login Keychain entry: service `infisical-service-token`, account
   `vision-worker-ct-ro`.
3. Non-GUI fallback for headless `pm2` sessions where the Login Keychain is
   unreachable: `0600` file `~/.config/infisical/tokens/vision-worker-ct-ro.token`
   inside a `0700` directory.

Mint the read-only scoped token in Infisical (project `congress-trade`, env
`prod`, path `/`), record its metadata in the Fleet References Google Sheet
(`Infisical Service Tokens` tab), store it in the Mac Login Keychain (and the
`0600` fallback file if `pm2` runs outside GUI Keychain access), and run:

```bash
./install-mac.sh
```

Required Infisical secret: `ADMIN_TOKEN` (or `CT_ADMIN_TOKEN`). Optional:
`OPENROUTER_API_KEY` (or `CT_OPENROUTER_API_KEY`), `PUSHOVER_APP_TOKEN`,
`PUSHOVER_USER_KEY`.

## Manual test / status

```bash
# Run offline unit tests for the Infisical launcher:
python3 -m unittest discover -s services/vision-worker/tests -t services/vision-worker

# Verify token custody and Infisical secret resolution without starting worker.py:
~/vision-worker/run-vision-worker.sh --check
```
