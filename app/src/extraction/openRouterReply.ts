/**
 * Classify an OpenRouter HTTP response or completion so a garbage /
 * Unauthorized *reply* cannot latch the whole extract pipeline.
 *
 * Proven dead-key rejections (invalid_api_key, User not found) stay
 * fail-closed.  Bare 401 Unauthorized, HTML, letterhead, and empty /
 * non-JSON completions are document-scoped: cheap-retry once on the
 * text path, then skip that doc.  Never treat those as a pipeline halt.
 */

import {
  looksLikeHeaderContaminatedAsset,
  looksLikePlausibleTradeTable,
} from './extractRouting.ts';

export type OpenRouterReplyKind =
  | 'ok'
  | 'proven_auth'
  | 'unauth_reply'
  | 'garbage'
  | 'billing'
  | 'quota'
  | 'rate_limit'
  | 'timeout'
  | 'other';

export const DOC_SCOPED_OPENROUTER_KINDS = ['unauth_reply', 'garbage'] as const;

export type DocScopedOpenRouterKind = typeof DOC_SCOPED_OPENROUTER_KINDS[number];

const REPLY_MARKER = 'openRouterReply:';

export function isDocScopedOpenRouterReply(
  kind: OpenRouterReplyKind,
): kind is DocScopedOpenRouterKind {
  return kind === 'unauth_reply' || kind === 'garbage';
}

export function isProvenOpenRouterCredentialRejection(message: string): boolean {
  const lower = message.trim().toLowerCase();
  if (!lower) return false;
  return (
    lower.includes('invalid_api_key')
    || lower.includes('invalid api key')
    || lower.includes('api key not configured')
    || lower.includes('rejected the configured credential')
    || lower.includes('authentication_error')
    || lower.includes('authentication failed')
    || (lower.includes('user not found')
      && (/\b401\b/.test(lower) || lower.includes('openrouter')))
  );
}

export function isDocScopedOpenRouterError(error: string | null | undefined): boolean {
  const message = (error ?? '').trim();
  if (!message) return false;
  if (isProvenOpenRouterCredentialRejection(message)) return false;
  const lower = message.toLowerCase();
  const looksOpenRouter = lower.includes('openrouter') || lower.includes('openrouterreply:');
  if (!looksOpenRouter) return false;
  return isDocScopedOpenRouterReply(classifyOpenRouterErrorMessage(message));
}

export function docScopedOpenRouterError(
  kind: DocScopedOpenRouterKind,
  detail: string,
): Error {
  const clipped = detail.trim().slice(0, 240);
  return new Error(`${REPLY_MARKER}${kind}: ${clipped || kind}`);
}

export function classifyOpenRouterReply(input: {
  httpStatus?: number | null;
  statusText?: string | null;
  bodyText?: string | null;
  completionText?: string | null;
}): OpenRouterReplyKind {
  const status = input.httpStatus ?? null;
  const statusText = (input.statusText ?? '').trim();
  const bodyText = (input.bodyText ?? '').trim();
  const completionText = input.completionText ?? null;
  const combined = [status == null ? '' : String(status), statusText, bodyText]
    .filter(Boolean)
    .join(' ');

  if (isProvenOpenRouterCredentialRejection(combined)) return 'proven_auth';

  const bodyKind = classifyPayloadOrText(bodyText, status);
  if (bodyKind === 'proven_auth' || bodyKind === 'billing' || bodyKind === 'quota'
    || bodyKind === 'rate_limit' || bodyKind === 'timeout') {
    return bodyKind;
  }

  if (status === 429) return 'rate_limit';
  if (status === 402) return 'billing';
  if (
    status === 401
    || /^unauthorized$/i.test(statusText)
    || /\bunauthorized\b/i.test(bodyText)
  ) {
    return 'unauth_reply';
  }

  if (completionText != null) {
    const completionKind = classifyCompletionText(completionText);
    if (completionKind !== 'other') return completionKind;
  }

  if (bodyKind === 'garbage' || bodyKind === 'unauth_reply') return bodyKind;
  if (status != null && status >= 400) return 'other';
  if (completionText != null && completionText.trim() === '') return 'garbage';
  return bodyKind;
}

export function classifyOpenRouterErrorMessage(error: string): OpenRouterReplyKind {
  const message = error.trim();
  if (!message) return 'other';
  const lower = message.toLowerCase();

  const marked = lower.match(/openrouterreply:(unauth_reply|garbage|proven_auth)\b/);
  if (marked?.[1] === 'proven_auth') return 'proven_auth';
  if (marked?.[1] === 'unauth_reply') return 'unauth_reply';
  if (marked?.[1] === 'garbage') return 'garbage';

  if (isProvenOpenRouterCredentialRejection(lower)) return 'proven_auth';

  if (
    lower.includes('llm daily usd budget exceeded')
    || lower.includes('llm per-doc usd budget exceeded')
  ) return 'quota';

  if (
    /\b402\b/.test(lower)
    || lower.includes('payment required')
    || lower.includes('credits are depleted')
    || lower.includes('balance for files')
    || lower.includes('budget limit')
    || lower.includes('key limit exceeded')
  ) return 'billing';

  if (/\b429\b/.test(lower) || /rate[- ]?limit/.test(lower) || lower.includes('too many requests')) {
    return 'rate_limit';
  }

  if (
    /\b408\b/.test(lower)
    || /\b504\b/.test(lower)
    || lower.includes('timed out')
    || lower.includes('timeout')
    || lower.includes('aborted')
  ) return 'timeout';

  if (
    lower.includes('returned no text block')
    || lower.includes('no candidate text')
    || lower.includes('empty completion')
    || lower.includes('could not parse model json')
    || lower.includes('empty markdown')
    || lower.includes('letterhead')
  ) return 'garbage';

  const looksOpenRouter = lower.includes('openrouter') || lower.includes('openroutertext')
    || lower.includes('openroutervision');
  if (looksOpenRouter && (/\b401\b/.test(lower) || lower.includes('unauthorized'))) {
    return 'unauth_reply';
  }

  return 'other';
}

function classifyPayloadOrText(
  raw: string,
  status: number | null,
): OpenRouterReplyKind {
  if (!raw) return 'other';
  const trimmed = raw.trim();
  if (/^unauthorized$/i.test(trimmed) || /^forbidden$/i.test(trimmed)) return 'unauth_reply';

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>;
      const err = record.error;
      if (typeof err === 'string' && err.trim()) {
        return classifyOpenRouterErrorMessage(err);
      }
      if (err && typeof err === 'object') {
        const message = (err as { message?: unknown }).message;
        if (typeof message === 'string' && message.trim()) {
          return classifyOpenRouterErrorMessage(message);
        }
      }
      if (hasTransactionArray(record)) return 'ok';
    }
  } catch {
    // Not JSON — fall through to completion-shaped heuristics.
  }

  if (/^\s*</.test(trimmed) && /<(?:html|body|div|!doctype)/i.test(trimmed)) {
    return 'garbage';
  }
  if (status != null && status >= 200 && status < 300) {
    return classifyCompletionText(trimmed);
  }
  return 'other';
}

function looksLikeTruncatedJson(text: string): boolean {
  const cleaned = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  if (!cleaned) return false;
  const startsJson = cleaned.startsWith('{') || cleaned.startsWith('[');
  if (!startsJson) return false;
  return !cleaned.endsWith('}') && !cleaned.endsWith(']');
}

function classifyCompletionText(text: string): OpenRouterReplyKind {
  const trimmed = text.trim();
  if (!trimmed) return 'garbage';
  if (/^unauthorized$/i.test(trimmed) || /^forbidden$/i.test(trimmed)) return 'unauth_reply';
  if (/^\s*</.test(trimmed) && /<(?:html|body|div|!doctype)/i.test(trimmed)) return 'garbage';

  let cleaned = trimmed.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  try {
    const parsed: unknown = JSON.parse(cleaned);
    if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>;
      const err = record.error;
      if (typeof err === 'string' && err.trim()) {
        return classifyOpenRouterErrorMessage(err);
      }
      if (err && typeof err === 'object') {
        const message = (err as { message?: unknown }).message;
        if (typeof message === 'string' && message.trim()) {
          return classifyOpenRouterErrorMessage(message);
        }
      }
      if (Array.isArray(parsed) || hasTransactionArray(record)) return 'ok';
    }
  } catch {
    // Cut-off JSON is not a garbage reply — parseTruncationAwareJson salvages
    // the complete leading rows when finish_reason is length. Classifying it
    // as garbage skipped that salvage and dropped the whole filing.
    if (looksLikeTruncatedJson(trimmed)) return 'other';
    if (
      looksLikeHeaderContaminatedAsset(trimmed.slice(0, 400))
      && !looksLikePlausibleTradeTable(trimmed)
    ) {
      return 'garbage';
    }
    return 'garbage';
  }

  if (
    looksLikeHeaderContaminatedAsset(trimmed.slice(0, 400))
    && !looksLikePlausibleTradeTable(trimmed)
  ) {
    return 'garbage';
  }
  return 'garbage';
}

function hasTransactionArray(record: Record<string, unknown>): boolean {
  if (Array.isArray(record.transactions) || Array.isArray(record.rows)) return true;
  for (const [key, value] of Object.entries(record)) {
    if (key === 'choices' || key === 'usage' || key === 'error') continue;
    if (Array.isArray(value)) return true;
  }
  return false;
}

export function providerErrorClassForOpenRouterReply(
  kind: OpenRouterReplyKind,
): 'auth' | 'billing' | 'quota' | 'rate_limit' | 'timeout' | 'other' | null {
  switch (kind) {
    case 'proven_auth':
      return 'auth';
    case 'unauth_reply':
    case 'garbage':
    case 'ok':
    case 'other':
      return 'other';
    case 'billing':
      return 'billing';
    case 'quota':
      return 'quota';
    case 'rate_limit':
      return 'rate_limit';
    case 'timeout':
      return 'timeout';
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}
