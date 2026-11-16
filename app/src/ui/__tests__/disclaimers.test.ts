import { describe, expect, it } from 'vitest';
import {
  NOT_AFFILIATED_SENTENCE,
  OG_SHARE_DISCLAIMER_LINE,
  SITE_FOOTER_DISCLAIMER,
  withOgShareDisclaimer,
} from '../disclaimers.ts';

describe('disclaimers (LEGALCOMPLIANCE-04 / CT-1336)', () => {
  it('pins the long non-affiliation sentence', () => {
    expect(NOT_AFFILIATED_SENTENCE).toContain('not affiliated with, endorsed by, or sponsored by');
    expect(NOT_AFFILIATED_SENTENCE).toContain('U.S. Congress');
  });

  it('pins the combined site-footer line', () => {
    expect(SITE_FOOTER_DISCLAIMER).toContain('independent/private service not affiliated');
    expect(SITE_FOOTER_DISCLAIMER).not.toMatch(/agency\./);
  });

  it('pins the OG share-card short line', () => {
    expect(OG_SHARE_DISCLAIMER_LINE).toBe(
      'Not affiliated with the U.S. Congress or any government agency.',
    );
  });

  it('appends the OG suffix once', () => {
    const base = 'Trading trends on Congress.Trade.';
    expect(withOgShareDisclaimer(base)).toBe(`${base} ${OG_SHARE_DISCLAIMER_LINE}`);
    expect(withOgShareDisclaimer(withOgShareDisclaimer(base))).toBe(`${base} ${OG_SHARE_DISCLAIMER_LINE}`);
  });
});
