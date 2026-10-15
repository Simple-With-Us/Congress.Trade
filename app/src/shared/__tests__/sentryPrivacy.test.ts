import { describe, expect, it, vi } from 'vitest';
import { NOT_LINKED_SENTRY_DATA_COLLECTION } from '../sentryDataCollection.ts';
import { buildSentryInitOptions, createSentryBindings, sentryLoggerWarn } from '../sentryRuntime.ts';
import { SENTRY_FILTERED_VALUE, scrubSentryEvent, scrubSentryFreeText } from '../sentryScrub.ts';

const FIXTURE = {
  email: 'operator@example.com',
  userId: 'user-9f3c2a1b-4e5d-6789-abcd-ef0123456789',
  subscriptionId: 'sub_1QwErTyUiOpAsDfG',
  originalTransactionId: 'otxn-anon-export-12345',
  ip: '203.0.113.42',
  forwarded: '203.0.113.42, 198.51.100.10',
  deviceId: 'A1B2C3D4-E5F6-7890-ABCD-EF1234567890',
  cookie: 'session=deadbeef; ct_pref=dark',
  body: '{"userId":"user-9f3c2a1b","email":"operator@example.com"}',
};

function serializedEnvelope(parts: unknown[]): string {
  return parts.map((part) => JSON.stringify(part)).join('\n');
}

function expectNoFixtureLeaks(serialized: string): void {
  for (const value of Object.values(FIXTURE)) {
    expect(serialized).not.toContain(value);
  }
  expect(serialized).toContain(SENTRY_FILTERED_VALUE);
}

describe('NOT_LINKED Sentry privacy controls', () => {
  it('sets explicit v11 dataCollection on SDK init options', () => {
    const options = buildSentryInitOptions(
      { SENTRY_DSN: 'https://key@o1.ingest.us.sentry.io/1' },
      0.1,
    );
    expect(options.dataCollection).toEqual(NOT_LINKED_SENTRY_DATA_COLLECTION);
    expect(typeof options.beforeSendSpan).toBe('function');
    expect(typeof options.beforeSendMetric).toBe('function');
  });

  it('scrubs identity values from free text', () => {
    const text = scrubSentryFreeText(
      `notify ${FIXTURE.email} sub ${FIXTURE.subscriptionId} from ${FIXTURE.ip}`,
    );
    expect(text).not.toContain(FIXTURE.email);
    expect(text).not.toContain(FIXTURE.subscriptionId);
    expect(text).not.toContain(FIXTURE.ip);
    expect(text).toContain(SENTRY_FILTERED_VALUE);
  });

  it('scrubs errors, transactions, logs, spans, and metrics before envelope serialization', () => {
    const options = buildSentryInitOptions(
      { SENTRY_DSN: 'https://key@o1.ingest.us.sentry.io/1' },
      0.1,
    );
    const beforeSend = options.beforeSend as (event: Record<string, unknown>) => Record<string, unknown>;
    const beforeSendTransaction = options.beforeSendTransaction as (
      event: Record<string, unknown>,
    ) => Record<string, unknown>;
    const beforeSendLog = options.beforeSendLog as (log: Record<string, unknown>) => Record<string, unknown>;
    const beforeSendSpan = options.beforeSendSpan as (span: Record<string, unknown>) => Record<string, unknown>;
    const beforeSendMetric = options.beforeSendMetric as (
      metric: Record<string, unknown>,
    ) => Record<string, unknown>;

    const event = beforeSend({
      user: { id: FIXTURE.userId, email: FIXTURE.email, ip_address: FIXTURE.ip },
      request: {
        headers: {
          cookie: FIXTURE.cookie,
          'x-forwarded-for': FIXTURE.forwarded,
        },
        data: FIXTURE.body,
      },
      message: `delivery failed for ${FIXTURE.subscriptionId}`,
    });
    const transaction = beforeSendTransaction({
      spans: [{
        data: {
          'http.request.header.x-forwarded-for': FIXTURE.forwarded,
          'url.full': `https://congress.trade/api/stream?subscription=${FIXTURE.subscriptionId}`,
        },
      }],
    });
    const log = beforeSendLog({
      body: `apple webhook for ${FIXTURE.originalTransactionId}`,
      attributes: { userId: FIXTURE.userId, deviceId: FIXTURE.deviceId },
    });
    const span = beforeSendSpan({
      data: { 'user.id': FIXTURE.userId, 'http.client_ip': FIXTURE.ip },
    });
    const metric = beforeSendMetric({
      name: 'webhook-retry',
      value: 1,
      attributes: { subscriptionId: FIXTURE.subscriptionId, clientId: `user:${FIXTURE.userId}` },
    });

    const envelope = serializedEnvelope([
      { event_id: 'evt' },
      { type: 'event' },
      event,
      { type: 'transaction' },
      transaction,
      { type: 'log' },
      log,
      { type: 'span' },
      span,
      { type: 'metric' },
      metric,
    ]);
    expectNoFixtureLeaks(envelope);
  });

  it('scrubs structured attributes emitted through sentryLoggerWarn', () => {
    const warn = vi.fn();
    const count = vi.fn();
    const sdk = {
      init: vi.fn(),
      logger: { warn },
      metrics: { count },
    };
    const sentry = createSentryBindings(sdk);
    sentry.initProductionSentry({ SENTRY_DSN: 'https://key@o1.ingest.us.sentry.io/1' });
    sentryLoggerWarn('webhook-retry', {
      subscriptionId: FIXTURE.subscriptionId,
      userId: FIXTURE.userId,
      email: FIXTURE.email,
      delaySeconds: 5,
    });
    const attrs = warn.mock.calls[0][1] as Record<string, unknown>;
    expect(attrs.delaySeconds).toBe(5);
    expect(attrs.subscriptionId).toBe(SENTRY_FILTERED_VALUE);
    expect(attrs.userId).toBe(SENTRY_FILTERED_VALUE);
    expect(attrs.email).toBe(SENTRY_FILTERED_VALUE);
    const metricAttrs = count.mock.calls[0][2]?.attributes as Record<string, unknown>;
    expect(metricAttrs.delaySeconds).toBe(5);
    expect(JSON.stringify(metricAttrs)).not.toContain(FIXTURE.subscriptionId);
  });

  it('keeps public member route slugs in URLs while redacting opaque path tokens', () => {
    const memberSlug = 'house-ca17-ro-khanna';
    const url = scrubSentryFreeText(`https://congress.trade/member/${memberSlug}`);
    expect(url).toContain(memberSlug);
    const opaque = 'a'.repeat(32);
    const redacted = scrubSentryFreeText(`https://congress.trade/api/admin/review/${opaque}`);
    expect(redacted).not.toContain(opaque);
    expect(redacted).toContain(SENTRY_FILTERED_VALUE);
  });

  it('does not redact span description keys when scrubbing nested objects', () => {
    const scrubbed = scrubSentryEvent({
      spans: [{ description: 'GET /api/health', op: 'http.client' }],
    }) as { spans: Array<{ description: string }> };
    expect(scrubbed.spans[0].description).toBe('GET /api/health');
  });

  it('redacts identity fields on direct scrub helper', () => {
    const scrubbed = scrubSentryEvent({
      breadcrumbs: [{ message: `user ${FIXTURE.email} txn ${FIXTURE.originalTransactionId}` }],
      contexts: { device: { id: FIXTURE.deviceId } },
    });
    const serialized = JSON.stringify(scrubbed);
    expectNoFixtureLeaks(serialized);
  });
});
