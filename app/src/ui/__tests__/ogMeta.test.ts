import { describe, expect, it } from 'vitest';
import { applyOgMeta, escapeAttr, resolveOgMeta } from '../ogMeta.ts';
import { OG_IMAGE_VERSION } from '../assets.ts';
import { OG_SHARE_DISCLAIMER_LINE } from '../disclaimers.ts';

describe('resolveOgMeta', () => {
  it('defaults to the home lockup card', () => {
    const m = resolveOgMeta('https://congress.trade/');
    expect(m.context).toBe('default');
    expect(m.title).toBe('Congress.Trade');
    expect(m.imageUrl).toBe(`https://congress.trade/og-image.png?v=${OG_IMAGE_VERSION}`);
    expect(m.url).toBe('https://congress.trade/');
    expect(m.description).toContain(OG_SHARE_DISCLAIMER_LINE);
    expect(m.description).not.toMatch(/\bofficial\b/i);
  });

  it('uses the Trends card for ?view=trends', () => {
    const m = resolveOgMeta('https://congress.trade/?view=trends');
    expect(m.context).toBe('trends');
    expect(m.title).toBe('Trends');
    expect(m.imageUrl).toContain('/og-image-trends.png?v=');
    expect(m.description).toMatch(/^Trading trends/);
    expect(m.description).not.toMatch(/Congressional/i);
  });

  it('uses the Company card for a DB-resolved ?ticker=', () => {
    const m = resolveOgMeta('https://congress.trade/?ticker=aapl', 'https://congress.trade', {
      tickerResolved: true,
    });
    expect(m.context).toBe('company');
    expect(m.title).toBe('AAPL');
    expect(m.imageUrl).toContain('/og-image-company.png?v=');
    expect(m.description).toContain('Disclosed trades in AAPL');
    expect(m.description).not.toMatch(/Congressional/i);
  });

  it('uses the Politician card for a DB-resolved ?member= (priority over view)', () => {
    const m = resolveOgMeta('https://congress.trade/?view=trends&member=P000197', 'https://congress.trade', {
      memberDisplayName: 'Nancy Pelosi',
    });
    expect(m.context).toBe('politician');
    expect(m.title).toBe('Nancy Pelosi');
    expect(m.imageUrl).toContain('/og-image-politician.png?v=');
  });

  it('prefers a resolved ticker over view when both present', () => {
    const m = resolveOgMeta('https://congress.trade/?view=trends&ticker=MSFT', 'https://congress.trade', {
      tickerResolved: true,
    });
    expect(m.context).toBe('company');
    expect(m.title).toBe('MSFT');
  });

  it('never repeats the site name in a context og:title', () => {
    const cases: Array<[string, Parameters<typeof resolveOgMeta>[2]]> = [
      ['https://congress.trade/?view=trends', {}],
      ['https://congress.trade/?ticker=AAPL', { tickerResolved: true }],
      ['https://congress.trade/?member=P000197', { memberDisplayName: 'Nancy Pelosi' }],
    ];
    for (const [url, opts] of cases) {
      expect(resolveOgMeta(url, 'https://congress.trade', opts).title).not.toContain('Congress.Trade');
    }
  });

  describe('SEOSOCIAL-06: only a DB-resolved entity earns a branded card', () => {
    it('falls back to the default card for an unresolved ?member= instead of echoing the raw text', () => {
      const m = resolveOgMeta('https://congress.trade/?member=Claim free BTC at evil.example');
      expect(m.context).toBe('default');
      expect(m.title).toBe('Congress.Trade');
      expect(m.title).not.toContain('evil.example');
      expect(m.description).not.toContain('evil.example');
    });

    it('falls back to the default card for an unresolved ?ticker= instead of upper-casing arbitrary text', () => {
      const m = resolveOgMeta('https://congress.trade/?ticker=free money evil.example');
      expect(m.context).toBe('default');
      expect(m.title).toBe('Congress.Trade');
      expect(m.title).not.toContain('EVIL');
      expect(m.description).not.toContain('EVIL');
    });

    it('a present-but-unresolved ?member= still lets a resolved ?ticker= win (no card is worse than the wrong card, but a real one is better than none)', () => {
      const m = resolveOgMeta('https://congress.trade/?member=nonexistent&ticker=NVDA', 'https://congress.trade', {
        tickerResolved: true,
      });
      expect(m.context).toBe('company');
      expect(m.title).toBe('NVDA');
    });
  });

  describe('LEGALCOMPLIANCE-04: share unfurls carry the non-affiliation line', () => {
    it('appends the short disclaimer to politician, company, and trade cards', () => {
      const politician = resolveOgMeta('https://congress.trade/?member=P000197', 'https://congress.trade', {
        memberDisplayName: 'Nancy Pelosi',
      });
      const company = resolveOgMeta('https://congress.trade/?ticker=NVDA', 'https://congress.trade', {
        tickerResolved: true,
      });
      const trade = resolveOgMeta('https://congress.trade/?trade=x', 'https://congress.trade', {
        tradeSummary: {
          filerLabel: 'Nancy Pelosi (D-CA-11)',
          verb: 'bought',
          assetLabel: 'NVDA',
          amountBracket: '$1m - $5m',
          txDateLabel: 'Aug 5, 2026',
        },
      });
      for (const m of [politician, company, trade]) {
        expect(m.description).toContain(OG_SHARE_DISCLAIMER_LINE);
      }
    });
  });

  describe('SEOSOCIAL-04: trades/people/subs views get their own title/description', () => {
    it.each([
      ['trades', 'Trades', /Trades tab/],
      ['people', 'Directory', /Directory/],
      ['subs', 'Delivery', /Delivery/],
    ])('renders a %s-specific card, not the generic default copy', (view, title, descPattern) => {
      const m = resolveOgMeta(`https://congress.trade/?view=${view}`);
      expect(m.title).toBe(title);
      expect(m.description).toMatch(descPattern);
      expect(m.description).not.toContain('First-party House');
      expect(m.pageTitle).toBe(`${title} — Congress.Trade`);
    });
  });

  describe('SEOSOCIAL-04: pageTitle carries the site suffix <title> needs, og:title does not', () => {
    it('leaves the bare default pageTitle as just "Congress.Trade" (no doubled suffix)', () => {
      const m = resolveOgMeta('https://congress.trade/');
      expect(m.pageTitle).toBe('Congress.Trade');
    });

    it('appends " — Congress.Trade" to every non-default pageTitle', () => {
      const trends = resolveOgMeta('https://congress.trade/?view=trends');
      expect(trends.pageTitle).toBe('Trends — Congress.Trade');
      const ticker = resolveOgMeta('https://congress.trade/?ticker=NVDA', 'https://congress.trade', {
        tickerResolved: true,
      });
      expect(ticker.pageTitle).toBe('NVDA — Congress.Trade');
      const member = resolveOgMeta('https://congress.trade/?member=P000197', 'https://congress.trade', {
        memberDisplayName: 'Nancy Pelosi',
        memberDistrict: 'D-CA-11',
      });
      expect(member.pageTitle).toBe('Nancy Pelosi (D-CA-11) — Congress.Trade');
    });
  });

  describe('SEOSOCIAL-05: ?trade= permalinks get a real trade card', () => {
    const summary = {
      filerLabel: 'Nancy Pelosi (D-CA-11)',
      verb: 'bought' as const,
      assetLabel: 'NVDA',
      amountBracket: '$1m - $5m',
      txDateLabel: 'Aug 5, 2026',
    };

    it('renders filer + verb + asset + bracket + date, reusing the company image', () => {
      const m = resolveOgMeta('https://congress.trade/?trade=aa349372-0000', 'https://congress.trade', {
        tradeSummary: summary,
      });
      expect(m.context).toBe('trade');
      expect(m.title).toBe('Nancy Pelosi (D-CA-11) bought NVDA ($1m - $5m) · Aug 5, 2026');
      expect(m.pageTitle).toBe('Nancy Pelosi (D-CA-11) bought NVDA ($1m - $5m) · Aug 5, 2026 — Congress.Trade');
      expect(m.description).toContain('Nancy Pelosi (D-CA-11) bought NVDA for $1m - $5m');
      expect(m.description).toContain('disclosed Aug 5, 2026');
      expect(m.imageUrl).toContain('/og-image-company.png?v=');
    });

    it('capitalizes the verb and drops the name when the filer did not resolve', () => {
      const m = resolveOgMeta('https://congress.trade/?trade=aa349372-0000', 'https://congress.trade', {
        tradeSummary: { ...summary, filerLabel: null },
      });
      expect(m.title).toBe('Bought NVDA ($1m - $5m) · Aug 5, 2026');
    });

    it('falls back to the default card for an unresolved trade id instead of a 500 (SEOSOCIAL-06 rule)', () => {
      const m = resolveOgMeta('https://congress.trade/?trade=does-not-exist');
      expect(m.context).toBe('default');
      expect(m.title).toBe('Congress.Trade');
    });

    it('lets a resolved member/ticker outrank an also-present ?trade= (member wins first)', () => {
      const m = resolveOgMeta(
        'https://congress.trade/?trade=aa349372-0000&member=P000197',
        'https://congress.trade',
        { memberDisplayName: 'Nancy Pelosi', tradeSummary: summary },
      );
      expect(m.context).toBe('politician');
    });
  });

  it('renders the district after the member name when provided', () => {
    const m = resolveOgMeta('https://congress.trade/?member=P000197', 'https://congress.trade', {
      memberDisplayName: 'Nancy Pelosi',
      memberDistrict: 'D-CA-11',
    });
    expect(m.title).toBe('Nancy Pelosi (D-CA-11)');
    expect(m.description).toContain('Nancy Pelosi (D-CA-11)');
    expect(m.description).toMatch(/^Trading activity for/);
    expect(m.description).not.toMatch(/Congressional/i);
  });

  it('falls back to the bare name when no district is known', () => {
    const m = resolveOgMeta('https://congress.trade/?member=P000197', 'https://congress.trade', {
      memberDisplayName: 'Nancy Pelosi',
      memberDistrict: '   ',
    });
    expect(m.title).toBe('Nancy Pelosi');
  });

  it('normalises a district that arrives already parenthesised', () => {
    const m = resolveOgMeta('https://congress.trade/?member=X', 'https://congress.trade', {
      memberDisplayName: 'Rep Example',
      memberDistrict: '(R-TX-02)',
    });
    expect(m.title).toBe('Rep Example (R-TX-02)');
  });

  // Cap raised 24 -> 40 so real executive-branch positions survive intact:
  // the longest curated title, 'Social Security Commissioner' (28 chars), was
  // being cut mid-word to 'Social Security Commissio…'. Still bounded.
  it('truncates an implausibly long district descriptor', () => {
    const m = resolveOgMeta('https://congress.trade/?member=X', 'https://congress.trade', {
      memberDisplayName: 'Rep Example',
      memberDistrict: 'D-CALIFORNIA-ELEVENTH-CONGRESSIONAL-DISTRICT-AT-LARGE-SEAT',
    });
    expect(m.title.length).toBeLessThanOrEqual('Rep Example '.length + 42);
    expect(m.title).toContain('…');
  });

  it('keeps a real executive-branch title intact', () => {
    const m = resolveOgMeta('https://congress.trade/?member=X', 'https://congress.trade', {
      memberDisplayName: 'Frank J. Bisignano',
      memberDistrict: 'Social Security Commissioner',
    });
    expect(m.title).toBe('Frank J. Bisignano (Social Security Commissioner)');
  });
});

describe('applyOgMeta', () => {
  it('fills every placeholder and escapes attribute text', () => {
    const meta = resolveOgMeta('https://congress.trade/?ticker=BRK.B', 'https://congress.trade', {
      tickerResolved: true,
    });
    const html = applyOgMeta(
      '<title>x</title><meta property="og:title" content="%OG_TITLE%" />' +
        '<meta property="og:image" content="%OG_IMAGE%" />' +
        '<link rel="canonical" href="%CANONICAL_URL%" />' +
        '<meta name="twitter:image" content="%TWITTER_IMAGE%" />',
      meta,
    );
    expect(html).toContain('content="BRK.B"');
    expect(html).toContain(`content="https://congress.trade/og-image-company.png?v=${OG_IMAGE_VERSION}"`);
    expect(html).toContain('href="https://congress.trade/?ticker=BRK.B"');
    expect(html).not.toContain('%OG_');
  });

  it('fills %TITLE%/%META_DESCRIPTION% from the same OgMeta (SEOSOCIAL-04)', () => {
    const meta = resolveOgMeta('https://congress.trade/?view=trends');
    const html = applyOgMeta('<title>%TITLE%</title><meta name="description" content="%META_DESCRIPTION%" />', meta);
    expect(html).toContain('<title>Trends — Congress.Trade</title>');
    expect(html).toContain('content="Trading trends');
    expect(html).not.toContain('%TITLE%');
    expect(html).not.toContain('%META_DESCRIPTION%');
  });

  it('escapeAttr encodes quotes and angle brackets', () => {
    expect(escapeAttr('a"b<c>')).toBe('a&quot;b&lt;c&gt;');
  });
});
