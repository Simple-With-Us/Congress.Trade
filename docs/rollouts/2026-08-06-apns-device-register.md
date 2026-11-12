# Rollout: APNs device registration (`register_device`)

**Date:** 2026-08-06  
**Branch:** `grok/apns-device-register`  
**Owner:** GROK

## Summary

iOS was failing push-token registration with:

- `delivery must be 'sse' or 'webhook'`
- `Command is still running…` (async command flood + poll timeout)

Root cause: `PushNotificationManager` called `create_subscription` with
`delivery: "apns"`, which the backend never accepted. Each refresh also used a
fresh UUID idempotency key, flooding the command queue.

### Fix

1. New table `push_devices` (migration `0076`) — separate from webhook/SSE
   subscription quota.
2. Commands `register_device` / `unregister_device`.
3. Legacy rewrite: `create_subscription` + `delivery: "apns"` → `register_device`
   so older TestFlight builds work after backend deploy alone.
4. iOS: `registerDevice`, stable idempotency key per token, skip re-sync when
   already registered, Settings status/Sync control.

## Files changed

- `app/migrations/0076_push_devices.sql`
- `app/src/client/pushDevices.ts`, `commands.ts`, `admin/migrations.ts`
- `clients/ios/.../PushNotificationManager.swift`, `APIClient.swift`, Settings
- `app/docs/client-mobile-api.md`

## Verification

- `cd app && npm run typecheck`
- `cd app && npm test -- src/client/__tests__/routes.test.ts src/admin/__tests__/migrations.test.ts`
- iOS simulator: `xcodebuild … BUILD SUCCEEDED`
- After prod migrate: signed-in iOS refresh should log no
  `delivery must be 'sse' or 'webhook'`; Settings shows “Device registered”.

## Follow-ups

- Actual APNs HTTP/2 trade fan-out (needs Apple `.p8` + team/key id in secrets).
- Alert rules UI / quiet hours (issue #1046 remainder).
- Free vs Premium push policy for fan-out (registration is signed-in only today).
