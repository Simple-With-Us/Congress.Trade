# Preview deployments (leftover Wrangler tooling)

This is **not** production.  The live site is Coolify `congress-app` at
[https://congress.trade](https://congress.trade).  These scripts still
provision an isolated Cloudflare Worker named `congress-trade-preview` for
optional review sandboxes.  Do not point them at the host SQLite file or
`congress.trade`.

The leftover preview stack is intentionally isolated:

- Worker: `congress-trade-preview` (sandbox only)
- Config: `app/wrangler.preview.toml` (generated locally, ignored by git)
- Database: `congress-feed-preview-db` (legacy backing-resource name)
- R2 bucket: `congress-feed-preview-raw` (legacy backing-resource name)
- Queues: `congress-feed-preview-*` (legacy backing-resource names)
- KV namespace: separate preview namespace
- No custom-domain route and no cron trigger by default

## First-time setup

```bash
cd app
npm run preview:provision
```

This creates preview Cloudflare resources, writes `wrangler.preview.toml`, applies
D1 migrations, and seeds a tiny fixture dataset so the public feed, search,
drawers, and Pelosi option rows are visible even before real preview ingestion is
configured. `npm run preview:deploy` also runs this automatically when
`wrangler.preview.toml` is missing.

## Deploy the current checkout

```bash
cd app
npm run preview:deploy
```

The deploy script runs `npm run typecheck`, `npm test`, then:

```bash
npx wrangler deploy --config wrangler.preview.toml
```

Wrangler prints the `workers.dev` URL after a successful deploy:

```text
https://congress-trade-preview.jaywedgeworth22.workers.dev
```

Use that URL to review branch work. Do not use `npm run deploy`,
`npm run deploy:full`, or `scripts/ship.sh` for preview; those target
production.

## Optional custom domain

If you want a stable URL like `preview.congress.trade`, add a route to the
generated `wrangler.preview.toml` only after the preview Worker is working:

```toml
routes = [
  { pattern = "preview.congress.trade", custom_domain = true }
]
workers_dev = true
```

Keep that in the ignored preview config unless the team decides to commit a
first-class staging environment with permanent resource IDs.

## Merge policy

Preview deploys are for review.  Merging to `main` rebuilds Coolify
`congress-app`; production migrations are not automatic.  Before merging,
run:

```bash
cd app
npm run typecheck
npm test
```

Apply production schema changes through `npm run deploy:full` / `scripts/ship.sh`
or `POST /api/admin/migrate` against `https://congress.trade`.  Do not use
remote Wrangler D1 migrations against the live host.
