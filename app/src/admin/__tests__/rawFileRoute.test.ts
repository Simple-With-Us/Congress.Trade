import { describe, expect, it } from 'vitest';
import { buildAdminRouter } from '../routes.ts';

const app = buildAdminRouter();
const AUTH = { Authorization: 'Bearer admin-secret' };

function envWithRawGet(getImpl: () => Promise<unknown>) {
  return {
    ADMIN_TOKEN: 'admin-secret',
    DB: {
      prepare: () => ({
        bind() { return this; },
        async first() {
          return { raw_object_key: 'raw/H-2025-8221177' };
        },
      }),
    },
    RAW_FILES: { get: getImpl },
  } as never;
}

describe('GET /filings/:docId/raw', () => {
  it('returns 503 without the provider Unauthorized string when the store rejects credentials', async () => {
    const res = await app.request(
      '/filings/H-2025-8221177/raw',
      { headers: AUTH },
      envWithRawGet(async () => {
        throw new Error('Unauthorized');
      }),
    );
    expect(res.status).toBe(503);
    const body = await res.json() as { error: string; detail: string };
    expect(body.error).toBe('stored copy unavailable');
    expect(JSON.stringify(body)).not.toContain('Unauthorized');
  });

  it('returns 500 without leaking provider text for other store failures', async () => {
    const res = await app.request(
      '/filings/H-2025-8221177/raw',
      { headers: AUTH },
      envWithRawGet(async () => {
        throw new Error('endpoint=secret-value');
      }),
    );
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('stored copy read failed');
    expect(JSON.stringify(body)).not.toContain('secret-value');
  });
});
