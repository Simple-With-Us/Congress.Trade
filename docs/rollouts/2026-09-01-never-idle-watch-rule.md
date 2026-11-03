# 2026-09-01 — Codify "Never idle-watch a PR" as a binding fleet rule

## Context & Objective

Owner ruling, 2026-09-01: agents "should never just wait and watch for things to merge
since that wastes tokens/time and they inevitably almost invariably end up slowly wasting
money/quota while the PR sits there with conflicts or comments/issues unresolved."

The recurring failure this closes: a seat opens a PR, then burns turns polling it, while
the actual blocker is something nobody acted on — an unresolved `chatgpt-codex-connector`
thread, a conflict, a never-dispatched check, or auto-merge that was never armed.  It is
the missing second half of "always commit + land finished work" already in this file's
Branch And Worktree Policy: landing work means *driving* it to merge, never watching it.

## Changes Made

Docs/rules only.  No app code, no schema, no deploy.

This repo:

- `AGENTS.md` — new `## Never Idle-Watch A PR (owner ruling 2026-09-01)` section, placed at
  the end of Branch And Worktree Policy where the existing PR-inspection commands live.
  `CLAUDE.md` is a separate file here (not a symlink, unlike Socratic.Trade) but it already
  names `AGENTS.md` as the source of truth, so it needs no duplicate copy.
- `docs/EFFORT-LOG.md` — effort row (mirrored to the live board
  `/Users/jay/apps/CONGRESS-TRADE-EFFORT-LOG.md`).
- `docs/rollouts/2026-09-01-never-idle-watch-rule.md` — this note.

Outside this repo, the same rule in each file's own voice:

- `/Users/jay/apps/AG***-S**C.md` — canonical `## Never idle-watch a PR` section, placed
  right after `## Merge requirements`.  Everything else cross-references it.
- `/Users/jay/Code/ai-fleet-coordinator/AG***-S**C.md` — same section, landed by PR so the
  tracked GitHub copy does not drift from the live file.
- `/Users/jay/.claude/CLAUDE.md` — stanza beside "Always commit + land finished work".
- `Socratic.Trade` and `Usage-Monitor` `AGENTS.md`.

## Decisions & Trade-offs

- **Canonical home is AG***-S**C.md**, but each repo restates the rule in full enough form
  to act on without a second lookup.  An agent that has loaded only this repo's `AGENTS.md`
  must still get the whole behavior, so link-only was rejected.
- **Bounded waits stay legal.**  The rule bans idle-polling and the *second* wait, not
  waiting as such: one `gh pr checks <n> --watch` is explicitly allowed.  Framing it as "a
  PR is waiting on an ACTION — here are the causes and the fix for each" gives the agent
  something to do instead of a bare prohibition.
- **The conflict remedy is worded to match this repo's existing rule** that branches must
  be merged/rebased with `main` before verification and merge, rather than inventing a
  second convention.
- Not machine-enforceable — no lint or CI gate can detect idle polling.  Same class of
  behavioral rule as "always commit + land finished work".

## Verification State

Docs-only.  Repo gate run from `app/`:

```bash
npm run typecheck   # deno check src/deno/main.ts
npm test            # vitest run
```

No migration, no `bash app/scripts/ship.sh`, no production change.

## Next Steps & Blockers

None.  Sibling changes land on their own paths: two live files edited in place, three repo
PRs (this one, Socratic.Trade, Usage-Monitor) plus the ai-fleet-coordinator mirror.
