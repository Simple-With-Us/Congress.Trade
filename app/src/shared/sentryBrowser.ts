/**
 * Public-web Sentry browser loader for Congress.Trade.
 *
 * The ingest DSN is public-by-design (same as NEXT_PUBLIC_ / VITE_ client
 * DSNs).  Never interpolates SENTRY_AUTH_TOKEN.  Designer 2026-09-04 update:
 * web session Replay defaults to 10%.  Error Replay is 100% masked.
 * Feedback is on unless SENTRY_FEEDBACK_ENABLED is an explicit falsy.
 *
 * Kill switches: SENTRY_BROWSER_ENABLED=false, SENTRY_FEEDBACK_ENABLED=false,
 * sample-rate env vars.  Unset SENTRY_DSN → empty string (CSP stays tight).
 */

import { readBuildInfo } from './buildInfo.ts';
import { renderSentryBrowserScrubInline } from './sentryBrowserScrubInline.ts';
import { NOT_LINKED_SENTRY_DATA_COLLECTION } from './sentryDataCollection.ts';
import { SENTRY_BROWSER_IGNORE_ERRORS } from './sentryNoise.ts';

export const SENTRY_BROWSER_SCRIPT_ORIGIN = 'https://browser.sentry-cdn.com';
export const SENTRY_BROWSER_BUNDLE =
  'https://browser.sentry-cdn.com/10.70.0/bundle.tracing.replay.feedback.min.js';

export type SentryBrowserInput = {
  SENTRY_DSN?: string;
  SENTRY_ENVIRONMENT?: string;
  SENTRY_BROWSER_ENABLED?: string;
  SENTRY_FEEDBACK_ENABLED?: string;
  SENTRY_REPLAY_SESSION_SAMPLE_RATE?: string;
  SENTRY_REPLAY_ERROR_SAMPLE_RATE?: string;
  SENTRY_TRACES_SAMPLE_RATE?: string;
  /** Coolify image SHA (`SOURCE_COMMIT` → `CT_BUILD_SHA`).  Browser release. */
  CT_BUILD_SHA?: string;
  SOURCE_COMMIT?: string;
  GIT_COMMIT_SHA?: string;
  GITHUB_SHA?: string;
};

export type SentryBrowserResolution =
  | { enabled: false }
  | {
    enabled: true;
    dsn: string;
    environment: string;
    scriptSrc: string;
    connectOrigin: string;
    tracesSampleRate: number;
    replaysSessionSampleRate: number;
    replaysOnErrorSampleRate: number;
    feedbackEnabled: boolean;
    /** Same Coolify SHA the Deno SDK uses, so browser events join the release. */
    release?: string;
  };

function jsonLiteral(value: string): string {
  return JSON.stringify(value);
}

function envFalsy(raw: string | undefined): boolean {
  return raw ? /^(false|0|off|no)$/i.test(raw.trim()) : false;
}

function clampRate(raw: string | undefined, fallback: number): number {
  if (raw == null || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.min(parsed, 1);
}

/** Ingest origin from a DSN.  No wildcards — CSP tests forbid `*`. */
export function sentryIngestOrigin(dsn: string): string | undefined {
  try {
    const url = new URL(dsn);
    if (!url.host) return undefined;
    return `${url.protocol}//${url.host}`;
  } catch {
    return undefined;
  }
}

export function resolveSentryBrowser(env: SentryBrowserInput | undefined): SentryBrowserResolution {
  const dsn = env?.SENTRY_DSN?.trim();
  if (!dsn) return { enabled: false };
  if (envFalsy(env?.SENTRY_BROWSER_ENABLED)) return { enabled: false };
  const connectOrigin = sentryIngestOrigin(dsn);
  if (!connectOrigin) return { enabled: false };
  const build = readBuildInfo(env);
  return {
    enabled: true,
    dsn,
    environment: env?.SENTRY_ENVIRONMENT?.trim() || 'production',
    scriptSrc: SENTRY_BROWSER_BUNDLE,
    connectOrigin,
    tracesSampleRate: clampRate(env?.SENTRY_TRACES_SAMPLE_RATE, 0.2),
    replaysSessionSampleRate: clampRate(env?.SENTRY_REPLAY_SESSION_SAMPLE_RATE, 0.1),
    replaysOnErrorSampleRate: clampRate(env?.SENTRY_REPLAY_ERROR_SAMPLE_RATE, 1),
    feedbackEnabled: !envFalsy(env?.SENTRY_FEEDBACK_ENABLED),
    ...(build.sha !== 'unknown' ? { release: build.sha } : {}),
  };
}

export function renderSentryBrowserScript(env: SentryBrowserInput | undefined): string {
  const resolved = resolveSentryBrowser(env);
  if (!resolved.enabled) return '';
  const init: Record<string, unknown> = {
    dsn: resolved.dsn,
    environment: resolved.environment,
    sendDefaultPii: false,
    dataCollection: NOT_LINKED_SENTRY_DATA_COLLECTION,
    tracesSampleRate: resolved.tracesSampleRate,
    replaysSessionSampleRate: resolved.replaysSessionSampleRate,
    replaysOnErrorSampleRate: resolved.replaysOnErrorSampleRate,
    enableLogs: true,
    ignoreErrors: SENTRY_BROWSER_IGNORE_ERRORS,
    ...(resolved.release ? { release: resolved.release } : {}),
  };
  const integrations: string[] = [
    'Sentry.browserTracingIntegration()',
    'Sentry.replayIntegration({maskAllText:true,blockAllMedia:true})',
  ];
  if (resolved.feedbackEnabled) {
    integrations.push(
      "Sentry.feedbackIntegration({colorScheme:'light',autoInject:false,showBranding:false,buttonLabel:'Report a Problem',submitButtonLabel:'Send',formTitle:'Report a Problem'})",
    );
  }
  // CONGRESS-TRADE-1H: `Sentry.init` builds a `replayIntegration()`, and the
  // Replay constructor THROWS "Multiple Sentry Session Replay instances are not
  // supported" the second time it runs on a page.  Two things can drive a
  // second run: the loader IIFE executing twice (the shell markup appearing
  // twice in one document, a bfcache/pjax-style re-injection, an extension or
  // proxy that re-evaluates inline scripts), and `n.onload` firing more than
  // once for a single tag.  Both are guarded here with window-scoped flags —
  // the injection guard stops a second <script> tag being appended at all, and
  // the init guard is the backstop for a double onload on the one tag we did
  // append.  The thrown error was unhandled, so it reached
  // `onerror` and became a production issue rather than a no-op.
  return [
    '<script>',
    '(function(){',
    'window.openSentryFeedback=window.openSentryFeedback||function(){try{var f=window.Sentry&&window.Sentry.getFeedback&&window.Sentry.getFeedback();if(f&&f.createForm){f.createForm().then(function(form){form.appendToDom();form.open();}).catch(function(){});}}catch(e){}};',
    'if(window.__ctSentryLoaderStarted)return;',
    'window.__ctSentryLoaderStarted=1;',
    'var n=document.createElement("script");',
    'n.async=1;n.crossOrigin="anonymous";',
    'n.src=' + jsonLiteral(resolved.scriptSrc) + ';',
    'n.onload=function(){',
    'if(window.__ctSentryInitialized)return;',
    'if(!window.Sentry)return;',
    'window.__ctSentryInitialized=1;',
    'var integrations=[' + integrations.join(',') + '];',
    'if(window.Sentry.consoleLoggingIntegration)integrations.push(window.Sentry.consoleLoggingIntegration({levels:["warn","error"]}));',
    renderSentryBrowserScrubInline(),
    'window.Sentry.init(Object.assign(' + JSON.stringify(init) + ',{integrations:integrations,'
    + 'beforeSend:function(e){return window.__ctScrubSentry(e);},'
    + 'beforeSendLog:function(l){return window.__ctScrubSentry(l);},'
    + 'beforeSendSpan:function(s){return window.__ctScrubSentry(s);},'
    + 'beforeSendMetric:function(m){return window.__ctScrubSentry(m);}'
    + '}));',
    '};',
    'document.head.appendChild(n);',
    '})();',
    '</script>',
  ].join('');
}
