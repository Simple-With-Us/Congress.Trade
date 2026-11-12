/**
 * Public-web Datadog RUM snippet.  Client token + application id are designed
 * to be public.  Never interpolates `DD_API_KEY`.  Session Replay stays off
 * (extra spend).  Partial or missing RUM keys return an empty string.
 */

import type { DatadogRumResolution } from './datadogRuntime.ts';

export const DATADOG_RUM_SCRIPT_ORIGIN = 'https://www.datadoghq-browser-agent.com';

function jsonLiteral(value: string): string {
  return JSON.stringify(value);
}

export function renderDatadogRumScript(rum: DatadogRumResolution): string {
  if (!rum.enabled) return '';
  const init = {
    clientToken: rum.clientToken,
    applicationId: rum.applicationId,
    site: rum.site,
    service: rum.service,
    env: rum.env,
    ...(rum.version ? { version: rum.version } : {}),
    sessionSampleRate: 20,
    sessionReplaySampleRate: 0,
    defaultPrivacyLevel: 'mask-user-input',
    trackUserInteractions: true,
    trackResources: true,
    trackLongTasks: true,
  };
  return [
    '<script>',
    '(function(h,o,u,n,d){',
    'h=h[d]=h[d]||{q:[],onReady:function(c){h.q.push(c)}};',
    'n=o.createElement(u);n.async=1;n.src=' + jsonLiteral(rum.scriptSrc) + ';',
    'd=o.getElementsByTagName(u)[0];d.parentNode.insertBefore(n,d);',
    "})(window,document,'script','datadogRum','DD_RUM');",
    'window.DD_RUM.onReady(function(){',
    'window.DD_RUM.init(' + JSON.stringify(init) + ');',
    '});',
    '</script>',
  ].join('');
}
