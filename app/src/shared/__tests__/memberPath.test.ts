import { describe, expect, it } from 'vitest';
import { mergePeeledQuery, peelEncodedQueryFromPathParam } from '../memberPath.ts';

describe('peelEncodedQueryFromPathParam', () => {
  it('leaves a clean member id untouched', () => {
    expect(peelEncodedQueryFromPathParam('C001047')).toEqual({ id: 'C001047', query: {} });
  });

  it('peels a percent-encoded query string off the path (APICONTRACT-01)', () => {
    expect(peelEncodedQueryFromPathParam('C001047%3Fsort%3Dtx_date%26order%3Ddesc')).toEqual({
      id: 'C001047',
      query: { sort: 'tx_date', order: 'desc' },
    });
  });

  it('peels a decoded query leftover (Hono already decoded %3F)', () => {
    expect(peelEncodedQueryFromPathParam('house-ca11-nancy-pelosi?window=90d')).toEqual({
      id: 'house-ca11-nancy-pelosi',
      query: { window: '90d' },
    });
  });
});

describe('mergePeeledQuery', () => {
  it('lets a real query string win over a peeled leftover', () => {
    expect(mergePeeledQuery({ sort: 'published' }, { sort: 'tx_date', order: 'desc' })).toEqual({
      sort: 'published',
      order: 'desc',
    });
  });
});
