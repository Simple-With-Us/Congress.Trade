/**
 * Shared Sentry event scrubbing.  Credential-bearing query params, headers,
 * account-linkable identifiers, and URL userinfo are replaced with
 * `[Filtered]` before an envelope is serialized.  Used by the Deno SDK,
 * Workers options factory, browser init hooks, and structured logs/metrics.
 */

export const SENTRY_FILTERED_VALUE = '[Filtered]';

const SENTRY_CREDENTIAL_KEYS = new Set([
  'apikey',
  'xapikey',
  'key',
  'token',
  'accesstoken',
  'authtoken',
  'authorization',
  'proxyauthorization',
  'clientsecret',
  'secret',
  'signature',
  'sig',
  'code',
  'password',
  'passwd',
  'session',
  'sessionid',
  'cookie',
  'setcookie',
]);

/** Field names that often carry account-linkable identifiers (normalized). */
const SENTRY_IDENTITY_KEYS = new Set([
  'userid',
  'user',
  'accountid',
  'account',
  'subscriptionid',
  'subscription',
  'subid',
  'originaltransactionid',
  'latesttransactionid',
  'transactionid',
  'txid',
  'clientid',
  'email',
  'ip',
  'ipaddress',
  'userip',
  'clientip',
  'remoteaddr',
  'xforwardedfor',
  'xrealip',
  'cfconnectingip',
  'trueclientip',
  'forwarded',
  'deviceid',
  'deviceidentifier',
  'idfa',
  'idfv',
  'stripecustomerid',
  'stripesubscriptionid',
  'appletransactionid',
  'requestid',
]);

const SENTRY_SENSITIVE_HEADER_KEYS = new Set([
  'cookie',
  'setcookie',
  'authorization',
  'proxyauthorization',
  'xforwardedfor',
  'xrealip',
  'cfconnectingip',
  'trueclientip',
  'forwarded',
  'xclientip',
  'xclusterclientip',
]);

const EMAIL_IN_TEXT = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const IPV4_IN_TEXT = /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\b/g;
const UUID_IN_TEXT = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const STRIPE_ID_IN_TEXT = /\b(?:cus|sub|pi|ch|in)_[A-Za-z0-9]{8,}\b/g;
const APPLE_TXN_IN_TEXT = /\b(?:otxn|txn)-[A-Za-z0-9_-]{6,}\b/gi;
const USER_PREFIXED_ID = /\buser:[A-Za-z0-9._-]{4,}\b/gi;

function normalizedSentryField(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isSentryCredentialField(value: string): boolean {
  return SENTRY_CREDENTIAL_KEYS.has(normalizedSentryField(value));
}

function isSentryIdentityField(value: string): boolean {
  const normalized = normalizedSentryField(value);
  if (SENTRY_IDENTITY_KEYS.has(normalized)) return true;
  if (normalized.endsWith('id') && normalized.length > 2 && normalized !== 'grid') {
    return normalized.includes('user')
      || normalized.includes('subscription')
      || normalized.includes('transaction')
      || normalized.includes('account')
      || normalized.includes('client')
      || normalized.includes('device');
  }
  return false;
}

function shouldRedactFieldKey(key: string, fieldPath = ''): boolean {
  const normalized = normalizedSentryField(key);
  const path = normalizedSentryField(fieldPath);
  if (normalized === 'id' && (path.includes('device') || path.includes('user'))) return true;
  return isSentryCredentialField(key)
    || isSentryIdentityField(key)
    || SENTRY_SENSITIVE_HEADER_KEYS.has(normalized);
}

export function scrubSentryFreeText(text: string): string {
  let out = text;
  out = out.replace(EMAIL_IN_TEXT, SENTRY_FILTERED_VALUE);
  out = out.replace(IPV4_IN_TEXT, SENTRY_FILTERED_VALUE);
  out = out.replace(UUID_IN_TEXT, SENTRY_FILTERED_VALUE);
  out = out.replace(STRIPE_ID_IN_TEXT, SENTRY_FILTERED_VALUE);
  out = out.replace(APPLE_TXN_IN_TEXT, SENTRY_FILTERED_VALUE);
  out = out.replace(USER_PREFIXED_ID, `user:${SENTRY_FILTERED_VALUE}`);
  return out.replace(/https?:\/\/[^\s<>"']+/gi, (url) => redactSentryUrl(url));
}

function redactSentryQuery(query: string): string {
  const prefix = query.startsWith('?') ? '?' : '';
  const raw = prefix ? query.slice(1) : query;
  if (!raw.includes('=')) return query;
  const params = new URLSearchParams(raw);
  let changed = false;
  for (const key of [...params.keys()]) {
    if (!isSentryCredentialField(key) && !isSentryIdentityField(key)) continue;
    params.set(key, SENTRY_FILTERED_VALUE);
    changed = true;
  }
  return changed ? `${prefix}${params.toString()}` : query;
}

/** Public member/ticker route slugs (kebab-case); not opaque account identifiers. */
function isPublicKebabRouteSlug(segment: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(segment);
}

function looksLikeOpaquePathToken(segment: string): boolean {
  if (segment.length < 20) return false;
  if (isPublicKebabRouteSlug(segment)) return false;
  return /^[A-Za-z0-9_]{20,}$/.test(segment);
}

function redactIdentifierPathSegments(pathname: string): string {
  const segments = pathname.split('/');
  let changed = false;
  const redacted = segments.map((segment) => {
    if (!segment) return segment;
    if (UUID_IN_TEXT.test(segment)) {
      changed = true;
      UUID_IN_TEXT.lastIndex = 0;
      return SENTRY_FILTERED_VALUE;
    }
    if (looksLikeOpaquePathToken(segment)) {
      changed = true;
      return SENTRY_FILTERED_VALUE;
    }
    if (STRIPE_ID_IN_TEXT.test(segment)) {
      changed = true;
      STRIPE_ID_IN_TEXT.lastIndex = 0;
      return SENTRY_FILTERED_VALUE;
    }
    if (APPLE_TXN_IN_TEXT.test(segment)) {
      changed = true;
      APPLE_TXN_IN_TEXT.lastIndex = 0;
      return SENTRY_FILTERED_VALUE;
    }
    return segment;
  });
  return changed ? redacted.join('/') : pathname;
}

function redactSentryUrl(urlString: string): string {
  try {
    const url = new URL(urlString);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return urlString;
    let changed = false;
    if (url.username || url.password) {
      url.username = SENTRY_FILTERED_VALUE;
      url.password = SENTRY_FILTERED_VALUE;
      changed = true;
    }
    const nextPath = redactIdentifierPathSegments(url.pathname);
    if (nextPath !== url.pathname) {
      url.pathname = nextPath;
      changed = true;
    }
    for (const key of [...url.searchParams.keys()]) {
      if (!isSentryCredentialField(key) && !isSentryIdentityField(key)) continue;
      url.searchParams.set(key, SENTRY_FILTERED_VALUE);
      changed = true;
    }
    return changed ? url.toString() : urlString;
  } catch {
    return urlString;
  }
}

function isSentryKeyValueCollection(field: string): boolean {
  const normalized = normalizedSentryField(field);
  return normalized.includes('query') || normalized.includes('header');
}

function scrubSentryKeyValueTuple(tuple: unknown[], field: string): unknown[] {
  if (tuple.length < 2 || typeof tuple[0] !== 'string') {
    return tuple.map((item) => scrubSentryValue(item, field));
  }
  const [key, child, ...rest] = tuple;
  const childField = field ? `${field}.${key}` : key;
  return [
    key,
    shouldRedactFieldKey(key, childField)
      ? SENTRY_FILTERED_VALUE
      : scrubSentryValue(child, childField),
    ...rest.map((item) => scrubSentryValue(item, field)),
  ];
}

export function scrubSentryValue(value: unknown, field = ''): unknown {
  if (typeof value === 'string') {
    if (shouldRedactFieldKey(field, field)) return SENTRY_FILTERED_VALUE;
    const normalized = normalizedSentryField(field);
    if (normalized.includes('query')) return redactSentryQuery(value);
    if (normalized.includes('url') || /^https?:\/\//i.test(value)) {
      return redactSentryUrl(value);
    }
    return scrubSentryFreeText(value);
  }
  if (Array.isArray(value)) {
    if (!isSentryKeyValueCollection(field)) {
      return value.map((item) => scrubSentryValue(item, field));
    }
    if (value.length >= 2 && typeof value[0] === 'string') {
      return scrubSentryKeyValueTuple(value, field);
    }
    return value.map((item) => (
      Array.isArray(item)
        ? scrubSentryKeyValueTuple(item, field)
        : scrubSentryValue(item, field)
    ));
  }
  if (value && typeof value === 'object') {
    const scrubbed: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const childField = field ? `${field}.${key}` : key;
      scrubbed[key] = shouldRedactFieldKey(key, childField)
        ? SENTRY_FILTERED_VALUE
        : scrubSentryValue(child, childField);
    }
    return scrubbed;
  }
  return value;
}

export function scrubSentryEvent<T>(event: T): T {
  return scrubSentryValue(event) as T;
}

/** Inputs for the browser loader's inline scrub IIFE (must match shouldRedactFieldKey / scrubSentryFreeText). */
export const SENTRY_BROWSER_SCRUB_CODEGEN = {
  filteredValue: SENTRY_FILTERED_VALUE,
  credentialKeys: [...SENTRY_CREDENTIAL_KEYS],
  identityKeys: [...SENTRY_IDENTITY_KEYS],
  sensitiveHeaderKeys: [...SENTRY_SENSITIVE_HEADER_KEYS],
  textPatterns: {
    email: EMAIL_IN_TEXT.source,
    ipv4: IPV4_IN_TEXT.source,
    uuid: UUID_IN_TEXT.source,
    stripeId: STRIPE_ID_IN_TEXT.source,
    appleTxn: APPLE_TXN_IN_TEXT.source,
    userPrefixedId: USER_PREFIXED_ID.source,
  },
} as const;

export function scrubSentryLogAttributes(
  attributes?: Record<string, string | number | boolean | null>,
): Record<string, string | number | boolean | null> | undefined {
  if (!attributes) return undefined;
  return scrubSentryValue(attributes) as Record<string, string | number | boolean | null>;
}
