import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { buildProductionApp, mountApiRouters } from '../apiRouters.ts';
import type { Env } from '../shared/types.ts';

describe('production route inventory', () => {
  it('mounts POST /api/webhooks/apple on the production Hono app', async () => {
    const app = buildProductionApp();
    const res = await app.request('http://localhost/api/webhooks/apple', {
      method: 'POST',
      body: JSON.stringify({}),
      headers: { 'content-type': 'application/json' },
    }, {} as Env);
    expect(res.status).not.toBe(404);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Apple IAP is not enabled' });
  });

  it('uses the same mount function the Worker entry calls (one assembly)', () => {
    const app = new Hono<{ Bindings: Env }>();
    mountApiRouters(app);
    const routes = app.routes.map((r) => `${r.method} ${r.path}`);
    expect(routes.some((r) => r.startsWith('POST') && r.includes('/apple'))).toBe(true);
  });
});
