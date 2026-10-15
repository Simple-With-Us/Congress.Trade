import { SENTRY_BROWSER_SCRUB_CODEGEN } from './sentryScrub.ts';

function jsonLiteral(value: string): string {
  return JSON.stringify(value);
}

/** Minified scrub helpers injected into the public Sentry browser loader script. */
export function renderSentryBrowserScrubInline(): string {
  const cfg = SENTRY_BROWSER_SCRUB_CODEGEN;
  const identityKeys = [
    ...new Set([...cfg.identityKeys, ...cfg.sensitiveHeaderKeys]),
  ];
  const p = cfg.textPatterns;
  return (
    'var F=' + jsonLiteral(cfg.filteredValue) + ';'
    + 'var CRED=new Set(' + JSON.stringify(cfg.credentialKeys) + ');'
    + 'var IDENT=new Set(' + JSON.stringify(identityKeys) + ');'
    + 'function norm(k){return String(k||"").toLowerCase().replace(/[^a-z0-9]/g,"");}'
    + 'function redactKey(k){var n=norm(k);if(CRED.has(n)||IDENT.has(n))return true;'
    + 'if(n.indexOf("transaction")>=0)return true;'
    + 'if(n.length>2&&n.slice(-2)==="id"&&n!=="grid"&&(n.indexOf("user")>=0||n.indexOf("subscription")>=0||n.indexOf("transaction")>=0||n.indexOf("account")>=0||n.indexOf("client")>=0||n.indexOf("device")>=0))return true;'
    + 'return false;}'
    + 'function scrubStr(s,f){if(typeof s!=="string")return s;if(redactKey(f))return F;'
    + 'return s.replace(/' + p.email + '/gi,F).replace(/' + p.ipv4 + '/g,F).replace(/' + p.uuid + '/gi,F)'
    + '.replace(/' + p.stripeId + '/g,F).replace(/' + p.appleTxn + '/gi,F).replace(/' + p.userPrefixedId + '/gi,"user:"+F);}'
    + 'function scrub(v,f){if(v==null)return v;if(typeof v==="string")return scrubStr(v,f);'
    + 'if(Array.isArray(v))return v.map(function(i){return scrub(i,f);});'
    + 'if(typeof v==="object"){var o={};for(var k in v){if(Object.prototype.hasOwnProperty.call(v,k))o[k]=redactKey(k)?F:scrub(v[k],k);}return o;}return v;}'
    + 'window.__ctScrubSentry=function(p){return scrub(p,"");};'
  );
}
