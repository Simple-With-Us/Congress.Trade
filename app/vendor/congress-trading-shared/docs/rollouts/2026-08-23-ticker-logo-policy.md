# 2026-08-23 tickerLogoPolicy shared module

## Summary
Add `src/tickerLogoPolicy.ts` so Congress.Trade and Socratic.Trade share A/B/C/D company-logo source order.  Serving, disk/KV cache, and the admin jury stay in each app.

## Why
Owner grades are product-agnostic.  Duplicating the seed map in two apps would drift.

## Files
- `src/tickerLogoPolicy.ts`
- `src/__tests__/tickerLogoPolicy.test.ts`
- `src/index.ts`
- `package.json` (2.6.0)
- `CHANGELOG.md`

## Verify
```
npm test -- src/__tests__/tickerLogoPolicy.test.ts
npm run typecheck
```

## Follow-ups
Tag `v2.6.0` after merge.  Congress.Trade vendors the module.  Socratic.Trade pins the tag and walks `sourceOrderFor` with `SOCRATIC_DEFAULT_LOGO_SOURCE_ORDER`.
