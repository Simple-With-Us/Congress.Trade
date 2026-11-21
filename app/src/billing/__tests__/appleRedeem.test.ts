/**
 * verifyAppleRedemption refusal logging — every refusal writes one
 * payload-free console.warn line (reason + environment/product/expires/
 * revoked fields only) so a rejected purchase can be diagnosed from server
 * logs without persisting the customer's signed transaction.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const verifyAppleSignedJws = vi.fn();
  class AppleJwsVerificationError extends Error {}
  return { verifyAppleSignedJws, AppleJwsVerificationError };
});
vi.mock('../../billing/appleJws', () => ({
  verifyAppleSignedJws: (...args: unknown[]) => mocks.verifyAppleSignedJws(...args),
  AppleJwsVerificationError: mocks.AppleJwsVerificationError,
}));
const { verifyAppleSignedJws, AppleJwsVerificationError: AppleJwsVerificationErrorRef } = mocks;

import { AppleRedeemError, verifyAppleRedemption } from '../appleRedeem.ts';
import type { Env } from '../../shared/types.ts';

function env(overrides: Record<string, unknown> = {}): Env {
  return { APPLE_IAP_ENABLED: 'true', ...overrides } as unknown as Env;
}

const FUTURE_MS = Date.now() + 30 * 86_400_000;
const PAST_MS = Date.now() - 60_000;

function transaction(overrides: Record<string, unknown> = {}) {
  return {
    transactionId: 'txn-1',
    originalTransactionId: 'otxn-1',
    productId: 'trade.congress.premium.monthly',
    bundleId: 'trade.congress.ios',
    environment: 'Production',
    expiresDate: FUTURE_MS,
    purchaseDate: Date.now(),
    ...overrides,
  };
}

describe('verifyAppleRedemption refusal logging', () => {
  beforeEach(() => {
    verifyAppleSignedJws.mockReset();
  });

  it('logs reason, environment, product and expiry when the transaction is expired', async () => {
    verifyAppleSignedJws.mockResolvedValue(transaction({ expiresDate: PAST_MS }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(verifyAppleRedemption(env(), 'a.b.c')).rejects.toThrow(AppleRedeemError);
      expect(warn).toHaveBeenCalledTimes(1);
      const line = String(warn.mock.calls[0][0]);
      expect(line).toContain('apple redeem rejected: this Apple transaction is not an active subscription');
      expect(line).toContain('environment=Production');
      expect(line).toContain('productId=trade.congress.premium.monthly');
      expect(line).toContain(`expiresAt=${new Date(PAST_MS).toISOString()}`);
      expect(line).not.toContain('a.b.c');
      expect(line).not.toContain('txn-1');
      expect(line).not.toContain('otxn-1');
    } finally {
      warn.mockRestore();
    }
  });

  it('logs revocation fields when the transaction is revoked', async () => {
    verifyAppleSignedJws.mockResolvedValue(transaction({ revocationDate: PAST_MS, revocationReason: 1 }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(verifyAppleRedemption(env(), 'a.b.c')).rejects.toThrow(/not an active subscription/);
      const line = String(warn.mock.calls[0][0]);
      expect(line).toContain(`revokedAt=${new Date(PAST_MS).toISOString()}`);
      expect(line).toContain('revocationReason=1');
    } finally {
      warn.mockRestore();
    }
  });

  it('logs the Sandbox environment when sandbox purchases are refused', async () => {
    verifyAppleSignedJws.mockResolvedValue(transaction({ environment: 'Sandbox' }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(verifyAppleRedemption(env({ APPLE_ALLOW_SANDBOX: 'false' }), 'a.b.c')).rejects.toThrow(
        /Sandbox Apple purchases are not accepted/,
      );
      const line = String(warn.mock.calls[0][0]);
      expect(line).toContain('environment=Sandbox');
      expect(line).toContain('productId=trade.congress.premium.monthly');
    } finally {
      warn.mockRestore();
    }
  });

  it('logs only the reason when the JWS cannot be verified', async () => {
    verifyAppleSignedJws.mockRejectedValue(new Error('bad chain'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(verifyAppleRedemption(env(), 'a.b.c')).rejects.toThrow(AppleRedeemError);
      expect(warn).toHaveBeenCalledTimes(1);
      const line = String(warn.mock.calls[0][0]);
      expect(line).toBe('apple redeem rejected: invalid Apple transaction');
      expect(line).not.toContain('a.b.c');
    } finally {
      warn.mockRestore();
    }
  });

  it('logs expiresAt=none instead of crashing on an out-of-range epoch', async () => {
    verifyAppleSignedJws.mockResolvedValue(transaction({ revocationDate: 1e30, revocationReason: 1 }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(verifyAppleRedemption(env(), 'a.b.c')).rejects.toThrow(/not an active subscription/);
      const line = String(warn.mock.calls[0][0]);
      expect(line).toContain('revokedAt=none');
    } finally {
      warn.mockRestore();
    }
  });

  it('sanitizes an attacker-influenced rejection reason to a single log line', async () => {
    verifyAppleSignedJws.mockRejectedValue(
      new AppleJwsVerificationErrorRef('bad alg\nforged log line\u001b[31mred'),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(verifyAppleRedemption(env(), 'a.b.c')).rejects.toThrow(AppleRedeemError);
      const line = String(warn.mock.calls[0][0]);
      expect(line).not.toContain('\n');
      expect(line).not.toContain('\u001b');
      expect(line).toContain('apple redeem rejected: bad alg forged log line');
    } finally {
      warn.mockRestore();
    }
  });

  it('does not log on success', async () => {
    verifyAppleSignedJws.mockResolvedValue(transaction());
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(verifyAppleRedemption(env(), 'a.b.c')).resolves.toMatchObject({ plan: 'monthly' });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
