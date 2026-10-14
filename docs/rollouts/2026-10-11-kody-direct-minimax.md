# Kody Direct MiniMax Endpoint

## Summary

Owner correction for CTS-330: use MiniMax’s direct OpenAI-compatible API instead of Vercel AI Gateway.  The inline workflow selects `MiniMax-M3` at `https://api.minimax.io/v1` with `MINIMAX_API_KEY` and pins a trusted helper that accepts the native endpoint and response format.

## Files Changed

- `.github/workflows/kody-fleet-autofix.yml`: endpoint, model identifier, key source, and immutable helper references.
- `STATUS.md`: current provider and verification status.
- `docs/rollouts/2026-10-11-kody-direct-minimax.md`: this decision record.

## Verification

A synthetic live request using the pinned compatibility helper authenticated against `https://api.minimax.io/v1/chat/completions`, returned an edit, and applied it successfully.  Seventy-one shared helper and generator tests passed, including response validation.  Scoped actionlint and `git diff --check` validate this caller before push.  Hosted checks and current-head Codex review gate merge.

## Follow-ups

This provider change preserves the existing gates, profile, source paths, budget, shared per-PR concurrency, and draft-proposal behavior.  Production Kody execution remains tracked separately in CTS-326; a synthetic request is not proof of a production proposal.

## Native M3 Answer Mode

The helper pin `b1503884e547a8fb5d1449a94e03cae8c496da4c` disables thinking for native `MiniMax-M3`, using the documented API mode to avoid upstream MiniMax-M3 issue 28, where reasoning boundaries can truncate the answer.  A live synthetic edit canary passed against this exact revision; all 71 offline helper tests passed.  The model, endpoint, key, source scope, and budget stay unchanged.
