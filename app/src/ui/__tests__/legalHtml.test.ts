/**
 * src/ui/__tests__/legalHtml.test.ts
 *
 * Guards the Terms of Service pricing copy against drifting from the owner-
 * decided canonical Premium price ($8.99/mo · $79.99/yr, 1-week trial).
 */

import { describe, it, expect } from 'vitest';
import { TOS_HTML, PRIVACY_HTML } from '../legalHtml.ts';

describe('legalHtml pricing copy', () => {
  it('states the canonical $8.99/mo · $79.99/yr Premium price in the Terms of Service', () => {
    expect(TOS_HTML).toContain('$8.99 / month');
    expect(TOS_HTML).toContain('$79.99 / year');
    expect(TOS_HTML).toContain('1-week free trial');
    expect(TOS_HTML).toContain('U.S. reference prices in USD');
    expect(TOS_HTML).toContain('local currency at purchase');
    expect(TOS_HTML).not.toContain('14 days');
    expect(TOS_HTML).not.toContain('2 weeks');
    expect(TOS_HTML).not.toContain('30 days');
    expect(TOS_HTML).not.toContain('14 days / 2 weeks');
  });

  it('never mentions stale price points', () => {
    expect(TOS_HTML).not.toContain('$5.00 / month');
    expect(TOS_HTML).not.toContain('$50.00 / year');
    expect(TOS_HTML).not.toContain('$15.00');
    expect(TOS_HTML).not.toContain('$140.00');
    expect(TOS_HTML).not.toContain('$9.00');
    expect(TOS_HTML).not.toContain('$90.00');
    expect(PRIVACY_HTML).not.toContain('$15.00');
    expect(PRIVACY_HTML).not.toContain('$140.00');
  });

  it('offers in-app account deletion in Privacy §6', () => {
    expect(PRIVACY_HTML).toContain('Delete Account');
    expect(PRIVACY_HTML).toContain('iOS Account sheet');
  });

  it('mails support@congress.trade, not the old jays.services inbox', () => {
    expect(TOS_HTML).toContain('mailto:support@congress.trade');
    expect(PRIVACY_HTML).toContain('mailto:support@congress.trade');
    expect(TOS_HTML).not.toContain('congress.trade@jays.services');
    expect(PRIVACY_HTML).not.toContain('congress.trade@jays.services');
  });
});

describe('LEGALCOMPLIANCE-04: not-affiliated-with-government disclaimer', () => {
  const SENTENCE =
    'Congress.Trade is an independent, privately operated service and is not affiliated with, endorsed by, or sponsored by the U.S. Congress, the U.S. House of Representatives, the U.S. Senate, the Office of Government Ethics, or any government agency.';
  const FOOTER =
    'Congress.Trade  ·  educational tool for public STOCK Act (2012) disclosures  ·  not financial advice  ·  $ estimated from brackets  ·  independent/private service not affiliated with or endorsed/sponsored by any government agency';

  it('keeps the long non-affiliation sentence in Terms of Service §1', () => {
    expect(TOS_HTML).toContain(SENTENCE);
  });

  it('uses one combined footer line with two spaces around each dot and no trailing period', () => {
    expect(TOS_HTML).toContain(FOOTER);
    expect(PRIVACY_HTML).toContain(FOOTER);
    expect(FOOTER.endsWith('agency')).toBe(true);
    expect(FOOTER).toContain('  ·  ');
    expect(FOOTER).not.toMatch(/agency\./);
  });
});

describe('LEGALCOMPLIANCE-05: ToS §1 scope covers Executive Branch OGE 278-T filings', () => {
  it('describes House, Senate, AND Executive Branch filings, not Congress-only', () => {
    expect(TOS_HTML).toContain('U.S. House of Representatives and U.S. Senate under the STOCK Act (2012)');
    expect(TOS_HTML).toContain('U.S. Executive Branch officials under the Ethics in Government Act of 1978');
    expect(TOS_HTML).toContain('Periodic Transaction Reports (OGE Form 278-T)');
    expect(TOS_HTML).not.toContain('filed by politicians serving in the U.S. Congress under the STOCK Act (2012)');
  });

  it('names the public-record source agencies and the EIGA use restriction on Executive Branch reports', () => {
    expect(TOS_HTML).toContain('U.S. House Clerk, the U.S. Senate, and the Office of Government Ethics');
    expect(TOS_HTML).toContain('5 U.S.C. &sect;13107(c)');
  });
});

describe('LEGALCOMPLIANCE-03: Apple In-App Purchase path in ToS §3-5', () => {
  it('addresses Apple as merchant of record and App Store cancellation/refunds separately from Stripe', () => {
    expect(TOS_HTML).toContain('billed by Apple as an In-App Purchase');
    expect(TOS_HTML).toContain('iOS Settings');
    expect(TOS_HTML).toContain('reportaproblem.apple.com');
    expect(TOS_HTML).toContain('Apple, not Congress.Trade, is the merchant of record');
  });
});

describe('LEGALCOMPLIANCE-02: Privacy Policy discloses Apple, Sentry, and LLM extraction providers', () => {
  it('lists Apple (Sign in, IAP, APNs) as a sub-processor and identifier source', () => {
    expect(PRIVACY_HTML).toContain('Apple-assigned user identifier');
    expect(PRIVACY_HTML).toContain('Apple Push Notification service (APNs) token');
    expect(PRIVACY_HTML).toContain('<strong>Apple</strong> — "Sign in with Apple" authentication');
  });

  it('lists Sentry and the OpenRouter/Mistral/LlamaParse extraction pipeline', () => {
    expect(PRIVACY_HTML).toContain('Sentry (Functional Software, Inc.)');
    expect(PRIVACY_HTML).toContain('OpenRouter, Mistral, and LlamaParse');
  });

  it('discloses webhook destination URLs and the Cloudflare Web Analytics beacon', () => {
    expect(PRIVACY_HTML).toContain('webhook delivery, the destination URL you provide');
    expect(PRIVACY_HTML).toContain('Web Analytics" beacon');
  });
});

describe('ToS §9-10: no-warranty / no-guarantee protective language', () => {
  it('disclaims any guarantee that a filing is published at all or on any schedule, and names the upstream sources', () => {
    expect(TOS_HTML).toContain('No guarantee any filing is published, or published on any schedule.');
    expect(TOS_HTML).toContain("the U.S. House Clerk's office, the U.S. Senate's electronic financial disclosure (eFD) system, and the Office of Government Ethics (OGE)");
    expect(TOS_HTML).toContain('do not guarantee that any particular filing will be published on the Service at all, on any schedule, or within any timeframe');
  });

  it('disclaims any guarantee of being faster than any other source, tying it to historical-only latency comparisons', () => {
    expect(TOS_HTML).toContain('No guarantee of being faster than any other source.');
    expect(TOS_HTML).toContain('historical measurement of past filings under the conditions observed at that time');
    expect(TOS_HTML).toContain('not a representation, promise, or guarantee about the timing of any future filing');
  });

  it('disclaims delivery of alerts and notifications across every channel', () => {
    expect(TOS_HTML).toContain('Alerts &amp; notifications may be delayed, duplicated, or fail.');
    expect(TOS_HTML).toContain('Email, push, webhook, and SSE (real-time) delivery');
    expect(TOS_HTML).toContain('A paid subscription does not guarantee the delivery, timing, or accuracy of any particular alert.');
  });

  it('reserves the right to change, suspend, or discontinue any part of the Service', () => {
    expect(TOS_HTML).toContain('We may add, change, suspend, or discontinue any part of the Service');
  });

  it('states dollar amounts are bracket-derived estimates, not exact amounts', () => {
    expect(TOS_HTML).toContain('estimates derived from the disclosure brackets the filings themselves use, not exact amounts');
  });

  it('carves out jurisdictions that do not allow warranty/liability exclusions', () => {
    expect(TOS_HTML).toContain('Some jurisdictions do not allow the exclusion of certain warranties');
    expect(TOS_HTML).toContain('limited to the maximum extent permitted by applicable law');
  });
});

describe('shared legal chrome and theme path', () => {
  function styleBlock(html: string): string {
    const match = html.match(/<style>[\s\S]*?<\/style>/);
    if (!match) throw new Error('missing <style> block');
    return match[0];
  }

  function themeBoot(html: string): string {
    const match = html.match(/localStorage\.getItem\('ui-theme'\)[\s\S]*?data-theme-pref/);
    if (!match) throw new Error('missing ui-theme boot');
    return match[0];
  }

  it('gives ToS and Privacy Policy the same heading, font, and list chrome', () => {
    expect(styleBlock(TOS_HTML)).toBe(styleBlock(PRIVACY_HTML));
    for (const html of [TOS_HTML, PRIVACY_HTML]) {
      expect(html).toContain('h1{font-size:26px;font-weight:700');
      expect(html).toContain('.eff{color:var(--dim);font-size:13px');
      expect(html).toContain('h2{font-size:17px;font-weight:700');
      expect(html).toContain('--sans:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif');
      expect(html).toContain('ul{padding-left:20px;list-style:disc}');
      expect(html).toContain('Congress<span class="dot">.</span>Trade');
    }
    expect(TOS_HTML).toContain('<h1>Terms of Service</h1>');
    expect(TOS_HTML).toContain('<p class="eff">Effective October 9, 2026</p>');
    expect(PRIVACY_HTML).toContain('<h1>Privacy Policy</h1>');
    expect(PRIVACY_HTML).toContain('<p class="eff">Effective October 9, 2026</p>');
  });

  it('honors the site Light / Dark / System switch on both pages', () => {
    expect(themeBoot(TOS_HTML)).toBe(themeBoot(PRIVACY_HTML));
    for (const html of [TOS_HTML, PRIVACY_HTML]) {
      expect(html).toContain('localStorage.getItem(\'ui-theme\')');
      expect(html).toContain('html[data-theme="light"]');
      expect(html).toContain('html[data-theme="dark"]');
      expect(html).toContain('--bg:#0b1120');
      expect(html).toContain('--bg:#eff3f8');
      expect(html).toContain('data-theme-opt="light"');
      expect(html).toContain('data-theme-opt="dark"');
      expect(html).toContain('data-theme-opt="system"');
      expect(html).toContain('aria-label="Theme"');
    }
  });

  // Owner 2026-08-21: "just delete the option" — Sepia was half-implemented
  // and looked ugly, not like paper.  Assert the palette, the picker entry,
  // and every html[data-theme="sepia"] CSS rule stay gone on both legal
  // pages so a future PR can't silently reintroduce it, while the one-time
  // localStorage migration (stored 'sepia' → 'light') stays present so a
  // returning visitor with Sepia selected doesn't keep failing validation.
  it('has fully removed the Sepia theme and migrates any stored preference to Light', () => {
    for (const html of [TOS_HTML, PRIVACY_HTML]) {
      expect(html).not.toContain("label: 'Sepia'");
      expect(html).not.toContain('html[data-theme="sepia"]');
      expect(html).not.toContain('data-theme-opt="sepia"');
      expect(html).not.toContain('--bg:#f3e6d0');
      const sepiaMigrations = html.match(/if \(s === 'sepia'\)/g) || [];
      // Boot script + runtime readThemePref() each migrate a stored 'sepia' value.
      expect(sepiaMigrations.length).toBe(2);
      expect(html).toContain("localStorage.setItem('ui-theme', 'light')");
    }
  });
});

describe('short legal and pricing routes', () => {
  // These dynamically import the whole UI router; under cold transform or
  // parallel-suite load the default 5s per-test budget occasionally trips
  // (observed 2026-08-20: flaky timeouts on the redirect test). 20s is ample
  // for the full module graph and still fails fast on a real hang.
  it('redirects /privacy, /terms, and /pricing to canonical destinations', { timeout: 20_000 }, async () => {
    const { buildUiRouter } = await import('../routes.ts');
    const app = buildUiRouter();
    const privacy = await app.request('http://localhost/privacy', {}, {} as never);
    expect(privacy.status).toBe(301);
    expect(privacy.headers.get('location')).toBe('/privacy-policy');

    const terms = await app.request('http://localhost/terms', {}, {} as never);
    expect(terms.status).toBe(301);
    expect(terms.headers.get('location')).toBe('/terms-of-service');

    const pricing = await app.request('http://localhost/pricing', {}, {} as never);
    expect(pricing.status).toBe(302);
    expect(pricing.headers.get('location')).toContain('pricing=1');
  });

  it('serves ToS and Privacy Policy from the same themed shell', { timeout: 20_000 }, async () => {
    const { buildUiRouter } = await import('../routes.ts');
    const app = buildUiRouter();
    const tos = await app.request('http://localhost/terms-of-service', {}, {} as never);
    const privacy = await app.request('http://localhost/privacy-policy', {}, {} as never);
    expect(tos.status).toBe(200);
    expect(privacy.status).toBe(200);
    const tosHtml = await tos.text();
    const privacyHtml = await privacy.text();
    expect(tosHtml).toContain('data-theme-opt="system"');
    expect(privacyHtml).toContain('data-theme-opt="system"');
    expect(tosHtml).toContain('<h1>Terms of Service</h1>');
    expect(privacyHtml).toContain('<h1>Privacy Policy</h1>');
    const tosStyle = tosHtml.match(/<style>[\s\S]*?<\/style>/)?.[0];
    const privacyStyle = privacyHtml.match(/<style>[\s\S]*?<\/style>/)?.[0];
    expect(tosStyle).toBe(privacyStyle);
  });
});
