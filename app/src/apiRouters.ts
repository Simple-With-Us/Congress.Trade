/**
 * Single production router assembly. index.ts is the HTTP entry; this is the
 * only place feature routers are mounted so a second copy (the old app.ts)
 * cannot silently omit a money-path route.
 */
import { Hono } from 'hono';
import type { Env } from './shared/types.ts';
import { buildRestRouter } from './delivery/rest.ts';
import { buildAdminRouter } from './admin/routes.ts';
import { buildAnalyticsRouter } from './analytics/routes.ts';
import { buildAuthRouter } from './auth/routes.ts';
import { buildBillingRouter } from './billing/routes.ts';
import { buildAppleWebhookRouter } from './billing/appleWebhook.ts';
import { buildClientRouter } from './client/routes.ts';
import { buildExportRouter } from './export/routes.ts';
import { buildUiRouter } from './ui/routes.ts';
import { buildDetectionRouter } from './ingestion/detectionRoutes.ts';

/**
 * Mount the app routers defensively: a build failure is logged and does not take
 * down the worker or the /health route.
 */
export function mountApiRouters(root: Hono<{ Bindings: Env }>): void {
  try {
    root.route('/api', buildRestRouter());
  } catch (err) {
    console.warn('delivery/rest router not mounted:', (err as Error).message);
  }
  try {
    root.route('/api/admin', buildAdminRouter());
  } catch (err) {
    console.warn('admin/routes router not mounted:', (err as Error).message);
  }
  try {
    // Read-only trend analytics over the transaction corpus.
    root.route('/api/analytics', buildAnalyticsRouter());
  } catch (err) {
    console.warn('analytics/routes router not mounted:', (err as Error).message);
  }
  try {
    // Shared backend-owned contract for the phone-first SwiftUI app.
    root.route('/api/client/v1', buildClientRouter());
  } catch (err) {
    console.warn('client/routes router not mounted:', (err as Error).message);
  }
  try {
    // Bulk market-data snapshot export (NDJSON in R2) for App B bootstrapping.
    root.route('/api/export', buildExportRouter());
  } catch (err) {
    console.warn('export/routes router not mounted:', (err as Error).message);
  }
  try {
    // Residential detection scout push (INGEST_TOKEN) -> disclosure-latency race.
    root.route('/api/ingest', buildDetectionRouter());
  } catch (err) {
    console.warn('ingestion/detectionRoutes router not mounted:', (err as Error).message);
  }
  try {
    // App Store Server Notifications V2. Must live on this assembly — the
    // dead src/app.ts copy never ran in production (ENGINEERINGQUALITY-02).
    root.route('/api/webhooks', buildAppleWebhookRouter());
  } catch (err) {
    console.warn('billing/appleWebhook router not mounted:', (err as Error).message);
  }
  // End-user auth (Google OAuth + magic-link) at /auth/*. Mounted before the UI
  // catch-all so its routes are not shadowed by the dashboard.
  try {
    root.route('/auth', buildAuthRouter());
  } catch (err) {
    console.warn('auth/routes router not mounted:', (err as Error).message);
  }
  // Stripe billing (checkout / portal / webhook) at /billing/*. Also before the
  // UI catch-all.
  try {
    root.route('/billing', buildBillingRouter());
  } catch (err) {
    console.warn('billing/routes router not mounted:', (err as Error).message);
  }
  // Dashboard SPA at `/` and `/admin`. Registered after /health and /api so the
  // exact UI paths never shadow the API routers.
  try {
    root.route('/', buildUiRouter());
  } catch (err) {
    console.warn('ui/routes router not mounted:', (err as Error).message);
  }
}

/** Bare production Hono app with the same mounts Deno/Workers serve. */
export function buildProductionApp(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  mountApiRouters(app);
  return app;
}
