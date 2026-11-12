import { describe, expect, it } from 'vitest';
import {
  renderSentryBrowserScript,
  resolveSentryBrowser,
  sentryIngestOrigin,
  SENTRY_BROWSER_SCRIPT_ORIGIN,
} from '../sentryBrowser.ts';
import { SENTRY_FILTERED_VALUE } from '../sentryScrub.ts';

const DSN = 'https://key@o1.ingest.us.sentry.io/1';

function loadBrowserScrubFromScript(html: string): (payload: unknown) => unknown {
  const body = html.replace(/^<script>/, '').replace(/<\/script>$/, '');
  const sentry = {
    init: () => {},
    browserTracingIntegration: () => ({}),
    replayIntegration: () => ({}),
    feedbackIntegration: () => ({}),
    consoleLoggingIntegration: () => ({}),
  };
  const win: Record<string, unknown> = { Sentry: sentry };
  const tags: Array<{ onload?: () => void }> = [];
  const doc = {
    createElement: () => {
      const tag: { onload?: () => void } = {};
      tags.push(tag);
      return tag;
    },
    head: { appendChild: () => {} },
  };
  const run = new Function('window', 'document', 'Sentry', body);
  run(win, doc, sentry);
  tags[0].onload?.();
  const scrub = win.__ctScrubSentry;
  if (typeof scrub !== 'function') {
    throw new Error('browser scrub hook missing from loader');
  }
  return scrub as (payload: unknown) => unknown;
}

describe('sentry browser loader', () => {
  it('stays dark without a DSN', () => {
    expect(resolveSentryBrowser({}).enabled).toBe(false);
    expect(resolveSentryBrowser(undefined).enabled).toBe(false);
    expect(renderSentryBrowserScript({})).toBe('');
    expect(renderSentryBrowserScript(undefined)).toBe('');
  });

  it('honors SENTRY_BROWSER_ENABLED=false', () => {
    expect(resolveSentryBrowser({ SENTRY_DSN: DSN, SENTRY_BROWSER_ENABLED: 'false' }).enabled).toBe(
      false,
    );
  });

  it('defaults session Replay to 0.1 and error Replay to 1 with Feedback on', () => {
    const resolved = resolveSentryBrowser({ SENTRY_DSN: DSN });
    expect(resolved.enabled).toBe(true);
    if (!resolved.enabled) return;
    expect(resolved.replaysSessionSampleRate).toBe(0.1);
    expect(resolved.replaysOnErrorSampleRate).toBe(1);
    expect(resolved.feedbackEnabled).toBe(true);
    expect(resolved.connectOrigin).toBe('https://o1.ingest.us.sentry.io');
    expect(resolved.scriptSrc.startsWith(SENTRY_BROWSER_SCRIPT_ORIGIN)).toBe(true);
    const html = renderSentryBrowserScript({ SENTRY_DSN: DSN });
    expect(html).toContain('replaysSessionSampleRate":0.1');
    expect(html).toContain('feedbackIntegration');
    expect(html).toContain('autoInject:false');
    expect(html).toContain("formTitle:'Report a Problem'");
    expect(html).toContain('window.openSentryFeedback=window.openSentryFeedback||function');
    expect(html).toContain('maskAllText:true');
    expect(html).toContain('"enableLogs":true');
    expect(html).toContain('ignoreErrors');
    expect(html).toContain('Unexpected end of input');
    expect(html).toContain('consoleLoggingIntegration');
    expect(html).not.toContain('"release"');
  });

  it('tags the Coolify image SHA as the browser release so events join the Deno release', () => {
    const sha = '94a3a921f0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5';
    const resolved = resolveSentryBrowser({ SENTRY_DSN: DSN, CT_BUILD_SHA: sha });
    expect(resolved.enabled).toBe(true);
    if (!resolved.enabled) return;
    expect(resolved.release).toBe(sha);
    const html = renderSentryBrowserScript({ SENTRY_DSN: DSN, SOURCE_COMMIT: sha });
    expect(html).toContain(`"release":"${sha}"`);
  });

  // CONGRESS-TRADE-1H.  Replay's constructor throws on a second instance, so a
  // loader that runs twice took down the page's error handler with
  // "Multiple Sentry Session Replay instances are not supported".
  it('initialises Sentry at most once even if the loader and onload both run twice', () => {
    const html = renderSentryBrowserScript({ SENTRY_DSN: DSN });
    const body = html.replace(/^<script>/, '').replace(/<\/script>$/, '');

    let initCalls = 0;
    let appended = 0;
    const tags: Array<{ onload?: () => void }> = [];
    // The emitted integrations read the bare `Sentry` global, so the sandbox
    // has to supply it under both names the script uses.
    const sentry = {
      init: () => {
        initCalls += 1;
      },
      browserTracingIntegration: () => ({}),
      replayIntegration: () => ({}),
      feedbackIntegration: () => ({}),
      consoleLoggingIntegration: () => ({}),
    };
    const win: Record<string, unknown> = { Sentry: sentry };
    const doc = {
      createElement: () => {
        const tag: { onload?: () => void } = {};
        tags.push(tag);
        return tag;
      },
      head: {
        appendChild: () => {
          appended += 1;
        },
      },
    };

    const run = new Function('window', 'document', 'Sentry', body);
    run(win, doc, sentry);
    run(win, doc, sentry);

    // Only one <script> tag is ever appended, however many times the inline
    // loader is evaluated.
    expect(appended).toBe(1);
    expect(tags).toHaveLength(1);

    // And a double onload on that one tag still initialises exactly once.
    tags[0].onload?.();
    tags[0].onload?.();
    expect(initCalls).toBe(1);
  });

  it('parses ingest origin without wildcards', () => {
    expect(sentryIngestOrigin(DSN)).toBe('https://o1.ingest.us.sentry.io');
    expect(sentryIngestOrigin('not-a-url')).toBeUndefined();
  });

  it('scrubs credential keys, identity fields, and free-text identifiers before send', () => {
    const scrub = loadBrowserScrubFromScript(renderSentryBrowserScript({ SENTRY_DSN: DSN }));
    const email = 'operator@example.com';
    const ip = '203.0.113.42';
    const subscriptionId = 'sub_1QwErTyUiOpAsDfG';
    const uuid = '9f3c2a1b-4e5d-4789-abcd-ef0123456789';
    const appleTxn = 'otxn-anon-export-12345';

    const scrubbed = scrub({
      authorization: 'Bearer deadbeef',
      apiKey: 'sk_live_abc',
      cookie: 'session=deadbeef',
      userId: 'user-abc',
      message: `notify ${email} sub ${subscriptionId} from ${ip} uuid ${uuid} ${appleTxn} user:user-abc-1234`,
    }) as Record<string, unknown>;

    expect(scrubbed.authorization).toBe(SENTRY_FILTERED_VALUE);
    expect(scrubbed.apiKey).toBe(SENTRY_FILTERED_VALUE);
    expect(scrubbed.cookie).toBe(SENTRY_FILTERED_VALUE);
    expect(scrubbed.userId).toBe(SENTRY_FILTERED_VALUE);
    const message = String(scrubbed.message);
    expect(message).not.toContain(email);
    expect(message).not.toContain(ip);
    expect(message).not.toContain(subscriptionId);
    expect(message).not.toContain(uuid);
    expect(message).not.toContain(appleTxn);
    expect(message).toContain(SENTRY_FILTERED_VALUE);
  });

  it('redacts URL query params and path-aware nested id like the Deno scrubber', () => {
    const scrub = loadBrowserScrubFromScript(renderSentryBrowserScript({ SENTRY_DSN: DSN }));
    const opaque = 'abcdefghijklmnopqrstuvwxyz123456';
    const url = `https://congress.trade/api/stream?subscription=${opaque}&chamber=senate`;

    const scrubbed = scrub({
      breadcrumbs: [{
        data: { url },
      }],
      device: { id: 'device-token-leak' },
    }) as {
      breadcrumbs: Array<{ data: { url: string } }>;
      device: { id: string };
    };

    const scrubbedUrl = scrubbed.breadcrumbs[0].data.url;
    expect(scrubbedUrl).not.toContain(opaque);
    expect(scrubbedUrl.includes(SENTRY_FILTERED_VALUE) || scrubbedUrl.includes('%5BFiltered%5D')).toBe(
      true,
    );
    expect(scrubbed.device.id).toBe(SENTRY_FILTERED_VALUE);
  });
});
