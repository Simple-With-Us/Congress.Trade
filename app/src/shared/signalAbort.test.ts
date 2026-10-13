import { describe, expect, it } from 'vitest';
import { abortIfSignal } from './signalAbort.ts';

/**
 * shared/signalAbort.ts: cooperative abort for cron lanes that receive a
 * merged maintenance signal.  Covers all three branches:
 *   - no signal / not yet aborted -> no-op (the lane keeps running)
 *   - aborted with an Error reason -> the reason itself is rethrown so the
 *     lane unwinds with the real cause (MaintenanceLaneTimeoutError, tick abort)
 *   - aborted with a non-Error reason -> synthesized DOMException AbortError
 */

describe('abortIfSignal', () => {
  it('is a no-op when no signal is provided', () => {
    expect(() => abortIfSignal()).not.toThrow();
  });

  it('is a no-op while the signal is not aborted', () => {
    const ctrl = new AbortController();
    expect(() => abortIfSignal(ctrl.signal)).not.toThrow();
  });

  it('rethrows an Error abort reason', () => {
    const ctrl = new AbortController();
    const reason = new Error('lane budget exceeded');
    ctrl.abort(reason);
    expect(() => abortIfSignal(ctrl.signal)).toThrow(reason);
  });

  it('rethrows the default AbortError DOMException reason', () => {
    const ctrl = new AbortController();
    ctrl.abort();
    let caught: unknown;
    try {
      abortIfSignal(ctrl.signal);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(ctrl.signal.reason);
    expect((caught as DOMException).name).toBe('AbortError');
  });

  it('throws a DOMException AbortError for a non-Error abort reason', () => {
    const ctrl = new AbortController();
    ctrl.abort('cancelled');
    let caught: unknown;
    try {
      abortIfSignal(ctrl.signal);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DOMException);
    expect((caught as DOMException).name).toBe('AbortError');
    expect((caught as DOMException).message).toBe('Aborted');
  });
});