/**
 * src/ui/__tests__/appLinks.test.ts
 *
 * WEB half of iOS Universal Links (see src/ui/appLinks.ts). Confirms:
 *   - the AASA manifest is served at the exact path iOS fetches, as real
 *     JSON, with the exact App ID, matching member/ticker/trade/view, and
 *     with /auth/* excluded so ASWebAuthenticationSession sign-in survives.
 *   - the Smart App Banner meta tag is absent until an App Store id is
 *     configured, and appears once one is.
 */

import { describe, it, expect } from 'vitest';
import { buildUiRouter } from '../routes.ts';
import {
  AASA_JSON,
  appStoreBannerTag,
  appStoreBannerHeadExtras,
  appStoreBannerMarkup,
} from '../appLinks.ts';

describe('apple-app-site-association route', () => {
  it('serves the AASA manifest with no redirect, no auth, application/json', async () => {
    const app = buildUiRouter();
    const res = await app.request(
      'http://localhost/.well-known/apple-app-site-association',
      {},
      {} as never,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    // No auth challenge, no redirect status.
    expect(res.headers.get('location')).toBeNull();
  });

  it('body parses as JSON and matches the exported AASA_JSON constant exactly', async () => {
    const app = buildUiRouter();
    const res = await app.request(
      'http://localhost/.well-known/apple-app-site-association',
      {},
      {} as never,
    );
    const text = await res.text();
    expect(() => JSON.parse(text)).not.toThrow();
    expect(text).toBe(AASA_JSON);
  });

  it('declares the exact CC8UTF7ATG.trade.congress.ios App ID', async () => {
    const doc = JSON.parse(AASA_JSON);
    expect(doc.applinks.details[0].appIDs).toEqual(['CC8UTF7ATG.trade.congress.ios']);
  });

  it('matches member, ticker, trade, and view query components', () => {
    const doc = JSON.parse(AASA_JSON);
    const components: Array<Record<string, unknown>> = doc.applinks.details[0].components;
    for (const key of ['member', 'ticker', 'trade', 'view']) {
      const match = components.find(
        (c) => c['/'] === '/' && (c['?'] as Record<string, unknown> | undefined)?.[key] === '?*',
      );
      expect(match, `expected a component matching ?${key}=`).toBeTruthy();
    }
  });

  it('excludes /auth/* so ASWebAuthenticationSession sign-in keeps working', () => {
    const doc = JSON.parse(AASA_JSON);
    const components: Array<Record<string, unknown>> = doc.applinks.details[0].components;
    const authExclude = components.find((c) => c['/'] === '/auth/*');
    expect(authExclude).toBeTruthy();
    expect(authExclude?.exclude).toBe(true);
  });

  it('excludes /api/* so the JSON API is never captured as a universal link', () => {
    const doc = JSON.parse(AASA_JSON);
    const components: Array<Record<string, unknown>> = doc.applinks.details[0].components;
    const apiExclude = components.find((c) => c['/'] === '/api/*');
    expect(apiExclude).toBeTruthy();
    expect(apiExclude?.exclude).toBe(true);
  });

  it('does not serve a legacy unprefixed root-level copy', async () => {
    const app = buildUiRouter();
    const res = await app.request('http://localhost/apple-app-site-association', {}, {} as never);
    expect(res.status).toBe(404);
  });
});

describe('Smart App Banner meta tag', () => {
  it('appStoreBannerTag returns null when IOS_APP_STORE_ID is unset', () => {
    expect(appStoreBannerTag({} as never)).toBeNull();
  });

  it('appStoreBannerTag returns null for a non-numeric value', () => {
    expect(appStoreBannerTag({ IOS_APP_STORE_ID: 'not-a-real-id' } as never)).toBeNull();
  });

  it('appStoreBannerTag returns the meta tag for a configured numeric id', () => {
    const tag = appStoreBannerTag({ IOS_APP_STORE_ID: '1234567890' } as never);
    expect(tag).toBe('<meta name="apple-itunes-app" content="app-id=1234567890" />');
  });

  it('the served dashboard HTML omits the banner meta when no id is configured', async () => {
    const app = buildUiRouter();
    const html = await (await app.request('http://localhost/', {}, {} as never)).text();
    expect(html).not.toContain('apple-itunes-app');
  });

  it('the served dashboard HTML includes the banner meta once an id is configured', async () => {
    const app = buildUiRouter();
    const html = await (
      await app.request('http://localhost/', {}, { IOS_APP_STORE_ID: '1234567890' } as never)
    ).text();
    expect(html).toContain('<meta name="apple-itunes-app" content="app-id=1234567890" />');
  });

  it('the /admin entry point also gets the banner meta once configured', async () => {
    const app = buildUiRouter();
    const html = await (
      await app.request('http://localhost/admin', {}, { IOS_APP_STORE_ID: '1234567890' } as never)
    ).text();
    expect(html).toContain('<meta name="apple-itunes-app" content="app-id=1234567890" />');
  });
});

describe('custom App Store banner (reuses the same IOS_APP_STORE_ID switch)', () => {
  it('appStoreBannerHeadExtras returns null when IOS_APP_STORE_ID is unset', () => {
    expect(appStoreBannerHeadExtras({} as never)).toBeNull();
  });

  it('appStoreBannerHeadExtras returns null for a non-numeric value', () => {
    expect(appStoreBannerHeadExtras({ IOS_APP_STORE_ID: 'not-a-real-id' } as never)).toBeNull();
  });

  it('appStoreBannerMarkup returns null when IOS_APP_STORE_ID is unset', () => {
    expect(appStoreBannerMarkup({} as never)).toBeNull();
  });

  it('appStoreBannerMarkup returns null for a non-numeric value', () => {
    expect(appStoreBannerMarkup({ IOS_APP_STORE_ID: 'not-a-real-id' } as never)).toBeNull();
  });

  it('the served dashboard HTML has NO custom-banner markup, CSS, or JS when no id is configured', async () => {
    const app = buildUiRouter();
    const html = await (await app.request('http://localhost/', {}, {} as never)).text();
    expect(html).not.toContain('app-store-banner');
    expect(html).not.toContain('asb-dismissed-v1');
    expect(html).not.toContain('asb-native-context');
  });

  it('the served dashboard HTML includes the custom banner markup once an id is configured', async () => {
    const app = buildUiRouter();
    const html = await (
      await app.request('http://localhost/', {}, { IOS_APP_STORE_ID: '1234567890' } as never)
    ).text();
    expect(html).toContain('id="app-store-banner"');
    expect(html).toContain('Congress.Trade');
  });

  it('the CTA href contains the configured App Store id', () => {
    const markup = appStoreBannerMarkup({ IOS_APP_STORE_ID: '1234567890' } as never)!;
    expect(markup).toContain('href="https://apps.apple.com/app/id1234567890"');
  });

  it('the close control is a real <button> with an accessible name', () => {
    const markup = appStoreBannerMarkup({ IOS_APP_STORE_ID: '1234567890' } as never)!;
    expect(markup).toMatch(/<button[^>]*aria-label="Dismiss App Store banner"/);
  });

  it('banner gates do not default to the released App Store id', () => {
    expect(appStoreBannerTag({} as never)).toBeNull();
    expect(appStoreBannerHeadExtras({} as never)).toBeNull();
    expect(appStoreBannerMarkup({} as never)).toBeNull();
    // Banner visibility and destination still use the request's configured id;
    // the released install fallback does not turn banners on by default.
    const markup = appStoreBannerMarkup({ IOS_APP_STORE_ID: '1111111111' } as never)!;
    expect(markup).not.toContain('6798076688');
  });

  it('reuses appStoreBannerTag\'s exact id validation --- no second switch', () => {
    // Same malformed input must be rejected identically by all three gates.
    const env = { IOS_APP_STORE_ID: '123abc' } as never;
    expect(appStoreBannerTag(env)).toBeNull();
    expect(appStoreBannerHeadExtras(env)).toBeNull();
    expect(appStoreBannerMarkup(env)).toBeNull();
  });

  it('the CTA is a real <a href> link, not a script-driven navigation', () => {
    const markup = appStoreBannerMarkup({ IOS_APP_STORE_ID: '1234567890' } as never)!;
    expect(markup).toMatch(/<a class="asb-cta" href="https:\/\/apps\.apple\.com\/app\/id1234567890"[^>]*>View<\/a>/);
  });

  it('the /admin entry point also gets the custom banner once configured', async () => {
    const app = buildUiRouter();
    const html = await (
      await app.request('http://localhost/admin', {}, { IOS_APP_STORE_ID: '1234567890' } as never)
    ).text();
    expect(html).toContain('id="app-store-banner"');
  });

  it('the custom banner markup precedes <header class="top"> so it renders above the header', async () => {
    const app = buildUiRouter();
    const html = await (
      await app.request('http://localhost/', {}, { IOS_APP_STORE_ID: '1234567890' } as never)
    ).text();
    const bannerIdx = html.indexOf('id="app-store-banner"');
    const headerIdx = html.indexOf('<header class="top">');
    expect(bannerIdx).toBeGreaterThan(-1);
    expect(headerIdx).toBeGreaterThan(-1);
    expect(bannerIdx).toBeLessThan(headerIdx);
  });
});
