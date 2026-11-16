import assert from 'node:assert/strict';
import { sourcePrefixesSchema } from './github-schemas.mjs';

const extensions = Object.freeze({ web: ['ts','tsx','js','mjs','css'], swift: ['swift'], python: ['py'], static: ['html','css','js','mjs'], blocked: [] });
export function parseProfile(name, raw) {
  assert(Object.hasOwn(extensions,name), 'Unsupported profile.');
  const prefixes=sourcePrefixesSchema.parse(JSON.parse(raw));
  assert(name==='blocked' || prefixes.length>0, 'No approved source scope.');
  return {profile:name,prefixes};
}
export function sourcePath(path, profile, prefixes) {
  if(typeof path!=='string' || !extensions[profile]?.length || !Array.isArray(prefixes))return false;
  if(!/^[A-Za-z0-9_-][A-Za-z0-9_./-]*$/.test(path) || path.split('/').some(part=>!part || part.startsWith('.')))return false;
  if(!prefixes.some(prefix=>prefix.endsWith('/')?path.startsWith(prefix):path===prefix))return false;
  if(!extensions[profile].includes(path.split('.').at(-1)))return false;
  // Operational/security/payment/release policy is deliberately outside automatic edits.
  const normalized=path.replace(/([A-Z]+)([A-Z][a-z])/g,'$1-$2').replace(/([a-z0-9])([A-Z])/g,'$1-$2').toLowerCase();
  return !/(?:^|[./_-])(?:node_modules|oauth|sessions?|cookies?|secrets?|credentials?|config|secret-map|knob-map|auth(?:enticate|entication|orize|orization)?|billing|payments?|migrations?|vendor|generated|fixtures?|casks?|formula|infisical|storage|network|rotation)(?:[./_-]|$)/i.test(normalized);
}
export function assertSafeText(value) {
  // Defense in depth; the pinned independent gitleaks scan is also mandatory.
  const secret=/-----BEGIN (?:[A-Z ]*PRIVATE KEY)-----|\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16}|ASIA[A-Z0-9]{16})|https?:\/\/[^\s/:]+:[^\s/@]+@/;
  assert(typeof value==='string' && !secret.test(value),'Sensitive-looking content requires manual review.');
}
