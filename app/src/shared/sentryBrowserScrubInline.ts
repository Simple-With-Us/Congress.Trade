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
  const urlInText = 'https?:\\/\\/[^\\s<>"\']+';
  return (
    'var F=' + jsonLiteral(cfg.filteredValue) + ';'
    + 'var CRED=new Set(' + JSON.stringify(cfg.credentialKeys) + ');'
    + 'var IDENT=new Set(' + JSON.stringify(identityKeys) + ');'
    + 'function norm(k){return String(k||"").toLowerCase().replace(/[^a-z0-9]/g,"");}'
    + 'function shouldRedactKey(key,fieldPath){var n=norm(key);var p=norm(fieldPath||"");'
    + 'if(n==="id"&&(p.indexOf("device")>=0||p.indexOf("user")>=0))return true;'
    + 'if(CRED.has(n)||IDENT.has(n))return true;if(n.indexOf("transaction")>=0)return true;'
    + 'if(n.length>2&&n.slice(-2)==="id"&&n!=="grid"&&(n.indexOf("user")>=0||n.indexOf("subscription")>=0||n.indexOf("transaction")>=0||n.indexOf("account")>=0||n.indexOf("client")>=0||n.indexOf("device")>=0))return true;'
    + 'return false;}'
    + 'function isPubSlug(seg){return /^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(seg);}'
    + 'function opaqueTok(seg){if(seg.length<20)return false;if(isPubSlug(seg))return false;return /^[A-Za-z0-9_]{20,}$/.test(seg);}'
    + 'function redactPath(pathname){var parts=pathname.split("/"),ch=false;'
    + 'var out=parts.map(function(seg){if(!seg)return seg;'
    + 'if(/' + p.uuid + '/i.test(seg)){ch=true;return F;}'
    + 'if(opaqueTok(seg)){ch=true;return F;}'
    + 'if(/' + p.stripeId + '/.test(seg)){ch=true;return F;}'
    + 'if(/' + p.appleTxn + '/i.test(seg)){ch=true;return F;}'
    + 'return seg;});return ch?out.join("/"):pathname;}'
    + 'function redactUrl(u){try{var url=new URL(u);'
    + 'if(url.protocol!=="http:"&&url.protocol!=="https:")return u;var ch=false;'
    + 'if(url.username||url.password){url.username=F;url.password=F;ch=true;}'
    + 'var np=redactPath(url.pathname);if(np!==url.pathname){url.pathname=np;ch=true;}'
    + 'var qkeys=[];url.searchParams.forEach(function(v,k){qkeys.push(k);});'
    + 'for(var qi=0;qi<qkeys.length;qi++){var qk=qkeys[qi];if(shouldRedactKey(qk,qk)){url.searchParams.set(qk,F);ch=true;}}'
    + 'return ch?url.toString():u;}catch(e){return u;}}'
    + 'function redactQuery(q){var pre=q.startsWith("?")?"?":"";var raw=pre?q.slice(1):q;'
    + 'if(raw.indexOf("=")<0)return q;var params=new URLSearchParams(raw),ch=false,qkeys=[];'
    + 'params.forEach(function(v,k){qkeys.push(k);});'
    + 'for(var qi=0;qi<qkeys.length;qi++){var qk=qkeys[qi];if(shouldRedactKey(qk,qk)){params.set(qk,F);ch=true;}}'
    + 'return ch?pre+params.toString():q;}'
    + 'function scrubFreeText(s){return s.replace(/' + p.email + '/gi,F).replace(/' + p.ipv4 + '/g,F).replace(/' + p.uuid + '/gi,F)'
    + '.replace(/' + p.stripeId + '/g,F).replace(/' + p.appleTxn + '/gi,F).replace(/' + p.userPrefixedId + '/gi,"user:"+F)'
    + '.replace(/' + urlInText + '/gi,function(u){return redactUrl(u);});}'
    + 'function scrubStr(s,f){if(typeof s!=="string")return s;if(shouldRedactKey(f,f))return F;var nf=norm(f);'
    + 'if(nf.indexOf("query")>=0)return redactQuery(s);'
    + 'if(nf.indexOf("url")>=0||/^https?:\\/\\//i.test(s))return redactUrl(s);return scrubFreeText(s);}'
    + 'function isKvCol(f){var n=norm(f);return n.indexOf("query")>=0||n.indexOf("header")>=0;}'
    + 'function scrubKvTuple(tuple,f){if(tuple.length<2||typeof tuple[0]!=="string")return tuple.map(function(i){return scrub(i,f);});'
    + 'var key=tuple[0],childField=f?f+"."+key:key;'
    + 'return [key,shouldRedactKey(key,childField)?F:scrub(tuple[1],childField)].concat(tuple.slice(2).map(function(i){return scrub(i,f);}));}'
    + 'function scrub(v,f){if(v==null)return v;if(typeof v==="string")return scrubStr(v,f);'
    + 'if(Array.isArray(v)){if(!isKvCol(f))return v.map(function(i){return scrub(i,f);});'
    + 'if(v.length>=2&&typeof v[0]==="string")return scrubKvTuple(v,f);'
    + 'return v.map(function(i){return Array.isArray(i)?scrubKvTuple(i,f):scrub(i,f);});}'
    + 'if(typeof v==="object"){var o={};for(var k in v){if(Object.prototype.hasOwnProperty.call(v,k)){var cp=f?f+"."+k:k;'
    + 'o[k]=shouldRedactKey(k,cp)?F:scrub(v[k],cp);}}return o;}return v;}'
    + 'window.__ctScrubSentry=function(p){return scrub(p,"");};'
  );
}
