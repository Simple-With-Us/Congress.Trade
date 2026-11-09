/**
 * Vitest setup: pin CT_DELIVERY_MODE to 'deliver' for every suite.
 *
 * Production reads the mode from the Infisical settings snapshot and throws
 * when that snapshot never booted (delivery fails closed).  Most suites never
 * call initSettings(), so without this pin every outbox flush, delivery
 * message, APNs fan-out and SSE drain under test would throw.  Suites that
 * exercise the real snapshot path call __setDeliveryModeForTests(null).
 *
 * Deliberately imports nothing from src/: a setup-file import would load the
 * real module graph before each test file's vi.mock() calls apply.  The key
 * must match DELIVERY_MODE_TEST_PIN in src/delivery/deliveryMode.ts.
 */
import { beforeEach } from 'vitest';

beforeEach(() => {
  (globalThis as Record<string, unknown>).__ctDeliveryModeTestPin = 'deliver';
});
