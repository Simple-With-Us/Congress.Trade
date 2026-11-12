import { describe, expect, it } from 'vitest';
import { parseCommitteeNames, resolveFilerCommittees } from '../committeeNames.ts';

describe('parseCommitteeNames', () => {
  it('parses a JSON string array', () => {
    expect(parseCommitteeNames('["Senate Armed Services","Senate Agriculture"]')).toEqual([
      'Senate Armed Services',
      'Senate Agriculture',
    ]);
  });

  it('accepts an already-parsed array (driver-decoded JSON)', () => {
    expect(parseCommitteeNames(['Senate Armed Services', ' Senate Agriculture '])).toEqual([
      'Senate Armed Services',
      'Senate Agriculture',
    ]);
  });

  it('pulls display names out of object rows', () => {
    expect(
      parseCommitteeNames([{ name: 'House Financial Services' }, { committee: 'House Agriculture' }]),
    ).toEqual(['House Financial Services', 'House Agriculture']);
  });

  it('falls back to comma-separated text when JSON is invalid', () => {
    expect(parseCommitteeNames('Armed Services, Agriculture')).toEqual([
      'Armed Services',
      'Agriculture',
    ]);
  });

  it('returns empty for null, blank, or empty-array sentinels', () => {
    expect(parseCommitteeNames(null)).toEqual([]);
    expect(parseCommitteeNames('')).toEqual([]);
    expect(parseCommitteeNames('[]')).toEqual([]);
    expect(parseCommitteeNames([])).toEqual([]);
  });
});

describe('resolveFilerCommittees', () => {
  it('returns the stored list without a sibling lookup', async () => {
    const db = {
      prepare() {
        throw new Error('should not query when the row already has committees');
      },
    } as unknown as D1Database;
    await expect(
      resolveFilerCommittees(db, 'senate-al-tommy-tuberville', '["Senate Armed Services"]', 'T000278'),
    ).resolves.toEqual(['Senate Armed Services']);
  });

  it('looks up a sibling bioguide row when the slug list is empty', async () => {
    const seen: Array<{ sql: string; params: unknown[] }> = [];
    const db = {
      prepare(sql: string) {
        return {
          bind(...params: unknown[]) {
            seen.push({ sql, params });
            return {
              async first() {
                return { committees: JSON.stringify(['Senate Armed Services']) };
              },
            };
          },
        };
      },
    } as unknown as D1Database;
    await expect(
      resolveFilerCommittees(db, 'senate-al-tommy-tuberville', '[]', 'T000278'),
    ).resolves.toEqual(['Senate Armed Services']);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.params).toEqual([
      'senate-al-tommy-tuberville',
      'T000278',
      'senate-al-tommy-tuberville',
      'T000278',
    ]);
  });
});
