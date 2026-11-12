/**
 * The dry run's hard boundary is that it cannot write to production. Pin the
 * guard that enforces it — the rest of the script is a report generator, but
 * this one function is the thing standing between "reads prod" and "rewrites
 * 26,318 asset names without the owner having seen them".
 */
import { describe, expect, it } from 'vitest';
import { assertReadOnly } from '../dry-run-asset-name-cleanup.ts';

describe('assertReadOnly', () => {
  it('allows a single SELECT', () => {
    expect(assertReadOnly('SELECT id, asset_name FROM transactions WHERE deprecated_at IS NULL')).toContain(
      'SELECT id, asset_name',
    );
    expect(assertReadOnly('  select  count(*)  as n  from transactions ')).toBe('select count(*) as n from transactions');
  });

  it('refuses every statement that could write', () => {
    for (const sql of [
      "UPDATE transactions SET asset_name = 'x'",
      "DELETE FROM transactions WHERE id = '1'",
      "INSERT INTO transactions (id) VALUES ('1')",
      'DROP TABLE transactions',
      'ALTER TABLE transactions ADD COLUMN x TEXT',
      'PRAGMA writable_schema = 1',
      'VACUUM',
    ]) {
      expect(() => assertReadOnly(sql)).toThrow(/read-only/i);
    }
  });

  it('refuses a write smuggled in behind a SELECT', () => {
    expect(() => assertReadOnly("SELECT 1; UPDATE transactions SET asset_name = 'x'")).toThrow(
      /multi-statement|write keyword/i,
    );
    expect(() =>
      assertReadOnly("SELECT id FROM transactions WHERE id IN (SELECT id FROM t) UNION SELECT 1 -- DELETE"),
    ).toThrow(/write keyword/i);
  });
});
