import { describe, it, expect } from 'vitest';
import type { Env } from '../../shared/types.ts';
import {
  APPLE_PRODUCT_ANNUAL,
  APPLE_PRODUCT_MONTHLY,
  appleSandboxPurchasesAllowed,
  appleTransactionIsActive,
  assertAppleJwsShape,
  isAppleSandboxEnvironment,
  planFromAppleProductId,
} from '../apple.ts';

function fakeJws(payload: Record<string, unknown>): string {
  const enc = (obj: unknown) => {
    const json = JSON.stringify(obj);
    const b64 = btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    return b64;
  };
  return `${enc({ alg: 'ES256' })}.${enc(payload)}.sig`;
}

describe('apple IAP helpers', () => {
  it('maps product ids to plans', () => {
    expect(planFromAppleProductId(APPLE_PRODUCT_MONTHLY)).toBe('monthly');
    expect(planFromAppleProductId(APPLE_PRODUCT_ANNUAL)).toBe('annual');
    expect(planFromAppleProductId('other')).toBeNull();
  });

  it('decodes a compact JWS payload', () => {
    const jws = fakeJws({
      productId: APPLE_PRODUCT_MONTHLY,
      originalTransactionId: '1000001',
      bundleId: 'trade.congress.ios',
      expiresDate: Date.now() + 86_400_000,
    });
    const tx = assertAppleJwsShape(jws);
    expect(tx.productId).toBe(APPLE_PRODUCT_MONTHLY);
    expect(tx.originalTransactionId).toBe('1000001');
    expect(appleTransactionIsActive(tx)).toBe(true);
  });

  it('treats expired or revoked transactions as inactive', () => {
    expect(
      appleTransactionIsActive({
        expiresDate: Date.now() - 1000,
      }),
    ).toBe(false);
    expect(
      appleTransactionIsActive({
        expiresDate: Date.now() + 1000,
        revocationDate: Date.now() - 10,
      }),
    ).toBe(false);
  });

  it('detects Apple Sandbox environments case-insensitively', () => {
    expect(isAppleSandboxEnvironment('Sandbox')).toBe(true);
    expect(isAppleSandboxEnvironment('sandbox')).toBe(true);
    expect(isAppleSandboxEnvironment('Production')).toBe(false);
    expect(isAppleSandboxEnvironment(undefined)).toBe(false);
  });

  it('allows Apple-signed Sandbox JWS unless APPLE_ALLOW_SANDBOX is explicitly false', async () => {
    // Unset is the production default: TestFlight, App Review, and Designed-for-iPad
    // on Mac all send environment=Sandbox to congress.trade.
    expect(await appleSandboxPurchasesAllowed({} as Env)).toBe(true);
    expect(await appleSandboxPurchasesAllowed({ APPLE_ALLOW_SANDBOX: 'true' } as Env)).toBe(true);
    expect(await appleSandboxPurchasesAllowed({ APPLE_ALLOW_SANDBOX: 'TRUE' } as Env)).toBe(true);
    expect(await appleSandboxPurchasesAllowed({ APPLE_ALLOW_SANDBOX: 'false' } as Env)).toBe(false);
    expect(await appleSandboxPurchasesAllowed({ APPLE_ALLOW_SANDBOX: '0' } as Env)).toBe(false);
    expect(await appleSandboxPurchasesAllowed({ APPLE_ALLOW_SANDBOX: 'no' } as Env)).toBe(false);
  });
});
