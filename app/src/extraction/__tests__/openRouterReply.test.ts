import { describe, expect, it } from 'vitest';
import {
  classifyOpenRouterErrorMessage,
  classifyOpenRouterReply,
  docScopedOpenRouterError,
  isDocScopedOpenRouterError,
  isProvenOpenRouterCredentialRejection,
  providerErrorClassForOpenRouterReply,
} from '../openRouterReply.ts';

describe('classifyOpenRouterReply', () => {
  it('keeps proven dead-key rejections fail-closed', () => {
    expect(classifyOpenRouterReply({
      httpStatus: 401,
      statusText: 'Unauthorized',
      bodyText: '{"error":{"message":"User not found.","code":401}}',
    })).toBe('proven_auth');
    expect(classifyOpenRouterReply({
      httpStatus: 401,
      statusText: 'Unauthorized',
      bodyText: '{"error":{"message":"invalid_api_key","code":401}}',
    })).toBe('proven_auth');
    expect(isProvenOpenRouterCredentialRejection(
      'openRouterVision: OpenRouter API 401 Unauthorized {"error":{"message":"User not found.","code":401}}',
    )).toBe(true);
  });

  it('treats a bare Unauthorized reply as one-doc, not a pipeline latch', () => {
    expect(classifyOpenRouterReply({
      httpStatus: 401,
      statusText: 'Unauthorized',
      bodyText: '{"error":{"message":"Unauthorized","code":401}}',
    })).toBe('unauth_reply');
    expect(classifyOpenRouterReply({
      httpStatus: 200,
      completionText: 'Unauthorized',
    })).toBe('unauth_reply');
    expect(isProvenOpenRouterCredentialRejection(
      'openRouterText: OpenRouter API 401 Unauthorized',
    )).toBe(false);
  });

  it('classifies HTML / letterhead / empty completions as garbage', () => {
    expect(classifyOpenRouterReply({
      httpStatus: 200,
      completionText: '<!doctype html><html><body>Unauthorized</body></html>',
    })).toBe('garbage');
    expect(classifyOpenRouterReply({
      httpStatus: 200,
      completionText: 'Clerk of the House of Representatives\nB-81 Cannon Building',
    })).toBe('garbage');
    expect(classifyOpenRouterReply({
      httpStatus: 200,
      completionText: '',
    })).toBe('garbage');
  });

  it('accepts a JSON trade payload as ok', () => {
    expect(classifyOpenRouterReply({
      httpStatus: 200,
      completionText: JSON.stringify({
        transactions: [{ ticker: 'AAPL', txType: 'B' }],
      }),
    })).toBe('ok');
  });

  it('does not treat truncated JSON as a garbage skip — salvage still runs', () => {
    const truncated =
      '{"transactions":[{"ticker":"AAPL","assetName":"Apple Inc.","txType":"B"},{"ticker":"MSFT","assetName":"Micro';
    expect(classifyOpenRouterReply({
      httpStatus: 200,
      completionText: truncated,
    })).toBe('other');
    expect(classifyOpenRouterReply({
      httpStatus: 200,
      completionText: '[{"ticker":"AAPL","txType":"B"},{"ticker":"MSFT","assetName":"Micro',
    })).toBe('other');
  });
});

describe('classifyOpenRouterErrorMessage', () => {
  it('does not treat OpenRouter API 401 Unauthorized as a dead key', () => {
    expect(classifyOpenRouterErrorMessage(
      'openRouterText: OpenRouter API 401 Unauthorized',
    )).toBe('unauth_reply');
    expect(classifyOpenRouterErrorMessage(
      'openRouterVision: could not parse model JSON: Unexpected token <',
    )).toBe('garbage');
    expect(isDocScopedOpenRouterError(
      'openRouterText: OpenRouter API 401 Unauthorized',
    )).toBe(true);
    expect(isDocScopedOpenRouterError(
      'openRouterVision: OpenRouter API 401 Unauthorized {"error":{"message":"User not found.","code":401}}',
    )).toBe(false);
  });

  it('round-trips tagged skip errors', () => {
    const err = docScopedOpenRouterError('unauth_reply', '401 Unauthorized');
    expect(err.message).toContain('openRouterReply:unauth_reply');
    expect(classifyOpenRouterErrorMessage(err.message)).toBe('unauth_reply');
    expect(providerErrorClassForOpenRouterReply('unauth_reply')).toBe('other');
    expect(providerErrorClassForOpenRouterReply('proven_auth')).toBe('auth');
  });
});
