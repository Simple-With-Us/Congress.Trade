import { describe, it, expect, vi, afterEach } from 'vitest';
import { with429Retries } from '../retry429.ts';

// Flush pending microtasks without touching the (faked) timer queue, so the
// first attempt settles and the backoff wait gets armed.
const flushMicrotasks = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe('with429Retries — default sleep cancellation', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('clears the default backoff timer when the caller aborts mid-wait', async () => {
    vi.useFakeTimers();
    const calls = { n: 0 };
    const call = async () => {
      calls.n += 1;
      // Retry-After 60 → the wait is the 60s cap:  a timer that outlives the
      // abort by that long is exactly the dangling-timer defect.
      return new Response('', { status: 429, headers: { 'retry-after': '60' } });
    };
    const controller = new AbortController();
    const reason = new Error('lane deadline');
    const pending = with429Retries(call, { signal: controller.signal, random: () => 0.5 });
    await flushMicrotasks(); // first attempt 429'd; the backoff timer is armed
    expect(vi.getTimerCount()).toBe(1);
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(calls.n).toBe(1); // no retry attempt was spent after the abort
    // The losing timer must be gone, not left dangling until its 60s expiry.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('the default backoff timer still fires normally when the wait is not aborted', async () => {
    vi.useFakeTimers();
    const calls = { n: 0 };
    const call = async () => {
      calls.n += 1;
      return calls.n === 1
        ? new Response('', { status: 429, headers: { 'retry-after': '2' } })
        : new Response('ok', { status: 200 });
    };
    const pending = with429Retries(call, {
      signal: new AbortController().signal,
      random: () => 0.5,
    });
    await flushMicrotasks();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(2000);
    const res = await pending;
    expect(res.status).toBe(200);
    expect(calls.n).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
