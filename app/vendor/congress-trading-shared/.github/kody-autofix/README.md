# Kody fix proposal workflow

This is separate infrastructure from the existing Codex autofix workflow.  It produces a draft proposal for a current, human-authored, same-repository PR after a verified successful Kody check.  It never merges the proposal or updates the source PR branch.  Keep both setup PRs and generated proposals in draft.  The existing shared-repository auto-merge workflow skips drafts and does not arm auto-merge.

## Disabled setup is the default

The caller generator is offline and writes only YAML to standard output.  It does not read repository inventory, contact GitHub, create an environment, install a credential, or change a variable.

Generate a caller with a reviewed repository ID, source profile, source scopes, and the exact commit containing the shared reusable workflow:

```sh
node .github/kody-autofix/generate-caller.mjs \
  --repository-id 123456789 \
  --profile web \
  --source-prefixes '["src/","server/"]' \
  --shared-sha "$VERIFIED_WORKFLOW_COMMIT" \
  > /tmp/kody-autofix.yml
```

Supported profiles are `web`, `swift`, `python`, `static`, and `blocked`.  Source scopes are a JSON array of up to eight normalized directory prefixes ending in `/` or exact source filenames.  Exact files must be eligible for the selected profile, for example `index.html` for `static` or `catalog.py` for `python`.  The `blocked` profile can use `[]` and cannot authorize paid attempts.  Configuration-only, policy, package-distribution, and unsupported repositories must stay blocked until separately reviewed.

A generated caller has `daily_attempt_limit: 0` and `budget_policy_id: pending`.  Both the caller and shared workflow require `SWU_KODY_AUTOFIX_ENABLED` to equal the string `true`; a missing variable is disabled.  The controller independently fails closed when the allocation is zero or pending.  Merging a disabled caller alone does not enable paid work.

Generating a positive allocation requires all of `--daily-attempt-limit` (1–5), `--budget-policy-id` (`approved-` followed by 1–64 letters, digits, underscores, or hyphens), and `--acknowledge-paid-attempts`.  These flags record an already approved allocation; they are not approval by themselves and still do not enable the repository variable.  Owner approval of budget allocations and activation remains necessary.

The quota is a real per-repository UTC-day attempt-slot limit, not an organization-wide or dollar-denominated cap.  Dollar cost can vary.  A fleet-wide dollar guarantee requires separately approved allocation and enforcement, and this setup does not claim one.

## Trust and secret boundaries

The shared workflow accepts only `workflow_call`, and generated callers accept only `check_run.completed`.  Both require app ID `413034`, sender bot ID `148880201`, sender login `kody-ai[bot]`, a successful conclusion, and one linked PR.  The controller re-fetches the check and PR and enforces identity, repository, exact head, and eligible unresolved findings.  Re-runs are rejected.

Every job checks out only the public shared helper repository at one immutable helper commit, with checkout credentials persistence disabled.  It never checks out or executes the target PR.  The helper revision is fixed independently when the reusable workflow is published.  The caller's shared-workflow pin and the reusable workflow's helper pin are distinct: publish the helper commit first, then pin it in the reusable workflow, then generate callers against the commit containing that workflow.

Jobs have separate privileges:

1. `prepare` has read-only contents, PR, and check access and creates a bounded snapshot.
2. `reserve` has contents write plus read access and creates durable attempt and daily-slot refs.  The controller only creates these refs; it does not update or delete reservations.
3. `generate` has read-only contents/artifact access and the protected `kody-autofix` environment.  A pinned scanner checks context before the provider key is injected into the generation step.  Generation is one bounded chat-completions request from the trusted helper: no CLI, no tools, no proxy, a byte-capped response, and only `applyEdits` plus the answer scan decide whether anything is used.  A separate key-free scanner step checks generated output before it is uploaded.
4. `publish` has contents and PR write plus read access, revalidates the snapshot and scanner proof, then creates a fresh branch and draft PR.
5. `meter` has only `actions: read`, no provider key and no environment.  It downloads `usage.json` (token counts and a model id, written by `generate` from the provider's own usage block even when the answer is later rejected) and posts one Usage Monitor event through the pinned `ci-usage-report` action.  It is best-effort:  without the optional `USAGE_INGEST_TOKEN` secret, or without a usage file, it does nothing, and it cannot fail the run.  Callers forward the secret explicitly, like `MODEL_API_KEY`.

The provider is MiniMax M3 through MiniMax's OpenAI-compatible chat completions (`https://api.minimax.io/v1`, default model `MiniMax-M3`).  The reusable workflow declares one callable secret, `MODEL_API_KEY`, which each caller forwards explicitly from the organization secret `MINIMAX_API_KEY`; it uses no `secrets: inherit` and no PAT.  The `kody-autofix` environment stays on the generation job as a `main`-only branch gate, and holds no secret of its own, so the forwarded key is what reaches the step.  That environment is defined on `Simple-With-Us/congress-trading-shared` (the reusable workflow host); callers inherit it, and GitHub auto-creates a missing environment with zero protection rules, which would make the spend gate inert (CTS-326).  Jay must pre-provision `kody-autofix` on the host repo with deployment protection (for example the `main` branch policy); there is no valid `GITHUB_TOKEN` permission scope for a prepare-job Environments API probe inside a reusable workflow called from fleet repos.  The reusable workflow therefore requires `MODEL_API_KEY` at `workflow_call` and fails the generation job when the forwarded credential is empty before any provider work.  The helper accepts only reviewed base URLs, because the key is sent wherever the URL points, and model identifiers that match a strict pattern.  The provider credential is present only on the generation step; GitHub credentials are not passed into that step.

The caller generator retains explicit model and base URL options; defaults select MiniMax M3 and use the matching MiniMax API key.

The 15-minute reservation lifetime and UTC day are checked before every upstream model request.  Environment approval delays can therefore consume a reservation without spending on generation.  Failed, cancelled, expired, or ambiguous attempts remain consumed; there is no automatic retry or reservation reclamation.

Artifacts are named for the workflow run and attempt, downloaded only by exact name into `runner.temp`, and retained for one day.  Source and finding snapshots may contain private code, so repository Actions access also controls access to this short-lived material.  No target repository inventory belongs in this public shared directory.

## Fixed dependencies and verification

Action commit pins are copied from the existing reviewed pilot.  Gitleaks is pinned to `8.30.1`; the Linux x64 archive SHA-256 is `551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb`, verified against the [official release checksum file](https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_checksums.txt).  Archive verification happens before extraction.  Scanner configuration comes from the trusted helper rather than the target repository.

Run offline tests with stock Node.js:

```sh
node --test .github/kody-autofix/*.node-test.mjs
```

The generator tests cover default-off behavior, explicit allocation acknowledgement, profile/file scopes, hostile input rejection, action and helper pinning, event identity filters, privilege separation, scanner order, artifact handling, and distinct concurrency keys.  The caller-level group `pr-autofix-<owner/repo>-<PR number>` without cancellation is shared with the fleet's other PR autofix callers, so only one autofix runs per PR at a time.  They make no GitHub or paid provider calls.  The dedicated `kody-autofix-validation.yml` runs only these offline tests on relevant pull-request and push path changes, using Node 24 and a read-only token.  It never contacts a model provider; provider calls are exercised only through injected fetch mocks.

Generated proposals target the original feature branch.  In repositories whose PR checks use a `main` base-branch filter, those checks may not run for the generated child PR.  GitHub documents that a `GITHUB_TOKEN`-created PR can create approval-required workflow runs, while normal token pushes do not trigger workflows.  A human must approve those runs when requested.  Missing checks therefore do not mean validation passed; a human must arrange the repository's secret-free checks before adopting the patch.

A successful offline test run does not establish that protected environments, secret placement, repository Actions settings, live Kody event behavior, or paid generation are configured correctly.

## Operational Limits

The owner approved activation fleet wide on 2026-10-11 (boards 04b963b7 and 99e559ea): every active repository gets a caller with `daily_attempt_limit: 5` and `budget_policy_id: approved-owner-2026-10-11`, a `kody-autofix` environment limited to the `main` deployment branch, and the organization variable `SWU_KODY_AUTOFIX_ENABLED`.  The environment branch policy is a branch gate, not a human-approval gate.  The same day the owner moved the provider from DeepSeek to Muse Spark on Vercel AI Gateway, using the existing organization secret.

The helper pin must point at a commit on `main` that contains `package.json` and `package-lock.json`, because every job runs `npm ci` in the helper directory.  The first pin was a pre-squash branch commit without them, so `npm ci` would have failed before any work.  Each attempt is one request with bounded context and at most 16,384 output tokens; the per-repository daily slot limit does not guarantee a dollar cap.  Aggregate organization spending requires approved allocations and a separately verified budget mechanism before enabling any repository.

Source-name filters and secret scanners are defensive checks, not proof that arbitrary business logic contains no sensitive data.  Review exact repository scopes before activation.  Existing same-branch auto-fixers must be retired or kept excluded from activation to prevent competing writers.  New proposals remain draft and unverified; review-thread resolution is always left to a person.

Coordination state and existing effort records were not changed in this isolated implementation lane.  Required coordination remains an activation prerequisite.  The legacy reusable workflow and package runtime/build outputs are unchanged.

## Disabled fleet budget client follow-on (Usage Monitor #1602)

The new `budget.mjs` is integrated into the helper's generation entry point, but no workflow helper pin or environment delivery has been changed.  Existing callers remain disabled.  The generation entry point now also refuses to launch the CLI unless `SWU_KODY_FLEET_BUDGET_ENABLED` is exactly `true`, a dedicated trusted settlement token is present, and the configured monitor destination is exactly the owner's Usage Monitor fleet-budget API.  No value is configured by this change.  Infisical remains the source of truth; any approved delivery copies, credentials, protected environments, workflow repinning, and activation are separate owner steps.

Prospective generation-step names, never values: `SWU_KODY_FLEET_BUDGET_ENABLED`, `FLEET_BUDGET_URL`, `FLEET_BUDGET_TOKEN`, `DEEPSEEK_API_KEY`, and `MINIMAX_API_KEY`.  The token is privileged settlement authority, distinct from ordinary usage-ingest/read tokens.  It and both provider keys remain in the trusted parent process and never enter Claude's subprocess environment or output.  No new GitHub secret reference is added in this slice.

### Bound and evidence (checked 2026-10-07)

The fixed adapters are `deepseek-flash` on the DeepSeek Anthropic endpoint and `MiniMax-M3.1-Flash` on MiniMax's Anthropic endpoint, standard tier only.  The request is rebuilt from a text-only allowlist.  Only the existing `StructuredOutput` function schema is permitted; provider-hosted tools, media, MCP, extension fields, alternative models, and premium tiers fail closed.  All explicit cache hints are removed.  Every request enforces at most 4,096 generated tokens, including reasoning, and receives a separate durable reservation and one-shot dispatch permit.  There are no provider retries under one permit.

- [DeepSeek model metadata](https://api-docs.deepseek.com/api/list-models/) defines context as input plus output and documents 1,048,576 tokens for Flash.  [The completion API](https://api-docs.deepseek.com/api/create-chat-completion/) caps generation with `max_tokens` and includes reasoning within completion usage.  [Anthropic compatibility](https://api-docs.deepseek.com/guides/anthropic_api/) fully supports `max_tokens`; its `thinking.budget_tokens` is ignored, so that field is never treated as a spending limit.
- [DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing/) has peak and off-peak tariffs.  A future bound must use the peak tariff (currently $0.30/M uncached input, $0.006/M cache hit, $1.20/M output), not a seven-day off-peak assumption.  Whole-context input plus 4,096 output is $0.319488 at those rates.  These figures are dated evidence, not installed pricing or an activation promise.
- [MiniMax compatibility](https://platform.minimax.io/docs/api-reference/text-anthropic-api) documents M3.1-Flash's 1M context and says `max_tokens` includes thinking.  Priority is 1.5x standard, so the adapter forces standard.  [Passive caching](https://platform.minimax.io/docs/api-reference/text-prompt-caching) has no cache-write surcharge; [explicit caching](https://platform.minimax.io/docs/api-reference/anthropic-api-compatible-cache) does, so the latter is not allowed.  [Current pricing](https://platform.minimax.io/docs/pricing/overview) must be reverified before activation.

The current monitor protocol chooses a provider after receiving one input bound.  This client therefore deliberately reserves 1,048,576 input tokens for either provider, plus its enforced output cap.  Both provider *reservation ceilings* must allow this common conservative bound, even though MiniMax's physical model context is smaller; a lower configured ceiling safely rejects MiniMax admission.  This avoids under-reservation during routing changes without requiring speculative byte-to-token arithmetic.  It sacrifices utilization.  Future per-provider bounds could recover that utilization through a separately reviewed protocol change.

### Reconciliation and uncertainty

The client buffers a bounded complete provider response before returning it to the CLI, so it can validate terminal usage first.  JSON requires a terminal message; SSE requires one start, one final cumulative output update, and one terminal stop, with no conflicting input counters.  MiniMax's documented uncached-plus-cache-read partition maps to total input; explicit cache-write reports, absent counters, malformed or truncated streams, and unknown models remain uncertain.  DeepSeek's public Anthropic guide does not define cached-input counter composition, so this slice only settles explicit uncached reports; cached DeepSeek reports retain their full bound until that mapping is independently established.  Missing usage is never zero.  Estimates are server-priced producer-reported tokens, not verified bills; this client fabricates no provider-reported dollar figure.

Reservations use a deterministic run/snapshot/request identity.  Reserve and reconciliation retries reuse that identity; dispatch is attempted once.  An uncertain dispatch response never starts upstream work.  Cancellation is limited to a known reservation before any dispatch attempt.  Provider errors, response loss, process crash, failed settlement, or unknown usage leave durable liability in Usage Monitor.  The generation attempt stops after any uncertainty; it does not automatically try another provider.  Every separately attempted retry/fallback would need a new approved reservation and dispatch.

The server's lease is checked again immediately before upstream invocation.  The client requires a fresh HTTP Date within two seconds of its clock and leaves a three-second lease margin; skew or delayed approval fails closed.  Chicago-day and midnight enforcement remains in the server ledger.  No reservation is reclaimed merely because a local timeout elapsed.

Offline tests exercise request bounds, model/host/tier restrictions, default-off behavior, credential isolation, cached/unknown usage, overrun preservation, duplicate/restarted identities, lost reserve/dispatch/settlement replies, clock/lease failure and response-size limits.  The real Claude Code 2.1.289 fixture passed against this revised helper using checksum-verified Gitleaks 8.30.1 and one in-memory synthetic provider request.  The CLI emits context_management; the gateway explicitly discards that field rather than forwarding it.  No live provider or monitor call is necessary for those tests.  Existing native Kodus reviews are outside this autofix gateway and are not capped by this work.
