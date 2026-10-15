import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { OG_SHARE_DISCLAIMER_LINE } from '../disclaimers.ts';

const OG_CARD_HTML = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../scripts/og-card.html',
);

describe('og-card.html share-card template (CT-1336)', () => {
  const html = readFileSync(OG_CARD_HTML, 'utf8');

  it('renders the non-affiliation disclaimer on card art', () => {
    expect(html).toContain('id="og-share-disclaimer"');
    expect(html).toContain(OG_SHARE_DISCLAIMER_LINE);
    expect(html).toContain('share-disclaimer');
  });
});
